import { describe, expect, it } from "vitest";
import type { IMarker, Terminal } from "@xterm/xterm";
import { BlockTracker, parseOsc7, type BlockTrackerCallbacks } from "../lib/osc133";

// Minimal fake terminal: enough surface for BlockTracker (parser handler
// registration, markers, buffer lines, onData).
class FakeLine {
  constructor(private text: string) {}
  translateToString(_trim: boolean, startCol = 0): string {
    return this.text.slice(startCol);
  }
}

class FakeTerminal {
  oscHandlers = new Map<number, (data: string) => boolean>();
  lines: string[] = [""];
  cursorY = 0;
  cursorX = 0;
  baseY = 0;
  markerCounter = 0;
  disposedMarkers: number[] = [];

  parser = {
    registerOscHandler: (id: number, cb: (data: string) => boolean) => {
      this.oscHandlers.set(id, cb);
      return { dispose: () => this.oscHandlers.delete(id) };
    },
  };

  buffer = {
    active: {
      get baseY() {
        return 0;
      },
      get cursorY() {
        return (this as unknown as { _t: FakeTerminal })._t.cursorY;
      },
      get cursorX() {
        return (this as unknown as { _t: FakeTerminal })._t.cursorX;
      },
      get length() {
        return (this as unknown as { _t: FakeTerminal })._t.lines.length;
      },
      getLine(y: number) {
        const t = (this as unknown as { _t: FakeTerminal })._t;
        return y < t.lines.length ? new FakeLine(t.lines[y]) : undefined;
      },
      _t: undefined as unknown as FakeTerminal,
    },
  };

  constructor() {
    (this.buffer.active as unknown as { _t: FakeTerminal })._t = this;
  }

  registerMarker(_offset: number): IMarker {
    const line = this.baseY + this.cursorY;
    const id = this.markerCounter++;
    const disposeCallbacks: (() => void)[] = [];
    return {
      id,
      line,
      isDisposed: false,
      onDispose: (cb: () => void) => {
        disposeCallbacks.push(cb);
        return { dispose: () => {} };
      },
      dispose: () => disposeCallbacks.forEach((cb) => cb()),
    } as unknown as IMarker;
  }

  onData(_cb: (d: string) => void) {
    return { dispose: () => {} };
  }

  /** Returns the handler's own return value — xterm prints the raw escape
   *  sequence when a handler returns false, so suspended handlers must
   *  still report true. */
  sendOsc(id: number, data: string): boolean | undefined {
    return this.oscHandlers.get(id)?.(data);
  }
}

function makeTracker(overrides?: Partial<BlockTrackerCallbacks>) {
  const term = new FakeTerminal();
  const events: string[] = [];
  const commands: string[] = [];
  const exits: number[] = [];
  const tracker = new BlockTracker(term as unknown as Terminal, {
    onBlockStart: (id, command) => {
      events.push(`start:${id}`);
      commands.push(command);
    },
    onBlockEnd: (id, exitCode) => {
      events.push(`end:${id}`);
      exits.push(exitCode);
    },
    onBlockTrimmed: (id) => events.push(`trim:${id}`),
    ...overrides,
  });
  tracker.attach();
  return { term, tracker, events, commands, exits };
}

describe("BlockTracker OSC 133 FSM", () => {
  it("tracks a full A→B→C→D cycle with command capture", () => {
    const { term, events, commands, exits } = makeTracker();
    term.sendOsc(133, "A");
    // Prompt renders "~/proj ❯ " then B marks input start at column 9
    term.lines[0] = "~/proj ❯ ";
    term.cursorX = 9;
    term.sendOsc(133, "B");
    // User types the command
    term.lines[0] = "~/proj ❯ ls -la";
    term.cursorX = 15;
    term.sendOsc(133, "C");
    term.cursorY = 1;
    term.lines.push("total 0");
    term.sendOsc(133, "D;0");

    expect(commands).toEqual(["ls -la"]);
    expect(exits).toEqual([0]);
    expect(events.filter((e) => e.startsWith("start:"))).toHaveLength(1);
    expect(events.filter((e) => e.startsWith("end:"))).toHaveLength(1);
  });

  it("reports non-zero exit codes", () => {
    const { term, exits } = makeTracker();
    term.sendOsc(133, "A");
    term.sendOsc(133, "B");
    term.sendOsc(133, "C");
    term.sendOsc(133, "D;127");
    expect(exits).toEqual([127]);
  });

  it("closes a dangling block when a new prompt arrives without D", () => {
    const { term, events } = makeTracker();
    term.sendOsc(133, "A");
    term.sendOsc(133, "B");
    term.sendOsc(133, "C"); // command runs, user Ctrl-C's a TUI — no D
    term.sendOsc(133, "A"); // next prompt
    expect(events.filter((e) => e.startsWith("end:"))).toHaveLength(1);
  });

  it("handles malformed exit codes as 0", () => {
    const { term, exits } = makeTracker();
    term.sendOsc(133, "A");
    term.sendOsc(133, "B");
    term.sendOsc(133, "C");
    term.sendOsc(133, "D;banana");
    expect(exits).toEqual([0]);
  });

  it("captures multi-line wrapped commands", () => {
    const { term, commands } = makeTracker();
    term.sendOsc(133, "A");
    term.lines[0] = "$ ";
    term.cursorX = 2;
    term.sendOsc(133, "B");
    term.lines[0] = "$ echo aaaaaaaaaa";
    term.lines.push("bbbbbbbbbb");
    term.cursorY = 1;
    term.cursorX = 10;
    term.sendOsc(133, "C");
    expect(commands).toEqual(["echo aaaaaaaaaabbbbbbbbbb"]);
  });

  it("isAtEmptyPrompt is true only at a pristine empty prompt", () => {
    const { term, tracker } = makeTracker();
    expect(tracker.isAtEmptyPrompt()).toBe(false);
    term.sendOsc(133, "A");
    term.lines[0] = "$ ";
    term.cursorX = 2;
    term.sendOsc(133, "B");
    expect(tracker.isAtEmptyPrompt()).toBe(true);
    term.sendOsc(133, "C"); // command started
    expect(tracker.isAtEmptyPrompt()).toBe(false);
  });
});

// Restored scrollback is written back through term.write(). xterm's serialize
// addon emits no OSC, so nothing SHOULD reach these handlers — but a replayed
// mark would create phantom blocks and, worse, re-insert every replayed command
// into command_history. suspend() is the defence-in-depth layer for that.
describe("BlockTracker suspend/resume", () => {
  it("swallows a full A→B→C→D cycle without emitting blocks", () => {
    const { term, tracker, events } = makeTracker();
    tracker.suspend();
    term.sendOsc(133, "A");
    term.lines[0] = "~/proj ❯ ";
    term.cursorX = 9;
    term.sendOsc(133, "B");
    term.lines[0] = "~/proj ❯ rm -rf /tmp/x";
    term.cursorX = 21;
    term.sendOsc(133, "C");
    term.sendOsc(133, "D;0");
    expect(events).toEqual([]);
  });

  it("keeps returning true so xterm does not print the raw sequence", () => {
    const { term, tracker } = makeTracker();
    tracker.suspend();
    expect(term.sendOsc(133, "A")).toBe(true);
    expect(term.sendOsc(7, "file://host/tmp")).toBe(true);
    expect(term.sendOsc(6973, "CMD;bHM=")).toBe(true);
  });

  it("does not move the cwd while suspended", () => {
    const cwds: string[] = [];
    const { term, tracker } = makeTracker({ onCwdChange: (cwd) => cwds.push(cwd) });
    tracker.suspend();
    term.sendOsc(7, "file://host/somewhere/else");
    expect(cwds).toEqual([]);
    tracker.resume();
    term.sendOsc(7, "file://host/real/cwd");
    expect(cwds).toEqual(["/real/cwd"]);
  });

  it("ignores a replayed command so it cannot leak into the next real block", () => {
    const { term, tracker, commands } = makeTracker();
    tracker.suspend();
    term.sendOsc(6973, `CMD;${btoa("replayed-command")}`);
    tracker.resume();
    // The next genuine block must capture its own command, not the stale one.
    term.sendOsc(133, "A");
    term.lines[0] = "$ ";
    term.cursorX = 2;
    term.sendOsc(133, "B");
    term.lines[0] = "$ echo hi";
    term.cursorX = 9;
    term.sendOsc(133, "C");
    expect(commands).toEqual(["echo hi"]);
  });

  it("resumes normal block tracking", () => {
    const { term, tracker, events } = makeTracker();
    tracker.suspend();
    term.sendOsc(133, "A");
    tracker.resume();
    term.sendOsc(133, "A");
    term.lines[0] = "$ ";
    term.cursorX = 2;
    term.sendOsc(133, "B");
    term.lines[0] = "$ ls";
    term.cursorX = 4;
    term.sendOsc(133, "C");
    term.sendOsc(133, "D;0");
    expect(events.filter((e) => e.startsWith("start:"))).toHaveLength(1);
    expect(events.filter((e) => e.startsWith("end:"))).toHaveLength(1);
  });
});

describe("parseOsc7", () => {
  it("parses file URLs", () => {
    expect(parseOsc7("file://mac.local/Users/me/proj")).toEqual({
      host: "mac.local",
      path: "/Users/me/proj",
    });
  });
  it("decodes percent-encoded paths", () => {
    expect(parseOsc7("file://h/Users/me/My%20Docs")?.path).toBe("/Users/me/My Docs");
  });
  it("rejects non-file URLs", () => {
    expect(parseOsc7("https://example.com/x")).toBeNull();
    expect(parseOsc7("garbage")).toBeNull();
  });
});
