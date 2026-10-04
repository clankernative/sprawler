//! Git (adapter): HEAD per repo, per-commit blast radius across contexts and tiers, the working tree
//! vs HEAD (construction state), HEAD versions of files, and per-file churn / authors / last change.
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::io::Write;
use std::process::{Command, Stdio};

use regex::Regex;
use serde_json::{json, Value};
use sprawler_domain::classify::Classifier;

use crate::ports::{GitStat, WorkFile, WorkTree};

const SEP: char = '\u{1e}';

/// Runs git in `root`; stdout, or empty on failure. `--no-optional-locks`: our own `status` calls must
/// not refresh the index, or the server's watcher would see that as a change and rescan forever.
pub fn git(root: &str, args: &[&str]) -> String {
    git_bytes(root, args, None).map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default()
}

/// Like [`git`], raw bytes (`-z` output, blobs), with optional stdin; `None` when git fails.
fn git_bytes(root: &str, args: &[&str], stdin: Option<Vec<u8>>) -> Option<Vec<u8>> {
    let mut cmd = Command::new("git");
    cmd.arg("--no-optional-locks").arg("-C").arg(root).args(args).stdout(Stdio::piped()).stderr(Stdio::null());
    cmd.stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() });
    let mut child = cmd.spawn().ok()?;
    let writer = stdin.and_then(|body| {
        let mut w = child.stdin.take()?;
        Some(std::thread::spawn(move || w.write_all(&body)))
    });
    let out = child.wait_with_output().ok()?;
    if let Some(w) = writer {
        let _ = w.join();
    }
    out.status.success().then_some(out.stdout)
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

/// A path as git log prints it, renames resolved to the new name: "a/{x => y}/b" and "x => y".
fn rename_target(rename: &Regex, p: &str) -> String {
    match rename.captures(p) {
        Some(c) => format!("{}{}{}", &c[1], &c[3], &c[4]).replace("//", "/"),
        None => p.rsplit(" => ").next().unwrap_or(p).to_string(),
    }
}

fn rename_re() -> Regex {
    Regex::new(r"^(.*)\{(.*) => (.*)\}(.*)$").unwrap()
}

fn history1(root: &str, prefix: &str, repo: Option<&str>, modules: &ModuleIndex, cls: &Classifier, limit: usize) -> Vec<Value> {
    let rename = rename_re();
    let norm = |p: &str| rename_target(&rename, p);
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

/// `(git dir to run in, module id prefix)` per repo of a profile: the root, or each of `repos`.
fn repo_roots(root: &str, repos: &[String]) -> Vec<(String, String)> {
    if repos.is_empty() {
        vec![(root.to_string(), String::new())]
    } else {
        repos.iter().map(|r| (format!("{root}/{r}"), format!("{r}/"))).collect()
    }
}

/// `git status --porcelain=v1 -z` → `(path, XY, original path of a rename/copy)`, paths relative to
/// the scanned folder (`strip` = `rev-parse --show-prefix`; porcelain paths are toplevel-relative).
fn parse_status(raw: &[u8], strip: &str) -> Vec<(String, String, Option<String>)> {
    let text = String::from_utf8_lossy(raw);
    let toks: Vec<&str> = text.split('\0').collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < toks.len() {
        let t = toks[i];
        i += 1;
        if t.len() < 4 {
            continue;
        }
        let (xy, path) = (&t[..2], &t[3..]);
        let mut orig = None;
        if xy.contains('R') || xy.contains('C') {
            orig = toks.get(i).map(|o| o.to_string());
            i += 1;
        }
        let Some(path) = path.strip_prefix(strip) else { continue };
        let orig = orig.and_then(|o| o.strip_prefix(strip).map(str::to_string));
        out.push((path.to_string(), xy.to_string(), orig));
    }
    out
}

/// `git diff --numstat -z` → `{path: (added, deleted)}`, renames keyed by their destination.
fn parse_numstat(raw: &[u8]) -> HashMap<String, (u64, u64)> {
    let text = String::from_utf8_lossy(raw);
    let toks: Vec<&str> = text.split('\0').collect();
    let mut out = HashMap::new();
    let mut i = 0;
    while i < toks.len() {
        let parts: Vec<&str> = toks[i].split('\t').collect();
        i += 1;
        if parts.len() != 3 {
            continue;
        }
        let mut path = parts[2].to_string();
        if path.is_empty() {
            // rename: the next two tokens are source and destination
            path = toks.get(i + 1).unwrap_or(&"").to_string();
            i += 2;
        }
        out.insert(path, (num(parts[0]), num(parts[1])));
    }
    out
}

/// Working tree vs HEAD for every repo of the profile (`walkable` decides which paths the scan would list).
pub fn worktree(root: &str, repos: &[String], walkable: &dyn Fn(&str) -> bool) -> WorkTree {
    let mut files: BTreeMap<String, WorkFile> = BTreeMap::new();
    let mut any_git = false;
    for (groot, prefix) in repo_roots(root, repos) {
        let Some(show) = git_bytes(&groot, &["rev-parse", "--show-prefix"], None) else { continue };
        any_git = true;
        let strip = String::from_utf8_lossy(&show).trim().to_string();
        let st = git_bytes(&groot, &["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."], None).unwrap_or_default();
        let ns = git_bytes(&groot, &["diff", "HEAD", "--numstat", "-z", "--relative", "--", "."], None).unwrap_or_default();
        let nums = parse_numstat(&ns);
        for (path, xy, orig) in parse_status(&st, &strip) {
            let (x, y) = (&xy[..1], &xy[1..]);
            let st = if xy == "??" || (x == "A" && y != "D") {
                "new"
            } else if x == "A" && y == "D" || xy == "!!" {
                continue; // added then deleted: never existed at HEAD, and is not on disk
            } else if xy.contains('D') && x != "R" {
                "del"
            } else {
                "mod"
            };
            let id = format!("{prefix}{path}");
            let (mut add, mut del) = match nums.get(&path) {
                Some(&(a, d)) => (Some(a), d),
                None => (None, 0),
            };
            if st == "new" && xy == "??" {
                (add, del) = (None, 0); // counted by the caller, only for files that turn out to be modules
            }
            let orig_id = orig.as_ref().map(|o| format!("{prefix}{o}"));
            if let (Some(o), "mod") = (&orig_id, st) {
                // the old path of a rename is gone from the map
                files.entry(o.clone()).or_insert_with(|| WorkFile {
                    st: "del",
                    add: Some(0),
                    del: nums.get(orig.as_deref().unwrap_or("")).map_or(0, |n| n.1),
                    orig: None,
                    renamed: Some(id.clone()),
                    walkable: walkable(o),
                });
            }
            let w = walkable(&id);
            files.insert(id, WorkFile { st, add: add.or(if st == "new" { None } else { Some(0) }), del, orig: orig_id, renamed: None, walkable: w });
        }
    }
    WorkTree { files, git: any_git }
}

/// HEAD versions of files, by module id; ids without a HEAD version are left out.
pub fn head_texts(root: &str, repos: &[String], ids: &[String]) -> HashMap<String, String> {
    let mut by_root: BTreeMap<String, Vec<(String, String)>> = BTreeMap::new();
    for id in ids {
        let (groot, rel) = match repos.iter().find(|r| id.starts_with(&format!("{r}/"))) {
            Some(r) => (format!("{root}/{r}"), id[r.len() + 1..].to_string()),
            None if repos.is_empty() => (root.to_string(), id.clone()),
            None => continue,
        };
        by_root.entry(groot).or_default().push((id.clone(), rel));
    }
    let mut out = HashMap::new();
    for (groot, want) in by_root {
        let stdin: String = want.iter().map(|(_, rel)| format!("HEAD:./{rel}\n")).collect();
        let Some(raw) = git_bytes(&groot, &["cat-file", "--batch"], Some(stdin.into_bytes())) else { continue };
        let mut pos = 0;
        for (id, _) in &want {
            let Some(nl) = raw[pos..].iter().position(|&b| b == b'\n').map(|n| pos + n) else { break };
            let header = String::from_utf8_lossy(&raw[pos..nl]).into_owned();
            pos = nl + 1;
            let h: Vec<&str> = header.split_whitespace().collect();
            if h.len() != 3 {
                continue; // "<name> missing"
            }
            let n: usize = h[2].parse().unwrap_or(0);
            let end = (pos + n).min(raw.len());
            if h[1] == "blob" {
                out.insert(id.clone(), String::from_utf8_lossy(&raw[pos..end]).replace("\r\n", "\n"));
            }
            pos = end + 1;
        }
    }
    out
}

/// Per-file churn (commits touching it), distinct authors and last change, from the last `limit`
/// commits of each repo; only for `ids`.
pub fn file_stats(root: &str, repos: &[String], ids: &HashSet<&str>, limit: usize) -> HashMap<String, GitStat> {
    let rename = rename_re();
    let n = format!("-{limit}");
    let mut acc: HashMap<String, (u64, BTreeSet<String>, i64)> = HashMap::new();
    for (groot, prefix) in repo_roots(root, repos) {
        let log = git(&groot, &["log", &n, "--relative", "--name-only", "--format=\u{1e}%an\u{1f}%at", "--", "."]);
        for block in log.split(SEP) {
            let mut lines = block.trim_matches('\n').split('\n');
            let Some(head) = lines.next().filter(|h| !h.trim().is_empty()) else { continue };
            let (author, ts) = head.split_once('\u{1f}').unwrap_or((head, "0"));
            let ts: i64 = ts.trim().parse().unwrap_or(0);
            for f in lines.map(str::trim).filter(|f| !f.is_empty()) {
                let id = format!("{prefix}{}", rename_target(&rename, f));
                if !ids.contains(id.as_str()) {
                    continue;
                }
                let e = acc.entry(id).or_insert_with(|| (0, BTreeSet::new(), 0));
                e.0 += 1;
                e.1.insert(author.to_string());
                e.2 = e.2.max(ts);
            }
        }
    }
    acc.into_iter().map(|(id, (churn, authors, last))| (id, GitStat { churn, authors: authors.len() as u64, last })).collect()
}
