// App-reserved keyboard shortcuts. Enforced in two places:
// 1. term.attachCustomKeyEventHandler(e => !matchesReserved(e)) — xterm ignores these
// 2. useGlobalShortcuts window listener — preventDefault + dispatch the action
export type AppAction =
  | "new-tab"
  | "close-tab"
  | "next-tab"
  | "prev-tab"
  | "goto-tab-1"
  | "goto-tab-2"
  | "goto-tab-3"
  | "goto-tab-4"
  | "goto-tab-5"
  | "goto-tab-6"
  | "goto-tab-7"
  | "goto-tab-8"
  | "goto-tab-9"
  | "command-palette"
  | "toggle-composer"
  | "toggle-ai-panel"
  | "terminal-search"
  | "session-browser"
  | "open-settings"
  | "font-size-up"
  | "font-size-down"
  | "font-size-reset";

export interface ReservedBinding {
  id: AppAction;
  /** e.g. "cmd+t", "cmd+shift+]" — cmd = metaKey on macOS */
  combo: string;
  label: string;
}

export const RESERVED: ReservedBinding[] = [
  { id: "new-tab", combo: "cmd+t", label: "New tab" },
  { id: "close-tab", combo: "cmd+w", label: "Close tab" },
  { id: "next-tab", combo: "cmd+shift+]", label: "Next tab" },
  { id: "prev-tab", combo: "cmd+shift+[", label: "Previous tab" },
  { id: "goto-tab-1", combo: "cmd+1", label: "Go to tab 1" },
  { id: "goto-tab-2", combo: "cmd+2", label: "Go to tab 2" },
  { id: "goto-tab-3", combo: "cmd+3", label: "Go to tab 3" },
  { id: "goto-tab-4", combo: "cmd+4", label: "Go to tab 4" },
  { id: "goto-tab-5", combo: "cmd+5", label: "Go to tab 5" },
  { id: "goto-tab-6", combo: "cmd+6", label: "Go to tab 6" },
  { id: "goto-tab-7", combo: "cmd+7", label: "Go to tab 7" },
  { id: "goto-tab-8", combo: "cmd+8", label: "Go to tab 8" },
  { id: "goto-tab-9", combo: "cmd+9", label: "Go to last tab" },
  { id: "command-palette", combo: "cmd+k", label: "Command palette" },
  { id: "toggle-composer", combo: "cmd+i", label: "AI command suggestion" },
  { id: "toggle-ai-panel", combo: "cmd+j", label: "Toggle AI panel" },
  { id: "terminal-search", combo: "cmd+f", label: "Search terminal" },
  // cmd+y, not cmd+h: no custom app menu is installed, so Tauri's default
  // macOS menu owns cmd+h as Hide Application. cmd+y is also Safari's and
  // Chrome's Show History, which is the muscle memory this borrows.
  { id: "session-browser", combo: "cmd+y", label: "Past sessions" },
  { id: "open-settings", combo: "cmd+,", label: "Settings" },
  { id: "font-size-up", combo: "cmd+=", label: "Increase font size" },
  { id: "font-size-down", combo: "cmd+-", label: "Decrease font size" },
  { id: "font-size-reset", combo: "cmd+0", label: "Reset font size" },
];

function comboMatches(combo: string, e: KeyboardEvent): boolean {
  const parts = combo.split("+");
  const key = parts[parts.length - 1];
  const needCmd = parts.includes("cmd");
  const needShift = parts.includes("shift");
  const needAlt = parts.includes("alt");
  const needCtrl = parts.includes("ctrl");
  if (e.metaKey !== needCmd) return false;
  if (e.shiftKey !== needShift) return false;
  if (e.altKey !== needAlt) return false;
  if (e.ctrlKey !== needCtrl) return false;
  // Match on e.key, case-insensitive; "=" also matches "+" (shifted layouts)
  const k = e.key.toLowerCase();
  if (key === "=") return k === "=" || k === "+";
  if (key === "[") return k === "[" || (e.code === "BracketLeft" && e.shiftKey);
  if (key === "]") return k === "]" || (e.code === "BracketRight" && e.shiftKey);
  return k === key;
}

export function matchesReserved(e: KeyboardEvent): ReservedBinding | null {
  if (!e.metaKey) return null; // all reserved combos are cmd-based
  for (const b of RESERVED) {
    if (comboMatches(b.combo, e)) return b;
  }
  return null;
}
