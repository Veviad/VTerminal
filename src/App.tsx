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

/** A run that gets this far is treated as good, resetting the crash-loop guard. */
const HEALTHY_AFTER_MS = 5_000;

export default function App() {
  const [workspaceReady, setWorkspaceReady] = useState(false);
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
      // Phase 1 — settings and terminals. Whatever happens, end with a shell
      // AND with persistence running: a boot that half-failed must still save
      // the user's tabs, or one bad launch silently disables restore for good.
      try {
        const settings = await loadSettings();
        applyTheme(settings.theme);
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
        setTimeout(() => void api.workspaceMarkHealthy().catch(() => {}), HEALTHY_AFTER_MS);
      }

      // Phase 2 — model status, in its OWN try. Sharing the one above would let
      // a modelStatus() throw skip startPersistence and silently disable saving.
      try {
        const status = await api.modelStatus();
        useAppStore
          .getState()
          .setModelStatus(status.loaded, status.state, status.available);
        // Chat model first, vision sidecar second, never both at once —
        // `warmStart` owns that order and the reason for it. Detached, because a
        // multi-gigabyte load must not hold the rest of boot; `loadModel` and
        // `loadVisionModel` route their own failures into the store, so this
        // catch is for the unexpected rather than for "not downloaded yet".
        void warmStart(status).catch((err) => console.error("Model warm-up failed:", err));
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

  return <AppShell />;
}
