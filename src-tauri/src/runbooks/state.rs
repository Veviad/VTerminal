//! Durable runbook lifecycle types.
//!
//! These values are stored as strings in SQLite and cross the Tauri boundary,
//! so their spelling is part of the public contract. Keep additions backwards
//! compatible and add a database migration before removing a value.

use serde::{Deserialize, Serialize};

/// Pair a Rust variant with the ONE string that is simultaneously its serde
/// spelling, its SQLite CHECK value and its `as_str()`.
///
/// Exported because `crate::scheduled` needs the same guarantee and a second
/// copy of the macro would be a second place for a literal to drift — which is
/// exactly how `ProviderId::OpenAi` shipped as `"open_ai"` against a frontend
/// that said `"openai"`. `::std::fmt` and `::std::str::FromStr` are written out
/// in full so the macro does not depend on what the calling module imported.
#[macro_export]
macro_rules! string_enum {
    (
        $(#[$meta:meta])*
        pub enum $name:ident {
            $($variant:ident => $value:literal),+ $(,)?
        }
    ) => {
        $(#[$meta])*
        // `JsonSchema` reads the serde attributes below, so the generated
        // schema and the wire spelling cannot drift apart. Only the enums
        // reachable from `RunbookDefinition` actually reach the artifact.
        #[derive(
            Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, schemars::JsonSchema,
        )]
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

        impl ::std::fmt::Display for $name {
            fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
                f.write_str(self.as_str())
            }
        }

        impl ::std::str::FromStr for $name {
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
        // Ansible follow-on adapter execution with explicit project and
        // inventory digests for per-host reconciliation.
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

impl EvidenceCaptureMode {
    /// How much a mode retains, so a request can be clamped up to a policy
    /// floor. Deliberately not an `Ord` derive: declaration order is a
    /// serialization detail and must not silently become a retention ranking.
    pub const fn retention_rank(self) -> u8 {
        match self {
            Self::None => 0,
            Self::Tail => 1,
            Self::Full => 2,
        }
    }

    /// Raise this mode to `floor` when it retains less. Never lowers, which is
    /// the whole point of the operator policy below.
    pub const fn at_least(self, floor: Self) -> Self {
        if self.retention_rank() >= floor.retention_rank() {
            self
        } else {
            floor
        }
    }
}

string_enum! {
    /// Operator policy from Settings → Runbooks for how much terminal output a
    /// run keeps as an audit record.
    ///
    /// This is NOT a capture mode and its spelling must never reach SQLite:
    /// `runbook_runs.evidence_mode` and `runbook_evidence.mode` both CHECK
    /// against none/tail/full. It is resolved together with the definition's own
    /// request into an `EvidenceCaptureMode` before a run row exists.
    pub enum EvidenceRecordingPolicy {
        None => "none",
        Runbook => "runbook",
        All => "all",
    }
}

// Defaulting to `Runbook` keeps a fresh install behaving exactly as it did
// before the policy existed: whatever the definition asks for, else tail.
#[allow(clippy::derivable_impls)]
impl Default for EvidenceRecordingPolicy {
    fn default() -> Self {
        Self::Runbook
    }
}

impl EvidenceRecordingPolicy {
    /// The least capture a run may use, given what the definition asked for.
    ///
    /// An operator may raise the mode for one run but never lower it, so `All`
    /// is an audit floor rather than a suggestion. `None` is deliberately
    /// "off by default" and not "recording forbidden" — a run the operator
    /// wants evidence for can still be raised, which keeps the setting from
    /// becoming a reason to avoid recording anything at all.
    pub fn floor(self, declared: Option<EvidenceCaptureMode>) -> EvidenceCaptureMode {
        match self {
            Self::All => EvidenceCaptureMode::Full,
            Self::None => EvidenceCaptureMode::None,
            Self::Runbook => declared.unwrap_or_default(),
        }
    }
}

/// Execution identity captured at preflight and checked again before dispatch.
/// Existing terminal targets retain their original wire representation. Managed
/// Ansible targets are bound to a source and immutable package digests instead
/// of a PTY session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum TargetBinding {
    ActiveTerminal {
        session_id: String,
        shell: Option<String>,
        cwd: Option<String>,
        remote_kind: Option<String>,
        remote_target: Option<String>,
        context_marker: Option<String>,
        observed_at: String,
    },
    AnsibleInventory {
        source_id: String,
        controller_path: String,
        controller_version: String,
        inventory_path: Option<String>,
        inventory_digest: Option<String>,
        project_digest: String,
        limit: Option<String>,
        observed_at: String,
    },
}

impl TargetBinding {
    pub fn active_terminal(
        session_id: String,
        shell: Option<String>,
        cwd: Option<String>,
        remote_kind: Option<String>,
        remote_target: Option<String>,
        context_marker: Option<String>,
        observed_at: String,
    ) -> Self {
        Self::ActiveTerminal {
            session_id,
            shell,
            cwd,
            remote_kind,
            remote_target,
            context_marker,
            observed_at,
        }
    }

    pub fn kind(&self) -> &'static str {
        match self {
            Self::ActiveTerminal { .. } => "active-terminal",
            Self::AnsibleInventory { .. } => "ansible-inventory",
        }
    }

    pub fn session_id(&self) -> Option<&str> {
        match self {
            Self::ActiveTerminal { session_id, .. } => Some(session_id),
            Self::AnsibleInventory { .. } => None,
        }
    }

    pub fn observed_at(&self) -> &str {
        match self {
            Self::ActiveTerminal { observed_at, .. }
            | Self::AnsibleInventory { observed_at, .. } => observed_at,
        }
    }

    pub fn lock_key(&self) -> String {
        match self {
            Self::ActiveTerminal { session_id, .. } => session_id.clone(),
            Self::AnsibleInventory { source_id, .. } => format!("ansible:{source_id}"),
        }
    }

    pub fn label(&self) -> String {
        match self {
            Self::ActiveTerminal {
                session_id,
                remote_kind: Some(kind),
                remote_target: Some(target),
                ..
            } => format!("{kind} {target} ({session_id})"),
            Self::ActiveTerminal { session_id, .. } => format!("terminal {session_id}"),
            Self::AnsibleInventory {
                inventory_path,
                limit,
                ..
            } => match (inventory_path, limit) {
                (Some(inventory), Some(limit)) => {
                    format!("Ansible inventory {inventory}, limit {limit}")
                }
                (Some(inventory), None) => format!("Ansible inventory {inventory}"),
                (None, Some(limit)) => format!("Ansible implicit inventory, limit {limit}"),
                (None, None) => "Ansible implicit inventory".into(),
            },
        }
    }

    pub fn same_execution_context(&self, observed: &Self) -> bool {
        match (self, observed) {
            (
                Self::ActiveTerminal {
                    session_id,
                    cwd,
                    remote_kind,
                    remote_target,
                    context_marker,
                    ..
                },
                Self::ActiveTerminal {
                    session_id: observed_session,
                    cwd: observed_cwd,
                    remote_kind: observed_kind,
                    remote_target: observed_target,
                    context_marker: observed_marker,
                    ..
                },
            ) => {
                session_id == observed_session
                    && (remote_kind.is_some() || cwd == observed_cwd)
                    && remote_kind == observed_kind
                    && remote_target == observed_target
                    && context_marker == observed_marker
            }
            (
                Self::AnsibleInventory {
                    source_id,
                    controller_path,
                    controller_version,
                    inventory_path,
                    inventory_digest,
                    project_digest,
                    limit,
                    ..
                },
                Self::AnsibleInventory {
                    source_id: observed_source,
                    controller_path: observed_controller,
                    controller_version: observed_version,
                    inventory_path: observed_inventory,
                    inventory_digest: observed_inventory_digest,
                    project_digest: observed_project_digest,
                    limit: observed_limit,
                    ..
                },
            ) => {
                source_id == observed_source
                    && controller_path == observed_controller
                    && controller_version == observed_version
                    && inventory_path == observed_inventory
                    && inventory_digest == observed_inventory_digest
                    && project_digest == observed_project_digest
                    && limit == observed_limit
            }
            _ => false,
        }
    }

    pub fn refresh_observation(&mut self, observed: &Self) {
        match (self, observed) {
            (
                Self::ActiveTerminal {
                    cwd, observed_at, ..
                },
                Self::ActiveTerminal {
                    cwd: next_cwd,
                    observed_at: next_observed_at,
                    ..
                },
            ) => {
                *cwd = next_cwd.clone();
                *observed_at = next_observed_at.clone();
            }
            (
                Self::AnsibleInventory { observed_at, .. },
                Self::AnsibleInventory {
                    observed_at: next_observed_at,
                    ..
                },
            ) => *observed_at = next_observed_at.clone(),
            _ => {}
        }
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
        let target = TargetBinding::active_terminal(
            "s1".into(),
            Some("zsh".into()),
            Some("/a".into()),
            None,
            None,
            Some("ctx-1".into()),
            "now".into(),
        );
        let mut observed = target.clone();
        if let TargetBinding::ActiveTerminal { cwd, .. } = &mut observed {
            *cwd = Some("/b".into());
        }
        assert!(!target.same_execution_context(&observed));
        observed = target.clone();
        if let TargetBinding::ActiveTerminal {
            remote_kind,
            remote_target,
            ..
        } = &mut observed
        {
            *remote_kind = Some("ssh".into());
            *remote_target = Some("staging".into());
        }
        assert!(!target.same_execution_context(&observed));
    }

    #[test]
    fn runtime_targets_are_a_backward_compatible_tagged_union() {
        let terminal: TargetBinding = serde_json::from_value(serde_json::json!({
            "kind": "active-terminal",
            "session_id": "s1",
            "shell": "zsh",
            "cwd": "/tmp",
            "remote_kind": null,
            "remote_target": null,
            "context_marker": "local",
            "observed_at": "now"
        }))
        .unwrap();
        assert_eq!(terminal.session_id(), Some("s1"));

        let ansible = TargetBinding::AnsibleInventory {
            source_id: "source-1".into(),
            controller_path: "/usr/bin/ansible-runner".into(),
            controller_version: "2.4.0".into(),
            inventory_path: None,
            inventory_digest: None,
            project_digest: "sha256:project".into(),
            limit: None,
            observed_at: "now".into(),
        };
        let serialized = serde_json::to_value(&ansible).unwrap();
        assert_eq!(serialized["kind"], "ansible-inventory");
        assert_eq!(ansible.lock_key(), "ansible:source-1");
        assert_eq!(ansible.session_id(), None);
    }

    #[test]
    fn the_recording_policy_never_borrows_a_capture_mode_spelling() {
        // These two enums are adjacent and easy to confuse. `runbook` has no
        // capture-mode counterpart, and the policy spelling must never be
        // accepted where a mode is expected: both SQLite columns CHECK against
        // none/tail/full and would reject it at the persistence boundary.
        assert_eq!(EvidenceRecordingPolicy::None.as_str(), "none");
        assert_eq!(EvidenceRecordingPolicy::Runbook.as_str(), "runbook");
        assert_eq!(EvidenceRecordingPolicy::All.as_str(), "all");
        assert!("runbook".parse::<EvidenceCaptureMode>().is_err());
        assert!("all".parse::<EvidenceCaptureMode>().is_err());
        assert!("tail".parse::<EvidenceRecordingPolicy>().is_err());
        assert!("full".parse::<EvidenceRecordingPolicy>().is_err());
        // `as_str` and the serde spelling are the same name written twice.
        for policy in [
            EvidenceRecordingPolicy::None,
            EvidenceRecordingPolicy::Runbook,
            EvidenceRecordingPolicy::All,
        ] {
            let wire = serde_json::to_string(&policy).expect("policy serializes");
            assert_eq!(wire, format!("\"{}\"", policy.as_str()));
            assert_eq!(
                policy.as_str().parse::<EvidenceRecordingPolicy>(),
                Ok(policy)
            );
        }
    }

    #[test]
    fn the_policy_is_a_floor_the_operator_may_only_raise() {
        use EvidenceCaptureMode::{Full, None as NoCapture, Tail};

        // `all` pins the floor at full, so no per-run choice can reduce it.
        assert_eq!(EvidenceRecordingPolicy::All.floor(None), Full);
        assert_eq!(EvidenceRecordingPolicy::All.floor(Some(NoCapture)), Full);
        for requested in [NoCapture, Tail, Full] {
            assert_eq!(requested.at_least(Full), Full);
        }

        // `none` is off by default, not forbidden: nothing is kept unless the
        // operator deliberately raises this run.
        assert_eq!(EvidenceRecordingPolicy::None.floor(Some(Full)), NoCapture);
        assert_eq!(NoCapture.at_least(NoCapture), NoCapture);
        assert_eq!(Full.at_least(NoCapture), Full);

        // `runbook` defers to the definition and falls back to the documented
        // tail default when it asks for nothing.
        assert_eq!(EvidenceRecordingPolicy::Runbook.floor(None), Tail);
        assert_eq!(EvidenceRecordingPolicy::Runbook.floor(Some(Full)), Full);
        assert_eq!(
            EvidenceRecordingPolicy::Runbook.floor(Some(NoCapture)),
            NoCapture
        );
        // Raising above the floor is allowed; lowering is not.
        assert_eq!(NoCapture.at_least(Tail), Tail);
        assert_eq!(Full.at_least(Tail), Full);
    }

    #[test]
    fn retention_rank_orders_modes_by_what_they_keep() {
        assert!(
            EvidenceCaptureMode::None.retention_rank() < EvidenceCaptureMode::Tail.retention_rank()
        );
        assert!(
            EvidenceCaptureMode::Tail.retention_rank() < EvidenceCaptureMode::Full.retention_rank()
        );
    }
}
