//! Judge every dependency against the profile's policy, then score the map.
//!
//! Pure: a [`Graph`] of facts plus a [`Policy`] in, a [`Judged`] result out. Deterministic, so the same facts
//! and policy always give the same atlas.
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::classify::OneOrMany;
use crate::glob::in_glob_list;

const GRADES: [(f64, &str); 6] = [(95.0, "S"), (88.0, "A"), (78.0, "B"), (66.0, "C"), (52.0, "D"), (0.0, "F")];
const HUBS: [&str; 5] = ["port", "kernel", "generated", "internal", "root"];

pub fn grade(score: f64) -> &'static str {
    GRADES.iter().find(|(t, _)| score >= *t).map(|(_, g)| *g).unwrap_or("F")
}

pub fn sev_w(s: &str) -> f64 {
    match s {
        "critical" => 5.0,
        "major" => 2.0,
        "minor" => 0.5,
        _ => 0.0,
    }
}

/// Python's `round(x, n)`: correctly rounded from the exact binary value, ties to even.
pub fn round(x: f64, n: usize) -> f64 {
    format!("{x:.n$}").parse().unwrap_or(x)
}

// ── policy ──────────────────────────────────────────────────────────────────
fn major() -> String {
    "major".into()
}
fn allow_all() -> String {
    "allow".into()
}
fn yes() -> bool {
    true
}
fn default_breach() -> BTreeMap<String, String> {
    [("default".to_string(), "major".to_string())].into()
}

#[derive(Debug, Clone, Deserialize)]
pub struct Tier {
    pub id: String,
    #[serde(default)]
    pub depends: Vec<String>,
    #[serde(default = "allow_all")]
    pub cross: String,
    #[serde(default)]
    pub published: Vec<String>,
    #[serde(default = "yes")]
    pub acyclic: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Rule {
    pub id: String,
    #[serde(default)]
    pub from_tier: Option<OneOrMany>,
    #[serde(default)]
    pub to_tier: Option<OneOrMany>,
    #[serde(default)]
    pub from_layer: Option<OneOrMany>,
    #[serde(default)]
    pub to_layer: Option<OneOrMany>,
    #[serde(default)]
    pub from_ctx: Option<OneOrMany>,
    #[serde(default)]
    pub to_ctx: Option<OneOrMany>,
    #[serde(default)]
    pub same_ctx: Option<bool>,
    #[serde(default)]
    pub same_slice: Option<bool>,
    #[serde(default = "major")]
    pub severity: String,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub why: Option<String>,
    /// Short headline for the findings inbox (defaults to `message`).
    #[serde(default)]
    pub title: Option<String>,
    /// Suggested direction for a fix, used in agent fix prompts.
    #[serde(default)]
    pub fix: Option<String>,
}

/// A rules pack's achievement: earned when no finding uses one of `no_rules` and none starts in one of `clean_layers`.
#[derive(Debug, Clone, Deserialize)]
pub struct AchievementDef {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub desc: String,
    #[serde(default)]
    pub no_rules: Vec<String>,
    #[serde(default)]
    pub clean_layers: Vec<String>,
    #[serde(default)]
    pub xp: u64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Scoring {
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default = "Scoring::default_min_confidence")]
    pub min_confidence: f64,
    #[serde(default)]
    pub boundary: bool,
}

impl Scoring {
    fn default_min_confidence() -> f64 {
        0.6
    }
}

impl Default for Scoring {
    fn default() -> Self {
        Self { mode: None, label: None, min_confidence: 0.6, boundary: false }
    }
}

/// The judging half of a profile: tiers, layer allow-lists, named rules, scoring options.
#[derive(Debug, Clone, Deserialize)]
pub struct Policy {
    pub tiers: Vec<Tier>,
    #[serde(default)]
    pub allow: BTreeMap<String, Vec<String>>,
    #[serde(default = "default_breach")]
    pub breach_severity: BTreeMap<String, String>,
    #[serde(default)]
    pub rules: Vec<Rule>,
    #[serde(default)]
    pub scoring: Scoring,
    #[serde(default)]
    pub achievements: Vec<AchievementDef>,
}

impl Policy {
    fn tier(&self, id: &str) -> Option<&Tier> {
        self.tiers.iter().find(|t| t.id == id)
    }
    fn layer_ok(&self, la: &str, lb: &str) -> bool {
        self.allow.get(la).is_none_or(|a| a.iter().any(|x| x == "*" || x == lb))
    }
    fn breach_sev(&self, la: &str) -> String {
        let bs = &self.breach_severity;
        bs.get(la).or_else(|| bs.get("default")).cloned().unwrap_or_else(major)
    }
}

// ── graph (facts) ───────────────────────────────────────────────────────────
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Module {
    pub id: String,
    pub tier: String,
    /// Context key, `tier:name`.
    pub ctx: String,
    pub layer: String,
    #[serde(default)]
    pub slice: Option<String>,
    pub lang: String,
    #[serde(default)]
    pub loc: u64,
    #[serde(default)]
    pub test: bool,
    #[serde(default)]
    pub generated: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Context {
    pub key: String,
    pub tier: String,
    pub name: String,
    pub label: String,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Edge {
    pub source: String,
    pub target: String,
    pub weight: u64,
    pub relations: Vec<String>,
    pub line: Option<u64>,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

/// What analyzers could not see. Lowers confidence.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct Unknown {
    #[serde(default)]
    pub dropped: u64,
    #[serde(default)]
    pub unresolved: u64,
    #[serde(default)]
    pub phantoms: u64,
}

/// Name-resolution evidence from a semantic analyzer (e.g. Roslyn), reported under `evidence.<key>`.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct Resolution {
    /// Module `lang` this evidence covers (e.g. `cs`).
    pub lang: String,
    #[serde(default)]
    pub resolved: u64,
    #[serde(default)]
    pub unresolved: u64,
    #[serde(default)]
    pub unrestored: u64,
    #[serde(default)]
    pub projects: u64,
    #[serde(default)]
    pub failed: bool,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct Graph {
    pub modules: Vec<Module>,
    pub contexts: Vec<Context>,
    pub edges: Vec<Edge>,
    /// Context pairs declared by a build system (Cargo, ProjectReference).
    #[serde(default)]
    pub declared: BTreeSet<(String, String)>,
    #[serde(default)]
    pub unknown: Unknown,
    #[serde(default)]
    pub resolution: BTreeMap<String, Resolution>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Judged {
    pub modules: Vec<Value>,
    pub contexts: Vec<Value>,
    pub edges: Vec<Value>,
    pub violations: Vec<Value>,
    pub cycles: Vec<Vec<String>>,
    pub wells: Vec<String>,
    pub achievements: Vec<Value>,
    pub score: Value,
}

// ── edge verdicts ───────────────────────────────────────────────────────────
#[derive(Debug, Clone)]
pub struct Verdict {
    pub status: &'static str,
    pub rule: Option<String>,
    pub severity: Option<String>,
    pub message: Option<String>,
}

impl Verdict {
    fn new(status: &'static str) -> Self {
        Self { status, rule: None, severity: None, message: None }
    }
    fn with(status: &'static str, rule: &str, sev: Option<&str>, msg: Option<String>) -> Self {
        Self { status, rule: Some(rule.into()), severity: sev.map(Into::into), message: msg }
    }
    fn scored(&self) -> bool {
        matches!(self.status, "clean" | "cross" | "violation")
    }
}

fn ctx_name(key: &str) -> &str {
    key.split_once(':').map_or(key, |x| x.1)
}

fn in_list(l: &Option<OneOrMany>, v: &str) -> bool {
    l.as_ref().is_none_or(|o| o.as_slice().contains(&v))
}

fn in_globs(l: &Option<OneOrMany>, v: &str) -> bool {
    match l {
        None => true,
        Some(o) => {
            let owned: Vec<String> = o.as_slice().iter().map(|s| s.to_string()).collect();
            in_glob_list(Some(&owned), v)
        }
    }
}

fn rule_hit(r: &Rule, a: &Module, b: &Module) -> bool {
    in_list(&r.from_tier, &a.tier)
        && in_list(&r.to_tier, &b.tier)
        && in_list(&r.from_layer, &a.layer)
        && in_list(&r.to_layer, &b.layer)
        && in_globs(&r.from_ctx, ctx_name(&a.ctx))
        && in_globs(&r.to_ctx, ctx_name(&b.ctx))
        && r.same_ctx.is_none_or(|s| (a.ctx == b.ctx) == s)
        && r.same_slice.is_none_or(|s| (a.slice == b.slice) == s)
}

/// Is this edge checked by any policy at all (vs. allowed only because nothing says otherwise)?
fn governs(p: &Policy, a: &Module, b: &Module) -> bool {
    if p.rules
        .iter()
        .any(|r| r.severity != "ok" && in_list(&r.from_tier, &a.tier) && in_list(&r.from_layer, &a.layer) && in_globs(&r.from_ctx, ctx_name(&a.ctx)))
    {
        return true;
    }
    if p.allow.get(&a.layer).is_some_and(|l| !l.iter().any(|x| x == "*")) {
        return true;
    }
    if a.ctx != b.ctx && a.tier == b.tier && p.tier(&a.tier).is_some_and(|t| t.cross != "allow") {
        return true;
    }
    a.tier != b.tier && p.tiers.len() > 1
}

pub fn judge_edge(p: &Policy, a: &Module, b: &Module, declared: &BTreeSet<(String, String)>) -> Verdict {
    let same_ctx = a.ctx == b.ctx;
    if a.tier == "unmapped" || b.tier == "unmapped" {
        return Verdict::with("fog", "unmapped", None, Some("Dependency touches unmapped code".into()));
    }
    if a.test {
        return Verdict::new("test");
    }
    if b.test {
        return Verdict::with("violation", "prod-imports-test", Some("major"), Some("Production code imports a proof/test module".into()));
    }
    for r in &p.rules {
        if rule_hit(r, a, b) {
            if r.severity == "ok" {
                return Verdict::with(if same_ctx { "clean" } else { "cross" }, &r.id, None, None);
            }
            return Verdict::with("violation", &r.id, Some(&r.severity), Some(r.message.clone().unwrap_or_else(|| r.id.clone())));
        }
    }
    let (la, lb) = (a.layer.as_str(), b.layer.as_str());
    let breach = || Verdict::with("violation", "layer-breach", Some(&p.breach_sev(la)), Some(format!("{la} → {lb} points outward")));
    if same_ctx {
        return if p.layer_ok(la, lb) { Verdict::new("clean") } else { breach() };
    }
    let tier = p.tier(&a.tier);
    if a.tier == b.tier {
        let policy = tier.map_or("allow", |t| t.cross.as_str());
        if policy == "deny" && !tier.is_some_and(|t| t.published.iter().any(|x| x == lb)) {
            return Verdict::with("violation", "context-bleed", Some("critical"), Some("Bounded context reaches into another context".into()));
        }
        if policy == "declared" && !declared.contains(&(a.ctx.clone(), b.ctx.clone())) {
            return Verdict::with("violation", "undeclared-coupling", Some("minor"), Some("Cross-context reference without a declared dependency".into()));
        }
    } else if !tier.is_some_and(|t| t.depends.iter().any(|d| d == &b.tier)) {
        return Verdict::with("violation", "tier-breach", Some("major"), Some(format!("{} tier must not depend on {}", a.tier, b.tier)));
    }
    if !p.layer_ok(la, lb) {
        return breach();
    }
    Verdict::new("cross")
}

/// Iterative Tarjan over `nodes`; returns strongly connected components.
fn sccs(nodes: &[usize], adj: &HashMap<usize, Vec<usize>>) -> Vec<Vec<usize>> {
    let (mut idx, mut low) = (HashMap::new(), HashMap::new());
    let (mut on, mut st, mut out, mut c) = (HashSet::new(), Vec::new(), Vec::new(), 0usize);
    let empty = Vec::new();
    for &s in nodes {
        if idx.contains_key(&s) {
            continue;
        }
        idx.insert(s, c);
        low.insert(s, c);
        c += 1;
        st.push(s);
        on.insert(s);
        let mut work: Vec<(usize, usize)> = vec![(s, 0)];
        while let Some(&mut (v, ref mut i)) = work.last_mut() {
            let kids = adj.get(&v).unwrap_or(&empty);
            if *i < kids.len() {
                let nxt = kids[*i];
                *i += 1;
                if let std::collections::hash_map::Entry::Vacant(e) = idx.entry(nxt) {
                    e.insert(c);
                    low.insert(nxt, c);
                    c += 1;
                    st.push(nxt);
                    on.insert(nxt);
                    work.push((nxt, 0));
                } else if on.contains(&nxt) {
                    let m = low[&v].min(idx[&nxt]);
                    low.insert(v, m);
                }
                continue;
            }
            work.pop();
            if let Some(&(parent, _)) = work.last() {
                let m = low[&parent].min(low[&v]);
                low.insert(parent, m);
            }
            if low[&v] == idx[&v] {
                let mut comp = Vec::new();
                while let Some(w) = st.pop() {
                    on.remove(&w);
                    comp.push(w);
                    if w == v {
                        break;
                    }
                }
                out.push(comp);
            }
        }
    }
    out
}

#[derive(Debug, Clone, Default)]
struct Acc {
    modules: u64,
    loc: u64,
    layers: Vec<(String, u64)>,
    scored: u64,
    crit: u64,
    major: u64,
    minor: u64,
    internal: u64,
    outbound: u64,
    inbound: u64,
    tangle: f64,
    tangle_raw: f64,
    scc_max: usize,
    avg: f64,
    purity: f64,
    score: f64,
    nest: bool,
}

fn bump(v: &mut Vec<(String, u64)>, k: &str) {
    match v.iter_mut().find(|(x, _)| x == k) {
        Some((_, n)) => *n += 1,
        None => v.push((k.to_string(), 1)),
    }
}

fn counts(v: &[(String, u64)]) -> Value {
    Value::Object(v.iter().map(|(k, n)| (k.clone(), json!(n))).collect())
}

pub fn judge(p: &Policy, g: &Graph) -> Judged {
    let mods = &g.modules;
    let n = mods.len();
    let idx: HashMap<&str, usize> = mods.iter().enumerate().map(|(i, m)| (m.id.as_str(), i)).collect();
    let cidx: HashMap<&str, usize> = g.contexts.iter().enumerate().map(|(i, c)| (c.key.as_str(), i)).collect();
    let nc = g.contexts.len();
    let why: HashMap<&str, &str> = p.rules.iter().filter_map(|r| r.why.as_deref().map(|w| (r.id.as_str(), w))).collect();
    let titles: HashMap<&str, &str> = p.rules.iter().filter_map(|r| r.title.as_deref().map(|t| (r.id.as_str(), t))).collect();

    // verdicts
    struct Je {
        e: usize,
        a: usize,
        b: usize,
        v: Verdict,
        test: bool,
    }
    let mut je = Vec::with_capacity(g.edges.len());
    let mut governed = 0usize;
    for (ei, e) in g.edges.iter().enumerate() {
        let (Some(&a), Some(&b)) = (idx.get(e.source.as_str()), idx.get(e.target.as_str())) else { continue };
        let (ma, mb) = (&mods[a], &mods[b]);
        let v = judge_edge(p, ma, mb, &g.declared);
        if v.scored() && (v.status == "violation" || governs(p, ma, mb)) {
            governed += 1;
        }
        je.push(Je { e: ei, a, b, test: ma.test || mb.test, v });
    }

    // per-module degree
    let (mut fan_in, mut fan_out, mut mviol) = (vec![0u64; n], vec![0u64; n], vec![0u64; n]);
    let mut in_ctx: Vec<HashSet<&str>> = vec![HashSet::new(); n];
    for x in je.iter().filter(|x| !x.test) {
        fan_out[x.a] += 1;
        fan_in[x.b] += 1;
        in_ctx[x.b].insert(mods[x.a].ctx.as_str());
    }

    // per-context metrics
    let mut acc = vec![Acc::default(); nc];
    let mut core: Vec<Vec<usize>> = vec![Vec::new(); nc];
    for (i, m) in mods.iter().enumerate() {
        if let Some(&c) = cidx.get(m.ctx.as_str()) {
            acc[c].modules += 1;
            acc[c].loc += m.loc;
            bump(&mut acc[c].layers, &m.layer);
            if !m.test && !m.generated {
                core[c].push(i);
            }
        }
    }
    let mut adj: Vec<HashMap<usize, Vec<usize>>> = vec![HashMap::new(); nc];
    for x in &je {
        let (ma, mb) = (&mods[x.a], &mods[x.b]);
        let (Some(&ca), Some(&cb)) = (cidx.get(ma.ctx.as_str()), cidx.get(mb.ctx.as_str())) else { continue };
        if x.v.scored() {
            acc[ca].scored += 1;
        }
        if x.v.status == "violation" {
            match x.v.severity.as_deref() {
                Some("critical") => acc[ca].crit += 1,
                Some("major") => acc[ca].major += 1,
                _ => acc[ca].minor += 1,
            }
            mviol[x.a] += 1;
        }
        if ma.ctx == mb.ctx {
            acc[ca].internal += 1;
            if !(ma.test || mb.test || ma.generated || mb.generated) {
                adj[ca].entry(x.a).or_default().push(x.b);
            }
        } else {
            acc[ca].outbound += 1;
            acc[cb].inbound += 1;
        }
    }
    for k in 0..nc {
        let nn = core[k].len();
        let e_int: usize = adj[k].values().map(Vec::len).sum();
        let big = if nn > 0 { sccs(&core[k], &adj[k]).iter().map(Vec::len).max().unwrap_or(0) } else { 0 };
        let scc_frac = if nn > 2 && big > 1 { big as f64 / nn as f64 } else { 0.0 };
        let avg = if nn > 0 { e_int as f64 / nn as f64 } else { 0.0 };
        let tangle = (0.6 * scc_frac + 0.4 * ((avg - 1.5) / 5.0).clamp(0.0, 1.0)).min(1.0);
        let a = &mut acc[k];
        let pen = 5.0 * a.crit as f64 + 2.0 * a.major as f64 + 0.5 * a.minor as f64;
        a.tangle_raw = tangle;
        a.tangle = round(tangle, 3);
        a.scc_max = big;
        a.avg = round(avg, 2);
        a.purity = if a.scored > 0 { round((-3.0 * pen / a.scored as f64).exp(), 3) } else { 1.0 };
        a.score = round(100.0 * (0.7 * a.purity + 0.3 * (1.0 - tangle)), 1);
        a.nest = tangle > 0.55 && nn >= 8;
    }

    // context cycles within a tier
    let mut cg: HashMap<usize, Vec<usize>> = HashMap::new();
    let mut cg_set: Vec<BTreeSet<usize>> = vec![BTreeSet::new(); nc];
    for x in &je {
        let (ma, mb) = (&mods[x.a], &mods[x.b]);
        if ma.ctx != mb.ctx && ma.tier == mb.tier && !x.test && x.v.status != "fog" && p.tier(&ma.tier).is_none_or(|t| t.acyclic) {
            if let (Some(&ca), Some(&cb)) = (cidx.get(ma.ctx.as_str()), cidx.get(mb.ctx.as_str())) {
                cg_set[ca].insert(cb);
            }
        }
    }
    for (k, s) in cg_set.into_iter().enumerate() {
        cg.insert(k, s.into_iter().collect());
    }
    let all_ctx: Vec<usize> = (0..nc).collect();
    let mut cycles: Vec<Vec<String>> = sccs(&all_ctx, &cg)
        .into_iter()
        .filter(|c| c.len() > 1)
        .map(|c| {
            let mut v: Vec<String> = c.iter().map(|&i| g.contexts[i].key.clone()).collect();
            v.sort();
            v
        })
        .collect();
    cycles.sort();

    // gravity wells: huge fan-in from several contexts, excluding expected hubs
    let not_hub = |m: &Module| !HUBS.contains(&m.layer.as_str()) && !m.test;
    let fins: Vec<u64> = (0..n).filter(|&i| not_hub(&mods[i])).map(|i| fan_in[i]).collect();
    let mean = if fins.is_empty() { 0.0 } else { fins.iter().sum::<u64>() as f64 / fins.len() as f64 };
    let mut wells: Vec<usize> = (0..n).filter(|&i| not_hub(&mods[i]) && fan_in[i] as f64 >= 15f64.max(5.0 * mean) && in_ctx[i].len() >= 2).collect();
    wells.sort_by(|a, b| fan_in[*b].cmp(&fan_in[*a]));
    wells.truncate(12);
    let well_set: HashSet<usize> = wells.iter().copied().collect();

    // global score
    let scored: Vec<&Je> = je.iter().filter(|x| x.v.scored()).collect();
    let viol: Vec<&Je> = je.iter().filter(|x| x.v.status == "violation").collect();
    let mut sev: Vec<(String, u64)> = Vec::new();
    let mut rules_hit: Vec<(String, u64)> = Vec::new();
    for x in &viol {
        bump(&mut sev, x.v.severity.as_deref().unwrap_or("major"));
        bump(&mut rules_hit, x.v.rule.as_deref().unwrap_or(""));
    }
    let hits = |r: &str| rules_hit.iter().find(|(k, _)| k == r).map_or(0, |x| x.1);
    let pen: f64 = sev.iter().map(|(s, k)| sev_w(s) * *k as f64).sum();
    let purity = (-3.0 * pen / scored.len().max(1) as f64).exp();
    let loc_total = acc.iter().map(|a| a.loc).sum::<u64>().max(1) as f64;
    let tangle = acc.iter().map(|a| a.tangle * a.loc as f64).sum::<f64>() / loc_total;
    let real: Vec<&Module> = mods.iter().filter(|m| !m.generated).collect();
    let nreal = real.len().max(1) as f64;
    let mapped = real.iter().filter(|m| m.tier != "unmapped").count() as f64 / nreal;
    let explicit = real.iter().filter(|m| m.tier != "unmapped" && m.layer != "loose").count() as f64 / nreal;

    // boundary purity: each context pair judged once, by its worst finding
    let mut pairs: HashSet<(&str, &str)> = HashSet::new();
    let mut bad: HashMap<(&str, &str), &str> = HashMap::new();
    for x in &scored {
        let (ca, cb) = (mods[x.a].ctx.as_str(), mods[x.b].ctx.as_str());
        if ca != cb && !x.test {
            pairs.insert((ca, cb));
            if x.v.status == "violation" {
                let s = x.v.severity.as_deref().unwrap_or("major");
                if sev_w(s) > bad.get(&(ca, cb)).map_or(0.0, |o| sev_w(o)) {
                    bad.insert((ca, cb), s);
                }
            }
        }
    }
    let boundary = if pairs.is_empty() { 1.0 } else { (-3.0 * bad.values().map(|s| sev_w(s)).sum::<f64>() / pairs.len() as f64).exp() };
    let used_purity = if p.scoring.boundary { purity.min(boundary) } else { purity };
    let score = 100.0 * (0.6 * used_purity + 0.25 * (1.0 - tangle) + 0.15 * explicit) - (4.0 * cycles.len() as f64).min(12.0);
    let raw_score = round(score.max(0.0), 1);
    let worst = (0..nc)
        .filter(|&k| acc[k].scored >= 3 && g.contexts[k].tier != "unmapped")
        .min_by(|a, b| acc[*a].score.partial_cmp(&acc[*b].score).unwrap_or(std::cmp::Ordering::Equal));
    let mut score = round(worst.map_or(raw_score, |w| raw_score.min(acc[w].score + 20.0)), 1);

    // confidence: how much of the dependency picture we actually trust
    let u = &g.unknown;
    let unknown = (u.dropped + u.unresolved + 5 * u.phantoms) as f64;
    let mut confidence = scored.len() as f64 / (scored.len() as f64 + unknown).max(1.0) * (0.5 + 0.5 * explicit);
    let mut evidence = Map::new();
    for (key, r) in &g.resolution {
        let n_lang = real.iter().filter(|m| m.lang == r.lang).count();
        let share = n_lang as f64 / nreal;
        let rate = if r.failed { 0.0 } else { r.resolved as f64 / (r.resolved + r.unresolved).max(1) as f64 };
        confidence *= (1.0 - share) + share * rate;
        let unroled = real.iter().filter(|m| m.lang == r.lang && m.role.as_deref() == Some("code")).count();
        evidence.insert(
            key.clone(),
            json!({"resolution": round(rate, 4), "resolved": r.resolved, "unresolved": r.unresolved, "unrestored": r.unrestored,
                   "projects": r.projects, "failed": r.failed, "unclassified": unroled, "files": n_lang}),
        );
    }

    // policy vs structure
    let coverage = governed as f64 / scored.len().max(1) as f64;
    let nctx = acc.iter().zip(&g.contexts).filter(|(_, c)| c.tier != "unmapped").count().max(1) as f64;
    let in_cycle = cycles.iter().flatten().collect::<HashSet<_>>().len();
    let structure_score =
        round((100.0 * (1.0 - (0.45 * tangle + 0.35 * in_cycle as f64 / nctx + 0.2 * (wells.len() as f64 / 3f64.max(nctx / 4.0)).min(1.0)))).max(0.0), 1);
    let mut mode = p.scoring.mode.clone().unwrap_or_else(|| "auto".into());
    if mode == "auto" {
        mode = if coverage >= 0.05 { "policy".into() } else { "structure".into() };
    }
    if mode == "structure" {
        score = structure_score;
    } else if mode == "combined" {
        score = score.min(structure_score);
    }
    let label = p.scoring.label.clone().unwrap_or_else(|| {
        match mode.as_str() {
            "policy" => "HEXAGON INTEGRITY",
            "structure" => "STRUCTURE HEALTH",
            _ => "ARCHITECTURE HEALTH",
        }
        .into()
    });
    let withheld = confidence < p.scoring.min_confidence;

    let nests = acc.iter().filter(|a| a.nest).count();
    // generic achievements; rules packs add their own (`[[achievements]]`)
    let mut ach: Vec<(String, String, String, bool, u64)> = [
        ("sealed", "SEALED BORDERS", "Zero context bleed between bounded contexts", hits("context-bleed") == 0, 400),
        ("one-way", "ONE-WAY STREET", "No tier breaches — dependencies point inward", hits("tier-breach") == 0, 300),
        ("acyclic", "ACYCLIC", "No dependency cycles between contexts", cycles.is_empty(), 300),
        ("no-nests", "NO RAT'S NESTS", "No context crosses the tangle threshold", nests == 0, 400),
        ("no-wells", "NO GRAVITY WELLS", "No god-module pulls in half the codebase", wells.is_empty(), 250),
        ("full-map", "FULL MAP", "Every file is placed on the map", mapped >= 0.999, 150),
        ("s-rank", "S-RANK", "Overall score of 95 or better", score >= 95.0, 1000),
    ]
    .iter()
    .map(|(i, t, d, ok, xp)| (i.to_string(), t.to_string(), d.to_string(), *ok, *xp))
    .collect();
    for a in &p.achievements {
        let ok = a.no_rules.iter().all(|r| hits(r) == 0) && !viol.iter().any(|x| a.clean_layers.contains(&mods[x.a].layer));
        let row = (a.id.clone(), a.title.clone(), a.desc.clone(), ok, a.xp);
        match ach.iter_mut().find(|x| x.0 == a.id) {
            Some(x) => *x = row,
            None => ach.push(row),
        }
    }
    let xp: u64 = ach.iter().filter(|a| a.3).map(|a| a.4).sum();
    let xp_max: u64 = ach.iter().map(|a| a.4).sum();
    let achievements = ach.iter().map(|(i, t, d, ok, xp)| json!({"id": i, "title": t, "desc": d, "earned": ok, "xp": xp})).collect();

    let mut vio: Vec<&Je> = viol.clone();
    vio.sort_by(|a, b| {
        let sa = sev_w(a.v.severity.as_deref().unwrap_or(""));
        let sb = sev_w(b.v.severity.as_deref().unwrap_or(""));
        sb.partial_cmp(&sa).unwrap_or(std::cmp::Ordering::Equal).then_with(|| a.v.rule.cmp(&b.v.rule)).then_with(|| mods[a.a].id.cmp(&mods[b.a].id))
    });
    let violations = vio
        .iter()
        .map(|x| {
            let e = &g.edges[x.e];
            let rule = x.v.rule.clone().unwrap_or_default();
            let mut v = json!({
                "id": format!("{}|{}|{}", rule, e.source, e.target), "rule": rule, "severity": x.v.severity,
                "message": x.v.message, "source": e.source, "target": e.target,
                "fromCtx": mods[x.a].ctx, "toCtx": mods[x.b].ctx, "weight": e.weight, "line": e.line,
            });
            if let Some(w) = why.get(rule.as_str()) {
                v["why"] = json!(w);
            }
            if let Some(t) = titles.get(rule.as_str()) {
                v["title"] = json!(t);
            }
            v
        })
        .collect();

    let edges = je
        .iter()
        .map(|x| {
            let mut v = serde_json::to_value(&g.edges[x.e]).unwrap_or(Value::Null);
            if let Value::Object(o) = &mut v {
                o.insert("status".into(), json!(x.v.status));
                o.insert("rule".into(), json!(x.v.rule));
                o.insert("severity".into(), json!(x.v.severity));
                o.insert("message".into(), json!(x.v.message));
                o.insert("test".into(), json!(x.test));
                o.insert("crossCtx".into(), json!(mods[x.a].ctx != mods[x.b].ctx));
            }
            v
        })
        .collect();

    let modules = mods
        .iter()
        .enumerate()
        .map(|(i, m)| {
            let mut v = serde_json::to_value(m).unwrap_or(Value::Null);
            if let Value::Object(o) = &mut v {
                o.insert("fanIn".into(), json!(fan_in[i]));
                o.insert("fanOut".into(), json!(fan_out[i]));
                o.insert("violations".into(), json!(mviol[i]));
                o.insert("well".into(), json!(well_set.contains(&i)));
            }
            v
        })
        .collect();

    let contexts = g
        .contexts
        .iter()
        .zip(&acc)
        .map(|(c, a)| {
            let mut v = serde_json::to_value(c).unwrap_or(Value::Null);
            if let Value::Object(o) = &mut v {
                for (k, val) in [
                    ("modules", json!(a.modules)),
                    ("loc", json!(a.loc)),
                    ("layers", counts(&a.layers)),
                    ("scored", json!(a.scored)),
                    ("crit", json!(a.crit)),
                    ("major", json!(a.major)),
                    ("minor", json!(a.minor)),
                    ("internal", json!(a.internal)),
                    ("outbound", json!(a.outbound)),
                    ("inbound", json!(a.inbound)),
                    ("tangle", json!(a.tangle)),
                    ("sccMax", json!(a.scc_max)),
                    ("avgDegree", json!(a.avg)),
                    ("purity", json!(a.purity)),
                    ("score", json!(a.score)),
                    ("grade", json!(grade(a.score))),
                    ("nest", json!(a.nest)),
                ] {
                    o.insert(k.into(), val);
                }
            }
            v
        })
        .collect();

    let mut score_v = json!({
        "total": score, "grade": grade(score), "purity": round(purity, 3), "tangle": round(tangle, 3),
        "mapped": round(mapped, 3), "edges": je.len(), "scored": scored.len(), "violations": viol.len(),
        "bySeverity": counts(&sev), "byRule": counts(&rules_hit),
        "clean": je.iter().filter(|x| x.v.status == "clean").count(),
        "cross": je.iter().filter(|x| x.v.status == "cross").count(),
        "xp": xp, "xpMax": xp_max, "raw": raw_score, "capped": score < raw_score, "explicit": round(explicit, 3),
        "worst": worst.map(|w| json!({"key": g.contexts[w].key, "label": g.contexts[w].label, "score": acc[w].score, "grade": grade(acc[w].score)})),
        "confidence": round(confidence, 3),
        "unknown": {"dropped": u.dropped, "unresolved": u.unresolved, "phantoms": u.phantoms},
        "mode": mode, "label": label, "withheld": withheld, "policyCoverage": round(coverage, 3),
        "boundary": {"purity": round(boundary, 3), "pairs": pairs.len(), "violating": bad.len(), "scored": p.scoring.boundary},
        "structure": {"score": structure_score, "grade": grade(structure_score), "tangle": round(tangle, 3),
                      "contextsInCycles": in_cycle, "wells": wells.len(), "nests": nests},
    });
    if !evidence.is_empty() {
        score_v["evidence"] = Value::Object(evidence);
    }

    Judged { modules, contexts, edges, violations, cycles, wells: wells.iter().map(|&i| mods[i].id.clone()).collect(), achievements, score: score_v }
}

impl Policy {
    /// The policy half of a resolved profile (a JSON object).
    pub fn from_profile(p: &Map<String, Value>) -> Result<Self, String> {
        serde_json::from_value(Value::Object(p.clone())).map_err(|e| format!("profile policy: {e}"))
    }
}
