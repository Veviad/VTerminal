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
}

#[derive(Debug, Clone, Deserialize)]
pub struct BlockSummary {
    pub command: String,
    pub exit_code: Option<i32>,
    pub output_tail: String,
}

const MAX_BLOCKS: usize = 8;
const MAX_TAIL_CHARS: usize = 2048;
const MAX_SCREEN_CHARS: usize = 4096;

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
        };
        assert_eq!(r.describe(), "docker");
    }
}
