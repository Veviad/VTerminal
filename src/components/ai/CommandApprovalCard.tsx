import { useState } from "react";
import { Hourglass, Play, ServerCog, SkipForward, Square, Terminal } from "lucide-react";
import { S } from "../../lib/strings";

export function CommandApprovalCard({
  command,
  explanation,
  target,
  remote,
  targetRole = remote ? "remote" : "local",
  queuedSteers = 0,
  askedBecause = null,
  onRespond,
}: {
  command: string;
  explanation: string;
  /** Where this will run — a remote host, or the local cwd. */
  target: string | null;
  remote: boolean;
  /** Explicit in sidecar mode; inferred from `remote` for single-session cards. */
  targetRole?: "local" | "remote";
  /** Why this card is up even though an auto mode is armed. Null when the mode
   *  asks about everything, where no explanation is owed. Without it the "Reads"
   *  mode looks broken every time it correctly stops for a write. */
  askedBecause?: "network" | "writes" | null;
  /** Messages the user typed while this card was up. The loop is parked on this
   *  gate and only appends them once the round ends, so the wait is real and has
   *  to be visible — otherwise it reads as the app ignoring them. */
  queuedSteers?: number;
  onRespond: (decision: "run" | "skip" | "stop", editedCommand?: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [edited, setEdited] = useState(command);
  // One response per card — the backend oneshot is consumed by the first one,
  // so later clicks would silently fail and desync the UI.
  const [responded, setResponded] = useState(false);
  const changed = edited.trim() !== command.trim();
  const empty = edited.trim() === "";
  const targetLabel = target ?? (targetRole === "remote" ? "remote shell" : S.aiPanel.localShell);
  const runLabel =
    targetRole === "remote"
      ? `Run on ${targetLabel.replace(/^ssh\s+/, "")}`
      : "Run locally";

  const respond = (decision: "run" | "skip" | "stop", editedCommand?: string) => {
    if (responded) return;
    setResponded(true);
    onRespond(decision, editedCommand);
  };

  return (
    <div
      className={`rounded-lg border bg-bg-card p-3 ${
        targetRole === "remote" ? "border-warning/50" : "border-accent/40"
      } ${responded ? "opacity-80" : ""}`}
      aria-label={`${targetRole === "remote" ? "Remote" : "Local"} command approval for ${targetLabel}`}
    >
      {/* Where it lands. Commands now run in the real terminal — which may be
          SSH'd into a production host — so this is a safety affordance, not
          decoration. */}
      <div
        className={`mb-2 flex items-center gap-1.5 text-[10px] ${
          targetRole === "remote" ? "text-warning" : "text-accent"
        }`}
      >
        {targetRole === "remote" ? <ServerCog size={11} /> : <Terminal size={11} />}
        <span className="font-semibold uppercase tracking-wide">
          {targetRole === "remote" ? "Remote" : "Local"}
        </span>
        <span aria-hidden="true">·</span>
        <span className="truncate font-mono">{targetLabel}</span>
      </div>
      {askedBecause && (
        <p className="mb-2 text-[10px] text-text-muted">{S.aiPanel.askedBecause[askedBecause]}</p>
      )}
      {editing ? (
        <textarea
          value={edited}
          onChange={(e) => setEdited(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              setEditing(false);
            }
          }}
          autoFocus
          rows={Math.min(5, edited.split("\n").length + 1)}
          className="w-full rounded-md bg-bg-terminal px-2 py-1.5 font-mono text-[12px] text-text-primary"
        />
      ) : (
        <button
          onClick={() => !responded && setEditing(true)}
          className="w-full rounded-md bg-bg-terminal px-2 py-1.5 text-start font-mono text-[12px] text-text-primary transition-colors duration-100 hover:bg-bg-hover"
          title={S.aiPanel.editHint}
        >
          {edited || <span className="text-text-muted">(empty)</span>}
        </button>
      )}
      {explanation && <p className="mt-1.5 text-[11px] text-text-muted">{explanation}</p>}
      <div className="mt-2 flex items-center gap-2">
        <button
          onClick={() => respond("run", changed ? edited : undefined)}
          disabled={responded || empty}
          title={empty ? "Command is empty — nothing to run" : undefined}
          className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1 text-[12px] font-medium text-bg-primary transition-colors duration-150 hover:bg-accent-hover disabled:opacity-60"
        >
          <Play size={11} />
          {runLabel}
        </button>
        <button
          onClick={() => respond("skip")}
          disabled={responded}
          className="flex items-center gap-1.5 rounded-md px-3 py-1 text-[12px] text-text-muted transition-colors duration-150 hover:bg-bg-hover hover:text-text-secondary disabled:opacity-60"
        >
          <SkipForward size={11} />
          {S.aiPanel.skip}
        </button>
        <button
          onClick={() => respond("stop")}
          disabled={responded}
          className="flex items-center gap-1.5 rounded-md px-3 py-1 text-[12px] text-error transition-colors duration-150 hover:bg-error-subtle disabled:opacity-60"
        >
          <Square size={11} />
          {S.aiPanel.stop}
        </button>
        {changed && !empty && <span className="text-[10px] text-warning">edited</span>}
      </div>
      {/* Skip & send is the escape hatch from the wait: it resolves the gate the
          user is looking at, which ends the round, which is what lets the loop
          deliver their message. Still their decision — nothing auto-skips. */}
      {queuedSteers > 0 && !responded && (
        <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-border-subtle pt-2 text-[10px] text-text-muted">
          <Hourglass size={10} />
          <span>
            {queuedSteers === 1
              ? S.aiPanel.steerWaitingOne
              : `${queuedSteers} ${S.aiPanel.steerWaitingMany}`}
          </span>
          <button
            onClick={() => respond("skip")}
            title={S.aiPanel.steerSkipAndSendHint}
            className="rounded-md border border-border-subtle px-1.5 py-0.5 text-text-secondary transition-colors duration-150 hover:bg-bg-hover"
          >
            {S.aiPanel.steerSkipAndSend}
          </button>
        </div>
      )}
    </div>
  );
}
