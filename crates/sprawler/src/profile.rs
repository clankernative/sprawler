//! Profile loading (adapter): TOML files, `extends`, and workspace configs → one resolved profile.
//!
//! The built-in rules files are compiled into the binary, so `sprawler` runs with nothing else installed.
use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::{json, Value};
use sprawler_domain::classify::Classifier;
use sprawler_domain::judge::Policy;

pub use crate::ports::Obj;

/// The shared (committed) workspace config file name.
pub const SHARED_CONFIG: &str = "sprawler.workspace.toml";

const BUILTIN: &[(&str, &str)] = &[
    ("ddd-hexagonal", include_str!("../../../packs/architectures/ddd-hexagonal.toml")),
    ("cqrs", include_str!("../../../packs/architectures/cqrs.toml")),
    ("vertical-slices", include_str!("../../../packs/architectures/vertical-slices.toml")),
    ("clankernative", include_str!("../../../packs/platforms/clankernative.toml")),
    ("dotnet", include_str!("../../../packs/languages/dotnet.toml")),
];
const ALIASES: &[(&str, &str)] = &[("day2", "clankernative")];
/// Tables that merge key by key when a profile `extends` a base.
const MERGE_DICTS: [&str; 7] = ["layers", "roles", "allow", "breach_severity", "scoring", "analyzers", "views"];
const RULE_LISTS: [&str; 6] = ["from_tier", "to_tier", "from_layer", "to_layer", "from_ctx", "to_ctx"];

fn alias(name: &str) -> &str {
    ALIASES.iter().find(|(a, _)| *a == name).map_or(name, |(_, t)| t)
}

pub fn builtin_names() -> Vec<&'static str> {
    BUILTIN.iter().map(|(n, _)| *n).collect()
}

fn builtin(name: &str) -> Option<&'static str> {
    let name = alias(name.strip_suffix(".toml").unwrap_or(name));
    BUILTIN.iter().find(|(n, _)| *n == name).map(|(_, t)| *t)
}

pub fn parse_toml(text: &str, origin: &str) -> Result<Obj, String> {
    let v: toml::Value = toml::from_str(text).map_err(|e| format!("{origin}: {e}"))?;
    match serde_json::to_value(v).map_err(|e| format!("{origin}: {e}"))? {
        Value::Object(o) => Ok(o),
        _ => Err(format!("{origin}: not a table")),
    }
}

fn read_toml(path: &Path) -> Result<Obj, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    parse_toml(&text, &path.display().to_string())
}

/// `~` expansion + absolute, symlink-resolved path (like Python's `Path.expanduser().resolve()`).
pub fn resolve_path(p: &str) -> PathBuf {
    let expanded = match p.strip_prefix('~') {
        Some(rest) if rest.is_empty() || rest.starts_with('/') => PathBuf::from(format!("{}{rest}", std::env::var("HOME").unwrap_or_default())),
        _ => PathBuf::from(p),
    };
    std::fs::canonicalize(&expanded).unwrap_or_else(
        |_| {
            if expanded.is_absolute() {
                expanded
            } else {
                std::env::current_dir().unwrap_or_default().join(expanded)
            }
        },
    )
}

fn path_str(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

fn base_name(p: &str) -> String {
    Path::new(p).file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default()
}

/// Where `sprawler pack add` installs packs: `~/.local/share/sprawler/packs` (or `SPRAWLER_PACK_HOME`).
pub fn pack_home() -> PathBuf {
    match std::env::var_os("SPRAWLER_PACK_HOME") {
        Some(p) if !p.is_empty() => PathBuf::from(p),
        _ => resolve_path("~/.local/share/sprawler/packs"),
    }
}

/// A pack by name or path: next to the file that names it, then installed packs, then built-in.
/// Returns the pack and the folder its own `extends` resolve from.
fn find_pack(name: &str, near: &Path) -> Result<(Obj, PathBuf), String> {
    let home = pack_home();
    let stem = name.strip_suffix(".toml").unwrap_or(name);
    for dir in [near.to_path_buf(), home] {
        for cand in [dir.join(name), dir.join(format!("{stem}.toml")), dir.join(stem).join("pack.toml")] {
            if cand.is_file() {
                let parent = cand.parent().map(Path::to_path_buf).unwrap_or_default();
                return Ok((read_toml(&cand)?, parent));
            }
        }
    }
    let text = builtin(stem)
        .ok_or_else(|| format!("extends '{name}', but no such pack (installed: {}; built-in: {})", pack_home().display(), builtin_names().join(", ")))?;
    Ok((parse_toml(text, stem)?, near.to_path_buf()))
}

/// `extends = "a"` or `extends = ["a", "b"]`: each pack (with its own `extends`) merged left to right.
fn resolve_bases(extends: &Value, near: &Path, depth: u8) -> Result<Obj, String> {
    let names: Vec<String> = match extends {
        Value::String(s) => vec![s.clone()],
        Value::Array(a) => a.iter().filter_map(Value::as_str).map(str::to_string).collect(),
        _ => vec![],
    };
    if depth > 8 {
        return Err(format!("extends nests too deeply (a cycle?) at {}", names.join(", ")));
    }
    let mut acc = Obj::new();
    for n in &names {
        let (mut pack, dir) = find_pack(n, near)?;
        if let Some(ext) = pack.remove("extends") {
            pack = merge_profile(&resolve_bases(&ext, &dir, depth + 1)?, &pack);
        }
        acc = merge_profile(&acc, &pack);
    }
    Ok(acc)
}

/// A pack with everything it extends, e.g. the `rules` of a workspace config.
pub fn load_pack(name: &str, near: &Path) -> Result<Obj, String> {
    resolve_bases(&json!(name), near, 0)
}

/// Profile keys win. `MERGE_DICTS` tables merge; `map` is prepended (more specific first);
/// `rules` with the same id replace the base rule in place, new ones are appended.
pub fn merge_profile(base: &Obj, over: &Obj) -> Obj {
    let mut out: Obj = base.iter().filter(|(k, _)| *k != "kind").map(|(k, v)| (k.clone(), v.clone())).collect();
    for (k, v) in over {
        let merged = match (k.as_str(), v) {
            (k2, Value::Object(o)) if MERGE_DICTS.contains(&k2) => {
                let mut m = base.get(k2).and_then(Value::as_object).cloned().unwrap_or_default();
                m.extend(o.clone());
                Value::Object(m)
            }
            ("map", Value::Array(a)) => {
                let mut m = a.clone();
                m.extend(base.get("map").and_then(Value::as_array).cloned().unwrap_or_default());
                Value::Array(m)
            }
            (k2 @ ("rules" | "achievements"), Value::Array(a)) => {
                let id = |r: &Value| r.get("id").and_then(Value::as_str).map(str::to_string);
                let mut pending: Vec<Value> = a.clone();
                let mut rules = Vec::new();
                for r in base.get(k2).and_then(Value::as_array).cloned().unwrap_or_default() {
                    match pending.iter().position(|x| id(x) == id(&r)) {
                        Some(i) => rules.push(pending.remove(i)),
                        None => rules.push(r),
                    }
                }
                rules.extend(pending);
                Value::Array(rules)
            }
            _ => v.clone(),
        };
        out.insert(k.clone(), merged);
    }
    out
}

fn set_default(p: &mut Obj, k: &str, v: Value) {
    p.entry(k.to_string()).or_insert(v);
}

/// Defaults for a profile dict, from a legacy profile file or a workspace config.
pub fn finalize(mut p: Obj) -> Result<Obj, String> {
    let root = p.get("root").and_then(Value::as_str).ok_or("profile has no root")?.to_string();
    p.insert("root".into(), json!(path_str(&resolve_path(&root))));
    let name = p.get("name").and_then(Value::as_str).unwrap_or_default().to_uppercase();
    set_default(&mut p, "title", json!(name));
    set_default(&mut p, "include", json!(["**"]));
    set_default(&mut p, "exclude", json!([]));
    set_default(&mut p, "extensions", json!([".roc", ".rs", ".py", ".ts"]));
    set_default(&mut p, "tiers", json!([{"id": "app", "label": "CODE", "color": "#39ffb0", "depends": [], "cross": "allow"}]));
    for k in ["layers", "allow", "analyzers"] {
        set_default(&mut p, k, json!({}));
    }
    for k in ["rules", "map"] {
        set_default(&mut p, k, json!([]));
    }
    set_default(&mut p, "breach_severity", json!({"default": "major"}));
    if let Some(Value::Array(rules)) = p.get_mut("rules") {
        for r in rules.iter_mut().filter_map(Value::as_object_mut) {
            for k in RULE_LISTS {
                let v = match r.remove(k) {
                    None | Some(Value::Null) => Value::Null,
                    Some(Value::Array(a)) => Value::Array(a),
                    Some(x) => Value::Array(vec![x]),
                };
                r.insert(k.into(), v);
            }
        }
    }
    Ok(p)
}

/// A full profile file (optionally `extends` a rules file), e.g. `my-backend.toml`.
pub fn load_profile(path: &Path, root: Option<&str>) -> Result<Obj, String> {
    let mut p = read_toml(path)?;
    let file = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    if let Some(ext) = p.remove("extends") {
        let base = resolve_bases(&ext, file.parent().unwrap_or(Path::new(".")), 0)?;
        p = merge_profile(&base, &p);
        // the packs this profile names directly, for the badge and reports
        let names: Vec<String> = match &ext {
            Value::String(s) => vec![s.clone()],
            Value::Array(a) => a.iter().filter_map(Value::as_str).map(str::to_string).collect(),
            _ => vec![],
        };
        p.insert("_packs".into(), json!(names));
    }
    p.insert("_path".into(), json!(path_str(&file)));
    if let Some(r) = root {
        p.insert("root".into(), json!(r));
    }
    let r = p.get("root").and_then(Value::as_str).ok_or_else(|| format!("{}: no root", path.display()))?.to_string();
    // a relative root in the file means relative to the file, not to wherever sprawler was run from
    let r = if root.is_none() && !r.starts_with('/') && !r.starts_with('~') { path_str(&file.parent().unwrap_or(Path::new(".")).join(&r)) } else { r };
    p.insert("root".into(), json!(path_str(&resolve_path(&r))));
    let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    set_default(&mut p, "name", json!(stem));
    finalize(p)
}

// ── workspace configs ───────────────────────────────────────────────────────
pub fn user_store() -> PathBuf {
    match std::env::var("SPRAWLER_CONFIG_DIR") {
        Ok(d) if !d.is_empty() => PathBuf::from(d),
        _ => resolve_path("~/.config/sprawler"),
    }
}

pub fn slug(root: &Path) -> String {
    let r = path_str(&resolve_path(&path_str(root)));
    let h = sha1_smol::Sha1::from(r.as_bytes()).digest().to_string();
    format!("{}-{}", base_name(&r), &h[..8])
}

/// Personal config wins over the shared `DIR/sprawler.workspace.toml`.
pub fn find_config(root: &Path) -> Option<PathBuf> {
    let personal = user_store().join("workspaces").join(format!("{}.toml", slug(root)));
    let shared = resolve_path(&path_str(root)).join(SHARED_CONFIG);
    [personal, shared].into_iter().find(|p| p.exists())
}

pub fn load_config(path: &Path) -> Result<Obj, String> {
    let mut c = read_toml(path)?;
    let file = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let dflt = path_str(file.parent().unwrap_or(Path::new(".")));
    let root = c.get("root").and_then(Value::as_str).filter(|s| !s.is_empty()).map_or(dflt, str::to_string);
    c.insert("root".into(), json!(path_str(&resolve_path(&root))));
    c.insert("_path".into(), json!(path_str(&file)));
    Ok(c)
}

fn under(path: &str, base: &str) -> bool {
    base.is_empty() || path == base || path.starts_with(&format!("{base}/"))
}

fn git_toplevel(dir: &Path) -> String {
    Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(["rev-parse", "--show-toplevel"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default()
}

/// None when one git repo holds the workspace; otherwise the sibling repos under root (platform first).
fn repos(root: &Path, dirs: &[String], plat: &str) -> Value {
    let mut tops = std::collections::BTreeSet::new();
    for d in dirs {
        let t = git_toplevel(&if d.is_empty() { root.to_path_buf() } else { root.join(d) });
        if !t.is_empty() {
            tops.insert(path_str(&resolve_path(&t)));
        }
    }
    let r = path_str(root);
    if tops.is_empty() || (tops.len() == 1 && tops.iter().next().is_some_and(|t| *t == r || r.starts_with(&format!("{t}/")))) {
        return Value::Null;
    }
    let mut rels: Vec<String> = tops.iter().filter_map(|t| t.strip_prefix(&format!("{r}/")).map(str::to_string)).collect();
    rels.sort_by_key(|x| (if plat.is_empty() { true } else { !under(plat, x) }, x.clone()));
    if rels.is_empty() {
        Value::Null
    } else {
        json!(rels)
    }
}

fn strs(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default()
}

fn sub_tokens(s: &str, plat: &str, app: Option<&str>) -> String {
    let mut s = s.replace("{platform}/", &if plat.is_empty() { String::new() } else { format!("{plat}/") }).replace("{platform}", plat);
    if let Some(a) = app {
        s = s.replace("{app}/", &if a.is_empty() { String::new() } else { format!("{a}/") }).replace("{app}", a);
    }
    s
}

fn sub_value(v: &Value, plat: &str) -> Value {
    match v {
        Value::String(s) => json!(sub_tokens(s, plat, None)),
        Value::Array(a) => Value::Array(a.iter().map(|x| sub_value(x, plat)).collect()),
        Value::Object(o) => Value::Object(o.iter().map(|(k, x)| (sub_tokens(k, plat, None), sub_value(x, plat))).collect()),
        _ => v.clone(),
    }
}

/// Workspace config (where things are) + a rules file (what they mean) → profile.
pub fn build_profile(cfg: &Obj) -> Result<Obj, String> {
    let root_s = cfg.get("root").and_then(Value::as_str).ok_or("workspace config has no root")?.to_string();
    let root = PathBuf::from(&root_s);
    let root_name = base_name(&root_s);
    let rname = alias(cfg.get("rules").and_then(Value::as_str).filter(|s| !s.is_empty()).unwrap_or("clankernative")).to_string();
    let near = cfg.get("_path").and_then(Value::as_str).and_then(|p| Path::new(p).parent()).map_or_else(|| root.clone(), Path::to_path_buf);
    let mut rules = load_pack(&rname, &near)?;
    rules.insert("_packs".into(), json!([rname.clone()]));
    let cfg_s = |k: &str| cfg.get(k).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string);
    let or_list = |k: &str| cfg.get(k).filter(|v| v.as_array().is_some_and(|a| !a.is_empty())).cloned().unwrap_or(json!([]));
    let cli = format!("sprawler report {root_s}");

    if rules.get("kind").and_then(Value::as_str) == Some("generic") {
        let mut p: Obj = rules.iter().filter(|(k, _)| *k != "kind").map(|(k, v)| (k.clone(), v.clone())).collect();
        let include = cfg
            .get("include")
            .filter(|v| v.as_array().is_some_and(|a| !a.is_empty()))
            .cloned()
            .or_else(|| rules.get("include").filter(|v| v.as_array().is_some_and(|a| !a.is_empty())).cloned())
            .unwrap_or(json!(["**"]));
        let mut exclude = strs(rules.get("exclude"));
        exclude.extend(strs(cfg.get("exclude")));
        let mut exts = strs(rules.get("extensions"));
        for e in strs(cfg.get("extensions")) {
            if !exts.contains(&e) {
                exts.push(e);
            }
        }
        for (k, v) in [
            ("name", json!(cfg_s("name").unwrap_or_else(|| root_name.clone()))),
            ("title", json!(cfg_s("title").unwrap_or_else(|| root_name.to_uppercase()))),
            ("root", json!(root_s)),
            ("include", include),
            ("exclude", json!(exclude)),
            ("extensions", json!(exts)),
            ("label_strip_prefix", or_list("label_strip_prefix")),
            ("label_strip_suffix", or_list("label_strip_suffix")),
            ("cache_key", json!(slug(&root))),
            ("_path", cfg.get("_path").cloned().unwrap_or(Value::Null)),
            ("_cli", json!(cli)),
            ("_packs", rules.get("_packs").cloned().unwrap_or(json!([]))),
        ] {
            p.insert(k.into(), v);
        }
        return finalize(p);
    }

    let plat = cfg_s("platform").unwrap_or_default().trim_matches('/').to_string();
    let apps: Vec<String> = strs(cfg.get("apps")).iter().map(|a| a.trim_matches('/').to_string()).collect();
    let instances = strs(cfg.get("instances"));
    let tests: Vec<String> = strs(cfg.get("tests")).iter().map(|t| t.trim_matches('/').to_string()).collect();

    let mut maps = Vec::new();
    for m in rules.get("platform_map").and_then(Value::as_array).cloned().unwrap_or_default() {
        let Value::Object(mut o) = m else { continue };
        if o.get("needs_prefix").and_then(Value::as_bool).unwrap_or(false) && plat.is_empty() {
            continue;
        }
        o.remove("needs_prefix");
        let g = sub_tokens(o.get("glob").and_then(Value::as_str).unwrap_or_default(), &plat, None);
        o.insert("glob".into(), json!(g));
        maps.push(Value::Object(o));
    }
    for ip in &instances {
        let dir = Path::new(ip).parent().map(path_str).unwrap_or_default();
        let d = Some(base_name(&dir)).filter(|s| !s.is_empty()).unwrap_or_else(|| root_name.clone());
        let ctx = d.strip_suffix("-instance").map(str::to_string).unwrap_or(d.clone());
        maps.push(json!({"glob": ip, "tier": "instance", "ctx": ctx, "layer": "binding"}));
    }
    for t in &tests {
        maps.push(json!({"glob": format!("{t}/**"), "tier": "host", "ctx": base_name(t), "layer": "test"}));
    }
    for a in &apps {
        let ctx = Some(base_name(a)).filter(|s| !s.is_empty()).unwrap_or_else(|| root_name.clone());
        for m in rules.get("app_map").and_then(Value::as_array).cloned().unwrap_or_default() {
            let Value::Object(mut o) = m else { continue };
            let g = sub_tokens(o.get("glob").and_then(Value::as_str).unwrap_or_default(), &plat, Some(a));
            o.insert("glob".into(), json!(g));
            o.entry("ctx").or_insert(json!(ctx));
            maps.push(Value::Object(o));
        }
    }

    let mut dirs = vec![plat.clone()];
    dirs.extend(apps.iter().cloned());
    dirs.extend(instances.iter().map(|i| Path::new(i).parent().map(path_str).unwrap_or_default()));
    dirs.extend(tests.iter().cloned());
    let mut include: Vec<String> = strs(rules.get("platform_include")).iter().map(|g| sub_tokens(g, &plat, None)).collect();
    include.extend(apps.iter().map(|a| if a.is_empty() { "**".into() } else { format!("{a}/**") }));
    include.extend(instances.iter().cloned());
    include.extend(tests.iter().map(|t| format!("{t}/**")));
    let mut exclude: Vec<String> = strs(rules.get("platform_exclude")).iter().map(|g| sub_tokens(g, &plat, None)).collect();
    exclude.extend(tests.iter().map(|t| format!("{t}/fixtures/**")));
    let get = |k: &str, d: Value| rules.get(k).cloned().unwrap_or(d);

    let mut p = Obj::new();
    for (k, v) in [
        ("name", json!(cfg_s("name").unwrap_or_else(|| root_name.clone()))),
        ("title", json!(cfg_s("title").unwrap_or_else(|| root_name.to_uppercase()))),
        ("root", json!(root_s)),
        ("repos", repos(&root, &dirs, &plat)),
        ("include", json!(include)),
        ("exclude", json!(exclude)),
        ("extensions", get("extensions", json!([".roc", ".rs"]))),
        ("label_strip_prefix", or_list("label_strip_prefix")),
        ("label_strip_suffix", or_list("label_strip_suffix")),
        ("analyzers", sub_value(&get("analyzers", json!({})), &plat)),
        ("tiers", get("tiers", json!([]))),
        ("layers", get("layers", json!({}))),
        ("allow", get("allow", json!({}))),
        ("breach_severity", get("breach_severity", json!({"default": "major"}))),
        ("rules", get("rules", json!([]))),
        ("map", json!(maps)),
        ("achievements", get("achievements", json!([]))),
        ("views", get("views", json!({}))),
        ("seams", sub_value(&get("seams", json!([])), &plat)),
        ("cache_key", json!(slug(&root))),
        ("_path", cfg.get("_path").cloned().unwrap_or(Value::Null)),
        ("_cli", json!(cli)),
        ("_packs", rules.get("_packs").cloned().unwrap_or(json!([]))),
    ] {
        p.insert(k.into(), v);
    }
    finalize(p)
}

// ── views over a resolved profile ───────────────────────────────────────────
pub fn policy(p: &Obj) -> Result<Policy, String> {
    Policy::from_profile(p)
}

pub fn classifier(p: &Obj) -> Result<Classifier, String> {
    Classifier::from_profile(p)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn obj(v: Value) -> Obj {
        v.as_object().cloned().unwrap()
    }

    #[test]
    fn extends_merges_tables_prepends_map_replaces_rules_by_id() {
        let base = obj(json!({"kind": "generic", "layers": {"a": {"ring": 0}}, "map": [{"glob": "base"}],
                              "rules": [{"id": "r1", "severity": "major"}, {"id": "r2"}]}));
        let over = obj(json!({"layers": {"b": {"ring": 1}}, "map": [{"glob": "mine"}],
                              "rules": [{"id": "r1", "severity": "ok"}, {"id": "r3"}]}));
        let m = merge_profile(&base, &over);
        assert!(!m.contains_key("kind"));
        let layers: Vec<&String> = m["layers"].as_object().unwrap().keys().collect();
        assert_eq!(layers, vec!["a", "b"]);
        let globs: Vec<&str> = m["map"].as_array().unwrap().iter().map(|x| x["glob"].as_str().unwrap()).collect();
        assert_eq!(globs, vec!["mine", "base"]);
        let rules: Vec<(&str, Option<&str>)> =
            m["rules"].as_array().unwrap().iter().map(|r| (r["id"].as_str().unwrap(), r.get("severity").and_then(Value::as_str))).collect();
        assert_eq!(rules, vec![("r1", Some("ok")), ("r2", None), ("r3", None)]);
    }

    #[test]
    fn finalize_normalises_rule_lists() {
        let p = finalize(obj(json!({"name": "x", "root": "/tmp", "rules": [{"id": "r", "from_tier": "app", "to_layer": ["a", "b"]}]}))).unwrap();
        let r = &p["rules"][0];
        assert_eq!(r["from_tier"], json!(["app"]));
        assert_eq!(r["to_layer"], json!(["a", "b"]));
        assert!(r["from_ctx"].is_null());
        assert_eq!(p["title"], json!("X"));
    }

    #[test]
    fn builtin_rules_parse_and_day2_alias() {
        for n in builtin_names() {
            parse_toml(builtin(n).unwrap(), n).unwrap();
        }
        assert!(builtin("day2").is_some());
        assert!(load_pack("nope", Path::new(".")).is_err());
    }

    #[test]
    fn extends_lists_merge_left_to_right_and_nest() {
        let d = std::env::temp_dir().join(format!("sprawler-packs-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("a.toml"), "x = 1\n[layers.core]\nring = 0\n[[rules]]\nid = \"r\"\nmessage = \"a\"\n").unwrap();
        std::fs::write(d.join("b.toml"), "extends = \"a\"\nx = 2\n[layers.port]\nring = 1\n").unwrap();
        std::fs::write(d.join("c.toml"), "[[rules]]\nid = \"r\"\nmessage = \"c\"\n").unwrap();
        let p = resolve_bases(&json!(["b", "c"]), &d, 0).unwrap();
        assert_eq!(p["x"], json!(2));
        assert!(p["layers"].get("core").is_some() && p["layers"].get("port").is_some());
        assert_eq!(p["rules"][0]["message"], json!("c"));
        assert!(p.get("extends").is_none());
    }
}
