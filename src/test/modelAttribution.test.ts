import { beforeEach, describe, expect, it } from "vitest";
import { emptySessionUi, useAppStore } from "../stores/appStore";
import type { Session } from "../lib/types";

// `StreamEvent::Started` carries the serving model, and the frontend used to
// have no `case "Started"` at all — it was discarded. The visible consequence
// was that switching models mid-conversation relabelled the ENTIRE scrollback,
// because the UI read the current setting instead of what actually answered.

function session(id: string): Session {
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

const SID = "s1";

/** One complete exchange on `model`, as the event stream would drive it. */
function exchange(model: string, answer: string, usage = { prompt: 10, completion: 5 }) {
  const s = useAppStore.getState();
  s.initAiStream(SID, "ask", `req-${model}-${answer}`);
  s.setAiStreamModel(SID, model);
  s.appendAiDelta(SID, answer);
  s.finishAiStream(SID, undefined, usage);
}

describe("per-message model attribution", () => {
  beforeEach(() => {
    useAppStore.setState({
      sessions: [session(SID)],
      activeSessionId: SID,
      sessionUi: { [SID]: emptySessionUi() },
      aiStreams: { [SID]: useAppStore.getState().aiStreams[SID] ?? undefined } as never,
    });
    // Rebuild a clean stream for the session.
    useAppStore.getState().removeSession(SID);
    useAppStore.getState().addSession(session(SID));
  });

  it("stamps the serving model onto the finished message", () => {
    exchange("Gemma 4 E4B", "hello");
    const msgs = useAppStore.getState().aiStreams[SID].messages;
    const last = msgs[msgs.length - 1];
    expect(last.role).toBe("assistant");
    expect(last.model).toBe("Gemma 4 E4B");
  });

  it("switching models does not relabel earlier answers", () => {
    exchange("Gemma 4 E4B", "first");
    exchange("Claude Opus 5", "second");

    const answers = useAppStore
      .getState()
      .aiStreams[SID].messages.filter((m) => m.role === "assistant");
    expect(answers).toHaveLength(2);
    // The whole point: the first answer keeps its own provenance.
    expect(answers[0].model).toBe("Gemma 4 E4B");
    expect(answers[1].model).toBe("Claude Opus 5");
  });

  it("records token usage per exchange", () => {
    exchange("Claude Opus 5", "hi", { prompt: 1234, completion: 56 });
    const msgs = useAppStore.getState().aiStreams[SID].messages;
    expect(msgs[msgs.length - 1].usage).toEqual({ prompt: 1234, completion: 56 });
  });

  it("clears the model between requests so a stale label cannot leak", () => {
    exchange("Gemma 4 E4B", "first");
    // A request that never receives Started must not inherit the previous one's
    // label — better no badge than a wrong one.
    const s = useAppStore.getState();
    s.initAiStream(SID, "ask", "req-2");
    expect(useAppStore.getState().aiStreams[SID].model).toBeNull();
    s.appendAiDelta(SID, "second");
    s.finishAiStream(SID);
    const msgs = useAppStore.getState().aiStreams[SID].messages;
    expect(msgs[msgs.length - 1].model).toBeUndefined();
  });
});
