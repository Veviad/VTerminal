import { FolderOpen, Loader2, Plus, Trash2 } from "lucide-react";

import type {
  AnsibleImportInput,
  AnsibleProjectInspection,
  AnsibleRunnerStatus,
  RunbookInputType,
} from "../../lib/runbooks";
import { fieldClass, labelClass } from "./runbookFields";
import { primaryButton, secondaryButton } from "./runbookUi";

const INPUT_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/;
const ANSIBLE_VARIABLE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export interface EditableAnsibleInput
  extends Omit<AnsibleImportInput, "values"> {
  uiKey: number;
  valuesText: string;
  values: string[];
}

interface InputIssues {
  id?: string;
  variable?: string;
  values?: string;
}

function occurrences(values: string[], value: string): number {
  return values.filter((candidate) => candidate === value).length;
}

function inputIssues(
  input: EditableAnsibleInput,
  inputs: EditableAnsibleInput[],
): InputIssues {
  const issues: InputIssues = {};
  if (!input.id) {
    issues.id = "Input ID is required.";
  } else if (!INPUT_ID_PATTERN.test(input.id)) {
    issues.id =
      "Start with a letter and use only letters, digits, underscores, or hyphens.";
  } else if (occurrences(inputs.map((item) => item.id), input.id) > 1) {
    issues.id = "Input IDs must be unique.";
  }

  if (!input.variable) {
    issues.variable = "Ansible variable is required.";
  } else if (!ANSIBLE_VARIABLE_PATTERN.test(input.variable)) {
    issues.variable =
      "Start with a letter or underscore and use only letters, digits, or underscores.";
  } else if (
    occurrences(
      inputs.map((item) => item.variable),
      input.variable,
    ) > 1
  ) {
    issues.variable = "Ansible variables must be unique.";
  }

  if (input.type === "enum") {
    if (input.values.length === 0) {
      issues.values = "Add at least one allowed value.";
    } else if (new Set(input.values).size !== input.values.length) {
      issues.values = "Allowed values must be unique.";
    }
  }
  return issues;
}

export function areAnsibleInputsValid(
  inputs: EditableAnsibleInput[],
): boolean {
  return inputs.every(
    (input) => Object.keys(inputIssues(input, inputs)).length === 0,
  );
}

function parseValues(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function ProjectStage({
  status,
  inspection,
  busy,
  onSelect,
}: {
  status: AnsibleRunnerStatus | null;
  inspection: AnsibleProjectInspection | null;
  busy: boolean;
  onSelect(): void;
}) {
  return (
    <div className="space-y-4">
      <section
        className={`rounded-md border p-3 ${status?.installed ? "border-success/30 bg-success/5" : "border-warning/30 bg-warning/5"}`}
      >
        <p className="text-[11px] font-medium text-text-primary">
          {status?.installed
            ? `Ansible Runner ${status.version ?? "ready"}`
            : "Ansible Runner is not ready"}
        </p>
        <p className="mt-1 break-all font-mono text-[9px] text-text-muted">
          {status?.path ?? status?.error ?? "Checking local controller…"}
        </p>
        {!status?.installed && status?.installUrl && (
          <a
            href={status.installUrl}
            target="_blank"
            rel="noreferrer"
            className="mt-2 inline-block text-[10px] text-accent hover:underline"
          >
            Official installation guide
          </a>
        )}
        <p className="mt-2 text-[10px] text-text-muted">
          Import is allowed without Runner. Execution remains blocked until it
          is installed.
        </p>
      </section>
      <button onClick={onSelect} disabled={busy} className={primaryButton}>
        {busy ? (
          <Loader2 size={12} className="animate-spin" />
        ) : (
          <FolderOpen size={12} />
        )}
        Select project directory
      </button>
      {inspection && (
        <section className="rounded-md border border-border-subtle bg-bg-card p-3 text-[10px]">
          <p className="break-all font-mono text-text-secondary">
            {inspection.projectPath}
          </p>
          <p className="mt-2 text-text-muted">
            {inspection.includedFiles.toLocaleString()} files, {" "}
            {(inspection.totalBytes / 1_048_576).toFixed(1)} MiB. {" "}
            {inspection.excluded.length} excluded.
          </p>
        </section>
      )}
    </div>
  );
}

export function ExecutionStage({
  inspection,
  title,
  id,
  applyPlaybook,
  inventory,
  limit,
  onTitleChange,
  onIdChange,
  onApplyPlaybookChange,
  onInventoryChange,
  onLimitChange,
}: {
  inspection: AnsibleProjectInspection;
  title: string;
  id: string;
  applyPlaybook: string;
  inventory: string;
  limit: string;
  onTitleChange(value: string): void;
  onIdChange(value: string): void;
  onApplyPlaybookChange(value: string): void;
  onInventoryChange(value: string): void;
  onLimitChange(value: string): void;
}) {
  return (
    <div className="space-y-3">
      <label className={labelClass}>
        Runbook title
        <input
          className={fieldClass}
          value={title}
          onChange={(event) => onTitleChange(event.target.value)}
        />
      </label>
      <label className={labelClass}>
        Runbook ID
        <input
          className={fieldClass}
          value={id}
          onChange={(event) => onIdChange(event.target.value)}
        />
      </label>
      <label className={labelClass}>
        Apply playbook
        <select
          className={fieldClass}
          value={applyPlaybook}
          onChange={(event) => onApplyPlaybookChange(event.target.value)}
        >
          {inspection.playbooks.map((path) => (
            <option key={path}>{path}</option>
          ))}
        </select>
      </label>
      <label className={labelClass}>
        Inventory (optional)
        <select
          className={fieldClass}
          value={inventory}
          onChange={(event) => onInventoryChange(event.target.value)}
        >
          <option value="">Implicit localhost inventory</option>
          {inspection.inventoryCandidates.map((path) => (
            <option key={path}>{path}</option>
          ))}
        </select>
      </label>
      <label className={labelClass}>
        Limit (optional)
        <input
          className={fieldClass}
          value={limit}
          onChange={(event) => onLimitChange(event.target.value)}
          placeholder="webservers"
        />
      </label>
      <p className="text-[10px] leading-relaxed text-text-muted">
        Remote hosts are reached through this inventory and Ansible SSH
        settings. Open VTerminal SSH sessions and credentials are not reused.
      </p>
    </div>
  );
}

export function PhasesStage({
  inspection,
  advanced,
  applyPlaybook,
  checkPlaybook,
  verifyPlaybook,
  onAdvancedChange,
  onCheckPlaybookChange,
  onVerifyPlaybookChange,
}: {
  inspection: AnsibleProjectInspection;
  advanced: boolean;
  applyPlaybook: string;
  checkPlaybook: string;
  verifyPlaybook: string;
  onAdvancedChange(value: boolean): void;
  onCheckPlaybookChange(value: string): void;
  onVerifyPlaybookChange(value: string): void;
}) {
  return (
    <div className="space-y-3">
      <label className="flex items-center gap-2 text-[11px] text-text-secondary">
        <input
          type="checkbox"
          checked={advanced}
          onChange={(event) => onAdvancedChange(event.target.checked)}
        />{" "}
        Use separate check and verify playbooks
      </label>
      <p className="text-[10px] text-text-muted">
        Check and verify always run with <code>--check --diff</code>. Apply runs
        normally.
      </p>
      {advanced ? (
        <>
          <label className={labelClass}>
            Check playbook
            <select
              className={fieldClass}
              value={checkPlaybook}
              onChange={(event) =>
                onCheckPlaybookChange(event.target.value)
              }
            >
              {inspection.playbooks.map((path) => (
                <option key={path}>{path}</option>
              ))}
            </select>
          </label>
          <label className={labelClass}>
            Verify playbook
            <select
              className={fieldClass}
              value={verifyPlaybook}
              onChange={(event) =>
                onVerifyPlaybookChange(event.target.value)
              }
            >
              {inspection.playbooks.map((path) => (
                <option key={path}>{path}</option>
              ))}
            </select>
          </label>
        </>
      ) : (
        <p className="rounded-md border border-border-subtle bg-bg-card p-3 text-[11px] text-text-secondary">
          {applyPlaybook} is used for check, apply, and verify.
        </p>
      )}
    </div>
  );
}

export function InputsStage({
  inputs,
  onAdd,
  onChange,
}: {
  inputs: EditableAnsibleInput[];
  onAdd(): void;
  onChange(inputs: EditableAnsibleInput[]): void;
}) {
  const update = (
    uiKey: number,
    mutate: (input: EditableAnsibleInput) => EditableAnsibleInput,
  ) => {
    onChange(
      inputs.map((input) => (input.uiKey === uiKey ? mutate(input) : input)),
    );
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h3 className="text-[11px] font-medium text-text-primary">
            Extra variables
          </h3>
          <p className="text-[10px] text-text-muted">
            Only non-secret values are supported.
          </p>
        </div>
        <button className={secondaryButton} onClick={onAdd}>
          <Plus size={11} /> Add input
        </button>
      </div>
      {inputs.map((input, index) => {
        const issues = inputIssues(input, inputs);
        return (
          <div
            key={input.uiKey}
            className="space-y-2 rounded-md border border-border-subtle bg-bg-card p-2"
          >
            <div className="grid grid-cols-[1fr_1fr_100px_auto] items-start gap-2">
              <label className={labelClass}>
                Input ID
                <input
                  aria-label={`Input ${index + 1} ID`}
                  aria-invalid={Boolean(issues.id)}
                  className={fieldClass}
                  placeholder="runbook_input"
                  value={input.id}
                  onChange={(event) =>
                    update(input.uiKey, (current) => ({
                      ...current,
                      id: event.target.value,
                    }))
                  }
                />
                {issues.id && <span className="text-error">{issues.id}</span>}
              </label>
              <label className={labelClass}>
                Ansible variable
                <input
                  aria-label={`Input ${index + 1} variable`}
                  aria-invalid={Boolean(issues.variable)}
                  className={fieldClass}
                  placeholder="ansible_variable"
                  value={input.variable}
                  onChange={(event) =>
                    update(input.uiKey, (current) => ({
                      ...current,
                      variable: event.target.value,
                    }))
                  }
                />
                {issues.variable && (
                  <span className="text-error">{issues.variable}</span>
                )}
              </label>
              <label className={labelClass}>
                Type
                <select
                  aria-label={`Input ${index + 1} type`}
                  className={fieldClass}
                  value={input.type}
                  onChange={(event) =>
                    update(input.uiKey, (current) => {
                      const type = event.target.value as RunbookInputType;
                      return {
                        ...current,
                        type,
                        values: type === "enum" ? current.values : [],
                        valuesText: type === "enum" ? current.valuesText : "",
                      };
                    })
                  }
                >
                  <option>string</option>
                  <option>path</option>
                  <option>integer</option>
                  <option>boolean</option>
                  <option>enum</option>
                </select>
              </label>
              <button
                aria-label={`Remove input ${index + 1}`}
                onClick={() =>
                  onChange(inputs.filter((item) => item.uiKey !== input.uiKey))
                }
                className="mt-4 text-text-muted hover:text-error"
              >
                <Trash2 size={13} />
              </button>
            </div>
            {input.type === "enum" && (
              <label className={labelClass}>
                Allowed values (comma separated)
                <input
                  aria-label={`Input ${index + 1} allowed values`}
                  aria-invalid={Boolean(issues.values)}
                  className={fieldClass}
                  placeholder="development, staging, production"
                  value={input.valuesText}
                  onChange={(event) => {
                    const valuesText = event.target.value;
                    update(input.uiKey, (current) => ({
                      ...current,
                      valuesText,
                      values: parseValues(valuesText),
                    }));
                  }}
                />
                {issues.values && (
                  <span className="text-error">{issues.values}</span>
                )}
              </label>
            )}
          </div>
        );
      })}
      {inputs.length === 0 && (
        <p className="rounded-md border border-dashed border-border-subtle p-4 text-center text-[10px] text-text-muted">
          No Runbook inputs. The playbook uses its own defaults and
          configuration.
        </p>
      )}
    </div>
  );
}

export function ReviewStage({
  inspection,
  title,
  advanced,
  applyPlaybook,
  checkPlaybook,
  verifyPlaybook,
  inventory,
  limit,
  inputCount,
}: {
  inspection: AnsibleProjectInspection;
  title: string;
  advanced: boolean;
  applyPlaybook: string;
  checkPlaybook: string;
  verifyPlaybook: string;
  inventory: string;
  limit: string;
  inputCount: number;
}) {
  return (
    <div className="space-y-3 text-[11px]">
      <h3 className="text-[13px] font-semibold text-text-primary">{title}</h3>
      <dl className="grid grid-cols-[100px_1fr] gap-2 rounded-md border border-border-subtle bg-bg-card p-3">
        <dt className="text-text-muted">Project</dt>
        <dd className="break-all font-mono text-text-secondary">
          {inspection.projectPath}
        </dd>
        <dt className="text-text-muted">Check</dt>
        <dd className="font-mono text-text-secondary">
          {advanced ? checkPlaybook : applyPlaybook} {" "}
          <span className="text-warning">--check --diff</span>
        </dd>
        <dt className="text-text-muted">Apply</dt>
        <dd className="font-mono text-text-secondary">{applyPlaybook}</dd>
        <dt className="text-text-muted">Verify</dt>
        <dd className="font-mono text-text-secondary">
          {advanced ? verifyPlaybook : applyPlaybook} {" "}
          <span className="text-warning">--check --diff</span>
        </dd>
        <dt className="text-text-muted">Inventory</dt>
        <dd className="font-mono text-text-secondary">
          {inventory || "implicit localhost"}
        </dd>
        <dt className="text-text-muted">Limit</dt>
        <dd className="font-mono text-text-secondary">{limit || "none"}</dd>
        <dt className="text-text-muted">Inputs</dt>
        <dd className="text-text-secondary">{inputCount}</dd>
      </dl>
      <p className="text-[10px] leading-relaxed text-text-muted">
        The original project is never modified. Re-import replaces only
        VTerminal&apos;s managed copy and increments the generated patch version.
      </p>
    </div>
  );
}
