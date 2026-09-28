//! Command line (driving adapter). Every command that reports something takes `--json`, and exit
//! codes are stable: 0 ok · 1 check failed / nothing matched · 2 usage or setup error.
use std::collections::{BTreeSet, HashSet};
use std::path::Path;
use std::process::{Command, ExitCode};

use clap::{Args, Parser, Subcommand};
use serde_json::{json, Value};

use crate::{atlas, discover, local, plugins, profile, serve};

#[derive(Parser)]
#[command(
    name = "sprawler",
    version,
    about = "See how your whole codebase connects: a 3D architecture map and rule checker.",
    after_help = "Exit codes: 0 ok · 1 check failed or nothing matched · 2 usage or setup error.\nStart: `sprawler check DIR` (works with no profile) · agents: see AGENTS.md"
)]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Args, Clone)]
struct Target {
    /// Workspace folder (default: current folder)
    #[arg(default_value = ".")]
    dir: String,
    /// A full profile file (overrides discovery)
    #[arg(long, short)]
    profile: Option<String>,
}

#[derive(Subcommand)]
enum Cmd {
    /// Scan and write the atlas JSON (schema sprawler.atlas/1)
    Scan {
        #[command(flatten)]
        t: Target,
        #[arg(long, short, default_value = "atlas.json")]
        out: String,
    },
    /// Summary: score, contexts, seams, warnings
    Report {
        #[command(flatten)]
        t: Target,
        #[arg(long)]
        json: bool,
    },
    /// CI / agent gate: exit 1 on findings at or above --fail-on (default major), a score below --min-score, or unhandled seams
    Check {
        #[command(flatten)]
        t: Target,
        /// Fail on findings at or above this severity; `none` never fails on findings
        #[arg(long, default_value = "major", value_parser = ["minor", "major", "critical", "none"])]
        fail_on: String,
        /// Also fail below this score, or when the grade is withheld (too little evidence)
        #[arg(long)]
        min_score: Option<f64>,
        /// Only findings not in this baseline (from `sprawler baseline`) count toward --fail-on
        #[arg(long)]
        baseline: Option<String>,
        #[arg(long)]
        json: bool,
        /// Output: text (default), json, or github (annotations on the PR diff + a job summary, then text)
        #[arg(long, value_parser = ["text", "json", "github"])]
        format: Option<String>,
    },
    /// Write a README badge: shields.io endpoint JSON (default) or a standalone SVG
    Badge {
        #[command(flatten)]
        t: Target,
        /// Where to write it (default: stdout)
        #[arg(long, short)]
        out: Option<String>,
        /// Write an SVG instead of shields.io endpoint JSON
        #[arg(long)]
        svg: bool,
    },
    /// Record today's findings, so `check --baseline FILE` fails only on new ones
    Baseline {
        #[command(flatten)]
        t: Target,
        /// Where to write it (default: DIR/sprawler-baseline.json)
        #[arg(long, short)]
        out: Option<String>,
    },
    /// Agent-ready fix prompts, one per finding
    Prompts {
        #[command(flatten)]
        t: Target,
        #[arg(long)]
        rule: Option<String>,
        /// Only finding N (0-based, as listed by `check --json`)
        #[arg(long)]
        index: Option<usize>,
    },
    /// Scan, open the 3D map at http://127.0.0.1:PORT, and rescan when files change
    Serve {
        #[command(flatten)]
        t: Target,
        #[arg(long, default_value_t = 8766)]
        port: u16,
        #[arg(long)]
        no_watch: bool,
    },
    /// Show what auto-discovery finds in a folder (platform, apps, instances, tests, .NET projects)
    Discover {
        #[arg(default_value = ".")]
        dir: String,
        #[arg(long)]
        json: bool,
    },
    /// Propose a workspace config from discovery; `--yes` saves it (safe to re-run)
    Setup {
        #[arg(default_value = ".")]
        dir: String,
        /// Write it (default: dry run, print the proposal)
        #[arg(long, short)]
        yes: bool,
        /// Save as DIR/sprawler.workspace.toml (shared with the team) instead of a personal config
        #[arg(long)]
        shared: bool,
        #[arg(long)]
        json: bool,
    },
    /// Which analyzer plugins and tools are available here, and how to fix what is missing
    Doctor {
        #[arg(long)]
        json: bool,
    },
    /// Profiles (the TOML policy)
    Profile {
        #[command(subcommand)]
        cmd: ProfileCmd,
    },
    /// Analyzer plugins
    Plugin {
        #[command(subcommand)]
        cmd: PluginCmd,
    },
    /// Rules packs (architecture and platform policy a profile `extends`)
    Pack {
        #[command(subcommand)]
        cmd: PackCmd,
    },
}

#[derive(Subcommand)]
enum PackCmd {
    /// Installed, built-in, and available packs
    List {
        #[arg(long)]
        json: bool,
    },
    /// Install packs by name (from a Sprawler checkout's packs/) or by path to a .toml file or pack folder
    Add {
        #[arg(required = true)]
        names: Vec<String>,
        /// The Sprawler source checkout (default: found from the current folder or the binary)
        #[arg(long)]
        from: Option<String>,
    },
    /// Remove installed packs
    Remove {
        #[arg(required = true)]
        names: Vec<String>,
    },
}

#[derive(Subcommand)]
enum PluginCmd {
    /// Installed analyzer plugins and the files they claim
    List {
        #[arg(long)]
        json: bool,
    },
    /// Build and install first-party analyzer plugins from a Sprawler checkout (roc, rust, csharp)
    Add {
        #[arg(required = true)]
        names: Vec<String>,
        /// The Sprawler source checkout (default: found from the current folder or the binary)
        #[arg(long)]
        from: Option<String>,
    },
    /// Remove installed plugins
    Remove {
        #[arg(required = true)]
        names: Vec<String>,
    },
    /// Conformance check for a plugin executable: describe, analyze a folder twice, validate the output
    Test {
        /// Path to a sprawler-analyzer-<name> executable
        exe: String,
        /// Folder to analyze (default: current folder)
        #[arg(long, default_value = ".")]
        dir: String,
        #[arg(long)]
        json: bool,
    },
}

#[derive(Subcommand)]
enum ProfileCmd {
    /// Check a profile before scanning: tiers, layers, rules, map entries, allow lists
    Validate {
        #[command(flatten)]
        t: Target,
        #[arg(long)]
        json: bool,
    },
    /// Write a starting sprawler.toml: architecture packs, extensions from installed plugins, one [[map]] entry per folder
    Init {
        /// Workspace folder (default: current folder)
        #[arg(default_value = ".")]
        dir: String,
        /// Architecture pack to extend
        #[arg(long, default_value = "ddd-hexagonal")]
        architecture: String,
        /// Add-on packs, e.g. --add cqrs --add vertical-slices
        #[arg(long)]
        add: Vec<String>,
        /// Overwrite an existing sprawler.toml
        #[arg(long)]
        force: bool,
    },
    /// Why files land where they do: which [[map]] entry placed a file, and which entries place the most
    Explain {
        #[command(flatten)]
        t: Target,
        /// Explain one file (path relative to the workspace root)
        #[arg(long)]
        file: Option<String>,
        #[arg(long)]
        json: bool,
    },
}

/// `--profile FILE`, else `DIR/sprawler.toml`, else a saved workspace config (personal, then
/// `DIR/sprawler.workspace.toml`), else auto-discovery.
pub fn resolve_dir(dir: &str, profile_file: Option<&str>) -> Result<profile::Obj, String> {
    if let Some(f) = profile_file {
        return profile::load_profile(Path::new(f), None);
    }
    let root = profile::resolve_path(dir);
    let own = root.join("sprawler.toml");
    if own.is_file() {
        return profile::load_profile(&own, None);
    }
    match profile::find_config(&root) {
        Some(cfg) => profile::build_profile(&profile::load_config(&cfg)?),
        None => discover::auto_profile(&root),
    }
}

/// Like `resolve`, but a Clankernative workspace with no saved config starts `serve` in setup mode
/// (`None`) so the first-run screen can confirm what to scan. `.NET` folders still auto-discover.
fn serve_target(t: &Target) -> Result<(Option<profile::Obj>, std::path::PathBuf), String> {
    let root = profile::resolve_path(&t.dir);
    if t.profile.is_some() || root.join("sprawler.toml").is_file() || profile::find_config(&root).is_some() {
        return resolve(t).map(|p| (Some(p), root));
    }
    let d = discover::discover(&root);
    if d["platform"].is_null() {
        // .NET projects or plugin defaults; with neither, the setup screen explains what is missing
        if let Ok(p) = discover::auto_profile(&root) {
            return Ok((Some(p), root));
        }
    }
    Ok((None, root))
}

fn resolve(t: &Target) -> Result<profile::Obj, String> {
    resolve_dir(&t.dir, t.profile.as_deref())
}

fn sev_rank(s: &str) -> u8 {
    match s {
        "critical" => 3,
        "major" => 2,
        "minor" => 1,
        _ => 0,
    }
}

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}

fn pct(v: &Value) -> i64 {
    (v.as_f64().unwrap_or(0.0) * 100.0).round() as i64
}

fn grade(sc: &Value) -> &str {
    if sc["withheld"].as_bool().unwrap_or(false) {
        "?"
    } else {
        s(sc, "grade")
    }
}

/// Findings per severity, from the final list (seams add findings after scoring).
fn by_severity(vs: &[Value]) -> Value {
    let mut m = serde_json::Map::new();
    for sev in ["critical", "major", "minor"] {
        let n = vs.iter().filter(|v| s(v, "severity") == sev).count();
        if n > 0 {
            m.insert(sev.into(), json!(n));
        }
    }
    Value::Object(m)
}

fn gh_data(x: &str) -> String {
    x.replace('%', "%25").replace('\r', "%0D").replace('\n', "%0A")
}

fn gh_prop(x: &str) -> String {
    gh_data(x).replace(':', "%3A").replace(',', "%2C")
}

/// GitHub Actions: one annotation per finding (errors for major/critical, warnings for minor; only new
/// ones with a baseline) and a Markdown job summary in `$GITHUB_STEP_SUMMARY`.
fn github_output(a: &Value, vs: &[Value], is_new: &dyn Fn(&Value) -> bool, base: Option<(usize, usize)>, failures: &[String]) {
    // annotation paths are relative to the repository (GITHUB_WORKSPACE), module ids to the profile root
    let root = s(&a["project"], "root").to_string();
    let ws = std::env::var("GITHUB_WORKSPACE").ok().or_else(|| std::env::current_dir().ok().map(|d| d.to_string_lossy().into_owned())).unwrap_or_default();
    let ws = profile::resolve_path(&ws).to_string_lossy().into_owned();
    let prefix = root.strip_prefix(&ws).map(|r| r.trim_start_matches('/').to_string()).filter(|r| !r.is_empty()).map(|r| format!("{r}/")).unwrap_or_default();
    for v in vs.iter().filter(|v| is_new(v)) {
        let level = if sev_rank(s(v, "severity")) >= sev_rank("major") { "error" } else { "warning" };
        let file = format!("{prefix}{}", s(v, "source"));
        let line = v["line"].as_u64().map_or(String::new(), |l| format!(",line={l}"));
        let title = format!("sprawler {} ({})", s(v, "rule"), s(v, "severity"));
        let why = s(v, "why");
        let msg = format!("{} → {}{}", s(v, "message"), s(v, "target"), if why.is_empty() { String::new() } else { format!("\n{why}") });
        println!("::{level} file={}{line},title={}::{}", gh_prop(&file), gh_prop(&title), gh_data(&msg));
    }
    let Ok(path) = std::env::var("GITHUB_STEP_SUMMARY") else { return };
    let sc = &a["score"];
    let mut md = format!("## Sprawler · {} {} [{}]\n\n", s(sc, "label"), sc["total"], grade(sc));
    md += &format!("{} finding(s) {} · confidence {}%", vs.len(), by_severity(vs), pct(&sc["confidence"]));
    if let Some((new_n, fixed)) = base {
        md += &format!(" · **{new_n} new**, {} known, {fixed} fixed since the baseline", vs.len() - new_n);
    }
    md += "\n\n";
    md += &if failures.is_empty() { "✅ check passed\n\n".to_string() } else { failures.iter().map(|f| format!("❌ {f}\n")).collect::<String>() + "\n" };
    let inbox = sprawler_domain::inbox::build_inbox(a);
    if !inbox.is_empty() {
        md += "| | Count | What |\n|---|---:|---|\n";
        for i in inbox.iter().take(12) {
            md += &format!("| {} | {} | {} |\n", s(i, "kind").to_uppercase(), i["count"].as_u64().unwrap_or(0), s(i, "title").replace('|', "\\|"));
        }
        md += "\n";
    }
    md += "Run `sprawler prompts . --rule <rule>` for a fix prompt.\n";
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        use std::io::Write;
        let _ = f.write_all(md.as_bytes());
    }
}

/// Badge text and colour: `S 98.7 · ddd-hexagonal`, or `· structure` when only plugin defaults were used.
fn badge_parts(a: &Value) -> (String, &'static str) {
    let sc = &a["score"];
    let g = grade(sc).to_string();
    let what = match a["project"]["packs"].as_array().filter(|x| !x.is_empty()) {
        Some(p) => p.iter().filter_map(Value::as_str).collect::<Vec<_>>().join("+"),
        None => "structure".into(),
    };
    let color = match g.as_str() {
        "S" => "brightgreen",
        "A" => "green",
        "B" => "yellowgreen",
        "C" => "yellow",
        "D" => "orange",
        "?" => "lightgrey",
        _ => "red",
    };
    let score = sc["total"].as_f64().map_or(String::new(), |t| format!(" {t}"));
    (format!("{g}{score} · {what}"), color)
}

fn badge_svg(label: &str, msg: &str, color: &str) -> String {
    let hex = match color {
        "brightgreen" => "#4c1",
        "green" => "#97ca00",
        "yellowgreen" => "#a4a61d",
        "yellow" => "#dfb317",
        "orange" => "#fe7d37",
        "red" => "#e05d44",
        _ => "#9f9f9f",
    };
    let esc = |x: &str| x.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;");
    // approximate text widths (Verdana 11px ≈ 6.5px per char) — close enough for a static badge
    let (lw, mw) = (label.chars().count() * 7 + 10, msg.chars().count() * 7 + 10);
    let w = lw + mw;
    format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{w}\" height=\"20\" role=\"img\" aria-label=\"{l}: {m}\"><title>{l}: {m}</title>\
<rect width=\"{lw}\" height=\"20\" fill=\"#555\"/><rect x=\"{lw}\" width=\"{mw}\" height=\"20\" fill=\"{hex}\"/>\
<g fill=\"#fff\" font-family=\"Verdana,DejaVu Sans,sans-serif\" font-size=\"11\">\
<text x=\"{lx}\" y=\"14\" text-anchor=\"middle\">{l}</text><text x=\"{mx}\" y=\"14\" text-anchor=\"middle\">{m}</text></g></svg>\n",
        l = esc(label),
        m = esc(msg),
        lx = lw / 2,
        mx = lw + mw / 2,
    )
}

fn write_badge(a: &Value, out: Option<&str>, svg: bool) -> Result<u8, String> {
    let (msg, color) = badge_parts(a);
    let body = if svg {
        badge_svg("sprawler", &msg, color)
    } else {
        serde_json::to_string_pretty(&json!({"schemaVersion": 1, "label": "sprawler", "message": msg, "color": color})).unwrap_or_default() + "\n"
    };
    match out {
        Some(f) => {
            std::fs::write(f, &body).map_err(|e| format!("{f}: {e}"))?;
            eprintln!("  ✓ wrote {f}: sprawler | {msg}");
        }
        None => print!("{body}"),
    }
    Ok(0)
}

/// Finding ids recorded by `sprawler baseline`.
fn read_baseline(path: &str) -> Result<BTreeSet<String>, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("{path}: {e}"))?;
    let v: Value = serde_json::from_str(&text).map_err(|e| format!("{path}: {e}"))?;
    Ok(v["findings"].as_array().into_iter().flatten().filter_map(|f| f["id"].as_str().map(str::to_string)).collect())
}

fn write_baseline(a: &Value, out: &str) -> Result<u8, String> {
    let vs = a["violations"].as_array().cloned().unwrap_or_default();
    let findings: Vec<Value> =
        vs.iter().map(|v| json!({"id": v["id"], "rule": v["rule"], "severity": v["severity"], "source": v["source"], "target": v["target"]})).collect();
    let doc = json!({"schema": "sprawler.baseline/1", "project": a["project"]["name"], "sha": a["project"]["sha"], "findings": findings});
    std::fs::write(out, serde_json::to_string_pretty(&doc).unwrap_or_default() + "\n").map_err(|e| format!("{out}: {e}"))?;
    println!("  ✓ wrote {out}: {} finding(s) recorded; `sprawler check --baseline {out}` now fails only on new ones", findings.len());
    Ok(0)
}

fn check(a: &Value, fail_on: &str, min_score: Option<f64>, baseline: Option<&BTreeSet<String>>, format: &str) -> u8 {
    let as_json = format == "json";
    let sc = &a["score"];
    let vs = a["violations"].as_array().cloned().unwrap_or_default();
    let is_new = |v: &Value| baseline.is_none_or(|b| !b.contains(s(v, "id")));
    let fixed: usize = baseline.map_or(0, |b| b.iter().filter(|id| !vs.iter().any(|v| s(v, "id") == id.as_str())).count());
    let new_n = vs.iter().filter(|v| is_new(v)).count();
    let mut failures = Vec::new();
    if let Some(f) = Some(fail_on).filter(|f| *f != "none") {
        let n = vs.iter().filter(|v| is_new(v) && sev_rank(s(v, "severity")) >= sev_rank(f)).count();
        if n > 0 {
            failures.push(format!("{n} {}finding(s) at or above {f}", if baseline.is_some() { "new " } else { "" }));
        }
    }
    let total = sc["total"].as_f64().unwrap_or(0.0);
    if let Some(m) = min_score {
        if total < m {
            failures.push(format!("score {total} is below {m}"));
        }
        if sc["withheld"].as_bool().unwrap_or(false) {
            failures.push(format!("grade withheld: confidence {}% is too low to back a score", pct(&sc["confidence"])));
        }
    }
    let unhandled: Vec<&str> =
        a["seams"].as_array().into_iter().flatten().flat_map(|x| x["unhandled"].as_array().into_iter().flatten().filter_map(Value::as_str)).collect();
    if !unhandled.is_empty() {
        let head: Vec<&str> = unhandled.iter().take(6).copied().collect();
        failures.push(format!("{} unhandled contract seam kind(s): {}", unhandled.len(), head.join(", ")));
    }
    if as_json {
        let keys = ["total", "grade", "label", "mode", "withheld", "confidence", "policyCoverage", "worst", "bySeverity"];
        let fkeys = ["id", "rule", "severity", "message", "why", "source", "line", "target", "fromCtx", "toCtx"];
        let out = json!({
            "schema": a["schema"], "project": a["project"]["name"], "sha": a["project"]["sha"],
            "ok": failures.is_empty(), "failures": failures,
            "score": keys.iter().map(|k| (k.to_string(), if *k == "bySeverity" { by_severity(&vs) } else { sc.get(*k).cloned().unwrap_or(Value::Null) })).collect::<serde_json::Map<_, _>>(),
            "findings": vs.iter().map(|v| {
                let mut m: serde_json::Map<_, _> = fkeys.iter().map(|k| (k.to_string(), v.get(*k).cloned().unwrap_or(Value::Null))).collect();
                if baseline.is_some() {
                    m.insert("new".into(), json!(is_new(v)));
                }
                m
            }).collect::<Vec<_>>(),
            "baseline": baseline.map(|b| json!({"known": b.len(), "new": new_n, "fixed": fixed})),
            "inbox": sprawler_domain::inbox::build_inbox(a),
            "warnings": a["warnings"],
        });
        println!("{}", serde_json::to_string_pretty(&out).unwrap_or_default());
    } else {
        println!(
            "  {}  {} {} [{}]  · {} finding(s) {}  · confidence {}%",
            s(&a["project"], "title"),
            s(sc, "label"),
            total,
            grade(sc),
            vs.len(),
            by_severity(&vs),
            pct(&sc["confidence"])
        );
        if format == "github" {
            github_output(a, &vs, &is_new, baseline.map(|_| (new_n, fixed)), &failures);
        }
        if baseline.is_some() {
            println!("  baseline: {new_n} new · {} known · {fixed} fixed since the baseline", vs.len() - new_n);
        }
        // what to do: FIX and IMPROVE items in order, then how much is left to CHECK
        let inbox = sprawler_domain::inbox::build_inbox(a);
        let items: Vec<&Value> = inbox.iter().collect();
        let act: Vec<&&Value> = items.iter().filter(|i| matches!(s(i, "kind"), "fix" | "improve")).collect();
        if !act.is_empty() {
            println!();
            for i in act.iter().take(8) {
                println!("  {:8} {:>4}  {}", s(i, "kind").to_uppercase(), i["count"].as_u64().unwrap_or(0), s(i, "title"));
            }
            if act.len() > 8 {
                println!("  … {} more", act.len() - 8);
            }
        }
        let checks = items.iter().filter(|i| s(i, "kind") == "check").count();
        if checks > 0 {
            println!("  {:8} {checks:>4}  item(s) to check: maybe a problem, or a blind spot (`sprawler report` lists them)", "CHECK");
        }
        println!();
        for f in &failures {
            println!("  ✗ {f}");
        }
        if failures.is_empty() {
            println!("  ✓ check passed");
        }
        if let Some(first) = act.first() {
            let root = s(&a["project"], "root");
            let rule = s(first, "rule");
            if !rule.is_empty() {
                println!("  next: sprawler prompts {root} --rule {rule}    (a fix prompt for the first item)");
            }
        }
    }
    u8::from(!failures.is_empty())
}

fn report(a: &Value, as_json: bool) {
    let sc = &a["score"];
    if as_json {
        let out = json!({"schema": a["schema"], "project": a["project"], "score": sc, "contexts": a["contexts"],
                         "seams": a["seams"], "inbox": sprawler_domain::inbox::build_inbox(a), "warnings": a["warnings"]});
        println!("{}", serde_json::to_string_pretty(&out).unwrap_or_default());
        return;
    }
    println!("\n  {}  @ {}   {} {}  [{}]", s(&a["project"], "title"), s(&a["project"], "sha"), s(sc, "label"), sc["total"], grade(sc));
    if let Some(w) = sc.get("worst").filter(|w| !w.is_null()) {
        println!("  worst context {} {} [{}]   confidence {}%", s(w, "label"), w["score"], s(w, "grade"), pct(&sc["confidence"]));
    }
    println!(
        "  modules {}  deps {}  clean {}  allowed-cross {}  findings {} {}",
        a["modules"].as_array().map_or(0, Vec::len),
        sc["edges"],
        sc["clean"],
        sc["cross"],
        a["violations"].as_array().map_or(0, Vec::len),
        by_severity(a["violations"].as_array().map(Vec::as_slice).unwrap_or(&[]))
    );
    println!(
        "  rules check {}% of links · cycles {} · wells {}",
        pct(&sc["policyCoverage"]),
        a["cycles"].as_array().map_or(0, Vec::len),
        a["wells"].as_array().map_or(0, Vec::len)
    );
    let mut ctxs: Vec<&Value> = a["contexts"].as_array().map(|c| c.iter().collect()).unwrap_or_default();
    ctxs.sort_by(|x, y| s(x, "tier").cmp(s(y, "tier")).then(y["loc"].as_u64().cmp(&x["loc"].as_u64())));
    println!("\n  CONTEXT                                  GRADE  SCORE  PURITY TANGLE  MODS  VIOL");
    for c in ctxs {
        let v = c["crit"].as_u64().unwrap_or(0) + c["major"].as_u64().unwrap_or(0) + c["minor"].as_u64().unwrap_or(0);
        let key: String = s(c, "key").chars().take(40).collect();
        println!(
            "  {key:40} {:>5}  {:5.1}  {:.2}   {:.2}  {:4}  {v:4}{}",
            s(c, "grade"),
            c["score"].as_f64().unwrap_or(0.0),
            c["purity"].as_f64().unwrap_or(0.0),
            c["tangle"].as_f64().unwrap_or(0.0),
            c["modules"].as_u64().unwrap_or(0),
            if c["nest"].as_bool().unwrap_or(false) { " NEST" } else { "" }
        );
    }
    if let Some(seams) = a["seams"].as_array().filter(|x| !x.is_empty()) {
        println!("\n  CONTRACT SEAMS (not scored)");
        for sm in seams {
            let list = |k: &str| sm[k].as_array().into_iter().flatten().filter_map(Value::as_str).collect::<Vec<_>>().join(",");
            let (u, d) = (list("unhandled"), list("dead"));
            let mut flag = String::new();
            if !u.is_empty() {
                flag += &format!("  ⚠ unhandled {u}");
            }
            if !d.is_empty() {
                flag += &format!("  · dead {d}");
            }
            println!(
                "  {:10} matched {:3}{}",
                s(sm, "id"),
                sm["matched"].as_array().map_or(0, Vec::len),
                if flag.is_empty() { "  ✓ in sync".into() } else { flag }
            );
        }
    }
    let inbox = sprawler_domain::inbox::build_inbox(a);
    if !inbox.is_empty() {
        println!("\n  INBOX (fix first, then improve; check = maybe a problem, or a blind spot)");
        for i in &inbox {
            let rule = s(i, "rule");
            let tag = if rule.is_empty() { String::new() } else { format!("  [{rule}]") };
            println!("  {:8} {:>4}  {}{tag}", s(i, "kind").to_uppercase(), i["count"].as_u64().unwrap_or(0), s(i, "title"));
        }
    }
    if a["warnings"].as_array().is_some_and(|w| !w.is_empty()) {
        println!();
    }
    for w in a["warnings"].as_array().into_iter().flatten().filter_map(Value::as_str) {
        println!("  ⚠ {w}");
    }
}

fn tool_ok(check: &[String]) -> bool {
    !check.is_empty() && Command::new(&check[0]).args(&check[1..]).output().is_ok_and(|o| o.status.success())
}

/// First-party plugins and how to install them from a clone of this repo.
const FIRST_PARTY: [(&str, &str); 6] = [
    ("roc", "sprawler plugin add roc"),
    ("rust", "sprawler plugin add rust   (also needs Graphify for symbols: uv tool install graphifyy)"),
    ("csharp", "sprawler plugin add csharp   (needs the .NET SDK)"),
    ("typescript", "sprawler plugin add typescript"),
    ("python", "sprawler plugin add python"),
    ("go", "sprawler plugin add go"),
];

/// A Sprawler checkout holding `plugins/analyzer-<name>`: `--from`, `SPRAWLER_SOURCE`, else the
/// current folder or the binary's folder and their parents.
fn plugin_source(from: Option<&str>) -> Result<std::path::PathBuf, String> {
    let ok = |d: &Path| d.join("plugins").is_dir() && d.join("crates/sprawler-protocol").is_dir();
    let mut cands: Vec<std::path::PathBuf> = Vec::new();
    if let Some(f) = from {
        cands.push(profile::resolve_path(f));
    }
    if let Some(s) = std::env::var_os("SPRAWLER_SOURCE") {
        cands.push(std::path::PathBuf::from(s));
    }
    for start in [std::env::current_dir().ok(), std::env::current_exe().ok()].into_iter().flatten() {
        cands.extend(start.ancestors().map(Path::to_path_buf));
    }
    cands
        .into_iter()
        .find(|d| ok(d))
        .ok_or_else(|| "no Sprawler source checkout found: run from a clone of the repo, or pass --from DIR (or set SPRAWLER_SOURCE)".into())
}

fn run_step(c: &mut Command) -> Result<(), String> {
    let o = c.output().map_err(|e| format!("{:?}: {e}", c.get_program()))?;
    if o.status.success() {
        return Ok(());
    }
    let err = String::from_utf8_lossy(&o.stderr).into_owned() + &String::from_utf8_lossy(&o.stdout);
    Err(err.trim().chars().rev().take(800).collect::<Vec<_>>().into_iter().rev().collect())
}

fn plugin_add_one(name: &str, src: &Path, home: &Path) -> Result<std::path::PathBuf, String> {
    let dir = src.join("plugins").join(format!("analyzer-{name}"));
    if !dir.is_dir() {
        let known: Vec<&str> = FIRST_PARTY.iter().map(|x| x.0).collect();
        return Err(format!("no first-party plugin `{name}` (available: {})", known.join(", ")));
    }
    let bin = home.join("bin");
    std::fs::create_dir_all(&bin).map_err(|e| format!("{}: {e}", bin.display()))?;
    let exe = bin.join(format!("sprawler-analyzer-{name}{}", std::env::consts::EXE_SUFFIX));
    if dir.join(format!("sprawler-analyzer-{name}.csproj")).is_file() {
        // .NET: build into the plugin home, then a small launcher on the plugin path
        // Windows: build next to the plugin path (the .exe needs its DLLs beside it; no shell launcher)
        let lib = if cfg!(windows) { bin.clone() } else { home.join("lib").join(name) };
        let obj = home.join("obj").join(name);
        let (lib_s, obj_s) = (format!("{}/", lib.display()), format!("{}/", obj.display()));
        run_step(
            Command::new("dotnet")
                .current_dir(&dir)
                .args(["build", &format!("sprawler-analyzer-{name}.csproj"), "--nologo", "-v", "quiet", "-c", "Release"])
                .arg(format!("-p:BaseIntermediateOutputPath={obj_s}"))
                .arg(format!("-p:MSBuildProjectExtensionsPath={obj_s}"))
                .arg(format!("-p:OutputPath={lib_s}")),
        )?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let target = lib.join(format!("sprawler-analyzer-{name}"));
            std::fs::write(&exe, format!("#!/bin/sh\nexec \"{}\" \"$@\"\n", target.display())).map_err(|e| e.to_string())?;
            std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
        }
    } else {
        run_step(
            Command::new("cargo")
                .args(["install", "--quiet", "--force", "--path"])
                .arg(&dir)
                .arg("--root")
                .arg(home)
                .arg("--target-dir")
                .arg(src.join("target")),
        )?;
    }
    plugins::load(&exe).map(|_| exe)
}

/// This build's release archive: `SPRAWLER_RELEASE_URL` (a URL or a local .tar.gz), else the GitHub release.
fn release_archive() -> String {
    match std::env::var("SPRAWLER_RELEASE_URL") {
        Ok(u) if !u.is_empty() => u,
        _ => {
            let (v, t) = (env!("CARGO_PKG_VERSION"), env!("SPRAWLER_TARGET"));
            format!("https://github.com/clankernative/sprawler/releases/download/v{v}/sprawler-{v}-{t}.tar.gz")
        }
    }
}

/// No source checkout: install prebuilt plugins from the release archive for this platform.
fn plugin_download(names: &[String]) -> u8 {
    let url = release_archive();
    let tmp = std::env::temp_dir().join(format!("sprawler-release-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp);
    let fetched = std::fs::create_dir_all(&tmp).map_err(|e| e.to_string()).and_then(|_| {
        let archive = tmp.join("release.tar.gz");
        if Path::new(&url).is_file() {
            std::fs::copy(&url, &archive).map(|_| ()).map_err(|e| format!("{url}: {e}"))?;
        } else {
            eprintln!("  … downloading {url}");
            run_step(Command::new("curl").args(["-fsSL", "-o"]).arg(&archive).arg(&url)).map_err(|e| format!("download failed: {e}"))?;
        }
        run_step(Command::new("tar").arg("-xzf").arg(&archive).arg("-C").arg(&tmp))?;
        std::fs::read_dir(&tmp)
            .map_err(|e| e.to_string())?
            .flatten()
            .map(|e| e.path().join("plugins"))
            .find(|p| p.is_dir())
            .ok_or_else(|| "the archive has no plugins/ folder".to_string())
    });
    let dir = match fetched {
        Ok(d) => d,
        Err(e) => {
            eprintln!("  ✗ {e}");
            eprintln!("    (or build from source: clone https://github.com/clankernative/sprawler and pass --from DIR)");
            let _ = std::fs::remove_dir_all(&tmp);
            return 2;
        }
    };
    let bin = plugins::plugin_home().join("bin");
    let mut failed = false;
    for n in names {
        let file = format!("sprawler-analyzer-{n}{}", std::env::consts::EXE_SUFFIX);
        let (from, to) = (dir.join(&file), bin.join(&file));
        let r = if !from.is_file() {
            Err(format!(
                "not in the release archive ({}); build it from a checkout with --from DIR",
                if n == "csharp" { "the C# plugin needs the .NET SDK" } else { "unknown plugin" }
            ))
        } else {
            std::fs::create_dir_all(&bin).and_then(|_| std::fs::copy(&from, &to)).map_err(|e| e.to_string()).and_then(|_| {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    std::fs::set_permissions(&to, std::fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
                }
                plugins::load(&to).map(|_| ())
            })
        };
        match r {
            Ok(()) => println!("  ✓ {n:8} {}", to.display()),
            Err(e) => {
                failed = true;
                println!("  ✗ {n:8} {e}");
            }
        }
    }
    let _ = std::fs::remove_dir_all(&tmp);
    u8::from(failed)
}

fn plugin_add(names: &[String], from: Option<&str>) -> u8 {
    let src = match plugin_source(from) {
        Ok(s) => s,
        Err(_) if from.is_none() => return plugin_download(names),
        Err(e) => {
            eprintln!("  ✗ {e}");
            return 2;
        }
    };
    let home = plugins::plugin_home();
    let mut failed = false;
    for n in names {
        eprintln!("  … building {n}");
        match plugin_add_one(n, &src, &home) {
            Ok(exe) => println!("  ✓ {n:8} {}", exe.display()),
            Err(e) => {
                failed = true;
                println!("  ✗ {n:8} {e}");
            }
        }
    }
    u8::from(failed)
}

fn plugin_remove(names: &[String]) -> u8 {
    let home = plugins::plugin_home();
    let mut missing = false;
    for n in names {
        let exe = home.join("bin").join(format!("sprawler-analyzer-{n}{}", std::env::consts::EXE_SUFFIX));
        let _ = std::fs::remove_dir_all(home.join("lib").join(n));
        let _ = std::fs::remove_dir_all(home.join("obj").join(n));
        match std::fs::remove_file(&exe) {
            Ok(()) => println!("  ✓ removed {n}"),
            Err(_) => {
                missing = true;
                println!("  ✗ {n} is not installed in {}", home.display());
            }
        }
    }
    u8::from(missing)
}

fn doctor(as_json: bool) -> u8 {
    let mut warnings = Vec::new();
    let found = plugins::discover(&profile::Obj::new(), &mut warnings);
    let mut checks = vec![json!({"name": "sprawler", "ok": true, "detail": env!("CARGO_PKG_VERSION"), "fix": null})];
    for p in &found {
        let reqs: Vec<&Value> = p.info["requires"].as_array().map(|r| r.iter().collect()).unwrap_or_default();
        let missing: Vec<&Value> = reqs
            .iter()
            .copied()
            .filter(|r| !tool_ok(&r["check"].as_array().into_iter().flatten().filter_map(Value::as_str).map(str::to_string).collect::<Vec<_>>()))
            .collect();
        let claims = p.info["claims"].to_string();
        checks.push(json!({
            "name": format!("analyzer {}", p.name), "ok": missing.is_empty(),
            "detail": format!("{} · {} · claims {claims}", p.exe.display(), s(&p.info, "precision")),
            "fix": missing.first().map(|r| format!("install {}: {}", s(r, "tool"), s(r, "install"))),
        }));
    }
    for (name, fix) in FIRST_PARTY {
        if !found.iter().any(|p| p.name == name) {
            checks.push(json!({"name": format!("analyzer {name}"), "ok": false, "detail": "not installed (optional)", "fix": fix}));
        }
    }
    checks.push(json!({"name": "git", "ok": tool_ok(&["git".into(), "--version".into()]),
                       "detail": "history and churn", "fix": "install git (optional)"}));
    // only the core itself is required; analyzers are optional per language
    let ok = true;
    if as_json {
        println!("{}", serde_json::to_string_pretty(&json!({"ok": ok, "checks": checks, "warnings": warnings})).unwrap_or_default());
    } else {
        for c in &checks {
            let good = c["ok"].as_bool().unwrap_or(false);
            println!("  {} {:24} {}", if good { "✓" } else { "✗" }, s(c, "name"), s(c, "detail"));
            if !good {
                if let Some(f) = c["fix"].as_str() {
                    println!("  {:26} → {f}", "");
                }
            }
        }
        for w in &warnings {
            println!("  ⚠ {w}");
        }
    }
    u8::from(!ok)
}

/// Packs under `dir`: `<name>.toml` files and `<name>/pack.toml` folders, anywhere below it.
fn packs_in(dir: &Path) -> Vec<(String, std::path::PathBuf)> {
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        for e in std::fs::read_dir(&d).into_iter().flatten().flatten() {
            let p = e.path();
            if p.is_dir() {
                if p.join("pack.toml").is_file() {
                    out.push((e.file_name().to_string_lossy().into_owned(), p));
                } else {
                    stack.push(p);
                }
            } else if p.extension().is_some_and(|x| x == "toml") && p.file_name().is_some_and(|n| n != "pack.toml") {
                out.push((p.file_stem().unwrap_or_default().to_string_lossy().into_owned(), p));
            }
        }
    }
    out.sort();
    out
}

fn copy_tree(from: &Path, to: &Path) -> std::io::Result<()> {
    if from.is_file() {
        return std::fs::copy(from, to).map(|_| ());
    }
    std::fs::create_dir_all(to)?;
    for e in std::fs::read_dir(from)?.flatten() {
        copy_tree(&e.path(), &to.join(e.file_name()))?;
    }
    Ok(())
}

/// Where packs come from: `--from DIR` (a packs repo, or a Sprawler checkout holding `packs/`),
/// `SPRAWLER_PACKS_SOURCE`, else the Sprawler checkout found from the current folder or the binary.
fn pack_source(from: Option<&str>) -> Option<std::path::PathBuf> {
    let is_packs = |d: &Path| d.join("architectures").is_dir() || d.join("platforms").is_dir();
    let mut cands: Vec<std::path::PathBuf> = Vec::new();
    if let Some(f) = from {
        cands.push(profile::resolve_path(f));
    }
    if let Some(s) = std::env::var_os("SPRAWLER_PACKS_SOURCE") {
        cands.push(std::path::PathBuf::from(s));
    }
    for c in cands {
        if is_packs(&c) {
            return Some(c);
        }
        if is_packs(&c.join("packs")) {
            return Some(c.join("packs"));
        }
    }
    plugin_source(None).ok().map(|s| s.join("packs")).filter(|d| is_packs(d))
}

fn pack_list(as_json: bool) -> u8 {
    let home = profile::pack_home();
    let installed = packs_in(&home);
    let available = pack_source(None).map(|s| packs_in(&s)).unwrap_or_default();
    let builtin = profile::builtin_names();
    if as_json {
        let f = |v: &[(String, std::path::PathBuf)]| v.iter().map(|(n, p)| json!({"name": n, "path": p.to_string_lossy()})).collect::<Vec<_>>();
        println!(
            "{}",
            serde_json::to_string_pretty(&json!({"home": home.to_string_lossy(), "installed": f(&installed), "builtin": builtin, "available": f(&available)}))
                .unwrap_or_default()
        );
        return 0;
    }
    println!("  installed ({})", home.display());
    if installed.is_empty() {
        println!("    none — `sprawler pack add <name>`");
    }
    for (n, p) in &installed {
        println!("    {n:18} {}", p.display());
    }
    println!("  built-in: {}", builtin.join(", "));
    if !available.is_empty() {
        println!("  available in this checkout: {}", available.iter().map(|x| x.0.as_str()).collect::<Vec<_>>().join(", "));
    }
    0
}

fn pack_add(names: &[String], from: Option<&str>) -> u8 {
    let home = profile::pack_home();
    let src = pack_source(from);
    let mut failed = false;
    for n in names {
        let given = profile::resolve_path(n);
        let found = if given.exists() && (given.is_dir() || given.extension().is_some_and(|x| x == "toml")) {
            let name = if given.is_dir() { given.file_name() } else { given.file_stem() }.unwrap_or_default().to_string_lossy().into_owned();
            Some((name, given))
        } else {
            src.as_ref().and_then(|s| packs_in(s).into_iter().find(|(x, _)| x == n))
        };
        let Some((name, path)) = found else {
            failed = true;
            println!("  ✗ {n:18} no such pack (not a path, and not in a packs repo; pass --from DIR or set SPRAWLER_PACKS_SOURCE)");
            continue;
        };
        let dst = if path.is_dir() { home.join(&name) } else { home.join(format!("{name}.toml")) };
        let r = std::fs::create_dir_all(&home)
            .and_then(|_| if dst.is_dir() { std::fs::remove_dir_all(&dst) } else { Ok(()) })
            .and_then(|_| copy_tree(&path, &dst))
            .map_err(|e| e.to_string())
            .and_then(|_| profile::load_pack(&name, &home).map(|_| ()));
        match r {
            Ok(()) => println!("  ✓ {name:18} {}", dst.display()),
            Err(e) => {
                failed = true;
                // don't leave a pack behind that cannot load
                let _ = if dst.is_dir() { std::fs::remove_dir_all(&dst) } else { std::fs::remove_file(&dst) };
                println!("  ✗ {name:18} {e}");
            }
        }
    }
    u8::from(failed)
}

fn pack_remove(names: &[String]) -> u8 {
    let home = profile::pack_home();
    let mut missing = false;
    for n in names {
        let (file, dir) = (home.join(format!("{n}.toml")), home.join(n));
        let r = if file.is_file() {
            std::fs::remove_file(&file)
        } else if dir.join("pack.toml").is_file() {
            std::fs::remove_dir_all(&dir)
        } else {
            Err(std::io::ErrorKind::NotFound.into())
        };
        match r {
            Ok(()) => println!("  ✓ removed {n}"),
            Err(_) => {
                missing = true;
                println!("  ✗ {n} is not installed in {}", home.display());
            }
        }
    }
    u8::from(missing)
}

fn plugin_list(as_json: bool) -> u8 {
    let mut warnings = Vec::new();
    let found = plugins::discover(&profile::Obj::new(), &mut warnings);
    if as_json {
        let list: Vec<Value> = found.iter().map(|p| json!({"name": p.name, "exe": p.exe.to_string_lossy(), "describe": p.info})).collect();
        println!("{}", serde_json::to_string_pretty(&json!({"plugins": list, "warnings": warnings})).unwrap_or_default());
    } else {
        if found.is_empty() {
            println!("  no analyzer plugins found (searched SPRAWLER_PLUGIN_PATH, next to sprawler, ~/.local/share/sprawler/plugins/bin, PATH)");
        }
        for p in &found {
            println!("  {:8} {:9} {}  claims {}", p.name, s(&p.info, "precision"), p.exe.display(), p.info["claims"]);
        }
        for w in &warnings {
            println!("  ⚠ {w}");
        }
    }
    0
}

fn setup(dir: &str, yes: bool, shared: bool, as_json: bool, only_discover: bool) -> u8 {
    let root = profile::resolve_path(dir);
    let d = discover::discover(&root);
    let found = !d["platform"].is_null() || d["dotnet"].as_array().is_some_and(|a| !a.is_empty());
    let mut cfg = discover::default_config(&d);
    let path = if shared { discover::workspace_config_path(&root) } else { discover::user_config_path(&root) };
    if !shared {
        cfg.insert("root".into(), d["root"].clone());
    }
    let text = discover::config_text(&cfg);
    let unchanged = std::fs::read_to_string(&path).is_ok_and(|t| t == text);
    let mut warnings = Vec::new();
    let installed = plugins::discover(&profile::Obj::new(), &mut warnings);
    let analyzers: Vec<Value> = discover::needed_analyzers(&d)
        .iter()
        .map(|n| {
            let fix = FIRST_PARTY.iter().find(|(x, _)| x == n).map(|(_, f)| *f);
            json!({"name": n, "installed": installed.iter().any(|p| p.name == *n), "install": fix})
        })
        .collect();
    let mut written = false;
    let mut error = None;
    if found && yes && !only_discover && !unchanged {
        match path.parent().map(std::fs::create_dir_all).unwrap_or(Ok(())).and_then(|_| std::fs::write(&path, &text)) {
            Ok(()) => written = true,
            Err(e) => error = Some(format!("{}: {e}", path.display())),
        }
    }
    let target = format!("sprawler check {}", d["root"].as_str().unwrap_or("."));
    let next: Vec<String> = if !found {
        vec!["add a sprawler.toml (docs/CONFIG.md) or pass --profile FILE".into()]
    } else {
        let mut n: Vec<String> =
            analyzers.iter().filter(|a| a["installed"] == json!(false)).filter_map(|a| a["install"].as_str().map(str::to_string)).collect();
        if !yes && !only_discover && !unchanged {
            n.push(format!("sprawler setup {} --yes{}", d["root"].as_str().unwrap_or("."), if shared { " --shared" } else { "" }));
        }
        n.push(target);
        n
    };
    if as_json {
        let out = json!({"root": d["root"], "found": found, "discovered": d, "config": cfg, "path": path.to_string_lossy(),
                         "written": written, "unchanged": unchanged, "analyzers": analyzers, "next": next, "error": error, "warnings": warnings});
        println!("{}", serde_json::to_string_pretty(&out).unwrap_or_default());
    } else {
        println!("  root       {}", s(&d, "root"));
        println!("  platform   {}", d["platform"].as_str().map_or("— not found".to_string(), |p| if p.is_empty() { "(root)".into() } else { p.into() }));
        println!("  apps       {}", d["apps"].as_array().map_or(0, Vec::len));
        println!("  instances  {}", d["instances"].as_array().map_or(0, Vec::len));
        println!("  tests      {}", d["tests"].as_array().map_or(0, Vec::len));
        println!("  .NET       {} project(s)", d["dotnet"].as_array().map_or(0, Vec::len));
        if found && !only_discover {
            println!(
                "\n  {} {}:\n",
                if written {
                    "saved"
                } else if unchanged {
                    "unchanged"
                } else {
                    "would write"
                },
                path.display()
            );
            for l in text.lines() {
                println!("    {l}");
            }
        }
        for a in &analyzers {
            println!("  {} analyzer {}", if a["installed"] == json!(true) { "✓" } else { "✗" }, s(a, "name"));
        }
        if let Some(e) = &error {
            println!("  ✗ {e}");
        }
        println!("\n  next:");
        for n in &next {
            println!("    {n}");
        }
    }
    if error.is_some() || !found {
        2
    } else {
        0
    }
}

fn check_row(checks: &mut Vec<Value>, name: &str, ok: bool, detail: impl Into<String>) {
    checks.push(json!({"check": name, "ok": ok, "detail": detail.into()}));
}

/// Every file under `root` (build/vendor/dot folders and .NET bin/obj pruned), sorted.
fn all_files(root: &Path) -> Vec<String> {
    let (mut out, mut stack) = (Vec::new(), vec![String::new()]);
    while let Some(rd) = stack.pop() {
        let dir = if rd.is_empty() { root.to_path_buf() } else { root.join(&rd) };
        let mut entries: Vec<_> = std::fs::read_dir(&dir).into_iter().flatten().flatten().collect();
        entries.sort_by_key(|e| e.file_name());
        for e in entries {
            let n = e.file_name().to_string_lossy().into_owned();
            let rel = if rd.is_empty() { n.clone() } else { format!("{rd}/{n}") };
            match e.file_type() {
                Ok(t) if t.is_dir() => {
                    if !n.starts_with('.') && !crate::walk::PRUNE.contains(&n.as_str()) && n != "bin" && n != "obj" {
                        stack.push(rel);
                    }
                }
                Ok(t) if t.is_file() => out.push(rel),
                _ => {}
            }
        }
    }
    out
}

fn plugin_test(exe: &str, dir: &str, as_json: bool) -> u8 {
    let mut checks: Vec<Value> = Vec::new();
    match plugins::load(&profile::resolve_path(exe)) {
        Err(e) => check_row(&mut checks, "describe", false, e),
        Ok(p) => {
            check_row(&mut checks, "describe", true, format!("{} {}", p.name, s(&p.info, "version")));
            let name_ok = p.name.chars().next().is_some_and(|c| c.is_ascii_lowercase())
                && p.name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
            check_row(&mut checks, "describe.name", name_ok, p.name.clone());
            check_row(&mut checks, "describe.version", !s(&p.info, "version").is_empty(), s(&p.info, "version"));
            let prec = s(&p.info, "precision");
            check_row(&mut checks, "describe.precision", matches!(prec, "semantic" | "syntactic"), prec);
            let has_claims = ["extensions", "files"].iter().any(|k| p.info["claims"][*k].as_array().is_some_and(|a| !a.is_empty()));
            check_row(&mut checks, "describe.claims", has_claims, p.info["claims"].to_string());
            let root = profile::resolve_path(dir);
            let files = all_files(&root);
            let one = vec![p.clone()];
            let claimed: Vec<String> = plugins::assign(&one, &files).into_iter().flat_map(|(_, f)| f).collect();
            check_row(&mut checks, "claims files", !claimed.is_empty(), format!("{} of {} files in {}", claimed.len(), files.len(), root.display()));
            if !claimed.is_empty() {
                let cache = std::env::temp_dir().join("sprawler-plugin-test").join(&p.name);
                let req = json!({"protocol": sprawler_protocol::PROTOCOL, "root": root.to_string_lossy(), "files": claimed,
                                 "tests": [], "options": {}, "cache_dir": cache.to_string_lossy()});
                match plugins::analyze(&p, &req) {
                    Err(e) => check_row(&mut checks, "analyze", false, e),
                    Ok(out) => {
                        check_row(&mut checks, "analyze", true, "protocol sprawler.analyzer/1");
                        let mods = out["modules"].as_array().cloned().unwrap_or_default();
                        let ids: HashSet<&str> = mods.iter().filter_map(|m| m["id"].as_str()).collect();
                        let bad = mods.iter().filter(|m| m["id"].as_str().is_none_or(str::is_empty) || m["lang"].as_str().is_none()).count();
                        check_row(&mut checks, "modules have id + lang", bad == 0, format!("{} modules, {bad} malformed", mods.len()));
                        let edges = out["edges"].as_array().cloned().unwrap_or_default();
                        let dangling = edges.iter().filter(|e| !ids.contains(s(e, "source")) || !ids.contains(s(e, "target"))).count();
                        check_row(
                            &mut checks,
                            "edges reference modules",
                            dangling == 0,
                            format!("{} edges, {dangling} to unknown modules (dropped by the core)", edges.len()),
                        );
                        let norel = edges.iter().filter(|e| e["relations"].as_array().is_none_or(|r| r.is_empty())).count();
                        check_row(&mut checks, "edges have relations", norel == 0, format!("{norel} without relations"));
                        let same = plugins::analyze(&p, &req).is_ok_and(|again| again == out);
                        check_row(&mut checks, "deterministic", same, if same { "two runs, identical output" } else { "second run differed or failed" });
                    }
                }
            }
        }
    }
    let ok = checks.iter().all(|c| c["ok"].as_bool().unwrap_or(false));
    if as_json {
        println!("{}", serde_json::to_string_pretty(&json!({"ok": ok, "checks": checks})).unwrap_or_default());
    } else {
        for c in &checks {
            println!("  {} {:26} {}", if c["ok"].as_bool().unwrap_or(false) { "✓" } else { "✗" }, s(c, "check"), s(c, "detail"));
        }
        println!("  {}", if ok { "✓ plugin conforms to sprawler.analyzer/1" } else { "✗ plugin does not conform" });
    }
    u8::from(!ok)
}

fn names(v: &Value) -> Vec<String> {
    match v {
        Value::String(x) => vec![x.clone()],
        Value::Array(a) => a.iter().filter_map(Value::as_str).map(str::to_string).collect(),
        _ => vec![],
    }
}

/// A first guess at a folder's layer from its name; `None` = no idea (the profile marks it TODO).
fn guess_layer(name: &str) -> Option<&'static str> {
    let n = name.to_lowercase();
    let any = |xs: &[&str]| xs.iter().any(|x| n == *x || n.ends_with(&format!("-{x}")) || n.ends_with(&format!("_{x}")));
    if any(&["test", "tests", "spec", "specs", "e2e", "__tests__"]) {
        Some("test")
    } else if any(&["domain", "core", "model", "models", "entities", "kernel"]) {
        Some("core")
    } else if any(&["ports", "port", "contracts", "contract", "interfaces", "protocol", "abstractions"]) {
        Some("port")
    } else if any(&["app", "application", "usecases", "use-cases", "use_cases", "services", "features"]) {
        Some("application")
    } else if any(&["api", "web", "http", "cli", "handlers", "controllers", "routes", "ui", "cmd", "server"]) {
        Some("driving")
    } else if any(&["infra", "infrastructure", "adapters", "adapter", "db", "persistence", "storage", "repositories", "clients", "integrations"]) {
        Some("driven")
    } else if any(&["generated", "gen", "codegen"]) {
        Some("generated")
    } else {
        None
    }
}

/// `profile init`: a starting profile the developer (or an agent, with them) then corrects.
fn profile_init(dir: &str, architecture: &str, add: &[String], force: bool) -> u8 {
    let root = profile::resolve_path(dir);
    let out = root.join("sprawler.toml");
    if out.exists() && !force {
        eprintln!("sprawler: {} already exists (edit it, or pass --force to replace it)", out.display());
        return 2;
    }
    let files = discover::sample_files(&root);
    let mut warnings = Vec::new();
    let found = plugins::discover(&profile::Obj::new(), &mut warnings);
    let used: Vec<&plugins::Plugin> = found.iter().filter(|p| files.iter().any(|f| p.claims(f))).collect();
    let mut exts: Vec<String> = Vec::new();
    for p in &used {
        for e in p.info.pointer("/claims/extensions").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str) {
            if !exts.iter().any(|x| x == e) {
                exts.push(e.to_string());
            }
        }
    }
    // top-level folders holding source files; container folders (crates/, packages/, …) map per child
    let is_src = |f: &str| exts.iter().any(|e| f.ends_with(e.as_str()));
    let mut tops: Vec<(String, bool)> = Vec::new();
    for f in files.iter().filter(|f| is_src(f)) {
        let Some((top, rest)) = f.split_once('/') else { continue };
        let container = matches!(top, "crates" | "packages" | "plugins" | "apps" | "services" | "libs" | "modules") && rest.contains('/');
        if !tops.iter().any(|(t, _)| t == top) {
            tops.push((top.to_string(), container));
        }
    }
    tops.sort();
    let name = root.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "workspace".into());
    let mut packs: Vec<String> = vec![architecture.to_string()];
    packs.extend(add.iter().cloned());
    let q = |v: &[String]| v.iter().map(|x| format!("\"{x}\"")).collect::<Vec<_>>().join(", ");
    let mut t = String::new();
    t += &format!("# Sprawler profile for {name}. Written by `sprawler profile init`; it is a starting point, not policy.\n");
    t += "# Confirm every [[map]] entry with the people who own this code, record design decisions as [[rules]] with a\n";
    t += "# `why`, then check with `sprawler profile explain` and `sprawler check .` (docs/CONFIG.md, AGENTS.md).\n";
    t += &format!("extends = [{}]\nname = \"{name}\"\nroot = \".\"\n", q(&packs));
    if !exts.is_empty() {
        t += &format!("extensions = [{}]\n", q(&exts));
    }
    t += "exclude = [\"**/target/**\", \"**/node_modules/**\", \"**/dist/**\", \"**/bin/**\", \"**/obj/**\", \"**/.venv/**\"]\n\n";
    t += "# ── where things are: path → tier, context, layer (first match wins; put specific entries first) ──\n";
    t += &format!(
        "# Layers from the packs: core, port, application, driving, driven, root, generated, test{}{}.\n",
        if add.iter().any(|a| a == "cqrs") { ", command, query" } else { "" },
        if add.iter().any(|a| a == "vertical-slices") { ", slice, shared" } else { "" }
    );
    t += "# `{ctx}` in a glob captures the bounded context from the path.\n";
    let test_dirs = ["tests", "test", "spec", "specs", "__tests__", "e2e"];
    for (top, container) in &tops {
        // tests inside a folder go first, or the folder's own entry would claim them
        let has_tests = guess_layer(top) != Some("test")
            && files.iter().filter(|f| is_src(f) && f.starts_with(&format!("{top}/"))).any(|f| f.split('/').any(|seg| test_dirs.contains(&seg)));
        if has_tests {
            for d in test_dirs.iter().filter(|d| files.iter().any(|f| f.starts_with(&format!("{top}/")) && f.split('/').any(|seg| seg == **d))) {
                t += "\n[[map]]\n";
                if *container {
                    t += &format!("glob = \"{top}/{{ctx}}/**/{d}/**\"\ntier = \"app\"\nlayer = \"test\"\n");
                } else {
                    t += &format!("glob = \"{top}/**/{d}/**\"\ntier = \"app\"\nctx = \"{top}\"\nlayer = \"test\"\n");
                }
            }
        }
        let guess = guess_layer(top);
        let layer = guess.unwrap_or("application");
        let note = if guess.is_some() { "guessed from the folder name — confirm" } else { "TODO: which layer is this?" };
        t += "\n[[map]]\n";
        if *container {
            t += &format!("glob = \"{top}/{{ctx}}/**\"\ntier = \"app\"\nlayer = \"{layer}\"   # {note}; one context per subfolder\n");
        } else {
            t += &format!("glob = \"{top}/**\"\ntier = \"app\"\nctx = \"{top}\"\nlayer = \"{layer}\"   # {note}\n");
        }
    }
    t += "\n# ── the team's own rules (first match wins) ──────────────────────────────────\n";
    t += "# [[rules]]\n# id = \"billing-knows-shipping\"\n# from_ctx = \"billing\"\n# to_ctx = \"shipping\"\n# severity = \"major\"\n";
    t += "# message = \"Billing uses Shipping internals\"\n# why = \"Contexts talk through published contracts so they can change independently.\"\n";
    if let Err(e) = std::fs::write(&out, &t) {
        eprintln!("sprawler: {}: {e}", out.display());
        return 2;
    }
    match profile::load_profile(&out, None).and_then(|p| profile::classifier(&p).map(|_| ())) {
        Ok(()) => {
            println!(
                "  ✓ wrote {} (extends {}; {} map entries; plugins: {})",
                out.display(),
                packs.join(", "),
                t.matches("\n[[map]]\n").count(),
                used.iter().map(|p| p.name.as_str()).collect::<Vec<_>>().join(", ")
            );
            println!("  next: confirm the layers with the code's owners, then `sprawler profile explain {dir}` and `sprawler check {dir}`");
            0
        }
        Err(e) => {
            eprintln!("sprawler: wrote {}, but it does not load: {e}", out.display());
            1
        }
    }
}

/// `profile explain`: the map as the scan applied it.
fn profile_explain(t: &Target, file: Option<&str>, as_json: bool) -> u8 {
    let a = match resolve(t).and_then(|p| atlas::build_atlas(&p, &local::Local).map(|a| (p, a))) {
        Ok(x) => x,
        Err(e) => {
            eprintln!("sprawler: {e}");
            return 2;
        }
    };
    let (p, a) = a;
    let mods: Vec<&Value> = a["modules"].as_array().map(|v| v.iter().filter(|m| !m["generated"].as_bool().unwrap_or(false)).collect()).unwrap_or_default();
    let viol: Vec<&Value> = a["violations"].as_array().map(|v| v.iter().collect()).unwrap_or_default();
    let rules: Vec<&Value> = p.get("rules").and_then(Value::as_array).map(|v| v.iter().collect()).unwrap_or_default();
    let in_list = |v: &Value, x: &str| v.is_null() || v.as_array().is_some_and(|l| l.iter().any(|y| y == x || y == "*"));

    if let Some(f) = file {
        let f = f.trim_start_matches("./");
        let Some(m) = mods.iter().find(|m| m["id"] == f || m["path"] == f) else {
            eprintln!("sprawler: {f} is not in the scan (excluded, empty, or not a claimed extension) — check include/exclude/extensions");
            return 2;
        };
        let layer = s(m, "layer");
        let applies: Vec<&str> = rules.iter().filter(|r| in_list(&r["from_layer"], layer) || in_list(&r["to_layer"], layer)).map(|r| s(r, "id")).collect();
        let allow = p.get("allow").and_then(|x| x.get(layer)).cloned().unwrap_or(Value::Null);
        let mine: Vec<Value> = viol
            .iter()
            .filter(|v| v["source"] == m["id"] || v["target"] == m["id"])
            .map(|v| json!({"rule": v["rule"], "severity": v["severity"], "source": v["source"], "target": v["target"], "message": v["message"]}))
            .collect();
        let out = json!({"file": m["id"], "tier": m["tier"], "context": m["ctx"], "layer": layer, "placedBy": m["rule"],
                         "role": m.get("role"), "mayDependOn": allow, "rules": applies, "findings": mine});
        if as_json {
            println!("{}", serde_json::to_string_pretty(&out).unwrap_or_default());
            return 0;
        }
        println!("  {f}");
        println!("    tier {}  ·  context {}  ·  layer {layer}", s(m, "tier"), s(m, "ctx"));
        match m["rule"].as_str() {
            Some(g) => println!("    placed by [[map]] glob = \"{g}\""),
            None => println!("    placed by nothing: unmapped (add a [[map]] entry)"),
        }
        if let Some(r) = m.get("role").and_then(Value::as_str) {
            println!("    analyzer role: {r}");
        }
        println!("    {layer} may depend on: {}", if allow.is_null() { "(no [allow] entry — anything)".to_string() } else { allow.to_string() });
        println!("    rules that look at this layer: {}", if applies.is_empty() { "none".to_string() } else { applies.join(", ") });
        for v in &mine {
            println!("    ✗ {} {}: {} → {}", s(v, "severity"), s(v, "rule"), s(v, "source"), s(v, "target"));
        }
        if !mine.is_empty() {
            println!("    If this file is in the wrong layer, fix [[map]] (more specific entries go first). If it is in the right layer, fix the code.");
        }
        return 0;
    }

    // every map entry: how many files it places, into which layers
    let total = mods.len().max(1);
    let mut by_rule: Vec<(String, usize, BTreeSet<String>)> = Vec::new();
    let mut unmapped = 0usize;
    for m in &mods {
        match m["rule"].as_str() {
            None => unmapped += 1,
            Some(g) => match by_rule.iter_mut().find(|x| x.0 == g) {
                Some(x) => {
                    x.1 += 1;
                    x.2.insert(s(m, "layer").to_string());
                }
                None => by_rule.push((g.to_string(), 1, BTreeSet::from([s(m, "layer").to_string()]))),
            },
        }
    }
    by_rule.sort_by_key(|x| std::cmp::Reverse(x.1));
    // a fallback: a `dir/**` glob with more specific entries under the same folder. Whatever it still
    // places was not placed on purpose — that is where misplaced files hide.
    let globs: Vec<String> = by_rule.iter().map(|x| x.0.clone()).collect();
    let catch_all = |g: &str, _n: usize| g.strip_suffix("**").is_some_and(|pre| !pre.contains('{') && globs.iter().any(|o| o != g && o.starts_with(pre)));
    let _ = total;
    let mut fired: Vec<(String, usize)> = Vec::new();
    for v in &viol {
        let r = s(v, "rule").to_string();
        match fired.iter_mut().find(|x| x.0 == r) {
            Some(x) => x.1 += 1,
            None => fired.push((r, 1)),
        }
    }
    fired.sort_by_key(|x| std::cmp::Reverse(x.1));
    if as_json {
        let entries: Vec<Value> = by_rule.iter().map(|(g, n, l)| json!({"glob": g, "files": n, "layers": l, "catchAll": catch_all(g, *n)})).collect();
        println!(
            "{}",
            serde_json::to_string_pretty(&json!({"files": mods.len(), "unmapped": unmapped, "map": entries,
            "firing": fired.iter().map(|(r, n)| json!({"rule": r, "findings": n})).collect::<Vec<_>>()}))
            .unwrap_or_default()
        );
        return 0;
    }
    println!("  {} files · {} unmapped", mods.len(), unmapped);
    println!("  [[map]] entries by files placed:");
    for (g, n, l) in by_rule.iter().take(15) {
        let flag = if catch_all(g, *n) { "  ⚠ fallback: these files were not placed on purpose — check each is really this layer" } else { "" };
        println!("    {n:6}  {g:48} → {}{flag}", l.iter().cloned().collect::<Vec<_>>().join(", "));
        if catch_all(g, *n) {
            let placed: Vec<&str> = mods.iter().filter(|m| m["rule"] == g.as_str()).filter_map(|m| m["id"].as_str()).collect();
            for f in placed.iter().take(10) {
                println!("              · {f}");
            }
            if placed.len() > 10 {
                println!("              · … {} more", placed.len() - 10);
            }
        }
    }
    if by_rule.len() > 15 {
        println!("    … {} more", by_rule.len() - 15);
    }
    if !fired.is_empty() {
        println!("  rules firing most:");
        for (r, n) in fired.iter().take(8) {
            println!("    {n:6}  {r}");
        }
    }
    println!("  `sprawler profile explain --file PATH` shows why one file is where it is.");
    0
}

fn profile_validate(t: &Target, as_json: bool) -> u8 {
    let (mut errors, mut warnings): (Vec<String>, Vec<String>) = (vec![], vec![]);
    let mut name = String::new();
    match resolve(t) {
        Err(e) => errors.push(e),
        Ok(p) => {
            name = p.get("name").and_then(Value::as_str).unwrap_or("").to_string();
            if let Err(e) = profile::policy(&p) {
                errors.push(e);
            }
            if let Err(e) = profile::classifier(&p) {
                errors.push(e);
            }
            let tier_list: Vec<&Value> = p.get("tiers").and_then(Value::as_array).map(|a| a.iter().collect()).unwrap_or_default();
            let mut tiers = BTreeSet::new();
            for tr in &tier_list {
                let id = s(tr, "id").to_string();
                if !tiers.insert(id.clone()) {
                    errors.push(format!("tier `{id}` is defined twice"));
                }
            }
            let layers: BTreeSet<String> = p.get("layers").and_then(Value::as_object).map(|o| o.keys().cloned().collect()).unwrap_or_default();
            for tr in &tier_list {
                for d in names(&tr["depends"]) {
                    if !tiers.contains(&d) {
                        errors.push(format!("tier `{}` depends on unknown tier `{d}`", s(tr, "id")));
                    }
                }
                if let Some(c) = tr["cross"].as_str() {
                    if !matches!(c, "allow" | "deny" | "declared") {
                        errors.push(format!("tier `{}`: cross must be allow, deny or declared (got `{c}`)", s(tr, "id")));
                    }
                }
            }
            let mut rule_ids = BTreeSet::new();
            for r in p.get("rules").and_then(Value::as_array).into_iter().flatten() {
                let id = s(r, "id");
                if id.is_empty() {
                    errors.push("a rule has no id".into());
                } else if !rule_ids.insert(id.to_string()) {
                    errors.push(format!("rule `{id}` is defined twice"));
                }
                let sev = r["severity"].as_str().unwrap_or("major");
                if !matches!(sev, "ok" | "minor" | "major" | "critical") {
                    errors.push(format!("rule `{id}`: severity must be ok, minor, major or critical (got `{sev}`)"));
                }
                for k in ["from_tier", "to_tier"] {
                    for x in names(&r[k]) {
                        if !tiers.contains(&x) {
                            errors.push(format!("rule `{id}`: {k} `{x}` is not a tier"));
                        }
                    }
                }
                for k in ["from_layer", "to_layer"] {
                    for x in names(&r[k]) {
                        if !layers.contains(&x) {
                            warnings.push(format!("rule `{id}`: {k} `{x}` is not a defined layer, so it never matches"));
                        }
                    }
                }
                if sev != "ok" && r["why"].as_str().is_none_or(str::is_empty) {
                    warnings.push(format!("rule `{id}` has no `why` — findings can't explain themselves to people or agents"));
                }
            }
            for (k, v) in p.get("allow").and_then(Value::as_object).into_iter().flatten() {
                if k != "*" && !layers.contains(k) {
                    warnings.push(format!("allow: `{k}` is not a defined layer"));
                }
                for x in names(v) {
                    if x != "*" && !layers.contains(&x) {
                        warnings.push(format!("allow.{k}: `{x}` is not a defined layer"));
                    }
                }
            }
            for m in p.get("map").and_then(Value::as_array).into_iter().flatten() {
                let (g, tier) = (s(m, "glob"), s(m, "tier"));
                if !tier.starts_with('@') && tier != "unmapped" && !tiers.contains(tier) {
                    errors.push(format!("map `{g}`: tier `{tier}` is not a tier"));
                }
                let ls: Vec<String> = std::iter::once(s(m, "layer").to_string())
                    .chain(m["layer_by_ctx"].as_object().into_iter().flatten().filter_map(|(_, v)| v.as_str().map(str::to_string)))
                    .filter(|l| !l.is_empty() && !l.starts_with('@'))
                    .collect();
                for l in ls {
                    if !layers.contains(&l) {
                        warnings.push(format!("map `{g}`: layer `{l}` is not a defined layer"));
                    }
                }
            }
            for (role, l) in p.get("roles").and_then(Value::as_object).into_iter().flatten() {
                if let Some(l) = l.as_str().filter(|l| !layers.contains(*l)) {
                    warnings.push(format!("roles.{role}: layer `{l}` is not defined"));
                }
            }
        }
    }
    let ok = errors.is_empty();
    if as_json {
        println!("{}", serde_json::to_string_pretty(&json!({"ok": ok, "profile": name, "errors": errors, "warnings": warnings})).unwrap_or_default());
    } else {
        let show = |label: &str, xs: &[String]| {
            for x in xs.iter().take(20) {
                println!("  {label} {x}");
            }
            if xs.len() > 20 {
                println!("  … {} more", xs.len() - 20);
            }
        };
        show("✗", &errors);
        show("⚠", &warnings);
        println!("  {} profile {name}: {} error(s), {} warning(s)", if ok { "✓" } else { "✗" }, errors.len(), warnings.len());
    }
    u8::from(!ok)
}

fn build(t: &Target) -> Result<Value, String> {
    atlas::build_atlas(&resolve(t)?, &local::Local)
}

pub fn run() -> ExitCode {
    let cli = Cli::parse();
    let r: Result<u8, String> = match cli.cmd {
        Cmd::Scan { t, out } => build(&t).and_then(|a| {
            std::fs::write(&out, a.to_string()).map_err(|e| format!("{out}: {e}"))?;
            eprintln!("wrote {out}");
            Ok(0)
        }),
        Cmd::Report { t, json } => build(&t).map(|a| {
            report(&a, json);
            0
        }),
        Cmd::Check { t, fail_on, min_score, baseline, json, format } => {
            let fmt = format.unwrap_or_else(|| if json { "json".into() } else { "text".into() });
            let b = baseline.as_deref().map(read_baseline).transpose();
            b.and_then(|b| build(&t).map(|a| check(&a, &fail_on, min_score, b.as_ref(), &fmt)))
        }
        Cmd::Badge { t, out, svg } => build(&t).and_then(|a| write_badge(&a, out.as_deref(), svg)),
        Cmd::Baseline { t, out } => build(&t).and_then(|a| {
            let out = out.unwrap_or_else(|| format!("{}/sprawler-baseline.json", s(&a["project"], "root")));
            write_baseline(&a, &out)
        }),
        Cmd::Prompts { t, rule, index } => build(&t).map(|a| {
            let mut vs: Vec<&Value> = a["violations"].as_array().map(|v| v.iter().collect()).unwrap_or_default();
            if let Some(r) = &rule {
                vs.retain(|v| s(v, "rule") == r);
            }
            if let Some(i) = index {
                vs = vs.into_iter().skip(i).take(1).collect();
            }
            if vs.is_empty() {
                eprintln!("no matching findings");
                return 1;
            }
            println!("{}", vs.iter().map(|v| s(v, "prompt")).collect::<Vec<_>>().join("\n\n---\n\n"));
            0
        }),
        Cmd::Serve { t, port, no_watch } => serve_target(&t).and_then(|(p, root)| serve::serve(p, &root, port, !no_watch)).map(|_| 0),
        Cmd::Discover { dir, json } => Ok(setup(&dir, false, false, json, true)),
        Cmd::Setup { dir, yes, shared, json } => Ok(setup(&dir, yes, shared, json, false)),
        Cmd::Doctor { json } => Ok(doctor(json)),
        Cmd::Plugin { cmd } => Ok(match cmd {
            PluginCmd::List { json } => plugin_list(json),
            PluginCmd::Test { exe, dir, json } => plugin_test(&exe, &dir, json),
            PluginCmd::Add { names, from } => plugin_add(&names, from.as_deref()),
            PluginCmd::Remove { names } => plugin_remove(&names),
        }),
        Cmd::Pack { cmd } => Ok(match cmd {
            PackCmd::List { json } => pack_list(json),
            PackCmd::Add { names, from } => pack_add(&names, from.as_deref()),
            PackCmd::Remove { names } => pack_remove(&names),
        }),
        Cmd::Profile { cmd: ProfileCmd::Validate { t, json } } => Ok(profile_validate(&t, json)),
        Cmd::Profile { cmd: ProfileCmd::Explain { t, file, json } } => Ok(profile_explain(&t, file.as_deref(), json)),
        Cmd::Profile { cmd: ProfileCmd::Init { dir, architecture, add, force } } => Ok(profile_init(&dir, &architecture, &add, force)),
    };
    match r {
        Ok(code) => ExitCode::from(code),
        Err(e) => {
            eprintln!("sprawler: {e}");
            ExitCode::from(2)
        }
    }
}
