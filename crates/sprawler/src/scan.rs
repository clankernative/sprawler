//! Scan (adapter): walk → plugins → one graph of facts, classified by the profile.
//!
//! modules in walk order (empty files skipped), then extra
//! and virtual modules from plugins (in plugin-name order), edges merged per module pair.
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};
use sprawler_domain::classify::{ctx_label, Classifier, Facts};
use sprawler_protocol::PROTOCOL;

use crate::plugins::{self, Plugin};
use crate::profile::{self, resolve_path, Obj};
use crate::walk;

pub use crate::ports::Scan;

pub fn read_text(path: &Path) -> String {
    let bytes = std::fs::read(path).unwrap_or_default();
    String::from_utf8_lossy(&bytes).replace("\r\n", "\n").replace('\r', "\n")
}

fn loc(text: &str) -> u64 {
    text.lines().filter(|l| !l.trim().is_empty()).count() as u64
}

fn strs(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_string).collect()
}

fn basename(p: &str) -> &str {
    p.rsplit('/').next().unwrap_or(p)
}

fn facts_of(m: &Value) -> Option<Facts> {
    let o = m.get("facts")?.as_object()?;
    Some(o.iter().map(|(k, v)| (k.clone(), v.as_str().map_or_else(|| v.to_string(), str::to_string))).collect())
}

pub fn cache_dir(p: &Obj) -> PathBuf {
    let key = p.get("cache_key").or_else(|| p.get("name")).and_then(Value::as_str).unwrap_or("default");
    resolve_path("~/.cache/sprawler").join(key)
}

/// Options for a plugin: the profile's `[analyzers.<name>.options]`, passed through unchanged.
fn options(p: &Obj, name: &str) -> Value {
    p.get("analyzers").and_then(|a| a.get(name)).and_then(|a| a.get("options")).cloned().unwrap_or(json!({}))
}

/// (weight, relations, first line) per module pair.
type EdgeData = (u64, BTreeSet<String>, Option<u64>);

#[derive(Default)]
struct Edges {
    order: Vec<(String, String)>,
    data: HashMap<(String, String), EdgeData>,
}

pub fn scan(p: &Obj) -> Result<Scan, String> {
    let root = PathBuf::from(p.get("root").and_then(Value::as_str).ok_or("profile has no root")?);
    let cls: Classifier = profile::classifier(p)?;
    let layers = p.get("layers").and_then(Value::as_object).cloned().unwrap_or_default();
    let test_layer = |l: &str| layers.get(l).and_then(|x| x.get("test")).and_then(Value::as_bool).unwrap_or(false);
    let (pre, suf) = (strs(p.get("label_strip_prefix")), strs(p.get("label_strip_suffix")));
    let mut warnings = Vec::new();

    let w = walk::walk(p)?;
    let mut nonempty = Vec::new();
    let mut locs: HashMap<String, u64> = HashMap::new();
    for rel in &w.files {
        let n = loc(&read_text(&root.join(rel)));
        if n > 0 {
            nonempty.push(rel.clone());
            locs.insert(rel.clone(), n);
        }
    }

    // plugins
    let installed = plugins::discover(p, &mut warnings);
    let mut claimable = nonempty.clone();
    claimable.extend(w.cargo.iter().cloned());
    let assigned = plugins::assign(&installed, &claimable);
    let claimed: HashSet<&str> = assigned.iter().flat_map(|(_, f)| f.iter().map(String::as_str)).collect();
    let exts: Vec<String> = strs(p.get("extensions"));
    let mut orphan_ext: BTreeMap<String, u64> = BTreeMap::new();
    for f in &nonempty {
        if let Some(e) = Path::new(f).extension().map(|e| format!(".{}", e.to_string_lossy())) {
            if exts.contains(&e) && !claimed.contains(f.as_str()) {
                *orphan_ext.entry(e).or_default() += 1;
            }
        }
    }
    for (e, n) in &orphan_ext {
        warnings.push(format!("{n} {e} file(s) have no analyzer plugin; they are placed by path only (see `sprawler plugin list`)"));
    }
    let cache = cache_dir(p);
    let results: Vec<(&Plugin, Result<Value, String>)> = std::thread::scope(|s| {
        let handles: Vec<_> = assigned
            .iter()
            .map(|(plugin, files)| {
                let tests: Vec<&String> = files.iter().filter(|f| test_layer(&cls.classify(f, None).layer)).collect();
                let req = json!({"protocol": PROTOCOL, "root": root.to_string_lossy(), "files": files, "tests": tests,
                                 "options": options(p, &plugin.name), "cache_dir": cache.join(&plugin.name).to_string_lossy()});
                s.spawn(move || (*plugin, plugins::analyze(plugin, &req)))
            })
            .collect();
        handles.into_iter().map(|h| h.join().expect("plugin thread")).collect()
    });

    let ok: Vec<(&Plugin, Value)> = results
        .into_iter()
        .filter_map(|(plugin, r)| match r {
            Ok(v) => Some((plugin, v)),
            Err(e) => {
                warnings.push(format!("{} analysis unavailable ({e}); its files are placed by path only and have no dependencies", plugin.name));
                None
            }
        })
        .collect();
    let failed: Vec<&Plugin> = assigned.iter().map(|(pl, _)| *pl).filter(|pl| !ok.iter().any(|(o, _)| o.name == pl.name)).collect();

    let mut facts: HashMap<String, Facts> = HashMap::new();
    for (_, out) in &ok {
        for m in out.get("modules").and_then(Value::as_array).into_iter().flatten() {
            if let (Some(id), Some(f)) = (m.get("id").and_then(Value::as_str), facts_of(m)) {
                facts.insert(id.to_string(), f);
            }
        }
    }

    // modules + contexts
    let mut contexts: Vec<Value> = Vec::new();
    let mut ctx_seen: HashSet<String> = HashSet::new();
    let mut ensure_ctx = |tier: &str, name: &str| -> String {
        let key = format!("{tier}:{name}");
        if ctx_seen.insert(key.clone()) {
            contexts.push(json!({"key": key, "tier": tier, "name": name, "label": ctx_label(name, &pre, &suf)}));
        }
        key
    };
    let mut modules: Vec<Map<String, Value>> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();
    for rel in &nonempty {
        let c = cls.classify(rel, facts.get(rel));
        let ctx = ensure_ctx(&c.tier, &c.ctx);
        let lang = Path::new(basename(rel)).extension().map(|e| e.to_string_lossy().into_owned()).unwrap_or_default();
        let m = json!({"id": rel, "name": basename(rel), "path": rel, "tier": c.tier, "ctx": ctx, "layer": c.layer, "slice": c.slice,
                       "lang": lang, "loc": locs[rel], "symbols": {"types": 0, "functions": 0, "methods": 0}, "sample": [],
                       "test": test_layer(&c.layer), "generated": false, "rule": c.rule});
        index.insert(rel.clone(), modules.len());
        modules.push(m.as_object().cloned().unwrap_or_default());
    }
    let mut emitted: HashSet<String> = HashSet::new();
    for (_, out) in &ok {
        for m in out.get("modules").and_then(Value::as_array).into_iter().flatten() {
            let Some(id) = m.get("id").and_then(Value::as_str) else { continue };
            emitted.insert(id.to_string());
            if let Some(&i) = index.get(id) {
                let t = &mut modules[i];
                for k in ["symbols", "sample"] {
                    if let Some(v) = m.get(k) {
                        t.insert(k.into(), v.clone());
                    }
                }
                if let Some(f) = facts.get(id) {
                    if let Some(r) = f.get("role") {
                        t.insert("role".into(), json!(r));
                    }
                    if let Some(pr) = f.get("project") {
                        t.insert("project".into(), json!(pr));
                    }
                }
                for k in ["evidence", "resolution"] {
                    if let Some(v) = m.get(k) {
                        t.insert(k.into(), v.clone());
                    }
                }
                if let Some(g) = m.get("generated").and_then(Value::as_bool) {
                    t.insert("generated".into(), json!(g));
                }
            }
        }
        // modules the plugin adds: build-system nodes (e.g. .csproj) and virtual ones (generated handles)
        for m in out.get("modules").and_then(Value::as_array).into_iter().flatten() {
            let Some(id) = m.get("id").and_then(Value::as_str) else { continue };
            if index.contains_key(id) || nonempty.iter().any(|f| f == id) {
                continue;
            }
            let symbols = m.get("symbols").cloned().unwrap_or(json!({"types": 0, "functions": 0, "methods": 0}));
            let sample = m.get("sample").cloned().unwrap_or(json!([]));
            let lang = m.get("lang").cloned().unwrap_or(json!(""));
            let name = m.get("name").and_then(Value::as_str).map_or_else(|| basename(id).to_string(), str::to_string);
            let v = if m.get("virtual").and_then(Value::as_bool).unwrap_or(false) {
                let Some(a) = m.get("anchor").and_then(Value::as_str).and_then(|a| index.get(a)).map(|&i| &modules[i]) else { continue };
                json!({"id": id, "name": name, "path": null, "tier": a["tier"], "ctx": a["ctx"], "layer": "generated", "slice": null,
                       "lang": lang, "loc": 0, "symbols": symbols, "sample": sample, "test": false, "generated": true})
            } else {
                let f = facts.get(id);
                let c = cls.classify(id, f);
                let project = f.and_then(|f| f.get("project")).cloned();
                if c.tier == "unmapped" && !modules.iter().any(|x| project.is_some() && x.get("project").and_then(Value::as_str) == project.as_deref()) {
                    continue;
                }
                let ctx = ensure_ctx(&c.tier, &c.ctx);
                let mut v = json!({"id": id, "name": name, "path": id, "tier": c.tier, "ctx": ctx, "layer": c.layer, "slice": null,
                                   "lang": lang, "loc": 0, "symbols": symbols, "sample": sample,
                                   "test": test_layer(&c.layer) || m.get("test").and_then(Value::as_bool).unwrap_or(false),
                                   "generated": false, "rule": c.rule});
                if let Some(r) = f.and_then(|f| f.get("role")) {
                    v["role"] = json!(r);
                }
                if let Some(pr) = project {
                    v["project"] = json!(pr);
                }
                if let Some(e) = m.get("evidence") {
                    v["evidence"] = e.clone();
                }
                v
            };
            index.insert(id.to_string(), modules.len());
            modules.push(v.as_object().cloned().unwrap_or_default());
        }
    }

    // edges, declared, unknowns
    let mut edges = Edges::default();
    let mut declared: BTreeSet<(String, String)> = BTreeSet::new();
    let (mut dropped, mut unresolved) = (0u64, 0u64);
    let mut phantoms = Vec::new();
    let mut externals: Vec<(String, u64)> = Vec::new();
    let mut resolution = Map::new();
    let mut stats = json!({"files": w.files.len(), "cargo": w.cargo.len(), "analyzers": {}});
    let mut analyzers = Vec::new();
    for (plugin, out) in &ok {
        for e in out.get("edges").and_then(Value::as_array).into_iter().flatten() {
            let (Some(a), Some(b)) = (e.get("source").and_then(Value::as_str), e.get("target").and_then(Value::as_str)) else { continue };
            if a == b || !index.contains_key(a) || !index.contains_key(b) {
                continue;
            }
            let k = (a.to_string(), b.to_string());
            let d = edges.data.entry(k.clone()).or_insert_with(|| {
                edges.order.push(k);
                (0, BTreeSet::new(), None)
            });
            d.0 += e.get("weight").and_then(Value::as_u64).unwrap_or(1);
            d.1.extend(strs(e.get("relations")));
            if d.2.is_none() {
                d.2 = e.get("line").and_then(Value::as_u64).filter(|l| *l > 0);
            }
        }
        for pair in out.get("declared").and_then(Value::as_array).into_iter().flatten() {
            let ctx = |id: &str| -> Option<String> {
                match index.get(id) {
                    Some(&i) => modules[i].get("ctx").and_then(Value::as_str).map(str::to_string),
                    None if emitted.contains(id) => None,
                    None => Some(cls.classify(id, None).ctx_key()),
                }
            };
            if let (Some(a), Some(b)) = (pair.get(0).and_then(Value::as_str), pair.get(1).and_then(Value::as_str)) {
                if let (Some(ca), Some(cb)) = (ctx(a), ctx(b)) {
                    declared.insert((ca, cb));
                }
            }
        }
        let u = out.get("unknown");
        dropped += u.and_then(|u| u.get("dropped")).and_then(Value::as_u64).unwrap_or(0);
        unresolved += u.and_then(|u| u.get("unresolved")).and_then(Value::as_u64).unwrap_or(0);
        for ph in u.and_then(|u| u.get("phantoms")).and_then(Value::as_array).into_iter().flatten() {
            let m = ph.get("module").and_then(Value::as_str).unwrap_or("");
            let inst = index.get(m).and_then(|&i| modules[i].get("ctx")).cloned().unwrap_or(json!(m));
            phantoms.push(json!({"instance": inst, "app": ph.get("name"), "module": m}));
        }
        for x in out.get("externals").and_then(Value::as_array).into_iter().flatten() {
            let (Some(k), Some(n)) = (x.get(0).and_then(Value::as_str), x.get(1).and_then(Value::as_u64)) else { continue };
            match externals.iter_mut().find(|(e, _)| e == k) {
                Some((_, c)) => *c += n,
                None => externals.push((k.to_string(), n)),
            }
        }
        if let Some(r) = out.get("resolution") {
            resolution.insert(plugin.name.clone(), r.clone());
        }
        stats["analyzers"][plugin.name.as_str()] = out.get("stats").cloned().unwrap_or(json!({}));
        warnings.extend(strs(out.get("warnings")));
        analyzers.push(json!({"name": plugin.name, "version": plugin.info.get("version"), "exe": plugin.exe.to_string_lossy()}));
    }
    for plugin in failed.iter().filter(|p| p.semantic()) {
        let files = assigned.iter().find(|(p2, _)| p2.name == plugin.name).map_or(0, |(_, f)| f.len());
        resolution.insert(plugin.name.clone(), json!({"lang": plugin.lang(), "failed": true}));
        stats["analyzers"][plugin.name.as_str()] = json!({"files": files, "failed": true, "resolved": 0, "unresolved": 0});
    }
    for ph in &phantoms {
        warnings.push(format!(
            "phantom binding: {} binds '{}' — no app source in scan",
            ph["instance"].as_str().unwrap_or(""),
            ph["app"].as_str().unwrap_or("")
        ));
    }
    externals.sort_by_key(|x| std::cmp::Reverse(x.1));
    externals.truncate(40);

    let edges_out: Vec<Value> = edges
        .order
        .iter()
        .map(|k| {
            let (w, r, line) = &edges.data[k];
            json!({"source": k.0, "target": k.1, "weight": w, "relations": r, "line": line})
        })
        .collect();
    let graph = json!({
        "modules": modules, "contexts": contexts, "edges": edges_out,
        "declared": declared.iter().map(|(a, b)| json!([a, b])).collect::<Vec<_>>(),
        "unknown": {"dropped": dropped, "unresolved": unresolved, "phantoms": phantoms.len()},
        "resolution": resolution,
    });
    Ok(Scan { graph, externals, phantoms, warnings, stats, analyzers })
}
