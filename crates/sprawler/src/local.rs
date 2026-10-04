//! The local workspace (driven adapter): the file system, git and analyzer plugins behind `ports::Workspace`.
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::Value;
use sprawler_domain::classify::Classifier;

use crate::ports::{GitStat, ModuleIndex, Obj, Scan, WorkTree, Workspace};
use crate::{history, scan, walk};

fn root_repos(p: &Obj) -> (String, Vec<String>) {
    let root = p.get("root").and_then(Value::as_str).unwrap_or(".").to_string();
    let repos = p.get("repos").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_string).collect();
    (root, repos)
}

pub struct Local;

impl Workspace for Local {
    fn scan(&self, p: &Obj) -> Result<Scan, String> {
        scan::scan(p)
    }
    fn read_text(&self, path: &Path) -> String {
        scan::read_text(path)
    }
    fn history(&self, root: &str, repos: &[String], modules: &ModuleIndex, cls: &Classifier, limit: usize) -> Vec<Value> {
        history::history(root, repos, modules, cls, limit)
    }
    fn head(&self, root: &str, repos: &[String]) -> Value {
        history::head(root, repos)
    }
    fn worktree(&self, p: &Obj) -> WorkTree {
        let (root, repos) = root_repos(p);
        let rules = walk::Rules::from_profile(p).ok();
        history::worktree(&root, &repos, &|id| rules.as_ref().is_some_and(|r| r.walkable(id)))
    }
    fn head_texts(&self, p: &Obj, ids: &[String]) -> HashMap<String, String> {
        let (root, repos) = root_repos(p);
        history::head_texts(&root, &repos, ids)
    }
    fn file_stats(&self, p: &Obj, ids: &HashSet<&str>, limit: usize) -> HashMap<String, GitStat> {
        let (root, repos) = root_repos(p);
        history::file_stats(&root, &repos, ids, limit)
    }
    fn now(&self) -> i64 {
        SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs() as i64)
    }
}
