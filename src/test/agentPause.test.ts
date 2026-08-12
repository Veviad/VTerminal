import { beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "../stores/appStore";
import { statusAllowsNaming } from "../lib/sessionNaming";
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

describe("a run that stops at a guard rail", () => {
  it("settles as paused, not as an error", () => {
    const s = useAppStore.getState();
    s.initAiStream("a", "agent", "req-1");
    s.appendAiDelta("a", "I checked two files");
    s.pauseAiStream(
      "a",
      { reason: "step_limit", steps: 10, limit: 10 },
      { prompt: 1200, completion: 340 },
    );

    const stream = useAppStore.getState().aiStreams["a"];
    expect(stream.status).toBe("paused");
    // The distinction the whole feature rests on: no error was raised, so the red
    // banner stays away and the transcript reads as resumable.
    expect(stream.lastError).toBeNull();
    expect(stream.pause).toEqual({ reason: "step_limit", steps: 10, limit: 10 });
    expect(stream.requestId).toBeNull();
  });

  it("flushes the streamed text and stamps the run's usage", () => {
    const s = useAppStore.getState();
    s.initAiStream("a", "agent", "req-1");
    s.appendAiDelta("a", "partial answer");
    s.pauseAiStream(
      "a",
      { reason: "step_limit", steps: 3, limit: 3 },
      { prompt: 900, completion: 120 },
    );

    const stream = useAppStore.getState().aiStreams["a"];
    // Dropping this would lose the model's last words from the panel.
    const last = stream.messages[stream.messages.length - 1];
    expect(last?.content).toBe("partial answer");
    expect(stream.streamingContent).toBe("");
    // No Done fires on the pause path, so the counters have to ride the pause or
    // they are lost for the whole run.
    expect(last?.usage).toEqual({ prompt: 900, completion: 120 });
  });

  it("reports a steer the loop never delivered as undelivered", () => {
    const s = useAppStore.getState();
    s.initAiStream("a", "agent", "req-1");
    s.queueSteer("a", "st-1", "actually check the logs");
    // Past the hard cap the backend deliberately leaves the steer in its mailbox
    // rather than clearing a badge for a message the model never saw.
    s.pauseAiStream("a", { reason: "step_limit", steps: 30, limit: 10 }, undefined);

    const stream = useAppStore.getState().aiStreams["a"];
    const steerMsg = stream.messages.find((m) => m.steer);
    expect(steerMsg?.steer).toBe("undelivered");
  });

  it("keeps the transcript so the next turn resumes with full context", () => {
    const s = useAppStore.getState();
    s.initAiStream("a", "agent", "req-1");
    s.setModelTranscript("a", [
      { role: "user", content: "find the bug" },
      { role: "assistant", content: "checked two files" },
    ]);
    s.pauseAiStream("a", { reason: "step_limit", steps: 10, limit: 10 }, undefined);

    // This is what makes Continue work at all: startAgent reads modelTranscript
    // as `history` at dispatch time.
    expect(useAppStore.getState().aiStreams["a"].modelTranscript).toHaveLength(2);
  });

  it("retires the pause when the next run starts", () => {
    const s = useAppStore.getState();
    s.initAiStream("a", "agent", "req-1");
    s.pauseAiStream("a", { reason: "step_limit", steps: 10, limit: 10 }, undefined);
    expect(useAppStore.getState().aiStreams["a"].pause).not.toBeNull();

    // Continue dispatches through initAiStream, which is what stops a second
    // click resuming the same pause twice.
    useAppStore.getState().initAiStream("a", "agent", "req-2");
    const stream = useAppStore.getState().aiStreams["a"];
    expect(stream.pause).toBeNull();
    expect(stream.status).toBe("streaming");
  });

  it("does not leave a Continue button on a session restored from the archive", () => {
    const s = useAppStore.getState();
    s.initAiStream("a", "agent", "req-1");
    s.pauseAiStream("a", { reason: "context_limit", steps: 4, limit: 10 }, undefined);

    // A restored Continue would dispatch a run against a transcript the user has
    // not looked at.
    useAppStore
      .getState()
      .restoreAiTranscript("a", [], [], new Date().toISOString());
    expect(useAppStore.getState().aiStreams["a"].pause).toBeNull();
  });

  it("counts as a resting state for tab naming", () => {
    // A run parked at the step limit may sit there indefinitely; treating it as
    // busy left such a tab unnamed forever.
    expect(statusAllowsNaming("paused")).toBe(true);
    expect(statusAllowsNaming("idle")).toBe(true);
    expect(statusAllowsNaming("error")).toBe(true);
    // Still never competes with the user's own generation.
    expect(statusAllowsNaming("streaming")).toBe(false);
    expect(statusAllowsNaming("awaiting_approval")).toBe(false);
    expect(statusAllowsNaming("executing")).toBe(false);
  });
});
