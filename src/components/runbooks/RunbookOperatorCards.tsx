import { CheckCircle2, CircleSlash, RotateCcw, SkipForward, Square } from "lucide-react";
import { useEffect, useState } from "react";

import type {
  RunbookDecisionKind,
  RunbookManualRequest,
  RunbookOperatorRequest,
} from "../../lib/runbooks";
import { RunbookMarkdown } from "./RunbookMarkdown";
import { dangerButton, primaryButton, runbookInputClass, secondaryButton } from "./runbookUi";

export function RunbookPauseCard({
  request,
  busy,
  onDecide,
}: {
  request: RunbookOperatorRequest;
  busy: boolean;
  onDecide(kind: RunbookDecisionKind, reason: string | null): void;
}) {
  const [selected, setSelected] = useState<RunbookDecisionKind | null>(null);
  const [reason, setReason] = useState("");
  useEffect(() => {
    setSelected(null);
    setReason("");
  }, [request.run_id, request.step_id, request.reason]);

  const requiresReason = selected === "waive";
  return (
    <section className="space-y-3 rounded-md border border-warning/40 bg-warning/5 p-3">
      <div>
        <h3 className="text-[12px] font-medium text-warning">Operator decision required</h3>
        {request.message && (
          <p className="mt-1 text-[10px] leading-relaxed text-text-secondary">{request.message}</p>
        )}
        <p className="mt-1 font-mono text-[9px] text-text-muted">{request.reason}</p>
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        {request.choices.map((choice) => (
          <button
            key={choice}
            onClick={() => setSelected(choice)}
            className={`${secondaryButton} ${selected === choice ? "border-accent bg-accent/10 text-accent" : ""}`}
          >
            <DecisionIcon kind={choice} /> {decisionLabel(choice)}
          </button>
        ))}
      </div>
      {selected && selected !== "retry" && (
        <label className="block space-y-1">
          <span className="text-[10px] text-text-muted">
            {requiresReason ? "Waiver reason (required)" : "Operator comment"}
          </span>
          <textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            rows={2}
            className={`${runbookInputClass} resize-none`}
            placeholder={requiresReason ? "Why is this requirement accepted without completion?" : "Optional context for the report"}
          />
        </label>
      )}
      <button
        onClick={() => selected && onDecide(selected, reason.trim() || null)}
        disabled={!selected || busy || (requiresReason && !reason.trim())}
        className={`${selected === "stop" ? dangerButton : primaryButton} w-full`}
      >
        {busy ? "Recording decision…" : selected ? `Confirm ${decisionLabel(selected).toLowerCase()}` : "Choose an action"}
      </button>
    </section>
  );
}

export function RunbookManualCard({
  request,
  busy,
  onSubmit,
}: {
  request: RunbookManualRequest;
  busy: boolean;
  onSubmit(
    outcome: "passed" | "failed" | "not_applicable",
    comment: string,
    evidence: string | null,
  ): void;
}) {
  const [outcome, setOutcome] = useState<"passed" | "failed" | "not_applicable" | null>(null);
  const [comment, setComment] = useState("");
  const [evidence, setEvidence] = useState("");
  useEffect(() => {
    setOutcome(null);
    setComment("");
    setEvidence("");
  }, [request.step_id, request.phase]);

  return (
    <section className="space-y-3 rounded-md border border-accent/30 bg-accent/5 p-3">
      <div>
        <h3 className="text-[12px] font-medium text-text-primary">
          Manual {request.phase} · {request.title}
        </h3>
        <div className="mt-2 text-text-secondary">
          <RunbookMarkdown>{request.instructions}</RunbookMarkdown>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-1">
        {(["passed", "failed", "not_applicable"] as const).map((value) => (
          <button
            key={value}
            onClick={() => setOutcome(value)}
            className={`${secondaryButton} px-1 ${outcome === value ? "border-accent bg-accent/10 text-accent" : ""}`}
          >
            {value === "passed" ? "Passed" : value === "failed" ? "Failed" : "N/A"}
          </button>
        ))}
      </div>
      <label className="block space-y-1">
        <span className="text-[10px] text-text-muted">Operator comment (required)</span>
        <textarea
          value={comment}
          onChange={(event) => setComment(event.target.value)}
          rows={2}
          className={`${runbookInputClass} resize-none`}
          placeholder="What did you inspect or do?"
        />
      </label>
      <label className="block space-y-1">
        <span className="text-[10px] text-text-muted">Optional evidence note</span>
        <textarea
          value={evidence}
          onChange={(event) => setEvidence(event.target.value)}
          rows={2}
          className={`${runbookInputClass} resize-none`}
          placeholder="Ticket, observation or artifact reference (no secrets)"
        />
      </label>
      <button
        onClick={() => outcome && onSubmit(outcome, comment.trim(), evidence.trim() || null)}
        disabled={!outcome || !comment.trim() || busy}
        className={`${primaryButton} w-full`}
      >
        <CheckCircle2 size={11} /> {busy ? "Recording…" : "Record outcome"}
      </button>
    </section>
  );
}

function DecisionIcon({ kind }: { kind: RunbookDecisionKind }) {
  switch (kind) {
    case "retry": return <RotateCcw size={10} />;
    case "skip": return <SkipForward size={10} />;
    case "waive": return <CircleSlash size={10} />;
    case "stop": return <Square size={10} />;
  }
}

function decisionLabel(kind: RunbookDecisionKind): string {
  switch (kind) {
    case "retry": return "Retry safely";
    case "skip": return "Skip";
    case "waive": return "Waive";
    case "stop": return "Stop run";
  }
}
