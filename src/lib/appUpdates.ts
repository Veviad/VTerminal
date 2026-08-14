import * as api from "./tauri";
import {
  preparePersistenceForExit,
  resumePersistenceAfterFailedExit,
} from "./sessionPersistence";
import { initialUpdateState, useUpdateStore } from "../stores/updateStore";

export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

let checkPromise: Promise<void> | null = null;
let installPromise: Promise<void> | null = null;
let pendingReady = false;
let cancelRequested = false;

class UpdateCancelled extends Error {
  constructor() {
    super("Update download cancelled.");
    this.name = "UpdateCancelled";
  }
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const isCancellation = (error: unknown) =>
  error instanceof UpdateCancelled || /update download cancelled/i.test(message(error));

export function checkForUpdates(
  options: { manual?: boolean; prompt?: boolean; promptAllowed?: () => boolean } = {},
): Promise<void> {
  if (checkPromise) return checkPromise;
  if (installPromise) return Promise.resolve();

  checkPromise = (async () => {
    useUpdateStore.setState({ status: "checking", error: null });
    try {
      const metadata = await api.updateCheck();
      const lastCheckedAt = new Date().toISOString();
      pendingReady = metadata !== null;
      if (!metadata) {
        useUpdateStore.setState({
          status: "up_to_date",
          metadata: null,
          lastCheckedAt,
          error: null,
          promptOpen: false,
          downloadedBytes: 0,
          totalBytes: null,
        });
        return;
      }

      const state = useUpdateStore.getState();
      const shouldPrompt =
        (options.prompt ?? true) &&
        (options.promptAllowed?.() ?? true) &&
        state.dismissedVersion !== metadata.version;
      useUpdateStore.setState({
        status: "available",
        metadata,
        lastCheckedAt,
        error: null,
        promptOpen: shouldPrompt,
        downloadedBytes: 0,
        totalBytes: null,
      });
    } catch (error) {
      pendingReady = false;
      useUpdateStore.setState({
        status: "error",
        lastCheckedAt: new Date().toISOString(),
        error: message(error),
        promptOpen: false,
      });
    }
  })().finally(() => {
    checkPromise = null;
  });
  return checkPromise;
}

export function dismissUpdatePrompt(): void {
  const version = useUpdateStore.getState().metadata?.version ?? null;
  useUpdateStore.setState({ promptOpen: false, dismissedVersion: version });
}

export function installPendingUpdate(): Promise<void> {
  if (installPromise) return installPromise;

  installPromise = (async () => {
    let persistencePrepared = false;
    cancelRequested = false;
    try {
      if (!useUpdateStore.getState().workspaceReady) {
        throw new Error("Finish restoring the workspace before installing the update.");
      }
      // The backend consumes its pending Update on an installation attempt. A
      // retry therefore refreshes the signed manifest before trying again.
      if (!pendingReady) {
        await checkForUpdates({ prompt: false });
        if (!pendingReady) throw new Error("No update is available to install.");
      }

      useUpdateStore.setState({
        status: "downloading",
        error: null,
        promptOpen: true,
        downloadedBytes: 0,
        totalBytes: null,
      });
      pendingReady = false;
      const downloadId = await api.updateDownload((event) => {
        switch (event.event) {
          case "Started":
            useUpdateStore.setState((state) =>
              state.status === "downloading"
                ? { totalBytes: state.totalBytes ?? event.data.totalBytes }
                : {},
            );
            break;
          case "Progress":
            useUpdateStore.setState((state) =>
              state.status === "downloading"
                ? {
                    downloadedBytes: Math.max(
                      state.downloadedBytes,
                      event.data.downloadedBytes,
                    ),
                    totalBytes: state.totalBytes ?? event.data.totalBytes,
                  }
                : {},
            );
            break;
          case "Verifying":
            if (useUpdateStore.getState().status === "downloading") {
              useUpdateStore.setState({ status: "verifying" });
            }
            break;
          case "ReadyToInstall":
            if (["downloading", "verifying"].includes(useUpdateStore.getState().status)) {
              useUpdateStore.setState({ status: "saving" });
            }
            break;
        }
      });

      if (cancelRequested) {
        // A verified payload may have won the race with the cancellation IPC.
        // Clear it explicitly and never cross into persistence or installation.
        try {
          await api.updateCancel();
        } catch (error) {
          console.error("Could not clear a cancelled verified update:", error);
        }
        throw new UpdateCancelled();
      }

      // Freeze new writes only after the package has been signature-verified.
      // The barrier strictly saves existing state before installation starts.
      useUpdateStore.setState({ status: "saving" });
      await preparePersistenceForExit();
      persistencePrepared = true;

      useUpdateStore.setState({ status: "installing" });
      await api.updateApply(downloadId);
      useUpdateStore.setState({ status: "restarting" });
      await api.appRestart();
    } catch (error) {
      if (cancelRequested || isCancellation(error)) {
        pendingReady = false;
        useUpdateStore.setState({
          status: "available",
          error: null,
          promptOpen: true,
          downloadedBytes: 0,
          totalBytes: null,
        });
        return;
      }

      let errorMessage = message(error);
      if (persistencePrepared) {
        try {
          await resumePersistenceAfterFailedExit();
        } catch (resumeError) {
          console.error("Could not resume persistence after a failed update exit:", resumeError);
          const separator = /[.!?]$/.test(errorMessage.trim()) ? " " : ". ";
          errorMessage += `${separator}Workspace autosave could not be resumed; restart VTerminal before continuing.`;
        }
      }
      useUpdateStore.setState({ status: "error", error: errorMessage, promptOpen: true });
    }
  })().finally(() => {
    cancelRequested = false;
    installPromise = null;
  });
  return installPromise;
}

export async function cancelPendingUpdate(): Promise<void> {
  const status = useUpdateStore.getState().status;
  if (!installPromise || !["downloading", "verifying", "cancelling"].includes(status)) {
    return;
  }
  if (status === "cancelling") return installPromise;

  cancelRequested = true;
  useUpdateStore.setState({ status: "cancelling", error: null, promptOpen: true });
  const activeInstall = installPromise;
  try {
    await api.updateCancel();
  } catch (error) {
    // Preserve the stop intent even if signalling fails. A result that races
    // with this request is refused above and can never be installed.
    console.error("Could not signal update download cancellation:", error);
  }
  await activeInstall;
}

/** Timer seam used by the hook and fake-timer tests. */
export function startAutoUpdateChecks(check?: () => void): () => void {
  let active = true;
  const run =
    check ??
    (() => void checkForUpdates({ promptAllowed: () => active }));
  run();
  const timer = setInterval(run, UPDATE_CHECK_INTERVAL_MS);
  return () => {
    active = false;
    clearInterval(timer);
  };
}

/** Test seam: no production caller should forget a discovered pending update. */
export function __resetAppUpdatesForTests(): void {
  checkPromise = null;
  installPromise = null;
  pendingReady = false;
  cancelRequested = false;
  useUpdateStore.setState({ ...initialUpdateState });
}
