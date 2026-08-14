import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { UpdateDownloadEvent, UpdateMetadata } from "../lib/types";

const updateCheck = vi.fn<() => Promise<UpdateMetadata | null>>();
const updateDownload = vi.fn<(onEvent: (event: UpdateDownloadEvent) => void) => Promise<string>>();
const updateCancel = vi.fn<() => Promise<void>>();
const updateApply = vi.fn<(downloadId: string) => Promise<void>>();
const appRestart = vi.fn<() => Promise<void>>();
const preparePersistenceForExit = vi.fn<() => Promise<void>>();
const resumePersistenceAfterFailedExit = vi.fn<() => Promise<void>>();

vi.mock("../lib/tauri", () => ({
  updateCheck: () => updateCheck(),
  updateDownload: (onEvent: (event: UpdateDownloadEvent) => void) => updateDownload(onEvent),
  updateCancel: () => updateCancel(),
  updateApply: (downloadId: string) => updateApply(downloadId),
  appRestart: () => appRestart(),
}));
vi.mock("../lib/sessionPersistence", () => ({
  preparePersistenceForExit: () => preparePersistenceForExit(),
  resumePersistenceAfterFailedExit: () => resumePersistenceAfterFailedExit(),
}));

const {
  UPDATE_CHECK_INTERVAL_MS,
  __resetAppUpdatesForTests,
  checkForUpdates,
  cancelPendingUpdate,
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
  updateDownload.mockResolvedValue("download-1");
  updateCancel.mockResolvedValue();
  updateApply.mockResolvedValue();
  appRestart.mockResolvedValue();
  preparePersistenceForExit.mockResolvedValue();
  resumePersistenceAfterFailedExit.mockResolvedValue();
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
    expect(updateDownload).not.toHaveBeenCalled();
    expect(useUpdateStore.getState().error).toMatch(/Finish restoring the workspace/);
  });

  it("turns a vanished update into a retryable UI error", async () => {
    updateCheck.mockResolvedValue(null);
    await installPendingUpdate();
    expect(useUpdateStore.getState()).toMatchObject({
      status: "error",
      error: "No update is available to install.",
    });
    expect(updateDownload).not.toHaveBeenCalled();
  });

  it("uses absolute progress and moves through every verified exit phase", async () => {
    updateDownload.mockImplementation(async (onEvent) => {
      onEvent({ event: "Started", data: { totalBytes: 100 } });
      onEvent({ event: "Progress", data: { downloadedBytes: 40, totalBytes: 100 } });
      // Repeated cumulative events are idempotent; they are not chunk deltas.
      onEvent({ event: "Progress", data: { downloadedBytes: 40, totalBytes: 100 } });
      onEvent({ event: "Progress", data: { downloadedBytes: 100, totalBytes: 100 } });
      onEvent({ event: "Verifying" });
      onEvent({ event: "ReadyToInstall" });
      return "download-1";
    });
    await checkForUpdates();
    const statuses: string[] = [];
    const unsubscribe = useUpdateStore.subscribe((state) => statuses.push(state.status));
    await installPendingUpdate();
    unsubscribe();

    expect(useUpdateStore.getState()).toMatchObject({
      status: "restarting",
      downloadedBytes: 100,
      totalBytes: 100,
    });
    expect(statuses.filter((status, index) => status !== statuses[index - 1])).toEqual([
      "downloading",
      "verifying",
      "saving",
      "installing",
      "restarting",
    ]);
    expect(preparePersistenceForExit).toHaveBeenCalledTimes(1);
    expect(updateApply).toHaveBeenCalledWith("download-1");
    expect(appRestart).toHaveBeenCalledTimes(1);
    expect(preparePersistenceForExit.mock.invocationCallOrder[0]).toBeLessThan(
      updateApply.mock.invocationCallOrder[0],
    );
    expect(updateApply.mock.invocationCallOrder[0]).toBeLessThan(appRestart.mock.invocationCallOrder[0]);
    expect(resumePersistenceAfterFailedExit).not.toHaveBeenCalled();
  });

  it("cancels an in-flight download without preparing or applying the update", async () => {
    let rejectDownload: ((reason?: unknown) => void) | undefined;
    updateDownload.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectDownload = reject;
      }),
    );
    updateCancel.mockImplementation(async () => {
      rejectDownload?.(new Error("update download cancelled"));
    });
    await checkForUpdates();
    const statuses: string[] = [];
    const unsubscribe = useUpdateStore.subscribe((state) => statuses.push(state.status));
    const installation = installPendingUpdate();
    await waitFor(() => expect(useUpdateStore.getState().status).toBe("downloading"));

    const cancellation = cancelPendingUpdate();
    await Promise.all([installation, cancellation]);
    unsubscribe();

    expect(statuses).toContain("cancelling");
    expect(updateCancel).toHaveBeenCalledTimes(1);
    expect(preparePersistenceForExit).not.toHaveBeenCalled();
    expect(updateApply).not.toHaveBeenCalled();
    expect(appRestart).not.toHaveBeenCalled();
    expect(useUpdateStore.getState()).toMatchObject({
      status: "available",
      error: null,
      promptOpen: true,
      downloadedBytes: 0,
      totalBytes: null,
    });
  });

  it("ignores non-monotonic and late transfer events", async () => {
    updateDownload.mockImplementation(async (onEvent) => {
      onEvent({ event: "Started", data: { totalBytes: 100 } });
      onEvent({ event: "Progress", data: { downloadedBytes: 80, totalBytes: 100 } });
      onEvent({ event: "Progress", data: { downloadedBytes: 20, totalBytes: 100 } });
      expect(useUpdateStore.getState()).toMatchObject({
        status: "downloading",
        downloadedBytes: 80,
        totalBytes: 100,
      });

      onEvent({ event: "Verifying" });
      onEvent({ event: "Progress", data: { downloadedBytes: 100, totalBytes: 200 } });
      onEvent({ event: "Started", data: { totalBytes: 200 } });
      expect(useUpdateStore.getState()).toMatchObject({
        status: "verifying",
        downloadedBytes: 80,
        totalBytes: 100,
      });

      onEvent({ event: "ReadyToInstall" });
      return "download-1";
    });

    await checkForUpdates();
    await installPendingUpdate();
    expect(useUpdateStore.getState()).toMatchObject({
      status: "restarting",
      downloadedBytes: 80,
      totalBytes: 100,
    });
  });

  it("does not apply when preparing the durable exit fails", async () => {
    updateDownload.mockResolvedValue("download-1");
    preparePersistenceForExit.mockRejectedValue(new Error("snapshot failed"));
    await checkForUpdates();
    await installPendingUpdate();

    expect(appRestart).not.toHaveBeenCalled();
    expect(updateApply).not.toHaveBeenCalled();
    expect(useUpdateStore.getState()).toMatchObject({
      status: "error",
      error: "snapshot failed",
      promptOpen: true,
    });
    expect(resumePersistenceAfterFailedExit).not.toHaveBeenCalled();
  });

  it("resumes persistence after apply fails and preserves the install error", async () => {
    updateApply.mockRejectedValue(new Error("installer failed"));
    await checkForUpdates();
    await installPendingUpdate();

    expect(resumePersistenceAfterFailedExit).toHaveBeenCalledTimes(1);
    expect(appRestart).not.toHaveBeenCalled();
    expect(useUpdateStore.getState()).toMatchObject({
      status: "error",
      error: "installer failed",
      promptOpen: true,
    });
  });

  it("keeps the original error and adds recovery guidance when resume fails", async () => {
    updateApply.mockRejectedValue(new Error("installer failed"));
    resumePersistenceAfterFailedExit.mockRejectedValue(new Error("resume failed"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    await checkForUpdates();
    await installPendingUpdate();

    expect(useUpdateStore.getState().error).toMatch(
      /^installer failed\. Workspace autosave could not be resumed/,
    );
    expect(consoleError).toHaveBeenCalledWith(
      "Could not resume persistence after a failed update exit:",
      expect.any(Error),
    );
    consoleError.mockRestore();
  });

  it("rechecks before retrying a consumed failed update", async () => {
    updateDownload
      .mockRejectedValueOnce(new Error("signature failed"))
      .mockResolvedValueOnce("download-2");
    await checkForUpdates();
    await installPendingUpdate();
    expect(useUpdateStore.getState().error).toMatch(/signature failed/);

    await installPendingUpdate();
    expect(updateCheck).toHaveBeenCalledTimes(2);
    expect(updateDownload).toHaveBeenCalledTimes(2);
  });
});
