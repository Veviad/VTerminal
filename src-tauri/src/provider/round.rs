//! One streamed provider round, shared by terminal Agent and terminal-free Chat.
//!
//! This layer knows provider messages, tool definitions, streaming and usage.
//! It deliberately knows neither terminal commands nor Knowledge: callers
//! inject the offered tool vector, observe presentation events, and dispatch
//! returned calls in their own capability boundary.

use super::{
    ChatMessage, ChatParams, FinishReason, Provider, ProviderError, ProviderEvent, ProviderState,
    ToolCall, ToolDef,
};

// Provider chunks can be single characters, especially during reasoning.
// Bound webview IPC work to a display cadence without delaying the first byte
// or reordering text across tool/activity/citation/completion boundaries.
const PRESENTATION_INTERVAL: std::time::Duration = std::time::Duration::from_millis(32);
const MAX_PENDING_DELTA_BYTES: usize = 65_536;

#[derive(Clone, Copy, PartialEq, Eq)]
enum DeltaKind {
    Text,
    Reasoning,
}

#[derive(Default)]
struct Presentation {
    pending: Option<(DeltaKind, String)>,
    last_kind: Option<DeltaKind>,
    last_emit: Option<tokio::time::Instant>,
}

impl Presentation {
    fn deadline(&self) -> Option<tokio::time::Instant> {
        self.pending
            .as_ref()
            .and(self.last_emit)
            .map(|last| last + PRESENTATION_INTERVAL)
    }

    fn flush(&mut self, now: tokio::time::Instant, observe: &mut impl FnMut(&ProviderEvent)) {
        if let Some((kind, text)) = self.pending.take() {
            let event = match kind {
                DeltaKind::Text => ProviderEvent::TextDelta(text),
                DeltaKind::Reasoning => ProviderEvent::ReasoningDelta(text),
            };
            observe(&event);
            self.last_emit = Some(now);
        }
    }

    fn push(
        &mut self,
        event: &ProviderEvent,
        now: tokio::time::Instant,
        observe: &mut impl FnMut(&ProviderEvent),
    ) {
        let (kind, text) = match event {
            ProviderEvent::TextDelta(text) => (DeltaKind::Text, text),
            ProviderEvent::ReasoningDelta(text) => (DeltaKind::Reasoning, text),
            _ => {
                self.flush(now, observe);
                observe(event);
                return;
            }
        };
        let pending_bytes = self.pending.as_ref().map_or(0, |(_, text)| text.len());
        if self.last_kind != Some(kind)
            || self
                .last_emit
                .is_none_or(|last| now >= last + PRESENTATION_INTERVAL)
            || text.len().saturating_add(pending_bytes) >= MAX_PENDING_DELTA_BYTES
        {
            self.flush(now, observe);
            observe(event);
            self.last_kind = Some(kind);
            self.last_emit = Some(now);
        } else {
            self.pending
                .get_or_insert_with(|| (kind, String::new()))
                .1
                .push_str(text);
        }
    }
}

pub struct RoundOutput {
    pub calls: Vec<ToolCall>,
    pub text: String,
    pub usage: (u32, u32),
    pub finish: FinishReason,
    pub provider_state: Option<ProviderState>,
}

fn absorb(output: &mut RoundOutput, event: ProviderEvent) {
    match event {
        ProviderEvent::TextDelta(delta) => output.text.push_str(&delta),
        ProviderEvent::ToolCalls(calls) => output.calls.extend(calls),
        ProviderEvent::ProviderState(state) => output.provider_state = Some(state),
        ProviderEvent::Usage {
            prompt_tokens,
            completion_tokens,
        } => output.usage = (prompt_tokens, completion_tokens),
        ProviderEvent::Done { finish_reason } => output.finish = finish_reason,
        ProviderEvent::ReasoningDelta(_)
        | ProviderEvent::WebCitation(_)
        | ProviderEvent::Activity(_) => {}
    }
}

pub async fn run_round(
    provider: &dyn Provider,
    messages: Vec<ChatMessage>,
    tools: Vec<ToolDef>,
    params: ChatParams,
    cancel: tokio::sync::watch::Receiver<bool>,
    mut observe: impl FnMut(&ProviderEvent),
) -> Result<RoundOutput, ProviderError> {
    if *cancel.borrow() {
        return Err(ProviderError::Cancelled);
    }
    let (tx, mut rx) = tokio::sync::mpsc::channel::<ProviderEvent>(64);
    let stream = provider.chat_stream(messages, tools, params, cancel, tx);
    tokio::pin!(stream);
    let mut stream_done = None;
    let mut events_closed = false;
    let mut presentation = Presentation::default();
    let mut output = RoundOutput {
        calls: Vec::new(),
        text: String::new(),
        usage: (0, 0),
        finish: FinishReason::Stop,
        provider_state: None,
    };

    loop {
        let flush_at = presentation.deadline();
        tokio::select! {
            _ = tokio::time::sleep_until(flush_at.unwrap_or_else(tokio::time::Instant::now)), if flush_at.is_some() => {
                presentation.flush(tokio::time::Instant::now(), &mut observe);
            }
            result = &mut stream, if stream_done.is_none() => stream_done = Some(result),
            event = rx.recv(), if !events_closed => {
                if let Some(event) = event {
                    presentation.push(&event, tokio::time::Instant::now(), &mut observe);
                    absorb(&mut output, event);
                } else {
                    // A provider may release its event sender before its
                    // worker finishes. Only the worker's result proves success.
                    events_closed = true;
                }
            }
        }
        if stream_done.is_some() && rx.is_closed() {
            while let Ok(event) = rx.try_recv() {
                presentation.push(&event, tokio::time::Instant::now(), &mut observe);
                absorb(&mut output, event);
            }
            break;
        }
    }

    // Cancellation/error may end without a Done event. The visible partial
    // answer must still exactly match every accepted provider delta.
    presentation.flush(tokio::time::Instant::now(), &mut observe);
    match stream_done {
        Some(Err(error)) => Err(error),
        _ => Ok(output),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::{Effort, WebToolPolicy};

    fn label(event: &ProviderEvent) -> String {
        match event {
            ProviderEvent::TextDelta(text) => format!("text:{text}"),
            ProviderEvent::ReasoningDelta(text) => format!("thinking:{text}"),
            ProviderEvent::Activity(_) => "activity".into(),
            ProviderEvent::WebCitation(_) => "citation".into(),
            ProviderEvent::ToolCalls(_) => "tools".into(),
            ProviderEvent::ProviderState(_) => "state".into(),
            ProviderEvent::Usage { .. } => "usage".into(),
            ProviderEvent::Done { .. } => "done".into(),
        }
    }

    #[test]
    fn a_burst_of_ten_thousand_deltas_needs_two_display_updates() {
        let now = tokio::time::Instant::now();
        let mut presentation = Presentation::default();
        let mut updates = Vec::new();
        let mut observe = |event: &ProviderEvent| updates.push(label(event));
        for _ in 0..10_000 {
            presentation.push(&ProviderEvent::TextDelta("🍰".into()), now, &mut observe);
        }
        presentation.flush(now, &mut observe);
        assert_eq!(updates.len(), 2);
        assert_eq!(updates[0], "text:🍰", "the first delta is immediate");
        assert_eq!(updates[1], format!("text:{}", "🍰".repeat(9_999)));
    }

    #[test]
    fn presentation_preserves_kind_and_tool_activity_citation_boundaries() {
        use crate::provider::{ActivityKind, ActivityStatus, ProviderActivity, WebCitation};
        let events = vec![
            ProviderEvent::ReasoningDelta("a".into()),
            ProviderEvent::ReasoningDelta("b".into()),
            ProviderEvent::TextDelta("c".into()),
            ProviderEvent::TextDelta("d".into()),
            ProviderEvent::Activity(ProviderActivity {
                id: "search".into(),
                kind: ActivityKind::WebSearch,
                status: ActivityStatus::Running,
            }),
            ProviderEvent::TextDelta("e".into()),
            ProviderEvent::WebCitation(WebCitation {
                url: "https://example.test".into(),
                title: "source".into(),
                cited_text: "e".into(),
            }),
            ProviderEvent::TextDelta("f".into()),
            ProviderEvent::ToolCalls(Vec::new()),
            ProviderEvent::Usage {
                prompt_tokens: 3,
                completion_tokens: 5,
            },
            ProviderEvent::Done {
                finish_reason: FinishReason::Stop,
            },
        ];
        let now = tokio::time::Instant::now();
        let mut presentation = Presentation::default();
        let mut updates = Vec::new();
        let mut observe = |event: &ProviderEvent| updates.push(label(event));
        for event in &events {
            presentation.push(event, now, &mut observe);
        }
        presentation.flush(now, &mut observe);
        assert_eq!(updates, events.iter().map(label).collect::<Vec<_>>());
    }

    #[test]
    fn pending_presentation_is_bounded_and_flushes_at_its_deadline() {
        let now = tokio::time::Instant::now();
        let mut presentation = Presentation::default();
        let mut updates = Vec::new();
        let mut observe = |event: &ProviderEvent| updates.push(label(event));
        presentation.push(&ProviderEvent::TextDelta("first".into()), now, &mut observe);
        presentation.push(
            &ProviderEvent::TextDelta("pending".into()),
            now,
            &mut observe,
        );
        assert_eq!(presentation.deadline(), Some(now + PRESENTATION_INTERVAL));
        presentation.flush(now + PRESENTATION_INTERVAL, &mut observe);
        assert!(presentation.deadline().is_none());
        let oversized = "x".repeat(MAX_PENDING_DELTA_BYTES + 1);
        presentation.push(
            &ProviderEvent::TextDelta(oversized.clone()),
            now + PRESENTATION_INTERVAL,
            &mut observe,
        );
        assert!(presentation.pending.is_none());
        assert_eq!(
            updates,
            [
                "text:first".to_owned(),
                "text:pending".to_owned(),
                format!("text:{oversized}")
            ]
        );
    }

    struct HeldProvider {
        release: std::sync::Arc<tokio::sync::Notify>,
        cancelled: bool,
    }

    #[async_trait::async_trait]
    impl Provider for HeldProvider {
        fn id(&self) -> &'static str {
            "held"
        }
        fn model_name(&self) -> String {
            "Held".into()
        }
        async fn chat_stream(
            &self,
            _messages: Vec<ChatMessage>,
            _tools: Vec<ToolDef>,
            _params: ChatParams,
            _cancel: tokio::sync::watch::Receiver<bool>,
            tx: tokio::sync::mpsc::Sender<ProviderEvent>,
        ) -> Result<(), ProviderError> {
            tx.send(ProviderEvent::TextDelta("first".into()))
                .await
                .unwrap();
            tx.send(ProviderEvent::TextDelta("second".into()))
                .await
                .unwrap();
            self.release.notified().await;
            tx.send(ProviderEvent::TextDelta("tail".into()))
                .await
                .unwrap();
            if self.cancelled {
                Err(ProviderError::Cancelled)
            } else {
                Err(ProviderError::Http("fixture failure".into()))
            }
        }
    }

    #[tokio::test]
    async fn pending_text_streams_before_provider_completion_and_flushes_on_failure_or_cancel() {
        for cancelled in [false, true] {
            let release = std::sync::Arc::new(tokio::sync::Notify::new());
            let provider = HeldProvider {
                release: release.clone(),
                cancelled,
            };
            let (events, mut receive) = tokio::sync::mpsc::unbounded_channel();
            let (_, cancel) = tokio::sync::watch::channel(false);
            let run = tokio::spawn(async move {
                run_round(
                    &provider,
                    Vec::new(),
                    Vec::new(),
                    params(),
                    cancel,
                    |event| {
                        events.send(label(event)).unwrap();
                    },
                )
                .await
            });
            assert_eq!(receive.recv().await.as_deref(), Some("text:first"));
            let second = tokio::time::timeout(std::time::Duration::from_secs(1), receive.recv())
                .await
                .unwrap();
            assert_eq!(second.as_deref(), Some("text:second"));
            assert!(
                !run.is_finished(),
                "text must be visible while the provider is still working"
            );
            release.notify_one();
            let result = run.await.unwrap();
            if cancelled {
                assert!(matches!(result, Err(ProviderError::Cancelled)));
            } else {
                assert!(matches!(result, Err(ProviderError::Http(_))));
            }
            assert_eq!(receive.recv().await.as_deref(), Some("text:tail"));
            assert!(receive.recv().await.is_none());
        }
    }

    struct ImmediateProvider;

    #[async_trait::async_trait]
    impl Provider for ImmediateProvider {
        fn id(&self) -> &'static str {
            "immediate"
        }

        fn model_name(&self) -> String {
            "Immediate".into()
        }

        async fn chat_stream(
            &self,
            _messages: Vec<ChatMessage>,
            _tools: Vec<ToolDef>,
            _params: ChatParams,
            _cancel: tokio::sync::watch::Receiver<bool>,
            tx: tokio::sync::mpsc::Sender<ProviderEvent>,
        ) -> Result<(), ProviderError> {
            tx.send(ProviderEvent::TextDelta("answer".into()))
                .await
                .unwrap();
            tx.send(ProviderEvent::Usage {
                prompt_tokens: 9_697,
                completion_tokens: 165,
            })
            .await
            .unwrap();
            tx.send(ProviderEvent::ProviderState(
                ProviderState::OpenAiResponses {
                    model: "gpt-6-luna".into(),
                    output: Vec::new(),
                    reasoning_tokens: 42,
                },
            ))
            .await
            .unwrap();
            tx.send(ProviderEvent::Done {
                finish_reason: FinishReason::Stop,
            })
            .await
            .unwrap();
            Ok(())
        }
    }

    struct LateFailureProvider;

    #[async_trait::async_trait]
    impl Provider for LateFailureProvider {
        fn id(&self) -> &'static str {
            "late-failure"
        }
        fn model_name(&self) -> String {
            "Late failure".into()
        }
        async fn chat_stream(
            &self,
            _messages: Vec<ChatMessage>,
            _tools: Vec<ToolDef>,
            _params: ChatParams,
            _cancel: tokio::sync::watch::Receiver<bool>,
            tx: tokio::sync::mpsc::Sender<ProviderEvent>,
        ) -> Result<(), ProviderError> {
            tx.send(ProviderEvent::TextDelta("partial".into()))
                .await
                .unwrap();
            drop(tx);
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            Err(ProviderError::Http(
                "stream failed after closing events".into(),
            ))
        }
    }

    fn params() -> ChatParams {
        ChatParams {
            temperature: None,
            max_tokens: None,
            tool_choice: super::super::ToolChoiceMode::None,
            web: WebToolPolicy::Disabled,
            effort: Effort::Off,
        }
    }

    #[tokio::test]
    async fn closing_events_does_not_hide_the_provider_failure() {
        let (_, cancel) = tokio::sync::watch::channel(false);
        let mut text = String::new();
        let result = run_round(
            &LateFailureProvider,
            Vec::new(),
            Vec::new(),
            params(),
            cancel,
            |event| {
                if let ProviderEvent::TextDelta(delta) = event {
                    text.push_str(delta)
                }
            },
        )
        .await;
        assert!(matches!(result, Err(ProviderError::Http(_))));
        assert_eq!(text, "partial");
    }

    #[tokio::test]
    async fn cancelled_setup_never_starts_a_provider_round() {
        let (_, cancel) = tokio::sync::watch::channel(true);
        let result = run_round(
            &ImmediateProvider,
            Vec::new(),
            Vec::new(),
            params(),
            cancel,
            |_| panic!("cancelled request must not stream output"),
        )
        .await;
        assert!(matches!(result, Err(ProviderError::Cancelled)));
    }

    #[tokio::test]
    async fn drains_usage_when_a_provider_finishes_immediately() {
        let (_, cancel) = tokio::sync::watch::channel(false);
        let mut observed = Vec::new();
        let output = run_round(
            &ImmediateProvider,
            vec![ChatMessage::user("hello")],
            Vec::new(),
            ChatParams {
                temperature: None,
                max_tokens: None,
                tool_choice: super::super::ToolChoiceMode::None,
                web: WebToolPolicy::Disabled,
                effort: Effort::Off,
            },
            cancel,
            |event| observed.push(std::mem::discriminant(event)),
        )
        .await
        .unwrap();

        assert_eq!(output.text, "answer");
        assert_eq!(output.usage, (9_697, 165));
        assert_eq!(output.finish, FinishReason::Stop);
        assert_eq!(output.provider_state.unwrap().reasoning_tokens(), 42);
        assert_eq!(observed.len(), 4);
    }
}
