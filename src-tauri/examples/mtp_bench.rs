//! Repeatable standard-versus-MTP benchmark for the real VTerminal provider.
//!
//! Usage:
//! cargo run --release --features local-llm --example mtp_bench -- \
//!   <target.gguf> <qwen|gemma> <draft-tokens> [draft.gguf|-] [runs]

#[cfg(feature = "local-llm")]
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    use std::sync::Arc;
    use vterminal_lib::models::catalog::LocalFamily;
    use vterminal_lib::provider::local::{last_generation_metrics, LocalLlamaCpp, ReadyModel};
    use vterminal_lib::provider::{
        ChatMessage, ChatParams, Effort, Provider, ProviderEvent, ToolChoiceMode, WebToolPolicy,
    };

    let mut args = std::env::args().skip(1);
    let target = args
        .next()
        .expect("usage: mtp_bench <target.gguf> <qwen|gemma> <draft-tokens> [draft.gguf|-] [runs]");
    let family = match args.next().as_deref() {
        Some("gemma") => LocalFamily::Gemma,
        _ => LocalFamily::Qwen,
    };
    let draft_tokens: u32 = args.next().as_deref().unwrap_or("4").parse()?;
    let draft_path = args.next().filter(|value| value != "-");
    let runs: usize = args.next().as_deref().unwrap_or("5").parse()?;
    std::env::set_var("VTERMINAL_MTP_BENCH_SEED", "424242");

    let mtp_ready = ReadyModel::load_standalone_with_mtp(
        &target,
        draft_path.as_deref(),
        family,
        32_768,
        draft_tokens,
    )?;
    let standard_ready = ReadyModel {
        model_id: mtp_ready.model_id.clone(),
        model: Arc::clone(&mtp_ready.model),
        template: Arc::clone(&mtp_ready.template),
        family: mtp_ready.family,
        context_len: mtp_ready.context_len,
        sampling: mtp_ready.sampling,
        acceleration: mtp_ready.acceleration.clone(),
        mtp: None,
        gate: Arc::clone(&mtp_ready.gate),
    };
    let standard = LocalLlamaCpp {
        ready: standard_ready,
    };
    let mtp = LocalLlamaCpp { ready: mtp_ready };
    let prompt = "You are assisting in a terminal. Explain how to find the ten largest files under the current directory, then provide a safe portable shell command.";

    // Warm both paths before measuring model and kernel initialization effects.
    let _ = run_once(&standard, prompt).await?;
    let _ = run_once(&mtp, prompt).await?;

    let mut rows = Vec::with_capacity(runs * 2);
    for run in 0..runs {
        let standard_text = run_once(&standard, prompt).await?;
        rows.push(serde_json::json!({
            "run": run + 1,
            "mode": "standard",
            "metrics": last_generation_metrics(),
            "resident_memory_bytes": resident_memory_bytes(),
        }));
        let mtp_text = run_once(&mtp, prompt).await?;
        if mtp_text != standard_text {
            return Err("MTP output differed from standard output with the same seed".into());
        }
        rows.push(serde_json::json!({
            "run": run + 1,
            "mode": "mtp",
            "metrics": last_generation_metrics(),
            "resident_memory_bytes": resident_memory_bytes(),
        }));
    }
    println!("{}", serde_json::to_string_pretty(&rows)?);

    async fn run_once(
        provider: &LocalLlamaCpp,
        prompt: &str,
    ) -> Result<String, Box<dyn std::error::Error>> {
        let messages = vec![ChatMessage::user(prompt)];
        let (_cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);
        let (tx, mut rx) = tokio::sync::mpsc::channel(128);
        let future = provider.chat_stream(
            messages,
            Vec::new(),
            ChatParams {
                temperature: Some(0.2),
                max_tokens: Some(256),
                tool_choice: ToolChoiceMode::None,
                effort: Effort::Off,
                web: WebToolPolicy::Disabled,
            },
            cancel_rx,
            tx,
        );
        let receive = async move {
            let mut output = String::new();
            while let Some(event) = rx.recv().await {
                match event {
                    ProviderEvent::TextDelta(text) | ProviderEvent::ReasoningDelta(text) => {
                        output.push_str(&text);
                    }
                    ProviderEvent::Done { .. } => break,
                    _ => {}
                }
            }
            output
        };
        let (result, output) = tokio::join!(future, receive);
        result?;
        Ok(output)
    }

    fn resident_memory_bytes() -> u64 {
        let Ok(pid) = sysinfo::get_current_pid() else {
            return 0;
        };
        let system = sysinfo::System::new_all();
        system.process(pid).map_or(0, sysinfo::Process::memory)
    }

    Ok(())
}

#[cfg(not(feature = "local-llm"))]
fn main() {
    eprintln!("build with --features local-llm");
}
