use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use serde_json::{json, Value};
use tauri::ipc::{Channel, InvokeResponseBody};
use vterminal_lib::agent::run::{
    self, AgentFailureKind, AgentRunOutcome, AgentTermination, ExecTarget,
};
use vterminal_lib::agent::{
    ApprovalDecision, ApprovalResponse, ApprovalState, PtyExecState, SteerState, StreamEvent,
};
use vterminal_lib::provider::{
    ChatMessage, ChatParams, FinishReason, Provider, ProviderError, ProviderEvent, Role, ToolCall,
    ToolDef,
};

enum ScriptedRound {
    Reply {
        text: String,
        calls: Vec<ToolCall>,
        usage: (u32, u32),
        finish: FinishReason,
    },
    Error(String),
}

struct ScriptedProvider {
    rounds: Mutex<VecDeque<ScriptedRound>>,
    inputs: Mutex<Vec<Vec<ChatMessage>>>,
}

impl ScriptedProvider {
    fn new(rounds: impl IntoIterator<Item = ScriptedRound>) -> Self {
        Self {
            rounds: Mutex::new(rounds.into_iter().collect()),
            inputs: Mutex::new(Vec::new()),
        }
    }

    fn inputs(&self) -> Vec<Vec<ChatMessage>> {
        self.inputs.lock().unwrap().clone()
    }
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
        messages: Vec<ChatMessage>,
        _tools: Vec<ToolDef>,
        _params: ChatParams,
        _cancel: tokio::sync::watch::Receiver<bool>,
        tx: tokio::sync::mpsc::Sender<ProviderEvent>,
    ) -> Result<(), ProviderError> {
        self.inputs.lock().unwrap().push(messages);
        let round = self.rounds.lock().unwrap().pop_front();
        match round {
            Some(ScriptedRound::Reply {
                text,
                calls,
                usage,
                finish,
            }) => {
                if !text.is_empty() {
                    tx.send(ProviderEvent::TextDelta(text)).await.unwrap();
                }
                if !calls.is_empty() {
                    tx.send(ProviderEvent::ToolCalls(calls)).await.unwrap();
                }
                tx.send(ProviderEvent::Usage {
                    prompt_tokens: usage.0,
                    completion_tokens: usage.1,
                })
                .await
                .unwrap();
                tx.send(ProviderEvent::Done {
                    finish_reason: finish,
                })
                .await
                .unwrap();
                Ok(())
            }
            Some(ScriptedRound::Error(message)) => Err(ProviderError::Http(message)),
            None => Err(ProviderError::Inference(
                "script exhausted before the agent stopped".into(),
            )),
        }
    }
}

fn call(id: &str, name: &str, arguments: Value) -> ToolCall {
    ToolCall {
        id: id.into(),
        name: name.into(),
        arguments: arguments.to_string(),
    }
}

fn reply(calls: Vec<ToolCall>) -> ScriptedRound {
    ScriptedRound::Reply {
        text: String::new(),
        calls,
        usage: (100, 10),
        finish: FinishReason::ToolCalls,
    }
}

fn finish(id: &str) -> ScriptedRound {
    reply(vec![call(
        id,
        "finish",
        json!({"summary": "scenario complete"}),
    )])
}

struct ScenarioResult {
    outcome: AgentRunOutcome,
    events: Vec<Value>,
}

async fn run_scenario(
    provider: &ScriptedProvider,
    decisions: Vec<ApprovalResponse>,
    web_access: bool,
    max_iterations: u32,
    history: Vec<ChatMessage>,
) -> ScenarioResult {
    run_scenario_with_context(
        provider,
        decisions,
        web_access,
        max_iterations,
        32_768,
        history,
    )
    .await
}

async fn run_scenario_with_context(
    provider: &ScriptedProvider,
    decisions: Vec<ApprovalResponse>,
    web_access: bool,
    max_iterations: u32,
    context_tokens: u32,
    history: Vec<ChatMessage>,
) -> ScenarioResult {
    let approvals = Arc::new(ApprovalState::default());
    let decisions = Arc::new(Mutex::new(VecDeque::from(decisions)));
    let events = Arc::new(Mutex::new(Vec::<Value>::new()));
    let callback_approvals = Arc::clone(&approvals);
    let callback_decisions = Arc::clone(&decisions);
    let callback_events = Arc::clone(&events);
    let on_event: Channel<StreamEvent> = Channel::new(move |body: InvokeResponseBody| {
        let InvokeResponseBody::Json(body) = body else {
            return Ok(());
        };
        let event: Value = serde_json::from_str(&body).unwrap();
        if event["type"] == "CommandProposal" {
            let approval_id = event["approval_id"].as_str().unwrap();
            let decision =
                callback_decisions
                    .lock()
                    .unwrap()
                    .pop_front()
                    .unwrap_or(ApprovalResponse {
                        decision: ApprovalDecision::Run,
                        edited_command: None,
                    });
            callback_approvals.respond(approval_id, decision).unwrap();
        }
        callback_events.lock().unwrap().push(event);
        Ok(())
    });

    let request_id = format!("harness-{}", uuid::Uuid::new_v4());
    let config = run::AgentConfig {
        request_id: request_id.clone(),
        shell: "/bin/zsh".into(),
        cwd: Some(std::env::temp_dir().to_string_lossy().into_owned()),
        temperature: None,
        effort: vterminal_lib::provider::Effort::Off,
        max_iterations,
        context_tokens,
        command_timeout_secs: 5,
        web_access,
        doc_buckets: vec![],
        exec_target: ExecTarget::Subprocess,
    };
    let pty_exec = PtyExecState::default();
    let steers = SteerState::default();
    steers.register(&request_id);
    let (_cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);

    let outcome = run::run_agent(
        provider,
        config,
        "system context that must never be checkpointed".into(),
        "perform the scripted scenario".into(),
        vec![],
        history,
        approvals.as_ref(),
        &pty_exec,
        &steers,
        None,
        None,
        cancel_rx,
        &on_event,
    )
    .await;

    let captured = events.lock().unwrap().clone();
    ScenarioResult {
        outcome,
        events: captured,
    }
}

fn event_types(events: &[Value]) -> Vec<&str> {
    events
        .iter()
        .filter_map(|event| event["type"].as_str())
        .collect()
}

fn assert_storage_safe_checkpoints(events: &[Value]) {
    let checkpoints: Vec<&Value> = events
        .iter()
        .filter(|event| event["type"] == "Checkpoint")
        .collect();
    assert!(!checkpoints.is_empty());
    for (index, checkpoint) in checkpoints.iter().enumerate() {
        assert_eq!(checkpoint["sequence"], (index + 1) as u64);
        let transcript = checkpoint["transcript"].as_array().unwrap();
        assert!(transcript.iter().all(|message| message["role"] != "system"));
        assert!(transcript
            .iter()
            .all(|message| message.get("images").is_none()));
    }
}

#[tokio::test]
async fn approved_command_is_observed_then_the_run_completes() {
    let provider = ScriptedProvider::new([
        reply(vec![call(
            "command-1",
            "run_command",
            json!({"command":"printf harness-ok", "explanation":"emit deterministic output"}),
        )]),
        finish("finish-1"),
    ]);
    let result = run_scenario(&provider, vec![], false, 5, vec![]).await;

    assert_eq!(result.outcome.termination, AgentTermination::Completed);
    assert_eq!(result.outcome.stats.model_rounds, 2);
    assert_eq!(result.outcome.stats.command_proposals, 1);
    assert_eq!(result.outcome.stats.commands_executed, 1);
    assert!(result
        .outcome
        .transcript
        .iter()
        .any(|message| { message.role == Role::Tool && message.content.contains("harness-ok") }));
    assert_storage_safe_checkpoints(&result.events);
    assert!(event_types(&result.events).contains(&"CommandResult"));
}

#[tokio::test]
async fn skipped_command_is_fed_back_without_execution() {
    let provider = ScriptedProvider::new([
        reply(vec![call(
            "command-1",
            "run_command",
            json!({"command":"printf should-not-run", "explanation":"skip fixture"}),
        )]),
        finish("finish-1"),
    ]);
    let result = run_scenario(
        &provider,
        vec![ApprovalResponse {
            decision: ApprovalDecision::Skip,
            edited_command: None,
        }],
        false,
        5,
        vec![],
    )
    .await;

    assert_eq!(result.outcome.stats.commands_skipped, 1);
    assert_eq!(result.outcome.stats.commands_executed, 0);
    assert!(provider.inputs()[1]
        .iter()
        .any(|message| message.content.contains("User skipped this command")));
}

#[tokio::test]
async fn network_policy_refuses_before_an_approval_exists() {
    let provider = ScriptedProvider::new([
        reply(vec![call(
            "command-1",
            "run_command",
            json!({"command":"curl https://example.com", "explanation":"network fixture"}),
        )]),
        finish("finish-1"),
    ]);
    let result = run_scenario(&provider, vec![], false, 5, vec![]).await;

    assert_eq!(result.outcome.stats.commands_blocked, 1);
    assert_eq!(result.outcome.stats.command_proposals, 0);
    assert!(!event_types(&result.events).contains(&"CommandProposal"));
    assert!(provider.inputs()[1]
        .iter()
        .any(|message| message.content.contains("turned internet access off")));
}

#[tokio::test]
async fn provider_failure_after_execution_keeps_the_command_result() {
    let provider = ScriptedProvider::new([
        reply(vec![call(
            "command-1",
            "run_command",
            json!({"command":"printf recover-me", "explanation":"recovery fixture"}),
        )]),
        ScriptedRound::Error("provider sentinel body".into()),
    ]);
    let result = run_scenario(&provider, vec![], false, 5, vec![]).await;

    assert!(matches!(
        result.outcome.termination,
        AgentTermination::Failed {
            kind: AgentFailureKind::Provider,
            ..
        }
    ));
    assert!(result
        .outcome
        .transcript
        .iter()
        .any(|message| { message.role == Role::Tool && message.content.contains("recover-me") }));
    assert_storage_safe_checkpoints(&result.events);
}

#[tokio::test]
async fn stop_cancels_and_prunes_the_unanswered_call_from_the_checkpoint() {
    let provider = ScriptedProvider::new([reply(vec![call(
        "command-1",
        "run_command",
        json!({"command":"printf never", "explanation":"stop fixture"}),
    )])]);
    let result = run_scenario(
        &provider,
        vec![ApprovalResponse {
            decision: ApprovalDecision::Stop,
            edited_command: None,
        }],
        false,
        5,
        vec![],
    )
    .await;

    assert_eq!(result.outcome.termination, AgentTermination::Cancelled);
    assert!(result.outcome.transcript.iter().all(|message| {
        message
            .tool_calls
            .as_ref()
            .is_none_or(|calls| calls.iter().all(|call| call.id != "command-1"))
    }));
}

#[tokio::test]
async fn paused_transcript_can_continue_in_a_fresh_run() {
    let first = ScriptedProvider::new([reply(vec![call("unknown-1", "missing_tool", json!({}))])]);
    let paused = run_scenario(&first, vec![], false, 1, vec![]).await;
    assert!(matches!(
        paused.outcome.termination,
        AgentTermination::Paused { .. }
    ));

    let second = ScriptedProvider::new([finish("finish-2")]);
    let resumed = run_scenario(&second, vec![], false, 2, paused.outcome.transcript).await;
    assert_eq!(resumed.outcome.termination, AgentTermination::Completed);
    assert!(second.inputs()[0]
        .iter()
        .any(|message| message.content.contains("unknown tool")));
}

#[tokio::test]
async fn an_approved_edit_executes_and_reports_the_edited_command() {
    let provider = ScriptedProvider::new([
        reply(vec![call(
            "command-1",
            "run_command",
            json!({"command":"printf original-marker", "explanation":"edit fixture"}),
        )]),
        finish("finish-1"),
    ]);
    let result = run_scenario(
        &provider,
        vec![ApprovalResponse {
            decision: ApprovalDecision::Run,
            edited_command: Some("printf edited-marker".into()),
        }],
        false,
        5,
        vec![],
    )
    .await;

    let observed = provider.inputs()[1]
        .iter()
        .find(|message| message.role == Role::Tool)
        .unwrap()
        .content
        .clone();
    assert!(observed.contains("the user edited the command to: printf edited-marker"));
    assert!(observed.contains("edited-marker"));
    assert!(!observed.contains("original-marker"));
    assert_eq!(result.outcome.stats.commands_executed, 1);
}

#[tokio::test]
async fn malformed_arguments_are_model_visible_without_drawing_an_approval() {
    let malformed = ToolCall {
        id: "malformed-1".into(),
        name: "run_command".into(),
        arguments: "{not-json".into(),
    };
    let provider = ScriptedProvider::new([reply(vec![malformed]), finish("finish-1")]);
    let result = run_scenario(&provider, vec![], false, 5, vec![]).await;

    assert_eq!(result.outcome.stats.command_proposals, 0);
    assert_eq!(result.outcome.stats.commands_executed, 0);
    assert!(!event_types(&result.events).contains(&"CommandProposal"));
    assert!(provider.inputs()[1]
        .iter()
        .any(|message| message.content.contains("arguments were not valid JSON")));
}

#[tokio::test]
async fn multiple_calls_remain_paired_through_the_next_model_round() {
    let provider = ScriptedProvider::new([
        reply(vec![
            call(
                "command-1",
                "run_command",
                json!({"command":"printf first", "explanation":"first fixture"}),
            ),
            call(
                "command-2",
                "run_command",
                json!({"command":"printf second", "explanation":"second fixture"}),
            ),
        ]),
        finish("finish-1"),
    ]);
    let result = run_scenario(&provider, vec![], false, 5, vec![]).await;

    let second_round = &provider.inputs()[1];
    for (id, marker) in [("command-1", "first"), ("command-2", "second")] {
        assert!(second_round.iter().any(|message| {
            message.role == Role::Tool
                && message.tool_call_id.as_deref() == Some(id)
                && message.content.contains(marker)
        }));
    }
    assert_eq!(result.outcome.stats.command_proposals, 2);
    assert_eq!(result.outcome.stats.commands_executed, 2);
    assert_storage_safe_checkpoints(&result.events);
}

#[tokio::test]
async fn a_nonzero_exit_is_preserved_as_observed_evidence() {
    let provider = ScriptedProvider::new([
        reply(vec![call(
            "command-1",
            "run_command",
            json!({"command":"printf failure-output; exit 7", "explanation":"nonzero fixture"}),
        )]),
        finish("finish-1"),
    ]);
    let result = run_scenario(&provider, vec![], false, 5, vec![]).await;

    assert_eq!(result.outcome.termination, AgentTermination::Completed);
    assert!(provider.inputs()[1].iter().any(|message| {
        message.role == Role::Tool
            && message.content.contains("exit code: 7")
            && message.content.contains("failure-output")
    }));
}

#[tokio::test]
async fn context_pressure_returns_a_resumable_context_pause() {
    let provider = ScriptedProvider::new([ScriptedRound::Reply {
        text: String::new(),
        calls: vec![call("unknown-1", "missing_tool", json!({}))],
        usage: (4_000, 10),
        finish: FinishReason::ToolCalls,
    }]);
    let result = run_scenario_with_context(&provider, vec![], false, 5, 8_192, vec![]).await;

    assert!(matches!(
        result.outcome.termination,
        AgentTermination::Paused {
            reason: vterminal_lib::agent::PauseReason::ContextLimit,
            steps: 1,
            context_used: 4_000,
            context_limit: 8_192,
            ..
        }
    ));
    assert!(result
        .outcome
        .transcript
        .iter()
        .any(|message| message.content.contains("unknown tool")));
}
