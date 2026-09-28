//! Contract seams (adapter): protocol boundaries that are data, not imports.
//!
//! A seam pairs what one side EMITS (e.g. SDK `kind: "get"` literals) with what the other side
//! HANDLES (e.g. `"get" =>` arms in the host decoder). Matched kinds become seam edges; mismatches
//! become findings: `seam-unhandled` (major, fails at runtime) and `seam-dead-handler` (minor).
//! Seams never change the score.
use std::collections::{BTreeSet, HashMap};
use std::path::Path;

use regex::Regex;
use serde_json::{json, Value};
use sprawler_domain::glob::compile_path_glob;

use crate::ports::{Obj, Workspace};

type Sites = Vec<(String, Vec<(String, usize)>)>;

fn basename(p: &str) -> &str {
    p.rsplit('/').next().unwrap_or(p)
}

fn line_of(text: &str, byte: usize) -> usize {
    text.as_bytes()[..byte].iter().filter(|&&c| c == b'\n').count() + 1
}

/// `(offset, body)` of the first brace block opened at a line matching `start` (containing `contains`).
fn block<'a>(text: &'a str, start: &Regex, contains: Option<&str>) -> Option<(usize, &'a str)> {
    let b = text.as_bytes();
    let n = b.len();
    for m in start.find_iter(text) {
        let Some(i) = b[m.start()..].iter().position(|&c| c == b'{').map(|k| m.start() + k) else { continue };
        let (mut depth, mut j) = (0i64, i);
        while j < n {
            let ch = b[j];
            if ch == b'"' {
                j += 1;
                while j < n && b[j] != b'"' {
                    j += if b[j] == b'\\' { 2 } else { 1 };
                }
            } else if b[j..].starts_with(b"//") {
                match b[j..].iter().position(|&c| c == b'\n') {
                    Some(k) => j += k,
                    None => break,
                }
            } else if ch == b'{' {
                depth += 1;
            } else if ch == b'}' {
                depth -= 1;
                if depth == 0 {
                    let body = &text[m.start()..=j];
                    if contains.is_none_or(|c| body.contains(c)) {
                        return Some((m.start(), body));
                    }
                    break;
                }
            }
            j += 1;
        }
    }
    None
}

fn push(found: &mut Sites, kind: &str, site: (String, usize)) {
    match found.iter_mut().find(|(k, _)| k == kind) {
        Some((_, v)) => v.push(site),
        None => found.push((kind.to_string(), vec![site])),
    }
}

fn strs(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_string).collect()
}

/// → kind → [(file, line)], kinds in order of first appearance.
fn scan_side(ws: &dyn Workspace, root: &Path, ids: &[&str], paths: &BTreeSet<&str>, specs: &[Value], handle: bool) -> Result<Sites, String> {
    let lit = Regex::new(r#""([a-z_][a-z0-9_]*)""#).unwrap();
    let mut found: Sites = Vec::new();
    for sp in specs {
        let pat = sp.get("pattern").and_then(Value::as_str).unwrap_or("");
        let pat = Regex::new(&format!("(?m){pat}")).map_err(|e| format!("seam pattern {pat}: {e}"))?;
        let files: Vec<String> = if handle {
            let f = sp.get("file").and_then(Value::as_str).unwrap_or("");
            if ids.contains(&f) {
                vec![f.to_string()]
            } else {
                vec![]
            }
        } else {
            let g = sp.get("glob").and_then(Value::as_str).unwrap_or("");
            let g = compile_path_glob(g).map_err(|e| format!("seam glob {g}: {e}"))?;
            paths.iter().filter(|m| g.is_match(m)).map(|m| m.to_string()).collect()
        };
        let ignore = strs(sp.get("ignore"));
        for f in files {
            let full = root.join(&f);
            if !full.is_file() {
                continue;
            }
            let text = ws.read_text(&full);
            let (off, body) = match sp.get("block").and_then(Value::as_str) {
                Some(start) => {
                    let start = Regex::new(&format!("(?m){start}")).map_err(|e| format!("seam block {start}: {e}"))?;
                    match block(&text, &start, sp.get("contains").and_then(Value::as_str)) {
                        Some(x) => x,
                        None => continue,
                    }
                }
                None => (0, text.as_str()),
            };
            for c in pat.captures_iter(body) {
                let Some(grp) = c.get(1) else { continue };
                let kinds: Vec<String> = if grp.as_str().contains('"') {
                    lit.captures_iter(grp.as_str()).map(|x| x[1].to_string()).collect()
                } else {
                    vec![grp.as_str().to_string()]
                };
                for k in kinds {
                    if !ignore.contains(&k) {
                        push(&mut found, &k, (f.clone(), line_of(&text, off + grp.start())));
                    }
                }
            }
        }
    }
    Ok(found)
}

fn keys(s: &Sites) -> BTreeSet<&str> {
    s.iter().map(|(k, _)| k.as_str()).collect()
}

fn get<'a>(s: &'a Sites, k: &str) -> &'a [(String, usize)] {
    s.iter().find(|(x, _)| x == k).map_or(&[], |(_, v)| v.as_slice())
}

/// `{file: line}` keeping first-seen file order and the LAST line per file (Python dict semantics).
fn per_file(v: &[(String, usize)]) -> Vec<(String, usize)> {
    let mut out: Vec<(String, usize)> = Vec::new();
    for (f, l) in v {
        match out.iter_mut().find(|(x, _)| x == f) {
            Some(e) => e.1 = *l,
            None => out.push((f.clone(), *l)),
        }
    }
    out
}

fn site(v: &[(String, usize)]) -> Value {
    json!(v.iter().take(6).map(|(f, l)| json!({"file": f, "line": l})).collect::<Vec<_>>())
}

pub fn attach_seams(p: &Obj, ws: &dyn Workspace, atlas: &mut Value) -> Result<(), String> {
    atlas["seams"] = json!([]);
    let cfg = p.get("seams").and_then(Value::as_array).cloned().unwrap_or_default();
    if cfg.is_empty() {
        return Ok(());
    }
    let root = Path::new(p.get("root").and_then(Value::as_str).unwrap_or(".")).to_path_buf();
    let mods: Vec<Value> = atlas["modules"].as_array().cloned().unwrap_or_default();
    let midx: HashMap<String, usize> = mods.iter().enumerate().filter_map(|(i, m)| Some((m["id"].as_str()?.to_string(), i))).collect();
    let ctx = |id: &str| midx.get(id).map_or(Value::Null, |&i| mods[i]["ctx"].clone());
    let ids: Vec<&str> = mods.iter().filter_map(|m| m["id"].as_str()).collect();
    let paths: BTreeSet<&str> = mods.iter().filter(|m| m["path"].is_string()).filter_map(|m| m["id"].as_str()).collect();
    let mut edge_at: HashMap<(String, String), usize> = HashMap::new();
    for (i, e) in atlas["edges"].as_array().into_iter().flatten().enumerate() {
        if let (Some(a), Some(b)) = (e["source"].as_str(), e["target"].as_str()) {
            edge_at.insert((a.to_string(), b.to_string()), i);
        }
    }
    let mut new_viol: Vec<Value> = Vec::new();
    let mut seams_out = Vec::new();
    for s in &cfg {
        let id = s.get("id").and_then(Value::as_str).unwrap_or("").to_string();
        let empty = vec![];
        let emit = s.get("emit").and_then(Value::as_array).unwrap_or(&empty);
        let handle = s.get("handle").and_then(Value::as_array).unwrap_or(&empty);
        let ignore = strs(s.get("ignore"));
        let e_all = scan_side(ws, &root, &ids, &paths, emit, false)?;
        let h_all = scan_side(ws, &root, &ids, &paths, handle, true)?;
        let em: Sites = e_all.into_iter().filter(|(k, _)| !ignore.contains(k)).collect();
        let hd: Sites = h_all.into_iter().filter(|(k, _)| !ignore.contains(k)).collect();
        let (ke, kh) = (keys(&em), keys(&hd));
        let matched: Vec<&str> = ke.intersection(&kh).copied().collect();
        let unhandled: Vec<&str> = ke.difference(&kh).copied().collect();
        let dead: Vec<&str> = kh.difference(&ke).copied().collect();
        let home_h = handle.iter().filter_map(|sp| sp.get("file").and_then(Value::as_str)).find(|f| midx.contains_key(*f)).map(str::to_string);
        let emitters: BTreeSet<&str> = em.iter().flat_map(|(_, v)| v.iter().map(|(f, _)| f.as_str())).collect();
        let handlers: BTreeSet<&str> = hd.iter().flat_map(|(_, v)| v.iter().map(|(f, _)| f.as_str())).collect();
        let home_e = emitters.iter().next().map(|s| s.to_string());

        let mut edge = |a: &str, b: &str, status: &str, rule: Option<&str>, sev: Option<&str>, msg: Option<&str>, kind: &str, line: usize| {
            let key = (a.to_string(), b.to_string());
            let edges = atlas["edges"].as_array_mut().expect("edges");
            let i = match edge_at.get(&key) {
                Some(&i) if edges[i].get("seam").is_some_and(|x| !x.is_null() && x != &json!(false)) => i,
                Some(&i) => {
                    // a real import already connects them; keep it, tag the seam on it
                    let e = &mut edges[i];
                    if !e["seamKinds"].is_array() {
                        e["seamKinds"] = json!([]);
                    }
                    e["seamKinds"].as_array_mut().unwrap().push(json!(kind));
                    return;
                }
                None => {
                    edges.push(json!({"source": a, "target": b, "weight": 0, "relations": [format!("seam:{id}")], "line": line,
                                      "status": status, "rule": rule, "severity": sev, "message": msg, "test": false,
                                      "crossCtx": ctx(a) != ctx(b), "seam": id, "seamKinds": []}));
                    edge_at.insert(key, edges.len() - 1);
                    edges.len() - 1
                }
            };
            let e = &mut edges[i];
            e["weight"] = json!(e["weight"].as_u64().unwrap_or(0) + 1);
            e["seamKinds"].as_array_mut().unwrap().push(json!(kind));
            if status == "violation" && e["status"] != "violation" {
                e["status"] = json!("violation");
                e["rule"] = json!(rule);
                e["severity"] = json!(sev);
                e["message"] = json!(msg);
                e["line"] = json!(line);
            }
        };

        for k in &matched {
            let (hf, _) = &get(&hd, k)[0];
            for (f, ln) in per_file(get(&em, k)) {
                if &f != hf {
                    edge(&f, hf, "cross", None, None, None, k, ln);
                }
            }
        }
        for k in &unhandled {
            let Some(hh) = &home_h else { continue };
            for (f, ln) in per_file(get(&em, k)) {
                if &f == hh {
                    continue;
                }
                let msg = format!("`{k}` is emitted by {} but {} has no handler for it — this fails at runtime", basename(&f), basename(hh));
                edge(&f, hh, "violation", Some("seam-unhandled"), Some("major"), Some(&msg), k, ln);
                new_viol.push(json!([f, hh, k, ln, "seam-unhandled", "major", msg]));
            }
        }
        for k in &dead {
            let (hf, hl) = &get(&hd, k)[0];
            let Some(he) = &home_e else { continue };
            if hf == he {
                continue;
            }
            let note = s.get("note").and_then(Value::as_str).map_or(String::new(), |n| format!(" ({n})"));
            let msg = format!("{}:{hl} handles `{k}` but no SDK emitter produces it — dead handler{note}", basename(hf));
            edge(hf, he, "violation", Some("seam-dead-handler"), Some("minor"), Some(&msg), k, *hl);
            new_viol.push(json!([hf, he, k, hl, "seam-dead-handler", "minor", msg]));
        }
        seams_out.push(json!({
            "id": id, "label": s.get("label").cloned().unwrap_or(json!(id)), "note": s.get("note").cloned().unwrap_or(Value::Null),
            "emitters": emitters, "handlers": handlers, "matched": matched, "unhandled": unhandled, "dead": dead,
            "emitted": em.iter().map(|(k, v)| (k.clone(), site(v))).collect::<serde_json::Map<_, _>>(),
            "handled": hd.iter().map(|(k, v)| (k.clone(), site(v))).collect::<serde_json::Map<_, _>>(),
        }));
    }
    atlas["seams"] = json!(seams_out);
    for v in new_viol {
        let (a, b, k, ln, rule, sev, msg) = (&v[0], &v[1], &v[2], &v[3], &v[4], &v[5], &v[6]);
        let (a_s, b_s) = (a.as_str().unwrap_or(""), b.as_str().unwrap_or(""));
        atlas["violations"].as_array_mut().expect("violations").push(json!({
            "id": format!("{}|{a_s}|{b_s}|{}", rule.as_str().unwrap_or(""), k.as_str().unwrap_or("")),
            "rule": rule, "severity": sev, "message": msg, "source": a, "target": b,
            "fromCtx": ctx(a_s), "toCtx": ctx(b_s), "weight": 1, "line": ln, "seam": true, "kind": k,
        }));
        if let Some(&i) = midx.get(a_s) {
            let m = &mut atlas["modules"][i];
            m["violations"] = json!(m["violations"].as_u64().unwrap_or(0) + 1);
        }
    }
    let w = |v: &Value| match v["severity"].as_str() {
        Some("critical") => 5.0,
        Some("major") => 2.0,
        Some("minor") => 0.5,
        _ => 0.0,
    };
    if let Some(vs) = atlas["violations"].as_array_mut() {
        vs.sort_by(|a, b| {
            w(b).partial_cmp(&w(a))
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| a["rule"].as_str().cmp(&b["rule"].as_str()))
                .then_with(|| a["source"].as_str().cmp(&b["source"].as_str()))
        });
    }
    Ok(())
}
