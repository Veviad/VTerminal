// Servers the user runs themselves: add one, ask it what it serves, tick the
// models to keep.
//
// State is component-local, like SshHostsSection's and unlike the model catalog's.
// Two reasons: a server with zero enabled models produces zero catalog rows, so
// deriving the list from `catalog` would make a freshly added server VANISH before
// it could be probed; and every keystroke in `appStore.ts` triggers a full page
// reload (it calls `import.meta.hot.invalidate()` on purpose), which is a bad
// place to iterate on a form.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Pencil, Plus, RefreshCw, Server, Trash2 } from "lucide-react";
import * as api from "../../lib/tauri";
import { useAppStore } from "../../stores/appStore";
import { refreshModels } from "../../lib/selectModel";
import {
  KIND_EXAMPLE_URL,
  KIND_LABELS,
  normalizeBaseUrl,
  previewProbeRequest,
  REMOTE_KINDS,
  validateRemoteServer,
} from "../../lib/remoteServer";
import { S } from "../../lib/strings";
import type {
  CatalogEntry,
  RemoteModel,
  RemoteProbeResult,
  RemoteServer,
  RemoteServerInput,
  RemoteServerKind,
} from "../../lib/types";
import { Field, inputClass } from "../ui/Row";
import { formatTokens, ModelRow } from "./ModelRow";

const EMPTY: RemoteServerInput = { kind: "ollama", label: "", base_url: "" };

/** Up to this many reported models, a first probe pre-checks the chat ones. */
const PRECHECK_LIMIT = 8;

/** Add → probe → pick is a SEQUENCE, so it is one mode rather than three
 *  independent flags: parallel booleans would permit "form open and picker open".
 *  SshHostsSection gets away with flags because its scan and edit are separate
 *  entry points. */
type Mode =
  | { kind: "list" }
  | { kind: "form"; server: RemoteServer | null }
  | { kind: "pick"; server: RemoteServer; result: RemoteProbeResult };

export function RemoteServersSection() {
  const catalog = useAppStore((s) => s.catalog);
  const [servers, setServers] = useState<RemoteServer[]>([]);
  const [mode, setMode] = useState<Mode>({ kind: "list" });
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  // One at a time: the button that starts a probe becomes a spinner, and the flow
  // then moves to the picker. A Record<id, true> is the change if that ever stops
  // being true.
  const [probing, setProbing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setServers(await api.remoteServersList());
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const onSave = async (draft: RemoteServerInput, apiKey: string | null) => {
    if (mode.kind !== "form") return;
    setError(null);
    // Normalize before sending so the stored value matches the preview the form
    // just showed. Rust re-normalizes; this layer is convenience.
    const server = { ...draft, base_url: normalizeBaseUrl(draft.base_url) };
    try {
      if (mode.server) {
        await api.remoteServersUpdate(mode.server.id, server);
        // null = the field was never touched, so the stored token stands.
        if (apiKey !== null) await api.remoteServersSetApiKey(mode.server.id, apiKey);
      } else {
        await api.remoteServersCreate(server, apiKey);
      }
      setMode({ kind: "list" });
      await reload();
      // A URL or label edit changes what the model rows say about themselves.
      await refreshModels().catch(() => {});
    } catch (e) {
      setError(String(e));
    }
  };

  const onProbe = async (server: RemoteServer) => {
    setError(null);
    setProbing(server.id);
    try {
      setMode({ kind: "pick", server, result: await api.remoteServersProbe(server.id) });
    } catch (e) {
      // Verbatim, and beside the server that failed — never through
      // setModelLoadError, which is the on-device engine's channel and renders
      // under a heading about downloads.
      setError(String(e));
    } finally {
      setProbing(null);
    }
  };

  const onSaveModels = async (server: RemoteServer, models: RemoteModel[]) => {
    setError(null);
    try {
      await api.remoteServersSetModels(server.id, models);
      setMode({ kind: "list" });
      await reload();
      // The enabled set is what makes rows exist in `catalog`.
      await refreshModels();
    } catch (e) {
      setError(String(e));
    }
  };

  const onDelete = async (id: string) => {
    setError(null);
    setConfirmDelete(null);
    try {
      await api.remoteServersDelete(id);
      await reload();
      await refreshModels();
      // The backend un-selects a model it just deleted; re-read so the header
      // chip stops naming a model that no longer exists.
      const settings = await api.getSettings();
      useAppStore.setState({ activeModelId: settings.active_model_id });
    } catch (e) {
      setError(String(e));
    }
  };

  if (mode.kind === "form") {
    return (
      <ServerForm
        initial={mode.server}
        error={error}
        onSave={onSave}
        onCancel={() => {
          setMode({ kind: "list" });
          setError(null);
        }}
      />
    );
  }

  if (mode.kind === "pick") {
    return (
      <ModelPicker
        server={mode.server}
        result={mode.result}
        error={error}
        onSave={(models) => void onSaveModels(mode.server, models)}
        onCancel={() => {
          setMode({ kind: "list" });
          setError(null);
        }}
      />
    );
  }

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <h3 className="text-[10px] font-semibold uppercase tracking-widest text-text-muted">
          {S.settings.remoteServers.title}
        </h3>
        <p className="text-[11px] leading-relaxed text-text-muted">
          {S.settings.remoteServers.intro}
        </p>
        {error && (
          <p className="rounded-md border border-error/30 bg-error/10 px-2 py-1.5 text-[11px] leading-relaxed text-error">
            {error}
          </p>
        )}
        {servers.length === 0 && (
          <p className="rounded-md border border-border-subtle bg-bg-card px-3 py-4 text-center text-[11px] text-text-muted">
            {S.settings.remoteServers.empty}
          </p>
        )}
        {/* Above the sections, unlike SshHostsSection: that list is one line per
            host, while each entry here is a whole section, so a button below them
            ends up orphaned pages down. */}
        <button
          onClick={() => setMode({ kind: "form", server: null })}
          className="flex items-center gap-1.5 rounded-md border border-border-subtle bg-bg-card px-2.5 py-1.5 text-[12px] text-text-secondary hover:bg-bg-hover"
        >
          <Plus size={12} />
          {S.settings.remoteServers.add}
        </button>
      </section>

      {servers.map((server) => (
        <ServerSection
          key={server.id}
          server={server}
          entries={catalog.filter((m) => m.remote?.server_id === server.id)}
          probing={probing === server.id}
          confirming={confirmDelete === server.id}
          onProbe={() => void onProbe(server)}
          onEdit={() => setMode({ kind: "form", server })}
          onDelete={() =>
            confirmDelete === server.id ? void onDelete(server.id) : setConfirmDelete(server.id)
          }
          onBlurDelete={() => setConfirmDelete(null)}
        />
      ))}
    </div>
  );
}

/** Shaped like ModelsSettings' ProviderSection: heading, one line of context,
 *  then the model rows. */
function ServerSection({
  server,
  entries,
  probing,
  confirming,
  onProbe,
  onEdit,
  onDelete,
  onBlurDelete,
}: {
  server: RemoteServer;
  entries: CatalogEntry[];
  probing: boolean;
  confirming: boolean;
  onProbe(): void;
  onEdit(): void;
  onDelete(): void;
  onBlurDelete(): void;
}) {
  return (
    <section className="space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-widest text-text-muted">
            <Server size={11} />
            <span className="truncate">{server.label}</span>
          </h3>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 font-mono text-[10px] text-text-muted">
            <span className="truncate">{server.base_url}</span>
            <span>· {KIND_LABELS[server.kind]}</span>
            {server.has_api_key && <span>· {S.settings.remoteServers.tokenStoredTag}</span>}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            disabled={probing}
            onClick={onProbe}
            className="flex items-center gap-1 rounded-md border border-border-subtle px-2 py-1 text-[10px] text-text-secondary hover:bg-bg-hover disabled:opacity-60"
          >
            {probing ? (
              <Loader2 size={11} className="animate-spin" />
            ) : (
              <RefreshCw size={11} />
            )}
            {probing
              ? S.settings.remoteServers.testing
              : server.models.length === 0
                ? S.settings.remoteServers.test
                : S.settings.remoteServers.refresh}
          </button>
          <button
            title={S.settings.remoteServers.edit}
            onClick={onEdit}
            className="rounded-md border border-border-subtle p-1 text-text-muted hover:bg-bg-hover hover:text-text-primary"
          >
            <Pencil size={11} />
          </button>
          {/* Two clicks, like the host list: removing a server also drops its
              token and un-selects its model. */}
          <button
            title={S.settings.remoteServers.remove}
            onClick={onDelete}
            onBlur={onBlurDelete}
            className={`rounded-md border p-1 ${
              confirming
                ? "border-error text-error"
                : "border-border-subtle text-text-muted hover:bg-bg-hover hover:text-error"
            }`}
          >
            <Trash2 size={11} />
          </button>
        </div>
      </div>
      {confirming && (
        <p className="text-[10px] text-error">{S.settings.remoteServers.confirmRemove}</p>
      )}
      {entries.length === 0 ? (
        <p className="rounded-md border border-border-subtle bg-bg-card px-3 py-3 text-[11px] text-text-muted">
          {S.settings.remoteServers.noModels}
        </p>
      ) : (
        <div className="space-y-1.5">
          {entries.map((entry) => (
            <ModelRow key={entry.id} entry={entry} />
          ))}
        </div>
      )}
    </section>
  );
}

function ServerForm({
  initial,
  error,
  onSave,
  onCancel,
}: {
  initial: RemoteServer | null;
  error: string | null;
  onSave(draft: RemoteServerInput, apiKey: string | null): void;
  onCancel(): void;
}) {
  const [draft, setDraft] = useState<RemoteServerInput>(
    initial
      ? { kind: initial.kind, label: initial.label, base_url: initial.base_url }
      : EMPTY,
  );
  // null means "never touched", which is the only way to say "keep the stored
  // token" — "" is the clear sentinel.
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);

  const errors = useMemo(() => validateRemoteServer(draft), [draft]);
  const errorFor = (field: keyof RemoteServerInput) =>
    touched ? errors.find((e) => e.field === field)?.message : undefined;
  const preview = previewProbeRequest(draft);

  return (
    <div className="space-y-4">
      <h3 className="text-[10px] font-semibold uppercase tracking-widest text-text-muted">
        {initial ? S.settings.remoteServers.editTitle : S.settings.remoteServers.newTitle}
      </h3>
      {error && (
        <p className="rounded-md border border-error/30 bg-error/10 px-2 py-1.5 text-[11px] leading-relaxed text-error">
          {error}
        </p>
      )}

      <Field
        label={S.settings.remoteServers.kind}
        hint={S.settings.remoteServers.kindHint}
        error={errorFor("kind")}
      >
        <select
          value={draft.kind}
          onChange={(e) => setDraft({ ...draft, kind: e.target.value as RemoteServerKind })}
          className={inputClass}
        >
          {REMOTE_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {KIND_LABELS[kind]}
            </option>
          ))}
        </select>
      </Field>

      <Field
        label={S.settings.remoteServers.label}
        hint={S.settings.remoteServers.labelHint}
        error={errorFor("label")}
      >
        <input
          value={draft.label}
          onChange={(e) => setDraft({ ...draft, label: e.target.value })}
          placeholder="Workstation"
          className={inputClass}
        />
      </Field>

      <Field
        label={S.settings.remoteServers.baseUrl}
        hint={S.settings.remoteServers.baseUrlHint(KIND_EXAMPLE_URL[draft.kind])}
        error={errorFor("base_url")}
      >
        <input
          value={draft.base_url}
          onChange={(e) => setDraft({ ...draft, base_url: e.target.value })}
          placeholder={KIND_EXAMPLE_URL[draft.kind]}
          className={`${inputClass} font-mono`}
          spellCheck={false}
          autoCapitalize="off"
        />
      </Field>

      <Field label={S.settings.remoteServers.token} hint={S.settings.remoteServers.tokenHint}>
        <input
          type="password"
          // Controlled, unlike ModelsSettings' ApiKeyField: `null` vs `""` is how
          // this form distinguishes keep from clear, so emptying the box really
          // does remove a stored token.
          value={apiKey ?? ""}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={
            initial?.has_api_key
              ? S.settings.remoteServers.tokenStored
              : S.settings.remoteServers.tokenPlaceholder
          }
          className={`${inputClass} font-mono`}
        />
      </Field>

      {preview && (
        <div className="space-y-1">
          <p className="text-[11px] text-text-secondary">{S.settings.remoteServers.preview}</p>
          <pre className="overflow-x-auto rounded-md border border-border-subtle bg-bg-elevated px-2 py-1.5 font-mono text-[10px] text-text-secondary">
            {preview}
          </pre>
        </div>
      )}

      <div className="flex gap-2">
        <button
          onClick={() => {
            setTouched(true);
            if (errors.length === 0) onSave(draft, apiKey);
          }}
          className="rounded-md bg-accent px-3 py-1.5 text-[12px] font-medium text-bg-primary"
        >
          {S.settings.remoteServers.save}
        </button>
        <button
          onClick={onCancel}
          className="rounded-md border border-border-subtle px-3 py-1.5 text-[12px] text-text-secondary hover:bg-bg-hover"
        >
          {S.settings.remoteServers.cancel}
        </button>
      </div>
    </div>
  );
}

function ModelPicker({
  server,
  result,
  error,
  onSave,
  onCancel,
}: {
  server: RemoteServer;
  result: RemoteProbeResult;
  error: string | null;
  onSave(models: RemoteModel[]): void;
  onCancel(): void;
}) {
  // Keyed by wire model, not by index: ssh candidates have no stable identity, but
  // a wire model does — and Ollama orders its listing by modification time, so
  // indices shift between refreshes.
  const [checked, setChecked] = useState<Set<string>>(() => {
    const enabled = result.models.filter((m) => m.already_enabled);
    // A re-probe pre-checks exactly what is on, so it can never silently
    // re-enable something unticked last time. A FIRST probe of a short list
    // pre-checks the chat models, making the common case one click; past
    // PRECHECK_LIMIT that inverts, and unticking dozens is worse than ticking a
    // few, so a long list starts empty.
    const seed =
      enabled.length > 0
        ? enabled
        : result.models.filter((m) => m.role === "chat" && result.models.length <= PRECHECK_LIMIT);
    return new Set(seed.map((m) => m.wire_model));
  });

  const toggle = (wire: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(wire)) next.delete(wire);
      else next.add(wire);
      return next;
    });

  const save = () =>
    onSave(
      result.models
        .filter((m) => checked.has(m.wire_model))
        // Strip the probe-only fields; what is stored is a RemoteModel.
        .map(({ wire_model, label, context_tokens, supports_vision, supports_tools }) => ({
          wire_model,
          label,
          context_tokens,
          supports_vision,
          supports_tools,
        })),
    );

  return (
    <div className="space-y-3">
      <h3 className="text-[10px] font-semibold uppercase tracking-widest text-text-muted">
        {S.settings.remoteServers.pickTitle} {server.label}
      </h3>
      <p className="font-mono text-[10px] text-text-muted">{result.endpoint}</p>

      {error && (
        <p className="rounded-md border border-error/30 bg-error/10 px-2 py-1.5 text-[11px] leading-relaxed text-error">
          {error}
        </p>
      )}
      {result.warnings.map((w) => (
        <p
          key={w}
          className="rounded-md border border-warning/30 bg-warning/10 px-2 py-1.5 text-[11px] leading-relaxed text-warning"
        >
          {w}
        </p>
      ))}

      {result.models.length === 0 ? (
        <p className="rounded-md border border-border-subtle bg-bg-card px-3 py-4 text-center text-[11px] text-text-muted">
          {S.settings.remoteServers.pickNone}
        </p>
      ) : (
        <>
          <p className="text-[11px] text-text-secondary">
            {S.settings.remoteServers.pickFound(result.models.length)} ·{" "}
            {S.settings.remoteServers.pickEnabled(checked.size)}
          </p>
          <div className="max-h-[320px] space-y-1 overflow-y-auto">
            {result.models.map((m) => (
              <label
                key={m.wire_model}
                className="flex cursor-pointer items-center gap-2 rounded-md border border-border-subtle bg-bg-card px-2.5 py-2"
              >
                <input
                  type="checkbox"
                  checked={checked.has(m.wire_model)}
                  onChange={() => toggle(m.wire_model)}
                  className="accent-accent"
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[12px] text-text-primary">{m.label}</p>
                  <p className="truncate font-mono text-[10px] text-text-muted">
                    {formatTokens(m.context_tokens)} {S.settings.models.contextTokens}
                    {!m.enriched && ` (${S.settings.remoteServers.assumedContext})`}
                    {m.role !== "chat" &&
                      ` · ${
                        S.settings.remoteServers.role[
                          m.role as keyof typeof S.settings.remoteServers.role
                        ] ?? m.role
                      }`}
                    {!m.supports_tools && ` · ${S.settings.remoteServers.noTools}`}
                    {m.state === "not-loaded" && ` · ${S.settings.remoteServers.notLoaded}`}
                  </p>
                </div>
                {m.already_enabled && (
                  <span className="shrink-0 rounded-full bg-bg-hover px-1.5 py-0.5 text-[9px] text-text-secondary">
                    {S.settings.remoteServers.alreadyEnabled}
                  </span>
                )}
              </label>
            ))}
          </div>
        </>
      )}

      <p className="text-[10px] leading-relaxed text-text-muted">
        {S.settings.remoteServers.pickHint}
      </p>

      <div className="flex gap-2">
        {/* NOT disabled at zero, unlike the ssh importer: importing nothing is a
            no-op, but ticking nothing here is the only way to turn a server off
            without removing it. */}
        <button
          onClick={save}
          className="rounded-md bg-accent px-3 py-1.5 text-[12px] font-medium text-bg-primary"
        >
          {S.settings.remoteServers.pickSave}
        </button>
        <button
          onClick={onCancel}
          className="rounded-md border border-border-subtle px-3 py-1.5 text-[12px] text-text-secondary hover:bg-bg-hover"
        >
          {S.settings.remoteServers.cancel}
        </button>
      </div>
    </div>
  );
}
