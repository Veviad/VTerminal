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
import { useRunbookStore } from "../stores/runbookStore";
import {
  isRunbookRunRevoked,
  registerLiveRunbookPtyJob,
  resetRunbookLiveJobsForTests,
} from "../lib/runbookLiveJobs";

function settings(runbooksEnabled: boolean, overrides: Partial<Settings> = {}): Settings {
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
    runbooks_enabled: runbooksEnabled,
    runbooks_output_recording: "runbook",
    scheduled_actions_enabled: false,
    scheduled_tab_execution_enabled: false,
    log_level: "info",
    ...overrides,
  };
}

describe("Runbooks feature revocation", () => {
  beforeEach(() => {
    mocks.getSettings.mockReset();
    mocks.saveSettings.mockReset();
    mocks.abortSession.mockClear();
    mocks.interruptJob.mockClear();
    resetRunbookLiveJobsForTests();
    useAppStore.setState({ runbooksEnabled: true, theme: "veviad-developer" });
    useRunbookStore.getState().reset();
  });

  it("closes the frontend execution gate before settings persistence resolves", async () => {
    let persist!: () => void;
    mocks.saveSettings.mockImplementation(
      () => new Promise<void>((resolve) => (persist = resolve)),
    );
    const { result } = renderHook(() => useSettings());

    let saving!: Promise<void>;
    act(() => {
      saving = result.current.save({ runbooks_enabled: false });
    });

    // A stale successful dispatch-claim response arriving in this window sees
    // false at the final canWrite guard and cannot reach ptyWrite.
    expect(useAppStore.getState().runbooksEnabled).toBe(false);
    expect(mocks.saveSettings).toHaveBeenCalledWith({ runbooks_enabled: false });

    persist();
    await act(async () => saving);
    expect(useAppStore.getState().runbooksEnabled).toBe(false);
  });

  it("synchronously revokes and aborts every concurrent Runbook PTY job", async () => {
    registerLiveRunbookPtyJob({
      runId: "run-selected",
      attemptId: "attempt-a",
      sessionId: "session-a",
    });
    registerLiveRunbookPtyJob({
      runId: "run-background",
      attemptId: "attempt-b",
      sessionId: "session-b",
    });
    let persist!: () => void;
    mocks.saveSettings.mockImplementation(
      () => new Promise<void>((resolve) => (persist = resolve)),
    );
    const { result } = renderHook(() => useSettings());

    let saving!: Promise<void>;
    act(() => {
      saving = result.current.save({ runbooks_enabled: false });
    });

    expect(isRunbookRunRevoked("run-selected")).toBe(true);
    expect(isRunbookRunRevoked("run-background")).toBe(true);
    expect(mocks.interruptJob.mock.calls).toEqual([
      ["session-a", "attempt-a"],
      ["session-b", "attempt-b"],
    ]);
    expect(mocks.abortSession.mock.calls).toEqual([
      ["session-a", "cancelled", "attempt-a"],
      ["session-b", "cancelled", "attempt-b"],
    ]);

    persist();
    await act(async () => saving);
  });

  it("rehydrates the authoritative backend snapshot when disable persisted before save reported an error", async () => {
    const failure = new Error("could not secure settings file");
    mocks.saveSettings.mockRejectedValue(failure);
    mocks.getSettings.mockResolvedValue(settings(false, { theme: "midnight" }));
    const { result } = renderHook(() => useSettings());

    await act(async () => {
      await expect(result.current.save({ runbooks_enabled: false })).rejects.toBe(failure);
    });

    expect(mocks.getSettings).toHaveBeenCalledOnce();
    expect(useAppStore.getState().runbooksEnabled).toBe(false);
    expect(useAppStore.getState().theme).toBe("midnight");
  });

  it("keeps the frontend Runbooks gate closed when save and authoritative reload both fail", async () => {
    const failure = new Error("settings save failed");
    mocks.saveSettings.mockRejectedValue(failure);
    mocks.getSettings.mockRejectedValue(new Error("settings reload failed"));
    const { result } = renderHook(() => useSettings());

    await act(async () => {
      await expect(result.current.save({ runbooks_enabled: false })).rejects.toBe(failure);
    });

    expect(mocks.getSettings).toHaveBeenCalledOnce();
    expect(useAppStore.getState().runbooksEnabled).toBe(false);
  });
});
