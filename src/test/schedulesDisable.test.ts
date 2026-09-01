import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings } from "../lib/types";

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  saveSettings: vi.fn(),
  abortSession: vi.fn(),
  interruptJob: vi.fn(),
}));

vi.mock("../lib/tauri", () => ({
  getSettings: mocks.getSettings,
  saveSettings: mocks.saveSettings,
  archiveClear: vi.fn(async () => {}),
}));

vi.mock("../lib/ptyExec", () => ({
  abortSession: mocks.abortSession,
  interruptJob: mocks.interruptJob,
}));

import { useSettings } from "../hooks/useSettings";
import { useAppStore } from "../stores/appStore";
import { useScheduleStore } from "../stores/scheduleStore";
import {
  isScheduleRunRevoked,
  registerLiveScheduleJob,
  resetScheduleLiveJobsForTests,
} from "../lib/scheduleLiveJobs";

function settings(schedulesEnabled: boolean, overrides: Partial<Settings> = {}): Settings {
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
    scheduled_actions_enabled: schedulesEnabled,
    scheduled_tab_execution_enabled: false,
    log_level: "info",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetScheduleLiveJobsForTests();
  useAppStore.setState({ schedulesEnabled: true, schedulesTabExecutionEnabled: true });
  useScheduleStore.getState().reset();
  mocks.saveSettings.mockResolvedValue(undefined);
  mocks.getSettings.mockResolvedValue(settings(false));
});

describe("disabling Scheduled Actions", () => {
  /** A capability revocation, so the webview mirror must close BEFORE the
   *  persistence IPC. A tab dispatch may already be in flight, and setting the
   *  mirror synchronously is what makes its final `canWrite` check fail. */
  it("closes the mirror and revokes live runs before the save resolves", async () => {
    let mirrorAtSave: boolean | null = null;
    let revokedAtSave: boolean | null = null;
    mocks.saveSettings.mockImplementation(async () => {
      mirrorAtSave = useAppStore.getState().schedulesEnabled;
      revokedAtSave = isScheduleRunRevoked("r1");
    });
    registerLiveScheduleJob({ runId: "r1", attemptId: "a1", sessionId: "s1" });
    useScheduleStore.getState().setWorkspaceOpen(true);

    const { result } = renderHook(() => useSettings());
    await act(async () => {
      await result.current.save({ scheduled_actions_enabled: false });
    });

    expect(mirrorAtSave).toBe(false);
    expect(revokedAtSave).toBe(true);
    expect(useScheduleStore.getState().workspaceOpen).toBe(false);
    // And the exact owned job is aborted, not merely marked.
    expect(mocks.interruptJob).toHaveBeenCalledWith("s1", "a1");
    expect(mocks.abortSession).toHaveBeenCalledWith("s1", "cancelled", "a1");
  });

  /** A rejected save can still have changed durable state, so never guess which
   *  fields committed — and if the re-read also fails, keep the capability
   *  CLOSED rather than restoring it from a stale snapshot. */
  it("keeps the feature closed when both the save and the re-read fail", async () => {
    mocks.saveSettings.mockRejectedValue(new Error("permission check failed"));
    mocks.getSettings.mockRejectedValue(new Error("unreadable"));
    const { result } = renderHook(() => useSettings());
    await act(async () => {
      await expect(
        result.current.save({ scheduled_actions_enabled: false }),
      ).rejects.toThrow();
    });
    expect(useAppStore.getState().schedulesEnabled).toBe(false);
  });

  it("mirrors the flag and the separate tab-execution switch on a successful save", async () => {
    useAppStore.setState({ schedulesEnabled: false, schedulesTabExecutionEnabled: false });
    const { result } = renderHook(() => useSettings());
    await act(async () => {
      await result.current.save({
        scheduled_actions_enabled: true,
        scheduled_tab_execution_enabled: true,
      });
    });
    expect(useAppStore.getState().schedulesEnabled).toBe(true);
    expect(useAppStore.getState().schedulesTabExecutionEnabled).toBe(true);
  });

  it("hydrates both mirrors from the backend view", async () => {
    mocks.getSettings.mockResolvedValue(
      settings(true, { scheduled_tab_execution_enabled: true }),
    );
    const { result } = renderHook(() => useSettings());
    await act(async () => {
      await result.current.loadSettings();
    });
    expect(useAppStore.getState().schedulesEnabled).toBe(true);
    expect(useAppStore.getState().schedulesTabExecutionEnabled).toBe(true);
  });

  it("does not touch the schedules mirror when the patch omits the flag", async () => {
    const { result } = renderHook(() => useSettings());
    await act(async () => {
      await result.current.save({ font_size: 14 });
    });
    expect(useAppStore.getState().schedulesEnabled).toBe(true);
  });
});
