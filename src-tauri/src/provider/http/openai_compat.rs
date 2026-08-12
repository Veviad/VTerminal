//! OpenAI Chat Completions shape — OpenAI, Mistral, and every self-hosted server
//! that speaks it (Ollama, LM Studio, vLLM, llama.cpp's server, LiteLLM).
//!
//! These differ only in base URL, how they spell reasoning depth, and whether
//! they need auth at all — all of which are data, so one module serves them.
//! Anything genuinely structural belongs in its own module (see `anthropic`), not
//! in a growing pile of conditionals here — that is the line to hold when adding
//! a vendor.

use serde_json::{json, Value};

use super::{client, emit, read_sse, send_with_retry};
use crate::models::catalog::{CatalogModel, Effort, ProviderId};
use crate::provider::{
    ChatMessage, ChatParams, FinishReason, Provider, ProviderError, ProviderEvent, Role, ToolCall,
    ToolChoiceMode, ToolDef,
};

pub struct OpenAiCompatProvider {
    pub model: &'static CatalogModel,
    /// Full chat-completions URL. Instance data rather than a `match` on the
    /// provider: the old function had a `_ => ""` arm, so a new `ProviderId`
    /// variant POSTed to the empty string instead of failing to compile.
    pub endpoint: String,
    /// `None` for a keyless server. Ollama and LM Studio need no auth, and
    /// `bearer_auth` used to be sent unconditionally.
    pub api_key: Option<String>,
    /// Convert `<think>…</think>` inside `content` into reasoning events.
    ///
    /// True only for user-configured servers. LM Studio serving a GGUF it has no
    /// reasoning parser for, and llama.cpp's server with `--reasoning-format
    /// none`, put the trace in `content` as raw tags. The vendors never do, and
    /// enabling this for them would silently eat a literal `<think>` out of a
    /// legitimate answer.
    pub split_think_tags: bool,
}

/// The hardcoded URL for a vendor that has one.
///
/// `Option` is the point: `None` forces the caller to decide what to do, which is
/// what the previous `_ => ""` arm quietly skipped.
pub fn vendor_endpoint(provider: ProviderId) -> Option<&'static str> {
    match provider {
        ProviderId::OpenAi => Some("https://api.openai.com/v1/chat/completions"),
        ProviderId::Mistral => Some("https://api.mistral.ai/v1/chat/completions"),
        // Local never reaches this module; Anthropic has its own; a remote
        // server's URL comes from its record, not from a table.
        ProviderId::Local | ProviderId::Anthropic | ProviderId::Remote => None,
    }
}

/// How each vendor spells reasoning depth.
///
/// The ladders genuinely differ: OpenAI has six levels including `none`, while
/// Mistral has exactly two. The catalog's `efforts` list has already clamped the
/// request to something legal for this model, so these mappings only have to
/// name it.
fn apply_reasoning(body: &mut Value, model: &CatalogModel, effort: Effort) {
    // No declared rungs means the field is not merely unused but *rejected*
    // (Mistral Large 3: `400 reasoning_effort is not enabled for this model`).
    // Sending `none` would fail exactly like sending `high`.
    if model.efforts.is_empty() {
        return;
    }
    match model.provider {
        ProviderId::OpenAi => {
            // GPT-5.6 accepts none|low|medium|high|xhigh|max — one rung more
            // than our ladder. `xhigh` is the one left unreached, so that
            // "High" costs what its label implies; `Max` still reaches the top.
            body["reasoning_effort"] = json!(match effort {
                Effort::Off => "none",
                Effort::Low => "low",
                Effort::Medium => "medium",
                Effort::High => "high",
                Effort::Max => "max",
            });
        }
        ProviderId::Mistral => {
            // Mistral accepts exactly two values and 400s on the rest —
            // `reasoning_effort='low' is not supported for this model. Must be
            // one of (none, high)`. That is the whole lineup, reasoning model
            // included, so this collapses rather than maps: an illegal value
            // must be unreachable even if the catalog drifts.
            //
            // `none` is sent explicitly rather than omitted: on a dedicated
            // reasoning model like Magistral, leaving the field out asks for
            // its default, which is to reason.
            body["reasoning_effort"] = json!(if effort == Effort::Off {
                "none"
            } else {
                "high"
            });
        }
        // Spelled out rather than left to `_`: a catch-all is exactly how a new
        // variant goes quiet. Local never reaches this module, Anthropic has its
        // own, and a remote server declares no rungs (so the guard above already
        // returned) because no self-hosted product accepts this field reliably.
        ProviderId::Local | ProviderId::Anthropic | ProviderId::Remote => {}
    }
}

/// Byte offset such that at least `keep` *characters* remain after it. Slicing on
/// a raw byte count would split a multibyte character.
fn hold_back(s: &str, keep: usize) -> usize {
    match s.char_indices().nth_back(keep.saturating_sub(1)) {
        Some((idx, _)) if keep > 0 => idx,
        _ if keep == 0 => s.len(),
        _ => 0,
    }
}

/// Pulls `<think>…</think>` out of a text stream and re-emits it as reasoning.
///
/// Needed because a self-hosted server may put the trace in `content` rather than
/// in `reasoning_content`. Splitting here, in the provider, rather than in the
/// consumer is deliberate: `agent::run` has no filter at all, so raw tags would
/// render literally AND be persisted into the transcript, the archive, and the
/// next turn's replay. `commands::ai`'s `ThinkFilter` covers only the one-shot
/// chats, and it discards the trace instead of showing it.
///
/// `provider::local`'s `OutputSplitter` solves the same problem for GGUFs; the
/// three behaviours copied from it are the hold-back on char boundaries, the
/// swallowed stray close marker, and flushing a mid-thought stream as reasoning.
/// It is not shared code because that module is behind `--features local-llm`.
#[derive(Default)]
struct ThinkSplitter {
    buf: String,
    thinking: bool,
}

const THINK_OPEN: &str = "<think>";
const THINK_CLOSE: &str = "</think>";

impl ThinkSplitter {
    /// Feed one text delta; returns the events it completes.
    fn push(&mut self, piece: &str) -> Vec<ProviderEvent> {
        self.buf.push_str(piece);
        // A tag can straddle two SSE frames, so keep back enough to recognize the
        // longest one once its tail arrives.
        let hold = THINK_CLOSE.len() - 1;
        let mut out = Vec::new();
        loop {
            if self.thinking {
                let Some(at) = self.buf.find(THINK_CLOSE) else {
                    let cut = hold_back(&self.buf, hold);
                    if cut > 0 {
                        out.push(ProviderEvent::ReasoningDelta(self.buf[..cut].to_string()));
                        self.buf.drain(..cut);
                    }
                    return out;
                };
                if at > 0 {
                    out.push(ProviderEvent::ReasoningDelta(self.buf[..at].to_string()));
                }
                self.buf.drain(..at + THINK_CLOSE.len());
                self.thinking = false;
            } else {
                // The close marker is in the running too: a stray one is a control
                // token, never content, so it is swallowed rather than shown. That
                // is what a server stripping the opening tag looks like.
                let open = self.buf.find(THINK_OPEN).map(|at| (at, THINK_OPEN, true));
                let close = self.buf.find(THINK_CLOSE).map(|at| (at, THINK_CLOSE, false));
                let Some((at, tag, opens)) = [open, close]
                    .into_iter()
                    .flatten()
                    .min_by_key(|(at, _, _)| *at)
                else {
                    let cut = hold_back(&self.buf, hold);
                    if cut > 0 {
                        out.push(ProviderEvent::TextDelta(self.buf[..cut].to_string()));
                        self.buf.drain(..cut);
                    }
                    return out;
                };
                if at > 0 {
                    out.push(ProviderEvent::TextDelta(self.buf[..at].to_string()));
                }
                self.buf.drain(..at + tag.len());
                self.thinking = opens;
            }
        }
    }

    /// Flush what is left once the stream ends.
    fn finish(&mut self) -> Vec<ProviderEvent> {
        if self.buf.is_empty() {
            return Vec::new();
        }
        let rest = std::mem::take(&mut self.buf);
        vec![if self.thinking {
            // Never as text: an unterminated trace is still a trace.
            ProviderEvent::ReasoningDelta(rest)
        } else {
            ProviderEvent::TextDelta(rest)
        }]
    }
}

/// Emit one `delta.content`, which is **not always a string**.
///
/// Magistral streams its reasoning inside `content` as typed chunks rather than
/// in a `reasoning_content` field: the thinking phase sends
/// `[{"type":"thinking","thinking":[{"type":"text","text":…}]}]`, then one
/// transition chunk carrying the closing ThinkChunk *and* the first TextChunk,
/// and only then does `content` settle down to a plain string. Reading it as a
/// string alone silently dropped the whole reasoning trace — no thinking box —
/// and took the first slice of the answer with it.
fn push_content(content: &Value, out: &mut Vec<ProviderEvent>) {
    match content {
        Value::String(s) if !s.is_empty() => out.push(ProviderEvent::TextDelta(s.clone())),
        Value::Array(chunks) => {
            for chunk in chunks {
                match chunk["type"].as_str() {
                    // `thinking` is itself a list of text chunks.
                    Some("thinking") => {
                        let text: String = chunk["thinking"]
                            .as_array()
                            .map(|parts| {
                                parts
                                    .iter()
                                    .filter_map(|p| p["text"].as_str())
                                    .collect::<String>()
                            })
                            .unwrap_or_default();
                        if !text.is_empty() {
                            out.push(ProviderEvent::ReasoningDelta(text));
                        }
                    }
                    Some("text") => {
                        if let Some(t) = chunk["text"].as_str().filter(|t| !t.is_empty()) {
                            out.push(ProviderEvent::TextDelta(t.to_string()));
                        }
                    }
                    _ => {}
                }
            }
        }
        _ => {}
    }
}

fn build_messages(messages: Vec<ChatMessage>) -> Vec<Value> {
    messages
        .into_iter()
        .map(|msg| match msg.role {
            Role::System => json!({"role": "system", "content": msg.content}),
            // Text FIRST here, images first on Anthropic — each matches its
            // vendor's own documented example. The asymmetry is deliberate.
            Role::User => match msg.images.filter(|v| !v.is_empty()) {
                // The overwhelmingly common case stays a bare string, byte for
                // byte what every request sent before images existed. Emitting a
                // one-element parts array here instead would change every
                // request in the app to prove a feature almost nobody used.
                None => json!({"role": "user", "content": msg.content}),
                Some(images) => {
                    let mut parts = vec![json!({"type": "text", "text": msg.content})];
                    for img in images {
                        parts.push(json!({
                            "type": "image_url",
                            "image_url": {
                                "url": format!("data:{};base64,{}", img.media_type, img.data),
                            },
                        }));
                    }
                    json!({"role": "user", "content": parts})
                }
            },
            Role::Tool => json!({
                "role": "tool",
                "tool_call_id": msg.tool_call_id.unwrap_or_default(),
                "content": msg.content,
            }),
            Role::Assistant => {
                let mut m = json!({"role": "assistant", "content": msg.content});
                if let Some(calls) = msg.tool_calls.filter(|c| !c.is_empty()) {
                    m["tool_calls"] = json!(calls
                        .iter()
                        .map(|c| json!({
                            "id": c.id,
                            "type": "function",
                            "function": {"name": c.name, "arguments": c.arguments},
                        }))
                        .collect::<Vec<_>>());
                }
                m
            }
        })
        .collect()
}

#[async_trait::async_trait]
impl Provider for OpenAiCompatProvider {
    fn id(&self) -> &'static str {
        self.model.provider.as_str()
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

        let mut body = json!({
            "model": self.model.wire_model,
            "messages": build_messages(messages),
            "stream": true,
            // Without this the final chunk carries no usage numbers.
            "stream_options": {"include_usage": true},
        });
        if let Some(max) = params.max_tokens {
            body["max_tokens"] = json!(max);
        }
        // The GPT-5.6 reasoning models reject temperature; the catalog says who.
        if let (true, Some(t)) = (self.model.supports_temperature, params.temperature) {
            body["temperature"] = json!(t.clamp(0.0, 2.0));
        }
        apply_reasoning(&mut body, self.model, effort);

        if !tools.is_empty() {
            body["tools"] = json!(tools
                .iter()
                .map(|t| json!({
                    "type": "function",
                    "function": {
                        "name": t.name,
                        "description": t.description,
                        "parameters": t.parameters,
                    },
                }))
                .collect::<Vec<_>>());
            body["tool_choice"] = json!(match params.tool_choice {
                ToolChoiceMode::Auto => "auto",
                ToolChoiceMode::None => "none",
            });
        }

        let resp = send_with_retry(
            || {
                let mut req = client()
                    .expect("client built once")
                    .post(&self.endpoint)
                    .json(&body);
                // A keyless self-hosted server gets no header at all — sending
                // `Authorization: Bearer ` is not the same as sending nothing.
                if let Some(key) = self.api_key.as_deref().filter(|k| !k.trim().is_empty()) {
                    req = req.bearer_auth(key);
                }
                req
            },
            &mut cancel,
        )
        .await?;

        // Tool call arguments arrive as partial JSON keyed by index.
        let mut pending: std::collections::BTreeMap<u64, (String, String, String)> =
            Default::default();
        let mut prompt_tokens = 0u32;
        let mut completion_tokens = 0u32;
        let mut finish = FinishReason::Stop;
        let mut splitter = self.split_think_tags.then(ThinkSplitter::default);

        let cancelled = read_sse(resp, &mut cancel, &tx, |data, out| {
            let v: Value = match serde_json::from_str(data) {
                Ok(v) => v,
                Err(_) => return Ok(false),
            };
            if let Some(err) = v.pointer("/error/message").and_then(Value::as_str) {
                return Err(ProviderError::Http(err.to_string()));
            }
            if let Some(u) = v.get("usage").filter(|u| !u.is_null()) {
                prompt_tokens = u["prompt_tokens"].as_u64().unwrap_or(0) as u32;
                completion_tokens = u["completion_tokens"].as_u64().unwrap_or(0) as u32;
            }
            let Some(choice) = v.pointer("/choices/0") else {
                return Ok(false);
            };
            let delta = &choice["delta"];

            // Vendors disagree on the key; accept either.
            for key in ["reasoning_content", "reasoning"] {
                if let Some(r) = delta[key].as_str().filter(|r| !r.is_empty()) {
                    out.push(ProviderEvent::ReasoningDelta(r.to_string()));
                }
            }
            match &mut splitter {
                // Text may carry raw `<think>` tags; typed reasoning chunks never
                // do, so they pass straight through.
                Some(s) => {
                    let mut content = Vec::new();
                    push_content(&delta["content"], &mut content);
                    for event in content {
                        match event {
                            ProviderEvent::TextDelta(t) => out.extend(s.push(&t)),
                            other => out.push(other),
                        }
                    }
                }
                None => push_content(&delta["content"], out),
            }
            if let Some(calls) = delta["tool_calls"].as_array() {
                for call in calls {
                    let idx = call["index"].as_u64().unwrap_or(0);
                    let entry = pending.entry(idx).or_default();
                    if let Some(id) = call["id"].as_str().filter(|s| !s.is_empty()) {
                        entry.0 = id.to_string();
                    }
                    if let Some(name) = call.pointer("/function/name").and_then(Value::as_str) {
                        if !name.is_empty() {
                            entry.1 = name.to_string();
                        }
                    }
                    if let Some(args) = call.pointer("/function/arguments").and_then(Value::as_str) {
                        entry.2.push_str(args);
                    }
                }
            }
            match choice["finish_reason"].as_str() {
                Some("tool_calls") => finish = FinishReason::ToolCalls,
                Some("length") => finish = FinishReason::Length,
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

        // Before the tool calls, so the held-back tail keeps its place in the
        // stream the user sees.
        if let Some(s) = &mut splitter {
            for event in s.finish() {
                emit(&tx, event).await?;
            }
        }

        if !pending.is_empty() {
            finish = FinishReason::ToolCalls;
            let calls: Vec<ToolCall> = pending
                .into_values()
                .filter(|(_, name, _)| !name.is_empty())
                .enumerate()
                .map(|(i, (id, name, arguments))| ToolCall {
                    // Some vendors omit the id on streamed calls.
                    id: if id.is_empty() {
                        format!("call_{i}")
                    } else {
                        id
                    },
                    name,
                    arguments: if arguments.trim().is_empty() {
                        "{}".to_string()
                    } else {
                        arguments
                    },
                })
                .collect();
            if !calls.is_empty() {
                emit(&tx, ProviderEvent::ToolCalls(calls)).await?;
            }
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

    fn effort_body(id: &str, effort: Effort) -> Value {
        let model = catalog::find(id).unwrap();
        let mut body = json!({});
        apply_reasoning(&mut body, model, model.clamp_effort(effort));
        body
    }

    #[test]
    fn a_steer_after_a_tool_result_stays_its_own_message() {
        // The OpenAI wire wants `tool` then `user` as separate messages — the
        // opposite of Anthropic's fold. This is the shape the agent loop emits
        // when a steering message lands at a round boundary.
        let msgs = build_messages(vec![
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

        assert_eq!(msgs.len(), 3);
        assert_eq!(msgs[0]["role"], "assistant");
        assert_eq!(msgs[1]["role"], "tool");
        assert_eq!(msgs[1]["tool_call_id"], "t1");
        // The tool result answers the call immediately; the steer follows it.
        assert_eq!(msgs[2]["role"], "user");
        assert_eq!(msgs[2]["content"], "actually, check the logs first");
    }

    /// The regression this guards is invisible: emitting a one-element parts
    /// array for every user turn would change EVERY request the app has ever
    /// sent, to serve a feature most turns do not use.
    #[test]
    fn a_user_turn_without_images_is_still_a_bare_string() {
        let msgs = build_messages(vec![ChatMessage::user("what is my cwd")]);
        assert_eq!(msgs[0]["content"], "what is my cwd");
        assert!(msgs[0]["content"].is_string());
    }

    #[test]
    fn images_become_data_uri_parts_after_the_text() {
        let msgs = build_messages(vec![ChatMessage::user_with_images(
            "what is this",
            vec![
                crate::provider::ImagePart { media_type: "image/png".into(), data: "AAAA".into() },
                crate::provider::ImagePart { media_type: "image/jpeg".into(), data: "BBBB".into() },
            ],
        )]);

        let parts = msgs[0]["content"].as_array().expect("parts array");
        assert_eq!(parts.len(), 3);
        // Text first here — the opposite of anthropic.rs, matching each vendor's
        // own documented example.
        assert_eq!(parts[0]["type"], "text");
        assert_eq!(parts[0]["text"], "what is this");
        assert_eq!(parts[1]["type"], "image_url");
        assert_eq!(parts[1]["image_url"]["url"], "data:image/png;base64,AAAA");
        assert_eq!(parts[2]["image_url"]["url"], "data:image/jpeg;base64,BBBB");
    }

    /// `user_with_images` normalizes empty to `None`, so the bare-string path is
    /// what an empty attachment list takes.
    #[test]
    fn an_empty_image_list_takes_the_bare_string_path() {
        let msgs = build_messages(vec![ChatMessage::user_with_images("hi", vec![])]);
        assert!(msgs[0]["content"].is_string());
    }

    /// (reasoning, text) collected from one `delta.content` value.
    fn split(content: Value) -> (String, String) {
        let mut out = Vec::new();
        push_content(&content, &mut out);
        out.iter().fold((String::new(), String::new()), |(r, t), e| match e {
            ProviderEvent::ReasoningDelta(s) => (r + s, t),
            ProviderEvent::TextDelta(s) => (r, t + s),
            _ => (r, t),
        })
    }

    #[test]
    fn magistral_thinking_chunks_become_reasoning_not_nothing() {
        // The thinking phase: content is a list, not a string. Read as a string
        // this vanished entirely, which is why Magistral showed no thinking box.
        let (reasoning, text) = split(json!([{
            "type": "thinking",
            "thinking": [{"type": "text", "text": "weigh "}, {"type": "text", "text": "it"}]
        }]));
        assert_eq!(reasoning, "weigh it");
        assert_eq!(text, "");
    }

    #[test]
    fn the_transition_chunk_keeps_both_halves() {
        // One chunk closes the thought and opens the answer. Dropping it lost
        // the first slice of the reply, not just the reasoning.
        let (reasoning, text) = split(json!([
            {"type": "thinking", "thinking": [{"type": "text", "text": "done"}]},
            {"type": "text", "text": "The answer"}
        ]));
        assert_eq!(reasoning, "done");
        assert_eq!(text, "The answer");
    }

    #[test]
    fn a_plain_string_still_streams_as_text() {
        // Every other model on this wire shape, and Magistral's answer phase.
        let (reasoning, text) = split(json!("hello"));
        assert_eq!(reasoning, "");
        assert_eq!(text, "hello");
        assert_eq!(split(json!(null)), (String::new(), String::new()));
        assert_eq!(split(json!("")), (String::new(), String::new()));
    }

    #[test]
    fn openai_rungs_keep_their_own_names() {
        // "High" must not silently buy `xhigh`, which is a different price and
        // a different behaviour than the label promises.
        assert_eq!(
            effort_body("openai/gpt-5.6-sol", Effort::High)["reasoning_effort"],
            "high"
        );
        assert_eq!(
            effort_body("openai/gpt-5.6-sol", Effort::Max)["reasoning_effort"],
            "max"
        );
        assert_eq!(
            effort_body("openai/gpt-5.6-luna", Effort::Off)["reasoning_effort"],
            "none"
        );
    }

    #[test]
    fn mistral_only_ever_sends_none_or_high() {
        // Mistral 400s on anything else, so no rung may map elsewhere — not
        // even one the catalog should have clamped away first.
        for effort in [Effort::Off, Effort::Low, Effort::Medium, Effort::High, Effort::Max] {
            for id in [
                "mistral/mistral-small-latest",
                "mistral/magistral-medium-latest",
            ] {
                let got = effort_body(id, effort)["reasoning_effort"].clone();
                assert!(
                    got == "none" || got == "high",
                    "{id} at {effort:?} sent {got}, which Mistral rejects"
                );
            }
        }
        assert_eq!(
            effort_body("mistral/mistral-small-latest", Effort::Off)["reasoning_effort"],
            "none"
        );
    }

    #[test]
    fn a_model_with_no_rungs_omits_the_field_entirely() {
        // Mistral Large 3 rejects `reasoning_effort` outright, so even `none`
        // is a 400 — the key must be absent, not falsy.
        for effort in [Effort::Off, Effort::Medium, Effort::Max] {
            assert!(
                effort_body("mistral/mistral-large-latest", effort)
                    .get("reasoning_effort")
                    .is_none(),
                "sent reasoning_effort to a model that rejects the field"
            );
        }
    }

    #[test]
    fn every_mistral_rung_offered_is_one_mistral_accepts() {
        // The picker renders exactly `efforts`, so a rung listed here is a rung
        // the user can pick — and every Mistral rung but Off/High is a 400.
        for m in crate::models::catalog::CATALOG
            .iter()
            .filter(|m| m.provider == ProviderId::Mistral)
        {
            for e in m.efforts {
                assert!(
                    matches!(e, Effort::Off | Effort::High),
                    "{} offers {e:?}, which Mistral rejects",
                    m.id
                );
            }
        }
    }

    #[test]
    fn each_vendor_has_its_own_endpoint() {
        assert!(vendor_endpoint(ProviderId::OpenAi)
            .unwrap()
            .contains("api.openai.com"));
        assert!(vendor_endpoint(ProviderId::Mistral)
            .unwrap()
            .contains("api.mistral.ai"));
        // No table entry means the caller must supply one. Returning `""` here is
        // how a new provider used to POST into the void.
        assert_eq!(vendor_endpoint(ProviderId::Remote), None);
        assert_eq!(vendor_endpoint(ProviderId::Local), None);
        assert_eq!(vendor_endpoint(ProviderId::Anthropic), None);
    }

    /// Drain a ThinkSplitter over pre-chunked input, returning (text, reasoning).
    fn drain_splitter(chunks: &[&str]) -> (String, String) {
        let mut s = ThinkSplitter::default();
        let mut text = String::new();
        let mut think = String::new();
        let mut collect = |events: Vec<ProviderEvent>| {
            for event in events {
                match event {
                    ProviderEvent::TextDelta(t) => text.push_str(&t),
                    ProviderEvent::ReasoningDelta(t) => think.push_str(&t),
                    _ => {}
                }
            }
        };
        for chunk in chunks {
            collect(s.push(chunk));
        }
        collect(s.finish());
        (text, think)
    }

    #[test]
    fn think_tags_in_content_become_reasoning() {
        let (text, think) = drain_splitter(&["<think>weighing it up</think>", "the answer"]);
        assert_eq!(text, "the answer");
        assert_eq!(think, "weighing it up");
    }

    #[test]
    fn a_tag_split_across_frames_is_still_recognized() {
        // The reason for holding bytes back at all: SSE frame boundaries fall
        // wherever the server flushes, including mid-tag.
        let (text, think) = drain_splitter(&["<thi", "nk>hmm</thi", "nk>done"]);
        assert_eq!(text, "done");
        assert_eq!(think, "hmm");
    }

    #[test]
    fn a_multibyte_character_is_never_split() {
        // hold_back counts characters, not bytes; a byte count would slice one of
        // these in half and produce invalid UTF-8 in the middle of the answer.
        let (text, think) = drain_splitter(&["<think>日本語で考える</think>", "答えは「４２」です"]);
        assert_eq!(text, "答えは「４２」です");
        assert_eq!(think, "日本語で考える");
    }

    #[test]
    fn a_stray_close_tag_is_swallowed_not_shown() {
        // What a server that strips the opening tag looks like. The close marker
        // is a control token either way, never content.
        let (text, think) = drain_splitter(&["reasoned already</think>the answer"]);
        assert_eq!(text, "reasoned alreadythe answer");
        assert!(think.is_empty());
    }

    #[test]
    fn a_stream_ending_mid_thought_flushes_as_reasoning() {
        // Truncated by max_tokens or a dropped connection. Delivering the trace as
        // the answer is the failure this prevents.
        let (text, think) = drain_splitter(&["<think>still going"]);
        assert!(text.is_empty());
        assert_eq!(think, "still going");
    }

    #[test]
    fn plain_text_passes_through_untouched() {
        let (text, think) = drain_splitter(&["no tags ", "at all"]);
        assert_eq!(text, "no tags at all");
        assert!(think.is_empty());
    }

    /// A keyless remote model, built the way `resolve_remote` builds one.
    fn remote_model() -> &'static crate::models::catalog::CatalogModel {
        use crate::models::remote::{RemoteModel, RemoteServer, ServerKind};
        let server = RemoteServer {
            id: "srv-1".into(),
            kind: ServerKind::Ollama,
            label: "Workstation".into(),
            base_url: "http://127.0.0.1:11434".into(),
            models: vec![RemoteModel {
                wire_model: "qwen3:8b".into(),
                label: "Qwen3 8B".into(),
                context_tokens: 32_768,
                supports_vision: false,
                supports_tools: true,
            }],
        };
        crate::models::remote::find_in(std::slice::from_ref(&server), "remote/srv-1/qwen3:8b")
            .unwrap()
    }

    /// One SSE response on a real socket. Returns the base URL and the request the
    /// provider actually sent, so the header and body claims are observed rather
    /// than inferred.
    async fn fake_chat_server(
        sse: &'static str,
    ) -> (String, std::sync::Arc<std::sync::Mutex<Option<String>>>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let seen = std::sync::Arc::new(std::sync::Mutex::new(None));
        let log = seen.clone();
        tokio::spawn(async move {
            let Ok((mut sock, _)) = listener.accept().await else {
                return;
            };
            let mut buf = vec![0u8; 8192];
            let n = sock.read(&mut buf).await.unwrap_or(0);
            *log.lock().unwrap() = Some(String::from_utf8_lossy(&buf[..n]).to_string());
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\
                 Content-Length: {}\r\nConnection: close\r\n\r\n{sse}",
                sse.len()
            );
            let _ = sock.write_all(response.as_bytes()).await;
            let _ = sock.shutdown().await;
        });
        (base, seen)
    }

    /// End-to-end over a socket: a self-hosted server that needs no auth, answers
    /// with raw `<think>` tags straddling two SSE frames, and is asked for no
    /// reasoning parameter. Every one of those is a claim the unit tests above can
    /// only make about a part.
    #[tokio::test]
    async fn a_remote_model_streams_keyless_and_splits_its_reasoning() {
        let (base, seen) = fake_chat_server(concat!(
            "data: {\"choices\":[{\"delta\":{\"content\":\"<thi\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"nk>weighing it up</think>the answer\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}],\
              \"usage\":{\"prompt_tokens\":7,\"completion_tokens\":11}}\n\n",
            "data: [DONE]\n\n",
        ))
        .await;

        let provider = OpenAiCompatProvider {
            model: remote_model(),
            endpoint: format!("{base}/v1/chat/completions"),
            api_key: None,
            split_think_tags: true,
        };
        let (_cancel_tx, cancel) = tokio::sync::watch::channel(false);
        let (tx, mut rx) = tokio::sync::mpsc::channel(64);
        provider
            .chat_stream(
                vec![ChatMessage::user("what is my cwd")],
                Vec::new(),
                ChatParams {
                    temperature: Some(0.7),
                    max_tokens: None,
                    tool_choice: ToolChoiceMode::None,
                    web_access: false,
                    effort: Effort::High,
                },
                cancel,
                tx,
            )
            .await
            .unwrap();

        let (mut text, mut think, mut usage) = (String::new(), String::new(), (0, 0));
        while let Some(event) = rx.recv().await {
            match event {
                ProviderEvent::TextDelta(t) => text.push_str(&t),
                ProviderEvent::ReasoningDelta(t) => think.push_str(&t),
                ProviderEvent::Usage {
                    prompt_tokens,
                    completion_tokens,
                } => usage = (prompt_tokens, completion_tokens),
                _ => {}
            }
        }
        assert_eq!(text, "the answer");
        assert_eq!(think, "weighing it up", "a tag split across frames still splits");
        assert_eq!(usage, (7, 11));

        let request = seen.lock().unwrap().clone().expect("the server saw nothing");
        assert!(request.starts_with("POST /v1/chat/completions"), "{request}");
        assert!(
            !request.contains("Authorization"),
            "a keyless server must get no header at all: {request}"
        );
        // Declaring no rungs means the field is omitted, not sent as "none" —
        // an effort value a server does not accept is a 400, not a downgrade.
        assert!(!request.contains("reasoning_effort"), "{request}");
        // The wire model is the one the server knows, not the app's id.
        assert!(request.contains("\"model\":\"qwen3:8b\""), "{request}");
    }

    /// The regression that matters most. Enabling the splitter for every provider
    /// would silently eat a literal `<think>` out of a legitimate answer — an
    /// answer *about* this feature, for instance.
    #[test]
    fn the_vendors_never_split_think_tags() {
        let vendor = OpenAiCompatProvider {
            model: catalog::find("openai/gpt-5.6-terra").unwrap(),
            endpoint: vendor_endpoint(ProviderId::OpenAi).unwrap().to_string(),
            api_key: Some("sk-test".into()),
            split_think_tags: false,
        };
        assert!(!vendor.split_think_tags);
        // The flag is what gates it; with the flag off, `content` is emitted
        // verbatim by `push_content`.
        let mut out = Vec::new();
        push_content(&json!("use <think> to open a span"), &mut out);
        match out.as_slice() {
            [ProviderEvent::TextDelta(t)] => assert_eq!(t, "use <think> to open a span"),
            other => panic!("expected one verbatim text delta, got {other:?}"),
        }
    }

    #[test]
    fn tool_results_carry_their_call_id() {
        let out = build_messages(vec![ChatMessage {
            role: Role::Tool,
            content: "ok".into(),
            tool_call_id: Some("call_1".into()),
            images: None,
            tool_calls: None,
        }]);
        assert_eq!(out[0]["role"], "tool");
        assert_eq!(out[0]["tool_call_id"], "call_1");
    }
}
