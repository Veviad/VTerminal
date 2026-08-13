//! Step-scoped agent execution for runbooks.
//!
//! This is intentionally separate from `agent::run`: a normal agent may call
//! `finish`, while a runbook agent must only propose phase commands and return one
//! structured `phase_complete` value bound to the active run, step and phase. The
//! engine remains authoritative over lifecycle transitions and final status.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::provider::{
    ChatMessage, ChatParams, FinishReason, Provider, ProviderError, ProviderEvent, Role, ToolCall,
    ToolChoiceMode, ToolDef,
};

use super::runtime::{PhaseCompletion, PhaseResult};
use super::state::{RunbookPhase, VerificationAssurance};

pub const MAX_AGENT_SUMMARY_CHARS: usize = 2_000;
pub const MAX_AGENT_PHASE_ITERATIONS: u32 = 100;

#[derive(Debug, Clone)]
pub struct AgentPhaseConfig {
    pub run_id: String,
    pub step_id: String,
    pub phase: RunbookPhase,
    pub step_title: String,
    pub instructions: String,
    pub target_summary: String,
    pub max_iterations: u32,
    pub temperature: Option<f32>,
    pub effort: crate::provider::Effort,
    pub max_tokens: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentCommandObservation {
    pub proposed_command: String,
    pub executed_command: Option<String>,
    pub exit_code: Option<i32>,
    pub output_tail: String,
    pub unknown: bool,
    pub cancelled: bool,
}

#[async_trait]
pub trait AgentCommandHost: Send {
    async fn run_command(
        &mut self,
        command: String,
        explanation: String,
    ) -> Result<AgentCommandObservation, String>;
}

/// Run one agent-backed check/apply/verify phase. The returned completion is still
/// validated by `RunCoordinator::complete_phase`; this function cannot mutate run
/// state or finish a run.
pub async fn execute_agent_phase(
    provider: &dyn Provider,
    config: &AgentPhaseConfig,
    host: &mut dyn AgentCommandHost,
    cancel: tokio::sync::watch::Receiver<bool>,
) -> Result<PhaseCompletion, String> {
    let max_iterations = config.max_iterations.clamp(1, MAX_AGENT_PHASE_ITERATIONS);
    let tools = phase_tools(config.phase);
    let mut messages = vec![
        ChatMessage::system(system_prompt(config)),
        ChatMessage::user(format!(
            "Perform only the active `{}` phase for step `{}`.\n\n{}",
            config.phase, config.step_id, config.instructions
        )),
    ];

    for _ in 0..max_iterations {
        if *cancel.borrow() {
            return Err("cancelled".into());
        }
        let (calls, text, finish) = provider_round(
            provider,
            messages.clone(),
            tools.clone(),
            ChatParams {
                temperature: config.temperature,
                max_tokens: Some(config.max_tokens.max(256)),
                tool_choice: ToolChoiceMode::Auto,
                // A server-side web tool has no runbook approval handshake. Network
                // operations must be proposed as visible terminal commands instead.
                web_access: false,
                effort: config.effort,
            },
            cancel.clone(),
        )
        .await?;

        if calls.is_empty() {
            messages.push(ChatMessage::assistant(text));
            let reason = if finish == FinishReason::Length {
                "The response hit its output limit. Call phase_complete with the best supported result."
            } else {
                "You must use phase_complete; plain text cannot complete a runbook phase."
            };
            messages.push(ChatMessage::user(reason));
            continue;
        }

        messages.push(ChatMessage {
            role: Role::Assistant,
            content: text,
            tool_calls: Some(calls.clone()),
            tool_call_id: None,
            images: None,
        });

        let contains_command = calls.iter().any(|call| call.name == "run_command");
        let completion_count = calls
            .iter()
            .filter(|call| call.name == "phase_complete")
            .count();
        for call in calls {
            if *cancel.borrow() {
                return Err("cancelled".into());
            }
            match call.name.as_str() {
                "run_command" => {
                    let arguments: CommandArguments =
                        match serde_json::from_str::<CommandArguments>(&call.arguments) {
                            Ok(arguments) if !arguments.command.trim().is_empty() => arguments,
                            _ => {
                                messages.push(tool_result(
                                    &call.id,
                                    "Error: command and explanation must be non-empty strings.",
                                ));
                                continue;
                            }
                        };
                    let observation = host
                        .run_command(arguments.command, arguments.explanation)
                        .await?;
                    messages.push(tool_result(&call.id, &render_observation(&observation)));
                    if observation.cancelled {
                        return Err("cancelled".into());
                    }
                    // A command with no authoritative outcome must never be
                    // followed by a model-authored success claim. Settle the
                    // phase from the observation immediately; the engine will
                    // pause and require a fresh reconciliation check.
                    if observation.unknown || observation.exit_code.is_none() {
                        return Ok(observed_failure_completion(
                            config,
                            PhaseResult::Unknown,
                            "agent command outcome is unknown; positive phase completion is forbidden",
                        ));
                    }
                    if observation.exit_code != Some(0) {
                        return Ok(observed_failure_completion(
                            config,
                            PhaseResult::Failed,
                            &format!(
                                "agent command exited with {}; positive phase completion is forbidden",
                                observation.exit_code.unwrap_or_default()
                            ),
                        ));
                    }
                }
                "phase_complete" => {
                    if contains_command {
                        messages.push(tool_result(
                            &call.id,
                            "Not accepted: inspect command results in the next round before completing the phase.",
                        ));
                        continue;
                    }
                    if completion_count != 1 {
                        messages.push(tool_result(
                            &call.id,
                            "Not accepted: emit exactly one phase_complete call.",
                        ));
                        continue;
                    }
                    match parse_completion(config, &call.arguments) {
                        Ok(completion) => return Ok(completion),
                        Err(message) => messages.push(tool_result(&call.id, &message)),
                    }
                }
                _ => messages.push(tool_result(
                    &call.id,
                    "Unknown tool. Available tools: run_command, phase_complete.",
                )),
            }
        }
    }

    Err(format!(
        "agent did not complete {} phase within {} iterations",
        config.phase, max_iterations
    ))
}

/// Optional one-shot summarization. Callers must fix all statuses before invoking
/// this and must treat every error/empty response as a deterministic-fallback case.
pub async fn summarize_structured_evidence(
    provider: &dyn Provider,
    system: &str,
    evidence: &str,
    effort: crate::provider::Effort,
    cancel: tokio::sync::watch::Receiver<bool>,
) -> Result<String, String> {
    let (_, text, _) = provider_round(
        provider,
        vec![ChatMessage::system(system), ChatMessage::user(evidence)],
        Vec::new(),
        ChatParams {
            temperature: None,
            max_tokens: Some(768),
            tool_choice: ToolChoiceMode::None,
            web_access: false,
            effort,
        },
        cancel,
    )
    .await?;
    let summary = bounded_summary(&text);
    if summary.is_empty() {
        Err("model returned an empty summary".into())
    } else {
        Ok(summary)
    }
}

fn system_prompt(config: &AgentPhaseConfig) -> String {
    format!(
        "You are executing one phase of a Veviad runbook. You have authority only for the active \
         run, step, and phase below. Never claim another step or the whole run is complete. Never \
         hide an error or unknown command outcome. Use run_command for every terminal operation; \
         commands remain visible and independently approval-gated. After observing all command \
         results, call phase_complete exactly once in a later round. Do not emit secrets.\n\n\
         Active run: {}\nActive step: {} ({})\nActive phase: {}\nTarget: {}\n\n\
         The phase_complete identifiers and phase must match these values exactly.",
        config.run_id, config.step_id, config.step_title, config.phase, config.target_summary
    )
}

fn phase_tools(phase: RunbookPhase) -> Vec<ToolDef> {
    let allowed_results = match phase {
        RunbookPhase::Check => json!(["compliant", "noncompliant", "failed", "unknown"]),
        RunbookPhase::Apply => json!(["applied", "failed", "unknown"]),
        RunbookPhase::Verify => json!(["verified", "failed", "unknown"]),
    };
    vec![
        ToolDef {
            name: "run_command".into(),
            description: "Propose one exact shell command for the active runbook phase. The engine applies the runbook approval policy and executes it in the visible target terminal.".into(),
            parameters: json!({
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "command": { "type": "string" },
                    "explanation": { "type": "string" }
                },
                "required": ["command", "explanation"]
            }),
        },
        ToolDef {
            name: "phase_complete".into(),
            description: "Return the structured result for only the active runbook phase. This cannot finish a step that still requires verification and cannot finish the run.".into(),
            parameters: json!({
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "run_id": { "type": "string" },
                    "step_id": { "type": "string" },
                    "phase": { "type": "string", "enum": [phase.as_str()] },
                    "result": { "type": "string", "enum": allowed_results },
                    "summary": { "type": "string" }
                },
                "required": ["run_id", "step_id", "phase", "result", "summary"]
            }),
        },
    ]
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CommandArguments {
    command: String,
    explanation: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CompletionArguments {
    run_id: String,
    step_id: String,
    phase: RunbookPhase,
    result: PhaseResult,
    summary: String,
}

fn parse_completion(config: &AgentPhaseConfig, arguments: &str) -> Result<PhaseCompletion, String> {
    let parsed: CompletionArguments = serde_json::from_str(arguments)
        .map_err(|error| format!("Invalid phase_complete arguments: {error}"))?;
    if parsed.run_id != config.run_id
        || parsed.step_id != config.step_id
        || parsed.phase != config.phase
    {
        return Err("phase_complete does not match the active run, step and phase".into());
    }
    let allowed = matches!(
        (parsed.phase, &parsed.result),
        (
            RunbookPhase::Check,
            PhaseResult::Compliant | PhaseResult::Noncompliant
        ) | (RunbookPhase::Apply, PhaseResult::Applied)
            | (RunbookPhase::Verify, PhaseResult::Verified)
            | (_, PhaseResult::Failed | PhaseResult::Unknown)
    );
    if !allowed {
        return Err(format!(
            "result {:?} is invalid for {} phase",
            parsed.result, parsed.phase
        ));
    }
    let summary = bounded_summary(&parsed.summary);
    if summary.is_empty() {
        return Err("phase_complete summary must not be empty".into());
    }
    Ok(PhaseCompletion {
        run_id: parsed.run_id,
        step_id: parsed.step_id,
        phase: parsed.phase,
        result: parsed.result,
        assurance: (parsed.phase == RunbookPhase::Verify)
            .then_some(VerificationAssurance::AgentAssisted),
        summary,
    })
}

fn bounded_summary(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.chars().count() <= MAX_AGENT_SUMMARY_CHARS {
        return trimmed.to_string();
    }
    trimmed.chars().take(MAX_AGENT_SUMMARY_CHARS).collect()
}

fn observed_failure_completion(
    config: &AgentPhaseConfig,
    result: PhaseResult,
    summary: &str,
) -> PhaseCompletion {
    PhaseCompletion {
        run_id: config.run_id.clone(),
        step_id: config.step_id.clone(),
        phase: config.phase,
        result,
        assurance: None,
        summary: summary.into(),
    }
}

fn render_observation(observation: &AgentCommandObservation) -> String {
    let executed = observation
        .executed_command
        .as_deref()
        .unwrap_or("(not executed)");
    format!(
        "proposed command: {}\nexecuted command: {}\nexit code: {}\noutcome unknown: {}\noutput (redacted tail):\n{}",
        observation.proposed_command,
        executed,
        observation
            .exit_code
            .map(|code| code.to_string())
            .unwrap_or_else(|| "unknown".into()),
        observation.unknown,
        if observation.output_tail.is_empty() {
            "(no output)"
        } else {
            &observation.output_tail
        }
    )
}

async fn provider_round(
    provider: &dyn Provider,
    messages: Vec<ChatMessage>,
    tools: Vec<ToolDef>,
    params: ChatParams,
    cancel: tokio::sync::watch::Receiver<bool>,
) -> Result<(Vec<ToolCall>, String, FinishReason), String> {
    let (tx, mut rx) = tokio::sync::mpsc::channel(64);
    let stream = provider.chat_stream(messages, tools, params, cancel, tx);
    tokio::pin!(stream);
    let mut stream_done: Option<Result<(), ProviderError>> = None;
    let mut calls = Vec::new();
    let mut text = String::new();
    let mut finish = FinishReason::Stop;

    loop {
        tokio::select! {
            result = &mut stream, if stream_done.is_none() => stream_done = Some(result),
            event = rx.recv() => {
                let Some(event) = event else { break };
                collect_provider_event(event, &mut calls, &mut text, &mut finish);
            }
        }
        if stream_done.is_some() && rx.is_closed() {
            while let Ok(event) = rx.try_recv() {
                collect_provider_event(event, &mut calls, &mut text, &mut finish);
            }
            break;
        }
    }

    match stream_done {
        Some(Err(ProviderError::Cancelled)) => Err("cancelled".into()),
        Some(Err(error)) => Err(error.to_string()),
        _ => Ok((calls, text, finish)),
    }
}

fn collect_provider_event(
    event: ProviderEvent,
    calls: &mut Vec<ToolCall>,
    text: &mut String,
    finish: &mut FinishReason,
) {
    match event {
        ProviderEvent::TextDelta(delta) => text.push_str(&delta),
        ProviderEvent::ToolCalls(found) => calls.extend(found),
        ProviderEvent::Done { finish_reason } => *finish = finish_reason,
        ProviderEvent::ReasoningDelta(_) | ProviderEvent::Usage { .. } => {}
    }
}

fn tool_result(id: &str, content: &str) -> ChatMessage {
    ChatMessage {
        role: Role::Tool,
        content: content.into(),
        tool_calls: None,
        tool_call_id: Some(id.into()),
        images: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::sync::Mutex;

    struct ScriptedProvider {
        rounds: Mutex<VecDeque<Vec<ToolCall>>>,
    }

    #[async_trait]
    impl Provider for ScriptedProvider {
        fn id(&self) -> &'static str {
            "scripted"
        }

        fn model_name(&self) -> String {
            "scripted".into()
        }

        async fn chat_stream(
            &self,
            _messages: Vec<ChatMessage>,
            _tools: Vec<ToolDef>,
            _params: ChatParams,
            _cancel: tokio::sync::watch::Receiver<bool>,
            tx: tokio::sync::mpsc::Sender<ProviderEvent>,
        ) -> Result<(), ProviderError> {
            let calls = self.rounds.lock().unwrap().pop_front().unwrap_or_default();
            tx.send(ProviderEvent::ToolCalls(calls)).await.unwrap();
            tx.send(ProviderEvent::Done {
                finish_reason: FinishReason::ToolCalls,
            })
            .await
            .unwrap();
            Ok(())
        }
    }

    #[derive(Default)]
    struct Host {
        commands: Vec<String>,
        observation: Option<AgentCommandObservation>,
    }

    #[async_trait]
    impl AgentCommandHost for Host {
        async fn run_command(
            &mut self,
            command: String,
            _explanation: String,
        ) -> Result<AgentCommandObservation, String> {
            self.commands.push(command.clone());
            Ok(self.observation.clone().unwrap_or(AgentCommandObservation {
                proposed_command: command.clone(),
                executed_command: Some(command),
                exit_code: Some(0),
                output_tail: "ok".into(),
                unknown: false,
                cancelled: false,
            }))
        }
    }

    fn call(id: &str, name: &str, arguments: serde_json::Value) -> ToolCall {
        ToolCall {
            id: id.into(),
            name: name.into(),
            arguments: arguments.to_string(),
        }
    }

    fn config(phase: RunbookPhase) -> AgentPhaseConfig {
        AgentPhaseConfig {
            run_id: "run-1".into(),
            step_id: "step-1".into(),
            phase,
            step_title: "Step one".into(),
            instructions: "Do the scoped work.".into(),
            target_summary: "active terminal s1".into(),
            max_iterations: 5,
            temperature: None,
            effort: crate::provider::Effort::Off,
            max_tokens: 1024,
        }
    }

    fn no_cancel() -> tokio::sync::watch::Receiver<bool> {
        let (sender, receiver) = tokio::sync::watch::channel(false);
        std::mem::forget(sender);
        receiver
    }

    #[tokio::test]
    async fn command_must_be_observed_before_phase_completion() {
        let provider = ScriptedProvider {
            rounds: Mutex::new(VecDeque::from([
                vec![
                    call(
                        "c1",
                        "run_command",
                        json!({"command": "id", "explanation": "inspect identity"}),
                    ),
                    call(
                        "p1",
                        "phase_complete",
                        json!({"run_id":"run-1","step_id":"step-1","phase":"check","result":"compliant","summary":"ok"}),
                    ),
                ],
                vec![call(
                    "p2",
                    "phase_complete",
                    json!({"run_id":"run-1","step_id":"step-1","phase":"check","result":"compliant","summary":"identity checked"}),
                )],
            ])),
        };
        let mut host = Host::default();
        let completion = execute_agent_phase(
            &provider,
            &config(RunbookPhase::Check),
            &mut host,
            no_cancel(),
        )
        .await
        .unwrap();
        assert_eq!(host.commands, vec!["id"]);
        assert_eq!(completion.result, PhaseResult::Compliant);
        assert_eq!(completion.summary, "identity checked");
    }

    #[tokio::test]
    async fn completion_is_bound_to_exact_scope() {
        let provider = ScriptedProvider {
            rounds: Mutex::new(VecDeque::from([
                vec![call(
                    "bad",
                    "phase_complete",
                    json!({"run_id":"other","step_id":"step-1","phase":"apply","result":"applied","summary":"no"}),
                )],
                vec![call(
                    "good",
                    "phase_complete",
                    json!({"run_id":"run-1","step_id":"step-1","phase":"apply","result":"applied","summary":"applied safely"}),
                )],
            ])),
        };
        let mut host = Host::default();
        let completion = execute_agent_phase(
            &provider,
            &config(RunbookPhase::Apply),
            &mut host,
            no_cancel(),
        )
        .await
        .unwrap();
        assert_eq!(completion.run_id, "run-1");
        assert_eq!(completion.phase, RunbookPhase::Apply);
    }

    #[tokio::test]
    async fn unknown_command_outcome_cannot_be_turned_into_success() {
        let provider = ScriptedProvider {
            rounds: Mutex::new(VecDeque::from([vec![call(
                "command",
                "run_command",
                json!({"command":"apply-change","explanation":"perform remediation"}),
            )]])),
        };
        let mut host = Host {
            observation: Some(AgentCommandObservation {
                proposed_command: "apply-change".into(),
                executed_command: Some("apply-change".into()),
                exit_code: None,
                output_tail: String::new(),
                unknown: true,
                cancelled: false,
            }),
            ..Host::default()
        };
        let completion = execute_agent_phase(
            &provider,
            &config(RunbookPhase::Apply),
            &mut host,
            no_cancel(),
        )
        .await
        .unwrap();
        assert_eq!(completion.result, PhaseResult::Unknown);
        assert!(completion
            .summary
            .contains("positive phase completion is forbidden"));
    }

    #[tokio::test]
    async fn failed_command_outcome_cannot_be_turned_into_success() {
        let provider = ScriptedProvider {
            rounds: Mutex::new(VecDeque::from([vec![call(
                "command",
                "run_command",
                json!({"command":"verify-change","explanation":"verify remediation"}),
            )]])),
        };
        let mut host = Host {
            observation: Some(AgentCommandObservation {
                proposed_command: "verify-change".into(),
                executed_command: Some("verify-change".into()),
                exit_code: Some(3),
                output_tail: "failed".into(),
                unknown: false,
                cancelled: false,
            }),
            ..Host::default()
        };
        let completion = execute_agent_phase(
            &provider,
            &config(RunbookPhase::Verify),
            &mut host,
            no_cancel(),
        )
        .await
        .unwrap();
        assert_eq!(completion.result, PhaseResult::Failed);
    }

    #[test]
    fn no_generic_finish_tool_is_exposed() {
        let names: Vec<_> = phase_tools(RunbookPhase::Verify)
            .into_iter()
            .map(|tool| tool.name)
            .collect();
        assert_eq!(names, vec!["run_command", "phase_complete"]);
    }
}
