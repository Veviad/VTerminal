import { readFileSync } from "node:fs";
import { Terminal } from "@xterm/xterm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cancelPtyEcho, expectPtyEcho, writePtyOutput } from "../lib/ptyEcho";
import { onTerminalUserInput } from "../lib/terminalUserInput";
import { probeFor } from "../lib/ptyExecShell";

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
  platform: string;
  cols: number;
  prompt: string;
  rprompt: string;
  kind: "probe" | "sentinel";
  line: string;
  initial: string;
  rawEcho: string;
  rawOutput: string;
}

// Captured with real interactive macOS Bash 3.2/zsh 5.9 and Linux Bash 5 PTYs using
// TERM=xterm-256color. Includes ZLE margin redraws and right-prompt erasure.
const fixtures = JSON.parse(
  readFileSync("src/test/fixtures/pty-echo.json", "utf8"),
) as EchoFixture[];

// Captured from the isolated app's real integrated zsh at 85 columns. ZLE
// emitted CSI 1 C for the space between the private group and its redirect.
const privateRedraw = JSON.parse(
  readFileSync("src/test/fixtures/pty-echo-private-redraw.json", "utf8"),
) as { line: string; visible: string; chunks: string[] };

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
    "replaces a real $platform $shell $kind echo at $cols columns (right prompt: '$rprompt') at every byte boundary",
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

  it("replaces the real integrated private-command echo when ZLE uses cursor-forward for a space", () => {
    const raw = encoder.encode(privateRedraw.chunks.join(""));
    const expected = `\x1b[K${privateRedraw.visible}\r\n\x1b[?2004l`;
    const splits = [
      privateRedraw.chunks.map((chunk) => encoder.encode(chunk)),
      Array.from(raw, (byte) => Uint8Array.of(byte)),
      ...Array.from({ length: raw.length + 1 }, (_, at) => [raw.subarray(0, at), raw.subarray(at)]),
    ];
    for (const chunks of splits) {
      const term = new RecordingTerminal();
      expectPtyEcho(term, privateRedraw.line, privateRedraw.visible);
      for (const chunk of chunks) writePtyOutput(term, chunk);
      expect(term.output).toBe(expected);
    }
  });

  it("fails open on oversized cursor advances without allocating their claimed width", () => {
    const term = new RecordingTerminal();
    const raw = `${line}\x1b[999999999999999999999C\r\n`;
    expectPtyEcho(term, line, visible);
    writePtyOutput(term, encoder.encode(raw));
    expect(term.output).toBe(raw);
  });

  it("bounds the aggregate expansion of repeated cursor advances", () => {
    const term = new RecordingTerminal();
    const raw = `x${"\x1b[32768C".repeat(3)}\r\n`;
    expectPtyEcho(term, `x${" ".repeat(32768 * 3)}`, visible);
    writePtyOutput(term, encoder.encode(raw));
    expect(term.output).toBe(raw);
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

  it("hides a retired exact probe echo when SSH returns after twenty seconds", () => {
    const term = new RecordingTerminal();
    const probe = probeFor(nonce);
    const retire = expectPtyEcho(term, probe, null, { probeNonce: nonce });
    vi.advanceTimersByTime(10_000);
    retire(); // The request stopped awaiting readiness; its bytes may be late.
    vi.advanceTimersByTime(10_000);
    const reply = `\x1b]6973;RP;${nonce};z;b5.2;f\x07`;
    const acknowledge = vi.fn();
    writePtyOutput(term, encoder.encode(`${probe}\r\n${reply}remote$ `), acknowledge);
    expect(term.output).toBe(`\r\x1b[2K${reply}remote$ `);
    expect(acknowledge).not.toHaveBeenCalled();
    term.callbacks[0]();
    expect(acknowledge).toHaveBeenCalledOnce();
  });

  it("preserves queries immediately while an empty retired probe remains armed", () => {
    const term = new RecordingTerminal();
    const probe = probeFor(nonce);
    expectPtyEcho(term, probe, null, { probeNonce: nonce })();
    vi.advanceTimersByTime(20_000);
    writePtyOutput(term, encoder.encode("\x1b[6n"));
    expect(term.output).toBe("\x1b[6n");
    writePtyOutput(term, encoder.encode(`${probe}\r\n`));
    expect(term.output).toBe("\x1b[6n\r\x1b[2K");
  });

  it("does not park an empty chunk acknowledgment behind a retired probe", () => {
    const term = new RecordingTerminal();
    const acknowledge = vi.fn();
    expectPtyEcho(term, probeFor(nonce), null, { probeNonce: nonce })();
    writePtyOutput(term, new Uint8Array(), acknowledge);
    expect(term.callbacks).toHaveLength(1);
    term.callbacks[0]();
    expect(acknowledge).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(60_001);
    expect(term.callbacks).toHaveLength(1);
  });

  it("handles two owned late echoes and their distinct replies in one-byte chunks", () => {
    const term = new RecordingTerminal();
    const nextNonce = "fedcba9876543210fedcba9876543210";
    const first = probeFor(nonce);
    const second = probeFor(nextNonce);
    expectPtyEcho(term, first, null, { probeNonce: nonce })();
    vi.advanceTimersByTime(12_000);
    expectPtyEcho(term, second, null, { probeNonce: nextNonce })();
    const reply1 = `\x1b]6973;RP;${nonce};z;b5.2;f\x07`;
    const reply2 = `\x1b]6973;RP;${nextNonce};z;b5.2;f\x07`;
    const raw = encoder.encode(`${first}\r\n${reply1}${second}\r\n${reply2}`);
    for (const byte of raw) writePtyOutput(term, Uint8Array.of(byte));
    expect(term.output).toBe(`\r\x1b[2K${reply1}\r\x1b[2K${reply2}`);
  });

  it("retires an echo-disabled probe only for its own nonce reply", () => {
    const term = new RecordingTerminal();
    const nextNonce = "fedcba9876543210fedcba9876543210";
    const first = probeFor(nonce);
    const second = probeFor(nextNonce);
    expectPtyEcho(term, first, null, { probeNonce: nonce })();
    expectPtyEcho(term, second, null, { probeNonce: nextNonce })();
    const reply = `\x1b]6973;RP;${nonce};z;b5.2;f\x07`;
    writePtyOutput(term, encoder.encode(`${reply}${second}\r\n`));
    expect(term.output).toBe(`${reply}\r\x1b[2K`);
  });

  it("acknowledges a chunk containing two retired echoes only after its final bytes parse", () => {
    const term = new RecordingTerminal();
    const acknowledge = vi.fn();
    const nextNonce = "fedcba9876543210fedcba9876543210";
    const first = probeFor(nonce);
    const second = probeFor(nextNonce);
    expectPtyEcho(term, first, null, { probeNonce: nonce })();
    expectPtyEcho(term, second, null, { probeNonce: nextNonce })();
    writePtyOutput(term, encoder.encode(`${first}\r\n${second}\r\nrest`), acknowledge);
    expect(term.output).toBe("\r\x1b[2K\r\x1b[2Krest");
    expect(acknowledge).not.toHaveBeenCalled();
    expect(term.callbacks).toHaveLength(1);
    term.callbacks[0]();
    expect(acknowledge).toHaveBeenCalledOnce();
  });

  it.each(["expiry", "user input", "disposal"] as const)("preserves the exact text after retired-probe %s", (reason) => {
    const term = new RecordingTerminal();
    const probe = probeFor(nonce);
    expectPtyEcho(term, probe, null, { probeNonce: nonce })();
    if (reason === "expiry") vi.advanceTimersByTime(60_001);
    else cancelPtyEcho(term, reason === "disposal");
    writePtyOutput(term, encoder.encode(`${probe}\r\n`));
    expect(term.output).toBe(`${probe}\r\n`);
  });

  it("does not search past ambiguous genuine output for a retired probe", () => {
    const term = new RecordingTerminal();
    const probe = probeFor(nonce);
    expectPtyEcho(term, probe, null, { probeNonce: nonce })();
    const raw = `genuine output\r\n${probe}\r\n`;
    writePtyOutput(term, encoder.encode(raw));
    expect(term.output).toBe(raw);
  });

  it("preserves a changed probe line even when its nonce is unchanged", () => {
    const term = new RecordingTerminal();
    const probe = probeFor(nonce);
    expectPtyEcho(term, probe, null, { probeNonce: nonce })();
    const raw = `${probe} extra\r\n${probe}\r\n`;
    writePtyOutput(term, encoder.encode(raw));
    expect(term.output).toBe(raw);
  });

  it("does not retain a line without its declared exact nonce", () => {
    const term = new RecordingTerminal();
    const probe = probeFor(nonce);
    expectPtyEcho(term, probe, null, { probeNonce: "f".repeat(32) })();
    vi.advanceTimersByTime(3_000);
    writePtyOutput(term, encoder.encode(`${probe}\r\n`));
    expect(term.output).toBe(`${probe}\r\n`);
  });

  it("keeps the ordinary buffering deadline for a fragmented retired echo", () => {
    const term = new RecordingTerminal();
    const probe = probeFor(nonce);
    expectPtyEcho(term, probe, null, { probeNonce: nonce })();
    vi.advanceTimersByTime(20_000);
    writePtyOutput(term, encoder.encode(probe.slice(0, 12)));
    vi.advanceTimersByTime(2_001);
    expect(term.output).toBe(probe.slice(0, 12));
    writePtyOutput(term, encoder.encode(`${probe.slice(12)}\r\n`));
    expect(term.output).toBe(`${probe}\r\n`);
  });

  it("bounds the number of retained probe expectations", () => {
    const term = new RecordingTerminal();
    for (let index = 0; index < 5; index++) {
      const owned = index.toString(16).repeat(32);
      expectPtyEcho(term, probeFor(owned), null, { probeNonce: owned })();
    }
    const expired = `${probeFor("0".repeat(32))}\r\n`;
    writePtyOutput(term, encoder.encode(expired));
    expect(term.output).toBe(expired);
  });

  it("does not extend retired retention when the system clock moves backward", () => {
    const term = new RecordingTerminal();
    const probe = probeFor(nonce);
    expectPtyEcho(term, probe, null, { probeNonce: nonce })();
    vi.setSystemTime(Date.now() - 3_600_000);
    vi.advanceTimersByTime(60_001);
    writePtyOutput(term, encoder.encode(`${probe}\r\n`));
    expect(term.output).toBe(`${probe}\r\n`);
  });

  it.each([
    `an unrelated line\r\n${line}\r\n`,
    `${line.replace(nonce, "fedcba9876543210fedcba9876543210")}\r\n`,
    `hello world\r\n${completion}`,
    `\x1b7${line}\r\n`,
    `\x1b[?1049h${line}\r\n`,
    `\x1b[?1;1049;2004h${line}\r\n`,
  ])("fails open on mismatched or unfamiliar echoed bytes: %j", (raw) => {
    const term = new RecordingTerminal();
    expectPtyEcho(term, line, visible);
    writePtyOutput(term, encoder.encode(raw));
    writePtyOutput(term, encoder.encode(`${line}\r\n`));
    expect(term.output).toBe(raw + `${line}\r\n`);
  });

  it.each([completion, "\x1b]133;C\x1b\\"])(
    "ends echo matching at a real shell start/completion token: %j",
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

  it.each(["\x1b]0;terminal title\x07", "\x1b]7;file://remote/tmp\x1b\\", "\x1bP$q m\x1b\\"])(
    "forwards leading protocol traffic and still replaces the echo at every byte boundary: %j",
    (token) => {
      const raw = encoder.encode(`${token}${line}\r\nhello world\r\n${completion}`);
      for (let split = 0; split <= raw.length; split++) {
        const term = new RecordingTerminal();
        expectPtyEcho(term, line, visible);
        writePtyOutput(term, raw.subarray(0, split));
        writePtyOutput(term, raw.subarray(split));
        expect(term.output, `split at ${split}`).toBe(`${token}${visible}\r\nhello world\r\n${completion}`);
      }
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
      expect(term.output).toBe(`\x1b[6n${visible}\r\n`);
    }
  });

  it("preserves a query and replaces the full echoed line arriving in one chunk", () => {
    const term = new RecordingTerminal();
    expectPtyEcho(term, line, visible);
    const raw = `\x1b[6n${line}\r\n`;
    writePtyOutput(term, encoder.encode(raw));
    expect(term.output).toBe(`\x1b[6n${visible}\r\n`);
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
    writePtyOutput(term, encoder.encode(`${line}\r\n`));
    expect(term.output).toBe(`\x1bP$q m\x1b\\${visible}\r\n`);
  });

  it("does not mistake control-string payload or a different output line for an echo", () => {
    const term = new RecordingTerminal();
    expectPtyEcho(term, line, visible);
    const token = `\x1b]0;${line}\n${line}\x07`;
    for (const byte of encoder.encode(token)) writePtyOutput(term, Uint8Array.of(byte));
    writePtyOutput(term, encoder.encode(`real output\r\n${line}\r\n`));
    expect(term.output).toBe(`${token}real output\r\n${line}\r\n`);
  });

  it("acknowledges a mixed control/echo chunk only after the whole chunk is parsed", () => {
    const term = new RecordingTerminal();
    const acknowledge = vi.fn();
    expectPtyEcho(term, line, visible);
    writePtyOutput(term, encoder.encode(`\x1b[6n${line}`), acknowledge);
    expect(term.output).toBe("\x1b[6n");
    expect(acknowledge).not.toHaveBeenCalled();
    writePtyOutput(term, encoder.encode("\r\n"));
    expect(acknowledge).not.toHaveBeenCalled();
    term.callbacks[0]();
    expect(acknowledge).toHaveBeenCalledOnce();
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
  it("renders the captured private zsh redraw as the approved command at 85 columns", async () => {
    const term = new Terminal({ cols: 85, rows: 24 });
    try {
      const prompt = "maholick@VMAC ~ % ";
      await new Promise<void>((resolve) => term.write(prompt, resolve));
      expectPtyEcho(term, privateRedraw.line, privateRedraw.visible);
      await new Promise<void>((resolve) => writePtyOutput(
        term, encoder.encode(privateRedraw.chunks.join("")), resolve,
      ));
      expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe(prompt + privateRedraw.visible);
      expect(term.buffer.active.getLine(1)?.translateToString(true)).toBe("");
    } finally {
      cancelPtyEcho(term, true);
      term.dispose();
    }
  });

  it.each(["\x1b[6n", "\x1b[c", "\x1bP$q m\x1b\\"])(
    "keeps the echo armed when the real input listener receives xterm's query reply: %j",
    async (query) => {
      const term = new Terminal({ cols: 240, rows: 24 });
      const userInput = vi.fn(() => cancelPtyEcho(term));
      const registration = onTerminalUserInput(term, userInput);
      const replies: string[] = [];
      term.onData((data) => replies.push(data));
      try {
        expectPtyEcho(term, line, visible);
        await new Promise<void>((resolve) => writePtyOutput(term, encoder.encode(query), resolve));
        expect(replies).toHaveLength(1);
        expect(userInput).not.toHaveBeenCalled();
        await new Promise<void>((resolve) => writePtyOutput(term, encoder.encode(`${line}\r\n`), resolve));
        expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe(visible);

        for (const data of ["x", "pasted text", "\x1b[1;1R"]) {
          expectPtyEcho(term, line, visible);
          term.input(data, true);
          await new Promise<void>((resolve) => writePtyOutput(term, encoder.encode(`${line}\r\n`), resolve));
        }
        expect(userInput).toHaveBeenCalledTimes(3);
        // Even a pasted string resembling a DSR reply is real user input once
        // the parser turn is over and must cancel suppression.
        expect(term.buffer.active.getLine(3)?.translateToString(true)).toBe(line);
      } finally {
        registration.dispose();
        cancelPtyEcho(term, true);
        term.dispose();
      }
    },
  );

  it.each(fixtures)(
    "renders a clean $platform $shell $kind at $cols columns while preserving protocol tokens",
    async (fixture) => {
      const term = new Terminal({ cols: fixture.cols, rows: 24, allowProposedApi: true });
      const tokens: string[] = [];
      term.parser.registerOscHandler(6973, (payload) => {
        tokens.push(payload);
        return true;
      });
      try {
        await new Promise<void>((resolve) => term.write(fixture.initial, resolve));
        const replies: string[] = [];
        term.onData((data) => replies.push(data));
        expectPtyEcho(term, fixture.line, fixture.kind === "probe" ? null : visible);
        await new Promise<void>((resolve) =>
          writePtyOutput(term, encoder.encode(`\x1b]0;audit title\x07\x1b[6n${fixture.rawOutput}`), resolve),
        );
        expect(replies).toHaveLength(1);
        expect(replies[0]).toMatch(/^\x1b\[\d+;\d+R$/);
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
