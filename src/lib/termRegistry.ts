import { Terminal, type IDisposable } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebglAddon } from "@xterm/addon-webgl";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { ClipboardAddon } from "@xterm/addon-clipboard";
import { SerializeAddon } from "@xterm/addon-serialize";
import { openUrl } from "@tauri-apps/plugin-opener";
import { BlockTracker, type BlockTrackerCallbacks } from "./osc133";
import { sanitizeExternalWebUrl } from "./externalUrl";
import { matchesReserved } from "./keymap";
import { resolveXtermTheme } from "./xtermTheme";
import "@xterm/xterm/css/xterm.css";

// Terminals live OUTSIDE React state on purpose: xterm instances are stateful
// and expensive; React 19 StrictMode double-mounts effects. Components only
// attach/detach the container div — the Terminal survives across re-mounts and
// is disposed exclusively on session close.
export interface TermOptions {
  fontSize: number;
  scrollback: number;
  cursorStyle: "block" | "bar" | "underline";
  cursorBlink: boolean;
  themeId: string;
}

export interface BlockMarkers {
  start: import("@xterm/xterm").IMarker;
  end: import("@xterm/xterm").IMarker | null;
}

/** Terminal lifecycle events, published so non-React modules (the agent's PTY
 *  executor) can observe a session without reaching into xterm internals or
 *  re-registering competing OSC handlers. */
export type TermEvent =
  | { type: "blockStart"; blockId: string; command: string }
  | { type: "blockEnd"; blockId: string; exitCode: number; endLine: number | null }
  | { type: "blockTrimmed"; blockId: string }
  | { type: "phase"; phase: import("./osc133").Phase }
  | { type: "osc"; payload: string }
  | { type: "data" }
  | { type: "userInput" }
  /** A full-screen program took (or released) the alternate screen. */
  | { type: "bufferChange"; buffer: "normal" | "alternate" }
  | { type: "disposed" };

export interface TermEntry {
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  /** Registers no handlers and holds no state until called — free to keep loaded. */
  serialize: SerializeAddon;
  webgl: WebglAddon | null;
  webglFailed: boolean;
  tracker: BlockTracker;
  container: HTMLDivElement;
  unackedBytes: number;
  disposed: boolean;
  scrollListeners: Set<() => void>;
  /** Live xterm markers per block id — marker.line shifts with scrollback
   *  trimming and reflow, so positions are read from here at render time,
   *  never from static line snapshots. */
  blockMarkers: Map<string, BlockMarkers>;
  private_disposables: IDisposable[];
  termListeners: Set<(e: TermEvent) => void>;
  /** Date.now() of the last PTY bytes parsed — "has output stopped?". */
  lastDataAt: number;
  /** Date.now() of the last user keystroke — "is the user mid-typing?". */
  lastUserInputAt: number;
}

const entries = new Map<string, TermEntry>();

export function getTerm(sessionId: string): TermEntry | undefined {
  return entries.get(sessionId);
}

/** Subscribe to a session's terminal events. Returns an unsubscribe function. */
export function subscribeTerm(sessionId: string, fn: (e: TermEvent) => void): () => void {
  const entry = entries.get(sessionId);
  if (!entry) return () => {};
  entry.termListeners.add(fn);
  return () => {
    entry.termListeners.delete(fn);
  };
}

export function emitTerm(sessionId: string, event: TermEvent): void {
  const entry = entries.get(sessionId);
  if (!entry) return;
  // Copy: a listener may unsubscribe itself while resolving.
  for (const fn of [...entry.termListeners]) fn(event);
}

export function forEachTerm(fn: (entry: TermEntry, sessionId: string) => void): void {
  for (const [id, entry] of entries) fn(entry, id);
}

export function getOrCreateTerm(
  sessionId: string,
  opts: TermOptions,
  trackerCallbacks: BlockTrackerCallbacks,
  onHashTrigger?: () => void,
): TermEntry {
  const existing = entries.get(sessionId);
  if (existing) return existing;

  const term = new Terminal({
    fontFamily: '"JetBrains Mono", "Fira Code", ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: opts.fontSize,
    scrollback: opts.scrollback,
    cursorStyle: opts.cursorStyle,
    cursorBlink: opts.cursorBlink,
    allowProposedApi: true,
    macOptionIsMeta: false,
    theme: resolveXtermTheme(opts.themeId),
  });

  const container = document.createElement("div");
  container.className = "terminal-host";

  const fit = new FitAddon();
  const search = new SearchAddon();
  const serialize = new SerializeAddon();
  term.loadAddon(fit);
  term.loadAddon(search);
  term.loadAddon(serialize);
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = "11";
  term.loadAddon(
    new WebLinksAddon((_e, uri) => {
      const safeUrl = sanitizeExternalWebUrl(uri);
      if (safeUrl) void openUrl(safeUrl);
    }),
  );
  term.loadAddon(new ClipboardAddon());

  const tracker = new BlockTracker(term, trackerCallbacks);

  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== "keydown") return true;
    // Reserved app shortcuts never reach the shell; the event bubbles up to the
    // window listener in useGlobalShortcuts, which dispatches the action.
    if (matchesReserved(e)) return false;
    // Cmd+C copies only when a selection exists; otherwise let it through
    // (shells ignore it; Ctrl+C stays the interrupt).
    if (e.metaKey && e.key.toLowerCase() === "c" && term.hasSelection()) {
      void navigator.clipboard.writeText(term.getSelection());
      term.clearSelection();
      return false;
    }
    // "#" at an empty shell prompt opens the AI composer instead of typing.
    if (
      e.key === "#" &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.altKey &&
      tracker.isAtEmptyPrompt() &&
      onHashTrigger
    ) {
      onHashTrigger();
      return false;
    }
    return true;
  });

  const entry: TermEntry = {
    term,
    fit,
    search,
    serialize,
    webgl: null,
    webglFailed: false,
    tracker,
    container,
    unackedBytes: 0,
    disposed: false,
    scrollListeners: new Set(),
    blockMarkers: new Map(),
    private_disposables: [],
    termListeners: new Set(),
    lastDataAt: 0,
    lastUserInputAt: 0,
  };

  term.open(container);
  tracker.attach();

  entry.private_disposables.push(
    term.onScroll(() => entry.scrollListeners.forEach((fn) => fn())),
    term.onResize(() => entry.scrollListeners.forEach((fn) => fn())),
    term.onRender(() => entry.scrollListeners.forEach((fn) => fn())),
    // Quiescence signals for the agent's idle gate. onWriteParsed fires only
    // for bytes that came through term.write() — i.e. the PTY — while onData is
    // the user's keystrokes (plus xterm's own DSR/DA replies).
    term.onWriteParsed(() => {
      entry.lastDataAt = Date.now();
      emitTerm(sessionId, { type: "data" });
    }),
    term.onData(() => {
      entry.lastUserInputAt = Date.now();
      emitTerm(sessionId, { type: "userInput" });
    }),
    // vim/less/top seizing the alternate screen is the ONE unambiguous "the
    // agent's command hung" signal: the pre-flight gate proved we were at a
    // shell prompt, so whatever took the screen came from the line we typed.
    term.buffer.onBufferChange((buffer) =>
      emitTerm(sessionId, { type: "bufferChange", buffer: buffer.type }),
    ),
  );

  entries.set(sessionId, entry);
  return entry;
}

/** Attach the WebGL renderer — only the ACTIVE tab holds one (contexts are scarce). */
/** Hard ceiling per tab, whatever the line setting says. */
export const MAX_SNAPSHOT_CHARS = 262_144;

/**
 * Capture a tab's visible history for persistence. Returns null when there is
 * nothing worth storing or no size under the cap works.
 *
 * The two exclusions matter more than they look:
 *  - `excludeModes`: a dead vim's `?1000h`/`?2004h` would re-arm mouse reporting
 *    and bracketed paste in a terminal with no application to consume them.
 *  - `excludeAltBuffer`: quitting mid-vim must restore the shell scrollback that
 *    was UNDERNEATH the TUI, not a frozen editor screen.
 */
export function serializeSession(
  sessionId: string,
  maxLines: number,
): { data: string; lines: number } | null {
  const entry = entries.get(sessionId);
  if (!entry || entry.disposed || maxLines <= 0) return null;

  const attempt = (n: number) =>
    entry.serialize.serialize({
      scrollback: n,
      excludeModes: true,
      excludeAltBuffer: true,
    });

  // Step down rather than truncate: cutting a string of escape sequences
  // mid-sequence would replay as garbage.
  for (const n of [maxLines, Math.floor(maxLines / 4), 0]) {
    try {
      const data = attempt(n);
      if (data.length <= MAX_SNAPSHOT_CHARS) return { data, lines: n };
    } catch (err) {
      console.warn(`serialize failed (${sessionId}):`, err);
      return null;
    }
  }
  return null;
}

/**
 * Write a restored payload back. Resolves once xterm has PARSED it, which is
 * what lets the caller spawn the shell afterwards and know the two streams
 * cannot interleave — the ordering guarantee the whole replay design rests on.
 */
export function replayScrollback(sessionId: string, payload: string): Promise<void> {
  const entry = entries.get(sessionId);
  if (!entry || entry.disposed || !payload) return Promise.resolve();
  entry.tracker.suspend();
  return new Promise((resolve) => {
    entry.term.write(payload, () => {
      entry.tracker.resume();
      entry.term.scrollToBottom();
      resolve();
    });
  });
}

export function acquireWebgl(entry: TermEntry): void {
  if (entry.webgl || entry.disposed || entry.webglFailed) return;
  try {
    const addon = new WebglAddon();
    addon.onContextLoss(() => {
      addon.dispose();
      entry.webgl = null;
      // One retry after 500ms, then stay on the DOM renderer.
      setTimeout(() => {
        if (entry.disposed || entry.webgl) return;
        try {
          const retry = new WebglAddon();
          retry.onContextLoss(() => {
            retry.dispose();
            entry.webgl = null;
            entry.webglFailed = true;
          });
          entry.term.loadAddon(retry);
          entry.webgl = retry;
        } catch {
          entry.webglFailed = true;
        }
      }, 500);
    });
    entry.term.loadAddon(addon);
    entry.webgl = addon;
  } catch {
    entry.webglFailed = true;
  }
}

export function releaseWebgl(entry: TermEntry): void {
  if (!entry.webgl) return;
  entry.webgl.dispose();
  entry.webgl = null;
}

export function disposeTerm(sessionId: string): void {
  const entry = entries.get(sessionId);
  if (!entry) return;
  entry.disposed = true;
  // Tell subscribers BEFORE tearing down, so a pending agent command resolves
  // with "terminal closed" instead of waiting out its full timeout.
  emitTerm(sessionId, { type: "disposed" });
  entry.termListeners.clear();
  releaseWebgl(entry);
  entry.tracker.dispose();
  entry.blockMarkers.clear();
  for (const d of entry.private_disposables) d.dispose();
  entry.term.dispose();
  entry.container.remove();
  entries.delete(sessionId);
}

/** Apply a live option change (font size, theme, cursor…) to every terminal. */
export function updateAllTermOptions(patch: Partial<TermOptions>): void {
  forEachTerm((entry) => {
    if (patch.fontSize !== undefined) entry.term.options.fontSize = patch.fontSize;
    if (patch.scrollback !== undefined) entry.term.options.scrollback = patch.scrollback;
    if (patch.cursorStyle !== undefined) entry.term.options.cursorStyle = patch.cursorStyle;
    if (patch.cursorBlink !== undefined) entry.term.options.cursorBlink = patch.cursorBlink;
    if (patch.themeId !== undefined) entry.term.options.theme = resolveXtermTheme(patch.themeId);
    entry.fit.fit();
  });
}
