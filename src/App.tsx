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

export default function App() {
  const [workspaceReady, setWorkspaceReady] = useState(false);
  // Do not mount AppShell on Windows until the prerequisite probe completes.
  // AppShell installs global shortcuts, so rendering it optimistically would let
  // Ctrl+Shift+T race a slow WSL startup and launch a session before validation.
  const [wslGate, setWslGate] = useState<WslGateState>(() =>
    isWindows() ? "checking" : "ready",
  );
  // Update prompts must wait until every saved tab has been restored and
  // persistence is watching the complete workspace. Otherwise an unusually
  // fast check/install can snapshot a half-restored tab set before restarting.
  useAutoUpdater(workspaceReady);
  const theme = useAppStore((s) => s.theme);
  const settingsLoaded = useAppStore((s) => s.settingsLoaded);
  const { loadSettings } = useSettings();
  const { createSession, restoreSessions } = useSessions();
  const booted = useRef(false);

  // One-time boot: settings → theme → restore (or one fresh tab) → model status.
  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    void (async () => {
      if (isWindows()) {
        try {
          const info = await api.getSystemInfo();
          if (info.wsl_status !== "ready") {
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
          setWslGate("ready");
        } catch {
          setWslGate("error");
          return;
        }
      }
      // Phase 1 — settings and terminals. Whatever happens, end with a shell
      // AND with persistence running: a boot that half-failed must still save
      // the user's tabs, or one bad launch silently disables restore for good.
      try {
        const settings = await loadSettings();
        applyTheme(settings.theme);
        // Chat owns separate durable state and must never become a new failure
        // gate for terminal restoration. A damaged Chat row degrades to the
        // Terminal workspace while the user's existing shells still restore.
        try {
          await useChatStore
            .getState()
            .initialize(settings.workspace_mode, settings.active_chat_id);
        } catch (error) {
          console.error("Chat workspace restore failed:", error);
          useChatStore.setState({ initialized: true, workspaceMode: "terminal" });
        }
        // MCP defaults are conversation snapshots, so load the redacted server
        // list before restore/new-tab creation. Reopened chats replace this with
        // their archived selection; a genuinely fresh tab receives today's defaults.
        try {
          useAppStore.getState().setMcpServers(await api.mcpServersList());
        } catch (error) {
          console.error("MCP configuration failed to load:", error);
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
  }, [loadSettings, createSession, restoreSessions]);

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
        <WslRequired issue={wslGate} />
      </>
    );
  }
  return <AppShell />;
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
          "Windows prerequisites are unavailable",
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
      <p role="status" className="text-sm text-text-muted">
        Checking WSL 2 prerequisites…
      </p>
    </main>
  );
}

function WslRequired({ issue }: { issue: WslIssue }) {
  const detail =
    issue === "wsl1"
      ? "Your default distribution is using WSL 1. VTerminal requires WSL 2."
      : issue === "missing"
        ? "No default WSL distribution was found."
        : issue === "missing_bash"
          ? "Your default WSL2 distribution does not provide /bin/bash."
          : issue === "missing_tools"
            ? "Your default WSL2 distribution is missing the standard POSIX tools VTerminal uses for terminal lifecycle and command reporting."
            : "VTerminal could not verify the default WSL distribution.";
  return (
    <main className="flex h-full items-center justify-center bg-bg-primary p-8 text-text-primary">
      <section className="max-w-lg rounded-lg border border-border-subtle bg-bg-card p-6 shadow-lg">
        <h1 className="text-lg font-semibold">WSL 2 and Bash are required</h1>
        <p className="mt-2 text-sm text-text-secondary">{detail}</p>
        <p className="mt-2 text-sm text-text-muted">
          Install or upgrade WSL, choose a default distribution, then reopen
          VTerminal. The app will never make this administrator-level change
          automatically.
        </p>
        <button
          type="button"
          className="mt-4 rounded-md bg-accent px-3 py-2 text-sm font-medium text-bg-primary"
          onClick={() =>
            void openUrl("https://learn.microsoft.com/windows/wsl/install")
          }
        >
          Open Microsoft WSL setup
        </button>
      </section>
    </main>
  );
}
