import { beforeEach, describe, expect, it, vi } from "vitest";

const archivePut = vi.hoisted(() => vi.fn());
vi.mock("../lib/tauri", () => ({ archivePut }));
vi.mock("../lib/termRegistry", () => ({
  getTerm: () => ({ term: { cols: 120, rows: 40 } }),
  serializeSession: () => null,
}));

import { archiveTranscriptOnly, pauseTranscriptArchiving } from "../lib/sessionArchive";
import { emptyAiStream, emptySessionUi, useAppStore } from "../stores/appStore";
import { makeSession } from "./factories";

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  archivePut.mockReset();
  archivePut.mockResolvedValue(undefined);
  useAppStore.setState({
    sessions: [makeSession({ id: "a" }), makeSession({ id: "b" })],
    sessionUi: { a: emptySessionUi(), b: emptySessionUi() },
    aiStreams: Object.fromEntries(["a", "b"].map((id) => [id, {
      ...emptyAiStream(),
      messages: [{ id: `message-${id}`, role: "user" as const, content: "old chat", createdAt: "2026-09-08T12:00:00.000Z" }],
    }])),
  });
});

describe("pausing one owner's transcript archiving", () => {
  it("drains an older write before allowing the caller to replace its row", async () => {
    const older = deferred();
    archivePut.mockReturnValueOnce(older.promise);
    const writing = archiveTranscriptOnly("a");
    const pause = pauseTranscriptArchiving("a");
    const drained = vi.fn();
    void pause.drained.then(drained);

    await Promise.resolve();
    expect(drained).not.toHaveBeenCalled();
    await expect(archiveTranscriptOnly("a")).resolves.toBe(false);
    expect(archivePut).toHaveBeenCalledOnce();

    older.resolve();
    await expect(writing).resolves.toBe(true);
    await pause.drained;
    expect(drained).toHaveBeenCalledOnce();
    pause.release();
    await expect(archiveTranscriptOnly("a")).resolves.toBe(true);
    expect(archivePut).toHaveBeenCalledTimes(2);
  });

  it("does not pause or wait for another owner's writes", async () => {
    const unrelated = deferred();
    archivePut.mockReturnValueOnce(unrelated.promise);
    const writingB = archiveTranscriptOnly("b");
    const pause = pauseTranscriptArchiving("a");

    await pause.drained;
    await expect(archiveTranscriptOnly("a")).resolves.toBe(false);
    await expect(archiveTranscriptOnly("b")).resolves.toBe(true);
    expect(archivePut.mock.calls.map(([row]) => row.session_id)).toEqual(["b", "b"]);

    unrelated.resolve();
    await writingB;
    pause.release();
  });

  it("settles a rejected older write and resumes after release", async () => {
    const older = deferred();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    archivePut.mockReturnValueOnce(older.promise);
    const writing = archiveTranscriptOnly("a");
    const pause = pauseTranscriptArchiving("a");

    older.reject(new Error("archive disk unavailable"));
    await expect(writing).resolves.toBe(false);
    await expect(pause.drained).resolves.toBeUndefined();
    await expect(archiveTranscriptOnly("a")).resolves.toBe(false);
    pause.release();
    await expect(archiveTranscriptOnly("a")).resolves.toBe(true);
    expect(archivePut).toHaveBeenCalledTimes(2);
    warning.mockRestore();
  });

  it("keeps overlapping pauses active until each is released, with idempotent release", async () => {
    const first = pauseTranscriptArchiving("a");
    const second = pauseTranscriptArchiving("a");
    first.release();
    first.release();
    await expect(archiveTranscriptOnly("a")).resolves.toBe(false);
    expect(archivePut).not.toHaveBeenCalled();

    second.release();
    second.release();
    await expect(archiveTranscriptOnly("a")).resolves.toBe(true);
    expect(archivePut).toHaveBeenCalledOnce();
  });
});
