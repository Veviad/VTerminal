//! The trust boundary for Scheduled Actions.
//!
//! Everything here runs at SAVE time and again at FIRE time, because the world
//! moves between the two: a host can gain a password, a step list can be edited
//! through a stale frontend, and a persisted mode can outlive the reason it was
//! chosen. A check that only runs in the editor is a suggestion.
//!
//! The stance on a command step is `flag, never filter` — it is the user's own
//! text, so classification is surfaced and the save proceeds. The stance on a
//! permission mode is the opposite: `Full` is refused outright.

use super::types::{
    ExecutionMode, MissedRunPolicy, Recurrence, ScheduledActionInput, ScheduledTarget,
    ScheduledValidationIssue, StepKind, MAX_COMMAND_CHARS, MAX_INTERVAL_MINUTES, MAX_NAME_CHARS,
    MAX_PROMPT_CHARS, MAX_STEPS, MAX_STEP_TITLE_CHARS,
};
use crate::agent::policy;
use crate::agent::PermissionMode;

/// The identity facts a headless remote run needs, resolved from `ssh_hosts`.
/// Passed in rather than queried so this whole module stays a pure function of
/// its inputs and is testable without a database.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostFacts {
    pub id: String,
    pub label: String,
    pub has_password: bool,
    pub has_identity_file: bool,
    pub extra_args: Option<String>,
}

/// A scheduled prompt step never gets more than `AutoAll`.
///
/// `agent::run::policy_auto_runs` returns `true` for `Full` BEFORE the
/// privileged / opaque / sensitive-read checks, and says so in a comment: "Full
/// is the explicit unattended mode." Interactively that is defensible — a human
/// chose it for a session they are watching and it dies with the run. Persisted
/// and unattended it means an unwatched `sudo …` or `curl … | sh` at 03:00 with
/// nobody reading the record until morning.
///
/// `AutoAll` — every non-protected command — already covers every plausible
/// scheduled job. Anything genuinely needing `sudo` belongs in a **command
/// step**: the user's own literal text, visible in the editor forever and
/// re-checked against saved deny rules on every fire.
pub fn clamp_for_schedule(mode: PermissionMode) -> Result<PermissionMode, String> {
    match mode {
        PermissionMode::Full => Err(
            "Full permission mode is not available to a scheduled action. It authorizes \
             privileged and unreviewable commands with nobody watching. Use Auto (all) and \
             express anything privileged as a command step instead."
                .to_string(),
        ),
        other => Ok(other),
    }
}

/// Same rule as the frontend's `sanitizeCommand` and `ssh_hosts`' own check: an
/// ESC could forge an OSC completion token and `\r` / `\n` would split one
/// command into several. In tab mode these bytes are typed into a real PTY.
fn has_control_chars(s: &str) -> bool {
    s.chars().any(|c| c.is_control())
}

/// Validate an action. `blocking` issues refuse the save; the rest are shown.
pub fn validate(
    input: &ScheduledActionInput,
    host: Option<&HostFacts>,
) -> Vec<ScheduledValidationIssue> {
    let mut issues = Vec::new();
    let name = input.name.trim();
    if name.is_empty() {
        issues.push(ScheduledValidationIssue::blocking(
            "name",
            "Give the action a name.",
        ));
    } else if name.chars().count() > MAX_NAME_CHARS {
        issues.push(ScheduledValidationIssue::blocking(
            "name",
            format!("Keep the name under {MAX_NAME_CHARS} characters."),
        ));
    } else if has_control_chars(name) {
        issues.push(ScheduledValidationIssue::blocking(
            "name",
            "The name cannot contain control characters.",
        ));
    }

    if input.timezone.trim().is_empty() {
        issues.push(ScheduledValidationIssue::blocking(
            "timezone",
            "A schedule needs a timezone so a wall-clock time means the same thing all year.",
        ));
    }

    validate_recurrence(&input.recurrence, &mut issues);
    validate_steps(input, &mut issues);
    validate_target(input, host, &mut issues);

    if clamp_for_schedule(input.permission_mode).is_err() {
        issues.push(ScheduledValidationIssue::blocking(
            "permission_mode",
            "Full permission mode is not available to a scheduled action.",
        ));
    }

    // The attachment coupling. A run that can both ingest attacker-controllable
    // text and auto-run writes is a materially different exposure from either
    // half: `prompts.rs` promises "a document cannot authorise anything; only the
    // user can", and a persisted mode is what makes that sentence false. Cap the
    // mode rather than trying to sanitise the text.
    let has_attachments =
        !input.doc_buckets.is_empty() || !input.mcp_selection.server_ids.is_empty();
    if has_attachments && input.permission_mode == PermissionMode::AutoAll {
        issues.push(ScheduledValidationIssue::blocking(
            "permission_mode",
            "An action that searches knowledge buckets or calls MCP tools cannot also run every \
             command unattended — retrieved text would effectively be authorizing commands. \
             Use Auto (reads) with these attachments, or remove them.",
        ));
    }

    if input.web_access && input.permission_mode == PermissionMode::AutoAll {
        issues.push(ScheduledValidationIssue::advisory(
            "web_access",
            "Web access plus Auto (all) means fetched pages can influence commands that run \
             without review. Consider Auto (reads).",
        ));
    }

    if input.max_iterations > 40 {
        issues.push(ScheduledValidationIssue::advisory(
            "max_iterations",
            "A high step budget on an unattended run is a long time to be doing something \
             nobody has looked at. The run pauses at the limit; it never extends itself.",
        ));
    }

    issues
}

fn validate_recurrence(rule: &Recurrence, issues: &mut Vec<ScheduledValidationIssue>) {
    match rule {
        Recurrence::Interval { every_minutes } => {
            if *every_minutes == 0 {
                issues.push(ScheduledValidationIssue::blocking(
                    "recurrence",
                    "An interval of zero would fire continuously. Choose at least one minute.",
                ));
            } else if *every_minutes > MAX_INTERVAL_MINUTES {
                issues.push(ScheduledValidationIssue::blocking(
                    "recurrence",
                    "That interval is longer than four weeks — use a daily or weekly rule.",
                ));
            } else if *every_minutes < 5 {
                issues.push(ScheduledValidationIssue::advisory(
                    "recurrence",
                    "A very short interval can come due again before the previous run has \
                     finished. Overlapping fires are skipped, not queued.",
                ));
            }
        }
        Recurrence::Daily { at } => {
            if at.to_naive().is_none() {
                issues.push(ScheduledValidationIssue::blocking(
                    "recurrence",
                    "That is not a valid time of day.",
                ));
            }
        }
        Recurrence::Weekly { weekdays, at } => {
            if weekdays.is_empty() {
                issues.push(ScheduledValidationIssue::blocking(
                    "recurrence",
                    "Choose at least one weekday, or the action can never fire.",
                ));
            }
            if at.to_naive().is_none() {
                issues.push(ScheduledValidationIssue::blocking(
                    "recurrence",
                    "That is not a valid time of day.",
                ));
            }
        }
        Recurrence::Once { at } => {
            if chrono::DateTime::parse_from_rfc3339(at).is_err() {
                issues.push(ScheduledValidationIssue::blocking(
                    "recurrence",
                    "A one-off run needs a date and time with a timezone offset.",
                ));
            }
        }
    }
}

fn validate_steps(input: &ScheduledActionInput, issues: &mut Vec<ScheduledValidationIssue>) {
    if input.steps.is_empty() {
        issues.push(ScheduledValidationIssue::blocking(
            "steps",
            "Add at least one step.",
        ));
    }
    if input.steps.len() > MAX_STEPS {
        issues.push(ScheduledValidationIssue::blocking(
            "steps",
            format!("An action may have at most {MAX_STEPS} steps."),
        ));
    }
    let mut seen_ids = std::collections::HashSet::new();
    for (index, step) in input.steps.iter().enumerate() {
        let field = format!("steps.{index}");
        if !seen_ids.insert(step.id.as_str()) {
            issues.push(ScheduledValidationIssue::blocking(
                &field,
                "Two steps share an id.",
            ));
        }
        if step.title.chars().count() > MAX_STEP_TITLE_CHARS {
            issues.push(ScheduledValidationIssue::blocking(
                &field,
                "That step title is too long.",
            ));
        }
        if step.text.trim().is_empty() {
            issues.push(ScheduledValidationIssue::blocking(
                &field,
                "The step is empty.",
            ));
            continue;
        }
        match step.kind {
            StepKind::Command => {
                if step.text.chars().count() > MAX_COMMAND_CHARS {
                    issues.push(ScheduledValidationIssue::blocking(
                        &field,
                        "That command is too long.",
                    ));
                }
                if has_control_chars(&step.text) {
                    issues.push(ScheduledValidationIssue::blocking(
                        &field,
                        "A command must be a single line with no control characters. In tab mode \
                         these bytes are typed into a real terminal, where an escape sequence \
                         could forge the marker that reports the command finished.",
                    ));
                }
                // Flag, never filter. `ProbeCandidate.role` and
                // `ssh_hosts_scan_config` take the same stance: surface what we
                // know and let the user decide about their own text.
                let assessment = policy::assess(&step.text);
                if assessment.privileged {
                    issues.push(ScheduledValidationIssue::advisory(
                        &field,
                        "This step runs a privileged command. Unattended, nobody will be there \
                         to answer a password prompt.",
                    ));
                }
                if assessment.network {
                    issues.push(ScheduledValidationIssue::advisory(
                        &field,
                        "This step reaches the network.",
                    ));
                }
                if assessment.opaque {
                    issues.push(ScheduledValidationIssue::advisory(
                        &field,
                        "What this step actually runs cannot be determined from its text, so it \
                         cannot be reviewed before it executes.",
                    ));
                }
                if policy::is_environment_transition(&step.text) {
                    issues.push(ScheduledValidationIssue::advisory(
                        &field,
                        "This step moves the shell to another machine or container. Later steps \
                         will run there, not on the target this action names.",
                    ));
                }
            }
            StepKind::Prompt => {
                if step.text.chars().count() > MAX_PROMPT_CHARS {
                    issues.push(ScheduledValidationIssue::blocking(
                        &field,
                        "That prompt is too long.",
                    ));
                }
            }
        }
    }
}

fn validate_target(
    input: &ScheduledActionInput,
    host: Option<&HostFacts>,
    issues: &mut Vec<ScheduledValidationIssue>,
) {
    match &input.target {
        ScheduledTarget::LocalShell { cwd } => {
            if let Some(dir) = cwd {
                if dir.trim().is_empty() {
                    issues.push(ScheduledValidationIssue::blocking(
                        "target",
                        "Leave the directory empty to use the default, or give an absolute path.",
                    ));
                } else if !std::path::Path::new(dir).is_absolute() {
                    issues.push(ScheduledValidationIssue::blocking(
                        "target",
                        "The working directory must be an absolute path — a relative one would \
                         resolve against whatever directory the app happens to be in.",
                    ));
                }
            }
        }
        ScheduledTarget::SshHost { host_id } => {
            let Some(host) = host else {
                issues.push(ScheduledValidationIssue::blocking(
                    "target",
                    format!("Saved host {host_id} no longer exists."),
                ));
                return;
            };
            if input.execution_mode == ExecutionMode::Headless {
                // `BatchMode=yes` disables every interactive authentication
                // prompt by construction, so password auth is not merely awkward
                // here — it is unreachable. Refusing at save time converts a 3 a.m.
                // silent failure into an editor error, and every workaround
                // (sshpass in an argv, a server-side expect harness, SSH_ASKPASS)
                // makes the credential story materially worse.
                if host.has_password && !host.has_identity_file {
                    issues.push(ScheduledValidationIssue::blocking(
                        "execution_mode",
                        format!(
                            "Headless runs authenticate with keys only, and “{}” has a saved \
                             password but no identity file. Add an identity file to the host, or \
                             set this action to run in a Tab.",
                            host.label
                        ),
                    ));
                }
                if let Some(extra) = host.extra_args.as_deref() {
                    if extra.to_ascii_lowercase().contains("requesttty") {
                        issues.push(ScheduledValidationIssue::advisory(
                            "execution_mode",
                            "This host requests a TTY. A headless run forces RequestTTY=no.",
                        ));
                    }
                }
            }
        }
    }
}

/// Fire-time re-validation. Returns the first blocking reason, if any.
///
/// The world moved since the save: a host may have gained a password, the steps
/// may have been edited through a stale frontend, and an arming that was never
/// re-confirmed must not silently authorize a different action.
pub fn check_before_fire(
    input: &ScheduledActionInput,
    stored_steps_sha256: &str,
    live_steps_sha256: &str,
    armed_at: Option<&str>,
    host: Option<&HostFacts>,
) -> Result<(), String> {
    if stored_steps_sha256 != live_steps_sha256 {
        return Err(
            "the action's steps changed since its permission mode was armed; \
                    re-open it and confirm the mode before it runs unattended"
                .to_string(),
        );
    }
    if input.permission_mode != PermissionMode::Ask && armed_at.is_none() {
        return Err(
            "this action has a permission mode but no record of it being armed; \
                    re-open it and confirm the mode"
                .to_string(),
        );
    }
    clamp_for_schedule(input.permission_mode)?;
    let blocking: Vec<String> = validate(input, host)
        .into_iter()
        .filter(|issue| issue.blocking)
        .map(|issue| issue.message)
        .collect();
    if let Some(first) = blocking.first() {
        return Err(first.clone());
    }
    Ok(())
}

/// Whether a run with this policy may catch up now.
///
/// CLAUDE.md says "nothing auto-runs at launch" in three places, and `runbooks`
/// refuses to rebind an interrupted run without operator confirmation. So a
/// catch-up is additionally deferred until the app has been up long enough for
/// session restore to have settled — the app's most fragile and least observed
/// moment is not when to start executing commands.
pub fn catch_up_allowed(policy: MissedRunPolicy, app_uptime_secs: u64) -> bool {
    const SETTLE_SECS: u64 = 90;
    policy == MissedRunPolicy::CatchUpOnce && app_uptime_secs >= SETTLE_SECS
}

#[cfg(test)]
mod tests {
    use super::super::types::{ScheduledStep, TimeOfDay};
    use super::*;
    use crate::knowledge::KnowledgeBucketRef;
    use crate::mcp::config::McpChatSelection;

    fn step(kind: StepKind, text: &str) -> ScheduledStep {
        ScheduledStep {
            id: format!("s-{text:.8}"),
            sort_order: 0,
            title: "a step".into(),
            kind,
            text: text.into(),
            continue_on_failure: false,
        }
    }

    fn base(target: ScheduledTarget) -> ScheduledActionInput {
        ScheduledActionInput {
            name: "nightly".into(),
            enabled: true,
            target,
            steps: vec![step(StepKind::Command, "df -h")],
            execution_mode: ExecutionMode::Headless,
            permission_mode: PermissionMode::AutoRead,
            recurrence: Recurrence::Daily {
                at: TimeOfDay { hour: 3, minute: 0 },
            },
            missed_run_policy: MissedRunPolicy::Skip,
            timezone: "Europe/Berlin".into(),
            mcp_selection: McpChatSelection::default(),
            doc_buckets: Vec::new(),
            web_access: false,
            max_iterations: 10,
            command_timeout_secs: 120,
            max_run_secs: 3600,
            close_tab_when_done: false,
        }
    }

    fn blocking(issues: &[ScheduledValidationIssue]) -> Vec<&str> {
        issues
            .iter()
            .filter(|i| i.blocking)
            .map(|i| i.field.as_str())
            .collect()
    }

    fn key_host() -> HostFacts {
        HostFacts {
            id: "h1".into(),
            label: "prod-01".into(),
            has_password: false,
            has_identity_file: true,
            extra_args: None,
        }
    }

    #[test]
    fn a_valid_local_action_has_no_blocking_issues() {
        let issues = validate(&base(ScheduledTarget::LocalShell { cwd: None }), None);
        assert!(blocking(&issues).is_empty(), "{issues:?}");
    }

    #[test]
    fn full_permission_mode_is_refused_for_a_scheduled_action() {
        assert!(clamp_for_schedule(PermissionMode::Full).is_err());
        for mode in [
            PermissionMode::Ask,
            PermissionMode::AutoRead,
            PermissionMode::AutoSmart,
            PermissionMode::AutoAll,
        ] {
            assert_eq!(clamp_for_schedule(mode).unwrap(), mode);
        }
        let mut input = base(ScheduledTarget::LocalShell { cwd: None });
        input.permission_mode = PermissionMode::Full;
        assert!(blocking(&validate(&input, None)).contains(&"permission_mode"));
    }

    #[test]
    fn a_command_step_with_a_control_character_is_refused() {
        let mut input = base(ScheduledTarget::LocalShell { cwd: None });
        input.steps = vec![step(StepKind::Command, "echo hi\rrm -rf /")];
        assert!(blocking(&validate(&input, None)).contains(&"steps.0"));
        // An escape that could forge a completion marker is refused too.
        input.steps = vec![step(StepKind::Command, "echo \x1b]133;D;0\x07")];
        assert!(blocking(&validate(&input, None)).contains(&"steps.0"));
    }

    /// Flag, never filter: a privileged command the user typed themselves is
    /// their call, and the editor's job is to say what it noticed.
    #[test]
    fn a_privileged_command_step_is_flagged_but_not_refused() {
        let mut input = base(ScheduledTarget::LocalShell { cwd: None });
        input.steps = vec![step(StepKind::Command, "sudo systemctl restart nginx")];
        let issues = validate(&input, None);
        assert!(blocking(&issues).is_empty(), "{issues:?}");
        assert!(issues.iter().any(|i| !i.blocking && i.field == "steps.0"));
    }

    #[test]
    fn an_empty_or_oversized_step_is_refused() {
        let mut input = base(ScheduledTarget::LocalShell { cwd: None });
        input.steps = vec![step(StepKind::Command, "   ")];
        assert!(blocking(&validate(&input, None)).contains(&"steps.0"));
        input.steps = Vec::new();
        assert!(blocking(&validate(&input, None)).contains(&"steps"));
    }

    #[test]
    fn headless_refuses_a_password_only_ssh_host_and_names_tab_mode() {
        let host = HostFacts {
            has_password: true,
            has_identity_file: false,
            ..key_host()
        };
        let input = base(ScheduledTarget::SshHost {
            host_id: "h1".into(),
        });
        let issues = validate(&input, Some(&host));
        assert!(blocking(&issues).contains(&"execution_mode"));
        let message = issues
            .iter()
            .find(|i| i.field == "execution_mode")
            .unwrap()
            .message
            .clone();
        assert!(message.contains("prod-01"), "{message}");
        assert!(
            message.contains("Tab"),
            "the refusal must name the alternative"
        );
    }

    #[test]
    fn headless_allows_a_password_host_that_also_has_an_identity_file() {
        let host = HostFacts {
            has_password: true,
            has_identity_file: true,
            ..key_host()
        };
        let input = base(ScheduledTarget::SshHost {
            host_id: "h1".into(),
        });
        assert!(blocking(&validate(&input, Some(&host))).is_empty());
    }

    /// A host with neither is normal: an agent, `~/.ssh/config`'s own
    /// `IdentityFile`, or a default key all work.
    #[test]
    fn headless_allows_a_host_with_no_stored_credentials_at_all() {
        let host = HostFacts {
            has_password: false,
            has_identity_file: false,
            ..key_host()
        };
        let input = base(ScheduledTarget::SshHost {
            host_id: "h1".into(),
        });
        assert!(blocking(&validate(&input, Some(&host))).is_empty());
    }

    #[test]
    fn tab_mode_allows_a_password_only_host_because_autofill_still_works() {
        let host = HostFacts {
            has_password: true,
            has_identity_file: false,
            ..key_host()
        };
        let mut input = base(ScheduledTarget::SshHost {
            host_id: "h1".into(),
        });
        input.execution_mode = ExecutionMode::Tab;
        assert!(blocking(&validate(&input, Some(&host))).is_empty());
    }

    #[test]
    fn a_missing_saved_host_is_refused() {
        let input = base(ScheduledTarget::SshHost {
            host_id: "gone".into(),
        });
        assert!(blocking(&validate(&input, None)).contains(&"target"));
    }

    #[test]
    fn a_weekly_recurrence_with_no_weekdays_is_refused() {
        let mut input = base(ScheduledTarget::LocalShell { cwd: None });
        input.recurrence = Recurrence::Weekly {
            weekdays: Vec::new(),
            at: TimeOfDay { hour: 7, minute: 0 },
        };
        assert!(blocking(&validate(&input, None)).contains(&"recurrence"));
    }

    #[test]
    fn a_zero_or_absurd_interval_is_refused() {
        let mut input = base(ScheduledTarget::LocalShell { cwd: None });
        input.recurrence = Recurrence::Interval { every_minutes: 0 };
        assert!(blocking(&validate(&input, None)).contains(&"recurrence"));
        input.recurrence = Recurrence::Interval {
            every_minutes: MAX_INTERVAL_MINUTES + 1,
        };
        assert!(blocking(&validate(&input, None)).contains(&"recurrence"));
        // A short-but-legal interval is advisory only.
        input.recurrence = Recurrence::Interval { every_minutes: 1 };
        let issues = validate(&input, None);
        assert!(blocking(&issues).is_empty());
        assert!(issues
            .iter()
            .any(|i| i.field == "recurrence" && !i.blocking));
    }

    #[test]
    fn a_one_off_run_needs_a_parseable_instant_with_an_offset() {
        let mut input = base(ScheduledTarget::LocalShell { cwd: None });
        input.recurrence = Recurrence::Once {
            at: "next tuesday".into(),
        };
        assert!(blocking(&validate(&input, None)).contains(&"recurrence"));
        input.recurrence = Recurrence::Once {
            at: "2026-06-01T09:00:00+02:00".into(),
        };
        assert!(blocking(&validate(&input, None)).is_empty());
    }

    #[test]
    fn a_relative_working_directory_is_refused() {
        let input = base(ScheduledTarget::LocalShell {
            cwd: Some("relative/path".into()),
        });
        assert!(blocking(&validate(&input, None)).contains(&"target"));
    }

    /// The coupling that matters most: untrusted text entering the loop AND
    /// unreviewed writes leaving it. Either alone is defensible.
    #[test]
    fn attachments_cap_the_mode_below_auto_all() {
        let mut input = base(ScheduledTarget::LocalShell { cwd: None });
        input.permission_mode = PermissionMode::AutoAll;
        assert!(blocking(&validate(&input, None)).is_empty());

        let mut with_bucket = input.clone();
        with_bucket.doc_buckets = vec![KnowledgeBucketRef::Local {
            bucket_id: "b1".into(),
        }];
        assert!(blocking(&validate(&with_bucket, None)).contains(&"permission_mode"));
        // Auto (reads) with the same attachment is fine.
        with_bucket.permission_mode = PermissionMode::AutoRead;
        assert!(blocking(&validate(&with_bucket, None)).is_empty());

        let mut with_mcp = input.clone();
        with_mcp.mcp_selection.server_ids = vec!["srv".into()];
        assert!(blocking(&validate(&with_mcp, None)).contains(&"permission_mode"));
    }

    #[test]
    fn check_before_fire_refuses_an_edited_step_list() {
        let input = base(ScheduledTarget::LocalShell { cwd: None });
        assert!(check_before_fire(&input, "sha-a", "sha-a", Some("t"), None).is_ok());
        let drifted = check_before_fire(&input, "sha-a", "sha-b", Some("t"), None);
        assert!(drifted.is_err());
        assert!(drifted.unwrap_err().contains("re-open it"));
    }

    #[test]
    fn check_before_fire_refuses_an_unarmed_mode_and_allows_plain_ask() {
        let mut input = base(ScheduledTarget::LocalShell { cwd: None });
        assert!(check_before_fire(&input, "sha", "sha", None, None).is_err());
        // `ask` needs no arming — it authorizes nothing, so every proposal is
        // skipped and the run is a dry report.
        input.permission_mode = PermissionMode::Ask;
        assert!(check_before_fire(&input, "sha", "sha", None, None).is_ok());
    }

    #[test]
    fn check_before_fire_re_applies_the_host_rule() {
        let input = base(ScheduledTarget::SshHost {
            host_id: "h1".into(),
        });
        // A host that gained a password after the action was saved.
        let host = HostFacts {
            has_password: true,
            has_identity_file: false,
            ..key_host()
        };
        assert!(check_before_fire(&input, "sha", "sha", Some("t"), Some(&host)).is_err());
        assert!(check_before_fire(&input, "sha", "sha", Some("t"), Some(&key_host())).is_ok());
    }

    #[test]
    fn a_catch_up_waits_for_the_app_to_settle_and_skip_never_catches_up() {
        assert!(!catch_up_allowed(MissedRunPolicy::CatchUpOnce, 5));
        assert!(catch_up_allowed(MissedRunPolicy::CatchUpOnce, 600));
        assert!(!catch_up_allowed(MissedRunPolicy::Skip, 600));
    }
}
