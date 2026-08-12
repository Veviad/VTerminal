import type { IDisposable, IMarker, Terminal } from "@xterm/xterm";

// Block detection driven by OSC 133 semantic-prompt sequences emitted by the
// injected zsh integration script:
//   ESC]133;A ST  → prompt start
//   ESC]133;B ST  → prompt end / command input start
//   ESC]133;C ST  → command output start (command accepted)
//   ESC]133;D;<exit> ST → command finished
// Parsing happens here (frontend) because xterm's parser correctly reassembles
// sequences split across write() chunk boundaries.
export type Phase = "idle" | "prompt" | "input" | "output";

export interface BlockTrackerCallbacks {
  onBlockStart(blockId: string, command: string, startMarker: IMarker): void;
  onBlockEnd(blockId: string, exitCode: number, endMarker: IMarker | undefined): void;
  onBlockTrimmed(blockId: string): void;
  onCwdChange?(cwd: string, host: string | null): void;
  onPhaseChange?(phase: Phase): void;
  /** Any OSC 6973 payload that is NOT `CMD;…` — the app's private channel,
   *  used by the remote-session hook to report exit codes without touching the
   *  OSC 133 FSM (a remote `133;A` would wrongly close the enclosing ssh block). */
  onOscPrivate?(payload: string): void;
}

let nextBlockId = 1;

export class BlockTracker {
  phase: Phase = "idle";
  private inputMarker: IMarker | null = null;
  /** Cursor column when OSC 133;B arrived — input starts here on the marker line. */
  private inputStartX = 0;
  /** Exact command shipped out-of-band via OSC 6973 just before 133;C. */
  private pendingCommand: string | null = null;
  private currentBlockId: string | null = null;
  private disposables: IDisposable[] = [];
  /** True while the user hasn't typed since the prompt became ready. */
  private inputPristine = false;
  /** Set while restored scrollback is being written back. */
  private suspended = false;

  constructor(
    private term: Terminal,
    private cb: BlockTrackerCallbacks,
  ) {}

  /**
   * Stop acting on OSC while a payload we generated ourselves is written back
   * (restored scrollback). Belt-and-braces: xterm's serialize addon emits SGR,
   * DECSTBM, DECSET and cursor moves but no OSC at all, so nothing should reach
   * these handlers — but a replayed mark would create phantom blocks and, worse,
   * re-insert every replayed command into command_history.
   *
   * Handlers must still return TRUE while suspended: returning false makes
   * xterm print the raw escape sequence to the screen.
   */
  suspend(): void {
    this.suspended = true;
  }

  resume(): void {
    this.suspended = false;
  }

  attach(): void {
    this.disposables.push(
      this.term.parser.registerOscHandler(133, (data) => {
        if (this.suspended) return true;
        this.handle133(data);
        return true;
      }),
      // OSC 7 — cwd reporting (file://host/path)
      this.term.parser.registerOscHandler(7, (data) => {
        if (this.suspended) return true;
        const parsed = parseOsc7(data);
        if (parsed && this.cb.onCwdChange) this.cb.onCwdChange(parsed.path, parsed.host);
        return true;
      }),
      // OSC 6973;CMD;<b64> — the exact typed command, shipped by our zsh
      // preexec hook. Far more reliable than scraping the buffer, which picks
      // up RPROMPT/PS2 decorations.
      this.term.parser.registerOscHandler(6973, (data) => {
        if (this.suspended) return true;
        if (data.startsWith("CMD;")) {
          const decoded = decodeBase64Utf8(data.slice(4));
          if (decoded !== null) this.pendingCommand = decoded;
        } else {
          this.cb.onOscPrivate?.(data);
        }
        return true;
      }),
      this.term.onData(() => {
        if (this.phase === "input") this.inputPristine = false;
      }),
    );
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }

  /** True when the shell shows an empty prompt (used by the `#` composer trigger). */
  isAtEmptyPrompt(): boolean {
    return this.inputPristine && this.isAtPromptColumn();
  }

  /** `isAtEmptyPrompt` without the pristine requirement: the prompt is drawn and
   *  the cursor has not moved past the input column, so the line is empty even
   *  though *something* once arrived on onData. Needed because xterm answers
   *  DSR/DA queries through the same onData path that clears `inputPristine`,
   *  which would otherwise wedge the agent's idle gate shut forever. */
  isAtPromptColumn(): boolean {
    if (this.phase !== "input") return false;
    // Cursor still at the input start position — checking buffer text instead
    // would false-negative on RPROMPT decorations right of the cursor.
    const buf = this.term.buffer.active;
    const cursorLine = buf.baseY + buf.cursorY;
    const markerLine =
      this.inputMarker && this.inputMarker.line >= 0 ? this.inputMarker.line : cursorLine;
    return cursorLine === markerLine && buf.cursorX <= this.inputStartX;
  }

  private handle133(data: string): void {
    const code = data[0];
    const arg = data.length > 2 ? data.slice(2) : "";
    switch (code) {
      case "A": {
        // New prompt. If a block is still open (Ctrl-C'd TUI, no D received),
        // close it with unknown exit.
        if (this.phase === "output" && this.currentBlockId) {
          this.cb.onBlockEnd(this.currentBlockId, 0, this.safeMarker());
          this.currentBlockId = null;
        }
        this.setPhase("prompt");
        break;
      }
      case "B": {
        this.inputMarker = this.term.registerMarker(0) ?? null;
        this.inputStartX = this.term.buffer.active.cursorX;
        this.inputPristine = true;
        this.setPhase("input");
        break;
      }
      case "C": {
        // Prefer the exact command from OSC 6973; buffer scraping is the
        // fallback and may pick up RPROMPT/PS2 text.
        const command = this.pendingCommand ?? this.readCommandText();
        this.pendingCommand = null;
        const blockId = `blk-${nextBlockId++}`;
        this.currentBlockId = blockId;
        const startMarker = this.term.registerMarker(0);
        if (startMarker) {
          startMarker.onDispose(() => this.cb.onBlockTrimmed(blockId));
          this.cb.onBlockStart(blockId, command, startMarker);
        } else {
          // Buffer edge case — still track the block without a marker anchor.
          this.cb.onBlockStart(blockId, command, {
            line: this.term.buffer.active.baseY + this.term.buffer.active.cursorY,
          } as IMarker);
        }
        this.setPhase("output");
        break;
      }
      case "D": {
        if (this.currentBlockId) {
          const exitCode = Number.parseInt(arg || "0", 10);
          this.cb.onBlockEnd(
            this.currentBlockId,
            Number.isNaN(exitCode) ? 0 : exitCode,
            this.safeMarker(),
          );
          this.currentBlockId = null;
        }
        this.setPhase("idle");
        break;
      }
    }
  }

  private setPhase(phase: Phase): void {
    this.phase = phase;
    this.cb.onPhaseChange?.(phase);
  }

  private safeMarker(): IMarker | undefined {
    return this.term.registerMarker(0) ?? undefined;
  }

  /** Read the typed command from the buffer between the B marker/column and the cursor. */
  private readCommandText(): string {
    const buf = this.term.buffer.active;
    const start =
      this.inputMarker && this.inputMarker.line >= 0 ? this.inputMarker.line : buf.baseY + buf.cursorY;
    const end = buf.baseY + buf.cursorY;
    const lines: string[] = [];
    for (let y = start; y <= end && y < buf.length; y++) {
      const line = buf.getLine(y);
      if (!line) continue;
      // Input begins at inputStartX on the marker line (the prompt occupies the
      // columns before it); subsequent wrapped/continuation lines start at 0.
      lines.push(line.translateToString(true, y === start ? this.inputStartX : 0));
    }
    return lines.join("").trim();
  }
}

export function decodeBase64Utf8(b64: string): string | null {
  try {
    const binary = atob(b64.trim());
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

export function parseOsc7(data: string): { host: string | null; path: string } | null {
  // file://hostname/path/to/dir
  try {
    if (!data.startsWith("file://")) return null;
    const url = new URL(data);
    const path = decodeURIComponent(url.pathname);
    if (!path) return null;
    return { host: url.hostname || null, path };
  } catch {
    return null;
  }
}
