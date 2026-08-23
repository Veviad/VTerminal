use serde::Deserialize;

/// Terminal context assembled frontend-side (the frontend owns cwd/branch
/// tracking via OSC 7/133); the backend just folds it into the prompt.
#[derive(Debug, Clone, Deserialize)]
pub struct TerminalContext {
    pub session_id: String,
    pub cwd: Option<String>,
    pub shell: String,
    pub git_branch: Option<String>,
    pub os: String,
    #[serde(default)]
    pub recent_blocks: Vec<BlockSummary>,
    /// Set when the visible tab is inside a nested shell (ssh, docker exec, …).
    #[serde(default)]
    pub remote: Option<RemoteContext>,
    /// Capped snapshot of what is on screen — the only grounding available when
    /// the shell emits no OSC markers.
    #[serde(default)]
    pub screen_tail: String,
    #[serde(default)]
    pub shell_integration: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RemoteContext {
    pub kind: String,
    pub target: Option<String>,
    #[serde(default)]
    pub host_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct BlockSummary {
    pub command: String,
    pub exit_code: Option<i32>,
    pub output_tail: String,
}

/// The two immutable execution environments attached to one Sidecar agent run.
///
/// This is an optional `agent_start` argument rather than a replacement for
/// `TerminalContext`: older/single-terminal callers keep sending exactly the
/// context they do today, while a linked caller adds this role-labelled pair.
#[derive(Debug, Clone, Deserialize)]
pub struct SidecarTargets {
    pub local: TerminalContext,
    pub remote: TerminalContext,
}

const MAX_BLOCKS: usize = 8;
const MAX_TAIL_CHARS: usize = 2048;
const MAX_SCREEN_CHARS: usize = 4096;
/// Both targets share one prompt budget. Each receives half, so activity is
/// trimmed symmetrically instead of allowing a noisy host to evict the other.
const MAX_SIDECAR_CONTEXT_CHARS: usize = 12_000;

impl RemoteContext {
    /// `ssh prod-01` / `docker exec` — for prompts and the approval card.
    pub fn describe(&self) -> String {
        match &self.target {
            Some(t) if !t.is_empty() => format!("{} {}", self.kind, t),
            _ => self.kind.clone(),
        }
    }
}

impl TerminalContext {
    /// Renders the environment header + recent commands, hard-capped so the
    /// prompt stays well under the context budget.
    pub fn render(&self) -> String {
        let mut out = self.render_identity();
        out.push_str(&self.render_activity());
        out
    }

    fn render_identity(&self) -> String {
        let mut out = String::new();

        // Lead with the session's nature. Getting this wrong is worse than
        // omitting it: a model told "Working directory: /Users/me/app" while the
        // user is SSH'd into a server will confidently reason about the wrong
        // machine's filesystem.
        if let Some(remote) = &self.remote {
            out.push_str(&format!(
                "The visible terminal is INSIDE a nested session ({}). Commands you run go to \
                 that remote/nested environment, NOT to the local machine. The local machine's \
                 working directory and git branch do not apply and are not shown. Assume a \
                 POSIX shell and avoid macOS/BSD-specific flags unless you have verified them.\n",
                remote.describe()
            ));
        } else {
            out.push_str(&format!("OS: {}\nShell: {}\n", self.os, self.shell));
            if let Some(cwd) = &self.cwd {
                out.push_str(&format!("Working directory: {cwd}\n"));
            }
            if let Some(branch) = &self.git_branch {
                out.push_str(&format!("Git branch: {branch}\n"));
            }
        }

        out
    }

    fn render_activity(&self) -> String {
        let mut out = String::new();
        let blocks: Vec<&BlockSummary> = self
            .recent_blocks
            .iter()
            .rev()
            .take(MAX_BLOCKS)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        if !blocks.is_empty() {
            out.push_str("\nRecent commands (oldest first):\n");
            for b in blocks {
                let exit = b
                    .exit_code
                    .map(|c| format!(" (exit {c})"))
                    .unwrap_or_default();
                out.push_str(&format!("$ {}{exit}\n", b.command));
                if !b.output_tail.is_empty() {
                    out.push_str(&format!("{}\n", tail(&b.output_tail, MAX_TAIL_CHARS)));
                }
            }
        }

        if !self.screen_tail.trim().is_empty() {
            out.push_str("\nCurrently visible on screen (most recent output):\n");
            out.push_str(&tail(&self.screen_tail, MAX_SCREEN_CHARS));
            out.push('\n');
        }
        out
    }

    /// Render one half of a linked context while preserving its identity and
    /// the newest activity. The oldest command/output material is what yields
    /// when this terminal exceeds its fair half of the combined budget.
    fn render_sidecar_target(&self, role: &str, max: usize) -> String {
        let heading = format!("=== SIDECAR TARGET: {role} ===\n");
        let identity = self.render_identity();
        let ending = format!("=== END SIDECAR TARGET: {role} ===\n");
        let fixed_len = heading.len() + identity.len() + ending.len();
        if fixed_len >= max {
            return truncate_head(&(heading + &identity + &ending), max);
        }

        let activity = self.render_activity();
        let available = max - fixed_len;
        let activity = if activity.len() <= available {
            activity
        } else {
            let marker = "\n[older terminal activity trimmed]\n";
            let keep = available.saturating_sub(marker.len());
            format!("{marker}{}", tail_within(&activity, keep))
        };
        format!("{heading}{identity}{activity}{ending}")
    }
}

impl SidecarTargets {
    /// Fail closed on a stale or incorrectly labelled pairing before a provider
    /// is loaded. The frontend performs richer live/idle checks; these are the
    /// role and identity invariants the backend can verify from the IPC value.
    pub fn validate(&self) -> Result<(), String> {
        if self.local.session_id.trim().is_empty() || self.remote.session_id.trim().is_empty() {
            return Err("sidecar targets must have non-empty session ids".into());
        }
        if self.local.session_id == self.remote.session_id {
            return Err(
                "sidecar local and remote targets must be different terminal sessions".into(),
            );
        }
        if self.local.remote.is_some() {
            return Err("sidecar local target is inside a nested session".into());
        }
        let Some(remote) = &self.remote.remote else {
            return Err("sidecar remote target is not inside an SSH session".into());
        };
        if !remote.kind.eq_ignore_ascii_case("ssh") {
            return Err(format!(
                "sidecar remote target must be an SSH session, not {}",
                remote.kind
            ));
        }
        if remote
            .target
            .as_deref()
            .is_none_or(|target| target.trim().is_empty())
        {
            return Err("sidecar remote target has no validated SSH identity".into());
        }
        Ok(())
    }

    /// Render two unmistakably separated environments under one hard cap.
    pub fn render(&self) -> String {
        let intro = "SIDECAR MODE: two separate terminal environments are linked. Facts, paths, \n\
credentials, environment variables, and command results belong only to the labelled target.\n\
Never assume state is shared between LOCAL and REMOTE.\n\n";
        let target_budget = MAX_SIDECAR_CONTEXT_CHARS
            .saturating_sub(intro.len())
            .saturating_sub(1)
            / 2;
        let local = self.local.render_sidecar_target("LOCAL", target_budget);
        let remote = self.remote.render_sidecar_target("REMOTE", target_budget);
        let rendered = format!("{intro}{local}\n{remote}");
        debug_assert!(rendered.len() <= MAX_SIDECAR_CONTEXT_CHARS);
        rendered
    }
}

/// Last `max` characters, cut on a char boundary.
fn tail(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_string();
    }
    let mut cut = text.len() - max;
    while !text.is_char_boundary(cut) {
        cut += 1;
    }
    format!("…{}", &text[cut..])
}

/// First `max` bytes, cut on a char boundary. Used only for pathological
/// identity metadata that alone exceeds a target's complete prompt allowance.
fn truncate_head(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_string();
    }
    if max == 0 {
        return String::new();
    }
    let marker = "…";
    let mut cut = max.saturating_sub(marker.len());
    while !text.is_char_boundary(cut) {
        cut -= 1;
    }
    if cut == 0 {
        return String::new();
    }
    format!("{}{marker}", &text[..cut])
}

/// A newest-content tail whose marker is included inside `max` (unlike the
/// legacy `tail`, whose caps predate the strict combined Sidecar ceiling).
fn tail_within(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_string();
    }
    let marker = "…";
    if max <= marker.len() {
        return String::new();
    }
    let keep = max - marker.len();
    let mut cut = text.len() - keep;
    while !text.is_char_boundary(cut) {
        cut += 1;
    }
    format!("{marker}{}", &text[cut..])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> TerminalContext {
        TerminalContext {
            session_id: "s1".into(),
            cwd: Some("/Users/me/app".into()),
            shell: "/bin/zsh".into(),
            git_branch: Some("main".into()),
            os: "macOS".into(),
            recent_blocks: vec![],
            remote: None,
            screen_tail: String::new(),
            shell_integration: true,
        }
    }

    #[test]
    fn local_context_reports_cwd() {
        let rendered = base().render();
        assert!(rendered.contains("Working directory: /Users/me/app"));
        assert!(rendered.contains("Git branch: main"));
    }

    /// The whole point of the feature: while nested, the local cwd must never
    /// be presented as the current directory.
    #[test]
    fn nested_context_hides_local_cwd_and_names_the_target() {
        let ctx = TerminalContext {
            remote: Some(RemoteContext {
                kind: "ssh".into(),
                target: Some("prod-01".into()),
                host_id: None,
            }),
            ..base()
        };
        let rendered = ctx.render();
        assert!(
            !rendered.contains("/Users/me/app"),
            "local cwd leaked into a remote session"
        );
        assert!(
            !rendered.contains("main"),
            "local branch leaked into a remote session"
        );
        assert!(rendered.contains("ssh prod-01"));
        assert!(rendered.contains("NOT to the local machine"));
    }

    #[test]
    fn screen_tail_is_included_and_capped() {
        let ctx = TerminalContext {
            screen_tail: "x".repeat(MAX_SCREEN_CHARS + 500),
            ..base()
        };
        let rendered = ctx.render();
        assert!(rendered.contains("Currently visible on screen"));
        assert!(
            rendered.contains('…'),
            "oversized screen tail must be truncated"
        );
        assert!(rendered.len() < MAX_SCREEN_CHARS + 1000);
    }

    #[test]
    fn describe_handles_missing_target() {
        let r = RemoteContext {
            kind: "docker".into(),
            target: None,
            host_id: None,
        };
        assert_eq!(r.describe(), "docker");
    }

    fn sidecar() -> SidecarTargets {
        SidecarTargets {
            local: base(),
            remote: TerminalContext {
                session_id: "s2".into(),
                cwd: Some("/Users/me/app".into()),
                git_branch: Some("main".into()),
                remote: Some(RemoteContext {
                    kind: "ssh".into(),
                    target: Some("deploy@prod-01".into()),
                    host_id: None,
                }),
                ..base()
            },
        }
    }

    #[test]
    fn sidecar_context_is_role_labelled_and_does_not_leak_local_facts_remote() {
        let rendered = sidecar().render();
        assert!(rendered.contains("SIDECAR TARGET: LOCAL"));
        assert!(rendered.contains("SIDECAR TARGET: REMOTE"));
        assert_eq!(
            rendered.matches("Working directory: /Users/me/app").count(),
            1
        );
        assert_eq!(rendered.matches("Git branch: main").count(), 1);
        assert!(rendered.contains("ssh deploy@prod-01"));
    }

    #[test]
    fn sidecar_context_has_one_even_combined_cap() {
        let mut targets = sidecar();
        let noisy = (0..20)
            .map(|i| BlockSummary {
                command: format!("command-{i}"),
                exit_code: Some(0),
                output_tail: format!("output-{i}-{}", "x".repeat(3000)),
            })
            .collect::<Vec<_>>();
        targets.local.recent_blocks = noisy.clone();
        targets.remote.recent_blocks = noisy;
        targets.local.screen_tail = "l".repeat(2_000);
        targets.remote.screen_tail = "r".repeat(2_000);

        let rendered = targets.render();
        assert!(rendered.len() <= MAX_SIDECAR_CONTEXT_CHARS);
        assert_eq!(
            rendered.matches("older terminal activity trimmed").count(),
            2
        );
        assert!(rendered.contains("command-19"));
    }

    #[test]
    fn sidecar_validation_pins_local_and_ssh_roles() {
        assert!(sidecar().validate().is_ok());

        let mut same = sidecar();
        same.remote.session_id = same.local.session_id.clone();
        assert!(same.validate().unwrap_err().contains("different"));

        let mut nested_local = sidecar();
        nested_local.local.remote = nested_local.remote.remote.clone();
        assert!(nested_local
            .validate()
            .unwrap_err()
            .contains("local target"));

        let mut docker_remote = sidecar();
        docker_remote.remote.remote.as_mut().unwrap().kind = "docker".into();
        assert!(docker_remote.validate().unwrap_err().contains("SSH"));
    }
}
