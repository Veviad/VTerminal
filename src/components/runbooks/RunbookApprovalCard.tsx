import {
  AlertTriangle,
  Network,
  Play,
  ShieldAlert,
  Square,
  TerminalSquare,
} from "lucide-react";
import { useEffect, useState } from "react";

import type { RunbookApprovalRequest } from "../../lib/runbooks";
import {
  dangerButton,
  primaryButton,
  runbookInputClass,
  secondaryButton,
} from "./runbookUi";

export function RunbookApprovalCard({
  approval,
  busy,
  targetLabel,
  onRespond,
  onApproveAll,
  onCancelApproveAll,
  autoApproving,
}: {
  approval: RunbookApprovalRequest;
  busy: boolean;
  targetLabel: string;
  onRespond(
    approved: boolean,
    command: string | null,
    shellAttested: boolean,
  ): void;
  onApproveAll?: () => void;
  onCancelApproveAll?: () => void;
  autoApproving?: boolean;
}) {
  const [command, setCommand] = useState(approval.command);

  useEffect(() => {
    setCommand(approval.command);
  }, [approval.approval_id, approval.command]);

  const modelInvocation = approval.command.startsWith(
    "model://configured-agent/",
  );
  const edited = command !== approval.command;
  const invalid =
    !command.trim() || command.length > 4_096 || /[\r\n\0]/.test(command);
  const classification = approval.classification;
  const phaseDeviation =
    approval.phase !== "apply" &&
    (classification.network ||
      classification.privileged ||
      classification.opaque);

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
        {!classification.read_only && !modelInvocation && (
          <Tag tone="warning">may write</Tag>
        )}
        {modelInvocation && <Tag tone="warning">model data processing</Tag>}
        {classification.network && (
          <Tag tone="warning">
            <Network size={9} /> network
          </Tag>
        )}
        {classification.privileged && (
          <Tag tone="warning">
            <ShieldAlert size={9} /> privileged
          </Tag>
        )}
        {classification.opaque && <Tag tone="warning">opaque</Tag>}
        {classification.read_only &&
          !classification.network &&
          !classification.privileged &&
          !classification.opaque && <Tag tone="neutral">read-only</Tag>}
      </div>

      {phaseDeviation && (
        <p className="flex items-start gap-1.5 rounded border border-warning/30 bg-warning/10 px-2 py-1.5 text-[10px] leading-relaxed text-warning">
          <AlertTriangle size={10} className="mt-0.5 shrink-0" />
          This {approval.phase} is not a local read-only action. Approving it is
          recorded as a phase deviation.
        </p>
      )}

      {modelInvocation ? (
        <div className="space-y-1 rounded border border-border-subtle bg-bg-primary px-2 py-2">
          <span className="flex items-center gap-1 text-[10px] text-text-muted">
            <Network size={10} /> Configured model invocation
          </span>
          <code className="block break-all text-[10px] text-text-secondary">
            {approval.command}
          </code>
          <span className="block text-[9px] leading-relaxed text-text-muted">
            No terminal command is executed by this approval. Step instructions
            and bounded run context may be sent to the configured model. Any
            terminal command it proposes requires a separate approval.
          </span>
        </div>
      ) : (
        <div className="space-y-2">
          <label className="block space-y-1">
            <span className="flex items-center gap-1 text-[10px] text-text-muted">
              <TerminalSquare size={10} /> Exact command to run in the visible
              terminal
            </span>
            <textarea
              value={command}
              onChange={(event) => setCommand(event.target.value)}
              spellCheck={false}
              rows={3}
              className={`${runbookInputClass} resize-none font-mono text-[10px] leading-relaxed ${invalid ? "border-error" : ""}`}
            />
            <span
              className={`block text-[9px] ${invalid ? "text-error" : "text-text-muted"}`}
            >
              {invalid
                ? "Commands must be one non-empty line of at most 4,096 characters."
                : edited
                  ? "Edited command — the original and executed form will both appear in the report."
                  : "Approve when the visible terminal row is the bound target. The command is used once."}
            </span>
            <span className="block text-[9px] leading-relaxed text-text-muted">
              This approval attests that the command runs in{" "}
              <strong>{targetLabel}</strong> under an operator-confirmed visible
              prompt.
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

        {autoApproving ? (
          <button
            onClick={() => onCancelApproveAll?.()}
            disabled={!onCancelApproveAll}
            className={`${dangerButton} flex-1`}
          >
            <Square size={10} /> Stop auto-approve
          </button>
        ) : (
          <>
            <button
              onClick={() => {
                onRespond(
                  true,
                  modelInvocation ? null : command,
                  !modelInvocation,
                );
              }}
              disabled={busy || (!modelInvocation && invalid)}
              className={`${primaryButton} flex-1`}
            >
              <Play size={10} />{" "}
              {busy
                ? "Responding…"
                : modelInvocation
                  ? "Allow model once"
                  : edited
                    ? "Acknowledge and approve step edit"
                    : "Acknowledge and approve step"}
            </button>
            {onApproveAll && (
              <button
                onClick={() => {
                  onApproveAll();
                }}
                disabled={busy}
                className={`${secondaryButton} flex-1`}
                title="Acknowledge and approve the current approval and all remaining approvals in this run."
              >
                <Play size={10} /> Acknowledge and approve all remaining steps
              </button>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function Tag({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone: "warning" | "neutral";
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[9px] ${
        tone === "warning"
          ? "border-warning/30 bg-warning/10 text-warning"
          : "border-border-subtle bg-bg-card text-text-muted"
      }`}
    >
      {children}
    </span>
  );
}
