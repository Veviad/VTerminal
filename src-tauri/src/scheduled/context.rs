//! Grounding for a run with no terminal to read.
//!
//! `TerminalContext::render()` (used by every interactive agent turn) is built
//! from a live xterm buffer: recent blocks, the visible screen tail, whether
//! shell integration is active. A scheduled run has none of that, and a headless
//! one has no xterm at all — so this renders the same *kind* of grounding from
//! facts the backend already knows, and says plainly what it does not know.
//!
//! Saying so matters. The interactive prompt's context implicitly promises the
//! model that recent history is visible; silence here would leave it inferring
//! that the shell is fresh when it may be a reused tab, or that it can look at
//! the screen when it cannot.

use super::types::{ExecutionMode, ScheduledTarget};

pub struct ScheduledContext<'a> {
    pub action_name: &'a str,
    pub execution_mode: ExecutionMode,
    pub target: &'a ScheduledTarget,
    /// How the remote transport describes itself, from
    /// `CommandWrapper::describe`. `None` for a local target.
    pub target_description: Option<String>,
    pub shell: &'a str,
    pub os: &'a str,
    pub step_count: usize,
    pub step_index: usize,
    pub step_title: &'a str,
}

impl ScheduledContext<'_> {
    pub fn render(&self) -> String {
        let mut out = String::from("Run context:\n");
        out.push_str(&format!("- scheduled action: {}\n", self.action_name));
        out.push_str(&format!(
            "- step {} of {}: {}\n",
            self.step_index + 1,
            self.step_count,
            self.step_title
        ));
        out.push_str(&format!("- os: {}\n", self.os));
        match self.target {
            ScheduledTarget::LocalShell { cwd } => {
                out.push_str(&format!("- shell: {}\n", self.shell));
                match cwd {
                    Some(dir) => out.push_str(&format!("- working directory: {dir}\n")),
                    None => out.push_str(
                        "- working directory: the shell's own default for this machine\n",
                    ),
                }
            }
            ScheduledTarget::SshHost { .. } => {
                let described = self
                    .target_description
                    .as_deref()
                    .unwrap_or("a saved remote host over ssh");
                out.push_str(&format!("- target: {described}\n"));
                // The remote's own cwd and branch are deliberately withheld:
                // reporting the LOCAL values for a remote machine is the exact
                // mistake `detectNesting` exists to prevent interactively.
                out.push_str(
                    "- every command in this step runs on that remote host, not on this \
                     machine. There is no interactive session and no tty: nothing can \
                     prompt, and a command that waits for input will simply time out.\n",
                );
            }
        }
        match self.execution_mode {
            ExecutionMode::Headless => out.push_str(
                "- there is no visible terminal. Command output is captured and returned to \
                 you, and only the tail of it is kept on the run record.\n",
            ),
            ExecutionMode::Tab => out.push_str(
                "- commands run in a real terminal tab in the app, which may be a tab an \
                 earlier run of this action already used. Do not assume the shell is fresh; \
                 check anything you depend on.\n",
            ),
        }
        out.push_str(
            "- you cannot see previous output from this run's earlier steps unless it is \
             quoted for you below.\n",
        );
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx<'a>(target: &'a ScheduledTarget, mode: ExecutionMode) -> ScheduledContext<'a> {
        ScheduledContext {
            action_name: "nightly checks",
            execution_mode: mode,
            target,
            target_description: Some("prod-01 (deploy@prod-01.test) over ssh".into()),
            shell: "/bin/zsh",
            os: "macos",
            step_count: 3,
            step_index: 1,
            step_title: "summarise disk usage",
        }
    }

    #[test]
    fn a_local_context_names_the_shell_and_the_working_directory() {
        let target = ScheduledTarget::LocalShell {
            cwd: Some("/srv/app".into()),
        };
        let rendered = ctx(&target, ExecutionMode::Headless).render();
        assert!(rendered.contains("step 2 of 3"));
        assert!(rendered.contains("/bin/zsh"));
        assert!(rendered.contains("/srv/app"));
        assert!(rendered.contains("no visible terminal"));
    }

    /// The local shell path and cwd describe THIS machine and would be a lie for
    /// a remote target — the same reason nesting withholds them interactively.
    #[test]
    fn a_remote_context_withholds_local_facts_and_says_there_is_no_tty() {
        let target = ScheduledTarget::SshHost {
            host_id: "h1".into(),
        };
        let rendered = ctx(&target, ExecutionMode::Headless).render();
        assert!(rendered.contains("prod-01"));
        assert!(rendered.contains("no tty"));
        assert!(!rendered.contains("/bin/zsh"), "{rendered}");
        assert!(!rendered.contains("working directory"), "{rendered}");
    }

    #[test]
    fn a_tab_run_warns_that_the_shell_may_be_reused() {
        let target = ScheduledTarget::LocalShell { cwd: None };
        let rendered = ctx(&target, ExecutionMode::Tab).render();
        assert!(rendered.contains("may be a tab an earlier run"));
    }
}
