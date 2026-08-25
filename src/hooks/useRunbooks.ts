import { useCallback } from "react";

import * as api from "../lib/runbooks";
import {
  abortSession,
  awaitApprovalPromptBinding,
  captureApprovalPromptBinding,
  interruptJob,
  releaseApprovalPromptBinding,
  runInTerminal,
} from "../lib/ptyExec";
import { protectRunbookTerminal } from "../lib/runbookTerminalPrivacy";
import {
  clearRunbookRunRevocation,
  isRunbookRunRevoked,
  registerLiveRunbookPtyJob,
  revokeRunbookRun,
  unregisterLiveRunbookPtyJob,
} from "../lib/runbookLiveJobs";
import { markScrollbackDirty } from "../lib/sessionPersistence";
import { useAppStore } from "../stores/appStore";
import { useRunbookStore } from "../stores/runbookStore";
import type {
  EvidenceMode,
  RunbookEvent,
  RunbookOperatorDecision,
  RunbookRun,
  RunbookSource,
  RunbookStartRequest,
  RunbookTargetContext,
} from "../lib/runbooks";

export function buildRunbookTargetContext(
  sessionId: string,
): RunbookTargetContext {
  const app = useAppStore.getState();
  const session = app.sessions.find((item) => item.id === sessionId);
  const ui = app.sessionUi[sessionId];
  if (!session || session.exited)
    throw new Error("The selected terminal is no longer available.");

  return {
    kind: "active-terminal",
    session_id: sessionId,
    shell: session.shell,
    // A nested shell makes the local cwd stale; never claim it describes the
    // remote target. This matches buildTerminalContext's safety rule.
    cwd: ui?.remote ? null : (ui?.cwd ?? session.cwd),
    remote_kind: ui?.remote?.kind ?? null,
    remote_target: ui?.remote?.target ?? null,
    context_marker: ui?.host ?? null,
    observed_at: new Date().toISOString(),
  };
}

export function describeRunbookTarget(
  context: RunbookTargetContext | null,
): string {
  if (!context) return "No terminal bound";
  if (context.remote_kind) {
    return context.remote_target
      ? `${context.remote_kind} ${context.remote_target}`
      : context.remote_kind;
  }
  return context.cwd ?? context.context_marker ?? "Local terminal";
}

function sameTarget(
  left: RunbookTargetContext,
  right: RunbookTargetContext,
): boolean {
  return (
    left.session_id === right.session_id &&
    (left.remote_kind !== null || left.cwd === right.cwd) &&
    left.context_marker === right.context_marker &&
    left.remote_kind === right.remote_kind &&
    left.remote_target === right.remote_target
  );
}

let definitionRequestSequence = 0;
let libraryRequestSequence = 0;
let sourceSelectionSequence = 0;
function getRunById(runId: string): RunbookRun | null {
  return useRunbookStore.getState().getRunById(runId);
}

/** Disarms run-level auto-approve and explains why. The reason is the operator's
 *  only account of a step they did not see, so it is never overwritten by a
 *  later, vaguer message. */
function disarmAutoApprove(runId: string, reason: string | null): void {
  const store = useRunbookStore.getState();
  const wasArmed = store.hasAutoApproveRun(runId);
  store.setAutoApprove(runId, false);
  if (wasArmed && reason) store.setError(reason);
}

function isAutoApproveArmed(runId: string): boolean {
  return useRunbookStore.getState().hasAutoApproveRun(runId);
}

function invalidCommandText(command: string): boolean {
  return (
    !command.trim() || command.length > 4_096 || /[\r\n\0]/.test(command)
  );
}

async function refreshRunById(runId: string): Promise<void> {
  try {
    useRunbookStore.getState().upsertRun(await api.runbooksGet(runId));
  } catch (error) {
    useRunbookStore.getState().setError(String(error));
  }
}

/** How the operator arrived at an approval. The distinction is durable — it
 *  decides the wording of the reason recorded in the report. */
type ApprovalAcknowledgement = api.RunbookApprovalAcknowledgement;

/** The one path to `runbooks_respond_approval`. The operator's click and an armed
 *  run's automatic response both come through here, so neither can skip the
 *  bound-terminal check or the prompt-binding capture. Returns the failure text
 *  instead of only writing it to the store, so an automatic caller can disarm
 *  with the specific reason rather than a later, vaguer one. */
async function submitApproval(args: {
  runId: string;
  approval: api.RunbookApprovalRequest;
  approved: boolean;
  command: string | null;
  acknowledgement: ApprovalAcknowledgement;
  busyAction: string;
  clearBusy?: boolean;
}): Promise<{ ok: boolean; error: string | null }> {
  const {
    runId,
    approval,
    approved,
    command,
    acknowledgement,
    busyAction,
    clearBusy = true,
  } = args;
  const store = useRunbookStore.getState();
  const approvalId = approval.approval_id;
  const clear = () => {
    if (clearBusy && useRunbookStore.getState().busyAction === busyAction) {
      useRunbookStore.getState().setBusyAction(null);
    }
  };
  const fail = (message: string) => {
    store.setError(message);
    clear();
    return { ok: false, error: message };
  };

  const run = getRunById(runId);
  if (!run) return fail("The active run is no longer available.");
  if (approval.command.trim().length === 0) {
    return fail("Approval command content is empty.");
  }

  const modelInvocation = approval.command.startsWith(
    "model://configured-agent/",
  );
  let promptBinding: string | null = null;
  if (approved && !modelInvocation) {
    const sessionId = run.target.session_id;
    if (!sessionId || useAppStore.getState().activeSessionId !== sessionId) {
      return fail("Select the bound terminal before approving this action.");
    }
    // An operator clicks at an already-quiet prompt; auto-approve answers an
    // event fired while the shell is still painting one. Waiting on the click
    // path would be a regression, so only the automatic path waits.
    promptBinding =
      acknowledgement === "pre_authorized"
        ? await awaitApprovalPromptBinding(sessionId)
        : captureApprovalPromptBinding(sessionId);
    if (!promptBinding) {
      return fail(
        acknowledgement === "pre_authorized"
          ? "Auto-approve stopped: the bound terminal did not reach a stable, quiet shell prompt in time."
          : "The visible terminal is not in a stable normal-buffer prompt state.",
      );
    }
    // Up to several seconds can pass in the wait above. Re-check the two facts
    // that make this dispatch safe, and fail closed if either moved.
    const latestRun = getRunById(runId);
    if (
      useAppStore.getState().activeSessionId !== sessionId ||
      !latestRun ||
      latestRun.pending_approval?.approval_id !== approvalId
    ) {
      releaseApprovalPromptBinding(promptBinding);
      return fail(
        "The run or its bound terminal changed while the terminal was settling; nothing was approved.",
      );
    }
    approvalPromptBindings.set(approvalId, promptBinding);
  }

  store.setBusyAction(busyAction);
  try {
    await api.runbooksRespondApproval(
      runId,
      approvalId,
      approved,
      command,
      acknowledgement,
    );
    await refreshRunById(runId);
    clear();
    return { ok: true, error: null };
  } catch (error) {
    if (promptBinding) releaseApprovalPromptBinding(promptBinding);
    approvalPromptBindings.delete(approvalId);
    const message = String(error);
    store.setError(message);
    clear();
    return { ok: false, error: message };
  }
}

/** Reacts to `ApprovalRequested` on an armed run. This replaced a loop that
 *  polled the store after responding: the engine advances
 *  `WaitingApproval -> Running` asynchronously, so the poll saw either the old
 *  approval or a run that had already moved on, and the mode never survived a
 *  command execution. The per-run event channel lives for the whole run, so
 *  reacting to the event is what makes auto-approve span steps.
 *
 *  Reads the approval off the EVENT, not the store: `dispatchEvent` drops its
 *  optimistic mutation entirely when the run is not yet in `runsById`.
 *
 *  Fails closed — anything unsafe disarms the run and says why. */
async function autoApproveArmedApproval(
  event: Extract<RunbookEvent, { type: "ApprovalRequested" }>,
): Promise<void> {
  const runId = event.run_id;
  if (!isAutoApproveArmed(runId)) return;

  // The event buffer replays queued events on `activate()`, so the same
  // approval can arrive twice. Responding twice makes Rust answer "approval is
  // already approved", which would disarm a perfectly healthy run. The record
  // lives in the store so it is scoped to the run and cleared when it ends.
  const armed = useRunbookStore.getState().getAutoApproveRunState(runId);
  if (armed?.grantedApprovalIds.includes(event.approval_id)) return;
  useRunbookStore.getState().noteAutoApproved(runId, event.approval_id);

  const run = getRunById(runId);
  if (!run) {
    disarmAutoApprove(runId, "Auto-approve stopped: the run is unavailable.");
    return;
  }
  if (useAppStore.getState().activeSessionId !== run.target.session_id) {
    disarmAutoApprove(
      runId,
      "Auto-approve stopped: the bound terminal is no longer the visible one.",
    );
    return;
  }
  const modelInvocation = event.command.startsWith(
    "model://configured-agent/",
  );
  if (!modelInvocation && invalidCommandText(event.command)) {
    disarmAutoApprove(
      runId,
      "Auto-approve stopped: the proposed command is not a single line of at most 4,096 characters.",
    );
    return;
  }

  const result = await submitApproval({
    runId,
    approval: event,
    approved: true,
    // Nobody typed an edit for a step that was never displayed. A null command
    // preserves the proposed command while keeping that audit fact explicit.
    command: null,
    acknowledgement: "pre_authorized",
    busyAction: `approval:${event.approval_id}`,
  });
  if (!result.ok) {
    disarmAutoApprove(runId, result.error);
  }
}

function cancelDefinitionRequest(): void {
  definitionRequestSequence += 1;
  useRunbookStore.getState().setLoading("definition", false);
}

async function loadSelectedDefinition(sourceId: string): Promise<void> {
  const requestSequence = ++definitionRequestSequence;
  useRunbookStore.getState().setLoading("definition", true);
  try {
    const definition = await api.runbooksGetDefinition(sourceId);
    const current = useRunbookStore.getState();
    if (
      requestSequence === definitionRequestSequence &&
      current.selectedSourceId === sourceId
    ) {
      current.setDefinition(definition);
    }
  } catch (error) {
    const current = useRunbookStore.getState();
    if (
      requestSequence === definitionRequestSequence &&
      current.selectedSourceId === sourceId
    ) {
      current.setError(String(error));
    }
  } finally {
    const current = useRunbookStore.getState();
    if (
      requestSequence === definitionRequestSequence &&
      current.selectedSourceId === sourceId
    ) {
      current.setLoading("definition", false);
    }
  }
}

async function installLibrarySources(sources: RunbookSource[]): Promise<void> {
  const store = useRunbookStore.getState();
  const previousSourceId = store.selectedSourceId;
  const current = sources.find(
    (source) =>
      source.source_id === previousSourceId && source.state === "valid",
  );
  const selected =
    current ?? sources.find((source) => source.state === "valid") ?? null;
  store.setSources(sources);

  if (!selected) {
    sourceSelectionSequence += 1;
    store.selectSource(null);
    cancelDefinitionRequest();
    return;
  }
  if (selected.source_id === previousSourceId && store.definition) return;

  if (selected.source_id !== previousSourceId) {
    sourceSelectionSequence += 1;
    store.selectSource(selected.source_id);
  }
  await loadSelectedDefinition(selected.source_id);
}

const approvalPromptBindings = new Map<string, string>();

export function useRunbooks() {
  const refreshRun = useCallback(async (runId: string) => {
    try {
      useRunbookStore.getState().upsertRun(await api.runbooksGet(runId));
    } catch (error) {
      useRunbookStore.getState().setError(String(error));
    }
  }, []);

  const loadHistory = useCallback(async () => {
    const store = useRunbookStore.getState();
    store.setLoading("history", true);
    store.setError(null);
    try {
      const history = await api.runbooksHistory();
      store.setHistory(history);
      return history;
    } catch (error) {
      store.setError(String(error));
      return [];
    } finally {
      store.setLoading("history", false);
    }
  }, []);

  const loadReport = useCallback(async (runId: string) => {
    const store = useRunbookStore.getState();
    store.selectHistoryRun(runId);
    store.setLoading("report", true);
    try {
      store.setReport(await api.runbooksReport(runId));
    } catch (error) {
      store.setError(String(error));
    } finally {
      store.setLoading("report", false);
    }
  }, []);

  const openHistoryRun = useCallback(
    async (runId: string) => {
      const store = useRunbookStore.getState();
      const entry = store.history.find((run) => run.run_id === runId);
      if (!entry || api.isTerminalRunState(entry.state)) {
        await loadReport(runId);
        return;
      }

      store.setBusyAction(`open-run:${runId}`);
      store.setError(null);
      try {
        // History is a summary. Load the durable checklist before showing the
        // live recovery surface; interrupted runs need its target for rebind.
        const run = await api.runbooksGet(runId);
        if (api.isTerminalRunState(run.status)) {
          await loadReport(runId);
          return;
        }
        store.selectHistoryRun(runId);
        store.setActiveRun(run);
        store.setView("run");
      } catch (error) {
        store.setError(String(error));
      } finally {
        store.setBusyAction(null);
      }
    },
    [loadReport],
  );

  const executeTerminalEventBody = useCallback(
    async (event: Extract<RunbookEvent, { type: "RunInTerminal" }>) => {
      protectRunbookTerminal(event.session_id);
      // Schedule an immediate blank scrollback snapshot. The sticky protection
      // below also covers later metadata, quit and archive flushes, but this
      // proactively removes an older stored raw blob before Runbook output can
      // arrive.
      markScrollbackDirty(event.session_id);
      const app = useAppStore.getState();
      let targetError: string | null = null;
      let currentTarget: RunbookTargetContext | null = null;
      const approvalPromptBinding = event.approval_id
        ? (approvalPromptBindings.get(event.approval_id) ?? null)
        : null;
      if (event.approval_id) approvalPromptBindings.delete(event.approval_id);
      if (!app.runbooksEnabled) {
        targetError =
          "Runbooks were disabled before dispatch; execution was not started.";
      }
      try {
        currentTarget = buildRunbookTargetContext(event.session_id);
      } catch (error) {
        targetError = String(error);
      }

      const run = getRunById(event.run_id);
      const expectedTarget = run?.target ?? null;
      if (app.activeSessionId !== event.session_id) {
        targetError =
          "The bound terminal is no longer visible; execution was not started.";
      } else if (!expectedTarget) {
        targetError =
          "The durable run target is unavailable; execution was not started.";
      } else if (!event.approval_id || !approvalPromptBinding) {
        targetError =
          "The shell dispatch is not bound to a fresh operator prompt attestation.";
      } else if (currentTarget && !sameTarget(expectedTarget, currentTarget)) {
        targetError =
          "The terminal target changed since preflight; execution was not started.";
      }

      if (targetError || !expectedTarget) {
        if (approvalPromptBinding)
          releaseApprovalPromptBinding(approvalPromptBinding);
        try {
          // Settle a rejected preflight under the same one-shot ownership rule;
          // a duplicate event can never become executable later.
          if (
            !(await api.runbooksClaimTerminalDispatch(
              event.run_id,
              event.attempt_id,
            ))
          )
            return;
          await api.runbooksSubmitTerminalResult(
            event.run_id,
            event.attempt_id,
            {
              exit_code: null,
              output_tail: "",
              output_truncated: false,
              output_observed_bytes: 0,
              output_captured_bytes: 0,
              duration_ms: 0,
              error:
                targetError ??
                "The durable run target is unavailable; execution was not started.",
              execution_mode: null,
              target_context: currentTarget,
            },
          );
        } catch (error) {
          useRunbookStore.getState().setError(String(error));
        }
        return;
      }

      let dispatchClaimed = false;
      let claimAttempted = false;
      try {
        const outcome = await runInTerminal(
          event.session_id,
          event.attempt_id,
          event.command,
          {
            timeoutMs: event.timeout_ms,
            tailLimit: run?.evidence_mode === "full" ? 1_048_576 : 8_192,
            environment: event.environment,
            // Rust emits the exact pager/stdin/input wrapper persisted in the
            // canonical attempt record. Do not transform it a second time here.
            harden: false,
            // Integrated/hook OSC markers can be replayed by hostile command
            // output. Runbooks require a fresh per-attempt nonce in every shell.
            nonceCompletion: true,
            approvalPromptBinding: approvalPromptBinding ?? undefined,
            // Prompt/mode detection can wait for seconds. Acquire the Rust lease
            // only after that work, at the final async boundary before ptyWrite, so
            // cancellation and dispatch are linearized rather than racing a stale
            // early claim.
            beforeWrite: async () => {
              if (isRunbookRunRevoked(event.run_id)) return false;
              claimAttempted = true;
              const claimed = await api.runbooksClaimTerminalDispatch(
                event.run_id,
                event.attempt_id,
              );
              dispatchClaimed = claimed && !isRunbookRunRevoked(event.run_id);
              return dispatchClaimed;
            },
            canWrite: () => {
              const latest = useAppStore.getState();
              const latestRun = getRunById(event.run_id);
              if (
                isRunbookRunRevoked(event.run_id) ||
                !latest.runbooksEnabled ||
                latest.activeSessionId !== event.session_id ||
                !latestRun ||
                api.isTerminalRunState(latestRun.status) ||
                latestRun.status === "interrupted"
              )
                return false;
              try {
                const observed = buildRunbookTargetContext(event.session_id);
                return sameTarget(expectedTarget, observed);
              } catch {
                return false;
              }
            },
          },
        );
        if (!dispatchClaimed) {
          // Prompt rejection can happen before the normal beforeWrite lease
          // boundary (for example an expired approval-click binding). Claim only
          // to settle that attempt Unknown; never type it.
          if (claimAttempted || isRunbookRunRevoked(event.run_id)) return;
          dispatchClaimed = await api.runbooksClaimTerminalDispatch(
            event.run_id,
            event.attempt_id,
          );
          if (!dispatchClaimed) return;
        }
        let resultTarget: RunbookTargetContext | null = null;
        try {
          resultTarget = buildRunbookTargetContext(event.session_id);
        } catch {
          // A closed or replaced terminal is intentionally reported as an unknown
          // observation so Rust will not accept the exit code as authoritative.
        }
        await api.runbooksSubmitTerminalResult(event.run_id, event.attempt_id, {
          exit_code: outcome.exitCode,
          output_tail: outcome.output,
          output_truncated: outcome.outputTruncated ?? false,
          output_observed_bytes:
            outcome.outputObservedBytes ??
            new TextEncoder().encode(outcome.output).length,
          output_captured_bytes:
            outcome.outputCapturedBytes ??
            new TextEncoder().encode(outcome.output).length,
          duration_ms: outcome.durationMs,
          error: outcome.error ?? null,
          execution_mode: outcome.mode,
          target_context: resultTarget,
        });
      } catch (error) {
        useRunbookStore.getState().setError(String(error));
        // A result must never be submitted for a dispatch the backend did not
        // lease to this webview. The engine owns timeout/cancellation settlement.
        if (!dispatchClaimed) return;
        await api
          .runbooksSubmitTerminalResult(event.run_id, event.attempt_id, {
            exit_code: null,
            output_tail: "",
            output_truncated: false,
            output_observed_bytes: 0,
            output_captured_bytes: 0,
            duration_ms: 0,
            error: String(error),
            execution_mode: null,
            target_context: currentTarget,
          })
          .catch(() => {});
      }
    },
    [],
  );

  const executeTerminalEvent = useCallback(
    async (event: Extract<RunbookEvent, { type: "RunInTerminal" }>) => {
      // Register synchronously, before prompt probing, target inspection or
      // the dispatch claim. Cancellation never relies on the capped
      // presentation event list and therefore cannot lose ownership of a
      // long-running job.
      const liveJob = registerLiveRunbookPtyJob({
        runId: event.run_id,
        attemptId: event.attempt_id,
        sessionId: event.session_id,
      });
      try {
        await executeTerminalEventBody(event);
      } finally {
        unregisterLiveRunbookPtyJob(liveJob);
      }
    },
    [executeTerminalEventBody],
  );

  // Async so a test (and only a test) can await the work an arm kicks off. The
  // event channel passes this as a void callback and ignores the promise.
  const handleEvent = useCallback(
    async (event: RunbookEvent) => {
      const store = useRunbookStore.getState();
      store.dispatchEvent(event);

      switch (event.type) {
        case "RunInTerminal":
          void executeTerminalEvent(event);
          break;
        case "StepChanged":
          // The event gives the UI an immediate transition; the durable row is
          // authoritative for attempts, summaries and timestamps.
          void refreshRun(event.run_id);
          break;
        case "ReportReady":
          void loadReport(event.run_id);
          break;
        case "RunFinished":
          disarmAutoApprove(event.run_id, null);
          void refreshRun(event.run_id);
          void loadHistory();
          void loadReport(event.run_id);
          break;
        case "ApprovalRequested":
          await autoApproveArmedApproval(event);
          break;
        case "OperatorDecisionRequired":
          // A pause or a manual step is exactly the kind of judgement the
          // operator armed auto-approve to skip past, so it ends the mode.
          disarmAutoApprove(
            event.run_id,
            isAutoApproveArmed(event.run_id)
              ? "Auto-approve stopped: this run needs an operator decision."
              : null,
          );
          break;
        case "Error":
          if (event.run_id) disarmAutoApprove(event.run_id, null);
          break;
        case "RunStarted":
          break;
      }
    },
    [executeTerminalEvent, loadHistory, loadReport, refreshRun],
  );

  const loadLibrary = useCallback(async () => {
    const requestSequence = ++libraryRequestSequence;
    const store = useRunbookStore.getState();
    store.setLoading("library", true);
    store.setError(null);
    try {
      const sources = await api.runbooksList();
      if (requestSequence === libraryRequestSequence) {
        await installLibrarySources(sources);
      }
    } catch (error) {
      if (requestSequence === libraryRequestSequence) {
        useRunbookStore.getState().setError(String(error));
      }
    } finally {
      if (requestSequence === libraryRequestSequence) {
        useRunbookStore.getState().setLoading("library", false);
      }
    }
  }, []);

  const initialize = useCallback(async () => {
    const [, history] = await Promise.all([loadLibrary(), loadHistory()]);
    const store = useRunbookStore.getState();
    // Hydrate every nonterminal run, not only the selected one. Different PTY
    // sessions may execute concurrently and each event needs its immutable
    // target/evidence metadata even while another run is open in the workspace.
    const recoverable = history.filter(
      (run) => !api.isTerminalRunState(run.state),
    );
    if (recoverable.length === 0) return;
    try {
      const runs = await Promise.all(
        recoverable.map((entry) => api.runbooksGet(entry.run_id)),
      );
      for (const run of runs) {
        if (!api.isTerminalRunState(run.status)) store.upsertRun(run);
      }
      if (!store.activeRun || api.isTerminalRunState(store.activeRun.status)) {
        const selected = runs.find(
          (run) => !api.isTerminalRunState(run.status),
        );
        if (selected) {
          store.selectHistoryRun(selected.run_id);
          store.setActiveRun(selected);
          store.setView("run");
        }
      }
    } catch (error) {
      store.setError(String(error));
    }
  }, [loadHistory, loadLibrary]);

  const importPackage = useCallback(async (path: string) => {
    const store = useRunbookStore.getState();
    const selectionSequence = ++sourceSelectionSequence;
    store.setBusyAction("import");
    store.setError(null);
    try {
      const source = await api.runbooksImport(path);
      store.upsertSource(source);
      if (selectionSequence === sourceSelectionSequence) {
        useRunbookStore.getState().selectSource(source.source_id);
        if (source.state === "valid") {
          await loadSelectedDefinition(source.source_id);
        } else {
          cancelDefinitionRequest();
        }
      }
      if (selectionSequence === sourceSelectionSequence) {
        useRunbookStore
          .getState()
          .setNotice(
            source.state === "valid" ? "Runbook imported and validated." : null,
          );
      }
      return source;
    } catch (error) {
      if (selectionSequence === sourceSelectionSequence) {
        useRunbookStore.getState().setError(String(error));
      }
      return null;
    } finally {
      store.setBusyAction(null);
    }
  }, []);

  const selectSource = useCallback(async (sourceId: string) => {
    sourceSelectionSequence += 1;
    useRunbookStore.getState().selectSource(sourceId);
    await loadSelectedDefinition(sourceId);
  }, []);

  const refreshSource = useCallback(async (sourceId: string) => {
    const store = useRunbookStore.getState();
    const selectionSequence = sourceSelectionSequence;
    store.setBusyAction(`refresh:${sourceId}`);
    store.setError(null);
    try {
      const source = await api.runbooksRefresh(sourceId);
      store.upsertSource(source);
      const current = useRunbookStore.getState();
      if (current.selectedSourceId === sourceId) {
        if (source.state === "valid") {
          await loadSelectedDefinition(sourceId);
        } else {
          cancelDefinitionRequest();
          current.setDefinition(null);
        }
      }
      if (selectionSequence === sourceSelectionSequence) {
        useRunbookStore.getState().setNotice("Package refreshed from disk.");
      }
    } catch (error) {
      if (selectionSequence === sourceSelectionSequence) {
        useRunbookStore.getState().setError(String(error));
      }
    } finally {
      store.setBusyAction(null);
    }
  }, []);

  const removeSource = useCallback(async (sourceId: string) => {
    const store = useRunbookStore.getState();
    const source =
      store.sources.find((item) => item.source_id === sourceId) ?? null;
    store.setBusyAction(`remove:${sourceId}`);
    store.setError(null);
    store.setNotice(null);
    try {
      await api.runbooksRemove(sourceId);
      await installLibrarySources(
        useRunbookStore
          .getState()
          .sources.filter((item) => item.source_id !== sourceId),
      );
      store.setNotice(
        source?.source_kind === "builtin"
          ? "Included runbook hidden. Restore examples can add it back; historical runs were retained."
          : "Package registration removed. Historical runs were retained.",
      );
    } catch (error) {
      store.setError(String(error));
    } finally {
      store.setBusyAction(null);
    }
  }, []);

  const exportPackage = useCallback(
    async (sourceId: string, destination: string) => {
      const store = useRunbookStore.getState();
      store.setBusyAction(`export-package:${sourceId}`);
      store.setError(null);
      store.setNotice(null);
      try {
        const result = await api.runbooksExportPackage(sourceId, destination);
        store.setNotice(`Runbook package exported to ${result.destination}.`);
        return result;
      } catch (error) {
        store.setError(String(error));
        return null;
      } finally {
        store.setBusyAction(null);
      }
    },
    [],
  );

  const restoreBuiltins = useCallback(async () => {
    const store = useRunbookStore.getState();
    store.setBusyAction("restore-builtins");
    store.setError(null);
    store.setNotice(null);
    try {
      const sources = await api.runbooksRestoreBuiltins();
      await installLibrarySources(sources);
      store.setNotice("Included runbook examples restored.");
      return sources;
    } catch (error) {
      store.setError(String(error));
      return null;
    } finally {
      store.setBusyAction(null);
    }
  }, []);

  const start = useCallback(
    async (
      sourceId: string,
      sessionId: string,
      inputs: Record<string, string | number | boolean>,
      evidenceMode: EvidenceMode,
    ) => {
      const store = useRunbookStore.getState();
      store.setBusyAction("start");
      store.setError(null);
      const eventBuffer = api.createRunbookEventBuffer(handleEvent);
      try {
        if (useAppStore.getState().activeSessionId !== sessionId) {
          throw new Error(
            "Select the target terminal before starting this runbook.",
          );
        }
        const request: RunbookStartRequest = {
          source_id: sourceId,
          session_id: sessionId,
          target_context: buildRunbookTargetContext(sessionId),
          inputs,
          evidence_mode: evidenceMode,
        };
        const run = await api.runbooksStart(request, eventBuffer.handle);
        const definition = store.definition;
        const installedRun: typeof run = {
          ...run,
          source_id: sourceId,
          definition_id: definition?.metadata.id,
          definition_version: definition?.metadata.version,
          definition_title: definition?.metadata.title,
          inputs,
          evidence_mode: evidenceMode,
          steps: run.steps.map((step, index) => {
            const defined = definition?.spec.steps.find(
              (item) => item.id === step.id,
            );
            return {
              ...step,
              title: defined?.title ?? step.id,
              required: defined?.required ?? true,
              index,
            };
          }),
        };
        store.setActiveRun(installedRun);
        store.setView("run");
        // Channel events may have arrived while invoke was unresolved. Only now
        // may terminal dispatch read target/evidence metadata from activeRun.
        eventBuffer.activate(run.run_id);
        return run;
      } catch (error) {
        eventBuffer.discard();
        store.setError(String(error));
        return null;
      } finally {
        store.setBusyAction(null);
      }
    },
    [handleEvent],
  );

  const resume = useCallback(
    async (runId: string, sessionId: string) => {
      const store = useRunbookStore.getState();
      store.setBusyAction("resume");
      store.setError(null);
      const eventBuffer = api.createRunbookEventBuffer(handleEvent);
      try {
        if (useAppStore.getState().activeSessionId !== sessionId) {
          throw new Error(
            "Select the terminal you want to rebind before resuming.",
          );
        }
        const run = await api.runbooksResume(
          runId,
          sessionId,
          buildRunbookTargetContext(sessionId),
          eventBuffer.handle,
        );
        const previous = getRunById(runId);
        store.setActiveRun({
          ...run,
          evidence_mode: run.evidence_mode ?? previous?.evidence_mode,
        });
        store.setView("run");
        clearRunbookRunRevocation(run.run_id);
        eventBuffer.activate(run.run_id);
        return run;
      } catch (error) {
        eventBuffer.discard(runId);
        store.setError(String(error));
        return null;
      } finally {
        store.setBusyAction(null);
      }
    },
    [handleEvent],
  );

  const cancel = useCallback(
    async (runId: string) => {
      const store = useRunbookStore.getState();
      // Revoke synchronously before any await. This closes claim(true) -> cancel
      // -> PTY-write even when the claim response was already travelling back to
      // the webview when the operator pressed Cancel.
      const attempts = revokeRunbookRun(runId);
      for (const attempt of attempts) {
        // Cancel is an operator gesture, so hand an owned in-flight foreground
        // command SIGINT before releasing observation. The durable outcome still
        // stays Unknown: SIGINT cannot prove what a mutation already changed or
        // whether it spawned work outside the foreground process group.
        interruptJob(attempt.sessionId, attempt.attemptId);
        abortSession(attempt.sessionId, "cancelled", attempt.attemptId);
      }
      store.setBusyAction("cancel");
      try {
        await api.runbooksCancel(runId);
        const terminal = await api.runbooksWaitForTerminal(runId, {
          onObservation: (run) => useRunbookStore.getState().setActiveRun(run),
        });
        store.setActiveRun(terminal);
        await loadHistory();
        if (terminal.report_ready) await loadReport(runId);
      } catch (error) {
        store.setError(String(error));
      } finally {
        store.setBusyAction(null);
      }
    },
    [loadHistory, loadReport],
  );

  const respondApproval = useCallback(
    async (
      runId: string,
      approvalId: string,
      approved: boolean,
      command: string | null,
    ) => {
      // An explicit single-step decision ends run-level auto-approve. Declining
      // is the operator taking the wheel back; approving one step by hand means
      // they were reading the cards again.
      disarmAutoApprove(runId, null);
      const approval = getRunById(runId)?.pending_approval ?? null;
      if (!approval) {
        useRunbookStore
          .getState()
          .setError("No pending approval was found for this run.");
        return;
      }
      if (approval.approval_id !== approvalId) {
        useRunbookStore
          .getState()
          .setError("This approval request changed before it was submitted.");
        return;
      }
      const modelInvocation = approval.command.startsWith(
        "model://configured-agent/",
      );
      await submitApproval({
        runId,
        approval,
        approved,
        command,
        acknowledgement: modelInvocation ? "model_once" : "acknowledged",
        busyAction: `approval:${approvalId}`,
      });
    },
    [],
  );

  /** Approves the approval on screen and arms the run so later approvals are
   *  answered by `autoApproveArmedApproval` as their events arrive. The mode is
   *  armed before releasing the visible approval to Rust, otherwise the engine
   *  can request its next approval before the response and refresh round trip
   *  completes. A refused visible approval rolls the mode back. */
  const approveAllPendingSteps = useCallback(
    async (runId: string, command: string | null) => {
      const run = getRunById(runId);
      const approval = run?.pending_approval ?? null;
      if (!approval) {
        useRunbookStore
          .getState()
          .setError("No pending approval was found for this run.");
        return;
      }
      const modelInvocation = approval.command.startsWith(
        "model://configured-agent/",
      );
      const store = useRunbookStore.getState();
      store.setAutoApprove(runId, true);
      // A replay of the currently displayed request must not race the explicit
      // response below and submit the same approval a second time.
      store.noteAutoApproved(runId, approval.approval_id);
      const result = await submitApproval({
        runId,
        approval,
        approved: true,
        command: modelInvocation ? null : command,
        acknowledgement: modelInvocation ? "model_once" : "acknowledged",
        busyAction: `approval:${approval.approval_id}`,
      });
      if (!result.ok) disarmAutoApprove(runId, result.error);
    },
    [],
  );

  const cancelApproveAll = useCallback((runId: string) => {
    disarmAutoApprove(runId, null);
  }, []);

  const decide = useCallback(
    async (runId: string, decision: RunbookOperatorDecision) => {
      const store = useRunbookStore.getState();
      store.setBusyAction(`decision:${decision.kind}`);
      try {
        await api.runbooksDecide(runId, decision);
        await refreshRun(runId);
      } catch (error) {
        store.setError(String(error));
      } finally {
        store.setBusyAction(null);
      }
    },
    [refreshRun],
  );

  const submitManual = useCallback(
    async (
      runId: string,
      stepId: string,
      outcome: "passed" | "failed" | "not_applicable",
      comment: string,
      evidence: string | null,
    ) => {
      const store = useRunbookStore.getState();
      store.setBusyAction(`manual:${stepId}`);
      try {
        const run = getRunById(runId);
        if (!run) throw new Error("The durable run target is unavailable.");
        const target = buildRunbookTargetContext(run.target.session_id);
        if (!sameTarget(run.target, target)) {
          throw new Error(
            "The terminal target changed; the manual outcome was not submitted.",
          );
        }
        await api.runbooksSubmitManual(
          runId,
          stepId,
          outcome,
          comment,
          evidence,
          target,
        );
        await refreshRun(runId);
      } catch (error) {
        store.setError(String(error));
      } finally {
        store.setBusyAction(null);
      }
    },
    [refreshRun],
  );

  const exportReport = useCallback(
    async (runId: string, destination: string) => {
      const store = useRunbookStore.getState();
      store.setBusyAction("export");
      try {
        const result = await api.runbooksExport(runId, destination);
        store.setNotice(`Report exported to ${result.destination}.`);
        return result;
      } catch (error) {
        store.setError(String(error));
        return null;
      } finally {
        store.setBusyAction(null);
      }
    },
    [],
  );

  const deleteRun = useCallback(
    async (runId: string) => {
      const store = useRunbookStore.getState();
      store.setBusyAction(`delete-run:${runId}`);
      store.setError(null);
      store.setNotice(null);
      try {
        const result = await api.runbooksDelete(runId);
        if (!result.database_deleted) {
          const cleanup = result.evidence_cleanup;
          store.setError(
            `Evidence cleanup was incomplete, so durable history was retained for a safe retry. ${cleanup.deleted}/${cleanup.expected} removed, ${cleanup.missing} missing.${cleanup.errors.length ? ` ${cleanup.errors.join(" ")}` : ""}`,
          );
          return result;
        }

        store.deleteHistoryRun(runId);
        const cleanup = result.evidence_cleanup;
        if (cleanup.complete) {
          const detail =
            cleanup.expected > 0
              ? ` ${cleanup.deleted} evidence artifact${cleanup.deleted === 1 ? "" : "s"} removed${cleanup.missing > 0 ? `; ${cleanup.missing} already missing` : ""}.`
              : " No captured evidence artifacts were registered.";
          store.setNotice(`Run history deleted.${detail}`);
        }
        await loadHistory();
        return result;
      } catch (error) {
        store.setError(String(error));
        return null;
      } finally {
        store.setBusyAction(null);
      }
    },
    [loadHistory],
  );

  return {
    initialize,
    loadLibrary,
    importPackage,
    selectSource,
    refreshSource,
    removeSource,
    exportPackage,
    restoreBuiltins,
    start,
    resume,
    cancel,
    respondApproval,
    approveAllPendingSteps,
    handleRunbookEvent: handleEvent,
    cancelApproveAll,
    decide,
    submitManual,
    loadHistory,
    loadReport,
    openHistoryRun,
    exportReport,
    deleteRun,
  };
}
