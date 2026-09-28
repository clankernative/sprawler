//! Path + facts → tier, context, layer. First matching map entry wins.
//!
//! `when` filters and `"@fact"` values need analyzer facts; without facts such entries never match,
//! so path-only analyzers (Roc, Rust) classify exactly as before.
use std::collections::BTreeMap;

use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::glob::{compile_path_glob, fnmatch};

pub type Facts = BTreeMap<String, String>;

#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum OneOrMany {
    One(String),
    Many(Vec<String>),
}

impl OneOrMany {
    pub fn as_slice(&self) -> Vec<&str> {
        match self {
            OneOrMany::One(s) => vec![s.as_str()],
            OneOrMany::Many(v) => v.iter().map(String::as_str).collect(),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct MapEntry {
    pub glob: String,
    pub tier: String,
    #[serde(default)]
    pub ctx: Option<String>,
    #[serde(default)]
    pub layer: Option<String>,
    #[serde(default)]
    pub layer_by_ctx: BTreeMap<String, String>,
    #[serde(default)]
    pub when: BTreeMap<String, OneOrMany>,
    #[serde(skip)]
    re: Option<Regex>,
}

impl MapEntry {
    pub fn compile(&mut self) -> Result<(), regex::Error> {
        self.re = Some(compile_path_glob(&self.glob)?);
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Classification {
    pub tier: String,
    pub ctx: String,
    pub layer: String,
    pub slice: Option<String>,
    pub rule: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
}

impl Classification {
    pub fn ctx_key(&self) -> String {
        format!("{}:{}", self.tier, self.ctx)
    }
}

/// The map plus the `[roles]` table it resolves `@role` through.
#[derive(Debug, Clone, Default)]
pub struct Classifier {
    pub map: Vec<MapEntry>,
    pub roles: BTreeMap<String, String>,
}

impl Classifier {
    pub fn new(mut map: Vec<MapEntry>, roles: BTreeMap<String, String>) -> Result<Self, regex::Error> {
        for m in &mut map {
            m.compile()?;
        }
        Ok(Self { map, roles })
    }

    /// `"@role"` / `"@project"` / `"@kind"` → fact value (roles go through `[roles]`); plain values pass through.
    fn fact(&self, facts: &Facts, value: &str) -> Option<String> {
        match value.strip_prefix('@') {
            None => Some(value.to_string()),
            Some(key) => {
                let v = facts.get(key)?.clone();
                Some(if key == "role" { self.roles.get(&v).cloned().unwrap_or(v) } else { v })
            }
        }
    }

    fn when_ok(facts: &Facts, when: &BTreeMap<String, OneOrMany>) -> bool {
        when.iter().all(|(k, want)| facts.get(k).is_some_and(|v| want.as_slice().iter().any(|w| fnmatch(v, w))))
    }

    pub fn classify(&self, rel: &str, facts: Option<&Facts>) -> Classification {
        let empty = Facts::new();
        let facts = facts.unwrap_or(&empty);
        for m in &self.map {
            let Some(caps) = m.re.as_ref().and_then(|re| re.captures(rel)) else { continue };
            if !m.when.is_empty() && !Self::when_ok(facts, &m.when) {
                continue;
            }
            let cap = |n: &str| caps.name(n).map(|x| x.as_str().to_string()).filter(|s| !s.is_empty());
            let ctx_spec = m.ctx.as_deref();
            let ctx = ctx_spec.and_then(|c| self.fact(facts, c)).filter(|s| !s.is_empty()).or_else(|| cap("ctx")).or_else(|| {
                if ctx_spec.is_some_and(|c| c.starts_with('@')) {
                    None
                } else {
                    Some("main".into())
                }
            });
            let Some(ctx) = ctx else { continue };
            let layer = m.layer_by_ctx.get(&ctx).cloned().or_else(|| self.fact(facts, m.layer.as_deref().unwrap_or("loose"))).filter(|s| !s.is_empty());
            let tier = self.fact(facts, &m.tier).filter(|s| !s.is_empty());
            let (Some(layer), Some(tier)) = (layer, tier) else { continue };
            return Classification {
                tier,
                ctx,
                layer,
                slice: cap("slice"),
                rule: Some(m.glob.clone()),
                role: facts.get("role").filter(|s| !s.is_empty()).cloned(),
            };
        }
        let seg: Vec<&str> = rel.split('/').collect();
        Classification {
            tier: "unmapped".into(),
            ctx: if seg.len() > 1 { seg[0].into() } else { "(root)".into() },
            layer: "loose".into(),
            slice: None,
            rule: None,
            role: None,
        }
    }
}

/// Context label: strip configured prefixes, then suffixes (in order), as the Python version does.
pub fn ctx_label(ctx: &str, strip_prefix: &[String], strip_suffix: &[String]) -> String {
    let mut s = ctx.to_string();
    for p in strip_prefix {
        if let Some(r) = s.strip_prefix(p.as_str()) {
            s = r.to_string();
        }
    }
    for p in strip_suffix {
        if let Some(r) = s.strip_suffix(p.as_str()) {
            s = r.to_string();
        }
    }
    s
}

impl Classifier {
    /// The `map` and `roles` of a resolved profile (a JSON object).
    pub fn from_profile(p: &serde_json::Map<String, serde_json::Value>) -> Result<Self, String> {
        let get = |k: &str, d: serde_json::Value| p.get(k).cloned().unwrap_or(d);
        let map: Vec<MapEntry> = serde_json::from_value(get("map", serde_json::json!([]))).map_err(|e| format!("profile map: {e}"))?;
        let roles = serde_json::from_value(get("roles", serde_json::json!({}))).map_err(|e| format!("profile roles: {e}"))?;
        Classifier::new(map, roles).map_err(|e| format!("profile map glob: {e}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(json: serde_json::Value) -> MapEntry {
        serde_json::from_value(json).unwrap()
    }

    fn facts(pairs: &[(&str, &str)]) -> Facts {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn fact_values_and_when() {
        let c = Classifier::new(
            vec![
                entry(serde_json::json!({"glob": "src/**", "when": {"project": "*.Contracts"}, "tier": "shared", "ctx": "@project", "layer": "@role"})),
                entry(serde_json::json!({"glob": "src/**", "tier": "lib", "ctx": "@project", "layer": "@role"})),
            ],
            [("code".to_string(), "loose".to_string())].into(),
        )
        .unwrap();
        let r = c.classify("src/A/X.cs", Some(&facts(&[("role", "service"), ("project", "Acme.Orders"), ("kind", "library")])));
        assert_eq!((r.tier.as_str(), r.ctx.as_str(), r.layer.as_str(), r.role.as_deref()), ("lib", "Acme.Orders", "service", Some("service")));
        let r = c.classify("src/A/X.cs", Some(&facts(&[("role", "code"), ("project", "Acme.Contracts")])));
        assert_eq!((r.tier.as_str(), r.layer.as_str()), ("shared", "loose"));
    }

    #[test]
    fn fact_entries_never_match_without_facts() {
        let c = Classifier::new(
            vec![
                entry(serde_json::json!({"glob": "**", "when": {"kind": "web"}, "tier": "host", "ctx": "@project", "layer": "@role"})),
                entry(serde_json::json!({"glob": "apps/{ctx}/**", "tier": "lib", "layer": "service"})),
            ],
            BTreeMap::new(),
        )
        .unwrap();
        let r = c.classify("apps/billing/App.roc", None);
        assert_eq!((r.tier.as_str(), r.ctx.as_str(), r.layer.as_str()), ("lib", "billing", "service"));
        assert!(r.role.is_none());
    }

    #[test]
    fn layer_by_ctx_and_unmapped() {
        let c = Classifier::new(
            vec![entry(serde_json::json!({"glob": "platform/sdk/{ctx}/**", "tier": "sdk", "layer": "port", "layer_by_ctx": {"runtime": "internal"}}))],
            BTreeMap::new(),
        )
        .unwrap();
        assert_eq!(c.classify("platform/sdk/runtime/X.roc", None).layer, "internal");
        assert_eq!(c.classify("platform/sdk/data/X.roc", None).layer, "port");
        let u = c.classify("README.md", None);
        assert_eq!((u.tier.as_str(), u.ctx.as_str(), u.rule.clone()), ("unmapped", "(root)", None));
        assert_eq!(c.classify("docs/x.md", None).ctx, "docs");
    }

    #[test]
    fn labels() {
        let p = vec!["Acme.Apps.".to_string(), "Acme.".to_string()];
        assert_eq!(ctx_label("Acme.Apps.Orders", &p, &[]), "Orders");
        assert_eq!(ctx_label("Acme.Common", &p, &[]), "Common");
        assert_eq!(ctx_label("tool-billing-app", &["tool-".into()], &["-app".into()]), "billing");
    }
}
