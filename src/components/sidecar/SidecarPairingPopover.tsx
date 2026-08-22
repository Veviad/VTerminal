import { useRef, useState, type ReactNode } from "react";
import { Link2, Server, ShieldCheck, Terminal, X } from "lucide-react";
import { useDismissibleLayer } from "../../hooks/useDismissibleLayer";
import { S } from "../../lib/strings";

export interface SidecarTerminalChoice {
  id: string;
  label: string;
  detail: string;
}

function firstChoiceId(choices: readonly SidecarTerminalChoice[]): string {
  for (const choice of choices) return choice.id;
  return "";
}

function initialChoiceId(
  preferredId: string | null,
  choices: readonly SidecarTerminalChoice[],
): string {
  return preferredId === null ? firstChoiceId(choices) : preferredId;
}

export function SidecarPairingPopover({
  localChoices,
  remoteChoices,
  defaultLocalId,
  defaultRemoteId,
  onStart,
  onOpenHosts,
  onClose,
}: {
  localChoices: readonly SidecarTerminalChoice[];
  remoteChoices: readonly SidecarTerminalChoice[];
  defaultLocalId: string | null;
  defaultRemoteId: string | null;
  /** Return a validation error to keep the dialog open and explain the race. */
  onStart: (localSessionId: string, remoteSessionId: string) => string | null;
  onOpenHosts: () => void;
  onClose: () => void;
}) {
  const [localId, setLocalId] = useState(initialChoiceId(defaultLocalId, localChoices));
  const [remoteId, setRemoteId] = useState(initialChoiceId(defaultRemoteId, remoteChoices));
  const [error, setError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useDismissibleLayer(panelRef, onClose);

  const canStart = Boolean(localId && remoteId && localId !== remoteId);

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label={S.aiPanel.sidecar.title}
      className="absolute end-0 top-full z-50 mt-1 w-[310px] rounded-lg border border-border-subtle bg-bg-elevated p-3 shadow-lg"
      onPointerDown={(event) => {
        event.stopPropagation();
      }}
    >
      <div className="mb-3 flex items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-1.5 text-[12px] font-medium text-text-primary">
            <Link2 size={13} className="text-accent" />
            {S.aiPanel.sidecar.title}
          </div>
          <p className="mt-1 text-[10px] leading-relaxed text-text-muted">
            {S.aiPanel.sidecar.safety}
          </p>
        </div>
        <button
          onClick={onClose}
          className="rounded p-1 text-text-muted hover:bg-bg-hover hover:text-text-secondary"
          aria-label="Close Sidecar setup"
        >
          <X size={12} />
        </button>
      </div>

      <ChoiceRow
        icon={<Terminal size={12} />}
        label={S.aiPanel.sidecar.localTerminal}
        value={localId}
        choices={localChoices}
        emptyLabel={S.aiPanel.sidecar.noLocal}
        onChange={(value) => {
          setError(null);
          setLocalId(value);
        }}
      />
      <ChoiceRow
        icon={<Server size={12} />}
        label={S.aiPanel.sidecar.sshTerminal}
        value={remoteId}
        choices={remoteChoices}
        emptyLabel={S.aiPanel.sidecar.noRemote}
        onChange={(value) => {
          setError(null);
          setRemoteId(value);
        }}
      />

      {remoteChoices.length === 0 && (
        <button
          onClick={() => {
            onOpenHosts();
            onClose();
          }}
          className="mb-2 w-full rounded-md border border-border-subtle px-2 py-1.5 text-[11px] text-accent transition-colors hover:bg-bg-hover"
        >
          {S.aiPanel.sidecar.openHosts}
        </button>
      )}

      <div className="mb-3 flex items-start gap-1.5 rounded-md bg-bg-card px-2 py-1.5 text-[10px] leading-relaxed text-text-muted">
        <ShieldCheck size={11} className="mt-0.5 shrink-0 text-accent" />
        <span>Both targets begin in Confirm. Nothing connects or runs automatically.</span>
      </div>

      {error && (
        <p role="alert" className="mb-2 rounded-md bg-error-subtle px-2 py-1.5 text-[10px] text-error">
          {error}
        </p>
      )}

      <button
        onClick={() => {
          if (!canStart) return;
          setError(onStart(localId, remoteId));
        }}
        disabled={!canStart}
        className="flex w-full items-center justify-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[11px] font-medium text-bg-primary transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Link2 size={12} />
        {S.aiPanel.sidecar.start}
      </button>
    </div>
  );
}

function ChoiceRow({
  icon,
  label,
  value,
  choices,
  emptyLabel,
  onChange,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  choices: readonly SidecarTerminalChoice[];
  emptyLabel: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="mb-2 block text-[10px] text-text-muted">
      <span className="mb-1 flex items-center gap-1.5 font-medium text-text-secondary">
        {icon}
        {label}
      </span>
      {choices.length > 0 ? (
        <select
          value={value}
          onChange={(event) => {
            onChange(event.target.value);
          }}
          className="w-full rounded-md border border-border-subtle bg-bg-primary px-2 py-1.5 text-[11px] text-text-primary outline-none focus:border-accent"
        >
          {choices.map((choice) => (
            <option key={choice.id} value={choice.id}>
              {choice.label} — {choice.detail}
            </option>
          ))}
        </select>
      ) : (
        <span className="block rounded-md border border-border-subtle bg-bg-card px-2 py-1.5 leading-relaxed">
          {emptyLabel}
        </span>
      )}
    </label>
  );
}
