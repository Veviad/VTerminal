use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{Manager, Wry};
use tauri_plugin_store::StoreExt;

pub const STORE_NAME: &str = "settings.json";

#[derive(Default)]
struct SettingsCredentialPresence {
    hugging_face: bool,
    anthropic: bool,
    openai: bool,
    mistral: bool,
}

/// Startup needs one metadata-only lookup per settings field and must not read
/// any secret. Keeping that contract behind a `has`-only callback makes it
/// directly testable without constructing a Tauri runtime.
fn settings_credential_presence(
    blocked: bool,
    mut has: impl FnMut(&crate::credentials::CredentialId) -> Result<bool, String>,
) -> SettingsCredentialPresence {
    if blocked {
        return SettingsCredentialPresence::default();
    }
    // The wire format is intentionally boolean. When an item-level check cannot
    // determine presence, treating it as configured avoids turning "unknown"
    // into a false "missing" signal that invites an unnecessary overwrite.
    // Actual secret use still reports the precise access error.
    let mut present = |id| has(&id).unwrap_or(true);
    SettingsCredentialPresence {
        hugging_face: present(crate::credentials::CredentialId::HuggingFace),
        anthropic: present(crate::credentials::CredentialId::Anthropic),
        openai: present(crate::credentials::CredentialId::OpenAi),
        mistral: present(crate::credentials::CredentialId::Mistral),
    }
}

/// Cowork pattern: every key is read with an inline default so the frontend
/// always receives a complete settings object.
#[tauri::command]
pub fn get_settings(app: tauri::AppHandle<Wry>) -> Result<Value, String> {
    let store = app.store(STORE_NAME).map_err(|e| e.to_string())?;
    let get = |key: &str, default: Value| store.get(key).unwrap_or(default);
    let credentials = crate::credentials::state(&app);
    let presence = settings_credential_presence(credentials.is_blocked(), |id| credentials.has(id));
    // A presence call can discover a genuinely unavailable Keychain and set the
    // global block, so read status after the snapshot rather than before it.
    let credential_store_blocked = credentials.is_blocked();
    Ok(json!({
        "theme": get("theme", json!("veviad-developer")),
        "font_size": get("font_size", json!(13)),
        "scrollback_lines": get("scrollback_lines", json!(10000)),
        "cursor_style": get("cursor_style", json!("block")),
        "cursor_blink": get("cursor_blink", json!(true)),
        "copy_on_select": get("copy_on_select", json!(false)),
        "shell_path": get("shell_path", Value::Null),
        "shell_integration_enabled": get("shell_integration_enabled", json!(true)),
        "active_model_id": json!(active_model_id(&store)),
        // null = use the model's own default (a GGUF's `general.sampling.temp`,
        // or the provider's). Only an explicit value overrides.
        "temperature": get("temperature", Value::Null),
        "max_context_tokens": get("max_context_tokens", json!(32768)),
        // On by default: a terminal whose AI is unavailable until you visit
        // Settings is a terminal whose AI you forget exists.
        "auto_load_model_on_start": get("auto_load_model_on_start", json!(true)),
        // The on-device vision sidecar. `null` = none chosen.
        "vision_model_id": get("vision_model_id", Value::Null),
        // `null` = use the chosen model's own `default_prompt`, which differs by
        // family: an OCR specialist is asked to transcribe, a general VLM to
        // describe.
        "vision_prompt": get("vision_prompt", Value::Null),
        // ON by default, exactly like `auto_load_model_on_start` above and for the
        // same reason its comment gives. It only does anything once
        // `vision_model_id` is set, and setting that is a deliberate act — so that
        // choice IS the signal this reader is wanted. A reader you picked that is
        // not there after a restart is one you stop trusting.
        "vision_auto_load_on_start": get("vision_auto_load_on_start", json!(true)),
        "has_hf_token": json!(presence.hugging_face),
        "models_dir": get("models_dir", Value::Null),
        // API keys are write-only: report presence, never the value.
        "has_anthropic_api_key": json!(presence.anthropic),
        "has_openai_api_key": json!(presence.openai),
        "has_mistral_api_key": json!(presence.mistral),
        "credential_store_status": if credential_store_blocked { "blocked" } else { "ready" },
        "history_enabled": get("history_enabled", json!(true)),
        "history_capture_output": get("history_capture_output", json!(true)),
        "send_context_to_ai": get("send_context_to_ai", json!(true)),
        "ai_session_naming": get("ai_session_naming", json!(true)),
        "restore_sessions_on_start": get("restore_sessions_on_start", json!(true)),
        "restore_scrollback_lines": get("restore_scrollback_lines", json!(1000)),
        "archive_enabled": get("archive_enabled", json!(true)),
        "archive_max_sessions": get("archive_max_sessions", json!(50)),
        "archive_max_age_days": get("archive_max_age_days", json!(30)),
        // Reasoning depth is per-model now — see `get_model_effort`.
        // Last-state, not a preference: whatever the panel was when you quit.
        "ai_panel_open": get("ai_panel_open", json!(true)),
        // Last workspace, not a preference. Existing installs start exactly as
        // before; Chat becomes sticky only after the user opens it once.
        "workspace_mode": get("workspace_mode", json!("terminal")),
        "active_chat_id": get("active_chat_id", Value::Null),
        // A SHARE of the window, so the panel keeps its proportion when the window
        // is resized. Null means "never dragged": the frontend then derives the
        // ratio from `ai_panel_width` below, which is the one-time migration and
        // the fresh-install default at once.
        "ai_panel_ratio": get("ai_panel_ratio", Value::Null),
        // LEGACY, read-only — no longer written. Kept as the migration source for
        // anyone whose settings.json predates `ai_panel_ratio`.
        "ai_panel_width": get("ai_panel_width", json!(420)),
        "agent_max_iterations": get("agent_max_iterations", json!(10)),
        "agent_command_timeout_secs": get("agent_command_timeout_secs", json!(120)),
        "agent_command_policy_rules": get("agent_command_policy_rules", json!([])),
        // Read since the web tiers landed (commands::ai) but never writable, so
        // it was pinned at this default. Default stays `true`: flipping it would
        // silently take the web away from every existing install on upgrade.
        "ai_web_access": get("ai_web_access", json!(true)),
        // The user's own standing instructions, APPENDED to the built-in system
        // prompt of the conversational surfaces — never replacing it. `null` on a
        // fresh install, which is what keeps the default prompt byte-identical to
        // what it was before the feature existed. See `agent::instructions` for
        // why the built-ins are not editable and why the one-shot helpers
        // (suggest / explain / tab naming / runbook authoring) are excluded.
        crate::agent::instructions::GLOBAL_KEY: get(crate::agent::instructions::GLOBAL_KEY, Value::Null),
        crate::agent::instructions::AGENT_KEY: get(crate::agent::instructions::AGENT_KEY, Value::Null),
        crate::agent::instructions::CHAT_KEY: get(crate::agent::instructions::CHAT_KEY, Value::Null),
        // Experimental and opt-in: upgrading an existing install must never
        // start release traffic or prompts without the user's choice.
        "auto_update_enabled": get("auto_update_enabled", json!(false)),
        // Document buckets: EXPERIMENTAL, and the only setting in this table that
        // defaults OFF for a reason other than "no value chosen yet". It is the
        // real gate, not UI sugar — `commands::ai` omits the `search_docs` tool
        // and its prompt section entirely while this is false, and every `docs_*`
        // command refuses. So a default install has no retrieval capability, no
        // `docs.db` on disk, and no new surface reachable from a stale frontend.
        "docs_enabled": get("docs_enabled", json!(false)),
        // Reusable Runbooks are experimental and can execute commands in the
        // active terminal. Keep the backend capability unreachable until the
        // user explicitly opts in; every `runbooks_*` command enforces this.
        "runbooks_enabled": get("runbooks_enabled", json!(false)),
        // How much terminal output a run keeps as an audit record. This is a
        // FLOOR, not the mode: preflight may raise a single run above it and
        // may never drop below it. `runbook` defers to the package and is the
        // default because it reproduces the pre-policy behaviour exactly.
        "runbooks_output_recording": get("runbooks_output_recording", json!("runbook")),
        "log_level": get("log_level", json!("info")),
    }))
}

#[tauri::command(rename_all = "snake_case")]
pub fn remember_command_policy_rule(
    app: tauri::AppHandle<Wry>,
    command: String,
    effect: crate::agent::policy::PolicyRuleEffect,
    scope: String,
) -> Result<Vec<crate::agent::policy::CommandPolicyRule>, String> {
    let mut rules = read_command_policy_rules(&app);
    let patterns = crate::agent::policy::exact_argv_patterns(&command)?;
    for argv in patterns {
        rules.push(crate::agent::policy::CommandPolicyRule {
            id: format!("rule-{}", uuid::Uuid::new_v4()),
            effect,
            scope: scope.clone(),
            argv,
            enabled: true,
            description: "Saved from an agent approval".into(),
        });
    }
    validate_command_policy_rules(&rules)?;
    let store = app.store(STORE_NAME).map_err(|error| error.to_string())?;
    store.set("agent_command_policy_rules", json!(rules));
    store.save().map_err(|error| error.to_string())?;
    Ok(rules)
}

#[allow(clippy::too_many_arguments)]
#[tauri::command(rename_all = "snake_case")]
pub fn save_settings(
    app: tauri::AppHandle<Wry>,
    theme: Option<String>,
    font_size: Option<u32>,
    scrollback_lines: Option<u32>,
    cursor_style: Option<String>,
    cursor_blink: Option<bool>,
    copy_on_select: Option<bool>,
    // Clearable strings: JSON null is indistinguishable from "missing" once
    // serde sees Option, so an EMPTY STRING clears the stored value.
    shell_path: Option<String>,
    shell_integration_enabled: Option<bool>,
    active_model_id: Option<String>,
    temperature: Option<f64>,
    max_context_tokens: Option<u32>,
    auto_load_model_on_start: Option<bool>,
    vision_model_id: Option<String>,
    vision_prompt: Option<String>,
    vision_auto_load_on_start: Option<bool>,
    hf_token: Option<String>,
    models_dir: Option<String>,
    anthropic_api_key: Option<String>,
    openai_api_key: Option<String>,
    mistral_api_key: Option<String>,
    history_enabled: Option<bool>,
    history_capture_output: Option<bool>,
    send_context_to_ai: Option<bool>,
    ai_session_naming: Option<bool>,
    restore_sessions_on_start: Option<bool>,
    restore_scrollback_lines: Option<u32>,
    archive_enabled: Option<bool>,
    archive_max_sessions: Option<u32>,
    archive_max_age_days: Option<u32>,
    ai_panel_open: Option<bool>,
    workspace_mode: Option<String>,
    active_chat_id: Option<String>,
    ai_panel_ratio: Option<f64>,
    agent_max_iterations: Option<u32>,
    agent_command_timeout_secs: Option<u32>,
    agent_command_policy_rules: Option<Vec<crate::agent::policy::CommandPolicyRule>>,
    ai_web_access: Option<bool>,
    // Clearable strings, like `shell_path` above: an empty string clears them.
    custom_instructions: Option<String>,
    agent_custom_instructions: Option<String>,
    chat_custom_instructions: Option<String>,
    auto_update_enabled: Option<bool>,
    docs_enabled: Option<bool>,
    runbooks_enabled: Option<bool>,
    runbooks_output_recording: Option<String>,
    log_level: Option<String>,
) -> Result<(), String> {
    let store = app.store(STORE_NAME).map_err(|e| e.to_string())?;
    let runbooks_gate_change = runbooks_enabled;
    let docs_gate_enabled = docs_enabled.is_some_and(|next| {
        next && !store
            .get("docs_enabled")
            .and_then(|value| value.as_bool())
            .unwrap_or(false)
    });

    // Credentials never enter the JSON store. Do these first so a Keychain
    // failure cannot make a mixed request appear successful.
    let credentials = crate::credentials::state(&app);
    for (id, value) in [
        (crate::credentials::CredentialId::HuggingFace, hf_token),
        (
            crate::credentials::CredentialId::Anthropic,
            anthropic_api_key,
        ),
        (crate::credentials::CredentialId::OpenAi, openai_api_key),
        (crate::credentials::CredentialId::Mistral, mistral_api_key),
    ] {
        if let Some(value) = value {
            credentials.set_or_clear(&id, value)?;
        }
    }

    if let Some(v) = theme {
        store.set("theme", json!(v));
    }
    if let Some(v) = font_size {
        store.set("font_size", json!(v.clamp(10, 20)));
    }
    if let Some(v) = scrollback_lines {
        store.set("scrollback_lines", json!(v.clamp(200, 100_000)));
    }
    if let Some(v) = cursor_style {
        if !["block", "bar", "underline"].contains(&v.as_str()) {
            return Err(format!("invalid cursor_style: {v}"));
        }
        store.set("cursor_style", json!(v));
    }
    if let Some(v) = cursor_blink {
        store.set("cursor_blink", json!(v));
    }
    if let Some(v) = copy_on_select {
        store.set("copy_on_select", json!(v));
    }
    let clearable = |v: String| {
        if v.trim().is_empty() {
            Value::Null
        } else {
            Value::from(v)
        }
    };
    if let Some(v) = shell_path {
        store.set("shell_path", clearable(v));
    }
    if let Some(v) = shell_integration_enabled {
        store.set("shell_integration_enabled", json!(v));
    }
    if let Some(v) = active_model_id {
        // Reject anything outside the allowlist rather than storing a value
        // that would fail to resolve on the next request. `find_model` widens
        // that allowlist to include enabled models on configured servers.
        if crate::models::find_model(&app, &v).is_none() {
            return Err(format!("unknown model: {v}"));
        }
        store.set("active_model_id", json!(v));
    }
    if let Some(v) = temperature {
        // Negative clears the override back to "use the model's own".
        store.set(
            "temperature",
            if v < 0.0 {
                Value::Null
            } else {
                json!(v.clamp(0.0, 2.0))
            },
        );
    }
    if let Some(v) = max_context_tokens {
        store.set("max_context_tokens", json!(v.clamp(2048, 262_144)));
    }
    if let Some(v) = auto_load_model_on_start {
        store.set("auto_load_model_on_start", json!(v));
    }
    if let Some(v) = vision_model_id {
        // Same allowlist discipline as `active_model_id`: an id the app does not
        // offer must not reach the loader.
        if v.trim().is_empty() {
            store.set("vision_model_id", Value::Null);
        } else if crate::models::vision::find(&v).is_some() {
            store.set("vision_model_id", json!(v));
        } else {
            return Err(format!("unknown vision model: {v}"));
        }
    }
    if let Some(v) = vision_prompt {
        store.set("vision_prompt", clearable(v));
    }
    if let Some(v) = vision_auto_load_on_start {
        store.set("vision_auto_load_on_start", json!(v));
    }
    if let Some(v) = models_dir {
        store.set("models_dir", clearable(v));
    }
    if let Some(v) = history_enabled {
        store.set("history_enabled", json!(v));
    }
    if let Some(v) = history_capture_output {
        store.set("history_capture_output", json!(v));
    }
    if let Some(v) = send_context_to_ai {
        store.set("send_context_to_ai", json!(v));
    }
    if let Some(v) = ai_session_naming {
        store.set("ai_session_naming", json!(v));
    }
    if let Some(v) = restore_sessions_on_start {
        store.set("restore_sessions_on_start", json!(v));
    }
    if let Some(v) = restore_scrollback_lines {
        // 0 = restore tabs and directories but capture no terminal output.
        store.set("restore_scrollback_lines", json!(v.clamp(0, 10_000)));
    }
    if let Some(v) = archive_enabled {
        store.set("archive_enabled", json!(v));
    }
    if let Some(v) = archive_max_sessions {
        // 0 = keep nothing, matching restore_scrollback_lines' "0 means off".
        store.set("archive_max_sessions", json!(v.clamp(0, 1000)));
    }
    if let Some(v) = archive_max_age_days {
        // Floor of 1, NOT 0. For a line count 0 naturally means "off", but for an
        // age limit 0 would have to mean "unlimited" — the opposite polarity.
        // Shipping two settings whose zero means opposite things is how a support
        // ticket gets written; "keep forever" can have its own toggle if wanted.
        store.set("archive_max_age_days", json!(v.clamp(1, 3650)));
    }
    if let Some(v) = ai_panel_open {
        store.set("ai_panel_open", json!(v));
    }
    if let Some(v) = workspace_mode {
        if !["terminal", "chat"].contains(&v.as_str()) {
            return Err(format!("invalid workspace_mode: {v}"));
        }
        store.set("workspace_mode", json!(v));
    }
    if let Some(v) = active_chat_id {
        store.set("active_chat_id", clearable(v));
    }
    if let Some(v) = ai_panel_ratio {
        // A share, not pixels — see `lib/panelRatio.ts`, whose bounds these mirror.
        // The ceiling is half the window, so the terminal always keeps the other
        // half; the 320px floor below which the composer is unusable is a pixel
        // rule and therefore lives in the CSS clamp, not here.
        store.set("ai_panel_ratio", json!(v.clamp(0.1, 0.5)));
    }
    if let Some(v) = agent_max_iterations {
        // The real ceiling is the model's context window, not this number: every
        // round appends an assistant turn plus a tool result of up to
        // `exec::MODEL_TAIL` (8 KiB), and the in-run transcript is never trimmed
        // (`history::normalize` only guards STORED history). So a 100-step run
        // is reachable on a 200k cloud model and will die of context on a 32k
        // local one — long before it spends its steps. Which is why raising this
        // ceiling would be cosmetic, and why `agent::run` pauses on the context
        // window too: whichever limit binds first, the run stops resumably rather
        // than on a provider 400.
        //
        // Also clamped on READ (`commands::ai`), since a hand-edited settings.json
        // reaches `read_u32` unfiltered.
        store.set("agent_max_iterations", json!(v.clamp(1, 100)));
    }
    if let Some(v) = agent_command_timeout_secs {
        store.set("agent_command_timeout_secs", json!(v.clamp(5, 3600)));
    }
    if let Some(rules) = agent_command_policy_rules {
        validate_command_policy_rules(&rules)?;
        store.set("agent_command_policy_rules", json!(rules));
    }
    if let Some(v) = ai_web_access {
        store.set("ai_web_access", json!(v));
    }
    // Validated, not clamped. `sanitize` REJECTS anything over the cap rather
    // than truncating it: a number that is clamped loses nothing a user can
    // notice, and a paragraph that is silently cut in half loses the half that
    // mattered. The three run before `store.save()` below, so a rejected field
    // takes the whole request with it and the UI's mirror stays truthful.
    for (key, value) in [
        (crate::agent::instructions::GLOBAL_KEY, custom_instructions),
        (
            crate::agent::instructions::AGENT_KEY,
            agent_custom_instructions,
        ),
        (
            crate::agent::instructions::CHAT_KEY,
            chat_custom_instructions,
        ),
    ] {
        if let Some(raw) = value {
            match crate::agent::instructions::sanitize(&raw)? {
                Some(text) => store.set(key, json!(text)),
                None => store.set(key, Value::Null),
            }
        }
    }
    if let Some(v) = auto_update_enabled {
        store.set("auto_update_enabled", json!(v));
    }
    if let Some(v) = docs_enabled {
        store.set("docs_enabled", json!(v));
    }
    if let Some(v) = runbooks_enabled {
        store.set("runbooks_enabled", json!(v));
    }
    if let Some(v) = runbooks_output_recording {
        // Parse rather than allowlist a literal array: `EvidenceRecordingPolicy`
        // owns these spellings, and an unknown value must be rejected here
        // instead of silently falling back to the inline default on the next
        // read, which would look like the setting had simply not been saved.
        v.parse::<crate::runbooks::state::EvidenceRecordingPolicy>()?;
        store.set("runbooks_output_recording", json!(v));
    }
    if let Some(v) = log_level {
        store.set("log_level", json!(v));
    }

    store.save().map_err(|e| e.to_string())?;
    if let Some(v) = runbooks_gate_change {
        if let Some(command_state) =
            app.try_state::<std::sync::Arc<crate::commands::runbooks::RunbookCommandState>>()
        {
            if v {
                command_state.cancellations.enable();
            } else {
                command_state.cancellations.cancel_all();
                command_state.pty.cancel_all();
            }
        }
    }
    secure_settings_permissions(&app)?;
    if docs_gate_enabled {
        crate::knowledge::ingest::resume_pending_jobs(&app)?;
    }
    Ok(())
}

fn secure_settings_permissions(app: &tauri::AppHandle<Wry>) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        use tauri::Manager;
        let path = app
            .path()
            .app_data_dir()
            .map_err(|_| "could not secure settings file".to_string())?
            .join(STORE_NAME);
        if path.exists() {
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
                .map_err(|_| "could not secure settings file".to_string())?;
        }
    }
    #[cfg(target_os = "windows")]
    {
        let path = app
            .path()
            .app_data_dir()
            .map_err(|_| "could not secure settings file".to_string())?
            .join(STORE_NAME);
        if path.exists() {
            crate::windows_fs::restrict_to_current_user(&path)
                .map_err(|_| "could not secure settings file".to_string())?;
        }
    }
    Ok(())
}

// ------------------------------------------------ active model + per-model effort

/// The selected catalog id, migrating a pre-catalog `local_model_id` on the fly.
///
/// The old setting held a `repo_id::filename` pair from the download registry,
/// which is a different namespace from catalog ids — resolving it here means an
/// upgrading user keeps their model instead of being silently reset.
fn active_model_id(store: &std::sync::Arc<tauri_plugin_store::Store<Wry>>) -> String {
    // Validated against the catalog AND the configured servers, whose records
    // live in this same store — hence `read_servers_from`, which takes the store
    // this function already holds rather than opening a second handle.
    let servers = crate::models::remote::read_servers_from(store);
    let current = store
        .get("active_model_id")
        .and_then(|v| v.as_str().map(String::from))
        .filter(|id| {
            crate::models::catalog::find(id).is_some()
                || crate::models::remote::find_in(&servers, id).is_some()
        });
    if let Some(id) = current {
        return id;
    }
    store
        .get("local_model_id")
        .and_then(|v| v.as_str().map(String::from))
        .and_then(|legacy| crate::models::catalog::find_by_legacy_local_id(&legacy))
        .map(|m| m.id.to_string())
        .unwrap_or_else(|| crate::models::catalog::DEFAULT_MODEL_ID.to_string())
}

/// Point the app at a different model from the backend.
///
/// Only used to un-select a model whose server just went away: leaving a stale id
/// stored would have the next request resolve against a server that no longer
/// exists. Does NOT validate — the caller supplies a known-good id, and the point
/// is to recover from an id that is no longer valid.
pub fn write_active_model_id(app: &tauri::AppHandle<Wry>, model_id: &str) -> Result<(), String> {
    let store = app.store(STORE_NAME).map_err(|e| e.to_string())?;
    store.set("active_model_id", json!(model_id));
    store.save().map_err(|e| e.to_string())
}

/// Reasoning effort per model, as `{ "<catalog id>": "high", … }`.
///
/// Deliberately NOT part of `save_settings`: that command is a flat list of
/// scalar `Option`s, and threading a map through it would turn every single-key
/// write into a read-modify-write race against concurrent writers.
#[tauri::command]
pub fn get_model_effort(app: tauri::AppHandle<Wry>) -> Result<Value, String> {
    let store = app.store(STORE_NAME).map_err(|e| e.to_string())?;
    Ok(store
        .get("model_effort")
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({})))
}

#[tauri::command(rename_all = "snake_case")]
pub fn set_model_effort(
    app: tauri::AppHandle<Wry>,
    model_id: String,
    effort: String,
) -> Result<(), String> {
    let model = crate::models::find_model(&app, &model_id)
        .ok_or_else(|| format!("unknown model: {model_id}"))?;
    let parsed = crate::models::catalog::Effort::parse(&effort)
        .ok_or_else(|| format!("invalid effort: {effort}"))?;
    // Store the clamped value, so what is persisted is always something this
    // model can actually be asked for.
    let clamped = model.clamp_effort(parsed);

    let store = app.store(STORE_NAME).map_err(|e| e.to_string())?;
    let mut map = store
        .get("model_effort")
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();
    map.insert(model_id, json!(clamped.as_str()));
    store.set("model_effort", Value::Object(map));
    store.save().map_err(|e| e.to_string())
}

/// Backend-side read of the effort for one model, already clamped.
pub fn read_effort(
    app: &tauri::AppHandle<Wry>,
    model: &crate::models::catalog::CatalogModel,
) -> crate::models::catalog::Effort {
    let stored = app
        .store(STORE_NAME)
        .ok()
        .and_then(|s| s.get("model_effort"))
        .and_then(|v| v.get(model.id).and_then(|e| e.as_str()).map(String::from))
        .and_then(|s| crate::models::catalog::Effort::parse(&s));
    model.effective_effort(stored)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TerminalBackend {
    WslConpty,
    NativePty,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ShellFamily {
    Bash,
    Zsh,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub enum WslStatus {
    Ready,
    Missing,
    Wsl1,
    #[cfg(target_os = "windows")]
    MissingBash,
    #[cfg(target_os = "windows")]
    MissingTools,
    Error,
    #[cfg(not(target_os = "windows"))]
    NotApplicable,
}

#[cfg(any(target_os = "windows", test))]
const WSL_REQUIRED_TOOLS_PROBE: &str = "test -x /bin/sh && test -x /bin/true && test -x /usr/bin/env && test -x /usr/bin/setsid && test -x /usr/bin/printf && for tool in base64 tr grep ps awk sort sleep; do command -v \"$tool\" >/dev/null || exit 1; done";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LocalAccelerationInfo {
    pub backend: String,
    pub device_name: Option<String>,
    pub device_memory_bytes: Option<u64>,
    pub fallback_reason: Option<String>,
    #[serde(default)]
    pub generation_mode: Option<String>,
    #[serde(default)]
    pub generation_fallback_reason: Option<String>,
}

#[cfg(any(feature = "local-llm", test))]
fn aggregate_local_acceleration(
    snapshots: Vec<(&'static str, LocalAccelerationInfo)>,
) -> LocalAccelerationInfo {
    let active: Vec<_> = snapshots
        .into_iter()
        .filter(|(_, acceleration)| acceleration.backend != "unloaded")
        .collect();
    let Some((_, first)) = active.first() else {
        return LocalAccelerationInfo {
            backend: "unloaded".into(),
            device_name: None,
            device_memory_bytes: None,
            fallback_reason: None,
            generation_mode: None,
            generation_fallback_reason: None,
        };
    };
    if active.len() == 1 {
        return first.clone();
    }

    let same_device = active.iter().all(|(_, acceleration)| {
        acceleration.backend == first.backend
            && acceleration.device_name == first.device_name
            && acceleration.device_memory_bytes == first.device_memory_bytes
    });
    let labeled_fallbacks = active
        .iter()
        .filter_map(|(host, acceleration)| {
            acceleration
                .fallback_reason
                .as_deref()
                .map(|reason| format!("{host}: {reason}"))
        })
        .collect::<Vec<_>>();
    if same_device {
        let mut aggregate = first.clone();
        aggregate.fallback_reason = if active
            .iter()
            .all(|(_, value)| value.fallback_reason.as_deref() == first.fallback_reason.as_deref())
        {
            first.fallback_reason.clone()
        } else if labeled_fallbacks.is_empty() {
            None
        } else {
            Some(labeled_fallbacks.join("; "))
        };
        return aggregate;
    }

    let active_devices = active
        .iter()
        .map(
            |(host, acceleration)| match acceleration.device_name.as_deref() {
                Some(device) => format!("{host}: {} ({device})", acceleration.backend),
                None => format!("{host}: {}", acceleration.backend),
            },
        )
        .collect::<Vec<_>>()
        .join("; ");
    LocalAccelerationInfo {
        backend: "mixed".into(),
        device_name: Some(active_devices),
        device_memory_bytes: None,
        fallback_reason: (!labeled_fallbacks.is_empty()).then(|| labeled_fallbacks.join("; ")),
        generation_mode: None,
        generation_fallback_reason: None,
    }
}

#[cfg(feature = "local-llm")]
fn decode_host_acceleration(host: &str, value: serde_json::Value) -> LocalAccelerationInfo {
    serde_json::from_value(value).unwrap_or_else(|error| LocalAccelerationInfo {
        backend: "unknown".into(),
        device_name: None,
        device_memory_bytes: None,
        fallback_reason: Some(format!("could not read {host} accelerator status: {error}")),
        generation_mode: None,
        generation_fallback_reason: None,
    })
}

#[derive(Debug, Clone, Serialize)]
pub struct SystemInfo {
    pub total_ram_bytes: u64,
    pub os: &'static str,
    pub arch: &'static str,
    pub terminal_backend: TerminalBackend,
    pub shell_family: ShellFamily,
    pub wsl_status: WslStatus,
    pub wsl_distribution: Option<String>,
    pub local_acceleration: LocalAccelerationInfo,
}

#[tauri::command]
pub async fn get_system_info(_app: tauri::AppHandle<Wry>) -> Result<SystemInfo, String> {
    let sys = sysinfo::System::new_with_specifics(
        sysinfo::RefreshKind::nothing().with_memory(sysinfo::MemoryRefreshKind::everything()),
    );
    #[cfg(target_os = "windows")]
    let (wsl_status, wsl_distribution) = tokio::task::spawn_blocking(detect_default_wsl)
        .await
        .unwrap_or((WslStatus::Error, None));
    #[cfg(not(target_os = "windows"))]
    let (wsl_status, wsl_distribution) = (WslStatus::NotApplicable, None);
    #[cfg(feature = "local-llm")]
    let local_acceleration = {
        let chat = _app.state::<crate::provider::local::ModelHost>();
        let vision = _app.state::<crate::provider::vision::VisionHost>();
        let embeddings = _app.state::<crate::knowledge::local::EmbeddingHost>();
        let (chat, vision, embeddings) = tokio::join!(
            chat.acceleration_snapshot(),
            vision.acceleration_snapshot(),
            embeddings.acceleration_snapshot(),
        );
        aggregate_local_acceleration(vec![
            ("chat", decode_host_acceleration("chat", chat)),
            ("vision", decode_host_acceleration("vision", vision)),
            (
                "embeddings",
                decode_host_acceleration("embeddings", embeddings),
            ),
        ])
    };
    #[cfg(not(feature = "local-llm"))]
    let local_acceleration = LocalAccelerationInfo {
        backend: "unavailable".into(),
        device_name: None,
        device_memory_bytes: None,
        fallback_reason: Some("local inference is not included in this build".into()),
        generation_mode: None,
        generation_fallback_reason: None,
    };
    Ok(SystemInfo {
        total_ram_bytes: sys.total_memory(),
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
        terminal_backend: if cfg!(target_os = "windows") {
            TerminalBackend::WslConpty
        } else {
            TerminalBackend::NativePty
        },
        shell_family: if cfg!(target_os = "windows") {
            ShellFamily::Bash
        } else {
            ShellFamily::Zsh
        },
        wsl_status,
        wsl_distribution,
        local_acceleration,
    })
}

#[cfg(any(target_os = "windows", test))]
fn decode_windows_command_output(bytes: &[u8]) -> String {
    // Windows console tools may emit UTF-16LE when stdout is redirected. WSL
    // has done both UTF-8 and UTF-16 across releases, so detect rather than
    // relying on the machine's active code page.
    if bytes.len() >= 2
        && bytes
            .iter()
            .skip(1)
            .step_by(2)
            .filter(|byte| **byte == 0)
            .count()
            > bytes.len() / 8
    {
        let utf16: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect();
        String::from_utf16_lossy(&utf16)
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    }
}

#[cfg(any(target_os = "windows", test))]
fn parse_default_wsl_list(output: &str) -> (WslStatus, Option<String>) {
    let rows: Vec<(bool, String, u8)> = output
        .lines()
        .filter_map(|line| {
            let clean = line.trim_matches(['\0', '\r', '\n', ' ', '\u{feff}']);
            let columns: Vec<&str> = clean.split_whitespace().collect();
            let is_default = columns.first() == Some(&"*");
            let offset = usize::from(is_default);
            let version = columns.last()?.parse::<u8>().ok()?;
            // NAME may contain spaces. STATE and VERSION are the last two
            // columns, so retain every token between the optional star and
            // those columns instead of truncating the distribution name.
            if columns.len() < offset + 3 {
                return None;
            }
            let distribution = columns[offset..columns.len() - 2].join(" ");
            (!distribution.is_empty()).then_some((is_default, distribution, version))
        })
        .collect();
    let Some((_, distribution, version)) = rows
        .iter()
        .find(|(is_default, _, _)| *is_default)
        .or_else(|| rows.first())
    else {
        return (WslStatus::Missing, None);
    };
    let status = match version {
        2 => WslStatus::Ready,
        1 => WslStatus::Wsl1,
        _ => WslStatus::Error,
    };
    (status, Some(distribution.clone()))
}

#[cfg(any(target_os = "windows", test))]
pub(crate) fn command_output_bounded(
    command: &mut std::process::Command,
    timeout: std::time::Duration,
) -> std::io::Result<std::process::Output> {
    use std::io::Read;

    let mut child = command.spawn()?;
    let stdout_reader = child.stdout.take().map(|mut pipe| {
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            pipe.read_to_end(&mut bytes)?;
            Ok::<_, std::io::Error>(bytes)
        })
    });
    let stderr_reader = child.stderr.take().map(|mut pipe| {
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            pipe.read_to_end(&mut bytes)?;
            Ok::<_, std::io::Error>(bytes)
        })
    });
    let deadline = std::time::Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                break Err(std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    "Windows command timed out",
                ));
            }
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                break Err(error);
            }
        }
    };
    let status = status?;
    let join_reader = |reader: Option<std::thread::JoinHandle<std::io::Result<Vec<u8>>>>| {
        let Some(reader) = reader else {
            return Ok(Vec::new());
        };
        while !reader.is_finished() {
            if std::time::Instant::now() >= deadline {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    "Windows command output did not close before the deadline",
                ));
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        reader
            .join()
            .map_err(|_| std::io::Error::other("Windows command output reader panicked"))?
    };
    let stdout = join_reader(stdout_reader)?;
    let stderr = join_reader(stderr_reader)?;
    Ok(std::process::Output {
        status,
        stdout,
        stderr,
    })
}

#[cfg(target_os = "windows")]
fn detect_default_wsl() -> (WslStatus, Option<String>) {
    let mut list = std::process::Command::new("wsl.exe");
    list.args(["--list", "--verbose"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    match command_output_bounded(&mut list, std::time::Duration::from_secs(15)) {
        Ok(output) if output.status.success() => {
            let detected = parse_default_wsl_list(&decode_windows_command_output(&output.stdout));
            if detected.0 == WslStatus::Ready {
                let mut bash = std::process::Command::new("wsl.exe");
                bash.args([
                    "--exec",
                    "/bin/bash",
                    "--noprofile",
                    "--norc",
                    "-c",
                    "exit 0",
                ])
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null());
                let bash_ready =
                    command_output_bounded(&mut bash, std::time::Duration::from_secs(15))
                        .map(|output| output.status.success())
                        .unwrap_or(false);
                if !bash_ready {
                    return (WslStatus::MissingBash, detected.1);
                }
                let mut tools = std::process::Command::new("wsl.exe");
                tools
                    .args([
                        "--exec",
                        "/bin/bash",
                        "--noprofile",
                        "--norc",
                        "-c",
                        WSL_REQUIRED_TOOLS_PROBE,
                    ])
                    .stdin(std::process::Stdio::null())
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null());
                let tools_ready =
                    command_output_bounded(&mut tools, std::time::Duration::from_secs(15))
                        .map(|output| output.status.success())
                        .unwrap_or(false);
                if !tools_ready {
                    return (WslStatus::MissingTools, detected.1);
                }
            }
            detected
        }
        Ok(_) => (WslStatus::Missing, None),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => (WslStatus::Missing, None),
        Err(_) => (WslStatus::Error, None),
    }
}

pub fn read_string(app: &tauri::AppHandle<Wry>, key: &str) -> Option<String> {
    let store = app.store(STORE_NAME).ok()?;
    store.get(key).and_then(|v| v.as_str().map(String::from))
}

pub fn default_shell() -> &'static str {
    if cfg!(target_os = "windows") {
        "/bin/bash"
    } else {
        "/bin/zsh"
    }
}

pub fn read_credential(
    app: &tauri::AppHandle<Wry>,
    id: crate::credentials::CredentialId,
) -> Result<Option<crate::credentials::Secret>, String> {
    read_credential_with(id, |credential| {
        crate::credentials::state(app).get(credential)
    })
}

fn read_credential_with(
    id: crate::credentials::CredentialId,
    mut get: impl FnMut(
        &crate::credentials::CredentialId,
    ) -> Result<Option<crate::credentials::Secret>, String>,
) -> Result<Option<crate::credentials::Secret>, String> {
    get(&id)
}

pub fn read_bool(app: &tauri::AppHandle<Wry>, key: &str, default: bool) -> bool {
    let Ok(store) = app.store(STORE_NAME) else {
        return default;
    };
    store.get(key).and_then(|v| v.as_bool()).unwrap_or(default)
}

/// An optional numeric setting. `None` when unset — distinct from a stored 0.
pub fn read_f64_opt(app: &tauri::AppHandle<Wry>, key: &str) -> Option<f64> {
    app.store(STORE_NAME).ok()?.get(key)?.as_f64()
}

#[cfg_attr(not(feature = "local-llm"), allow(dead_code))]
pub fn read_u32(app: &tauri::AppHandle<Wry>, key: &str, default: u32) -> u32 {
    let Ok(store) = app.store(STORE_NAME) else {
        return default;
    };
    store
        .get(key)
        .and_then(|v| v.as_u64())
        .map(|v| v as u32)
        .unwrap_or(default)
}

pub fn read_command_policy_rules(
    app: &tauri::AppHandle<Wry>,
) -> Vec<crate::agent::policy::CommandPolicyRule> {
    app.store(STORE_NAME)
        .ok()
        .and_then(|store| store.get("agent_command_policy_rules"))
        .and_then(|value| serde_json::from_value(value).ok())
        .unwrap_or_default()
}

fn validate_command_policy_rules(
    rules: &[crate::agent::policy::CommandPolicyRule],
) -> Result<(), String> {
    if rules.len() > 200 {
        return Err("at most 200 command policy rules are allowed".into());
    }
    for rule in rules {
        if rule.id.trim().is_empty()
            || rule.id.len() > 80
            || rule.argv.is_empty()
            || rule.argv.len() > 64
        {
            return Err("invalid command policy rule".into());
        }
        let valid_scope = rule.scope == "local"
            || rule
                .scope
                .strip_prefix("remote:")
                .is_some_and(|host| !host.trim().is_empty() && host.len() <= 256);
        if !valid_scope {
            return Err(format!("invalid command policy scope: {}", rule.scope));
        }
        if rule.argv.iter().any(|token| token.len() > 512) {
            return Err("command policy token is too long".into());
        }
        if rule.description.len() > 512 {
            return Err("command policy description is too long".into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod command_policy_tests {
    use super::validate_command_policy_rules;
    use crate::agent::policy::{CommandPolicyRule, PolicyRuleEffect};

    fn rule(scope: &str) -> CommandPolicyRule {
        CommandPolicyRule {
            id: "rule-test".into(),
            effect: PolicyRuleEffect::Ask,
            scope: scope.into(),
            argv: vec!["future-cli".into(), "**".into()],
            enabled: true,
            description: "test rule".into(),
        }
    }

    #[test]
    fn command_policy_rules_accept_supported_local_and_remote_scopes() {
        assert!(validate_command_policy_rules(&[rule("local")]).is_ok());
        assert!(validate_command_policy_rules(&[rule("remote:saved-host-id")]).is_ok());
    }

    #[test]
    fn command_policy_rules_reject_empty_remote_host_scopes() {
        let error = validate_command_policy_rules(&[rule("remote:")]).unwrap_err();
        assert!(error.contains("invalid command policy scope"));
    }

    #[test]
    fn command_policy_rules_enforce_the_shared_count_limit() {
        assert!(validate_command_policy_rules(&vec![rule("local"); 200]).is_ok());
        let error = validate_command_policy_rules(&vec![rule("local"); 201]).unwrap_err();
        assert_eq!(error, "at most 200 command policy rules are allowed");
    }

    #[test]
    fn command_policy_rules_bound_user_controlled_text() {
        let mut long_token = rule("local");
        long_token.argv = vec!["x".repeat(513)];
        assert_eq!(
            validate_command_policy_rules(&[long_token]).unwrap_err(),
            "command policy token is too long"
        );

        let mut long_description = rule("local");
        long_description.description = "x".repeat(513);
        assert_eq!(
            validate_command_policy_rules(&[long_description]).unwrap_err(),
            "command policy description is too long"
        );
    }
}

#[cfg(test)]
mod credential_tests {
    #[cfg(unix)]
    use super::command_output_bounded;
    use super::{
        aggregate_local_acceleration, decode_windows_command_output, parse_default_wsl_list,
        read_credential_with, settings_credential_presence, LocalAccelerationInfo, WslStatus,
        WSL_REQUIRED_TOOLS_PROBE,
    };

    fn acceleration(backend: &str, device: Option<&str>) -> LocalAccelerationInfo {
        LocalAccelerationInfo {
            backend: backend.into(),
            device_name: device.map(str::to_owned),
            device_memory_bytes: None,
            fallback_reason: None,
            generation_mode: None,
            generation_fallback_reason: None,
        }
    }

    #[test]
    fn startup_settings_check_each_credential_once_without_a_secret_reader() {
        use crate::credentials::CredentialId;

        let mut calls = Vec::new();
        let presence = settings_credential_presence(false, |id| {
            calls.push(id.clone());
            Ok(true)
        });

        assert!(presence.hugging_face);
        assert!(presence.anthropic);
        assert!(presence.openai);
        assert!(presence.mistral);
        assert_eq!(
            calls,
            vec![
                CredentialId::HuggingFace,
                CredentialId::Anthropic,
                CredentialId::OpenAi,
                CredentialId::Mistral,
            ]
        );

        let blocked = settings_credential_presence(true, |_| {
            panic!("a globally blocked store must not be queried")
        });
        assert!(!blocked.hugging_face);
        assert!(!blocked.anthropic);
        assert!(!blocked.openai);
        assert!(!blocked.mistral);

        let unknown = settings_credential_presence(false, |_| Err("item denied".into()));
        assert!(unknown.hugging_face);
        assert!(unknown.anthropic);
        assert!(unknown.openai);
        assert!(unknown.mistral);
    }

    #[test]
    fn actual_credential_consumers_read_the_requested_secret_once() {
        let mut reads = Vec::new();
        let secret = read_credential_with(crate::credentials::CredentialId::OpenAi, |id| {
            reads.push(id.clone());
            Ok(Some(crate::credentials::Secret::from("provider-secret")))
        })
        .unwrap()
        .unwrap();
        assert_eq!(reads, vec![crate::credentials::CredentialId::OpenAi]);
        assert_eq!(secret.expose(), "provider-secret");
    }

    #[test]
    fn parses_the_default_wsl2_distribution() {
        let output = "  NAME      STATE           VERSION\r\n* Ubuntu    Running         2\r\n  Debian    Stopped         1\r\n";
        assert_eq!(
            parse_default_wsl_list(output),
            (WslStatus::Ready, Some("Ubuntu".into()))
        );
    }

    #[test]
    fn detects_wsl1_and_utf16_console_output() {
        let output = "* Legacy Stopped 1\r\n";
        let utf16 = output
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>();
        let decoded = decode_windows_command_output(&utf16);
        assert_eq!(
            parse_default_wsl_list(&decoded),
            (WslStatus::Wsl1, Some("Legacy".into()))
        );
    }

    #[test]
    fn parses_localized_headers_bom_and_distribution_names_with_spaces() {
        let output = "\u{feff}NOM ÉTAT VERSION\r\n* Ubuntu Preview Running 2\r\n";
        assert_eq!(
            parse_default_wsl_list(output),
            (WslStatus::Ready, Some("Ubuntu Preview".into()))
        );
    }

    #[test]
    fn wsl_tool_probe_requires_the_absolute_printf_bridge() {
        assert!(WSL_REQUIRED_TOOLS_PROBE.contains("test -x /usr/bin/printf"));
    }

    #[test]
    fn aggregate_acceleration_drops_unloaded_hosts_and_never_returns_stale_state() {
        let active = aggregate_local_acceleration(vec![
            ("chat", acceleration("unloaded", None)),
            ("vision", acceleration("vulkan", Some("Example GPU"))),
            ("embeddings", acceleration("unloaded", None)),
        ]);
        assert_eq!(active.backend, "vulkan");
        assert_eq!(active.device_name.as_deref(), Some("Example GPU"));

        let unloaded = aggregate_local_acceleration(vec![
            ("chat", acceleration("unloaded", None)),
            ("vision", acceleration("unloaded", None)),
            ("embeddings", acceleration("unloaded", None)),
        ]);
        assert_eq!(unloaded, acceleration("unloaded", None));
    }

    #[test]
    fn aggregate_acceleration_reports_different_active_hosts_as_mixed() {
        let aggregate = aggregate_local_acceleration(vec![
            ("chat", acceleration("vulkan", Some("Example GPU"))),
            ("vision", acceleration("unloaded", None)),
            ("embeddings", acceleration("cpu", None)),
        ]);
        assert_eq!(aggregate.backend, "mixed");
        let devices = aggregate.device_name.unwrap();
        assert!(devices.contains("chat: vulkan (Example GPU)"));
        assert!(devices.contains("embeddings: cpu"));
    }

    #[cfg(unix)]
    #[test]
    fn bounded_output_drains_more_than_a_pipe_capacity() {
        let mut command = std::process::Command::new("/bin/sh");
        command
            .args(["-c", "dd if=/dev/zero bs=1048576 count=2 2>/dev/null"])
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        let output = command_output_bounded(&mut command, std::time::Duration::from_secs(5))
            .expect("large child output should not deadlock");
        assert!(output.status.success());
        assert_eq!(output.stdout.len(), 2 * 1_048_576);
    }

    #[cfg(unix)]
    #[test]
    fn bounded_output_terminates_a_stuck_process() {
        let mut command = std::process::Command::new("/bin/sh");
        command
            .args(["-c", "while :; do :; done"])
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        let error =
            command_output_bounded(&mut command, std::time::Duration::from_millis(40)).unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::TimedOut);
    }
}
