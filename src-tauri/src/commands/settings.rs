use serde_json::{json, Value};
use tauri::Wry;
use tauri_plugin_store::StoreExt;

pub const STORE_NAME: &str = "settings.json";

/// Cowork pattern: every key is read with an inline default so the frontend
/// always receives a complete settings object.
#[tauri::command]
pub fn get_settings(app: tauri::AppHandle<Wry>) -> Result<Value, String> {
    let store = app.store(STORE_NAME).map_err(|e| e.to_string())?;
    let get = |key: &str, default: Value| store.get(key).unwrap_or(default);
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
        "hf_token": get("hf_token", Value::Null),
        "models_dir": get("models_dir", Value::Null),
        // API keys are write-only: report presence, never the value.
        "has_anthropic_api_key": json!(store.get("anthropic_api_key").map(|v| !v.is_null()).unwrap_or(false)),
        "has_openai_api_key": json!(store.get("openai_api_key").map(|v| !v.is_null()).unwrap_or(false)),
        "has_mistral_api_key": json!(store.get("mistral_api_key").map(|v| !v.is_null()).unwrap_or(false)),
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
        // Read since the web tiers landed (commands::ai) but never writable, so
        // it was pinned at this default. Default stays `true`: flipping it would
        // silently take the web away from every existing install on upgrade.
        "ai_web_access": get("ai_web_access", json!(true)),
        "log_level": get("log_level", json!("info")),
    }))
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
    ai_panel_ratio: Option<f64>,
    agent_max_iterations: Option<u32>,
    agent_command_timeout_secs: Option<u32>,
    ai_web_access: Option<bool>,
    log_level: Option<String>,
) -> Result<(), String> {
    let store = app.store(STORE_NAME).map_err(|e| e.to_string())?;

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
            if v < 0.0 { Value::Null } else { json!(v.clamp(0.0, 2.0)) },
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
    if let Some(v) = hf_token {
        store.set("hf_token", clearable(v));
    }
    if let Some(v) = models_dir {
        store.set("models_dir", clearable(v));
    }
    if let Some(v) = anthropic_api_key {
        store.set("anthropic_api_key", clearable(v));
    }
    if let Some(v) = openai_api_key {
        store.set("openai_api_key", clearable(v));
    }
    if let Some(v) = mistral_api_key {
        store.set("mistral_api_key", clearable(v));
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
        // local one — long before it spends its steps.
        store.set("agent_max_iterations", json!(v.clamp(1, 100)));
    }
    if let Some(v) = agent_command_timeout_secs {
        store.set("agent_command_timeout_secs", json!(v.clamp(5, 3600)));
    }
    if let Some(v) = ai_web_access {
        store.set("ai_web_access", json!(v));
    }
    if let Some(v) = log_level {
        store.set("log_level", json!(v));
    }

    store.save().map_err(|e| e.to_string())
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

#[tauri::command]
pub fn get_system_info() -> Result<Value, String> {
    let sys = sysinfo::System::new_with_specifics(
        sysinfo::RefreshKind::nothing().with_memory(sysinfo::MemoryRefreshKind::everything()),
    );
    Ok(json!({
        "total_ram_bytes": sys.total_memory(),
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
    }))
}

pub fn read_string(app: &tauri::AppHandle<Wry>, key: &str) -> Option<String> {
    let store = app.store(STORE_NAME).ok()?;
    store.get(key).and_then(|v| v.as_str().map(String::from))
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
