import { beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "../stores/appStore";
import type { Session } from "../lib/types";

// Same shape as the other store tests' local helper.
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

/** Per-session bucket attachment.
 *
 *  An empty list is what withholds `search_docs` from a run, so these assertions are
 *  about exactly two things: that the list is per-session and never bleeds between
 *  tabs, and that it lasts as long as the conversation does but no longer — surviving
 *  turns, cleared by a new chat, and empty in a session opened from the archive.
 */

beforeEach(() => {
  useAppStore.setState({ sessions: [], aiStreams: {}, sessionUi: {}, docBuckets: [] });
  useAppStore.getState().addSession(makeSession("s1"));
});

const stream = () => useAppStore.getState().aiStreams["s1"];

describe("attach and detach", () => {
  it("starts empty, so a fresh session has no document capability", () => {
    expect(stream().attachedBucketIds).toEqual([]);
  });

  it("attaches and detaches by id", () => {
    const s = useAppStore.getState();
    s.attachBucketToAi("s1", "b1");
    s.attachBucketToAi("s1", "b2");
    expect(stream().attachedBucketIds).toEqual(["b1", "b2"]);

    useAppStore.getState().detachBucketFromAi("s1", "b1");
    expect(stream().attachedBucketIds).toEqual(["b2"]);
  });

  /** A double click on the same checkbox must not send the same bucket twice — the id
   *  list becomes a SQL `IN` clause, and a duplicate would double that bucket's weight
   *  in nothing but wasted work. */
  it("is idempotent", () => {
    const s = useAppStore.getState();
    s.attachBucketToAi("s1", "b1");
    s.attachBucketToAi("s1", "b1");
    expect(stream().attachedBucketIds).toEqual(["b1"]);

    useAppStore.getState().detachBucketFromAi("s1", "nope");
    expect(stream().attachedBucketIds).toEqual(["b1"]);
  });

  it("does not leak across sessions", () => {
    useAppStore.getState().addSession(makeSession("s2"));
    useAppStore.getState().attachBucketToAi("s1", "b1");
    expect(useAppStore.getState().aiStreams["s2"].attachedBucketIds).toEqual([]);
  });

  it("no-ops for a session that does not exist", () => {
    useAppStore.getState().attachBucketToAi("ghost", "b1");
    expect(useAppStore.getState().aiStreams["ghost"]).toBeUndefined();
  });
});

describe("lifetime", () => {
  /** Nothing persists attachment, and `restoreAiTranscript` only ever runs on a session
   *  `createSession` just made (see `sessionReopen.ts`), so a reopened session begins
   *  with an empty list. This pins the consequence rather than the mechanism: a reopened
   *  conversation does NOT silently arrive with a bucket the previous session had. */
  it("a session with a restored transcript starts with nothing attached", () => {
    useAppStore.getState().restoreAiTranscript("s1", [], [], "2026-08-01T00:00:00.000Z");
    expect(stream().attachedBucketIds).toEqual([]);
    // The stance restoreAiTranscript documents for the fields it does reset.
    expect(stream().permissionMode).toBe("ask");
    expect(stream().mode).toBe("ask");
    expect(stream().pause).toBeNull();
  });

  /** A new chat is a clean slate. `newAiConversation` spreads `emptyAiStream()` rather
   *  than listing fields, precisely so a field added later cannot silently survive the
   *  wipe — this pins that the new field obeys it. */
  it("clears attached buckets on a new conversation", () => {
    useAppStore.getState().attachBucketToAi("s1", "b1");
    useAppStore.getState().newAiConversation("s1");
    expect(stream().attachedBucketIds).toEqual([]);
  });

  /** Attachment is standing context: it must outlive a turn, or the user would have to
   *  re-pick their documentation before every message. */
  it("survives a turn starting and finishing", () => {
    const s = useAppStore.getState();
    s.attachBucketToAi("s1", "b1");
    s.initAiStream("s1", "agent", "req-1");
    expect(stream().attachedBucketIds).toEqual(["b1"]);
    useAppStore.getState().finishAiStream("s1");
    expect(stream().attachedBucketIds).toEqual(["b1"]);
  });
});
