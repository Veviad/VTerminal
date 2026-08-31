import { CalendarClock, History, PencilLine, ListOrdered, X } from "lucide-react";
import { useEffect, useRef } from "react";

import { S } from "../../lib/strings";
import { openRightPanel } from "../../lib/rightPanel";
import { useSchedules } from "../../hooks/useSchedules";
import {
  selectLiveScheduleRuns,
  useScheduleStore,
  type SchedulesView,
} from "../../stores/scheduleStore";
import { ScheduleEditor } from "./ScheduleEditor";
import { ScheduleList } from "./ScheduleList";
import { ScheduleRuns } from "./ScheduleRuns";

export function SchedulesWorkspace() {
  const view = useScheduleStore((s) => s.view);
  const setView = useScheduleStore((s) => s.setView);
  const error = useScheduleStore((s) => s.error);
  const notice = useScheduleStore((s) => s.notice);
  const setError = useScheduleStore((s) => s.setError);
  const setNotice = useScheduleStore((s) => s.setNotice);
  const runsById = useScheduleStore((s) => s.runsById);
  const liveRuns = selectLiveScheduleRuns(runsById);
  const { initialize } = useSchedules();
  const initialized = useRef(false);

  // Deliberately NO `setWorkspaceOpen(true)` here, unlike `RunbooksWorkspace`.
  // With a resolver deciding which aside is mounted, a panel that opens itself
  // can resurrect after `openRightPanel("runbooks")` in a re-mount race.
  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    void initialize();
  }, [initialize]);

  return (
    <aside
      style={{ width: "clamp(440px, 48vw, 760px)" }}
      className="relative flex min-h-0 shrink-0 flex-col border-s border-border-subtle bg-bg-secondary animate-slide-in-right"
      aria-label="Scheduled Actions workspace"
    >
      <header className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-border-subtle px-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex items-center gap-1.5 px-1 text-[11px] font-medium text-text-primary">
            <CalendarClock size={13} className="text-accent" /> {S.schedules.title}
          </span>
          <nav
            className="flex items-center rounded-md border border-border-subtle bg-bg-primary p-0.5"
            aria-label="Scheduled Actions sections"
          >
            <ViewTab
              icon={<ListOrdered size={10} />}
              label={S.schedules.views.list}
              value="list"
              active={view}
              onChange={setView}
            />
            <ViewTab
              icon={<PencilLine size={10} />}
              label={S.schedules.views.editor}
              value="editor"
              active={view}
              onChange={setView}
            />
            <ViewTab
              icon={<History size={10} />}
              label={S.schedules.views.runs}
              value="runs"
              active={view}
              onChange={setView}
              badge={liveRuns.length > 0}
            />
          </nav>
        </div>
        <button
          onClick={() => {
          openRightPanel("ai");
        }}
          title={S.schedules.close}
          aria-label={S.schedules.close}
          className="shrink-0 rounded-md p-1 text-text-muted hover:bg-bg-hover hover:text-text-secondary"
        >
          <X size={14} />
        </button>
      </header>

      {error && (
        <div className="flex shrink-0 items-start justify-between gap-2 border-b border-error/20 bg-error/10 px-3 py-1.5 text-[10px] text-error">
          <span className="min-w-0 break-words">{error}</span>
          <button onClick={() => setError(null)} aria-label="Dismiss error" className="shrink-0">
            <X size={10} />
          </button>
        </div>
      )}
      {notice && (
        <div className="flex shrink-0 items-start justify-between gap-2 border-b border-success/20 bg-success/10 px-3 py-1.5 text-[10px] text-success">
          <span className="min-w-0 break-words">{notice}</span>
          <button onClick={() => setNotice(null)} aria-label="Dismiss notice" className="shrink-0">
            <X size={10} />
          </button>
        </div>
      )}

      {view === "list" ? (
        <ScheduleList />
      ) : view === "editor" ? (
        <ScheduleEditor />
      ) : (
        <ScheduleRuns />
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
  value: SchedulesView;
  active: SchedulesView;
  badge?: boolean;
  onChange: (view: SchedulesView) => void;
}) {
  return (
    <button
      onClick={() => {
        onChange(value);
      }}
      className={`relative flex items-center gap-1 rounded px-2 py-1 text-[10px] transition-colors ${
        active === value
          ? "bg-bg-hover text-text-primary"
          : "text-text-muted hover:text-text-secondary"
      }`}
    >
      {icon} {label}
      {badge && <span className="absolute -end-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-accent" />}
    </button>
  );
}
