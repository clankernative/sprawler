//! Workspace walk (adapter): which files the profile includes, in a stable order.
//!
//! top-down, files of a folder before its subfolders,
//! names sorted; common build/vendor folders and dot-folders pruned; symlinked folders not followed.
use std::path::Path;

use regex::Regex;
use serde_json::Value;
use sprawler_domain::glob::compile_path_glob;

use crate::profile::Obj;

pub const PRUNE: [&str; 8] = [".git", "target", "node_modules", "graphify-out", ".research", "__pycache__", ".venv", "dist"];

pub struct Walk {
    /// Source files for analyzers (profile extensions, or explicitly named includes).
    pub files: Vec<String>,
    /// `Cargo.toml` manifests (declared crate dependencies for the Rust analyzer).
    pub cargo: Vec<String>,
}

fn globs(p: &Obj, key: &str) -> Result<Vec<Regex>, String> {
    p.get(key)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(|g| compile_path_glob(g).map_err(|e| format!("{key} glob {g}: {e}")))
        .collect()
}

fn any(res: &[Regex], s: &str) -> bool {
    res.iter().any(|r| r.is_match(s))
}

/// The profile's include / exclude / extension rules, compiled once.
pub struct Rules {
    include: Vec<Regex>,
    exclude: Vec<Regex>,
    /// include patterns whose last segment is a literal name select files of any extension
    explicit: Vec<Regex>,
    exts: Vec<String>,
}

impl Rules {
    pub fn from_profile(p: &Obj) -> Result<Rules, String> {
        let explicit: Vec<Regex> = p
            .get("include")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .filter(|g| {
                let last = g.rsplit('/').next().unwrap_or(g);
                !last.contains('*') && !last.contains('{')
            })
            .filter_map(|g| compile_path_glob(g).ok())
            .collect();
        let exts = p.get("extensions").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_string).collect();
        Ok(Rules { include: globs(p, "include")?, exclude: globs(p, "exclude")?, explicit, exts })
    }

    /// A folder the walk enters (`rel` relative to the root, `name` its last segment).
    fn enters(&self, rel: &str, name: &str) -> bool {
        !PRUNE.contains(&name) && !name.starts_with('.') && !any(&self.exclude, rel)
    }

    /// Would the walk list this file as a source file (not a `Cargo.toml`)? No disk access.
    pub fn walkable(&self, rel: &str) -> bool {
        let parts: Vec<&str> = rel.split('/').collect();
        let Some((name, dirs)) = parts.split_last() else { return false };
        for i in 0..dirs.len() {
            if !self.enters(&parts[..=i].join("/"), dirs[i]) {
                return false;
            }
        }
        if any(&self.exclude, rel) || !any(&self.include, rel) || *name == "Cargo.toml" {
            return false;
        }
        let ext = Path::new(name).extension().map(|x| format!(".{}", x.to_string_lossy()));
        ext.is_some_and(|x| self.exts.contains(&x)) || any(&self.explicit, rel)
    }
}

pub fn walk(p: &Obj) -> Result<Walk, String> {
    let root = Path::new(p.get("root").and_then(Value::as_str).ok_or("profile has no root")?).to_path_buf();
    let rules = Rules::from_profile(p)?;
    let (include, exclude, explicit, exts) = (&rules.include, &rules.exclude, &rules.explicit, &rules.exts);

    let mut out = Walk { files: Vec::new(), cargo: Vec::new() };
    let mut stack: Vec<String> = vec![String::new()];
    while let Some(rd) = stack.pop() {
        let dir = if rd.is_empty() { root.clone() } else { root.join(&rd) };
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        let (mut dirs, mut files) = (Vec::new(), Vec::new());
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            let ft = e.file_type().ok();
            let is_link = ft.is_some_and(|t| t.is_symlink());
            // os.walk: a symlink to a folder is listed as a folder but never entered
            let is_dir = if is_link { e.path().is_dir() } else { ft.is_some_and(|t| t.is_dir()) };
            if is_dir {
                if !is_link {
                    dirs.push(name);
                }
            } else {
                files.push(name);
            }
        }
        files.sort();
        for f in &files {
            let rel = if rd.is_empty() { f.clone() } else { format!("{rd}/{f}") };
            if any(exclude, &rel) || !any(include, &rel) {
                continue;
            }
            if f == "Cargo.toml" {
                out.cargo.push(rel);
            } else {
                let ext = Path::new(f).extension().map(|x| format!(".{}", x.to_string_lossy()));
                if ext.is_some_and(|x| exts.contains(&x)) || any(explicit, &rel) {
                    out.files.push(rel);
                }
            }
        }
        dirs.retain(|d| {
            let rel = if rd.is_empty() { d.clone() } else { format!("{rd}/{d}") };
            rules.enters(&rel, d)
        });
        dirs.sort();
        // depth-first, first subfolder next: push in reverse
        for d in dirs.into_iter().rev() {
            stack.push(if rd.is_empty() { d } else { format!("{rd}/{d}") });
        }
    }
    Ok(out)
}
