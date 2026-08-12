//! End-to-end smoke test for the local inference path, runnable without the
//! Tauri UI: loads a GGUF via llama.cpp and streams a command suggestion
//! through the same Provider implementation the app uses.
//!
//! Usage: cargo run --features local-llm --example smoke_llm -- <file.gguf> [qwen|gemma]

#[cfg(feature = "local-llm")]
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    use vterminal_lib::models::catalog::LocalFamily;
    use vterminal_lib::provider::local::{LocalLlamaCpp, ReadyModel};
    use vterminal_lib::provider::{
        ChatMessage, ChatParams, Effort, Provider, ProviderEvent, ToolChoiceMode,
    };

    let mut args = std::env::args().skip(1);
    let file = args
        .next()
        .expect("usage: smoke_llm <file.gguf> [qwen|gemma]");
    let family = match args.next().as_deref() {
        Some("gemma") => LocalFamily::Gemma,
        _ => LocalFamily::Qwen,
    };

    eprintln!("loading {file}…");
    let start = std::time::Instant::now();
    let ready = ReadyModel::load_standalone(&file, family, 8192)?;
    eprintln!("loaded in {:.1}s", start.elapsed().as_secs_f32());

    let provider = LocalLlamaCpp { ready };

    let messages = vec![
        ChatMessage::system(vterminal_lib::agent::prompts::SUGGEST),
        ChatMessage::user(
            "OS: macOS\nShell: /bin/zsh\nWorking directory: /Users/test\nRequest: list all files larger than 100MB in my home directory",
        ),
    ];
    let (_cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);
    let (tx, mut rx) = tokio::sync::mpsc::channel::<ProviderEvent>(64);

    let gen_start = std::time::Instant::now();
    let handle = tokio::spawn(async move {
        provider
            .chat_stream(
                messages,
                Vec::new(),
                ChatParams {
                    temperature: Some(0.4),
                    max_tokens: Some(256),
                    tool_choice: ToolChoiceMode::None,
                    effort: Effort::Off,
                    web_access: false,
                },
                cancel_rx,
                tx,
            )
            .await
    });

    let mut text = String::new();
    let mut completion_tokens = 0;
    while let Some(event) = rx.recv().await {
        match event {
            ProviderEvent::TextDelta(delta) => {
                print!("{delta}");
                use std::io::Write;
                std::io::stdout().flush().ok();
                text.push_str(&delta);
            }
            ProviderEvent::Usage {
                completion_tokens: ct,
                ..
            } => completion_tokens = ct,
            ProviderEvent::Done { .. } => break,
            _ => {}
        }
    }
    handle.await??;
    let secs = gen_start.elapsed().as_secs_f32();
    eprintln!(
        "\n---\ngenerated {completion_tokens} tokens in {secs:.1}s ({:.1} tok/s)",
        completion_tokens as f32 / secs.max(0.001)
    );
    assert!(
        text.contains("```"),
        "expected a fenced command in the reply"
    );
    eprintln!("SMOKE OK");
    Ok(())
}

#[cfg(not(feature = "local-llm"))]
fn main() {
    eprintln!("build with --features local-llm");
}
