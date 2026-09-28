//! Findings inbox: turns raw findings into a short list of things worth looking at.
//!
//! kind: `fix` (breaks the architecture / fails at runtime) · `improve` (design drift) ·
//! `check` (maybe a problem, or a blind spot). Same output as `web/src/inbox.js#buildInbox`, so the
//! UI, CLI and agents all see one list.
use serde_json::{json, Map, Value};

/// Texts for the rules the core itself applies. Rules from a profile or pack bring their own `title` / `why`.
const RULES: &[(&str, &str, &str)] = &[
    ("context-bleed", "Bounded contexts import each other", "Contexts should talk through published contracts; direct imports merge their models."),
    ("tier-breach", "A tier depends on a tier it must not know about", "Dependencies should point inward."),
    ("layer-breach", "A dependency points outward", "Inner layers define what they need; outer layers implement it."),
    ("prod-imports-test", "Production code imports tests", "Tests should depend on code, not the reverse."),
    (
        "undeclared-coupling",
        "Contexts reference each other without a declared build dependency",
        "Declare the dependency (Cargo.toml, ProjectReference, …) or remove the reference.",
    ),
    ("seam-unhandled", "One side emits a contract kind the other never handles", "This fails at runtime the first time the kind is used."),
    (
        "seam-dead-handler",
        "A handler matches a contract kind nothing emits",
        "Either dead code to delete, or the kind is built dynamically and deserves a typed constructor.",
    ),
];

fn order(kind: &str) -> u8 {
    match kind {
        "fix" => 0,
        "improve" => 1,
        _ => 2,
    }
}

fn sevw(s: &str) -> u8 {
    match s {
        "critical" => 3,
        "major" => 2,
        "minor" => 1,
        _ => 0,
    }
}

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}

fn arr<'a>(v: &'a Value, k: &str) -> &'a [Value] {
    v.get(k).and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}

fn push_unique(out: &mut Vec<String>, x: &str) {
    if !out.iter().any(|y| y == x) {
        out.push(x.to_string());
    }
}

fn js_round(x: f64) -> i64 {
    (x + 0.5).floor() as i64
}

/// Build the inbox from a full atlas (judged graph + seams + views).
pub fn build_inbox(atlas: &Value) -> Vec<Value> {
    let label = |k: &str| -> String {
        arr(atlas, "contexts").iter().find(|c| s(c, "key") == k).map(|c| s(c, "label")).filter(|l| !l.is_empty()).unwrap_or(k).to_string()
    };
    let mut items: Vec<Value> = Vec::new();

    // one item per rule, in order of first appearance
    let viol = arr(atlas, "violations");
    let mut by_rule: Vec<(String, Vec<usize>)> = Vec::new();
    for (i, v) in viol.iter().enumerate() {
        let r = s(v, "rule");
        match by_rule.iter_mut().find(|(k, _)| k == r) {
            Some((_, l)) => l.push(i),
            None => by_rule.push((r.to_string(), vec![i])),
        }
    }
    for (rule, idx) in &by_rule {
        let vs: Vec<&Value> = idx.iter().map(|&i| &viol[i]).collect();
        let sev = vs.iter().fold("minor", |acc, v| if sevw(s(v, "severity")) > sevw(acc) { s(v, "severity") } else { acc });
        let kind = if rule == "seam-unhandled" {
            "fix"
        } else if rule.starts_with("seam-") {
            "check"
        } else if sev == "minor" {
            "improve"
        } else {
            "fix"
        };
        let mut per: Vec<(String, u64)> = Vec::new();
        for v in &vs {
            let k = s(v, "fromCtx");
            match per.iter_mut().find(|(x, _)| x == k) {
                Some((_, n)) => *n += 1,
                None => per.push((k.to_string(), 1)),
            }
        }
        per.sort_by(|a, b| b.1.cmp(&a.1));
        let (title, why) = match (vs[0].get("title").and_then(Value::as_str), RULES.iter().find(|r| r.0 == rule)) {
            (Some(t), _) => (t.to_string(), s(vs[0], "why").to_string()),
            (None, Some((_, t, w))) => (t.to_string(), w.to_string()),
            (None, None) => (s(vs[0], "message").to_string(), s(vs[0], "why").to_string()),
        };
        let (mut pick, mut modules) = (Vec::new(), Vec::new());
        for v in &vs {
            push_unique(&mut pick, s(v, "fromCtx"));
            push_unique(&mut pick, s(v, "toCtx"));
            push_unique(&mut modules, s(v, "source"));
            push_unique(&mut modules, s(v, "target"));
        }
        let mut view = json!({"pick": pick, "isolate": "only", "camera": "fit", "select": {"type": "commit", "modules": modules}});
        if rule.starts_with("seam-") {
            let src = s(vs[0], "source");
            let has = |sm: &Value, k: &str| arr(sm, k).iter().any(|x| x.as_str() == Some(src));
            if let Some(sm) = arr(atlas, "seams").iter().find(|sm| has(sm, "emitters") || has(sm, "handlers")) {
                view["seam"] = json!(s(sm, "id"));
            }
        } else {
            view["seam"] = Value::Null;
        }
        items.push(json!({
            "id": format!("rule:{rule}"), "kind": kind, "rule": rule, "title": title, "why": why, "count": vs.len(),
            "findings": idx, "where": per.iter().map(|(k, n)| json!({"key": k, "label": label(k), "n": n})).collect::<Vec<_>>(),
            "view": view,
        }));
    }

    let phantoms = arr(atlas, "phantoms");
    if !phantoms.is_empty() {
        let mut pick = Vec::new();
        for p in phantoms {
            push_unique(&mut pick, s(p, "instance"));
        }
        items.push(json!({
            "id": "phantom", "kind": "check", "title": "Instances bind an app that isn't in this repo",
            "why": "The instance config points at an app with no source here. Either the app lives elsewhere, or the binding is stale and will fail at install.",
            "count": phantoms.len(), "findings": [],
            "where": phantoms.iter().map(|p| json!({"key": s(p, "instance"), "label": format!("{} → '{}'", label(s(p, "instance")), s(p, "app")), "n": 1})).collect::<Vec<_>>(),
            "view": {"pick": pick, "isolate": "plus", "camera": "fit"},
        }));
    }

    let unused: Vec<&Value> = arr(atlas, "ports").iter().filter(|p| arr(p, "callers").is_empty()).collect();
    if !unused.is_empty() {
        let mut pick = Vec::new();
        for p in &unused {
            push_unique(&mut pick, s(p, "ctx"));
        }
        items.push(json!({
            "id": "unused-ports", "kind": "check", "title": format!("{} {} no module uses", unused.len(), atlas.pointer("/views/interfaces/label").and_then(Value::as_str).unwrap_or("interfaces")),
            "why": "Nothing calls these. They may be capabilities nothing needs yet — or dead surface area that still has to be maintained.",
            "count": unused.len(), "findings": [],
            "where": unused.iter().map(|p| json!({"mod": s(p, "id"), "label": s(p, "name"), "n": 0})).collect::<Vec<_>>(),
            "view": {"pick": pick, "isolate": "only", "camera": "fit", "tab": "ports",
                     "select": {"type": "commit", "modules": unused.iter().map(|p| s(p, "id")).collect::<Vec<_>>()}},
        }));
    }

    let wells = arr(atlas, "wells");
    if !wells.is_empty() {
        let fan_in = |id: &str| arr(atlas, "modules").iter().find(|m| s(m, "id") == id).and_then(|m| m.get("fanIn")).and_then(Value::as_u64).unwrap_or(0);
        items.push(json!({
            "id": "wells", "kind": "check", "title": "Files half the codebase depends on",
            "why": "These modules have unusually high fan-in from several contexts. Every change to them is risky; consider splitting them by responsibility.",
            "count": wells.len(), "findings": [],
            "where": wells.iter().filter_map(Value::as_str).map(|id| json!({"mod": id, "label": id.rsplit('/').next().unwrap_or(id), "n": fan_in(id)})).collect::<Vec<_>>(),
            "view": {"select": {"type": "module", "id": wells[0]}, "camera": "module"},
        }));
    }

    let nests: Vec<&Value> = arr(atlas, "contexts").iter().filter(|c| c.get("nest").and_then(Value::as_bool).unwrap_or(false)).collect();
    if !nests.is_empty() {
        items.push(json!({
            "id": "nests", "kind": "improve", "title": "Contexts that have become a rat's nest",
            "why": "Most modules in these contexts depend on each other in cycles. Look for a smaller core to pull out.",
            "count": nests.len(), "findings": [],
            "where": nests.iter().map(|c| json!({"key": s(c, "key"), "label": s(c, "label"), "n": c.get("modules").cloned().unwrap_or(json!(0))})).collect::<Vec<_>>(),
            "view": {"pick": nests.iter().map(|c| s(c, "key")).collect::<Vec<_>>(), "isolate": "only", "camera": "fit"},
        }));
    }

    let cycles = arr(atlas, "cycles");
    if !cycles.is_empty() {
        let flat: Vec<&str> = cycles.iter().flat_map(|c| c.as_array().into_iter().flatten()).filter_map(Value::as_str).collect();
        let mut pick = Vec::new();
        for k in &flat {
            push_unique(&mut pick, k);
        }
        items.push(json!({
            "id": "cycles", "kind": "improve", "title": "Contexts that depend on each other in a cycle",
            "why": "A cycle between contexts means neither can change or be released alone.",
            "count": cycles.len(), "findings": [],
            "where": flat.iter().map(|k| json!({"key": k, "label": label(k), "n": 0})).collect::<Vec<_>>(),
            "view": {"pick": pick, "isolate": "only", "camera": "fit"},
        }));
    }

    let score = atlas.get("score").cloned().unwrap_or(Value::Null);
    if let Some(cs) = score.get("evidence").and_then(|e| e.get("csharp")) {
        let failed = cs.get("failed").and_then(Value::as_bool).unwrap_or(false);
        let res = cs.get("resolution").and_then(Value::as_f64).unwrap_or(1.0);
        let unres = cs.get("unresolved").and_then(Value::as_u64).unwrap_or(0);
        let unrestored = cs.get("unrestored").and_then(Value::as_u64).unwrap_or(0);
        if failed || res < 0.97 {
            let title = if failed {
                "C# analysis failed — C# files have no dependencies".to_string()
            } else {
                format!("{}% of C# names could not be resolved", js_round((1.0 - res) * 100.0))
            };
            let why = if failed {
                "The Roslyn adapter did not run (is the .NET SDK installed?). Files are placed by path only, so the map cannot show their coupling.".to_string()
            } else {
                let r = if unrestored > 0 { format!("; {unrestored} project(s) are not restored — run dotnet restore") } else { String::new() };
                format!("Links through unresolved names are invisible here{r}. Confidence is lowered to match.")
            };
            items.push(json!({"id": "cs-unresolved", "kind": "check", "title": title, "why": why,
                              "count": if unres > 0 { unres } else { 1 }, "findings": [], "where": [], "view": Value::Null}));
        }
        let unclassified = cs.get("unclassified").and_then(Value::as_u64).unwrap_or(0);
        if unclassified > 0 {
            let ids: Vec<&str> = arr(atlas, "modules").iter().filter(|m| s(m, "lang") == "cs" && s(m, "role") == "code").map(|m| s(m, "id")).collect();
            items.push(json!({
                "id": "cs-unclassified", "kind": "check", "title": format!("{unclassified} C# files have no recognised role"),
                "why": "Nothing about these files says controller, service, entity, DTO… They are shown as \"Unclassified C#\" rather than guessed. Rules that depend on roles cannot check them.",
                "count": unclassified, "findings": [],
                "where": ids.iter().take(12).map(|id| json!({"mod": id, "label": id.rsplit('/').next().unwrap_or(id), "n": 0})).collect::<Vec<_>>(),
                "view": {"select": {"type": "commit", "modules": ids.iter().take(400).collect::<Vec<_>>()}, "camera": "fit"},
            }));
        }
    }

    let dropped = score.get("unknown").and_then(|u| u.get("dropped")).and_then(Value::as_u64).unwrap_or(0);
    if dropped > 0 {
        items.push(json!({
            "id": "dropped", "kind": "check", "title": format!("{dropped} name-matched links the map can't see"),
            "why": "An analyzer matched names across projects the build doesn't connect, so those links were dropped as name collisions. Most are noise, but a real one would be invisible here.",
            "count": dropped, "findings": [], "where": [], "view": Value::Null,
        }));
    }

    items.sort_by(|a, b| {
        order(s(a, "kind")).cmp(&order(s(b, "kind"))).then_with(|| {
            let c = |v: &Value| v.get("count").and_then(Value::as_u64).unwrap_or(0);
            c(b).cmp(&c(a))
        })
    });
    items
}

/// FIX / IMPROVE / CHECK counts (before any done/snooze marks are applied).
pub fn summarize(items: &[Value]) -> Map<String, Value> {
    let mut out = Map::new();
    for k in ["fix", "improve", "check"] {
        out.insert(k.into(), json!(items.iter().filter(|i| s(i, "kind") == k).count()));
    }
    out
}
