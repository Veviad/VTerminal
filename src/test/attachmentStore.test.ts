import { beforeEach, describe, expect, it } from "vitest";
import { emptyAiStream, useAppStore } from "../stores/appStore";
import { MAX_ATTACHMENTS } from "../lib/attachments";
import type { Attachment, Session } from "../lib/types";

const SID = "s1";

function image(id: string): Attachment {
  return { id, kind: "image", name: `${id}.png`, mediaType: "image/png", bytes: 1024, data: "QQ==" };
}

/** `withAiStream` is a no-op for a session that is not in `sessions`, so a stream
 *  entry alone is not enough to drive these actions. */
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

const pending = () => useAppStore.getState().aiStreams[SID]?.pendingAttachments ?? [];
const attachError = () => useAppStore.getState().aiStreams[SID]?.attachError ?? null;

beforeEach(() => {
  useAppStore.setState({
    sessions: [session(SID)],
    aiStreams: { [SID]: emptyAiStream() },
  });
});

describe("pending attachments", () => {
  it("stages and removes by id", () => {
    const s = useAppStore.getState();
    s.attachFilesToAi(SID, [image("a"), image("b")]);
    expect(pending().map((a) => a.id)).toEqual(["a", "b"]);

    s.detachFileFromAi(SID, "a");
    expect(pending().map((a) => a.id)).toEqual(["b"]);
  });

  it("appends across separate drops rather than replacing", () => {
    const s = useAppStore.getState();
    s.attachFilesToAi(SID, [image("a")]);
    s.attachFilesToAi(SID, [image("b")]);
    expect(pending()).toHaveLength(2);
  });

  it("caps at MAX_ATTACHMENTS and says how many it dropped", () => {
    const s = useAppStore.getState();
    const many = Array.from({ length: MAX_ATTACHMENTS + 2 }, (_, i) => image(`a${i}`));
    s.attachFilesToAi(SID, many);

    expect(pending()).toHaveLength(MAX_ATTACHMENTS);
    // Silently swallowing files the user dropped is the failure mode this guards.
    expect(attachError()).toMatch(/2 files not added/);
  });

  it("clears the limit message when the user makes room", () => {
    const s = useAppStore.getState();
    s.attachFilesToAi(SID, Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, i) => image(`a${i}`)));
    expect(attachError()).not.toBeNull();

    s.detachFileFromAi(SID, "a0");
    expect(attachError()).toBeNull();
  });

  /** The send path clears; nothing else may. */
  it("clearPendingAttachments empties both the list and the error", () => {
    const s = useAppStore.getState();
    s.attachFilesToAi(SID, [image("a")]);
    s.setAttachError(SID, "boom");
    s.clearPendingAttachments(SID);

    expect(pending()).toEqual([]);
    expect(attachError()).toBeNull();
  });

  /** `newAiConversation` spreads `emptyAiStream()` precisely so a field added to
   *  AiStreamState later cannot survive the wipe. Pin that for this one. */
  it("a new conversation wipes staged files", () => {
    const s = useAppStore.getState();
    s.attachFilesToAi(SID, [image("a")]);
    s.newAiConversation(SID);
    expect(pending()).toEqual([]);
  });

  /** The reason clearing lives in the send path and NOT in `initAiStream`: a run
   *  that never starts must not eat the user's files. */
  it("starting a stream keeps them staged", () => {
    const s = useAppStore.getState();
    s.attachFilesToAi(SID, [image("a")]);
    s.initAiStream(SID, "ask", "req-1");
    expect(pending().map((a) => a.id)).toEqual(["a"]);
  });

  it("is per-session", () => {
    const s = useAppStore.getState();
    useAppStore.setState({
      sessions: [session(SID), session("s2")],
      aiStreams: { [SID]: emptyAiStream(), s2: emptyAiStream() },
    });
    s.attachFilesToAi(SID, [image("a")]);
    expect(useAppStore.getState().aiStreams.s2.pendingAttachments).toEqual([]);
  });
});
