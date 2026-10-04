//! `sprawler demo` (driving adapter): a living map for showing people.
//!
//! Copies the workspace's committed files (`git archive` per repo) into a throwaway sandbox, never
//! touching the real repo, serves it, and stages a day of work in a loop: new files go up, an edit, a
//! file is deleted, someone sneaks in an import that breaks a rule (when the platform has a Roc
//! `internal` module), it all gets committed, the shortcut is fixed, and every few days the sandbox
//! is reset to its founding commit.
use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use serde_json::{json, Value};

use crate::profile::{resolve_path, Obj};
use crate::{atlas, local, serve};

const AUTHORS: [&str; 5] = ["Ada Lovelace", "Grace Hopper", "Linus T.", "Margaret H.", "Ken T."];
const EMAIL: &str = "demo@sprawler.local";
const PREFIX: &str = "sprawler-demo-";

fn say(msg: &str) {
    eprintln!("[demo] {msg}");
}

/// git in `dir`, as the demo user, never signing; stdout, or the error.
fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    let o = Command::new("git")
        .args(["-c", "user.name=Sprawler demo", "-c", &format!("user.email={EMAIL}"), "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main"])
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .map_err(|e| format!("git: {e}"))?;
    if o.status.success() {
        Ok(String::from_utf8_lossy(&o.stdout).into_owned())
    } else {
        Err(format!("git {} in {}: {}", args.join(" "), dir.display(), String::from_utf8_lossy(&o.stderr).trim()))
    }
}

/// A demo started by a process that is gone left its folders behind (Ctrl-C ends a demo): remove them.
fn sweep(dir: &Path, prefix: &str) {
    for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let Some(pid) = name.strip_prefix(prefix).and_then(|p| p.parse::<u32>().ok()) else { continue };
        if pid != std::process::id() && !alive(pid) {
            let _ = std::fs::remove_dir_all(e.path());
        }
    }
}

fn alive(pid: u32) -> bool {
    if cfg!(unix) {
        Command::new("kill").args(["-0", &pid.to_string()]).stderr(Stdio::null()).status().is_ok_and(|s| s.success())
    } else {
        true // no cheap check: keep it
    }
}

/// Committed files only (`git archive HEAD`), as fresh repos with one founding commit each.
fn make_sandbox(root: &Path, repos: &[String]) -> Result<PathBuf, String> {
    let tmp = std::env::temp_dir();
    sweep(&tmp, PREFIX);
    let sandbox = tmp.join(format!("{PREFIX}{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&sandbox);
    let pairs: Vec<(PathBuf, PathBuf)> =
        if repos.is_empty() { vec![(root.to_path_buf(), sandbox.clone())] } else { repos.iter().map(|r| (root.join(r), sandbox.join(r))).collect() };
    for (src, dst) in pairs {
        std::fs::create_dir_all(&dst).map_err(|e| format!("{}: {e}", dst.display()))?;
        let top = git(&src, &["rev-parse", "--show-toplevel"])
            .map_err(|_| format!("{} is not in a git repository; the demo copies committed files", src.display()))?;
        let prefix = git(&src, &["rev-parse", "--show-prefix"])?.trim().to_string();
        let arch = Command::new("git")
            .arg("-C")
            .arg(top.trim())
            .args(["archive", "HEAD", if prefix.is_empty() { "." } else { &prefix }])
            .output()
            .map_err(|e| format!("git archive: {e}"))?;
        if !arch.status.success() {
            return Err(format!("git archive in {}: {}", src.display(), String::from_utf8_lossy(&arch.stderr).trim()));
        }
        let mut tar = Command::new("tar");
        tar.arg("-x").arg("-C").arg(&dst).stdin(Stdio::piped());
        if !prefix.is_empty() {
            tar.args(["--strip-components", &prefix.trim_end_matches('/').split('/').count().to_string()]);
        }
        let mut child = tar.spawn().map_err(|e| format!("tar: {e}"))?;
        child.stdin.take().ok_or("tar: no stdin")?.write_all(&arch.stdout).map_err(|e| format!("tar: {e}"))?;
        if !child.wait().is_ok_and(|s| s.success()) {
            return Err(format!("tar could not unpack {}", src.display()));
        }
        git(&dst, &["init", "-q"])?;
        git(&dst, &["add", "-A"])?;
        git(&dst, &["commit", "-qm", "City founded (demo baseline)"])?;
    }
    Ok(sandbox)
}

/// Every string in the profile that points into the real workspace now points into the sandbox.
fn rebase(v: &mut Value, from: &str, to: &str) {
    match v {
        Value::String(s) if s == from || s.starts_with(&format!("{from}/")) => *s = format!("{to}{}", &s[from.len()..]),
        Value::Array(a) => a.iter_mut().for_each(|x| rebase(x, from, to)),
        Value::Object(o) => o.values_mut().for_each(|x| rebase(x, from, to)),
        _ => {}
    }
}

/// Small deterministic generator (xorshift): the same demo every time.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n.max(1) as u64) as usize
    }
    fn shuffle<T>(&mut self, xs: &mut [T]) {
        for i in (1..xs.len()).rev() {
            xs.swap(i, self.below(i + 1));
        }
    }
}

#[derive(Clone)]
struct Site {
    id: String,
    layer: String,
}

/// Stages one day of work per cycle, saying what it does.
struct Director {
    root: PathBuf,
    repos: Vec<String>,
    pace: f64,
    rng: Rng,
    stages: Vec<String>,
    by_ctx: BTreeMap<String, Vec<Site>>,
    /// An import that breaks a rule: an app reaching into a runtime-internal Roc module.
    leak: Option<String>,
}

fn comment_mark(ext: &str) -> &'static str {
    match ext {
        "rs" | "cs" | "ts" | "tsx" | "js" | "jsx" | "go" | "java" | "kt" | "swift" | "c" | "cpp" | "h" => "//",
        _ => "#",
    }
}

fn stem_ext(p: &Path) -> (String, String) {
    (p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default(), p.extension().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default())
}

impl Director {
    fn new(a: &Value, root: PathBuf, repos: Vec<String>, pace: f64) -> Director {
        let s = |v: &Value, k: &str| v[k].as_str().unwrap_or("").to_string();
        let mut by_ctx: BTreeMap<String, Vec<Site>> = BTreeMap::new();
        for m in a["modules"].as_array().into_iter().flatten() {
            if m["path"].is_string() && m["generated"] != true && m["test"] != true {
                by_ctx.entry(s(m, "ctx")).or_default().push(Site { id: s(m, "id"), layer: s(m, "layer") });
            }
        }
        let first_tier = a["tiers"].get(0).map(|t| s(t, "id"));
        let mut stages: Vec<String> =
            by_ctx.iter().filter(|(k, v)| v.len() >= 6 && first_tier.as_ref().is_none_or(|t| k.split(':').next() == Some(t))).map(|(k, _)| k.clone()).collect();
        if stages.is_empty() {
            stages = by_ctx.iter().filter(|(_, v)| v.len() >= 4).map(|(k, _)| k.clone()).collect();
        }
        let leak = a["modules"].as_array().into_iter().flatten().find(|m| m["layer"] == "internal" && m["lang"] == "roc").map(|m| s(m, "id"));
        Director { root, repos, pace, rng: Rng(7), stages, by_ctx, leak }
    }

    fn wait(&self, secs: f64) {
        std::thread::sleep(Duration::from_secs_f64((secs * self.pace).max(0.0)));
    }

    /// The repo folder holding a module id, and the id relative to it.
    fn repo_of(&self, id: &str) -> (PathBuf, String) {
        match self.repos.iter().find(|r| id.starts_with(&format!("{r}/"))) {
            Some(r) => (self.root.join(r), id[r.len() + 1..].to_string()),
            None => (self.root.clone(), id.to_string()),
        }
    }

    fn repo_dirs(&self) -> Vec<PathBuf> {
        if self.repos.is_empty() {
            vec![self.root.clone()]
        } else {
            self.repos.iter().map(|r| self.root.join(r)).collect()
        }
    }

    fn commit(&mut self, repo: &Path, msg: &str) -> Result<(), String> {
        let author = AUTHORS[self.rng.below(AUTHORS.len())];
        git(repo, &["add", "-A"])?;
        let who = format!("{author} <{EMAIL}>");
        // nothing staged (already reset) is fine
        let _ = git(repo, &["-c", &format!("user.name={author}"), "commit", "-qm", msg, "--author", &who]);
        say(&format!("commit by {author}: {msg}"));
        Ok(())
    }

    fn cycle(&mut self, n: usize) -> Result<(), String> {
        if self.stages.is_empty() {
            return Ok(());
        }
        let ctx = self.stages[self.rng.below(self.stages.len())].clone();
        let mut pool: Vec<Site> = self.by_ctx[&ctx].iter().filter(|m| self.root.join(&m.id).exists()).cloned().collect();
        self.rng.shuffle(&mut pool);
        if pool.len() < 3 {
            return Ok(());
        }
        let label = ctx.rsplit(':').next().unwrap_or(&ctx).to_string();
        let (a, b, c) = (pool[0].clone(), pool[1].clone(), pool[2].clone());
        let (repo, _) = self.repo_of(&a.id);

        // 1 · ground breaking: one or two new files next to an existing one
        let src = self.root.join(&a.id);
        let (stem, ext) = stem_ext(&src);
        let text = std::fs::read_to_string(&src).map_err(|e| format!("{}: {e}", src.display()))?;
        let mut news = Vec::new();
        for suffix in ["Archive", "ArchiveTypes"].iter().take(1 + n % 2) {
            let name = format!("{stem}{suffix}{n}");
            let dst = src.with_file_name(if ext.is_empty() { name.clone() } else { format!("{name}.{ext}") });
            std::fs::write(&dst, text.replace(&stem, &name)).map_err(|e| format!("{}: {e}", dst.display()))?;
            news.push(dst);
        }
        let names: Vec<String> = news.iter().map(|d| d.file_name().unwrap_or_default().to_string_lossy().into_owned()).collect();
        say(&format!("{label}: ground broken on {}", names.join(", ")));
        self.wait(8.0);

        // 2 · renovation: an edit to another building
        let p = self.root.join(&b.id);
        let (bstem, bext) = stem_ext(&p);
        let mut f = std::fs::OpenOptions::new().append(true).open(&p).map_err(|e| format!("{}: {e}", p.display()))?;
        let _ = writeln!(f, "\n{} demo: second pass on {bstem} ({n})", comment_mark(&bext));
        say(&format!("{label}: scaffolding on {}", p.file_name().unwrap_or_default().to_string_lossy()));
        self.wait(8.0);

        // 3 · demolition
        if !matches!(c.layer.as_str(), "root" | "core" | "composition") {
            let (crepo, rel) = self.repo_of(&c.id);
            if git(&crepo, &["rm", "-q", &rel]).is_ok() {
                say(&format!("{label}: wrecking ball on {}", Path::new(&rel).file_name().unwrap_or_default().to_string_lossy()));
                self.wait(8.0);
            }
        }

        // 4 · an unpermitted dirt road, where we know a forbidden import for this language
        let mut leaked: Option<(PathBuf, String)> = None;
        if let (Some(leak), "roc") = (&self.leak, ext.as_str()) {
            let target = stem_ext(Path::new(leak)).0;
            let line = format!("import pf.{target}");
            let body = std::fs::read_to_string(&news[0]).unwrap_or_default();
            std::fs::write(&news[0], format!("{line}\n{body}")).map_err(|e| e.to_string())?;
            say(&format!("{label}: {} bulldozes an unpermitted road into {target}", names[0]));
            leaked = Some((news[0].clone(), line));
            self.wait(14.0);
        }

        // 5 · everything ships
        self.commit(&repo, &format!("{label}: archive flow ({n})"))?;
        self.wait(18.0);

        // 6 · the shortcut gets fixed
        if let Some((file, line)) = leaked.filter(|(f, _)| f.exists()) {
            let body = std::fs::read_to_string(&file).unwrap_or_default();
            let kept: Vec<&str> = body.lines().filter(|l| l.trim() != line).collect();
            std::fs::write(&file, kept.join("\n") + "\n").map_err(|e| e.to_string())?;
            say(&format!("{label}: the shortcut from {} is closed", names[0]));
            self.wait(6.0);
            self.commit(&repo, &format!("{label}: go through the SDK port instead ({n})"))?;
            self.wait(10.0);
        }
        Ok(())
    }

    fn run(&mut self) {
        if self.stages.is_empty() {
            say("no context has enough files to stage work in; serving the sandbox as it is");
            return;
        }
        let mut n = 1;
        loop {
            if let Err(e) = self.cycle(n) {
                say(&format!("cycle failed: {e}")); // a demo keeps going
            }
            n += 1;
            if n % 6 == 0 {
                // keep the city from drifting forever: back to the founding commit
                for repo in self.repo_dirs() {
                    let base = git(&repo, &["rev-list", "--max-parents=0", "HEAD"]).unwrap_or_default();
                    if let Some(base) = base.lines().next() {
                        let _ = git(&repo, &["reset", "-q", "--hard", base]);
                        let _ = git(&repo, &["clean", "-qfd"]);
                    }
                }
                say("the city is reset to its founding day");
                self.wait(10.0);
            }
        }
    }
}

/// Copy, serve, and stage work until interrupted.
pub fn run_demo(p: &Obj, port: u16, pace: f64) -> Result<(), String> {
    let root = p.get("root").and_then(Value::as_str).ok_or("profile has no root")?.to_string();
    let repos: Vec<String> = p.get("repos").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_string).collect();
    let sandbox = make_sandbox(Path::new(&root), &repos)?;
    let sb = sandbox.to_string_lossy().into_owned();
    let mut demo = Value::Object(p.clone());
    rebase(&mut demo, &root, &sb);
    let name = p.get("name").and_then(Value::as_str).unwrap_or("workspace");
    let title = p.get("title").and_then(Value::as_str).filter(|t| !t.is_empty()).unwrap_or(name);
    demo["root"] = json!(sb);
    demo["name"] = json!(format!("{name}-demo"));
    demo["title"] = json!(format!("{title} · DEMO"));
    // a fresh event log and plugin cache per demo; leftovers of finished demos are swept
    sweep(&resolve_path("~/.cache/sprawler"), "demo-");
    demo["cache_key"] = json!(format!("demo-{}", std::process::id()));
    let demo: Obj = demo.as_object().cloned().unwrap_or_default();
    say(&format!("sandbox {sb}  (the real repo is never touched)"));

    let first = atlas::build_atlas(&demo, &local::Local)?;
    let mut director = Director::new(&first, sandbox.clone(), repos, pace);
    std::thread::spawn(move || {
        director.wait(12.0); // let the server's first scan land
        director.run();
    });
    serve::serve(Some(demo), &sandbox, port, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rebase_rewrites_paths_into_the_sandbox() {
        let mut v = json!({"root": "/w", "analyzers": {"roc": {"options": {"x": "/w/platform", "y": "/other", "z": "/wx"}}}, "repos": ["a"]});
        rebase(&mut v, "/w", "/tmp/s");
        assert_eq!((v["root"].as_str(), v["analyzers"]["roc"]["options"]["x"].as_str()), (Some("/tmp/s"), Some("/tmp/s/platform")));
        assert_eq!((v["analyzers"]["roc"]["options"]["y"].as_str(), v["analyzers"]["roc"]["options"]["z"].as_str()), (Some("/other"), Some("/wx")));
    }

    #[test]
    fn director_picks_stages_and_leak() {
        let mods: Vec<Value> = (0..6)
            .map(|i| json!({"id": format!("app/src/M{i}.roc"), "path": format!("app/src/M{i}.roc"), "ctx": "app:main", "layer": "core", "lang": "roc"}))
            .chain([json!({"id": "pf/Wire.roc", "path": "pf/Wire.roc", "ctx": "platform:pf", "layer": "internal", "lang": "roc"})])
            .collect();
        let a = json!({"tiers": [{"id": "app"}, {"id": "platform"}], "modules": mods});
        let d = Director::new(&a, PathBuf::from("/s"), vec!["app".into()], 1.0);
        assert_eq!(d.stages, ["app:main"]);
        assert_eq!(d.leak.as_deref(), Some("pf/Wire.roc"));
        assert_eq!(d.repo_of("app/src/M1.roc"), (PathBuf::from("/s/app"), "src/M1.roc".to_string()));
        let mut r = Rng(7);
        let mut xs = [1, 2, 3, 4, 5];
        r.shuffle(&mut xs);
        let mut sorted = xs;
        sorted.sort();
        assert_eq!(sorted, [1, 2, 3, 4, 5]);
    }
}
