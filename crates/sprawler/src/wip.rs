//! Construction state (application): the working tree vs HEAD on modules, edges and violations.
//!
//! Module `wip`: `null` | `"new"` (untracked / added) | `"mod"` (modified / renamed), with `wipAdd` /
//! `wipDel` line counts. Edge `wip`: the dependency does not exist at HEAD. How that is known:
//!
//! - source or target is a new file → the edge cannot exist at HEAD;
//! - source modified → **HEAD text**: the edge is new when the source now names the target (its file
//!   stem, or its folder for `mod.rs` / `index.ts` / Go packages) and its HEAD version does not;
//! - and, in `sprawler serve`, a **session baseline**: the edge set first seen for the current HEAD.
//!   An edge from a modified file that is missing from it was added during the session.
//!
//! Imports are not re-resolved per language at HEAD (that would need each analyzer to run on HEAD
//! blobs); the HEAD-text check catches new imports of names the old file never mentioned.
use std::collections::{BTreeSet, HashMap, HashSet};

use serde_json::{json, Value};
use sprawler_domain::classify::Classifier;

use crate::ports::{Obj, WorkTree, Workspace};

/// The session baseline for wip edges, owned by the server: the edge set first seen for a HEAD.
#[derive(Debug, Default)]
pub struct Baseline {
    key: Option<String>,
    edges: Option<HashSet<(String, String)>>,
}

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}

/// Which HEAD(s) an atlas was built at.
fn head_key(atlas: &Value) -> String {
    let p = &atlas["project"];
    match p["repos"].as_array().filter(|r| !r.is_empty()) {
        Some(rs) => rs.iter().map(|h| format!("{}@{}", s(h, "repo"), s(h, "sha"))).collect::<Vec<_>>().join("|"),
        None => s(p, "sha").to_string(),
    }
}

fn nonblank(text: &str) -> u64 {
    text.lines().filter(|l| !l.trim().is_empty()).count() as u64
}

fn count_lines(text: &str) -> u64 {
    text.matches('\n').count() as u64 + u64::from(!text.is_empty() && !text.ends_with('\n'))
}

/// The name a source file uses to refer to a module: its file stem, or its folder for `mod.rs`,
/// `index.ts`, `__init__.py` and Go (which imports packages, not files).
fn names_of(m: &Value) -> Vec<String> {
    let id = m["path"].as_str().unwrap_or_else(|| s(m, "name"));
    let base = id.rsplit('/').next().unwrap_or(id);
    let stem = base.split_once('.').map_or(base, |(a, _)| a).trim_matches(|c| c == '⟨' || c == '⟩');
    let by_folder = matches!(stem, "mod" | "lib" | "main" | "index" | "__init__") || base.ends_with(".go");
    let name = if by_folder { id.rsplit('/').nth(1).unwrap_or("") } else { stem };
    if name.is_empty() {
        Vec::new()
    } else {
        vec![name.to_string()]
    }
}

fn mentions(text: &str, name: &str) -> bool {
    let word = |c: char| c.is_alphanumeric() || c == '_';
    text.match_indices(name).any(|(i, _)| {
        let before = text[..i].chars().next_back();
        let after = text[i + name.len()..].chars().next();
        !before.is_some_and(word) && !after.is_some_and(word)
    })
}

/// Tag modules / edges / violations with construction state and add `atlas.wip`.
pub fn attach_wip(p: &Obj, ws: &dyn Workspace, atlas: &mut Value, cls: &Classifier, baseline: Option<&mut Baseline>) {
    let wt = ws.worktree(p);
    attach_with(p, ws, atlas, cls, baseline, &wt);
}

fn attach_with(p: &Obj, ws: &dyn Workspace, atlas: &mut Value, cls: &Classifier, baseline: Option<&mut Baseline>, wt: &WorkTree) {
    let root = std::path::PathBuf::from(p.get("root").and_then(Value::as_str).unwrap_or("."));
    let files = &wt.files;
    let mut wip_of: HashMap<String, &'static str> = HashMap::new();
    let mut ids: HashSet<String> = HashSet::new();
    for m in atlas["modules"].as_array_mut().into_iter().flatten() {
        let id = s(m, "id").to_string();
        let f = files.get(&id).filter(|f| m["path"].is_string() && matches!(f.st, "new" | "mod"));
        match f {
            Some(f) => {
                let add = f.add.unwrap_or_else(|| count_lines(&ws.read_text(&root.join(&id))));
                m["wip"] = json!(f.st);
                m["wipAdd"] = json!(add);
                m["wipDel"] = json!(f.del);
                wip_of.insert(id.clone(), f.st);
            }
            None => {
                m["wip"] = Value::Null;
                m["wipAdd"] = json!(0);
                m["wipDel"] = json!(0);
            }
        }
        ids.insert(id);
    }

    // HEAD versions: deleted would-be modules (were they buildings?) and modified sources (what did they name?)
    let deleted: Vec<&String> = files.iter().filter(|(id, f)| f.st == "del" && !ids.contains(*id) && f.walkable).map(|(id, _)| id).collect();
    let modified: Vec<&String> = wip_of.iter().filter(|(_, st)| **st == "mod").map(|(id, _)| id).collect();
    // a renamed file's HEAD version lives at its old path
    let head_id = |id: &String| files.get(id).and_then(|f| f.orig.clone()).unwrap_or_else(|| id.clone());
    let mut want: Vec<String> = deleted.iter().map(|id| (*id).clone()).chain(modified.iter().map(|id| head_id(id))).collect();
    want.sort();
    want.dedup();
    let heads = if want.is_empty() { HashMap::new() } else { ws.head_texts(p, &want) };

    let mut demolished = Vec::new();
    for id in &deleted {
        if heads.get(*id).is_some_and(|t| nonblank(t) == 0) {
            continue; // the scan skips empty files: this never was a building
        }
        let c = cls.classify(id, None);
        let mut d = json!({"path": id, "ctx": c.ctx_key(), "tier": c.tier, "del": files[*id].del});
        if let Some(r) = &files[*id].renamed {
            d["renamed"] = json!(r);
        }
        demolished.push(d);
    }

    // session baseline (server only): the first edge set seen for this HEAD
    let edges = atlas["edges"].as_array().cloned().unwrap_or_default();
    let cur_keys: HashSet<(String, String)> = edges.iter().map(|e| (s(e, "source").to_string(), s(e, "target").to_string())).collect();
    let base_edges: Option<HashSet<(String, String)>> = baseline.map(|b| {
        let key = head_key(atlas);
        if b.key.as_deref() != Some(key.as_str()) {
            let new = match &b.edges {
                None => cur_keys.clone(), // first scan of the session: everything present counts as HEAD
                // HEAD moved: clean sources are at HEAD; wip sources keep what the old baseline knew
                Some(old) => cur_keys.iter().filter(|k| !wip_of.contains_key(&k.0) || old.contains(*k)).cloned().collect(),
            };
            b.key = Some(key);
            b.edges = Some(new);
        }
        b.edges.clone().unwrap_or_default()
    });

    let by_id: HashMap<&str, &Value> = atlas["modules"].as_array().into_iter().flatten().map(|m| (s(m, "id"), m)).collect();
    let cur_text: HashMap<&String, String> = modified.iter().map(|id| (*id, ws.read_text(&root.join(id.as_str())))).collect();
    let mut wip_edge: HashMap<(String, String), bool> = HashMap::new();
    let mut flags = Vec::with_capacity(edges.len());
    for e in &edges {
        let (a, b) = (s(e, "source"), s(e, "target"));
        let (wa, wb) = (wip_of.get(a).copied(), wip_of.get(b).copied());
        let seam = e.get("seam").is_some_and(|x| !x.is_null() && x != &json!(false));
        let w = if wa == Some("new") || wb == Some("new") {
            true
        } else if wa == Some("mod") && !seam {
            let head = heads.get(&head_id(&a.to_string()));
            let named_now: Vec<String> = match (cur_text.get(&a.to_string()), by_id.get(b)) {
                (Some(t), Some(m)) => names_of(m).into_iter().filter(|n| mentions(t, n)).collect(),
                _ => Vec::new(),
            };
            let by_text = head.is_some_and(|h| !named_now.is_empty() && !named_now.iter().any(|n| mentions(h, n)));
            let by_session = base_edges.as_ref().is_some_and(|base| !base.contains(&(a.to_string(), b.to_string())));
            by_text || by_session
        } else {
            false
        };
        wip_edge.insert((a.to_string(), b.to_string()), w);
        flags.push(w);
    }
    for (e, w) in atlas["edges"].as_array_mut().into_iter().flatten().zip(&flags) {
        e["wip"] = json!(w);
    }
    let mut n_viol = 0;
    for v in atlas["violations"].as_array_mut().into_iter().flatten() {
        let w = wip_edge.get(&(s(v, "source").to_string(), s(v, "target").to_string())).copied().unwrap_or(false);
        v["wip"] = json!(w);
        n_viol += usize::from(w);
    }

    let mods: Vec<&Value> = atlas["modules"].as_array().into_iter().flatten().filter(|m| !m["wip"].is_null()).collect();
    let sum = |k: &str| mods.iter().filter_map(|m| m[k].as_u64()).sum::<u64>();
    let ctxs: BTreeSet<String> =
        mods.iter().map(|m| s(m, "ctx").to_string()).chain(demolished.iter().filter(|d| s(d, "tier") != "unmapped").map(|d| s(d, "ctx").to_string())).collect();
    let deleted_set: HashSet<&String> = deleted.iter().copied().collect();
    let basis = if base_edges.is_some() { "head-text+session-baseline" } else { "head-text" };
    let summary = json!({
        "files": mods.len() + demolished.len(),
        "new": mods.iter().filter(|m| m["wip"] == "new").count(),
        "mod": mods.iter().filter(|m| m["wip"] == "mod").count(),
        "added": sum("wipAdd"),
        "deleted": sum("wipDel") + demolished.iter().filter_map(|d| d["del"].as_u64()).sum::<u64>(),
        "demolished": demolished,
        "contexts": ctxs,
        "edges": flags.iter().filter(|w| **w).count(),
        "violations": n_viol,
        "other": files.keys().filter(|id| !ids.contains(*id) && !deleted_set.contains(id)).count(),
        "edgeBasis": {"new": "file-is-new", "roc": basis, "other": basis},
        "git": wt.git,
    });
    atlas["wip"] = summary;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ports::{GitStat, ModuleIndex, Scan, WorkFile};
    use std::collections::BTreeMap;
    use std::path::Path;

    /// Text and HEAD versions in memory; no git, no disk.
    struct Fake {
        now: HashMap<String, String>,
        head: HashMap<String, String>,
    }

    impl Workspace for Fake {
        fn scan(&self, _: &Obj) -> Result<Scan, String> {
            Err("unused".into())
        }
        fn read_text(&self, path: &Path) -> String {
            let id = path.to_string_lossy().trim_start_matches("/r/").to_string();
            self.now.get(&id).cloned().unwrap_or_default()
        }
        fn history(&self, _: &str, _: &[String], _: &ModuleIndex, _: &Classifier, _: usize) -> Vec<Value> {
            Vec::new()
        }
        fn head(&self, _: &str, _: &[String]) -> Value {
            Value::Null
        }
        fn worktree(&self, _: &Obj) -> WorkTree {
            WorkTree::default()
        }
        fn head_texts(&self, _: &Obj, ids: &[String]) -> HashMap<String, String> {
            ids.iter().filter_map(|i| Some((i.clone(), self.head.get(i)?.clone()))).collect()
        }
        fn file_stats(&self, _: &Obj, _: &HashSet<&str>, _: usize) -> HashMap<String, GitStat> {
            HashMap::new()
        }
        fn now(&self) -> i64 {
            0
        }
    }

    fn profile() -> Obj {
        json!({"root": "/r", "tiers": [{"id": "app"}], "map": [{"glob": "**", "tier": "app", "ctx": "a", "layer": "core"}]}).as_object().cloned().unwrap()
    }

    fn atlas(sha: &str, edges: &[(&str, &str)]) -> Value {
        let m = |id: &str| json!({"id": id, "path": id, "name": id, "ctx": "app:a"});
        json!({"project": {"sha": sha}, "modules": [m("x.rs"), m("y.rs"), m("z.rs"), m("n.rs")],
               "edges": edges.iter().map(|(a, b)| json!({"source": a, "target": b})).collect::<Vec<_>>(), "violations": []})
    }

    fn wt(files: &[(&str, &'static str)]) -> WorkTree {
        let files: BTreeMap<String, WorkFile> =
            files.iter().map(|(id, st)| (id.to_string(), WorkFile { st, add: Some(1), del: 0, orig: None, renamed: None, walkable: true })).collect();
        WorkTree { files, git: true }
    }

    #[test]
    fn session_baseline() {
        let p = profile();
        let cls = Classifier::from_profile(&p).unwrap();
        // neither version names its targets: only the session baseline can tell
        let ws = Fake { now: HashMap::new(), head: [("x.rs".to_string(), String::new())].into() };
        let mut base = Baseline::default();
        let mut a1 = atlas("h1", &[("x.rs", "y.rs")]);
        attach_with(&p, &ws, &mut a1, &cls, Some(&mut base), &wt(&[("x.rs", "mod")]));
        assert_eq!(a1["edges"][0]["wip"], false); // boot: pre-existing edges count as HEAD
        let mut a2 = atlas("h1", &[("x.rs", "y.rs"), ("x.rs", "z.rs")]);
        attach_with(&p, &ws, &mut a2, &cls, Some(&mut base), &wt(&[("x.rs", "mod")]));
        assert_eq!((a2["edges"][0]["wip"].as_bool(), a2["edges"][1]["wip"].as_bool()), (Some(false), Some(true)));
        assert_eq!(a2["wip"]["edgeBasis"]["other"], "head-text+session-baseline");
        // commit: HEAD moves, x is clean again → its edges join the baseline
        let mut a3 = atlas("h2", &[("x.rs", "y.rs"), ("x.rs", "z.rs")]);
        attach_with(&p, &ws, &mut a3, &cls, Some(&mut base), &wt(&[]));
        assert!(base.edges.as_ref().unwrap().contains(&("x.rs".to_string(), "z.rs".to_string())));
        assert_eq!(a3["wip"]["edges"], 0);
    }

    #[test]
    fn head_text_and_new_files() {
        let p = profile();
        let cls = Classifier::from_profile(&p).unwrap();
        let ws = Fake {
            now: [("x.rs".to_string(), "use crate::y;\nuse crate::z::Thing;\n".to_string())].into(),
            head: [("x.rs".to_string(), "use crate::y;\n// zz only\n".to_string())].into(),
        };
        let mut a = atlas("h1", &[("x.rs", "y.rs"), ("x.rs", "z.rs"), ("n.rs", "y.rs")]);
        attach_with(&p, &ws, &mut a, &cls, None, &wt(&[("x.rs", "mod"), ("n.rs", "new")]));
        let w: Vec<bool> = a["edges"].as_array().unwrap().iter().map(|e| e["wip"].as_bool().unwrap()).collect();
        assert_eq!(w, [false, true, true]);
        assert_eq!(a["wip"]["edgeBasis"]["other"], "head-text");
        assert_eq!((a["wip"]["new"].as_u64(), a["wip"]["mod"].as_u64(), a["wip"]["edges"].as_u64()), (Some(1), Some(1), Some(2)));
    }

    #[test]
    fn names_and_mentions() {
        assert_eq!(names_of(&json!({"path": "src/views/mod.rs"})), ["views"]);
        assert_eq!(names_of(&json!({"path": "pkg/core/D.roc"})), ["D"]);
        assert_eq!(names_of(&json!({"path": "internal/store/db.go"})), ["store"]);
        assert!(names_of(&json!({"path": "main.rs"})).is_empty());
        assert_eq!(names_of(&json!({"path": null, "name": "Wire"})), ["Wire"]);
        assert!(mentions("import D\n", "D"));
        assert!(!mentions("import DD\n", "D"));
        assert!(!mentions("let d_x = 1", "d"));
    }
}
