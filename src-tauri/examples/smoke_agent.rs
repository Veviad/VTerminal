//! End-to-end smoke test for the v2 agent loop, runnable without the Tauri UI:
//! drives the REAL run_agent state machine (tool calling through the GGUF chat
//! template, approval gate, subprocess execution, result feedback) with an
//! auto-approving script in place of the user.
//!
//! Usage: cargo run --features local-llm --example smoke_agent -- <file.gguf> [qwen|gemma]

#[cfg(feature = "local-llm")]
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    use std::sync::Arc;
    use tauri::ipc::{Channel, InvokeResponseBody};
    use vterminal_lib::agent::{run, ApprovalDecision, ApprovalResponse, ApprovalState};

    use vterminal_lib::models::catalog::LocalFamily;
    use vterminal_lib::provider::local::{LocalLlamaCpp, ReadyModel};

    let mut args = std::env::args().skip(1);
    let file = args
        .next()
        .expect("usage: smoke_agent <file.gguf> [qwen|gemma]");
    let family = match args.next().as_deref() {
        Some("gemma") => LocalFamily::Gemma,
        _ => LocalFamily::Qwen,
    };

    let target = "/tmp/vterminal-agent-smoke.txt";
    let _ = std::fs::remove_file(target);

    eprintln!("loading {file}…");
    let provider = LocalLlamaCpp {
        ready: ReadyModel::load_standalone(&file, family, 8192)?,
    };

    let approvals = Arc::new(ApprovalState::default());
    let approvals_for_channel = Arc::clone(&approvals);
    let saw_proposal = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let saw_result = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let saw_done = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let (p, r, d) = (
        Arc::clone(&saw_proposal),
        Arc::clone(&saw_result),
        Arc::clone(&saw_done),
    );

    // The "user": logs every event and auto-approves every proposal.
    let on_event: Channel<vterminal_lib::agent::StreamEvent> =
        Channel::new(move |body: InvokeResponseBody| {
            let InvokeResponseBody::Json(json) = body else {
                return Ok(());
            };
            let Ok(v) = serde_json::from_str::<serde_json::Value>(&json) else {
                return Ok(());
            };
            match v.get("type").and_then(|t| t.as_str()) {
                Some("Delta") => {
                    eprint!(
                        "{}",
                        v.get("content").and_then(|c| c.as_str()).unwrap_or("")
                    );
                }
                // Quiet by default — a thinking trace drowns the events that
                // matter. `SMOKE_VERBOSE=1` shows it, which is the only way to
                // tell "the model said nothing" apart from "the model spent the
                // whole budget reasoning" when a run ends with no tool call.
                Some("ThinkingDelta") if std::env::var_os("SMOKE_VERBOSE").is_some() => {
                    eprint!(
                        "{}",
                        v.get("content").and_then(|c| c.as_str()).unwrap_or("")
                    );
                }
                Some("ThinkingDelta") => {}
                Some("CommandProposal") => {
                    let id = v.get("approval_id").and_then(|c| c.as_str()).unwrap_or("");
                    let cmd = v.get("command").and_then(|c| c.as_str()).unwrap_or("");
                    eprintln!("\n[proposal] {cmd}  → auto-approving");
                    p.store(true, std::sync::atomic::Ordering::SeqCst);
                    let _ = approvals_for_channel.respond(
                        id,
                        ApprovalResponse {
                            decision: ApprovalDecision::Run,
                            edited_command: None,
                        },
                    );
                }
                Some("CommandOutput") => {
                    eprintln!(
                        "[out] {}",
                        v.get("chunk").and_then(|c| c.as_str()).unwrap_or("")
                    );
                }
                Some("CommandResult") => {
                    eprintln!(
                        "[exit {}]",
                        v.get("exit_code").and_then(|c| c.as_i64()).unwrap_or(-1)
                    );
                    r.store(true, std::sync::atomic::Ordering::SeqCst);
                }
                Some("Done") => {
                    d.store(true, std::sync::atomic::Ordering::SeqCst);
                }
                // A guard rail, not a failure. Printed distinctly from Error
                // because that is the whole point of the variant — and without an
                // arm here the catch-all below would swallow it, making a paused
                // run look like one that simply stopped.
                Some("Paused") => {
                    eprintln!(
                        "\n[paused] reason={} steps={} limit={} context={}/{}",
                        v.get("reason").and_then(|c| c.as_str()).unwrap_or(""),
                        v.get("steps").and_then(|c| c.as_i64()).unwrap_or(-1),
                        v.get("limit").and_then(|c| c.as_i64()).unwrap_or(-1),
                        v.get("context_used").and_then(|c| c.as_i64()).unwrap_or(-1),
                        v.get("context_limit")
                            .and_then(|c| c.as_i64())
                            .unwrap_or(-1),
                    );
                }
                Some("Error") => {
                    eprintln!(
                        "\n[error] {}",
                        v.get("message").and_then(|c| c.as_str()).unwrap_or("")
                    );
                }
                _ => {}
            }
            Ok(())
        });

    let (_cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);
    let config = run::AgentConfig {
        request_id: "smoke-agent".into(),
        shell: "/bin/zsh".into(),
        cwd: Some("/tmp".into()),
        temperature: Some(0.2),
        // Off by default to keep the run fast and on-task, but every catalog
        // model ships a *thinking* default effort, so the configuration users
        // actually get needs exercising too: `SMOKE_EFFORT=medium` turns it on.
        // That path differs in kind, not degree — the template prefills a
        // reasoning span the splitter has to be told about.
        effort: std::env::var("SMOKE_EFFORT")
            .ok()
            .and_then(|s| vterminal_lib::provider::Effort::parse(s.trim()))
            .unwrap_or(vterminal_lib::provider::Effort::Off),
        // `SMOKE_MAX_STEPS=2` forces the step-limit pause without editing this
        // file, which is the only way to exercise that path headlessly.
        max_iterations: std::env::var("SMOKE_MAX_STEPS")
            .ok()
            .and_then(|s| s.trim().parse().ok())
            .unwrap_or(6),
        // Generous on purpose: this example exists to exercise tool calling, not
        // the context guard. `SMOKE_CONTEXT_TOKENS=6144` is enough to watch a
        // ContextLimit pause instead — at Off effort the reserve is 5120, so the
        // guard is live and trips once a round's input passes ~1k.
        context_tokens: std::env::var("SMOKE_CONTEXT_TOKENS")
            .ok()
            .and_then(|s| s.trim().parse().ok())
            .unwrap_or(32_768),
        command_timeout_secs: 30,
        // The smoke run drives a local GGUF, which has no server-side web tool
        // for this to switch on anyway.
        web_access: false,
        // Headless: no buckets, so `tools()` offers `run_command` and `finish` only.
        // This example exercises tool calling against a real GGUF, and adding a third
        // tool would change what it is measuring — the `docs` argument below is `None`
        // for the same reason.
        doc_buckets: vec![],
        // Headless: there is no PTY here, so this drives the captured-subprocess
        // path. The app itself always uses ExecTarget::Pty.
        exec_target: run::ExecTarget::Subprocess,
    };
    let system_prompt = format!(
        "{}\n\nOS: macOS\nShell: /bin/zsh\nWorking directory: /tmp",
        vterminal_lib::agent::prompts::AGENT
    );
    let goal = format!(
        "Create the file {target} containing exactly the word hello, then print its contents."
    );

    let pty_exec = vterminal_lib::agent::PtyExecState::default();
    // Headless: nothing can steer this run, but the mailbox still has to exist
    // and be registered or the loop's per-round drain finds no queue at all.
    let steers = vterminal_lib::agent::SteerState::default();
    steers.register(&config.request_id);
    let transcript = run::run_agent(
        &provider,
        config,
        system_prompt,
        goal,
        // Headless: no attachments. The app passes the goal turn's images here.
        vec![],
        // Fresh run: no prior turns. Passing history here is how the app
        // continues a conversation or reopens an archived one.
        vec![],
        &approvals,
        &pty_exec,
        &steers,
        // No Tauri app handle in this headless example; no knowledge buckets are
        // attached, so the knowledge service is never invoked.
        None,
        // No document index headless: there is no app data directory to open one in.
        None,
        cancel_rx,
        &on_event,
    )
    .await
    .map_err(|e| format!("agent loop failed: {e}"))?;

    eprintln!("\n---");
    // The transcript is what makes a run continuable; a run that produced tool
    // calls but handed back nothing would be a silent regression in reopen.
    eprintln!(
        "transcript: {} messages ({} tool results)",
        transcript.len(),
        transcript
            .iter()
            .filter(|m| m.role == vterminal_lib::provider::Role::Tool)
            .count()
    );
    let proposal_ok = saw_proposal.load(std::sync::atomic::Ordering::SeqCst);
    let result_ok = saw_result.load(std::sync::atomic::Ordering::SeqCst);
    let file_content = std::fs::read_to_string(target).unwrap_or_default();
    eprintln!(
        "proposals: {proposal_ok} · executed: {result_ok} · done: {} · file: {:?}",
        saw_done.load(std::sync::atomic::Ordering::SeqCst),
        file_content.trim()
    );
    assert!(
        proposal_ok,
        "expected at least one CommandProposal (tool calling through the GGUF template)"
    );
    assert!(result_ok, "expected at least one executed command");
    assert!(
        file_content.trim().contains("hello"),
        "expected the agent to create {target} containing hello"
    );
    eprintln!("AGENT SMOKE OK");
    let _ = std::fs::remove_file(target);
    Ok(())
}

#[cfg(not(feature = "local-llm"))]
fn main() {
    eprintln!("build with --features local-llm");
}
