// Deliberate seam module: tool calling, usage plumbing, and the trait methods
// exist for the v2 agent loop + cloud providers and are partly unused in v1.
#![allow(dead_code)]

#[cfg(feature = "local-llm")]
pub mod chat_template;
pub mod http;
#[cfg(feature = "local-llm")]
pub mod local;
pub mod round;
#[cfg(feature = "local-llm")]
pub mod vision;

use std::sync::Arc;

/// The ONE permit for on-device generation, shared by the chat host and the
/// vision sidecar.
///
/// `ModelHost` used to own its semaphore, and the obvious way to add a second
/// resident model is to give it a second one. That would quietly change a shipped
/// invariant from "one local generation at a time" to "two, with two models in
/// memory" — on a 16GB machine the chat model plus the smallest sidecar already
/// leaves under 600MB of headroom, and each generation allocates its own KV cache
/// on top. It also matters for correctness: `MtmdInputChunks::eval_chunks` is
/// documented as not thread-safe.
///
/// Sharing costs nothing, because the flow is inherently sequential: transcribe
/// the image, then send the chat turn that quotes it.
pub struct InferenceGate(pub Arc<tokio::sync::Semaphore>);

impl Default for InferenceGate {
    fn default() -> Self {
        Self(Arc::new(tokio::sync::Semaphore::new(1)))
    }
}

use serde::{Deserialize, Serialize};

pub use crate::models::catalog::Effort;

// The provider seam: everything AI-related in the app talks to this trait with
// OpenAI-ish shapes. `local::LocalLlamaCpp` implements it on-device;
// `http::{anthropic, openai_compat}` implement it over SSE.

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    System,
    User,
    Assistant,
    Tool,
}

/// One image on a user turn.
///
/// A sibling of `content`, deliberately NOT a variant of it. `ChatMessage.content`
/// is simultaneously the provider input, the `agent_start` IPC type in and out,
/// and the archived transcript format, and `agent/history.rs` reads it as a plain
/// string in five places. Turning it into an enum breaks all of that at once and
/// forces a migration of every stored transcript; adding a field beside it breaks
/// none of them.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImagePart {
    /// Checked against an allowlist before it reaches a request body — never
    /// echoed from a filename or from `File.type`.
    pub media_type: String,
    /// Base64, no `data:` prefix. Each adapter wraps it in its vendor's shape.
    pub data: String,
}

/// Media types an image part may declare. A provider answers anything else with a
/// 400, and the value originates from bytes the user dropped in.
pub const ALLOWED_IMAGE_TYPES: &[&str] = &["image/png", "image/jpeg", "image/gif", "image/webp"];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: Role,
    pub content: String,
    // `default` is not redundant with `skip_serializing_if`: together they are
    // what makes a Rust -> JSON -> Rust round trip work at all. Serializing omits
    // these keys entirely when they are None, so deserializing has to accept
    // their absence — which serde does for Option anyway, but only implicitly.
    // Stating it keeps a stored transcript (archive, IPC) from depending on an
    // invisible derive detail.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCall>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    /// Images on this turn. The `default` above is doing real work here: a
    /// transcript archived before this field existed must still deserialize, and
    /// it does — as `None`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub images: Option<Vec<ImagePart>>,
}

impl ChatMessage {
    pub fn system(content: impl Into<String>) -> Self {
        Self {
            role: Role::System,
            content: content.into(),
            tool_calls: None,
            tool_call_id: None,
            images: None,
        }
    }
    pub fn user(content: impl Into<String>) -> Self {
        Self {
            role: Role::User,
            content: content.into(),
            tool_calls: None,
            tool_call_id: None,
            images: None,
        }
    }
    pub fn user_with_images(content: impl Into<String>, images: Vec<ImagePart>) -> Self {
        Self {
            role: Role::User,
            content: content.into(),
            tool_calls: None,
            tool_call_id: None,
            // Empty stays None so every downstream `is_some()` means "there are
            // actually images here".
            images: if images.is_empty() {
                None
            } else {
                Some(images)
            },
        }
    }
    pub fn assistant(content: impl Into<String>) -> Self {
        Self {
            role: Role::Assistant,
            content: content.into(),
            tool_calls: None,
            tool_call_id: None,
            images: None,
        }
    }

    /// Total base64 bytes carried as images. Used by the history budget, which
    /// would otherwise measure an image-heavy transcript as nearly free.
    pub fn image_bytes(&self) -> usize {
        self.images.iter().flatten().map(|i| i.data.len()).sum()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    /// Raw JSON string of the arguments.
    pub arguments: String,
}

/// One source attached to provider-grounded web prose. Kept structured until
/// the renderer so an untrusted URL never becomes raw model-authored markdown.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WebCitation {
    pub url: String,
    pub title: String,
    #[serde(default)]
    pub cited_text: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WebToolPolicy {
    Disabled,
    Unsupported,
    FetchOnly,
    SearchAndFetch,
}

impl WebToolPolicy {
    pub fn allows_fetch(self) -> bool {
        matches!(self, Self::FetchOnly | Self::SearchAndFetch)
    }

    pub fn allows_search(self) -> bool {
        matches!(self, Self::SearchAndFetch)
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ToolDef {
    pub name: String,
    pub description: String,
    pub parameters: serde_json::Value,
}

#[derive(Debug, Clone, Copy)]
pub enum ToolChoiceMode {
    Auto,
    None,
}

#[derive(Debug, Clone)]
pub struct ChatParams {
    /// `None` means "use the model's own default" — for a GGUF that is the
    /// `general.sampling.temp` it ships, matching llama.cpp's precedence.
    /// Ignored entirely when the catalog says the model rejects it: Claude
    /// Opus 5 and Sonnet 5 return a 400 for `temperature`, as do GPT-5.6.
    pub temperature: Option<f32>,
    pub max_tokens: Option<u32>,
    pub tool_choice: ToolChoiceMode,
    /// Which provider-native web tools this turn may use. Each adapter intersects
    /// the policy with its model's catalog capabilities and
    /// emits its vendor's wire shape — the same discipline as `effort`, which is
    /// clamped by `catalog.efforts`. Adapters whose vendor offers nothing on the
    /// wire shape we speak (OpenAI and Mistral both keep web search on a
    /// different API) ignore it entirely.
    ///
    /// Deliberately NOT a `ToolDef` variant: `ToolDef` means "a function the
    /// agent loop can dispatch", and `chat_template.rs` — which renders it for
    /// local GGUFs — is behind `--features local-llm`, so changing that type
    /// compiles clean in the default build and breaks the local engine.
    pub web: WebToolPolicy,
    /// Reasoning depth on the app's normalized ladder. Each provider clamps it
    /// to the rungs its catalog entry declares, then maps it onto whatever that
    /// vendor actually accepts (`output_config.effort`, `reasoning_effort`, a
    /// `budget_tokens` number, or a plain thinking toggle).
    pub effort: Effort,
}

impl ChatParams {
    /// Whether the model should reason at all. The one thing every backend
    /// needs regardless of how it spells depth.
    pub fn thinking_enabled(&self) -> bool {
        self.effort != Effort::Off
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FinishReason {
    Stop,
    ToolCalls,
    Length,
    Cancelled,
}

#[derive(Debug, Clone)]
pub enum ProviderEvent {
    TextDelta(String),
    /// Model reasoning (auto-split from `<think>` blocks by the engine).
    ReasoningDelta(String),
    /// Complete, parsed tool calls (local models emit them whole).
    ToolCalls(Vec<ToolCall>),
    WebCitation(WebCitation),
    Usage {
        prompt_tokens: u32,
        completion_tokens: u32,
    },
    Done {
        finish_reason: FinishReason,
    },
}

#[derive(Debug, thiserror::Error)]
pub enum ProviderError {
    #[error("no model loaded")]
    NoModel,
    #[error("inference error: {0}")]
    Inference(String),
    #[error("cancelled")]
    Cancelled,
    #[allow(dead_code)] // used by the HTTP providers in v2
    #[error("http error: {0}")]
    Http(String),
}

#[async_trait::async_trait]
pub trait Provider: Send + Sync {
    fn id(&self) -> &'static str;
    fn model_name(&self) -> String;
    /// Streams events into `tx` until Done. Honors `cancel` (watch flips true).
    async fn chat_stream(
        &self,
        messages: Vec<ChatMessage>,
        tools: Vec<ToolDef>,
        params: ChatParams,
        cancel: tokio::sync::watch::Receiver<bool>,
        tx: tokio::sync::mpsc::Sender<ProviderEvent>,
    ) -> Result<(), ProviderError>;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png(data: &str) -> ImagePart {
        ImagePart {
            media_type: "image/png".into(),
            data: data.into(),
        }
    }

    /// `skip_serializing_if` means a message with no images emits no `images` key
    /// at all, so the stored shape is byte-identical to every transcript archived
    /// before this field existed.
    #[test]
    fn a_message_without_images_serializes_no_images_key() {
        let json = serde_json::to_value(ChatMessage::user("hi")).unwrap();
        assert!(json.get("images").is_none());
        assert!(json.get("tool_calls").is_none());
    }

    /// The half that actually matters for the archive: an OLD transcript, written
    /// before `images` existed, has to deserialize. `default` is what makes it.
    #[test]
    fn a_transcript_predating_the_field_still_deserializes() {
        let stored = serde_json::json!({"role": "user", "content": "what is my cwd"});
        let msg: ChatMessage = serde_json::from_value(stored).unwrap();
        assert_eq!(msg.role, Role::User);
        assert!(msg.images.is_none());
    }

    #[test]
    fn images_round_trip_through_serde() {
        let original = ChatMessage::user_with_images("look", vec![png("AAAA"), png("BBBB")]);
        let back: ChatMessage =
            serde_json::from_str(&serde_json::to_string(&original).unwrap()).unwrap();
        let images = back.images.expect("images survived");
        assert_eq!(images.len(), 2);
        assert_eq!(images[1].data, "BBBB");
    }

    /// Empty collapses to `None` so every downstream `is_some()` means "there are
    /// actually images here" — the non-vision gate and the history strip both
    /// rely on that.
    #[test]
    fn an_empty_image_list_is_none_not_some_empty() {
        assert!(ChatMessage::user_with_images("hi", vec![]).images.is_none());
    }

    #[test]
    fn image_bytes_sums_base64_across_parts() {
        let msg = ChatMessage::user_with_images("x", vec![png("AAAA"), png("BB")]);
        assert_eq!(msg.image_bytes(), 6);
        // And costs nothing when there are none — the history budget calls this
        // for every message.
        assert_eq!(ChatMessage::user("x").image_bytes(), 0);
    }
}
