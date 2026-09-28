//! `sprawler-analyzer-roc` — Roc facts for Sprawler (protocol `sprawler.analyzer/1`).
//!
//! Resolves `import` lines through each package's aliases (`pf: platform "…"`), marks
//! platform-generated handles (`Data`, `Reads`, …) as virtual modules, and binds company
//! instances (`instance.json` → `apps`) to the App.roc they name. Options come from the
//! profile's `[analyzers.roc.options]`: `package_markers` (default App.roc, main.roc), `default_aliases`, `generated`.
use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::Path;
use std::process::ExitCode;

use regex::Regex;
use serde_json::{json, Map, Value};
use sprawler_protocol::PROTOCOL;

const BUILTIN: [&str; 19] =
    ["Json", "Str", "List", "Dict", "Set", "Num", "Bool", "Result", "Try", "Box", "Encode", "Decode", "Hash", "Inspect", "U8", "U32", "U64", "I64", "Dec"];

/// Profile defaults for a Roc repo with no profile: each package (a folder with a marker file) is a
/// context. Structure only — no policy (that comes from a pack).
fn defaults() -> Value {
    json!({
        "tiers": [{"id": "code", "label": "CODE", "color": "#39ffb0", "depends": [], "cross": "allow"}],
        "layers": {"code": {"label": "Roc module", "ring": 1, "shape": "box", "color": "#b388ff"}},
        "allow": {"code": ["code"]},
        "map": [{"glob": "**/*.roc", "tier": "code", "ctx": "@package", "layer": "code"}],
    })
}

fn describe() -> Value {
    json!({
        "protocol": PROTOCOL, "name": "roc", "version": env!("CARGO_PKG_VERSION"), "languages": ["roc"],
        "claims": {"extensions": [".roc"], "files": ["instance.json"]},
        "precision": "syntactic", "facts": ["package"], "defaults": defaults(), "requires": [],
    })
}

// ── path helpers with Python os.path semantics ──────────────────────────────
fn dirname(p: &str) -> &str {
    p.rsplit_once('/').map_or("", |(d, _)| if d.is_empty() { "/" } else { d })
}

fn basename(p: &str) -> &str {
    p.rsplit_once('/').map_or(p, |(_, b)| b)
}

fn stem(p: &str) -> &str {
    let b = basename(p);
    match b.rfind('.') {
        Some(i) if i > 0 => &b[..i],
        _ => b,
    }
}

fn join(a: &str, b: &str) -> String {
    if b.starts_with('/') || a.is_empty() {
        b.to_string()
    } else if a.ends_with('/') {
        format!("{a}{b}")
    } else {
        format!("{a}/{b}")
    }
}

fn normpath(p: &str) -> String {
    if p.is_empty() {
        return ".".into();
    }
    let abs = p.starts_with('/');
    let mut out: Vec<&str> = Vec::new();
    for c in p.split('/') {
        match c {
            "" | "." => {}
            ".." => {
                if out.last().is_some_and(|x| *x != "..") {
                    out.pop();
                } else if !abs {
                    out.push("..");
                }
            }
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

fn common_prefix(a: &str, b: &str) -> usize {
    a.chars().zip(b.chars()).take_while(|(x, y)| x == y).count()
}

fn line_of(text: &str, byte: usize) -> usize {
    text[..byte].matches('\n').count() + 1
}

/// Python `read_text()`: lossy UTF-8 with universal newlines.
fn read_text(path: &Path) -> String {
    let bytes = std::fs::read(path).unwrap_or_default();
    String::from_utf8_lossy(&bytes).replace("\r\n", "\n").replace('\r', "\n")
}

fn strs(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_string).collect()
}

/// Ordered counter (insertion order kept for ties, like Python's `Counter.most_common`).
#[derive(Default)]
struct Counts(Vec<(String, u64)>);

impl Counts {
    fn add(&mut self, k: &str) {
        match self.0.iter_mut().find(|(x, _)| x == k) {
            Some((_, n)) => *n += 1,
            None => self.0.push((k.to_string(), 1)),
        }
    }
    fn most_common(&self) -> Vec<(String, u64)> {
        let mut v = self.0.clone();
        v.sort_by_key(|x| std::cmp::Reverse(x.1));
        v
    }
    fn total(&self) -> u64 {
        self.0.iter().map(|x| x.1).sum()
    }
}

// ── resolver ────────────────────────────────────────────────────────────────
enum Resolved {
    Module(String),
    Generated(String),
    External,
    Unresolved(String),
    Builtin,
}

struct Resolver {
    root: std::path::PathBuf,
    markers: Vec<String>,
    generated: HashSet<String>,
    defaults: HashMap<String, String>,
    pkg_cache: HashMap<String, Option<String>>,
    pkg_of: HashMap<String, Option<String>>,
    index: HashMap<String, HashMap<String, Vec<String>>>,
    aliases: HashMap<String, HashMap<String, Option<String>>>,
    alias_re: Regex,
}

impl Resolver {
    fn new(root: &Path, opts: &Map<String, Value>, roc: &[String]) -> Self {
        let mut markers = strs(opts.get("package_markers"));
        if markers.is_empty() && !opts.contains_key("package_markers") {
            markers = vec!["App.roc".into(), "main.roc".into()];
        }
        let defaults = opts
            .get("default_aliases")
            .and_then(Value::as_object)
            .map(|o| o.iter().filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string()))).collect())
            .unwrap_or_default();
        let mut r = Resolver {
            root: root.to_path_buf(),
            markers,
            generated: strs(opts.get("generated")).into_iter().collect(),
            defaults,
            pkg_cache: HashMap::new(),
            pkg_of: HashMap::new(),
            index: HashMap::new(),
            aliases: HashMap::new(),
            alias_re: Regex::new(r#"(\w+)\s*:\s*(?:platform\s+)?"([^"]+)""#).unwrap(),
        };
        for rel in roc {
            let pkg = r.find_pkg(dirname(rel));
            r.pkg_of.insert(rel.clone(), pkg.clone());
            if let Some(p) = pkg {
                r.index.entry(p).or_default().entry(stem(rel).to_string()).or_default().push(rel.clone());
            }
        }
        let pkgs: HashSet<String> = r.pkg_of.values().flatten().cloned().collect();
        for p in pkgs {
            let a = r.read_aliases(&p);
            r.aliases.insert(p, a);
        }
        r
    }

    fn find_pkg(&mut self, d: &str) -> Option<String> {
        if let Some(c) = self.pkg_cache.get(d) {
            return c.clone();
        }
        let res = if self.markers.iter().any(|m| self.root.join(d).join(m).exists()) {
            Some(d.to_string())
        } else if !d.is_empty() && d != "." {
            self.find_pkg(dirname(d))
        } else {
            None
        };
        self.pkg_cache.insert(d.to_string(), res.clone());
        res
    }

    fn read_aliases(&self, pkg: &str) -> HashMap<String, Option<String>> {
        let mut out = HashMap::new();
        let names = std::iter::once("main.roc".to_string()).chain(self.markers.iter().cloned());
        for m in names {
            let f = self.root.join(pkg).join(&m);
            if !f.exists() {
                continue;
            }
            let text = read_text(&f);
            let head: String = text.split("\nimport ").next().unwrap_or("").chars().take(4000).collect();
            for c in self.alias_re.captures_iter(&head) {
                let (alias, target) = (c[1].to_string(), c[2].to_string());
                let v = if target.starts_with("http") {
                    None // external platform / package
                } else {
                    let t = normpath(&join(pkg, &target));
                    Some(if t.ends_with(".roc") { dirname(&t).to_string() } else { t })
                };
                out.insert(alias, v);
            }
            break;
        }
        out
    }

    fn pick(cands: &[String], rel: &str) -> String {
        let mut best = &cands[0];
        for c in &cands[1..] {
            if common_prefix(c, rel) > common_prefix(best, rel) {
                best = c;
            }
        }
        best.clone()
    }

    fn resolve(&self, rel: &str, name: &str) -> Resolved {
        let pkg = self.pkg_of.get(rel).cloned().flatten();
        let parts: Vec<&str> = name.split('.').collect();
        if parts.len() > 1 {
            let (alias, st) = (parts[0], parts[parts.len() - 1]);
            let pa = pkg.as_ref().and_then(|p| self.aliases.get(p));
            let target = match pa.and_then(|a| a.get(alias)) {
                Some(v) => v.clone(),
                None => self.defaults.get(alias).cloned(),
            };
            let Some(t) = target else { return Resolved::External };
            return match self.index.get(&t).and_then(|i| i.get(st)) {
                Some(c) if !c.is_empty() => Resolved::Module(Self::pick(c, rel)),
                _ => Resolved::External,
            };
        }
        let st = parts[0];
        if let Some(c) = pkg.as_ref().and_then(|p| self.index.get(p)).and_then(|i| i.get(st)).filter(|c| !c.is_empty()) {
            return Resolved::Module(Self::pick(c, rel));
        }
        if self.generated.contains(st) {
            return Resolved::Generated(st.to_string());
        }
        if BUILTIN.contains(&st) {
            return Resolved::Builtin;
        }
        Resolved::Unresolved(st.to_string())
    }
}

fn symbols(text: &str, ty: &Regex, func: &Regex) -> (Value, Vec<(String, String, usize)>) {
    let (mut sample, mut fns, mut types) = (Vec::new(), 0u64, 0u64);
    for (rx, kind) in [(ty, "type"), (func, "fn")] {
        for c in rx.captures_iter(text) {
            if kind == "type" {
                types += 1;
            } else {
                fns += 1;
            }
            if sample.len() < 60 {
                let m = c.get(0).unwrap();
                sample.push((kind.to_string(), c[1].to_string(), line_of(text, m.start())));
            }
        }
    }
    sample.sort_by_key(|s| s.2);
    (json!({"types": types, "functions": fns, "methods": 0}), sample)
}

// ── analyze ─────────────────────────────────────────────────────────────────
/// (weight, relations, first line) per module pair.
type EdgeData = (u64, Vec<String>, Option<usize>);

struct Edges {
    order: Vec<(String, String)>,
    data: HashMap<(String, String), EdgeData>,
}

impl Edges {
    fn add(&mut self, a: &str, b: &str, rel: &str, line: Option<usize>, known: &HashSet<String>) {
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
            e.2 = line;
        }
    }
}

fn analyze(req: &Value) -> Result<Value, String> {
    let root = Path::new(req.get("root").and_then(Value::as_str).ok_or("request has no root")?).to_path_buf();
    let files = strs(req.get("files"));
    let empty = Map::new();
    let opts = req.get("options").and_then(Value::as_object).unwrap_or(&empty);
    let import_re = Regex::new(r"(?m)^import\s+([A-Za-z0-9_.]+)").unwrap();
    let ty_re = Regex::new(r"(?m)^\t?([A-Z]\w*)\s*::?\s").unwrap();
    let fn_re = Regex::new(r"(?m)^\t?([a-z_][\w!]*)\s*=\s*\|").unwrap();
    let ns_re = Regex::new(r#"namespace:\s*"([^"]+)""#).unwrap();

    let roc: Vec<String> = files.iter().filter(|f| f.ends_with(".roc")).cloned().collect();
    let inst: Vec<String> = files.iter().filter(|f| basename(f) == "instance.json").cloned().collect();
    let texts: HashMap<&str, String> = roc.iter().chain(&inst).map(|r| (r.as_str(), read_text(&root.join(r)))).collect();
    let resolver = Resolver::new(&root, opts, &roc);

    let mut known: HashSet<String> = roc.iter().chain(&inst).cloned().collect();
    let mut modules = Vec::new();
    let mut virtuals: Vec<Value> = Vec::new();
    let mut edges = Edges { order: Vec::new(), data: HashMap::new() };
    let (mut externals, mut unresolved) = (Counts::default(), Counts::default());
    let mut imports = 0u64;

    for rel in &roc {
        let text = &texts[rel.as_str()];
        let (sym, sample) = symbols(text, &ty_re, &fn_re);
        let mut m = json!({"id": rel, "path": rel, "lang": "roc", "symbols": sym,
                            "sample": sample.iter().map(|(k, n, l)| json!([k, n, l])).collect::<Vec<_>>()});
        // the package a file belongs to: the nearest folder holding a package marker (App.roc, main.roc)
        if let Some(pkg) = resolver.pkg_of.get(rel).cloned().flatten() {
            let name = if pkg.is_empty() || pkg == "." { "(root)".to_string() } else { basename(&pkg).to_string() };
            m["facts"] = json!({"package": name});
        }
        modules.push(m);
    }
    for rel in &roc {
        let text = &texts[rel.as_str()];
        for c in import_re.captures_iter(text) {
            imports += 1;
            let name = &c[1];
            let ln = line_of(text, c.get(0).unwrap().start());
            match resolver.resolve(rel, name) {
                Resolved::Module(t) => edges.add(rel, &t, "imports", Some(ln), &known),
                Resolved::Generated(v) => {
                    let pkg = resolver.pkg_of.get(rel).cloned().flatten().unwrap_or_else(|| dirname(rel).to_string());
                    let gid = format!("{pkg}/⟨{v}⟩");
                    if known.insert(gid.clone()) {
                        virtuals.push(json!({"id": gid, "path": null, "lang": "roc", "virtual": true, "anchor": rel, "name": v,
                                             "generated": true, "symbols": {"types": 0, "functions": 0, "methods": 0}, "sample": []}));
                    }
                    edges.add(rel, &gid, "imports", Some(ln), &known);
                }
                Resolved::External => {
                    let p: Vec<&str> = name.split('.').collect();
                    externals.add(&if p.len() > 1 { format!("{}.{}", p[0], p[p.len() - 1]) } else { name.to_string() });
                }
                Resolved::Unresolved(v) => unresolved.add(&v),
                Resolved::Builtin => {}
            }
        }
    }

    // instances bind apps by namespace (or app folder name)
    let root_name = root.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let mut ns: HashMap<String, String> = HashMap::new();
    for rel in roc.iter().filter(|r| basename(r) == "App.roc") {
        if let Some(c) = ns_re.captures(&texts[rel.as_str()]) {
            ns.insert(c[1].to_string(), rel.clone());
        }
        let d = basename(dirname(rel));
        ns.insert(if d.is_empty() { root_name.clone() } else { d.to_string() }, rel.clone());
    }
    let mut phantoms = Vec::new();
    for rel in &inst {
        modules.push(json!({"id": rel, "path": rel, "lang": "json", "symbols": {"types": 0, "functions": 0, "methods": 0}, "sample": []}));
        let Ok(doc) = serde_json::from_str::<Value>(&texts[rel.as_str()]) else { continue };
        let apps: Vec<String> = match doc.get("apps") {
            Some(Value::Object(o)) => o.keys().cloned().collect(),
            Some(Value::Array(a)) => a.iter().filter_map(Value::as_str).map(str::to_string).collect(),
            _ => Vec::new(),
        };
        for app in apps {
            match ns.get(&app) {
                Some(t) => edges.add(rel, t, "binds", None, &known),
                None => phantoms.push(json!({"module": rel, "name": app, "note": "no app source in scan"})),
            }
        }
    }

    let mut warnings = Vec::new();
    if unresolved.total() > 0 {
        let top: Vec<String> = unresolved.most_common().iter().take(8).map(|(k, v)| format!("{k}×{v}")).collect();
        warnings.push(format!("unresolved Roc imports: {}", top.join(", ")));
    }
    modules.extend(virtuals);
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
        "protocol": PROTOCOL, "modules": modules, "edges": edges_out, "declared": [],
        "unknown": {"unresolved": unresolved.total(), "dropped": 0, "phantoms": phantoms},
        "externals": externals.0.iter().map(|(k, n)| json!([k, n])).collect::<Vec<_>>(),
        "stats": {"files": roc.len() + inst.len(), "imports": imports, "unresolved": unresolved.total()},
        "warnings": warnings,
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
        _ => Err("usage: sprawler-analyzer-roc (describe | analyze < request.json)".into()),
    };
    match out {
        Ok(v) => {
            println!("{v}");
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("sprawler-analyzer-roc: {e}");
            ExitCode::FAILURE
        }
    }
}
