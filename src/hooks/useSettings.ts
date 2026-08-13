import { useCallback } from "react";
import * as api from "../lib/tauri";
import type { SettingsPatch } from "../lib/types";
import { useAppStore } from "../stores/appStore";
import { updateAllTermOptions } from "../lib/termRegistry";
import { clampPanelRatio } from "../lib/panelRatio";

// Load-mirror / save-partial pattern (Cowork useSettings): hydrate the store
// from Rust on mount; every save writes through Rust first, then updates the
// mirror. Nothing persists frontend-side.
export function useSettings() {
  const hydrateSettings = useAppStore((s) => s.hydrateSettings);

  const loadSettings = useCallback(async () => {
    const s = await api.getSettings();
    hydrateSettings({
      theme: s.theme,
      fontSize: s.font_size,
      scrollbackLines: s.scrollback_lines,
      cursorStyle: s.cursor_style,
      cursorBlink: s.cursor_blink,
      copyOnSelect: s.copy_on_select,
      shellPath: s.shell_path,
      shellIntegrationEnabled: s.shell_integration_enabled,
      temperature: s.temperature,
      activeModelId: s.active_model_id,
      hfToken: s.hf_token,
      historyEnabled: s.history_enabled,
      historyCaptureOutput: s.history_capture_output,
      sendContextToAi: s.send_context_to_ai,
      aiSessionNaming: s.ai_session_naming,
      restoreSessionsOnStart: s.restore_sessions_on_start,
      restoreScrollbackLines: s.restore_scrollback_lines,
      archiveEnabled: s.archive_enabled,
      archiveMaxSessions: s.archive_max_sessions,
      archiveMaxAgeDays: s.archive_max_age_days,
      autoLoadModelOnStart: s.auto_load_model_on_start,
      visionModelId: s.vision_model_id,
      visionPrompt: s.vision_prompt,
      visionAutoLoadOnStart: s.vision_auto_load_on_start,
      aiPanelOpen: s.ai_panel_open,
      // Migration AND fresh-install default in one expression: `ai_panel_ratio` is
      // null until the first drag, and the legacy pixel width over the current
      // window reproduces exactly what the user (or a first launch, at 420px) had.
      // Clamped here because `hydrateSettings` applies its patch verbatim.
      aiPanelRatio: clampPanelRatio(s.ai_panel_ratio ?? s.ai_panel_width / window.innerWidth),
      agentMaxIterations: s.agent_max_iterations,
      agentCommandTimeoutSecs: s.agent_command_timeout_secs,
      aiWebAccess: s.ai_web_access,
      docsEnabled: s.docs_enabled,
      hasApiKey: {
        anthropic: s.has_anthropic_api_key,
        openai: s.has_openai_api_key,
        mistral: s.has_mistral_api_key,
      },
    });
    return s;
  }, [hydrateSettings]);

  const save = useCallback(async (patch: Partial<SettingsPatch>) => {
    await api.saveSettings(patch);
    const store = useAppStore.getState();
    if (patch.theme !== undefined) store.setTheme(patch.theme);
    if (patch.font_size !== undefined) {
      store.setFontSize(patch.font_size);
      updateAllTermOptions({ fontSize: patch.font_size });
    }
    if (patch.scrollback_lines !== undefined) {
      useAppStore.setState({ scrollbackLines: patch.scrollback_lines });
      updateAllTermOptions({ scrollback: patch.scrollback_lines });
    }
    if (patch.cursor_style !== undefined) {
      useAppStore.setState({ cursorStyle: patch.cursor_style as "block" | "bar" | "underline" });
      updateAllTermOptions({ cursorStyle: patch.cursor_style as "block" | "bar" | "underline" });
    }
    if (patch.cursor_blink !== undefined) {
      useAppStore.setState({ cursorBlink: patch.cursor_blink });
      updateAllTermOptions({ cursorBlink: patch.cursor_blink });
    }
    if (patch.copy_on_select !== undefined) useAppStore.setState({ copyOnSelect: patch.copy_on_select });
    if (patch.shell_path !== undefined) useAppStore.setState({ shellPath: patch.shell_path || null });
    if (patch.shell_integration_enabled !== undefined)
      useAppStore.setState({ shellIntegrationEnabled: patch.shell_integration_enabled });
    if (patch.temperature !== undefined) useAppStore.setState({ temperature: patch.temperature });
    if (patch.active_model_id !== undefined)
      useAppStore.setState({ activeModelId: patch.active_model_id });
    if (patch.hf_token !== undefined) useAppStore.setState({ hfToken: patch.hf_token || null });
    if (patch.history_enabled !== undefined) useAppStore.setState({ historyEnabled: patch.history_enabled });
    if (patch.history_capture_output !== undefined)
      useAppStore.setState({ historyCaptureOutput: patch.history_capture_output });
    if (patch.send_context_to_ai !== undefined)
      useAppStore.setState({ sendContextToAi: patch.send_context_to_ai });
    if (patch.ai_session_naming !== undefined)
      useAppStore.setState({ aiSessionNaming: patch.ai_session_naming });
    if (patch.restore_sessions_on_start !== undefined) {
      useAppStore.setState({ restoreSessionsOnStart: patch.restore_sessions_on_start });
      // Turning restore OFF is a privacy action: `workspace::restore` wipes the
      // stored snapshots at the next boot for exactly that reason. The archive is
      // a SECOND on-disk copy of the same captured output, and its write gate
      // only stops it GROWING — so what is already there has to be cleared here,
      // or the switch stops meaning what it says.
      if (!patch.restore_sessions_on_start) void api.archiveClear().catch(() => {});
    }
    if (patch.restore_scrollback_lines !== undefined)
      useAppStore.setState({ restoreScrollbackLines: patch.restore_scrollback_lines });
    if (patch.archive_enabled !== undefined)
      useAppStore.setState({ archiveEnabled: patch.archive_enabled });
    if (patch.archive_max_sessions !== undefined)
      useAppStore.setState({ archiveMaxSessions: patch.archive_max_sessions });
    if (patch.archive_max_age_days !== undefined)
      useAppStore.setState({ archiveMaxAgeDays: patch.archive_max_age_days });
    if (patch.ai_panel_open !== undefined)
      useAppStore.setState({ aiPanelOpen: patch.ai_panel_open });
    if (patch.ai_panel_ratio !== undefined)
      useAppStore.setState({ aiPanelRatio: clampPanelRatio(patch.ai_panel_ratio) });
    if (patch.auto_load_model_on_start !== undefined)
      useAppStore.setState({ autoLoadModelOnStart: patch.auto_load_model_on_start });
    if (patch.vision_model_id !== undefined)
      // Empty string is the clear sentinel over IPC, so mirror it as null.
      useAppStore.setState({ visionModelId: patch.vision_model_id || null });
    if (patch.vision_prompt !== undefined)
      useAppStore.setState({ visionPrompt: patch.vision_prompt || null });
    if (patch.vision_auto_load_on_start !== undefined)
      useAppStore.setState({ visionAutoLoadOnStart: patch.vision_auto_load_on_start });
    if (patch.agent_max_iterations !== undefined)
      useAppStore.setState({ agentMaxIterations: patch.agent_max_iterations });
    if (patch.agent_command_timeout_secs !== undefined)
      useAppStore.setState({ agentCommandTimeoutSecs: patch.agent_command_timeout_secs });
    if (patch.ai_web_access !== undefined)
      useAppStore.setState({ aiWebAccess: patch.ai_web_access });
    if (patch.docs_enabled !== undefined)
      useAppStore.setState({ docsEnabled: patch.docs_enabled });
    // Keys are write-only. Mirror only whether one is now present — the value
    // itself is never held frontend-side.
    for (const [key, provider] of [
      ["anthropic_api_key", "anthropic"],
      ["openai_api_key", "openai"],
      ["mistral_api_key", "mistral"],
    ] as const) {
      const v = patch[key];
      if (v !== undefined) store.setHasApiKey(provider, v.trim().length > 0);
    }
  }, []);

  return { loadSettings, save };
}
