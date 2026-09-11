import { useEffect, useRef, useState } from "react";
import { AppShell } from "./components/layout/AppShell";
import { applyTheme } from "./lib/applyTheme";
import { updateAllTermOptions } from "./lib/termRegistry";
import { useAppStore } from "./stores/appStore";
import { useSettings } from "./hooks/useSettings";
import { useSessions } from "./hooks/useSessions";
import { startPersistence } from "./lib/sessionPersistence";
import { warmStart } from "./lib/selectModel";
import * as api from "./lib/tauri";
import { useAutoUpdater } from "./hooks/useAutoUpdater";
import { useUpdateStore } from "./stores/updateStore";
import { isWindows } from "./lib/platform";
import { openUrl } from "@tauri-apps/plugin-opener";
import { listen } from "@tauri-apps/api/event";
import { useChatStore } from "./stores/chatStore";

/** A run that gets this far is treated as good, resetting the crash-loop guard. */
const HEALTHY_AFTER_MS = 5_000;
const APP_QUIT_EVENT = "vterminal-app-quit-requested";

type WslIssue = "missing" | "wsl1" | "missing_bash" | "missing_tools" | "error";
type WslGateState = "checking" | "ready" | WslIssue;
type BootSettings = Awaited<ReturnType<typeof api.getSettings>>;

export default function App() {
  const [workspaceReady, setWorkspaceReady] = useState(false);
  // Do not mount AppShell on Windows until the prerequisite probe completes.
  // AppShell installs global shortcuts, so rendering it optimistically would let
  // Ctrl+Shift+T race a slow WSL startup and launch a session before validation.
  const [wslGate, setWslGate] = useState<WslGateState>(() =>
    isWindows() ? "checking" : "ready",
  );
  const [wslMessage, setWslMessage] = useState<string | null>(null);
  const [preparationAttempt, setPreparationAttempt] = useState(0);
  // Update prompts must wait until every saved tab has been restored and
  // persistence is watching the complete workspace. Otherwise an unusually
  // fast check/install can snapshot a half-restored tab set before restarting.
  useAutoUpdater(workspaceReady);
  const theme = useAppStore((s) => s.theme);
  const settingsLoaded = useAppStore((s) => s.settingsLoaded);
  const { loadSettings } = useSettings();
  const { createSession, restoreSessions } = useSessions();
  const booted = useRef(false);
  const attemptedPreparation = useRef(-1);
  const settingsResult = useRef<Promise<PromiseSettledResult<BootSettings>> | null>(null);

  // Settings and Windows preparation overlap. A retry reuses the settings
  // result and resumes workspace restoration once, after preparation succeeds.
  useEffect(() => {
    if (booted.current || attemptedPreparation.current === preparationAttempt) return;
    attemptedPreparation.current = preparationAttempt;
    const loadedSettings = settingsResult.current ??= loadSettings().then(
      (settings): PromiseFulfilledResult<BootSettings> => {
        applyTheme(settings.theme);
        return { status: "fulfilled", value: settings };
      },
      // Settle immediately so a settings failure cannot become an unhandled
      // rejection while a cold WSL distribution is still starting.
      (reason): PromiseRejectedResult => ({ status: "rejected", reason }),
    );
    void (async () => {
      if (isWindows()) {
        try {
          const info = await api.windowsTerminalPrepare(preparationAttempt > 0);
          if (info.wsl_status !== "ready") {
            setWslMessage(info.message);
            setWslGate(
              info.wsl_status === "wsl1"
                ? "wsl1"
                : info.wsl_status === "missing"
                  ? "missing"
                  : info.wsl_status === "missing_bash"
                    ? "missing_bash"
                    : info.wsl_status === "missing_tools"
                      ? "missing_tools"
                      : "error",
            );
            return;
          }
        } catch (error) {
          setWslMessage(String(error));
          setWslGate("error");
          return;
        }
      }
      const settings = await loadedSettings;
      booted.current = true;
      setWslMessage(null);
      setWslGate("ready");
      // Phase 1 — settings and terminals. Whatever happens, end with a shell
      // AND with persistence running: a boot that half-failed must still save
      // the user's tabs, or one bad launch silently disables restore for good.
      try {
        if (settings.status === "rejected") throw settings.reason;
        // MCP defaults are conversation snapshots. Load the redacted server
        // list before restoring or creating either Chat threads or terminal
        // conversations so every genuinely new conversation sees today's defaults.
        try {
          useAppStore.getState().setMcpServers(await api.mcpServersList());
        } catch (error) {
          console.error("MCP configuration failed to load:", error);
        }
        // Chat owns separate durable state and must never become a new failure
        // gate for terminal restoration. A damaged Chat row degrades to the
        // Terminal workspace while the user's existing shells still restore.
        try {
          await useChatStore
            .getState()
            .initialize(settings.value.workspace_mode, settings.value.active_chat_id);
        } catch (error) {
          console.error("Chat workspace restore failed:", error);
          useChatStore.setState({ initialized: true, workspaceMode: "terminal" });
        }
        // The model catalog gates the whole AI surface (see aiReady), so it has
        // to be present from boot — not only once the user opens Settings.
        void Promise.all([api.modelsCatalog(), api.getModelEffort()])
          .then(([catalog, effort]) => {
            const st = useAppStore.getState();
            st.setCatalog(catalog);
            st.setModelEffortMap(effort);
          })
          .catch((err) => console.error("Model catalog failed:", err));
        const restored = await restoreSessions();
        if (restored === 0) await createSession();
      } catch (err) {
        console.error("Boot failed:", err);
        if (useAppStore.getState().sessions.length === 0) {
          try {
            await createSession();
          } catch (e) {
            console.error("Fallback session failed:", e);
          }
        }
      } finally {
        startPersistence();
        useUpdateStore.setState({ workspaceReady: true });
        setWorkspaceReady(true);
        // Only declare the run healthy once it has actually survived a while;
        // doing it at boot would defeat the crash-loop guard entirely.
        setTimeout(
          () => void api.workspaceMarkHealthy().catch(() => {}),
          HEALTHY_AFTER_MS,
        );
      }

      // Phase 2 — model status, in its OWN try. Sharing the one above would let
      // a modelStatus() throw skip startPersistence and silently disable saving.
      try {
        const status = await api.modelStatus();
        useAppStore
          .getState()
          .setModelStatus(
            status.loaded,
            status.state,
            status.available,
            status.acceleration,
          );
        // Chat model first, vision sidecar second, never both at once —
        // `warmStart` owns that order and the reason for it. Detached, because a
        // multi-gigabyte load must not hold the rest of boot; `loadModel` and
        // `loadVisionModel` route their own failures into the store, so this
        // catch is for the unexpected rather than for "not downloaded yet".
        void warmStart(status).catch((err) =>
          console.error("Model warm-up failed:", err),
        );
      } catch (err) {
        console.error("Model status failed:", err);
      }
    })();
  }, [loadSettings, createSession, restoreSessions, preparationAttempt]);

  // Theme switches re-style both the DOM and every live terminal.
  useEffect(() => {
    if (!settingsLoaded) return;
    applyTheme(theme);
    updateAllTermOptions({ themeId: theme });
  }, [theme, settingsLoaded]);

  if (wslGate === "checking") {
    return (
      <>
        <PrerequisiteQuitFallback />
        <WslChecking />
      </>
    );
  }
  if (wslGate !== "ready") {
    return (
      <>
        <PrerequisiteQuitFallback />
        <WslRequired
          issue={wslGate}
          message={wslMessage}
          onRetry={() => {
            setWslGate("checking");
            setWslMessage(null);
            setPreparationAttempt((attempt) => attempt + 1);
          }}
        />
      </>
    );
  }
  return (
    <>
      {isWindows() && !workspaceReady && <PrerequisiteQuitFallback />}
      <AppShell />
    </>
  );
}

/**
 * The full persistence coordinator starts only after a usable terminal
 * workspace exists. While Windows is blocked on its prerequisite screen there
 * is intentionally no workspace to flush, but native close/menu requests still
 * need an immediate acknowledgement; otherwise Rust must wait for its bounded
 * crash-safe watchdog. The backend performs verified process cleanup and keeps
 * the previous workspace marked unclean/recoverable.
 */
function PrerequisiteQuitFallback() {
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void listen<{ token: number }>(APP_QUIT_EVENT, (event) => {
      void api
        .appQuitForce(
          event.payload.token,
          "Windows workspace startup has not completed",
        )
        .catch((error) => {
          console.warn("could not finish prerequisite-screen quit:", error);
        });
    })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch((error) => {
        console.warn("could not install prerequisite-screen quit hook:", error);
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
  return null;
}

function WslChecking() {
  return (
    <main
      className="flex h-full items-center justify-center bg-bg-primary p-8 text-text-primary"
      aria-busy="true"
    >
      <section className="text-center">
        <h1 className="text-lg font-semibold">VTerminal</h1>
        <p role="status" className="mt-2 text-sm text-text-muted">
          Starting your terminal…
        </p>
      </section>
    </main>
  );
}

function WslRequired({ issue, message, onRetry }: {
  issue: WslIssue;
  message: string | null;
  onRetry: () => void;
}) {
  const detail =
    issue === "wsl1"
      ? "Your default distribution is using WSL 1. VTerminal requires WSL 2."
      : issue === "missing"
        ? "No default WSL distribution was found."
        : issue === "missing_bash"
          ? "Your default WSL2 distribution does not provide /bin/bash."
          : issue === "missing_tools"
            ? "Your default WSL2 distribution is missing the standard POSIX tools VTerminal uses for terminal lifecycle and command reporting."
            : message || "VTerminal could not start the default WSL distribution.";
  return (
    <main className="flex h-full items-center justify-center bg-bg-primary p-8 text-text-primary">
      <section className="max-w-lg rounded-lg border border-border-subtle bg-bg-card p-6 shadow-lg">
        <h1 className="text-lg font-semibold">
          {issue === "error" ? "Your terminal could not start" : "WSL 2 and Bash are required"}
        </h1>
        <p className="mt-2 text-sm text-text-secondary">{detail}</p>
        <p className="mt-2 text-sm text-text-muted">
          {issue === "error"
            ? "Try again. If the problem continues, check that your default WSL distribution starts normally."
            : "Install or upgrade WSL and choose a default distribution, then retry."}
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-bg-primary"
            onClick={onRetry}
          >
            Retry
          </button>
          <button
            type="button"
            className="rounded-md border border-border-subtle px-3 py-2 text-sm font-medium"
            onClick={() =>
              void openUrl("https://learn.microsoft.com/windows/wsl/install")
            }
          >
            Open Microsoft WSL setup
          </button>
        </div>
      </section>
    </main>
  );
}
