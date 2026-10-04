//! Ports (what the atlas use case needs from the outside world). The application layer — atlas
//! assembly, views, seams, prompts — depends only on these; `local.rs` implements them with the
//! file system, git and analyzer plugins, and the driving adapters (CLI, server) pass it in.
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::Path;

use serde_json::{Map, Value};
use sprawler_domain::classify::Classifier;

/// A resolved profile (JSON object).
pub type Obj = Map<String, Value>;

/// module id → (context, tier), for attributing commits.
pub type ModuleIndex<'a> = HashMap<&'a str, (&'a str, &'a str)>;

/// One scan of a workspace: the fact graph plus what the analyzers reported alongside it.
pub struct Scan {
    /// Input for the judge (`sprawler_domain::judge::Graph`).
    pub graph: Value,
    pub externals: Vec<(String, u64)>,
    pub phantoms: Vec<Value>,
    pub warnings: Vec<String>,
    pub stats: Value,
    pub analyzers: Vec<Value>,
}

/// One file that differs between the working tree and HEAD. Keyed by module id (relative to the
/// profile root, repo-prefixed in a multi-repo profile).
#[derive(Debug, Clone)]
pub struct WorkFile {
    /// `new` (untracked or added) · `mod` (modified, renamed) · `del` (deleted, or the old side of a rename)
    pub st: &'static str,
    /// Lines added; `None` for an untracked file (count its lines if it matters).
    pub add: Option<u64>,
    pub del: u64,
    /// A renamed file: the id its HEAD version lives at.
    pub orig: Option<String>,
    /// The old side of a rename: the id it moved to.
    pub renamed: Option<String>,
    /// Would a scan list this path (include / exclude / extensions)?
    pub walkable: bool,
}

/// The working tree vs HEAD, for every repo of a profile.
#[derive(Debug, Clone, Default)]
pub struct WorkTree {
    pub files: BTreeMap<String, WorkFile>,
    /// At least one repo is a git repository.
    pub git: bool,
}

/// Git history of one file: commits touching it, distinct authors, last change (unix seconds).
#[derive(Debug, Clone, Copy, Default)]
pub struct GitStat {
    pub churn: u64,
    pub authors: u64,
    pub last: i64,
}

/// Everything the atlas use case reads from outside itself.
pub trait Workspace {
    /// Walk the workspace and run the analyzer plugins.
    fn scan(&self, p: &Obj) -> Result<Scan, String>;
    /// A source file's text (empty when unreadable), newlines normalized.
    fn read_text(&self, path: &Path) -> String;
    /// Recent commits with their blast radius across contexts and tiers.
    fn history(&self, root: &str, repos: &[String], modules: &ModuleIndex, cls: &Classifier, limit: usize) -> Vec<Value>;
    /// HEAD of each repo (sha, branch, dirty).
    fn head(&self, root: &str, repos: &[String]) -> Value;
    /// Uncommitted work: what differs between the working tree and HEAD.
    fn worktree(&self, p: &Obj) -> WorkTree;
    /// HEAD versions of files, by module id (ids with no HEAD version are left out).
    fn head_texts(&self, p: &Obj, ids: &[String]) -> HashMap<String, String>;
    /// Churn, authors and last change of the given files over the last `limit` commits.
    fn file_stats(&self, p: &Obj, ids: &HashSet<&str>, limit: usize) -> HashMap<String, GitStat>;
    /// Seconds since the Unix epoch.
    fn now(&self) -> i64;
}
