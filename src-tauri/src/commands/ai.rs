use tauri::ipc::Channel;
use tauri::{State, Wry};

use crate::agent::context::{SidecarTargets, TerminalContext};
use crate::agent::{prompts, AiState, StreamEvent};
use crate::models::catalog::{self, CatalogModel, Effort, ProviderId};
use crate::provider::{ChatMessage, ChatParams, Provider, ToolChoiceMode};

// One-shot streamed chats plus the agent loop, both over the `Provider` seam.

/// The context window `agent::run`'s pause guard may trust, or 0 to disable it.
///
/// Deliberately NOT `model.context_tokens` verbatim, for two unrelated reasons:
///
/// * A LOCAL model is *loaded* at `min(max_context_tokens, catalog)` — the clamp
///   in `commands::models` — so on the default model the catalog number is 8x the
///   real ceiling (262_144 declared, 32_768 loaded). A guard reading the catalog
///   value would trip at ~257k, long after `provider::local` has already refused
///   the prompt outright, making it inert in exactly the configuration it exists
///   for. This mirrors that clamp and must keep mirroring it.
/// * A REMOTE model's value is ADVISORY: an unprobed server reports
///   `ServerKind::default_context()`, a conservative guess (4096/8192) that is
///   never 0 and often far below what the server really serves. Pausing on a
///   guess would break agent mode against a 128k server — and at low effort the
///   guess is *smaller* than one round's reserve, which inverted the guard so it
///   fired on round 1 at Off/Low and switched off at Medium. So the guard stays
///   off for remote servers and the step cap is the only limit there, preserving
///   the promise in `models::remote` that a wrong value costs a wrong tooltip and
///   never a failed request.
fn agent_context_window(app: &tauri::AppHandle<Wry>, model: &CatalogModel) -> u32 {
    context_window_for(
        model.provider,
        model.context_tokens,
        // Same key and same default as the load clamp in `commands::models`.
        crate::commands::settings::read_u32(app, "max_context_tokens", 32_768),
    )
}

/// The pure half of `agent_context_window`, split out so the three arms can be
/// pinned without an `AppHandle`.
fn context_window_for(provider: ProviderId, catalog_tokens: u32, local_setting: u32) -> u32 {
    match provider {
        ProviderId::Remote => 0,
        ProviderId::Local => local_setting.min(catalog_tokens),
        _ => catalog_tokens,
    }
}

/// The selected model, resolved into something we can actually talk to.
pub struct Resolved {
    pub provider: Box<dyn Provider>,
    pub model: &'static CatalogModel,
    /// The user's stored depth for this model, already clamped to what it takes.
    pub effort: Effort,
}

/// Turn the `active_model_id` setting into a live provider.
///
/// This is the only place that decides local-vs-cloud. Both failure modes are
/// actionable on purpose: an unconfigured API key and an unloaded local model
/// are the two things a user actually has to go do something about.
/// The selected catalog entry, without building a provider for it.
///
/// Split out because asking "can this model reach the web?" must not await the
/// local model host the way `resolve_provider` does — that is a real load for a
/// question about a `bool`.
pub fn active_model(app: &tauri::AppHandle<Wry>) -> &'static CatalogModel {
    // `find_model`, not `catalog::find`: a model served by a configured remote
    // server is not in the static table, and falling back to the default here
    // would answer from the wrong model rather than saying anything.
    crate::models::find_model(app, &default_model_id(app)).unwrap_or_else(|| {
        catalog::find(catalog::DEFAULT_MODEL_ID).expect("default model is in the catalog")
    })
}

fn default_model_id(app: &tauri::AppHandle<Wry>) -> String {
    crate::commands::settings::read_string(app, "active_model_id")
        .unwrap_or_else(|| catalog::DEFAULT_MODEL_ID.to_string())
}

pub async fn resolve_provider(app: &tauri::AppHandle<Wry>) -> Result<Resolved, String> {
    let model = active_model(app);
    resolve_provider_for_model(app, model).await
}

/// Resolve the exact model captured by a caller rather than re-reading the
/// mutable active-model setting after an asynchronous task has been spawned.
/// Runbooks use this to keep their durable execution-environment record tied
/// to the provider that can actually participate in that run.
pub async fn resolve_provider_for_model(
    app: &tauri::AppHandle<Wry>,
    model: &'static CatalogModel,
) -> Result<Resolved, String> {
    let effort = crate::commands::settings::read_effort(app, model);

    if model.provider == ProviderId::Local {
        return resolve_local(app, model, effort).await;
    }
    // Before the API-key gate below: a self-hosted server usually has no key at
    // all, and its token is per-server rather than per-provider.
    if model.provider == ProviderId::Remote {
        return resolve_remote(app, model, effort);
    }

    let key_setting = model
        .provider
        .api_key_setting()
        .ok_or("this model has no API key setting")?;
    let credential_id = crate::credentials::CredentialId::from_setting(key_setting)
        .ok_or("this model has no credential mapping")?;
    let api_key = crate::commands::settings::read_credential(app, credential_id)?
        .filter(|k| !k.expose().trim().is_empty())
        .ok_or_else(|| {
            format!(
                "no {} API key — add one in Settings → Models",
                model.provider.label()
            )
        })?;

    let provider: Box<dyn Provider> = match model.provider {
        ProviderId::Anthropic => {
            Box::new(crate::provider::http::anthropic::AnthropicProvider { model, api_key })
        }
        _ => Box::new(crate::provider::http::openai_compat::OpenAiCompatProvider {
            model,
            endpoint: crate::provider::http::openai_compat::vendor_endpoint(model.provider)
                .ok_or_else(|| format!("{} has no endpoint", model.provider.label()))?
                .to_string(),
            api_key: Some(api_key),
            // The vendors never emit raw `<think>` tags, and splitting them
            // would eat a literal one out of a legitimate answer.
            split_think_tags: false,
        }),
    };
    Ok(Resolved {
        provider,
        model,
        effort,
    })
}

/// A model on a server the user configured. Store reads only — no await, and no
/// network until the request itself.
fn resolve_remote(
    app: &tauri::AppHandle<Wry>,
    model: &'static CatalogModel,
    effort: Effort,
) -> Result<Resolved, String> {
    use crate::models::remote;

    let (server_id, _) = remote::parse_id(model.id)
        .ok_or_else(|| format!("{} is not a valid remote model id", model.id))?;
    let server = remote::read_servers(app)
        .into_iter()
        .find(|s| s.id == server_id)
        // Reachable: `remote_servers_delete` resets `active_model_id`, but a
        // hand-edited settings file or a half-applied write can still land here.
        .ok_or_else(|| {
            format!(
                "the server for {} is no longer configured — re-add it in Settings → Models",
                model.label
            )
        })?;
    let api_key = remote::read_token(app, server_id)?;
    crate::models::remote_probe::ensure_credential_transport(&server.base_url, api_key.is_some())?;

    Ok(Resolved {
        provider: Box::new(crate::provider::http::openai_compat::OpenAiCompatProvider {
            model,
            endpoint: format!("{}/v1/chat/completions", server.base_url),
            // A missing token is NOT an error: keyless is the normal case for a
            // LAN server. A server that does want one answers 401, which says so.
            api_key,
            split_think_tags: true,
        }),
        model,
        effort,
    })
}

#[cfg(feature = "local-llm")]
async fn resolve_local(
    app: &tauri::AppHandle<Wry>,
    model: &'static CatalogModel,
    effort: Effort,
) -> Result<Resolved, String> {
    use tauri::Manager;

    let host = app.state::<crate::provider::local::ModelHost>();
    // Must be awaited, not block_on'd: this runs on the tokio runtime, and
    // blocking on it from inside itself panics or deadlocks.
    let ready = host
        .get_ready()
        .await
        .map_err(|_| "no model loaded — load one in Settings → Models".to_string())?;
    if ready.model_id != model.id {
        return Err(format!(
            "{} is selected but {} is loaded — load it in Settings → Models",
            model.label, ready.model_id
        ));
    }
    Ok(Resolved {
        provider: Box::new(crate::provider::local::LocalLlamaCpp { ready }),
        model,
        effort,
    })
}

#[cfg(not(feature = "local-llm"))]
async fn resolve_local(
    _app: &tauri::AppHandle<Wry>,
    _model: &'static CatalogModel,
    _effort: Effort,
) -> Result<Resolved, String> {
    Err("on-device inference is not available in this build (compile with --features local-llm) — pick an API model in Settings → Models".to_string())
}

#[tauri::command]
pub async fn ai_suggest(
    app: tauri::AppHandle<Wry>,
    ai_state: State<'_, AiState>,
    request_id: String,
    prompt: String,
    context: TerminalContext,
    on_event: Channel<StreamEvent>,
) -> Result<(), String> {
    let messages = vec![
        ChatMessage::system(prompts::SUGGEST),
        ChatMessage::user(format!("{}\nRequest: {}", context.render(), prompt.trim())),
    ];
    // Composer suggestions are always thinking-OFF regardless of the model's
    // configured effort: instant beats deliberate for NL→command.
    run_chat(
        &app,
        &ai_state,
        request_id,
        messages,
        on_event,
        Some(512),
        Some(Effort::Off),
        // NL→command must stay instant; a fetch would defeat the point.
        false,
    )
    .await
}

#[tauri::command]
pub async fn ai_explain(
    app: tauri::AppHandle<Wry>,
    ai_state: State<'_, AiState>,
    request_id: String,
    command: String,
    output_tail: String,
    exit_code: i32,
    context: TerminalContext,
    on_event: Channel<StreamEvent>,
) -> Result<(), String> {
    let messages = vec![
        ChatMessage::system(prompts::EXPLAIN),
        ChatMessage::user(format!(
            "{}\nFailed command (exit {exit_code}):\n$ {command}\n\nOutput:\n{output_tail}",
            context.render()
        )),
    ];
    // Explain reads output already on screen — nothing to fetch.
    run_chat(
        &app,
        &ai_state,
        request_id,
        messages,
        on_event,
        Some(1024),
        None,
        false,
    )
    .await
}

#[derive(serde::Deserialize)]
pub struct HistoryMessage {
    pub role: String,
    pub content: String,
    /// How many images rode on this turn when it was sent. The images themselves
    /// are deliberately gone (see `HISTORY_IMAGE_TURNS` in `agent/history.rs`), so
    /// this is what lets the replayed turn say so instead of reading as if the
    /// user had attached nothing.
    #[serde(default)]
    pub image_count: u8,
    /// How many retrieved document passages rode on this turn when it was sent.
    ///
    /// Same contract as `image_count`, for the same reason. The passages are folded into
    /// `content` on the way out, but they are stripped again before replay: ask mode
    /// replays 12 turns, so three passages per turn would compound into the whole
    /// budget. Stripping without saying so would let the model answer a follow-up as if
    /// the earlier answer had come from nowhere.
    #[serde(default)]
    pub doc_count: u8,
}

/// The turn's images, after the active model has had its say.
///
/// Returns the parts to send plus an optional note to prepend to the user's text.
/// A model that cannot see images gets NEITHER the images nor silence: it is told
/// they existed, for the same reason `prompts::ASK` forbids predicting a command's
/// output. The panel blocks Send in this case, so reaching here means the model
/// was switched between typing and sending — a real race, not a hypothetical.
fn gate_images(
    model: &CatalogModel,
    images: Vec<crate::provider::ImagePart>,
) -> (Vec<crate::provider::ImagePart>, Option<String>) {
    if images.is_empty() {
        return (images, None);
    }
    if !model.supports_vision {
        let note = format!(
            "[{} image{} could not be sent: {} cannot read images]",
            images.len(),
            if images.len() == 1 { "" } else { "s" },
            model.label
        );
        return (Vec::new(), Some(note));
    }
    // The media type originates from bytes the user dropped in. Anything outside
    // the allowlist is a 400, so drop it here where the reason can be stated.
    let (ok, rejected): (Vec<_>, Vec<_>) = images
        .into_iter()
        .partition(|i| crate::provider::ALLOWED_IMAGE_TYPES.contains(&i.media_type.as_str()));
    let note = (!rejected.is_empty()).then(|| {
        format!(
            "[{} attachment{} could not be sent: unsupported image format]",
            rejected.len(),
            if rejected.len() == 1 { "" } else { "s" }
        )
    });
    (ok, note)
}

/// Fold a gate note into the user's own text, note last so the question leads.
fn with_note(prompt: String, note: Option<String>) -> String {
    match note {
        None => prompt,
        Some(note) if prompt.trim().is_empty() => note,
        Some(note) => format!("{prompt}\n\n{note}"),
    }
}

// Plain command, NOT `rename_all`: the existing keys are camelCase (`requestId`,
// `onEvent`) and `images` is one word, so it is spelled the same either way.
#[tauri::command]
pub async fn ai_ask(
    app: tauri::AppHandle<Wry>,
    ai_state: State<'_, AiState>,
    request_id: String,
    prompt: String,
    history: Vec<HistoryMessage>,
    // Images on THIS turn only. `Option` so omitting the key stays legal for a
    // text-only send, matching how `agent_start` treats `history`.
    images: Option<Vec<crate::provider::ImagePart>>,
    context: TerminalContext,
    // Whether THIS turn carries passages retrieved from the user's document buckets,
    // folded into `prompt` by the frontend. `Option` for the same reason as `images`.
    // Only the prompt tier depends on it: the passages themselves are already in
    // `prompt`, so a stale `false` costs the framing paragraph, not the content.
    docs: Option<bool>,
    on_event: Channel<StreamEvent>,
) -> Result<(), String> {
    // Ask mode has no client tools, but a provider with a server-side fetch
    // does the round trip inside the single request — so the tools clause has
    // to match reality per model, or the prompt tells Claude it cannot do the
    // one thing it can.
    let model = active_model(&app);
    let native_web =
        crate::commands::settings::read_bool(&app, "ai_web_access", true) && model.native_web_fetch;
    let mut messages = vec![ChatMessage::system(format!(
        "{}{}{}\n\nCurrent terminal context:\n{}",
        prompts::ASK,
        if native_web {
            prompts::ASK_WEB_NATIVE
        } else {
            prompts::ASK_WEB_NONE
        },
        // Appended only when passages are actually present. Ask mode is deliberately
        // uncached, so a system prompt that varies per turn costs nothing here — unlike
        // the agent path, where it would invalidate the run's cached prefix.
        if docs.unwrap_or(false) {
            prompts::ASK_DOCS
        } else {
            ""
        },
        context.render()
    ))];
    for h in history.iter().rev().take(12).rev() {
        if h.role == "assistant" {
            messages.push(ChatMessage::assistant(h.content.clone()));
            continue;
        }
        // ADDITIVE, not a match ladder. This was a `match` whose image arm was
        // exclusive, which was fine while images were the only thing stripped from
        // history — but a turn can carry images AND retrieved passages, and an
        // exclusive arm would silently drop one of the two notes.
        let mut content = h.content.clone();
        // A past turn's images are gone by design, so say they were there. Silence here
        // is what would let the model answer a follow-up as if it could still see the
        // screenshot.
        if h.image_count > 0 {
            content.push_str(&format!(
                "\n\n[{} image{} were attached to this message]",
                h.image_count,
                if h.image_count == 1 { "" } else { "s" }
            ));
        }
        // Same reasoning, same shape: the passages were stripped before replay (they
        // would compound over 12 turns), so the turn has to say it consulted documents
        // rather than read as if the answer came from nowhere.
        if h.doc_count > 0 {
            content.push_str(&format!(
                "\n\n[{} passage{} from the user's documents {} included with this message]",
                h.doc_count,
                if h.doc_count == 1 { "" } else { "s" },
                if h.doc_count == 1 { "was" } else { "were" }
            ));
        }
        messages.push(ChatMessage::user(content));
    }
    let (images, note) = gate_images(model, images.unwrap_or_default());
    messages.push(ChatMessage::user_with_images(
        with_note(prompt, note),
        images,
    ));
    run_chat(
        &app,
        &ai_state,
        request_id,
        messages,
        on_event,
        Some(2048),
        None,
        true,
    )
    .await
}

/// Collapse whatever the model produced into something that fits a tab label,
/// or reject it. Kept separate from the command so it is unit-testable without a
/// loaded model, and applied unconditionally — a label goes straight into the UI,
/// so "the prompt said not to" is not a guarantee.
fn sanitize_title(raw: &str) -> Result<String, String> {
    // First non-empty line only: a chatty model puts the label first and then
    // explains itself.
    let line = raw
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("");
    let cleaned = line
        .trim_matches(|c: char| {
            c == '"'
                || c == '\''
                || c == '`'
                || c == '*'
                || c == '.'
                || c == ':'
                || c.is_whitespace()
        })
        // Control characters would corrupt the label (and the snapshot
        // fingerprint, which uses them as separators).
        .replace(|c: char| c.is_control(), " ");
    let collapsed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");

    if collapsed.is_empty() {
        return Err("model returned no usable name".to_string());
    }
    // The prompt's own escape hatch for "not enough to go on".
    if collapsed.eq_ignore_ascii_case("unknown") {
        return Err("not enough context to name this session".to_string());
    }
    // A sentence is a refusal or an explanation, not a label.
    if collapsed.split_whitespace().count() > 6 {
        return Err("model returned prose instead of a name".to_string());
    }
    // char_indices, not byte slicing — a multibyte label must not be cut in half.
    let truncated = match collapsed.char_indices().nth(24) {
        Some((idx, _)) => collapsed[..idx].trim_end().to_string(),
        None => collapsed,
    };
    Ok(truncated.to_lowercase())
}

/// Name a tab from a digest of its activity. Returns the label rather than
/// streaming it: the result is a handful of characters, so a channel (and its
/// retain-until-done bookkeeping) would be pure overhead.
#[tauri::command]
pub async fn ai_name_session(
    app: tauri::AppHandle<Wry>,
    ai_state: State<'_, AiState>,
    request_id: String,
    digest: String,
) -> Result<String, String> {
    use crate::provider::{ProviderError, ProviderEvent};

    let resolved = resolve_provider(&app).await?;
    let provider = resolved.provider;

    let messages = vec![
        ChatMessage::system(prompts::NAME_SESSION),
        // Fenced, so a digest containing something that looks like an
        // instruction reads as quoted data rather than as part of the prompt.
        ChatMessage::user(format!(
            "Terminal tab summary:\n```\n{}\n```",
            digest.trim()
        )),
    ];

    let cancel_rx = ai_state.register(&request_id);
    let (tx, mut rx) = tokio::sync::mpsc::channel::<ProviderEvent>(16);
    // Naming is cosmetic: thinking off and a hard token ceiling, so it can never
    // become the slow thing in the app.
    let params = ChatParams {
        temperature: Some(0.3),
        max_tokens: Some(24),
        tool_choice: ToolChoiceMode::None,
        effort: Effort::Off,
        // Naming a tab is cosmetic and must stay cheap: never worth a fetch.
        web_access: false,
    };

    let stream_task = tokio::spawn(async move {
        provider
            .chat_stream(messages, Vec::new(), params, cancel_rx, tx)
            .await
    });

    // Hybrid-reasoning models emit <think> blocks even with thinking disabled.
    let mut filter = ThinkFilter::new();
    let mut out = String::new();
    while let Some(event) = rx.recv().await {
        match event {
            ProviderEvent::TextDelta(delta) => out.push_str(&filter.push(&delta)),
            ProviderEvent::Done { .. } => break,
            _ => {}
        }
    }
    out.push_str(&filter.flush());

    let result = stream_task
        .await
        .map_err(|e| format!("naming task panicked: {e}"))?;
    ai_state.finish(&request_id);

    match result {
        Ok(()) => sanitize_title(&out),
        Err(ProviderError::Cancelled) => Err("cancelled".to_string()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn ai_cancel(
    ai_state: State<'_, AiState>,
    approvals: State<'_, crate::agent::ApprovalState>,
    pty_exec: State<'_, crate::agent::PtyExecState>,
    steers: State<'_, crate::agent::SteerState>,
    request_id: String,
) -> Result<(), String> {
    ai_state.cancel(&request_id);
    // Drop any approval gates the cancelled agent run is still waiting on.
    approvals.drain_for_request(&request_id);
    // …and any command it was still waiting to hear back about from the PTY.
    pty_exec.drain_for_request(&request_id);
    // …and close its steering mailbox, so a message that never reached the model
    // reports as undelivered instead of sitting in a map nothing will read.
    steers.drain_for_request(&request_id);
    Ok(())
}

/// Hand a message to a RUNNING agent turn without cancelling it.
///
/// Not delivered instantly: the loop appends it at the next round boundary,
/// because a user turn between an assistant's tool_calls and their results is a
/// 400 on OpenAI and Anthropic and is silently dropped by Gemma 4's template. A
/// run parked on an approval gate or a long command picks it up when that step
/// ends — which is why the UI says "delivered at the next step" rather than
/// pretending it already arrived.
///
/// Steering grants no new authority: the model still has to call `run_command`,
/// and that still goes through the approval gate.
#[tauri::command(rename_all = "snake_case")]
pub fn agent_steer(
    steers: State<'_, crate::agent::SteerState>,
    request_id: String,
    steer_id: String,
    text: String,
) -> Result<(), String> {
    steers.push(&request_id, steer_id, text)
}

/// The frontend reports what it observed after typing a command into the live
/// terminal. Failing when nothing is pending is normal (the run was cancelled
/// or timed out first), so the caller ignores the error.
#[tauri::command(rename_all = "snake_case")]
pub fn submit_command_result(
    pty_exec: State<'_, crate::agent::PtyExecState>,
    approval_id: String,
    exit_code: Option<i32>,
    output_tail: String,
    duration_ms: u64,
    error: Option<String>,
) -> Result<(), String> {
    pty_exec.respond(
        &approval_id,
        crate::agent::PtyExecResult {
            exit_code,
            output_tail,
            duration_ms,
            error,
        },
    )
}

#[tauri::command(rename_all = "snake_case")]
pub fn respond_to_approval(
    approvals: State<'_, crate::agent::ApprovalState>,
    approval_id: String,
    decision: crate::agent::ApprovalDecision,
    edited_command: Option<String>,
) -> Result<(), String> {
    approvals.respond(
        &approval_id,
        crate::agent::ApprovalResponse {
            decision,
            edited_command,
        },
    )
}

fn agent_terminal_event(outcome: &crate::agent::run::AgentRunOutcome) -> StreamEvent {
    match &outcome.termination {
        crate::agent::run::AgentTermination::Completed => StreamEvent::Done {
            prompt_tokens: outcome.prompt_tokens,
            completion_tokens: outcome.completion_tokens,
        },
        crate::agent::run::AgentTermination::Paused {
            reason,
            steps,
            limit,
            context_used,
            context_limit,
        } => StreamEvent::Paused {
            reason: *reason,
            steps: *steps,
            limit: *limit,
            prompt_tokens: outcome.prompt_tokens,
            completion_tokens: outcome.completion_tokens,
            context_used: *context_used,
            context_limit: *context_limit,
        },
        crate::agent::run::AgentTermination::Cancelled => StreamEvent::Cancelled,
        crate::agent::run::AgentTermination::Failed { message, .. } => StreamEvent::Error {
            message: message.clone(),
        },
    }
}

/// Run one agent turn, returning the model-visible transcript it produced.
///
/// The returned array is what the caller passes back as `history` on the next
/// turn — and what gets archived so a reopened session keeps its memory. The
/// frontend must treat it as OPAQUE: never reorder, never edit a `content`, and
/// never drop an element, because dropping an assistant turn that carries
/// `tool_calls` orphans its tool result and Anthropic answers that with a 400.
/// All trimming and repair happens in `agent::history`.
#[tauri::command]
pub async fn agent_start(
    app: tauri::AppHandle<Wry>,
    ai_state: State<'_, AiState>,
    approvals: State<'_, crate::agent::ApprovalState>,
    pty_exec: State<'_, crate::agent::PtyExecState>,
    steers: State<'_, crate::agent::SteerState>,
    docs: State<'_, crate::docs::db::DocsDb>,
    request_id: String,
    goal: String,
    context: TerminalContext,
    // Optional role-labelled PTYs for Agent Sidecar mode. `context` remains
    // required so every existing/single-terminal caller keeps the same API.
    sidecar_targets: Option<SidecarTargets>,
    // Document buckets the user attached to this session. Same `Option` reasoning as
    // `history` below.
    doc_buckets: Option<Vec<crate::knowledge::KnowledgeBucketRef>>,
    // Prior turns of THIS conversation, in the model's own shape. `Option` rather
    // than a bare `Vec` because tauri deserializes each argument by key and
    // omitting it has to stay legal.
    history: Option<Vec<crate::provider::ChatMessage>>,
    // Images on the goal turn. Same `Option` reasoning as `history`.
    images: Option<Vec<crate::provider::ImagePart>>,
    on_event: Channel<StreamEvent>,
) -> Result<Vec<crate::provider::ChatMessage>, String> {
    if let Some(targets) = &sidecar_targets {
        if let Err(message) = targets.validate() {
            let _ = on_event.send(StreamEvent::Error {
                message: message.clone(),
            });
            return Err(message);
        }
    }

    // Before anything that can await: resolving a local provider loads a GGUF,
    // which takes seconds, and a steer typed in that window must not be refused
    // for a run the user can already see starting.
    steers.register(&request_id);
    let resolved = match resolve_provider(&app).await {
        Ok(r) => r,
        Err(message) => {
            steers.drain_for_request(&request_id);
            let _ = on_event.send(StreamEvent::Error {
                message: message.clone(),
            });
            return Err(message);
        }
    };
    let model_id = resolved.model.label.to_string();
    // The user's switch AND what this model can actually do. Each provider
    // intersects it again with its own catalog entry, so this is a ceiling.
    let web_access = crate::commands::settings::read_bool(&app, "ai_web_access", true);
    let native_web = web_access && resolved.model.native_web_fetch;
    // Gate before the provider box is moved out of `resolved`.
    let (goal_images, gate_note) = gate_images(resolved.model, images.unwrap_or_default());
    let provider = resolved.provider;

    let shell = crate::commands::settings::read_string(&app, "shell_path")
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| crate::commands::settings::default_shell().into());

    // THE agent-facing half of the experimental gate, and the only one that matters:
    // an empty list means `tools()` never adds `search_docs`, so the capability is
    // absent rather than merely discouraged. The `&&` order also means a frontend
    // that kept stale bucket ids across a toggle-off cannot reintroduce them.
    //
    // Read ONCE here, so the tool vector and the system prompt are decided together
    // and stay byte-identical for every round of this run — both live inside the
    // Anthropic cache breakpoint's span.
    let docs_enabled = crate::commands::settings::read_bool(&app, "docs_enabled", false);
    let doc_buckets: Vec<crate::knowledge::KnowledgeBucketRef> = if docs_enabled {
        doc_buckets.unwrap_or_default()
    } else {
        Vec::new()
    };
    let docs_attached = !doc_buckets.is_empty();

    let (rendered_context, command_cwd, exec_target, sidecar_mode) =
        if let Some(targets) = &sidecar_targets {
            (
                targets.render(),
                targets.local.cwd.clone(),
                crate::agent::run::ExecTarget::Sidecar {
                    local_session_id: targets.local.session_id.clone(),
                    remote_session_id: targets.remote.session_id.clone(),
                },
                true,
            )
        } else {
            (
                context.render(),
                context.cwd.clone(),
                crate::agent::run::ExecTarget::Pty {
                    session_id: context.session_id.clone(),
                },
                false,
            )
        };

    let config = crate::agent::run::AgentConfig {
        request_id: request_id.clone(),
        shell,
        cwd: command_cwd,
        temperature: crate::commands::settings::read_f64_opt(&app, "temperature").map(|t| t as f32),
        effort: resolved.effort,
        // Clamped on READ as well as on write: `save_settings` bounds this to
        // 1..=100 but `read_u32` returns a hand-edited `settings.json` verbatim,
        // and the value now feeds both the 3x steer hard cap and a number shown
        // to the user.
        max_iterations: crate::commands::settings::read_u32(&app, "agent_max_iterations", 10)
            .clamp(1, 100),
        context_tokens: agent_context_window(&app, resolved.model),
        command_timeout_secs: u64::from(crate::commands::settings::read_u32(
            &app,
            "agent_command_timeout_secs",
            120,
        )),
        web_access,
        doc_buckets,
        // Always a user-established visible PTY. Sidecar freezes one session id
        // per role; ordinary runs retain their single destination.
        exec_target,
    };
    let history = history.unwrap_or_default();
    let agent_instructions = if sidecar_mode {
        format!("{}\n\n{}", prompts::AGENT, prompts::AGENT_SIDECAR)
    } else {
        prompts::AGENT.to_string()
    };
    // The curl tier is appended separately rather than living in AGENT because a
    // model that holds a real fetch tool must not be told to shell out for the
    // same job. Today no model has one, so every run gets it; the native tier
    // turns this into a branch.
    let mut system_prompt = match (web_access, native_web) {
        // A model with a real fetch tool must not be told to shell out for the
        // same job; a model with neither must not be told it can reach the web.
        (true, true) => format!(
            "{}\n\n{}\n\n{}",
            agent_instructions,
            prompts::AGENT_WEB_NATIVE,
            rendered_context
        ),
        (true, false) => format!(
            "{}\n\n{}\n\n{}",
            agent_instructions,
            prompts::AGENT_WEB_CURL,
            rendered_context
        ),
        // Internet off. This arm used to append nothing, which was harmless only
        // because `ai_web_access` had no writer and could never be false.
        (false, _) => format!(
            "{}\n\n{}\n\n{}",
            agent_instructions,
            prompts::AGENT_WEB_NONE,
            rendered_context
        ),
    };
    // Paired with the tool: appended exactly when `tools()` adds `search_docs`, so the
    // prompt can never describe a tool the model was not given (or stay silent about
    // one it was). There is no "no documents" tier — see `prompts::AGENT_DOCS`.
    if docs_attached {
        system_prompt.push_str(&format!("\n\n{}", prompts::AGENT_DOCS));
    }
    if !history.is_empty() {
        // The transcript describes a world that has moved on: it may contain
        // `exit code: 0` for an `npm run dev` that is no longer running, and after
        // a reopen the shell is genuinely new. Saying so is a correctness
        // requirement — without it the model treats stale state as current.
        system_prompt.push_str(
            "\n\nThis conversation continues earlier turns that are included above as history. \
             Anything they describe as running is NOT still running, and after a reopened \
             session the shell is new and the working directory may differ. Re-check state \
             before relying on it.",
        );
    }
    let cancel_rx = ai_state.register(&request_id);

    let _ = on_event.send(StreamEvent::Started {
        request_id: request_id.clone(),
        model: model_id.clone(),
    });

    let outcome = crate::agent::run::run_agent(
        provider.as_ref(),
        config,
        system_prompt,
        with_note(goal, gate_note),
        goal_images,
        history,
        &approvals,
        &pty_exec,
        &steers,
        Some(&app),
        // Handed over only when a bucket is attached, so a run with none cannot open
        // `docs.db` at all — which is what keeps the flag-off install free of the file.
        if docs_attached { Some(&*docs) } else { None },
        cancel_rx,
        &on_event,
    )
    .await;

    ai_state.finish(&request_id);
    approvals.drain_for_request(&request_id);
    pty_exec.drain_for_request(&request_id);
    steers.drain_for_request(&request_id);

    let _ = on_event.send(agent_terminal_event(&outcome));

    // Metadata only. Do not add goal text, commands, output, document passages,
    // paths or provider error bodies here: this line goes to the durable app log.
    log::info!(
        target: "vterminal::agent",
        "{}",
        outcome.metadata_log_line(&request_id, &model_id),
    );

    // Active-run failures resolve with this checkpointed transcript after their
    // Error event. The frontend can therefore persist and resume the work that
    // happened before the failure. Only provider-resolution/preflight failures
    // above reject the IPC call.
    Ok(outcome.transcript)
}

/// Strips `<think>…</think>` spans from a streamed delta sequence — hybrid
/// thinking models may still open a think block even with /no_think.
struct ThinkFilter {
    in_think: bool,
    carry: String,
}

impl ThinkFilter {
    fn new() -> Self {
        Self {
            in_think: false,
            carry: String::new(),
        }
    }

    fn push(&mut self, delta: &str) -> String {
        self.carry.push_str(delta);
        let mut out = String::new();
        loop {
            if self.in_think {
                if let Some(idx) = self.carry.find("</think>") {
                    self.carry = self.carry[idx + "</think>".len()..].to_string();
                    self.in_think = false;
                } else {
                    // Keep only a tag-length tail in case </think> is split.
                    let keep = self.carry.len().min("</think>".len() - 1);
                    let cut = self.carry.len() - keep;
                    if cut > 0 {
                        let mut boundary = cut;
                        while !self.carry.is_char_boundary(boundary) {
                            boundary -= 1;
                        }
                        self.carry = self.carry[boundary..].to_string();
                    }
                    return out;
                }
            } else if let Some(idx) = self.carry.find("<think>") {
                out.push_str(&self.carry[..idx]);
                self.carry = self.carry[idx + "<think>".len()..].to_string();
                self.in_think = true;
            } else {
                // Emit everything except a possible split "<think>" prefix tail.
                let keep = self.carry.len().min("<think>".len() - 1);
                let mut cut = self.carry.len() - keep;
                while !self.carry.is_char_boundary(cut) {
                    cut -= 1;
                }
                out.push_str(&self.carry[..cut]);
                self.carry = self.carry[cut..].to_string();
                return out;
            }
        }
    }

    fn flush(&mut self) -> String {
        if self.in_think {
            self.carry.clear();
            return String::new();
        }
        std::mem::take(&mut self.carry)
    }
}

/// `effort_override` is for internal fast paths (NL→command suggestions) that
/// must stay instant no matter what the user configured. `None` means "use the
/// model's configured effort".
async fn run_chat(
    app: &tauri::AppHandle<Wry>,
    ai_state: &AiState,
    request_id: String,
    messages: Vec<ChatMessage>,
    on_event: Channel<StreamEvent>,
    max_tokens: Option<u32>,
    effort_override: Option<Effort>,
    // Whether THIS call site permits web access. Intersected below with the
    // user's setting and the model's own capability, so a `true` here is a
    // ceiling rather than a demand.
    allow_web: bool,
) -> Result<(), String> {
    use crate::provider::{ProviderError, ProviderEvent};

    let resolved = match resolve_provider(app).await {
        Ok(r) => r,
        Err(message) => {
            let _ = on_event.send(StreamEvent::Error {
                message: message.clone(),
            });
            return Err(message);
        }
    };
    let label = resolved.model.label.to_string();
    let web_model = resolved.model.native_web_fetch;
    let provider = resolved.provider;
    let effort = effort_override.unwrap_or(resolved.effort);

    let temperature = crate::commands::settings::read_f64_opt(app, "temperature").map(|t| t as f32);
    let cancel_rx = ai_state.register(&request_id);

    let _ = on_event.send(StreamEvent::Started {
        request_id: request_id.clone(),
        model: label,
    });

    let (tx, mut rx) = tokio::sync::mpsc::channel::<ProviderEvent>(64);
    let params = ChatParams {
        temperature,
        max_tokens,
        tool_choice: ToolChoiceMode::None,
        effort,
        web_access: allow_web
            && web_model
            && crate::commands::settings::read_bool(app, "ai_web_access", true),
    };

    let stream_task = tokio::spawn(async move {
        provider
            .chat_stream(messages, Vec::new(), params, cancel_rx, tx)
            .await
    });

    let mut filter = ThinkFilter::new();
    let mut usage = (0u32, 0u32);
    while let Some(event) = rx.recv().await {
        match event {
            ProviderEvent::TextDelta(delta) => {
                let cleaned = filter.push(&delta);
                if !cleaned.is_empty() {
                    let _ = on_event.send(StreamEvent::Delta { content: cleaned });
                }
            }
            ProviderEvent::ReasoningDelta(delta) => {
                let _ = on_event.send(StreamEvent::ThinkingDelta { content: delta });
            }
            ProviderEvent::Usage {
                prompt_tokens,
                completion_tokens,
            } => usage = (prompt_tokens, completion_tokens),
            ProviderEvent::Done { .. } => break,
            ProviderEvent::ToolCalls(_) => {} // ask/explain/suggest expose no tools
        }
    }
    let tail = filter.flush();
    if !tail.is_empty() {
        let _ = on_event.send(StreamEvent::Delta { content: tail });
    }

    let result = stream_task
        .await
        .map_err(|e| format!("stream task panicked: {e}"))?;
    ai_state.finish(&request_id);

    match result {
        Ok(()) => {
            let _ = on_event.send(StreamEvent::Done {
                prompt_tokens: usage.0,
                completion_tokens: usage.1,
            });
            Ok(())
        }
        Err(ProviderError::Cancelled) => {
            let _ = on_event.send(StreamEvent::Cancelled);
            Ok(())
        }
        Err(e) => {
            let message = e.to_string();
            let _ = on_event.send(StreamEvent::Error {
                message: message.clone(),
            });
            Err(message)
        }
    }
}

#[cfg(test)]
mod context_window_tests {
    use super::context_window_for;
    use crate::models::catalog::{self, ProviderId};

    #[test]
    fn a_local_model_is_bounded_by_what_it_was_actually_loaded_with() {
        // The anti-drift pin for `commands::models`' load clamp. The default
        // model declares 262_144 but loads at the `max_context_tokens` setting,
        // so trusting the catalog here made the guard inert 8x too late.
        assert_eq!(
            context_window_for(ProviderId::Local, 262_144, 32_768),
            32_768
        );
        // Raising the setting past what the model advertises cannot exceed it —
        // same `.min()` direction as the load clamp.
        assert_eq!(
            context_window_for(ProviderId::Local, 32_768, 262_144),
            32_768
        );
    }

    #[test]
    fn the_default_model_reports_its_loaded_window_not_its_catalog_window() {
        let default = catalog::find("local/qwen3.5-9b").expect("default model in catalog");
        assert_eq!(default.provider, ProviderId::Local);
        assert!(
            context_window_for(default.provider, default.context_tokens, 32_768)
                < default.context_tokens,
            "the catalog value must not reach the guard for a clamped local model"
        );
    }

    #[test]
    fn a_remote_server_disables_the_guard_entirely() {
        // A configured server's context_tokens is ADVISORY — an unprobed one
        // reports ServerKind::default_context(), 4096 or 8192. Those are guesses,
        // never 0, and smaller than one round's reserve at some effort rungs, so
        // trusting them paused every run at Off/Low while switching the guard off
        // at Medium. 0 means "no guard"; the step cap is the only limit there.
        assert_eq!(context_window_for(ProviderId::Remote, 8_192, 32_768), 0);
        assert_eq!(context_window_for(ProviderId::Remote, 4_096, 32_768), 0);
        assert_eq!(context_window_for(ProviderId::Remote, 128_000, 32_768), 0);
    }

    #[test]
    fn a_cloud_model_is_trusted_verbatim() {
        // Nothing clamps a cloud window locally, and the vendor enforces it.
        assert_eq!(
            context_window_for(ProviderId::Anthropic, 200_000, 32_768),
            200_000
        );
        assert_eq!(
            context_window_for(ProviderId::OpenAi, 400_000, 32_768),
            400_000
        );
        assert_eq!(
            context_window_for(ProviderId::Mistral, 131_072, 32_768),
            131_072
        );
    }
}

#[cfg(test)]
mod agent_terminal_event_tests {
    use super::agent_terminal_event;
    use crate::agent::run::{AgentFailureKind, AgentRunOutcome, AgentRunStats, AgentTermination};
    use crate::agent::PauseReason;

    fn outcome(termination: AgentTermination) -> AgentRunOutcome {
        AgentRunOutcome {
            transcript: Vec::new(),
            termination,
            prompt_tokens: 21,
            completion_tokens: 8,
            stats: AgentRunStats::default(),
            elapsed_ms: 5,
        }
    }

    #[test]
    fn a_failure_maps_to_one_error_event_without_logging_policy_here() {
        let event = agent_terminal_event(&outcome(AgentTermination::Failed {
            kind: AgentFailureKind::Provider,
            message: "provider unavailable".into(),
        }));
        let json = serde_json::to_value(event).unwrap();
        assert_eq!(json["type"], "Error");
        assert_eq!(json["message"], "provider unavailable");
    }

    #[test]
    fn a_pause_keeps_its_reason_limits_and_usage() {
        let event = agent_terminal_event(&outcome(AgentTermination::Paused {
            reason: PauseReason::ContextLimit,
            steps: 4,
            limit: 10,
            context_used: 28_000,
            context_limit: 32_768,
        }));
        let json = serde_json::to_value(event).unwrap();
        assert_eq!(json["type"], "Paused");
        assert_eq!(json["reason"], "context_limit");
        assert_eq!(json["prompt_tokens"], 21);
        assert_eq!(json["completion_tokens"], 8);
        assert_eq!(json["context_used"], 28_000);
    }
}

#[cfg(test)]
mod title_tests {
    use super::sanitize_title;

    #[test]
    fn accepts_a_plain_label() {
        assert_eq!(
            sanitize_title("deploy debugging").unwrap(),
            "deploy debugging"
        );
    }

    #[test]
    fn strips_quoting_and_trailing_punctuation() {
        assert_eq!(sanitize_title("\"log triage\".").unwrap(), "log triage");
        assert_eq!(sanitize_title("`rust build`").unwrap(), "rust build");
    }

    #[test]
    fn takes_only_the_first_line() {
        // A chatty model puts the label first and then explains itself.
        assert_eq!(
            sanitize_title("cargo builds\n\nThis tab is used for...").unwrap(),
            "cargo builds"
        );
    }

    #[test]
    fn lowercases_and_collapses_whitespace() {
        assert_eq!(
            sanitize_title("  Deploy   Debugging  ").unwrap(),
            "deploy debugging"
        );
    }

    #[test]
    fn rejects_prose() {
        assert!(sanitize_title("This tab appears to be used for running tests").is_err());
    }

    #[test]
    fn rejects_the_models_own_escape_hatch() {
        assert!(sanitize_title("unknown").is_err());
        assert!(sanitize_title("Unknown").is_err());
    }

    #[test]
    fn rejects_empty_output() {
        assert!(sanitize_title("").is_err());
        assert!(sanitize_title("   \n  ").is_err());
    }

    #[test]
    fn clamps_length_without_splitting_a_character() {
        // A label of multibyte characters must not be cut mid-character; byte
        // slicing here would panic.
        let out = sanitize_title("ünïcödé ünïcödé ünïcödé").unwrap();
        assert!(out.chars().count() <= 24);
    }

    #[test]
    fn strips_control_characters() {
        // These would corrupt the label and the snapshot fingerprint, which uses
        // control characters as separators.
        let out = sanitize_title("log\u{0001}triage").unwrap();
        assert_eq!(out, "log triage");
    }
}

#[cfg(test)]
mod tests {
    use super::ThinkFilter;

    #[test]
    fn passes_plain_text() {
        let mut f = ThinkFilter::new();
        let mut out = f.push("hello world, this is a long enough delta");
        out.push_str(&f.flush());
        assert_eq!(out, "hello world, this is a long enough delta");
    }

    #[test]
    fn strips_think_block() {
        let mut f = ThinkFilter::new();
        let mut out = String::new();
        out.push_str(&f.push("<think>internal reasoning</think>answer"));
        out.push_str(&f.flush());
        assert_eq!(out, "answer");
    }

    #[test]
    fn strips_split_think_block() {
        let mut f = ThinkFilter::new();
        let mut out = String::new();
        for chunk in ["<thi", "nk>reason", "ing</thi", "nk>ans", "wer"] {
            out.push_str(&f.push(chunk));
        }
        out.push_str(&f.flush());
        assert_eq!(out, "answer");
    }

    #[test]
    fn unterminated_think_is_dropped() {
        let mut f = ThinkFilter::new();
        let mut out = String::new();
        out.push_str(&f.push("<think>never ends"));
        out.push_str(&f.flush());
        assert_eq!(out, "");
    }
}
