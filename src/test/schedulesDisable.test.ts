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
import { makeSettings } from "./factories";

function settings(schedulesEnabled: boolean, overrides: Partial<Settings> = {}): Settings {
  // The exhaustive default lives in `factories.makeSettings`: `Settings` is
  // what `get_settings` returns, so it has to carry every key, and a copy per
  // test file breaks on the next added field.
  return makeSettings({ scheduled_actions_enabled: schedulesEnabled, ...overrides });
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
