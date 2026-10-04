//! Town events: what changed between two atlases (scan N−1 → scan N), as typed, UI-ready events.
//!
//! Every event is `{kind, sev, …}` with `sev` one of `info | good | warn | bad` and optional fields
//! (`ctx`, `ctxs`, `module`, `modules`, `source`, `target`, `rule`, `severity`, `count`, `from`, `to`,
//! `sha`, `subject`, `author`, `branch`, `seam`, `kinds`, `wip`, `summary`). The server stamps `id` and
//! `t` and keeps the log; this module only compares. More than [`FLOOD`] events of one kind in one scan
//! become one event with `aggregated: true`, a `count` and a `sample`.
use std::collections::{BTreeSet, HashMap, HashSet};

use serde_json::{json, Map, Value};

/// More than this many events of one kind in one scan → one aggregated event.
pub const FLOOD: usize = 40;
const SAMPLE: usize = 8;

/// (source context, target context) of a road.
type ContextPair = (Value, Value);
const GRADES: [&str; 6] = ["F", "D", "C", "B", "A", "S"];

fn grade_rank(g: &str) -> usize {
    GRADES.iter().position(|x| *x == g).unwrap_or(0)
}

fn sev_of(severity: &str) -> &'static str {
    if severity == "minor" {
        "warn"
    } else {
        "bad"
    }
}

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}

fn arr(v: &Value) -> &[Value] {
    v.as_array().map_or(&[], Vec::as_slice)
}

fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::String(x) => !x.is_empty(),
        Value::Number(n) => n.as_f64() != Some(0.0),
        Value::Array(a) => !a.is_empty(),
        Value::Object(o) => !o.is_empty(),
    }
}

/// An event; fields given as `null` are left out.
fn ev(kind: &str, sev: &str, fields: Vec<(&str, Value)>) -> Value {
    let mut m = Map::new();
    m.insert("kind".into(), json!(kind));
    m.insert("sev".into(), json!(sev));
    for (k, v) in fields {
        if !v.is_null() {
            m.insert(k.into(), v);
        }
    }
    Value::Object(m)
}

fn opt(v: Option<&Value>) -> Value {
    v.cloned().unwrap_or(Value::Null)
}

/// `{repo: (sha, branch)}`; a single repo is keyed `""`.
fn repo_heads(a: &Value) -> Vec<(String, Value, Value)> {
    let p = &a["project"];
    match p.get("repos").and_then(Value::as_array).filter(|r| !r.is_empty()) {
        Some(rs) => rs.iter().map(|h| (s(h, "repo").to_string(), opt(h.get("sha")), opt(h.get("branch")))).collect(),
        None => vec![(String::new(), opt(p.get("sha")), opt(p.get("branch")))],
    }
}

fn short_sha(c: &Value) -> Value {
    c.get("short").filter(|x| truthy(x)).or_else(|| c.get("sha")).cloned().unwrap_or(Value::Null)
}

fn commit_event(c: &Value) -> Value {
    let mods = arr(&c["modules"]);
    ev(
        "commit",
        "info",
        vec![
            ("sha", short_sha(c)),
            ("subject", opt(c.get("subject"))),
            ("author", opt(c.get("author"))),
            ("count", json!(mods.len())),
            ("modules", json!(mods.iter().take(20).collect::<Vec<_>>())),
            ("ctxs", opt(c.get("contexts"))),
            ("blast", opt(c.get("blast"))),
            ("shotgun", opt(c.get("shotgun"))),
            ("repo", opt(c.get("repo"))),
        ],
    )
}

/// The first scan of a session: one `boot` summary instead of a `build.start` per pre-existing site,
/// plus the commits that landed while the server was down (authored after `since_t`, the newest logged
/// event, and not already logged by sha).
pub fn boot_events(cur: &Value, since_t: Option<i64>, logged: &HashSet<String>) -> Vec<Value> {
    let mut out = Vec::new();
    if let Some(t) = since_t.filter(|t| *t > 0) {
        let news: Vec<&Value> = arr(&cur["history"])
            .iter()
            .filter(|c| c["ts"].as_i64().unwrap_or(0) > t && !logged.contains(s(c, "short")) && !logged.contains(s(c, "sha")))
            .collect();
        out.extend(news.iter().rev().map(|c| commit_event(c)));
    }
    let w = &cur["wip"];
    let sites: Vec<&Value> = arr(&cur["modules"]).iter().filter(|m| truthy(&m["wip"])).collect();
    let p = &cur["project"];
    let n = |k: &str| json!(w[k].as_u64().unwrap_or(0));
    out.push(ev(
        "boot",
        "info",
        vec![
            ("count", w.get("files").cloned().unwrap_or(json!(sites.len()))),
            ("ctxs", opt(w.get("contexts"))),
            ("modules", json!(sites.iter().take(20).map(|m| m["id"].clone()).collect::<Vec<_>>())),
            ("sha", opt(p.get("sha"))),
            ("branch", opt(p.get("branch"))),
            (
                "summary",
                json!({"new": n("new"), "mod": n("mod"), "demolished": arr(&w["demolished"]).len(), "added": n("added"),
                       "deleted": n("deleted"), "edges": n("edges"), "violations": n("violations")}),
            ),
        ],
    ));
    coalesce(out, FLOOD)
}

fn by_id<'a>(xs: &'a Value, key: &str) -> HashMap<&'a str, &'a Value> {
    arr(xs).iter().filter_map(|x| Some((x.get(key)?.as_str()?, x))).collect()
}

/// Scan `prev` → scan `cur` as events (without `id` / `t`).
pub fn diff_atlas(prev: &Value, cur: &Value) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    let pm = by_id(&prev["modules"], "id");
    let cm = by_id(&cur["modules"], "id");
    let (ph, ch) = (repo_heads(prev), repo_heads(cur));
    let phm: HashMap<&str, (&Value, &Value)> = ph.iter().map(|(r, sha, b)| (r.as_str(), (sha, b))).collect();
    let head_moved = ch.iter().any(|(r, sha, _)| phm.get(r.as_str()).map_or(&Value::Null, |x| x.0) != sha);
    let switched: Vec<(&str, &Value, &Value)> = ch
        .iter()
        .filter_map(|(r, _, b)| {
            let (_, pb) = phm.get(r.as_str())?;
            (truthy(pb) && truthy(b) && *pb != b).then_some((r.as_str(), *pb, b))
        })
        .collect();

    // ── branch / commits ──
    for (r, a, b) in &switched {
        let sha = ch.iter().find(|x| x.0 == *r).map_or(Value::Null, |x| x.1.clone());
        out.push(ev(
            "branch",
            "info",
            vec![("from", (*a).clone()), ("to", (*b).clone()), ("sha", sha), ("repo", if r.is_empty() { Value::Null } else { json!(r) })],
        ));
    }
    let mut new_commits: Vec<&Value> = Vec::new();
    if head_moved {
        let seen: HashSet<&str> = arr(&prev["history"]).iter().map(|c| s(c, "sha")).collect();
        new_commits = arr(&cur["history"]).iter().filter(|c| !seen.contains(s(c, "sha"))).collect();
        if switched.is_empty() {
            // on a branch switch the "new" commits are just the other branch's past
            out.extend(new_commits.iter().rev().map(|c| commit_event(c)));
        }
    }
    // the commit that opened this building, if HEAD moved
    let landed = |mid: &str| -> Vec<(&'static str, Value)> {
        if !head_moved {
            return Vec::new();
        }
        let c = new_commits.iter().find(|c| arr(&c["modules"]).iter().any(|m| m.as_str() == Some(mid))).or(new_commits.first());
        c.map_or_else(Vec::new, |c| vec![("sha", short_sha(c)), ("subject", opt(c.get("subject")))])
    };

    // ── buildings ──
    let pdem = by_id(&prev["wip"]["demolished"], "path");
    let cdem = by_id(&cur["wip"]["demolished"], "path");
    for m in arr(&cur["modules"]) {
        if !truthy(&m["path"]) {
            continue;
        }
        let mid = s(m, "id");
        let p = pm.get(mid);
        let w = s(m, "wip");
        let pw = p.map_or("", |p| s(p, "wip"));
        let ctx = || ("ctx", m["ctx"].clone());
        if w == "new" && (p.is_none() || pw != "new") {
            out.push(ev("build.start", "info", vec![("module", json!(mid)), ctx(), ("count", opt(m.get("wipAdd")))]));
        } else if w == "mod" && pw != "mod" {
            out.push(ev("build.renovate", "info", vec![("module", json!(mid)), ctx(), ("count", opt(m.get("wipAdd")))]));
        } else if w.is_empty() && p.is_some() && !pw.is_empty() {
            let mut f = vec![("module", json!(mid)), ctx(), ("from", json!(pw))];
            f.extend(landed(mid));
            out.push(ev("build.open", "good", f));
        } else if w.is_empty() && p.is_none() && !pdem.contains_key(mid) {
            let mut f = vec![("module", json!(mid)), ctx()];
            f.extend(landed(mid));
            out.push(ev("module.added", "info", f));
        }
    }
    for p in arr(&prev["modules"]) {
        let mid = s(p, "id");
        if cm.contains_key(mid) || !truthy(&p["path"]) || cdem.contains_key(mid) {
            continue; // still there, or the demolition is reported below
        }
        let wip = if truthy(&p["wip"]) { json!(true) } else { Value::Null };
        out.push(ev("module.removed", "info", vec![("module", json!(mid)), ("ctx", p["ctx"].clone()), ("wip", wip)]));
    }
    for d in arr(&cur["wip"]["demolished"]) {
        if !pdem.contains_key(s(d, "path")) {
            out.push(ev(
                "build.demolish",
                "warn",
                vec![("module", d["path"].clone()), ("ctx", opt(d.get("ctx"))), ("count", opt(d.get("del"))), ("to", opt(d.get("renamed")))],
            ));
        }
    }
    for d in arr(&prev["wip"]["demolished"]) {
        let path = s(d, "path");
        if cdem.contains_key(path) {
            continue;
        }
        let restored = cm.contains_key(path);
        let to = if restored {
            "restored"
        } else if head_moved {
            "committed"
        } else {
            "gone"
        };
        let mut f = vec![("module", json!(path)), ("ctx", opt(d.get("ctx"))), ("to", json!(to))];
        if !restored {
            f.extend(landed(path));
        }
        out.push(ev("build.cleared", "info", f));
    }

    // ── roads ──
    let pe: HashSet<(&str, &str)> = arr(&prev["edges"]).iter().map(|e| (s(e, "source"), s(e, "target"))).collect();
    let ctx_of = |id: &str| cm.get(id).map_or(Value::Null, |m| m["ctx"].clone());
    // roads opened between each pair of contexts (in order of appearance)
    let mut opened: Vec<(ContextPair, Vec<(&str, &str)>)> = Vec::new();
    for e in arr(&cur["edges"]) {
        let k = (s(e, "source"), s(e, "target"));
        if pe.contains(&k) || s(e, "status") == "violation" || truthy(&e["test"]) {
            continue;
        }
        let (ca, cb) = (ctx_of(k.0), ctx_of(k.1));
        if truthy(&e["wip"]) {
            out.push(ev("road.paving", "info", vec![("source", json!(k.0)), ("target", json!(k.1)), ("ctx", ca.clone()), ("ctxs", json!([ca, cb]))]));
        } else {
            match opened.iter_mut().find(|(c, _)| c.0 == ca && c.1 == cb) {
                Some((_, ks)) => ks.push(k),
                None => opened.push(((ca, cb), vec![k])),
            }
        }
    }
    for ((ca, cb), ks) in opened {
        out.push(ev(
            "road.open",
            "info",
            vec![("ctx", ca.clone()), ("ctxs", json!([ca, cb])), ("count", json!(ks.len())), ("source", json!(ks[0].0)), ("target", json!(ks[0].1))],
        ));
    }

    // ── violations ──
    let pv = by_id(&prev["violations"], "id");
    let cv = by_id(&cur["violations"], "id");
    for v in arr(&cur["violations"]) {
        let old = pv.get(s(v, "id"));
        let wip = truthy(&v["wip"]);
        if old.is_none() || old.is_some_and(|o| truthy(&o["wip"]) && !wip) {
            let mut f = vec![
                ("rule", v["rule"].clone()),
                ("severity", v["severity"].clone()),
                ("source", v["source"].clone()),
                ("target", v["target"].clone()),
                ("ctx", opt(v.get("fromCtx"))),
                ("ctxs", json!([opt(v.get("fromCtx")), opt(v.get("toCtx"))])),
                ("wip", json!(wip)),
            ];
            if old.is_some() {
                f.push(("from", json!("wip")));
            }
            out.push(ev("track.cut", sev_of(s(v, "severity")), f));
        }
    }
    for v in arr(&prev["violations"]) {
        if !cv.contains_key(s(v, "id")) {
            out.push(ev(
                "track.closed",
                "good",
                vec![
                    ("rule", v["rule"].clone()),
                    ("severity", v["severity"].clone()),
                    ("source", v["source"].clone()),
                    ("target", v["target"].clone()),
                    ("ctx", opt(v.get("fromCtx"))),
                    ("ctxs", json!([opt(v.get("fromCtx")), opt(v.get("toCtx"))])),
                ],
            ));
        }
    }

    // ── seams ──
    let ps = by_id(&prev["seams"], "id");
    let set = |v: Option<&Value>, k: &str| -> BTreeSet<String> {
        v.map(|x| arr(&x[k]).iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default()
    };
    for sm in arr(&cur["seams"]) {
        let o = ps.get(s(sm, "id")).copied();
        let (cu, ou) = (set(Some(sm), "unhandled"), set(o, "unhandled"));
        let broke: Vec<&String> = cu.difference(&ou).collect();
        let fixed: Vec<&String> = ou.difference(&cu).collect();
        let dead: Vec<String> = set(Some(sm), "dead").difference(&set(o, "dead")).cloned().collect();
        for (kind, sev, kinds) in [("bridge.broken", "bad", json!(broke)), ("bridge.fixed", "good", json!(fixed)), ("bridge.dead", "warn", json!(dead))] {
            let n = arr(&kinds).len();
            if n > 0 {
                out.push(ev(kind, sev, vec![("seam", sm["id"].clone()), ("kinds", kinds), ("count", json!(n))]));
            }
        }
    }

    // ── grades, score, trophies ──
    let pc = by_id(&prev["contexts"], "key");
    for c in arr(&cur["contexts"]) {
        let Some(o) = pc.get(s(c, "key")) else { continue };
        let (og, cg) = (s(o, "grade"), s(c, "grade"));
        if og != cg {
            let up = grade_rank(cg) > grade_rank(og);
            out.push(ev(
                if up { "grade.up" } else { "grade.down" },
                if up { "good" } else { "bad" },
                vec![("ctx", c["key"].clone()), ("from", o["grade"].clone()), ("to", c["grade"].clone())],
            ));
        }
        if truthy(&c["nest"]) && !truthy(&o["nest"]) {
            out.push(ev("nest.new", "warn", vec![("ctx", c["key"].clone())]));
        } else if truthy(&o["nest"]) && !truthy(&c["nest"]) {
            out.push(ev("nest.gone", "good", vec![("ctx", c["key"].clone())]));
        }
    }
    if let (Some(a), Some(b)) = (prev["score"]["total"].as_f64(), cur["score"]["total"].as_f64()) {
        if crate::judge::round(a, 1) != crate::judge::round(b, 1) {
            out.push(ev("score", if b > a { "good" } else { "warn" }, vec![("from", json!(a)), ("to", json!(b))]));
        }
    }
    let pa = by_id(&prev["achievements"], "id");
    for t in arr(&cur["achievements"]) {
        let Some(o) = pa.get(s(t, "id")) else { continue };
        if o["earned"] == t["earned"] {
            continue;
        }
        let won = truthy(&t["earned"]);
        out.push(ev(
            if won { "trophy.won" } else { "trophy.lost" },
            if won { "good" } else { "bad" },
            vec![("rule", t["id"].clone()), ("subject", opt(t.get("title"))), ("count", opt(t.get("xp")))],
        ));
    }

    // ── structure ──
    let cycles = |a: &Value| -> BTreeSet<Vec<String>> {
        arr(&a["cycles"]).iter().map(|c| arr(c).iter().filter_map(Value::as_str).map(str::to_string).collect()).collect()
    };
    let (pcy, ccy) = (cycles(prev), cycles(cur));
    for c in ccy.difference(&pcy) {
        out.push(ev("cycle.new", "bad", vec![("ctxs", json!(c)), ("ctx", opt(c.first().map(|x| json!(x)).as_ref()))]));
    }
    for c in pcy.difference(&ccy) {
        out.push(ev("cycle.gone", "good", vec![("ctxs", json!(c)), ("ctx", opt(c.first().map(|x| json!(x)).as_ref()))]));
    }
    let wells = |a: &Value| -> BTreeSet<String> { arr(&a["wells"]).iter().filter_map(Value::as_str).map(str::to_string).collect() };
    let (pw, cw) = (wells(prev), wells(cur));
    for m in cw.difference(&pw) {
        out.push(ev("well.new", "warn", vec![("module", json!(m)), ("ctx", cm.get(m.as_str()).map_or(Value::Null, |x| x["ctx"].clone()))]));
    }
    for m in pw.difference(&cw) {
        out.push(ev("well.gone", "good", vec![("module", json!(m)), ("ctx", pm.get(m.as_str()).map_or(Value::Null, |x| x["ctx"].clone()))]));
    }
    if let Some((_, _, b)) = switched.first() {
        for e in &mut out {
            if let Value::Object(o) = e {
                o.entry("branch").or_insert_with(|| (*b).clone());
            }
        }
    }
    coalesce(out, FLOOD)
}

/// More than `limit` events of one kind → one aggregated event in place of the first of them.
pub fn coalesce(events: Vec<Value>, limit: usize) -> Vec<Value> {
    let mut by: HashMap<String, Vec<usize>> = HashMap::new();
    for (i, e) in events.iter().enumerate() {
        by.entry(s(e, "kind").to_string()).or_default().push(i);
    }
    let mut out = Vec::new();
    let mut done: HashSet<String> = HashSet::new();
    for e in &events {
        let k = s(e, "kind").to_string();
        let grp: Vec<&Value> = by[&k].iter().map(|&i| &events[i]).collect();
        if grp.len() <= limit {
            out.push(e.clone());
            continue;
        }
        if !done.insert(k.clone()) {
            continue;
        }
        // contexts by frequency (ties: first seen)
        let mut ctxs: Vec<(String, usize)> = Vec::new();
        for c in grp.iter().map(|x| s(x, "ctx")).filter(|c| !c.is_empty()) {
            match ctxs.iter_mut().find(|(x, _)| x == c) {
                Some((_, n)) => *n += 1,
                None => ctxs.push((c.to_string(), 1)),
            }
        }
        ctxs.sort_by(|a, b| b.1.cmp(&a.1));
        let sev = ["bad", "warn", "good", "info"].into_iter().find(|sv| grp.iter().any(|x| s(x, "sev") == *sv)).unwrap_or("info");
        let count: u64 = grp.iter().map(|x| if k == "road.open" { x["count"].as_u64().unwrap_or(1) } else { 1 }).sum();
        let modules: Vec<&Value> = grp.iter().filter_map(|x| x.get("module").filter(|m| truthy(m))).take(20).collect();
        let sample: Vec<Value> = grp
            .iter()
            .take(SAMPLE)
            .map(|x| {
                Value::Object(
                    x.as_object()
                        .map(|o| o.iter().filter(|(kk, _)| *kk != "kind" && *kk != "sev").map(|(a, b)| (a.clone(), b.clone())).collect())
                        .unwrap_or_default(),
                )
            })
            .collect();
        let mut agg = ev(
            &k,
            sev,
            vec![
                ("count", json!(count)),
                ("ctxs", if ctxs.is_empty() { Value::Null } else { json!(ctxs.iter().take(12).map(|c| &c.0).collect::<Vec<_>>()) }),
                ("modules", if modules.is_empty() { Value::Null } else { json!(modules) }),
                ("wip", if grp.iter().any(|x| truthy(&x["wip"])) { json!(true) } else { Value::Null }),
                ("sample", json!(sample)),
            ],
        );
        agg["aggregated"] = json!(true);
        out.push(agg);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    struct A {
        sha: &'static str,
        branch: &'static str,
        modules: Vec<Value>,
        edges: Vec<Value>,
        violations: Vec<Value>,
        contexts: Vec<Value>,
        seams: Vec<Value>,
        score: f64,
        achievements: Vec<Value>,
        cycles: Vec<Value>,
        wells: Vec<&'static str>,
        history: Vec<Value>,
        demolished: Vec<Value>,
    }

    impl Default for A {
        fn default() -> Self {
            A {
                sha: "aaa",
                branch: "main",
                modules: vec![],
                edges: vec![],
                violations: vec![],
                contexts: vec![],
                seams: vec![],
                score: 80.0,
                achievements: vec![],
                cycles: vec![],
                wells: vec![],
                history: vec![],
                demolished: vec![],
            }
        }
    }

    impl A {
        fn v(self) -> Value {
            json!({"project": {"sha": self.sha, "branch": self.branch}, "modules": self.modules, "edges": self.edges,
                   "violations": self.violations, "contexts": self.contexts, "seams": self.seams,
                   "score": {"total": self.score, "grade": "B"}, "achievements": self.achievements, "cycles": self.cycles,
                   "wells": self.wells, "history": self.history, "wip": {"demolished": self.demolished}})
        }
    }

    fn m(id: &str, ctx: &str, wip: Option<&str>) -> Value {
        json!({"id": id, "path": id, "ctx": ctx, "wip": wip, "wipAdd": if wip.is_some() { 3 } else { 0 }})
    }

    fn kinds(evs: &[Value]) -> Vec<String> {
        let mut k: Vec<String> = evs.iter().map(|e| s(e, "kind").to_string()).collect();
        k.sort();
        k
    }

    #[test]
    fn build_lifecycle() {
        let a = A { modules: vec![m("x", "app:a", None), m("y", "app:a", None)], ..A::default() }.v();
        let b = A { modules: vec![m("x", "app:a", Some("mod")), m("y", "app:a", None), m("n", "app:a", Some("new"))], ..A::default() }.v();
        assert_eq!(kinds(&diff_atlas(&a, &b)), ["build.renovate", "build.start"]);
        let c = A {
            sha: "bbb",
            modules: vec![m("x", "app:a", None), m("y", "app:a", None), m("n", "app:a", None)],
            history: vec![
                json!({"sha": "bbb", "short": "bbb", "subject": "feat", "author": "T", "modules": ["n"], "contexts": ["app:a"], "blast": 1, "shotgun": false}),
            ],
            ..A::default()
        }
        .v();
        let evs = diff_atlas(&b, &c);
        assert_eq!(kinds(&evs), ["build.open", "build.open", "commit"]);
        let n = evs.iter().find(|e| s(e, "module") == "n").unwrap();
        assert_eq!((s(n, "sha"), s(n, "subject"), s(n, "from")), ("bbb", "feat", "new"));
        // same HEAD, wip dropped (reverted): opens without a commit
        let reverted = diff_atlas(&b, &A { modules: vec![m("x", "app:a", None), m("y", "app:a", None), m("n", "app:a", None)], ..A::default() }.v());
        assert!(reverted.iter().all(|e| e.get("sha").is_none()));
    }

    #[test]
    fn committed_add_remove_and_demolition() {
        let a = A { modules: vec![m("x", "app:a", None), m("gone", "app:a", None)], ..A::default() }.v();
        let b = A { modules: vec![m("x", "app:a", None), m("pulled", "app:a", None)], ..A::default() }.v();
        assert_eq!(kinds(&diff_atlas(&a, &b)), ["module.added", "module.removed"]);
        let c =
            A { modules: vec![m("x", "app:a", None)], demolished: vec![json!({"path": "gone", "ctx": "app:a", "tier": "app", "del": 9})], ..A::default() }.v();
        assert_eq!(kinds(&diff_atlas(&a, &c)), ["build.demolish"]); // no module.removed for a demolition
        let restored = diff_atlas(&c, &a);
        assert_eq!(restored.iter().map(|e| (s(e, "kind"), s(e, "to"))).collect::<Vec<_>>(), [("build.cleared", "restored")]);
    }

    #[test]
    fn roads_and_tracks() {
        let mods = vec![m("x", "app:a", None), m("y", "app:b", None), m("z", "app:b", None)];
        let a = A { modules: mods.clone(), ..A::default() }.v();
        let b = A {
            modules: mods,
            edges: vec![
                json!({"source": "x", "target": "y", "status": "cross", "wip": true}),
                json!({"source": "x", "target": "z", "status": "cross", "wip": false}),
                json!({"source": "y", "target": "z", "status": "clean", "wip": false}),
                json!({"source": "z", "target": "x", "status": "violation", "wip": true}),
            ],
            violations: vec![
                json!({"id": "r|z|x", "rule": "r", "severity": "critical", "source": "z", "target": "x", "fromCtx": "app:b", "toCtx": "app:a", "wip": true}),
            ],
            ..A::default()
        }
        .v();
        let evs = diff_atlas(&a, &b);
        assert_eq!(kinds(&evs), ["road.open", "road.open", "road.paving", "track.cut"]);
        let cut = evs.iter().find(|e| s(e, "kind") == "track.cut").unwrap();
        assert_eq!((s(cut, "sev"), s(cut, "rule"), &cut["wip"], &cut["ctxs"]), ("bad", "r", &json!(true), &json!(["app:b", "app:a"])));
        let open = evs.iter().find(|e| s(e, "kind") == "road.open" && e["ctxs"] == json!(["app:a", "app:b"])).unwrap();
        assert_eq!(open["count"], 1);
        assert_eq!(kinds(&diff_atlas(&b, &a)), ["track.closed"]);
    }

    #[test]
    fn seams_grades_score_trophies_structure() {
        let a = A {
            seams: vec![json!({"id": "wire", "unhandled": [], "dead": []})],
            contexts: vec![json!({"key": "app:a", "grade": "A", "nest": false})],
            achievements: vec![json!({"id": "acyclic", "title": "ACYCLIC", "earned": true, "xp": 300})],
            modules: vec![m("x", "app:a", None)],
            score: 88.0,
            ..A::default()
        }
        .v();
        let b = A {
            seams: vec![json!({"id": "wire", "unhandled": ["defer"], "dead": ["old"]})],
            contexts: vec![json!({"key": "app:a", "grade": "C", "nest": true})],
            achievements: vec![json!({"id": "acyclic", "title": "ACYCLIC", "earned": false, "xp": 300})],
            cycles: vec![json!(["app:a", "app:b"])],
            wells: vec!["x"],
            modules: vec![m("x", "app:a", None)],
            score: 70.5,
            ..A::default()
        }
        .v();
        let evs = diff_atlas(&a, &b);
        assert_eq!(kinds(&evs), ["bridge.broken", "bridge.dead", "cycle.new", "grade.down", "nest.new", "score", "trophy.lost", "well.new"]);
        let get = |k: &str| evs.iter().find(|e| s(e, "kind") == k).unwrap();
        assert_eq!(get("bridge.broken")["kinds"], json!(["defer"]));
        assert_eq!((s(get("grade.down"), "from"), s(get("grade.down"), "to")), ("A", "C"));
        assert_eq!((get("score")["from"].as_f64(), get("score")["to"].as_f64()), (Some(88.0), Some(70.5)));
        assert_eq!(get("cycle.new")["ctx"], "app:a");
        assert_eq!(kinds(&diff_atlas(&b, &a)), ["bridge.fixed", "cycle.gone", "grade.up", "nest.gone", "score", "trophy.won", "well.gone"]);
    }

    #[test]
    fn branch_switch_suppresses_commit_replay() {
        let a = A { history: vec![json!({"sha": "aaa", "subject": "x"})], ..A::default() }.v();
        let b =
            A { sha: "ccc", branch: "other", history: vec![json!({"sha": "ccc", "subject": "y"}), json!({"sha": "bbb", "subject": "z"})], ..A::default() }.v();
        let evs = diff_atlas(&a, &b);
        assert_eq!(evs.iter().map(|e| (s(e, "kind"), s(e, "from"), s(e, "to"))).collect::<Vec<_>>(), [("branch", "main", "other")]);
    }

    #[test]
    fn multi_repo_heads() {
        let p = |sha: &str| {
            json!({"project": {"sha": "x", "repos": [{"repo": "one", "sha": sha, "branch": "main"}, {"repo": "two", "sha": "t", "branch": "dev"}]},
                                    "history": [{"sha": sha, "short": sha, "subject": "s", "repo": "one"}]})
        };
        let evs = diff_atlas(&p("a1"), &p("a2"));
        assert_eq!(evs.iter().map(|e| (s(e, "kind"), s(e, "sha"), s(e, "repo"))).collect::<Vec<_>>(), [("commit", "a2", "one")]);
    }

    #[test]
    fn flood_coalescing() {
        let a = A::default().v();
        let b = A { modules: (0..60).map(|i| m(&format!("m{i}"), "app:a", Some("new"))).collect(), ..A::default() }.v();
        let evs = diff_atlas(&a, &b);
        assert_eq!(evs.len(), 1);
        assert_eq!((s(&evs[0], "kind"), evs[0]["count"].as_u64(), &evs[0]["aggregated"]), ("build.start", Some(60), &json!(true)));
        assert_eq!(arr(&evs[0]["sample"]).len(), 8);
        assert_eq!(evs[0]["ctxs"], json!(["app:a"]));
        assert_eq!(arr(&evs[0]["modules"]).len(), 20);
        assert_eq!(coalesce(vec![json!({"kind": "k", "sev": "info"}); 40], FLOOD).len(), 40);
    }

    #[test]
    fn boot_summary_and_catch_up() {
        let mut cur = A {
            modules: vec![m("x", "app:a", Some("new")), m("y", "app:a", None)],
            history: vec![
                json!({"sha": "c2full", "short": "c2", "ts": 200, "subject": "later"}),
                json!({"sha": "c1full", "short": "c1", "ts": 150, "subject": "logged already"}),
                json!({"sha": "c0full", "short": "c0", "ts": 50, "subject": "old"}),
            ],
            ..A::default()
        }
        .v();
        cur["wip"]["files"] = json!(1);
        cur["wip"]["contexts"] = json!(["app:a"]);
        cur["wip"]["new"] = json!(1);
        let logged: HashSet<String> = ["c1".to_string()].into();
        let evs = boot_events(&cur, Some(100), &logged);
        assert_eq!(evs.iter().map(|e| (s(e, "kind"), s(e, "sha"))).collect::<Vec<_>>(), [("commit", "c2"), ("boot", "aaa")]);
        let boot = evs.last().unwrap();
        assert_eq!((boot["count"].as_u64(), &boot["modules"], boot["summary"]["new"].as_u64()), (Some(1), &json!(["x"]), Some(1)));
        assert_eq!(boot_events(&cur, None, &HashSet::new()).len(), 1);
    }
}
