import { useEffect, useRef, useState } from "react";

import { defaultRunbookInputs, runbooksGetDefinition, runbooksList, type RunbookDefinition, type RunbookSource } from "../../lib/runbooks";
import type { ScheduleRunbook, ScheduleRunbookApproval } from "../../lib/schedules";
import { Field } from "../ui/Row";
import { scheduleInputClass, secondaryButton } from "./scheduleUi";

const approvalDescriptions: Record<ScheduleRunbookApproval, string> = {
  none: "No automatic approval. A phase that requires approval stops the scheduled run and records the reason.",
  read_only: "Automatically approve read-only commands without network or elevated privileges. Other commands stop the run.",
  all: "Automatically approve every command permitted by this runbook. No employee approval is required. Manual steps and unresolved results still stop the run.",
};

export function ScheduleRunbookPicker({
  value,
  onChange,
  error,
}: {
  value: ScheduleRunbook;
  onChange(value: ScheduleRunbook): void;
  error?: string;
}) {
  const [sources, setSources] = useState<RunbookSource[]>([]);
  const [definition, setDefinition] = useState<RunbookDefinition | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshRevision, setRefreshRevision] = useState(0);
  const latest = useRef({ value, onChange });
  latest.current = { value, onChange };
  const pendingDefaults = useRef<string | null>(null);

  useEffect(() => {
    let active = true;
    void runbooksList().then((items) => {
      if (active) setSources(items.filter((source) => source.state === "valid"));
    }).catch((reason) => { if (active) setLoadError(String(reason)); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    setDefinition(null);
    if (!value.source_id) return;
    let active = true;
    void runbooksGetDefinition(value.source_id).then((item) => {
      if (!active) return;
      setDefinition(item);
      if (pendingDefaults.current === value.source_id) {
        pendingDefaults.current = null;
        const current = latest.current;
        current.onChange({ ...current.value, inputs: { ...defaultRunbookInputs(item), ...current.value.inputs } });
      }
    }).catch((reason) => { if (active) setLoadError(String(reason)); });
    return () => { active = false; };
  }, [value.source_id, refreshRevision]);

  const selected = sources.find((source) => source.source_id === value.source_id);
  const digestChanged = selected && selected.canonical_sha256 !== value.canonical_sha256;

  const selectSource = (sourceId: string) => {
    const source = sources.find((item) => item.source_id === sourceId);
    if (!source?.canonical_sha256) return;
    setLoadError(null);
    pendingDefaults.current = sourceId;
    setRefreshRevision((revision) => revision + 1);
    // Clear the previous package's inputs and standing approval immediately.
    onChange({ source_id: sourceId, canonical_sha256: source.canonical_sha256, inputs: {}, approval: "none" });
  };

  return (
    <section className="space-y-3 rounded-md border border-border-subtle bg-bg-card p-2.5">
      <Field label="Runbook" error={error}>
        <select
          value={value.source_id}
          onChange={(event) => selectSource(event.target.value)}
          aria-label="Scheduled runbook"
          className={scheduleInputClass}
        >
          <option value="">Select a published runbook…</option>
          {value.source_id && !selected && <option value={value.source_id}>Unavailable runbook ({value.source_id})</option>}
          {sources.map((source) => (
            <option key={source.source_id} value={source.source_id} disabled={!source.canonical_sha256}>
              {source.title ?? source.definition_id} · v{source.version}
            </option>
          ))}
        </select>
      </Field>
      <p className="text-[10px] text-text-muted">
        This task runs the selected definition in the background on the target above. The definition is pinned; a changed runbook must be selected and approved again.
      </p>
      {digestChanged && <div className="space-y-1">
        <p className="text-[10px] text-warning">This runbook has changed. Review and authorize the new definition before it can run again.</p>
        <button type="button" className={secondaryButton} onClick={() => selectSource(value.source_id)}>Use current definition</button>
      </div>}
      {definition?.spec.target.kind === "ansible-inventory" && <p className="text-[10px] text-warning">Scheduled runbooks require an active-terminal definition. Select a shell runbook.</p>}
      {loadError && <p className="text-[10px] text-error">{loadError}</p>}
      {definition && Object.entries(definition.spec.inputs ?? {}).map(([name, input]) => {
        const current = Object.entries(value.inputs).find(([key]) => key === name)?.[1];
        const update = (next: string | number | boolean) => onChange({ ...value, inputs: { ...value.inputs, [name]: next } });
        return (
          <Field key={name} label={`${name}${input.required ? " *" : ""}`} hint={input.description ?? undefined}>
            {input.type === "boolean" ? (
              <input aria-label={`Runbook input ${name}`} type="checkbox" checked={current === true} onChange={(event) => update(event.target.checked)} className="accent-accent" />
            ) : input.type === "enum" ? (
              <select aria-label={`Runbook input ${name}`} className={scheduleInputClass} value={current === undefined ? "" : String(current)} onChange={(event) => update(event.target.value)}>
                <option value="">Select…</option>
                {(input.values ?? []).map((option) => <option key={option} value={option}>{option}</option>)}
              </select>
            ) : (
              <input aria-label={`Runbook input ${name}`} className={scheduleInputClass} type={input.type === "integer" ? "number" : "text"} value={current === undefined ? "" : String(current)} onChange={(event) => {
                const raw = event.target.value;
                update(input.type === "integer" && raw.trim() && Number.isInteger(Number(raw)) ? Number(raw) : raw);
              }} />
            )}
          </Field>
        );
      })}
      <Field label="Runbook automatic approval" hint={approvalDescriptions[value.approval]}>
        <select
          aria-label="Runbook automatic approval"
          value={value.approval}
          onChange={(event) => onChange({ ...value, approval: event.target.value as ScheduleRunbookApproval })}
          className={`${scheduleInputClass} ${value.approval === "all" ? "border-warning/50 text-warning" : ""}`}
        >
          <option value="none">No automatic approval</option>
          <option value="read_only">Approve read-only commands</option>
          <option value="all">Approve all runbook commands</option>
        </select>
      </Field>
    </section>
  );
}
