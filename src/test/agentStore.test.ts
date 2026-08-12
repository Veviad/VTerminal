import { beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "../stores/appStore";
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

describe("agent stream lifecycle", () => {
  it("proposal → approval state → executing → result → back to streaming", () => {
    const s = useAppStore.getState();
    s.initAiStream("a", "agent", "req-1");
    s.setPendingProposal(
      "a",
      { approvalId: "ap1", command: "ls", explanation: "list files", readOnly: true, network: false },
      "awaiting_approval",
    );
    let stream = useAppStore.getState().aiStreams["a"];
    expect(stream.status).toBe("awaiting_approval");
    expect(stream.pendingProposal?.command).toBe("ls");

    useAppStore.getState().beginCommand("a", "ap1", "ls");
    stream = useAppStore.getState().aiStreams["a"];
    expect(stream.status).toBe("executing");
    expect(stream.pendingProposal).toBeNull();
    const cmdMsg = stream.messages.find((m) => m.id === "cmd-ap1");
    expect(cmdMsg?.command?.status).toBe("running");

    useAppStore.getState().appendCommandOutput("a", "ap1", "file1.txt\n");
    useAppStore.getState().appendCommandOutput("a", "ap1", "file2.txt\n");
    useAppStore.getState().finishCommand("a", "ap1", 0);
    stream = useAppStore.getState().aiStreams["a"];
    const done = stream.messages.find((m) => m.id === "cmd-ap1");
    expect(done?.command?.status).toBe("done");
    expect(done?.command?.exitCode).toBe(0);
    expect(done?.command?.output).toBe("file1.txt\nfile2.txt\n");
    expect(stream.status).toBe("streaming");
  });

  it("beginCommand flushes preceding streamed text into a message first", () => {
    const s = useAppStore.getState();
    s.initAiStream("a", "agent", "req-2");
    s.appendAiDelta("a", "I will list the files.");
    useAppStore.getState().beginCommand("a", "ap2", "ls");
    const msgs = useAppStore.getState().aiStreams["a"].messages;
    expect(msgs[msgs.length - 2].content).toBe("I will list the files.");
    expect(msgs[msgs.length - 1].id).toBe("cmd-ap2");
    expect(useAppStore.getState().aiStreams["a"].streamingContent).toBe("");
  });

  it("thinking accumulates and folds into the finished message", () => {
    const s = useAppStore.getState();
    s.initAiStream("a", "ask", "req-3");
    s.appendThinking("a", "step 1… ");
    useAppStore.getState().appendThinking("a", "step 2");
    useAppStore.getState().appendAiDelta("a", "The answer.");
    useAppStore.getState().finishAiStream("a");
    const stream = useAppStore.getState().aiStreams["a"];
    expect(stream.thinkingContent).toBe("");
    const last = stream.messages[stream.messages.length - 1];
    expect(last.content).toBe("The answer.");
    expect(last.thinking).toBe("step 1… step 2");
  });

  it("permissionMode is per-session and defaults to asking", () => {
    expect(useAppStore.getState().aiStreams["a"].permissionMode).toBe("ask");
    useAppStore.getState().setPermissionMode("a", "auto_all");
    expect(useAppStore.getState().aiStreams["a"].permissionMode).toBe("auto_all");
    // A new tab is never born pre-armed, whatever another tab is set to.
    useAppStore.getState().addSession(makeSession("b"));
    expect(useAppStore.getState().aiStreams["b"].permissionMode).toBe("ask");
  });

  it("a policy-blocked command lands as a settled card, not a running one", () => {
    const s = useAppStore.getState();
    s.initAiStream("a", "agent", "req-blocked");
    s.appendAiDelta("a", "Let me fetch that.");
    useAppStore
      .getState()
      .noteBlockedCommand("a", "curl https://example.com", "internet access is off");
    const stream = useAppStore.getState().aiStreams["a"];
    // The streamed prose ahead of it is flushed, same as beginCommand does.
    expect(stream.streamingContent).toBe("");
    const last = stream.messages[stream.messages.length - 1];
    expect(last.command?.status).toBe("blocked");
    expect(last.command?.command).toBe("curl https://example.com");
    expect(last.command?.note).toBe("internet access is off");
    // Never executed: no exit code, no output, and it must not read as running.
    expect(last.command?.exitCode).toBeNull();
    expect(last.command?.output).toBe("");
  });

  it("skipped commands are marked, not removed", () => {
    const s = useAppStore.getState();
    s.initAiStream("a", "agent", "req-4");
    s.beginCommand("a", "ap3", "rm -rf /");
    useAppStore.getState().finishCommand("a", "ap3", null, "skipped");
    const msg = useAppStore.getState().aiStreams["a"].messages.find((m) => m.id === "cmd-ap3");
    expect(msg?.command?.status).toBe("skipped");
  });

  it("queueSteer flushes the in-flight answer ABOVE the user's message", () => {
    // Order is the whole point: the paragraph that was streaming when the user
    // interjected has to close first, or it folds into a bubble BELOW theirs and
    // the transcript claims a sequence that never happened.
    const s = useAppStore.getState();
    s.initAiStream("a", "agent", "req-steer-1");
    s.appendAiDelta("a", "Checking the config file…");
    useAppStore.getState().queueSteer("a", "st1", "no, look at the logs");

    const stream = useAppStore.getState().aiStreams["a"];
    expect(stream.messages.map((m) => m.role)).toEqual(["assistant", "user"]);
    expect(stream.messages[0].content).toBe("Checking the config file…");
    expect(stream.messages[1].content).toBe("no, look at the logs");
    expect(stream.messages[1].steer).toBe("queued");
    expect(stream.streamingContent).toBe("");
    expect(stream.steerQueue).toEqual([{ id: "st1", text: "no, look at the logs" }]);
  });

  it("only SteerDelivered clears the queued badge", () => {
    const s = useAppStore.getState();
    s.initAiStream("a", "agent", "req-steer-2");
    s.queueSteer("a", "st1", "first");
    s.queueSteer("a", "st2", "second");

    useAppStore.getState().markSteersDelivered("a", ["st1"]);
    let stream = useAppStore.getState().aiStreams["a"];
    expect(stream.messages.find((m) => m.id === "msg-steer-st1")?.steer).toBeUndefined();
    // The one the loop did NOT confirm keeps its badge.
    expect(stream.messages.find((m) => m.id === "msg-steer-st2")?.steer).toBe("queued");
    expect(stream.steerQueue.map((q) => q.id)).toEqual(["st2"]);

    useAppStore.getState().markSteersDelivered("a", ["st2"]);
    stream = useAppStore.getState().aiStreams["a"];
    expect(stream.steerQueue).toEqual([]);
  });

  it("a steer the backend refused is flagged undelivered, not dropped", () => {
    const s = useAppStore.getState();
    s.initAiStream("a", "agent", "req-steer-3");
    s.queueSteer("a", "st1", "too late");
    useAppStore.getState().markSteerUndelivered("a", "st1");

    const stream = useAppStore.getState().aiStreams["a"];
    const msg = stream.messages.find((m) => m.id === "msg-steer-st1");
    // Still visible, so the user can resend it — the text is never lost.
    expect(msg?.content).toBe("too late");
    expect(msg?.steer).toBe("undelivered");
    expect(stream.steerQueue).toEqual([]);
  });

  it("finishAiStream turns anything still queued into undelivered", () => {
    const s = useAppStore.getState();
    s.initAiStream("a", "agent", "req-steer-4");
    s.queueSteer("a", "st1", "delivered one");
    s.queueSteer("a", "st2", "stranded one");
    useAppStore.getState().markSteersDelivered("a", ["st1"]);
    useAppStore.getState().finishAiStream("a");

    const stream = useAppStore.getState().aiStreams["a"];
    expect(stream.messages.find((m) => m.id === "msg-steer-st1")?.steer).toBeUndefined();
    expect(stream.messages.find((m) => m.id === "msg-steer-st2")?.steer).toBe("undelivered");
    // Not cleared here: finishAiStream fires on Done, before agent_start's
    // promise resolves. initAiStream owns the reset.
    expect(stream.steerQueue.map((q) => q.id)).toEqual(["st2"]);

    useAppStore.getState().initAiStream("a", "agent", "req-steer-5");
    expect(useAppStore.getState().aiStreams["a"].steerQueue).toEqual([]);
  });

  it("command output is capped", () => {
    const s = useAppStore.getState();
    s.initAiStream("a", "agent", "req-5");
    s.beginCommand("a", "ap4", "yes");
    const bigChunk = "x".repeat(10_000);
    for (let i = 0; i < 30; i++) {
      useAppStore.getState().appendCommandOutput("a", "ap4", bigChunk);
    }
    const msg = useAppStore.getState().aiStreams["a"].messages.find((m) => m.id === "cmd-ap4");
    // Cap is 131_072 checked pre-append, so worst case is cap + one chunk.
    expect((msg?.command?.output.length ?? 0)).toBeLessThan(150_000);
  });
});
