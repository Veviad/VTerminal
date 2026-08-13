import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { UpdateDownloadEvent, UpdateMetadata } from "../lib/types";

const updateCheck = vi.fn<() => Promise<UpdateMetadata | null>>();
const updateInstall = vi.fn<(onEvent: (event: UpdateDownloadEvent) => void) => Promise<void>>();
const appRestart = vi.fn<() => Promise<void>>();
const flushAll = vi.fn<(opts?: { final?: boolean; strict?: boolean }) => Promise<void>>();

vi.mock("../lib/tauri", () => ({
  updateCheck: () => updateCheck(),
  updateInstall: (onEvent: (event: UpdateDownloadEvent) => void) => updateInstall(onEvent),
  appRestart: () => appRestart(),
}));
vi.mock("../lib/sessionPersistence", () => ({
  flushAll: (opts: { final?: boolean; strict?: boolean }) => flushAll(opts),
}));

const {
  UPDATE_CHECK_INTERVAL_MS,
  __resetAppUpdatesForTests,
  checkForUpdates,
  dismissUpdatePrompt,
  installPendingUpdate,
  startAutoUpdateChecks,
} = await import("../lib/appUpdates");
const { useUpdateStore } = await import("../stores/updateStore");
const { useAppStore } = await import("../stores/appStore");
const { useAutoUpdater } = await import("../hooks/useAutoUpdater");

const available: UpdateMetadata = {
  current_version: "0.1.1",
  version: "0.2.0-beta.1",
  notes: "A faster, sharper beta.",
  published_at: "2026-08-13T00:00:00Z",
  prerelease: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  __resetAppUpdatesForTests();
  useUpdateStore.setState({ workspaceReady: true });
  useAppStore.setState({ settingsLoaded: false, autoUpdateEnabled: false });
  updateCheck.mockResolvedValue(available);
  appRestart.mockResolvedValue();
  flushAll.mockResolvedValue();
});

afterEach(() => vi.useRealTimers());

describe("release checks", () => {
  it("records a prerelease and opens one prompt", async () => {
    await checkForUpdates();
    expect(useUpdateStore.getState()).toMatchObject({
      status: "available",
      metadata: available,
      promptOpen: true,
    });

    dismissUpdatePrompt();
    await checkForUpdates();
    expect(useUpdateStore.getState().promptOpen).toBe(false);
    expect(updateCheck).toHaveBeenCalledTimes(2);
  });

  it("keeps a dismissed version quiet even after a manual check", async () => {
    await checkForUpdates();
    dismissUpdatePrompt();
    await checkForUpdates({ manual: true });
    expect(useUpdateStore.getState()).toMatchObject({
      status: "available",
      metadata: available,
      promptOpen: false,
    });
  });

  it("coalesces overlapping checks", async () => {
    let finish: ((value: UpdateMetadata | null) => void) | undefined;
    updateCheck.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const first = checkForUpdates();
    const second = checkForUpdates();
    expect(first).toBe(second);
    expect(updateCheck).toHaveBeenCalledTimes(1);
    finish?.(null);
    await first;
    expect(useUpdateStore.getState().status).toBe("up_to_date");
  });

  it("checks immediately and every 24 hours", () => {
    vi.useFakeTimers();
    const check = vi.fn();
    const stop = startAutoUpdateChecks(check);
    expect(check).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(UPDATE_CHECK_INTERVAL_MS);
    expect(check).toHaveBeenCalledTimes(2);
    stop();
    vi.advanceTimersByTime(UPDATE_CHECK_INTERVAL_MS);
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("starts on opt-in and cancels the daily timer on opt-out", async () => {
    vi.useFakeTimers();
    useAppStore.setState({ settingsLoaded: true, autoUpdateEnabled: false });
    const { rerender } = renderHook(
      ({ ready }) => useAutoUpdater(ready),
      { initialProps: { ready: false } },
    );
    expect(updateCheck).not.toHaveBeenCalled();

    rerender({ ready: true });
    expect(updateCheck).not.toHaveBeenCalled();

    act(() => useAppStore.setState({ autoUpdateEnabled: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(updateCheck).toHaveBeenCalledTimes(1);

    act(() => useAppStore.setState({ autoUpdateEnabled: false }));
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS);
    expect(updateCheck).toHaveBeenCalledTimes(1);
  });

  it("waits for workspace restoration before the first automatic check", async () => {
    vi.useFakeTimers();
    useAppStore.setState({ settingsLoaded: true, autoUpdateEnabled: true });
    const { rerender } = renderHook(
      ({ ready }) => useAutoUpdater(ready),
      { initialProps: { ready: false } },
    );
    expect(updateCheck).not.toHaveBeenCalled();

    rerender({ ready: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(updateCheck).toHaveBeenCalledTimes(1);
  });

  it("does not reopen an automatic prompt when opt-out happens mid-check", async () => {
    let finish: ((value: UpdateMetadata | null) => void) | undefined;
    updateCheck.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    useAppStore.setState({ settingsLoaded: true, autoUpdateEnabled: true });
    renderHook(() => useAutoUpdater(true));
    expect(updateCheck).toHaveBeenCalledTimes(1);

    act(() => useAppStore.setState({ autoUpdateEnabled: false }));
    await act(async () => finish?.(available));
    expect(useUpdateStore.getState()).toMatchObject({
      status: "available",
      metadata: available,
      promptOpen: false,
    });
  });

  it("surfaces an offline error without opening the prompt", async () => {
    updateCheck.mockRejectedValue(new Error("offline"));
    await checkForUpdates();
    expect(useUpdateStore.getState()).toMatchObject({
      status: "error",
      error: "offline",
      promptOpen: false,
    });
  });
});

describe("installation", () => {
  it("does not install until workspace restoration has completed", async () => {
    await checkForUpdates();
    useUpdateStore.setState({ workspaceReady: false });
    await installPendingUpdate();
    expect(updateInstall).not.toHaveBeenCalled();
    expect(useUpdateStore.getState().error).toMatch(/Finish restoring the workspace/);
  });

  it("turns a vanished update into a retryable UI error", async () => {
    updateCheck.mockResolvedValue(null);
    await installPendingUpdate();
    expect(useUpdateStore.getState()).toMatchObject({
      status: "error",
      error: "No update is available to install.",
    });
    expect(updateInstall).not.toHaveBeenCalled();
  });

  it("streams progress, flushes sessions, and restarts only after install", async () => {
    updateInstall.mockImplementation(async (onEvent) => {
      onEvent({ event: "Started", data: { contentLength: 100 } });
      onEvent({ event: "Progress", data: { chunkLength: 40 } });
      onEvent({ event: "Progress", data: { chunkLength: 60 } });
      onEvent({ event: "Finished" });
    });
    await checkForUpdates();
    await installPendingUpdate();

    expect(useUpdateStore.getState()).toMatchObject({
      status: "installing",
      downloadedBytes: 100,
      totalBytes: 100,
    });
    expect(flushAll).toHaveBeenCalledTimes(1);
    expect(flushAll).toHaveBeenCalledWith({ final: true, strict: true });
    expect(appRestart).toHaveBeenCalledTimes(1);
    expect(flushAll.mock.invocationCallOrder[0]).toBeLessThan(appRestart.mock.invocationCallOrder[0]);
  });

  it("does not restart when the required final snapshot fails", async () => {
    updateInstall.mockResolvedValue();
    flushAll.mockRejectedValue(new Error("snapshot failed"));
    await checkForUpdates();
    await installPendingUpdate();

    expect(appRestart).not.toHaveBeenCalled();
    expect(useUpdateStore.getState()).toMatchObject({
      status: "error",
      error: "snapshot failed",
      promptOpen: true,
    });
  });

  it("rechecks before retrying a consumed failed update", async () => {
    updateInstall
      .mockRejectedValueOnce(new Error("signature failed"))
      .mockResolvedValueOnce(undefined);
    await checkForUpdates();
    await installPendingUpdate();
    expect(useUpdateStore.getState().error).toMatch(/signature failed/);

    await installPendingUpdate();
    expect(updateCheck).toHaveBeenCalledTimes(2);
    expect(updateInstall).toHaveBeenCalledTimes(2);
  });
});
