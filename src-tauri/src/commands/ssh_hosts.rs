//! Saved SSH hosts — CRUD over the `ssh_hosts` table.
//!
//! `validate` here is the real trust boundary, not the settings form. A host's
//! fields end up spliced into a command line that is TYPED INTO A LIVE SHELL,
//! and a row can be edited straight in the DB or arrive from the ~/.ssh/config
//! importer, so the frontend's checks are a convenience, not a guarantee.
//!
//! The frontend adds POSIX single-quoting on top (see `src/lib/ssh.ts`); this
//! layer rejects the shapes that quoting alone should never have to contain.

use tauri::State;

use crate::database::{queries, DbState};

/// Same rule as the frontend's `sanitizeCommand`: an ESC could forge an OSC
/// completion token, and \r / \n would split one command into several.
fn has_control_chars(s: &str) -> bool {
    s.chars().any(|c| c.is_control())
}

/// ssh options that would weaken host-key verification. Refusing these is the
/// point — the first-connect fingerprint prompt renders and answers correctly
/// because we type into the user's real interactive shell.
fn is_host_key_bypass(args: &str) -> bool {
    let lower = args.to_ascii_lowercase();
    [
        "stricthostkeychecking",
        "userknownhostsfile",
        "checkhostip",
        "globalknownhostsfile",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
}

fn valid_hostname(h: &str) -> bool {
    if h.len() > 255 || h.is_empty() {
        return false;
    }
    // Bracketed IPv6, e.g. [2001:db8::1]
    if let Some(inner) = h.strip_prefix('[').and_then(|s| s.strip_suffix(']')) {
        return !inner.is_empty()
            && inner
                .chars()
                .all(|c| c.is_ascii_hexdigit() || c == ':' || c == '.');
    }
    // Hostname or IPv4: alphanumeric ends, dots/dashes/underscores inside.
    let bytes = h.as_bytes();
    if !bytes[0].is_ascii_alphanumeric() || !bytes[bytes.len() - 1].is_ascii_alphanumeric() {
        return false;
    }
    h.chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_')
}

fn valid_username(u: &str) -> bool {
    !u.is_empty()
        && u.len() <= 32
        && u.chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_')
        && u.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
}

const COLORS: [&str; 5] = ["accent", "warning", "error", "success", "text-muted"];

#[cfg(any(target_os = "windows", test))]
fn valid_wsl_identity_path(path: &str) -> bool {
    (path.starts_with('/') || path.starts_with("~/"))
        && !path.contains('\\')
        && !path.split('/').any(|component| component == "..")
}

/// Trims, drops empty optionals, and rejects anything that must never reach a
/// command line. Mutates in place so create/update/import share one path.
fn validate(h: &mut queries::SshHostInput) -> Result<(), String> {
    let clean = |v: &mut Option<String>| {
        if let Some(s) = v.as_mut() {
            let t = s.trim().to_string();
            *v = if t.is_empty() { None } else { Some(t) };
        }
    };

    h.label = h.label.trim().to_string();
    h.hostname = h.hostname.trim().to_string();
    clean(&mut h.username);
    clean(&mut h.identity_file);
    clean(&mut h.jump_host);
    clean(&mut h.extra_args);
    clean(&mut h.remote_dir);
    clean(&mut h.post_connect);
    clean(&mut h.tag);
    clean(&mut h.color);
    clean(&mut h.config_alias);

    // One sweep for control characters across every field — cheaper to reason
    // about than per-field rules, and there is no field where they are valid.
    let all = [
        Some(&h.label),
        Some(&h.hostname),
        h.username.as_ref(),
        h.identity_file.as_ref(),
        h.jump_host.as_ref(),
        h.extra_args.as_ref(),
        h.remote_dir.as_ref(),
        h.post_connect.as_ref(),
        h.tag.as_ref(),
        h.color.as_ref(),
        h.config_alias.as_ref(),
    ];
    if all.iter().flatten().any(|s| has_control_chars(s)) {
        return Err("host fields cannot contain control characters".into());
    }

    if h.label.is_empty() {
        return Err("a label is required".into());
    }
    if h.label.chars().count() > 64 {
        return Err("the label is too long (max 64 characters)".into());
    }
    if !valid_hostname(&h.hostname) {
        return Err(format!(
            "\"{}\" is not a valid hostname or IP address",
            h.hostname
        ));
    }
    if let Some(u) = &h.username {
        if !valid_username(u) {
            return Err(format!("\"{u}\" is not a valid username"));
        }
    }
    match h.port {
        Some(0) => return Err("port must be between 1 and 65535".into()),
        // Normalize the default away so the line stays `ssh host`, and so the
        // importer does not stamp `-p 22` onto every row it reads.
        Some(22) => h.port = None,
        _ => {}
    }
    if let Some(args) = &h.extra_args {
        if is_host_key_bypass(args) {
            return Err(
                "host-key checking options are not allowed — they would disable the protection \
                 that warns you when a server's identity changes"
                    .into(),
            );
        }
        // A bare word here is read as the hostname by both ssh and the app's
        // own nesting detector, which would silently break remote awareness.
        if first_bare_token(args).is_some() {
            return Err(
                "extra options must all be flags (like `-o ConnectTimeout=5`) — a bare word \
                 there would be treated as the hostname"
                    .into(),
            );
        }
    }
    for (field, value, max) in [
        ("remote directory", h.remote_dir.as_ref(), 512usize),
        ("post-connect command", h.post_connect.as_ref(), 512),
        ("identity file", h.identity_file.as_ref(), 1024),
        ("jump host", h.jump_host.as_ref(), 255),
    ] {
        if let Some(v) = value {
            if v.chars().count() > max {
                return Err(format!("the {field} is too long (max {max} characters)"));
            }
        }
    }
    #[cfg(target_os = "windows")]
    if let Some(identity) = &h.identity_file {
        if !valid_wsl_identity_path(identity) {
            return Err(
                "the identity file must be a Linux path in the default WSL distribution".into(),
            );
        }
    }
    if let Some(c) = &h.color {
        if !COLORS.contains(&c.as_str()) {
            return Err(format!("unknown color \"{c}\""));
        }
    }
    if h.source != "manual" && h.source != "ssh_config" {
        return Err(format!("unknown source \"{}\"", h.source));
    }
    Ok(())
}

/// Mirror of the frontend `firstNonFlag(tokenizeCommand(args), 0)`. Kept here
/// so the backend can enforce the rule without trusting the UI; the two are
/// pinned together by tests on both sides.
pub(crate) fn first_bare_token(args: &str) -> Option<String> {
    let words = tokenize(args);
    let mut i = 0;
    while i < words.len() {
        let w = &words[i];
        if w.starts_with('-') {
            let takes_value = if w.contains('=') {
                false
            } else {
                w.starts_with("--") || is_value_flag(w)
            };
            if takes_value && i + 1 < words.len() {
                i += 1;
            }
            i += 1;
            continue;
        }
        return Some(w.clone());
    }
    None
}

fn is_value_flag(w: &str) -> bool {
    let mut chars = w.chars();
    chars.next(); // '-'
    match (chars.next(), chars.next()) {
        (Some(c), None) => "bcDEeFIiJLlmOopQRSWw".contains(c),
        _ => false,
    }
}

fn tokenize(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    for ch in s.trim().chars() {
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

#[tauri::command]
pub fn ssh_hosts_list(db: State<'_, DbState>) -> Result<Vec<queries::SshHost>, String> {
    let conn = db.0.lock().map_err(|_| "db poisoned")?;
    queries::list_ssh_hosts(&conn)
}

/// Single row by id. Returns None when the host was deleted since the tab that
/// references it was opened — a restored tab can easily outlive its host row.
#[tauri::command]
pub fn ssh_hosts_get(
    db: State<'_, DbState>,
    id: String,
) -> Result<Option<queries::SshHost>, String> {
    let conn = db.0.lock().map_err(|_| "db poisoned")?;
    queries::get_ssh_host(&conn, &id)
}

#[tauri::command]
pub fn ssh_hosts_create(
    db: State<'_, DbState>,
    host: queries::SshHostInput,
) -> Result<String, String> {
    let mut host = host;
    validate(&mut host)?;
    let conn = db.0.lock().map_err(|_| "db poisoned")?;
    queries::insert_ssh_host(&conn, &host)
}

#[tauri::command]
pub fn ssh_hosts_update(
    db: State<'_, DbState>,
    id: String,
    host: queries::SshHostInput,
) -> Result<(), String> {
    let mut host = host;
    validate(&mut host)?;
    let conn = db.0.lock().map_err(|_| "db poisoned")?;
    queries::update_ssh_host(&conn, &id, &host)
}

#[tauri::command]
pub fn ssh_hosts_delete(db: State<'_, DbState>, id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|_| "db poisoned")?;
    queries::delete_ssh_host(&conn, &id)
}

#[tauri::command]
pub fn ssh_hosts_touch(db: State<'_, DbState>, id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|_| "db poisoned")?;
    queries::touch_ssh_host(&conn, &id)
}

/// One importable `Host` block, pre-checked against what is already saved.
#[derive(Debug, serde::Serialize)]
pub struct SshConfigCandidate {
    pub host: queries::SshHostInput,
    /// Row this would duplicate — the review UI pre-unchecks these.
    pub existing_id: Option<String>,
}

#[cfg(target_os = "windows")]
struct WslSshContext {
    distribution: String,
    ssh_dir: std::path::PathBuf,
}

#[cfg(target_os = "windows")]
fn wsl_ssh_context() -> Result<WslSshContext, String> {
    let mut command = std::process::Command::new("wsl.exe");
    command
        .args(["--exec", "/usr/bin/env", "-0"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    let output =
        super::settings::command_output_bounded(&mut command, std::time::Duration::from_secs(15))
            .map_err(|error| format!("inspect the default WSL environment: {error}"))?;
    if !output.status.success() {
        return Err("the default WSL distribution is not ready".into());
    }
    let mut distribution = None;
    let mut home = None;
    for entry in output.stdout.split(|byte| *byte == 0) {
        let Ok(entry) = std::str::from_utf8(entry) else {
            continue;
        };
        if let Some(value) = entry.strip_prefix("WSL_DISTRO_NAME=") {
            distribution = Some(value.to_string());
        } else if let Some(value) = entry.strip_prefix("HOME=") {
            home = Some(value.to_string());
        }
    }
    let distribution = distribution.ok_or("WSL did not report its distribution name")?;
    if distribution.is_empty()
        || distribution
            .chars()
            .any(|character| character.is_control() || matches!(character, '/' | '\\'))
    {
        return Err("WSL reported an invalid distribution name".into());
    }
    let home = home.ok_or("WSL did not report its Linux home directory")?;
    if !home.starts_with('/')
        || home.contains('\\')
        || home.split('/').any(|component| component == "..")
    {
        return Err("WSL reported an invalid Linux home directory".into());
    }
    let home_components = home.trim_start_matches('/').replace('/', "\\");
    let ssh_dir = std::path::PathBuf::from(format!(
        r"\\wsl.localhost\{}\{}\.ssh",
        distribution, home_components
    ));
    Ok(WslSshContext {
        distribution,
        ssh_dir,
    })
}

#[tauri::command]
pub fn ssh_wsl_identity_root() -> Result<Option<String>, String> {
    #[cfg(target_os = "windows")]
    {
        Ok(Some(
            wsl_ssh_context()?.ssh_dir.to_string_lossy().into_owned(),
        ))
    }
    #[cfg(not(target_os = "windows"))]
    Ok(None)
}

#[cfg(target_os = "windows")]
fn strip_wsl_unc_prefix<'a>(path: &'a str, prefix: &str) -> Option<&'a str> {
    path.strip_prefix(prefix).or_else(|| {
        let candidate = path.get(..prefix.len())?;
        candidate
            .eq_ignore_ascii_case(prefix)
            .then(|| &path[prefix.len()..])
    })
}

#[cfg(any(target_os = "windows", test))]
fn wsl_regular_file_probe_args(path: &str) -> Vec<String> {
    vec![
        "--exec".into(),
        "/bin/sh".into(),
        "-c".into(),
        "test -f \"$1\"".into(),
        "vterminal-identity-probe".into(),
        path.into(),
    ]
}

#[tauri::command]
pub fn ssh_wsl_path_from_host(path: String) -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        let context = wsl_ssh_context()?;
        let normalized = path.replace('/', "\\");
        let localhost = format!(r"\\wsl.localhost\{}\", context.distribution);
        let legacy = format!(r"\\wsl$\{}\", context.distribution);
        let relative = strip_wsl_unc_prefix(&normalized, &localhost)
            .or_else(|| strip_wsl_unc_prefix(&normalized, &legacy))
            .ok_or(
                "choose a file inside the default WSL distribution, not a Windows or other-distro path",
            )?;
        if relative.is_empty()
            || relative
                .split('\\')
                .any(|component| component.is_empty() || matches!(component, "." | ".."))
        {
            return Err("the selected WSL identity path is invalid".into());
        }
        let linux_path = format!("/{}", relative.replace('\\', "/"));
        let mut probe = std::process::Command::new("wsl.exe");
        probe
            .args(wsl_regular_file_probe_args(&linux_path))
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        let output =
            super::settings::command_output_bounded(&mut probe, std::time::Duration::from_secs(10))
                .map_err(|error| format!("validate the WSL identity file: {error}"))?;
        if !output.status.success() {
            return Err(
                "the selected WSL identity file does not exist or is not a regular file".into(),
            );
        }
        Ok(linux_path)
    }
    #[cfg(not(target_os = "windows"))]
    Ok(path)
}

#[tauri::command]
pub fn ssh_hosts_scan_config(db: State<'_, DbState>) -> Result<Vec<SshConfigCandidate>, String> {
    #[cfg(target_os = "windows")]
    let ssh_dir = wsl_ssh_context()?.ssh_dir;
    #[cfg(not(target_os = "windows"))]
    let ssh_dir = dirs::home_dir()
        .ok_or_else(|| "cannot locate your home directory".to_string())?
        .join(".ssh");
    if !ssh_dir.is_dir() {
        return Ok(vec![]);
    }
    let parsed = crate::ssh_config::scan(&ssh_dir)?;
    let conn = db.0.lock().map_err(|_| "db poisoned")?;

    let mut out = Vec::new();
    for p in parsed {
        let mut host = queries::SshHostInput {
            label: p.alias.clone(),
            // ssh's own fallback when a block has no HostName.
            hostname: p.hostname.unwrap_or_else(|| p.alias.clone()),
            username: p.username,
            port: p.port,
            identity_file: p.identity_file,
            jump_host: p.jump_host,
            source: "ssh_config".into(),
            config_alias: Some(p.alias),
            ..Default::default()
        };
        // A single malformed block must not fail the whole scan.
        if validate(&mut host).is_err() {
            continue;
        }
        let existing_id = queries::find_ssh_host_duplicate(
            &conn,
            host.config_alias.as_deref(),
            &host.hostname,
            host.username.as_deref(),
            host.port,
        )?;
        out.push(SshConfigCandidate { host, existing_id });
    }
    Ok(out)
}

/// Takes only the rows the user ticked — the UI is the review step, so this
/// stays dumb and the unique indexes are the backstop. Returns the count added.
#[tauri::command]
pub fn ssh_hosts_import(
    db: State<'_, DbState>,
    hosts: Vec<queries::SshHostInput>,
) -> Result<u32, String> {
    let conn = db.0.lock().map_err(|_| "db poisoned")?;
    let mut added = 0u32;
    for host in hosts {
        let mut host = host;
        if validate(&mut host).is_err() {
            continue;
        }
        // Re-import must be idempotent, not fatal: skip rows that collide.
        if queries::insert_ssh_host(&conn, &host).is_ok() {
            added += 1;
        }
    }
    Ok(added)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn host(label: &str, hostname: &str) -> queries::SshHostInput {
        queries::SshHostInput {
            label: label.into(),
            hostname: hostname.into(),
            source: "manual".into(),
            ..Default::default()
        }
    }

    #[test]
    fn accepts_a_plain_host() {
        let mut h = host("Prod", "prod-01.example.com");
        assert!(validate(&mut h).is_ok());
    }

    #[test]
    fn wsl_identity_paths_are_linux_only_and_confined_lexically() {
        assert!(valid_wsl_identity_path("~/.ssh/id_ed25519"));
        assert!(valid_wsl_identity_path("/home/casey/.ssh/work key"));
        assert!(!valid_wsl_identity_path(r"C:\Users\casey\.ssh\id_ed25519"));
        assert!(!valid_wsl_identity_path("/home/casey/../root/key"));
    }

    #[test]
    fn wsl_identity_probe_keeps_the_linux_path_out_of_shell_source() {
        let args = wsl_regular_file_probe_args("/home/casey/My Keys/id;still-a-path");
        assert_eq!(
            &args[..5],
            [
                "--exec",
                "/bin/sh",
                "-c",
                "test -f \"$1\"",
                "vterminal-identity-probe"
            ]
        );
        assert_eq!(args.last().unwrap(), "/home/casey/My Keys/id;still-a-path");
        assert!(!args[3].contains("casey"));
    }

    #[test]
    fn trims_and_nulls_empty_optionals() {
        let mut h = host("  Prod  ", " prod-01 ");
        h.username = Some("   ".into());
        h.tag = Some("  web ".into());
        validate(&mut h).unwrap();
        assert_eq!(h.label, "Prod");
        assert_eq!(h.hostname, "prod-01");
        assert_eq!(h.username, None);
        assert_eq!(h.tag.as_deref(), Some("web"));
    }

    #[test]
    fn rejects_control_characters() {
        let mut h = host("Prod", "prod-01");
        h.post_connect = Some("tmux attach\rrm -rf /".into());
        assert!(validate(&mut h).unwrap_err().contains("control characters"));
    }

    #[test]
    fn rejects_a_bad_hostname() {
        for bad in ["prod 01", "prod;01", "-prod", "prod-", "$(whoami)", ""] {
            let mut h = host("X", bad);
            assert!(validate(&mut h).is_err(), "should reject hostname {bad:?}");
        }
    }

    #[test]
    fn accepts_ip_addresses() {
        for good in ["10.0.0.5", "[2001:db8::1]"] {
            let mut h = host("X", good);
            assert!(validate(&mut h).is_ok(), "should accept hostname {good:?}");
        }
    }

    #[test]
    fn normalizes_the_default_port_away() {
        let mut h = host("Prod", "prod-01");
        h.port = Some(22);
        validate(&mut h).unwrap();
        assert_eq!(h.port, None);

        let mut h = host("Prod", "prod-01");
        h.port = Some(0);
        assert!(validate(&mut h).is_err());

        let mut h = host("Prod", "prod-01");
        h.port = Some(2222);
        validate(&mut h).unwrap();
        assert_eq!(h.port, Some(2222));
    }

    #[test]
    fn rejects_host_key_bypass_options() {
        for bad in [
            "-o StrictHostKeyChecking=no",
            "-o stricthostkeychecking=accept-new",
            "-o UserKnownHostsFile=/dev/null",
        ] {
            let mut h = host("Prod", "prod-01");
            h.extra_args = Some(bad.into());
            assert!(
                validate(&mut h).unwrap_err().contains("host-key"),
                "should reject extra args {bad:?}"
            );
        }
    }

    #[test]
    fn rejects_a_bare_word_in_extra_args() {
        let mut h = host("Prod", "prod-01");
        h.extra_args = Some("-v somehost".into());
        assert!(validate(&mut h).unwrap_err().contains("bare word"));
    }

    #[test]
    fn accepts_flag_only_extra_args() {
        let mut h = host("Prod", "prod-01");
        // -o consumes its value; -vv is valueless; the quoted value stays whole.
        h.extra_args = Some("-o ConnectTimeout=5 -vv -o \"ProxyCommand=nc -X 5 %h %p\"".into());
        assert!(validate(&mut h).is_ok());
    }

    #[test]
    fn first_bare_token_skips_flags_and_their_values() {
        assert_eq!(first_bare_token("-p 2222 -i /k/id"), None);
        assert_eq!(first_bare_token("-vv"), None);
        assert_eq!(first_bare_token("--user=root"), None);
        assert_eq!(first_bare_token("-p 2222 host"), Some("host".into()));
        assert_eq!(first_bare_token("host -v"), Some("host".into()));
    }

    #[test]
    fn rejects_an_unknown_color() {
        let mut h = host("Prod", "prod-01");
        h.color = Some("chartreuse".into());
        assert!(validate(&mut h).is_err());
        h.color = Some("accent".into());
        assert!(validate(&mut h).is_ok());
    }
}
