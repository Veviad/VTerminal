import { ChevronDown, ChevronUp, Sparkles, SquareTerminal, Trash2 } from "lucide-react";

import { S } from "../../lib/strings";
import { sanitizeCommand } from "../../lib/ptyExecShell";
import type { ScheduleStep, ScheduleStepKind } from "../../lib/schedules";
import { scheduleInputClass, secondaryButton } from "./scheduleUi";

export function ScheduleStepList({
  steps,
  onPatch,
  onAdd,
  onRemove,
  onMove,
  issueFor,
}: {
  steps: ScheduleStep[];
  onPatch(index: number, patch: Partial<ScheduleStep>): void;
  onAdd(kind: ScheduleStepKind): void;
  onRemove(index: number): void;
  onMove(from: number, to: number): void;
  issueFor(index: number): string | undefined;
}) {
  return (
    <div className="space-y-2">
      <p className="text-[11px] text-text-secondary">{S.schedules.steps}</p>
      <ol className="space-y-1.5">
        {steps.map((step, index) => (
          <StepRow
            // A stable per-step id, not the index: indexes as keys plus reorder
            // is the classic bug where a textarea keeps the previous step's text.
            key={step.id}
            step={step}
            index={index}
            total={steps.length}
            issue={issueFor(index)}
            onPatch={(patch) => onPatch(index, patch)}
            onRemove={() => onRemove(index)}
            onMove={(delta) => onMove(index, index + delta)}
          />
        ))}
      </ol>
      <div className="flex gap-1.5">
        <button type="button" className={secondaryButton} onClick={() => onAdd("command")}>
          <SquareTerminal size={11} /> {S.schedules.addCommand}
        </button>
        <button type="button" className={secondaryButton} onClick={() => onAdd("prompt")}>
          <Sparkles size={11} /> {S.schedules.addPrompt}
        </button>
      </div>
    </div>
  );
}

function StepRow({
  step,
  index,
  total,
  issue,
  onPatch,
  onRemove,
  onMove,
}: {
  step: ScheduleStep;
  index: number;
  total: number;
  issue?: string;
  onPatch(patch: Partial<ScheduleStep>): void;
  onRemove(): void;
  onMove(delta: number): void;
}) {
  // A live dry-run of the same gate the terminal applies. Showing the reason as
  // you type turns "the schedule silently did nothing at 3am" into a red line at
  // authoring time — the highest-value validation in this editor.
  const gate =
    step.kind === "command" && step.text.trim() ? sanitizeCommand(step.text) : null;
  const gateReason = gate && !gate.ok ? gate.reason : undefined;

  return (
    <li className="space-y-1 rounded-md border border-border-subtle bg-bg-card p-2">
      <div className="flex items-center gap-1.5">
        <span className="text-[10px] text-text-muted">{index + 1}.</span>
        <span className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-text-muted">
          {step.kind === "command" ? <SquareTerminal size={10} /> : <Sparkles size={10} />}
          {step.kind === "command" ? S.schedules.stepCommand : S.schedules.stepPrompt}
        </span>
        <input
          value={step.title}
          onChange={(e) => onPatch({ title: e.target.value })}
          className="min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 py-0.5 text-[11px] text-text-secondary hover:border-border-subtle focus:border-accent focus:outline-none"
          aria-label={`Step ${index + 1} title`}
        />
        {/* Up/down rather than drag-and-drop: `dragDropEnabled: false` on the
            window is what makes the app's file-drop normalizer work at all, and a
            second HTML5 drag protocol in the same window invites a regression in
            the AI composer's attachment handling. */}
        <button
          type="button"
          onClick={() => onMove(-1)}
          disabled={index === 0}
          title={S.schedules.moveUp}
          aria-label={S.schedules.moveUp}
          className="rounded p-0.5 text-text-muted hover:bg-bg-hover hover:text-text-secondary disabled:opacity-30"
        >
          <ChevronUp size={11} />
        </button>
        <button
          type="button"
          onClick={() => onMove(1)}
          disabled={index === total - 1}
          title={S.schedules.moveDown}
          aria-label={S.schedules.moveDown}
          className="rounded p-0.5 text-text-muted hover:bg-bg-hover hover:text-text-secondary disabled:opacity-30"
        >
          <ChevronDown size={11} />
        </button>
        <button
          type="button"
          onClick={onRemove}
          disabled={total === 1}
          title={S.schedules.removeStep}
          aria-label={S.schedules.removeStep}
          className="rounded p-0.5 text-text-muted hover:bg-bg-hover hover:text-error disabled:opacity-30"
        >
          <Trash2 size={11} />
        </button>
      </div>

      <textarea
        value={step.text}
        onChange={(e) => onPatch({ text: e.target.value })}
        rows={step.kind === "command" ? 2 : 3}
        spellCheck={step.kind === "prompt"}
        placeholder={
          step.kind === "command"
            ? S.schedules.stepCommandPlaceholder
            : S.schedules.stepPromptPlaceholder
        }
        className={`${scheduleInputClass} resize-y ${
          step.kind === "command" ? "font-mono text-[11px]" : "text-[12px]"
        }`}
        aria-label={`Step ${index + 1} ${step.kind}`}
      />

      {(gateReason || issue) && (
        <p className="text-[10px] text-error">{gateReason ?? issue}</p>
      )}

      <label className="flex items-center gap-1.5 text-[10px] text-text-muted">
        <input
          type="checkbox"
          checked={step.continue_on_failure}
          onChange={(e) => onPatch({ continue_on_failure: e.target.checked })}
          className="accent-accent"
        />
        {S.schedules.stepContinue}
      </label>
    </li>
  );
}
