use regex::Regex;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::Read;
use std::path::Path;

pub fn describe(name: &str, language: &str, extensions: &[&str], files: &[&str]) -> Value {
    json!({"protocol": sprawler_protocol::PROTOCOL, "name": name, "version": env!("CARGO_PKG_VERSION"),
        "languages": [language], "claims": {"extensions": extensions, "files": files},
        "precision": "syntactic", "facts": [], "requires": []})
}

pub fn strings(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_owned).collect()
}
pub fn read_text(path: &Path) -> String {
    std::fs::read_to_string(path).unwrap_or_default()
}
pub fn line(text: &str, pos: usize) -> u64 {
    text.as_bytes()[..pos.min(text.len())].iter().filter(|&&b| b == b'\n').count() as u64 + 1
}
pub fn normalize(path: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for p in path.split('/') {
        match p {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            _ => parts.push(p),
        }
    }
    parts.join("/")
}

type EdgeKey = (String, String);
type EdgeValue = (u64, Vec<String>, Option<u64>);

#[derive(Default)]
pub struct Edges {
    data: HashMap<EdgeKey, EdgeValue>,
}
impl Edges {
    pub fn add(&mut self, a: &str, b: &str, rel: &str, ln: u64) {
        if a == b {
            return;
        }
        let e = self.data.entry((a.to_owned(), b.to_owned())).or_insert((0, Vec::new(), None));
        e.0 += 1;
        if !e.1.iter().any(|x| x == rel) {
            e.1.push(rel.to_owned());
        }
        if e.2.is_none() {
            e.2 = Some(ln);
        }
    }
    pub fn json(self) -> Vec<Value> {
        let mut out: Vec<_> = self.data.into_iter().collect();
        out.sort_by(|a, b| a.0.cmp(&b.0));
        out.into_iter()
            .map(|((source, target), (weight, mut relations, line))| {
                relations.sort();
                json!({"source":source,"target":target,"relations":relations,"weight":weight,"line":line})
            })
            .collect()
    }
}

#[allow(clippy::too_many_arguments)]
pub fn assemble(
    name: &str,
    language: &str,
    modules: Vec<Value>,
    edges: Edges,
    unresolved: u64,
    externals: HashMap<String, u64>,
    mut warnings: Vec<String>,
    extra_stats: Value,
) -> Value {
    let mut ext: Vec<_> = externals.into_iter().collect();
    ext.sort_by(|a, b| a.0.cmp(&b.0));
    if unresolved > 0 {
        warnings.push(format!("{unresolved} import(s) could not be resolved to scanned files"));
    }
    json!({"protocol":sprawler_protocol::PROTOCOL,"modules":modules,"edges":edges.json(),"declared":[],
        "unknown":{"unresolved":unresolved,"dropped":0,"phantoms":[]},"externals":ext.iter().map(|(n,c)|json!([n,c])).collect::<Vec<_>>(),
        "stats":{"analyzer":name,"language":language,"resolved":extra_stats["resolved"],"unresolved":unresolved,"imports":extra_stats["imports"]},"warnings":warnings})
}

pub fn module(rel: &str, language: &str, text: &str) -> Value {
    let types = Regex::new(r"(?m)^\s*(?:export\s+)?(?:declare\s+)?(?:class|interface|type|enum|struct)\s+([\w$]+)").unwrap();
    let funcs = Regex::new(r"(?m)^\s*(?:export\s+)?(?:async\s+)?function\s+([\w$]+)|^\s*(?:def|func)\s+([\w$]+)").unwrap();
    let mut sample = Vec::new();
    let mut nt = 0u64;
    let mut nf = 0u64;
    for cap in types.captures_iter(text) {
        nt += 1;
        if sample.len() < 60 {
            sample.push((line(text, cap.get(0).unwrap().start()), "type", cap[1].to_owned()));
        }
    }
    for cap in funcs.captures_iter(text) {
        nf += 1;
        if sample.len() < 60 {
            sample.push((line(text, cap.get(0).unwrap().start()), "fn", cap.get(1).or(cap.get(2)).unwrap().as_str().to_owned()));
        }
    }
    sample.sort_by_key(|x| x.0);
    json!({"id":rel,"path":rel,"lang":language,"symbols":{"types":nt,"functions":nf,"methods":0},"sample":sample.iter().map(|(l,k,n)|json!([k,n,l])).collect::<Vec<_>>()})
}

pub fn run(name: &str, descriptor: Value, analyze: fn(&Value) -> Result<Value, String>) -> std::process::ExitCode {
    let result = match std::env::args().nth(1).as_deref() {
        Some("describe") => Ok(descriptor),
        Some("analyze") => {
            let mut s = String::new();
            std::io::stdin()
                .read_to_string(&mut s)
                .map_err(|e| e.to_string())
                .and_then(|_| serde_json::from_str(&s).map_err(|e| format!("bad request: {e}")))
                .and_then(|v| analyze(&v))
        }
        _ => Err(format!("usage: sprawler-analyzer-{name} (describe | analyze < request.json)")),
    };
    match result {
        Ok(v) => {
            println!("{v}");
            std::process::ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("sprawler-analyzer-{name}: {e}");
            std::process::ExitCode::FAILURE
        }
    }
}
