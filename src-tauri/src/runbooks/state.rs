//! Durable runbook lifecycle types.
//!
//! These values are stored as strings in SQLite and cross the Tauri boundary,
//! so their spelling is part of the public contract. Keep additions backwards
//! compatible and add a database migration before removing a value.

use serde::{Deserialize, Serialize};
use std::fmt;
use std::str::FromStr;

macro_rules! string_enum {
    (
        $(#[$meta:meta])*
        pub enum $name:ident {
            $($variant:ident => $value:literal),+ $(,)?
        }
    ) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
        #[serde(rename_all = "snake_case")]
        pub enum $name {
            $($variant),+
        }

        impl $name {
            pub const fn as_str(self) -> &'static str {
                match self {
                    $(Self::$variant => $value),+
                }
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(self.as_str())
            }
        }

        impl FromStr for $name {
            type Err = String;

            fn from_str(value: &str) -> Result<Self, Self::Err> {
                match value {
                    $($value => Ok(Self::$variant),)+
                    other => Err(format!("unknown {}: {other}", stringify!($name))),
                }
            }
        }
    };
}

string_enum! {
    /// Engine-owned state of a durable run.
    pub enum RunStatus {
        Created => "created",
        Ready => "ready",
        Running => "running",
        WaitingApproval => "waiting_approval",
        WaitingOperator => "waiting_operator",
        Paused => "paused",
        Succeeded => "succeeded",
        CompletedWithExceptions => "completed_with_exceptions",
        Failed => "failed",
        Cancelled => "cancelled",
        Interrupted => "interrupted",
    }
}

impl RunStatus {
    pub const fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Succeeded | Self::CompletedWithExceptions | Self::Failed | Self::Cancelled
        )
    }

    pub const fn is_active(self) -> bool {
        matches!(
            self,
            Self::Running | Self::WaitingApproval | Self::WaitingOperator | Self::Paused
        )
    }

    /// The only legal durable transitions. An interrupted run must be rebound
    /// into `ready` before it can run again.
    pub const fn can_transition_to(self, next: Self) -> bool {
        use RunStatus::*;
        match self {
            Created => matches!(next, Ready | Failed | Cancelled | Interrupted),
            Ready => matches!(next, Running | Failed | Cancelled | Interrupted),
            Running => matches!(
                next,
                WaitingApproval
                    | WaitingOperator
                    | Paused
                    | Succeeded
                    | CompletedWithExceptions
                    | Failed
                    | Cancelled
                    | Interrupted
            ),
            WaitingApproval => {
                matches!(next, Running | Paused | Failed | Cancelled | Interrupted)
            }
            WaitingOperator => {
                matches!(next, Running | Paused | Failed | Cancelled | Interrupted)
            }
            Paused => matches!(next, Running | Failed | Cancelled | Interrupted),
            Interrupted => matches!(next, Ready | Cancelled),
            Succeeded | CompletedWithExceptions | Failed | Cancelled => false,
        }
    }
}

string_enum! {
    /// State of one checklist item. Only the two positive states are checked.
    pub enum StepStatus {
        Pending => "pending",
        Checking => "checking",
        AlreadyCompliant => "already_compliant",
        NeedsAction => "needs_action",
        Applying => "applying",
        Verifying => "verifying",
        RemediatedVerified => "remediated_verified",
        Paused => "paused",
        Failed => "failed",
        Skipped => "skipped",
        Waived => "waived",
        Blocked => "blocked",
        Unknown => "unknown",
    }
}

impl StepStatus {
    pub const fn is_checked(self) -> bool {
        matches!(self, Self::AlreadyCompliant | Self::RemediatedVerified)
    }

    pub const fn is_exception(self) -> bool {
        matches!(
            self,
            Self::NeedsAction
                | Self::Paused
                | Self::Failed
                | Self::Skipped
                | Self::Waived
                | Self::Blocked
                | Self::Unknown
        )
    }

    pub const fn can_transition_to(self, next: Self) -> bool {
        use StepStatus::*;
        match self {
            Pending => matches!(next, Checking | Skipped | Waived | Blocked),
            Checking => matches!(
                next,
                // RemediatedVerified is used only when a fresh check reconciles
                // a prior mutation attempt from this same run.
                AlreadyCompliant
                    | RemediatedVerified
                    | NeedsAction
                    | Paused
                    | Failed
                    | Blocked
                    | Unknown
            ),
            NeedsAction => matches!(
                next,
                Checking | Applying | Paused | Failed | Skipped | Waived | Blocked
            ),
            Applying => matches!(next, Verifying | Paused | Failed | Blocked | Unknown),
            Verifying => matches!(
                next,
                RemediatedVerified | Paused | Failed | Blocked | Unknown
            ),
            Paused => matches!(
                next,
                Checking | Applying | Verifying | Failed | Skipped | Waived | Blocked | Unknown
            ),
            Unknown => matches!(
                next,
                Checking | Verifying | Paused | Failed | Skipped | Waived
            ),
            // A compliant reconciliation check after a prior mutation still
            // has to execute the authored verify phase before it is final.
            AlreadyCompliant => matches!(next, Verifying),
            RemediatedVerified | Failed | Skipped | Waived | Blocked => false,
        }
    }
}

string_enum! {
    pub enum RunbookPhase {
        Check => "check",
        Apply => "apply",
        Verify => "verify",
    }
}

string_enum! {
    pub enum AttemptStatus {
        Intent => "intent",
        WaitingApproval => "waiting_approval",
        Running => "running",
        Succeeded => "succeeded",
        Failed => "failed",
        Unknown => "unknown",
        Cancelled => "cancelled",
        Declined => "declined",
    }
}

impl AttemptStatus {
    pub const fn is_in_flight(self) -> bool {
        matches!(self, Self::Intent | Self::WaitingApproval | Self::Running)
    }

    pub const fn is_terminal(self) -> bool {
        !self.is_in_flight()
    }
}

string_enum! {
    pub enum ApprovalStatus {
        Pending => "pending",
        Approved => "approved",
        Declined => "declined",
        Cancelled => "cancelled",
    }
}

string_enum! {
    pub enum ApprovalDecision {
        Approve => "approve",
        Decline => "decline",
    }
}

string_enum! {
    pub enum PauseDecision {
        Retry => "retry",
        Skip => "skip",
        Waive => "waive",
        Stop => "stop",
    }
}

string_enum! {
    pub enum FailurePolicy {
        Pause => "pause",
        Stop => "stop",
        Continue => "continue",
    }
}

string_enum! {
    pub enum VerificationAssurance {
        DeterministicShell => "deterministic_shell",
        // The bound PTY returned an observed exit status, without claiming the
        // parent interactive shell itself was an attested runtime.
        ShellObserved => "shell_observed",
        /// Ansible follow-on adapter execution with explicit project and
        /// inventory digests for per-host reconciliation.
        AnsibleRunner => "ansible_runner",
        AgentAssisted => "agent_assisted",
        OperatorAttested => "operator_attested",
    }
}

string_enum! {
    pub enum EvidenceCaptureMode {
        None => "none",
        Tail => "tail",
        Full => "full",
    }
}

string_enum! {
    /// Durable availability of one evidence item. Full artifacts are reserved
    /// as `pending` before filesystem I/O and become `complete` only after the
    /// final file has been verified. `missing` is terminal audit metadata: it
    /// records that capture was requested but no verified artifact survived.
    pub enum EvidenceAvailability {
        Pending => "pending",
        Complete => "complete",
        Missing => "missing",
    }
}

// The shared enum macro intentionally does not choose defaults for every enum;
// this one contractually defaults to tail capture.
#[allow(clippy::derivable_impls)]
impl Default for EvidenceCaptureMode {
    fn default() -> Self {
        Self::Tail
    }
}

/// Terminal identity captured at preflight and checked again before dispatch.
/// A local working directory is part of the approval boundary: changing it can
/// change the meaning of relative paths. Remote integrations deliberately leave
/// `cwd` unset when they cannot observe the remote directory authoritatively;
/// `context_marker` then detects an SSH/container context change in-place.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TargetBinding {
    pub kind: String,
    pub session_id: String,
    pub shell: Option<String>,
    pub cwd: Option<String>,
    pub remote_kind: Option<String>,
    pub remote_target: Option<String>,
    pub context_marker: Option<String>,
    pub observed_at: String,
}

impl TargetBinding {
    pub fn same_execution_context(&self, observed: &Self) -> bool {
        self.kind == observed.kind
            && self.session_id == observed.session_id
            && (self.remote_kind.is_some() || self.cwd == observed.cwd)
            && self.remote_kind == observed.remote_kind
            && self.remote_target == observed.remote_target
            && self.context_marker == observed.context_marker
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Waiver {
    pub actor: String,
    pub reason: String,
    pub created_at: String,
}

impl Waiver {
    pub fn validate(&self) -> Result<(), String> {
        if self.actor.trim().is_empty() {
            return Err("waiver actor is required".into());
        }
        if self.reason.trim().is_empty() {
            return Err("waiver reason is required".into());
        }
        if self.created_at.trim().is_empty() {
            return Err("waiver timestamp is required".into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn positive_step_states_are_the_only_checked_states() {
        for status in [
            StepStatus::Pending,
            StepStatus::Checking,
            StepStatus::NeedsAction,
            StepStatus::Applying,
            StepStatus::Verifying,
            StepStatus::Paused,
            StepStatus::Failed,
            StepStatus::Skipped,
            StepStatus::Waived,
            StepStatus::Blocked,
            StepStatus::Unknown,
        ] {
            assert!(!status.is_checked(), "{status} must not be checked");
        }
        assert!(StepStatus::AlreadyCompliant.is_checked());
        assert!(StepStatus::RemediatedVerified.is_checked());
    }

    #[test]
    fn apply_cannot_skip_verification() {
        assert!(StepStatus::Applying.can_transition_to(StepStatus::Verifying));
        assert!(!StepStatus::Applying.can_transition_to(StepStatus::RemediatedVerified));
    }

    #[test]
    fn observed_interactive_shell_is_not_labelled_deterministic() {
        assert_eq!(
            VerificationAssurance::ShellObserved.as_str(),
            "shell_observed"
        );
        assert_eq!(
            "shell_observed".parse::<VerificationAssurance>().unwrap(),
            VerificationAssurance::ShellObserved
        );
        assert_ne!(
            VerificationAssurance::ShellObserved,
            VerificationAssurance::DeterministicShell
        );
        assert_eq!(
            VerificationAssurance::AnsibleRunner.as_str(),
            "ansible_runner"
        );
        assert_eq!(
            "ansible_runner".parse::<VerificationAssurance>().unwrap(),
            VerificationAssurance::AnsibleRunner
        );
    }

    #[test]
    fn a_restored_noncompliant_check_can_be_reconciled_with_a_fresh_check() {
        assert!(StepStatus::NeedsAction.can_transition_to(StepStatus::Checking));
        assert!(StepStatus::Checking.can_transition_to(StepStatus::RemediatedVerified));
    }

    #[test]
    fn terminal_runs_cannot_be_resumed() {
        for status in [
            RunStatus::Succeeded,
            RunStatus::CompletedWithExceptions,
            RunStatus::Failed,
            RunStatus::Cancelled,
        ] {
            assert!(!status.can_transition_to(RunStatus::Running));
        }
        assert!(RunStatus::Interrupted.can_transition_to(RunStatus::Ready));
        assert!(!RunStatus::Interrupted.can_transition_to(RunStatus::Running));
    }

    #[test]
    fn local_cwd_and_remote_identity_changes_are_target_drift() {
        let target = TargetBinding {
            kind: "active-terminal".into(),
            session_id: "s1".into(),
            shell: Some("zsh".into()),
            cwd: Some("/a".into()),
            remote_kind: None,
            remote_target: None,
            context_marker: Some("ctx-1".into()),
            observed_at: "now".into(),
        };
        let mut observed = target.clone();
        observed.cwd = Some("/b".into());
        assert!(!target.same_execution_context(&observed));
        observed = target.clone();
        observed.remote_kind = Some("ssh".into());
        observed.remote_target = Some("staging".into());
        assert!(!target.same_execution_context(&observed));
    }
}
