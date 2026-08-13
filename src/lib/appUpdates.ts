import * as api from "./tauri";
import { flushAll } from "./sessionPersistence";
import { initialUpdateState, useUpdateStore } from "../stores/updateStore";

export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

let checkPromise: Promise<void> | null = null;
let installPromise: Promise<void> | null = null;
let pendingReady = false;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

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
      await api.updateInstall((event) => {
        if (event.event === "Started") {
          useUpdateStore.setState({ totalBytes: event.data.contentLength });
        } else if (event.event === "Progress") {
          useUpdateStore.setState((state) => ({
            downloadedBytes: state.downloadedBytes + event.data.chunkLength,
          }));
        } else {
          useUpdateStore.setState({ status: "installing" });
        }
      });
      useUpdateStore.setState({ status: "installing" });
      // The updater replaces the bundle before returning. Flush from the still
      // running old process, then let Tauri restart into the new one.
      await flushAll({ final: true, strict: true });
      await api.appRestart();
    } catch (error) {
      useUpdateStore.setState({ status: "error", error: message(error), promptOpen: true });
    }
  })().finally(() => {
    installPromise = null;
  });
  return installPromise;
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
  useUpdateStore.setState({ ...initialUpdateState });
}
