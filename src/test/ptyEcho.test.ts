import { readFileSync } from "node:fs";
import { Terminal } from "@xterm/xterm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cancelPtyEcho, expectPtyEcho, writePtyOutput } from "../lib/ptyEcho";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const nonce = "0123456789abcdef0123456789abcdef";
const visible = "printf 'hello world\\n'";
const line = `${visible}; printf '\\033]6973;RD;%s;${nonce}\\007' $?`;
const completion = `\x1b]6973;RD;0;${nonce}\x07`;

// The parser works without opening a renderer. Avoid jsdom's unsupported
// canvas warning from xterm's optional color-format probe during import.
const canvasContext = vi.hoisted(() =>
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => null),
);
afterAll(() => canvasContext.mockRestore());

interface EchoFixture {
  shell: string;
  cols: number;
  prompt: string;
  rprompt: string;
  kind: "probe" | "sentinel";
  line: string;
  initial: string;
  rawEcho: string;
  rawOutput: string;
}

// Captured with real interactive bash 3.2 and zsh 5.9 PTYs using
// TERM=xterm-256color. Includes ZLE margin redraws and right-prompt erasure.
const fixtures = JSON.parse(
  readFileSync("src/test/fixtures/pty-echo.json", "utf8"),
) as EchoFixture[];

class RecordingTerminal {
  chunks: Uint8Array[] = [];
  callbacks: Array<() => void> = [];

  write(data: string | Uint8Array, callback?: () => void): void {
    this.chunks.push(typeof data === "string" ? encoder.encode(data) : data.slice());
    if (callback) this.callbacks.push(callback);
  }

  get output(): string {
    const bytes = new Uint8Array(this.chunks.reduce((size, chunk) => size + chunk.length, 0));
    let offset = 0;
    for (const chunk of this.chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return decoder.decode(bytes);
  }
}

describe("PTY command echo filtering", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it.each(fixtures)(
    "replaces a real $shell $kind echo at $cols columns (right prompt: '$rprompt') at every byte boundary",
    (fixture) => {
      const bytes = encoder.encode(fixture.rawOutput);
      const modes = fixture.shell === "zsh" ? "\x1b[?2004l" : "";
      const erase = fixture.rawEcho.includes("\x1b[K") ? "\x1b[K" : "";
      const replacement = fixture.kind === "probe" ? "\r\x1b[2K" : `${erase}${visible}\r\n`;
      const expected = replacement + modes + fixture.rawOutput.slice(fixture.rawEcho.length);
      for (let split = 0; split <= bytes.length; split++) {
        const term = new RecordingTerminal();
        expectPtyEcho(term, fixture.line, fixture.kind === "probe" ? null : visible);
        writePtyOutput(term, bytes.subarray(0, split));
        writePtyOutput(term, bytes.subarray(split));
        expect(term.output, `split at byte ${split}`).toBe(expected);
      }
    },
  );

  it("preserves UTF-8 commands and output when every incoming chunk is one byte", () => {
    const term = new RecordingTerminal();
    const unicodeCommand = "printf 'Grüße 🍰 東京\\n'";
    const unicodeLine = unicodeCommand + line.slice(visible.length);
    expectPtyEcho(term, unicodeLine, unicodeCommand);
    const raw = encoder.encode(`${unicodeLine}\r\nGrüße 🍰 東京\r\n${completion}`);
    for (const byte of raw) writePtyOutput(term, Uint8Array.of(byte));
    expect(term.output).toBe(`${unicodeCommand}\r\nGrüße 🍰 東京\r\n${completion}`);
  });

  it("preserves standard and private terminal mode changes during echo replacement", () => {
    const term = new RecordingTerminal();
    expectPtyEcho(term, line, visible);
    writePtyOutput(term, encoder.encode(`${line}\x1b[4l\x1b[?2004l\r\n`));
    expect(term.output).toBe(`${visible}\r\n\x1b[4l\x1b[?2004l`);
  });

  it("passes ordinary output through without an armed expectation", () => {
    const term = new RecordingTerminal();
    const text = `${line}\r\n${completion}`;
    writePtyOutput(term, encoder.encode(text));
    expect(term.output).toBe(text);
  });

  it.each([
    `an unrelated line\r\n${line}\r\n`,
    `${line.replace(nonce, "fedcba9876543210fedcba9876543210")}\r\n`,
    `hello world\r\n${completion}`,
    `\x1b7${line}\r\n`,
  ])("fails open on mismatched or unfamiliar echoed bytes: %j", (raw) => {
    const term = new RecordingTerminal();
    expectPtyEcho(term, line, visible);
    writePtyOutput(term, encoder.encode(raw));
    writePtyOutput(term, encoder.encode(`${line}\r\n`));
    expect(term.output).toBe(raw + `${line}\r\n`);
  });

  it.each([completion, "\x1b]133;C\x1b\\", "\x1b]7;file://remote/tmp\x07"])(
    "immediately forwards actual OSC tokens, including tokens split after ESC: %j",
    (token) => {
      const term = new RecordingTerminal();
      expectPtyEcho(term, line, visible);
      writePtyOutput(term, encoder.encode("\x1b"));
      expect(term.output).toBe("");
      writePtyOutput(term, encoder.encode(token.slice(1)));
      expect(term.output).toBe(token);
      writePtyOutput(term, encoder.encode(`${line}\r\n`));
      expect(term.output).toBe(token + `${line}\r\n`);
    },
  );

  it("forwards a terminal status query immediately at every split boundary", () => {
    const query = encoder.encode("\x1b[6n");
    for (let split = 0; split <= query.length; split++) {
      const term = new RecordingTerminal();
      expectPtyEcho(term, line, visible);
      writePtyOutput(term, query.subarray(0, split));
      writePtyOutput(term, query.subarray(split));
      expect(term.output).toBe("\x1b[6n");
      writePtyOutput(term, encoder.encode(`${line}\r\n`));
      expect(term.output).toBe(`\x1b[6n${line}\r\n`);
    }
  });

  it("preserves a query and the full echoed line arriving in one chunk", () => {
    const term = new RecordingTerminal();
    expectPtyEcho(term, line, visible);
    const raw = `\x1b[6n${line}\r\n`;
    writePtyOutput(term, encoder.encode(raw));
    expect(term.output).toBe(raw);
  });

  it("immediately releases a DCS prefix without waiting for its terminator or a newline", () => {
    const term = new RecordingTerminal();
    expectPtyEcho(term, line, visible);
    writePtyOutput(term, encoder.encode("\x1b"));
    expect(term.output).toBe("");
    writePtyOutput(term, encoder.encode("P"));
    expect(term.output).toBe("\x1bP");
    writePtyOutput(term, encoder.encode("$q m\x1b\\"));
    expect(term.output).toBe("\x1bP$q m\x1b\\");
  });

  it("holds a partial echo until timeout, then releases it without consuming later output", () => {
    const term = new RecordingTerminal();
    expectPtyEcho(term, line, visible);
    writePtyOutput(term, encoder.encode("printf partial"));
    vi.advanceTimersByTime(1_999);
    expect(term.output).toBe("");
    vi.advanceTimersByTime(1);
    expect(term.output).toBe("printf partial");
    writePtyOutput(term, encoder.encode(" output\r\n"));
    expect(term.output).toBe("printf partial output\r\n");
  });

  it("cancels safely for user input or a failed write, and supports disposal without a final write", () => {
    const term = new RecordingTerminal();
    const cancel = expectPtyEcho(term, line, visible);
    writePtyOutput(term, encoder.encode("first partial"));
    cancel();
    cancel();
    expect(term.output).toBe("first partial");

    expectPtyEcho(term, line, visible);
    writePtyOutput(term, encoder.encode("discarded partial"));
    cancelPtyEcho(term, true);
    vi.advanceTimersByTime(2_000);
    expect(term.output).toBe("first partial");
  });

  it("releases the old echo when re-armed and ignores an old cancellation handle", () => {
    const term = new RecordingTerminal();
    const staleCancel = expectPtyEcho(term, "old line", null);
    writePtyOutput(term, encoder.encode("old partial"));
    expectPtyEcho(term, line, visible);
    expect(term.output).toBe("old partial");
    staleCancel();
    writePtyOutput(term, encoder.encode(`${line}\r\n`));
    expect(term.output).toBe(`old partial${visible}\r\n`);
  });

  it("bounds held bytes and forwards oversized input unchanged", () => {
    const term = new RecordingTerminal();
    expectPtyEcho(term, line, visible);
    writePtyOutput(term, encoder.encode("x".repeat(65_536)));
    expect(term.output).toBe("");
    writePtyOutput(term, encoder.encode("y"));
    expect(term.output).toBe("x".repeat(65_536) + "y");
    vi.advanceTimersByTime(2_000);
    expect(term.chunks).toHaveLength(1);
  });

  it("still replaces a short echo followed by a large output chunk", () => {
    const term = new RecordingTerminal();
    const output = "output ".repeat(12_000);
    expectPtyEcho(term, line, visible);
    writePtyOutput(term, encoder.encode(`${line}\r\n${output}`));
    expect(term.output).toBe(`${visible}\r\n${output}`);
  });

  it("acknowledges each original chunk once, including chunks held before replacement", () => {
    const term = new RecordingTerminal();
    const firstAck = vi.fn();
    const finalAck = vi.fn();
    expectPtyEcho(term, line, visible);
    const split = 23;
    writePtyOutput(term, encoder.encode(line.slice(0, split)), firstAck);
    expect(firstAck).not.toHaveBeenCalled();
    expect(term.chunks).toHaveLength(0);
    writePtyOutput(term, encoder.encode(`${line.slice(split)}\r\n${completion}`), finalAck);
    expect(firstAck).not.toHaveBeenCalled();
    expect(finalAck).not.toHaveBeenCalled();
    expect(term.callbacks).toHaveLength(1);
    term.callbacks[0]();
    expect(finalAck).toHaveBeenCalledOnce();
    expect(firstAck).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(2_000);
    expect(term.output).toBe(`${visible}\r\n${completion}`);
  });

  it.each([
    ["mismatched line", "unexpected\r\n"],
    ["terminal query", "\x1b[6n"],
    ["oversized echo", "x".repeat(65_536)],
  ])("acknowledges held bytes only after parsing a %s fallback", (_reason, suffix) => {
    const term = new RecordingTerminal();
    const firstAck = vi.fn();
    const finalAck = vi.fn();
    expectPtyEcho(term, line, visible);
    writePtyOutput(term, encoder.encode("partial"), firstAck);
    writePtyOutput(term, encoder.encode(suffix), finalAck);
    expect(firstAck).not.toHaveBeenCalled();
    expect(finalAck).not.toHaveBeenCalled();
    expect(term.output).toBe("partial" + suffix);
    expect(term.callbacks).toHaveLength(1);
    term.callbacks[0]();
    expect(firstAck).toHaveBeenCalledOnce();
    expect(finalAck).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(2_000);
    expect(term.callbacks).toHaveLength(1);
  });

  it.each(["timeout", "cancel", "rearm"])(
    "waits for parsing before acknowledging bytes released by %s",
    (reason) => {
      const term = new RecordingTerminal();
      const acknowledge = vi.fn();
      const cancel = expectPtyEcho(term, line, visible);
      writePtyOutput(term, encoder.encode("partial"), acknowledge);
      if (reason === "timeout") vi.advanceTimersByTime(2_000);
      else if (reason === "cancel") cancel();
      else expectPtyEcho(term, "next line", null);
      expect(acknowledge).not.toHaveBeenCalled();
      expect(term.output).toBe("partial");
      expect(term.callbacks).toHaveLength(1);
      term.callbacks[0]();
      expect(acknowledge).toHaveBeenCalledOnce();
      cancel();
      vi.advanceTimersByTime(2_000);
      expect(term.callbacks).toHaveLength(1);
    },
  );

  it("acknowledges discarded data once without writing into a closing terminal", () => {
    const term = new RecordingTerminal();
    const acknowledge = vi.fn();
    expectPtyEcho(term, line, visible);
    writePtyOutput(term, encoder.encode("partial"), acknowledge);
    expect(acknowledge).not.toHaveBeenCalled();
    cancelPtyEcho(term, true);
    cancelPtyEcho(term, true);
    vi.advanceTimersByTime(2_000);
    expect(acknowledge).toHaveBeenCalledOnce();
    expect(term.chunks).toHaveLength(0);
  });
});

describe("PTY echo filtering with xterm's real parser", () => {
  it.each(fixtures)(
    "renders a clean $shell $kind at $cols columns while preserving protocol tokens",
    async (fixture) => {
      const term = new Terminal({ cols: fixture.cols, rows: 24, allowProposedApi: true });
      const tokens: string[] = [];
      term.parser.registerOscHandler(6973, (payload) => {
        tokens.push(payload);
        return true;
      });
      try {
        await new Promise<void>((resolve) => term.write(fixture.initial, resolve));
        expectPtyEcho(term, fixture.line, fixture.kind === "probe" ? null : visible);
        await new Promise<void>((resolve) =>
          writePtyOutput(term, encoder.encode(fixture.rawOutput), resolve),
        );
        const buffer = term.buffer.active;
        const rendered = Array.from({ length: buffer.baseY + buffer.cursorY + 1 }, (_, row) =>
          buffer.getLine(row)?.translateToString(true) ?? "",
        ).join("\n");
        const withoutRightPrompt = fixture.rprompt
          ? rendered.replace(/ +RIGHT/g, " ")
          : rendered;
        expect(rendered).not.toMatch(/6973|ZSH_VERSION|BASH_VERSION|FISH_VERSION/);
        if (fixture.kind === "probe") {
          expect(withoutRightPrompt).toBe(fixture.prompt);
          expect(tokens).toHaveLength(1);
          expect(tokens[0]).toMatch(new RegExp(`^RP;${nonce};`));
        } else {
          if (fixture.rprompt && fixture.rawEcho.includes("\x1b[K")) {
            expect(rendered.split("\n")[0]).toBe(`${fixture.prompt}${visible}`);
          }
          expect(withoutRightPrompt.split("\n").map((row) => row.trimEnd())).toEqual([
            `${fixture.prompt}${visible}`,
            "hello world",
            fixture.prompt.trimEnd(),
          ]);
          expect(tokens).toEqual([`RD;0;${nonce}`]);
        }
        if (fixture.shell === "zsh") expect(term.modes.bracketedPasteMode).toBe(true);
      } finally {
        cancelPtyEcho(term, true);
        term.dispose();
      }
    },
  );
});
