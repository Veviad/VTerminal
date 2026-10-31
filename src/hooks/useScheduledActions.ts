import { useEffect, useRef } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";

import * as api from "../lib/schedules";
import * as tauri from "../lib/tauri";
import { S } from "../lib/strings";
import { getTerm } from "../lib/termRegistry";
import { abortSession, runInTerminal, type PtyExecOutcome } from "../lib/ptyExec";
import { protectPrivateTerminal } from "../lib/runbookTerminalPrivacy";
import {
  claimScheduleSession,
  bindScheduleAgentRequest,
  clearScheduleRunRevocation,
  forgetActionSession,
  isScheduleRunRevoked,
  recallActionSession,
  registerLiveScheduleJob,
  releaseScheduleSession,
  rememberActionSession,
  revokeScheduleRun,
  scheduleOwnerOf,
  scheduleAgentOwnsRequest,
  unregisterLiveScheduleJob,
} from "../lib/scheduleLiveJobs";
// Every record read below is keyed by a runtime id. `ownRecordValue` is the
// repo's own `hasOwnProperty` + `Reflect.get` accessor for exactly that: a
// plain `record[key]` is reachable by `__proto__`, which is the reasoning
// `runbookStore` records for keeping its revision map a `Map`.
import { ownRecordValue } from "../lib/records";
import { useAppStore } from "../stores/appStore";
import { useScheduleStore } from "../stores/scheduleStore";
import { useAiStream } from "./useAiStream";
import { useSessions } from "./useSessions";
import type { ScheduleAction, ScheduleFireEvent, ScheduleStep } from "../lib/schedules";

/**
 * The tab-execution driver for Scheduled Actions.
 *
 * Mounted **unconditionally** in `AppShell`, beside `useGlobalShortcuts`, and
 * gated internally. Runbooks can initialise on panel mount because its runs are
 * user-started; a scheduled action fires with the panel closed, so a driver that
 * lived in the panel would simply not be there when it mattered.
 *
 * Everything here composes existing primitives rather than reimplementing them:
 * `createSession` already supports a background tab (`activate: false` plus seeded
 * `dims`), `runInTerminal` already types and observes one command, and
 * `startAgent` already drives the agent loop against a session's PTY. Neither
 * `ptyExec.ts` nor `useAiStream.ts` references `activeSessionId` — the active-tab
 * requirement is Runbooks policy, not a platform constraint.
 */

/** Fallback geometry when there is no fitted tab to copy. Not xterm's 80×24: a
 *  background pane never fits, so whatever is chosen here is what every command
 *  in the run sees, and 80 columns truncates `ps`, `docker ps` and `df -h` into
 *  output the model then reads as fact. */
const FALLBACK_DIMS = { cols: 120, rows: 40 };

interface StepResult {
  status: string;
  executed_command?: string | null;
  exit_code?: number | null;
  output_tail?: string | null;
  output_truncated?: boolean;
  termination?: string | null;
  summary?: string | null;
  commands_executed?: number;
  commands_skipped?: number;
  commands_blocked?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  error?: string | null;
  duration_ms?: number | null;
}

/** Serialize by session. Two actions targeting one host, or a catch-up
 *  overlapping a scheduled run, would otherwise collide in `runInTerminal` and
 *  surface as `terminal_busy` — a failure the user could never reconstruct.
 *  Runbooks needs no equivalent because a run there is a human gesture. */
const sessionQueues = new Map<string, Promise<void>>();

function enqueue(sessionId: string, work: () => Promise<void>): Promise<void> {
  const tail = (sessionQueues.get(sessionId) ?? Promise.resolve()).then(work, work);
  const tracked = tail.then(
    () => { if (sessionQueues.get(sessionId) === tracked) sessionQueues.delete(sessionId); },
    () => { if (sessionQueues.get(sessionId) === tracked) sessionQueues.delete(sessionId); },
  );
  sessionQueues.set(sessionId, tracked);
  return tail;
}

function seedDims(): { cols: number; rows: number } {
  // The `restoreSessions` recipe: every pane in this app has identical geometry,
  // so the active tab's fitted size is correct for a background one too.
  const activeId = useAppStore.getState().activeSessionId;
  const entry = activeId ? getTerm(activeId) : undefined;
  if (!entry) return FALLBACK_DIMS;
  return {
    cols: entry.term.cols || FALLBACK_DIMS.cols,
    rows: entry.term.rows || FALLBACK_DIMS.rows,
  };
}

/** `Array.prototype.at` is above this project's lib target. */
function lastContent(messages: { content: string }[] | undefined): string | null {
  if (!messages || messages.length === 0) return null;
  return messages[messages.length - 1].content;
}

function outcomeToResult(outcome: PtyExecOutcome, command: string): StepResult {
  const base: StepResult = {
    status: "failed",
    executed_command: command,
    exit_code: outcome.exitCode ?? null,
    output_tail: outcome.output || null,
    duration_ms: outcome.durationMs,
    commands_executed: 1,
  };
  if (outcome.error) {
    return {
      ...base,
      // `ptyExec` deliberately never kills on timeout — it is the user's shell.
      // Reporting "still running" rather than "killed" keeps that truthful, and
      // the two modes must not share a word for it.
      status: outcome.error === "timeout" ? "unknown" : "failed",
      error:
        outcome.error === "timeout"
          ? `the command did not finish within its timeout and may still be running${
              outcome.note ? ` — ${outcome.note}` : ""
            }`
          : (outcome.note ?? outcome.error),
    };
  }
  return {
    ...base,
    status: outcome.exitCode === 0 ? "succeeded" : "failed",
    error:
      outcome.exitCode === 0
        ? null
        : `the command exited with status ${outcome.exitCode ?? "unknown"}`,
  };
}

export function useScheduledActions() {
  const enabled = useAppStore((s) => s.schedulesEnabled);
  const { createSession } = useSessions();
  const { startAgent, cancel: cancelAgent } = useAiStream();
  // Held in refs so the listener effect does not re-subscribe on every render of
  // a hook whose callbacks are recreated per commit.
  const createRef = useRef(createSession);
  const startAgentRef = useRef(startAgent);
  const cancelAgentRef = useRef(cancelAgent);
  createRef.current = createSession;
  startAgentRef.current = startAgent;
  cancelAgentRef.current = cancelAgent;

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    const generation = useScheduleStore.getState().resetGeneration;
    const current = () => !disposed && generation === useScheduleStore.getState().resetGeneration;
    const unlisteners: UnlistenFn[] = [];

    const finish = async (runId: string, status: string, error?: string | null) => {
      try {
        await api.scheduleRunFinish(runId, status, error ?? null);
      } catch {
        // The backend may have already settled the run — a cancel, or the
        // feature being switched off. Nothing more to do here.
      }
    };

    const runStep = async (
      runId: string,
      action: ScheduleAction,
      step: ScheduleStep,
      index: number,
      sessionId: string,
    ): Promise<StepResult> => {
      if (isScheduleRunRevoked(runId)) {
        return { status: "cancelled", error: "the run was cancelled" };
      }
      if (
        !(await api.scheduleRunIsActive(runId).catch(() => false)) ||
        isScheduleRunRevoked(runId) ||
        !useAppStore.getState().schedulesEnabled
      ) {
        return { status: "cancelled", error: "the run is no longer active" };
      }
      const attemptId = await api.scheduleStepBegin(
        runId,
        step.id,
        index,
        step.kind,
        step.title,
      );
      const lease = registerLiveScheduleJob({ runId, attemptId, sessionId, kind: step.kind });
      const startedAt = Date.now();
      try {
        if (isScheduleRunRevoked(runId) || !useAppStore.getState().schedulesEnabled) {
          const cancelled = { status: "cancelled", error: "the run is no longer active" };
          await api.scheduleStepFinish(runId, attemptId, cancelled);
          return cancelled;
        }
        if (step.kind === "command") {
          const outcome = await runInTerminal(sessionId, attemptId, step.text, {
            // The action's own timeout, not a hardcoded one: the editor exposes
            // it, and a headless run honours it — ignoring it here would make the
            // same action behave differently in a tab for no stated reason.
            timeoutMs: action.command_timeout_secs * 1000,
            // Hostile command output can replay integrated OSC markers, so a
            // scheduled dispatch always requires a fresh per-command token.
            nonceCompletion: true,
            harden: true,
            beforeWrite: async () => {
              if (isScheduleRunRevoked(runId)) return false;
              const active = await api.scheduleRunIsActive(runId).catch(() => false);
              return active && !isScheduleRunRevoked(runId) && useAppStore.getState().schedulesEnabled;
            },
            canWrite: () => {
              const app = useAppStore.getState();
              return (
                !isScheduleRunRevoked(runId) &&
                app.schedulesEnabled &&
                scheduleOwnerOf(sessionId) === runId &&
                !app.sessions.find((s) => s.id === sessionId)?.exited
              );
              // NOTE: deliberately NO activeSessionId check. That is the
              // Runbooks guard, and copying it here would make every scheduled
              // run fail the moment the user looked at another tab.
            },
          });
          const result = outcomeToResult(outcome, step.text);
          await api.scheduleStepFinish(runId, attemptId, result);
          return result;
        }

        // A prompt step. `startAgent` is async and awaits `api.agentStart`, which
        // resolves only when the backend run terminates — so this IS the
        // completion signal. Do not poll `status`.
        const before = ownRecordValue(useAppStore.getState().aiStreams, sessionId);
        if (before && before.status !== "idle") {
          const busy: StepResult = {
            status: "failed",
            error: "the terminal's AI panel was already busy",
            duration_ms: Date.now() - startedAt,
          };
          await api.scheduleStepFinish(runId, attemptId, busy);
          return busy;
        }
        const messagesBefore = before?.messages.length ?? 0;
        if (
          !(await api.scheduleRunIsActive(runId).catch(() => false)) ||
          isScheduleRunRevoked(runId) ||
          !useAppStore.getState().schedulesEnabled
        ) {
          const cancelled = { status: "cancelled", error: "the run is no longer active" };
          await api.scheduleStepFinish(runId, attemptId, cancelled);
          return cancelled;
        }
        // startAgent claims its request synchronously before its first await.
        // Capture that exact owner before yielding, so a delayed cancellation
        // notice cannot stop a newer human turn in the same terminal.
        const started = startAgentRef.current(sessionId, step.text, [], runId);
        const state = useAppStore.getState();
        const owner = state.resolveAiOwner(sessionId);
        const requestId = ownRecordValue(state.aiStreams, owner)?.requestId;
        if (requestId && requestId !== before?.requestId) bindScheduleAgentRequest(lease, requestId);
        await started;
        const after = ownRecordValue(useAppStore.getState().aiStreams, sessionId);
        // `startAgent` returns immediately, having done nothing, if the session
        // was busy or a sidecar is unhealthy. An await on that resolves instantly
        // and would otherwise look like a step that finished in two milliseconds.
        const ran = (after?.messages.length ?? 0) > messagesBefore;
        const result: StepResult =
          after?.status === "paused"
            ? {
                status: "failed",
                // The step limit PAUSES; nothing continues a paused run on its
                // own. Wiring a scheduler to Continue would turn the step cap
                // into no cap at all, unattended.
                termination: "step_limit",
                error: S.schedules.pausedStep,
                summary: lastContent(after.messages),
                duration_ms: Date.now() - startedAt,
              }
            : after?.status === "error" || !ran
              ? {
                  status: "failed",
                  error: after?.lastError ?? "the prompt step did not run",
                  duration_ms: Date.now() - startedAt,
                }
              : {
                  status: "succeeded",
                  summary: lastContent(after?.messages),
                  duration_ms: Date.now() - startedAt,
                };
        await api.scheduleStepFinish(runId, attemptId, result);
        return result;
      } catch (error) {
        const failed: StepResult = {
          status: "failed",
          error: String(error),
          duration_ms: Date.now() - startedAt,
        };
        await api.scheduleStepFinish(runId, attemptId, failed).catch(() => {});
        return failed;
      } finally {
        unregisterLiveScheduleJob(lease);
      }
    };

    const drive = async (fire: ScheduleFireEvent) => {
      // The event carries the plan committed by the backend, so edits made
      // while this run waited never change the commands or permissions it runs.
      const action = fire.action;

      // The local SSH block starts before password, host-key and MFA prompts.
      // It is not proof of a remote prompt, so do not open or type into an
      // unattended SSH tab without a passive authentication signal.
      if (fire.target_host_id !== null || action.target.kind === "ssh_host") {
        await finish(fire.run_id, "failed", "Unattended SSH tab runs cannot safely verify authentication. Use a key-authenticated headless schedule, or connect interactively.");
        return;
      }

      // Reuse an unconstrained local tab when it is still usable.
      const remembered = recallActionSession(fire.action_id);
      const app = useAppStore.getState();
      const reusable =
        remembered &&
        app.sessions.some((s) => s.id === remembered && !s.exited) &&
        getTerm(remembered) !== undefined &&
        scheduleOwnerOf(remembered) === null &&
        // A shell can change directories, so an explicit cwd needs a new tab.
        fire.target_cwd === null &&
        !ownRecordValue(app.sessionUi, remembered)?.remote;

      let sessionId = reusable ? (remembered as string) : null;
      const dims = seedDims();

      if (!sessionId) {
        try {
          sessionId = await createRef.current({
                activate: false,
                dims,
                cwd: fire.target_cwd,
                userTitle: `⏱ ${action.name}`,
              });
        } catch (error) {
          await finish(fire.run_id, "failed", `the terminal could not be opened: ${error}`);
          return;
        }
        if (!sessionId) {
          await finish(fire.run_id, "failed", "the terminal could not be opened");
          return;
        }
        // `pty_spawn` failure does NOT throw: `createSession` catches it, marks
        // the session exited and returns the id anyway. Without this check the
        // run reports `terminal_closed` on step one for no visible reason.
        if (useAppStore.getState().sessions.find((s) => s.id === sessionId)?.exited) {
          await finish(fire.run_id, "failed", "the shell for this run failed to start");
          return;
        }
      }

      if (!claimScheduleSession(fire.run_id, sessionId)) {
        await finish(fire.run_id, "failed", "another scheduled run already owns that terminal");
        return;
      }
      rememberActionSession(fire.action_id, sessionId);

      const entry = getTerm(sessionId);
      try {
        // Also where the working directory is re-checked: `createSession`
        // deliberately treats an unresolvable cwd as non-fatal and just logs it,
        // which is right when a person opens a tab and wrong for an unattended
        // run that would then execute somewhere else entirely.
        await api.scheduleRunAttach(
          fire.run_id,
          sessionId,
          fire.target_host_id,
          entry?.term.cols ?? dims.cols,
          entry?.term.rows ?? dims.rows,
        );
      } catch (error) {
        releaseScheduleSession(sessionId);
        await finish(fire.run_id, "failed", String(error));
        return;
      }

      // Seeded only now: `withAiStream` no-ops for a session id that is not in
      // `state.sessions`, and this is the first point at which it certainly is.
      const appStore = useAppStore.getState();
      appStore.setPermissionMode(sessionId, action.permission_mode);
      appStore.setMcpSelection(sessionId, action.mcp_selection as never);
      const stream = ownRecordValue(useAppStore.getState().aiStreams, sessionId);
      for (const ref of stream?.attachedBucketRefs ?? stream?.attachedBucketIds ?? []) {
        appStore.detachBucketFromAi(sessionId, ref);
      }
      for (const ref of action.doc_buckets) {
        appStore.attachBucketToAi(sessionId, ref as never);
      }

      let status = "succeeded";
      let runError: string | null = null;
      try {
        for (const [index, step] of action.steps.entries()) {
          const result = await runStep(fire.run_id, action, step, index, sessionId);
          if (
            result.status === "cancelled" ||
            isScheduleRunRevoked(fire.run_id) ||
            !(await api.scheduleRunIsActive(fire.run_id).catch(() => false))
          ) {
            status = "cancelled";
            break;
          }
          if (result.status !== "succeeded" && result.status !== "skipped") {
            if (!step.continue_on_failure) {
              status = "failed";
              runError = result.error ?? null;
              break;
            }
            status = "failed";
            runError = runError ?? result.error ?? null;
          }
        }
      } finally {
        releaseScheduleSession(sessionId);
        // The counterpart safety measure, and not optional: otherwise a user who
        // clicks into a leftover schedule tab inherits its armed mode for their
        // own next turn, with no gesture and the panel showing it as if they had
        // chosen it themselves.
        useAppStore.getState().setPermissionMode(sessionId, "ask");
        if (action.close_tab_when_done && action.recurrence.kind === "once") {
          forgetActionSession(sessionId);
          void tauri.ptyKill(sessionId).catch(() => {});
        } else {
          // Rename the tab to carry the result, so a glance at the tab strip is
          // enough. The scrollback IS the run's forensic record, which is why the
          // tab is left open by default.
          useAppStore.getState().updateSession(sessionId, {
            userTitle: `⏱ ${action.name} · ${status === "succeeded" ? "✓" : "✗"}`,
          });
        }
      }
      await finish(fire.run_id, status, runError);
    };

    void api
      .onScheduleFire((fire) => {
        if (disposed) return;
        if (fire.execution_mode !== "tab") return;
        // Serialized per action rather than per session: the session is not known
        // until the tab is resolved, and two fires of one action must not race to
        // create two tabs.
        void enqueue(`action:${fire.action_id}`, () => drive(fire))
          .catch((error) => finish(fire.run_id, "failed", String(error)))
          .finally(() => {
            clearScheduleRunRevocation(fire.run_id);
          });
      })
      .then((unlisten) => {
        if (disposed) unlisten();
        else unlisteners.push(unlisten);
      });

    void api
      .onScheduleRunNotice((notice) => {
        if (!current()) return;
        const store = useScheduleStore.getState();
        store.noteRunEvent(notice);
        if (notice.status === "cancelled" || notice.status === "failed" || notice.status === "interrupted") {
          for (const job of revokeScheduleRun(notice.run_id)) {
            // A watchdog has no user gesture to send Ctrl-C; release the
            // waiter, and stop any model turn from dispatching more work.
            abortSession(job.sessionId, "cancelled", job.attemptId);
            if (scheduleAgentOwnsRequest(job)) void cancelAgentRef.current(job.sessionId);
          }
        }
        // A terminal notice is the cue to re-read the durable record, which has
        // per-step detail the notice does not carry.
        if (api.isTerminalScheduleRunStatus(notice.status)) {
          const issuedAtRevision = useScheduleStore.getState().revisionOf(notice.run_id);
          void api.scheduleRunGet(notice.run_id).then((run) => {
            if (current() && run) useScheduleStore.getState().upsertRun(run, issuedAtRevision);
          }).catch(() => {});
          void api.schedulesList().then((actions) => {
            if (current()) useScheduleStore.getState().setActions(actions);
          }).catch(() => {});
        }
      })
      .then((unlisten) => {
        if (disposed) unlisten();
        else unlisteners.push(unlisten);
      });

    // Load the durable state once, from here rather than from the panel: an
    // overdue banner and a live badge have to be right whether or not anyone has
    // opened the workspace.
    void api.schedulesList().then((actions) => {
      if (current()) useScheduleStore.getState().setActions(actions);
    });

    return () => {
      disposed = true;
      for (const unlisten of unlisteners) unlisten();
    };
  }, [enabled]);

  useEffect(() => {
    if (enabled) return;
    // Switching the feature off clears the panel's view of it, so a re-enable
    // starts from the backend's truth rather than a stale mirror.
    useScheduleStore.getState().reset();
  }, [enabled]);
}

/** A protected terminal never gives its scrollback back for the rest of its
 *  life, so a schedule must never inflict that on a tab the user owns. Exposed
 *  for the run path that needs it and pinned by a test. */
export function protectScheduleTerminal(sessionId: string): void {
  protectPrivateTerminal(sessionId);
}
