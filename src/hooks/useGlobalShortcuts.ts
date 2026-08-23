import { useEffect } from "react";
import { matchesReserved, type AppAction } from "../lib/keymap";
import { useAppStore } from "../stores/appStore";
import { useSessions } from "./useSessions";
import { useSettings } from "./useSettings";
import { getTerm } from "../lib/termRegistry";
import { aiCancel } from "../lib/tauri";
import { toggleAiPanel } from "../lib/aiPanel";
import { isUpdateExitBarrier, useUpdateStore } from "../stores/updateStore";
import { useChatStore } from "../stores/chatStore";

/** Close the composer, cancelling any in-flight generation — otherwise the
 *  abandoned stream later resurrects a stale proposal into the closed UI. */
function closeComposer(sessionId: string): void {
  const s = useAppStore.getState();
  const ui = s.sessionUi[sessionId];
  if (ui?.composerStatus === "generating" && ui.composerRequestId) {
    void aiCancel(ui.composerRequestId).catch(() => {});
  }
  s.updateSessionUi(sessionId, {
    composerOpen: false,
    composerStatus: "idle",
    composerProposal: null,
    composerError: null,
    composerRequestId: null,
  });
}

export function useGlobalShortcuts(): void {
  const { createSession, closeSession } = useSessions();
  const { save } = useSettings();

  useEffect(() => {
    const dispatch = (action: AppAction) => {
      const s = useAppStore.getState();
      const gotoTab = (index: number) => {
        const sessions = s.sessions;
        if (!sessions.length) return;
        const target = index >= sessions.length ? sessions[sessions.length - 1] : sessions[index];
        if (target) s.setActiveSession(target.id);
      };
      switch (action) {
        case "new-tab":
          if (useChatStore.getState().workspaceMode === "chat") {
            void useChatStore.getState().createChat().catch(() => {});
          } else {
            void createSession().catch(() => {});
          }
          break;
        case "close-tab":
          if (s.activeSessionId) void closeSession(s.activeSessionId);
          break;
        case "next-tab":
        case "prev-tab": {
          const idx = s.sessions.findIndex((x) => x.id === s.activeSessionId);
          if (idx === -1) break;
          const delta = action === "next-tab" ? 1 : -1;
          const next = s.sessions[(idx + delta + s.sessions.length) % s.sessions.length];
          if (next) s.setActiveSession(next.id);
          break;
        }
        case "goto-tab-1":
        case "goto-tab-2":
        case "goto-tab-3":
        case "goto-tab-4":
        case "goto-tab-5":
        case "goto-tab-6":
        case "goto-tab-7":
        case "goto-tab-8":
          gotoTab(Number(action.slice(-1)) - 1);
          break;
        case "goto-tab-9":
          gotoTab(s.sessions.length - 1);
          break;
        case "command-palette":
          s.setPaletteOpen(!s.paletteOpen);
          break;
        case "toggle-composer":
          if (s.activeSessionId) {
            const ui = s.sessionUi[s.activeSessionId];
            if (ui?.composerOpen) closeComposer(s.activeSessionId);
            else s.updateSessionUi(s.activeSessionId, { composerOpen: true });
          }
          break;
        case "toggle-ai-panel":
          toggleAiPanel();
          break;
        case "terminal-search":
          if (s.activeSessionId) {
            const ui = s.sessionUi[s.activeSessionId];
            s.updateSessionUi(s.activeSessionId, { searchOpen: !ui?.searchOpen });
          }
          break;
        case "session-browser":
          // Two stacked pickers read as a rendering bug; the newer one wins.
          if (s.paletteOpen) s.setPaletteOpen(false);
          s.setSessionBrowserOpen(!s.sessionBrowserOpen);
          break;
        case "open-settings":
          s.setSettingsOpen(!s.settingsOpen);
          break;
        case "font-size-up":
          void save({ font_size: Math.min(20, s.fontSize + 1) });
          break;
        case "font-size-down":
          void save({ font_size: Math.max(10, s.fontSize - 1) });
          break;
        case "font-size-reset":
          void save({ font_size: 13 });
          break;
      }
    };

    const onKeyDown = (e: KeyboardEvent) => {
      const binding = matchesReserved(e);
      if (binding) {
        e.preventDefault();
        e.stopPropagation();
        // updateApply quiesces all PTYs before the installer is launched. Keep
        // consuming reserved shortcuts, but do not let any of them mutate app or
        // terminal state after the durable-exit barrier has begun.
        if (isUpdateExitBarrier(useUpdateStore.getState().status)) return;
        dispatch(binding.id);
        return;
      }
      // Esc closes overlays in priority order: palette → sessions → search → composer
      if (e.key === "Escape") {
        const s = useAppStore.getState();
        if (s.paletteOpen) {
          s.setPaletteOpen(false);
          refocusTerm();
          return;
        }
        // After the palette (which paints on top when both are open) and before
        // search/composer (which sit UNDER this modal — closing something the
        // user cannot see is a bug). The browser's own input handles Escape and
        // stops propagation; this is the fallback for when focus sits on a row's
        // Reopen or Remove button, whose keydown reaches the window instead.
        if (s.sessionBrowserOpen) {
          s.setSessionBrowserOpen(false);
          refocusTerm();
          return;
        }
        if (s.activeSessionId) {
          const ui = s.sessionUi[s.activeSessionId];
          if (ui?.searchOpen) {
            s.updateSessionUi(s.activeSessionId, { searchOpen: false });
            refocusTerm();
            return;
          }
          if (ui?.composerOpen) {
            closeComposer(s.activeSessionId);
            refocusTerm();
          }
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [createSession, closeSession, save]);
}

function refocusTerm(): void {
  const s = useAppStore.getState();
  if (s.activeSessionId) getTerm(s.activeSessionId)?.term.focus();
}
