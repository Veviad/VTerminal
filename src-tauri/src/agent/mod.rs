pub mod context;
pub mod exec;
pub mod history;
// The agent loop is provider-agnostic — it drives the `Provider` trait, so it
// works against a cloud model in a build with no local engine compiled in.
pub mod policy;
pub mod prompts;
pub mod pty_exec;
pub mod run;

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum PermissionMode {
    #[default]
    Ask,
    AutoRead,
    AutoSmart,
    AutoAll,
    Full,
}

#[derive(Debug, Clone, Copy, Deserialize)]
pub struct AgentPermissionModes {
    #[serde(default)]
    pub single: PermissionMode,
    #[serde(default)]
    pub local: PermissionMode,
    #[serde(default)]
    pub remote: PermissionMode,
}

impl Default for AgentPermissionModes {
    fn default() -> Self {
        Self {
            single: PermissionMode::Ask,
            local: PermissionMode::Ask,
            remote: PermissionMode::Ask,
        }
    }
}

#[derive(Default)]
pub struct AgentPermissionState {
    modes: Mutex<HashMap<String, AgentPermissionModes>>,
}

impl AgentPermissionState {
    pub fn register(&self, request_id: &str, modes: AgentPermissionModes) {
        if let Ok(mut map) = self.modes.lock() {
            map.insert(request_id.into(), modes);
        }
    }

    pub fn mode(&self, request_id: &str, role: Option<AgentTargetRole>) -> PermissionMode {
        self.modes
            .lock()
            .ok()
            .and_then(|map| map.get(request_id).copied())
            .map(|modes| match role {
                Some(AgentTargetRole::Local) => modes.local,
                Some(AgentTargetRole::Remote) => modes.remote,
                None => modes.single,
            })
            .unwrap_or_default()
    }

    pub fn set(
        &self,
        request_id: &str,
        role: Option<AgentTargetRole>,
        mode: PermissionMode,
    ) -> Result<(), String> {
        let mut map = self.modes.lock().map_err(|_| "permission state poisoned")?;
        let modes = map
            .get_mut(request_id)
            .ok_or_else(|| "agent run is no longer active".to_string())?;
        match role {
            Some(AgentTargetRole::Local) => modes.local = mode,
            Some(AgentTargetRole::Remote) => modes.remote = mode,
            None => modes.single = mode,
        }
        Ok(())
    }

    pub fn finish(&self, request_id: &str) {
        if let Ok(mut map) = self.modes.lock() {
            map.remove(request_id);
        }
    }
}

/// Stable model/UI names for the two terminals in a linked Sidecar run.
#[cfg_attr(not(feature = "local-llm"), allow(dead_code))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentTargetRole {
    Local,
    Remote,
}

impl AgentTargetRole {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Local => "local",
            Self::Remote => "remote",
        }
    }
}

/// Whether command output may cross the execution boundary into the terminal
/// card and model transcript. `Private` is an execution policy, not a redaction
/// hint: stdout and stderr are discarded before capture.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OutputPolicy {
    Normal,
    Private,
}

pub const PRIVATE_OUTPUT_NOTICE: &str = "[private output suppressed]";

/// Wire events for AI streaming (tagged union, Cowork idiom).
#[cfg_attr(not(feature = "local-llm"), allow(dead_code))]
#[derive(Clone, Serialize)]
#[serde(tag = "type")]
pub enum StreamEvent {
    Started {
        request_id: String,
        model: String,
    },
    Delta {
        content: String,
    },
    /// Model reasoning stream (thinking mode) — rendered collapsible.
    ThinkingDelta {
        content: String,
    },
    WebCitation {
        url: String,
        title: String,
        cited_text: String,
    },
    /// Agent proposes a command; nothing runs until respond_to_approval.
    ///
    /// Emitted only after backend mode/rule/classification evaluation concludes
    /// that a real operator decision is required. The legacy booleans remain on
    /// the wire while the UI migrates to the structured assessment.
    CommandProposal {
        approval_id: String,
        command: String,
        explanation: String,
        /// Provably reads and changes nothing. False also means "could not tell".
        read_only: bool,
        /// Reaches the network, as far as the command text shows.
        network: bool,
        output_policy: OutputPolicy,
        assessment: policy::CommandAssessment,
        ask_reason: String,
        /// Present only in Sidecar mode. Together these freeze the destination
        /// before approval, independently of whichever tab is later focused.
        #[serde(skip_serializing_if = "Option::is_none")]
        target_role: Option<AgentTargetRole>,
        #[serde(skip_serializing_if = "Option::is_none")]
        target_session_id: Option<String>,
    },
    /// Policy refused a command outright — it was never proposed and never ran.
    ///
    /// Distinct from a skipped proposal: there was no approval gate, so there is
    /// no `approval_id` to settle. The frontend renders it through the existing
    /// `"blocked"` command status.
    CommandBlocked {
        command: String,
        reason: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        target_role: Option<AgentTargetRole>,
        #[serde(skip_serializing_if = "Option::is_none")]
        target_session_id: Option<String>,
    },
    CommandStarted {
        approval_id: String,
        command: String,
        /// Repeated from the proposal. A command that auto-ran never drew an
        /// approval card, so this event is the only place its one-sentence
        /// justification can reach the transcript.
        explanation: String,
        output_policy: OutputPolicy,
        #[serde(skip_serializing_if = "Option::is_none")]
        target_role: Option<AgentTargetRole>,
        #[serde(skip_serializing_if = "Option::is_none")]
        target_session_id: Option<String>,
    },
    /// Ask the FRONTEND to run this in the session's live PTY. The backend never
    /// sees PTY bytes (all OSC parsing is frontend-side), so it cannot detect
    /// completion itself — it waits for `submit_command_result`.
    RunInTerminal {
        approval_id: String,
        session_id: String,
        command: String,
        timeout_secs: u64,
        /// See `CommandStarted::explanation`.
        explanation: String,
        output_policy: OutputPolicy,
        #[serde(skip_serializing_if = "Option::is_none")]
        target_role: Option<AgentTargetRole>,
        #[serde(skip_serializing_if = "Option::is_none")]
        target_session_id: Option<String>,
    },
    CommandOutput {
        approval_id: String,
        chunk: String,
        is_stderr: bool,
    },
    CommandResult {
        approval_id: String,
        /// None when the command outlived its timeout: it is still running in
        /// the user's terminal and was deliberately NOT killed.
        exit_code: Option<i32>,
        duration_ms: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        target_role: Option<AgentTargetRole>,
        #[serde(skip_serializing_if = "Option::is_none")]
        target_session_id: Option<String>,
    },
    /// The loop just appended these queued steering messages to the transcript.
    /// The frontend clears its "queued" badge on this and on nothing else — a
    /// message that never gets one is a message the model never saw, and the
    /// user has to be able to tell those two apart.
    SteerDelivered {
        ids: Vec<String>,
    },
    /// Storage-safe model history at a stable round boundary.
    ///
    /// This is deliberately separate from the display transcript. It contains
    /// tool-call ids/results needed for continuation, but no system message or
    /// image bytes. The frontend persists it without rendering or editing it.
    Checkpoint {
        sequence: u32,
        transcript: Vec<crate::provider::ChatMessage>,
    },
    Done {
        prompt_tokens: u32,
        completion_tokens: u32,
    },
    /// The loop stopped at a LIMIT, not because the model finished.
    ///
    /// Deliberately not `Error`: the transcript is intact and already resumable
    /// (the typed outcome carries the storage-safe checkpoint, so `agent_start`
    /// resolves and the frontend stores it as `modelTranscript`), which makes
    /// this a checkpoint the user extends with one click rather than a failure.
    /// It also carries the run's usage, because no `Done` fires on this path and
    /// the counters would otherwise be silently lost.
    Paused {
        reason: PauseReason,
        /// Steps actually taken.
        steps: u32,
        /// The user's configured `agent_max_iterations` — NEVER the
        /// steer-extended budget, which is a number they cannot find in Settings.
        limit: u32,
        prompt_tokens: u32,
        completion_tokens: u32,
        /// Last round's input size and the model's window. Both 0 when the
        /// provider reported no usage (see `PauseReason::ContextLimit`).
        context_used: u32,
        context_limit: u32,
    },
    Cancelled,
    Error {
        message: String,
    },
}

/// Why a run paused. `snake_case` on the wire — unlike the outer `StreamEvent`,
/// which is `tag = "type"` with no `rename_all` and so ships PascalCase verbatim.
/// Both literals are pinned by `pause_reasons_serialize_as_snake_case`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PauseReason {
    /// Spent the step budget.
    StepLimit,
    /// The next round would not fit the model's context window. Only ever
    /// reachable when the provider reports usage — see `run.rs`.
    ContextLimit,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalDecision {
    Run,
    Skip,
    Stop,
}

#[derive(Debug)]
pub struct ApprovalResponse {
    pub decision: ApprovalDecision,
    pub edited_command: Option<String>,
}

/// Pending approval gates: approval_id → (request_id, oneshot). The request_id
/// lets ai_cancel drain only the gates belonging to the cancelled run.
#[derive(Default)]
pub struct ApprovalState {
    pub pending: Mutex<HashMap<String, (String, tokio::sync::oneshot::Sender<ApprovalResponse>)>>,
}

impl ApprovalState {
    pub fn register(
        &self,
        approval_id: &str,
        request_id: &str,
    ) -> tokio::sync::oneshot::Receiver<ApprovalResponse> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        if let Ok(mut map) = self.pending.lock() {
            map.insert(approval_id.to_string(), (request_id.to_string(), tx));
        }
        rx
    }

    pub fn respond(&self, approval_id: &str, response: ApprovalResponse) -> Result<(), String> {
        let sender = self
            .pending
            .lock()
            .map_err(|_| "approval state poisoned")?
            .remove(approval_id)
            .map(|(_, tx)| tx)
            .ok_or_else(|| format!("no pending approval {approval_id}"))?;
        sender
            .send(response)
            .map_err(|_| "agent run no longer waiting".to_string())
    }

    /// Drop every gate belonging to a cancelled run (their receivers error out,
    /// which the loop treats as Stop).
    pub fn drain_for_request(&self, request_id: &str) {
        if let Ok(mut map) = self.pending.lock() {
            map.retain(|_, (rid, _)| rid != request_id);
        }
    }

    pub fn drain_all(&self) {
        if let Ok(mut map) = self.pending.lock() {
            map.clear();
        }
    }
}

/// What the frontend observed after typing a command into the live PTY.
#[cfg_attr(not(feature = "local-llm"), allow(dead_code))]
#[derive(Debug, Deserialize)]
pub struct PtyExecResult {
    /// None = unknown (timed out, or the shell never reported it).
    pub exit_code: Option<i32>,
    pub output_tail: String,
    pub duration_ms: u64,
    pub error: Option<String>,
}

/// Pending PTY executions: approval_id → (request_id, oneshot). Structurally
/// identical to ApprovalState — same lifecycle, same drain-on-cancel rules.
#[derive(Default)]
pub struct PtyExecState {
    pub pending: Mutex<HashMap<String, (String, tokio::sync::oneshot::Sender<PtyExecResult>)>>,
}

#[cfg_attr(not(feature = "local-llm"), allow(dead_code))]
impl PtyExecState {
    pub fn register(
        &self,
        approval_id: &str,
        request_id: &str,
    ) -> tokio::sync::oneshot::Receiver<PtyExecResult> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        if let Ok(mut map) = self.pending.lock() {
            map.insert(approval_id.to_string(), (request_id.to_string(), tx));
        }
        rx
    }

    pub fn respond(&self, approval_id: &str, result: PtyExecResult) -> Result<(), String> {
        let sender = self
            .pending
            .lock()
            .map_err(|_| "pty exec state poisoned")?
            .remove(approval_id)
            .map(|(_, tx)| tx)
            .ok_or_else(|| format!("no pending terminal command {approval_id}"))?;
        sender
            .send(result)
            .map_err(|_| "agent run no longer waiting".to_string())
    }

    pub fn drain_for_request(&self, request_id: &str) {
        if let Ok(mut map) = self.pending.lock() {
            map.retain(|_, (rid, _)| rid != request_id);
        }
    }

    pub fn drain_all(&self) {
        if let Ok(mut map) = self.pending.lock() {
            map.clear();
        }
    }
}

/// Cancellation registry: request_id → watch sender flipped true on cancel
/// (Cowork cancel_stream shape).
#[derive(Default)]
pub struct AiState {
    pub cancel: Mutex<HashMap<String, tokio::sync::watch::Sender<bool>>>,
}

#[cfg_attr(not(feature = "local-llm"), allow(dead_code))]
impl AiState {
    pub fn register(&self, request_id: &str) -> tokio::sync::watch::Receiver<bool> {
        let (tx, rx) = tokio::sync::watch::channel(false);
        if let Ok(mut map) = self.cancel.lock() {
            map.insert(request_id.to_string(), tx);
        }
        rx
    }

    pub fn cancel(&self, request_id: &str) {
        if let Ok(mut map) = self.cancel.lock() {
            if let Some(tx) = map.remove(request_id) {
                let _ = tx.send(true);
            }
        }
    }

    pub fn finish(&self, request_id: &str) {
        if let Ok(mut map) = self.cancel.lock() {
            map.remove(request_id);
        }
    }

    /// Signal every active generation without removing its registry entry.
    /// Keeping entries until `finish` gives updater shutdown a truthful idle
    /// predicate instead of declaring success before providers/subprocesses
    /// have observed cancellation.
    pub fn cancel_all(&self) {
        if let Ok(map) = self.cancel.lock() {
            for sender in map.values() {
                let _ = sender.send(true);
            }
        }
    }

    pub fn is_idle(&self) -> bool {
        self.cancel
            .lock()
            .map(|map| map.is_empty())
            .unwrap_or(false)
    }
}

/// One message the user typed while an agent run was already in flight.
#[derive(Debug, Clone)]
pub struct Steer {
    pub id: String,
    pub text: String,
}

/// A single steer may not exceed this. A pasted logfile would evict the run's
/// own tool results from a 9B model's context window.
const MAX_STEER_CHARS: usize = 4096;
/// Ceiling on one run's mailbox, so leaning on Enter cannot grow it unbounded.
const MAX_STEERS_PENDING: usize = 8;

/// Steering mailbox: request_id → messages waiting for the next round boundary.
///
/// A mutexed map rather than a channel because the loop never has to WAKE for a
/// steer — it drains once per round, at the one point where the transcript is
/// tool-pair-complete and a `Role::User` turn is legal on every provider. The
/// two places the loop blocks mid-round are the approval gate and a command
/// running in the user's own terminal, and neither may be cut short to deliver
/// a message. That makes an mpsc's wakeup pure dead weight (it would still need
/// a `HashMap<_, Sender>` to be reachable from the command), and a `watch`
/// outright wrong: last-value-wins would let two steers in one round eat each
/// other.
///
/// Keyed by request_id rather than approval_id, so `drain_for_request` is a
/// `remove` rather than the `retain` the other two registries need.
#[derive(Default)]
pub struct SteerState {
    pub pending: Mutex<HashMap<String, Vec<Steer>>>,
}

#[cfg_attr(not(feature = "local-llm"), allow(dead_code))]
impl SteerState {
    /// Open a mailbox for a run. Until this is called `push` refuses, which is
    /// what turns "steered a run that already ended" into a definite error
    /// instead of an entry nothing ever removes.
    pub fn register(&self, request_id: &str) {
        if let Ok(mut map) = self.pending.lock() {
            map.insert(request_id.to_string(), Vec::new());
        }
    }

    pub fn push(&self, request_id: &str, id: String, text: String) -> Result<(), String> {
        let text = text.trim().to_string();
        if text.is_empty() {
            return Err("empty message".to_string());
        }
        if text.chars().count() > MAX_STEER_CHARS {
            return Err(format!(
                "message too long (max {MAX_STEER_CHARS} characters)"
            ));
        }
        let mut map = self.pending.lock().map_err(|_| "steer state poisoned")?;
        let queue = map
            .get_mut(request_id)
            .ok_or("that agent run has already finished")?;
        if queue.len() >= MAX_STEERS_PENDING {
            return Err(
                "too many queued messages — wait for the agent to pick them up".to_string(),
            );
        }
        queue.push(Steer { id, text });
        Ok(())
    }

    /// Take everything queued for this run. Called once per round, so the lock is
    /// held only long enough to swap the Vec out — never across an await.
    pub fn drain(&self, request_id: &str) -> Vec<Steer> {
        self.pending
            .lock()
            .ok()
            .and_then(|mut map| map.get_mut(request_id).map(std::mem::take))
            .unwrap_or_default()
    }

    /// Whether anything is waiting, without consuming it. Lets a round that was
    /// about to end keep going instead, so the steer lands in this run rather
    /// than being stranded.
    pub fn has_pending(&self, request_id: &str) -> bool {
        self.pending
            .lock()
            .ok()
            .and_then(|map| map.get(request_id).map(|q| !q.is_empty()))
            .unwrap_or(false)
    }

    pub fn drain_for_request(&self, request_id: &str) {
        if let Ok(mut map) = self.pending.lock() {
            map.remove(request_id);
        }
    }

    pub fn drain_all(&self) {
        if let Ok(mut map) = self.pending.lock() {
            map.clear();
        }
    }
}

#[cfg(test)]
mod steer_tests {
    use super::*;

    #[test]
    fn push_before_register_is_an_error() {
        let state = SteerState::default();
        assert!(state.push("req-1", "s1".into(), "hello".into()).is_err());
        // …and it must not have created a mailbox as a side effect.
        assert!(state.pending.lock().unwrap().is_empty());
    }

    #[test]
    fn push_after_register_queues_in_order() {
        let state = SteerState::default();
        state.register("req-1");
        state.push("req-1", "s1".into(), "first".into()).unwrap();
        state.push("req-1", "s2".into(), "second".into()).unwrap();

        assert!(state.has_pending("req-1"));
        let drained = state.drain("req-1");
        assert_eq!(drained.len(), 2);
        assert_eq!(drained[0].id, "s1");
        assert_eq!(drained[0].text, "first");
        assert_eq!(drained[1].text, "second");
    }

    #[test]
    fn drain_empties_the_mailbox_but_keeps_it_open() {
        let state = SteerState::default();
        state.register("req-1");
        state.push("req-1", "s1".into(), "hi".into()).unwrap();

        assert_eq!(state.drain("req-1").len(), 1);
        assert!(state.drain("req-1").is_empty());
        assert!(!state.has_pending("req-1"));
        // Still registered, so the run can be steered again next round.
        assert!(state.push("req-1", "s2".into(), "again".into()).is_ok());
    }

    #[test]
    fn drain_for_request_closes_the_mailbox() {
        let state = SteerState::default();
        state.register("req-1");
        state.register("req-2");
        state.drain_for_request("req-1");

        assert!(state.push("req-1", "s1".into(), "hi".into()).is_err());
        assert!(state.push("req-2", "s2".into(), "hi".into()).is_ok());
    }

    #[test]
    fn whitespace_only_and_oversized_are_rejected() {
        let state = SteerState::default();
        state.register("req-1");

        assert!(state.push("req-1", "s1".into(), "   \n\t ".into()).is_err());
        let huge = "x".repeat(MAX_STEER_CHARS + 1);
        assert!(state.push("req-1", "s2".into(), huge).is_err());
        // The cap is in chars, not bytes: multibyte text up to the limit is fine.
        let wide = "é".repeat(MAX_STEER_CHARS);
        assert!(state.push("req-1", "s3".into(), wide).is_ok());
    }

    #[test]
    fn text_is_trimmed_and_the_queue_is_capped() {
        let state = SteerState::default();
        state.register("req-1");
        state
            .push("req-1", "s0".into(), "  padded  ".into())
            .unwrap();
        assert_eq!(state.drain("req-1")[0].text, "padded");

        for i in 0..MAX_STEERS_PENDING {
            state.push("req-1", format!("s{i}"), "msg".into()).unwrap();
        }
        assert!(state
            .push("req-1", "overflow".into(), "msg".into())
            .is_err());
    }
}
