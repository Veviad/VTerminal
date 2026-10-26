//! OpenAI Responses API, including stateless replay of encrypted reasoning.
//!
//! The canonical transcript remains portable between providers. OpenAI's ordered
//! output items ride beside an assistant message so the next tool round can
//! replay reasoning and preserve assistant phases without storing a response on
//! the provider's servers.

use serde::Deserialize;
use serde_json::{json, Value};

use super::{client, emit, read_sse, send_with_retry};
use crate::models::catalog::{CatalogModel, Effort};
use crate::provider::tool_summary::ToolSummaryStream;
use crate::provider::{
    ChatMessage, ChatParams, FinishReason, Provider, ProviderError, ProviderEvent, ProviderState,
    Role, ToolCall, ToolChoiceMode, ToolDef, ALLOWED_IMAGE_TYPES,
};

const API_URL: &str = "https://api.openai.com/v1/responses";

pub struct OpenAiResponsesProvider {
    pub model: &'static CatalogModel,
    pub api_key: crate::credentials::Secret,
}

fn wire_effort(effort: Effort) -> &'static str {
    match effort {
        Effort::Off => "none",
        Effort::Low => "low",
        Effort::Medium => "medium",
        Effort::High => "high",
        Effort::Max => "max",
    }
}

fn malformed(detail: &str) -> ProviderError {
    ProviderError::Http(format!("invalid OpenAI Responses stream: {detail}"))
}

fn item_text(item: &Value) -> Result<String, ProviderError> {
    if item["role"] != "assistant" {
        return Err(malformed("output message is not from the assistant"));
    }
    let parts = item["content"]
        .as_array()
        .ok_or_else(|| malformed("output message has no content array"))?;
    let mut text = String::new();
    for part in parts {
        let field = match part["type"].as_str() {
            Some("output_text") => "text",
            Some("refusal") => "refusal",
            _ => return Err(malformed("unsupported assistant content type")),
        };
        text.push_str(
            part[field]
                .as_str()
                .ok_or_else(|| malformed("assistant content is not text"))?,
        );
    }
    Ok(text)
}

fn item_call(item: &Value) -> Result<ToolCall, ProviderError> {
    if matches!(item["status"].as_str(), Some("in_progress" | "incomplete")) {
        return Err(malformed("function call is incomplete"));
    }
    let field = |key: &str| {
        item[key]
            .as_str()
            .filter(|value| !value.trim().is_empty())
            .map(String::from)
            .ok_or_else(|| malformed("function call is missing its id, name, or arguments"))
    };
    let call = ToolCall {
        // The output item id (fc_...) is NOT the call id (call_...). Tool
        // results must refer to call_id or the next request fails.
        id: field("call_id")?,
        name: field("name")?,
        arguments: field("arguments")?,
    };
    if !serde_json::from_str::<Value>(&call.arguments).is_ok_and(|value| value.is_object()) {
        return Err(malformed(
            "function arguments are not a complete JSON object",
        ));
    }
    Ok(call)
}

/// Opaque state is usable only if it still describes the canonical assistant
/// message. Normalization may have pruned calls, or a transcript may have been
/// edited or produced by a different model. Falling back to its portable shape
/// prevents stale raw items from restoring content that the caller removed.
fn replay_output<'a>(message: &'a ChatMessage, model: &CatalogModel) -> Option<&'a [Value]> {
    let Some(ProviderState::OpenAiResponses {
        model: saved_model,
        output,
        ..
    }) = &message.provider_state
    else {
        return None;
    };
    if saved_model != model.wire_model || output.is_empty() {
        return None;
    }
    let mut text = String::new();
    let mut calls = Vec::new();
    for item in output {
        match item["type"].as_str() {
            Some("reasoning") => {
                if item["encrypted_content"]
                    .as_str()
                    .is_none_or(|content| content.is_empty())
                {
                    return None;
                }
            }
            Some("message") => text.push_str(&item_text(item).ok()?),
            Some("function_call") => calls.push(item_call(item).ok()?),
            _ => return None,
        }
    }
    let canonical = message.tool_calls.as_deref().unwrap_or_default();
    if text != message.content
        || calls.len() != canonical.len()
        || calls.iter().zip(canonical).any(|(raw, saved)| {
            raw.id != saved.id || raw.name != saved.name || raw.arguments != saved.arguments
        })
    {
        return None;
    }
    Some(output)
}

/// Match the official SDK's response-input normalization: provenance is output
/// metadata, while assistant phase and encrypted reasoning must survive replay.
fn replay_input_item(output: &Value) -> Value {
    let mut input = output.clone();
    if let Some(fields) = input.as_object_mut() {
        fields.remove("created_by");
        fields.remove("parsed_arguments");
    }
    if input["type"] == "message" {
        if let Some(parts) = input["content"].as_array_mut() {
            for part in parts {
                if let Some(fields) = part.as_object_mut() {
                    fields.remove("parsed");
                }
            }
        }
    }
    input
}

fn build_body(
    model: &CatalogModel,
    messages: Vec<ChatMessage>,
    tools: Vec<ToolDef>,
    params: &ChatParams,
) -> Result<Value, ProviderError> {
    let mut instructions = Vec::new();
    let mut input = Vec::new();
    for message in messages {
        match message.role {
            Role::System => instructions.push(message.content),
            Role::User => {
                let mut content = vec![json!({"type": "input_text", "text": message.content})];
                for image in message.images.into_iter().flatten() {
                    if !model.supports_vision
                        || !ALLOWED_IMAGE_TYPES.contains(&image.media_type.as_str())
                    {
                        return Err(ProviderError::Inference(
                            "this image cannot be sent to the selected OpenAI model".into(),
                        ));
                    }
                    content.push(json!({
                        "type": "input_image",
                        "image_url": format!("data:{};base64,{}", image.media_type, image.data),
                    }));
                }
                input.push(json!({"role": "user", "content": content}));
            }
            Role::Assistant => {
                if let Some(output) = replay_output(&message, model) {
                    input.extend(output.iter().map(replay_input_item));
                    continue;
                }
                if !message.content.is_empty() {
                    input.push(json!({"role": "assistant", "content": message.content}));
                }
                for call in message.tool_calls.into_iter().flatten() {
                    input.push(json!({
                        "type": "function_call",
                        "call_id": call.id,
                        "name": call.name,
                        "arguments": call.arguments,
                    }));
                }
            }
            Role::Tool => {
                let call_id = message
                    .tool_call_id
                    .filter(|id| !id.is_empty())
                    .ok_or_else(|| malformed("tool result has no call id"))?;
                input.push(json!({
                    "type": "function_call_output",
                    "call_id": call_id,
                    "output": message.content,
                }));
            }
        }
    }
    let mut body = json!({
        "model": model.wire_model,
        "input": input,
        "stream": true,
        "store": false,
        "include": ["reasoning.encrypted_content"],
        "reasoning": {
            "effort": wire_effort(model.clamp_effort(params.effort)),
            "summary": "auto",
        },
    });
    if !instructions.is_empty() {
        body["instructions"] = json!(instructions.join("\n\n"));
    }
    if let Some(max_tokens) = params.max_tokens {
        body["max_output_tokens"] = json!(max_tokens);
    }
    if let (true, Some(temperature)) = (model.supports_temperature, params.temperature) {
        body["temperature"] = json!(temperature.clamp(0.0, 2.0));
    }
    if !tools.is_empty() {
        body["tools"] = json!(tools
            .into_iter()
            .map(|tool| json!({
                "type": "function",
                "name": tool.name,
                "description": tool.description,
                "parameters": tool.parameters,
                // Responses otherwise normalizes function schemas to strict
                // mode, where all properties must be required. Existing app
                // and MCP tools deliberately have optional parameters.
                "strict": false,
            }))
            .collect::<Vec<_>>());
        body["tool_choice"] = json!(match params.tool_choice {
            ToolChoiceMode::Auto => "auto",
            ToolChoiceMode::None => "none",
        });
    }
    Ok(body)
}

#[derive(Deserialize)]
#[serde(tag = "type")]
enum ResponseEvent {
    #[serde(rename = "response.output_text.delta")]
    TextDelta { delta: String },
    #[serde(rename = "response.refusal.delta")]
    RefusalDelta { delta: String },
    #[serde(rename = "response.reasoning_summary_text.delta")]
    ReasoningDelta { delta: String },
    #[serde(rename = "response.output_item.added")]
    ItemAdded { output_index: usize, item: Value },
    #[serde(rename = "response.function_call_arguments.delta")]
    ArgumentsDelta {
        output_index: Option<usize>,
        delta: String,
    },
    #[serde(rename = "response.function_call_arguments.done")]
    ArgumentsDone {
        output_index: usize,
        arguments: String,
    },
    #[serde(rename = "response.output_item.done")]
    ItemDone { output_index: usize, item: Value },
    #[serde(rename = "response.completed")]
    Completed { response: Value },
    #[serde(rename = "response.incomplete")]
    Incomplete { response: Value },
    #[serde(rename = "response.failed")]
    Failed { response: Value },
    #[serde(rename = "response.cancelled")]
    Cancelled,
    #[serde(rename = "error")]
    Error {
        message: Option<String>,
        error: Option<Value>,
    },
    #[serde(other)]
    Other,
}

#[derive(Default)]
struct ResponseStream {
    text: String,
    reasoning: String,
    completed_items: std::collections::BTreeMap<usize, Value>,
    pending_calls: std::collections::BTreeMap<usize, Value>,
    summaries: std::collections::BTreeMap<usize, ToolSummaryStream>,
    first_call_index: Option<usize>,
    terminal: bool,
}

fn token_count(value: &Value) -> u32 {
    value.as_u64().unwrap_or_default().min(u32::MAX as u64) as u32
}

impl ResponseStream {
    fn validate_call_prefix(
        pending: Option<&Value>,
        complete: &Value,
    ) -> Result<(), ProviderError> {
        let Some(pending) = pending.filter(|item| item["type"] == "function_call") else {
            return Ok(());
        };
        if complete["type"] != "function_call"
            || complete["call_id"] != pending["call_id"]
            || complete["name"] != pending["name"]
            || !complete["arguments"].as_str().is_some_and(|arguments| {
                arguments.starts_with(pending["arguments"].as_str().unwrap_or_default())
            })
        {
            return Err(malformed(
                "terminal function call disagrees with streamed arguments",
            ));
        }
        Ok(())
    }

    fn stream_summary(
        summaries: &mut std::collections::BTreeMap<usize, ToolSummaryStream>,
        first_call_index: &mut Option<usize>,
        index: usize,
        item: &Value,
        out: &mut Vec<ProviderEvent>,
    ) {
        if item["type"] != "function_call" {
            return;
        }
        if *first_call_index.get_or_insert(index) != index {
            return;
        }
        let Some(call_id) = item["call_id"].as_str() else {
            return;
        };
        let Some(name) = item["name"].as_str() else {
            return;
        };
        let Some(arguments) = item["arguments"].as_str() else {
            return;
        };
        if let Some(event) = summaries
            .entry(index)
            .or_default()
            .push_json(call_id, name, arguments)
        {
            out.push(event);
        }
    }

    fn finish(
        &mut self,
        response: Value,
        incomplete: bool,
        model: &CatalogModel,
        out: &mut Vec<ProviderEvent>,
    ) -> Result<(), ProviderError> {
        if response["status"] == "cancelled" {
            return Err(ProviderError::Cancelled);
        }
        if incomplete
            && response
                .pointer("/incomplete_details/reason")
                .and_then(Value::as_str)
                != Some("max_output_tokens")
        {
            return Err(ProviderError::Inference(
                "OpenAI stopped before completing the response; the request may have been filtered"
                    .into(),
            ));
        }
        let items = response["output"]
            .as_array()
            .ok_or_else(|| malformed("terminal response has no output array"))?;
        let mut output = Vec::new();
        let mut calls = Vec::new();
        let mut text = String::new();
        let mut reasoning = String::new();
        let mut call_ids = std::collections::HashSet::new();
        for (index, final_item) in items.iter().enumerate() {
            // Only a done event guarantees a complete encrypted reasoning
            // item. Prefer it to the early in-progress item snapshots.
            let item = self
                .completed_items
                .get(&index)
                .filter(|done| done["id"] == final_item["id"] && done["type"] == final_item["type"])
                .unwrap_or(final_item);
            match item["type"].as_str() {
                Some("reasoning") => {
                    for summary in item["summary"].as_array().into_iter().flatten() {
                        if let Some(value) = summary["text"].as_str() {
                            reasoning.push_str(value);
                        }
                    }
                    if item["encrypted_content"]
                        .as_str()
                        .is_some_and(|value| !value.is_empty())
                        && (!incomplete || self.completed_items.contains_key(&index))
                    {
                        output.push(item.clone());
                    }
                }
                Some("message") => {
                    text.push_str(&item_text(item)?);
                    output.push(item.clone());
                }
                Some("function_call") if !incomplete => {
                    Self::validate_call_prefix(self.pending_calls.get(&index), item)?;
                    let call = item_call(item)?;
                    if !call_ids.insert(call.id.clone()) {
                        return Err(malformed("duplicate function call id"));
                    }
                    Self::stream_summary(
                        &mut self.summaries,
                        &mut self.first_call_index,
                        index,
                        item,
                        out,
                    );
                    calls.push(call);
                    output.push(item.clone());
                }
                // An incomplete response must never dispatch even an earlier
                // complete call: a parallel group may still be truncated.
                Some("function_call") => {}
                _ => return Err(malformed("unrequested output item type")),
            }
        }
        let tail = text
            .strip_prefix(&self.text)
            .ok_or_else(|| malformed("terminal text disagrees with streamed deltas"))?;
        if !tail.is_empty() {
            out.push(ProviderEvent::TextDelta(tail.into()));
        }
        // Summary deltas normally carry the whole summary. Recover an omitted
        // suffix from the terminal response without showing it twice.
        if let Some(tail) = reasoning
            .strip_prefix(&self.reasoning)
            .filter(|tail| !tail.is_empty())
        {
            out.push(ProviderEvent::ReasoningDelta(tail.into()));
        }
        let usage = &response["usage"];
        if !incomplete {
            out.push(ProviderEvent::ProviderState(
                ProviderState::OpenAiResponses {
                    model: model.wire_model.to_string(),
                    output,
                    reasoning_tokens: token_count(
                        &usage["output_tokens_details"]["reasoning_tokens"],
                    ),
                },
            ));
        }
        out.push(ProviderEvent::Usage {
            prompt_tokens: token_count(&usage["input_tokens"]),
            completion_tokens: token_count(&usage["output_tokens"]),
        });
        let finish_reason = if incomplete {
            FinishReason::Length
        } else if calls.is_empty() {
            FinishReason::Stop
        } else {
            out.push(ProviderEvent::ToolCalls(calls));
            FinishReason::ToolCalls
        };
        out.push(ProviderEvent::Done { finish_reason });
        self.terminal = true;
        Ok(())
    }

    fn event(
        &mut self,
        data: &str,
        model: &CatalogModel,
        secret: &crate::credentials::Secret,
        out: &mut Vec<ProviderEvent>,
    ) -> Result<bool, ProviderError> {
        let event: ResponseEvent = serde_json::from_str(data)
            .map_err(|_| malformed("malformed event JSON or missing event fields"))?;
        match event {
            ResponseEvent::TextDelta { delta } | ResponseEvent::RefusalDelta { delta } => {
                self.text.push_str(&delta);
                if !delta.is_empty() {
                    out.push(ProviderEvent::TextDelta(delta));
                }
            }
            ResponseEvent::ReasoningDelta { delta } => {
                self.reasoning.push_str(&delta);
                if !delta.is_empty() {
                    out.push(ProviderEvent::ReasoningDelta(delta));
                }
            }
            ResponseEvent::ItemAdded { output_index, item } => {
                Self::stream_summary(
                    &mut self.summaries,
                    &mut self.first_call_index,
                    output_index,
                    &item,
                    out,
                );
                if item["type"] == "function_call" {
                    self.pending_calls.insert(output_index, item);
                }
            }
            ResponseEvent::ArgumentsDelta {
                output_index,
                delta,
            } => {
                if let Some(index) = output_index {
                    if let Some(item) = self.pending_calls.get_mut(&index) {
                        if !item["arguments"].is_string() {
                            item["arguments"] = Value::String(String::new());
                        }
                        if let Value::String(arguments) = &mut item["arguments"] {
                            arguments.push_str(&delta);
                        }
                        Self::stream_summary(
                            &mut self.summaries,
                            &mut self.first_call_index,
                            index,
                            item,
                            out,
                        );
                    }
                }
            }
            ResponseEvent::ArgumentsDone {
                output_index,
                arguments,
            } => {
                if let Some(item) = self.pending_calls.get_mut(&output_index) {
                    if !arguments.starts_with(item["arguments"].as_str().unwrap_or_default()) {
                        return Err(malformed(
                            "completed function arguments disagree with streamed deltas",
                        ));
                    }
                    item["arguments"] = Value::String(arguments);
                    Self::stream_summary(
                        &mut self.summaries,
                        &mut self.first_call_index,
                        output_index,
                        item,
                        out,
                    );
                }
            }
            ResponseEvent::ItemDone { output_index, item } => {
                Self::validate_call_prefix(self.pending_calls.get(&output_index), &item)?;
                Self::stream_summary(
                    &mut self.summaries,
                    &mut self.first_call_index,
                    output_index,
                    &item,
                    out,
                );
                self.completed_items.insert(output_index, item);
            }
            ResponseEvent::Completed { response } => self.finish(response, false, model, out)?,
            ResponseEvent::Incomplete { response } => self.finish(response, true, model, out)?,
            ResponseEvent::Failed { response } => {
                return Err(ProviderError::Http(
                    crate::credentials::redact_provider_text(
                        response
                            .pointer("/error/message")
                            .and_then(Value::as_str)
                            .unwrap_or("OpenAI failed to generate a response"),
                        Some(secret),
                    ),
                ));
            }
            ResponseEvent::Cancelled => return Err(ProviderError::Cancelled),
            ResponseEvent::Error { message, error } => {
                let message = message
                    .or_else(|| error.and_then(|error| error["message"].as_str().map(String::from)))
                    .unwrap_or_else(|| "OpenAI returned a stream error".into());
                return Err(ProviderError::Http(
                    crate::credentials::redact_provider_text(&message, Some(secret)),
                ));
            }
            ResponseEvent::Other => {}
        }
        Ok(self.terminal)
    }
}

impl OpenAiResponsesProvider {
    async fn chat_stream_at(
        &self,
        endpoint: &str,
        messages: Vec<ChatMessage>,
        tools: Vec<ToolDef>,
        params: ChatParams,
        mut cancel: tokio::sync::watch::Receiver<bool>,
        tx: tokio::sync::mpsc::Sender<ProviderEvent>,
    ) -> Result<(), ProviderError> {
        let body = build_body(self.model, messages, tools, &params)?;
        let response = send_with_retry(
            || {
                client()
                    .expect("client built once")
                    .post(endpoint)
                    .bearer_auth(self.api_key.expose())
                    .json(&body)
            },
            &mut cancel,
            Some(&self.api_key),
        )
        .await?;
        let mut stream = ResponseStream::default();
        let cancelled = read_sse(response, &mut cancel, &tx, |data, out| {
            stream.event(data, self.model, &self.api_key, out)
        })
        .await;
        if matches!(cancelled, Ok(true) | Err(ProviderError::Cancelled)) {
            let _ = emit(
                &tx,
                ProviderEvent::Done {
                    finish_reason: FinishReason::Cancelled,
                },
            )
            .await;
            return Err(ProviderError::Cancelled);
        }
        cancelled?;
        if !stream.terminal {
            return Err(malformed(
                "connection ended before a terminal response event",
            ));
        }
        Ok(())
    }
}

#[async_trait::async_trait]
impl Provider for OpenAiResponsesProvider {
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
        cancel: tokio::sync::watch::Receiver<bool>,
        tx: tokio::sync::mpsc::Sender<ProviderEvent>,
    ) -> Result<(), ProviderError> {
        self.chat_stream_at(API_URL, messages, tools, params, cancel, tx)
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::catalog;
    use crate::provider::{ImagePart, WebToolPolicy};

    fn model() -> &'static CatalogModel {
        catalog::find("openai/gpt-5.6-terra").unwrap()
    }

    fn params() -> ChatParams {
        ChatParams {
            temperature: Some(0.7),
            max_tokens: Some(4096),
            tool_choice: ToolChoiceMode::Auto,
            web: WebToolPolicy::SearchAndFetch,
            effort: Effort::High,
        }
    }

    fn tool() -> ToolDef {
        ToolDef {
            name: "inspect".into(),
            description: "Inspect an optional path".into(),
            parameters: json!({"type": "object", "properties": {"path": {"type": "string"}}}),
        }
    }

    fn reasoning() -> Value {
        json!({"id": "rs_1", "type": "reasoning", "summary": [
            {"type": "summary_text", "text": "Checking."}
        ], "encrypted_content": "opaque-ciphertext"})
    }

    fn message(text: &str) -> Value {
        json!({"id": "msg_1", "type": "message", "role": "assistant", "status": "completed",
            "phase": "commentary", "content": [{"type": "output_text", "text": text,
                "annotations": [], "logprobs": []}]})
    }

    fn call(id: &str) -> Value {
        json!({"id": format!("fc_{id}"), "type": "function_call", "status": "completed",
            "call_id": id, "name": "inspect", "arguments": "{}"})
    }

    fn completed(output: Vec<Value>) -> Value {
        json!({"type": "response.completed", "response": {"status": "completed", "output": output,
            "usage": {"input_tokens": 23, "output_tokens": 41,
                "output_tokens_details": {"reasoning_tokens": 31}}}})
    }

    fn apply(events: Vec<Value>) -> (Result<(), ProviderError>, Vec<ProviderEvent>) {
        let mut stream = ResponseStream::default();
        let mut output = Vec::new();
        for event in events {
            if let Err(error) = stream.event(
                &event.to_string(),
                model(),
                &"secret-sentinel".into(),
                &mut output,
            ) {
                return (Err(error), output);
            }
        }
        (Ok(()), output)
    }

    fn replay_assistant() -> ChatMessage {
        let mut assistant = ChatMessage::assistant("Checking now.");
        assistant.tool_calls = Some(vec![item_call(&call("call_1")).unwrap()]);
        assistant.provider_state = Some(ProviderState::OpenAiResponses {
            model: model().wire_model.into(),
            output: vec![reasoning(), message("Checking now."), call("call_1")],
            reasoning_tokens: 31,
        });
        assistant
    }

    #[test]
    fn request_uses_responses_shapes_and_keeps_optional_tool_arguments() {
        let body = build_body(
            model(),
            vec![
                ChatMessage::system("first"),
                ChatMessage::system("second"),
                ChatMessage::user_with_images(
                    "look",
                    vec![ImagePart {
                        media_type: "image/png".into(),
                        data: "AAAA".into(),
                    }],
                ),
            ],
            vec![tool()],
            &params(),
        )
        .unwrap();
        assert_eq!(body["model"], model().wire_model);
        assert_eq!(body["instructions"], "first\n\nsecond");
        assert_eq!(body["store"], false);
        assert_eq!(body["stream"], true);
        assert_eq!(body["include"], json!(["reasoning.encrypted_content"]));
        assert_eq!(body["max_output_tokens"], 4096);
        assert_eq!(
            body["reasoning"],
            json!({"effort": "high", "summary": "auto"})
        );
        assert_eq!(body["input"][0]["content"][0]["type"], "input_text");
        assert_eq!(
            body["input"][0]["content"][1]["image_url"],
            "data:image/png;base64,AAAA"
        );
        assert_eq!(body["tools"][0]["name"], "inspect");
        assert_eq!(body["tools"][0]["strict"], false);
        assert_eq!(body["tool_choice"], "auto");
        for forbidden in [
            "messages",
            "max_tokens",
            "max_completion_tokens",
            "reasoning_effort",
            "temperature",
            "previous_response_id",
            "stream_options",
        ] {
            assert!(body.get(forbidden).is_none(), "sent {forbidden}: {body}");
        }
        // Native web capability stays off until a separate implementation maps
        // its citations and tools; the generic policy cannot enable it here.
        assert_eq!(body["tools"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn effort_and_tool_choice_preserve_the_supported_ladder() {
        let mut checked = 0;
        for model in catalog::CATALOG
            .iter()
            .filter(|model| model.provider == catalog::ProviderId::OpenAi)
        {
            let allowed: &[&str] = match model.wire_model {
                "gpt-6-luna" => &["none", "low", "medium", "high", "max"],
                "gpt-6.1-sol" | "gpt-6-astra" => &["low", "medium", "high", "max"],
                other => panic!("add the verified reasoning ladder for {other}"),
            };
            for effort in [
                Effort::Off,
                Effort::Low,
                Effort::Medium,
                Effort::High,
                Effort::Max,
            ] {
                let expected = match effort {
                    Effort::Off if model.wire_model == "gpt-6-luna" => "none",
                    Effort::Off | Effort::Low => "low",
                    Effort::Medium => "medium",
                    Effort::High => "high",
                    Effort::Max => "max",
                };
                let mut options = params();
                options.effort = effort;
                options.max_tokens = None;
                options.tool_choice = ToolChoiceMode::None;
                let body = build_body(model, vec![], vec![tool()], &options).unwrap();
                assert_eq!(body["model"], model.wire_model);
                assert_eq!(
                    body["reasoning"]["effort"], expected,
                    "{} at {effort:?}",
                    model.id
                );
                assert!(allowed.contains(&body["reasoning"]["effort"].as_str().unwrap()));
                assert_eq!(body["tool_choice"], "none");
                assert_eq!(body["tools"][0]["strict"], false);
                assert!(body.get("max_output_tokens").is_none());
            }
            checked += 1;
        }
        assert_eq!(checked, 3);
        let body = build_body(model(), vec![], vec![], &params()).unwrap();
        assert!(body.get("tools").is_none());
        assert!(body.get("tool_choice").is_none());
    }

    #[test]
    fn replay_preserves_order_phase_and_call_ids_without_duplicate_text() {
        let mut result = ChatMessage::user("done");
        result.role = Role::Tool;
        result.tool_call_id = Some("call_1".into());
        let body = build_body(
            model(),
            vec![replay_assistant(), result],
            vec![tool()],
            &params(),
        )
        .unwrap();
        let input = body["input"].as_array().unwrap();
        assert_eq!(input.len(), 4);
        assert_eq!(input[0], reasoning());
        assert_eq!(input[1]["phase"], "commentary");
        assert_eq!(input[2]["call_id"], "call_1");
        assert_eq!(
            input[3],
            json!({"type": "function_call_output", "call_id": "call_1", "output": "done"})
        );
    }

    #[test]
    fn stale_or_foreign_replay_cannot_override_canonical_content_or_calls() {
        for change in 0..5 {
            let mut assistant = replay_assistant();
            match change {
                0 => assistant.content = "edited".into(),
                1 => assistant.tool_calls = None,
                2 => {
                    assistant.tool_calls.as_mut().unwrap()[0].arguments =
                        "{\"path\":\"changed\"}".into()
                }
                3 => {
                    if let Some(ProviderState::OpenAiResponses { model, .. }) =
                        &mut assistant.provider_state
                    {
                        *model = "other-model".into();
                    }
                }
                _ => {
                    if let Some(ProviderState::OpenAiResponses { output, .. }) =
                        &mut assistant.provider_state
                    {
                        output.push(json!({"type": "web_search_call"}));
                    }
                }
            }
            assert!(replay_output(&assistant, model()).is_none());
            let body = build_body(model(), vec![assistant], vec![], &params()).unwrap();
            assert!(body.to_string().find("opaque-ciphertext").is_none());
        }
    }

    #[test]
    fn forged_replay_cannot_restore_a_system_or_user_message() {
        for role in ["system", "developer", "user", "tool"] {
            let mut assistant = replay_assistant();
            if let Some(ProviderState::OpenAiResponses { output, .. }) =
                &mut assistant.provider_state
            {
                output[1]["role"] = json!(role);
            }
            assert!(replay_output(&assistant, model()).is_none());
            let body = build_body(model(), vec![assistant], vec![], &params()).unwrap();
            assert!(body.get("instructions").is_none());
            assert_eq!(body["input"][0]["role"], "assistant");
            assert!(body["input"]
                .as_array()
                .unwrap()
                .iter()
                .all(|item| item["role"] != "system" && item["role"] != "developer"));
        }
    }

    #[test]
    fn replay_removes_output_only_provenance_without_mutating_stored_state() {
        let mut assistant = replay_assistant();
        if let Some(ProviderState::OpenAiResponses { output, .. }) = &mut assistant.provider_state {
            for item in output.iter_mut() {
                item["created_by"] = json!({"agent_id": "agent_1"});
            }
            output[1]["content"][0]["parsed"] = json!({"sdk": "only"});
            output[2]["parsed_arguments"] = json!({});
        }
        let body = build_body(model(), vec![assistant.clone()], vec![], &params()).unwrap();
        for item in body["input"].as_array().unwrap() {
            assert!(item.get("created_by").is_none());
            assert!(item.get("parsed_arguments").is_none());
        }
        assert!(body["input"][1]["content"][0].get("parsed").is_none());
        assert_eq!(body["input"][1]["phase"], "commentary");
        let Some(ProviderState::OpenAiResponses { output, .. }) = assistant.provider_state else {
            panic!("missing state");
        };
        assert!(output[0].get("created_by").is_some());
    }

    #[test]
    fn invalid_images_and_tool_result_ids_fail_before_network_io() {
        let bad = ChatMessage::user_with_images(
            "look",
            vec![ImagePart {
                media_type: "text/html".into(),
                data: "AAAA".into(),
            }],
        );
        assert!(build_body(model(), vec![bad], vec![], &params()).is_err());
        let blind = CatalogModel {
            supports_vision: false,
            ..*model()
        };
        let image = ChatMessage::user_with_images(
            "look",
            vec![ImagePart {
                media_type: "image/png".into(),
                data: "AAAA".into(),
            }],
        );
        assert!(build_body(&blind, vec![image], vec![], &params()).is_err());
        let mut orphan = ChatMessage::user("output");
        orphan.role = Role::Tool;
        assert!(build_body(model(), vec![orphan], vec![], &params()).is_err());
    }

    #[test]
    fn finish_summary_streams_before_completion_and_reconciles_without_duplicates() {
        let prefix = r###"{"summary":"## Fertig\nGrüße \uD83D"###;
        let tail = r#"\uDE80"}"#;
        let mut finish = call("finish_1");
        finish["name"] = json!("finish");
        finish["arguments"] = json!(format!("{prefix}{tail}"));
        let mut started = finish.clone();
        started["arguments"] = json!("");
        started["status"] = json!("in_progress");

        let mut stream = ResponseStream::default();
        let mut events = Vec::new();
        for event in [
            json!({"type":"response.output_item.added","output_index":0,"item":reasoning()}),
            json!({"type":"response.output_item.added","output_index":1,"item":started}),
            json!({"type":"response.function_call_arguments.delta","output_index":1,"delta":prefix}),
        ] {
            stream
                .event(&event.to_string(), model(), &"test-key".into(), &mut events)
                .unwrap();
        }
        assert!(
            matches!(events.as_slice(), [ProviderEvent::ToolSummaryDelta { call_id, content }]
            if call_id == "finish_1" && content == "## Fertig\nGrüße ")
        );
        assert!(
            !stream.terminal,
            "the summary must be readable before response.completed"
        );

        for event in [
            json!({"type":"response.function_call_arguments.delta","output_index":1,"delta":tail}),
            json!({"type":"response.function_call_arguments.done","output_index":1,"arguments":finish["arguments"]}),
            json!({"type":"response.output_item.done","output_index":1,"item":finish}),
            completed(vec![reasoning(), finish.clone()]),
        ] {
            stream
                .event(&event.to_string(), model(), &"test-key".into(), &mut events)
                .unwrap();
        }
        let summary: String = events
            .iter()
            .filter_map(|event| match event {
                ProviderEvent::ToolSummaryDelta { call_id, content } => {
                    assert_eq!(call_id, "finish_1");
                    Some(content.as_str())
                }
                _ => None,
            })
            .collect();
        assert_eq!(summary, "## Fertig\nGrüße 🚀");
        assert!(events.iter().any(|event| matches!(event, ProviderEvent::ToolCalls(calls)
            if calls.len() == 1 && calls[0].id == "finish_1" && calls[0].arguments == finish["arguments"])));
    }

    #[test]
    fn completed_arguments_cannot_replace_a_summary_that_is_already_visible() {
        let mut started = call("finish_1");
        started["name"] = json!("finish");
        started["arguments"] = json!("");
        let mut changed = started.clone();
        changed["arguments"] = json!(r#"{"summary":"Changed"}"#);
        for terminal in [
            json!({"type":"response.function_call_arguments.done","output_index":0,"arguments":changed["arguments"]}),
            json!({"type":"response.output_item.done","output_index":0,"item":changed}),
            completed(vec![changed]),
        ] {
            let (result, _) = apply(vec![
                json!({"type":"response.output_item.added","output_index":0,"item":started}),
                json!({"type":"response.function_call_arguments.delta","output_index":0,"delta":"{\"summary\":\"Original"}),
                terminal,
            ]);
            assert!(
                result.is_err(),
                "changed arguments must fail instead of duplicating or mixing summaries"
            );
        }
    }

    #[test]
    fn later_finish_calls_do_not_preview_ahead_of_the_first_client_call() {
        let mut finish = call("finish_1");
        finish["name"] = json!("finish");
        finish["arguments"] = json!(r#"{"summary":"Finished"}"#);
        let (result, events) = apply(vec![
            json!({"type":"response.output_item.added","output_index":0,"item":call("inspect_1")}),
            json!({"type":"response.output_item.added","output_index":1,"item":finish}),
            completed(vec![call("inspect_1"), finish]),
        ]);
        result.unwrap();
        assert!(!events
            .iter()
            .any(|event| matches!(event, ProviderEvent::ToolSummaryDelta { .. })));
    }

    #[test]
    fn only_the_first_finish_summary_is_previewed_in_a_parallel_group() {
        let mut first = call("finish_1");
        first["name"] = json!("finish");
        first["arguments"] = json!(r#"{"summary":"First summary"}"#);
        let mut second = first.clone();
        second["call_id"] = json!("finish_2");
        second["id"] = json!("fc_finish_2");
        second["arguments"] = json!(r#"{"summary":"Second summary"}"#);
        let (result, events) = apply(vec![
            json!({"type":"response.output_item.added","output_index":0,"item":first}),
            json!({"type":"response.output_item.added","output_index":1,"item":second}),
            completed(vec![first, second]),
        ]);
        result.unwrap();
        let summary: String = events
            .iter()
            .filter_map(|event| match event {
                ProviderEvent::ToolSummaryDelta { content, .. } => Some(content.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(summary, "First summary");
    }

    #[test]
    fn terminal_output_drives_calls_usage_and_replay_after_streamed_deltas() {
        let (result, events) = apply(vec![
            json!({"type": "response.reasoning_summary_text.delta", "delta": "Checking."}),
            json!({"type": "response.output_text.delta", "delta": "Checking "}),
            json!({"type": "response.function_call_arguments.delta", "delta": "{bad partial"}),
            completed(vec![
                reasoning(),
                message("Checking now."),
                call("call_1"),
                call("call_2"),
            ]),
        ]);
        result.unwrap();
        let text: String = events
            .iter()
            .filter_map(|event| {
                if let ProviderEvent::TextDelta(text) = event {
                    Some(text.as_str())
                } else {
                    None
                }
            })
            .collect();
        assert_eq!(text, "Checking now.");
        assert_eq!(
            events
                .iter()
                .filter(|event| matches!(event, ProviderEvent::ReasoningDelta(_)))
                .count(),
            1
        );
        assert!(events.iter().any(|event| matches!(event, ProviderEvent::ToolCalls(calls) if calls.len() == 2 && calls[0].id == "call_1" && calls[1].id == "call_2")));
        assert!(events.iter().any(|event| matches!(
            event,
            ProviderEvent::Usage {
                prompt_tokens: 23,
                completion_tokens: 41
            }
        )));
        assert!(events.iter().any(|event| matches!(event, ProviderEvent::ProviderState(ProviderState::OpenAiResponses { output, reasoning_tokens: 31, .. }) if output.len() == 4)));
        assert!(matches!(
            events.last(),
            Some(ProviderEvent::Done {
                finish_reason: FinishReason::ToolCalls
            })
        ));
    }

    #[test]
    fn incomplete_responses_never_dispatch_a_partial_parallel_group() {
        let mut unfinished = call("call_2");
        unfinished["status"] = json!("in_progress");
        unfinished["arguments"] = json!("{");
        let (result, events) = apply(vec![json!({"type": "response.incomplete", "response": {
            "status": "incomplete", "incomplete_details": {"reason": "max_output_tokens"},
            "output": [reasoning(), call("call_1"), unfinished],
            "usage": {"input_tokens": 2, "output_tokens": 8}
        }})]);
        result.unwrap();
        assert!(!events
            .iter()
            .any(|event| matches!(event, ProviderEvent::ToolCalls(_))));
        assert!(!events
            .iter()
            .any(|event| matches!(event, ProviderEvent::ProviderState(_))));
        assert!(matches!(
            events.last(),
            Some(ProviderEvent::Done {
                finish_reason: FinishReason::Length
            })
        ));
    }

    #[test]
    fn reasoning_uses_done_items_and_refusals_remain_visible_text() {
        let mut stale = reasoning();
        stale["encrypted_content"] = json!("partial-ciphertext");
        let refusal = json!({"id": "msg_1", "type": "message", "role": "assistant", "content": [{"type": "refusal", "refusal": "I cannot help."}]});
        let (result, events) = apply(vec![
            json!({"type": "response.output_item.done", "output_index": 0, "item": reasoning()}),
            json!({"type": "response.refusal.delta", "delta": "I cannot "}),
            completed(vec![stale, refusal]),
        ]);
        result.unwrap();
        let text: String = events
            .iter()
            .filter_map(|event| {
                if let ProviderEvent::TextDelta(text) = event {
                    Some(text.as_str())
                } else {
                    None
                }
            })
            .collect();
        assert_eq!(text, "I cannot help.");
        assert!(events.iter().any(|event| matches!(event, ProviderEvent::ProviderState(ProviderState::OpenAiResponses { output, .. }) if output[0]["encrypted_content"] == "opaque-ciphertext")));
        assert!(matches!(
            events.last(),
            Some(ProviderEvent::Done {
                finish_reason: FinishReason::Stop
            })
        ));
    }

    #[test]
    fn failed_error_cancelled_and_invalid_calls_cannot_succeed() {
        for event in [
            json!({"type": "response.failed", "response": {"error": {"message": "failed secret-sentinel"}}}),
            json!({"type": "error", "message": "failed secret-sentinel"}),
            json!({"type": "error", "error": {"message": "failed secret-sentinel"}}),
            json!({"type": "response.cancelled"}),
            json!({"type": "response.incomplete", "response": {"incomplete_details": {"reason": "content_filter"}}}),
        ] {
            let (result, events) = apply(vec![event]);
            let error = result.unwrap_err().to_string();
            assert!(!error.contains("secret-sentinel"));
            assert!(!events
                .iter()
                .any(|event| matches!(event, ProviderEvent::ToolCalls(_))));
        }
        let mut partial = call("call_1");
        partial["arguments"] = json!("{");
        assert!(apply(vec![completed(vec![partial])]).0.is_err());
        assert!(apply(vec![completed(vec![call("same"), call("same")])])
            .0
            .is_err());
    }

    async fn fake_server(sse: String) -> (String, std::sync::Arc<std::sync::Mutex<String>>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/v1/responses", listener.local_addr().unwrap());
        let seen = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
        let capture = seen.clone();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            loop {
                let mut chunk = [0u8; 4096];
                let count = socket.read(&mut chunk).await.unwrap();
                if count == 0 {
                    break;
                }
                request.extend_from_slice(&chunk[..count]);
                let request_text = String::from_utf8_lossy(&request);
                if let Some((headers, body)) = request_text.split_once("\r\n\r\n") {
                    let length = headers
                        .lines()
                        .find_map(|line| {
                            let (name, value) = line.split_once(':')?;
                            name.eq_ignore_ascii_case("content-length")
                                .then(|| value.trim().parse::<usize>().ok())
                                .flatten()
                        })
                        .unwrap_or_default();
                    if body.len() >= length {
                        break;
                    }
                }
            }
            *capture.lock().unwrap() = String::from_utf8(request).unwrap();
            let response = format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{sse}", sse.len());
            socket.write_all(response.as_bytes()).await.unwrap();
            let _ = socket.shutdown().await;
        });
        (endpoint, seen)
    }

    fn sse(events: Vec<Value>) -> String {
        events
            .into_iter()
            .map(|event| {
                format!(
                    "event: {}\ndata: {event}\n\n",
                    event["type"].as_str().unwrap()
                )
            })
            .collect()
    }

    #[tokio::test]
    async fn socket_stream_round_trips_reasoning_text_calls_and_usage() {
        let (endpoint, seen) = fake_server(sse(vec![
            json!({"type": "response.output_text.delta", "delta": "Checking now."}),
            completed(vec![reasoning(), message("Checking now."), call("call_1")]),
        ]))
        .await;
        let provider = OpenAiResponsesProvider {
            model: model(),
            api_key: "sk-test-responses".into(),
        };
        let (_cancel_tx, cancel) = tokio::sync::watch::channel(false);
        let (tx, mut rx) = tokio::sync::mpsc::channel(64);
        provider
            .chat_stream_at(
                &endpoint,
                vec![ChatMessage::user("inspect")],
                vec![tool()],
                params(),
                cancel,
                tx,
            )
            .await
            .unwrap();
        let mut events = Vec::new();
        while let Some(event) = rx.recv().await {
            events.push(event);
        }
        assert!(matches!(
            events.last(),
            Some(ProviderEvent::Done {
                finish_reason: FinishReason::ToolCalls
            })
        ));
        let request = seen.lock().unwrap().clone();
        assert!(request.starts_with("POST /v1/responses "));
        assert!(request
            .to_ascii_lowercase()
            .contains("authorization: bearer sk-test-responses"));
        let body: Value = serde_json::from_str(request.split_once("\r\n\r\n").unwrap().1).unwrap();
        assert_eq!(body["store"], false);
        let state = events
            .into_iter()
            .find_map(|event| {
                if let ProviderEvent::ProviderState(state) = event {
                    Some(state)
                } else {
                    None
                }
            })
            .unwrap();
        let mut assistant = ChatMessage::assistant("Checking now.");
        assistant.tool_calls = Some(vec![item_call(&call("call_1")).unwrap()]);
        assistant.provider_state =
            Some(serde_json::from_str(&serde_json::to_string(&state).unwrap()).unwrap());
        let follow_up = build_body(model(), vec![assistant], vec![tool()], &params()).unwrap();
        assert_eq!(follow_up["input"][0], reasoning());
        assert_eq!(follow_up["input"].as_array().unwrap().len(), 3);
    }

    #[tokio::test]
    async fn socket_eof_without_terminal_event_is_an_error() {
        let (endpoint, _) = fake_server(sse(vec![
            json!({"type": "response.output_text.delta", "delta": "unfinished"}),
        ]))
        .await;
        let provider = OpenAiResponsesProvider {
            model: model(),
            api_key: "sk-test".into(),
        };
        let (_cancel_tx, cancel) = tokio::sync::watch::channel(false);
        let (tx, _rx) = tokio::sync::mpsc::channel(64);
        let error = provider
            .chat_stream_at(&endpoint, vec![], vec![], params(), cancel, tx)
            .await
            .unwrap_err();
        assert!(error.to_string().contains("terminal response event"));
    }

    #[tokio::test]
    async fn cancellation_before_request_never_contacts_the_server() {
        let provider = OpenAiResponsesProvider {
            model: model(),
            api_key: "sk-test".into(),
        };
        let (_cancel_tx, cancel) = tokio::sync::watch::channel(true);
        let (tx, _rx) = tokio::sync::mpsc::channel(64);
        let result = provider
            .chat_stream_at(
                "http://127.0.0.1:1/v1/responses",
                vec![],
                vec![],
                params(),
                cancel,
                tx,
            )
            .await;
        assert!(matches!(result, Err(ProviderError::Cancelled)));
    }

    #[tokio::test]
    async fn cancellation_interrupts_a_stalled_stream_without_dispatching_calls() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/v1/responses", listener.local_addr().unwrap());
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0u8; 4096];
            let read = socket.read(&mut request).await.unwrap();
            assert!(read > 0, "the client must send an HTTP request");
            let partial = sse(vec![
                json!({"type": "response.output_text.delta", "delta": "started"}),
                json!({"type": "response.function_call_arguments.delta", "delta": "{\"path\":"}),
            ]);
            let headers = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n";
            socket.write_all(headers.as_bytes()).await.unwrap();
            socket
                .write_all(format!("{:x}\r\n{partial}\r\n", partial.len()).as_bytes())
                .await
                .unwrap();
            let _ = started_tx.send(());
            std::future::pending::<()>().await;
        });
        let (cancel_tx, cancel) = tokio::sync::watch::channel(false);
        let (tx, mut rx) = tokio::sync::mpsc::channel(64);
        let run = tokio::spawn(async move {
            let provider = OpenAiResponsesProvider {
                model: model(),
                api_key: "sk-test".into(),
            };
            provider
                .chat_stream_at(&endpoint, vec![], vec![tool()], params(), cancel, tx)
                .await
        });
        tokio::time::timeout(std::time::Duration::from_secs(3), started_rx)
            .await
            .unwrap()
            .unwrap();
        // Receiving a provider delta proves the adapter has passed the HTTP
        // headers and entered read_sse; the server writing headers alone does
        // not establish that ordering under concurrent test execution.
        let marker = tokio::time::timeout(std::time::Duration::from_secs(3), rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(marker, ProviderEvent::TextDelta(ref text) if text == "started"));
        cancel_tx.send(true).unwrap();
        let result = tokio::time::timeout(std::time::Duration::from_secs(3), run)
            .await
            .unwrap()
            .unwrap();
        server.abort();
        assert!(matches!(result, Err(ProviderError::Cancelled)));
        let mut saw_cancelled = false;
        while let Some(event) = rx.recv().await {
            assert!(!matches!(event, ProviderEvent::ToolCalls(_)));
            if matches!(
                event,
                ProviderEvent::Done {
                    finish_reason: FinishReason::Cancelled
                }
            ) {
                saw_cancelled = true;
            }
        }
        assert!(saw_cancelled);
    }
}
