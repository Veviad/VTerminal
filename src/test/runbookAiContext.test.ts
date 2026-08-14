import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readBlockOutput: vi.fn<(sessionId: string, block: { id: string }) => string>(),
}));

vi.mock("../hooks/useAiStream", () => ({ readBlockOutput: mocks.readBlockOutput }));

import {
  collectSessionBlocks,
  contextAvailability,
  renderContext,
  type RunbookContextBlock,
} from "../lib/runbookAiContext";
import {
  protectRunbookTerminal,
  resetRunbookTerminalPrivacyForTests,
} from "../lib/runbookTerminalPrivacy";
import { useAppStore } from "../stores/appStore";
import type { Block } from "../lib/types";

function block(over: Partial<Block> & { id: string }): Block {
  return {
    sessionId: "s1",
    command: `echo ${over.id}`,
    state: "done",
    exitCode: 0,
    startLine: 0,
    endLine: 1,
    startedAt: "2026-01-01T00:00:00Z",
    endedAt: "2026-01-01T00:00:01Z",
    origin: "user",
    ...over,
  };
}

/** Blocks only — never touches `sendContextToAi`, which some cases set first. */
function seed(blocks: Block[]): void {
  useAppStore.setState({
    sessionUi: { s1: { ...(useAppStore.getState().sessionUi.s1 ?? {}), blocks } },
  } as never);
}

beforeEach(() => {
  resetRunbookTerminalPrivacyForTests();
  mocks.readBlockOutput.mockReset();
  mocks.readBlockOutput.mockImplementation((_s, b) => `output of ${b.id}`);
  useAppStore.setState({ sendContextToAi: true, sessionUi: {} } as never);
});

describe("contextAvailability", () => {
  it("honours the operator's standing answer without asking again", () => {
    useAppStore.setState({ sendContextToAi: false } as never);
    const verdict = contextAvailability("s1");
    expect(verdict.available).toBe(false);
    expect(verdict.available === false && verdict.reason).toContain("Settings");
  });

  it("refuses a tab that has run a Runbook", () => {
    // That tab suppresses its scrollback for the rest of its life so redacted
    // evidence cannot be recovered from a raw capture. This path must not be
    // the hole in that boundary.
    protectRunbookTerminal("s1");
    expect(contextAvailability("s1").available).toBe(false);
    expect(contextAvailability("s2").available).toBe(true);
  });
});

describe("collectSessionBlocks", () => {
  it("takes the WHOLE session, oldest first — not the chat window's three", () => {
    seed(Array.from({ length: 12 }, (_, i) => block({ id: `b${i}` })));
    const collected = collectSessionBlocks("s1");
    expect(collected).toHaveLength(12);
    expect(collected[0].id).toBe("b0");
    expect(collected[11].id).toBe("b11");
  });

  it("skips agent-run and unfinished blocks", () => {
    // An agent block is the model's own past output; authoring from it would
    // launder a previous suggestion into a runbook as the operator's choice.
    seed([
      block({ id: "mine" }),
      block({ id: "theirs", origin: "agent" }),
      block({ id: "running", state: "running" }),
      block({ id: "blank", command: "   " }),
    ]);
    expect(collectSessionBlocks("s1").map((b) => b.id)).toEqual(["mine"]);
  });

  it("flags a block whose output has fallen out of scrollback", () => {
    // Output lives in the xterm buffer, not the store, so an old block keeps
    // its command and loses its output. Saying so beats sending an empty tail.
    mocks.readBlockOutput.mockReturnValue("");
    seed([block({ id: "old" })]);
    expect(collectSessionBlocks("s1")[0].outputUnavailable).toBe(true);
  });

  it("yields nothing at all when context is switched off", () => {
    useAppStore.setState({ sendContextToAi: false } as never);
    seed([block({ id: "b0" })]);
    expect(collectSessionBlocks("s1")).toEqual([]);
  });
});

describe("renderContext", () => {
  const sample = (id: string, over: Partial<RunbookContextBlock> = {}): RunbookContextBlock => ({
    id,
    command: `install ${id}`,
    exitCode: 0,
    output: "ok",
    outputUnavailable: false,
    ...over,
  });

  it("renders command, exit code and output", () => {
    const out = renderContext([sample("nginx")]);
    expect(out).toContain("$ install nginx (exit 0)");
    expect(out).toContain("ok");
  });

  it("drops the OLDEST commands when over budget, and says how many", () => {
    // The tail of a session is where the thing finally worked, so breadth is
    // spent from the front. Silently shortening would let the model assume the
    // beginning it cannot see does not exist.
    const blocks = Array.from({ length: 50 }, (_, i) => sample(`pkg${i}`));
    const out = renderContext(blocks, 400);
    expect(out).toMatch(/^\[\d+ earlier commands omitted\]/);
    expect(out).toContain("pkg49");
    expect(out).not.toContain("pkg0 ");
    expect(out.length).toBeLessThan(600);
  });

  it("keeps at least the newest command even when it alone exceeds the budget", () => {
    const out = renderContext([sample("a"), sample("huge", { output: "x".repeat(5000) })], 100);
    expect(out).toContain("install huge");
  });

  it("marks missing output rather than pretending there was none", () => {
    const out = renderContext([sample("gone", { output: "", outputUnavailable: true })]);
    expect(out).toContain("[output no longer in scrollback]");
    expect(renderContext([sample("quiet", { output: "" })])).toContain("[no output]");
  });
});
