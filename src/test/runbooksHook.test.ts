import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  submitTerminal: vi.fn(async () => {}),
  runInTerminal: vi.fn(),
  list: vi.fn(),
  getDefinition: vi.fn(),
  removeSource: vi.fn(),
  exportPackage: vi.fn(),
  restoreBuiltins: vi.fn(),
  history: vi.fn(),
  get: vi.fn(),
  report: vi.fn(),
  deleteRun: vi.fn(),
  claimTerminal: vi.fn(),
  respondApproval: vi.fn(),
  capturePrompt: vi.fn(),
  awaitPrompt: vi.fn(),
  abortSession: vi.fn(),
  interruptJob: vi.fn(),
  cancel: vi.fn(),
  waitForTerminal: vi.fn(),
}));

vi.mock("../lib/runbooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/runbooks")>();
  return {
    ...actual,
    runbooksStart: mocks.start,
    runbooksSubmitTerminalResult: mocks.submitTerminal,
    runbooksList: mocks.list,
    runbooksGetDefinition: mocks.getDefinition,
    runbooksRemove: mocks.removeSource,
    runbooksExportPackage: mocks.exportPackage,
    runbooksRestoreBuiltins: mocks.restoreBuiltins,
    runbooksHistory: mocks.history,
    runbooksGet: mocks.get,
    runbooksReport: mocks.report,
    runbooksDelete: mocks.deleteRun,
    runbooksClaimTerminalDispatch: mocks.claimTerminal,
    runbooksRespondApproval: mocks.respondApproval,
    runbooksCancel: mocks.cancel,
    runbooksWaitForTerminal: mocks.waitForTerminal,
  };
});

vi.mock("../lib/ptyExec", () => ({
  abortSession: mocks.abortSession,
  awaitApprovalPromptBinding: mocks.awaitPrompt,
  captureApprovalPromptBinding: mocks.capturePrompt,
  interruptJob: mocks.interruptJob,
  releaseApprovalPromptBinding: vi.fn(),
  runInTerminal: mocks.runInTerminal,
}));

import { useRunbooks } from "../hooks/useRunbooks";
import { emptySessionUi, useAppStore } from "../stores/appStore";
import { useRunbookStore } from "../stores/runbookStore";
import {
  isRunbookTerminalProtected,
  resetRunbookTerminalPrivacyForTests,
} from "../lib/runbookTerminalPrivacy";
import {
  listLiveRunbookPtyJobs,
  resetRunbookLiveJobsForTests,
} from "../lib/runbookLiveJobs";
import type {
  RunbookDeleteResult,
  RunbookEvent,
  RunbookDefinition,
  RunbookHistoryEntry,
  RunbookRun,
  RunbookSource,
  RunbookStartRequest,
  RunbookRunState,
} from "../lib/runbooks";

function historyEntry(
  runId: string,
  state: RunbookRunState,
  startedAt: string,
): RunbookHistoryEntry {
  return {
    run_id: runId,
    source_id: "source-1",
    definition_id: "baseline",
    definition_version: "1.0.0",
    definition_title: "Baseline",
    state,
    target_label: "session-1",
    started_at: startedAt,
    finished_at: null,
    duration_ms: null,
    checked_steps: 0,
    total_steps: 1,
  };
}

function source(
  sourceId: string,
  sourceKind: RunbookSource["source_kind"] = "user",
  state: RunbookSource["state"] = "valid",
): RunbookSource {
  return {
    source_id: sourceId,
    source_kind: sourceKind,
    package_path: `/runbooks/${sourceId}`,
    definition_id: sourceId,
    version: "1.0.0",
    title: sourceId,
    digest_sha256: `${sourceId}-digest`,
    state,
    validation_issues: [],
    imported_at: "2026-08-13T12:00:00Z",
    refreshed_at: "2026-08-13T12:00:00Z",
  };
}

function definition(id: string): RunbookDefinition {
  return {
    kind: "Runbook",
    metadata: { id, version: "1.0.0", title: id },
    spec: {
      target: { kind: "active-terminal" },
      steps: [
        {
          id: "one",
          title: "One",
          required: true,
          check: { uses: "manual", instructions: "Check" },
        },
      ],
    },
  };
}

function run(runId: string, status: RunbookRunState): RunbookRun {
  return {
    run_id: runId,
    status,
    target: {
      kind: "active-terminal",
      session_id: "session-1",
      observed_at: "2026-08-13T12:00:00Z",
    },
    active_step_id: "one",
    active_phase: "check",
    pending_approval_id: null,
    pause_reason: status === "interrupted" ? "Application restarted" : null,
    steps: [
      { id: "one", status: status === "interrupted" ? "unknown" : "checking" },
    ],
  };
}

function waitingApprovalRun(
  runId: string,
  approvalId: string,
  command: string,
  overrides: Partial<RunbookRun> = {},
): RunbookRun {
  return {
    ...run(runId, "waiting_approval"),
    active_step_id: "one",
    active_phase: "check",
    pending_approval_id: approvalId,
    pending_approval: {
      approval_id: approvalId,
      run_id: runId,
      step_id: "one",
      phase: "check",
      command,
      explanation: "Runbook approval",
      classification: {
        read_only: false,
        network: false,
        privileged: false,
        opaque: true,
      },
    },
    ...overrides,
  };
}

function approvalEvent(
  runId: string,
  approvalId: string,
  command: string,
): RunbookEvent {
  return {
    type: "ApprovalRequested",
    run_id: runId,
    approval_id: approvalId,
    step_id: "one",
    phase: "check",
    command,
    explanation: "Test shell approval",
    classification: {
      read_only: false,
      network: false,
      privileged: false,
      opaque: true,
    },
  };
}

function terminalEvent(
  runId: string,
  attemptId: string,
  approvalId: string,
  command: string,
): RunbookEvent {
  return {
    type: "RunInTerminal",
    run_id: runId,
    attempt_id: attemptId,
    approval_id: approvalId,
    session_id: "session-1",
    command,
    timeout_ms: 1_000,
    environment: {},
  };
}

beforeEach(() => {
  resetRunbookTerminalPrivacyForTests();
  resetRunbookLiveJobsForTests();
  mocks.start.mockReset();
  mocks.submitTerminal.mockClear();
  mocks.runInTerminal.mockReset();
  mocks.list.mockReset();
  mocks.getDefinition.mockReset();
  mocks.removeSource.mockReset();
  mocks.exportPackage.mockReset();
  mocks.restoreBuiltins.mockReset();
  mocks.history.mockReset();
  mocks.get.mockReset();
  mocks.report.mockReset();
  mocks.deleteRun.mockReset();
  mocks.claimTerminal.mockReset();
  mocks.respondApproval.mockReset();
  mocks.capturePrompt.mockReset();
  mocks.awaitPrompt.mockReset();
  mocks.abortSession.mockReset();
  mocks.interruptJob.mockReset();
  mocks.cancel.mockReset();
  mocks.waitForTerminal.mockReset();
  mocks.list.mockResolvedValue([]);
  mocks.getDefinition.mockImplementation(async (sourceId: string) =>
    definition(sourceId),
  );
  mocks.removeSource.mockResolvedValue(undefined);
  mocks.exportPackage.mockResolvedValue({
    destination: "/exports/runbook-example-v1.0.0",
    files: ["runbook.vrun.yaml"],
  });
  mocks.restoreBuiltins.mockResolvedValue([]);
  mocks.history.mockResolvedValue([]);
  mocks.runInTerminal.mockImplementation(
    async (_sessionId, _attemptId, _command, options) => {
      const authorized = await options.beforeWrite?.();
      return {
        exitCode: authorized === false ? null : 0,
        output: authorized === false ? "" : "full captured output",
        durationMs: 12,
        error: authorized === false ? "cancelled" : null,
        mode: "sentinel",
      };
    },
  );
  mocks.claimTerminal.mockResolvedValue(true);
  mocks.respondApproval.mockResolvedValue(undefined);
  mocks.capturePrompt.mockReturnValue("prompt-binding");
  mocks.awaitPrompt.mockResolvedValue("prompt-binding");
  mocks.cancel.mockResolvedValue(undefined);
  mocks.waitForTerminal.mockImplementation(async (runId: string) =>
    run(runId, "cancelled"),
  );
  useRunbookStore.getState().reset();
  useAppStore.setState({
    runbooksEnabled: true,
    activeSessionId: "session-1",
    sessions: [
      {
        id: "session-1",
        shell: "/bin/zsh",
        cwd: "/srv/app",
        createdAt: "2026-08-13T12:00:00Z",
        exited: false,
        exitCode: null,
        hostId: null,
        hostLabel: null,
        userTitle: null,
        aiTitle: null,
        ordinal: 1,
      },
    ],
    sessionUi: {
      "session-1": {
        ...emptySessionUi(),
        cwd: "/srv/app",
        host: "local-host",
      },
    },
  });
  useRunbookStore.getState().setDefinition({
    kind: "Runbook",
    metadata: { id: "baseline", version: "1.0.0", title: "Baseline" },
    spec: {
      target: { kind: "active-terminal" },
      steps: [
        {
          id: "one",
          title: "One",
          required: true,
          check: { uses: "manual", instructions: "Check" },
        },
      ],
    },
  });
});

describe("useRunbooks channel activation", () => {
  it("installs full evidence mode before flushing an early terminal event", async () => {
    let onEvent!: (event: RunbookEvent) => void;
    mocks.start.mockImplementation(
      async (
        request: RunbookStartRequest,
        handler: (event: RunbookEvent) => void,
      ) => {
        onEvent = handler;
        const run: RunbookRun = {
          run_id: "run-early",
          status: "running",
          target: request.target_context,
          active_step_id: "one",
          active_phase: "check",
          pending_approval_id: null,
          pause_reason: null,
          steps: [{ id: "one", status: "checking" }],
        };
        return run;
      },
    );

    const { result } = renderHook(() => useRunbooks());
    await act(async () => {
      await result.current.start("source-1", "session-1", {}, "full");
    });
    act(() => onEvent(approvalEvent("run-early", "approval-early", "sshd -T")));
    await act(async () => {
      await result.current.respondApproval(
        "run-early",
        "approval-early",
        true,
        "sshd -T",
      );
    });
    act(() =>
      onEvent(
        terminalEvent(
          "run-early",
          "attempt-early",
          "approval-early",
          "sshd -T",
        ),
      ),
    );

    await waitFor(() => expect(mocks.runInTerminal).toHaveBeenCalledTimes(1));
    expect(isRunbookTerminalProtected("session-1")).toBe(true);
    expect(mocks.runInTerminal).toHaveBeenCalledWith(
      "session-1",
      "attempt-early",
      "sshd -T",
      expect.objectContaining({ tailLimit: 1_048_576 }),
    );
    expect(useRunbookStore.getState().activeRun?.evidence_mode).toBe("full");
    await waitFor(() => expect(mocks.submitTerminal).toHaveBeenCalledTimes(1));
  });

  it("never types a replayed terminal event when Rust denies the dispatch lease", async () => {
    let onEvent!: (event: RunbookEvent) => void;
    mocks.claimTerminal.mockResolvedValue(false);
    mocks.start.mockImplementation(
      async (
        request: RunbookStartRequest,
        handler: (event: RunbookEvent) => void,
      ) => {
        onEvent = handler;
        const started = run("run-replayed", "running");
        started.target = request.target_context;
        return started;
      },
    );

    const { result } = renderHook(() => useRunbooks());
    await act(async () => {
      await result.current.start("source-1", "session-1", {}, "tail");
    });
    act(() =>
      onEvent(
        approvalEvent(
          "run-replayed",
          "approval-replayed",
          "touch /tmp/must-not-repeat",
        ),
      ),
    );
    await act(async () => {
      await result.current.respondApproval(
        "run-replayed",
        "approval-replayed",
        true,
        "touch /tmp/must-not-repeat",
      );
    });
    act(() =>
      onEvent(
        terminalEvent(
          "run-replayed",
          "attempt-already-claimed",
          "approval-replayed",
          "touch /tmp/must-not-repeat",
        ),
      ),
    );

    await waitFor(() => expect(mocks.claimTerminal).toHaveBeenCalledTimes(1));
    expect(mocks.runInTerminal).toHaveBeenCalledTimes(1);
    expect(mocks.submitTerminal).not.toHaveBeenCalled();
  });

  it("keeps the immutable target guard when live run state disappears before typing", async () => {
    let onEvent!: (event: RunbookEvent) => void;
    mocks.runInTerminal.mockImplementation(
      async (_sessionId, _attemptId, _command, options) => {
        expect(await options.beforeWrite()).toBe(true);
        // Model the webview/store recovery window after the event was accepted but
        // before ptyWrite. The target has also changed in place to a remote shell.
        useRunbookStore.getState().setActiveRun(null);
        useAppStore.setState((state) => ({
          sessionUi: {
            ...state.sessionUi,
            "session-1": {
              ...state.sessionUi["session-1"],
              remote: { kind: "ssh", target: "other.example" },
            },
          },
        }));
        expect(options.canWrite()).toBe(false);
        return {
          exitCode: null,
          output: "",
          outputTruncated: false,
          outputObservedBytes: 0,
          outputCapturedBytes: 0,
          durationMs: 1,
          error: "target_changed",
          mode: "sentinel",
        };
      },
    );
    mocks.start.mockImplementation(
      async (
        request: RunbookStartRequest,
        handler: (event: RunbookEvent) => void,
      ) => {
        onEvent = handler;
        const started = run("run-target-guard", "running");
        started.target = request.target_context;
        return started;
      },
    );

    const { result } = renderHook(() => useRunbooks());
    await act(async () => {
      await result.current.start("source-1", "session-1", {}, "tail");
    });
    act(() =>
      onEvent(
        approvalEvent("run-target-guard", "approval-target", "printf ok"),
      ),
    );
    await act(async () => {
      await result.current.respondApproval(
        "run-target-guard",
        "approval-target",
        true,
        "printf ok",
      );
    });
    act(() =>
      onEvent(
        terminalEvent(
          "run-target-guard",
          "attempt-target-guard",
          "approval-target",
          "printf ok",
        ),
      ),
    );

    await waitFor(() => expect(mocks.runInTerminal).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mocks.submitTerminal).toHaveBeenCalledTimes(1));
    expect(mocks.submitTerminal).toHaveBeenCalledWith(
      "run-target-guard",
      "attempt-target-guard",
      expect.objectContaining({ exit_code: null, error: "target_changed" }),
    );
  });

  it("revokes a delayed successful dispatch claim when cancellation wins before write", async () => {
    let onEvent!: (event: RunbookEvent) => void;
    let resolveClaim!: (claimed: boolean) => void;
    let markClaimStarted!: () => void;
    const claimStarted = new Promise<void>(
      (resolve) => (markClaimStarted = resolve),
    );
    mocks.claimTerminal.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolveClaim = resolve;
          markClaimStarted();
        }),
    );
    let simulatedWrites = 0;
    mocks.runInTerminal.mockImplementation(
      async (_sessionId, _attemptId, _command, options) => {
        const authorized = await options.beforeWrite();
        if (authorized && options.canWrite()) simulatedWrites += 1;
        return {
          exitCode: null,
          output: "",
          outputTruncated: false,
          outputObservedBytes: 0,
          outputCapturedBytes: 0,
          durationMs: 1,
          error: authorized ? "target_changed" : "cancelled",
          mode: "sentinel",
        };
      },
    );
    mocks.start.mockImplementation(
      async (
        request: RunbookStartRequest,
        handler: (event: RunbookEvent) => void,
      ) => {
        onEvent = handler;
        const started = run("run-cancel-race", "running");
        started.target = request.target_context;
        return started;
      },
    );

    const { result } = renderHook(() => useRunbooks());
    await act(async () => {
      await result.current.start("source-1", "session-1", {}, "tail");
    });
    act(() =>
      onEvent(
        approvalEvent(
          "run-cancel-race",
          "approval-cancel-race",
          "touch /tmp/must-not-run-after-cancel",
        ),
      ),
    );
    await act(async () => {
      await result.current.respondApproval(
        "run-cancel-race",
        "approval-cancel-race",
        true,
        "touch /tmp/must-not-run-after-cancel",
      );
    });
    act(() =>
      onEvent(
        terminalEvent(
          "run-cancel-race",
          "attempt-cancel-race",
          "approval-cancel-race",
          "touch /tmp/must-not-run-after-cancel",
        ),
      ),
    );
    await claimStarted;

    let cancellation!: Promise<void>;
    act(() => {
      cancellation = result.current.cancel("run-cancel-race");
    });
    resolveClaim(true);
    await act(async () => cancellation);

    await waitFor(() =>
      expect(mocks.cancel).toHaveBeenCalledWith("run-cancel-race"),
    );
    expect(simulatedWrites).toBe(0);
    expect(mocks.submitTerminal).not.toHaveBeenCalled();
  });

  it("cancels the exact live PTY job after its terminal event was evicted", async () => {
    let onEvent!: (event: RunbookEvent) => void;
    let settleTerminal!: (outcome: {
      exitCode: null;
      output: string;
      durationMs: number;
      error: "cancelled";
      mode: "sentinel";
    }) => void;
    mocks.runInTerminal.mockImplementation(
      () => new Promise((resolve) => (settleTerminal = resolve)),
    );
    mocks.start.mockImplementation(
      async (
        request: RunbookStartRequest,
        handler: (event: RunbookEvent) => void,
      ) => {
        onEvent = handler;
        const started = run("run-evicted", "running");
        started.target = request.target_context;
        return started;
      },
    );

    const { result } = renderHook(() => useRunbooks());
    await act(async () => {
      await result.current.start("source-1", "session-1", {}, "tail");
    });
    act(() =>
      onEvent(
        approvalEvent("run-evicted", "approval-evicted", "printf still-owned"),
      ),
    );
    await act(async () => {
      await result.current.respondApproval(
        "run-evicted",
        "approval-evicted",
        true,
        "printf still-owned",
      );
    });
    act(() =>
      onEvent(
        terminalEvent(
          "run-evicted",
          "attempt-evicted",
          "approval-evicted",
          "printf still-owned",
        ),
      ),
    );

    await waitFor(() => expect(mocks.runInTerminal).toHaveBeenCalledTimes(1));
    act(() => {
      for (let index = 0; index < 201; index += 1) {
        useRunbookStore.getState().dispatchEvent({
          type: "Error",
          message: `noise-${index}`,
          recoverable: true,
        });
      }
    });
    expect(useRunbookStore.getState().events).toHaveLength(200);
    expect(
      useRunbookStore
        .getState()
        .events.some(
          (event) =>
            event.type === "RunInTerminal" && event.run_id === "run-evicted",
        ),
    ).toBe(false);
    expect(listLiveRunbookPtyJobs("run-evicted")).toEqual([
      {
        runId: "run-evicted",
        attemptId: "attempt-evicted",
        sessionId: "session-1",
      },
    ]);

    await act(async () => {
      await result.current.cancel("run-evicted");
    });
    expect(mocks.interruptJob).toHaveBeenCalledWith(
      "session-1",
      "attempt-evicted",
    );
    expect(mocks.abortSession).toHaveBeenCalledWith(
      "session-1",
      "cancelled",
      "attempt-evicted",
    );

    await act(async () => {
      settleTerminal({
        exitCode: null,
        output: "",
        durationMs: 1,
        error: "cancelled",
        mode: "sentinel",
      });
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(listLiveRunbookPtyJobs("run-evicted")).toEqual([]),
    );
    expect(mocks.submitTerminal).not.toHaveBeenCalled();
  });
});

describe("useRunbooks recovery and deletion", () => {
  it("uses native-controller attestation without an editable command", async () => {
    const native = waitingApprovalRun(
      "run-ansible",
      "approval-ansible",
      "ansible-runner run /managed/project",
      {
        target: {
          kind: "ansible-inventory",
          source_id: "source-ansible",
          controller_path: "/usr/local/bin/ansible-runner",
          controller_version: "2.4.1",
          inventory_path: "/managed/project/inventory.ini",
          inventory_digest: "b".repeat(64),
          project_digest: "a".repeat(64),
          limit: "webservers",
          observed_at: "2026-08-13T12:00:00Z",
        },
      },
    );
    useRunbookStore.getState().setActiveRun(native);
    mocks.get.mockResolvedValue({
      ...native,
      status: "running" as const,
      pending_approval_id: null,
      pending_approval: null,
    });

    const { result } = renderHook(() => useRunbooks());
    await act(async () => {
      await result.current.respondApproval(
        "run-ansible",
        "approval-ansible",
        true,
        null,
      );
    });

    expect(mocks.respondApproval).toHaveBeenCalledWith(
      "run-ansible",
      "approval-ansible",
      true,
      null,
      "native_controller",
    );
  });

  it("rejects a supplied edit for a native Ansible approval", async () => {
    const native = waitingApprovalRun(
      "run-ansible",
      "approval-ansible",
      "ansible-runner run /managed/project",
      {
        target: {
          kind: "ansible-inventory",
          source_id: "source-ansible",
          controller_path: "/usr/local/bin/ansible-runner",
          controller_version: "2.4.1",
          inventory_path: null,
          inventory_digest: null,
          project_digest: "a".repeat(64),
          limit: null,
          observed_at: "2026-08-13T12:00:00Z",
        },
      },
    );
    useRunbookStore.getState().setActiveRun(native);

    const { result } = renderHook(() => useRunbooks());
    await act(async () => {
      await result.current.respondApproval(
        "run-ansible",
        "approval-ansible",
        true,
        "ansible-runner run /edited/project",
      );
    });

    expect(mocks.respondApproval).not.toHaveBeenCalled();
    expect(useRunbookStore.getState().error).toContain("cannot be edited");
  });

  it("performs one history request during empty initialization", async () => {
    const { result } = renderHook(() => useRunbooks());
    await act(async () => {
      await result.current.initialize();
    });

    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(mocks.history).toHaveBeenCalledTimes(1);
    expect(useRunbookStore.getState().history).toEqual([]);
    expect(useRunbookStore.getState().loadingHistory).toBe(false);
  });

  it("settles a failed history request until the caller explicitly retries", async () => {
    mocks.history.mockRejectedValue(new Error("history unavailable"));
    const { result } = renderHook(() => useRunbooks());

    await act(async () => {
      await result.current.loadHistory();
    });

    expect(mocks.history).toHaveBeenCalledTimes(1);
    expect(useRunbookStore.getState().loadingHistory).toBe(false);
    expect(useRunbookStore.getState().error).toContain("history unavailable");

    mocks.history.mockResolvedValue([]);
    await act(async () => {
      await result.current.loadHistory();
    });
    expect(mocks.history).toHaveBeenCalledTimes(2);
    expect(useRunbookStore.getState().error).toBeNull();
  });

  it("selects and loads the first valid source returned by the library", async () => {
    mocks.list.mockResolvedValue([
      source("invalid", "user", "invalid"),
      source("builtin-security", "builtin"),
      source("user-baseline"),
    ]);
    const { result } = renderHook(() => useRunbooks());

    await act(async () => {
      await result.current.loadLibrary();
    });

    expect(useRunbookStore.getState().selectedSourceId).toBe(
      "builtin-security",
    );
    expect(mocks.getDefinition).toHaveBeenCalledWith("builtin-security");
    expect(useRunbookStore.getState().definition?.metadata.id).toBe(
      "builtin-security",
    );
  });

  it("ignores an older library response after a newer refresh completes", async () => {
    let resolveFirst!: (value: RunbookSource[]) => void;
    let resolveSecond!: (value: RunbookSource[]) => void;
    const firstLibrary = new Promise<RunbookSource[]>((resolve) => {
      resolveFirst = resolve;
    });
    const secondLibrary = new Promise<RunbookSource[]>((resolve) => {
      resolveSecond = resolve;
    });
    mocks.list
      .mockImplementationOnce(() => firstLibrary)
      .mockImplementationOnce(() => secondLibrary);
    const { result } = renderHook(() => useRunbooks());

    let firstRequest!: Promise<void>;
    let secondRequest!: Promise<void>;
    act(() => {
      firstRequest = result.current.loadLibrary();
      secondRequest = result.current.loadLibrary();
    });
    await act(async () => {
      resolveSecond([source("newer")]);
      await secondRequest;
    });
    expect(
      useRunbookStore.getState().sources.map((item) => item.source_id),
    ).toEqual(["newer"]);
    expect(useRunbookStore.getState().selectedSourceId).toBe("newer");
    expect(useRunbookStore.getState().loadingLibrary).toBe(false);

    await act(async () => {
      resolveFirst([source("older")]);
      await firstRequest;
    });
    expect(
      useRunbookStore.getState().sources.map((item) => item.source_id),
    ).toEqual(["newer"]);
    expect(useRunbookStore.getState().selectedSourceId).toBe("newer");
    expect(useRunbookStore.getState().definition?.metadata.id).toBe("newer");
    expect(useRunbookStore.getState().loadingLibrary).toBe(false);
  });

  it("ignores an older definition response after a newer source is selected", async () => {
    let resolveFirst!: (value: RunbookDefinition) => void;
    let resolveSecond!: (value: RunbookDefinition) => void;
    const firstDefinition = new Promise<RunbookDefinition>((resolve) => {
      resolveFirst = resolve;
    });
    const secondDefinition = new Promise<RunbookDefinition>((resolve) => {
      resolveSecond = resolve;
    });
    mocks.getDefinition.mockImplementation((sourceId: string) =>
      sourceId === "first" ? firstDefinition : secondDefinition,
    );
    useRunbookStore.getState().setSources([source("first"), source("second")]);
    const { result } = renderHook(() => useRunbooks());

    let firstRequest!: Promise<void>;
    let secondRequest!: Promise<void>;
    act(() => {
      firstRequest = result.current.selectSource("first");
      secondRequest = result.current.selectSource("second");
    });
    await act(async () => {
      resolveSecond(definition("second"));
      await secondRequest;
    });
    expect(useRunbookStore.getState().selectedSourceId).toBe("second");
    expect(useRunbookStore.getState().definition?.metadata.id).toBe("second");
    expect(useRunbookStore.getState().loadingDefinition).toBe(false);

    await act(async () => {
      resolveFirst(definition("first"));
      await firstRequest;
    });
    expect(useRunbookStore.getState().selectedSourceId).toBe("second");
    expect(useRunbookStore.getState().definition?.metadata.id).toBe("second");
    expect(useRunbookStore.getState().loadingDefinition).toBe(false);
  });

  it("ignores an older definition error after a newer source has loaded", async () => {
    let rejectFirst!: (reason: Error) => void;
    const firstDefinition = new Promise<RunbookDefinition>(
      (_resolve, reject) => {
        rejectFirst = reject;
      },
    );
    mocks.getDefinition.mockImplementation((sourceId: string) =>
      sourceId === "first"
        ? firstDefinition
        : Promise.resolve(definition("second")),
    );
    useRunbookStore.getState().setSources([source("first"), source("second")]);
    const { result } = renderHook(() => useRunbooks());

    let firstRequest!: Promise<void>;
    await act(async () => {
      firstRequest = result.current.selectSource("first");
      await result.current.selectSource("second");
    });
    await act(async () => {
      rejectFirst(new Error("stale definition failure"));
      await firstRequest;
    });

    expect(useRunbookStore.getState().selectedSourceId).toBe("second");
    expect(useRunbookStore.getState().definition?.metadata.id).toBe("second");
    expect(useRunbookStore.getState().error).toBeNull();
    expect(useRunbookStore.getState().loadingDefinition).toBe(false);
  });

  it("restores examples, preserves backend ordering, and selects the first valid source", async () => {
    const restored = [
      source("builtin-security", "builtin"),
      source("user-baseline"),
    ];
    mocks.restoreBuiltins.mockResolvedValue(restored);
    const { result } = renderHook(() => useRunbooks());

    await act(async () => {
      await result.current.restoreBuiltins();
    });

    expect(mocks.restoreBuiltins).toHaveBeenCalledTimes(1);
    expect(useRunbookStore.getState().sources).toEqual(restored);
    expect(useRunbookStore.getState().selectedSourceId).toBe(
      "builtin-security",
    );
    expect(useRunbookStore.getState().notice).toBe(
      "Included runbook examples restored.",
    );
  });

  it("hides an included source, retains the explanatory notice, and selects a fallback", async () => {
    useRunbookStore
      .getState()
      .setSources([
        source("builtin-security", "builtin"),
        source("builtin-developer", "builtin"),
      ]);
    useRunbookStore.getState().selectSource("builtin-security");
    const { result } = renderHook(() => useRunbooks());

    await act(async () => {
      await result.current.removeSource("builtin-security");
    });

    expect(mocks.removeSource).toHaveBeenCalledWith("builtin-security");
    expect(
      useRunbookStore.getState().sources.map((item) => item.source_id),
    ).toEqual(["builtin-developer"]);
    expect(useRunbookStore.getState().selectedSourceId).toBe(
      "builtin-developer",
    );
    expect(useRunbookStore.getState().notice).toContain(
      "Included runbook hidden",
    );
  });

  it("exports a reusable package with source and destination feedback", async () => {
    const { result } = renderHook(() => useRunbooks());

    await act(async () => {
      await result.current.exportPackage("builtin-security", "/exports");
    });

    expect(mocks.exportPackage).toHaveBeenCalledWith(
      "builtin-security",
      "/exports",
    );
    expect(useRunbookStore.getState().notice).toContain(
      "/exports/runbook-example-v1.0.0",
    );
    expect(useRunbookStore.getState().busyAction).toBeNull();
  });

  it("auto-approves a later approval that arrives after a command ran", async () => {
    // The realistic sequence, and the one the old drain loop could not survive:
    // the engine leaves waiting_approval as soon as it is answered, runs the
    // command, and only then requests the next approval. The per-run event
    // channel is what carries the mode across that gap.
    const armed = waitingApprovalRun("run-auto", "approval-1", "printf one");
    useRunbookStore.getState().setActiveRun(armed);
    useAppStore.setState({ activeSessionId: "session-1" });
    mocks.get.mockResolvedValue({
      ...armed,
      status: "running" as const,
      pending_approval_id: null,
      pending_approval: null,
    });

    const { result } = renderHook(() => useRunbooks());
    await act(async () => {
      await result.current.approveAllPendingSteps("run-auto", "printf edited");
    });

    expect(mocks.respondApproval).toHaveBeenNthCalledWith(
      1,
      "run-auto",
      "approval-1",
      true,
      "printf edited",
      "acknowledged",
    );
    expect(useRunbookStore.getState().hasAutoApproveRun("run-auto")).toBe(true);

    // The run has moved on; the next approval arrives only as an event.
    await act(async () => {
      await result.current.handleRunbookEvent(
        approvalEvent("run-auto", "approval-2", "printf two"),
      );
    });

    expect(mocks.respondApproval).toHaveBeenNthCalledWith(
      2,
      "run-auto",
      "approval-2",
      true,
      null,
      "pre_authorized",
    );
    expect(useRunbookStore.getState().error).toBeNull();
    expect(useRunbookStore.getState().busyAction).toBeNull();
  });

  it("arms before releasing the visible approval so the next request cannot race it", async () => {
    const armed = waitingApprovalRun("run-race", "approval-1", "printf one");
    useRunbookStore.getState().setActiveRun(armed);
    useAppStore.setState({ activeSessionId: "session-1" });
    mocks.get.mockResolvedValue(armed);

    let releaseVisibleApproval!: () => void;
    mocks.respondApproval.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseVisibleApproval = resolve;
        }),
    );

    const { result } = renderHook(() => useRunbooks());
    let approveAll!: Promise<void>;
    act(() => {
      approveAll = result.current.approveAllPendingSteps(
        "run-race",
        "printf one",
      );
    });

    await waitFor(() => expect(mocks.respondApproval).toHaveBeenCalledTimes(1));
    expect(useRunbookStore.getState().hasAutoApproveRun("run-race")).toBe(true);
    expect(
      useRunbookStore
        .getState()
        .getAutoApproveRunState("run-race")
        ?.grantedApprovalIds,
    ).toContain("approval-1");

    await act(async () => {
      await result.current.handleRunbookEvent(
        approvalEvent("run-race", "approval-2", "printf two"),
      );
    });
    expect(mocks.respondApproval).toHaveBeenNthCalledWith(
      2,
      "run-race",
      "approval-2",
      true,
      null,
      "pre_authorized",
    );

    releaseVisibleApproval();
    await act(async () => {
      await approveAll;
    });
    expect(useRunbookStore.getState().hasAutoApproveRun("run-race")).toBe(true);
  });

  it("never approves the same approval twice when an event is replayed", async () => {
    const armed = waitingApprovalRun("run-dupe", "approval-1", "printf one");
    useRunbookStore.getState().setActiveRun(armed);
    useAppStore.setState({ activeSessionId: "session-1" });
    mocks.get.mockResolvedValue(armed);
    useRunbookStore.getState().setAutoApprove("run-dupe", true);

    const { result } = renderHook(() => useRunbooks());
    const event = approvalEvent("run-dupe", "approval-9", "printf nine");
    await act(async () => {
      await result.current.handleRunbookEvent(event);
      await result.current.handleRunbookEvent(event);
    });

    expect(mocks.respondApproval).toHaveBeenCalledTimes(1);
    expect(useRunbookStore.getState().error).toBeNull();
  });

  it("records an unseen model approval as pre-authorized", async () => {
    const armed = waitingApprovalRun("run-model-auto", "approval-1", "printf one");
    useRunbookStore.getState().setActiveRun(armed);
    useAppStore.setState({ activeSessionId: "session-1" });
    useRunbookStore.getState().setAutoApprove("run-model-auto", true);

    const { result } = renderHook(() => useRunbooks());
    await act(async () => {
      await result.current.handleRunbookEvent(
        approvalEvent(
          "run-model-auto",
          "approval-model",
          "model://configured-agent/check",
        ),
      );
    });

    expect(mocks.respondApproval).toHaveBeenCalledWith(
      "run-model-auto",
      "approval-model",
      true,
      null,
      "pre_authorized",
    );
  });

  it("stops auto-approve and says why when the bound terminal is not visible", async () => {
    const armed = waitingApprovalRun("run-hidden", "approval-1", "printf one");
    useRunbookStore.getState().setActiveRun(armed);
    mocks.get.mockResolvedValue(armed);
    useRunbookStore.getState().setAutoApprove("run-hidden", true);
    useAppStore.setState({ activeSessionId: "session-other" });

    const { result } = renderHook(() => useRunbooks());
    await act(async () => {
      await result.current.handleRunbookEvent(
        approvalEvent("run-hidden", "approval-2", "printf two"),
      );
    });

    expect(mocks.respondApproval).not.toHaveBeenCalled();
    expect(useRunbookStore.getState().hasAutoApproveRun("run-hidden")).toBe(false);
    expect(useRunbookStore.getState().error).toContain("bound terminal");
  });

  it("stops auto-approve when the terminal never reaches a quiet prompt", async () => {
    const armed = waitingApprovalRun("run-noisy", "approval-1", "printf one");
    useRunbookStore.getState().setActiveRun(armed);
    mocks.get.mockResolvedValue(armed);
    useRunbookStore.getState().setAutoApprove("run-noisy", true);
    useAppStore.setState({ activeSessionId: "session-1" });
    mocks.awaitPrompt.mockResolvedValue(null);

    const { result } = renderHook(() => useRunbooks());
    await act(async () => {
      await result.current.handleRunbookEvent(
        approvalEvent("run-noisy", "approval-2", "printf two"),
      );
    });

    expect(mocks.respondApproval).not.toHaveBeenCalled();
    expect(useRunbookStore.getState().hasAutoApproveRun("run-noisy")).toBe(false);
    expect(useRunbookStore.getState().error).toContain("quiet shell prompt");
  });

  it("stops auto-approve when the run needs an operator decision", async () => {
    const armed = waitingApprovalRun("run-pause", "approval-1", "printf one");
    useRunbookStore.getState().setActiveRun(armed);
    mocks.get.mockResolvedValue(armed);
    useRunbookStore.getState().setAutoApprove("run-pause", true);

    const { result } = renderHook(() => useRunbooks());
    await act(async () => {
      await result.current.handleRunbookEvent({
        type: "OperatorDecisionRequired",
        run_id: "run-pause",
        step_id: "one",
        reason: "human decision required",
        choices: ["retry", "skip", "waive", "stop"],
      } as never);
    });

    expect(useRunbookStore.getState().hasAutoApproveRun("run-pause")).toBe(false);
    expect(useRunbookStore.getState().error).toContain("operator decision");
  });

  it("a manual approval takes the wheel back from auto-approve", async () => {
    const armed = waitingApprovalRun("run-manual", "approval-1", "printf one");
    useRunbookStore.getState().setActiveRun(armed);
    mocks.get.mockResolvedValue(armed);
    useAppStore.setState({ activeSessionId: "session-1" });
    useRunbookStore.getState().setAutoApprove("run-manual", true);

    const { result } = renderHook(() => useRunbooks());
    await act(async () => {
      await result.current.respondApproval(
        "run-manual",
        "approval-1",
        true,
        "printf one",
      );
    });

    expect(useRunbookStore.getState().hasAutoApproveRun("run-manual")).toBe(false);
  });

  it("does not arm auto-approve when the visible approval is refused", async () => {
    const armed = waitingApprovalRun("run-refuse", "approval-1", "printf one");
    useRunbookStore.getState().setActiveRun(armed);
    mocks.get.mockResolvedValue(armed);
    useAppStore.setState({ activeSessionId: "session-1" });
    mocks.respondApproval.mockRejectedValueOnce(new Error("approval denied"));

    const { result } = renderHook(() => useRunbooks());
    await act(async () => {
      await result.current.approveAllPendingSteps("run-refuse", "printf one");
    });

    expect(useRunbookStore.getState().hasAutoApproveRun("run-refuse")).toBe(false);
    expect(useRunbookStore.getState().error).toContain("approval");
    expect(useRunbookStore.getState().busyAction).toBeNull();
  });


  it("hydrates the most recent nonterminal run during initialization", async () => {
    mocks.history.mockResolvedValue([
      historyEntry("run-done", "succeeded", "2026-08-13T12:03:00Z"),
      historyEntry("run-interrupted", "interrupted", "2026-08-13T12:02:00Z"),
      historyEntry("run-paused", "paused", "2026-08-13T12:01:00Z"),
    ]);
    mocks.get.mockResolvedValue(run("run-interrupted", "interrupted"));

    const { result } = renderHook(() => useRunbooks());
    await act(async () => {
      await result.current.initialize();
    });

    expect(mocks.get).toHaveBeenCalledWith("run-interrupted");
    expect(mocks.report).not.toHaveBeenCalled();
    expect(useRunbookStore.getState().activeRun?.run_id).toBe(
      "run-interrupted",
    );
    expect(useRunbookStore.getState().selectedHistoryRunId).toBe(
      "run-interrupted",
    );
    expect(useRunbookStore.getState().view).toBe("run");
  });

  it("opens an interrupted history entry in the live recovery view", async () => {
    useRunbookStore
      .getState()
      .setHistory([
        historyEntry("run-interrupted", "interrupted", "2026-08-13T12:02:00Z"),
      ]);
    mocks.get.mockResolvedValue(run("run-interrupted", "interrupted"));

    const { result } = renderHook(() => useRunbooks());
    await act(async () => {
      await result.current.openHistoryRun("run-interrupted");
    });

    expect(mocks.get).toHaveBeenCalledWith("run-interrupted");
    expect(mocks.report).not.toHaveBeenCalled();
    expect(useRunbookStore.getState().activeRun?.status).toBe("interrupted");
    expect(useRunbookStore.getState().view).toBe("run");
  });

  it("reports partial evidence cleanup and refreshes history after deletion", async () => {
    const entry = historyEntry("run-failed", "failed", "2026-08-13T12:02:00Z");
    const deletion: RunbookDeleteResult = {
      run_id: entry.run_id,
      database_deleted: false,
      evidence_cleanup: {
        expected: 3,
        deleted: 1,
        missing: 1,
        errors: ["artifact is locked"],
        complete: false,
      },
    };
    useRunbookStore.getState().setHistory([entry]);
    useRunbookStore.getState().selectHistoryRun(entry.run_id);
    useRunbookStore.getState().setActiveRun(run(entry.run_id, "failed"));
    mocks.deleteRun.mockResolvedValue(deletion);
    mocks.history.mockResolvedValue([entry]);

    const { result } = renderHook(() => useRunbooks());
    await act(async () => {
      await result.current.deleteRun(entry.run_id);
    });

    expect(mocks.deleteRun).toHaveBeenCalledWith(entry.run_id);
    expect(mocks.history).not.toHaveBeenCalled();
    expect(useRunbookStore.getState().history).toEqual([entry]);
    expect(useRunbookStore.getState().activeRun?.run_id).toBe(entry.run_id);
    expect(useRunbookStore.getState().selectedHistoryRunId).toBe(entry.run_id);
    expect(useRunbookStore.getState().error).toContain(
      "Evidence cleanup was incomplete",
    );
    expect(useRunbookStore.getState().error).toContain("1/3 removed");
  });
});
