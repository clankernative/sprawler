//! Per-file code-health facts for `modules[].metrics` (docs/PROTOCOL.md): functions, approximate
//! cyclomatic complexity, nesting, TODOs and comment density.
//!
//! Deliberately lightweight (a small lexer and regexes, no parsers): good enough to rank files and spot
//! smells. Function bodies end where their braces close (brace languages) or where the indentation
//! returns to the header's (Roc, Python); strings and comments never count. These are facts only: the
//! smell limits are policy and live in the core.
use regex::Regex;
use serde_json::{json, Value};

/// The metrics language for a file name (its extension), when we know how to measure it.
pub fn lang_of(path: &str) -> Option<&'static str> {
    let ext = path.rsplit('/').next().unwrap_or(path).rsplit_once('.')?.1;
    Some(match ext {
        "rs" => "rs",
        "roc" => "roc",
        "py" | "pyi" => "py",
        "ts" | "tsx" | "mts" | "cts" => "ts",
        "js" | "jsx" | "mjs" | "cjs" => "js",
        "go" => "go",
        _ => return None,
    })
}

fn hash_comments(lang: &str) -> bool {
    matches!(lang, "roc" | "py")
}

fn braces(lang: &str) -> bool {
    matches!(lang, "rs" | "ts" | "js" | "go" | "cs")
}

/// Blank out string literals (kept as `""`) and comments so keywords inside them don't count.
/// Newlines are preserved, so line numbers still match the source.
pub fn strip(text: &str, lang: &str) -> String {
    lex(text, lang, false)
}

/// [`strip`], optionally keeping comments (where TODO markers live).
fn lex(text: &str, lang: &str, keep_comments: bool) -> String {
    let c: Vec<char> = text.chars().collect();
    let n = c.len();
    let at = |i: usize| c.get(i).copied();
    let hash = hash_comments(lang);
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    // skip to the end of a literal, keeping only its newlines
    let skip = |out: &mut String, from: usize, to: usize| {
        for &ch in &c[from..to.min(n)] {
            if ch == '\n' {
                out.push('\n');
            }
        }
    };
    while i < n {
        let ch = c[i];
        let next = at(i + 1);
        if (hash && ch == '#') || (!hash && ch == '/' && next == Some('/')) {
            while i < n && c[i] != '\n' {
                if keep_comments {
                    out.push(c[i]);
                }
                i += 1;
            }
            continue;
        }
        if !hash && ch == '/' && next == Some('*') {
            let mut j = i + 2;
            while j < n && !(c[j] == '*' && at(j + 1) == Some('/')) {
                j += 1;
            }
            if keep_comments {
                out.extend(&c[i..(j + 2).min(n)]);
            } else {
                skip(&mut out, i, j);
            }
            i = j + 2;
            continue;
        }
        // triple-quoted strings (Python, Roc)
        let triple = hash && (ch == '"' || (lang == "py" && ch == '\'')) && next == Some(ch) && at(i + 2) == Some(ch);
        if triple {
            let mut j = i + 3;
            while j < n && !(c[j] == ch && at(j + 1) == Some(ch) && at(j + 2) == Some(ch)) {
                j += if c[j] == '\\' { 2 } else { 1 };
            }
            out.push_str("\"\"");
            skip(&mut out, i, j);
            i = j + 3;
            continue;
        }
        let ident_before = i > 0 && (c[i - 1].is_alphanumeric() || c[i - 1] == '_');
        // Rust raw strings: r"…", r#"…"#
        if lang == "rs" && ch == 'r' && !ident_before && matches!(next, Some('"') | Some('#')) {
            let mut j = i + 1;
            while at(j) == Some('#') {
                j += 1;
            }
            if at(j) == Some('"') {
                let hashes = j - i - 1;
                let mut k = j + 1;
                while k < n && !(c[k] == '"' && (1..=hashes).all(|h| at(k + h) == Some('#'))) {
                    k += 1;
                }
                out.push_str("\"\"");
                skip(&mut out, i, k);
                i = k + 1 + hashes;
                continue;
            }
        }
        // char literals ('x', '\n', '\u{1F600}') — a Rust lifetime ('a) is left alone
        if ch == '\'' && matches!(lang, "rs" | "go" | "cs") {
            let close = if next == Some('\\') { (i + 3..(i + 12).min(n)).find(|&k| c[k] == '\'') } else { Some(i + 2).filter(|&k| at(k) == Some('\'')) };
            if let Some(k) = close {
                out.push_str("' '");
                i = k + 1;
                continue;
            }
            out.push(ch);
            i += 1;
            continue;
        }
        let quote = ch == '"' || (ch == '`' && matches!(lang, "ts" | "js" | "go")) || (ch == '\'' && matches!(lang, "py" | "ts" | "js"));
        if quote {
            let raw = ch == '`' && lang == "go";
            let mut j = i + 1;
            while j < n && c[j] != ch {
                // a single-quoted string never spans lines: stop a runaway at the newline
                if ch == '\'' && c[j] == '\n' {
                    break;
                }
                j += if c[j] == '\\' && !raw { 2 } else { 1 };
            }
            out.push_str("\"\"");
            skip(&mut out, i, j);
            i = j + 1;
            continue;
        }
        out.push(ch);
        i += 1;
    }
    out
}

fn fn_start(lang: &str) -> Option<Regex> {
    let rx = match lang {
        "rs" => r#"(?m)^[ \t]*(?:pub(?:\([^)]*\))?\s+)?(?:default\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+(?:"[^"]*"\s+)?)?fn\s+(\w+)"#,
        "roc" => r"(?m)^(?:\t|    )?([a-z_][\w!]*)\s*=\s*\|",
        "py" => r"(?m)^[ \t]*(?:async\s+)?def\s+(\w+)",
        "ts" | "js" => concat!(
            r"(?m)^[ \t]*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([\w$]+)",
            r"|^[ \t]*(?:export\s+)?(?:const|let)\s+([\w$]+)\s*=\s*(?:async\s*)?(?:\(|[\w$]+\s*=>)",
            r"|^[ \t]+(?:(?:public|private|protected|static|async|override|readonly|get|set)\s+)*([\w$]+)\s*\([^)]*\)\s*(?::[^{;=]*)?\{",
        ),
        "go" => r"(?m)^func\s+(?:\([^)]*\)\s*)?(\w+)",
        _ => return None,
    };
    Some(Regex::new(rx).unwrap())
}

/// Decision points (+1 each) for an approximate cyclomatic complexity. Rust's `?` is not a branch;
/// Roc's `->` is a type arrow (match arms are `=>`).
fn decisions(lang: &str) -> Option<Regex> {
    let rx = match lang {
        "rs" => r"\bif\b|\bwhile\b|\bfor\b|\bloop\b|=>|&&|\|\|",
        "roc" => r"\bif\b|=>|&&|\|\||\band\b|\bor\b",
        "py" => r"\bif\b|\belif\b|\bwhile\b|\bfor\b|\bexcept\b|\band\b|\bor\b",
        "ts" | "js" => r"\bif\b|\bwhile\b|\bfor\b|\bcase\b|\bcatch\b|&&|\|\||\?\?|\s\?\s",
        "go" => r"\bif\b|\bfor\b|\bcase\b|&&|\|\|",
        _ => return None,
    };
    Some(Regex::new(rx).unwrap())
}

/// Words that look like a method header in a class body but are control flow.
const NOT_FUNCTIONS: [&str; 8] = ["if", "for", "while", "switch", "catch", "function", "return", "with"];

fn indent(t: &str) -> usize {
    t.len() - t.trim_start().len()
}

struct Function {
    name: String,
    line: usize,
    len: usize,
    cc: usize,
}

/// `{cc, ccMax, ccFn, ccLine, fnMax, fnName, fnLine, fns, nest, todo, comments}` for one file
/// (`lang` as returned by [`lang_of`]). `null` for an unknown language.
pub fn file_metrics(text: &str, lang: &str) -> Value {
    let (Some(rx_fn), Some(rx_dec)) = (fn_start(lang), decisions(lang)) else { return Value::Null };
    let code = strip(text, lang);
    let clines: Vec<&str> = code.split('\n').collect();
    let mut starts: Vec<(usize, String)> = Vec::new();
    let (mut pos, mut line) = (0usize, 0usize);
    for cap in rx_fn.captures_iter(&code) {
        let Some(name) = cap.iter().skip(1).flatten().next().map(|m| m.as_str()) else { continue };
        if NOT_FUNCTIONS.contains(&name) {
            continue;
        }
        let start = cap.get(0).unwrap().start();
        line += code[pos..start].matches('\n').count();
        pos = start;
        let ln = line;
        if starts.last().is_none_or(|(l, _)| *l != ln) {
            starts.push((ln, name.to_string()));
        }
    }
    let mut fns: Vec<Function> = Vec::new();
    for (k, (ln, name)) in starts.iter().enumerate() {
        let ln = *ln;
        let nxt = starts.get(k + 1).map_or(clines.len(), |s| s.0);
        let mut end = nxt;
        if braces(lang) {
            // the body ends where its braces close (struct / impl text after it is not part of it)
            let (mut depth, mut opened) = (0i64, false);
            for (j, l) in clines.iter().enumerate().skip(ln) {
                if !opened && j >= nxt {
                    break; // never opened a body before the next function: a one-line arrow without `;`
                }
                for ch in l.chars() {
                    match ch {
                        '{' => {
                            depth += 1;
                            opened = true;
                        }
                        '}' => depth -= 1,
                        _ => {}
                    }
                }
                if opened && depth <= 0 {
                    end = j + 1;
                    break;
                }
                let t = l.trim_end();
                if !opened && (t.ends_with(';') || (j == ln && t.contains("=>") && !t.ends_with("=>") && !t.ends_with('('))) {
                    end = j + 1; // a declaration without a body, or an expression-bodied arrow
                    break;
                }
            }
        } else {
            // indentation languages: the body ends at the first line indented no deeper than the header
            let base = indent(clines[ln]);
            if let Some(j) = (ln + 1..nxt).find(|&j| !clines[j].trim().is_empty() && indent(clines[j]) <= base) {
                end = j;
            }
        }
        while end > ln + 1 && clines[end - 1].trim().is_empty() {
            end -= 1;
        }
        let body = clines[ln..end].join("\n");
        fns.push(Function { name: name.clone(), line: ln + 1, len: end - ln, cc: 1 + rx_dec.find_iter(&body).count() });
    }
    let total_cc = 1 + rx_dec.find_iter(&code).count();
    // nesting: deepest indentation in indent units (a tab, or the file's space indent: 2 or 4)
    let leads: Vec<&str> = clines.iter().filter(|l| !l.trim().is_empty()).map(|l| &l[..indent(l)]).collect();
    let unit = if leads.iter().any(|l| !l.contains('\t') && l.len() % 4 == 2) { 2 } else { 4 };
    let nest = leads
        .iter()
        .map(|lead| {
            let tabs = lead.matches('\t').count();
            tabs + (lead.len() - tabs) / unit
        })
        .max()
        .unwrap_or(0);
    // first maximum wins, as in a stable sort
    let worst = |key: fn(&Function) -> usize| fns.iter().fold(None::<&Function>, |b, f| if b.is_none_or(|b| key(f) > key(b)) { Some(f) } else { b });
    let (wl, wc) = (worst(|f| f.len), worst(|f| f.cc));
    let marker = if hash_comments(lang) { "#" } else { "//" };
    let lines: Vec<&str> = text.split('\n').collect();
    let comments = lines.iter().filter(|l| l.trim_start().starts_with(marker)).count();
    // markers in comments, not in strings
    let todo = Regex::new(r"\b(TODO|FIXME|HACK|XXX)\b").unwrap().find_iter(&lex(text, lang, true)).count();
    json!({
        "cc": total_cc,
        "ccMax": wc.map_or(total_cc, |f| f.cc), "ccFn": wc.map(|f| &f.name), "ccLine": wc.map(|f| f.line),
        "fnMax": wl.map_or(0, |f| f.len), "fnName": wl.map(|f| &f.name), "fnLine": wl.map(|f| f.line),
        "fns": fns.len(), "nest": nest, "todo": todo,
        "comments": (comments as f64 / lines.len().max(1) as f64 * 1000.0).round() / 1000.0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const RUST: &str = r#"
pub fn small(x: i32) -> i32 {
    if x > 0 { 1 } else { 2 }
}

struct Unrelated { a: i32 }

fn big(v: Vec<i32>) -> i32 {
    let mut n = 0;
    for x in v {
        match x {
            0 => n += 1,
            1 => n += 2,
            _ => if x > 9 && x < 99 { n += 3 },
        }
    }
    n
}
"#;

    const ROC: &str = "
Foo :: [].{
\thandle = |ctx, input|
\t\tif input.ok then
\t\t\tmatch input.kind {
\t\t\t\tA => 1
\t\t\t\tB => 2
\t\t\t}
\t\telse 0

\tother = |x| x
}
";

    #[test]
    fn rust_functions_end_at_their_braces() {
        let m = file_metrics(RUST, "rs");
        assert_eq!(m["fns"], 2);
        assert_eq!(m["fnName"], "big");
        // `fn big` through its closing brace; the struct between the functions is not counted
        assert_eq!((m["fnMax"].as_u64(), m["fnLine"].as_u64()), (Some(11), Some(8)));
        // big: for + 3 match arms + if + && = 6 decisions → 7
        assert_eq!(m["ccFn"], "big");
        assert_eq!(m["ccMax"], 7);
    }

    #[test]
    fn roc_type_arrows_are_not_branches() {
        let m = file_metrics(&format!("f : I64 -> I64\n{ROC}"), "roc");
        assert_eq!(m["ccFn"], "handle");
        assert_eq!(m["ccMax"], 4); // if + two match arms
        assert_eq!(m["fns"], 2);
        assert_eq!(m["nest"], 4);
    }

    #[test]
    fn strings_and_comments_do_not_count() {
        let m = file_metrics("fn a() {\n    let s = \"if if if\";\n    // if && ||\n}\n", "rs");
        assert_eq!(m["ccMax"], 1);
        assert_eq!(m["todo"], 0);
        assert_eq!(m["comments"], 0.2);
    }

    #[test]
    fn rust_question_mark_char_literals_and_raw_strings() {
        let src = "fn a() -> Result<(), E> {\n    let q = '\"';\n    let r = r#\"if \"quoted\" while\"#;\n    let x = f()?;\n    g(x)?;\n    Ok(())\n}\nfn b<'a>(s: &'a str) -> &'a str { if s.is_empty() { s } else { s } }\n";
        let m = file_metrics(src, "rs");
        assert_eq!(m["fns"], 2);
        assert_eq!(m["cc"], 2); // only b's `if`
        assert_eq!(m["fnMax"], 7);
    }

    #[test]
    fn todos_count_in_comments() {
        let m = file_metrics("def a():\n    # TODO: one\n    # FIXME two\n    return 1\n", "py");
        assert_eq!((m["todo"].as_u64(), m["fns"].as_u64(), m["fnMax"].as_u64()), (Some(2), Some(1), Some(4)));
    }

    #[test]
    fn typescript_functions_and_methods() {
        let src = "export function f(a) {\n  if (a) { return 1 }\n  return a ?? 2\n}\nclass C {\n  run(x: number): number {\n    for (const y of [x]) { if (y) return y }\n    return 0\n  }\n}\nconst g = (x) => x ? 1 : 2\n";
        let m = file_metrics(src, "ts");
        assert_eq!(m["fns"], 3);
        assert_eq!((m["ccMax"].as_u64(), m["ccFn"].as_str()), (Some(3), Some("f")));
    }

    #[test]
    fn two_space_indent_and_arrows_without_semicolons() {
        let src =
            "const a = (x) => x + 1\nconst b = (y) => {\n  if (y) {\n    return 1\n  }\n  return 2\n}\nconst c = 'TODO: not a marker' // TODO: a marker\n";
        let m = file_metrics(src, "js");
        assert_eq!((m["fns"].as_u64(), m["fnName"].as_str(), m["fnMax"].as_u64()), (Some(2), Some("b"), Some(6)));
        assert_eq!(m["nest"], 2);
        assert_eq!(m["todo"], 1);
    }

    #[test]
    fn unknown_language_is_null() {
        assert!(file_metrics("x", "cobol").is_null());
        assert_eq!(lang_of("a/b.tsx"), Some("ts"));
        assert_eq!(lang_of("Makefile"), None);
    }
}
