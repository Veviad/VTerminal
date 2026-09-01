import { useCallback } from "react";
import * as api from "../lib/tauri";
import type { SettingsPatch } from "../lib/types";
import { useAppStore } from "../stores/appStore";
import { useRunbookStore } from "../stores/runbookStore";
import { abortSession, interruptJob } from "../lib/ptyExec";
import { revokeAllLiveRunbookRuns } from "../lib/runbookLiveJobs";
import { revokeAllLiveScheduleRuns } from "../lib/scheduleLiveJobs";
import { useScheduleStore } from "../stores/scheduleStore";
import type { EvidenceRecordingPolicy } from "../lib/runbooks";
import { updateAllTermOptions } from "../lib/termRegistry";
import { clampPanelRatio } from "../lib/panelRatio";
import { useChatStore } from "../stores/chatStore";

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
      hasHfToken: s.has_hf_token,
      credentialStoreStatus: s.credential_store_status,
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
      autoCompactEnabled: s.auto_compact_enabled,
      autoCompactThresholdPercent: s.auto_compact_threshold_percent,
      agentMaxIterations: s.agent_max_iterations,
      agentCommandTimeoutSecs: s.agent_command_timeout_secs,
      agentCommandPolicyRules: s.agent_command_policy_rules ?? [],
      aiWebAccess: s.ai_web_access,
      customInstructions: s.custom_instructions ?? "",
      agentCustomInstructions: s.agent_custom_instructions ?? "",
      chatCustomInstructions: s.chat_custom_instructions ?? "",
      autoUpdateEnabled: s.auto_update_enabled,
      docsEnabled: s.docs_enabled,
      runbooksEnabled: s.runbooks_enabled,
      schedulesEnabled: s.scheduled_actions_enabled,
      schedulesTabExecutionEnabled: s.scheduled_tab_execution_enabled,
      runbooksOutputRecording: s.runbooks_output_recording,
      hasApiKey: {
        anthropic: s.has_anthropic_api_key,
        openai: s.has_openai_api_key,
        mistral: s.has_mistral_api_key,
      },
    });
    return s;
  }, [hydrateSettings]);

  const save = useCallback(async (patch: Partial<SettingsPatch>) => {
    // Disabling Runbooks is a capability revocation, so the webview gate must
    // close before the persistence IPC. A terminal claim response may already
    // be in flight; setting this mirror synchronously makes its final canWrite
    // check fail even if Rust persisted the setting a moment earlier.
    if (patch.scheduled_actions_enabled === false) {
      // A capability revocation, so the mirror closes before the IPC. Rust
      // cancels the runs; this stops a tab-mode dispatch that is already in
      // flight from passing its final `canWrite` check.
      useAppStore.setState({ schedulesEnabled: false });
      useScheduleStore.getState().setWorkspaceOpen(false);
      for (const job of revokeAllLiveScheduleRuns()) {
        interruptJob(job.sessionId, job.attemptId);
        abortSession(job.sessionId, "cancelled", job.attemptId);
      }
    }
    if (patch.runbooks_enabled === false) {
      useAppStore.setState({ runbooksEnabled: false });
      const runbooks = useRunbookStore.getState();
      // The selected run and capped event feed are presentation state, not PTY
      // ownership. Revoke every exact live job before persistence can yield so
      // concurrent background runs cannot keep executing through disable.
      for (const job of revokeAllLiveRunbookRuns()) {
        interruptJob(job.sessionId, job.attemptId);
        abortSession(job.sessionId, "cancelled", job.attemptId);
      }
      runbooks.setWorkspaceOpen(false);
    }
    try {
      await api.saveSettings(patch);
    } catch (error) {
      // A rejected save can still have changed durable state: for example, the
      // JSON write may succeed before its owner-only permission check fails.
      // Never guess which fields committed. Re-read the complete backend view;
      // if that also fails, keep any Runbooks toggle closed rather than
      // restoring capability from a stale frontend snapshot.
      try {
        await loadSettings();
      } catch {
        if (patch.runbooks_enabled !== undefined) {
          useAppStore.setState({ runbooksEnabled: false });
        }
        if (patch.scheduled_actions_enabled !== undefined) {
          useAppStore.setState({ schedulesEnabled: false });
        }
      }
      throw error;
    }
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
    if (patch.hf_token !== undefined)
      useAppStore.setState({ hasHfToken: patch.hf_token.trim().length > 0 });
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
    if (patch.workspace_mode !== undefined)
      useChatStore.setState({ workspaceMode: patch.workspace_mode });
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
    if (patch.auto_compact_enabled !== undefined)
      useAppStore.setState({ autoCompactEnabled: patch.auto_compact_enabled });
    if (patch.auto_compact_threshold_percent !== undefined)
      // Mirrored with the sent value: Rust clamps to 50..=95, so the two can
      // differ at the edges until the next `loadSettings` settles it — the same
      // trade the instruction fields make.
      useAppStore.setState({
        autoCompactThresholdPercent: patch.auto_compact_threshold_percent,
      });
    if (patch.agent_max_iterations !== undefined)
      useAppStore.setState({ agentMaxIterations: patch.agent_max_iterations });
    if (patch.agent_command_timeout_secs !== undefined)
      useAppStore.setState({ agentCommandTimeoutSecs: patch.agent_command_timeout_secs });
    if (patch.agent_command_policy_rules !== undefined)
      useAppStore.setState({ agentCommandPolicyRules: patch.agent_command_policy_rules });
    if (patch.ai_web_access !== undefined)
      useAppStore.setState({ aiWebAccess: patch.ai_web_access });
    // Mirrored with the SENT text, not the stored text: Rust trims and drops
    // stray control bytes, so the two can differ by whitespace. Re-reading to
    // reconcile that would fight the textarea the user is still typing in; the
    // next `loadSettings` settles it.
    if (patch.custom_instructions !== undefined)
      useAppStore.setState({ customInstructions: patch.custom_instructions });
    if (patch.agent_custom_instructions !== undefined)
      useAppStore.setState({ agentCustomInstructions: patch.agent_custom_instructions });
    if (patch.chat_custom_instructions !== undefined)
      useAppStore.setState({ chatCustomInstructions: patch.chat_custom_instructions });
    if (patch.auto_update_enabled !== undefined)
      useAppStore.setState({ autoUpdateEnabled: patch.auto_update_enabled });
    if (patch.docs_enabled !== undefined)
      useAppStore.setState({ docsEnabled: patch.docs_enabled });
    if (patch.runbooks_enabled !== undefined) {
      useAppStore.setState({ runbooksEnabled: patch.runbooks_enabled });
    }
    if (patch.scheduled_actions_enabled !== undefined) {
      useAppStore.setState({ schedulesEnabled: patch.scheduled_actions_enabled });
    }
    if (patch.scheduled_tab_execution_enabled !== undefined) {
      useAppStore.setState({
        schedulesTabExecutionEnabled: patch.scheduled_tab_execution_enabled,
      });
    }
    if (patch.runbooks_output_recording !== undefined) {
      // Rust already rejected anything outside the union before this resolved.
      useAppStore.setState({
        runbooksOutputRecording: patch.runbooks_output_recording as EvidenceRecordingPolicy,
      });
    }
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
  }, [loadSettings]);

  return { loadSettings, save };
}
