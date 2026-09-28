//! Git history (adapter): HEAD per repo, and per-commit blast radius across contexts and tiers.
use std::collections::BTreeSet;
use std::process::Command;

use regex::Regex;
use serde_json::{json, Value};
use sprawler_domain::classify::Classifier;

const SEP: char = '\u{1e}';

pub fn git(root: &str, args: &[&str]) -> String {
    Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default()
}

fn opt(s: &str) -> Value {
    if s.is_empty() {
        Value::Null
    } else {
        json!(s)
    }
}

fn head1(root: &str) -> Value {
    let sha = git(root, &["rev-parse", "--short", "HEAD"]);
    let branch = git(root, &["rev-parse", "--abbrev-ref", "HEAD"]);
    let dirty = git(root, &["status", "--porcelain", "--", "."]).lines().filter(|l| !l.trim().is_empty()).count();
    json!({"sha": opt(sha.trim()), "branch": opt(branch.trim()), "dirty": dirty})
}

/// A single repo, or several sibling repos under one root (profile `repos = [...]`).
pub fn head(root: &str, repos: &[String]) -> Value {
    if repos.is_empty() {
        return head1(root);
    }
    let heads: Vec<Value> = repos
        .iter()
        .map(|r| {
            let mut h = head1(&format!("{root}/{r}"));
            h["repo"] = json!(r);
            h
        })
        .collect();
    let sha = heads.iter().find(|h| !h["sha"].is_null()).map_or(Value::Null, |h| h["sha"].clone());
    let dirty: u64 = heads.iter().filter_map(|h| h["dirty"].as_u64()).sum();
    json!({"sha": sha, "branch": null, "dirty": dirty, "repos": heads})
}

/// `id → (ctx, tier)` for modules on the map.
pub use crate::ports::ModuleIndex;

pub fn history(root: &str, repos: &[String], modules: &ModuleIndex, cls: &Classifier, limit: usize) -> Vec<Value> {
    if repos.is_empty() {
        return history1(root, "", None, modules, cls, limit);
    }
    let mut commits: Vec<Value> = Vec::new();
    for r in repos {
        commits.extend(history1(&format!("{root}/{r}"), &format!("{r}/"), Some(r), modules, cls, limit));
    }
    commits.sort_by_key(|c| std::cmp::Reverse(c["ts"].as_i64().unwrap_or(0)));
    commits.truncate(limit);
    commits
}

fn num(s: &str) -> u64 {
    if !s.is_empty() && s.chars().all(|c| c.is_ascii_digit()) {
        s.parse().unwrap_or(0)
    } else {
        0
    }
}

fn history1(root: &str, prefix: &str, repo: Option<&str>, modules: &ModuleIndex, cls: &Classifier, limit: usize) -> Vec<Value> {
    // rename forms: "a/{x => y}/b" and "x => y"
    let rename = Regex::new(r"^(.*)\{(.*) => (.*)\}(.*)$").unwrap();
    let norm = |p: &str| -> String {
        match rename.captures(p) {
            Some(c) => format!("{}{}{}", &c[1], &c[3], &c[4]).replace("//", "/"),
            None => p.rsplit(" => ").next().unwrap_or(p).to_string(),
        }
    };
    let format = format!("--format={SEP}%H%x1f%h%x1f%an%x1f%at%x1f%s");
    let n = format!("-{limit}");
    let out = git(root, &["log", &n, "--relative", "--numstat", "--date=unix", &format, "--", "."]);
    let mut commits = Vec::new();
    for block in out.split(SEP) {
        if block.trim().is_empty() {
            continue;
        }
        let lines: Vec<&str> = block.trim_matches('\n').split('\n').collect();
        let mut head: Vec<&str> = lines[0].split('\u{1f}').collect();
        head.resize(5, "");
        let (full, short, author, ts, subject) = (head[0], head[1], head[2], head[3], head[4]);
        let (mut files, mut add, mut del) = (0usize, 0u64, 0u64);
        let mut mods: Vec<String> = Vec::new();
        let (mut ctxs, mut tiers) = (BTreeSet::new(), BTreeSet::new());
        for ln in &lines[1..] {
            let parts: Vec<&str> = ln.split('\t').collect();
            if parts.len() != 3 {
                continue;
            }
            let path = format!("{prefix}{}", norm(parts[2]));
            add += num(parts[0]);
            del += num(parts[1]);
            files += 1;
            if let Some((ctx, tier)) = modules.get(path.as_str()) {
                ctxs.insert(ctx.to_string());
                tiers.insert(tier.to_string());
                mods.push(path);
            } else {
                let c = cls.classify(&path, None);
                if c.tier != "unmapped" {
                    ctxs.insert(c.ctx_key());
                    tiers.insert(c.tier);
                }
            }
        }
        commits.push(json!({
            "sha": full, "short": short, "repo": repo, "author": author, "ts": ts.trim().parse::<i64>().unwrap_or(0),
            "subject": subject, "add": add, "del": del, "files": files, "modules": mods,
            "contexts": ctxs, "tiers": tiers, "blast": ctxs.len(), "shotgun": ctxs.len() > 3 || tiers.len() > 2,
        }));
    }
    commits
}
