//! Code-health metrics (application): the analyzers' per-file measurements (`modules[].metrics`),
//! plus git churn / authors / age, judged against the smell limits (`sprawler_domain::health`).
//! Informational only: attached after judging, so it never changes the score.
use std::collections::HashSet;

use serde_json::{json, Map, Value};
use sprawler_domain::health::{self, Limits};

use crate::ports::{Obj, Workspace};

/// How many recent commits per repo churn and authorship cover.
const CHURN_LIMIT: usize = 600;

/// Add `metrics` to every module with a file, and `atlas.smells`.
pub fn attach_metrics(p: &Obj, ws: &dyn Workspace, atlas: &mut Value) {
    let lim = Limits::from_profile(p);
    let measured = |m: &Value| m["path"].is_string() && !m["generated"].as_bool().unwrap_or(false);
    let stats = {
        let ids: HashSet<&str> = atlas["modules"].as_array().into_iter().flatten().filter(|m| measured(m)).filter_map(|m| m["id"].as_str()).collect();
        ws.file_stats(p, &ids, CHURN_LIMIT)
    };
    let now = ws.now();
    for m in atlas["modules"].as_array_mut().into_iter().flatten() {
        if !measured(m) {
            continue;
        }
        let mut met: Map<String, Value> = m["metrics"].as_object().cloned().unwrap_or_default();
        let g = stats.get(m["id"].as_str().unwrap_or("")).copied().unwrap_or_default();
        met.insert("churn".into(), json!(g.churn));
        met.insert("authors".into(), json!(g.authors));
        let age = (g.last > 0).then(|| sprawler_domain::judge::round((now - g.last).max(0) as f64 / 86400.0, 1));
        met.insert("age".into(), json!(age));
        health::assess(&lim, m["loc"].as_u64().unwrap_or(0), m["lang"].as_str().unwrap_or(""), &mut met);
        m["metrics"] = Value::Object(met);
    }
    atlas["smells"] = health::summary(&lim, atlas["modules"].as_array().map_or(&[], Vec::as_slice));
}
