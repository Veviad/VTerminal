import { Terminal } from "@xterm/xterm";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { cancelTerminalClear, clearTerminalBuffer, hasPendingTerminalClear } from "../lib/terminalClear";

const canvasContext = vi.hoisted(() =>
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => null),
);
afterAll(() => canvasContext.mockRestore());

const terminals: Terminal[] = [];
afterEach(() => {
  for (const terminal of terminals.splice(0)) {
    cancelTerminalClear(terminal);
    terminal.dispose();
  }
});

function makeTerm(): Terminal {
  const terminal = new Terminal({ cols: 80, rows: 5, scrollback: 100, allowProposedApi: true });
  terminals.push(terminal);
  return terminal;
}

function write(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve));
}

function contents(term: Terminal, kind: "active" | "normal" = "active"): string {
  const buffer = term.buffer[kind];
  return Array.from({ length: buffer.length }, (_, line) =>
    buffer.getLine(line)?.translateToString(true) ?? "",
  ).join("\n");
}

const history = Array.from({ length: 12 }, (_, line) => `old output ${line}\r\n`).join("");

describe("clearing terminal history without restarting the connection", () => {
  it("drains pending writes and removes screen history, scrollback, and old markers", async () => {
    const term = makeTerm();
    const marker = term.registerMarker(0)!;
    const onCleared = vi.fn();
    term.write(`${history}host$ printf 'hello'`);

    const clearing = clearTerminalBuffer(term, onCleared);
    expect(hasPendingTerminalClear(term)).toBe(true);
    await clearing;

    expect(term.buffer.active.baseY).toBe(0);
    expect(term.buffer.active.viewportY).toBe(0);
    expect(term.buffer.active.cursorY).toBe(0);
    expect(term.buffer.active.length).toBe(term.rows);
    expect(contents(term)).toBe("host$ printf 'hello'\n\n\n\n");
    expect(marker.isDisposed).toBe(true);
    expect(onCleared).toHaveBeenCalledOnce();
    expect(hasPendingTerminalClear(term)).toBe(false);
  });

  it("keeps the cursor inside existing input and accepts subsequent shell output", async () => {
    const term = makeTerm();
    await write(term, `${history}host$ echo abc\x1b[2D`);
    const cursorX = term.buffer.active.cursorX;
    const sendToPty = vi.fn();
    term.onData(sendToPty);

    await clearTerminalBuffer(term);
    expect(term.buffer.active.cursorX).toBe(cursorX);
    await write(term, "X\x1b[C\r\nresult\r\nhost$ ");

    expect(contents(term)).toBe("host$ echo aXc\nresult\nhost$ \n\n");
    expect(sendToPty).not.toHaveBeenCalled();
  });

  it("defers a cursor-at-top clear while old screen rows remain below the cursor", async () => {
    const term = makeTerm();
    await write(term, "old\r\nold2\x1b[H");
    const onCleared = vi.fn();

    await clearTerminalBuffer(term, onCleared);

    expect(term.buffer.active.baseY).toBe(0);
    expect(term.buffer.active.cursorY).toBe(0);
    expect(contents(term)).toContain("old\nold2");
    expect(hasPendingTerminalClear(term)).toBe(true);
    expect(onCleared).not.toHaveBeenCalled();
    await write(term, "\x1b[32m");
    expect(hasPendingTerminalClear(term)).toBe(true);
    expect(onCleared).not.toHaveBeenCalled();

    await write(term, "\r\n\r\nhost$ ");

    expect(contents(term)).toBe("host$ \n\n\n\n");
    expect(hasPendingTerminalClear(term)).toBe(false);
    expect(onCleared).toHaveBeenCalledOnce();
  });

  it("finishes immediately for a prompt on row zero with only blank rows below", async () => {
    const term = makeTerm();
    await write(term, "host$ ");
    const onCleared = vi.fn();

    await clearTerminalBuffer(term, onCleared);

    expect(contents(term)).toBe("host$ \n\n\n\n");
    expect(hasPendingTerminalClear(term)).toBe(false);
    expect(onCleared).toHaveBeenCalledOnce();
  });

  it("preserves input modes, text attributes, OSC handlers, and an incomplete parser sequence", async () => {
    const term = makeTerm();
    const osc = vi.fn(() => true);
    term.parser.registerOscHandler(133, osc);
    await write(term, `${history}\x1b[?2004h\x1b[?1h\x1b[4h\x1b[32mhost$ \x1b]133;B`);
    const modes = { ...term.modes };
    const foreground = term.buffer.active.getLine(term.buffer.active.baseY + term.buffer.active.cursorY)!
      .getCell(0)!.getFgColor();

    await clearTerminalBuffer(term);
    expect(term.modes).toEqual(modes);
    expect(osc).not.toHaveBeenCalled();
    await write(term, "\x07printf\x1b]133;D;0\x07");

    expect(osc.mock.calls).toEqual([["B"], ["D;0"]]);
    expect(contents(term)).toBe("host$ printf\n\n\n\n");
    expect(term.buffer.active.getLine(0)!.getCell(6)!.getFgColor()).toBe(foreground);
  });

  it("leaves a running TUI intact and clears normal history after its real exit restores the cursor", async () => {
    const term = makeTerm();
    await write(term, `${history}host$ vim file`);
    const marker = term.registerMarker(0)!;
    await write(term, "\x1b[?1049h\x1b[2J\x1b[HEDITOR\x1b[?1000h\x1b[?2004h");
    const tui = contents(term);
    const modes = { ...term.modes };
    const onCleared = vi.fn();

    await clearTerminalBuffer(term, onCleared);

    expect(hasPendingTerminalClear(term)).toBe(true);
    expect(term.buffer.active.type).toBe("alternate");
    expect(contents(term)).toBe(tui);
    expect(contents(term, "normal")).toContain("old output");
    expect(term.modes).toEqual(modes);
    expect(marker.isDisposed).toBe(false);
    expect(onCleared).not.toHaveBeenCalled();

    await write(term, "\x1b[?1049l\r\nhost$ ");

    expect(hasPendingTerminalClear(term)).toBe(false);
    expect(term.buffer.active.type).toBe("normal");
    expect(contents(term)).toBe("host$ \n\n\n\n");
    expect(term.buffer.active.cursorY).toBe(0);
    expect(term.buffer.active.cursorX).toBe(6);
    expect(marker.isDisposed).toBe(true);
    expect(onCleared).toHaveBeenCalledOnce();
  });

  it("coalesces alternate-buffer requests and does not keep clearing later output", async () => {
    const term = makeTerm();
    await write(term, `${history}host$ less file\x1b[?1049hfile contents`);
    const first = vi.fn();
    const latest = vi.fn();
    await clearTerminalBuffer(term, first);
    await clearTerminalBuffer(term, latest);
    await write(term, "\x1b[?1049l\r\nhost$ ");
    await write(term, "echo kept\r\nkept\r\nhost$ ");

    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledOnce();
    expect(contents(term)).toContain("host$ echo kept\nkept\nhost$");
  });

  it("waits if an app reenters the alternate buffer within the same parser batch", async () => {
    const term = makeTerm();
    await write(term, `${history}host$ app\x1b[?1049hfirst screen`);
    await clearTerminalBuffer(term);
    await write(term, "\x1b[?1049l\x1b[?1049h\x1b[2J\x1b[Hsecond screen");

    expect(hasPendingTerminalClear(term)).toBe(true);
    expect(term.buffer.active.type).toBe("alternate");
    expect(contents(term)).toContain("second screen");

    await write(term, "\x1b[?1049l\r\nhost$ ");
    expect(hasPendingTerminalClear(term)).toBe(false);
    expect(contents(term)).not.toContain("old output");
  });

  it("settles queued requests on disposal and ignores write callbacks arriving afterward", async () => {
    const term = makeTerm();
    await write(term, `${history}host$ `);
    const barriers: Array<() => void> = [];
    vi.spyOn(term, "write").mockImplementation((_data, callback) => {
      if (callback) barriers.push(callback);
    });
    const clear = vi.spyOn(term, "clear");
    const onCleared = vi.fn();
    const first = clearTerminalBuffer(term, onCleared);
    const latest = clearTerminalBuffer(term, onCleared);
    expect(hasPendingTerminalClear(term)).toBe(true);

    cancelTerminalClear(term);
    term.dispose();
    await Promise.all([first, latest]);
    for (const callback of barriers) callback();

    expect(hasPendingTerminalClear(term)).toBe(false);
    expect(clear).not.toHaveBeenCalled();
    expect(onCleared).not.toHaveBeenCalled();
  });

  it("does not let a canceled barrier clear a newer request on the same terminal", async () => {
    const term = makeTerm();
    await write(term, `${history}host$ `);
    const barriers: Array<() => void> = [];
    vi.spyOn(term, "write").mockImplementation((_data, callback) => {
      if (callback) barriers.push(callback);
    });
    const canceled = vi.fn();
    const latest = vi.fn();
    const first = clearTerminalBuffer(term, canceled);
    cancelTerminalClear(term);
    await first;
    const second = clearTerminalBuffer(term, latest);

    barriers[0]();
    expect(contents(term)).toContain("old output");
    expect(hasPendingTerminalClear(term)).toBe(true);
    expect(canceled).not.toHaveBeenCalled();
    expect(latest).not.toHaveBeenCalled();
    barriers[1]();
    await second;

    expect(contents(term)).not.toContain("old output");
    expect(latest).toHaveBeenCalledOnce();
    expect(hasPendingTerminalClear(term)).toBe(false);
  });

  it("cancels deferred alternate-buffer clearing before an app exits", async () => {
    const term = makeTerm();
    await write(term, `${history}host$ less file\x1b[?1049hfile contents`);
    const onCleared = vi.fn();
    await clearTerminalBuffer(term, onCleared);
    expect(hasPendingTerminalClear(term)).toBe(true);

    cancelTerminalClear(term);
    expect(hasPendingTerminalClear(term)).toBe(false);
    await write(term, "\x1b[?1049l\r\nhost$ ");

    expect(contents(term)).toContain("old output");
    expect(onCleared).not.toHaveBeenCalled();
  });
});
