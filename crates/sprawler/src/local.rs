//! The local workspace (driven adapter): the file system, git and analyzer plugins behind `ports::Workspace`.
use std::path::Path;

use serde_json::Value;
use sprawler_domain::classify::Classifier;

use crate::ports::{ModuleIndex, Obj, Scan, Workspace};
use crate::{history, scan};

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
}
