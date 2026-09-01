import type { Session, Settings } from "../lib/types";

export function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "session-1",
    shell: "/bin/zsh",
    cwd: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    exited: false,
    exitCode: null,
    hostId: null,
    hostLabel: null,
    userTitle: null,
    aiTitle: null,
    ordinal: 1,
    ...overrides,
  };
}

/** A complete backend settings snapshot, for tests that exercise `useSettings`.
 *
 *  `Settings` is what `get_settings` returns, and Rust always returns EVERY key —
 *  so this object has to be exhaustive, and a test that hand-rolls it breaks on
 *  the next added field. It broke twice already. Values are the Rust defaults
 *  except where a test-friendly one reads better (an active model that resolves,
 *  the experimental features off).
 */
export function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    theme: "veviad-developer",
    font_size: 13,
    scrollback_lines: 10_000,
    cursor_style: "block",
    cursor_blink: true,
    copy_on_select: false,
    shell_path: null,
    shell_integration_enabled: true,
    active_model_id: "local/qwen3.5-9b",
    temperature: 0.7,
    max_context_tokens: 32_768,
    auto_compact_enabled: true,
    auto_compact_threshold_percent: 85,
    auto_load_model_on_start: true,
    vision_model_id: null,
    vision_prompt: null,
    vision_auto_load_on_start: true,
    has_hf_token: false,
    models_dir: null,
    has_anthropic_api_key: false,
    has_openai_api_key: false,
    has_mistral_api_key: false,
    credential_store_status: "ready",
    history_enabled: true,
    history_capture_output: true,
    send_context_to_ai: true,
    ai_session_naming: true,
    restore_sessions_on_start: true,
    restore_scrollback_lines: 1_000,
    archive_enabled: true,
    archive_max_sessions: 50,
    archive_max_age_days: 30,
    ai_panel_open: true,
    workspace_mode: "terminal",
    active_chat_id: null,
    ai_panel_ratio: 0.3,
    ai_panel_width: 420,
    agent_max_iterations: 10,
    agent_command_timeout_secs: 120,
    ai_web_access: true,
    custom_instructions: null,
    agent_custom_instructions: null,
    chat_custom_instructions: null,
    auto_update_enabled: false,
    docs_enabled: false,
    runbooks_enabled: false,
    runbooks_output_recording: "runbook",
    scheduled_actions_enabled: false,
    scheduled_tab_execution_enabled: false,
    log_level: "info",
    ...overrides,
  };
}
