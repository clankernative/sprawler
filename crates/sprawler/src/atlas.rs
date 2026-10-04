//! Atlas assembly (adapter): scan → judge → history → seams → construction → health → one `sprawler.atlas` JSON document.
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use sprawler_domain::classify::Classifier;
use sprawler_domain::judge::{judge, Graph, Policy};

use crate::ports::{ModuleIndex, Obj, Workspace};
use crate::{metrics, prompts, seams, views, wip};

/// How many recent commits the history replay covers.
const HISTORY_LIMIT: usize = 150;

pub const SCHEMA: &str = "sprawler.atlas/1";

fn strs(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_string).collect()
}

/// The use case: scan through the workspace port, judge, then attach history, seams, construction
/// state, code health, prompts and views.
pub fn build_atlas(p: &Obj, ws: &dyn Workspace) -> Result<Value, String> {
    build_atlas_session(p, ws, None)
}

/// [`build_atlas`] for a long-running session (`sprawler serve`): `baseline` remembers the edge set
/// first seen for each HEAD, so edges added while it runs count as uncommitted work (see `wip.rs`).
pub fn build_atlas_session(p: &Obj, ws: &dyn Workspace, baseline: Option<&mut wip::Baseline>) -> Result<Value, String> {
    let t0 = Instant::now();
    let s = ws.scan(p)?;
    let graph: Graph = serde_json::from_value(s.graph.clone()).map_err(|e| format!("scan graph: {e}"))?;
    let j = judge(&Policy::from_profile(p)?, &graph);
    let cls = Classifier::from_profile(p)?;
    let root = p.get("root").and_then(Value::as_str).unwrap_or_default().to_string();
    let repos = strs(p.get("repos"));

    let judged = serde_json::to_value(&j).map_err(|e| e.to_string())?;
    let index: ModuleIndex = j.modules.iter().filter_map(|m| Some((m["id"].as_str()?, (m["ctx"].as_str()?, m["tier"].as_str()?)))).collect();
    let hist = ws.history(&root, &repos, &index, &cls, HISTORY_LIMIT);

    let mut project = json!({"name": p.get("name"), "title": p.get("title"), "root": root});
    if let Value::Object(h) = ws.head(&root, &repos) {
        for (k, v) in h {
            project[k.as_str()] = v;
        }
    }
    // what the score was measured against: the packs a profile extends, or plugin defaults (structure only)
    if let Some(v) = p.get("_packs").filter(|v| v.as_array().is_some_and(|a| !a.is_empty())) {
        project["packs"] = v.clone();
    }
    if let Some(v) = p.get("_defaults_from") {
        project["defaultsFrom"] = v.clone();
    }
    if let Some(l) = p.get("context_label").filter(|v| v.as_str().is_some_and(|s| !s.is_empty())) {
        project["contextLabel"] = l.clone();
    }
    let rules: Vec<Value> = p
        .get("rules")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|r| json!({"id": r.get("id"), "severity": r.get("severity"), "message": r.get("message")}))
        .collect();
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs());

    let mut atlas = json!({
        "version": 1, "schema": SCHEMA, "generatedAt": now,
        "elapsed": sprawler_domain::judge::round(t0.elapsed().as_secs_f64(), 2),
        "project": project, "tiers": p.get("tiers").cloned().unwrap_or(json!([])),
        "layers": p.get("layers").cloned().unwrap_or(json!({})), "rules": rules,
    });
    if let Value::Object(o) = judged {
        for (k, v) in o {
            atlas[k.as_str()] = v;
        }
    }
    atlas["history"] = json!(hist);
    atlas["externals"] = json!(s.externals.iter().map(|(k, n)| json!([k, n])).collect::<Vec<_>>());
    atlas["phantoms"] = json!(s.phantoms);
    atlas["warnings"] = json!(s.warnings);
    atlas["stats"] = s.stats;
    atlas["analyzers"] = json!(s.analyzers);
    seams::attach_seams(p, ws, &mut atlas)?; // after judging: seams never change the score
    wip::attach_wip(p, ws, &mut atlas, &cls, baseline); // after seams: tags their edges and findings too
    metrics::attach_metrics(p, ws, &mut atlas); // informational: never part of the score
    prompts::attach_prompts(p, ws, &mut atlas);
    views::attach_views(p, ws, &mut atlas)?;
    atlas["inbox"] = json!(sprawler_domain::inbox::build_inbox(&atlas)); // one inbox for UI, CLI and agents
    Ok(atlas)
}
