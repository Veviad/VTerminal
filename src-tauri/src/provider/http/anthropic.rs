//! Anthropic Messages API.
//!
//! Distinct enough from the OpenAI shape to warrant its own module: the system
//! prompt is a top-level field, content is typed blocks rather than strings,
//! reasoning depth rides on `output_config.effort`, and reasoning comes back as
//! `thinking` blocks instead of a text prefix.

use serde_json::{json, Map, Value};

use super::{client, emit, read_sse, send_with_retry};
use crate::models::catalog::{CatalogModel, Effort};
use crate::provider::{
    ChatMessage, ChatParams, FinishReason, Provider, ProviderError, ProviderEvent, Role, ToolCall,
    ToolChoiceMode, ToolDef,
};

const API_URL: &str = "https://api.anthropic.com/v1/messages";
const API_VERSION: &str = "2023-06-01";

pub struct AnthropicProvider {
    pub model: &'static CatalogModel,
    pub api_key: crate::credentials::Secret,
}

/// Claude Haiku 4.5 predates the effort parameter and returns a 400 for it —
/// depth there is a thinking token budget instead. Every other Claude in the
/// catalog takes `output_config.effort`.
fn uses_budget_tokens(model: &CatalogModel) -> bool {
    model.wire_model.starts_with("claude-haiku")
}

/// App ladder → Anthropic's levels, by the same name wherever one exists.
///
/// The vendor ladder is `low|medium|high|xhigh|max`, one rung longer than ours,
/// so exactly one has to go unreached — and it is `xhigh`, not `high`. `high` is
/// Anthropic's documented default and the level "equivalent to not setting the
/// parameter"; `xhigh` is documented for long-horizon agentic runs "over 30
/// minutes" with "token budgets in the millions". Mapping our `High` onto
/// `xhigh` made the middle of the picker cost far more than its label implies,
/// and left the vendor's own default unreachable. `Max` still reaches `max`.
fn wire_effort(effort: Effort) -> &'static str {
    match effort {
        // Off is expressed by disabling thinking, not by an effort level; the
        // API rejects disabled thinking above `high`, so pair it with `high`.
        Effort::Off => "high",
        Effort::Low => "low",
        Effort::Medium => "medium",
        Effort::High => "high",
        Effort::Max => "max",
    }
}

/// Anthropic's server-side fetch, as a tool definition.
///
/// Deliberately the BASIC version. The `_2026…` variants add dynamic filtering,
/// which runs through code execution: they default to `allowed_callers:
/// ["code_execution_…"]`, are not ZDR-eligible, and require an explicit
/// `["direct"]` on models without programmatic tool calling — a per-model
/// compatibility matrix maintained from 400s, exactly like `efforts`.
/// `web_fetch_20250910` defaults to `["direct"]` and works across the lineup,
/// so size is capped with `max_content_tokens` instead.
///
/// `max_uses` above 1 is what buys LINK FOLLOWING: the API permits fetching a
/// URL that came from a previous fetch result, which is how the agent recovers
/// when the URL the user pasted is close but not exactly right. Failed fetches
/// count against it. No `allowed_domains` — the user's URL is arbitrary by
/// definition, and a path in such an entry never matches a fetch anyway.
fn web_fetch_tool() -> Value {
    json!({
        "type": "web_fetch_20250910",
        "name": "web_fetch",
        "max_uses": 8,
        "max_content_tokens": 30000,
        "citations": { "enabled": true },
    })
}

/// The `tools` array and the `tool_choice` that goes with it, or `None` when
/// this turn offers no tools at all.
///
/// Extracted from `chat_stream` purely so it can be tested: every rule below is
/// a 400 or a silently-disabled capability if it drifts, and none of them are
/// reachable through the streaming path.
fn build_tools(
    tools: &[ToolDef],
    params: &ChatParams,
    model: &CatalogModel,
) -> Option<(Vec<Value>, Option<Value>)> {
    let mut wire: Vec<Value> = tools
        .iter()
        .map(|t| {
            json!({
                "name": t.name,
                "description": t.description,
                "input_schema": t.parameters,
            })
        })
        .collect();

    // A server tool is not a `ToolDef`: no schema, never dispatched here, and
    // Anthropic runs it inside this very request.
    let web = params.web_access && model.native_web_fetch;
    if web {
        wire.push(web_fetch_tool());
    }
    if wire.is_empty() {
        return None;
    }

    let client_tools = !tools.is_empty();
    let choice = if client_tools && matches!(params.tool_choice, ToolChoiceMode::None) {
        // Gate on CLIENT tools: ask mode passes `None` because it has nothing to
        // dispatch, and sending `none` there would disable the web tool we just
        // added — enabling and disabling web in the same request.
        Some(json!({"type": "none"}))
    } else if web && client_tools {
        // Claude may call a server tool and a client tool in the SAME parallel
        // group. That returns `stop_reason: "tool_use"` with a `server_tool_use`
        // block carrying no result, which has to be echoed back verbatim or the
        // next request 400s — and a flat `ChatMessage` cannot represent that
        // block. `run_command` is serial anyway (one command, one approval), so
        // nothing is lost by keeping that shape off the wire entirely.
        Some(json!({"type": "auto", "disable_parallel_tool_use": true}))
    } else {
        None
    };
    Some((wire, choice))
}

fn budget_tokens(effort: Effort) -> u32 {
    match effort {
        Effort::Off => 0,
        Effort::Low => 1024,
        Effort::Medium => 4096,
        Effort::High => 8192,
        Effort::Max => 16384,
    }
}

/// Flatten our conversation into Anthropic's shape: system text lifted out,
/// everything else as typed content blocks.
fn build_messages(messages: Vec<ChatMessage>) -> (String, Vec<Value>) {
    let mut system = String::new();
    let mut out: Vec<Value> = Vec::new();

    for mut msg in messages {
        match msg.role {
            Role::System => {
                if !system.is_empty() {
                    system.push_str("\n\n");
                }
                system.push_str(&msg.content);
            }
            Role::User => {
                // Take the images before the text: `json!` below borrows
                // `msg.content`, and moving a field out of a partially borrowed
                // struct is a fight with no upside.
                let images = msg.images.take().unwrap_or_default();
                let mut blocks: Vec<Value> = Vec::with_capacity(images.len() + 1);
                // Images BEFORE the question. Anthropic documents that ordering as
                // producing better results, and it matches how the panel renders
                // the turn — thumbnails above the text.
                for img in images {
                    blocks.push(json!({
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": img.media_type,
                            "data": img.data,
                        },
                    }));
                }
                blocks.push(json!({"type": "text", "text": msg.content}));
                // A mid-run steering message lands directly behind a round's
                // tool results, which are already wrapped in a user turn. Adding
                // it as a text block on that SAME turn is the documented shape
                // and sidesteps the question of whether consecutive user turns
                // are accepted. Text after the tool_result blocks, never before:
                // tool_result must lead.
                match out.last_mut() {
                    Some(prev)
                        if prev["role"] == "user"
                            && prev["content"][0]["type"] == "tool_result" =>
                    {
                        if let Some(arr) = prev["content"].as_array_mut() {
                            arr.extend(blocks);
                        }
                    }
                    _ => out.push(json!({"role": "user", "content": blocks})),
                }
            }
            Role::Assistant => {
                let mut blocks: Vec<Value> = Vec::new();
                if !msg.content.trim().is_empty() {
                    blocks.push(json!({"type": "text", "text": msg.content}));
                }
                for call in msg.tool_calls.unwrap_or_default() {
                    let input: Value = serde_json::from_str(&call.arguments)
                        .unwrap_or_else(|_| Value::Object(Map::new()));
                    blocks.push(json!({
                        "type": "tool_use",
                        "id": call.id,
                        "name": call.name,
                        "input": input,
                    }));
                }
                if !blocks.is_empty() {
                    out.push(json!({"role": "assistant", "content": blocks}));
                }
            }
            Role::Tool => {
                let block = json!({
                    "type": "tool_result",
                    "tool_use_id": msg.tool_call_id.unwrap_or_default(),
                    "content": msg.content,
                });
                // Every tool_result for a turn must sit in ONE user message —
                // splitting them is a 400. Append to the previous user turn
                // when it is already a tool-result carrier.
                //
                // The `content[0]` probe means a user turn that already carries a
                // trailing text block still matches, and this would append the
                // tool_result AFTER that text — invalid ordering. Unreachable
                // only because steering messages are injected exclusively at a
                // round boundary, so `assistant → tool → user → tool` never
                // occurs. Relaxing that rule breaks this.
                match out.last_mut() {
                    Some(prev)
                        if prev["role"] == "user"
                            && prev["content"][0]["type"] == "tool_result" =>
                    {
                        if let Some(arr) = prev["content"].as_array_mut() {
                            arr.push(block);
                        }
                    }
                    _ => out.push(json!({"role": "user", "content": [block]})),
                }
            }
        }
    }
    (system, out)
}

#[async_trait::async_trait]
impl Provider for AnthropicProvider {
    fn id(&self) -> &'static str {
        "anthropic"
    }

    fn model_name(&self) -> String {
        self.model.wire_model.to_string()
    }

    async fn chat_stream(
        &self,
        messages: Vec<ChatMessage>,
        tools: Vec<ToolDef>,
        params: ChatParams,
        mut cancel: tokio::sync::watch::Receiver<bool>,
        tx: tokio::sync::mpsc::Sender<ProviderEvent>,
    ) -> Result<(), ProviderError> {
        let effort = self.model.clamp_effort(params.effort);
        let (system, msgs) = build_messages(messages);

        let mut body = json!({
            "model": self.model.wire_model,
            "max_tokens": params.max_tokens.unwrap_or(4096),
            "messages": msgs,
            "stream": true,
        });
        if !system.is_empty() {
            // A block array rather than a bare string, so the prefix can carry
            // a cache breakpoint. Agent mode re-sends tools+system every round
            // (a prefix growing past 20k tokens over a run); cached reads bill
            // at roughly a tenth. Render order is tools -> system -> messages,
            // so one breakpoint on the last system block covers both.
            body["system"] = json!([{
                "type": "text",
                "text": system,
                "cache_control": { "type": "ephemeral" },
            }]);
        }
        // Opus 5 and Sonnet 5 reject temperature outright — the catalog says so.
        if let (true, Some(t)) = (self.model.supports_temperature, params.temperature) {
            body["temperature"] = json!(t.clamp(0.0, 1.0));
        }

        if uses_budget_tokens(self.model) {
            if effort != Effort::Off {
                let budget = budget_tokens(effort);
                // budget_tokens must stay strictly below max_tokens.
                let max = params.max_tokens.unwrap_or(4096).max(budget + 1024);
                body["max_tokens"] = json!(max);
                body["thinking"] = json!({"type": "enabled", "budget_tokens": budget});
            }
        } else {
            body["output_config"] = json!({"effort": wire_effort(effort)});
            body["thinking"] = if effort == Effort::Off {
                json!({"type": "disabled"})
            } else {
                // `display` defaults to "omitted", which streams thinking blocks
                // with empty text — the reasoning panel would sit there blank.
                json!({"type": "adaptive", "display": "summarized"})
            };
        }

        if let Some((wire_tools, choice)) = build_tools(&tools, &params, self.model) {
            body["tools"] = json!(wire_tools);
            if let Some(choice) = choice {
                body["tool_choice"] = choice;
            }
        }

        let resp = send_with_retry(
            || {
                client()
                    .expect("client built once")
                    .post(API_URL)
                    .header("x-api-key", self.api_key.expose())
                    .header("anthropic-version", API_VERSION)
                    .json(&body)
            },
            &mut cancel,
            Some(&self.api_key),
        )
        .await?;

        // Tool calls stream as partial JSON per block; they are only meaningful
        // whole, so accumulate and emit once at the end.
        let mut pending: std::collections::BTreeMap<u64, (String, String, String)> =
            Default::default();
        let mut prompt_tokens = 0u32;
        let mut completion_tokens = 0u32;
        let mut finish = FinishReason::Stop;
        let mut paused = false;

        let cancelled = read_sse(resp, &mut cancel, &tx, |data, out| {
            let v: Value = match serde_json::from_str(data) {
                Ok(v) => v,
                Err(_) => return Ok(false), // ignore frames we don't model
            };
            match v["type"].as_str().unwrap_or_default() {
                "message_start" => {
                    // Cached reads are billed separately from fresh input, so
                    // reporting only `input_tokens` would make a warm cache
                    // look like the prompt shrank.
                    let usage = |k: &str| {
                        v.pointer(&format!("/message/usage/{k}"))
                            .and_then(Value::as_u64)
                            .unwrap_or(0) as u32
                    };
                    prompt_tokens = usage("input_tokens")
                        + usage("cache_creation_input_tokens")
                        + usage("cache_read_input_tokens");
                }
                "content_block_start" => {
                    if v.pointer("/content_block/type").and_then(Value::as_str) == Some("tool_use")
                    {
                        let idx = v["index"].as_u64().unwrap_or(0);
                        pending.insert(
                            idx,
                            (
                                v.pointer("/content_block/id")
                                    .and_then(Value::as_str)
                                    .unwrap_or_default()
                                    .to_string(),
                                v.pointer("/content_block/name")
                                    .and_then(Value::as_str)
                                    .unwrap_or_default()
                                    .to_string(),
                                String::new(),
                            ),
                        );
                    }
                }
                "content_block_delta" => {
                    let delta = &v["delta"];
                    match delta["type"].as_str().unwrap_or_default() {
                        "text_delta" => {
                            if let Some(t) = delta["text"].as_str().filter(|t| !t.is_empty()) {
                                out.push(ProviderEvent::TextDelta(t.to_string()));
                            }
                        }
                        "thinking_delta" => {
                            if let Some(t) = delta["thinking"].as_str().filter(|t| !t.is_empty()) {
                                out.push(ProviderEvent::ReasoningDelta(t.to_string()));
                            }
                        }
                        "input_json_delta" => {
                            let idx = v["index"].as_u64().unwrap_or(0);
                            if let Some(entry) = pending.get_mut(&idx) {
                                entry
                                    .2
                                    .push_str(delta["partial_json"].as_str().unwrap_or_default());
                            }
                        }
                        _ => {}
                    }
                }
                "message_delta" => {
                    if let Some(u) = v.pointer("/usage/output_tokens").and_then(Value::as_u64) {
                        completion_tokens = u as u32;
                    }
                    match v.pointer("/delta/stop_reason").and_then(Value::as_str) {
                        Some("tool_use") => finish = FinishReason::ToolCalls,
                        Some("max_tokens") => finish = FinishReason::Length,
                        Some("refusal") => {
                            return Err(ProviderError::Http(
                                "the model declined this request".into(),
                            ))
                        }
                        // The server-side web loop paused after its internal
                        // iteration limit. Resuming means re-POSTing this
                        // turn's raw content blocks — which a flat
                        // `ChatMessage` cannot carry — so for now it is
                        // reported rather than continued. Reported, and not
                        // dropped into the `_` arm: an unhandled pause leaves
                        // `finish` as `Stop` with empty text, and the run ends
                        // mid-research looking exactly like a model that
                        // simply stopped talking.
                        Some("pause_turn") => paused = true,
                        _ => {}
                    }
                }
                "error" => {
                    let msg = v
                        .pointer("/error/message")
                        .and_then(Value::as_str)
                        .unwrap_or("stream error");
                    return Err(ProviderError::Http(
                        crate::credentials::redact_provider_text(msg, Some(&self.api_key)),
                    ));
                }
                "message_stop" => return Ok(true),
                _ => {}
            }
            Ok(false)
        })
        .await?;

        if cancelled {
            let _ = tx
                .send(ProviderEvent::Done {
                    finish_reason: FinishReason::Cancelled,
                })
                .await;
            return Err(ProviderError::Cancelled);
        }

        // Surfaced as an error rather than a silent short answer: the turn is
        // genuinely incomplete, and the alternative is prose that stops in the
        // middle of the research it was doing with no indication why.
        if paused && pending.is_empty() {
            return Err(ProviderError::Http(
                "the model paused mid-research after too many web lookups — ask it to continue, \
                 or narrow the question"
                    .into(),
            ));
        }

        if !pending.is_empty() {
            finish = FinishReason::ToolCalls;
            let calls: Vec<ToolCall> = pending
                .into_values()
                .map(|(id, name, arguments)| ToolCall {
                    id,
                    name,
                    arguments: if arguments.trim().is_empty() {
                        "{}".to_string()
                    } else {
                        arguments
                    },
                })
                .collect();
            emit(&tx, ProviderEvent::ToolCalls(calls)).await?;
        }

        let _ = tx
            .send(ProviderEvent::Usage {
                prompt_tokens,
                completion_tokens,
            })
            .await;
        let _ = tx
            .send(ProviderEvent::Done {
                finish_reason: finish,
            })
            .await;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::catalog;

    #[test]
    fn haiku_uses_budgets_everything_else_uses_effort() {
        assert!(uses_budget_tokens(
            catalog::find("anthropic/claude-haiku-4-5").unwrap()
        ));
        assert!(!uses_budget_tokens(
            catalog::find("anthropic/claude-opus-5").unwrap()
        ));
    }

    fn params(web_access: bool, tool_choice: ToolChoiceMode) -> ChatParams {
        ChatParams {
            temperature: None,
            max_tokens: None,
            tool_choice,
            effort: Effort::Off,
            web_access,
        }
    }

    fn client_tool() -> ToolDef {
        ToolDef {
            name: "run_command".into(),
            description: "runs a command".into(),
            parameters: json!({"type": "object"}),
        }
    }

    fn opus() -> &'static CatalogModel {
        catalog::find("anthropic/claude-opus-5").unwrap()
    }

    #[test]
    fn web_fetch_rides_the_same_tools_array_as_client_tools() {
        let (wire, _) = build_tools(
            &[client_tool()],
            &params(true, ToolChoiceMode::Auto),
            opus(),
        )
        .expect("tools present");
        assert_eq!(wire.len(), 2);
        // A server tool is typed and schemaless — sending it with an
        // `input_schema` (or as a bare function) is a 400.
        let web = wire
            .iter()
            .find(|t| t["type"] == "web_fetch_20250910")
            .unwrap();
        assert_eq!(web["name"], "web_fetch");
        assert!(web.get("input_schema").is_none());
        assert!(web.get("description").is_none());
        // Above 1, or the agent can never follow a link off the fetched page.
        assert!(web["max_uses"].as_u64().unwrap() > 1);
    }

    /// The trap that would make web silently "not work" in Ask mode: that mode
    /// passes `ToolChoiceMode::None` because it has no CLIENT tools to run, and
    /// a blanket `tool_choice: none` would disable the web tool in the very
    /// request that just enabled it.
    #[test]
    fn tool_choice_none_does_not_disable_a_lone_server_tool() {
        let (wire, choice) = build_tools(&[], &params(true, ToolChoiceMode::None), opus())
            .expect("web tool alone still counts as tools");
        assert_eq!(wire.len(), 1);
        assert_eq!(
            choice, None,
            "must not send tool_choice:none with only a server tool"
        );

        // With real client tools, `none` still means none.
        let (_, choice) = build_tools(
            &[client_tool()],
            &params(true, ToolChoiceMode::None),
            opus(),
        )
        .unwrap();
        assert_eq!(choice, Some(json!({"type": "none"})));
    }

    /// A server tool and a client tool in one parallel group returns a
    /// `server_tool_use` block that a flat `ChatMessage` cannot echo back, and
    /// dropping it is a 400 on the next round.
    #[test]
    fn parallel_tool_use_is_disabled_when_web_and_client_tools_coexist() {
        let (_, choice) = build_tools(
            &[client_tool()],
            &params(true, ToolChoiceMode::Auto),
            opus(),
        )
        .unwrap();
        assert_eq!(
            choice,
            Some(json!({"type": "auto", "disable_parallel_tool_use": true}))
        );
        // No web tool: nothing to serialize, so leave tool_choice implicit.
        let (_, choice) = build_tools(
            &[client_tool()],
            &params(false, ToolChoiceMode::Auto),
            opus(),
        )
        .unwrap();
        assert_eq!(choice, None);
    }

    #[test]
    fn web_access_is_intersected_with_the_models_own_capability() {
        // Setting on, model cannot: no tools at all rather than a 400.
        assert!(build_tools(&[], &params(true, ToolChoiceMode::Auto), opus()).is_some());
        let no_web = catalog::CATALOG
            .iter()
            .find(|m| !m.native_web_fetch)
            .expect("a non-Anthropic model exists");
        assert!(build_tools(&[], &params(true, ToolChoiceMode::Auto), no_web).is_none());
        // Setting off, model can: still nothing.
        assert!(build_tools(&[], &params(false, ToolChoiceMode::Auto), opus()).is_none());
    }

    #[test]
    fn rungs_keep_their_own_names_and_xhigh_is_the_one_skipped() {
        // Anthropic's ladder is one rung longer than ours, so one value is
        // unreachable. It must be `xhigh` — documented for 30-minute agentic
        // runs — and never `high`, which is the vendor's own default.
        assert_eq!(wire_effort(Effort::High), "high");
        assert_eq!(wire_effort(Effort::Max), "max");
        assert_eq!(wire_effort(Effort::Low), "low");
        // Off still needs a legal effort: disabled thinking 400s above `high`.
        assert_eq!(wire_effort(Effort::Off), "high");
    }

    #[test]
    fn a_steer_rides_the_tool_result_turn_instead_of_opening_a_second_user_turn() {
        // The shape the agent loop produces when a steering message is appended
        // at a round boundary. Two adjacent user turns on the wire is the thing
        // to avoid; one turn holding [tool_result, text] is the documented shape.
        let (_, msgs) = build_messages(vec![
            ChatMessage {
                role: Role::Assistant,
                content: String::new(),
                tool_calls: Some(vec![crate::provider::ToolCall {
                    id: "t1".into(),
                    name: "run_command".into(),
                    arguments: "{}".into(),
                }]),
                tool_call_id: None,
                images: None,
            },
            ChatMessage {
                role: Role::Tool,
                content: "exit code: 0".into(),
                tool_calls: None,
                tool_call_id: Some("t1".into()),
                images: None,
            },
            ChatMessage::user("actually, check the logs first"),
        ]);

        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0]["role"], "assistant");
        assert_eq!(msgs[1]["role"], "user");
        let blocks = msgs[1]["content"].as_array().unwrap();
        assert_eq!(blocks.len(), 2);
        // tool_result must lead; the steer text follows it.
        assert_eq!(blocks[0]["type"], "tool_result");
        assert_eq!(blocks[1]["type"], "text");
        assert_eq!(blocks[1]["text"], "actually, check the logs first");
    }

    #[test]
    fn images_lead_the_user_turn_ahead_of_the_question() {
        let (_, msgs) = build_messages(vec![ChatMessage::user_with_images(
            "what is this",
            vec![
                crate::provider::ImagePart {
                    media_type: "image/png".into(),
                    data: "AAAA".into(),
                },
                crate::provider::ImagePart {
                    media_type: "image/jpeg".into(),
                    data: "BBBB".into(),
                },
            ],
        )]);

        let blocks = msgs[0]["content"].as_array().expect("blocks");
        assert_eq!(blocks.len(), 3);
        // Images BEFORE the text: Anthropic documents that ordering as producing
        // better results, and the panel renders the turn the same way.
        assert_eq!(blocks[0]["type"], "image");
        assert_eq!(blocks[0]["source"]["type"], "base64");
        assert_eq!(blocks[0]["source"]["media_type"], "image/png");
        assert_eq!(blocks[0]["source"]["data"], "AAAA");
        assert_eq!(blocks[1]["source"]["media_type"], "image/jpeg");
        assert_eq!(blocks[2]["type"], "text");
        assert_eq!(blocks[2]["text"], "what is this");
    }

    /// A turn with no images must serialize exactly as it did before images
    /// existed — one text block, nothing else.
    #[test]
    fn a_user_turn_without_images_is_unchanged() {
        let (_, msgs) = build_messages(vec![ChatMessage::user("what is my cwd")]);
        let blocks = msgs[0]["content"].as_array().unwrap();
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0], json!({"type": "text", "text": "what is my cwd"}));
    }

    /// The tool-result carrier appends the WHOLE block list, images included —
    /// `arr.push(block)` would have silently kept only the text.
    #[test]
    fn images_on_a_steer_join_the_tool_result_turn() {
        let (_, msgs) = build_messages(vec![
            ChatMessage {
                role: Role::Assistant,
                content: String::new(),
                tool_calls: Some(vec![crate::provider::ToolCall {
                    id: "t1".into(),
                    name: "run_command".into(),
                    arguments: "{}".into(),
                }]),
                tool_call_id: None,
                images: None,
            },
            ChatMessage {
                role: Role::Tool,
                content: "exit code: 0".into(),
                tool_calls: None,
                tool_call_id: Some("t1".into()),
                images: None,
            },
            ChatMessage::user_with_images(
                "look at this instead",
                vec![crate::provider::ImagePart {
                    media_type: "image/png".into(),
                    data: "AAAA".into(),
                }],
            ),
        ]);

        assert_eq!(msgs.len(), 2);
        let blocks = msgs[1]["content"].as_array().unwrap();
        assert_eq!(blocks.len(), 3);
        assert_eq!(blocks[0]["type"], "tool_result");
        assert_eq!(blocks[1]["type"], "image");
        assert_eq!(blocks[2]["type"], "text");
    }

    #[test]
    fn an_ordinary_user_turn_still_opens_its_own_message() {
        // Only a tool-result carrier absorbs the text — a plain user turn after
        // an assistant answer must not be folded into anything.
        let (_, msgs) = build_messages(vec![
            ChatMessage::user("first"),
            ChatMessage::assistant("answer"),
            ChatMessage::user("second"),
        ]);
        assert_eq!(msgs.len(), 3);
        assert_eq!(msgs[2]["role"], "user");
        assert_eq!(msgs[2]["content"][0]["text"], "second");
    }

    #[test]
    fn system_turns_are_lifted_out_of_messages() {
        let (system, msgs) = build_messages(vec![
            ChatMessage::system("be terse"),
            ChatMessage::user("hi"),
        ]);
        assert_eq!(system, "be terse");
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0]["role"], "user");
    }

    #[test]
    fn consecutive_tool_results_share_one_user_turn() {
        // Splitting them across messages is a 400 from the API.
        let msgs = vec![
            ChatMessage {
                role: Role::Tool,
                content: "a".into(),
                tool_calls: None,
                tool_call_id: Some("t1".into()),
                images: None,
            },
            ChatMessage {
                role: Role::Tool,
                content: "b".into(),
                tool_calls: None,
                tool_call_id: Some("t2".into()),
                images: None,
            },
        ];
        let (_, out) = build_messages(msgs);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["content"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn assistant_tool_calls_become_tool_use_blocks() {
        let msgs = vec![ChatMessage {
            role: Role::Assistant,
            content: String::new(),
            tool_calls: Some(vec![ToolCall {
                id: "tu_1".into(),
                name: "run_command".into(),
                arguments: r#"{"cmd":"ls"}"#.into(),
            }]),
            tool_call_id: None,
            images: None,
        }];
        let (_, out) = build_messages(msgs);
        assert_eq!(out[0]["content"][0]["type"], "tool_use");
        assert_eq!(out[0]["content"][0]["input"]["cmd"], "ls");
    }

    /// The test that actually prevents the 400.
    ///
    /// `agent::history::normalize` promises that a transcript restored from the
    /// archive is safe to send, but the promise is only worth what this builder
    /// does with it — so exercise the REAL builder rather than a model of it, and
    /// assert Anthropic's own rule: every `tool_result.tool_use_id` must match a
    /// `tool_use.id` in an earlier assistant turn. It lives here, beside
    /// `build_messages`, because this is the contract that would break.
    #[test]
    fn a_normalized_transcript_survives_the_builder() {
        let mut messages = vec![
            ChatMessage::system("AGENT"),
            // Every hazard a stored transcript can carry, at once.
            ChatMessage::system("stale context from the old session"),
            ChatMessage {
                role: Role::Tool,
                content: "result with no call".into(),
                tool_calls: None,
                tool_call_id: Some("ghost".into()),
                images: None,
            },
            ChatMessage {
                role: Role::Assistant,
                content: String::new(),
                tool_calls: Some(vec![ToolCall {
                    id: "unanswered".into(),
                    name: "run_command".into(),
                    arguments: "{}".into(),
                }]),
                tool_call_id: None,
                images: None,
            },
            ChatMessage {
                role: Role::Assistant,
                content: "running it".into(),
                tool_calls: Some(vec![ToolCall {
                    id: "good".into(),
                    name: "run_command".into(),
                    arguments: r#"{"command":"ls"}"#.into(),
                }]),
                tool_call_id: None,
                images: None,
            },
            ChatMessage {
                role: Role::Tool,
                content: "exit code: 0".into(),
                tool_calls: None,
                tool_call_id: Some("good".into()),
                images: None,
            },
            ChatMessage::user("the goal"),
        ];
        crate::agent::history::normalize(&mut messages);
        let (system, out) = build_messages(messages);

        // The stale system message never reaches the wire.
        assert!(!system.contains("stale context"), "got {system:?}");

        let mut offered: Vec<String> = Vec::new();
        for msg in &out {
            for block in msg["content"].as_array().into_iter().flatten() {
                match block["type"].as_str() {
                    Some("tool_use") => {
                        offered.push(block["id"].as_str().unwrap_or_default().to_string());
                    }
                    Some("tool_result") => {
                        let id = block["tool_use_id"].as_str().unwrap_or_default();
                        assert!(
                            offered.iter().any(|o| o == id),
                            "tool_result {id:?} has no preceding tool_use — this is the 400"
                        );
                    }
                    _ => {}
                }
            }
        }
        // And the reverse: Anthropic rejects a tool_use with no result too.
        let results: Vec<String> = out
            .iter()
            .flat_map(|m| m["content"].as_array().cloned().unwrap_or_default())
            .filter(|b| b["type"] == "tool_result")
            .map(|b| b["tool_use_id"].as_str().unwrap_or_default().to_string())
            .collect();
        assert_eq!(offered, vec!["good".to_string()]);
        assert_eq!(results, vec!["good".to_string()]);
    }
}
