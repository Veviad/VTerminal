import { beforeEach, describe, expect, it, vi } from "vitest";

const readLineRange = vi.fn((..._args: unknown[]) => "raw-private-block-bytes");
const readScreenTail = vi.fn((..._args: unknown[]) => "raw-private-screen-bytes");

vi.mock("../lib/terminalSnapshot", () => ({
  readLineRange: (...args: unknown[]) => readLineRange(...args),
  readScreenTail: (...args: unknown[]) => readScreenTail(...args),
}));

vi.mock("../lib/termRegistry", () => ({
  getTerm: () => ({ blockMarkers: new Map() }),
}));

import { buildTerminalContext, readBlockOutput } from "../hooks/useAiStream";
import {
  protectPrivateTerminal,
  resetRunbookTerminalPrivacyForTests,
} from "../lib/runbookTerminalPrivacy";
import { emptySessionUi, useAppStore } from "../stores/appStore";
import type { Block, Session } from "../lib/types";

const session: Session = {
  id: "private-session",
  shell: "/bin/zsh",
  cwd: "/tmp",
  createdAt: "2026-08-24T00:00:00Z",
  exited: false,
  exitCode: null,
  hostId: null,
  hostLabel: null,
  userTitle: null,
  aiTitle: null,
  ordinal: 1,
};

const block: Block = {
  id: "private-block",
  sessionId: session.id,
  command: "opaque command reference",
  exitCode: 0,
  state: "done",
  startLine: 1,
  endLine: 2,
  startedAt: "2026-08-24T00:00:00Z",
  endedAt: "2026-08-24T00:00:01Z",
  origin: "user",
};

beforeEach(() => {
  resetRunbookTerminalPrivacyForTests();
  readLineRange.mockClear();
  readScreenTail.mockClear();
  useAppStore.setState({
    sessions: [session],
    sessionUi: {
      [session.id]: { ...emptySessionUi(), blocks: [block], cwd: "/tmp" },
    },
    sendContextToAi: true,
  });
});

describe("Agent private terminal context", () => {
  it("blocks screen tails, block attachments, and recent block evidence", () => {
    protectPrivateTerminal(session.id);

    expect(readBlockOutput(session.id, block)).toBe("");
    const context = buildTerminalContext(session.id);
    expect(context.screen_tail).toBe("");
    expect(context.recent_blocks).toEqual([]);
    expect(readLineRange).not.toHaveBeenCalled();
    expect(readScreenTail).not.toHaveBeenCalled();
  });
});
