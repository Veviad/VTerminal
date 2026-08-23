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
