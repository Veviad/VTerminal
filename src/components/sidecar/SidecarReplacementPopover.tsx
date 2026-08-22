import { useMemo, useRef, useState } from "react";
import { ArrowLeft, Link2, Server, Terminal, X } from "lucide-react";
import { useDismissibleLayer } from "../../hooks/useDismissibleLayer";
import type { AgentTargetRole } from "../../lib/sidecar";
import { S } from "../../lib/strings";
import type { SidecarTerminalChoice } from "./SidecarPairingPopover";

function choicesForRole(
  choices: Record<AgentTargetRole, readonly SidecarTerminalChoice[]>,
  role: AgentTargetRole,
): readonly SidecarTerminalChoice[] {
  return role === "local" ? choices.local : choices.remote;
}

function firstChoice(
  choices: readonly SidecarTerminalChoice[],
): SidecarTerminalChoice | undefined {
  for (const choice of choices) return choice;
  return undefined;
}

export function SidecarReplacementPopover({
  defaultRole,
  choices,
  onReplace,
  onBack,
  onClose,
}: {
  defaultRole: AgentTargetRole;
  choices: Record<AgentTargetRole, readonly SidecarTerminalChoice[]>;
  onReplace: (role: AgentTargetRole, sessionId: string) => string | null;
  onBack: () => void;
  onClose: () => void;
}) {
  const [role, setRole] = useState<AgentTargetRole>(defaultRole);
  const [selected, setSelected] = useState(
    firstChoice(choicesForRole(choices, defaultRole))?.id ?? "",
  );
  const [error, setError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const roleChoices = choicesForRole(choices, role);
  const chosen = useMemo(
    () => roleChoices.find((choice) => choice.id === selected) ?? firstChoice(roleChoices),
    [roleChoices, selected],
  );

  useDismissibleLayer(panelRef, onClose);

  const chooseRole = (next: AgentTargetRole) => {
    setRole(next);
    setSelected(firstChoice(choicesForRole(choices, next))?.id ?? "");
    setError(null);
  };

  const handleReplace = () => {
    if (!chosen) return;
    setError(onReplace(role, chosen.id));
  };

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label={S.aiPanel.sidecar.replace}
      className="absolute end-0 top-full z-50 mt-1 w-[310px] rounded-lg border border-border-subtle bg-bg-elevated p-3 shadow-lg"
      onPointerDown={(event) => {
        event.stopPropagation();
      }}
    >
      <div className="mb-3 flex items-center gap-1.5">
        <button
          type="button"
          onClick={onBack}
          className="rounded p-1 text-text-muted hover:bg-bg-hover"
          aria-label="Back to Sidecar menu"
        >
          <ArrowLeft size={12} />
        </button>
        <Link2 size={12} className="text-accent" />
        <span className="text-[12px] font-medium text-text-primary">
          {S.aiPanel.sidecar.replace}
        </span>
        <button
          type="button"
          onClick={onClose}
          className="ms-auto rounded p-1 text-text-muted hover:bg-bg-hover"
          aria-label="Close target replacement"
        >
          <X size={12} />
        </button>
      </div>

      <div className="mb-2 grid grid-cols-2 gap-1 rounded-md bg-bg-primary p-0.5">
        {(["local", "remote"] as const).map((candidateRole) => (
          <button
            key={candidateRole}
            type="button"
            onClick={() => {
              chooseRole(candidateRole);
            }}
            className={`flex items-center justify-center gap-1 rounded px-2 py-1 text-[10px] font-medium ${
              role === candidateRole
                ? "bg-bg-hover text-text-primary"
                : "text-text-muted hover:text-text-secondary"
            }`}
            aria-pressed={role === candidateRole}
          >
            {candidateRole === "remote" ? <Server size={10} /> : <Terminal size={10} />}
            {candidateRole === "remote" ? S.aiPanel.sidecar.remote : S.aiPanel.sidecar.local}
          </button>
        ))}
      </div>

      {roleChoices.length > 0 ? (
        <label className="mb-3 block text-[10px] text-text-muted">
          <span className="mb-1 block font-medium text-text-secondary">Replacement terminal</span>
          <select
            value={chosen ? chosen.id : ""}
            onChange={(event) => {
              setSelected(event.target.value);
              setError(null);
            }}
            className="w-full rounded-md border border-border-subtle bg-bg-primary px-2 py-1.5 text-[11px] text-text-primary outline-none focus:border-accent"
          >
            {roleChoices.map((choice) => (
              <option key={choice.id} value={choice.id}>
                {choice.label} — {choice.detail}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <p className="mb-3 rounded-md border border-border-subtle bg-bg-card px-2 py-1.5 text-[10px] leading-relaxed text-text-muted">
          No live, idle terminal is eligible for this role. If this target owns the transcript,
          recover it in its existing tab or end the Sidecar.
        </p>
      )}

      {error && (
        <p role="alert" className="mb-2 rounded-md bg-error-subtle px-2 py-1.5 text-[10px] text-error">
          {error}
        </p>
      )}

      <button
        type="button"
        disabled={!chosen}
        onClick={handleReplace}
        className="flex w-full items-center justify-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[11px] font-medium text-bg-primary hover:bg-accent-hover disabled:opacity-50"
      >
        <Link2 size={11} />
        {S.aiPanel.sidecar.replace}
      </button>
    </div>
  );
}
