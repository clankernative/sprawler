//! Architecture views (adapter), configured by the profile's `[views]` table:
//!
//! - **Interfaces** (`atlas.ports`): the boundaries code depends on — who calls each one, and who
//!   implements it (verified by `implements` links or contract seams, else a name match).
//! - **Use cases** (`atlas.flows`): a path from an entry point (endpoint, command, job) inward through
//!   chosen layers to interfaces and their implementers. A `registry` names use cases from a
//!   registration file instead (e.g. Clankernative's `App.roc` `operations: { … }`).
//!
//! Without configuration both views are empty and `atlas.views` says what to add.
use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::Path;

use regex::Regex;
use serde_json::{json, Map, Value};

use crate::ports::{Obj, Workspace};

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}

fn strs(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_string).collect()
}

fn truthy(v: &Value, k: &str) -> bool {
    match v.get(k) {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::String(x)) => !x.is_empty(),
        Some(_) => true,
    }
}

fn dirname(p: &str) -> &str {
    p.rsplit_once('/').map_or("", |(d, _)| d)
}

fn stem(p: &str) -> &str {
    let b = p.rsplit('/').next().unwrap_or(p);
    match b.rfind('.') {
        Some(i) if i > 0 && !b[..i].chars().all(|c| c == '.') => &b[..i],
        _ => b,
    }
}

fn tokens(name: &str) -> Vec<String> {
    let mut snake = String::new();
    for (i, c) in stem(name).chars().enumerate() {
        if i > 0 && c.is_ascii_uppercase() {
            snake.push('_');
        }
        snake.push(c);
    }
    snake.to_lowercase().split(['_', '-']).filter(|t| !t.is_empty()).map(str::to_string).collect()
}

fn contains(hay: &[String], needle: &[String]) -> bool {
    !needle.is_empty() && hay.windows(needle.len()).any(|w| w == needle)
}

fn ordered_counts(keys: impl Iterator<Item = String>) -> Vec<(String, u64)> {
    let mut v: Vec<(String, u64)> = Vec::new();
    for k in keys {
        match v.iter_mut().find(|(x, _)| *x == k) {
            Some((_, n)) => *n += 1,
            None => v.push((k, 1)),
        }
    }
    v.sort_by_key(|x| std::cmp::Reverse(x.1));
    v
}

fn in_or_any(list: &[String], v: &str) -> bool {
    list.is_empty() || list.iter().any(|x| x == v)
}

// ── configuration ───────────────────────────────────────────────────────────
struct Interfaces {
    label: String,
    tiers: Vec<String>,
    layers: Vec<String>,
    impl_tiers: Vec<String>,
    impl_layers: Vec<String>,
    caller_tier: Option<String>,
}

impl Interfaces {
    fn from(p: &Obj) -> Self {
        let c = p.get("views").and_then(|v| v.get("interfaces")).cloned().unwrap_or(json!({}));
        Interfaces {
            label: c.get("label").and_then(Value::as_str).unwrap_or("Interfaces").to_string(),
            tiers: strs(c.get("tiers")),
            layers: strs(c.get("layers")),
            impl_tiers: strs(c.get("implementer_tiers")),
            impl_layers: strs(c.get("implementer_layers")),
            caller_tier: c.get("caller_tier").and_then(Value::as_str).map(str::to_string),
        }
    }
    fn enabled(&self) -> bool {
        !self.layers.is_empty()
    }
    fn is_iface(&self, m: &Value) -> bool {
        self.enabled() && self.layers.iter().any(|l| l == s(m, "layer")) && in_or_any(&self.tiers, s(m, "tier"))
    }
    fn is_impl(&self, m: &Value) -> bool {
        !self.impl_layers.is_empty() && self.impl_layers.iter().any(|l| l == s(m, "layer")) && in_or_any(&self.impl_tiers, s(m, "tier")) && !truthy(m, "test")
    }
}

struct Registry {
    file: String,
    layer: Option<String>,
    block: Regex,
    entry: Regex,
    namespace: Option<Regex>,
    handles: Map<String, Value>,
}

struct UseCases {
    label: String,
    entry: Vec<String>,
    through: Vec<String>,
    same_context: bool,
    depth: usize,
    registry: Option<Registry>,
}

impl UseCases {
    fn from(p: &Obj) -> Result<Self, String> {
        let c = p.get("views").and_then(|v| v.get("use_cases")).cloned().unwrap_or(json!({}));
        let re = |k: &str, v: &Value| -> Result<Option<Regex>, String> {
            match v.get(k).and_then(Value::as_str) {
                Some(x) => Regex::new(x).map(Some).map_err(|e| format!("views.use_cases.registry.{k}: {e}")),
                None => Ok(None),
            }
        };
        let registry = match c.get("registry") {
            Some(r) => Some(Registry {
                file: s(r, "file").to_string(),
                layer: r.get("layer").and_then(Value::as_str).map(str::to_string),
                block: re("block", r)?.ok_or("views.use_cases.registry needs `block`")?,
                entry: re("entry", r)?.ok_or("views.use_cases.registry needs `entry`")?,
                namespace: re("namespace", r)?,
                handles: r.get("handles").and_then(Value::as_object).cloned().unwrap_or_default(),
            }),
            None => None,
        };
        Ok(UseCases {
            label: c.get("label").and_then(Value::as_str).unwrap_or("Use cases").to_string(),
            entry: strs(c.get("entry")),
            through: strs(c.get("through")),
            same_context: c.get("same_context").and_then(Value::as_bool).unwrap_or(true),
            depth: c.get("depth").and_then(Value::as_u64).unwrap_or(3) as usize,
            registry,
        })
    }
    fn enabled(&self) -> bool {
        !self.entry.is_empty() || self.registry.is_some()
    }
}

// ── interfaces ──────────────────────────────────────────────────────────────
fn build_interfaces(atlas: &Value, cfg: &Interfaces) -> Vec<Value> {
    if !cfg.enabled() {
        return vec![];
    }
    let modules: Vec<&Value> = atlas["modules"].as_array().map(|a| a.iter().collect()).unwrap_or_default();
    let mods: HashMap<&str, &Value> = modules.iter().map(|m| (s(m, "id"), *m)).collect();
    let mut callers: HashMap<&str, Vec<&str>> = HashMap::new();
    // verified implementers: an `implements` link, or a handler file that decodes what the interface emits
    let mut verified: HashMap<String, BTreeSet<String>> = HashMap::new();
    for e in atlas["edges"].as_array().into_iter().flatten() {
        if truthy(e, "test") || truthy(e, "seam") {
            continue;
        }
        callers.entry(s(e, "target")).or_default().push(s(e, "source"));
        let implements = e["relations"].as_array().is_some_and(|r| r.iter().any(|x| x == "implements"));
        if implements && mods.get(s(e, "source")).is_some_and(|m| cfg.is_impl(m)) {
            verified.entry(s(e, "target").to_string()).or_default().insert(s(e, "source").to_string());
        }
    }
    for sm in atlas["seams"].as_array().into_iter().flatten() {
        for k in sm["matched"].as_array().into_iter().flatten().filter_map(Value::as_str) {
            for em in sm["emitted"][k].as_array().into_iter().flatten() {
                for h in sm["handled"][k].as_array().into_iter().flatten() {
                    verified.entry(s(em, "file").to_string()).or_default().insert(s(h, "file").to_string());
                }
            }
        }
    }
    let impls: Vec<(&str, Vec<String>)> = modules.iter().filter(|m| cfg.is_impl(m)).map(|m| (s(m, "id"), tokens(s(m, "id")))).collect();
    let mut out: Vec<(u64, usize, String, Value)> = Vec::new();
    for m in modules.iter().filter(|m| cfg.is_iface(m)) {
        let id = s(m, "id");
        let cs: Vec<&str> = callers.get(id).into_iter().flatten().copied().collect::<BTreeSet<_>>().into_iter().collect();
        let by_ctx = ordered_counts(cs.iter().map(|c| mods.get(c).map_or(String::new(), |x| s(x, "ctx").to_string())));
        let apps = match &cfg.caller_tier {
            Some(t) => by_ctx.iter().filter(|(k, _)| k.starts_with(&format!("{t}:"))).count(),
            None => by_ctx.iter().filter(|(k, _)| k != s(m, "ctx")).count(),
        } as u64;
        let tok = tokens(id);
        let ver: Vec<String> = verified.get(id).map(|x| x.iter().cloned().collect()).unwrap_or_default();
        let mut guessed: Vec<String> = impls.iter().filter(|(h, ht)| contains(ht, &tok) && !ver.iter().any(|v| v == h)).map(|(h, _)| h.to_string()).collect();
        guessed.sort();
        let imp: Vec<String> = ver.iter().chain(&guessed).take(12).cloned().collect();
        let name = stem(s(m, "name")).to_string();
        let v = json!({
            "id": id, "name": name, "ctx": s(m, "ctx"), "callers": cs,
            "callerCtx": by_ctx.iter().map(|(k, n)| (k.clone(), json!(n))).collect::<Map<_, _>>(),
            "apps": apps, "implementers": imp, "verified": ver,
            "implEvidence": if ver.is_empty() { "name-match (unverified)" } else { "verified (implements / contract seam)" },
        });
        out.push((apps, cs.len(), name, v));
    }
    out.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.cmp(&a.1)).then_with(|| a.2.cmp(&b.2)));
    out.into_iter().map(|x| x.3).collect()
}

// ── use cases ───────────────────────────────────────────────────────────────
struct Graph<'a> {
    mods: HashMap<&'a str, &'a Value>,
    modules: Vec<&'a Value>,
    out_adj: HashMap<&'a str, Vec<&'a str>>,
    in_adj: HashMap<&'a str, Vec<&'a str>>,
    violations: Vec<&'a Value>,
    impl_of: HashMap<&'a str, Vec<&'a str>>,
}

fn stage_keys(uc: &UseCases) -> Vec<String> {
    let mut k = vec!["entry".to_string(), "op".to_string()];
    k.extend(uc.through.iter().filter(|t| !matches!(t.as_str(), "entry" | "op" | "port" | "adapter")).cloned());
    k.extend(["port".to_string(), "adapter".to_string()]);
    k
}

/// Walk from `mid` through the use case's layers; returns (stages, every module seen).
fn walk<'a>(g: &Graph<'a>, uc: &UseCases, ifc: &Interfaces, mid: &'a str, entry: Vec<String>) -> (Map<String, Value>, HashSet<&'a str>) {
    let m = g.mods[mid];
    let keys = stage_keys(uc);
    let mut stages: HashMap<String, Vec<String>> = keys.iter().map(|k| (k.clone(), Vec::new())).collect();
    stages.insert("op".into(), vec![mid.to_string()]);
    stages.insert("entry".into(), entry);
    let none: Vec<&str> = Vec::new();
    let mut seen: HashSet<&str> = HashSet::from([mid]);
    let mut frontier = vec![mid];
    for _ in 0..uc.depth {
        let mut nxt = Vec::new();
        for cur in &frontier {
            for &t in g.out_adj.get(cur).unwrap_or(&none) {
                if seen.contains(t) {
                    continue;
                }
                let Some(tm) = g.mods.get(t) else { continue };
                let layer = s(tm, "layer");
                if ifc.is_iface(tm) {
                    seen.insert(t);
                    stages.get_mut("port").unwrap().push(t.to_string());
                } else if (!uc.same_context || s(tm, "ctx") == s(m, "ctx")) && uc.through.iter().any(|x| x == layer) && stages.contains_key(layer) {
                    seen.insert(t);
                    stages.get_mut(layer).unwrap().push(t.to_string());
                    nxt.push(t);
                }
            }
        }
        frontier = nxt;
    }
    for pt in stages["port"].clone() {
        let add: Vec<String> = g.impl_of.get(pt.as_str()).into_iter().flatten().take(3).map(|x| x.to_string()).collect();
        stages.get_mut("adapter").unwrap().extend(add);
    }
    let mut out = Map::new();
    for k in keys {
        let v: Vec<String> = stages[&k].iter().cloned().collect::<BTreeSet<_>>().into_iter().collect();
        out.insert(k, json!(v));
    }
    (out, seen)
}

/// How a use case is named: `ns.op`, and the registration file it came from (if any).
struct Named {
    id: String,
    op: String,
    ns: String,
    registered: Value,
}

fn flow(g: &Graph, uc: &UseCases, ifc: &Interfaces, mid: &str, n: Named, entry: Vec<String>) -> Value {
    let Named { id, op, ns, registered } = n;
    let m = g.mods[mid];
    let (stages, seen) = walk(g, uc, ifc, g.mods.get_key_value(mid).map(|(k, _)| *k).unwrap(), entry);
    let path: Vec<Value> = stages.values().flat_map(|v| v.as_array().cloned().unwrap_or_default()).collect();
    let viol: Vec<usize> = g.violations.iter().enumerate().filter(|(_, v)| seen.contains(s(v, "source")) || s(v, "target") == mid).map(|(i, _)| i).collect();
    json!({"id": id, "op": op, "ns": ns, "ctx": s(m, "ctx"), "kind": s(m, "layer"), "module": mid,
           "registeredIn": registered, "stages": stages, "path": path, "violations": viol})
}

fn build_use_cases(p: &Obj, ws: &dyn Workspace, atlas: &Value, uc: &UseCases, ifc: &Interfaces, ports: &[Value]) -> Vec<Value> {
    if !uc.enabled() {
        return vec![];
    }
    let root = Path::new(p.get("root").and_then(Value::as_str).unwrap_or(".")).to_path_buf();
    let modules: Vec<&Value> = atlas["modules"].as_array().map(|a| a.iter().collect()).unwrap_or_default();
    let mut g = Graph {
        mods: modules.iter().map(|m| (s(m, "id"), *m)).collect(),
        modules: modules.clone(),
        out_adj: HashMap::new(),
        in_adj: HashMap::new(),
        violations: atlas["violations"].as_array().map(|a| a.iter().collect()).unwrap_or_default(),
        impl_of: ports.iter().map(|p| (s(p, "id"), p["implementers"].as_array().into_iter().flatten().filter_map(Value::as_str).collect())).collect(),
    };
    for e in atlas["edges"].as_array().into_iter().flatten() {
        if truthy(e, "test") || truthy(e, "seam") {
            continue;
        }
        g.out_adj.entry(s(e, "source")).or_default().push(s(e, "target"));
        g.in_adj.entry(s(e, "target")).or_default().push(s(e, "source"));
    }
    let none: Vec<&str> = Vec::new();
    let mut flows: Vec<Value> = Vec::new();
    match &uc.registry {
        // named by a registration file, e.g. App.roc `operations: { submit: Submit.definition }`
        Some(reg) => {
            let regs =
                g.modules.iter().filter(|m| s(m, "name") == reg.file && reg.layer.as_deref().is_none_or(|l| s(m, "layer") == l) && !s(m, "path").is_empty());
            for app in regs {
                let full = root.join(s(app, "path"));
                if !full.is_file() {
                    continue;
                }
                let text = ws.read_text(&full);
                let app_ctx = s(app, "ctx");
                let fallback = app_ctx.split_once(':').map_or(app_ctx, |x| x.1).to_string();
                let ns = reg.namespace.as_ref().and_then(|r| r.captures(&text)).map_or(fallback, |c| c[1].to_string());
                let Some(block) = reg.block.captures(&text) else { continue };
                let body = block.get(1).map_or("", |m| m.as_str());
                let prefix = format!("{}/", dirname(s(app, "path")));
                let mut by_stem: HashMap<&str, &str> = HashMap::new();
                for m in g.modules.iter().filter(|m| s(m, "ctx") == app_ctx && !s(m, "path").is_empty() && s(m, "path").starts_with(&prefix)) {
                    by_stem.insert(stem(s(m, "name")), s(m, "id"));
                }
                for c in reg.entry.captures_iter(body) {
                    let (op, st) = (c[1].to_string(), &c[2]);
                    let Some(&mid) = by_stem.get(st) else { continue };
                    let m = g.mods[mid];
                    let mut entry: Vec<String> = Vec::new();
                    for src in g.in_adj.get(mid).unwrap_or(&none) {
                        if g.mods.get(src).is_some_and(|x| uc.entry.iter().any(|e| e == s(x, "layer"))) {
                            entry.push(src.to_string());
                        }
                    }
                    // entry points that reach the use case through a generated handle (e.g. `Commands`)
                    let handle = reg.handles.get(s(m, "layer")).or_else(|| reg.handles.get("*")).and_then(Value::as_str);
                    if let Some(h) = handle {
                        for d in g.modules.iter().filter(|x| s(x, "ctx") == s(m, "ctx") && uc.entry.iter().any(|e| e == s(x, "layer"))) {
                            let hit =
                                g.out_adj.get(s(d, "id")).unwrap_or(&none).iter().any(|t| {
                                    g.mods.get(t).is_some_and(|tm| tm.get("generated").and_then(Value::as_bool).unwrap_or(false) && s(tm, "name") == h)
                                });
                            if hit {
                                entry.push(s(d, "id").to_string());
                            }
                        }
                    }
                    flows.push(flow(&g, uc, ifc, mid, Named { id: format!("{ns}.{op}"), op, ns: ns.clone(), registered: json!(s(app, "id")) }, entry));
                }
            }
        }
        // every module in an entry layer starts a use case
        None => {
            for m in g.modules.iter().filter(|m| uc.entry.iter().any(|e| e == s(m, "layer")) && !truthy(m, "test")) {
                let mid = s(m, "id");
                let ns = s(m, "ctx").split_once(':').map_or(s(m, "ctx"), |x| x.1).to_string();
                let op = stem(s(m, "name")).to_string();
                flows.push(flow(&g, uc, ifc, mid, Named { id: format!("{ns}.{op}"), op, ns, registered: Value::Null }, vec![]));
            }
        }
    }
    flows.sort_by(|a, b| (s(a, "ctx"), s(a, "kind"), s(a, "op")).cmp(&(s(b, "ctx"), s(b, "kind"), s(b, "op"))));
    flows
}

/// What the UI shows for each view: labels, stage names, and what to configure when empty.
fn meta(p: &Obj, ifc: &Interfaces, uc: &UseCases, n_if: usize, n_uc: usize) -> Value {
    let layer_label = |l: &str| p.get("layers").and_then(|x| x.get(l)).and_then(|x| x.get("label")).and_then(Value::as_str).unwrap_or(l).to_uppercase();
    let stages: Vec<Value> = stage_keys(uc)
        .iter()
        .map(|k| {
            let label = match k.as_str() {
                "entry" => "ENTRY".to_string(),
                "op" => uc.label.trim_end_matches('s').to_uppercase(),
                "port" => ifc.label.to_uppercase(),
                "adapter" => "IMPLEMENTERS".to_string(),
                l => layer_label(l),
            };
            json!({"key": k, "label": label})
        })
        .collect();
    let if_hint = if !ifc.enabled() {
        "Not configured. Add `[views.interfaces] layers = [\"…\"]` to your profile to list the boundaries code depends on (docs/CONFIG.md)."
    } else if n_if == 0 {
        "No modules in the configured interface layers."
    } else {
        ""
    };
    let uc_hint = if !uc.enabled() {
        "Not configured. Add `[views.use_cases] entry = [\"…\"]` to your profile to trace paths from entry points inward (docs/CONFIG.md)."
    } else if n_uc == 0 {
        "No modules in the configured entry layers."
    } else {
        ""
    };
    json!({
        "interfaces": {"label": ifc.label, "enabled": ifc.enabled(), "hint": if_hint},
        "use_cases": {"label": uc.label, "enabled": uc.enabled(), "hint": uc_hint, "stages": stages},
    })
}

pub fn attach_views(p: &Obj, ws: &dyn Workspace, atlas: &mut Value) -> Result<(), String> {
    let ifc = Interfaces::from(p);
    let uc = UseCases::from(p)?;
    let ports = build_interfaces(atlas, &ifc);
    let flows = build_use_cases(p, ws, atlas, &uc, &ifc, &ports);
    atlas["views"] = meta(p, &ifc, &uc, ports.len(), flows.len());
    atlas["ports"] = json!(ports);
    atlas["flows"] = json!(flows);
    Ok(())
}
