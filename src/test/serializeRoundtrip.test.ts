import { describe, expect, it } from "vitest";
import { Terminal } from "@xterm/xterm";
import { SerializeAddon } from "@xterm/addon-serialize";

/**
 * Exercises the REAL addon, not a mock. The restore design rests on two claims
 * about it, and both are load-bearing enough to pin.
 */
function makeTerm(cols = 80, rows = 10) {
  const term = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 1000 });
  const serialize = new SerializeAddon();
  term.loadAddon(serialize);
  return { term, serialize };
}

function write(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, () => resolve()));
}

describe("serialize round-trip", () => {
  it("preserves visible text", async () => {
    const { term, serialize } = makeTerm();
    await write(term, "hello world\r\nsecond line\r\n");
    const payload = serialize.serialize({ scrollback: 1000 });
    expect(payload).toContain("hello world");
    expect(payload).toContain("second line");
  });

  it("replays into a fresh terminal", async () => {
    const a = makeTerm();
    await write(a.term, "\x1b[32mgreen\x1b[0m plain\r\n");
    const payload = a.serialize.serialize({ scrollback: 1000 });

    const b = makeTerm();
    await write(b.term, payload);
    const line = b.term.buffer.active.getLine(0)?.translateToString(true);
    expect(line).toContain("green plain");
  });

  // THE claim the replay guard rests on: BlockTracker only registers OSC
  // handlers, so if the payload carries no OSC it cannot manufacture phantom
  // blocks or re-insert replayed commands into command_history.
  it("emits no OSC sequences, even when the source terminal received them", async () => {
    const { term, serialize } = makeTerm();
    await write(term, "\x1b]133;A\x1b\\prompt$ ls\r\n");
    await write(term, "\x1b]7;file://host/tmp\x1b\\output\r\n");
    await write(term, "\x1b]133;D;0\x1b\\");

    const payload = serialize.serialize({ scrollback: 1000 });
    // OSC introducer is ESC ] — its absence is what makes replay inert.
    expect(payload).not.toContain("\x1b]");
    expect(payload).toContain("output");
  });

  it("excludeModes keeps a dead TUI's mouse tracking out of the payload", async () => {
    const { term, serialize } = makeTerm();
    // What vim leaves behind: mouse reporting + bracketed paste.
    await write(term, "\x1b[?1000h\x1b[?2004h");
    await write(term, "editor screen\r\n");

    const withModes = serialize.serialize({ scrollback: 1000 });
    const without = serialize.serialize({ scrollback: 1000, excludeModes: true });

    expect(withModes).toContain("?1000h");
    // Re-arming mouse reporting in a terminal with no app to consume it would
    // make clicks emit escape codes into the user's next command.
    expect(without).not.toContain("?1000h");
    expect(without).not.toContain("?2004h");
  });

  it("excludeAltBuffer restores the shell scrollback under a TUI", async () => {
    const { term, serialize } = makeTerm();
    await write(term, "shell history here\r\n");
    // Enter the alt screen, as vim/less do, and paint over everything.
    await write(term, "\x1b[?1049h");
    await write(term, "VIM SCREEN\r\n");

    const payload = serialize.serialize({ scrollback: 1000, excludeAltBuffer: true });
    expect(payload).toContain("shell history here");
    expect(payload).not.toContain("VIM SCREEN");
    expect(payload).not.toContain("?1049h");
  });

  it("a smaller scrollback request yields a smaller payload", async () => {
    const { term, serialize } = makeTerm();
    for (let i = 0; i < 200; i++) await write(term, `line ${i}\r\n`);
    const big = serialize.serialize({ scrollback: 200, excludeModes: true });
    const small = serialize.serialize({ scrollback: 10, excludeModes: true });
    expect(small.length).toBeLessThan(big.length);
    expect(big).toContain("line 20");
  });

  it("an empty terminal serializes to something trivially small", () => {
    const { serialize } = makeTerm();
    const payload = serialize.serialize({ scrollback: 1000, excludeModes: true });
    expect(payload.length).toBeLessThan(200);
  });
});
