import { ArrowLeft, Database, Eye, Play, ShieldAlert, TerminalSquare, Workflow } from "lucide-react";
import { useEffect, useState } from "react";

import {
  atLeastEvidence,
  defaultRunbookInputs,
  definitionRecordOutput,
  evidenceFloor,
  evidenceModesAtOrAbove,
  runbooksAnsibleStatus,
  type AnsibleRunnerStatus,
  type AnsibleAction,
  type EvidenceMode,
  type RunbookDefinition,
  type RunbookInputDefinition,
} from "../../lib/runbooks";
import { buildRunbookTargetContext, describeRunbookTarget } from "../../hooks/useRunbooks";
import { useAppStore } from "../../stores/appStore";
import { primaryButton, runbookInputClass, secondaryButton } from "./runbookUi";

export function RunbookPreflight({
  definition,
  sessionId,
  packageDigest,
  busy,
  onBack,
  onStart,
}: {
  definition: RunbookDefinition;
  sessionId: string | null;
  packageDigest: string | null;
  busy: boolean;
  onBack(): void;
  onStart(inputs: Record<string, string | number | boolean>, evidence: EvidenceMode): void;
}) {
  // Subscribing to these objects keeps the target summary fresh while the user
  // enters/exits SSH or changes tabs during preflight.
  const session = useAppStore((state) => state.sessions.find((item) => item.id === sessionId));
  const targetUi = useAppStore((state) => (sessionId ? state.sessionUi[sessionId] : undefined));
  const [values, setValues] = useState<Record<string, string | number | boolean>>(() =>
    defaultRunbookInputs(definition),
  );
  // The operator's policy and the package's request together set the least this
  // run may keep. `runbooks_start` applies the same clamp, so this only decides
  // what the picker offers — never what is actually retained.
  const policy = useAppStore((state) => state.runbooksOutputRecording);
  const declared = definitionRecordOutput(definition);
  const floor = evidenceFloor(policy, declared);
  const [requested, setRequested] = useState<EvidenceMode>(floor);
  const evidenceMode = atLeastEvidence(requested, floor);
  const [submitted, setSubmitted] = useState(false);
  const ansibleTarget = definition.spec.target.kind === "ansible-inventory";
  const [runner, setRunner] = useState<AnsibleRunnerStatus | null>(null);

  useEffect(() => {
    if (!ansibleTarget) return;
    void runbooksAnsibleStatus().then(setRunner).catch((error) =>
      setRunner({
        supported: false,
        installed: false,
        path: null,
        version: null,
        error: String(error),
        installUrl: "https://ansible.readthedocs.io/projects/runner/en/latest/install/",
      }),
    );
  }, [ansibleTarget]);

  useEffect(() => {
    setValues(defaultRunbookInputs(definition));
    setSubmitted(false);
  }, [definition]);

  // A package with its own request, or a changed policy, moves the floor. Reset
  // rather than clamp so the control never shows a stale higher choice the
  // operator did not make for THIS runbook.
  useEffect(() => {
    setRequested(floor);
  }, [floor]);

  const choices = evidenceModesAtOrAbove(floor);
  // Name whichever source actually raised the floor, so a greyed-out choice is
  // never unexplained. The policy wins when both would apply.
  const floorReason =
    policy === "all"
      ? "Settings → Runbooks records every run in full."
      : policy === "none"
        ? null
        : declared
          ? `This runbook asks to keep ${declared === "none" ? "no output" : declared === "tail" ? "a redacted tail" : "full artifacts"}.`
          : null;

  const target = (() => {
    if (ansibleTarget) return { context: null, error: null };
    if (!sessionId) return { context: null, error: "Open and select a terminal first." };
    try {
      return { context: buildRunbookTargetContext(sessionId), error: null };
    } catch (error) {
      return { context: null, error: String(error) };
    }
  })();
  // These reads are also the invalidation signal for the imperative context
  // builder above; naming them documents why the subscriptions are present.
  void session;
  void targetUi;

  const inputs = Object.entries(definition.spec.inputs ?? {});
  const ansibleActions = definition.spec.steps.flatMap((step) =>
    [step.check, step.apply, step.verify].filter(
      (action): action is AnsibleAction => action?.uses === "ansible.playbook",
    ),
  );
  const ansibleSelection = ansibleActions[0]?.with;
  const targetReady = ansibleTarget ? runner?.installed === true : target.context !== null;
  const missing = inputs.filter(([name, input]) => {
    if (!input.required) return false;
    const value = values[name];
    return value === undefined || value === null || (typeof value === "string" && !value.trim());
  });

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2">
        <button onClick={onBack} className={secondaryButton}>
          <ArrowLeft size={12} /> Definition
        </button>
        <div className="min-w-0">
          <h2 className="truncate text-[14px] font-semibold text-text-primary">Start preflight</h2>
          <p className="truncate text-[10px] text-text-muted">{definition.metadata.title}</p>
        </div>
      </div>

      <section className="space-y-2 rounded-md border border-border-subtle bg-bg-card p-3">
        <h3 className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-widest text-text-muted">
          {ansibleTarget ? <Workflow size={11} /> : <TerminalSquare size={11} />}
          {ansibleTarget ? "Ansible controller target" : "Active terminal target"}
        </h3>
        {ansibleTarget ? (
          <>
            <p className={`text-[12px] ${runner?.installed ? "text-success" : "text-warning"}`}>
              {runner?.installed
                ? `Ready: Ansible Runner ${runner.version ?? "detected"}`
                : "Execution blocked until Ansible Runner is installed"}
            </p>
            <dl className="grid grid-cols-[82px_1fr] gap-x-2 gap-y-1 font-mono text-[10px]">
              <dt className="text-text-muted">Controller</dt>
              <dd className="truncate text-text-secondary">{runner?.path ?? runner?.error ?? "Checking…"}</dd>
              <dt className="text-text-muted">Inventory</dt>
              <dd className="truncate text-text-secondary">{ansibleSelection?.inventory ?? "implicit localhost"}</dd>
              <dt className="text-text-muted">Limit</dt>
              <dd className="truncate text-text-secondary">{ansibleSelection?.limit ?? "none"}</dd>
              <dt className="text-text-muted">Package</dt>
              <dd className="truncate text-text-secondary" title={packageDigest ?? undefined}>sha256:{packageDigest ?? "unavailable"}</dd>
            </dl>
            <p className="text-[10px] leading-relaxed text-text-muted">
              Project and inventory digests are recomputed from the managed snapshot and locked into the durable run before approval.
            </p>
            {!runner?.installed && runner?.installUrl && (
              <a href={runner.installUrl} target="_blank" rel="noreferrer" className="text-[10px] text-accent hover:underline">
                Official Ansible Runner installation guide
              </a>
            )}
          </>
        ) : target.context ? (
          <>
            <p className="text-[12px] text-text-primary">
              {describeRunbookTarget(target.context)}
            </p>
            <dl className="grid grid-cols-[72px_1fr] gap-x-2 gap-y-1 font-mono text-[10px]">
              <dt className="text-text-muted">Session</dt>
              <dd className="truncate text-text-secondary">{target.context.session_id}</dd>
              <dt className="text-text-muted">Shell</dt>
              <dd className="truncate text-text-secondary">{target.context.shell}</dd>
              <dt className="text-text-muted">Context</dt>
              <dd className="truncate text-text-secondary">
                {target.context.remote_kind
                  ? `${target.context.remote_kind}:${target.context.remote_target ?? "unknown"}`
                  : (target.context.cwd ?? "unknown")}
              </dd>
            </dl>
            <p className="flex items-start gap-1.5 text-[10px] leading-relaxed text-warning">
              <ShieldAlert size={11} className="mt-0.5 shrink-0" />
              This exact visible terminal is bound to the run. Changing its local, SSH or container context pauses execution.
            </p>
          </>
        ) : (
          <p className="text-[11px] text-error">{target.error}</p>
        )}
      </section>

      {inputs.length > 0 && (
        <section className="space-y-3">
          <div>
            <h3 className="text-[10px] font-semibold uppercase tracking-widest text-text-muted">
              Inputs
            </h3>
            <p className="mt-1 text-[10px] text-text-muted">
              V1 accepts non-secret values only. Do not enter passwords, tokens or private keys.
            </p>
          </div>
          {inputs.map(([name, input]) => (
            <RunbookInputField
              key={name}
              name={name}
              definition={input}
              value={values[name]}
              invalid={submitted && missing.some(([missingName]) => missingName === name)}
              onChange={(value) => setValues((current) => ({ ...current, [name]: value }))}
            />
          ))}
        </section>
      )}

      <section className="space-y-2">
        <h3 className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-widest text-text-muted">
          <Eye size={11} /> Evidence capture
        </h3>
        <div
          className="grid gap-1 rounded-md border border-border-subtle bg-bg-card p-1"
          style={{ gridTemplateColumns: `repeat(${choices.length}, minmax(0, 1fr))` }}
        >
          {choices.map((mode) => (
            <button
              key={mode}
              type="button"
              role="radio"
              aria-checked={evidenceMode === mode}
              onClick={() => {
                setRequested(mode);
              }}
              className={`rounded px-2 py-1.5 text-[10px] transition-colors ${
                evidenceMode === mode
                  ? "bg-accent text-bg-primary"
                  : "text-text-muted hover:bg-bg-hover hover:text-text-secondary"
              }`}
            >
              {mode === "none" ? "No output" : mode === "tail" ? "Redacted tail" : "Full artifacts"}
            </button>
          ))}
        </div>
        <p className="text-[10px] leading-relaxed text-text-muted">
          {evidenceMode === "none"
            ? "Only results, timestamps and operator comments are stored."
            : evidenceMode === "tail"
              ? "Up to 8 KiB of redacted output per attempt is stored in the app database."
              : "Redacted output artifacts are capped at 1 MiB per attempt and stored in protected app data."}
        </p>
        {floorReason && (
          <p className="text-[10px] leading-relaxed text-text-muted">
            {floorReason} You can keep more for this run, not less.
          </p>
        )}
      </section>

      <section className="rounded-md border border-border-subtle bg-bg-card p-3">
        <p className="flex items-start gap-1.5 text-[10px] leading-relaxed text-text-muted">
          <Database size={11} className="mt-0.5 shrink-0" />
          The definition snapshot, inputs, checklist transitions, approvals, comments and final report are retained until explicitly deleted. Removing the package later does not remove this history.
        </p>
      </section>

      {submitted && missing.length > 0 && (
        <p className="rounded-md border border-error/30 bg-error/10 px-2 py-1.5 text-[11px] text-error">
          Complete all required inputs before starting.
        </p>
      )}

      <button
        onClick={() => {
          setSubmitted(true);
          if (targetReady && missing.length === 0) onStart(values, evidenceMode);
        }}
        disabled={busy || !targetReady}
        className={`${primaryButton} w-full`}
      >
        <Play size={12} /> {busy ? "Starting…" : "Start runbook"}
      </button>
    </div>
  );
}

function RunbookInputField({
  name,
  definition,
  value,
  invalid,
  onChange,
}: {
  name: string;
  definition: RunbookInputDefinition;
  value: string | number | boolean | undefined;
  invalid: boolean;
  onChange(value: string | number | boolean): void;
}) {
  const label = name;
  const describedBy = `runbook-input-${name}-help`;

  return (
    <label className="block space-y-1">
      <span className="flex items-center justify-between gap-2 text-[11px] text-text-secondary">
        <span>{label}{definition.required ? " *" : ""}</span>
        <span className="font-mono text-[9px] text-text-muted">{definition.type}</span>
      </span>
      {definition.type === "boolean" ? (
        <input
          type="checkbox"
          checked={value === true}
          aria-describedby={describedBy}
          onChange={(event) => onChange(event.target.checked)}
          className="accent-accent"
        />
      ) : definition.type === "enum" ? (
        <select
          value={value === undefined ? "" : String(value)}
          aria-describedby={describedBy}
          onChange={(event) => onChange(coerceInput(event.target.value, definition))}
          className={runbookInputClass}
        >
          <option value="">Select…</option>
          {(definition.values ?? []).map((option) => (
            <option key={String(option)} value={String(option)}>{String(option)}</option>
          ))}
        </select>
      ) : (
        <input
          type={definition.type === "integer" ? "number" : "text"}
          value={value === undefined ? "" : String(value)}
          aria-describedby={describedBy}
          onChange={(event) => onChange(coerceInput(event.target.value, definition))}
          className={`${runbookInputClass} ${invalid ? "border-error" : ""}`}
        />
      )}
      <span id={describedBy} className={`block text-[10px] ${invalid ? "text-error" : "text-text-muted"}`}>
        {invalid ? "Required." : (definition.description ?? "Non-secret input.")}
      </span>
    </label>
  );
}

function coerceInput(value: string, definition: RunbookInputDefinition): string | number | boolean {
  if (definition.type === "integer") {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : value;
  }
  if (definition.type === "boolean") return value === "true";
  return value;
}
