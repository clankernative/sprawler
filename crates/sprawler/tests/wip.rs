//! Construction state on a real git repository, and the event diff across its lifecycle
//! (uncommitted work → commit). Runs the `sprawler` binary with the Roc analyzer.
use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::Value;
use sprawler_domain::events::{boot_events, diff_atlas};

fn git(root: &Path, args: &[&str]) {
    let o = Command::new("git")
        .args(["-c", "user.name=T", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", "-C"])
        .arg(root)
        .args(args)
        .output()
        .unwrap();
    assert!(o.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&o.stderr));
}

fn write(root: &Path, files: &[(&str, &str)]) {
    for (p, text) in files {
        let f = root.join(p);
        std::fs::create_dir_all(f.parent().unwrap()).unwrap();
        std::fs::write(f, text).unwrap();
    }
}

const PROFILE: &str = r#"
name = "wipfix"
root = "ROOT"
extensions = [".roc"]
include = ["INC/**"]
[analyzers.roc.options]
package_markers = ["main.roc"]
[[tiers]]
id = "app"
label = "APP"
depends = []
cross = "allow"
[layers.core]
[layers.adapter]
[allow]
core = ["core"]
adapter = ["*"]
[[map]]
glob = "INC/core/**"
tier = "app"
ctx = "main"
layer = "core"
[[map]]
glob = "INC/**"
tier = "app"
ctx = "main"
layer = "adapter"
"#;

struct Fixture {
    tmp: PathBuf,
    repo: PathBuf,
    profile: PathBuf,
}

impl Fixture {
    fn new(tag: &str) -> Option<Fixture> {
        if !Path::new(env!("CARGO_BIN_EXE_sprawler")).parent().unwrap().join("sprawler-analyzer-roc").is_file() {
            eprintln!("skipped: sprawler-analyzer-roc not built (cargo build --workspace)");
            return None;
        }
        let tmp = std::env::temp_dir().join(format!("sprawler-wip-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let repo = tmp.join("repo");
        write(
            &repo,
            &[
                ("pkg/main.roc", "package [A, B, D, F] {}\n"),
                ("pkg/core/A.roc", "module [a]\n\nimport B\n\na = |x| B.b(x)\n"),
                ("pkg/core/B.roc", "module [b]\n\nb = |x| x\n"),
                ("pkg/core/F.roc", "module [f]\n\nf = |x| x\n"),
                ("pkg/adapter/D.roc", "module [d]\n\nd = |x| x\n"),
                ("README.md", "hi\n"),
            ],
        );
        git(&repo, &["init", "-q"]);
        git(&repo, &["add", "-A"]);
        git(&repo, &["commit", "-qm", "init"]);
        let profile = tmp.join("profile.toml");
        std::fs::write(&profile, PROFILE.replace("ROOT", &repo.to_string_lossy()).replace("INC", "pkg")).unwrap();
        Some(Fixture { tmp, repo, profile })
    }

    fn scan(&self) -> Value {
        scan(&self.profile, &self.tmp)
    }

    fn edit(&self) {
        write(
            &self.repo,
            &[
                ("pkg/core/A.roc", "module [a]\n\nimport B\nimport D\n\na = |x| D.d(B.b(x))\n"), // +1 import
                ("pkg/core/E.roc", "module [e]\n\nimport B\n\ne = |x| B.b(x)\n"),                // untracked
                ("README.md", "changed\n"),                                                      // not a module
            ],
        );
        std::fs::remove_file(self.repo.join("pkg/core/F.roc")).unwrap(); // deleted
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.tmp);
    }
}

fn scan(profile: &Path, tmp: &Path) -> Value {
    let out = tmp.join("atlas.json");
    let o = Command::new(env!("CARGO_BIN_EXE_sprawler"))
        .args(["scan", "--profile", profile.to_str().unwrap(), "-o", out.to_str().unwrap()])
        .env("SPRAWLER_CONFIG_DIR", tmp.join("cfg"))
        .output()
        .unwrap();
    assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
    serde_json::from_str(&std::fs::read_to_string(out).unwrap()).unwrap()
}

fn module<'a>(a: &'a Value, id: &str) -> &'a Value {
    a["modules"].as_array().unwrap().iter().find(|m| m["id"] == id).unwrap_or_else(|| panic!("no module {id}"))
}

fn edge<'a>(a: &'a Value, s: &str, t: &str) -> &'a Value {
    a["edges"].as_array().unwrap().iter().find(|e| e["source"] == s && e["target"] == t).unwrap_or_else(|| panic!("no edge {s} → {t}"))
}

fn kinds(evs: &[Value]) -> Vec<&str> {
    evs.iter().map(|e| e["kind"].as_str().unwrap()).collect()
}

#[test]
fn clean_tree_has_no_wip() {
    let Some(f) = Fixture::new("clean") else { return };
    let a = f.scan();
    assert!(a["modules"].as_array().unwrap().iter().all(|m| m["wip"].is_null() && m["wipAdd"] == 0));
    assert_eq!((a["wip"]["files"].as_u64(), a["wip"]["git"].as_bool()), (Some(0), Some(true)));
    assert_eq!(a["wip"]["demolished"], serde_json::json!([]));
    assert!(a["edges"].as_array().unwrap().iter().all(|e| e["wip"] == false));
    // metrics on every file module, and the smell summary
    assert_eq!(module(&a, "pkg/core/A.roc")["metrics"]["fns"], 1);
    assert_eq!(module(&a, "pkg/core/A.roc")["metrics"]["churn"], 1);
    assert!(a["smells"]["limits"]["longFile"].is_number());
}

#[test]
fn module_wip_line_counts_and_edges() {
    let Some(f) = Fixture::new("edit") else { return };
    f.edit();
    let a = f.scan();
    let m = |id: &str| module(&a, id);
    assert_eq!(
        (m("pkg/core/A.roc")["wip"].as_str(), m("pkg/core/A.roc")["wipAdd"].as_u64(), m("pkg/core/A.roc")["wipDel"].as_u64()),
        (Some("mod"), Some(2), Some(1))
    );
    assert_eq!((m("pkg/core/E.roc")["wip"].as_str(), m("pkg/core/E.roc")["wipAdd"].as_u64()), (Some("new"), Some(5)));
    assert!(m("pkg/core/B.roc")["wip"].is_null());
    let w = &a["wip"];
    assert_eq!(w["demolished"], serde_json::json!([{"path": "pkg/core/F.roc", "ctx": "app:main", "tier": "app", "del": 3}]));
    assert_eq!((w["files"].as_u64(), w["new"].as_u64(), w["mod"].as_u64()), (Some(3), Some(1), Some(1)));
    assert_eq!((w["added"].as_u64(), w["deleted"].as_u64(), w["other"].as_u64()), (Some(7), Some(4), Some(1))); // other: README.md
    assert_eq!(w["contexts"], serde_json::json!(["app:main"]));
    // edges: imported at HEAD too / a new import in a modified file / from a new file
    assert_eq!(edge(&a, "pkg/core/A.roc", "pkg/core/B.roc")["wip"], false);
    assert_eq!(edge(&a, "pkg/core/A.roc", "pkg/adapter/D.roc")["wip"], true); // found by the HEAD text of A.roc
    assert_eq!(edge(&a, "pkg/core/E.roc", "pkg/core/B.roc")["wip"], true);
    let v = a["violations"].as_array().unwrap().iter().find(|v| v["source"] == "pkg/core/A.roc" && v["target"] == "pkg/adapter/D.roc").unwrap();
    assert_eq!(v["wip"], true); // core → adapter breach, uncommitted
    assert_eq!((w["violations"].as_u64(), w["edges"].as_u64()), (Some(1), Some(2)));
    assert_eq!(w["edgeBasis"]["other"], "head-text");
}

#[test]
fn staged_add_counts_as_new() {
    let Some(f) = Fixture::new("staged") else { return };
    write(&f.repo, &[("pkg/core/G.roc", "module [g]\n\ng = 1\n")]);
    git(&f.repo, &["add", "pkg/core/G.roc"]);
    let a = f.scan();
    assert_eq!((module(&a, "pkg/core/G.roc")["wip"].as_str(), module(&a, "pkg/core/G.roc")["wipAdd"].as_u64()), (Some("new"), Some(3)));
}

#[test]
fn subdirectory_root_and_repo_prefixes() {
    let Some(f) = Fixture::new("subdir") else { return };
    // profile rooted in a subdirectory of the repo: porcelain paths are toplevel-relative and get stripped
    let outer = f.tmp.join("outer");
    let inner = outer.join("inner");
    for p in ["pkg/main.roc", "pkg/core/A.roc", "pkg/core/B.roc"] {
        write(&inner, &[(p, &std::fs::read_to_string(f.repo.join(p)).unwrap())]);
    }
    git(&outer, &["init", "-q"]);
    git(&outer, &["add", "-A"]);
    git(&outer, &["commit", "-qm", "init"]);
    write(&inner, &[("pkg/core/E.roc", "module [e]\n\ne = 1\n")]);
    let sub = f.tmp.join("sub.toml");
    std::fs::write(&sub, PROFILE.replace("ROOT", &inner.to_string_lossy()).replace("INC", "pkg")).unwrap();
    let a = scan(&sub, &f.tmp);
    assert_eq!(module(&a, "pkg/core/E.roc")["wip"], "new");
    assert!(module(&a, "pkg/core/A.roc")["wip"].is_null());
    // multi-repo profile: ids carry the repo prefix
    let multi = f.tmp.join("multi.toml");
    let text = PROFILE
        .replace("ROOT", &f.tmp.to_string_lossy())
        .replace("INC", "outer/inner/pkg")
        .replace("name = \"wipfix\"", "name = \"wipfix\"\nrepos = [\"outer\"]");
    std::fs::write(&multi, text).unwrap();
    let a = scan(&multi, &f.tmp);
    assert_eq!(module(&a, "outer/inner/pkg/core/E.roc")["wip"], "new");
    assert_eq!(a["project"]["repos"][0]["repo"], "outer");
}

#[test]
fn events_across_the_lifecycle() {
    let Some(f) = Fixture::new("events") else { return };
    let base = f.scan();
    assert_eq!(kinds(&boot_events(&base, None, &Default::default())), ["boot"]);
    f.edit();
    let mid = f.scan();
    let evs = diff_atlas(&base, &mid);
    for k in ["build.start", "build.renovate", "build.demolish"] {
        assert!(kinds(&evs).contains(&k), "{k} missing from {:?}", kinds(&evs));
    }
    let cut = evs.iter().find(|e| e["kind"] == "track.cut").expect("track.cut");
    assert_eq!((cut["wip"].as_bool(), cut["sev"].as_str()), (Some(true), Some("bad")));
    git(&f.repo, &["add", "-A"]);
    git(&f.repo, &["commit", "-qm", "ship it"]);
    let done = f.scan();
    let evs = diff_atlas(&mid, &done);
    assert!(kinds(&evs).contains(&"commit"));
    assert!(kinds(&evs).contains(&"build.cleared"));
    let opened: Vec<&str> = evs.iter().filter(|e| e["kind"] == "build.open").map(|e| e["module"].as_str().unwrap()).collect();
    assert_eq!(opened, ["pkg/core/A.roc", "pkg/core/E.roc"]);
    assert!(evs.iter().filter(|e| e["kind"] == "build.open").all(|e| e["subject"] == "ship it"));
    // the violation is now committed
    let recut = evs.iter().find(|e| e["kind"] == "track.cut").unwrap();
    assert_eq!((recut["wip"].as_bool(), recut["from"].as_str()), (Some(false), Some("wip")));
}
