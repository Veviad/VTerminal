import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TermEvent } from "../lib/termRegistry";

// The repo's first Tauri IPC mock. It stays trivial because ptyExec reaches the
// outside world through exactly two seams: ptyWrite and the term registry.
const ptyWrite = vi.fn((_sessionId: string, _data: string) => Promise.resolve());
vi.mock("../lib/tauri", () => ({
  ptyWrite: (sessionId: string, data: string) => ptyWrite(sessionId, data),
  submitCommandResult: vi.fn(() => Promise.resolve()),
}));

const listeners = new Set<(e: TermEvent) => void>();
let entry: FakeEntry | undefined;

vi.mock("../lib/termRegistry", () => ({
  getTerm: () => entry,
  subscribeTerm: (_id: string, fn: (e: TermEvent) => void) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  emitTerm: (_id: string, e: TermEvent) => {
    for (const fn of [...listeners]) fn(e);
  },
}));

const {
  runInTerminal,
  abortSession,
  captureApprovalPromptBinding,
  interruptJob,
  resetSessionMode,
} = await import("../lib/ptyExec");
const { hardenCommand, suppressPrivateOutput } = await import("../lib/ptyExecShell");
const {
  isTerminalOutputProtected,
  resetRunbookTerminalPrivacyForTests,
} = await import("../lib/runbookTerminalPrivacy");
const { useAppStore } = await import("../stores/appStore");

/**
 * What `hardenCommand` turns a command into — i.e. what the shell will report
 * back through OSC 6973;CMD. Derived rather than hardcoded so these tests keep
 * proving the binding rule instead of the env string: matching a block against
 * the UN-hardened command binds nothing and every run dies as
 * `command_not_observed`.
 */
const typed = (command: string) => hardenCommand(command).line;

interface FakeEntry {
  disposed: boolean;
  lastDataAt: number;
  lastUserInputAt: number;
  registeredMarkers: FakeMarker[];
  blockMarkers: Map<string, { start: { line: number; isDisposed: boolean }; end: { line: number; isDisposed: boolean } | null }>;
  tracker: {
    isAtEmptyPrompt: () => boolean;
    isAtPromptColumn: () => boolean;
    beginRunbookOutputIsolation: () => void;
    endRunbookOutputIsolation: () => void;
  };
  term: {
    rows: number;
    focus: () => void;
    registerMarker: (offset?: number) => FakeMarker;
    buffer: {
      active: {
        type: string;
        baseY: number;
        cursorX: number;
        cursorY: number;
        length: number;
        getLine: (y: number) => { translateToString: () => string; isWrapped: boolean } | undefined;
      };
    };
  };
}

interface FakeMarker {
  line: number;
  isDisposed: boolean;
  dispose: () => void;
  onDispose: (callback: () => void) => { dispose(): void };
}

function makeMarker(line: number): FakeMarker {
  const listeners = new Set<() => void>();
  const marker: FakeMarker = {
    line,
    isDisposed: false,
    dispose: vi.fn(() => {
      if (marker.isDisposed) return;
      marker.isDisposed = true;
      marker.line = -1;
      for (const listener of [...listeners]) listener();
      listeners.clear();
    }),
    onDispose: (callback) => {
      listeners.add(callback);
      return { dispose: () => listeners.delete(callback) };
    },
  };
  return marker;
}

function makeEntry(lines: string[], opts: Partial<{ atPrompt: boolean; bufferType: string }> = {}): FakeEntry {
  const atPrompt = opts.atPrompt ?? true;
  const registeredMarkers: FakeMarker[] = [];
  const active = {
    type: opts.bufferType ?? "normal",
    baseY: 0,
    cursorX: 2,
    cursorY: lines.length - 1,
    length: lines.length,
    getLine: (y: number) =>
      lines[y] === undefined
        ? undefined
        : { translateToString: () => lines[y], isWrapped: false },
  };
  return {
    disposed: false,
    lastDataAt: 0,
    lastUserInputAt: 0,
    registeredMarkers,
    blockMarkers: new Map(),
    tracker: {
      isAtEmptyPrompt: () => atPrompt,
      isAtPromptColumn: () => atPrompt,
      beginRunbookOutputIsolation: () => {},
      endRunbookOutputIsolation: () => {},
    },
    term: {
      rows: 24,
      // A password prompt brings the tab forward so the user can just type.
      focus: () => {},
      registerMarker: (offset = 0) => {
        const marker = makeMarker(active.baseY + active.cursorY + offset);
        registeredMarkers.push(marker);
        return marker;
      },
      buffer: {
        active,
      },
    },
  };
}

const emit = (e: TermEvent) => {
  for (const fn of [...listeners]) fn(e);
};
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  ptyWrite.mockClear();
  listeners.clear();
  resetRunbookTerminalPrivacyForTests();
  resetSessionMode("s1");
  useAppStore.setState({
    sessions: [
      {
        id: "s1",
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
      },
    ],
    activeSessionId: "s1",
    sessionUi: {},
    aiStreams: {},
  });
});

afterEach(() => {
  abortSession("s1");
  vi.useRealTimers();
});

describe("runInTerminal — integrated session", () => {
  it("types the command once and reports the block's exit code and output", async () => {
    entry = makeEntry(["$ ", "hello", "$ "]);
    const promise = runInTerminal("s1", "ap1", "echo hello", { timeoutMs: 5000 });
    await flush();

    expect(ptyWrite).toHaveBeenCalledTimes(1);
    expect(ptyWrite).toHaveBeenCalledWith("s1", `${typed("echo hello")}\r`);

    entry.blockMarkers.set("b1", {
      start: { line: 1, isDisposed: false },
      end: { line: 2, isDisposed: false },
    });
    emit({ type: "blockStart", blockId: "b1", command: typed("echo hello") });
    emit({ type: "blockEnd", blockId: "b1", exitCode: 0, endLine: 2 });

    const outcome = await promise;
    expect(outcome.exitCode).toBe(0);
    expect(outcome.output).toBe("hello");
    expect(outcome.error).toBeUndefined();
    // Written exactly once — a retry into someone's live shell is unrecoverable.
    expect(ptyWrite).toHaveBeenCalledTimes(1);
  });

  it("propagates a non-zero exit code", async () => {
    entry = makeEntry(["$ ", "nope", "$ "]);
    const promise = runInTerminal("s1", "ap1", "false", { timeoutMs: 5000 });
    await flush();
    entry.blockMarkers.set("b1", {
      start: { line: 1, isDisposed: false },
      end: { line: 2, isDisposed: false },
    });
    emit({ type: "blockStart", blockId: "b1", command: typed("false") });
    emit({ type: "blockEnd", blockId: "b1", exitCode: 127, endLine: 2 });
    expect((await promise).exitCode).toBe(127);
  });

  it("groups private commands in the current shell and never harvests their bytes", async () => {
    const command = "export GENERATED=$(openssl rand -hex 32)";
    const wrapped = suppressPrivateOutput(typed(command), "posix");
    entry = makeEntry(["$ ", "must-not-be-captured", "$ "]);
    const promise = runInTerminal("s1", "private-ap1", command, {
      timeoutMs: 5000,
      outputPolicy: "private",
    });
    await flush();

    expect(ptyWrite).toHaveBeenCalledWith("s1", `${wrapped}\r`);
    expect(isTerminalOutputProtected("s1")).toBe(true);
    entry.blockMarkers.set("private-b1", {
      start: { line: 1, isDisposed: false },
      end: { line: 2, isDisposed: false },
    });
    emit({ type: "blockStart", blockId: "private-b1", command: wrapped });
    emit({ type: "blockEnd", blockId: "private-b1", exitCode: 0, endLine: 2 });

    const outcome = await promise;
    expect(outcome.output).toBe("");
    expect(outcome.outputObservedBytes).toBe(0);
    expect(outcome.note).toBe("[private output suppressed]");
  });

  it("marks output as truncated when the bound block was trimmed", async () => {
    entry = makeEntry(["$ ", "retained tail", "$ "]);
    const promise = runInTerminal("s1", "ap1", "echo lots", { timeoutMs: 5000 });
    await flush();
    entry.blockMarkers.set("b1", {
      start: { line: 1, isDisposed: false },
      end: { line: 2, isDisposed: false },
    });
    emit({ type: "blockStart", blockId: "b1", command: typed("echo lots") });
    emit({ type: "blockTrimmed", blockId: "b1" });
    emit({ type: "blockEnd", blockId: "b1", exitCode: 0, endLine: 2 });
    expect((await promise).outputTruncated).toBe(true);
  });

  // The user may hit Enter at the same instant; OSC 6973 gives us the exact
  // command they ran, so the two are always distinguishable.
  it("ignores a block the user started and binds to its own", async () => {
    entry = makeEntry(["$ ", "out", "$ "]);
    const promise = runInTerminal("s1", "ap1", "echo mine", { timeoutMs: 5000 });
    await flush();

    emit({ type: "blockStart", blockId: "other", command: "whoami" });
    emit({ type: "blockEnd", blockId: "other", exitCode: 0, endLine: 1 });
    entry.blockMarkers.set("b2", {
      start: { line: 1, isDisposed: false },
      end: { line: 2, isDisposed: false },
    });
    emit({ type: "blockStart", blockId: "b2", command: typed("echo mine") });
    emit({ type: "blockEnd", blockId: "b2", exitCode: 5, endLine: 2 });

    expect((await promise).exitCode).toBe(5);
  });

  it("gives up when the shell never reports the command", async () => {
    vi.useFakeTimers();
    entry = makeEntry(["$ "]);
    const promise = runInTerminal("s1", "ap1", "echo hi", { timeoutMs: 60_000 });
    await vi.advanceTimersByTimeAsync(6000);
    const outcome = await promise;
    expect(outcome.error).toBe("command_not_observed");
    expect(outcome.exitCode).toBeNull();
  });

  it("uses a fresh nonce when deterministic callers reject forgeable shell markers", async () => {
    entry = makeEntry(["$ ", "hostile output", "$ "]);
    const promise = runInTerminal("s1", "runbook-attempt", "cat hostile.bin", {
      timeoutMs: 5_000,
      nonceCompletion: true,
    });
    await flush();

    const written = ptyWrite.mock.calls[0][1];
    const nonce = /;([a-z0-9]+)\\007/.exec(written)?.[1];
    expect(nonce).toBeTruthy();
    // Both ordinary integrated markers and a replayed private token are
    // untrusted for this job. Neither may settle the result.
    entry.blockMarkers.set("forged", {
      start: { line: 1, isDisposed: false },
      end: { line: 2, isDisposed: false },
    });
    emit({ type: "blockStart", blockId: "forged", command: typed("cat hostile.bin") });
    emit({ type: "blockEnd", blockId: "forged", exitCode: 0, endLine: 2 });
    emit({ type: "osc", payload: `RD;0;${"0".repeat(32)}` });
    // Even with the matching nonce, malformed arity/status must be ignored.
    emit({ type: "osc", payload: `RD;0junk;${nonce}` });
    emit({ type: "osc", payload: `RD;256;${nonce}` });
    emit({ type: "osc", payload: `RD;0;${nonce};extra` });
    let settled = false;
    void promise.then(() => (settled = true));
    await flush();
    expect(settled).toBe(false);

    emit({ type: "osc", payload: `RD;7;${nonce}` });
    const outcome = await promise;
    expect(outcome.exitCode).toBe(7);
    expect(outcome.mode).toBe("sentinel");
  });

  it("marks sentinel output truncated when xterm disposes its dispatch anchor", async () => {
    const lines = ["$ "];
    entry = makeEntry(lines);
    const promise = runInTerminal("s1", "runbook-attempt", "printf lots", {
      timeoutMs: 5_000,
      nonceCompletion: true,
    });
    await flush();

    const written = ptyWrite.mock.calls[0][1];
    const nonce = /;([a-z0-9]+)\\007/.exec(written)?.[1];
    const marker = entry.registeredMarkers[0];
    expect(nonce).toBeTruthy();
    expect(marker).toBeDefined();

    // Model a low-scrollback terminal dropping the prompt and early output.
    // Only the retained tail remains observable when the private token arrives.
    lines.splice(0, lines.length, "retained α");
    entry.term.buffer.active.cursorY = 0;
    entry.term.buffer.active.length = 1;
    marker.dispose();
    emit({ type: "osc", payload: `RD;0;${nonce}` });

    const outcome = await promise;
    const retainedBytes = new TextEncoder().encode("retained α").length;
    expect(outcome.output).toBe("retained α");
    expect(outcome.outputTruncated).toBe(true);
    expect(outcome.outputObservedBytes).toBe(retainedBytes);
    expect(outcome.outputCapturedBytes).toBe(retainedBytes);
  });

  it("harvests sentinel output from the marker's shifted live line", async () => {
    const lines = ["old history", "$ "];
    entry = makeEntry(lines);
    const promise = runInTerminal("s1", "runbook-attempt", "printf kept", {
      timeoutMs: 5_000,
      nonceCompletion: true,
    });
    await flush();

    const written = ptyWrite.mock.calls[0][1];
    const nonce = /;([a-z0-9]+)\\007/.exec(written)?.[1];
    const marker = entry.registeredMarkers[0];
    expect(marker.line).toBe(1);

    // xterm shifts live markers as history ahead of them is trimmed. The old
    // integer row is now outside this buffer range, but no command output was
    // lost because the dispatch marker itself remains live.
    lines.splice(0, lines.length, "$ ", "kept");
    marker.line = 0;
    entry.term.buffer.active.cursorY = 1;
    entry.term.buffer.active.length = 2;
    emit({ type: "osc", payload: `RD;0;${nonce}` });

    const outcome = await promise;
    expect(outcome.output).toBe("kept");
    expect(outcome.outputTruncated).toBe(false);
    expect(outcome.outputObservedBytes).toBe(4);
    expect(outcome.outputCapturedBytes).toBe(4);
  });

  it("disposes a sentinel anchor after complete capture without claiming truncation", async () => {
    const lines = ["$ "];
    entry = makeEntry(lines);
    const promise = runInTerminal("s1", "runbook-attempt", "printf done", {
      timeoutMs: 5_000,
      nonceCompletion: true,
    });
    await flush();

    const written = ptyWrite.mock.calls[0][1];
    const nonce = /;([a-z0-9]+)\\007/.exec(written)?.[1];
    const marker = entry.registeredMarkers[0];
    lines.push("done");
    entry.term.buffer.active.cursorY = 1;
    entry.term.buffer.active.length = 2;
    emit({ type: "osc", payload: `RD;0;${nonce}` });

    const outcome = await promise;
    expect(outcome.output).toBe("done");
    expect(outcome.outputTruncated).toBe(false);
    expect(outcome.outputObservedBytes).toBe(4);
    expect(outcome.outputCapturedBytes).toBe(4);
    expect(marker.dispose).toHaveBeenCalledOnce();
    expect(marker.isDisposed).toBe(true);
  });

  it("does not send a preflight probe before a runbook dispatch lease", async () => {
    useAppStore.getState().updateSessionUi("s1", {
      remote: { kind: "ssh", target: "prod-01" },
    });
    entry = makeEntry(["remote$ "]);
    let releaseClaim: ((allowed: boolean) => void) | undefined;
    const beforeWrite = vi.fn(
      () => new Promise<boolean>((resolve) => { releaseClaim = resolve; }),
    );
    const promise = runInTerminal("s1", "runbook-attempt", "true", {
      timeoutMs: 5_000,
      nonceCompletion: true,
      beforeWrite,
    });
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(beforeWrite).toHaveBeenCalledTimes(1);
    expect(ptyWrite).not.toHaveBeenCalled();

    releaseClaim?.(false);
    expect((await promise).error).toBe("target_changed");
    expect(ptyWrite).not.toHaveBeenCalled();
  });

  it("claims a remote runbook lease before using separate probe and command nonces", async () => {
    useAppStore.getState().updateSessionUi("s1", {
      remote: { kind: "ssh", target: "prod-01" },
    });
    entry = makeEntry(["remote$ ", "done", "remote$ "]);
    const binding = captureApprovalPromptBinding("s1");
    const beforeWrite = vi.fn(() => true);
    const canWrite = vi.fn(() => true);
    const promise = runInTerminal("s1", "runbook-attempt", "printf done", {
      timeoutMs: 5_000,
      nonceCompletion: true,
      approvalPromptBinding: binding!,
      beforeWrite,
      canWrite,
    });

    await flush();
    expect(beforeWrite).toHaveBeenCalledTimes(1);
    expect(ptyWrite).toHaveBeenCalledTimes(1);
    const probeNonce = /6973;RP;([a-f0-9]{32});/.exec(ptyWrite.mock.calls[0][1])?.[1];
    expect(probeNonce).toHaveLength(32);
    emit({ type: "osc", payload: `RP;${probeNonce};z5.9;b;f` });

    await flush();
    expect(ptyWrite).toHaveBeenCalledTimes(2);
    const commandWrite = ptyWrite.mock.calls[1][1];
    const commandNonce = /RD;%s;([a-f0-9]{32})\\007/.exec(commandWrite)?.[1];
    expect(commandNonce).toHaveLength(32);
    expect(commandNonce).not.toBe(probeNonce);
    expect(canWrite).toHaveBeenCalledTimes(1);

    emit({ type: "osc", payload: `RD;0;${commandNonce}` });
    const outcome = await promise;
    expect(outcome.exitCode).toBe(0);
    expect(outcome.mode).toBe("sentinel");
  });
});

describe("runInTerminal — refusing to type", () => {
  it("binds a Runbook approval click to the exact unchanged terminal epoch", async () => {
    entry = makeEntry(["remote$ "]);
    const binding = captureApprovalPromptBinding("s1");
    expect(binding).not.toBeNull();
    entry.lastUserInputAt = Date.now();

    const outcome = await runInTerminal("s1", "approval-bound", "touch /tmp/nope", {
      nonceCompletion: true,
      approvalPromptBinding: binding!,
      beforeWrite: vi.fn(() => true),
    });

    expect(outcome.error).toBe("target_changed");
    expect(ptyWrite).not.toHaveBeenCalled();
  });

  it("revalidates the shell prompt after an asynchronous dispatch claim", async () => {
    entry = makeEntry(["$ "]);
    let releaseClaim!: (allowed: boolean) => void;
    let claimStarted!: () => void;
    const started = new Promise<void>((resolve) => (claimStarted = resolve));
    const promise = runInTerminal("s1", "ap1", "touch /tmp/nope", {
      beforeWrite: () => new Promise<boolean>((resolve) => {
        releaseClaim = resolve;
        claimStarted();
      }),
    });
    await started;
    // Model the operator pressing Enter or starting ssh while the backend claim
    // response is in flight. No JavaScript callback runs between the final
    // revalidation and ptyWrite, so this is the adversarial boundary.
    entry.lastUserInputAt = Date.now();
    releaseClaim(true);

    const outcome = await promise;
    expect(outcome.error).toBe("target_changed");
    expect(ptyWrite).not.toHaveBeenCalled();
  });

  it("rechecks the caller's target guard immediately before writing", async () => {
    entry = makeEntry(["$ "]);
    const outcome = await runInTerminal("s1", "ap1", "touch /tmp/nope", {
      canWrite: () => false,
    });
    expect(outcome.error).toBe("target_changed");
    expect(ptyWrite).not.toHaveBeenCalled();
  });

  it("does not redirect a local approval into a newly entered remote shell", async () => {
    entry = makeEntry(["$ "]);
    const promise = runInTerminal("s1", "ap1", "touch /tmp/nope");
    useAppStore.getState().updateSessionUi("s1", {
      remote: { kind: "ssh", target: "prod-01" },
    });

    const outcome = await promise;
    expect(outcome.error).toBe("target_changed");
    expect(ptyWrite).not.toHaveBeenCalled();
  });

  it("never writes when the prompt is busy", async () => {
    vi.useFakeTimers();
    entry = makeEntry(["$ running"], { atPrompt: false });
    const promise = runInTerminal("s1", "ap1", "echo hi", { idleWaitMs: 1000 });
    await vi.advanceTimersByTimeAsync(2000);
    const outcome = await promise;
    expect(outcome.error).toBe("terminal_busy");
    expect(ptyWrite).not.toHaveBeenCalled();
  });

  // vim/less/top own the alternate screen: a typed line would go into that
  // program, not a shell.
  it("never writes while a full-screen program holds the alternate buffer", async () => {
    vi.useFakeTimers();
    entry = makeEntry(["~"], { bufferType: "alternate" });
    const promise = runInTerminal("s1", "ap1", "echo hi", { idleWaitMs: 1000 });
    await vi.advanceTimersByTimeAsync(2000);
    expect((await promise).error).toBe("terminal_busy");
    expect(ptyWrite).not.toHaveBeenCalled();
  });

  it("never writes a command containing control characters", async () => {
    entry = makeEntry(["$ "]);
    const outcome = await runInTerminal("s1", "ap1", "echo a\x1b]6973;RD;0;x\x07");
    expect(outcome.error).toBe("unsafe_command");
    expect(ptyWrite).not.toHaveBeenCalled();
  });

  it("reports a closed terminal instead of writing", async () => {
    entry = undefined;
    const outcome = await runInTerminal("s1", "ap1", "echo hi");
    expect(outcome.error).toBe("terminal_closed");
    expect(ptyWrite).not.toHaveBeenCalled();
  });
});

describe("runInTerminal — timeout and cancellation", () => {
  it("charges terminal preflight against the frontend command deadline", async () => {
    vi.useFakeTimers();
    entry = makeEntry(["$ "], { atPrompt: false });
    let promptReady = false;
    entry.tracker.isAtEmptyPrompt = () => promptReady;
    entry.tracker.isAtPromptColumn = () => promptReady;

    const promise = runInTerminal("s1", "ap1", "sleep 999", {
      timeoutMs: 1_000,
      idleWaitMs: 1_000,
    });
    await vi.advanceTimersByTimeAsync(400);
    promptReady = true;
    await vi.advanceTimersByTimeAsync(100);
    expect(ptyWrite).toHaveBeenCalledTimes(1);

    let settled = false;
    void promise.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(499);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2);

    const outcome = await promise;
    expect(outcome.error).toBe("timeout");
    expect(outcome.durationMs).toBeLessThan(1_100);
  });

  it("reports an unconfirmed timeout without claiming the command is still running", async () => {
    vi.useFakeTimers();
    entry = makeEntry(["$ ", "partial"]);
    const promise = runInTerminal("s1", "ap1", "sleep 999", { timeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(1500);

    const outcome = await promise;
    expect(outcome.error).toBe("timeout");
    expect(outcome.exitCode).toBeNull();
    expect(outcome.note).toContain("may still be running");
    expect(outcome.note).toContain("may have finished after terminal integration was lost");
    // Completion is unknown, and timeout itself never sends an interrupt.
    for (const call of ptyWrite.mock.calls) {
      expect(call[1]).not.toContain("\x03");
    }
  });

  it("suppresses live terminal bytes even when a private command times out", async () => {
    vi.useFakeTimers();
    entry = makeEntry(["$ ", "private-partial"]);
    const promise = runInTerminal("s1", "private-timeout", "sleep 999", {
      timeoutMs: 1000,
      outputPolicy: "private",
    });
    await vi.advanceTimersByTimeAsync(1500);

    const outcome = await promise;
    expect(outcome.error).toBe("timeout");
    expect(outcome.output).toBe("");
    expect(outcome.outputObservedBytes).toBe(0);
    expect(outcome.note).toContain("[private output suppressed]");
    expect(outcome.note).toContain("No completion signal arrived");
  });

  it("abortSession resolves the pending command without touching the terminal", async () => {
    entry = makeEntry(["$ "]);
    const promise = runInTerminal("s1", "ap1", "sleep 999", { timeoutMs: 60_000 });
    await flush();
    const writesBefore = ptyWrite.mock.calls.length;

    abortSession("s1", "cancelled");
    const outcome = await promise;
    expect(outcome.error).toBe("cancelled");
    expect(ptyWrite.mock.calls.length).toBe(writesBefore);
  });

  it("does not abort another feature's command when an owner id is supplied", async () => {
    entry = makeEntry(["$ "]);
    const promise = runInTerminal("s1", "ai-command", "sleep 999", { timeoutMs: 60_000 });
    await flush();

    expect(abortSession("s1", "cancelled", "runbook-attempt")).toBe(false);
    expect(abortSession("s1", "cancelled", "ai-command")).toBe(true);
    expect((await promise).error).toBe("cancelled");
  });

  it("closing the terminal releases a pending command", async () => {
    entry = makeEntry(["$ "]);
    const promise = runInTerminal("s1", "ap1", "sleep 999", { timeoutMs: 60_000 });
    await flush();
    emit({ type: "disposed" });
    expect((await promise).error).toBe("terminal_closed");
  });

  it("refuses a second command while one is still being awaited", async () => {
    entry = makeEntry(["$ "]);
    const first = runInTerminal("s1", "ap1", "sleep 999", { timeoutMs: 60_000 });
    await flush();
    const second = await runInTerminal("s1", "ap2", "echo hi", { timeoutMs: 60_000 });
    expect(second.error).toBe("terminal_busy");
    abortSession("s1");
    await first;
  });
});

describe("runInTerminal — a command that hangs", () => {
  const writes = () => ptyWrite.mock.calls.map((c) => c[1]);

  // The one signal acted on without asking: the pre-flight gate proved we were at
  // a shell prompt, so whatever seized the screen came from the line we typed.
  it("sends SIGINT when the command seizes the alternate screen", async () => {
    entry = makeEntry(["$ ", "", "$ "]);
    const promise = runInTerminal("s1", "ap1", "vim /etc/hosts", { timeoutMs: 60_000 });
    await flush();
    expect(ptyWrite).toHaveBeenCalledTimes(1);

    entry.term.buffer.active.type = "alternate";
    emit({ type: "bufferChange", buffer: "alternate" });
    await flush();
    expect(writes()[1]).toBe("\x03");

    // Ctrl-C landed: the shell reaches its prompt and reports 130 itself, so the
    // job settles through the ordinary completion path.
    entry.term.buffer.active.type = "normal";
    entry.blockMarkers.set("b1", {
      start: { line: 1, isDisposed: false },
      end: { line: 2, isDisposed: false },
    });
    emit({ type: "blockStart", blockId: "b1", command: typed("vim /etc/hosts") });
    emit({ type: "blockEnd", blockId: "b1", exitCode: 130, endLine: 2 });

    const outcome = await promise;
    expect(outcome.exitCode).toBe(130);
    expect(outcome.error).toBe("interrupted");
    expect(outcome.note).toContain("shell then reported completion");
  });

  it("settles after the TUI returns to normal but completion integration is lost", async () => {
    vi.useFakeTimers();
    entry = makeEntry(["$ ", "partial"]);
    const promise = runInTerminal("s1", "ap1", "top", { timeoutMs: 60_000 });
    await vi.advanceTimersByTimeAsync(0);

    entry.term.buffer.active.type = "alternate";
    emit({ type: "bufferChange", buffer: "alternate" });
    expect(writes()).toContain("\x03");

    entry.term.buffer.active.type = "normal";
    await vi.advanceTimersByTimeAsync(1_500);

    const outcome = await promise;
    expect(outcome.exitCode).toBeNull();
    expect(outcome.error).toBe("interrupted");
    expect(outcome.note).toContain("no completion signal arrived within one second");
  });

  it("escalates to q and :q! while the alternate screen holds, then gives up", async () => {
    vi.useFakeTimers();
    entry = makeEntry(["$ "]);
    const promise = runInTerminal("s1", "ap1", "less /var/log/syslog", { timeoutMs: 60_000 });
    await vi.advanceTimersByTimeAsync(0);

    entry.term.buffer.active.type = "alternate";
    emit({ type: "bufferChange", buffer: "alternate" });

    await vi.advanceTimersByTimeAsync(500);
    expect(writes()).toContain("q");
    await vi.advanceTimersByTimeAsync(500);
    expect(writes()).toContain("\x1b:q!\r");
    await vi.advanceTimersByTimeAsync(500);

    const outcome = await promise;
    expect(outcome.error).toBe("interrupt_failed");
    expect(outcome.note).toContain("full-screen program");
  });

  // A password prompt is the user's to answer, so it must neither be interrupted
  // nor allowed to burn the command's budget.
  it("pauses the deadline for a password prompt and never interrupts it", async () => {
    vi.useFakeTimers();
    entry = makeEntry(["$ ", "[sudo] password for maholick:"]);
    const promise = runInTerminal("s1", "ap1", "sudo aide --init", { timeoutMs: 3_000 });
    await vi.advanceTimersByTimeAsync(0);
    // The shell reports the command starting, as it does for a real sudo.
    emit({ type: "blockStart", blockId: "b1", command: typed("sudo aide --init") });
    const before = ptyWrite.mock.calls.length;

    // Twice the timeout in wall-clock terms — but all of it belongs to the user.
    await vi.advanceTimersByTimeAsync(6_000);
    expect(ptyWrite.mock.calls.length).toBe(before);
    expect(writes()).not.toContain("\x03");

    // Still pending, not timed out.
    let settled = false;
    void promise.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
  });

  it("settles a password-paused command before the backend watchdog", async () => {
    vi.useFakeTimers();
    entry = makeEntry(["$ ", "[sudo] password for maholick:"]);
    const promise = runInTerminal("s1", "ap1", "sudo aide --init", { timeoutMs: 1_000 });
    await vi.advanceTimersByTimeAsync(0);
    emit({ type: "blockStart", blockId: "b1", command: typed("sudo aide --init") });

    await vi.advanceTimersByTimeAsync(16_001);
    const outcome = await promise;
    expect(outcome.error).toBe("timeout");
    expect(outcome.exitCode).toBeNull();
    expect(writes()).not.toContain("\x03");
  });

  // The guardrail for the whole design: `aide --init` prints nothing for ten
  // minutes, so idleness may inform the user but must never act.
  it("publishes an idle stall without touching the terminal", async () => {
    vi.useFakeTimers();
    entry = makeEntry(["$ ", "partial"]);
    // Output arrived just now, so the command is not idle YET — the threshold is
    // what this test is about.
    entry.lastDataAt = Date.now();
    useAppStore.getState().beginCommand("s1", "ap1", "aide --init");
    const promise = runInTerminal("s1", "ap1", "aide --init", { timeoutMs: 300_000 });
    await vi.advanceTimersByTimeAsync(0);
    emit({ type: "blockStart", blockId: "b1", command: typed("aide --init") });
    const before = ptyWrite.mock.calls.length;

    await vi.advanceTimersByTimeAsync(10_000);
    expect(
      useAppStore.getState().aiStreams.s1?.messages.find((m) => m.id === "cmd-ap1")?.command?.stall,
    ).toBeUndefined();

    await vi.advanceTimersByTimeAsync(21_000);
    const card = useAppStore
      .getState()
      .aiStreams.s1?.messages.find((m) => m.id === "cmd-ap1")?.command;
    expect(card?.stall).toBe("idle");
    expect(card?.status).toBe("running");
    expect(ptyWrite.mock.calls.length).toBe(before);

    abortSession("s1");
    await promise;
  });

  it("binds a manual interrupt to its approval and applies it idempotently", async () => {
    vi.useFakeTimers();
    entry = makeEntry(["$ ", "no output yet", "$ "]);
    const promise = runInTerminal("s1", "ap1", "aide --init", { timeoutMs: 60_000 });
    await vi.advanceTimersByTimeAsync(0);
    emit({ type: "blockStart", blockId: "b1", command: typed("aide --init") });

    expect(interruptJob("s1", "different-approval")).toBe(false);
    expect(writes()).not.toContain("\x03");
    expect(interruptJob("s1", "ap1")).toBe(true);
    expect(interruptJob("s1", "ap1")).toBe(true);
    expect(writes().filter((value) => value === "\x03")).toHaveLength(1);
    expect(writes()).not.toContain("q");
    expect(writes()).not.toContain("\x1b:q!\r");

    entry.blockMarkers.set("b1", {
      start: { line: 1, isDisposed: false },
      end: { line: 2, isDisposed: false },
    });
    emit({ type: "blockEnd", blockId: "b1", exitCode: 130, endLine: 2 });

    const outcome = await promise;
    expect(outcome.exitCode).toBe(130);
    expect(outcome.error).toBe("interrupted");
    expect(outcome.note).toContain("shell confirmed command completion");
  });

  it("settles a delivered manual interrupt after a one-second grace without confirmation", async () => {
    vi.useFakeTimers();
    entry = makeEntry(["$ ", "partial"]);
    const promise = runInTerminal("s1", "ap1", "aide --init", { timeoutMs: 60_000 });
    await vi.advanceTimersByTimeAsync(0);

    expect(interruptJob("s1", "ap1")).toBe(true);
    await vi.advanceTimersByTimeAsync(1_100);

    const outcome = await promise;
    expect(outcome.exitCode).toBeNull();
    expect(outcome.error).toBe("interrupted");
    expect(outcome.note).toContain("no completion signal arrived within one second");
    expect(writes().filter((value) => value === "\x03")).toHaveLength(1);
  });

  it("starts the completion grace only after the SIGINT write is confirmed", async () => {
    vi.useFakeTimers();
    entry = makeEntry(["$ ", "partial"]);
    const promise = runInTerminal("s1", "ap1", "aide --init", { timeoutMs: 60_000 });
    await vi.advanceTimersByTimeAsync(0);

    let confirmWrite!: () => void;
    ptyWrite.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          confirmWrite = resolve;
        }),
    );
    expect(interruptJob("s1", "ap1")).toBe(true);

    await vi.advanceTimersByTimeAsync(500);
    confirmWrite();
    await vi.advanceTimersByTimeAsync(900);
    let settled = false;
    void promise.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(101);
    const outcome = await promise;
    expect(outcome.error).toBe("interrupted");
    expect(outcome.exitCode).toBeNull();
  });

  it("buffers authoritative completion until SIGINT delivery is confirmed", async () => {
    vi.useFakeTimers();
    entry = makeEntry(["$ ", "partial", "$ "]);
    const promise = runInTerminal("s1", "ap1", "aide --init", { timeoutMs: 60_000 });
    await vi.advanceTimersByTimeAsync(0);
    emit({ type: "blockStart", blockId: "b1", command: typed("aide --init") });

    let confirmWrite!: () => void;
    ptyWrite.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          confirmWrite = resolve;
        }),
    );
    expect(interruptJob("s1", "ap1")).toBe(true);
    entry.blockMarkers.set("b1", {
      start: { line: 1, isDisposed: false },
      end: { line: 2, isDisposed: false },
    });
    emit({ type: "blockEnd", blockId: "b1", exitCode: 130, endLine: 2 });

    let settled = false;
    void promise.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(500);
    expect(settled).toBe(false);

    confirmWrite();
    const outcome = await promise;
    expect(outcome.error).toBe("interrupted");
    expect(outcome.exitCode).toBe(130);
    expect(writes().filter((value) => value === "\x03")).toHaveLength(1);
  });

  it("reports interrupt_failed when SIGINT delivery never settles", async () => {
    vi.useFakeTimers();
    entry = makeEntry(["$ ", "partial"]);
    const promise = runInTerminal("s1", "ap1", "aide --init", { timeoutMs: 60_000 });
    await vi.advanceTimersByTimeAsync(0);
    ptyWrite.mockImplementationOnce(() => new Promise<void>(() => {}));

    expect(interruptJob("s1", "ap1")).toBe(true);
    await vi.advanceTimersByTimeAsync(1_001);

    const outcome = await promise;
    expect(outcome.error).toBe("interrupt_failed");
    expect(outcome.exitCode).toBeNull();
    expect(outcome.note).toContain("could not confirm that SIGINT was written");
  });

  it("does not promote buffered completion when SIGINT delivery is rejected", async () => {
    vi.useFakeTimers();
    entry = makeEntry(["$ ", "partial", "$ "]);
    const promise = runInTerminal("s1", "ap1", "aide --init", { timeoutMs: 60_000 });
    await vi.advanceTimersByTimeAsync(0);
    emit({ type: "blockStart", blockId: "b1", command: typed("aide --init") });

    let rejectWrite!: (error: Error) => void;
    ptyWrite.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectWrite = reject;
        }),
    );
    expect(interruptJob("s1", "ap1")).toBe(true);
    entry.blockMarkers.set("b1", {
      start: { line: 1, isDisposed: false },
      end: { line: 2, isDisposed: false },
    });
    emit({ type: "blockEnd", blockId: "b1", exitCode: 130, endLine: 2 });
    rejectWrite(new Error("PTY closed"));

    const outcome = await promise;
    expect(outcome.error).toBe("interrupt_failed");
    expect(outcome.exitCode).toBeNull();
  });

  it("reports interrupt_failed only when SIGINT cannot be delivered", async () => {
    entry = makeEntry(["$ ", "partial"]);
    const promise = runInTerminal("s1", "ap1", "aide --init", { timeoutMs: 60_000 });
    await flush();
    ptyWrite.mockRejectedValueOnce(new Error("PTY closed"));

    expect(interruptJob("s1", "ap1")).toBe(true);
    const outcome = await promise;
    expect(outcome.exitCode).toBeNull();
    expect(outcome.error).toBe("interrupt_failed");
    expect(outcome.note).toContain("could not confirm that SIGINT was written");
  });
});

describe("runInTerminal — remote session", () => {
  const probeNonce = (write: string): string => {
    const nonce = /6973;RP;([a-f0-9]{32});/.exec(write)?.[1];
    expect(nonce).toHaveLength(32);
    return nonce!;
  };

  const commandNonce = (write: string): string => {
    const nonce = /RD;%s;([a-f0-9]{32})\\007/.exec(write)?.[1];
    expect(nonce).toHaveLength(32);
    return nonce!;
  };

  beforeEach(() => {
    useAppStore.getState().updateSessionUi("s1", {
      remote: { kind: "ssh", target: "prod-01" },
    });
  });

  it("reserves the terminal while remote preflight is still probing", async () => {
    entry = makeEntry(["$ ", "out", "$ "]);
    const first = runInTerminal("s1", "ap1", "id", { timeoutMs: 60_000 });
    const second = await runInTerminal("s1", "ap2", "whoami", { timeoutMs: 60_000 });

    expect(second.error).toBe("terminal_busy");
    await flush();
    expect(ptyWrite).toHaveBeenCalledTimes(1);
    const probe = probeNonce(ptyWrite.mock.calls[0][1]);
    emit({ type: "osc", payload: `RP;${probe};z5.9;b;f` });
    await flush();
    const nonce = commandNonce(ptyWrite.mock.calls[1][1]);
    emit({ type: "osc", payload: `RD;0;${nonce}` });

    expect((await first).exitCode).toBe(0);
    expect(ptyWrite).toHaveBeenCalledTimes(2);
  });

  it("never dispatches after the approved remote identity changes", async () => {
    entry = makeEntry(["remote$ "]);
    const promise = runInTerminal("s1", "ap1", "hostname", { timeoutMs: 60_000 });
    await flush();
    const probe = probeNonce(ptyWrite.mock.calls[0][1]);

    useAppStore.getState().updateSessionUi("s1", {
      remote: { kind: "ssh", target: "prod-02" },
    });
    emit({ type: "osc", payload: `RP;${probe};z5.9;b;f` });

    const outcome = await promise;
    expect(outcome.error).toBe("target_changed");
    expect(ptyWrite).toHaveBeenCalledTimes(1);
    expect(ptyWrite.mock.calls[0][1]).toContain("6973;RP");
  });

  it("requires the matching fresh probe and a quiet redrawn prompt", async () => {
    vi.useFakeTimers();
    entry = makeEntry(["$ ", "remote-out", "$ "]);
    const promise = runInTerminal("s1", "ap1", "uname -a", { timeoutMs: 60_000 });

    await vi.advanceTimersByTimeAsync(0);
    expect(ptyWrite).toHaveBeenCalledTimes(1);
    const probe = probeNonce(ptyWrite.mock.calls[0][1]);

    // A delayed reply from a previous command is not authority for this probe.
    emit({ type: "osc", payload: `RP;${"0".repeat(32)};z5.9;b;f` });
    await vi.advanceTimersByTimeAsync(0);
    expect(ptyWrite).toHaveBeenCalledTimes(1);

    // The matching RP is printed before the shell redraws its prompt. Model the
    // data timestamp and prove that the command waits for another quiet period.
    entry.lastDataAt = Date.now();
    emit({ type: "osc", payload: `RP;${probe};z5.9;b;f` });
    await vi.advanceTimersByTimeAsync(500);
    expect(ptyWrite).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(200);

    const written = ptyWrite.mock.calls[1][1];
    expect(written).toContain(`${typed("uname -a")}; printf`);
    const nonce = commandNonce(written);
    expect(nonce).not.toBe(probe);

    emit({ type: "osc", payload: `RD;0;${"0".repeat(32)}` });
    emit({ type: "osc", payload: `RD;3;${nonce}` });
    const outcome = await promise;
    expect(outcome.exitCode).toBe(3);
    expect(outcome.mode).toBe("sentinel");
  });

  it("uses a fresh probe and command nonce for every remote command", async () => {
    entry = makeEntry(["$ ", "out", "$ "]);

    const first = runInTerminal("s1", "ap1", "id", { timeoutMs: 60_000 });
    await flush();
    const firstProbe = probeNonce(ptyWrite.mock.calls[0][1]);
    emit({ type: "osc", payload: `RP;${firstProbe};z5.9;b;f` });
    await flush();
    const firstCommand = commandNonce(ptyWrite.mock.calls[1][1]);
    emit({ type: "osc", payload: `RD;0;${firstCommand}` });
    await first;

    const second = runInTerminal("s1", "ap2", "whoami", { timeoutMs: 60_000 });
    await flush();
    const secondProbe = probeNonce(ptyWrite.mock.calls[2][1]);
    expect(secondProbe).not.toBe(firstProbe);
    emit({ type: "osc", payload: `RP;${secondProbe};z;b5.2;f` });
    await flush();
    const secondCommand = commandNonce(ptyWrite.mock.calls[3][1]);
    expect(secondCommand).not.toBe(firstCommand);
    expect(secondCommand).not.toBe(secondProbe);
    emit({ type: "osc", payload: `RD;0;${secondCommand}` });
    await second;

    // There is no hook install and no session-level mode cache: two commands
    // produce exactly probe, command, probe, command.
    expect(ptyWrite).toHaveBeenCalledTimes(4);
  });

  it("rejects sentinel-unsafe syntax before claiming a lease or writing a probe", async () => {
    entry = makeEntry(["remote$ "]);
    const beforeWrite = vi.fn(() => true);
    for (const command of [
      "echo done # hides suffix",
      "echo `unterminated",
      "echo done;",
      "sleep 1 &",
      "sleep 1 &>/dev/null",
      "true &&",
      "false ||",
      "printf x |",
      "echo $(date",
      "echo ${HOME",
      "if true; then echo ok",
      "case x in",
      "[[ -n value",
    ]) {
      const outcome = await runInTerminal("s1", "ap1", command, {
        timeoutMs: 60_000,
        nonceCompletion: true,
        beforeWrite,
      });
      expect(outcome.error).toBe("unsafe_command");
    }
    expect(beforeWrite).not.toHaveBeenCalled();
    expect(ptyWrite).not.toHaveBeenCalled();
  });

  it("uses fish grouping for a private command in a remote fish shell", async () => {
    entry = makeEntry(["$ ", "private bytes", "$ "]);
    const promise = runInTerminal("s1", "private-fish", "set -gx GENERATED opaque", {
      timeoutMs: 60_000,
      outputPolicy: "private",
    });

    await flush();
    const probe = probeNonce(ptyWrite.mock.calls[0][1]);
    emit({ type: "osc", payload: `RP;${probe};z;b;f3.7` });
    await flush();

    const written = ptyWrite.mock.calls[1][1];
    expect(written).toContain("begin; eval 'set -gx GENERATED opaque < /dev/null'");
    expect(written).toContain("end >/dev/null 2>/dev/null");
    expect(written).toContain("$status");
    const nonce = commandNonce(written);
    emit({ type: "osc", payload: `RD;0;${nonce}` });

    const outcome = await promise;
    expect(outcome.output).toBe("");
    expect(outcome.note).toBe("[private output suppressed]");
  });

  it("refuses to run at all when nothing answers the probe", async () => {
    vi.useFakeTimers();
    entry = makeEntry(["some pager output"]);
    const promise = runInTerminal("s1", "ap1", "echo hi", { timeoutMs: 60_000 });
    await vi.advanceTimersByTimeAsync(3000);

    const outcome = await promise;
    expect(outcome.error).toBe("not_a_shell");
    // Only the probe was written, never the command.
    expect(ptyWrite).toHaveBeenCalledTimes(1);
    expect(ptyWrite.mock.calls[0][1]).toContain("6973;RP");
  });
});
