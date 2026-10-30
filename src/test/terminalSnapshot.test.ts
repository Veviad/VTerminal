import { afterEach, describe, expect, it, vi } from "vitest";
import { Terminal } from "@xterm/xterm";

const state = vi.hoisted(() => ({ entry: null as null | { disposed: boolean; term: Terminal } }));
vi.mock("../lib/termRegistry", () => ({ getTerm: () => state.entry }));
import { readLineRangeResult, utf8Tail } from "../lib/terminalSnapshot";

afterEach(() => {
  state.entry?.term.dispose();
  state.entry = null;
});

describe("utf8Tail", () => {
  it("caps UTF-8 bytes without splitting a multibyte character", () => {
    const captured = utf8Tail("alpha-€€", 5);
    expect(captured.text).toBe("€");
    expect(captured.observedBytes).toBe(12);
    expect(captured.capturedBytes).toBe(3);
    expect(captured.truncated).toBe(true);
  });

  it("reports a complete capture explicitly", () => {
    expect(utf8Tail("ok", 8)).toEqual({
      text: "ok",
      observedBytes: 2,
      capturedBytes: 2,
      truncated: false,
    });
  });
});

describe("terminal text snapshots", () => {
  it.each([
    ["123456789 XYZ", "123456789 XYZ"],
    ["123456789界XYZ", "123456789界XYZ"],
    ["12345678  XYZ", "12345678  XYZ"],
  ])("preserves wrapped terminal text %j", async (input, expected) => {
    const term = new Terminal({ cols: 10, rows: 5 });
    state.entry = { term, disposed: false };
    await new Promise<void>((resolve) => term.write(input, resolve));
    expect(readLineRangeResult("test", 0, term.buffer.active.cursorY, { limit: 100 }).text).toBe(expected);
  });
});
