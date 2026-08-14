import { FileText, Loader2 } from "lucide-react";
import { useState } from "react";

import {
  runbooksEvidenceRead,
  type RunbookEvidenceContent,
  type RunbookReportEvidence,
} from "../../lib/runbooks";

/** Reads one recorded artifact back on demand.
 *
 * A `full` run writes a redacted artifact per attempt, and until this existed
 * nothing in the app could open one — the report showed only `mode · bytes ·
 * available`, and **Export report** copied files to a folder. Evidence that
 * cannot be read is not proof.
 *
 * Loading is deferred to a click rather than done with the report: a run can
 * hold up to 1 MiB per attempt, and expanding a step should not pull every
 * artifact of every attempt into the webview at once.
 */
export function RunbookEvidenceViewer({
  runId,
  evidence,
}: {
  runId: string;
  evidence: RunbookReportEvidence;
}) {
  const [content, setContent] = useState<RunbookEvidenceContent | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  // `tail` evidence is already inlined with its attempt below, and a pending or
  // missing artifact has nothing to open. Only a stored file is readable.
  const readable = evidence.availability === "complete" && evidence.relative_path !== null;

  const toggle = async () => {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (content || loading) return;
    setLoading(true);
    setError(null);
    try {
      setContent(await runbooksEvidenceRead(runId, evidence.id));
    } catch (cause) {
      setError(String(cause));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-1">
      <p
        className={`text-[9px] ${evidence.availability === "complete" ? "text-text-muted" : "text-warning"}`}
      >
        Evidence · {evidence.mode} · {evidence.bytes} bytes ·{" "}
        {evidence.availability === "complete"
          ? "available"
          : `unavailable (${evidence.availability})`}
      </p>
      {readable && (
        <button
          type="button"
          onClick={() => void toggle()}
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] text-text-muted transition-colors hover:bg-bg-hover hover:text-text-secondary"
        >
          {loading ? <Loader2 size={9} className="animate-spin" /> : <FileText size={9} />}
          {open ? "Hide recorded output" : "View recorded output"}
        </button>
      )}
      {open && error && <p className="text-[9px] text-error">{error}</p>}
      {open && content && !content.available && (
        <p className="text-[9px] text-warning">
          The recorded artifact is no longer readable. It was {content.bytes} bytes when the run
          finished; it is now absent, resized or altered, so it is not shown.
        </p>
      )}
      {open && content?.available && (
        <>
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded border border-border-subtle bg-bg-primary p-2 font-mono text-[9px] text-text-secondary">
            {content.text}
            {content.truncated ? "\n[… output truncated when it was recorded …]" : ""}
          </pre>
          <p className="text-[9px] text-text-muted">
            {content.bytes} bytes recorded
            {content.redacted ? " · secrets redacted before storage" : ""}
            {" · digest re-verified on read"}
          </p>
        </>
      )}
    </div>
  );
}
