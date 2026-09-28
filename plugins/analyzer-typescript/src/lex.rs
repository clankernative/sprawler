//! A string-, template- and regex-aware comment stripper for TS/JS, so `'http://x'` is not a comment.
fn skip_str(b: &[u8], i: usize) -> usize {
    let q = b[i];
    let mut j = i + 1;
    while j < b.len() {
        match b[j] {
            b'\\' => j += 2,
            c if c == q => return j + 1,
            b'\n' => return j,
            _ => j += 1,
        }
    }
    b.len()
}

/// End of the template literal whose backtick is at `i`, skipping `${ … }` holes.
fn skip_tpl(b: &[u8], i: usize) -> usize {
    let mut j = i + 1;
    while j < b.len() {
        match b[j] {
            b'\\' => j += 2,
            b'`' => return j + 1,
            b'$' if b.get(j + 1) == Some(&b'{') => j = close(b, j + 1).map_or(b.len(), |k| k + 1),
            _ => j += 1,
        }
    }
    b.len()
}

/// Index of the bracket closing the one at `i`, skipping strings and templates.
fn close(b: &[u8], i: usize) -> Option<usize> {
    let mut depth = 0i32;
    let mut j = i;
    while j < b.len() {
        match b[j] {
            b'\'' | b'"' => {
                j = skip_str(b, j);
                continue;
            }
            b'`' => {
                j = skip_tpl(b, j);
                continue;
            }
            b'(' | b'{' | b'[' => depth += 1,
            b')' | b'}' | b']' => {
                depth -= 1;
                if depth == 0 {
                    return Some(j);
                }
            }
            _ => {}
        }
        j += 1;
    }
    None
}

fn skip_regex(b: &[u8], i: usize) -> Option<usize> {
    let (mut j, mut class) = (i + 1, false);
    while j < b.len() && b[j] != b'\n' {
        match b[j] {
            b'\\' => j += 1,
            b'[' => class = true,
            b']' => class = false,
            b'/' if !class => return Some(j + 1),
            _ => {}
        }
        j += 1;
    }
    None
}

/// Blank out `//` and `/* */` comments (keeping newlines and offsets), but never inside strings,
/// templates or regex literals — so `'http://x'` survives.
pub fn strip_comments(s: &str) -> String {
    let mut b = s.as_bytes().to_vec();
    let (mut i, mut prev) = (0usize, b'\n');
    while i < b.len() {
        let c = b[i];
        match c {
            b'\'' | b'"' => {
                i = skip_str(&b, i);
                prev = b'"';
                continue;
            }
            b'`' => {
                i = skip_tpl(&b, i);
                prev = b'"';
                continue;
            }
            b'/' if b.get(i + 1) == Some(&b'/') => {
                while i < b.len() && b[i] != b'\n' {
                    b[i] = b' ';
                    i += 1;
                }
                continue;
            }
            b'/' if b.get(i + 1) == Some(&b'*') => {
                let end = s[i + 2..].find("*/").map_or(b.len(), |k| i + 2 + k + 2);
                for x in &mut b[i..end] {
                    if *x != b'\n' {
                        *x = b' ';
                    }
                }
                i = end;
                continue;
            }
            b'/' if b"(,=:[!&|?{};+-*%<>~^\n".contains(&prev) => {
                if let Some(e) = skip_regex(&b, i) {
                    i = e;
                    prev = b'"';
                    continue;
                }
            }
            _ => {}
        }
        if !c.is_ascii_whitespace() || c == b'\n' {
            prev = c;
        }
        i += 1;
    }
    String::from_utf8(b).unwrap_or_else(|_| s.to_string())
}

#[cfg(test)]
mod tests {
    #[test]
    fn comments_go_but_strings_stay() {
        let s = super::strip_comments("const u = 'http://x/y' // gone\nconst r = /a\\/\\/b/ /* gone */ + `//${a}`");
        assert!(s.contains("'http://x/y'") && s.contains("`//${a}`") && s.contains("/a\\/\\/b/"));
        assert!(!s.contains("gone"));
        assert_eq!(s.lines().count(), 2);
    }
}
