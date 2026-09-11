//! Native regression check for a downloaded Qwen3.5 2B MTP GGUF.
//!
//! Read JSON from stdin: {"target":"...gguf","backend":"cpu"|"auto",
//! "backend_modules":"optional directory containing packaged GGML modules"}.
//! Optional legacy_target/legacy_family (qwen|gemma) checks a separate model
//! without enabling its MTP artifacts. Otherwise standard decoding reloads target.
//! No model downloads or generated commands are executed. Each request is
//! limited to 48 output tokens (128 for cancellation) and a 4096-token context.

#[cfg(feature = "local-llm")]
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    use std::io::Read;
    use std::path::PathBuf;
    use vterminal_lib::models::catalog::LocalFamily;
    use vterminal_lib::provider::local::{
        configure_backend_modules, last_generation_metrics, GenerationMetrics, LocalLlamaCpp,
        MtpLoadSpec, ReadyModel, StandaloneLoadOptions,
    };
    use vterminal_lib::provider::{
        ChatMessage, ChatParams, Effort, Provider, ProviderError, ProviderEvent, Role, ToolCall,
        ToolChoiceMode, ToolDef, WebToolPolicy,
    };

    struct StderrLogger;
    impl log::Log for StderrLogger {
        fn enabled(&self, metadata: &log::Metadata<'_>) -> bool {
            metadata.level() <= log::Level::Info
        }
        fn log(&self, record: &log::Record<'_>) {
            if self.enabled(record.metadata()) {
                eprintln!("{}: {}", record.level(), record.args());
            }
        }
        fn flush(&self) {}
    }
    static LOGGER: StderrLogger = StderrLogger;
    let _ = log::set_logger(&LOGGER);
    log::set_max_level(log::LevelFilter::Info);

    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Config {
        target: PathBuf,
        backend: String,
        backend_modules: Option<PathBuf>,
        legacy_target: Option<PathBuf>,
        legacy_family: Option<String>,
    }
    let mut input = String::new();
    std::io::stdin()
        .lock()
        .take(16_385)
        .read_to_string(&mut input)?;
    if input.len() > 16_384 {
        return Err("smoke configuration exceeds 16 KiB".into());
    }
    let config: Config = serde_json::from_str(&input)?;
    let cpu_only = match config.backend.as_str() {
        "cpu" => true,
        "auto" => false,
        _ => return Err("backend must be cpu or auto".into()),
    };
    if let Some(path) = config.backend_modules {
        let path = path.canonicalize()?;
        if !path.is_dir() {
            return Err("backend_modules must be a directory".into());
        }
        configure_backend_modules(path);
    }
    let target = canonical_gguf(config.target)?;
    let legacy = config.legacy_target.map(canonical_gguf).transpose()?;
    let standard_family = match config.legacy_family.as_deref() {
        None | Some("qwen") => LocalFamily::Qwen,
        Some("gemma") if legacy.is_some() => LocalFamily::Gemma,
        _ => return Err("legacy_family must be qwen or gemma with a legacy_target".into()),
    };
    let path = target.to_str().ok_or("target path is not valid UTF-8")?;
    std::env::set_var("VTERMINAL_MTP_BENCH_SEED", "424242");

    let ready = ReadyModel::load_standalone_configured(
        path,
        LocalFamily::Qwen,
        4096,
        StandaloneLoadOptions {
            mtp: Some(MtpLoadSpec {
                draft_path: None,
                draft_tokens: 3,
            }),
            cpu_only,
        },
    )?;
    let backend = ready.acceleration.backend.clone();
    if cpu_only && backend != "cpu" {
        return Err(format!("CPU-only smoke selected {backend}").into());
    }
    let provider = LocalLlamaCpp { ready };
    let goal = ChatMessage::user("Call finish with summary set to ok. Do not explain.");
    let first = run_request(&provider, vec![goal.clone()], vec![finish_tool()]).await?;
    require_mtp(&first.metrics)?;
    if first.calls.is_empty() || first.calls.iter().any(|call| call.name != "finish") {
        return Err("agent smoke did not return the requested finish tool call".into());
    }
    let tool_count = first.calls.len();
    let mut assistant = ChatMessage::assistant(first.text);
    assistant.tool_calls = Some(first.calls.clone());
    let mut continuation = vec![goal, assistant];
    for call in first.calls {
        let mut result = ChatMessage::user(r#"{"status":"ok","summary":"ok"}"#);
        result.role = Role::Tool;
        result.tool_call_id = Some(call.id);
        continuation.push(result);
    }
    continuation.push(ChatMessage::user(
        "The tool completed successfully. Reply with a short confirmation.",
    ));
    let continued = run_request(&provider, continuation, Vec::new()).await?;
    require_mtp(&continued.metrics)?;
    if continued.text.trim().is_empty() {
        return Err("agent smoke did not respond after the tool result".into());
    }
    run_cancellation(&provider).await?;
    // This request must acquire the same gate released by the cancelled native
    // worker, proving cancellation did not leave inference permanently blocked.
    let chat = run_request(
        &provider,
        vec![ChatMessage::user("Reply with the word hello.")],
        Vec::new(),
    )
    .await?;
    require_mtp(&chat.metrics)?;
    if chat.text.trim().is_empty() {
        return Err("ordinary chat smoke returned no text".into());
    }
    drop(provider);

    // The default check reloads the current artifact with MTP disabled. A
    // supplied legacy_target instead exercises an actual separate model whose
    // MTP artifacts are not requested, without pretending both are equivalent.
    let standard_target = legacy.as_deref().unwrap_or(&target);
    let standard_provider = LocalLlamaCpp {
        ready: ReadyModel::load_standalone_configured(
            standard_target
                .to_str()
                .ok_or("standard model path is not valid UTF-8")?,
            standard_family,
            4096,
            StandaloneLoadOptions {
                mtp: None,
                cpu_only,
            },
        )?,
    };
    let standard = run_request(
        &standard_provider,
        vec![ChatMessage::user("Reply with the word hello.")],
        Vec::new(),
    )
    .await?;
    if standard.metrics.mode != "standard" || standard.metrics.drafted_tokens != 0 {
        return Err("standard loading unexpectedly entered speculative decoding".into());
    }
    if standard.text.trim().is_empty() {
        return Err("standard chat smoke returned no text".into());
    }
    if cpu_only && standard.metrics.backend != "cpu" {
        return Err("standard CPU-only smoke selected an accelerator".into());
    }
    drop(standard_provider);
    println!(
        "{}",
        serde_json::json!({
            "ok": true, "backend": backend, "mtp": first.metrics,
            "standard": standard.metrics, "repeated_mtp": continued.metrics,
            "chat": chat.metrics, "tool_result_round": {"ok": true, "tool_calls": tool_count},
            "cancellation": {"ok": true, "resumed": true},
            "standard_artifact": if legacy.is_some() { "separate_model" } else { "target_without_mtp" },
        })
    );

    fn canonical_gguf(path: PathBuf) -> Result<PathBuf, Box<dyn std::error::Error>> {
        let path = path.canonicalize()?;
        if !path.is_file() || path.extension().and_then(|value| value.to_str()) != Some("gguf") {
            return Err("model path must be an existing GGUF file".into());
        }
        Ok(path)
    }

    fn finish_tool() -> ToolDef {
        ToolDef {
            name: "finish".into(),
            description: "Return the requested summary.".into(),
            parameters: serde_json::json!({
                "type": "object", "properties": {"summary": {"type": "string"}},
                "required": ["summary"],
            }),
        }
    }

    struct RequestOutput {
        metrics: GenerationMetrics,
        text: String,
        calls: Vec<ToolCall>,
    }

    fn require_mtp(metrics: &GenerationMetrics) -> Result<(), Box<dyn std::error::Error>> {
        if metrics.mode != "mtp" || metrics.drafted_tokens == 0 {
            return Err("MTP smoke fell back or produced no draft tokens".into());
        }
        Ok(())
    }

    async fn run_cancellation(provider: &LocalLlamaCpp) -> Result<(), Box<dyn std::error::Error>> {
        let (cancel_tx, cancel) = tokio::sync::watch::channel(false);
        let (tx, mut rx) = tokio::sync::mpsc::channel(64);
        let request = provider.chat_stream(
            vec![ChatMessage::user(
                "Write a numbered list from 1 to 100, spelling each number out in words. Start immediately and do not stop early.",
            )],
            Vec::new(),
            ChatParams {
                temperature: Some(0.2),
                max_tokens: Some(128),
                tool_choice: ToolChoiceMode::Auto,
                effort: Effort::Off,
                web: WebToolPolicy::Disabled,
            },
            cancel,
            tx,
        );
        let receive = async {
            let mut cancelled_after_text = false;
            while let Some(event) = rx.recv().await {
                if matches!(event, ProviderEvent::TextDelta(ref delta) if !delta.is_empty())
                    && !cancelled_after_text
                {
                    cancel_tx.send(true)?;
                    cancelled_after_text = true;
                }
            }
            Ok::<_, Box<dyn std::error::Error>>(cancelled_after_text)
        };
        let (result, cancelled_after_text) = tokio::join!(request, receive);
        if !cancelled_after_text? || !matches!(result, Err(ProviderError::Cancelled)) {
            return Err("native cancellation did not stop an actively streaming request".into());
        }
        Ok(())
    }

    async fn run_request(
        provider: &LocalLlamaCpp,
        messages: Vec<ChatMessage>,
        tools: Vec<ToolDef>,
    ) -> Result<RequestOutput, Box<dyn std::error::Error>> {
        let (cancel_tx, cancel) = tokio::sync::watch::channel(false);
        let (tx, mut rx) = tokio::sync::mpsc::channel(64);
        let request = provider.chat_stream(
            messages,
            tools,
            ChatParams {
                temperature: Some(0.2),
                max_tokens: Some(48),
                tool_choice: ToolChoiceMode::Auto,
                effort: Effort::Off,
                web: WebToolPolicy::Disabled,
            },
            cancel,
            tx,
        );
        let receive = async {
            let mut text = String::new();
            let mut calls = Vec::new();
            while let Some(event) = rx.recv().await {
                match event {
                    ProviderEvent::TextDelta(delta) => text.push_str(&delta),
                    ProviderEvent::ToolCalls(found) => calls.extend(found),
                    _ => {}
                }
            }
            (text, calls)
        };
        let (result, (text, calls)) = tokio::join!(request, receive);
        drop(cancel_tx);
        result?;
        if text.trim().is_empty() && calls.is_empty() {
            return Err("local model returned no text or tool call".into());
        }
        let metrics = last_generation_metrics().ok_or("native generation metrics missing")?;
        if metrics.completion_tokens == 0 {
            return Err("local model generated zero tokens".into());
        }
        Ok(RequestOutput {
            metrics,
            text,
            calls,
        })
    }
    Ok(())
}

#[cfg(not(feature = "local-llm"))]
fn main() {
    eprintln!("local_inference_smoke requires --features local-llm");
    std::process::exit(2);
}
