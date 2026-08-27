//! One streamed provider round, shared by terminal Agent and terminal-free Chat.
//!
//! This layer knows provider messages, tool definitions, streaming and usage.
//! It deliberately knows neither terminal commands nor Knowledge: callers
//! inject the offered tool vector, observe presentation events, and dispatch
//! returned calls in their own capability boundary.

use super::{
    ChatMessage, ChatParams, FinishReason, Provider, ProviderError, ProviderEvent, ToolCall,
    ToolDef,
};

pub struct RoundOutput {
    pub calls: Vec<ToolCall>,
    pub text: String,
    pub usage: (u32, u32),
    pub finish: FinishReason,
}

fn absorb(output: &mut RoundOutput, event: ProviderEvent) {
    match event {
        ProviderEvent::TextDelta(delta) => output.text.push_str(&delta),
        ProviderEvent::ToolCalls(calls) => output.calls.extend(calls),
        ProviderEvent::Usage {
            prompt_tokens,
            completion_tokens,
        } => output.usage = (prompt_tokens, completion_tokens),
        ProviderEvent::Done { finish_reason } => output.finish = finish_reason,
        ProviderEvent::ReasoningDelta(_) | ProviderEvent::WebCitation(_) => {}
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
    let (tx, mut rx) = tokio::sync::mpsc::channel::<ProviderEvent>(64);
    let stream = provider.chat_stream(messages, tools, params, cancel, tx);
    tokio::pin!(stream);
    let mut stream_done = None;
    let mut output = RoundOutput {
        calls: Vec::new(),
        text: String::new(),
        usage: (0, 0),
        finish: FinishReason::Stop,
    };

    loop {
        tokio::select! {
            result = &mut stream, if stream_done.is_none() => stream_done = Some(result),
            event = rx.recv() => {
                let Some(event) = event else { break };
                observe(&event);
                absorb(&mut output, event);
            }
        }
        if stream_done.is_some() && rx.is_closed() {
            while let Ok(event) = rx.try_recv() {
                observe(&event);
                absorb(&mut output, event);
            }
            break;
        }
    }

    match stream_done {
        Some(Err(error)) => Err(error),
        _ => Ok(output),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::{Effort, WebToolPolicy};

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
            tx.send(ProviderEvent::Done {
                finish_reason: FinishReason::Stop,
            })
            .await
            .unwrap();
            Ok(())
        }
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
        assert_eq!(observed.len(), 3);
    }
}
