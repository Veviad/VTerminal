import { useEffect, useRef, useState } from "react";

import { runbooksReport, type RunbookReport } from "../../lib/runbooks";
import { RunbookReportViewer } from "../runbooks/RunbookReportViewer";
import { secondaryButton } from "./scheduleUi";

/** This marker is written with the durable attempt before the native run starts. */
export function scheduledRunbookReportId(summary: string | null | undefined): string | null {
  return /^Runbook report: ([\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})$/i.exec(summary ?? "")?.[1] ?? null;
}

export function ScheduleRunbookReport({ runId }: { runId: string }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [report, setReport] = useState<RunbookReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const revision = useRef(0);
  useEffect(() => () => { revision.current++; }, []);

  const show = async () => {
    setOpen(true);
    if (report || loading) return;
    const request = ++revision.current;
    setLoading(true);
    setError(null);
    try {
      const result = await runbooksReport(runId);
      if (revision.current === request) setReport(result);
    } catch (reason) {
      if (revision.current === request) setError(String(reason));
    } finally {
      if (revision.current === request) setLoading(false);
    }
  };

  return (
    <div className="space-y-2">
      <button type="button" className={secondaryButton} onClick={() => open ? setOpen(false) : void show()}>
        {open ? "Close runbook report" : "View runbook report"}
      </button>
      {open && <section aria-label="Scheduled runbook report" className="space-y-2 border-t border-border-subtle pt-3">
        {loading && <p role="status" className="text-[10px] text-text-muted">Loading runbook report…</p>}
        {error && <div className="space-y-1">
          <p className="text-[10px] text-error">{error}</p>
          <button type="button" className={secondaryButton} onClick={() => void show()}>Retry loading report</button>
        </div>}
        {report && <RunbookReportViewer report={report} />}
      </section>}
    </div>
  );
}
