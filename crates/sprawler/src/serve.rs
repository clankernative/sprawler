//! Local server (driving adapter): the built-in 3D UI + `/api/*` + live rescans on file change.
//!
//! Standard library only, bound to 127.0.0.1. The UI is compiled into the binary (`crates/sprawler/web_dist`). With no saved
//! config, the server starts in setup mode and the UI's first-run screen writes one.
//!
//! After each scan the previous and new atlas are compared into town events (`sprawler_domain::events`),
//! kept in a per-workspace log (`events.jsonl` in the cache folder) and served at `/api/events?since=<id>`.
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use include_dir::{include_dir, Dir};
use serde_json::{json, Value};

use crate::events::{self, EventLog};
use crate::profile::{self, Obj};
use crate::{atlas, discover, history, scan, walk, wip};

static WEB: Dir = include_dir!("$CARGO_MANIFEST_DIR/web_dist");

struct State {
    root: PathBuf,
    profile: Option<Obj>,
    version: u64,
    atlas: Vec<u8>,
    scanning: bool,
    pending: bool,
    error: Option<String>,
    /// Bumped when setup switches profiles: a scan of the old one must not touch the new session.
    generation: u64,
    /// The edge set first seen for the current HEAD (wip edges; see `wip.rs`).
    baseline: wip::Baseline,
    /// The last atlas (the parts the event diff reads).
    prev: Option<Value>,
    events: EventLog,
}

/// The town-event log of a profile's workspace.
fn event_log(p: Option<&Obj>) -> EventLog {
    EventLog::open(p.map(|p| scan::cache_dir(p).join("events.jsonl")), events::CAP)
}

/// What the event diff needs from an atlas (drops prompts, flows, ports and other bulk).
fn slim(a: &Value) -> Value {
    let keep = ["project", "modules", "edges", "violations", "seams", "contexts", "score", "achievements", "cycles", "wells", "history", "wip"];
    Value::Object(keep.iter().filter_map(|k| Some((k.to_string(), a.get(*k)?.clone()))).collect())
}

/// Diff the new atlas against the previous one into events, and log them.
fn record_events(s: &mut State, a: &Value) {
    let evs = match &s.prev {
        None => {
            let (t, logged) = s.events.resume_point();
            sprawler_domain::events::boot_events(a, t, &logged)
        }
        Some(prev) => sprawler_domain::events::diff_atlas(prev, a),
    };
    for e in s.events.append(evs, None) {
        let what = ["module", "source", "ctx", "subject"].iter().find_map(|k| e[*k].as_str()).unwrap_or("");
        let agg = if e["aggregated"] == true { format!(" ×{}", e["count"]) } else { String::new() };
        eprintln!("[sprawler] event #{} {} {what}{agg}", e["id"], e["kind"].as_str().unwrap_or(""));
    }
    s.prev = Some(slim(a));
}

type Shared = Arc<Mutex<State>>;

fn rescan(st: &Shared) {
    let (p, gen, baseline) = {
        let mut s = st.lock().unwrap();
        let Some(p) = s.profile.clone() else { return };
        if s.scanning {
            s.pending = true; // picked up when the running scan finishes
            return;
        }
        s.scanning = true;
        (p, s.generation, std::mem::take(&mut s.baseline))
    };
    let (mut p, mut gen, mut baseline) = (p, gen, baseline);
    loop {
        let t = Instant::now();
        let built = atlas::build_atlas_session(&p, &crate::local::Local, Some(&mut baseline));
        {
            let mut s = st.lock().unwrap();
            if s.generation == gen {
                s.baseline = std::mem::take(&mut baseline);
            }
        }
        match built {
            Ok(mut a) => {
                let mut s = st.lock().unwrap();
                if s.generation == gen {
                    record_events(&mut s, &a); // events never break a scan: the log skips what it cannot write
                }
                s.version += 1;
                a["scan"] = json!(s.version);
                eprintln!(
                    "[sprawler] scan #{}: {} modules, {} deps, {} {} ({}) in {:.1}s",
                    s.version,
                    a["modules"].as_array().map_or(0, Vec::len),
                    a["edges"].as_array().map_or(0, Vec::len),
                    a["score"]["label"].as_str().unwrap_or("score"),
                    a["score"]["total"],
                    a["score"]["grade"].as_str().unwrap_or(""),
                    t.elapsed().as_secs_f64()
                );
                s.atlas = a.to_string().into_bytes();
                s.error = None;
            }
            Err(e) => {
                eprintln!("[sprawler] scan failed: {e}");
                st.lock().unwrap().error = Some(e);
            }
        }
        let mut s = st.lock().unwrap();
        if !s.pending {
            s.scanning = false;
            return;
        }
        s.pending = false;
        if let Some(np) = s.profile.clone() {
            p = np; // setup may have switched profiles meanwhile
        }
        gen = s.generation;
        baseline = std::mem::take(&mut s.baseline);
    }
}

/// Each repo's folder, and its git dir when it is a repository.
fn git_dirs(p: &Obj) -> (Vec<String>, Vec<PathBuf>) {
    let root = p.get("root").and_then(Value::as_str).unwrap_or(".").to_string();
    let repos: Vec<String> = p.get("repos").and_then(Value::as_array).into_iter().flatten().filter_map(|r| r.as_str().map(str::to_string)).collect();
    let roots: Vec<String> = if repos.is_empty() { vec![root.clone()] } else { repos.iter().map(|r| format!("{root}/{r}")).collect() };
    let dirs =
        roots.iter().map(|r| history::git(r, &["rev-parse", "--absolute-git-dir"]).trim().to_string()).filter(|g| !g.is_empty()).map(PathBuf::from).collect();
    (roots, dirs)
}

/// Cheap change detector: included files' mtime + size (the walk lists untracked files too, so new
/// files fire), plus git state: the index (stage / unstage / commit), HEAD (checkout) and the commit
/// HEAD resolves to (a commit moves the branch ref, not HEAD itself, and need not rewrite the index).
/// Our own git calls use `--no-optional-locks`, so they never touch the index and retrigger this.
fn signature(p: &Obj, roots: &[String], git: &[PathBuf]) -> String {
    let root = PathBuf::from(p.get("root").and_then(Value::as_str).unwrap_or("."));
    let mut out = String::new();
    if let Ok(w) = walk::walk(p) {
        for rel in w.files.iter().chain(&w.cargo) {
            if let Ok(m) = std::fs::metadata(root.join(rel)) {
                let t = m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |d| d.as_nanos());
                out.push_str(&format!("{rel}:{t}:{}\n", m.len()));
            }
        }
    }
    for g in git {
        for f in ["HEAD", "index"] {
            if let Ok(m) = std::fs::metadata(g.join(f)) {
                out.push_str(&format!("{f}:{:?}\n", m.modified().ok()));
            }
        }
    }
    for r in roots {
        out.push_str(&format!("head:{}\n", history::git(r, &["rev-parse", "HEAD"]).trim()));
    }
    out
}

fn watch(st: Shared) {
    let mut last: Option<(String, String)> = None; // (profile path/root, signature)
    let mut git: (String, Vec<String>, Vec<PathBuf>) = (String::new(), Vec::new(), Vec::new());
    let mut first = true;
    loop {
        // the first look is immediate (alongside the first scan), so a change made right after it counts
        if !first {
            std::thread::sleep(Duration::from_secs(2));
        }
        first = false;
        let Some(p) = st.lock().unwrap().profile.clone() else { continue };
        let key = format!("{}|{}", p.get("_path").and_then(Value::as_str).unwrap_or(""), p.get("root").and_then(Value::as_str).unwrap_or(""));
        if git.0 != key {
            let (roots, dirs) = git_dirs(&p);
            git = (key.clone(), roots, dirs);
        }
        let cur = signature(&p, &git.1, &git.2);
        match &last {
            Some((k, sig)) if *k == key && *sig != cur => {
                std::thread::sleep(Duration::from_millis(600)); // debounce editor save bursts
                last = Some((key, signature(&p, &git.1, &git.2)));
                eprintln!("[sprawler] change detected → rescanning");
                rescan(&st);
            }
            Some((k, _)) if *k == key => {}
            _ => last = Some((key, cur)), // first look, or setup just switched profiles
        }
    }
}

fn setup_payload(st: &Shared) -> Value {
    let (root, legacy, setup) = {
        let s = st.lock().unwrap();
        let legacy = s.profile.as_ref().is_some_and(|p| p.get("cache_key").is_none());
        (s.root.clone(), legacy, s.profile.is_none())
    };
    let path = profile::find_config(&root);
    let cfg = path.as_ref().and_then(|p| profile::load_config(p).ok()).map(|c| Value::Object(c.into_iter().filter(|(k, _)| !k.starts_with('_')).collect()));
    let (user, shared) = (discover::user_config_path(&root), discover::workspace_config_path(&root));
    json!({
        "root": root.to_string_lossy(), "discovered": discover::discover(&root), "config": cfg,
        "configPath": path.as_ref().map(|p| p.to_string_lossy().into_owned()),
        "where": if path.as_ref() == Some(&shared) { "workspace" } else { "user" },
        "paths": {"user": user.to_string_lossy(), "workspace": shared.to_string_lossy()},
        "legacy": legacy, "setup": setup,
    })
}

fn trim_list(v: &Value) -> Vec<String> {
    v.as_array().into_iter().flatten().filter_map(Value::as_str).map(|x| x.trim_matches('/').to_string()).collect()
}

fn setup_save(st: &Shared, body: &Value) -> Result<Value, String> {
    let root = st.lock().unwrap().root.clone();
    let plat = body["platform"].as_str().unwrap_or("").trim_matches('/').to_string();
    if !root.join(&plat).join("sdk").join("main.roc").exists() {
        let at = if plat.is_empty() { String::new() } else { format!("{plat}/") };
        return Err(format!("no platform at '{}': expected {at}sdk/main.roc", if plat.is_empty() { "." } else { &plat }));
    }
    let apps = trim_list(&body["apps"]);
    for a in &apps {
        if !root.join(a).join("App.roc").exists() {
            return Err(format!("'{a}' has no App.roc"));
        }
    }
    let name = body["name"]
        .as_str()
        .map(str::trim)
        .filter(|x| !x.is_empty())
        .map_or_else(|| root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(), str::to_string);
    let title = body["title"].as_str().map(str::trim).filter(|x| !x.is_empty());
    let mut cfg: Obj = json!({
        "name": name, "title": title, "rules": body["rules"].as_str().filter(|x| !x.is_empty()).unwrap_or("clankernative"),
        "platform": plat, "apps": apps,
        "instances": body["instances"].as_array().cloned().unwrap_or_default(), "tests": trim_list(&body["tests"]),
        "label_strip_prefix": body["label_strip_prefix"].as_array().cloned().unwrap_or_default(),
        "label_strip_suffix": body["label_strip_suffix"].as_array().cloned().unwrap_or_default(),
    })
    .as_object()
    .cloned()
    .unwrap_or_default();
    let shared = body["where"].as_str() == Some("workspace");
    let path = if shared {
        let _ = std::fs::remove_file(discover::user_config_path(&root)); // a personal copy would shadow the shared one
        discover::workspace_config_path(&root)
    } else {
        cfg.insert("root".into(), json!(root.to_string_lossy()));
        discover::user_config_path(&root)
    };
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
    }
    std::fs::write(&path, discover::config_text(&cfg)).map_err(|e| format!("{}: {e}", path.display()))?;
    let p = profile::build_profile(&profile::load_config(&path)?)?;
    {
        let events = event_log(Some(&p));
        let mut s = st.lock().unwrap();
        s.root = PathBuf::from(p.get("root").and_then(Value::as_str).unwrap_or("."));
        s.profile = Some(p);
        // a new session: no previous atlas to diff against, a fresh baseline, that workspace's log
        s.generation += 1;
        (s.baseline, s.prev, s.events) = (wip::Baseline::default(), None, events);
    }
    let st2 = st.clone();
    std::thread::spawn(move || rescan(&st2));
    Ok(json!({"ok": true, "configPath": path.to_string_lossy()}))
}

fn mime(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "woff2" => "font/woff2",
        _ => "application/octet-stream",
    }
}

fn send(stream: &mut TcpStream, code: u16, ctype: &str, body: &[u8], cache: bool) {
    let reason = match code {
        200 => "OK",
        202 => "Accepted",
        400 => "Bad Request",
        404 => "Not Found",
        _ => "Error",
    };
    let cc = if cache { "" } else { "Cache-Control: no-store\r\n" };
    let head = format!("HTTP/1.1 {code} {reason}\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\n{cc}Connection: close\r\n\r\n", body.len());
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(body);
}

fn send_json(stream: &mut TcpStream, code: u16, v: &Value) {
    send(stream, code, "application/json", v.to_string().as_bytes(), false);
}

fn handle(mut stream: TcpStream, st: &Shared) {
    let mut reader = BufReader::new(match stream.try_clone() {
        Ok(s) => s,
        Err(_) => return,
    });
    let mut line = String::new();
    if reader.read_line(&mut line).is_err() {
        return;
    }
    let mut parts = line.split_whitespace();
    let (method, target) = (parts.next().unwrap_or(""), parts.next().unwrap_or("/"));
    let mut len = 0usize;
    loop {
        let mut h = String::new();
        if reader.read_line(&mut h).is_err() || h.trim().is_empty() {
            break;
        }
        if let Some((k, v)) = h.split_once(':') {
            if k.eq_ignore_ascii_case("content-length") {
                len = v.trim().parse().unwrap_or(0).min(1 << 20); // bodies are tiny; cap them
            }
        }
    }
    let mut body = vec![0u8; len];
    let _ = reader.read_exact(&mut body);
    let path = target.split_once('?').map_or(target, |x| x.0);

    match (method, path) {
        ("POST", "/api/rescan") => {
            let st2 = st.clone();
            std::thread::spawn(move || rescan(&st2));
            send_json(&mut stream, 202, &json!({"ok": true}));
        }
        ("POST", "/api/setup") => {
            let parsed: Result<Value, String> = if body.is_empty() { Ok(json!({})) } else { serde_json::from_slice(&body).map_err(|e| e.to_string()) };
            match parsed.and_then(|b| setup_save(st, &b)) {
                Ok(v) => send_json(&mut stream, 200, &v),
                Err(e) => send_json(&mut stream, 400, &json!({"ok": false, "error": e})),
            }
        }
        ("GET", "/api/atlas") => {
            let bytes = st.lock().unwrap().atlas.clone();
            send(&mut stream, 200, "application/json", if bytes.is_empty() { b"{}" } else { &bytes }, false);
        }
        ("GET", "/api/version") => {
            let s = st.lock().unwrap();
            send_json(
                &mut stream,
                200,
                &json!({"version": s.version, "scanning": s.scanning, "error": s.error, "setup": s.profile.is_none(), "events": s.events.last}),
            );
        }
        ("GET", "/api/events") => {
            // town events; ?since=<id> returns only newer ones, &limit=N the newest N
            let query = target.split_once('?').map_or("", |x| x.1);
            let arg = |k: &str| query.split('&').filter_map(|kv| kv.split_once('=')).find(|(a, _)| *a == k).map(|(_, v)| v);
            let since = arg("since").filter(|v| !v.is_empty()).map(str::parse::<u64>).transpose();
            let limit = arg("limit").filter(|v| !v.is_empty()).map(str::parse::<usize>).transpose();
            match (since, limit) {
                (Ok(since), Ok(limit)) => {
                    let body = st.lock().unwrap().events.since(since.unwrap_or(0), limit);
                    send_json(&mut stream, 200, &body);
                }
                _ => send_json(&mut stream, 400, &json!({"error": "since/limit must be integers"})),
            }
        }
        ("GET", "/api/setup") => send_json(&mut stream, 200, &setup_payload(st)),
        (_, p2) if p2.starts_with("/api/") => send_json(&mut stream, 404, &json!({})),
        ("GET", _) => {
            let rel = path.trim_start_matches('/');
            match WEB.get_file(rel).filter(|_| !rel.is_empty()) {
                Some(f) => send(&mut stream, 200, mime(rel), f.contents(), rel.starts_with("assets/")),
                None => match WEB.get_file("index.html") {
                    Some(f) => send(&mut stream, 200, mime("index.html"), f.contents(), false),
                    None => send(&mut stream, 200, "text/html", b"<h1>web UI missing from this build</h1>", false),
                },
            }
        }
        _ => send_json(&mut stream, 404, &json!({})),
    }
}

/// `profile: None` starts in setup mode: the UI's first-run screen saves a workspace config for `root`.
pub fn serve(profile: Option<Obj>, root: &Path, port: u16, watch_files: bool) -> Result<(), String> {
    let listener = TcpListener::bind(("127.0.0.1", port)).map_err(|e| format!("127.0.0.1:{port}: {e}"))?;
    let root = profile.as_ref().and_then(|p| p.get("root").and_then(Value::as_str)).map_or_else(|| root.to_path_buf(), PathBuf::from);
    let mode = if profile.is_some() {
        if watch_files {
            "watch=on"
        } else {
            "watch=off"
        }
    } else {
        "setup: open the page to choose what to scan"
    };
    let events = event_log(profile.as_ref());
    let st: Shared = Arc::new(Mutex::new(State {
        root: root.clone(),
        profile,
        version: 0,
        atlas: Vec::new(),
        scanning: false,
        pending: false,
        error: None,
        generation: 0,
        baseline: wip::Baseline::default(),
        prev: None,
        events,
    }));
    {
        let st2 = st.clone();
        std::thread::spawn(move || rescan(&st2));
    }
    if watch_files {
        let st2 = st.clone();
        std::thread::spawn(move || watch(st2));
    }
    eprintln!("[sprawler] ▶ http://127.0.0.1:{port}  (root {}, {mode})", root.display());
    for stream in listener.incoming().flatten() {
        let st2 = st.clone();
        std::thread::spawn(move || handle(stream, &st2));
    }
    Ok(())
}
