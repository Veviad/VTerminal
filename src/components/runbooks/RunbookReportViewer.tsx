import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleSlash,
  Download,
  FileJson,
  RotateCcw,
  ShieldCheck,
  TriangleAlert,
  XCircle,
} from "lucide-react";
import { useState } from "react";

import {
  chooseRunbookExportFolder,
  isCheckedStepState,
  type RunbookReport,
  type RunbookReportChecklistItem,
} from "../../lib/runbooks";
import { RunbookEvidenceViewer } from "./RunbookEvidenceViewer";
import { useRunbooks } from "../../hooks/useRunbooks";
import { useRunbookStore } from "../../stores/runbookStore";
import {
  formatRunbookDuration,
  humanizeRunbookState,
  primaryButton,
  runStateTone,
  secondaryButton,
  stepStateTone,
} from "./runbookUi";

function AnsibleHostOutcomes({ value }: { value: unknown }) {
  if (!value || typeof value !== "object" || !("hosts" in value)) return null;
  const hosts = (value as {
    hosts?: Record<string, Partial<Record<"ok" | "changed" | "failed" | "unreachable" | "skipped", number>>>;
  }).hosts;
  if (!hosts || typeof hosts !== "object") return null;
  return (
    <div className="mt-2 overflow-x-auto rounded border border-border-subtle">
      <table className="w-full text-left text-[9px] text-text-secondary">
        <thead className="bg-bg-secondary text-text-muted">
          <tr><th className="px-2 py-1">Host</th><th>OK</th><th>Changed</th><th>Failed</th><th>Unreachable</th><th>Skipped</th></tr>
        </thead>
        <tbody>
          {Object.entries(hosts).map(([host, outcome]) => (
            <tr key={host} className="border-t border-border-subtle">
              <td className="px-2 py-1 font-mono">{host}</td>
              <td>{outcome.ok ?? 0}</td><td>{outcome.changed ?? 0}</td><td>{outcome.failed ?? 0}</td>
              <td>{outcome.unreachable ?? 0}</td><td>{outcome.skipped ?? 0}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function RunbookReportViewer({
  report,
  onRerun,
}: {
  report: RunbookReport;
  onRerun?(): void;
}) {
  const busyAction = useRunbookStore((state) => state.busyAction);
  const { exportReport } = useRunbooks();
  const [showJson, setShowJson] = useState(false);

  const exportBundle = async () => {
    const destination = await chooseRunbookExportFolder();
    if (destination) await exportReport(report.run_id, destination);
  };

  const alreadyCompliant = report.checklist.filter((item) => item.state === "already_compliant").length;
  const changed = report.checklist.filter((item) => item.changed).length;
  const checked = report.checklist.filter((item) => item.checked || isCheckedStepState(item.state)).length;

  return (
    <div className="space-y-5">
      <section className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-[15px] font-semibold text-text-primary">Run report</h2>
              <span className={`rounded border px-1.5 py-0.5 text-[9px] ${runStateTone(report.result)}`}>
                {humanizeRunbookState(report.result)}
              </span>
            </div>
            <p className="mt-0.5 font-mono text-[10px] text-text-muted">
              {report.definition.id} · v{report.definition.version} · {report.run_id}
            </p>
          </div>
          <div className="flex gap-1.5">
            {onRerun && (
              <button onClick={onRerun} className={secondaryButton}>
                <RotateCcw size={11} /> Run again
              </button>
            )}
            <button
              onClick={() => void exportBundle()}
              disabled={busyAction === "export"}
              className={primaryButton}
            >
              <Download size={11} /> {busyAction === "export" ? "Exporting…" : "Export report"}
            </button>
          </div>
        </div>
        <p className="text-[11px] leading-relaxed text-text-secondary">
          {report.executive_summary || "No executive summary was generated."}
        </p>
      </section>

      <section className="grid grid-cols-4 gap-2">
        <Metric label="Checked" value={`${checked}/${report.checklist.length}`} />
        <Metric label="Already compliant" value={String(alreadyCompliant)} />
        <Metric label="Changed" value={String(changed)} />
        <Metric label="Duration" value={formatRunbookDuration(report.duration_ms)} />
      </section>

      <section className="space-y-2 rounded-md border border-border-subtle bg-bg-card p-3">
        <h3 className="text-[10px] font-semibold uppercase tracking-widest text-text-muted">
          Provenance
        </h3>
        <dl className="grid grid-cols-[92px_1fr] gap-x-2 gap-y-1 font-mono text-[9px]">
          <dt className="text-text-muted">YAML digest</dt>
          <dd className="break-all text-text-secondary">{report.definition.yaml_sha256}</dd>
          <dt className="text-text-muted">JSON digest</dt>
          <dd className="break-all text-text-secondary">{report.definition.canonical_json_sha256}</dd>
          <dt className="text-text-muted">Started</dt>
          <dd className="text-text-secondary">{report.started_at ?? "—"}</dd>
          <dt className="text-text-muted">Finished</dt>
          <dd className="text-text-secondary">{report.finished_at}</dd>
          {report.model && (
            <>
              <dt className="text-text-muted">Model</dt>
              <dd className="text-text-secondary">{report.model}</dd>
            </>
          )}
          {report.resumes.map((resume, index) => (
            <div key={`${resume.resumed_at}-${index}`} className="contents">
              <dt className="text-text-muted">Resume {index + 1}</dt>
              <dd className="text-text-secondary">
                {resume.resumed_at} · app {resume.app_version} · {resume.model ?? "no model"}
              </dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="space-y-2">
        <h3 className="text-[10px] font-semibold uppercase tracking-widest text-text-muted">
          Checklist
        </h3>
        <div className="space-y-2">
          {report.checklist.map((item, index) => (
            <ReportStep
              key={item.step_id}
              item={item}
              index={index}
              runId={report.run_id}
            />
          ))}
        </div>
      </section>

      {report.approvals.length > 0 && (
        <section className="space-y-2">
          <h3 className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-widest text-text-muted">
            <ShieldCheck size={11} /> Approvals
          </h3>
          <div className="divide-y divide-border-subtle overflow-hidden rounded-md border border-border-subtle bg-bg-card">
            {report.approvals.map((approval) => (
              <div key={approval.approval_id} className="space-y-1 px-3 py-2 text-[10px]">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-text-secondary">{approval.step_id} · {approval.phase}</span>
                  <span className="text-text-muted">{humanizeRunbookState(approval.decision)}</span>
                </div>
                {approval.executed_command && (
                  <code className="block overflow-x-auto whitespace-pre rounded bg-bg-primary px-2 py-1 font-mono text-[9px] text-text-secondary">
                    {approval.executed_command}
                  </code>
                )}
                {approval.proposed_command && approval.proposed_command !== approval.executed_command && (
                  <p className="text-[9px] text-warning">Edited from: {approval.proposed_command}</p>
                )}
                {approval.reason && (
                  <p className="text-[9px] text-text-muted">{approval.reason}</p>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {(report.exceptions.length > 0 || report.unresolved_risks.length > 0) && (
        <section className="space-y-2 rounded-md border border-warning/30 bg-warning/5 p-3">
          <h3 className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-widest text-warning">
            <TriangleAlert size={11} /> Exceptions and unresolved risks
          </h3>
          <ul className="space-y-1 text-[10px] leading-relaxed text-text-secondary">
            {[...report.exceptions, ...report.unresolved_risks].map((item, index) => (
              <li key={index}>• {item}</li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <button onClick={() => setShowJson((shown) => !shown)} className={secondaryButton}>
          <FileJson size={11} /> Canonical JSON {showJson ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        </button>
        {showJson && (
          <pre className="mt-2 max-h-80 overflow-auto rounded-md border border-border-subtle bg-bg-primary p-3 font-mono text-[9px] leading-relaxed text-text-secondary">
            {JSON.stringify(report.canonical, null, 2)}
          </pre>
        )}
      </section>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border-subtle bg-bg-card p-2 text-center">
      <p className="font-mono text-[12px] text-text-primary">{value}</p>
      <p className="text-[9px] text-text-muted">{label}</p>
    </div>
  );
}

function ReportStep({
  item,
  index,
  runId,
}: {
  item: RunbookReportChecklistItem;
  index: number;
  runId: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const checked = item.checked || isCheckedStepState(item.state);
  return (
    <article className="overflow-hidden rounded-md border border-border-subtle bg-bg-card">
      <button
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-start gap-2 px-3 py-2 text-start hover:bg-bg-hover"
      >
        {checked ? (
          <CheckCircle2 size={13} className="mt-0.5 shrink-0 text-success" />
        ) : item.state === "waived" || item.state === "skipped" ? (
          <CircleSlash size={13} className="mt-0.5 shrink-0 text-warning" />
        ) : (
          <XCircle size={13} className={`mt-0.5 shrink-0 ${stepStateTone(item.state)}`} />
        )}
        <span className="min-w-0 flex-1">
          <span className="block text-[11px] text-text-primary">{index + 1}. {item.title}</span>
          <span className={`block text-[9px] ${stepStateTone(item.state)}`}>
            {humanizeRunbookState(item.state)}
            {item.changed ? " · changed" : ""}
            {item.assurance ? ` · ${humanizeRunbookState(item.assurance)}` : ""}
          </span>
        </span>
        {expanded ? <ChevronDown size={11} className="text-text-muted" /> : <ChevronRight size={11} className="text-text-muted" />}
      </button>
      {expanded && (
        <div className="space-y-2 border-t border-border-subtle px-3 py-2">
          {item.summary && <p className="text-[10px] leading-relaxed text-text-secondary">{item.summary}</p>}
          {item.operator_comment && (
            <p className="text-[10px] leading-relaxed text-text-muted">Operator: {item.operator_comment}</p>
          )}
          {item.exception && <p className="text-[10px] text-warning">{item.exception}</p>}
          {item.evidence.length > 0 && (
            <div className="space-y-1">
              {item.evidence.map((evidence) => (
                <RunbookEvidenceViewer key={evidence.id} runId={runId} evidence={evidence} />
              ))}
            </div>
          )}
          {item.attempts.map((attempt) => (
            <div key={attempt.attempt_id} className="rounded border border-border-subtle bg-bg-primary p-2">
              <div className="flex items-center justify-between gap-2 text-[9px] text-text-muted">
                <span>{attempt.phase} · {attempt.executor}</span>
                <span>{attempt.exit_code === null || attempt.exit_code === undefined ? attempt.status : `exit ${attempt.exit_code}`}</span>
              </div>
              {attempt.executed_command && (
                <code className="mt-1 block overflow-x-auto whitespace-pre font-mono text-[9px] text-text-secondary">
                  {attempt.executed_command}
                </code>
              )}
              {attempt.structured_outcomes != null && <AnsibleHostOutcomes value={attempt.structured_outcomes} />}
              {attempt.output_tail && (
                <pre className="mt-1 max-h-36 overflow-auto whitespace-pre-wrap font-mono text-[9px] text-text-secondary">
                  {attempt.output_tail}{attempt.output_truncated ? "\n[… output truncated …]" : ""}
                </pre>
              )}
              {(attempt.output_observed_bytes !== undefined || attempt.output_captured_bytes !== undefined) && (
                <p className="mt-1 text-[9px] text-text-muted">
                  Captured {attempt.output_captured_bytes ?? 0} of {attempt.output_observed_bytes ?? 0} bytes
                  {attempt.output_redacted ? " · redacted" : ""}
                </p>
              )}
              {attempt.error && <p className="mt-1 text-[9px] text-error">{attempt.error}</p>}
            </div>
          ))}
        </div>
      )}
    </article>
  );
}
