/**
 * AI panel visibility, written through to settings.json.
 *
 * The panel's open state is LAST-STATE, not a preference: whatever it was when
 * you quit is what you get back. That only holds if every path that changes it
 * persists — including the indirect ones ("Explain this block" force-opening the
 * panel), which is why callers go through here rather than touching the store
 * setter directly.
 *
 * Lives outside the store to keep it free of IPC: `useSettings.save` owns writes
 * everywhere else, but the panel is toggled from six places, several of them
 * outside React, so a plain function beats threading a hook through all of them.
 */
import * as api from "./tauri";
import { clampPanelRatio } from "./panelRatio";
import { useAppStore } from "../stores/appStore";

export function setAiPanelOpen(open: boolean): void {
  const store = useAppStore.getState();
  if (store.aiPanelOpen === open) return;
  store.setAiPanelOpen(open);
  // Fire-and-forget: failing to remember the panel state is not worth surfacing
  // an error over, and the UI has already moved.
  void api.saveSettings({ ai_panel_open: open }).catch(() => {});
}

export function toggleAiPanel(): void {
  setAiPanelOpen(!useAppStore.getState().aiPanelOpen);
}

/** Called once at the end of a drag — a per-frame write would hammer the store. */
export function commitAiPanelRatio(ratio: number): void {
  useAppStore.getState().setAiPanelRatio(ratio);
  void api.saveSettings({ ai_panel_ratio: clampPanelRatio(ratio) }).catch(() => {});
}

/**
 * Drag state, read by TerminalView's ResizeObserver.
 *
 * That observer is the ONLY caller of `pty_resize`, on a 16ms debounce. A drag
 * moves the terminal's width every frame, which at 16ms would fire ~60
 * SIGWINCH-bearing resizes a second at the shell. Widening the debounce while a
 * drag is live keeps the visual refit responsive but throttles what reaches the
 * PTY.
 */
let resizing = false;

export function beginPanelResize(): void {
  resizing = true;
}

export function endPanelResize(): void {
  resizing = false;
}

export function isPanelResizing(): boolean {
  return resizing;
}
