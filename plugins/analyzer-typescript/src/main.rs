mod lex;
use regex::Regex;
use serde_json::{json, Value};
use sprawler_analyzer_kit::{assemble, module, read_text, strings, Edges};
use std::collections::HashMap;
use std::path::Path;

fn jsonc(s: &str) -> String {
    let s = Regex::new(r#"(?m)//[^\n]*|/\*.*?\*/"#).unwrap().replace_all(s, " ").into_owned();
    Regex::new(r#",\s*([}\]])"#).unwrap().replace_all(&s, "$1").into_owned()
}
fn join(a: &str, b: &str) -> String {
    if a.is_empty() {
        b.into()
    } else {
        format!("{a}/{b}")
    }
}
fn resolve_path(root: &Path, from: &str, target: &str, known: &std::collections::HashSet<String>) -> Option<String> {
    let base = if target.starts_with('/') { target.trim_start_matches('/').to_owned() } else { join(from, target) };
    let mut c = vec![base.clone()];
    if let Some(ext) = Path::new(&base).extension().and_then(|x| x.to_str()) {
        if ext == "js" {
            c.push(format!("{}.ts", base.trim_end_matches(".js")));
        }
    } else {
        for e in ["ts", "tsx", "d.ts", "js", "jsx", "mjs", "cjs"] {
            c.push(format!("{base}.{e}"));
        }
    }
    for p in ["ts", "tsx", "d.ts", "js", "jsx", "mjs", "cjs"] {
        c.push(format!("{base}/index.{p}"));
    }
    c.into_iter().map(|p| sprawler_analyzer_kit::normalize(&p)).find(|p| known.contains(p) || root.join(p).is_file())
}
fn analyze(req: &Value) -> Result<Value, String> {
    let root = std::path::PathBuf::from(req["root"].as_str().ok_or("request has no root")?);
    let files = strings(req.get("files"));
    let code: Vec<String> =
        files.iter().filter(|f| [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"].iter().any(|e| f.ends_with(e))).cloned().collect();
    let known: std::collections::HashSet<String> = code.iter().cloned().collect();
    let mut modules = Vec::new();
    let mut edges = Edges::default();
    let mut ext = HashMap::new();
    let mut unresolved = 0u64;
    let mut imports = 0u64;
    let mut warnings = Vec::new();
    let import_re=Regex::new(r#"(?m)\b(?:import\s+(?:type\s+)?(?:[^;\n]*?\s+from\s+)?|export\s+(?:type\s+)?[^;\n]*?\s+from\s+|(?:import|require)\s*\()\s*['\"]([^'\"]+)['\"]|\bimport\s*['\"]([^'\"]+)['\"]"#).unwrap();
    let mut package_entries: HashMap<String, String> = HashMap::new();
    for f in &files {
        if f.ends_with("package.json") {
            if let Ok(v) = serde_json::from_str::<Value>(&jsonc(&read_text(&root.join(f)))) {
                if let Some(n) = v["name"].as_str() {
                    let entry = ["types", "module", "main"].iter().find_map(|k| v[k].as_str()).unwrap_or("src/index.ts");
                    if let Some(p) = resolve_path(&root, Path::new(f).parent().unwrap_or(Path::new(".")).to_str().unwrap_or(""), entry, &known) {
                        package_entries.insert(n.into(), p);
                    }
                }
            }
        }
    }
    let mut aliases = Vec::<(String, String, String)>::new();
    for f in &files {
        if ["tsconfig.json", "jsconfig.json"].iter().any(|x| f.ends_with(x)) {
            if let Ok(v) = serde_json::from_str::<Value>(&jsonc(&read_text(&root.join(f)))) {
                let dir = Path::new(f).parent().unwrap_or(Path::new(".")).to_string_lossy().to_string();
                let base = v.pointer("/compilerOptions/baseUrl").and_then(Value::as_str).unwrap_or("");
                let b = join(&dir, base);
                if let Some(paths) = v.pointer("/compilerOptions/paths").and_then(Value::as_object) {
                    for (k, vs) in paths {
                        if let Some(t) = vs.as_array().and_then(|x| x.first()).and_then(Value::as_str) {
                            aliases.push((k.clone(), b.clone(), t.into()));
                        }
                    }
                }
            }
        }
    }
    for f in &code {
        let text = read_text(&root.join(f));
        modules.push(module(f, "ts", &text));
        let clean = lex::strip_comments(&text);
        for c in import_re.captures_iter(&clean) {
            let spec = c.get(1).or_else(|| c.get(2)).unwrap().as_str();
            imports += 1;
            let ln = sprawler_analyzer_kit::line(&clean, c.get(0).unwrap().start());
            let mut found = None;
            if spec.starts_with('.') || spec.starts_with('/') {
                found = resolve_path(&root, Path::new(f).parent().unwrap_or(Path::new(".")).to_str().unwrap_or(""), spec, &known);
            } else {
                for (pattern, base, target) in &aliases {
                    if let Some((pre, suf)) = pattern.split_once('*') {
                        if spec.starts_with(pre) && spec.ends_with(suf) {
                            let middle = &spec[pre.len()..spec.len() - suf.len()];
                            let t = target.replace('*', middle);
                            found = resolve_path(&root, base, &t, &known);
                            if found.is_some() {
                                break;
                            }
                        }
                    } else if pattern == spec {
                        found = resolve_path(&root, base, target, &known);
                        if found.is_some() {
                            break;
                        }
                    }
                }
                if found.is_none() {
                    found = package_entries.get(spec).cloned();
                    if found.is_none() {
                        let package = spec.split('/').take(if spec.starts_with('@') { 2 } else { 1 }).collect::<Vec<_>>().join("/");
                        found = package_entries.get(&package).cloned();
                    }
                }
            }
            if let Some(t) = found {
                if known.contains(&t) {
                    edges.add(f, &t, "imports", ln)
                } else {
                    unresolved += 1;
                }
            } else if !spec.starts_with('.') && !spec.starts_with('/') {
                *ext.entry(spec.to_owned()).or_insert(0) += 1;
            } else {
                unresolved += 1;
            }
        }
    }
    if !aliases.is_empty() {
        warnings.push(format!("{} tsconfig/jsconfig path mapping(s) considered; extends is not followed", aliases.len()));
    }
    Ok(assemble("typescript", "ts", modules, edges, unresolved, ext, warnings, json!({"imports":imports,"resolved":imports.saturating_sub(unresolved)})))
}
fn main() -> std::process::ExitCode {
    let d = sprawler_analyzer_kit::describe(
        "typescript",
        "typescript",
        &[".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
        &["package.json", "tsconfig.json", "jsconfig.json"],
    );
    sprawler_analyzer_kit::run("typescript", d, analyze)
}
