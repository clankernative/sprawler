//! Native Rust module resolution: follow each crate's real `mod` tree and resolve `use` trees and
//! `crate::` / `super::` / `self::` / dependency paths to the files that define them.
//!
//! Graphify matches names; this follows the compiler's module rules, so grouped imports like
//! `use crate::{a, b::{self, C}}` become links. Cross-crate links only follow Cargo path
//! dependencies. What can't be resolved (a `mod x;` with no file, `super` past the crate root) is
//! reported, never guessed.
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::Path;

use regex::Regex;

pub struct Link {
    pub source: String,
    pub target: String,
    pub relation: &'static str,
    pub line: u64,
}

#[derive(Default)]
pub struct Native {
    pub links: Vec<Link>,
    /// Cargo.toml → Cargo.toml path dependencies between scanned crates.
    pub declared: Vec<(String, String)>,
    pub unresolved_mods: Vec<String>,
    /// `super` paths that climb past the crate root.
    pub unresolved: u64,
    /// `.rs` files no crate root reaches through `mod` declarations.
    pub orphans: Vec<String>,
}

fn dirname(p: &str) -> &str {
    p.rsplit_once('/').map_or("", |(d, _)| d)
}

fn basename(p: &str) -> &str {
    p.rsplit('/').next().unwrap_or(p)
}

fn stem(p: &str) -> &str {
    basename(p).strip_suffix(".rs").unwrap_or(basename(p))
}

fn join(a: &str, b: &str) -> String {
    if a.is_empty() {
        b.to_string()
    } else if b.is_empty() {
        a.to_string()
    } else {
        format!("{a}/{b}")
    }
}

fn normpath(p: &str) -> String {
    let mut out: Vec<&str> = Vec::new();
    for c in p.split('/') {
        match c {
            "" | "." => {}
            ".." if out.last().is_some_and(|x| *x != "..") => {
                out.pop();
            }
            x => out.push(x),
        }
    }
    out.join("/")
}

fn line_of(text: &str, pos: usize) -> u64 {
    text.as_bytes()[..pos].iter().filter(|&&c| c == b'\n').count() as u64 + 1
}

/// Blank comments, string and char literals (same byte length, newlines kept) so regexes only see code.
pub fn strip(src: &str) -> String {
    let b = src.as_bytes();
    let n = b.len();
    let mut out = b.to_vec();
    let blank = |out: &mut Vec<u8>, from: usize, to: usize| {
        for x in out.iter_mut().take(to.min(n)).skip(from) {
            if *x != b'\n' {
                *x = b' ';
            }
        }
    };
    let mut i = 0;
    while i < n {
        let c = b[i];
        if c == b'/' && i + 1 < n && b[i + 1] == b'/' {
            let s = i;
            while i < n && b[i] != b'\n' {
                i += 1;
            }
            blank(&mut out, s, i);
            continue;
        }
        if c == b'/' && i + 1 < n && b[i + 1] == b'*' {
            let (s, mut depth) = (i, 0i32);
            while i < n {
                if b[i] == b'/' && i + 1 < n && b[i + 1] == b'*' {
                    depth += 1;
                    i += 2;
                } else if b[i] == b'*' && i + 1 < n && b[i + 1] == b'/' {
                    depth -= 1;
                    i += 2;
                    if depth == 0 {
                        break;
                    }
                } else {
                    i += 1;
                }
            }
            blank(&mut out, s, i);
            continue;
        }
        let after_ident = i > 0 && (b[i - 1].is_ascii_alphanumeric() || b[i - 1] == b'_');
        if !after_ident && (c == b'r' || (c == b'b' && i + 1 < n && b[i + 1] == b'r')) {
            let mut j = i + if c == b'b' { 2 } else { 1 };
            let mut hashes = 0;
            while j < n && b[j] == b'#' {
                hashes += 1;
                j += 1;
            }
            if j < n && b[j] == b'"' {
                let s = i;
                j += 1;
                while j < n {
                    if b[j] == b'"' && (0..hashes).all(|k| j + 1 + k < n && b[j + 1 + k] == b'#') {
                        j += 1 + hashes;
                        break;
                    }
                    j += 1;
                }
                blank(&mut out, s, j);
                i = j;
                continue;
            }
        }
        if c == b'"' {
            let s = i;
            i += 1;
            while i < n && b[i] != b'"' {
                i += if b[i] == b'\\' { 2 } else { 1 };
            }
            blank(&mut out, s + 1, i);
            i += 1;
            continue;
        }
        if c == b'\'' {
            if i + 2 < n && b[i + 1] == b'\\' {
                let s = i;
                i += 3;
                while i < n && b[i] != b'\'' {
                    i += 1;
                }
                i += 1;
                blank(&mut out, s, i);
                continue;
            }
            if i + 1 < n {
                let len = match b[i + 1] {
                    x if x < 0x80 => 1,
                    x if x >= 0xF0 => 4,
                    x if x >= 0xE0 => 3,
                    _ => 2,
                };
                let j = i + 1 + len;
                if j < n && b[j] == b'\'' {
                    blank(&mut out, i, j + 1);
                    i = j + 1;
                    continue;
                }
            }
            i += 1; // a lifetime
            continue;
        }
        i += 1;
    }
    String::from_utf8(out).unwrap_or_default()
}

fn tokens(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let cs: Vec<char> = s.chars().collect();
    let mut i = 0;
    let flush = |cur: &mut String, out: &mut Vec<String>| {
        if !cur.is_empty() {
            out.push(std::mem::take(cur));
        }
    };
    while i < cs.len() {
        let c = cs[i];
        if c.is_alphanumeric() || c == '_' {
            cur.push(c);
        } else {
            flush(&mut cur, &mut out);
            if c == ':' && i + 1 < cs.len() && cs[i + 1] == ':' {
                out.push("::".into());
                i += 1;
            } else if matches!(c, '{' | '}' | ',' | '*') {
                out.push(c.to_string());
            }
        }
        i += 1;
    }
    flush(&mut cur, &mut out);
    out
}

fn parse_tree(t: &[String], i: &mut usize, mut path: Vec<String>, out: &mut Vec<Vec<String>>) {
    let base = path.len();
    let mut group_self = false;
    while *i < t.len() {
        match t[*i].as_str() {
            "::" => *i += 1,
            "{" => {
                *i += 1;
                while *i < t.len() && t[*i] != "}" {
                    if t[*i] == "," {
                        *i += 1;
                        continue;
                    }
                    let before = *i;
                    parse_tree(t, i, path.clone(), out);
                    if *i == before {
                        *i += 1;
                    }
                }
                *i += 1;
                return;
            }
            "*" => {
                *i += 1;
                let mut g = path;
                g.push("*".into());
                out.push(g);
                return;
            }
            "," | "}" => break,
            "as" => {
                *i += 2;
                break;
            }
            "self" if path.len() == base && base > 0 => {
                group_self = true;
                *i += 1;
            }
            id => {
                path.push(id.to_string());
                *i += 1;
            }
        }
    }
    if path.len() > base || group_self {
        out.push(path);
    }
}

/// `crate::{a, b::{self, C}, d::*}` → `[crate a] [crate b] [crate b C] [crate d]`.
pub fn expand_use(tree: &str) -> Vec<Vec<String>> {
    let t = tokens(tree);
    let mut out = Vec::new();
    let mut i = 0;
    while i < t.len() {
        let before = i;
        parse_tree(&t, &mut i, Vec::new(), &mut out);
        if i == before {
            i += 1;
        }
    }
    out
}

fn read_toml(root: &Path, rel: &str) -> Option<toml::Table> {
    toml::from_str(&std::fs::read_to_string(root.join(rel)).ok()?).ok()
}

type WsCache = HashMap<String, Option<(String, toml::Table)>>;

/// `foo = { workspace = true }` → the path in the nearest `[workspace.dependencies]`.
fn workspace_dep(root: &Path, dir: &str, key: &str, cache: &mut WsCache) -> Option<String> {
    let mut d = dir.to_string();
    loop {
        let entry =
            cache.entry(d.clone()).or_insert_with(|| read_toml(root, &join(&d, "Cargo.toml")).filter(|t| t.contains_key("workspace")).map(|t| (d.clone(), t)));
        if let Some((wd, t)) = entry {
            let p = t.get("workspace")?.get("dependencies")?.get(key)?.get("path")?.as_str()?;
            return Some(normpath(&join(wd.as_str(), p)));
        }
        if d.is_empty() {
            return None;
        }
        d = dirname(&d).to_string();
    }
}

struct Crate {
    dir: String,
    cargo: String,
    lib_name: String,
    lib_root: Option<String>,
    roots: Vec<String>,
    deps: Vec<(String, String)>,
}

fn parse_crates(root: &Path, cargos: &[&str], rs: &HashSet<&str>) -> Vec<Crate> {
    let mut ws: WsCache = HashMap::new();
    let mut crates = Vec::new();
    for c in cargos {
        let Some(t) = read_toml(root, c) else { continue };
        let Some(pkg) = t.get("package").and_then(|v| v.as_table()) else { continue };
        let dir = dirname(c).to_string();
        let pname = pkg.get("name").and_then(|v| v.as_str()).unwrap_or("").replace('-', "_");
        let lib = t.get("lib").and_then(|v| v.as_table());
        let lib_name = lib.and_then(|l| l.get("name")).and_then(|v| v.as_str()).map_or(pname, |s| s.replace('-', "_"));
        let lib_rel = lib.and_then(|l| l.get("path")).and_then(|v| v.as_str()).map_or_else(|| join(&dir, "src/lib.rs"), |p| normpath(&join(&dir, p)));
        let lib_root = rs.contains(lib_rel.as_str()).then_some(lib_rel);
        let mut roots: Vec<String> = lib_root.iter().cloned().collect();
        for cand in ["src/main.rs", "build.rs"] {
            let p = join(&dir, cand);
            if rs.contains(p.as_str()) {
                roots.push(p);
            }
        }
        let mut extra: Vec<String> = Vec::new();
        for b in t.get("bin").and_then(|v| v.as_array()).into_iter().flatten() {
            if let Some(p) = b.get("path").and_then(|v| v.as_str()) {
                extra.push(normpath(&join(&dir, p)));
            }
        }
        let prefix = if dir.is_empty() { String::new() } else { format!("{dir}/") };
        for f in rs {
            let Some(rest) = f.strip_prefix(prefix.as_str()) else { continue };
            let parts: Vec<&str> = rest.split('/').collect();
            let target_root = match parts.as_slice() {
                ["src", "bin", _] | ["src", "bin", _, "main.rs"] => true,
                [d, _] | [d, _, "main.rs"] => matches!(*d, "tests" | "examples" | "benches"),
                _ => false,
            };
            if target_root {
                extra.push(f.to_string());
            }
        }
        extra.sort();
        for e in extra {
            if rs.contains(e.as_str()) && !roots.contains(&e) {
                roots.push(e);
            }
        }
        let mut tables: Vec<&toml::Table> = Vec::new();
        const KINDS: [&str; 3] = ["dependencies", "dev-dependencies", "build-dependencies"];
        for k in KINDS {
            tables.extend(t.get(k).and_then(|v| v.as_table()));
        }
        for (_, v) in t.get("target").and_then(|v| v.as_table()).into_iter().flatten() {
            for k in KINDS {
                tables.extend(v.get(k).and_then(|v| v.as_table()));
            }
        }
        let mut deps = Vec::new();
        for tb in tables {
            for (key, v) in tb {
                let Some(vt) = v.as_table() else { continue };
                let target = match vt.get("path").and_then(|v| v.as_str()) {
                    Some(p) => Some(normpath(&join(&dir, p))),
                    None if vt.get("workspace").and_then(|v| v.as_bool()) == Some(true) => workspace_dep(root, &dir, key, &mut ws),
                    None => None,
                };
                if let Some(td) = target {
                    deps.push((key.replace('-', "_"), td));
                }
            }
        }
        crates.push(Crate { dir, cargo: c.to_string(), lib_name, lib_root, roots, deps });
    }
    crates
}

fn inline_spans(t: &str, re: &Regex) -> Vec<(usize, usize, String)> {
    let b = t.as_bytes();
    let mut out = Vec::new();
    for c in re.captures_iter(t) {
        let m = c.get(0).unwrap();
        let (mut depth, mut j) = (0i32, m.end() - 1);
        while j < b.len() {
            match b[j] {
                b'{' => depth += 1,
                b'}' => {
                    depth -= 1;
                    if depth == 0 {
                        break;
                    }
                }
                _ => {}
            }
            j += 1;
        }
        out.push((m.start(), j, c[1].to_string()));
    }
    out
}

type Modules = HashMap<(String, Vec<String>), String>;
type Reexports = HashMap<String, Vec<(String, String, Option<String>)>>;

/// Start of the attribute lines (`#[...]`) directly above `pos`'s line.
fn attr_start(s: &str, pos: usize) -> usize {
    let mut start = s[..pos].rfind('\n').map_or(0, |i| i + 1);
    while start > 0 {
        let prev_end = start - 1;
        let prev_start = s[..prev_end].rfind('\n').map_or(0, |i| i + 1);
        if s[prev_start..prev_end].trim_start().starts_with("#[") {
            start = prev_start;
        } else {
            break;
        }
    }
    start
}

/// The file that actually defines `item` when it is reached through `file`: follows `pub use`
/// re-exports (named and glob), so `crate::Foo` links to Foo's file, not to the crate root.
/// Re-exports are only followed inside one crate: a dependency's `pub use` of a third crate is what
/// the caller sees, and Cargo only links the caller to that dependency.
fn follow(defs: &HashMap<&str, HashSet<String>>, reexp: &Reexports, crate_of: &HashMap<String, String>, file: &str, item: Option<&str>, depth: u8) -> String {
    let same = |t: &str| crate_of.get(t).is_some() && crate_of.get(t) == crate_of.get(file);
    let Some(name) = item else { return file.to_string() };
    if depth > 4 || defs.get(file).is_some_and(|d| d.contains(name)) {
        return file.to_string();
    }
    if let Some(list) = reexp.get(file) {
        if let Some((_, t, ti)) = list.iter().find(|(n, _, _)| n == name) {
            return if same(t) { follow(defs, reexp, crate_of, t, ti.as_deref().or(Some(name)), depth + 1) } else { file.to_string() };
        }
        for (_, t, _) in list.iter().filter(|(n, t, _)| n == "*" && same(t)) {
            let r = follow(defs, reexp, crate_of, t, Some(name), depth + 1);
            if r != *t || defs.get(t.as_str()).is_some_and(|d| d.contains(name)) {
                return r;
            }
        }
    }
    file.to_string()
}

enum Res {
    /// the module file the path reaches, and the item name left over (if any)
    Ours(String, Option<String>),
    Unresolved,
}

fn resolve(modules: &Modules, externs: &HashMap<String, HashMap<String, String>>, root: &str, cur: &[String], segs: &[&str]) -> Option<Res> {
    let has = |r: &str, p: &[String]| modules.contains_key(&(r.to_string(), p.to_vec()));
    let mut trunc = cur.to_vec();
    while !trunc.is_empty() && !has(root, &trunc) {
        trunc.pop();
    }
    let (base, mut path, rest): (String, Vec<String>, &[&str]) = match *segs.first()? {
        "crate" => (root.to_string(), vec![], &segs[1..]),
        "self" => (root.to_string(), trunc.clone(), &segs[1..]),
        "super" => {
            let (mut p, mut i) = (cur.to_vec(), 0);
            while i < segs.len() && segs[i] == "super" {
                if p.pop().is_none() {
                    return Some(Res::Unresolved);
                }
                i += 1;
            }
            while !p.is_empty() && !has(root, &p) {
                p.pop();
            }
            (root.to_string(), p, &segs[i..])
        }
        first => {
            if let Some(l) = externs.get(root).and_then(|e| e.get(first)) {
                (l.clone(), vec![], &segs[1..])
            } else {
                let child = |base: &[String]| {
                    let mut c = base.to_vec();
                    c.push(first.to_string());
                    c
                };
                let (c1, c2) = (child(cur), child(&trunc));
                if has(root, &c1) {
                    (root.to_string(), c1, &segs[1..])
                } else if has(root, &c2) {
                    (root.to_string(), c2, &segs[1..])
                } else {
                    return None; // std, an external crate, or a type
                }
            }
        }
    };
    if !has(&base, &path) {
        return None; // a dependency whose source isn't scanned
    }
    let mut k = 0;
    for s in rest {
        path.push(s.to_string());
        if !has(&base, &path) {
            path.pop();
            break;
        }
        k += 1;
    }
    let item = rest.get(k).filter(|s| **s != "*").map(|s| s.to_string());
    modules.get(&(base, path)).cloned().map(|f| Res::Ours(f, item))
}

pub fn analyze(root: &Path, files: &[String]) -> Native {
    let rs: HashSet<&str> = files.iter().map(String::as_str).filter(|f| f.ends_with(".rs")).collect();
    let cargos: Vec<&str> = files.iter().map(String::as_str).filter(|f| basename(f) == "Cargo.toml").collect();
    let crates = parse_crates(root, &cargos, &rs);
    let mut n = Native::default();

    let lib_of: HashMap<&str, Option<&str>> = crates.iter().map(|c| (c.dir.as_str(), c.lib_root.as_deref())).collect();
    let cargo_of: HashMap<&str, &str> = crates.iter().map(|c| (c.dir.as_str(), c.cargo.as_str())).collect();
    for c in &crates {
        for (_, td) in &c.deps {
            if let Some(tc) = cargo_of.get(td.as_str()) {
                let pair = (c.cargo.clone(), tc.to_string());
                if !n.declared.contains(&pair) {
                    n.declared.push(pair);
                }
            }
        }
    }

    let mut sorted: Vec<&str> = rs.iter().copied().collect();
    sorted.sort();
    let origs: HashMap<&str, String> =
        sorted.iter().map(|f| (*f, String::from_utf8_lossy(&std::fs::read(root.join(f)).unwrap_or_default()).into_owned())).collect();
    let texts: HashMap<&str, String> = origs.iter().map(|(f, t)| (*f, strip(t))).collect();
    let path_attr = Regex::new(r#"#\[\s*path\s*=\s*"([^"]+)"\s*\]"#).unwrap();
    let mod_re = Regex::new(r"(?m)^[ \t]*(?:#\[[^\]\n]*\][ \t]*)*(?:pub(?:\([^)\n]*\))?[ \t]+)?mod[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t]*;").unwrap();
    let inline_re = Regex::new(r"\bmod\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{").unwrap();
    let spans: HashMap<&str, Vec<(usize, usize, String)>> = texts.iter().map(|(f, t)| (*f, inline_spans(t, &inline_re))).collect();

    // module trees, one per crate root
    let mut modules: Modules = HashMap::new();
    let mut file_ctx: HashMap<String, (String, Vec<String>)> = HashMap::new();
    let mut externs: HashMap<String, HashMap<String, String>> = HashMap::new();
    for c in &crates {
        for r in &c.roots {
            let mut ex = HashMap::new();
            for (name, td) in &c.deps {
                if let Some(Some(l)) = lib_of.get(td.as_str()) {
                    ex.insert(name.clone(), l.to_string());
                }
            }
            if let Some(lr) = c.lib_root.as_ref().filter(|lr| *lr != r) {
                ex.insert(c.lib_name.clone(), lr.clone());
            }
            externs.insert(r.clone(), ex);
            modules.insert((r.clone(), vec![]), r.clone());
            file_ctx.entry(r.clone()).or_insert((r.clone(), vec![]));
            let mut q = VecDeque::from([(r.clone(), Vec::<String>::new())]);
            while let Some((file, path)) = q.pop_front() {
                let Some(text) = texts.get(file.as_str()) else { continue };
                let sp = &spans[file.as_str()];
                let base = if file == *r || basename(&file) == "mod.rs" { dirname(&file).to_string() } else { join(dirname(&file), stem(&file)) };
                for m in mod_re.captures_iter(text) {
                    let pos = m.get(0).unwrap().start();
                    if sp.iter().any(|(s, e, _)| *s < pos && pos < *e) {
                        continue; // `mod x;` inside an inline module: rare, not followed
                    }
                    let name = m[1].to_string();
                    let span = m.get(0).unwrap();
                    // `#[path = "x.rs"] mod y;` — relative to the declaring file's folder
                    let region = &origs[file.as_str()][attr_start(text, span.start())..span.end()];
                    let cands: Vec<String> = match path_attr.captures(region) {
                        Some(c) => vec![normpath(&join(dirname(&file), &c[1]))],
                        None => vec![join(&base, &format!("{name}.rs")), join(&base, &format!("{name}/mod.rs"))],
                    };
                    match cands.iter().find(|p| rs.contains(p.as_str())) {
                        Some(p) => {
                            let mut np = path.clone();
                            np.push(name);
                            if modules.insert((r.clone(), np.clone()), p.clone()).is_none() {
                                file_ctx.entry(p.clone()).or_insert((r.clone(), np.clone()));
                                q.push_back((p.clone(), np));
                            }
                        }
                        None => n.unresolved_mods.push(format!("{file}: mod {name}")),
                    }
                }
            }
        }
    }
    n.unresolved_mods.sort();
    n.unresolved_mods.dedup();
    n.orphans = sorted.iter().filter(|f| !file_ctx.contains_key(**f)).map(|f| f.to_string()).collect();

    // items each file defines, and what it re-exports (`pub use`)
    let item_re = Regex::new(r"(?m)^[ \t]*(?:pub(?:\([^)\n]*\))?[ \t]+)?(?:(?:async|const|unsafe)[ \t]+)*(?:struct|enum|fn|trait|type|const|static|union)[ \t]+([A-Za-z_][A-Za-z0-9_]*)").unwrap();
    let defs: HashMap<&str, HashSet<String>> = texts.iter().map(|(f, t)| (*f, item_re.captures_iter(t).map(|c| c[1].to_string()).collect())).collect();
    let pub_use_re = Regex::new(r"\bpub(?:\([^)]*\))?\s+use\s+([^;]+);").unwrap();
    let crate_dir: HashMap<&str, &str> = crates.iter().flat_map(|c| c.roots.iter().map(move |r| (r.as_str(), c.dir.as_str()))).collect();
    let crate_of: HashMap<String, String> = file_ctx.iter().filter_map(|(f, (r, _))| crate_dir.get(r.as_str()).map(|d| (f.clone(), d.to_string()))).collect();
    let mut reexp: Reexports = HashMap::new();
    for f in &sorted {
        let Some((r, fpath)) = file_ctx.get(*f) else { continue };
        for c in pub_use_re.captures_iter(&texts[f]) {
            for path in expand_use(&c[1]) {
                let segs: Vec<&str> = path.iter().map(String::as_str).collect();
                if let Some(Res::Ours(t, item)) = resolve(&modules, &externs, r, fpath, &segs) {
                    let name = path.last().cloned().unwrap_or_default();
                    reexp.entry(f.to_string()).or_default().push((name, t, item));
                }
            }
        }
    }

    // links
    let use_re = Regex::new(r"\buse\s+([^;]+);").unwrap();
    let path_re = Regex::new(r"[A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)+").unwrap();
    for f in &sorted {
        let Some((r, fpath)) = file_ctx.get(*f) else { continue };
        let (text, sp) = (&texts[f], &spans[f]);
        let ctx_at = |pos: usize| {
            let mut inner: Vec<&(usize, usize, String)> = sp.iter().filter(|(s, e, _)| *s < pos && pos < *e).collect();
            inner.sort_by_key(|x| x.0);
            let mut p = fpath.clone();
            p.extend(inner.iter().map(|x| x.2.clone()));
            p
        };
        let mut push = |target: String, relation: &'static str, line: u64| {
            if target != *f {
                n.links.push(Link { source: f.to_string(), target, relation, line });
            }
        };
        let mut unresolved = 0u64;
        let mut blanked = text.clone().into_bytes();
        for c in use_re.captures_iter(text) {
            let m = c.get(0).unwrap();
            let (line, cur) = (line_of(text, m.start()), ctx_at(m.start()));
            for path in expand_use(&c[1]) {
                let segs: Vec<&str> = path.iter().map(String::as_str).collect();
                match resolve(&modules, &externs, r, &cur, &segs) {
                    Some(Res::Ours(t, item)) => push(follow(&defs, &reexp, &crate_of, &t, item.as_deref(), 0), "uses", line),
                    Some(Res::Unresolved) => unresolved += 1,
                    None => {}
                }
            }
            for b in &mut blanked[m.start()..m.end()] {
                if *b != b'\n' {
                    *b = b' ';
                }
            }
        }
        let bl = String::from_utf8(blanked).unwrap_or_default();
        for m in path_re.find_iter(&bl) {
            let s = m.start();
            if s > 0 {
                let p = bl.as_bytes()[s - 1];
                if p.is_ascii_alphanumeric() || p == b'_' || p == b':' {
                    continue;
                }
            }
            let segs: Vec<&str> = m.as_str().split("::").collect();
            match resolve(&modules, &externs, r, &ctx_at(s), &segs) {
                Some(Res::Ours(t, item)) => push(follow(&defs, &reexp, &crate_of, &t, item.as_deref(), 0), "references", line_of(&bl, s)),
                Some(Res::Unresolved) => unresolved += 1,
                None => {}
            }
        }
        n.unresolved += unresolved;
    }
    n
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expands_use_trees() {
        let got = expand_use("crate::{atlas, profile::{self, Obj}, d::*}");
        let want: Vec<Vec<String>> = [vec!["crate", "atlas"], vec!["crate", "profile"], vec!["crate", "profile", "Obj"], vec!["crate", "d", "*"]]
            .iter()
            .map(|v| v.iter().map(|s| s.to_string()).collect())
            .collect();
        assert_eq!(got, want);
        assert_eq!(expand_use("super::x as y"), vec![vec!["super".to_string(), "x".into()]]);
        assert_eq!(expand_use("::serde::Deserialize"), vec![vec!["serde".to_string(), "Deserialize".into()]]);
    }

    #[test]
    fn strips_comments_strings_chars_keeping_lifetimes() {
        let src = "let a = \"use crate::x;\"; // use crate::y;\n/* mod z; */ fn f<'a>(c: char) { let q = '\"'; let r = r#\"mod w;\"#; }";
        let s = strip(src);
        assert_eq!(s.len(), src.len());
        assert!(!s.contains("crate::") && !s.contains("mod z") && !s.contains("mod w"));
        assert!(s.contains("'a"));
    }
}
