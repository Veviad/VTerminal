import { AlertTriangle, Network, Play, ShieldAlert, Square, TerminalSquare } from "lucide-react";
import { useEffect, useState } from "react";

import type { RunbookApprovalRequest } from "../../lib/runbooks";
import { dangerButton, primaryButton, runbookInputClass } from "./runbookUi";

export function RunbookApprovalCard({
  approval,
  busy,
  targetLabel,
  onRespond,
}: {
  approval: RunbookApprovalRequest;
  busy: boolean;
  targetLabel: string;
  onRespond(approved: boolean, command: string | null, shellAttested: boolean): void;
}) {
  const [command, setCommand] = useState(approval.command);
  const [shellAttested, setShellAttested] = useState(false);

  useEffect(() => {
    setCommand(approval.command);
    setShellAttested(false);
  }, [approval.approval_id, approval.command]);

  const modelInvocation = approval.command.startsWith("model://configured-agent/");
  const edited = command !== approval.command;
  const invalid =
    !command.trim() || command.length > 4_096 || /[\r\n\0]/.test(command);
  const classification = approval.classification;
  const phaseDeviation =
    approval.phase !== "apply" &&
    (classification.network || classification.privileged || classification.opaque);

  return (
    <section className="space-y-3 rounded-md border border-warning/40 bg-warning/5 p-3">
      <div className="flex items-start gap-2">
        <ShieldAlert size={14} className="mt-0.5 shrink-0 text-warning" />
        <div className="min-w-0 flex-1">
          <h3 className="text-[12px] font-medium text-text-primary">
            Approval required · {approval.phase}
          </h3>
          <p className="mt-0.5 text-[10px] leading-relaxed text-text-muted">
            {approval.explanation}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap gap-1">
        {!classification.read_only && !modelInvocation && <Tag tone="warning">may write</Tag>}
        {modelInvocation && <Tag tone="warning">model data processing</Tag>}
        {classification.network && <Tag tone="warning"><Network size={9} /> network</Tag>}
        {classification.privileged && <Tag tone="warning"><ShieldAlert size={9} /> privileged</Tag>}
        {classification.opaque && <Tag tone="warning">opaque</Tag>}
        {classification.read_only && !classification.network && !classification.privileged && !classification.opaque && (
          <Tag tone="neutral">read-only</Tag>
        )}
      </div>

      {phaseDeviation && (
        <p className="flex items-start gap-1.5 rounded border border-warning/30 bg-warning/10 px-2 py-1.5 text-[10px] leading-relaxed text-warning">
          <AlertTriangle size={10} className="mt-0.5 shrink-0" />
          This {approval.phase} is not a local read-only action. Approving it is recorded as a phase deviation.
        </p>
      )}

      {modelInvocation ? (
        <div className="space-y-1 rounded border border-border-subtle bg-bg-primary px-2 py-2">
          <span className="flex items-center gap-1 text-[10px] text-text-muted">
            <Network size={10} /> Configured model invocation
          </span>
          <code className="block break-all text-[10px] text-text-secondary">{approval.command}</code>
          <span className="block text-[9px] leading-relaxed text-text-muted">
            No terminal command is executed by this approval. Step instructions and bounded run context may be sent to the configured model. Any terminal command it proposes requires a separate approval.
          </span>
        </div>
      ) : (
        <div className="space-y-2">
        <label className="block space-y-1">
          <span className="flex items-center gap-1 text-[10px] text-text-muted">
            <TerminalSquare size={10} /> Exact command to run in the visible terminal
          </span>
          <textarea
            value={command}
            onChange={(event) => setCommand(event.target.value)}
            spellCheck={false}
            rows={3}
            className={`${runbookInputClass} resize-none font-mono text-[10px] leading-relaxed ${invalid ? "border-error" : ""}`}
          />
          <span className={`block text-[9px] ${invalid ? "text-error" : "text-text-muted"}`}>
            {invalid
              ? "Commands must be one non-empty line of at most 4,096 characters."
              : edited
                ? "Edited command — the original and executed form will both appear in the report."
                : "The command is typed once. It is never retried automatically."}
          </span>
        </label>
        <label className="flex cursor-pointer items-start gap-2 rounded border border-warning/30 bg-warning/10 px-2 py-2 text-[10px] leading-relaxed text-text-secondary">
          <input
            type="checkbox"
            checked={shellAttested}
            onChange={(event) => setShellAttested(event.target.checked)}
            className="mt-0.5"
          />
          <span>
            I confirm the visible prompt is on the bound target <strong>{targetLabel}</strong>, is a POSIX shell prompt, and I trust this session&apos;s shell, functions, aliases, and PATH. The observed result is not deterministic shell attestation.
          </span>
        </label>
        </div>
      )}

      <div className="flex gap-2">
        <button
          onClick={() => onRespond(false, null, false)}
          disabled={busy}
          className={`${dangerButton} flex-1`}
        >
          <Square size={10} /> Decline and pause
        </button>
        <button
          onClick={() => onRespond(true, modelInvocation ? null : command, shellAttested)}
          disabled={busy || (!modelInvocation && (invalid || !shellAttested))}
          className={`${primaryButton} flex-1`}
        >
          <Play size={10} /> {busy ? "Responding…" : modelInvocation ? "Allow model once" : edited ? "Confirm prompt & approve edit" : "Confirm prompt & approve"}
        </button>
      </div>
    </section>
  );
}

function Tag({ children, tone }: { children: React.ReactNode; tone: "warning" | "neutral" }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[9px] ${
      tone === "warning"
        ? "border-warning/30 bg-warning/10 text-warning"
        : "border-border-subtle bg-bg-card text-text-muted"
    }`}>
      {children}
    </span>
  );
}
