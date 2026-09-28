//! Analyzer plugin runner (adapter): find `sprawler-analyzer-<name>` executables, route files to
//! them by their `describe` claims, and run `analyze` over the JSON protocol (docs/PROTOCOL.md).
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde_json::Value;
use sprawler_domain::glob::fnmatch;
use sprawler_protocol::PROTOCOL;

use crate::profile::{resolve_path, Obj};

const PREFIX: &str = "sprawler-analyzer-";

#[derive(Debug, Clone)]
pub struct Plugin {
    pub name: String,
    pub exe: PathBuf,
    pub info: Value,
}

impl Plugin {
    pub fn semantic(&self) -> bool {
        self.info.get("precision").and_then(Value::as_str) == Some("semantic")
    }
    pub fn claims(&self, rel: &str) -> bool {
        let base = rel.rsplit('/').next().unwrap_or(rel);
        let ext = Path::new(base).extension().map(|e| format!(".{}", e.to_string_lossy()));
        let c = self.info.get("claims");
        let list = |k: &str| c.and_then(|c| c.get(k)).and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str);
        ext.is_some_and(|e| list("extensions").any(|x| x == e)) || list("files").any(|g| fnmatch(base, g))
    }
    /// First claimed extension without the dot (the module `lang` its facts describe).
    pub fn lang(&self) -> String {
        self.info.pointer("/claims/extensions/0").and_then(Value::as_str).unwrap_or("").trim_start_matches('.').to_string()
    }
}

/// Where `sprawler plugin add` installs: `~/.local/share/sprawler/plugins` (or `SPRAWLER_PLUGIN_HOME`).
pub fn plugin_home() -> PathBuf {
    match std::env::var_os("SPRAWLER_PLUGIN_HOME") {
        Some(p) if !p.is_empty() => PathBuf::from(p),
        _ => resolve_path("~/.local/share/sprawler/plugins"),
    }
}

/// Where plugins are looked up, in order.
pub fn search_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(p) = std::env::var_os("SPRAWLER_PLUGIN_PATH") {
        dirs.extend(std::env::split_paths(&p));
    }
    if let Some(d) = std::env::current_exe().ok().and_then(|e| e.parent().map(Path::to_path_buf)) {
        dirs.push(d);
    }
    dirs.push(plugin_home().join("bin"));
    if let Some(p) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&p));
    }
    dirs
}

pub fn describe(exe: &Path) -> Result<Value, String> {
    let o = Command::new(exe).arg("describe").output().map_err(|e| format!("{}: {e}", exe.display()))?;
    if !o.status.success() {
        return Err(format!("{} describe failed: {}", exe.display(), String::from_utf8_lossy(&o.stderr).trim()));
    }
    let v: Value = serde_json::from_slice(&o.stdout).map_err(|e| format!("{} describe: {e}", exe.display()))?;
    if v.get("protocol").and_then(Value::as_str) != Some(PROTOCOL) {
        return Err(format!("{} speaks {:?}, expected {PROTOCOL}", exe.display(), v.get("protocol")));
    }
    Ok(v)
}

/// A plugin from an explicit executable path (for `sprawler plugin test`).
pub fn load(exe: &Path) -> Result<Plugin, String> {
    let info = describe(exe)?;
    let name = info.get("name").and_then(Value::as_str).unwrap_or_default().to_string();
    Ok(Plugin { name, exe: exe.to_path_buf(), info })
}

/// Installed plugins, sorted by name. `[analyzers] <name> = "path"` in the profile wins over search.
pub fn discover(p: &Obj, warnings: &mut Vec<String>) -> Vec<Plugin> {
    let mut found: Vec<(String, PathBuf)> = Vec::new();
    if let Some(t) = p.get("analyzers").and_then(Value::as_object) {
        for (name, v) in t {
            if let Some(path) = v.as_str().or_else(|| v.get("path").and_then(Value::as_str)) {
                found.push((name.clone(), resolve_path(path)));
            }
        }
    }
    for dir in search_dirs() {
        for e in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
            let file = e.file_name().to_string_lossy().into_owned();
            // `sprawler-analyzer-rust` on Unix, `sprawler-analyzer-rust.exe` on Windows
            let file = file.strip_suffix(std::env::consts::EXE_SUFFIX).unwrap_or(&file).to_string();
            let Some(name) = file.strip_prefix(PREFIX) else { continue };
            if name.is_empty() || name.contains('.') || found.iter().any(|(n, _)| n == name) || !e.path().is_file() {
                continue;
            }
            found.push((name.to_string(), e.path()));
        }
    }
    let mut out = Vec::new();
    for (name, exe) in found {
        match describe(&exe) {
            Ok(info) => out.push(Plugin { name, exe, info }),
            Err(e) => warnings.push(format!("analyzer plugin skipped: {e}")),
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// Route each file to one plugin: a claiming `semantic` plugin beats a `syntactic` one; ties go by name.
pub fn assign<'a>(plugins: &'a [Plugin], files: &[String]) -> Vec<(&'a Plugin, Vec<String>)> {
    let mut out: Vec<(&Plugin, Vec<String>)> = plugins.iter().map(|p| (p, Vec::new())).collect();
    for f in files {
        let mut best: Option<usize> = None;
        for (i, p) in plugins.iter().enumerate() {
            if p.claims(f) && best.is_none_or(|b| p.semantic() && !plugins[b].semantic()) {
                best = Some(i);
            }
        }
        if let Some(i) = best {
            out[i].1.push(f.clone());
        }
    }
    out.retain(|(_, f)| !f.is_empty());
    out
}

pub fn analyze(plugin: &Plugin, request: &Value) -> Result<Value, String> {
    let mut child = Command::new(&plugin.exe)
        .arg("analyze")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("{}: {e}", plugin.exe.display()))?;
    let body = serde_json::to_vec(request).map_err(|e| e.to_string())?;
    let mut stdin = child.stdin.take().ok_or("no stdin")?;
    let writer = std::thread::spawn(move || stdin.write_all(&body));
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    let _ = writer.join();
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(err.trim().chars().rev().take(600).collect::<Vec<_>>().into_iter().rev().collect());
    }
    let v: Value = serde_json::from_slice(&out.stdout).map_err(|e| format!("bad analyze output: {e}"))?;
    if v.get("protocol").and_then(Value::as_str) != Some(PROTOCOL) {
        return Err(format!("analyze output is not {PROTOCOL}"));
    }
    Ok(v)
}
