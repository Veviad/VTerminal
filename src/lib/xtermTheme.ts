import type { ITheme } from "@xterm/xterm";

// xterm's ITheme requires concrete color strings — CSS var() references do NOT
// work. The 20 Veviad tokens are resolved live via getComputedStyle (safe in the
// same tick as applyTheme, which sets inline vars synchronously); the 16 ANSI
// colors have no CSS-token equivalent, so they are defined per theme id here,
// keeping themes.ts a pristine Cowork copy.
export interface Ansi16 {
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

export const ANSI_BY_THEME: Record<string, Ansi16> = {
  "veviad-developer": {
    black: "#27272a",
    red: "#f87171",
    green: "#34d399",
    yellow: "#fbbf24",
    blue: "#60a5fa",
    magenta: "#c084fc",
    cyan: "#22d3ee",
    white: "#d4d4d8",
    brightBlack: "#52525b",
    brightRed: "#fca5a5",
    brightGreen: "#6ee7b7",
    brightYellow: "#fcd34d",
    brightBlue: "#93c5fd",
    brightMagenta: "#d8b4fe",
    brightCyan: "#67e8f9",
    brightWhite: "#fafafa",
  },
  "veviad-ui": {
    black: "#2a2942",
    red: "#f87171",
    green: "#34d399",
    yellow: "#fbbf24",
    blue: "#818cf8",
    magenta: "#a78bfa",
    cyan: "#22d3ee",
    white: "#d6d4e0",
    brightBlack: "#5c5a6e",
    brightRed: "#fca5a5",
    brightGreen: "#6ee7b7",
    brightYellow: "#fcd34d",
    brightBlue: "#a5b4fc",
    brightMagenta: "#c4b5fd",
    brightCyan: "#67e8f9",
    brightWhite: "#ededf0",
  },
  midnight: {
    black: "#1e293b",
    red: "#f87171",
    green: "#4ade80",
    yellow: "#facc15",
    blue: "#818cf8",
    magenta: "#c084fc",
    cyan: "#22d3ee",
    white: "#cbd5e1",
    brightBlack: "#475569",
    brightRed: "#fca5a5",
    brightGreen: "#86efac",
    brightYellow: "#fde047",
    brightBlue: "#a5b4fc",
    brightMagenta: "#d8b4fe",
    brightCyan: "#67e8f9",
    brightWhite: "#e2e8f0",
  },
  // Official Nord terminal palette
  nord: {
    black: "#3b4252",
    red: "#bf616a",
    green: "#a3be8c",
    yellow: "#ebcb8b",
    blue: "#81a1c1",
    magenta: "#b48ead",
    cyan: "#88c0d0",
    white: "#e5e9f0",
    brightBlack: "#4c566a",
    brightRed: "#bf616a",
    brightGreen: "#a3be8c",
    brightYellow: "#ebcb8b",
    brightBlue: "#81a1c1",
    brightMagenta: "#b48ead",
    brightCyan: "#8fbcbb",
    brightWhite: "#eceff4",
  },
  // Official Solarized terminal palette
  "solarized-dark": {
    black: "#073642",
    red: "#dc322f",
    green: "#859900",
    yellow: "#b58900",
    blue: "#268bd2",
    magenta: "#d33682",
    cyan: "#2aa198",
    white: "#eee8d5",
    brightBlack: "#586e75",
    brightRed: "#cb4b16",
    brightGreen: "#859900",
    brightYellow: "#b58900",
    brightBlue: "#268bd2",
    brightMagenta: "#6c71c4",
    brightCyan: "#93a1a1",
    brightWhite: "#fdf6e3",
  },
  // Dark-on-light. The bright row is LIGHTER than the normal row so "bright"
  // still reads as bright, but on a light ground lighter means less contrast —
  // so both rows are pulled down far enough to stay legible on #eef0f2 (normal
  // >= 5.0:1, bright >= 4.4:1). The earlier palette had the polarity of the
  // grey slots inverted: white #adb5bd was 1.82:1 and brightWhite #868e96 was
  // 2.91:1, so anything printing white text vanished. white is now the mid
  // grey and brightWhite the darkest slot, which is what programs reach for
  // when they want emphasis. brightBlack is the one deliberate exception at
  // 3.41:1 — it is the dim slot tools use for de-emphasis.
  light: {
    black: "#2b2b3c",
    red: "#b4232a",
    green: "#1f6b32",
    yellow: "#8a5d00",
    blue: "#1a4fb0",
    magenta: "#7b4a99",
    cyan: "#0b6478",
    white: "#5c636a",
    brightBlack: "#7a828a",
    brightRed: "#c22b30",
    brightGreen: "#257538",
    brightYellow: "#946500",
    brightBlue: "#2563c9",
    brightMagenta: "#874ba8",
    brightCyan: "#0b7288",
    brightWhite: "#1a1a2e",
  },
};

/** Read a theme token as a concrete color. xterm's ITheme and its decoration
 *  options take literal colors, never CSS vars, so anything handing colors to
 *  xterm has to resolve them here rather than referencing --color-* directly. */
export function cssVar(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

export function resolveXtermTheme(themeId: string): ITheme {
  const v = cssVar;
  const ansi = ANSI_BY_THEME[themeId] ?? ANSI_BY_THEME["veviad-developer"];
  return {
    // Opaque background — allowTransparency costs WebGL performance.
    background: v("--color-bg-terminal", "#0a0a0c"),
    foreground: v("--color-text-primary", "#fafafa"),
    cursor: v("--color-accent", "#10b981"),
    cursorAccent: v("--color-bg-terminal", "#0a0a0c"),
    selectionBackground: v("--color-selection", "rgba(16,185,129,0.25)"),
    ...ansi,
  };
}
