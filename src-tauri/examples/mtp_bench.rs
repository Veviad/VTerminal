//! Repeatable standard-versus-MTP benchmark for the real VTerminal provider.
//!
//! Usage:
//! cargo run --release --features local-llm --example mtp_bench -- \
//!   <target.gguf> <qwen|gemma> <draft-tokens> [draft.gguf|-] [runs]

#[cfg(feature = "local-llm")]
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    use std::{ffi::OsString, path::PathBuf, sync::Arc};
    use vterminal_lib::models::catalog::LocalFamily;
    use vterminal_lib::provider::local::{last_generation_metrics, LocalLlamaCpp, ReadyModel};
    use vterminal_lib::provider::{
        ChatMessage, ChatParams, Effort, Provider, ProviderEvent, ToolChoiceMode, WebToolPolicy,
    };

    let usage = "usage: mtp_bench <target.gguf> <qwen|gemma> <draft-tokens> [draft.gguf|-] [runs]";
    let mut args = std::env::args_os().skip(1);
    let target = canonical_gguf(args.next().ok_or(usage)?)?;
    let family_arg = utf8_arg(args.next().ok_or(usage)?, "model family")?;
    let family = match family_arg.as_str() {
        "qwen" => LocalFamily::Qwen,
        "gemma" => LocalFamily::Gemma,
        _ => return Err("model family must be qwen or gemma".into()),
    };
    let draft_tokens: u32 = utf8_arg(args.next().ok_or(usage)?, "draft token limit")?.parse()?;
    if !(1..=8).contains(&draft_tokens) {
        return Err("draft token limit must be between 1 and 8".into());
    }
    let draft_path = match args.next() {
        Some(value) if value != "-" => Some(canonical_gguf(value)?),
        _ => None,
    };
    let runs: usize = args
        .next()
        .map(|value| utf8_arg(value, "run count"))
        .transpose()?
        .as_deref()
        .unwrap_or("5")
        .parse()?;
    if !(5..=50).contains(&runs) {
        return Err("run count must be between 5 and 50".into());
    }
    if args.next().is_some() {
        return Err(usage.into());
    }
    std::env::set_var("VTERMINAL_MTP_BENCH_SEED", "424242");

    let mtp_ready = ReadyModel::load_standalone_with_mtp(
        target
            .to_str()
            .ok_or("target GGUF path is not valid UTF-8")?,
        draft_path
            .as_deref()
            .map(|path| path.to_str().ok_or("draft GGUF path is not valid UTF-8"))
            .transpose()?,
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

    fn utf8_arg(value: OsString, label: &str) -> Result<String, Box<dyn std::error::Error>> {
        value
            .into_string()
            .map_err(|_| format!("{label} must be valid UTF-8").into())
    }

    fn canonical_gguf(value: OsString) -> Result<PathBuf, Box<dyn std::error::Error>> {
        let path = PathBuf::from(value).canonicalize()?;
        if !path.is_file()
            || path
                .extension()
                .and_then(|extension| extension.to_str())
                .is_none_or(|extension| !extension.eq_ignore_ascii_case("gguf"))
        {
            return Err(format!("{} is not a GGUF file", path.display()).into());
        }
        Ok(path)
    }

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
