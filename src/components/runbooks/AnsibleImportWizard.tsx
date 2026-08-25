import {
  ArrowLeft,
  ArrowRight,
  Check,
  FolderOpen,
  Loader2,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  runbooksAnsibleImport,
  runbooksAnsibleInspect,
  runbooksAnsibleStatus,
  selectAnsibleProjectDirectory,
  type AnsibleImportInput,
  type AnsibleProjectInspection,
  type AnsibleRunnerStatus,
  type RunbookSource,
} from "../../lib/runbooks";
import {
  areAnsibleInputsValid,
  ExecutionStage,
  InputsStage,
  PhasesStage,
  ProjectStage,
  ReviewStage,
  type EditableAnsibleInput,
} from "./AnsibleImportWizardStages";
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
  const [inputs, setInputs] = useState<EditableAnsibleInput[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nextInputKey = useRef(0);

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
        inputs: inputs.map(
          (input): AnsibleImportInput => ({
            id: input.id,
            variable: input.variable,
            type: input.type,
            description: input.description,
            required: input.required,
            default: input.default,
            values: input.type === "enum" ? input.values : [],
          }),
        ),
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
    (stage !== 3 || areAnsibleInputsValid(inputs));

  const addInput = () => {
    nextInputKey.current += 1;
    setInputs((current) => [
      ...current,
      {
        uiKey: nextInputKey.current,
        valuesText: "",
        id: "",
        variable: "",
        type: "string",
        required: false,
        values: [],
      },
    ]);
  };

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
                <ProjectStage
                  status={status}
                  inspection={inspection}
                  busy={busy}
                  onSelect={() => void selectProject()}
                />
              )}

              {stage === 1 && inspection && (
                <ExecutionStage
                  inspection={inspection}
                  title={title}
                  id={id}
                  applyPlaybook={applyPlaybook}
                  inventory={inventory}
                  limit={limit}
                  onTitleChange={setTitle}
                  onIdChange={setId}
                  onApplyPlaybookChange={setApplyPlaybook}
                  onInventoryChange={setInventory}
                  onLimitChange={setLimit}
                />
              )}

              {stage === 2 && inspection && (
                <PhasesStage
                  inspection={inspection}
                  advanced={advanced}
                  applyPlaybook={applyPlaybook}
                  checkPlaybook={checkPlaybook}
                  verifyPlaybook={verifyPlaybook}
                  onAdvancedChange={setAdvanced}
                  onCheckPlaybookChange={setCheckPlaybook}
                  onVerifyPlaybookChange={setVerifyPlaybook}
                />
              )}

              {stage === 3 && (
                <InputsStage
                  inputs={inputs}
                  onAdd={addInput}
                  onChange={setInputs}
                />
              )}

              {stage === 4 && inspection && (
                <ReviewStage
                  inspection={inspection}
                  title={title}
                  advanced={advanced}
                  applyPlaybook={applyPlaybook}
                  checkPlaybook={checkPlaybook}
                  verifyPlaybook={verifyPlaybook}
                  inventory={inventory}
                  limit={limit}
                  inputCount={inputs.length}
                />
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
