import { useEffect, useRef } from "react";
import { Link2Off, Server, Terminal, Unplug } from "lucide-react";
import * as api from "../../lib/tauri";
import { setAiPanelOpen } from "../../lib/aiPanel";
import { abortSession } from "../../lib/ptyExec";
import { ownRecordValue } from "../../lib/records";
import { sessionIdForRole, type AgentTargetRole, type SidecarBinding } from "../../lib/sidecar";
import { collapseHome, resolveSessionTitle } from "../../lib/sessionTitle";
import { S } from "../../lib/strings";
import { useAppStore } from "../../stores/appStore";
import { TerminalPane } from "../terminal/TerminalPane";

const STACK_AT_PX = 640;

export function SidecarWorkspace({ binding }: { binding: SidecarBinding }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const sessions = useAppStore((state) => state.sessions);
  const sessionUi = useAppStore((state) => state.sessionUi);
  const activeSessionId = useAppStore((state) => state.activeSessionId);
  const requestId = useAppStore(
    (state) => ownRecordValue(state.aiStreams, binding.ownerSessionId)?.requestId ?? null,
  );
  const setOrientation = useAppStore((state) => state.setSidecarOrientation);
  const setFocused = useAppStore((state) => state.setSidecarFocusedSession);
  const endSidecar = useAppStore((state) => state.endSidecar);
  const fenceAiGeneration = useAppStore((state) => state.fenceAiGeneration);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const update = () => {
      const orientation = host.clientWidth < STACK_AT_PX ? "vertical" : "horizontal";
      if (useAppStore.getState().sidecarForSession(binding.ownerSessionId)?.splitOrientation !== orientation) {
        setOrientation(binding.ownerSessionId, orientation);
      }
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(host);
    return () => {
      observer.disconnect();
    };
  }, [binding.ownerSessionId, setOrientation]);

  // Identity drift is a hard execution fence. Store reconciliation marks the
  // binding synchronously; this effect retires the provider and any pending PTY
  // waiter before a stale continuation can reach either target.
  useEffect(() => {
    if (!binding.degraded || !requestId) return;
    abortSession(binding.localSessionId, "cancelled");
    abortSession(binding.remoteSessionId, "cancelled");
    fenceAiGeneration(binding.ownerSessionId);
    void api.aiCancel(requestId).catch(() => {});
  }, [binding, fenceAiGeneration, requestId]);

  const vertical = binding.splitOrientation === "vertical";
  const firstRole = binding.paneOrder[0];
  const secondRole = binding.paneOrder[1];

  return (
    <div
      ref={hostRef}
      className={`relative flex min-h-0 flex-1 ${vertical ? "flex-col" : "flex-row"}`}
      data-sidecar-owner={binding.ownerSessionId}
    >
      <SidecarPane
        binding={binding}
        role={firstRole}
        basis={binding.splitRatio}
        sessions={sessions}
        sessionUi={sessionUi}
        activeSessionId={activeSessionId}
        onFocus={(id) => {
          setFocused(binding.ownerSessionId, id);
        }}
      />
      <SidecarDivider binding={binding} />
      <SidecarPane
        binding={binding}
        role={secondRole}
        basis={1 - binding.splitRatio}
        sessions={sessions}
        sessionUi={sessionUi}
        activeSessionId={activeSessionId}
        onFocus={(id) => {
          setFocused(binding.ownerSessionId, id);
        }}
      />
      {binding.degraded && (
        <div className="pointer-events-auto absolute inset-x-2 top-10 z-30 flex flex-wrap items-center justify-center gap-2 rounded-md border border-warning/50 bg-bg-elevated/95 px-3 py-2 text-[11px] text-warning shadow-lg">
          <Unplug size={12} />
          <span>{S.aiPanel.sidecar.degradedHint}</span>
          <button
            onClick={() => {
              setAiPanelOpen(true);
              window.dispatchEvent(
                new CustomEvent("vterminal:open-sidecar", { detail: { replace: true } }),
              );
            }}
            className="rounded border border-warning/40 px-2 py-0.5 hover:bg-warning/10"
          >
            {S.aiPanel.sidecar.replace}
          </button>
          <button
            onClick={() => {
              endSidecar(binding.ownerSessionId);
            }}
            className="flex items-center gap-1 rounded px-2 py-0.5 text-text-secondary hover:bg-bg-hover"
          >
            <Link2Off size={10} /> {S.aiPanel.sidecar.end}
          </button>
        </div>
      )}
    </div>
  );
}

function SidecarPane({
  binding,
  role,
  basis,
  sessions,
  sessionUi,
  activeSessionId,
  onFocus,
}: {
  binding: SidecarBinding;
  role: AgentTargetRole;
  basis: number;
  sessions: ReturnType<typeof useAppStore.getState>["sessions"];
  sessionUi: ReturnType<typeof useAppStore.getState>["sessionUi"];
  activeSessionId: string | null;
  onFocus: (sessionId: string) => void;
}) {
  const sessionId = sessionIdForRole(binding, role);
  const session = sessions.find((candidate) => candidate.id === sessionId);
  const ui = ownRecordValue(sessionUi, sessionId);
  const focused = activeSessionId === sessionId;
  const degraded = binding.degraded?.role === role;
  const roleLabel = role === "local" ? S.aiPanel.sidecar.local : S.aiPanel.sidecar.remote;
  const detail =
    role === "remote"
      ? binding.remoteIdentity.label
      : ui?.cwd
        ? collapseHome(ui.cwd)
        : session
          ? resolveSessionTitle(session, ui)
          : sessionId;
  const focusSession = () => {
    if (session) onFocus(sessionId);
  };

  return (
    <section
      style={{ flexBasis: `${basis * 100}%` }}
      className={`flex min-h-0 min-w-0 flex-col bg-bg-terminal ${
        focused ? "ring-1 ring-inset ring-accent/50" : ""
      }`}
      aria-label={`${roleLabel} terminal ${detail}`}
      onPointerDownCapture={focusSession}
    >
      <button
        onClick={focusSession}
        className={`flex h-8 shrink-0 items-center gap-2 border-b px-2.5 text-start text-[10px] font-medium uppercase tracking-wide transition-colors ${
          focused
            ? "border-accent/40 bg-accent/10 text-accent"
            : "border-border-subtle bg-bg-secondary text-text-muted hover:text-text-secondary"
        }`}
        aria-pressed={focused}
      >
        {role === "remote" ? <Server size={11} /> : <Terminal size={11} />}
        <span>{roleLabel}</span>
        <span aria-hidden="true">·</span>
        <span className="min-w-0 truncate font-mono normal-case tracking-normal text-text-secondary">
          {detail}
        </span>
        <span
          className={`ms-auto flex shrink-0 items-center gap-1 normal-case tracking-normal ${
            degraded ? "text-error" : "text-text-muted"
          }`}
        >
          {degraded ? (
            <Unplug size={10} />
          ) : (
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                role === "remote" ? "bg-warning" : "bg-accent"
              }`}
            />
          )}
          {degraded ? S.aiPanel.sidecar.degraded : S.aiPanel.sidecar.connected}
        </span>
      </button>
      {session ? (
        <TerminalPane
          sessionId={sessionId}
          active={focused}
          visible
          showComposer={false}
          rendererActive
        />
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center px-4 text-center text-[11px] text-text-muted">
          {S.aiPanel.sidecar.degradedHint}
        </div>
      )}
    </section>
  );
}

function SidecarDivider({ binding }: { binding: SidecarBinding }) {
  const setRatio = useAppStore((state) => state.setSidecarRatio);
  const vertical = binding.splitOrientation === "vertical";
  const commit = (ratio: number) => {
    setRatio(binding.ownerSessionId, ratio);
  };

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-label={S.aiPanel.sidecar.divider}
      aria-orientation={vertical ? "horizontal" : "vertical"}
      aria-valuemin={30}
      aria-valuemax={70}
      aria-valuenow={Math.round(binding.splitRatio * 100)}
      onDoubleClick={() => {
        commit(0.5);
      }}
      onKeyDown={(event) => {
        const previous = vertical ? "ArrowUp" : "ArrowLeft";
        const next = vertical ? "ArrowDown" : "ArrowRight";
        if (event.key === previous || event.key === next) {
          event.preventDefault();
          commit(binding.splitRatio + (event.key === previous ? -0.02 : 0.02));
        }
        if (event.key === "Home") commit(0.3);
        if (event.key === "End") commit(0.7);
      }}
      onPointerDown={(event) => {
        event.preventDefault();
        const divider = event.currentTarget;
        const host = divider.parentElement;
        if (!host) return;
        const rect = host.getBoundingClientRect();
        divider.setPointerCapture(event.pointerId);
        const onMove = (move: PointerEvent) => {
          const ratio = vertical
            ? (move.clientY - rect.top) / rect.height
            : (move.clientX - rect.left) / rect.width;
          commit(ratio);
        };
        const onUp = () => {
          divider.releasePointerCapture(event.pointerId);
          divider.removeEventListener("pointermove", onMove);
          divider.removeEventListener("pointerup", onUp);
          divider.removeEventListener("pointercancel", onUp);
        };
        divider.addEventListener("pointermove", onMove);
        divider.addEventListener("pointerup", onUp);
        divider.addEventListener("pointercancel", onUp);
      }}
      className={`relative z-20 shrink-0 bg-transparent outline-none before:absolute before:bg-border-subtle before:content-[''] hover:before:bg-accent/60 focus:before:bg-accent ${
        vertical
          ? "h-2 cursor-row-resize before:inset-x-0 before:top-1/2 before:h-px"
          : "w-2 cursor-col-resize before:inset-y-0 before:left-1/2 before:w-px"
      }`}
    />
  );
}
