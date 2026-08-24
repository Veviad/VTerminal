import { useState } from "react";
import { Server } from "lucide-react";
import { useAppStore } from "../../stores/appStore";
import { useSessions } from "../../hooks/useSessions";
import { useSshHost } from "../../hooks/useSshHost";
import { canConnectHere, connectToHost } from "../../lib/sshConnect";
import { ownRecordValue } from "../../lib/records";
import { describeSshTarget } from "../../lib/ssh";
import { S } from "../../lib/strings";

/**
 * Shown when a tab belongs to a saved host but is NOT currently connected —
 * a restored tab, or one where the user typed `exit`.
 *
 * Deliberately a click, never automatic. Reconnecting N restored tabs at launch
 * would fire N MFA pushes / YubiKey touches / host-key prompts before the user
 * has even looked at the screen, and a "REMOTE HOST IDENTIFICATION HAS CHANGED"
 * warning answered blind is exactly the one you want a human reading.
 */
export function ReconnectBar({ sessionId }: { sessionId: string }) {
  const session = useAppStore((s) => s.sessions.find((x) => x.id === sessionId));
  // Subscribe to the whole per-session UI record, not only `remote`. When ssh
  // exits, the bar first renders while OSC 133 still reports `output`, so the
  // safety gate is (correctly) closed. The following prompt changes `phase`
  // without changing `remote`; subscribing only to `remote` left this render
  // stale and the button disabled forever.
  const sessionUi = useAppStore((s) => ownRecordValue(s.sessionUi, sessionId));
  const remote = sessionUi?.remote;
  const { createSession } = useSessions();
  const [busy, setBusy] = useState(false);

  const hostId = session?.hostId ?? null;
  const show = Boolean(hostId) && !remote && !session?.exited;
  const { host } = useSshHost(show ? hostId : null);

  // The host row may have been deleted since; nothing to reconnect to then.
  if (!show || !host) return null;

  const gate = canConnectHere(sessionId);
  const target = describeSshTarget(host);

  return (
    <div className="pointer-events-auto absolute inset-x-0 bottom-0 z-20 flex items-center justify-between gap-2 overflow-hidden border-t border-border-subtle bg-bg-secondary/95 px-3 py-1.5 text-[11px] text-text-muted">
      <span className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
        <Server aria-hidden="true" className="shrink-0" size={11} />
        <span className="min-w-0 truncate font-mono" title={target}>
          {target} · {S.terminal.notConnected}
        </span>
      </span>
      <button
        onClick={() => {
          setBusy(true);
          void connectToHost(host, "current-tab", createSession, sessionId).finally(() => {
            setBusy(false);
          });
        }}
        disabled={busy || !gate.ok}
        title={gate.ok ? undefined : gate.reason}
        className="shrink-0 rounded-md border border-border-subtle px-2 py-0.5 text-accent transition-colors duration-150 hover:bg-bg-hover disabled:cursor-not-allowed disabled:opacity-60"
      >
        {S.terminal.reconnect}
      </button>
    </div>
  );
}
