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
import { makeSettings } from "./factories";

function settings(runbooksEnabled: boolean, overrides: Partial<Settings> = {}): Settings {
  // The exhaustive default lives in `factories.makeSettings`: `Settings` is
  // what `get_settings` returns, so it has to carry every key, and a copy per
  // test file breaks on the next added field.
  return makeSettings({ runbooks_enabled: runbooksEnabled, ...overrides });
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
