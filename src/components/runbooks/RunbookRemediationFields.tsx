import type { RunbookDraftStep } from "../../lib/runbooks";
import { fieldClass, labelClass, parseCodes, parseMappings, TextField } from "./runbookFields";

/**
 * Apply and verify, which turn a step from a report into a repair.
 *
 * The two are added and removed TOGETHER because the backend rejects an apply
 * with nothing to prove it worked. Offering them separately would let the
 * operator build a document that cannot be published and only find out on the
 * Review stage.
 */
export function Remediation({
  step,
  onChange,
}: {
  step: RunbookDraftStep;
  onChange: (step: RunbookDraftStep) => void;
}) {
  const enabled = step.apply !== null;
  const enable = () => {
    onChange({
      ...step,
      apply: { kind: "shell", command: "", env: {}, successExitCodes: [0] },
      // Re-running the check is the usual proof, so seed it with that.
      verify:
        step.check.kind === "shell"
          ? { kind: "shell", command: step.check.command, env: step.check.env, passExitCodes: [0] }
          : { kind: "shell", command: "", env: {}, passExitCodes: [0] },
    });
  };
  return (
    <div className="mt-3 border-t border-border-subtle pt-2">
      <label className="flex items-center gap-1.5 text-[9px] text-text-secondary"><input type="checkbox" checked={enabled} onChange={(event) => {
        if (event.target.checked) enable();
        else onChange({ ...step, apply: null, verify: null });
      }} /> Remediate when this check fails</label>
      {enabled && step.apply && (
        <div className="mt-2 space-y-3">
          <PhaseFields
            legend="Apply — the change. Must be safe to run twice."
            action={step.apply}
            codesLabel="Success codes"
            codes={step.apply.kind === "shell" ? step.apply.successExitCodes : []}
            onKind={(kind) => {
              onChange({ ...step, apply: kind === "manual" ? { kind: "manual", instructions: "" } : { kind: "shell", command: "", env: {}, successExitCodes: [0] } });
            }}
            onAction={(command, env) => {
              onChange({ ...step, apply: { kind: "shell", command, env, successExitCodes: step.apply?.kind === "shell" ? step.apply.successExitCodes : [0] } });
            }}
            onCodes={(codes) => {
              if (step.apply?.kind === "shell") onChange({ ...step, apply: { ...step.apply, successExitCodes: codes } });
            }}
            onInstructions={(instructions) => {
              onChange({ ...step, apply: { kind: "manual", instructions } });
            }}
          />
          {step.verify && (
            <PhaseFields
              legend="Verify — proof it worked. Required."
              action={step.verify}
              codesLabel="Pass codes"
              codes={step.verify.kind === "shell" ? step.verify.passExitCodes : []}
              onKind={(kind) => {
                onChange({ ...step, verify: kind === "manual" ? { kind: "manual", instructions: "" } : { kind: "shell", command: "", env: {}, passExitCodes: [0] } });
              }}
              onAction={(command, env) => {
                onChange({ ...step, verify: { kind: "shell", command, env, passExitCodes: step.verify?.kind === "shell" ? step.verify.passExitCodes : [0] } });
              }}
              onCodes={(codes) => {
                if (step.verify?.kind === "shell") onChange({ ...step, verify: { ...step.verify, passExitCodes: codes } });
              }}
              onInstructions={(instructions) => {
                onChange({ ...step, verify: { kind: "manual", instructions } });
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}

/** One phase's editor. Apply and verify differ only in what their exit codes
 *  are called, which is why they share this. */
function PhaseFields({ legend, action, codesLabel, codes, onKind, onAction, onCodes, onInstructions }: {
  legend: string;
  action: { kind: "shell"; command: string; env: Record<string, string> } | { kind: "manual"; instructions: string };
  codesLabel: string;
  codes: number[];
  onKind: (kind: "shell" | "manual") => void;
  onAction: (command: string, env: Record<string, string>) => void;
  onCodes: (codes: number[]) => void;
  onInstructions: (instructions: string) => void;
}) {
  return (
    <fieldset className="rounded-md border border-border-subtle p-2">
      <legend className="px-1 text-[9px] text-text-muted">{legend}</legend>
      <label className={labelClass}>Type<select className={fieldClass} value={action.kind} onChange={(event) => {
        onKind(event.target.value as "shell" | "manual");
      }}><option value="shell">Shell</option><option value="manual">Manual</option></select></label>
      {action.kind === "shell" ? (
        <div className="mt-2 space-y-2">
          <label className={labelClass}>Single-line command<textarea className={`${fieldClass} min-h-16 font-mono`} value={action.command} onChange={(event) => {
            onAction(event.target.value, action.env);
          }} /></label>
          <label className={labelClass}>Input mappings (one <code>VRUN_NAME=inputId</code> per line)<textarea className={`${fieldClass} min-h-14 font-mono`} value={Object.entries(action.env).map(([name, id]) => `${name}=${id}`).join("\n")} onChange={(event) => {
            onAction(action.command, parseMappings(event.target.value));
          }} /></label>
          <details><summary className="cursor-pointer text-[9px] text-text-muted">Advanced exit codes</summary><div className="mt-2"><TextField label={codesLabel} value={codes.join(", ")} onChange={(value) => {
            onCodes(parseCodes(value));
          }} /></div></details>
        </div>
      ) : (
        <label className={`${labelClass} mt-2`}>Operator instructions<textarea className={`${fieldClass} min-h-20`} value={action.instructions} onChange={(event) => {
          onInstructions(event.target.value);
        }} /></label>
      )}
    </fieldset>
  );
}
