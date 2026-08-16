import { desktopPlatform, isWindows } from "./platform";

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

const MAC_RESERVED: ReservedBinding[] = [
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

export function bindingsForPlatform(platform: "windows" | "macos" | "other"): ReservedBinding[] {
  if (platform !== "windows") return MAC_RESERVED.map((binding) => ({ ...binding }));
  return MAC_RESERVED.map((binding) => ({
    ...binding,
    combo: binding.combo.startsWith("cmd+shift+")
      ? binding.combo.replace("cmd+shift+", "ctrl+shift+")
      : binding.combo.replace("cmd+", "ctrl+shift+"),
  }));
}

export const RESERVED: ReservedBinding[] = bindingsForPlatform(desktopPlatform());

export function shortcutFor(action: AppAction): string {
  const combo = RESERVED.find((binding) => binding.id === action)?.combo ?? "";
  return combo
    .replace("cmd+", "⌘")
    .replace("ctrl+", "Ctrl+")
    .replace("shift+", "Shift+")
    .replace("alt+", "Alt+")
    .replace(/(^|\+)([a-z])$/i, (_match, prefix: string, key: string) => `${prefix}${key.toUpperCase()}`);
}

export function usesAlternateAction(e: Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "shiftKey">): boolean {
  return isWindows() ? e.ctrlKey && e.shiftKey : e.metaKey;
}

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
  // Windows app bindings all include Shift, so punctuation and number keys
  // arrive as their shifted symbols (`!`, `_`, `{`, ...). Match the physical
  // code for those keys while retaining e.key as the layout-friendly fallback.
  const k = e.key.toLowerCase();
  if (/^[0-9]$/.test(key)) return k === key || e.code === `Digit${key}`;
  if (key === "=") return k === "=" || k === "+" || e.code === "Equal";
  if (key === "-") return k === "-" || k === "_" || e.code === "Minus";
  if (key === "[") return k === "[" || k === "{" || e.code === "BracketLeft";
  if (key === "]") return k === "]" || k === "}" || e.code === "BracketRight";
  if (key === ",") return k === "," || k === "<" || e.code === "Comma";
  return k === key;
}

function matchBindings(e: KeyboardEvent, bindings: ReservedBinding[]): ReservedBinding | null {
  if (!e.metaKey && !e.ctrlKey) return null;
  for (const binding of bindings) {
    if (comboMatches(binding.combo, e)) return binding;
  }
  return null;
}

export function matchesReserved(e: KeyboardEvent): ReservedBinding | null {
  return matchBindings(e, RESERVED);
}

/** Explicit-platform variant used by tests and platform-specific callers that
 * need to interpret an event before the browser environment is initialized. */
export function matchesReservedForPlatform(
  e: KeyboardEvent,
  platform: "windows" | "macos" | "other",
): ReservedBinding | null {
  return matchBindings(e, bindingsForPlatform(platform));
}
