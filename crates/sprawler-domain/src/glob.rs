//! Path globs and fact globs, with the exact semantics of the Python reference implementation.
use regex::Regex;

/// Path glob → anchored regex. Supports `**`, `*`, `?` and `{name}` single-segment captures.
/// `**/` matches zero or more directories; `*` and `?` never cross `/`.
pub fn compile_path_glob(pat: &str) -> Result<Regex, regex::Error> {
    let b = pat.as_bytes();
    let (mut out, mut i) = (String::from("^"), 0usize);
    while i < b.len() {
        let rest = &pat[i..];
        if rest.starts_with("**/") {
            out.push_str("(?:.*/)?");
            i += 3;
        } else if rest == "/**" {
            out.push_str("(?:/.*)?");
            i += 3;
        } else if rest.starts_with("**") {
            out.push_str(".*");
            i += 2;
        } else if b[i] == b'*' {
            out.push_str("[^/]*");
            i += 1;
        } else if b[i] == b'?' {
            out.push_str("[^/]");
            i += 1;
        } else if b[i] == b'{' {
            let j = rest.find('}').map(|k| i + k).unwrap_or(b.len());
            out.push_str(&format!("(?P<{}>[^/]+?)", &pat[i + 1..j]));
            i = j + 1;
        } else {
            let ch = rest.chars().next().unwrap();
            out.push_str(&regex::escape(&ch.to_string()));
            i += ch.len_utf8();
        }
    }
    out.push('$');
    Regex::new(&out)
}

/// `fnmatch.fnmatchcase`: `*` matches anything (including `/`), `?` one char, `[abc]` / `[!abc]` sets.
pub fn fnmatch(value: &str, pat: &str) -> bool {
    let mut re = String::from("^");
    let mut chars = pat.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '*' => re.push_str(".*"),
            '?' => re.push('.'),
            '[' => {
                let mut set = String::new();
                let mut closed = false;
                if chars.peek() == Some(&'!') {
                    chars.next();
                    set.push('^');
                }
                for c2 in chars.by_ref() {
                    if c2 == ']' {
                        closed = true;
                        break;
                    }
                    if c2 == '\\' || c2 == '[' {
                        set.push('\\');
                    }
                    set.push(c2);
                }
                if closed {
                    re.push('[');
                    re.push_str(&set);
                    re.push(']');
                } else {
                    re.push_str("\\[");
                    re.push_str(&regex::escape(&set));
                }
            }
            _ => re.push_str(&regex::escape(&c.to_string())),
        }
    }
    re.push('$');
    Regex::new(&re).map(|r| r.is_match(value)).unwrap_or(false)
}

/// Context lists in rules: plain names match exactly, names containing `*`/`?` match as globs.
pub fn in_glob_list(list: Option<&[String]>, value: &str) -> bool {
    match list {
        None => true,
        Some(l) => l.iter().any(|x| x == value || ((x.contains('*') || x.contains('?')) && fnmatch(value, x))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn m(p: &str, s: &str) -> bool {
        compile_path_glob(p).unwrap().is_match(s)
    }

    #[test]
    fn path_globs() {
        assert!(m("**/target/**", "target/x"));
        assert!(m("**/target/**", "a/b/target/c/d.rs"));
        assert!(m("apps/*.roc", "apps/App.roc"));
        assert!(!m("apps/*.roc", "apps/x/App.roc"));
        assert!(m("platform/sdk/**", "platform/sdk"));
        assert!(m("a/?.rs", "a/b.rs"));
        let re = compile_path_glob("apps/{ctx}/commands/{slice}/**").unwrap();
        let c = re.captures("apps/billing/commands/create/Create.roc").unwrap();
        assert_eq!((&c["ctx"], &c["slice"]), ("billing", "create"));
        assert!(m("acme-config/instance.json", "acme-config/instance.json"));
    }

    #[test]
    fn fact_globs() {
        assert!(fnmatch("Acme.Orders.Contracts", "*.Contracts"));
        assert!(fnmatch("web", "web"));
        assert!(!fnmatch("web2", "web"));
        assert!(fnmatch("a/b", "*"));
        assert!(fnmatch("x", "[!y]"));
        assert!(in_glob_list(None, "x"));
        assert!(in_glob_list(Some(&["billing".into()]), "billing"));
        assert!(!in_glob_list(Some(&["billing".into()]), "billing2"));
    }
}
