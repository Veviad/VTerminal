import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SshHost } from "../lib/types";

const apiMocks = vi.hoisted(() => ({
  writePassword: vi.fn(() => Promise.resolve()),
  beginPassword: vi.fn(() => Promise.resolve("native-attempt")),
  cancelPassword: vi.fn(() => Promise.resolve()),
  ptyWrite: vi.fn(() => Promise.resolve()),
  atPrompt: true,
  terminalListeners: new Map<string, Set<(event: { type: string }) => void>>(),
}));

vi.mock("../lib/tauri", () => ({
  sshHostsWritePassword: apiMocks.writePassword,
  sshHostsBeginPassword: apiMocks.beginPassword,
  sshHostsCancelPassword: apiMocks.cancelPassword,
  ptyWrite: apiMocks.ptyWrite,
}));

vi.mock("../lib/termRegistry", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/termRegistry")>(),
  getTerm: () => ({ disposed: false, tracker: { phase: "input", isAtPromptColumn: () => apiMocks.atPrompt } }),
  subscribeTerm: (sessionId: string, listener: (event: { type: string }) => void) => {
    const listeners = apiMocks.terminalListeners.get(sessionId) ?? new Set();
    listeners.add(listener);
    apiMocks.terminalListeners.set(sessionId, listeners);
    return () => { listeners.delete(listener); };
  },
  emitTerm: (sessionId: string, event: { type: string }) => {
    for (const listener of [...(apiMocks.terminalListeners.get(sessionId) ?? [])]) listener(event);
  },
}));
vi.mock("../lib/ptyExec", () => ({ isBusy: () => false }));

import {
  clearPendingConnect,
  connectToHost,
  isSshPasswordPrompt,
  notePasswordAutofill,
  notePendingConnect,
  observeSshPasswordPrompt,
  takePendingConnect,
} from "../lib/sshConnect";
import { emptySessionUi, useAppStore } from "../stores/appStore";
import { emitTerm } from "../lib/termRegistry";

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
  apiMocks.beginPassword.mockReset().mockResolvedValue("native-attempt");
  apiMocks.cancelPassword.mockClear();
  apiMocks.ptyWrite.mockClear();
  apiMocks.atPrompt = true;
  useAppStore.setState({
    activeSessionId: "s1",
    sessions: [{ id: "s1", shell: "/bin/zsh", cwd: "/tmp", createdAt: "now", exited: false,
      exitCode: null, hostId: null, hostLabel: null, userTitle: null, aiTitle: null, ordinal: 1 }],
    sessionUi: { s1: { ...emptySessionUi(), integrationActive: true } },
  });
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
    expect(isSshPasswordPrompt("deploy@prod-01's password: ", "prod-01", "deploy")).toBe(true);
    expect(isSshPasswordPrompt("Enter passphrase for key '/tmp/id': ", "prod-01", "deploy")).toBe(
      false,
    );
  });

  it("requires the exact destination and user for every connection", () => {
    for (const prompt of ["Password: ", "jump@bastion's password: ", "root@prod-01's password: ", "deploy@prod-01.evil's password: "]) {
      expect(isSshPasswordPrompt(prompt, "prod-01", "deploy")).toBe(false);
    }
    expect(isSshPasswordPrompt("deploy@prod-01's password: ", "prod-01", "deploy")).toBe(true);
  });

  it("ignores ANSI styling around a matching prompt", () => {
    expect(
      isSshPasswordPrompt("\u001b[33mdeploy@prod-01's password:\u001b[0m ", "prod-01", "deploy"),
    ).toBe(true);
  });

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
  it("submits the native token once when a prompt is split across PTY chunks", async () => {
    const encoder = new TextEncoder();
    await notePasswordAutofill("s1", host);
    observeSshPasswordPrompt("s1", encoder.encode("deploy@prod"));
    expect(apiMocks.writePassword).not.toHaveBeenCalled();
    observeSshPasswordPrompt("s1", encoder.encode("-01's password: "));
    await vi.waitFor(() => expect(apiMocks.writePassword).toHaveBeenCalledWith("native-attempt", "s1"));

    observeSshPasswordPrompt("s1", encoder.encode("deploy@prod-01's password: "));
    expect(apiMocks.writePassword).toHaveBeenCalledTimes(1);
  });

  it("does not submit to a stale local prompt after connection cleanup", async () => {
    await notePasswordAutofill("s1", host);
    clearPendingConnect("s1");
    observeSshPasswordPrompt("s1", new TextEncoder().encode("deploy@prod-01's password: "));
    expect(apiMocks.writePassword).not.toHaveBeenCalled();
    expect(apiMocks.cancelPassword).toHaveBeenCalledWith("s1", "native-attempt");
  });

  it("cancels a native grant that arrives after the connection was cancelled", async () => {
    let resolve!: (token: string) => void;
    apiMocks.beginPassword.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const arming = notePasswordAutofill("s1", host);
    clearPendingConnect("s1");
    resolve("late-attempt");
    expect(await arming).toEqual({ kind: "cancelled" });
    expect(apiMocks.cancelPassword).toHaveBeenCalledWith("s1", "late-attempt");
    observeSshPasswordPrompt("s1", new TextEncoder().encode("deploy@prod-01's password: "));
    expect(apiMocks.writePassword).not.toHaveBeenCalled();
  });

  it("uses manual entry for proxy/custom/unknown-user connections or native refusal", async () => {
    for (const overrides of [{ jump_host: "bastion" }, { extra_args: "-o ProxyCommand=custom" }, { username: null }, { config_alias: "alias" }]) {
      expect(await notePasswordAutofill("s1", { ...host, ...overrides })).toMatchObject({ kind: "manual" });
    }
    expect(apiMocks.beginPassword).not.toHaveBeenCalled();
    apiMocks.beginPassword.mockRejectedValueOnce(new Error("no native prompt proof"));
    expect(await notePasswordAutofill("s1", host)).toMatchObject({ kind: "manual" });
    observeSshPasswordPrompt("s1", new TextEncoder().encode("deploy@prod-01's password: "));
    expect(apiMocks.writePassword).not.toHaveBeenCalled();
  });

  it("does not dispatch an older connect after a newer connection owns the tab", async () => {
    let resolve!: (token: string) => void;
    apiMocks.beginPassword.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const old = connectToHost(host, "current-tab", vi.fn(), "s1");
    expect(await connectToHost({ ...host, id: "h2", hostname: "staging" }, "current-tab", vi.fn(), "s1")).toBe("s1");
    resolve("stale-token");
    expect(await old).toBeNull();
    expect(apiMocks.ptyWrite).toHaveBeenCalledTimes(1);
    expect(apiMocks.ptyWrite).toHaveBeenCalledWith("s1", "ssh deploy@staging\r", "native-attempt");
    expect(apiMocks.cancelPassword).toHaveBeenCalledWith("s1", "stale-token");
  });

  it("treats user input during native preparation as cancellation, including manual fallback", async () => {
    let reject!: (error: Error) => void;
    apiMocks.beginPassword.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    const pending = connectToHost(host, "current-tab", vi.fn(), "s1");
    emitTerm("s1", { type: "userInput" });
    reject(new Error("autofill unsupported"));
    expect(await pending).toBeNull();
    expect(apiMocks.ptyWrite).not.toHaveBeenCalled();
  });

  it("rechecks terminal prompt eligibility after native preparation", async () => {
    let resolve!: (token: string) => void;
    apiMocks.beginPassword.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const pending = connectToHost(host, "current-tab", vi.fn(), "s1");
    apiMocks.atPrompt = false;
    resolve("native-attempt");
    expect(await pending).toBeNull();
    expect(apiMocks.ptyWrite).not.toHaveBeenCalled();
    expect(apiMocks.cancelPassword).toHaveBeenCalledWith("s1", "native-attempt");
  });

  it("still dispatches current unsupported authentication for manual entry", async () => {
    expect(await connectToHost({ ...host, username: null }, "current-tab", vi.fn(), "s1")).toBe("s1");
    expect(apiMocks.ptyWrite).toHaveBeenCalledWith("s1", "ssh prod-01\r", undefined);
    expect(apiMocks.beginPassword).not.toHaveBeenCalled();
  });
});
