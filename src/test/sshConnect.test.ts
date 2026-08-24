import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SshHost } from "../lib/types";

const apiMocks = vi.hoisted(() => ({
  writePassword: vi.fn(() => Promise.resolve()),
}));

vi.mock("../lib/tauri", () => ({
  sshHostsWritePassword: apiMocks.writePassword,
  ptyWrite: vi.fn(() => Promise.resolve()),
}));

import {
  clearPendingConnect,
  isSshPasswordPrompt,
  notePasswordAutofill,
  notePendingConnect,
  observeSshPasswordPrompt,
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
  apiMocks.writePassword.mockClear();
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

describe("SSH password prompt matching", () => {
  it("accepts a direct password prompt and rejects private-key passphrases", () => {
    expect(isSshPasswordPrompt("deploy@prod-01's password: ", "prod-01", false)).toBe(true);
    expect(isSshPasswordPrompt("Enter passphrase for key '/tmp/id': ", "prod-01", false)).toBe(
      false,
    );
  });

  it("requires the destination hostname when a proxy may prompt first", () => {
    expect(isSshPasswordPrompt("jump@bastion's password: ", "prod-01", true)).toBe(false);
    expect(isSshPasswordPrompt("deploy@prod-01's password: ", "prod-01", true)).toBe(true);
  });

  it("ignores ANSI styling around a matching prompt", () => {
    expect(
      isSshPasswordPrompt("\u001b[33mdeploy@prod-01's password:\u001b[0m ", "prod-01", true),
    ).toBe(true);
  });

  it("submits once when a prompt is split across PTY chunks", async () => {
    const host: SshHost = {
      id: "h1",
      label: "Prod",
      hostname: "prod-01",
      username: "deploy",
      port: null,
      identity_file: null,
      jump_host: null,
      extra_args: null,
      remote_dir: null,
      post_connect: null,
      tag: null,
      color: null,
      source: "manual",
      config_alias: null,
      use_count: 0,
      last_used_at: null,
      created_at: "now",
      updated_at: "now",
      has_password: true,
    };
    const encoder = new TextEncoder();
    notePasswordAutofill("s1", host);
    observeSshPasswordPrompt("s1", encoder.encode("deploy@prod"));
    expect(apiMocks.writePassword).not.toHaveBeenCalled();
    observeSshPasswordPrompt("s1", encoder.encode("-01's password: "));
    await vi.waitFor(() => expect(apiMocks.writePassword).toHaveBeenCalledWith("h1", "s1"));

    observeSshPasswordPrompt("s1", encoder.encode("deploy@prod-01's password: "));
    expect(apiMocks.writePassword).toHaveBeenCalledTimes(1);
  });
});
