//! Fix prompts (adapter): turn each finding into a self-contained, agent-ready fix prompt.
use std::collections::HashMap;
use std::path::Path;

use serde_json::{json, Value};

use crate::ports::{Obj, Workspace};

const HINTS: &[(&str, &str)] = &[
    ("context-bleed", "Bounded contexts must not import each other. Communicate through a published contract or an explicit integration event, or move the shared concept into a shared kernel on purpose."),
    ("tier-breach", "This tier must not depend on the target tier. Invert the dependency: the inner tier defines the interface it needs and the outer tier implements it."),
    ("layer-breach", "This dependency points outward. Invert it: the inner layer defines the port it needs, the outer layer implements it, and the composition root wires them."),
    ("prod-imports-test", "Production code must not import test modules. Move the shared helper into production code or keep it inside the test."),
    ("undeclared-coupling", "Declare the dependency in the build (Cargo.toml, ProjectReference, …) if it is intended, or remove the reference if it isn't."),
    ("seam-unhandled", "The SDK emits a protocol kind the host never decodes, so it fails at runtime. Either add the handler arm on the host side (and its validation), or stop emitting the kind in the SDK."),
    ("seam-dead-handler", "The host decodes a protocol kind no SDK code emits. Confirm nothing builds it dynamically (search for the string and for kind-building helpers); if nothing does, remove the arm, otherwise add a typed SDK constructor so the seam is explicit."),
];

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}

/// Numbered source lines around `line` (`>>` marks it); the first 20 lines when there is no line.
pub fn snippet(ws: &dyn Workspace, root: &Path, rel: Option<&str>, line: Option<u64>, radius: u64) -> String {
    let Some(rel) = rel.filter(|r| !r.is_empty()) else { return String::new() };
    let full = root.join(rel);
    if !full.is_file() {
        return String::new();
    }
    let text = ws.read_text(&full);
    let lines: Vec<&str> = text.lines().collect();
    let n = lines.len() as u64;
    let (lo, hi) = match line {
        Some(l) if l >= 1 && l <= n => (l.saturating_sub(radius).max(1), (l + radius).min(n)),
        _ => (1, n.min(20)),
    };
    (lo..=hi).map(|i| format!("{}{i:5} | {}", if Some(i) == line { ">>" } else { "  " }, lines[(i - 1) as usize])).collect::<Vec<_>>().join("\n")
}

fn lang(rel: Option<&str>) -> &'static str {
    match rel.unwrap_or("").rsplit('.').next().unwrap_or("") {
        "rs" => "rust",
        "roc" => "roc",
        "json" => "json",
        "py" => "python",
        "ts" => "ts",
        _ => "",
    }
}

pub fn attach_prompts(p: &Obj, ws: &dyn Workspace, atlas: &mut Value) {
    let root = p.get("root").and_then(Value::as_str).unwrap_or("").to_string();
    let rootp = Path::new(&root).to_path_buf();
    let mods: HashMap<String, Value> = atlas["modules"].as_array().into_iter().flatten().map(|m| (s(m, "id").to_string(), m.clone())).collect();
    let ctxs: HashMap<String, Value> = atlas["contexts"].as_array().into_iter().flatten().map(|c| (s(c, "key").to_string(), c.clone())).collect();
    let rules: HashMap<&str, &Value> = p.get("rules").and_then(Value::as_array).into_iter().flatten().map(|r| (s(r, "id"), r)).collect();
    let tiers: HashMap<&str, &Value> = p.get("tiers").and_then(Value::as_array).into_iter().flatten().map(|t| (s(t, "id"), t)).collect();
    let empty = json!({});
    let layers = p.get("layers").unwrap_or(&empty);
    let allow = p.get("allow").unwrap_or(&empty);
    let verify = match p.get("_cli").and_then(Value::as_str).filter(|x| !x.is_empty()) {
        Some(c) => c.to_string(),
        None => format!("sprawler report --profile {}", p.get("_path").and_then(Value::as_str).unwrap_or("profiles/<name>.toml")),
    };
    let label = |m: &Value| layers.get(s(m, "layer")).and_then(|l| l.get("label")).and_then(Value::as_str).unwrap_or(s(m, "layer")).to_string();
    let clabel = |m: &Value| ctxs.get(s(m, "ctx")).and_then(|c| c.get("label")).and_then(Value::as_str).unwrap_or(s(m, "ctx")).to_string();

    let Some(vs) = atlas["violations"].as_array_mut() else { return };
    for v in vs.iter_mut() {
        let (Some(a), Some(b)) = (mods.get(s(v, "source")), mods.get(s(v, "target"))) else { continue };
        let line = v.get("line").and_then(Value::as_u64);
        let a_path = a.get("path").and_then(Value::as_str);
        let snip = snippet(ws, &rootp, a_path, line, 4);
        v["snippet"] = json!(snip);
        let allowed: Vec<String> = allow
            .get(s(a, "layer"))
            .and_then(Value::as_array)
            .map(|l| l.iter().filter_map(Value::as_str).map(str::to_string).collect())
            .unwrap_or_else(|| vec!["*".into()]);
        let tier = tiers.get(s(a, "tier"));
        let depends: Vec<String> =
            tier.and_then(|t| t.get("depends")).and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(|x| format!("`{x}`")).collect();
        let cross = tier.and_then(|t| t.get("cross")).and_then(Value::as_str).unwrap_or("allow");
        let rule = s(v, "rule").to_string();
        let why =
            rules.get(rule.as_str()).and_then(|r| r.get("message")).and_then(Value::as_str).filter(|m| !m.is_empty()).unwrap_or(s(v, "message")).to_string();
        let where_ = match line.filter(|l| *l != 0) {
            Some(l) => format!("{}:{l}", a_path.unwrap_or("None")),
            None => a_path.filter(|x| !x.is_empty()).unwrap_or(s(a, "id")).to_string(),
        };
        let target = b
            .get("path")
            .and_then(Value::as_str)
            .filter(|x| !x.is_empty())
            .map_or_else(|| format!("{} (platform-generated handle, not on disk)", s(b, "id")), str::to_string);
        let seam = v.get("seam").and_then(Value::as_bool).unwrap_or(false);
        let (aid, bid) = (s(a, "id"), s(b, "id"));
        let mut lines: Vec<String> = vec![
            format!("# Fix architecture finding: `{rule}` ({})", s(v, "severity")),
            String::new(),
            format!("Repository root: `{root}`"),
            String::new(),
            "## What is wrong".into(),
            format!(
                "`{aid}` ({} in {}, tier `{}`) {} `{bid}` ({} in {}, tier `{}`).",
                label(a),
                clabel(a),
                s(a, "tier"),
                if seam { "is out of sync with" } else { "depends on" },
                label(b),
                clabel(b),
                s(b, "tier"),
            ),
            String::new(),
            format!("Rule: {why}"),
            String::new(),
            "## Where".into(),
            format!("- Dependency declared at: `{where_}`"),
            format!("- Target: `{target}`"),
            String::new(),
        ];
        if !snip.is_empty() {
            lines.extend([format!("```{}", lang(a_path)), snip.clone(), "```".into(), String::new()]);
        }
        if seam {
            lines.extend([
                "## Contract seam".into(),
                format!(
                    "This is a protocol boundary, not an import: the SDK emits `kind` strings and the host matches on them. Kind in question: `{}`. Check both sides — the emitter in `{aid}` or `{bid}` and the handler arms — and keep them in sync.",
                    v.get("kind").and_then(Value::as_str).unwrap_or("None"),
                ),
                String::new(),
            ]);
        }
        let pack_fix = rules.get(rule.as_str()).and_then(|r| r.get("fix")).and_then(Value::as_str);
        let hint =
            pack_fix.or_else(|| HINTS.iter().find(|(k, _)| *k == rule).map(|(_, h)| *h)).unwrap_or("Remove or invert this dependency so it points inward.");
        lines.extend([
            "## Architecture constraints".into(),
            format!("- A `{}` module may depend on: {}.", s(a, "layer"), allowed.iter().map(|x| format!("`{x}`")).collect::<Vec<_>>().join(", ")),
            format!(
                "- Tier `{}` may depend on tiers: {}; cross-context policy: `{cross}`.",
                s(a, "tier"),
                if depends.is_empty() { "none outside itself".to_string() } else { depends.join(", ") },
            ),
            String::new(),
            "## Suggested direction".into(),
            hint.to_string(),
            String::new(),
            "## Rules for the fix".into(),
            "- Preserve behaviour; keep the change as small as possible.".into(),
            "- Do not game the checker (renaming or moving files just to change their classification, suppressing the rule).".into(),
            "- If the dependency is actually correct, say so and explain why instead of changing code.".into(),
            "- Run the project's normal tests/checks for the files you touch.".into(),
            String::new(),
            "## Done when".into(),
            format!("Running `{verify}` no longer lists `{rule}` for `{aid}` → `{bid}`, and no new findings appear."),
        ]);
        if seam {
            // import-layer rules don't apply to a protocol boundary
            let i = lines.iter().position(|l| l == "## Architecture constraints");
            let j = lines.iter().position(|l| l == "## Suggested direction");
            if let (Some(i), Some(j)) = (i, j) {
                lines.drain(i..j);
            }
        }
        v["prompt"] = json!(lines.join("\n"));
    }
}
