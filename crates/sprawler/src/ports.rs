//! Ports (what the atlas use case needs from the outside world). The application layer — atlas
//! assembly, views, seams, prompts — depends only on these; `local.rs` implements them with the
//! file system, git and analyzer plugins, and the driving adapters (CLI, server) pass it in.
use std::collections::HashMap;
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
}
