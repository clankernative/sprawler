//! Workspace discovery (adapter): find a Clankernative platform, its apps, company instances and
//! acceptance-test crates — or .NET projects — in a folder, and propose a workspace config.
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use regex::Regex;
use serde_json::{json, Value};

use crate::plugins;
use crate::profile::{self, resolve_path, Obj};
use crate::scan::read_text;

const SKIP: [&str; 12] =
    [".git", "target", "node_modules", "graphify-out", ".research", "__pycache__", ".venv", "dist", ".toolchains", "artifacts", "fixtures", "vendor"];
const MAX_DEPTH: usize = 6;
const KEYS: [&str; 11] = ["name", "title", "rules", "root", "platform", "apps", "instances", "tests", "label_strip_prefix", "label_strip_suffix", "extensions"];

/// Frontend / Node source a `.csproj` repo also holds (a `package.json` beside it): scanned too, so
/// HTTP requests from the frontend can be matched to the controllers that serve them.
const JS_EXTENSIONS: [&str; 8] = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

fn under(path: &str, base: &str) -> bool {
    base.is_empty() || path == base || path.starts_with(&format!("{base}/"))
}

fn dirname(p: &str) -> &str {
    p.rsplit_once('/').map_or("", |(d, _)| d)
}

fn basename(p: &str) -> &str {
    p.rsplit('/').next().unwrap_or(p)
}

fn join(a: &str, b: &str) -> String {
    if a.is_empty() || b.starts_with('/') {
        b.to_string()
    } else {
        format!("{}/{b}", a.trim_end_matches('/'))
    }
}

/// Python `os.path.normpath` for relative paths.
fn normpath(p: &str) -> String {
    let abs = p.starts_with('/');
    let mut out: Vec<&str> = Vec::new();
    for c in p.split('/') {
        match c {
            "" | "." => {}
            ".." if out.last().is_some_and(|x| *x != "..") => {
                out.pop();
            }
            ".." if abs => {}
            x => out.push(x),
        }
    }
    let s = out.join("/");
    if abs {
        format!("/{s}")
    } else if s.is_empty() {
        ".".into()
    } else {
        s
    }
}

pub fn discover(root: &Path) -> Value {
    let root = resolve_path(&root.to_string_lossy());
    let plat_re = Regex::new(r#"^\s*platform\s+""#).unwrap();
    let ns_re = Regex::new(r#"namespace:\s*"([^"]+)""#).unwrap();
    let (mut platforms, mut cargos, mut csprojs): (Vec<String>, Vec<String>, Vec<String>) = (vec![], vec![], vec![]);
    let (mut apps, mut instances): (Vec<Value>, Vec<Value>) = (vec![], vec![]);
    let mut js: Vec<String> = Vec::new();
    let mut stack = vec![String::new()];
    while let Some(rel) = stack.pop() {
        let dp = if rel.is_empty() { root.clone() } else { root.join(&rel) };
        let depth = if rel.is_empty() { 0 } else { rel.matches('/').count() + 1 };
        let Ok(entries) = std::fs::read_dir(&dp) else { continue };
        let (mut dirs, mut files) = (Vec::new(), BTreeSet::new());
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            let ft = e.file_type().ok();
            let link = ft.is_some_and(|t| t.is_symlink());
            if if link { e.path().is_dir() } else { ft.is_some_and(|t| t.is_dir()) } {
                if !link {
                    dirs.push(name); // like os.walk: symlinked folders are listed but never entered
                }
            } else {
                files.insert(name);
            }
        }
        let rel_of = |f: &str| if rel.is_empty() { f.to_string() } else { format!("{rel}/{f}") };
        if files.contains("main.roc") && dp.file_name().is_some_and(|n| n == "sdk") {
            let head: String = read_text(&dp.join("main.roc")).chars().take(400).collect();
            if plat_re.is_match(&head) {
                platforms.push(dirname(&rel).to_string());
            }
        }
        if files.contains("App.roc") {
            if let Some(c) = ns_re.captures(&read_text(&dp.join("App.roc"))) {
                apps.push(json!({"path": rel, "namespace": &c[1]}));
            }
        }
        if files.contains("instance.json") {
            let d: Option<Value> = serde_json::from_str(&read_text(&dp.join("instance.json"))).ok();
            // disposable instances are throwaway runtime / test evidence, not a company instance
            if let Some(d) = d.filter(|d| d["apps"].is_object() && d.get("environment").and_then(Value::as_str) != Some("disposable")) {
                let mut names: Vec<&String> = d["apps"].as_object().unwrap().keys().collect();
                names.sort();
                instances.push(json!({"path": rel_of("instance.json"), "installation": d.get("installation"), "apps": names}));
            }
        }
        if files.contains("Cargo.toml") {
            cargos.push(rel.clone());
        }
        if files.contains("package.json") {
            js.push(rel.clone());
        }
        csprojs.extend(files.iter().filter(|f| f.ends_with(".csproj")).map(|f| rel_of(f)));
        dirs.retain(|d| !SKIP.contains(&d.as_str()) && !d.starts_with('.') && depth < MAX_DEPTH);
        dirs.sort();
        for d in dirs.into_iter().rev() {
            stack.push(rel_of(&d));
        }
    }
    let key = |p: &String| (p.matches('/').count(), p.chars().count());
    let plat = platforms.iter().fold(None::<&String>, |best, p| match best {
        Some(b) if key(b) <= key(p) => Some(b),
        _ => Some(p),
    });
    let path_of = |v: &Value| v["path"].as_str().unwrap_or("").to_string();
    let mut tests = Vec::new();
    if let Some(pl) = plat {
        // the platform ships its own example / fixture apps; they are not this workspace's apps
        if pl.is_empty() {
            apps.retain(|a| !path_of(a).starts_with("examples/"));
        } else {
            apps.retain(|a| !under(&path_of(a), pl));
            instances.retain(|i| !under(&path_of(i), pl));
        }
        let crates = if pl.is_empty() { "crates".to_string() } else { format!("{pl}/crates") };
        for c in &cargos {
            if (!pl.is_empty() && under(c, pl)) || apps.iter().any(|a| under(c, &path_of(a))) {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(root.join(c).join("Cargo.toml")) else { continue };
            let Ok(t) = toml::from_str::<toml::Table>(&text) else { continue };
            let mut deps: Vec<(String, toml::Value)> = Vec::new();
            for k in ["dependencies", "dev-dependencies"] {
                for (n, v) in t.get(k).and_then(|v| v.as_table()).into_iter().flatten() {
                    match deps.iter_mut().find(|(x, _)| x == n) {
                        Some(e) => e.1 = v.clone(),
                        None => deps.push((n.clone(), v.clone())),
                    }
                }
            }
            let path_dep = |v: &toml::Value| v.as_table().and_then(|t| t.get("path")).and_then(|p| p.as_str()).map(str::to_string);
            if deps.iter().filter_map(|(_, v)| path_dep(v)).any(|p| under(&normpath(&join(c, &p)), &crates)) {
                tests.push(c.clone());
            }
        }
    }
    csprojs.sort();
    json!({"root": root.to_string_lossy(), "platforms": platforms, "platform": plat, "apps": apps, "instances": instances,
           "tests": tests, "dotnet": csprojs, "js": js})
}

fn title_of(name: &str) -> String {
    Regex::new(r"[-_]+").unwrap().replace_all(name, " ").to_uppercase()
}

/// A naming prefix most apps share (e.g. `tool-`), stripped from labels.
fn dash_prefix(names: &[String]) -> Vec<String> {
    if names.len() < 3 {
        return vec![];
    }
    let mut best = String::new();
    for n in names {
        let parts: Vec<&str> = n.split('-').collect();
        for k in 1..parts.len() {
            let pre = format!("{}-", parts[..k].join("-"));
            if pre.chars().count() > best.chars().count() && names.iter().filter(|x| x.starts_with(&pre)).count() * 2 >= names.len() {
                best = pre;
            }
        }
    }
    if best.is_empty() {
        vec![]
    } else {
        vec![best]
    }
}

/// Shared dotted prefixes (e.g. `Acme.Apps.`, `Acme.`) stripped from .NET project labels, longest first.
fn dotted_prefix(names: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for k in [2usize, 1] {
        let pres: BTreeSet<String> =
            names.iter().filter(|n| n.matches('.').count() >= k).map(|n| format!("{}.", n.split('.').take(k).collect::<Vec<_>>().join("."))).collect();
        for pre in pres {
            if names.iter().filter(|n| n.starts_with(&pre)).count() * 2 >= names.len() && !out.contains(&pre) {
                out.push(pre);
            }
        }
    }
    out
}

pub fn default_config(d: &Value) -> Obj {
    let root = d["root"].as_str().unwrap_or("");
    let name = basename(root).to_string();
    let strs = |k: &str| -> Vec<String> { d[k].as_array().into_iter().flatten().filter_map(Value::as_str).map(str::to_string).collect() };
    let cfg = if d["platform"].is_null() && !strs("dotnet").is_empty() {
        let names: Vec<String> = strs("dotnet").iter().map(|p| basename(p).rsplit_once('.').map_or(p.as_str(), |x| x.0).to_string()).collect();
        let mut c = json!({"name": name, "title": title_of(&name), "rules": "dotnet", "label_strip_prefix": dotted_prefix(&names), "label_strip_suffix": []});
        if !strs("js").is_empty() {
            c["extensions"] = json!(std::iter::once(".cs").chain(JS_EXTENSIONS).collect::<Vec<_>>());
        }
        c
    } else {
        let app_paths: Vec<String> = d["apps"].as_array().into_iter().flatten().filter_map(|a| a["path"].as_str()).map(str::to_string).collect();
        let names: Vec<String> = app_paths.iter().map(|a| basename(a).to_string()).collect();
        json!({
            "name": name, "title": title_of(&name), "rules": "clankernative", "platform": d["platform"].as_str().unwrap_or(""),
            "apps": app_paths, "instances": d["instances"].as_array().into_iter().flatten().map(|i| i["path"].clone()).collect::<Vec<_>>(),
            "tests": d["tests"], "label_strip_prefix": dash_prefix(&names),
            "label_strip_suffix": if names.iter().any(|n| n.ends_with("-app")) { json!(["-app"]) } else { json!([]) },
        })
    };
    cfg.as_object().cloned().unwrap_or_default()
}

/// Analyzer plugins this workspace needs, from what discovery found.
pub fn needed_analyzers(d: &Value) -> Vec<&'static str> {
    let mut out = Vec::new();
    if !d["platform"].is_null() {
        out.extend(["roc", "rust"]);
    }
    if d["dotnet"].as_array().is_some_and(|a| !a.is_empty()) {
        out.push("csharp");
        if d["js"].as_array().is_some_and(|a| !a.is_empty()) {
            out.push("typescript");
        }
    }
    out
}

pub fn user_config_path(root: &Path) -> PathBuf {
    profile::user_store().join("workspaces").join(format!("{}.toml", profile::slug(root)))
}

pub fn workspace_config_path(root: &Path) -> PathBuf {
    resolve_path(&root.to_string_lossy()).join(profile::SHARED_CONFIG)
}

pub fn config_text(cfg: &Obj) -> String {
    let mut lines = vec![
        "# Sprawler workspace: which folders are the platform, the apps, the instances and the acceptance tests.".to_string(),
        "# Paths are relative to `root` (or to this file's folder when there is no `root`). Rules: docs/CONFIG.md".to_string(),
    ];
    for k in KEYS {
        if let Some(v) = cfg.get(k).filter(|v| !v.is_null()) {
            lines.push(format!("{k} = {v}"));
        }
    }
    lines.join("\n") + "\n"
}

/// File paths under `root` (skipping build output and hidden folders), enough to see which languages it holds.
pub fn sample_files(root: &Path) -> Vec<String> {
    let mut out = Vec::new();
    let mut stack = vec![(root.to_path_buf(), 0usize)];
    while let Some((d, depth)) = stack.pop() {
        for e in std::fs::read_dir(&d).into_iter().flatten().flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            let p = e.path();
            if e.file_type().is_ok_and(|t| t.is_dir()) {
                if depth < MAX_DEPTH && !name.starts_with('.') && !SKIP.contains(&name.as_str()) {
                    stack.push((p, depth + 1));
                }
            } else if let Ok(rel) = p.strip_prefix(root) {
                out.push(rel.to_string_lossy().into_owned());
            }
            if out.len() > 20_000 {
                return out;
            }
        }
    }
    out
}

/// No platform or project files found: a structure-only profile from the installed plugins'
/// `defaults` (each plugin maps its own language; entries match on the facts it reports).
fn plugin_defaults_profile(d: &Value) -> Result<Obj, String> {
    let root = d["root"].as_str().unwrap_or("").to_string();
    let mut warnings = Vec::new();
    let mut found = plugins::discover(&Obj::new(), &mut warnings);
    found.sort_by(|a, b| a.name.cmp(&b.name));
    // only plugins that claim files actually in this repo
    let files = sample_files(Path::new(&root));
    found.retain(|pl| files.iter().any(|f| pl.claims(f)));
    let (mut p, mut used, mut exts, mut exclude) = (Obj::new(), Vec::new(), Vec::<String>::new(), Vec::<String>::new());
    for pl in &found {
        let Some(def) = pl.info.get("defaults").and_then(Value::as_object) else { continue };
        let strs =
            |v: Option<&Value>| -> Vec<String> { v.and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_string).collect() };
        for e in strs(pl.info.pointer("/claims/extensions")).into_iter().chain(strs(def.get("extensions"))) {
            if !exts.contains(&e) {
                exts.push(e);
            }
        }
        for e in strs(def.get("exclude")) {
            if !exclude.contains(&e) {
                exclude.push(e);
            }
        }
        p = profile::merge_profile(&p, def);
        used.push(pl.name.clone());
    }
    if used.is_empty() {
        return Err(format!(
            "nothing to map in {root}: no profile, no Clankernative platform or .csproj files, and no installed analyzer \
             plugin publishes defaults — `sprawler plugin add rust roc`, add a sprawler.toml (see docs/CONFIG.md), or pass --profile FILE"
        ));
    }
    for e in ["**/.git/**", "**/node_modules/**"] {
        if !exclude.iter().any(|x| x == e) {
            exclude.push(e.to_string());
        }
    }
    eprintln!("(no profile for {root}; using defaults from the {} plugin(s) — structure only; `sprawler profile init` writes one)", used.join(", "));
    let name = basename(&root).to_string();
    for (k, v) in [
        ("name", json!(name)),
        ("title", json!(name.to_uppercase())),
        ("root", json!(root)),
        ("include", json!(["**"])),
        ("exclude", json!(exclude)),
        ("extensions", json!(exts)),
        ("cache_key", json!(profile::slug(Path::new(&root)))),
        ("_defaults_from", json!(used)),
    ] {
        p.insert(k.into(), v);
    }
    profile::finalize(p)
}

/// No saved config: build a profile straight from discovery, or explain what is missing.
pub fn auto_profile(root: &Path) -> Result<Obj, String> {
    let d = discover(root);
    if d["platform"].is_null() && d["dotnet"].as_array().is_none_or(|a| a.is_empty()) {
        return plugin_defaults_profile(&d);
    }
    eprintln!("(no saved config for {}; using auto-discovery — `sprawler setup --yes` saves it)", d["root"].as_str().unwrap_or(""));
    let mut cfg = default_config(&d);
    cfg.insert("root".into(), d["root"].clone());
    profile::build_profile(&cfg)
}
