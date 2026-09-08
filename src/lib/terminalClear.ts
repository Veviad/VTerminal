import type { IDisposable, Terminal } from "@xterm/xterm";

type ClearableTerminal = Pick<Terminal, "buffer" | "clear" | "clearSelection" | "onWriteParsed" | "write">;

interface PendingClear {
  subscription?: IDisposable;
  onCleared?: () => void;
  generation: number;
  resolvers: Array<() => void>;
}

const pendingClears = new WeakMap<ClearableTerminal, PendingClear>();

/** Old history is still queued or cannot yet be cleared without disrupting an app. */
export function hasPendingTerminalClear(term: ClearableTerminal): boolean {
  return pendingClears.has(term);
}

function resolveWaiters(pending: PendingClear): void {
  for (const resolve of pending.resolvers.splice(0)) resolve();
}

function canClearNormalBuffer(term: ClearableTerminal): boolean {
  const buffer = term.buffer.active;
  if (buffer.type !== "normal") return false;
  if (buffer.baseY !== 0 || buffer.cursorY !== 0) return true;

  // xterm.clear() returns early at the first row with no scrollback. A program
  // that moved the cursor to the top can still have old output below it. Keep
  // that history pending until the cursor moves or the program erases it.
  for (let line = 1; line < buffer.length; line++) {
    if (buffer.getLine(line)?.translateToString(true).trim()) return false;
  }
  return true;
}

/** Settle pending work before disposing a terminal, even if writes never drain. */
export function cancelTerminalClear(term: ClearableTerminal): void {
  const pending = pendingClears.get(term);
  if (!pending) return;
  pending.subscription?.dispose();
  pendingClears.delete(term);
  resolveWaiters(pending);
}

function clearNormalBuffer(term: ClearableTerminal, pending: PendingClear): void {
  pending.subscription?.dispose();
  pendingClears.delete(term);
  try {
    term.clearSelection();
    term.clear();
    pending.onCleared?.();
  } finally {
    resolveWaiters(pending);
  }
}

/**
 * Clear display history without sending shell input or resetting terminal modes
 * or the parser. xterm keeps the current physical cursor row, including any
 * prompt and input on it. Its public clear API does not reconstruct wrapped
 * input. If the cursor is at row zero without scrollback while old output is
 * below it, defer until the cursor moves or the program erases that output,
 * since xterm.clear() otherwise silently retains those rows.
 *
 * An inactive normal buffer is read-only through xterm's public API. While an
 * alternate-screen app runs, defer clearing until it returns to normal and the
 * parser finishes restoring its cursor. The promise then resolves once this
 * deferred clear is registered; onCleared runs when clearing actually occurs.
 * Repeated requests replace the pending callback with the latest one and wait
 * for its write barrier. Call cancelTerminalClear before disposing the terminal.
 */
export function clearTerminalBuffer(term: ClearableTerminal, onCleared?: () => void): Promise<void> {
  return new Promise((resolve) => {
    const pending = pendingClears.get(term) ?? { generation: 0, resolvers: [] };
    pending.subscription?.dispose();
    pending.subscription = undefined;
    pending.onCleared = onCleared;
    pending.resolvers.push(resolve);
    const generation = ++pending.generation;
    // Mark the operation before the write barrier so persistence cannot capture
    // the history while xterm is still draining previously queued output.
    pendingClears.set(term, pending);

    // An empty write is a parser barrier. Injecting erase sequences instead
    // could corrupt an incomplete OSC/CSI arriving from the live connection.
    term.write("", () => {
      if (pendingClears.get(term) !== pending || pending.generation !== generation) return;
      if (canClearNormalBuffer(term)) {
        clearNormalBuffer(term, pending);
      } else {
        pending.subscription = term.onWriteParsed(() => {
          if (pendingClears.get(term) === pending && canClearNormalBuffer(term)) {
            clearNormalBuffer(term, pending);
          }
        });
        resolveWaiters(pending);
      }
    });
  });
}
