import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearPendingConnect,
  notePendingConnect,
  takePendingConnect,
} from "../lib/sshConnect";

const note = (over: Partial<{ hostId: string; label: string; command: string }> = {}) => ({
  hostId: "h1",
  label: "Prod",
  color: null,
  command: "ssh prod-01",
  at: Date.now(),
  ...over,
});

beforeEach(() => {
  clearPendingConnect("s1");
  clearPendingConnect("s2");
});

afterEach(() => {
  vi.useRealTimers();
});

describe("pending connect binding", () => {
  it("claims the note when the command matches exactly", () => {
    notePendingConnect("s1", note());
    const got = takePendingConnect("s1", "ssh prod-01");
    expect(got?.hostId).toBe("h1");
    // Consumed — a second block cannot claim the same connect.
    expect(takePendingConnect("s1", "ssh prod-01")).toBeNull();
  });

  it("tolerates surrounding whitespace", () => {
    notePendingConnect("s1", note());
    expect(takePendingConnect("s1", "  ssh prod-01  ")?.hostId).toBe("h1");
  });

  it("leaves the note in place for a non-matching command", () => {
    // The user may have hit Enter at the same instant we typed. That block is
    // theirs; ours must still be claimable when it arrives.
    notePendingConnect("s1", note());
    expect(takePendingConnect("s1", "ls -la")).toBeNull();
    expect(takePendingConnect("s1", "ssh prod-01")?.hostId).toBe("h1");
  });

  it("is scoped per session", () => {
    notePendingConnect("s1", note());
    expect(takePendingConnect("s2", "ssh prod-01")).toBeNull();
    expect(takePendingConnect("s1", "ssh prod-01")).not.toBeNull();
  });

  it("expires after the TTL", () => {
    vi.useFakeTimers();
    notePendingConnect("s1", note());
    vi.advanceTimersByTime(31_000);
    expect(takePendingConnect("s1", "ssh prod-01")).toBeNull();
  });

  it("replaces an earlier note for the same session", () => {
    notePendingConnect("s1", note());
    notePendingConnect("s1", note({ hostId: "h2", command: "ssh staging" }));
    expect(takePendingConnect("s1", "ssh prod-01")).toBeNull();
    expect(takePendingConnect("s1", "ssh staging")?.hostId).toBe("h2");
  });

  it("returns null when nothing is pending", () => {
    expect(takePendingConnect("s1", "ssh prod-01")).toBeNull();
  });
});
