import { History, Library, ListChecks, PlayCircle, X } from "lucide-react";
import { useEffect } from "react";

import { useRunbooks } from "../../hooks/useRunbooks";
import { useRunbookStore, type RunbooksView } from "../../stores/runbookStore";
import { RunbookHistory } from "./RunbookHistory";
import { RunbookLibrary } from "./RunbookLibrary";
import { RunbookLiveRun } from "./RunbookLiveRun";

export function RunbooksWorkspace({
  sessionId,
  onClose,
}: {
  sessionId: string | null;
  onClose?(): void;
}) {
  const view = useRunbookStore((state) => state.view);
  const setView = useRunbookStore((state) => state.setView);
  const setWorkspaceOpen = useRunbookStore((state) => state.setWorkspaceOpen);
  const error = useRunbookStore((state) => state.error);
  const notice = useRunbookStore((state) => state.notice);
  const setError = useRunbookStore((state) => state.setError);
  const setNotice = useRunbookStore((state) => state.setNotice);
  const run = useRunbookStore((state) => state.activeRun);
  const { initialize } = useRunbooks();

  useEffect(() => {
    setWorkspaceOpen(true);
    void initialize();
  }, [initialize, setWorkspaceOpen]);

  const close = () => {
    setWorkspaceOpen(false);
    onClose?.();
  };

  return (
    <aside
      style={{ width: "clamp(440px, 48vw, 760px)" }}
      className="relative flex min-h-0 shrink-0 flex-col border-s border-border-subtle bg-bg-secondary animate-slide-in-right"
      aria-label="Runbooks workspace"
    >
      <header className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-border-subtle px-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex items-center gap-1.5 px-1 text-[11px] font-medium text-text-primary">
            <ListChecks size={13} className="text-accent" /> Runbooks
          </span>
          <nav className="flex items-center rounded-md border border-border-subtle bg-bg-primary p-0.5" aria-label="Runbooks sections">
            <ViewTab icon={<Library size={10} />} label="Library" value="library" active={view} onChange={setView} />
            <ViewTab
              icon={<PlayCircle size={10} />}
              label="Run"
              value="run"
              active={view}
              onChange={setView}
              badge={!!run && !["succeeded", "completed_with_exceptions", "failed", "cancelled"].includes(run.status)}
            />
            <ViewTab icon={<History size={10} />} label="History" value="history" active={view} onChange={setView} />
          </nav>
        </div>
        <button
          onClick={close}
          title="Close Runbooks"
          aria-label="Close Runbooks"
          className="shrink-0 rounded-md p-1 text-text-muted hover:bg-bg-hover hover:text-text-secondary"
        >
          <X size={14} />
        </button>
      </header>

      {error && (
        <div className="flex shrink-0 items-start justify-between gap-2 border-b border-error/20 bg-error/10 px-3 py-1.5 text-[10px] text-error">
          <span className="min-w-0 break-words">{error}</span>
          <button onClick={() => setError(null)} aria-label="Dismiss error" className="shrink-0"><X size={10} /></button>
        </div>
      )}
      {notice && (
        <div className="flex shrink-0 items-start justify-between gap-2 border-b border-success/20 bg-success/10 px-3 py-1.5 text-[10px] text-success">
          <span className="min-w-0 break-words">{notice}</span>
          <button onClick={() => setNotice(null)} aria-label="Dismiss notice" className="shrink-0"><X size={10} /></button>
        </div>
      )}

      {view === "library" ? (
        <RunbookLibrary sessionId={sessionId} />
      ) : view === "run" ? (
        <RunbookLiveRun sessionId={sessionId} />
      ) : (
        <RunbookHistory />
      )}
    </aside>
  );
}

function ViewTab({
  icon,
  label,
  value,
  active,
  badge = false,
  onChange,
}: {
  icon: React.ReactNode;
  label: string;
  value: RunbooksView;
  active: RunbooksView;
  badge?: boolean;
  onChange(view: RunbooksView): void;
}) {
  return (
    <button
      onClick={() => onChange(value)}
      className={`relative flex items-center gap-1 rounded px-2 py-1 text-[10px] transition-colors ${
        active === value ? "bg-bg-hover text-text-primary" : "text-text-muted hover:text-text-secondary"
      }`}
    >
      {icon} {label}
      {badge && <span className="absolute -end-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-accent" />}
    </button>
  );
}
