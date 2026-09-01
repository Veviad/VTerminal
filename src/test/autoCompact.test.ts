import { beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "../stores/appStore";
import { S } from "../lib/strings";
import type { Session } from "../lib/types";

function makeSession(id: string): Session {
  return {
    id,
    shell: "/bin/zsh",
    cwd: null,
    createdAt: new Date().toISOString(),
    exited: false,
    exitCode: null,
    hostId: null,
    hostLabel: null,
    userTitle: null,
    aiTitle: null,
    ordinal: 1,
  };
}

beforeEach(() => {
  useAppStore.setState({ sessions: [], activeSessionId: null, sessionUi: {}, aiStreams: {} });
  useAppStore.getState().addSession(makeSession("a"));
});

describe("a run that summarizes its own history", () => {
  it("records the swap without settling the run", () => {
    const s = useAppStore.getState();
    s.initAiStream("a", "agent", "req-1");
    s.noteCompaction("a", 12, 9_000, "req-1");

    const stream = useAppStore.getState().aiStreams["a"];
    expect(stream.compaction).toEqual({
      count: 1,
      removedMessages: 12,
      afterTokens: 9_000,
    });
    // The loop is still running: a compaction is not a settlement, and treating
    // it as one would leave the panel idle with a live request behind it.
    expect(stream.status).toBe("streaming");
    expect(stream.requestId).toBe("req-1");
    expect(stream.lastError).toBeNull();
    expect(stream.pause).toBeNull();
  });

  it("counts repeats into one line instead of stacking notices", () => {
    const s = useAppStore.getState();
    s.initAiStream("a", "agent", "req-1");
    s.noteCompaction("a", 12, 9_000, "req-1");
    s.noteCompaction("a", 6, 9_500, "req-1");

    expect(useAppStore.getState().aiStreams["a"].compaction).toEqual({
      count: 2,
      removedMessages: 6,
      afterTokens: 9_500,
    });
  });

  it("ignores an event from a superseded request", () => {
    const s = useAppStore.getState();
    s.initAiStream("a", "agent", "req-1");
    s.initAiStream("a", "agent", "req-2");
    s.noteCompaction("a", 12, 9_000, "req-1");

    expect(useAppStore.getState().aiStreams["a"].compaction).toBeNull();
  });

  it("starts each run with a clean line", () => {
    const s = useAppStore.getState();
    s.initAiStream("a", "agent", "req-1");
    s.noteCompaction("a", 12, 9_000, "req-1");
    // Continue dispatches through initAiStream, which is what makes the notice
    // describe THIS run rather than accumulating across a session.
    s.initAiStream("a", "agent", "req-2");

    expect(useAppStore.getState().aiStreams["a"].compaction).toBeNull();
  });

  it("says what was replaced, in both the single and repeated case", () => {
    // The wording is the promise: it has to name the loss, because the whole
    // point of the event is that the model's memory was rewritten.
    const once = S.aiPanel.compacted(12, 1);
    expect(once).toContain("12 messages");
    expect(once).toContain("summary");
    expect(S.aiPanel.compacted(1, 1)).toContain("1 message ");
    expect(S.aiPanel.compacted(6, 3)).toContain("3 times");
  });
});
