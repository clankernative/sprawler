//! Code health: per-file smell flags and a 0..1 smell score from analyzer metrics, git churn and size.
//!
//! The limits are policy (defaults here, overridable by the profile's `[smells]` table). Informational
//! only: smells never change the architecture score.
use std::collections::BTreeMap;

use serde_json::{json, Map, Value};

/// Smell keys, in display order.
pub const SMELLS: [&str; 6] = ["longFile", "longFn", "complexFn", "deepNest", "todos", "busFactor"];

/// A file only one person has touched counts as a bus-factor risk once it changes this often.
const BUS_FACTOR_CHURN: u64 = 8;

#[derive(Debug, Clone)]
pub struct Limits {
    /// Lines of code in the file.
    pub long_file: f64,
    /// Lines in the longest function.
    pub long_fn: f64,
    /// Cyclomatic complexity of the worst function.
    pub complex_fn: f64,
    /// Indentation depth.
    pub deep_nest: f64,
    /// TODO / FIXME / HACK / XXX markers.
    pub todos: f64,
    /// Indentation depth per language (module `lang`), where the default does not fit its idiom.
    pub deep_nest_by_lang: BTreeMap<String, f64>,
}

impl Default for Limits {
    fn default() -> Self {
        // continuation-passing Roc nests lambdas by design, and Rust nests impl → fn → match; only
        // flag those when it gets truly deep
        let by_lang = [("roc", 10.0), ("rs", 9.0)].into_iter().map(|(k, v)| (k.to_string(), v)).collect();
        Limits { long_file: 500.0, long_fn: 60.0, complex_fn: 15.0, deep_nest: 6.0, todos: 5.0, deep_nest_by_lang: by_lang }
    }
}

impl Limits {
    /// Defaults, overridden by the profile's `[smells]` table: `long_file`, `long_fn`, `complex_fn`,
    /// `deep_nest`, `todos`, and `deep_nest_by_lang = { roc = 10 }`.
    pub fn from_profile(p: &Map<String, Value>) -> Self {
        let mut l = Limits::default();
        let Some(t) = p.get("smells").and_then(Value::as_object) else { return l };
        for (k, slot) in [
            ("long_file", &mut l.long_file),
            ("long_fn", &mut l.long_fn),
            ("complex_fn", &mut l.complex_fn),
            ("deep_nest", &mut l.deep_nest),
            ("todos", &mut l.todos),
        ] {
            if let Some(v) = t.get(k).and_then(Value::as_f64).filter(|v| *v > 0.0) {
                *slot = v;
            }
        }
        for (lang, v) in t.get("deep_nest_by_lang").and_then(Value::as_object).into_iter().flatten() {
            if let Some(v) = v.as_f64().filter(|v| *v > 0.0) {
                l.deep_nest_by_lang.insert(lang.clone(), v);
            }
        }
        l
    }

    pub fn nest_limit(&self, lang: &str) -> f64 {
        self.deep_nest_by_lang.get(lang).copied().unwrap_or(self.deep_nest)
    }

    /// `atlas.smells.limits`.
    pub fn json(&self) -> Value {
        // whole numbers stay integers in JSON (500, not 500.0)
        let n = |v: f64| if v.fract() == 0.0 { json!(v as i64) } else { json!(v) };
        let by_lang: Map<String, Value> = self.deep_nest_by_lang.iter().map(|(k, v)| (k.clone(), n(*v))).collect();
        json!({"longFile": n(self.long_file), "longFn": n(self.long_fn), "complexFn": n(self.complex_fn), "deepNest": n(self.deep_nest),
               "todos": n(self.todos), "busFactor": 1, "deepNestByLang": by_lang})
    }
}

fn num(m: &Map<String, Value>, k: &str) -> f64 {
    m.get(k).and_then(Value::as_f64).unwrap_or(0.0)
}

/// How far past a limit, 0..1 (three times the limit or more is 1).
fn over(v: f64, lim: f64) -> f64 {
    if v > 0.0 && v >= lim {
        ((v / lim - 1.0) / 3.0).clamp(0.0, 1.0)
    } else {
        0.0
    }
}

/// Add `smells` (keys from [`SMELLS`]) and `smell` (0..1) to one module's metrics. `met` holds the
/// analyzer's metrics (may be empty) plus `churn` and `authors` from git.
pub fn assess(lim: &Limits, loc: u64, lang: &str, met: &mut Map<String, Value>) {
    let loc = loc as f64;
    let nest_lim = lim.nest_limit(lang);
    let mut smells = Vec::new();
    if loc >= lim.long_file {
        smells.push("longFile");
    }
    if num(met, "fnMax") >= lim.long_fn {
        smells.push("longFn");
    }
    if num(met, "ccMax") >= lim.complex_fn {
        smells.push("complexFn");
    }
    if num(met, "nest") >= nest_lim {
        smells.push("deepNest");
    }
    if num(met, "todo") >= lim.todos {
        smells.push("todos");
    }
    if met.get("authors").and_then(Value::as_u64) == Some(1) && met.get("churn").and_then(Value::as_u64).unwrap_or(0) >= BUS_FACTOR_CHURN {
        smells.push("busFactor");
    }
    let score =
        (over(loc, lim.long_file) + over(num(met, "fnMax"), lim.long_fn) + over(num(met, "ccMax"), lim.complex_fn) + 0.5 * over(num(met, "nest"), nest_lim))
            / 2.2;
    met.insert("smells".into(), json!(smells));
    met.insert("smell".into(), json!(crate::judge::round(score.min(1.0), 3)));
}

/// `atlas.smells`: the limits, how many files have each smell, and how many smell at all.
pub fn summary(lim: &Limits, modules: &[Value]) -> Value {
    let mut counts: Map<String, Value> = SMELLS.iter().map(|k| (k.to_string(), json!(0))).collect();
    let mut files = 0;
    for m in modules {
        let Some(s) = m.pointer("/metrics/smells").and_then(Value::as_array) else { continue };
        if !s.is_empty() {
            files += 1;
        }
        for k in s.iter().filter_map(Value::as_str) {
            if let Some(c) = counts.get_mut(k) {
                *c = json!(c.as_u64().unwrap_or(0) + 1);
            }
        }
    }
    json!({"limits": lim.json(), "counts": counts, "files": files})
}

#[cfg(test)]
mod tests {
    use super::*;

    fn met(v: Value) -> Map<String, Value> {
        v.as_object().cloned().unwrap()
    }

    #[test]
    fn flags_and_score() {
        let lim = Limits::default();
        let mut m = met(json!({"fnMax": 120, "ccMax": 15, "nest": 6, "todo": 5, "churn": 9, "authors": 1}));
        assess(&lim, 600, "py", &mut m);
        assert_eq!(m["smells"], json!(["longFile", "longFn", "complexFn", "deepNest", "todos", "busFactor"]));
        // longFile (600/500-1)/3 = .0667, longFn (120/60-1)/3 = .333, complexFn 0, nest 0 → .4/2.2
        assert_eq!(m["smell"], 0.182);
    }

    #[test]
    fn per_language_nesting_and_clean_files() {
        let lim = Limits::default();
        let mut rs = met(json!({"nest": 8}));
        assess(&lim, 10, "rs", &mut rs);
        assert_eq!(rs["smells"], json!([]));
        assert_eq!(rs["smell"], 0.0);
        let mut roc = met(json!({"nest": 10}));
        assess(&lim, 10, "roc", &mut roc);
        assert_eq!(roc["smells"], json!(["deepNest"]));
        // no analyzer metrics at all: only size and git can smell
        let mut bare = Map::new();
        assess(&lim, 2000, "json", &mut bare);
        assert_eq!(bare["smells"], json!(["longFile"]));
        assert_eq!(bare["smell"], 0.455);
    }

    #[test]
    fn profile_overrides_and_summary() {
        let p = met(json!({"smells": {"long_file": 100, "deep_nest_by_lang": {"go": 3}}}));
        let lim = Limits::from_profile(&p);
        assert_eq!((lim.long_file, lim.long_fn, lim.nest_limit("go"), lim.nest_limit("roc")), (100.0, 60.0, 3.0, 10.0));
        let mods = vec![json!({"metrics": {"smells": ["longFile", "todos"]}}), json!({"metrics": {"smells": []}}), json!({"id": "virtual"})];
        let s = summary(&lim, &mods);
        assert_eq!((s["files"].as_u64(), s["counts"]["todos"].as_u64(), s["counts"]["busFactor"].as_u64()), (Some(1), Some(1), Some(0)));
        assert_eq!(s["limits"]["longFile"], json!(100));
    }
}
