use regex::Regex;
use serde_json::{json, Value};
use sprawler_analyzer_kit::{assemble, module, read_text, strings, Edges};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
fn strip_comments(s: &str) -> String {
    let mut out = String::new();
    let mut quote = None;
    let mut esc = false;
    let mut comment = false;
    for ch in s.chars() {
        if comment {
            if ch == '\n' {
                comment = false;
                out.push(ch)
            } else {
                out.push(' ')
            }
        } else if let Some(q) = quote {
            out.push(ch);
            if esc {
                esc = false
            } else if ch == '\\' {
                esc = true
            } else if ch == q {
                quote = None
            }
        } else if ch == '#' {
            comment = true;
            out.push(' ')
        } else {
            if ch == '\'' || ch == '"' {
                quote = Some(ch)
            }
            out.push(ch)
        }
    }
    out
}
fn resolve(root: &Path, base: &Path, name: &str, known: &HashSet<String>) -> Option<String> {
    let mut c = vec![];
    for r in [root.to_path_buf(), root.join("src"), root.join(base)] {
        let p = r.join(name.replace('.', "/"));
        let Ok(rel) = p.strip_prefix(root) else {
            continue;
        };
        let rel = rel.to_string_lossy().replace('\\', "/");
        let rel = sprawler_analyzer_kit::normalize(&rel);
        c.push(format!("{rel}.py"));
        c.push(format!("{rel}.pyi"));
        c.push(format!("{rel}/__init__.py"));
        c.push(format!("{rel}/__init__.pyi"));
        if known.contains(&rel) {
            c.push(rel)
        }
    }
    c.into_iter().find(|x| known.contains(x))
}
fn analyze(req: &Value) -> Result<Value, String> {
    let root = PathBuf::from(req["root"].as_str().ok_or("request has no root")?);
    let files = strings(req.get("files"));
    let code: Vec<String> = files.iter().filter(|f| f.ends_with(".py") || f.ends_with(".pyi")).cloned().collect();
    let known: HashSet<String> = code.iter().cloned().collect();
    let mut modules = Vec::new();
    let mut edges = Edges::default();
    let mut ext = HashMap::new();
    let (mut unresolved, mut imports) = (0u64, 0u64);
    let mut warnings=vec!["Python roots use repository root, src/, setup/pyproject directories, and scanned package parents (directories with __init__.py); namespace packages resolve when their target file is scanned.".into()];
    let re = Regex::new(r"(?m)^\s*(?:from\s+([.\w]+)\s+import\s+([\w*,\s()]+)|import\s+([\w.,\s]+))").unwrap();
    for f in &code {
        let text = read_text(&root.join(f));
        modules.push(module(f, "python", &text));
        let clean = strip_comments(&text);
        for c in re.captures_iter(&clean) {
            let line = sprawler_analyzer_kit::line(&clean, c.get(0).unwrap().start());
            let current = Path::new(f).parent().unwrap_or(Path::new("."));
            if let Some(from) = c.get(1) {
                let name = from.as_str();
                let targets = c.get(2).unwrap().as_str().replace(['(', ')', '\n'], " ");
                let mut resolved = None;
                if name.starts_with('.') {
                    let dots = name.chars().take_while(|x| *x == '.').count();
                    let suffix = name[dots..].trim_matches('.');
                    let mut b = current.to_path_buf();
                    for _ in 1..dots {
                        b.pop();
                    }
                    if !suffix.is_empty() {
                        resolved = resolve(&root, &b, suffix, &known);
                    }
                    if resolved.is_none() {
                        resolved = resolve(
                            &root,
                            &b,
                            &if suffix.is_empty() {
                                targets.split(',').next().unwrap_or("").trim().split(" as ").next().unwrap_or("").trim().to_owned()
                            } else {
                                format!("{suffix}.{}", targets.split(',').next().unwrap_or("").trim().split(" as ").next().unwrap_or("").trim())
                            },
                            &known,
                        );
                    }
                } else {
                    resolved = resolve(&root, current, name, &known);
                    if resolved.is_none() {
                        for part in targets.split(',').map(str::trim).filter(|x| !x.is_empty()) {
                            if let Some(p) = resolve(&root, current, &format!("{name}.{part}"), &known) {
                                resolved = Some(p);
                                break;
                            }
                        }
                        if resolved.is_none() {
                            resolved = resolve(&root, current, name, &known);
                        }
                    }
                    if resolved.is_none() {
                        *ext.entry(name.to_owned()).or_insert(0) += 1;
                    }
                }
                imports += 1;
                if let Some(t) = resolved {
                    edges.add(f, &t, "imports", line)
                } else if name.starts_with('.') || !ext.contains_key(name) {
                    unresolved += 1;
                }
            } else if let Some(raw) = c.get(3) {
                for item in raw.as_str().split(',').map(str::trim).filter(|x| !x.is_empty()) {
                    let name = item.split_whitespace().next().unwrap_or(item);
                    imports += 1;
                    if let Some(t) = resolve(&root, current, name, &known) {
                        edges.add(f, &t, "imports", line)
                    } else if known.iter().any(|k| k.starts_with(&format!("{}/", name.replace('.', "/")))) {
                        unresolved += 1
                    } else {
                        *ext.entry(name.into()).or_insert(0) += 1;
                    }
                }
            }
        }
    }
    if files.iter().any(|f| f.ends_with("pyproject.toml") || f.ends_with("setup.cfg") || f.ends_with("setup.py")) {
        warnings.push("project configuration markers found; source roots inferred heuristically".into());
    }
    Ok(assemble("python", "python", modules, edges, unresolved, ext, warnings, json!({"imports":imports,"resolved":imports.saturating_sub(unresolved)})))
}
fn main() -> std::process::ExitCode {
    let d = sprawler_analyzer_kit::describe("python", "python", &[".py", ".pyi"], &["pyproject.toml", "setup.cfg", "setup.py"]);
    sprawler_analyzer_kit::run("python", d, analyze)
}
