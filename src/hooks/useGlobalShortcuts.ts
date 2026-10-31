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

    // The fallback handler above runs in the bubble phase, after xterm has
    // already forwarded keyboard input to the PTY. When the search bar is open
    // but the terminal itself has focus, intercept Escape before xterm can send
    // it to the shell. Otherwise zsh can retain ESC as a Meta-key prefix and
    // consume the first character of the next command.
    let searchEscapeHeld = false;
    let searchEscapeTimeout: number | undefined;
    const releaseSearchEscape = () => {
      searchEscapeHeld = false;
      window.clearTimeout(searchEscapeTimeout);
      searchEscapeTimeout = undefined;
    };
    const keepSearchEscapeHeld = () => {
      searchEscapeHeld = true;
      window.clearTimeout(searchEscapeTimeout);
      // Recover if a keyup is lost; repeats refresh the timer while held.
      searchEscapeTimeout = window.setTimeout(releaseSearchEscape, 5_000);
    };
    const onSearchEscapeCapture = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // The search is already closed after the first keydown. Continue to
      // consume auto-repeat until keyup rather than forwarding a bare Escape
      // to the shell while the physical key remains held.
      if (searchEscapeHeld) {
        e.preventDefault();
        e.stopPropagation();
        keepSearchEscapeHeld();
        return;
      }
      const s = useAppStore.getState();
      const id = s.activeSessionId;
      if (!id || s.paletteOpen || s.sessionBrowserOpen || !s.sessionUi[id]?.searchOpen) return;
      if (getTerm(id)?.term.textarea !== e.target) return;
      e.preventDefault();
      e.stopPropagation();
      keepSearchEscapeHeld();
      s.updateSessionUi(id, { searchOpen: false });
      refocusTerm();
    };
    const onSearchEscapeKeyUp = (e: KeyboardEvent) => {
      if (e.key === "Escape") releaseSearchEscape();
    };

    window.addEventListener("keydown", onSearchEscapeCapture, true);
    window.addEventListener("keyup", onSearchEscapeKeyUp, true);
    window.addEventListener("blur", releaseSearchEscape);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      releaseSearchEscape();
      window.removeEventListener("keydown", onSearchEscapeCapture, true);
      window.removeEventListener("keyup", onSearchEscapeKeyUp, true);
      window.removeEventListener("blur", releaseSearchEscape);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [createSession, closeSession, save]);
}

function refocusTerm(): void {
  const s = useAppStore.getState();
  if (s.activeSessionId) getTerm(s.activeSessionId)?.term.focus();
}
