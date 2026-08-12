import { useCallback, useEffect, useMemo, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { FileDown, KeyRound, Pencil, Plus, Server, Trash2 } from "lucide-react";
import * as api from "../../lib/tauri";
import { useAppStore } from "../../stores/appStore";
import { useSessions } from "../../hooks/useSessions";
import { buildSshCommand, describeSshTarget, validateSshHost } from "../../lib/ssh";
import { connectToHost } from "../../lib/sshConnect";
import { S } from "../../lib/strings";
import { Field, inputClass } from "../ui/Row";
import type { SshConfigCandidate, SshHost, SshHostInput } from "../../lib/types";

const EMPTY: SshHostInput = {
  label: "",
  hostname: "",
  username: null,
  port: null,
  identity_file: null,
  jump_host: null,
  extra_args: null,
  remote_dir: null,
  post_connect: null,
  tag: null,
  color: null,
};

/** Stateful, unlike the scalar save-on-change sections — a host record needs
 *  create/cancel/validate semantics. ModelsSettings is the precedent. */
export function SshHostsSection() {
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);
  const { createSession } = useSessions();
  const [hosts, setHosts] = useState<SshHost[]>([]);
  const [editing, setEditing] = useState<SshHost | "new" | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [importing, setImporting] = useState<SshConfigCandidate[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setHosts(await api.sshHostsList());
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const onSave = async (draft: SshHostInput) => {
    setError(null);
    try {
      if (editing === "new") await api.sshHostsCreate(draft);
      else if (editing) await api.sshHostsUpdate(editing.id, draft);
      setEditing(null);
      await reload();
    } catch (e) {
      setError(String(e));
    }
  };

  const onDelete = async (id: string) => {
    setError(null);
    try {
      await api.sshHostsDelete(id);
      setConfirmDelete(null);
      await reload();
    } catch (e) {
      setError(String(e));
    }
  };

  const onScan = async () => {
    setError(null);
    try {
      setImporting(await api.sshHostsScanConfig());
    } catch (e) {
      setError(String(e));
    }
  };

  const onImport = async (selected: SshHostInput[]) => {
    setError(null);
    try {
      await api.sshHostsImport(selected);
      setImporting(null);
      await reload();
    } catch (e) {
      setError(String(e));
    }
  };

  if (importing) {
    return (
      <ImportReview
        candidates={importing}
        error={error}
        onImport={onImport}
        onCancel={() => {
          setImporting(null);
          setError(null);
        }}
      />
    );
  }

  if (editing) {
    return (
      <HostForm
        initial={editing === "new" ? EMPTY : editing}
        error={error}
        onSave={onSave}
        onCancel={() => {
          setEditing(null);
          setError(null);
        }}
      />
    );
  }

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <h3 className="text-[10px] font-semibold uppercase tracking-widest text-text-muted">
          {S.settings.sshHosts.title}
        </h3>
        <p className="text-[11px] leading-relaxed text-text-secondary">
          {S.settings.sshHosts.intro}
        </p>

        {error && (
          <p className="rounded-md border border-error/30 bg-error/10 px-2 py-1.5 text-[11px] text-error">
            {error}
          </p>
        )}

        {hosts.length === 0 && (
          <p className="rounded-md border border-border-subtle bg-bg-card px-3 py-4 text-center text-[11px] text-text-muted">
            {S.settings.sshHosts.empty}
          </p>
        )}

        <div className="space-y-1">
          {hosts.map((h) => (
            <div
              key={h.id}
              className="flex items-center gap-2 rounded-md border border-border-subtle bg-bg-card px-2.5 py-2"
            >
              <Server size={12} className="shrink-0 text-text-muted" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[12px] text-text-primary">{h.label}</p>
                <p className="truncate font-mono text-[10px] text-text-muted">
                  {describeSshTarget(h)}
                  {h.tag ? ` · ${h.tag}` : ""}
                  {" · "}
                  {h.use_count > 0 ? `${h.use_count} ${S.settings.sshHosts.uses}` : S.settings.sshHosts.neverUsed}
                </p>
              </div>
              <button
                onClick={() => {
                  void connectToHost(h, "new-tab", createSession);
                  setSettingsOpen(false);
                }}
                className="rounded-md px-2 py-1 text-[11px] text-accent hover:bg-bg-hover"
              >
                {S.settings.sshHosts.connect}
              </button>
              <button
                onClick={() => setEditing(h)}
                className="rounded-md p-1 text-text-muted hover:bg-bg-hover hover:text-text-secondary"
                title={S.settings.sshHosts.edit}
              >
                <Pencil size={12} />
              </button>
              <button
                onClick={() =>
                  confirmDelete === h.id ? void onDelete(h.id) : setConfirmDelete(h.id)
                }
                onBlur={() => setConfirmDelete(null)}
                className={`rounded-md p-1 hover:bg-bg-hover ${
                  confirmDelete === h.id ? "text-error" : "text-text-muted hover:text-text-secondary"
                }`}
                title={confirmDelete === h.id ? S.settings.sshHosts.confirmRemove : S.settings.sshHosts.remove}
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>

        <div className="flex gap-2">
          <button
            onClick={() => setEditing("new")}
            className="flex items-center gap-1.5 rounded-md border border-border-subtle bg-bg-card px-2.5 py-1.5 text-[12px] text-text-secondary hover:bg-bg-hover"
          >
            <Plus size={12} />
            {S.settings.sshHosts.add}
          </button>
          <button
            onClick={() => void onScan()}
            className="flex items-center gap-1.5 rounded-md border border-border-subtle bg-bg-card px-2.5 py-1.5 text-[12px] text-text-secondary hover:bg-bg-hover"
          >
            <FileDown size={12} />
            {S.settings.sshHosts.importOpen}
          </button>
        </div>
      </section>

      <section className="flex gap-2 rounded-md border border-border-subtle bg-bg-secondary px-3 py-2.5">
        <KeyRound size={12} className="mt-0.5 shrink-0 text-text-muted" />
        <p className="text-[10px] leading-relaxed text-text-muted">
          {S.settings.sshHosts.keyAuthHint}
        </p>
      </section>
    </div>
  );
}

function HostForm({
  initial,
  error,
  onSave,
  onCancel,
}: {
  initial: SshHostInput;
  error: string | null;
  onSave(draft: SshHostInput): void;
  onCancel(): void;
}) {
  const [draft, setDraft] = useState<SshHostInput>(initial);
  const [touched, setTouched] = useState(false);

  const errors = useMemo(() => validateSshHost(draft), [draft]);
  const errorFor = (field: string) => errors.find((e) => e.field === field)?.message;
  const preview = useMemo(() => {
    try {
      return buildSshCommand(draft);
    } catch {
      return "";
    }
  }, [draft]);

  const set = <K extends keyof SshHostInput>(key: K, value: SshHostInput[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));
  const setText = (key: keyof SshHostInput, value: string) =>
    set(key, (value.trim() === "" ? null : value) as SshHostInput[typeof key]);

  const pickIdentity = async () => {
    const picked = await openDialog({ multiple: false, directory: false });
    if (typeof picked === "string") set("identity_file", picked);
  };

  return (
    <div className="space-y-5">
      <h3 className="text-[10px] font-semibold uppercase tracking-widest text-text-muted">
        {initial.label ? S.settings.sshHosts.edit : S.settings.sshHosts.add}
      </h3>

      {error && (
        <p className="rounded-md border border-error/30 bg-error/10 px-2 py-1.5 text-[11px] text-error">
          {error}
        </p>
      )}

      <Field label={S.settings.sshHosts.label} hint={S.settings.sshHosts.labelHint} error={touched ? errorFor("label") : undefined}>
        <input
          value={draft.label}
          onChange={(e) => set("label", e.target.value)}
          placeholder="Production web"
          className={inputClass}
        />
      </Field>

      <div className="grid grid-cols-[1fr_auto] gap-3">
        <Field label={S.settings.sshHosts.hostname} error={touched ? errorFor("hostname") : undefined}>
          <input
            value={draft.hostname}
            onChange={(e) => set("hostname", e.target.value)}
            placeholder="prod-01.example.com"
            className={`${inputClass} font-mono`}
          />
        </Field>
        <Field label={S.settings.sshHosts.port} error={touched ? errorFor("port") : undefined}>
          <input
            type="number"
            value={draft.port ?? ""}
            onChange={(e) => set("port", e.target.value === "" ? null : Number(e.target.value))}
            placeholder="22"
            className={`${inputClass} w-20 font-mono`}
          />
        </Field>
      </div>

      <Field label={S.settings.sshHosts.username} error={touched ? errorFor("username") : undefined}>
        <input
          value={draft.username ?? ""}
          onChange={(e) => setText("username", e.target.value)}
          placeholder="deploy"
          className={`${inputClass} font-mono`}
        />
      </Field>

      <Field label={S.settings.sshHosts.identityFile} hint={S.settings.sshHosts.identityFileHint}>
        <div className="flex gap-2">
          <input
            value={draft.identity_file ?? ""}
            onChange={(e) => setText("identity_file", e.target.value)}
            placeholder="~/.ssh/id_ed25519"
            className={`${inputClass} font-mono`}
          />
          <button
            onClick={() => void pickIdentity()}
            className="shrink-0 rounded-md border border-border-subtle bg-bg-card px-2 text-[11px] text-text-secondary hover:bg-bg-hover"
          >
            {S.settings.sshHosts.chooseFile}
          </button>
        </div>
      </Field>

      <Field label={S.settings.sshHosts.jumpHost} hint={S.settings.sshHosts.jumpHostHint}>
        <input
          value={draft.jump_host ?? ""}
          onChange={(e) => setText("jump_host", e.target.value)}
          placeholder="jump@bastion"
          className={`${inputClass} font-mono`}
        />
      </Field>

      <Field label={S.settings.sshHosts.remoteDir} hint={S.settings.sshHosts.remoteDirHint}>
        <input
          value={draft.remote_dir ?? ""}
          onChange={(e) => setText("remote_dir", e.target.value)}
          placeholder="/srv/app"
          className={`${inputClass} font-mono`}
        />
      </Field>

      <Field label={S.settings.sshHosts.postConnect} hint={S.settings.sshHosts.postConnectHint} error={touched ? errorFor("post_connect") : undefined}>
        <input
          value={draft.post_connect ?? ""}
          onChange={(e) => setText("post_connect", e.target.value)}
          placeholder="tmux attach || tmux new -s main"
          className={`${inputClass} font-mono`}
        />
      </Field>

      <Field label={S.settings.sshHosts.extraArgs} hint={S.settings.sshHosts.extraArgsHint} error={touched ? errorFor("extra_args") : undefined}>
        <input
          value={draft.extra_args ?? ""}
          onChange={(e) => setText("extra_args", e.target.value)}
          placeholder="-o ConnectTimeout=5"
          className={`${inputClass} font-mono`}
        />
      </Field>

      <Field label={S.settings.sshHosts.tag}>
        <input
          value={draft.tag ?? ""}
          onChange={(e) => setText("tag", e.target.value)}
          placeholder="production"
          className={inputClass}
        />
      </Field>

      {/* The most useful element on this form: the literal bytes that will be
          typed. It makes the quoting rules self-documenting and turns a rejected
          option into something the user can see rather than guess at. */}
      <section className="space-y-1">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-text-muted">
          {S.settings.sshHosts.preview}
        </p>
        <pre className="overflow-x-auto rounded-md border border-border-subtle bg-bg-secondary px-2.5 py-2 font-mono text-[11px] text-text-secondary">
          {preview}
        </pre>
        <p className="text-[10px] text-text-muted">{S.settings.sshHosts.previewHint}</p>
        {touched && errorFor("command") && (
          <p className="text-[10px] text-error">{errorFor("command")}</p>
        )}
      </section>

      <div className="flex gap-2">
        <button
          onClick={() => {
            setTouched(true);
            if (errors.length === 0) onSave(draft);
          }}
          disabled={touched && errors.length > 0}
          className="rounded-md bg-accent px-3 py-1.5 text-[12px] font-medium text-bg-primary disabled:opacity-60"
        >
          {S.settings.sshHosts.save}
        </button>
        <button
          onClick={onCancel}
          className="rounded-md border border-border-subtle px-3 py-1.5 text-[12px] text-text-secondary hover:bg-bg-hover"
        >
          {S.settings.sshHosts.cancel}
        </button>
      </div>
    </div>
  );
}

/** The review step. Rows that would duplicate something already saved start
 *  unchecked, so re-importing after adding one host is a no-op by default. */
function ImportReview({
  candidates,
  error,
  onImport,
  onCancel,
}: {
  candidates: SshConfigCandidate[];
  error: string | null;
  onImport(hosts: SshHostInput[]): void;
  onCancel(): void;
}) {
  const [checked, setChecked] = useState<Set<number>>(
    () => new Set(candidates.map((c, i) => (c.existing_id ? -1 : i)).filter((i) => i >= 0)),
  );

  const toggle = (i: number) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });

  const newCount = candidates.filter((c) => !c.existing_id).length;

  return (
    <div className="space-y-4">
      <h3 className="text-[10px] font-semibold uppercase tracking-widest text-text-muted">
        {S.settings.sshHosts.importTitle}
      </h3>

      {error && (
        <p className="rounded-md border border-error/30 bg-error/10 px-2 py-1.5 text-[11px] text-error">
          {error}
        </p>
      )}

      {candidates.length === 0 ? (
        <p className="rounded-md border border-border-subtle bg-bg-card px-3 py-4 text-center text-[11px] text-text-muted">
          {S.settings.sshHosts.importNone}
        </p>
      ) : (
        <>
          <p className="text-[11px] text-text-secondary">
            {candidates.length} {S.settings.sshHosts.importFound} · {newCount}{" "}
            {S.settings.sshHosts.importNew}
          </p>
          <div className="max-h-[320px] space-y-1 overflow-y-auto">
            {candidates.map((c, i) => (
              <label
                key={`${c.host.config_alias ?? c.host.label}-${i}`}
                className="flex cursor-pointer items-center gap-2 rounded-md border border-border-subtle bg-bg-card px-2.5 py-2"
              >
                <input
                  type="checkbox"
                  checked={checked.has(i)}
                  onChange={() => toggle(i)}
                  className="accent-accent"
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[12px] text-text-primary">{c.host.label}</p>
                  <p className="truncate font-mono text-[10px] text-text-muted">
                    {describeSshTarget(c.host)}
                    {c.host.identity_file ? ` · -i ${c.host.identity_file}` : ""}
                    {c.host.jump_host ? ` · -J ${c.host.jump_host}` : ""}
                  </p>
                </div>
                {c.existing_id && (
                  <span className="shrink-0 rounded-full bg-bg-hover px-1.5 py-0.5 text-[9px] text-text-secondary">
                    {S.settings.sshHosts.importAlready}
                  </span>
                )}
              </label>
            ))}
          </div>
        </>
      )}

      <p className="text-[10px] text-text-muted">{S.settings.sshHosts.importReadOnly}</p>

      <div className="flex gap-2">
        <button
          onClick={() => onImport(candidates.filter((_, i) => checked.has(i)).map((c) => c.host))}
          disabled={checked.size === 0}
          className="rounded-md bg-accent px-3 py-1.5 text-[12px] font-medium text-bg-primary disabled:opacity-60"
        >
          {S.settings.sshHosts.importButton} {checked.size > 0 ? checked.size : ""}
        </button>
        <button
          onClick={onCancel}
          className="rounded-md border border-border-subtle px-3 py-1.5 text-[12px] text-text-secondary hover:bg-bg-hover"
        >
          {S.settings.sshHosts.cancel}
        </button>
      </div>
    </div>
  );
}
