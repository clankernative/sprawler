//! `sprawler-analyzer-rust` — Rust facts for Sprawler (protocol `sprawler.analyzer/1`).
//!
//! Runs Graphify over a read-only mirror of the claimed files, then corrects its name-matched links
//! with the Cargo dependency graph: a cross-crate reference only counts when Cargo actually links
//! the crates, and production code never links to test-only code. Everything dropped is reported
//! as `unknown.dropped`, never hidden.
use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};

use serde_json::{json, Value};
use sprawler_protocol::PROTOCOL;

mod native;

const RUST_REL: [&str; 7] = ["imports", "imports_from", "calls", "references", "implements", "inherits", "uses"];

/// Profile defaults for a Rust repo with no profile: each crate is a context; entry points, library
/// code and tests are separate layers. Structure only — no policy (that comes from a pack).
fn defaults() -> Value {
    json!({
        "tiers": [{"id": "code", "label": "CODE", "color": "#39ffb0", "depends": [], "cross": "allow"}],
        "layers": {
            "code": {"label": "Library code", "ring": 1, "shape": "box", "color": "#4cc9ff"},
            "root": {"label": "Entry point", "ring": 3, "side": "north", "shape": "dodeca", "color": "#ffffff"},
            "test": {"label": "Tests", "ring": 4, "side": "south", "shape": "tetra", "color": "#7f8ea3", "test": true},
        },
        "allow": {"code": ["code"], "root": ["*"], "test": ["*"]},
        "exclude": ["**/target/**"],
        "map": [
            {"glob": "**/*.rs", "when": {"target": ["test", "bench", "example"]}, "tier": "code", "ctx": "@crate", "layer": "test"},
            {"glob": "**/*.rs", "when": {"target": ["bin", "build"]}, "tier": "code", "ctx": "@crate", "layer": "root"},
            {"glob": "**/*.rs", "when": {"target": "lib"}, "tier": "code", "ctx": "@crate", "layer": "code"},
        ],
    })
}

fn describe() -> Value {
    json!({
        "protocol": PROTOCOL, "name": "rust", "version": env!("CARGO_PKG_VERSION"), "languages": ["rust"],
        "claims": {"extensions": [".rs"], "files": ["Cargo.toml"]},
        "precision": "syntactic", "facts": ["crate", "target"], "defaults": defaults(),
        "requires": [{"tool": "graphify", "check": ["graphify", "--help"], "install": "uv tool install graphifyy  (or: pipx install graphifyy)"}],
    })
}

fn dirname(p: &str) -> &str {
    p.rsplit_once('/').map_or("", |(d, _)| if d.is_empty() { "/" } else { d })
}

fn basename(p: &str) -> &str {
    p.rsplit_once('/').map_or(p, |(_, b)| b)
}

fn strs(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_string).collect()
}

fn which(name: &str) -> Option<PathBuf> {
    std::env::var_os("PATH").and_then(|p| std::env::split_paths(&p).map(|d| d.join(name)).find(|f| f.is_file()))
}

/// `L42` → 42; anything else → None.
fn loc_line(v: Option<&Value>) -> Option<u64> {
    v.and_then(Value::as_str).and_then(|s| s.strip_prefix('L')).and_then(|n| n.parse().ok())
}

// ── mirror + graphify ───────────────────────────────────────────────────────
fn sync_mirror(root: &Path, mirror: &Path, files: &[String]) -> Result<(), String> {
    std::fs::create_dir_all(mirror).map_err(|e| format!("{}: {e}", mirror.display()))?;
    let want: HashSet<&str> = files.iter().map(String::as_str).collect();
    for rel in files {
        let (src, dst) = (root.join(rel), mirror.join(rel));
        let raw = std::fs::read(&src).map_err(|e| format!("{rel}: {e}"))?;
        // test-only code (`#[cfg(test)]` items and modules) is blanked, same length and lines, so
        // Graphify only links production code and its line numbers still match the real file
        let body = if rel.ends_with(".rs") { native::sanitize(&String::from_utf8_lossy(&raw)).into_bytes() } else { raw };
        if std::fs::read(&dst).ok().as_deref() == Some(body.as_slice()) {
            continue;
        }
        if let Some(parent) = dst.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(&dst, &body).map_err(|e| format!("{rel}: {e}"))?;
    }
    // drop files no longer claimed (graphify's own output folder is kept)
    let mut stack = vec![mirror.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for e in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
            let p = e.path();
            if e.file_type().is_ok_and(|t| t.is_dir()) {
                if e.file_name() != "graphify-out" {
                    stack.push(p);
                }
            } else if let Ok(rel) = p.strip_prefix(mirror) {
                if !want.contains(rel.to_string_lossy().as_ref()) {
                    let _ = std::fs::remove_file(&p);
                }
            }
        }
    }
    Ok(())
}

fn run_graphify(mirror: &Path, warnings: &mut Vec<String>) -> Option<Value> {
    let mut cmd = match std::env::var_os("SPRAWLER_GRAPHIFY").map(PathBuf::from).or_else(|| which("graphify")) {
        Some(exe) => Command::new(exe),
        None => {
            let mut c = Command::new("uvx");
            c.args(["--from", "graphifyy", "graphify"]);
            c
        }
    };
    let out = cmd.arg("update").arg(mirror).args(["--force", "--no-cluster"]).current_dir(mirror).output();
    match out {
        Err(e) => {
            warnings.push(format!("graphify unavailable: {e}"));
            return None;
        }
        Ok(o) if !o.status.success() => {
            let err = String::from_utf8_lossy(&o.stderr);
            let err = err.trim();
            let tail: String = err.chars().rev().take(300).collect::<Vec<_>>().into_iter().rev().collect();
            warnings.push(format!("graphify exited {}: {tail}", o.status.code().unwrap_or(-1)));
        }
        Ok(_) => {}
    }
    let g = mirror.join("graphify-out").join("graph.json");
    std::fs::read_to_string(g).ok().and_then(|t| serde_json::from_str(&t).ok())
}

// ── crate facts ─────────────────────────────────────────────────────────────
/// Each Cargo.toml's folder → its `[package] name` (else the folder name).
fn crate_names(root: &Path, cargo: &[&str]) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = cargo
        .iter()
        .map(|c| {
            let dir = dirname(c).to_string();
            let name = std::fs::read_to_string(root.join(c))
                .ok()
                .and_then(|t| toml::from_str::<toml::Table>(&t).ok())
                .and_then(|t| t.get("package")?.get("name")?.as_str().map(str::to_string))
                .unwrap_or_else(|| basename(&dir).to_string());
            (dir, name)
        })
        .collect();
    out.sort_by_key(|(d, _)| std::cmp::Reverse(d.len())); // deepest first: nested crates win
    out
}

/// `{crate, target}` for a .rs file: target is test / bench / example / build / bin / lib by where it sits.
fn crate_facts(f: &str, crates: &[(String, String)]) -> Option<Value> {
    let (dir, name) = crates.iter().find(|(d, _)| d == "/" || f.starts_with(&format!("{d}/")) || (d.is_empty()))?;
    let rel = if dir.is_empty() || dir == "/" { f } else { &f[dir.len() + 1..] };
    let kind = match rel.split('/').next().unwrap_or("") {
        "tests" => "test",
        "benches" => "bench",
        "examples" => "example",
        _ if rel == "build.rs" => "build",
        _ if rel == "src/main.rs" || rel.starts_with("src/bin/") => "bin",
        _ => "lib",
    };
    Some(json!({"crate": name, "target": kind}))
}

// ── analyze ─────────────────────────────────────────────────────────────────
/// (weight, relations, first line) per module pair.
type EdgeData = (u64, Vec<String>, Option<u64>);

#[derive(Default)]
struct Edges {
    order: Vec<(String, String)>,
    data: HashMap<(String, String), EdgeData>,
}

impl Edges {
    fn add(&mut self, a: &str, b: &str, rel: &str, line: Option<u64>, known: &HashSet<&str>) {
        if a == b || !known.contains(a) || !known.contains(b) {
            return;
        }
        let k = (a.to_string(), b.to_string());
        let e = self.data.entry(k.clone()).or_insert_with(|| {
            self.order.push(k);
            (0, Vec::new(), None)
        });
        e.0 += 1;
        if !e.1.iter().any(|r| r == rel) {
            e.1.push(rel.to_string());
        }
        if e.2.is_none() {
            e.2 = line.filter(|l| *l > 0);
        }
    }
}

fn analyze(req: &Value) -> Result<Value, String> {
    let root = PathBuf::from(req.get("root").and_then(Value::as_str).ok_or("request has no root")?);
    let files = strs(req.get("files"));
    let tests: HashSet<String> = strs(req.get("tests")).into_iter().collect();
    let minc = req.pointer("/options/min_confidence").and_then(Value::as_f64).unwrap_or(0.8);
    let cache = req.get("cache_dir").and_then(Value::as_str).map(PathBuf::from).unwrap_or_else(|| {
        let tag: String = root.to_string_lossy().chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '_' }).collect();
        std::env::temp_dir().join("sprawler-analyzer-rust").join(tag)
    });
    let mirror = cache.join("mirror");

    let rs: Vec<&str> = files.iter().map(String::as_str).filter(|f| f.ends_with(".rs")).collect();
    let cargo: Vec<&str> = files.iter().map(String::as_str).filter(|f| basename(f) == "Cargo.toml").collect();
    let known: HashSet<&str> = rs.iter().copied().collect();
    let mut warnings = Vec::new();
    let mut symbols: HashMap<&str, [u64; 3]> = rs.iter().map(|f| (*f, [0, 0, 0])).collect();
    let mut samples: HashMap<&str, Vec<(String, String, u64)>> = HashMap::new();
    let mut edges = Edges::default();
    let mut declared: Vec<(String, String)> = Vec::new();
    let mut stats = json!({"nodes": 0, "links": 0});
    let mut impossible = 0u64;

    // native module resolution: follow each crate's `mod` tree and resolve `use` / paths like the compiler.
    // First, because it also finds test-only code, which Graphify must not count either.
    let nat = native::analyze(&root, &files);
    let in_test = |f: &str, line: Option<u64>| {
        nat.test_only.contains(f) || line.is_some_and(|l| nat.test_lines.get(f).is_some_and(|r| r.iter().any(|(a, b)| *a <= l && l <= *b)))
    };
    let mut test_dropped = 0u64;
    let graph = if rs.is_empty() {
        None
    } else {
        sync_mirror(&root, &mirror, &files)?;
        run_graphify(&mirror, &mut warnings)
    };
    if let Some(g) = graph {
        let nodes: &[Value] = g.get("nodes").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
        let links: &[Value] = g.get("links").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
        stats = json!({"nodes": nodes.len(), "links": links.len()});
        let fileof: HashMap<&str, Option<&str>> = nodes
            .iter()
            .filter_map(|n| n.get("id").and_then(Value::as_str).map(|id| (id, n.get("source_file").and_then(Value::as_str).filter(|s| !s.is_empty()))))
            .collect();
        let file_of = |id: Option<&Value>| id.and_then(Value::as_str).and_then(|i| fileof.get(i).copied().flatten());

        // symbols
        for n in nodes {
            let Some(sf) = n.get("source_file").and_then(Value::as_str) else { continue };
            let lab = n.get("label").and_then(Value::as_str).unwrap_or("");
            let Some(&key) = known.get(sf) else { continue };
            let Some(sym) = symbols.get_mut(key) else { continue };
            if lab == basename(sf) {
                continue;
            }
            let kind = if n.get("_callable_class").is_some_and(|v| !v.is_null() && v != &json!(false)) {
                sym[0] += 1;
                "type"
            } else if lab.starts_with('.') {
                sym[2] += 1;
                "method"
            } else if lab.ends_with("()") {
                sym[1] += 1;
                "fn"
            } else {
                continue;
            };
            let s = samples.entry(key).or_default();
            if s.len() < 60 {
                s.push((kind.into(), lab.into(), loc_line(n.get("source_location")).unwrap_or(0)));
            }
        }

        let crate_root = |cargo_rel: &str| -> Option<String> {
            let d = dirname(cargo_rel);
            ["src/lib.rs", "src/main.rs"].iter().map(|c| format!("{d}/{c}")).find(|p| known.contains(p.as_str()))
        };
        let crate_dirs: HashSet<&str> = cargo.iter().map(|c| dirname(c)).collect();
        let crate_of = |f: &str| -> Option<String> {
            let mut d = dirname(f);
            while !d.is_empty() && !crate_dirs.contains(d) {
                d = dirname(d);
            }
            (!d.is_empty()).then(|| d.to_string())
        };
        let mut dep_dirs: HashSet<(String, String)> = HashSet::new();
        for e in links.iter().filter(|e| e.get("relation").and_then(Value::as_str) == Some("depends_on")) {
            let a = file_of(e.get("source")).unwrap_or("");
            let b = file_of(e.get("target")).unwrap_or("");
            if a.ends_with("Cargo.toml") && b.ends_with("Cargo.toml") {
                let sf = e.get("source_file").and_then(Value::as_str).unwrap_or("");
                let other = if a == sf { b } else { a };
                dep_dirs.insert((dirname(sf).to_string(), dirname(other).to_string()));
            }
        }
        for e in links {
            let rel_t = e.get("relation").and_then(Value::as_str).unwrap_or("");
            let sf = e.get("source_file").and_then(Value::as_str).filter(|s| !s.is_empty());
            let (fa, fb) = (file_of(e.get("source")), file_of(e.get("target")));
            let other = if fa == sf {
                fb
            } else if fb == sf {
                fa
            } else {
                None
            };
            if rel_t == "depends_on" {
                if let (Some(s), Some(o)) = (sf, other) {
                    if s.ends_with("Cargo.toml") && o.ends_with("Cargo.toml") {
                        declared.push((s.to_string(), o.to_string()));
                        if let (Some(ra), Some(rb)) = (crate_root(s), crate_root(o)) {
                            edges.add(&ra, &rb, "depends_on", None, &known);
                        }
                    }
                }
                continue;
            }
            if !RUST_REL.contains(&rel_t) || e.get("confidence_score").and_then(Value::as_f64).unwrap_or(1.0) < minc {
                continue;
            }
            let (Some(s), Some(o)) = (sf, other) else { continue };
            if s == o {
                continue;
            }
            if in_test(s, loc_line(e.get("source_location"))) {
                test_dropped += 1; // from test-only code: not a production dependency
                continue;
            }
            let (ca, cb) = (crate_of(s), crate_of(o));
            let linked = matches!((&ca, &cb), (Some(x), Some(y)) if dep_dirs.contains(&(x.clone(), y.clone())));
            if (ca != cb && !linked) || (tests.contains(o) && !tests.contains(s)) {
                // a cross-crate name collision Cargo would never link, or production code → test-only code
                impossible += 1;
                continue;
            }
            edges.add(s, o, rel_t, loc_line(e.get("source_location")), &known);
        }
        stats["impossible"] = json!(impossible);
        stats["testDropped"] = json!(test_dropped);
        if impossible > 0 {
            warnings.push(format!("dropped {impossible} cross-crate Rust refs with no Cargo dependency (resolver name collisions)"));
        }
    }

    // native module resolution: follow each crate's `mod` tree and resolve `use` / paths like the compiler
    let mut native_links = 0u64;
    for l in &nat.links {
        if (tests.contains(&l.target) || nat.test_only.contains(&l.target)) && !tests.contains(&l.source) {
            continue; // production → test-only code is never a real dependency
        }
        edges.add(&l.source, &l.target, l.relation, Some(l.line), &known);
        native_links += 1;
    }
    for d in &nat.declared {
        if !declared.contains(d) {
            declared.push(d.clone());
        }
    }
    let unresolved = nat.unresolved + nat.unresolved_mods.len() as u64;
    if !nat.unresolved_mods.is_empty() {
        let head: Vec<&str> = nat.unresolved_mods.iter().take(4).map(String::as_str).collect();
        warnings.push(format!("{} `mod` declaration(s) point at no scanned file: {}", nat.unresolved_mods.len(), head.join(", ")));
    }
    if !nat.orphans.is_empty() {
        let head: Vec<&str> = nat.orphans.iter().take(4).map(String::as_str).collect();
        warnings.push(format!(
            "{} .rs file(s) are not reached from any crate root through `mod`, so their imports are not followed: {}",
            nat.orphans.len(),
            head.join(", ")
        ));
    }
    stats["native"] = json!({"links": native_links, "orphans": nat.orphans.len(), "unresolvedMods": nat.unresolved_mods.len(), "unresolvedPaths": nat.unresolved,
              "testOnlyFiles": nat.test_only.len(), "testRegions": nat.test_lines.values().map(Vec::len).sum::<usize>(), "testRefsSkipped": nat.test_refs});

    let crates = crate_names(&root, &cargo);
    let modules: Vec<Value> = rs
        .iter()
        .map(|f| {
            let s = symbols[f];
            let mut sample = samples.remove(f).unwrap_or_default();
            sample.sort_by_key(|x| x.2);
            let mut m = json!({"id": f, "path": f, "lang": "rs", "symbols": {"types": s[0], "functions": s[1], "methods": s[2]},
                   "sample": sample.iter().map(|(k, n, l)| json!([k, n, l])).collect::<Vec<_>>()});
            if let Some(facts) = crate_facts(f, &crates) {
                m["facts"] = facts;
            }
            m
        })
        .collect();
    let edges_out: Vec<Value> = edges
        .order
        .iter()
        .map(|k| {
            let (w, rels, line) = &edges.data[k];
            let mut r = rels.clone();
            r.sort();
            json!({"source": k.0, "target": k.1, "relations": r, "weight": w, "line": line})
        })
        .collect();
    Ok(json!({
        "protocol": PROTOCOL, "modules": modules, "edges": edges_out,
        "declared": declared.iter().map(|(a, b)| json!([a, b])).collect::<Vec<_>>(),
        "unknown": {"unresolved": unresolved, "dropped": impossible, "phantoms": []},
        "externals": [], "stats": stats, "warnings": warnings,
    }))
}

fn main() -> ExitCode {
    let cmd = std::env::args().nth(1).unwrap_or_default();
    let out = match cmd.as_str() {
        "describe" => Ok(describe()),
        "analyze" => {
            let mut s = String::new();
            std::io::stdin().read_to_string(&mut s).map_err(|e| e.to_string()).and_then(|_| {
                let req: Value = serde_json::from_str(&s).map_err(|e| format!("bad request: {e}"))?;
                analyze(&req)
            })
        }
        _ => Err("usage: sprawler-analyzer-rust (describe | analyze < request.json)".into()),
    };
    match out {
        Ok(v) => {
            println!("{v}");
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("sprawler-analyzer-rust: {e}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::native::tests::{test_fixture, FIXTURE_FILES};

    /// A stand-in Graphify: links every file mentioning `Local` / `Other` / `Helper` to that type's
    /// file, at the line it appears. Any test-only code that reaches it would become an edge.
    const FAKE_GRAPHIFY: &str = r#"#!/usr/bin/env python3
import json, os, sys
m = sys.argv[2]
files = []
for d, dn, fn in os.walk(m):
    dn[:] = [x for x in dn if x != "graphify-out"]
    files += [os.path.relpath(os.path.join(d, f), m) for f in fn if f.endswith(".rs")]
nodes = [{"id": f, "source_file": f, "label": os.path.basename(f)} for f in files]
links = []
for f in files:
    for n, line in enumerate(open(os.path.join(m, f)).read().split("\n"), 1):
        for name, t in (("Local", "src/local.rs"), ("Other", "src/other.rs"), ("Helper", "src/helper.rs")):
            if name in line and f != t:
                links.append({"source": f, "target": t, "relation": "references", "source_file": f, "source_location": "L%d" % n, "confidence_score": 1.0})
os.makedirs(os.path.join(m, "graphify-out"), exist_ok=True)
json.dump({"nodes": nodes, "links": links}, open(os.path.join(m, "graphify-out", "graph.json"), "w"))
"#;

    fn edges(out: &Value) -> Vec<(String, String, u64)> {
        let s = |e: &Value, k: &str| e[k].as_str().unwrap_or("").to_string();
        out["edges"].as_array().unwrap().iter().map(|e| (s(e, "source"), s(e, "target"), e["line"].as_u64().unwrap_or(0))).collect()
    }

    #[test]
    fn test_only_code_is_excluded_with_and_without_graphify() {
        if which("python3").is_none() {
            eprintln!("skipped: needs python3 for the fake graphify");
            return;
        }
        let d = test_fixture();
        let cache = d.join("cache");
        let fake = d.join("fake-graphify");
        std::fs::write(&fake, FAKE_GRAPHIFY).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        let req = json!({"protocol": PROTOCOL, "root": d.to_string_lossy(), "files": FIXTURE_FILES, "tests": [],
                         "cache_dir": cache.to_string_lossy(), "options": {}});
        for with_graphify in [true, false] {
            // the only test that sets this variable, so nothing races on it
            std::env::set_var("SPRAWLER_GRAPHIFY", if with_graphify { fake.to_string_lossy().into_owned() } else { "sprawler-no-graphify".into() });
            let out = analyze(&req).unwrap();
            let e = edges(&out);
            assert!(e.contains(&("src/app.rs".into(), "src/local.rs".into(), 1)), "graphify={with_graphify}: {e:?}");
            assert!(!e.iter().any(|(a, b, _)| a == "src/app.rs" && b != "src/local.rs"), "graphify={with_graphify}: {e:?}");
            assert!(!e.iter().any(|(a, _, _)| a == "src/tests.rs"), "graphify={with_graphify}: {e:?}");
            if with_graphify {
                assert!(out["stats"]["links"].as_u64().unwrap() > 0, "the fake graphify ran: {}", out["stats"]);
                assert!(out["stats"]["testDropped"].as_u64().unwrap() >= 1, "tests.rs -> other.rs dropped: {}", out["stats"]);
                let orig = std::fs::read_to_string(d.join("src/app.rs")).unwrap();
                let mirrored = std::fs::read_to_string(cache.join("mirror/src/app.rs")).unwrap();
                assert_eq!(orig.len(), mirrored.len());
                assert!(mirrored.starts_with("use crate::local::Local;") && !mirrored.contains("Other") && !mirrored.contains("Helper"));
            }
        }
        std::env::remove_var("SPRAWLER_GRAPHIFY");
        let _ = std::fs::remove_dir_all(&d);
    }
}
