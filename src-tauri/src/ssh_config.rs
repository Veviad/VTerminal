//! A deliberately partial `~/.ssh/config` reader, for importing hosts.
//!
//! Hand-rolled rather than a crate because we want LESS than OpenSSH's
//! semantics, not more: wildcard `Host` patterns and `Match` blocks are skipped
//! rather than resolved, because an importer wants concrete rows a user can
//! recognise, not a resolver. Keeping it local also means the parser is a pure
//! function over `&str` and its tests need no fixtures on disk.
//!
//! This is READ-ONLY. The app never writes to the user's ssh config.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

/// Guards against a pathological include graph.
const MAX_INCLUDE_DEPTH: usize = 3;
const MAX_FILES: usize = 64;

#[derive(Debug, Default, Clone, PartialEq)]
pub struct ParsedHost {
    pub alias: String,
    pub hostname: Option<String>,
    pub username: Option<String>,
    pub port: Option<u16>,
    pub identity_file: Option<String>,
    pub jump_host: Option<String>,
}

/// Parse one file's text. `Include` targets are RETURNED rather than followed,
/// which keeps this function pure and independently testable.
pub fn parse(text: &str) -> (Vec<ParsedHost>, Vec<String>) {
    let mut hosts: Vec<ParsedHost> = Vec::new();
    let mut includes: Vec<String> = Vec::new();
    // Indices into `hosts` for the aliases the current `Host` line opened.
    let mut current: Vec<usize> = Vec::new();
    let mut skipping = false;

    for raw in text.lines() {
        let line = raw.trim();
        // OpenSSH has no trailing comments, so only a leading # is a comment —
        // stripping mid-line would corrupt values that legitimately contain #.
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((keyword, value)) = split_directive(line) else {
            continue;
        };

        match keyword.as_str() {
            "host" => {
                current.clear();
                skipping = false;
                for alias in tokenize(&value) {
                    // A pattern matches many hosts; there is no single concrete
                    // row to import, and negations are meaningless in isolation.
                    if alias.contains('*') || alias.contains('?') || alias.starts_with('!') {
                        continue;
                    }
                    current.push(hosts.len());
                    hosts.push(ParsedHost {
                        alias,
                        ..Default::default()
                    });
                }
                if current.is_empty() {
                    skipping = true;
                }
            }
            // Applicability is conditional (on user, exec, originalhost…) and
            // cannot be decided statically, so the whole block is ignored.
            "match" => {
                current.clear();
                skipping = true;
            }
            "include" => {
                includes.extend(tokenize(&value));
            }
            _ if skipping || current.is_empty() => {}
            "hostname" | "user" | "port" | "identityfile" | "proxyjump" => {
                let first = tokenize(&value).into_iter().next();
                let Some(first) = first else { continue };
                for &i in &current {
                    let h = &mut hosts[i];
                    // First value wins, as ssh does.
                    match keyword.as_str() {
                        "hostname" => h.hostname.get_or_insert_with(|| first.clone()),
                        "user" => h.username.get_or_insert_with(|| first.clone()),
                        "identityfile" => h.identity_file.get_or_insert_with(|| first.clone()),
                        "proxyjump" => h.jump_host.get_or_insert_with(|| first.clone()),
                        "port" => {
                            if h.port.is_none() {
                                h.port = first.parse::<u16>().ok();
                            }
                            continue;
                        }
                        _ => continue,
                    };
                }
            }
            _ => {}
        }
    }

    (hosts, includes)
}

/// `Keyword Value`, `Keyword=Value`, and `Keyword = Value` are all legal.
fn split_directive(line: &str) -> Option<(String, String)> {
    let idx = line.find(|c: char| c.is_whitespace() || c == '=')?;
    let keyword = line[..idx].to_ascii_lowercase();
    let value = line[idx..].trim_start_matches(['=', ' ', '\t']).trim();
    if keyword.is_empty() || value.is_empty() {
        return None;
    }
    Some((keyword, value.to_string()))
}

/// Whitespace split honoring quotes, so `IdentityFile "~/my keys/id"` survives.
fn tokenize(value: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    for ch in value.trim().chars() {
        if let Some(q) = quote {
            if ch == q {
                quote = None;
            } else {
                current.push(ch);
            }
            continue;
        }
        if ch == '"' || ch == '\'' {
            quote = Some(ch);
            continue;
        }
        if ch.is_whitespace() {
            if !current.is_empty() {
                out.push(std::mem::take(&mut current));
            }
            continue;
        }
        current.push(ch);
    }
    if !current.is_empty() {
        out.push(current);
    }
    out
}

/// Read `<ssh_dir>/config` and everything it includes.
pub fn scan(ssh_dir: &Path) -> Result<Vec<ParsedHost>, String> {
    // Canonicalize FIRST: every include is then checked against this prefix.
    let root = ssh_dir
        .canonicalize()
        .map_err(|e| format!("cannot read {}: {e}", ssh_dir.display()))?;
    let entry = root.join("config");
    if !entry.is_file() {
        return Ok(vec![]);
    }

    let mut out = Vec::new();
    let mut seen: HashSet<PathBuf> = HashSet::new();
    let mut queue: Vec<(PathBuf, usize)> = vec![(entry, 0)];

    while let Some((path, depth)) = queue.pop() {
        if seen.len() >= MAX_FILES {
            log::warn!("ssh config scan hit the {MAX_FILES}-file limit");
            break;
        }
        let Ok(canon) = path.canonicalize() else {
            continue;
        };
        // THE security-relevant line in this module. Without it `Include
        // /etc/passwd`, or a symlink planted inside ~/.ssh, turns the importer
        // into an arbitrary-file reader that ships contents to the UI.
        if !canon.starts_with(&root) {
            log::warn!(
                "skipping ssh config include outside {}: {}",
                root.display(),
                canon.display()
            );
            continue;
        }
        if !seen.insert(canon.clone()) {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&canon) else {
            continue;
        };

        let (hosts, includes) = parse(&text);
        out.extend(hosts);

        if depth >= MAX_INCLUDE_DEPTH {
            continue;
        }
        for inc in includes {
            for resolved in expand_include(&inc, &root) {
                queue.push((resolved, depth + 1));
            }
        }
    }

    Ok(out)
}

/// `~` is home; a relative path is relative to the ssh dir (OpenSSH's rule).
/// A trailing `*`/`?` glob is expanded via read_dir; character classes are not
/// supported and are simply not matched.
fn expand_include(pattern: &str, ssh_dir: &Path) -> Vec<PathBuf> {
    let expanded = if let Some(rest) = pattern.strip_prefix("~/") {
        match dirs::home_dir() {
            Some(home) => home.join(rest),
            None => return vec![],
        }
    } else {
        let p = Path::new(pattern);
        if p.is_absolute() {
            p.to_path_buf()
        } else {
            ssh_dir.join(p)
        }
    };

    let name = expanded.file_name().and_then(|n| n.to_str()).unwrap_or("");
    if !name.contains('*') && !name.contains('?') {
        return vec![expanded];
    }

    let Some(parent) = expanded.parent() else {
        return vec![];
    };
    let Ok(entries) = std::fs::read_dir(parent) else {
        return vec![];
    };
    entries
        .flatten()
        .filter(|e| e.path().is_file())
        .filter(|e| {
            e.file_name()
                .to_str()
                .is_some_and(|f| glob_matches(name, f))
        })
        .map(|e| e.path())
        .collect()
}

/// `*` (any run) and `?` (one char) only.
fn glob_matches(pattern: &str, text: &str) -> bool {
    let p: Vec<char> = pattern.chars().collect();
    let t: Vec<char> = text.chars().collect();
    let (mut pi, mut ti) = (0usize, 0usize);
    let (mut star, mut mark) = (usize::MAX, 0usize);
    while ti < t.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == t[ti]) {
            pi += 1;
            ti += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = pi;
            mark = ti;
            pi += 1;
        } else if star != usize::MAX {
            pi = star + 1;
            mark += 1;
            ti = mark;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_basic_block() {
        let (hosts, includes) = parse(
            "Host prod\n  HostName prod-01.example.com\n  User deploy\n  Port 2222\n  IdentityFile ~/.ssh/id_ed25519\n  ProxyJump bastion\n",
        );
        assert!(includes.is_empty());
        assert_eq!(hosts.len(), 1);
        let h = &hosts[0];
        assert_eq!(h.alias, "prod");
        assert_eq!(h.hostname.as_deref(), Some("prod-01.example.com"));
        assert_eq!(h.username.as_deref(), Some("deploy"));
        assert_eq!(h.port, Some(2222));
        assert_eq!(h.identity_file.as_deref(), Some("~/.ssh/id_ed25519"));
        assert_eq!(h.jump_host.as_deref(), Some("bastion"));
    }

    #[test]
    fn one_host_line_can_open_several_aliases() {
        let (hosts, _) = parse("Host a b c\n  HostName shared.example.com\n  User root\n");
        assert_eq!(hosts.len(), 3);
        assert_eq!(
            hosts.iter().map(|h| h.alias.as_str()).collect::<Vec<_>>(),
            vec!["a", "b", "c"]
        );
        assert!(hosts
            .iter()
            .all(|h| h.hostname.as_deref() == Some("shared.example.com")));
        assert!(hosts.iter().all(|h| h.username.as_deref() == Some("root")));
    }

    #[test]
    fn skips_wildcard_and_negated_patterns() {
        let (hosts, _) =
            parse("Host *\n  User root\n\nHost prod-*\n  User deploy\n\nHost !bad\n  User x\n");
        assert!(hosts.is_empty());
    }

    #[test]
    fn a_wildcard_block_does_not_bleed_into_the_next_host() {
        // The state machine's real failure mode: forgetting to reset `skipping`.
        let (hosts, _) = parse(
            "Host *\n  User root\n  IdentityFile ~/.ssh/global\n\nHost prod\n  HostName p1\n",
        );
        assert_eq!(hosts.len(), 1);
        assert_eq!(hosts[0].alias, "prod");
        assert_eq!(hosts[0].hostname.as_deref(), Some("p1"));
        // Host * defaults are deliberately NOT inherited: copying them would
        // freeze a snapshot that then drifts from the config, and ssh applies
        // them at connect time anyway.
        assert_eq!(hosts[0].username, None);
        assert_eq!(hosts[0].identity_file, None);
    }

    #[test]
    fn a_match_block_is_skipped_but_the_next_host_is_not() {
        let (hosts, _) =
            parse("Match host foo exec \"true\"\n  User nope\n\nHost prod\n  HostName p1\n  User deploy\n");
        assert_eq!(hosts.len(), 1);
        assert_eq!(hosts[0].alias, "prod");
        assert_eq!(hosts[0].username.as_deref(), Some("deploy"));
    }

    #[test]
    fn accepts_the_equals_form_and_odd_spacing() {
        let (hosts, _) = parse("Host=prod\n\tHostName = p1\n   Port=2222\n");
        assert_eq!(hosts.len(), 1);
        assert_eq!(hosts[0].hostname.as_deref(), Some("p1"));
        assert_eq!(hosts[0].port, Some(2222));
    }

    #[test]
    fn keywords_are_case_insensitive() {
        let (hosts, _) = parse("HOST prod\n  hostname p1\n  HostName p2\n  USER deploy\n");
        assert_eq!(
            hosts[0].hostname.as_deref(),
            Some("p1"),
            "first value must win"
        );
        assert_eq!(hosts[0].username.as_deref(), Some("deploy"));
    }

    #[test]
    fn keeps_a_quoted_value_whole() {
        let (hosts, _) = parse("Host prod\n  IdentityFile \"~/my keys/id_ed25519\"\n");
        assert_eq!(
            hosts[0].identity_file.as_deref(),
            Some("~/my keys/id_ed25519")
        );
    }

    #[test]
    fn ignores_comments_and_blank_lines() {
        let (hosts, _) =
            parse("# a comment\n\n   # indented\nHost prod\n  # inner\n  HostName p1\n");
        assert_eq!(hosts.len(), 1);
        assert_eq!(hosts[0].hostname.as_deref(), Some("p1"));
    }

    #[test]
    fn a_bad_port_is_dropped_not_fatal() {
        let (hosts, _) = parse("Host prod\n  HostName p1\n  Port notanumber\n");
        assert_eq!(hosts.len(), 1);
        assert_eq!(hosts[0].port, None);
    }

    #[test]
    fn includes_are_returned_not_followed() {
        let (hosts, includes) =
            parse("Include conf.d/*\nInclude other\nHost prod\n  HostName p1\n");
        assert_eq!(includes, vec!["conf.d/*".to_string(), "other".to_string()]);
        assert_eq!(hosts.len(), 1);
    }

    #[test]
    fn a_host_without_a_hostname_still_parses() {
        // ssh falls back to the alias; the mapper fills that in, not the parser.
        let (hosts, _) = parse("Host prod-01\n  User deploy\n");
        assert_eq!(hosts[0].alias, "prod-01");
        assert_eq!(hosts[0].hostname, None);
    }

    #[test]
    fn glob_matching() {
        assert!(glob_matches("*", "anything"));
        assert!(glob_matches("*.conf", "web.conf"));
        assert!(glob_matches("conf?", "conf1"));
        assert!(!glob_matches("conf?", "conf12"));
        assert!(!glob_matches("*.conf", "web.cfg"));
        assert!(glob_matches("a*b*c", "azzbzzc"));
    }

    #[test]
    fn scan_of_a_missing_directory_errors_rather_than_panicking() {
        assert!(scan(Path::new("/definitely/not/here/xyzzy")).is_err());
    }
}
