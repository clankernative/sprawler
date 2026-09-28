use regex::Regex;
use serde_json::{json, Value};
use sprawler_analyzer_kit::{assemble, module, read_text, strings, Edges};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
fn clean(s: &str) -> String {
    Regex::new(r"(?s)/\*.*?\*/|//[^\n]*").unwrap().replace_all(s, " ").into_owned()
}
/// Top-level names a Go file declares: `func F`, methods' names, `type T`, `var V`, `const C`, and
/// every name inside grouped `var ( … )` / `const ( … )` / `type ( … )` blocks.
fn declared(src: &str) -> HashSet<String> {
    let single = Regex::new(r"^(?:func\s+(?:\([^)]*\)\s*)?|type\s+|var\s+|const\s+)([A-Za-z_]\w*)").unwrap();
    let group = Regex::new(r"^(?:var|const|type)\s*\($").unwrap();
    let names = Regex::new(r"^([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)").unwrap();
    let mut out = HashSet::new();
    let mut in_group = false;
    for line in src.lines() {
        let t = line.trim();
        if in_group {
            if t.starts_with(')') {
                in_group = false;
            } else if line.starts_with(|c: char| c.is_whitespace()) || !t.is_empty() {
                if let Some(c) = names.captures(t) {
                    out.extend(c[1].split(',').map(|n| n.trim().to_string()));
                }
            }
            continue;
        }
        if line.starts_with(char::is_whitespace) {
            continue; // not top level
        }
        if group.is_match(t) {
            in_group = true;
        } else if let Some(c) = single.captures(t) {
            out.insert(c[1].to_string());
            // `var a, b = …`
            if let Some(rest) = t.split_once(&c[1]).map(|x| x.1) {
                for n in rest.split('=').next().unwrap_or("").split(',').skip(1) {
                    if let Some(first) = n.split_whitespace().next() {
                        if first.chars().all(|ch| ch.is_alphanumeric() || ch == '_') && !first.is_empty() {
                            out.insert(first.to_string());
                        }
                    }
                }
            }
        }
    }
    out
}

fn analyze(req: &Value) -> Result<Value, String> {
    let root = PathBuf::from(req["root"].as_str().ok_or("request has no root")?);
    let files = strings(req.get("files"));
    let code: Vec<String> = files.iter().filter(|f| f.ends_with(".go")).cloned().collect();
    let mut edges = Edges::default();
    let mut ext = HashMap::new();
    let (mut unresolved, mut imports) = (0u64, 0u64);
    let mut warnings = Vec::new();
    // every go.mod in the scan: (module path, directory). A repo can hold several modules
    // (root + nested tools/ui modules); an import resolves against the longest matching path.
    let module_re = Regex::new(r"(?m)^\s*module\s+([^\s]+)").unwrap();
    let mut mods: Vec<(String, String)> = Vec::new();
    for f in files.iter().filter(|f| f.rsplit('/').next() == Some("go.mod")) {
        let dir = Path::new(f).parent().unwrap_or(Path::new("")).to_string_lossy().to_string();
        let t = read_text(&root.join(f));
        if let Some(c) = module_re.captures(&t) {
            mods.push((c[1].trim_matches('"').to_string(), dir));
        }
    }
    mods.sort_by(|a, b| b.0.len().cmp(&a.0.len()).then_with(|| a.0.cmp(&b.0)));
    if mods.is_empty() && !code.is_empty() {
        warnings.push("no go.mod in the scan; module imports cannot be resolved".into());
    }
    let selectors = Regex::new(r"\b([A-Za-z_]\w*)\.([A-Za-z_]\w*)").unwrap();
    let quoted = Regex::new(r#"(?:(\w+)\s+)?"([^"\s]+)""#).unwrap();
    let mut pkg_dirs: HashMap<String, Vec<String>> = HashMap::new();
    for f in &code {
        if f.ends_with("_test.go") {
            continue;
        }
        pkg_dirs.entry(Path::new(f).parent().unwrap_or(Path::new(".")).to_string_lossy().into()).or_default().push(f.clone());
    }
    let decls: HashMap<&str, HashSet<String>> = pkg_dirs.values().flatten().map(|t| (t.as_str(), declared(&clean(&read_text(&root.join(t)))))).collect();
    let mut modules = Vec::new();
    for f in &code {
        let text = read_text(&root.join(f));
        modules.push(module(f, "go", &text));
        if f.ends_with("_test.go") {
            continue;
        }
        let src = clean(&text);
        let mut import_specs: Vec<(String, String, u64)> = Vec::new();
        let mut in_group = false;
        for (idx, raw) in src.lines().enumerate() {
            let trimmed = raw.trim();
            if trimmed == "import (" || trimmed == "import(" {
                in_group = true;
                continue;
            }
            if in_group && trimmed.starts_with(')') {
                in_group = false;
                continue;
            }
            if in_group || trimmed.starts_with("import ") {
                if let Some(cap) = quoted.captures(trimmed.strip_prefix("import").map_or(trimmed, str::trim_start)) {
                    let path = cap[2].to_owned();
                    let alias = cap.get(1).map_or_else(|| path.rsplit('/').next().unwrap_or(&path).to_owned(), |m| m.as_str().to_owned());
                    import_specs.push((path, alias, idx as u64 + 1));
                }
            }
        }
        for (imp, alias, imp_line) in import_specs {
            imports += 1;
            let target_dir = mods.iter().find(|(mp, _)| imp == *mp || imp.starts_with(&format!("{mp}/"))).map(|(mp, moddir)| {
                let suffix = imp.strip_prefix(mp.as_str()).unwrap_or("").trim_start_matches('/');
                match (moddir.is_empty(), suffix.is_empty()) {
                    (true, _) => suffix.to_owned(),
                    (false, true) => moddir.clone(),
                    (false, false) => format!("{moddir}/{suffix}"),
                }
            });
            if let Some(d) = target_dir {
                if let Some(targets) = pkg_dirs.get(&d) {
                    let mut used = HashSet::new();
                    for s in selectors.captures_iter(&src) {
                        if s[1] == alias {
                            used.insert(s[2].to_owned());
                        }
                    }
                    let mut matches = Vec::new();
                    for t in targets {
                        if decls.get(t.as_str()).is_some_and(|d| d.iter().any(|n| used.contains(n))) {
                            matches.push(t.clone());
                        }
                    }
                    if matches.is_empty() {
                        warnings.push(format!("{f}: import {imp} had no matching imported identifiers; linked to all {} package files", targets.len()));
                        for t in targets {
                            edges.add(f, t, "imports", imp_line);
                        }
                    } else {
                        for t in matches {
                            edges.add(f, &t, "imports", imp_line);
                        }
                    }
                } else {
                    unresolved += 1;
                    warnings.push(format!("{f}: module package {imp} is not among scanned files"));
                }
            } else {
                *ext.entry(imp).or_insert(0) += 1;
            }
        }
    }
    // go.work use directives are informational; each scanned go.mod still defines its module prefix.
    if files.iter().any(|f| f.ends_with("go.work")) {
        warnings.push("go.work workspace paths are not used to map module imports; go.mod module roots are used".into());
    }
    Ok(assemble("go", "go", modules, edges, unresolved, ext, warnings, json!({"imports":imports,"resolved":imports.saturating_sub(unresolved)})))
}
fn main() -> std::process::ExitCode {
    let d = sprawler_analyzer_kit::describe("go", "go", &[".go"], &["go.mod", "go.work"]);
    sprawler_analyzer_kit::run("go", d, analyze)
}

#[cfg(test)]
mod tests {
    use super::declared;

    #[test]
    fn grouped_and_single_declarations() {
        let d = declared("package x\n\nvar (\n\tVersion   = \"dev\"\n\tCommit, Date = \"a\", \"b\"\n)\n\nconst Max = 3\nvar a, b = 1, 2\ntype (\n\tA struct{}\n\tB = A\n)\nfunc (s *S) Run() {}\nfunc New() *S {\n\tlocal := 1\n}\n");
        for n in ["Version", "Commit", "Date", "Max", "a", "b", "A", "B", "Run", "New"] {
            assert!(d.contains(n), "missing {n}: {d:?}");
        }
        assert!(!d.contains("local"));
    }
}
