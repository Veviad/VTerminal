import {
  AlertTriangle,
  FastForward,
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
  ): void;
  onApproveAll?: (command: string | null) => void;
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
  const ansibleController = Boolean(approval.project_digest);
  const edited = command !== approval.command;
  const invalid =
    !ansibleController &&
    (!command.trim() || command.length > 4_096 || /[\r\n\0]/.test(command));
  // Both approve paths execute the same text, so they share one predicate. The
  // bulk button used to be gated on `busy` alone.
  const approveDisabled = busy || (!modelInvocation && invalid);
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

      {approval.project_digest && (
        <div className="space-y-1 rounded border border-border-subtle bg-bg-primary px-2 py-2 text-[9px] text-text-muted">
          <p>Approval is bound to these exact Ansible inputs:</p>
          <code className="block break-all text-text-secondary">Project {approval.project_digest}</code>
          {approval.inventory_digest && (
            <code className="block break-all text-text-secondary">Inventory {approval.inventory_digest}</code>
          )}
        </div>
      )}

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
      ) : ansibleController ? (
        <div className="space-y-1 rounded border border-border-subtle bg-bg-primary px-2 py-2">
          <span className="flex items-center gap-1 text-[10px] text-text-muted">
            <TerminalSquare size={10} /> Exact local controller command
          </span>
          <code className="block overflow-x-auto whitespace-pre font-mono text-[9px] text-text-secondary">
            {approval.command}
          </code>
          <span className="block text-[9px] leading-relaxed text-text-muted">
            VTerminal launches this command directly as a local process. It does
            not run in, or inherit state from, the visible terminal and cannot be
            edited without invalidating this approval.
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
              Approving runs this in <strong>{targetLabel}</strong>. Your click
              is bound to the terminal row visible right now; the session&apos;s
              shell, functions, aliases and PATH are inside that target and are
              not independently verified.
            </span>
          </label>
        </div>
      )}

      <div className="space-y-2">
        <div className="flex gap-2">
          <button
            onClick={() => onRespond(false, null)}
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
            <button
              onClick={() => {
                onRespond(true, modelInvocation ? null : command);
              }}
              disabled={approveDisabled}
              className={`${primaryButton} flex-1`}
            >
              <Play size={10} />{" "}
              {busy
                ? "Responding…"
                : modelInvocation
                  ? "Allow model once"
                  : edited
                    ? "Approve this edited step"
                    : "Approve this step"}
            </button>
          )}
        </div>

        {!autoApproving && onApproveAll && !ansibleController && (
          <div className="space-y-1">
            <button
              onClick={() => {
                // Carry the edit. The bulk button used to take no arguments, so
                // a narrowed command was silently replaced by the model's
                // original proposal and recorded as un-edited.
                onApproveAll(modelInvocation ? null : command);
              }}
              disabled={approveDisabled}
              className={`${secondaryButton} w-full`}
            >
              <FastForward size={10} /> Approve every later step unseen
            </button>
            <span className="block text-[9px] leading-relaxed text-text-muted">
              Later steps in this run are approved without being shown to you —
              including networked, privileged and model steps. Each one is
              recorded in the report as approved without individual display.
              Pauses, manual steps and a declined step end this mode.
            </span>
          </div>
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
