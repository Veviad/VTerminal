import { useCallback } from "react";

import * as api from "../lib/runbooks";
import {
  abortSession,
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
  RunbookApprovalRequest,
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
let approvalFlowSequence = 0;
const approvalAllFlows = new Map<string, number>();

function stopApproveAllFlow(runId: string): void {
  const current = approvalAllFlows.get(runId) ?? 0;
  approvalAllFlows.set(runId, current + 1);
}

function isApproveAllFlowActive(runId: string, token: number): boolean {
  const active = approvalAllFlows.get(runId);
  return Object.is(active, token);
}

/** Why an automatic-approval wait ended. */
type ApprovalWait =
  | { kind: "approval"; approval: RunbookApprovalRequest }
  /** Operator pause, manual step, or a finished run — all documented stops. */
  | { kind: "settled" }
  /** The operator pressed Stop auto-approve, or another flow superseded this. */
  | { kind: "stopped" }
  | { kind: "timeout" };

/** Wait for the run to offer its next approval.
 *
 * Approving does not run the command — it releases the engine, which then
 * dispatches into the terminal and blocks. The run is legitimately `running`
 * for as long as that command takes, so there is nothing useful to sample once
 * a response returns. The next approval arrives as an EVENT or not at all.
 *
 * Resolves immediately when the condition already holds, so a run that has
 * already offered its next approval never waits.
 */
function waitForNextApproval(
  runId: string,
  seen: Set<string>,
  isActive: () => boolean,
  timeoutMs: number,
): Promise<ApprovalWait> {
  const evaluate = (): ApprovalWait | null => {
    if (!isActive()) return { kind: "stopped" };
    const run = getRunById(runId);
    // A run that vanished, paused for the operator, needs a manual outcome, or
    // finished is done with unattended approval either way.
    if (!run || run.pending_operator || run.pending_manual) {
      return { kind: "settled" };
    }
    if (api.isTerminalRunState(run.status) || run.status === "interrupted") {
      return { kind: "settled" };
    }
    const approval = run.pending_approval;
    if (approval && !seen.has(approval.approval_id)) {
      return { kind: "approval", approval };
    }
    return null;
  };

  const immediate = evaluate();
  if (immediate) return Promise.resolve(immediate);

  return new Promise<ApprovalWait>((resolve) => {
    let done = false;
    const settle = (outcome: ApprovalWait) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(outcome);
    };
    const timer = setTimeout(() => {
      settle({ kind: "timeout" });
    }, timeoutMs);
    const unsubscribe = useRunbookStore.subscribe(() => {
      const outcome = evaluate();
      if (outcome) settle(outcome);
    });
  });
}

/** How long one approved command may take before the flow gives up waiting.
 *
 * Mirrors the engine's own budget — `command_timeout_secs` plus the 15s it
 * allows itself past a timeout — so a slow but healthy step never breaks the
 * flow, while a wedged engine still releases it. */
function approvalWaitBudgetMs(): number {
  return (useAppStore.getState().agentCommandTimeoutSecs + 15 + 5) * 1_000;
}

function getRunById(runId: string): RunbookRun | null {
  return (
    Object.values(useRunbookStore.getState().runsById).find((run) =>
      Object.is(run.run_id, runId),
    ) ?? null
  );
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
    // Capture the revision BEFORE the round trip. The row this reads is a
    // snapshot of now, but it arrives whenever it arrives — and the engine is
    // on its own connection, emitting events the whole time. Handing the
    // revision back lets the store drop a snapshot that events have overtaken
    // instead of rewinding to it.
    const issuedAtRevision =
      useRunbookStore.getState().runRevisions.get(runId) ?? 0;
    try {
      const run = await api.runbooksGet(runId);
      useRunbookStore.getState().upsertRun(run, issuedAtRevision);
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
            // A capture GATE, not just a size cap. `none` used to still harvest
            // 8 KiB and ship it over IPC for Rust to discard, so output the
            // operator asked never to keep was read out of the terminal and
            // crossed a process boundary anyway. Zero keeps the honest
            // observed/truncated counters without carrying the bytes.
            tailLimit: api.evidenceTailLimit(run?.evidence_mode),
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

  const handleEvent = useCallback(
    (event: RunbookEvent) => {
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
          void refreshRun(event.run_id);
          void loadHistory();
          void loadReport(event.run_id);
          break;
        case "RunStarted":
        case "ApprovalRequested":
        case "OperatorDecisionRequired":
        case "Error":
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

  const respondApprovalInternal = useCallback(
    async (
      runId: string,
      approvalId: string,
      approved: boolean,
      command: string | null,
      shellAttested: boolean,
      busyAction: string,
      clearBusy = true,
    ) => {
      const store = useRunbookStore.getState();
      const run = getRunById(runId);
      const approval = run?.pending_approval;
      if (!approval) {
        store.setError("No pending approval was found for this run.");
        if (clearBusy && useRunbookStore.getState().busyAction === busyAction) {
          store.setBusyAction(null);
        }
        return false;
      }
      if (approval.approval_id !== approvalId) {
        store.setError(
          "This approval request changed before it was submitted.",
        );
        if (clearBusy && useRunbookStore.getState().busyAction === busyAction) {
          store.setBusyAction(null);
        }
        return false;
      }
      if (approval.command.trim().length === 0) {
        store.setError("Approval command content is empty.");
        if (clearBusy && useRunbookStore.getState().busyAction === busyAction) {
          store.setBusyAction(null);
        }
        return false;
      }

      const modelInvocation = approval.command.startsWith(
        "model://configured-agent/",
      );
      let promptBinding: string | null = null;
      if (approved && !modelInvocation) {
        if (!shellAttested) {
          store.setError(
            "Confirm the visible POSIX shell prompt before approving this action.",
          );
          return false;
        }
        const sessionId = run.target.session_id;
        if (
          !sessionId ||
          useAppStore.getState().activeSessionId !== sessionId
        ) {
          store.setError(
            "Select the bound terminal before approving this action.",
          );
          return false;
        }
        promptBinding = captureApprovalPromptBinding(sessionId);
        if (!promptBinding) {
          store.setError(
            "The visible terminal is not in a stable normal-buffer prompt state.",
          );
          return false;
        }
        approvalPromptBindings.set(approvalId, promptBinding);
      }

      store.setBusyAction(busyAction);
      let delivered = false;
      try {
        await api.runbooksRespondApproval(
          runId,
          approvalId,
          approved,
          command,
          shellAttested,
        );
        delivered = true;
        await refreshRun(runId);
      } catch (error) {
        if (promptBinding) releaseApprovalPromptBinding(promptBinding);
        approvalPromptBindings.delete(approvalId);
        store.setError(String(error));
      } finally {
        if (clearBusy && useRunbookStore.getState().busyAction === busyAction) {
          store.setBusyAction(null);
        }
      }
      return delivered;
    },
    [refreshRun],
  );

  const respondApproval = useCallback(
    async (
      runId: string,
      approvalId: string,
      approved: boolean,
      command: string | null,
      shellAttested: boolean,
    ) => {
      stopApproveAllFlow(runId);
      await respondApprovalInternal(
        runId,
        approvalId,
        approved,
        command,
        shellAttested,
        `approval:${approvalId}`,
      );
    },
    [respondApprovalInternal],
  );

  const approveAllPendingSteps = useCallback(
    async (runId: string) => {
      const run = getRunById(runId);
      if (!run || run.status !== "waiting_approval") {
        return;
      }

      const autoApproveToken = ++approvalFlowSequence;
      approvalAllFlows.set(runId, autoApproveToken);
      const observedApprovals = new Set<string>();
      const store = useRunbookStore.getState();
      store.setBusyAction(`approve-all:${runId}`);
      store.setError(null);
      const isActive = () => isApproveAllFlowActive(runId, autoApproveToken);
      try {
        while (isActive()) {
          // Blocks until the run offers an approval this flow has not already
          // handled, or reaches a state where unattended approval must stop.
          const next = await waitForNextApproval(
            runId,
            observedApprovals,
            isActive,
            approvalWaitBudgetMs(),
          );
          if (next.kind === "stopped") break;
          if (next.kind === "settled") break;
          if (next.kind === "timeout") {
            store.setError(
              "Automatic approval stopped: the run did not reach its next approval in time. Approve the remaining steps individually.",
            );
            break;
          }

          const approval = next.approval;
          observedApprovals.add(approval.approval_id);
          const modelInvocation = approval.command.startsWith(
            "model://configured-agent/",
          );
          if (
            !modelInvocation &&
            (!approval.command.trim() ||
              approval.command.length > 4_096 ||
              /[\r\n\0]/.test(approval.command))
          ) {
            store.setError(
              "Automatic approval stopped because an approval command is invalid.",
            );
            break;
          }

          const delivered = await respondApprovalInternal(
            runId,
            approval.approval_id,
            true,
            modelInvocation ? null : approval.command,
            modelInvocation ? false : true,
            `approve-all:${runId}`,
            false,
          );
          // A refused or failed response has already explained itself. Waiting
          // on after one would sit until the deadline for an approval the
          // engine is never going to replace.
          if (!delivered) break;
        }
      } catch (error) {
        store.setError(String(error));
      } finally {
        if (isApproveAllFlowActive(runId, autoApproveToken)) {
          approvalAllFlows.delete(runId);
        }
        if (useRunbookStore.getState().busyAction === `approve-all:${runId}`) {
          store.setBusyAction(null);
        }
      }
    },
    [respondApprovalInternal],
  );

  const cancelApproveAll = useCallback((runId: string) => {
    stopApproveAllFlow(runId);
    const store = useRunbookStore.getState();
    if (store.busyAction === `approve-all:${runId}`) {
      store.setBusyAction(null);
    }
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
