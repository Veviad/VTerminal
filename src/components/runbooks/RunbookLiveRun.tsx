import {
  CheckCircle2,
  Circle,
  CircleSlash,
  Clock3,
  Eye,
  FileText,
  Loader2,
  PauseCircle,
  RotateCcw,
  Square,
  TriangleAlert,
  XCircle,
} from "lucide-react";
import { useEffect, useState } from "react";

import { useRunbooks, describeRunbookTarget } from "../../hooks/useRunbooks";
import {
  isCheckedStepState,
  isTerminalRunState,
  runbooksGetDefinition,
  type RunbookDefinition,
  type RunbookStepRun,
} from "../../lib/runbooks";
import { useRunbookStore } from "../../stores/runbookStore";
import { RunbookApprovalCard } from "./RunbookApprovalCard";
import { RunbookManualCard, RunbookPauseCard } from "./RunbookOperatorCards";
import { RunbookDefinitionPreview } from "./RunbookDefinitionPreview";
import { RunbookReportViewer } from "./RunbookReportViewer";
import {
  dangerButton,
  humanizeRunbookState,
  primaryButton,
  runStateTone,
  secondaryButton,
  stepStateTone,
} from "./runbookUi";

export function RunbookLiveRun({ sessionId }: { sessionId: string | null }) {
  const run = useRunbookStore((state) => state.activeRun);
  const report = useRunbookStore((state) => state.report);
  const busyAction = useRunbookStore((state) => state.busyAction);
  const {
    cancel,
    resume,
    respondApproval,
    approveAllPendingSteps,
    cancelApproveAll,
    decide,
    submitManual,
    loadReport,
  } = useRunbooks();
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [showReport, setShowReport] = useState(false);
  const [showDefinitionReview, setShowDefinitionReview] = useState(false);
  const [definitionReview, setDefinitionReview] =
    useState<RunbookDefinition | null>(null);
  const [definitionReviewLoading, setDefinitionReviewLoading] = useState(false);
  const [definitionReviewError, setDefinitionReviewError] = useState<
    string | null
  >(null);

  const ignoreAsync = (operation: Promise<unknown> | void) => {
    if (!operation || typeof operation.then !== "function") return;
    operation.catch((error) => {
      useRunbookStore.getState().setError(String(error));
    });
  };

  if (!run) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-5 text-center">
        <div className="max-w-64 space-y-2">
          <Circle size={22} className="mx-auto text-text-muted" />
          <p className="text-[12px] text-text-secondary">No run selected</p>
          <p className="text-[10px] leading-relaxed text-text-muted">
            Start a validated definition from the Library, or open a completed
            run from History.
          </p>
        </div>
      </div>
    );
  }

  if (showReport && report?.run_id === run.run_id) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <button
          onClick={() => {
            setShowReport(false);
          }}
          className={`${secondaryButton} mb-4`}
        >
          ← Checklist
        </button>
        <RunbookReportViewer report={report} />
      </div>
    );
  }

  const checked = run.steps.filter((step) =>
    isCheckedStepState(step.status),
  ).length;
  const terminal = isTerminalRunState(run.status);
  const active =
    run.steps.find((step) => step.id === run.active_step_id) ?? null;
  const autoApproving = busyAction === `approve-all:${run.run_id}`;
  const pendingApproval = run.pending_approval;
  const pendingManual = run.pending_manual;
  const pendingOperator = run.pending_operator;

  useEffect(() => {
    setShowDefinitionReview(false);
    setDefinitionReview(null);
    setDefinitionReviewLoading(false);
    setDefinitionReviewError(null);
  }, [run.run_id]);

  const openReport = async () => {
    if (report?.run_id !== run.run_id) await loadReport(run.run_id);
    setShowReport(true);
  };

  const openRunbookReview = async () => {
    setShowDefinitionReview(true);
    setDefinitionReviewError(null);
    if (
      definitionReview &&
      definitionReview.metadata.id === run.definition_id &&
      definitionReview.metadata.version === run.definition_version
    )
      return;

    if (!run.source_id) {
      setDefinitionReviewError(
        "This run no longer has an associated source to review.",
      );
      return;
    }

    setDefinitionReviewLoading(true);
    try {
      const next = await runbooksGetDefinition(run.source_id);
      if (run.run_id !== useRunbookStore.getState().activeRun?.run_id) return;
      setDefinitionReview(next);
    } catch (error) {
      setDefinitionReviewError(String(error));
    } finally {
      setDefinitionReviewLoading(false);
    }
  };

  if (showDefinitionReview) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <button
          onClick={() => {
            setShowDefinitionReview(false);
          }}
          className={`${secondaryButton} mb-4`}
        >
          ← Checklist
        </button>
        {definitionReviewLoading && (
          <p className="flex items-center gap-1.5 px-2 py-5 text-[11px] text-text-muted">
            <Loader2 size={12} className="animate-spin" /> Loading definition…
          </p>
        )}
        {definitionReviewError && (
          <p className="rounded-md border border-error/30 bg-error/10 p-2 text-[10px] text-error">
            {definitionReviewError}
          </p>
        )}
        {definitionReview ? (
          <RunbookDefinitionPreview definition={definitionReview} />
        ) : !definitionReviewLoading ? (
          <p className="px-2 py-4 text-[11px] text-text-muted">
            The runbook definition could not be loaded for review.
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4">
      <div className="space-y-4">
        <section className="space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="truncate text-[14px] font-semibold text-text-primary">
                  {run.definition_title ??
                    run.definition_id ??
                    "Runbook execution"}
                </h2>
                <span
                  className={`rounded border px-1.5 py-0.5 text-[9px] ${runStateTone(run.status)}`}
                >
                  {humanizeRunbookState(run.status)}
                </span>
              </div>
              <p className="mt-0.5 font-mono text-[9px] text-text-muted">
                {run.run_id} · {describeRunbookTarget(run.target)}
              </p>
            </div>
            <div className="flex shrink-0 gap-1.5">
              {terminal && (
                <button
                  onClick={() => {
                    ignoreAsync(openReport());
                  }}
                  className={primaryButton}
                >
                  <FileText size={11} /> View report
                </button>
              )}
              <button
                onClick={() => {
                  ignoreAsync(openRunbookReview());
                }}
                disabled={definitionReviewLoading}
                className={secondaryButton}
              >
                <Eye size={11} /> Review runbook
              </button>
              {run.status === "interrupted" && sessionId && (
                <button
                  onClick={() => {
                    ignoreAsync(resume(run.run_id, sessionId));
                  }}
                  disabled={busyAction === "resume"}
                  className={primaryButton}
                >
                  <RotateCcw size={11} /> Rebind and resume
                </button>
              )}
              {!terminal && run.status !== "interrupted" && (
                <div className="flex flex-col items-end gap-1">
                  <button
                    onClick={() => {
                      if (confirmCancel) {
                        setConfirmCancel(false);
                        ignoreAsync(cancel(run.run_id));
                      } else {
                        setConfirmCancel(true);
                      }
                    }}
                    onBlur={() => setConfirmCancel(false)}
                    disabled={busyAction === "cancel"}
                    className={confirmCancel ? dangerButton : secondaryButton}
                  >
                    <Square size={10} />{" "}
                    {confirmCancel ? "Confirm cancel" : "Cancel"}
                  </button>
                  {confirmCancel && (
                    <p className="max-w-64 text-right text-[9px] leading-snug text-warning">
                      Sends SIGINT to an owned foreground command, but cannot
                      prove or undo changes already made. The active step will
                      be reported unknown.
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>

          <div>
            <div className="mb-1 flex items-center justify-between text-[9px] text-text-muted">
              <span>
                {checked} of {run.steps.length} verified
              </span>
              <span>
                {Math.round((checked / Math.max(1, run.steps.length)) * 100)}%
              </span>
            </div>
            <div className="h-1 overflow-hidden rounded-full bg-bg-elevated">
              <div
                className="h-full rounded-full bg-accent transition-[width] duration-300"
                style={{
                  width: `${(checked / Math.max(1, run.steps.length)) * 100}%`,
                }}
              />
            </div>
          </div>

          {run.pause_reason && !run.pending_operator && (
            <p className="flex items-start gap-1.5 rounded-md border border-warning/30 bg-warning/5 px-2 py-1.5 text-[10px] text-warning">
              <PauseCircle size={11} className="mt-0.5 shrink-0" />{" "}
              {run.pause_reason}
            </p>
          )}
        </section>

        {pendingApproval && (
          <section className="space-y-2">
            {autoApproving && (
              <p className="rounded-md border border-accent/30 bg-accent/5 px-2 py-1.5 text-[10px] text-accent">
                Automatically acknowledging remaining approvals in this run.
                Manual/operator steps will stop auto mode.
              </p>
            )}
            <RunbookApprovalCard
              approval={pendingApproval}
              targetLabel={describeRunbookTarget(run.target)}
              busy={busyAction !== null}
              autoApproving={autoApproving}
              onApproveAll={() => {
                ignoreAsync(approveAllPendingSteps(run.run_id));
              }}
              onCancelApproveAll={() => {
                ignoreAsync(cancelApproveAll(run.run_id));
              }}
              onRespond={(approved, command, shellAttested) => {
                ignoreAsync(
                  respondApproval(
                    run.run_id,
                    pendingApproval.approval_id,
                    approved,
                    command,
                    shellAttested,
                  ),
                );
              }}
            />
          </section>
        )}

        {pendingManual && (
          <RunbookManualCard
            request={pendingManual}
            busy={busyAction === `manual:${pendingManual.step_id}`}
            onSubmit={(outcome, comment, evidence) => {
              ignoreAsync(
                submitManual(
                  run.run_id,
                  pendingManual.step_id,
                  outcome,
                  comment,
                  evidence,
                ),
              );
            }}
          />
        )}

        {pendingOperator && !pendingManual && (
          <RunbookPauseCard
            request={pendingOperator}
            busy={busyAction?.startsWith("decision:") ?? false}
            onDecide={(kind, reason) => {
              ignoreAsync(
                decide(run.run_id, {
                  kind,
                  step_id: pendingOperator.step_id,
                  actor: "operator",
                  reason,
                }),
              );
            }}
          />
        )}

        {run.status === "running" && active && (
          <p className="flex items-center gap-1.5 rounded-md border border-accent/20 bg-accent/5 px-2 py-1.5 text-[10px] text-accent">
            <Loader2 size={11} className="animate-spin" />
            {humanizeRunbookState(active.status)}: {active.title ?? active.id}
          </p>
        )}

        <section className="space-y-2">
          <h3 className="text-[10px] font-semibold uppercase tracking-widest text-text-muted">
            Checklist
          </h3>
          <ol className="space-y-1.5">
            {run.steps.map((step, index) => (
              <LiveStep
                key={step.id}
                step={step}
                index={index}
                active={step.id === run.active_step_id}
              />
            ))}
          </ol>
        </section>

        {terminal && run.status !== "succeeded" && (
          <p className="flex items-start gap-1.5 rounded-md border border-warning/30 bg-warning/5 px-2 py-1.5 text-[10px] leading-relaxed text-warning">
            <TriangleAlert size={11} className="mt-0.5 shrink-0" />
            This run finished without every required step being positively
            verified. Review the report for exceptions and unresolved risks.
          </p>
        )}
      </div>
    </div>
  );
}

function LiveStep({
  step,
  index,
  active,
}: {
  step: RunbookStepRun;
  index: number;
  active: boolean;
}) {
  const checked = isCheckedStepState(step.status);
  return (
    <li
      className={`rounded-md border p-2.5 ${active ? "border-accent/40 bg-accent/5" : "border-border-subtle bg-bg-card"}`}
    >
      <div className="flex items-start gap-2">
        <StepIcon step={step} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5">
            <p
              className={`text-[11px] ${checked ? "text-text-primary" : "text-text-secondary"}`}
            >
              {index + 1}. {step.title ?? step.id}
            </p>
            <span className={`text-[9px] ${stepStateTone(step.status)}`}>
              {humanizeRunbookState(step.status)}
            </span>
          </div>
          <p className="font-mono text-[9px] text-text-muted">
            {step.id}
            {step.phase ? ` · ${step.phase}` : ""}
            {step.required === false ? " · optional" : ""}
          </p>
          {step.summary && (
            <p className="mt-1 text-[10px] leading-relaxed text-text-secondary">
              {step.summary}
            </p>
          )}
          {step.operator_comment && (
            <p className="mt-1 text-[9px] text-text-muted">
              Operator: {step.operator_comment}
            </p>
          )}
          {step.exception && (
            <p className="mt-1 text-[9px] text-warning">{step.exception}</p>
          )}
        </div>
      </div>
    </li>
  );
}

function StepIcon({ step }: { step: RunbookStepRun }) {
  if (isCheckedStepState(step.status))
    return <CheckCircle2 size={13} className="mt-0.5 shrink-0 text-success" />;
  if (["checking", "applying", "verifying"].includes(step.status)) {
    return (
      <Clock3 size={13} className="mt-0.5 shrink-0 animate-pulse text-accent" />
    );
  }
  if (["skipped", "waived"].includes(step.status)) {
    return <CircleSlash size={13} className="mt-0.5 shrink-0 text-warning" />;
  }
  if (["failed", "blocked"].includes(step.status)) {
    return <XCircle size={13} className="mt-0.5 shrink-0 text-error" />;
  }
  if (["paused", "unknown"].includes(step.status)) {
    return <PauseCircle size={13} className="mt-0.5 shrink-0 text-warning" />;
  }
  return <Circle size={13} className="mt-0.5 shrink-0 text-text-muted" />;
}
