//! Redaction and evidence-size limits applied before data reaches the UI, DB or
//! exported report bundle. The frontend may redact too, but this module is the
//! persistence boundary and therefore the guarantee.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fmt::Write as _;

use super::state::EvidenceCaptureMode;

pub const OUTPUT_TAIL_BYTES: usize = 8 * 1024;
pub const FULL_EVIDENCE_BYTES: usize = 1024 * 1024;

const REDACTED: &str = "[REDACTED]";
const TRUNCATED: &str = "[truncated; showing final captured bytes]\n";

/// Longest first so `client_secret` wins over `secret` when spans overlap.
const SENSITIVE_KEYS: &[&str] = &[
    "private_key",
    "private-key",
    "client_secret",
    "client-secret",
    "authorization",
    "proxy_authorization",
    "access_token",
    "access-token",
    "refresh_token",
    "refresh-token",
    "vault_password",
    "vault-password",
    "database_url",
    "connection_string",
    "credential",
    "credentials",
    "passphrase",
    "auth",
    "api_key",
    "api-key",
    "apikey",
    "access_key",
    "access-key",
    "password",
    "passwd",
    "token",
    "secret",
    "cookie",
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SanitizedEvidence {
    pub text: String,
    pub original_bytes: u64,
    pub stored_bytes: u64,
    pub sha256: String,
    pub redacted: bool,
    pub truncated: bool,
}

/// Redact common environment, JSON, header and CLI secret shapes without a
/// regex dependency. This is deliberately conservative: false-positive
/// redaction is preferable to writing credentials into durable history.
pub fn redact_sensitive(input: &str) -> (String, bool) {
    let (without_private_keys, mut redacted) = redact_private_key_blocks(input);
    let lower = without_private_keys.to_ascii_lowercase();
    let mut spans = Vec::<(usize, usize)>::new();

    for key in SENSITIVE_KEYS {
        let mut cursor = 0usize;
        while let Some(relative) = lower[cursor..].find(key) {
            let start = cursor + relative;
            let key_end = start + key.len();
            cursor = key_end;

            if !is_key_boundary(&lower, start, key_end) {
                continue;
            }
            if let Some(span) = value_span(&without_private_keys, &lower, start, key_end, key) {
                spans.push(span);
            }
        }
    }

    // Authorization values also commonly appear as `Bearer <token>` in tool
    // output without their header name.
    let mut cursor = 0usize;
    while let Some(relative) = lower[cursor..].find("bearer ") {
        let start = cursor + relative + "bearer ".len();
        let end = token_end(&without_private_keys, start);
        if end > start {
            spans.push((start, end));
        }
        cursor = end.max(start + 1);
    }

    redact_literal_tokens(&without_private_keys, &lower, &mut spans);
    redact_url_userinfo(&without_private_keys, &mut spans);
    redact_curl_user(&without_private_keys, &lower, &mut spans);

    if spans.is_empty() {
        return (without_private_keys, redacted);
    }
    spans.sort_unstable_by_key(|(start, end)| (*start, *end));
    let mut merged = Vec::<(usize, usize)>::new();
    for (start, end) in spans {
        if let Some((_, previous_end)) = merged.last_mut() {
            if start <= *previous_end {
                *previous_end = (*previous_end).max(end);
                continue;
            }
        }
        merged.push((start, end));
    }

    let mut output = String::with_capacity(without_private_keys.len());
    let mut at = 0usize;
    for (start, end) in merged {
        output.push_str(&without_private_keys[at..start]);
        output.push_str(REDACTED);
        at = end;
        redacted = true;
    }
    output.push_str(&without_private_keys[at..]);
    (output, redacted)
}

fn redact_literal_tokens(input: &str, lower: &str, spans: &mut Vec<(usize, usize)>) {
    for prefix in ["sk-", "ghp_", "gho_", "github_pat_", "akia"] {
        let mut cursor = 0usize;
        while let Some(relative) = lower[cursor..].find(prefix) {
            let start = cursor + relative;
            let end = token_end(input, start);
            let minimum = match prefix {
                "akia" => 20,
                "sk-" | "ghp_" | "gho_" => 12,
                _ => 16,
            };
            if end.saturating_sub(start) >= minimum {
                spans.push((start, end));
            }
            cursor = end.max(start + prefix.len());
        }
    }

    // JWTs are three substantial base64url segments. Avoid treating ordinary
    // dotted IDs/versions as secrets by requiring a typical encoded-header
    // prefix and minimum segment sizes.
    for (start, _) in input.match_indices("eyJ") {
        let end = token_end(input, start);
        let candidate = &input[start..end];
        let segments: Vec<_> = candidate.split('.').collect();
        if segments.len() == 3
            && segments[0].len() >= 8
            && segments[1].len() >= 8
            && segments[2].len() >= 8
            && segments.iter().all(|segment| {
                segment
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
            })
        {
            spans.push((start, end));
        }
    }
}

fn redact_url_userinfo(input: &str, spans: &mut Vec<(usize, usize)>) {
    let lower = input.to_ascii_lowercase();
    for scheme in ["http://", "https://", "ssh://"] {
        let mut cursor = 0usize;
        while let Some(relative) = lower[cursor..].find(scheme) {
            let authority_start = cursor + relative + scheme.len();
            let authority_end = input.as_bytes()[authority_start..]
                .iter()
                .position(|byte| matches!(*byte, b'/' | b'?' | b'#' | b' ' | b'\t' | b'\r' | b'\n'))
                .map(|offset| authority_start + offset)
                .unwrap_or(input.len());
            if let Some(at_offset) = input[authority_start..authority_end].rfind('@') {
                let userinfo_end = authority_start + at_offset;
                if input[authority_start..userinfo_end].contains(':') {
                    spans.push((authority_start, userinfo_end));
                }
            }
            cursor = authority_end.max(authority_start + 1);
        }
    }
}

fn redact_curl_user(input: &str, lower: &str, spans: &mut Vec<(usize, usize)>) {
    for flag in ["--user", "-u"] {
        let mut cursor = 0usize;
        while let Some(relative) = lower[cursor..].find(flag) {
            let flag_start = cursor + relative;
            let before = lower[..flag_start].bytes().next_back();
            let after = lower[flag_start + flag.len()..].bytes().next();
            if before.is_some_and(|byte| !byte.is_ascii_whitespace())
                || after.is_some_and(|byte| !byte.is_ascii_whitespace() && byte != b'=')
            {
                cursor = flag_start + flag.len();
                continue;
            }
            let mut value_start = flag_start + flag.len();
            if input.as_bytes().get(value_start) == Some(&b'=') {
                value_start += 1;
            }
            while input
                .as_bytes()
                .get(value_start)
                .is_some_and(|byte| byte.is_ascii_whitespace())
            {
                value_start += 1;
            }
            if let Some(quote @ (b'\'' | b'"')) = input.as_bytes().get(value_start).copied() {
                value_start += 1;
                let end = input.as_bytes()[value_start..]
                    .iter()
                    .position(|byte| *byte == quote)
                    .map(|offset| value_start + offset)
                    .unwrap_or(input.len());
                if end > value_start {
                    spans.push((value_start, end));
                }
                cursor = end.max(value_start + 1);
            } else {
                let end = token_end(input, value_start);
                if end > value_start {
                    spans.push((value_start, end));
                }
                cursor = end.max(value_start + 1);
            }
        }
    }
}

pub fn sanitize_output_tail(input: &str) -> SanitizedEvidence {
    sanitize_text(input, EvidenceCaptureMode::Tail)
}

pub fn sanitize_evidence(input: &[u8], mode: EvidenceCaptureMode) -> SanitizedEvidence {
    let lossy = String::from_utf8_lossy(input);
    let mut sanitized = sanitize_text(&lossy, mode);
    sanitized.original_bytes = input.len() as u64;
    sanitized
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut output = String::with_capacity(digest.len() * 2);
    for byte in digest {
        let _ = write!(output, "{byte:02x}");
    }
    output
}

fn sanitize_text(input: &str, mode: EvidenceCaptureMode) -> SanitizedEvidence {
    let original_bytes = input.len() as u64;
    let (redacted_text, redacted) = redact_sensitive(input);
    let limit = match mode {
        EvidenceCaptureMode::None => 0,
        EvidenceCaptureMode::Tail => OUTPUT_TAIL_BYTES,
        EvidenceCaptureMode::Full => FULL_EVIDENCE_BYTES,
    };
    let (text, truncated) = if limit == 0 {
        (String::new(), !redacted_text.is_empty())
    } else {
        bounded_tail(&redacted_text, limit)
    };
    let sha256 = sha256_hex(text.as_bytes());
    SanitizedEvidence {
        stored_bytes: text.len() as u64,
        text,
        original_bytes,
        sha256,
        redacted,
        truncated,
    }
}

fn bounded_tail(input: &str, max_bytes: usize) -> (String, bool) {
    if input.len() <= max_bytes {
        return (input.to_string(), false);
    }
    if max_bytes <= TRUNCATED.len() {
        return (TRUNCATED[..max_bytes].to_string(), true);
    }
    let available = max_bytes - TRUNCATED.len();
    let mut start = input.len() - available;
    while !input.is_char_boundary(start) {
        start += 1;
    }
    (format!("{TRUNCATED}{}", &input[start..]), true)
}

fn redact_private_key_blocks(input: &str) -> (String, bool) {
    let upper = input.to_ascii_uppercase();
    let mut output = String::with_capacity(input.len());
    let mut cursor = 0usize;
    let mut changed = false;
    const BEGIN: &str = "-----BEGIN ";
    const END: &str = "-----END ";
    while let Some(relative) = upper[cursor..].find("-----BEGIN ") {
        let begin = cursor + relative;
        // Search after the opening dashes. Starting at `begin` would match the
        // same five dashes at offset zero and inspect only "-----" as a header.
        let header_body = begin + BEGIN.len();
        let Some(header_relative_end) = upper[header_body..].find("-----") else {
            break;
        };
        let header_end = header_body + header_relative_end + 5;
        if !upper[begin..header_end].contains("PRIVATE KEY") {
            output.push_str(&input[cursor..header_end]);
            cursor = header_end;
            continue;
        }
        let Some(end_relative) = upper[header_end..].find(END) else {
            output.push_str(&input[cursor..begin]);
            output.push_str(REDACTED);
            return (output, true);
        };
        let end_begin = header_end + end_relative;
        let end_body = end_begin + END.len();
        let Some(end_marker_relative) = upper[end_body..].find("-----") else {
            output.push_str(&input[cursor..begin]);
            output.push_str(REDACTED);
            return (output, true);
        };
        let end = end_body + end_marker_relative + 5;
        output.push_str(&input[cursor..begin]);
        output.push_str(REDACTED);
        cursor = end;
        changed = true;
    }
    output.push_str(&input[cursor..]);
    (output, changed)
}

fn is_key_boundary(lower: &str, start: usize, end: usize) -> bool {
    let before = lower[..start].bytes().next_back();
    let after = lower[end..].bytes().next();
    let valid = |byte: Option<u8>| byte.is_none_or(|b| !b.is_ascii_alphanumeric());
    valid(before) && valid(after)
}

fn value_span(
    original: &str,
    lower: &str,
    key_start: usize,
    key_end: usize,
    key: &str,
) -> Option<(usize, usize)> {
    let bytes = original.as_bytes();
    let mut at = key_end;
    while at < bytes.len() && matches!(bytes[at], b'\'' | b'"' | b' ' | b'\t') {
        at += 1;
    }

    let cli_flag = key_start >= 2 && &lower[key_start - 2..key_start] == "--";
    if at < bytes.len() && matches!(bytes[at], b'=' | b':') {
        at += 1;
    } else if !cli_flag {
        return None;
    }
    while at < bytes.len() && matches!(bytes[at], b' ' | b'\t') {
        at += 1;
    }
    if at >= bytes.len() {
        return None;
    }

    let quote = match bytes[at] {
        b'\'' | b'"' => {
            let quote = bytes[at];
            at += 1;
            Some(quote)
        }
        _ => None,
    };
    if at >= bytes.len() {
        return None;
    }

    let end = if let Some(quote) = quote {
        bytes[at..]
            .iter()
            .position(|b| *b == quote)
            .map(|n| at + n)
            .unwrap_or(bytes.len())
    } else if matches!(key, "authorization" | "proxy_authorization" | "cookie") {
        bytes[at..]
            .iter()
            .position(|b| matches!(*b, b'\r' | b'\n'))
            .map(|n| at + n)
            .unwrap_or(bytes.len())
    } else {
        token_end(original, at)
    };
    (end > at).then_some((at, end))
}

fn token_end(input: &str, start: usize) -> usize {
    input.as_bytes()[start..]
        .iter()
        .position(|b| {
            matches!(
                *b,
                b' ' | b'\t' | b'\r' | b'\n' | b',' | b';' | b'\'' | b'"' | b')' | b']' | b'}'
            )
        })
        .map(|n| start + n)
        .unwrap_or(input.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_env_json_cli_and_bearer_shapes() {
        let input = concat!(
            "PASSWORD=hunter2\n",
            "{\"api_key\":\"abc123\",\"safe\":\"visible\"}\n",
            "tool --token secret-token --format json\n",
            "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature\n",
        );
        let (actual, changed) = redact_sensitive(input);
        assert!(changed);
        for secret in ["hunter2", "abc123", "secret-token", "eyJhbGci"] {
            assert!(!actual.contains(secret), "leaked {secret}: {actual}");
        }
        assert!(actual.contains("visible"));
        assert!(actual.matches(REDACTED).count() >= 4);
    }

    #[test]
    fn redacts_common_literal_url_and_curl_secret_shapes() {
        // Assemble credential-shaped fixtures at runtime so repository secret
        // scanners never have to distinguish test literals from real keys.
        let openai = ["sk", "-", "1234567890abcdefghijklmnop"].concat();
        let github = ["gh", "p_", "1234567890abcdefghijklmnop"].concat();
        let aws = ["AK", "IA", "1234567890ABCDEF"].concat();
        let jwt = [
            "eyJ",
            "hbGciOiJIUzI1NiJ9",
            ".eyJzdWIiOiIxMjM0NTY3ODkwIn0",
            ".signature123",
        ]
        .concat();
        let input = format!(
            concat!(
                "credential=opaque-value\n",
                "passphrase: swordfish\n",
                "auth=basic-value\n",
                "OPENAI={}\n",
                "GITHUB={}\n",
                "AWS={}\n",
                "JWT={}\n",
                "https://alice:password@example.invalid/path\n",
                "curl --user 'operator:password' https://example.invalid\n",
                "curl -u admin:password https://example.invalid\n",
            ),
            openai, github, aws, jwt,
        );
        let (actual, changed) = redact_sensitive(&input);
        assert!(changed);
        for secret in [
            "opaque-value",
            "swordfish",
            "basic-value",
            &openai,
            &github,
            &aws,
            &jwt,
            "alice:password",
            "operator:password",
            "admin:password",
        ] {
            assert!(!actual.contains(secret), "leaked {secret}: {actual}");
        }
    }

    #[test]
    fn removes_private_key_blocks() {
        let begin = ["-----BEGIN PRIVATE ", "KEY-----"].concat();
        let end = ["-----END PRIVATE ", "KEY-----"].concat();
        let input = format!("before\n{begin}\nvery-secret\n{end}\nafter");
        let (actual, changed) = redact_sensitive(&input);
        assert!(changed);
        assert_eq!(actual, format!("before\n{REDACTED}\nafter"));
    }

    #[test]
    fn output_tail_is_utf8_safe_bounded_and_explicit() {
        let input = format!("PASSWORD=gone\n{}END", "🦀".repeat(4_000));
        let result = sanitize_output_tail(&input);
        assert!(result.redacted);
        assert!(result.truncated);
        assert!(result.text.len() <= OUTPUT_TAIL_BYTES);
        assert!(result.text.starts_with(TRUNCATED));
        assert!(result.text.ends_with("END"));
        assert!(!result.text.contains("gone"));
    }

    #[test]
    fn evidence_modes_enforce_their_caps() {
        let bytes = vec![b'x'; FULL_EVIDENCE_BYTES + 100];
        let none = sanitize_evidence(&bytes, EvidenceCaptureMode::None);
        assert!(none.text.is_empty());
        assert!(none.truncated);

        let tail = sanitize_evidence(&bytes, EvidenceCaptureMode::Tail);
        assert!(tail.text.len() <= OUTPUT_TAIL_BYTES);
        assert!(tail.truncated);

        let full = sanitize_evidence(&bytes, EvidenceCaptureMode::Full);
        assert!(full.text.len() <= FULL_EVIDENCE_BYTES);
        assert!(full.truncated);
        assert_eq!(full.sha256, sha256_hex(full.text.as_bytes()));
    }
}
