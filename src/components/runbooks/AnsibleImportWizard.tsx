import {
  ArrowLeft,
  ArrowRight,
  Check,
  FolderOpen,
  Loader2,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";

import {
  runbooksAnsibleImport,
  runbooksAnsibleInspect,
  runbooksAnsibleStatus,
  selectAnsibleProjectDirectory,
  type AnsibleImportInput,
  type AnsibleProjectInspection,
  type AnsibleRunnerStatus,
  type RunbookInputType,
  type RunbookSource,
} from "../../lib/runbooks";
import { fieldClass, labelClass } from "./runbookFields";
import { primaryButton, secondaryButton } from "./runbookUi";

const stages = ["Project", "Execution", "Phases", "Inputs", "Review"] as const;

function definitionId(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  const leaf = parts[parts.length - 1] ?? "ansible-project";
  const normalized = leaf
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "ansible-project";
}

export function AnsibleImportWizard({
  onImported,
}: {
  onImported(source: RunbookSource): Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [stage, setStage] = useState(0);
  const [status, setStatus] = useState<AnsibleRunnerStatus | null>(null);
  const [inspection, setInspection] = useState<AnsibleProjectInspection | null>(null);
  const [title, setTitle] = useState("");
  const [id, setId] = useState("");
  const [applyPlaybook, setApplyPlaybook] = useState("");
  const [inventory, setInventory] = useState("");
  const [limit, setLimit] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [checkPlaybook, setCheckPlaybook] = useState("");
  const [verifyPlaybook, setVerifyPlaybook] = useState("");
  const [inputs, setInputs] = useState<AnsibleImportInput[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    void runbooksAnsibleStatus().then(setStatus).catch((reason) => setError(String(reason)));
  }, [open]);

  const reset = () => {
    setOpen(false);
    setStage(0);
    setInspection(null);
    setInputs([]);
    setError(null);
  };

  const selectProject = async () => {
    const path = await selectAnsibleProjectDirectory();
    if (!path) return;
    setBusy(true);
    setError(null);
    try {
      const next = await runbooksAnsibleInspect(path);
      setInspection(next);
      const nextId = definitionId(next.projectPath);
      setId(nextId);
      setTitle(nextId.replace(/[-_]+/g, " ").replace(/\b\w/g, (value) => value.toUpperCase()));
      const playbook = next.playbooks[0] ?? "";
      setApplyPlaybook(playbook);
      setCheckPlaybook(playbook);
      setVerifyPlaybook(playbook);
      setInventory(next.inventoryCandidates[0] ?? "");
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  const importProject = async () => {
    if (!inspection) return;
    setBusy(true);
    setError(null);
    try {
      const source = await runbooksAnsibleImport({
        projectPath: inspection.projectPath,
        definitionId: id,
        title,
        applyPlaybook,
        checkPlaybook: advanced ? checkPlaybook : null,
        verifyPlaybook: advanced ? verifyPlaybook : null,
        inventory: inventory || null,
        limit: limit.trim() || null,
        inputs,
      });
      await onImported(source);
      reset();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  const canContinue =
    (stage !== 0 || inspection !== null) &&
    (stage !== 1 || (!!title.trim() && !!id.trim() && !!applyPlaybook)) &&
    (stage !== 2 || !advanced || (!!checkPlaybook && !!verifyPlaybook)) &&
    (stage !== 3 || inputs.every((input) => !!input.id.trim() && !!input.variable.trim()));

  return (
    <>
      <button onClick={() => setOpen(true)} className={`${secondaryButton} min-w-0 flex-1`}>
        <FolderOpen size={12} /> Import Ansible
      </button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-5">
          <div className="flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-border-subtle bg-bg-primary shadow-2xl">
            <header className="flex items-start justify-between gap-3 border-b border-border-subtle p-4">
              <div>
                <h2 className="text-[15px] font-semibold text-text-primary">Import Ansible project</h2>
                <p className="mt-1 text-[10px] text-text-muted">
                  VTerminal copies a safe snapshot and creates a terminal-free Runbook.
                </p>
              </div>
              <button onClick={reset} aria-label="Close Ansible import" className="text-text-muted hover:text-text-primary">
                <X size={16} />
              </button>
            </header>

            <div className="grid grid-cols-5 border-b border-border-subtle bg-bg-card">
              {stages.map((name, index) => (
                <div key={name} className={`px-2 py-2 text-center text-[9px] ${index === stage ? "text-accent" : "text-text-muted"}`}>
                  {index + 1}. {name}
                </div>
              ))}
            </div>

            <main className="min-h-0 flex-1 overflow-y-auto p-4">
              {stage === 0 && (
                <div className="space-y-4">
                  <section className={`rounded-md border p-3 ${status?.installed ? "border-success/30 bg-success/5" : "border-warning/30 bg-warning/5"}`}>
                    <p className="text-[11px] font-medium text-text-primary">
                      {status?.installed ? `Ansible Runner ${status.version ?? "ready"}` : "Ansible Runner is not ready"}
                    </p>
                    <p className="mt-1 break-all font-mono text-[9px] text-text-muted">
                      {status?.path ?? status?.error ?? "Checking local controller…"}
                    </p>
                    {!status?.installed && status?.installUrl && (
                      <a href={status.installUrl} target="_blank" rel="noreferrer" className="mt-2 inline-block text-[10px] text-accent hover:underline">
                        Official installation guide
                      </a>
                    )}
                    <p className="mt-2 text-[10px] text-text-muted">
                      Import is allowed without Runner. Execution remains blocked until it is installed.
                    </p>
                  </section>
                  <button onClick={() => void selectProject()} disabled={busy} className={primaryButton}>
                    {busy ? <Loader2 size={12} className="animate-spin" /> : <FolderOpen size={12} />}
                    Select project directory
                  </button>
                  {inspection && (
                    <section className="rounded-md border border-border-subtle bg-bg-card p-3 text-[10px]">
                      <p className="break-all font-mono text-text-secondary">{inspection.projectPath}</p>
                      <p className="mt-2 text-text-muted">
                        {inspection.includedFiles.toLocaleString()} files, {(inspection.totalBytes / 1_048_576).toFixed(1)} MiB. {inspection.excluded.length} excluded.
                      </p>
                    </section>
                  )}
                </div>
              )}

              {stage === 1 && inspection && (
                <div className="space-y-3">
                  <label className={labelClass}>Runbook title<input className={fieldClass} value={title} onChange={(event) => setTitle(event.target.value)} /></label>
                  <label className={labelClass}>Runbook ID<input className={fieldClass} value={id} onChange={(event) => setId(event.target.value)} /></label>
                  <label className={labelClass}>Apply playbook<select className={fieldClass} value={applyPlaybook} onChange={(event) => setApplyPlaybook(event.target.value)}>{inspection.playbooks.map((path) => <option key={path}>{path}</option>)}</select></label>
                  <label className={labelClass}>Inventory (optional)<select className={fieldClass} value={inventory} onChange={(event) => setInventory(event.target.value)}><option value="">Implicit localhost inventory</option>{inspection.inventoryCandidates.map((path) => <option key={path}>{path}</option>)}</select></label>
                  <label className={labelClass}>Limit (optional)<input className={fieldClass} value={limit} onChange={(event) => setLimit(event.target.value)} placeholder="webservers" /></label>
                  <p className="text-[10px] leading-relaxed text-text-muted">
                    Remote hosts are reached through this inventory and Ansible SSH settings. Open VTerminal SSH sessions and credentials are not reused.
                  </p>
                </div>
              )}

              {stage === 2 && inspection && (
                <div className="space-y-3">
                  <label className="flex items-center gap-2 text-[11px] text-text-secondary"><input type="checkbox" checked={advanced} onChange={(event) => setAdvanced(event.target.checked)} /> Use separate check and verify playbooks</label>
                  <p className="text-[10px] text-text-muted">Check and verify always run with <code>--check --diff</code>. Apply runs normally.</p>
                  {advanced ? (
                    <>
                      <label className={labelClass}>Check playbook<select className={fieldClass} value={checkPlaybook} onChange={(event) => setCheckPlaybook(event.target.value)}>{inspection.playbooks.map((path) => <option key={path}>{path}</option>)}</select></label>
                      <label className={labelClass}>Verify playbook<select className={fieldClass} value={verifyPlaybook} onChange={(event) => setVerifyPlaybook(event.target.value)}>{inspection.playbooks.map((path) => <option key={path}>{path}</option>)}</select></label>
                    </>
                  ) : (
                    <p className="rounded-md border border-border-subtle bg-bg-card p-3 text-[11px] text-text-secondary">{applyPlaybook} is used for check, apply, and verify.</p>
                  )}
                </div>
              )}

              {stage === 3 && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <div><h3 className="text-[11px] font-medium text-text-primary">Extra variables</h3><p className="text-[10px] text-text-muted">Only non-secret values are supported.</p></div>
                    <button className={secondaryButton} onClick={() => setInputs((current) => [...current, { id: "", variable: "", type: "string", required: false, values: [] }])}><Plus size={11} /> Add input</button>
                  </div>
                  {inputs.map((input, index) => (
                    <div key={index} className="grid grid-cols-[1fr_1fr_100px_auto] gap-2 rounded-md border border-border-subtle bg-bg-card p-2">
                      <input aria-label={`Input ${index + 1} ID`} className={fieldClass} placeholder="runbook_input" value={input.id} onChange={(event) => setInputs((current) => current.map((item, at) => at === index ? { ...item, id: event.target.value } : item))} />
                      <input aria-label={`Input ${index + 1} variable`} className={fieldClass} placeholder="ansible_variable" value={input.variable} onChange={(event) => setInputs((current) => current.map((item, at) => at === index ? { ...item, variable: event.target.value } : item))} />
                      <select aria-label={`Input ${index + 1} type`} className={fieldClass} value={input.type} onChange={(event) => setInputs((current) => current.map((item, at) => at === index ? { ...item, type: event.target.value as RunbookInputType } : item))}><option>string</option><option>path</option><option>integer</option><option>boolean</option><option>enum</option></select>
                      <button aria-label={`Remove input ${index + 1}`} onClick={() => setInputs((current) => current.filter((_, at) => at !== index))} className="text-text-muted hover:text-error"><Trash2 size={13} /></button>
                    </div>
                  ))}
                  {inputs.length === 0 && <p className="rounded-md border border-dashed border-border-subtle p-4 text-center text-[10px] text-text-muted">No Runbook inputs. The playbook uses its own defaults and configuration.</p>}
                </div>
              )}

              {stage === 4 && inspection && (
                <div className="space-y-3 text-[11px]">
                  <h3 className="text-[13px] font-semibold text-text-primary">{title}</h3>
                  <dl className="grid grid-cols-[100px_1fr] gap-2 rounded-md border border-border-subtle bg-bg-card p-3">
                    <dt className="text-text-muted">Project</dt><dd className="break-all font-mono text-text-secondary">{inspection.projectPath}</dd>
                    <dt className="text-text-muted">Check</dt><dd className="font-mono text-text-secondary">{advanced ? checkPlaybook : applyPlaybook} <span className="text-warning">--check --diff</span></dd>
                    <dt className="text-text-muted">Apply</dt><dd className="font-mono text-text-secondary">{applyPlaybook}</dd>
                    <dt className="text-text-muted">Verify</dt><dd className="font-mono text-text-secondary">{advanced ? verifyPlaybook : applyPlaybook} <span className="text-warning">--check --diff</span></dd>
                    <dt className="text-text-muted">Inventory</dt><dd className="font-mono text-text-secondary">{inventory || "implicit localhost"}</dd>
                    <dt className="text-text-muted">Limit</dt><dd className="font-mono text-text-secondary">{limit || "none"}</dd>
                    <dt className="text-text-muted">Inputs</dt><dd className="text-text-secondary">{inputs.length}</dd>
                  </dl>
                  <p className="text-[10px] leading-relaxed text-text-muted">The original project is never modified. Re-import replaces only VTerminal's managed copy and increments the generated patch version.</p>
                </div>
              )}

              {error && <p className="mt-4 rounded-md border border-error/30 bg-error/10 p-2 text-[10px] text-error">{error}</p>}
            </main>

            <footer className="flex items-center justify-between border-t border-border-subtle p-3">
              <button onClick={() => setStage((value) => Math.max(0, value - 1))} disabled={stage === 0 || busy} className={secondaryButton}><ArrowLeft size={11} /> Back</button>
              {stage < stages.length - 1 ? (
                <button onClick={() => setStage((value) => value + 1)} disabled={!canContinue || busy} className={primaryButton}>Continue <ArrowRight size={11} /></button>
              ) : (
                <button onClick={() => void importProject()} disabled={busy} className={primaryButton}>{busy ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />} {busy ? "Importing…" : "Import Runbook"}</button>
              )}
            </footer>
          </div>
        </div>
      )}
    </>
  );
}
