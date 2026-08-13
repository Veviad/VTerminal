import { useEffect, useMemo, useState } from "react";
import { Cloud, KeyRound, Loader2, Pencil, Plus, RefreshCw, Trash2, X } from "lucide-react";

import * as api from "../../lib/tauri";
import { compatibilityLabel } from "../../lib/knowledge";
import type {
  KnowledgeBucketDescriptor,
  QdrantConnection,
  QdrantConnectionInput,
} from "../../lib/types";
import { inputClass } from "../ui/Row";

export function QdrantConnectionsSection({
  buckets,
  selectedProfileId,
  onChanged,
}: {
  buckets: KnowledgeBucketDescriptor[];
  selectedProfileId: string | null;
  onChanged: () => Promise<void>;
}) {
  const [connections, setConnections] = useState<QdrantConnection[]>([]);
  const [editing, setEditing] = useState<QdrantConnection | "new" | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newCollectionFor, setNewCollectionFor] = useState<string | null>(null);
  const [newCollectionName, setNewCollectionName] = useState("");

  const refresh = async () => {
    try {
      setConnections(await api.knowledgeQdrantConnectionsList());
      setError(null);
    } catch (reason) {
      setError(String(reason));
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const connectionBuckets = useMemo(() => {
    const grouped = new Map<string, KnowledgeBucketDescriptor[]>();
    for (const bucket of buckets) {
      if (bucket.ref.source !== "qdrant") continue;
      grouped.set(bucket.ref.connection_id, [
        ...(grouped.get(bucket.ref.connection_id) ?? []),
        bucket,
      ]);
    }
    return grouped;
  }, [buckets]);

  const test = async (id: string) => {
    setBusy(id);
    try {
      await api.knowledgeQdrantConnectionTest(id);
      await Promise.all([refresh(), onChanged()]);
    } catch (reason) {
      setError(String(reason));
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  const forget = async (connection: QdrantConnection) => {
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Forget “${connection.label}”? Remote collections and documents are not deleted.`)) {
      return;
    }
    setBusy(connection.id);
    try {
      await api.knowledgeQdrantConnectionDelete(connection.id);
      await Promise.all([refresh(), onChanged()]);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(null);
    }
  };

  const clearKey = async (connection: QdrantConnection) => {
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Clear the stored API key for “${connection.label}”?`)) return;
    setBusy(connection.id);
    try {
      await api.knowledgeQdrantConnectionClearKey(connection.id);
      await refresh();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(null);
    }
  };

  const createCollection = async (connectionId: string) => {
    const name = newCollectionName.trim();
    if (!name || !selectedProfileId) return;
    setBusy(connectionId);
    setError(null);
    try {
      await api.knowledgeBucketCreate(name, {
        connectionId,
        profileId: selectedProfileId,
      });
      setNewCollectionFor(null);
      setNewCollectionName("");
      await Promise.all([refresh(), onChanged()]);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="space-y-3" aria-labelledby="qdrant-connections-title">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3
            id="qdrant-connections-title"
            className="text-[10px] font-semibold uppercase tracking-widest text-text-muted"
          >
            Qdrant connections
          </h3>
          <p className="mt-1 text-[11px] leading-relaxed text-text-muted">
            Connect a cluster once. Collections allowed by its Database API Key appear
            automatically; keys stay write-only in the backend.
          </p>
        </div>
        {editing === null && (
          <button
            type="button"
            onClick={() => setEditing("new")}
            className="flex shrink-0 items-center gap-1 rounded-md border border-border-subtle px-2 py-1 text-[10px] text-text-secondary hover:bg-bg-hover"
          >
            <Plus size={11} /> Add connection
          </button>
        )}
      </div>

      {editing && (
        <ConnectionForm
          connection={editing === "new" ? null : editing}
          onCancel={() => setEditing(null)}
          onSave={async (input) => {
            setBusy(input.id ?? "new");
            try {
              const id = await api.knowledgeQdrantConnectionSave(input);
              setEditing(null);
              await api.knowledgeQdrantConnectionTest(id).catch(() => {});
              await Promise.all([refresh(), onChanged()]);
            } finally {
              setBusy(null);
            }
          }}
        />
      )}

      {error && (
        <p className="rounded-md border border-error/30 bg-error/10 px-2 py-1.5 text-[10px] text-error">
          {error}
        </p>
      )}

      {connections.length === 0 && editing === null ? (
        <p className="rounded-md border border-dashed border-border-subtle px-3 py-3 text-[11px] text-text-muted">
          No Qdrant connections yet. Local knowledge keeps working without one.
        </p>
      ) : (
        <div className="space-y-2">
          {connections.map((connection) => {
            const remoteBuckets = connectionBuckets.get(connection.id) ?? [];
            return (
              <article
                key={connection.id}
                className="rounded-lg border border-border-subtle bg-bg-card px-3 py-2"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="flex items-center gap-1.5 text-[12px] font-medium text-text-primary">
                      <Cloud size={12} className="text-text-muted" />
                      <span className="truncate">{connection.label}</span>
                      <StatusBadge status={connection.status} />
                    </p>
                    <p className="mt-0.5 truncate font-mono text-[9px] text-text-muted">
                      {connection.url}
                    </p>
                    <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[9px] text-text-muted">
                      <span className="flex items-center gap-1">
                        <KeyRound size={9} />
                        {connection.has_api_key ? "API key stored" : "No API key"}
                      </span>
                      {connection.server_version && <span>· Qdrant {connection.server_version}</span>}
                      <span>
                        · {remoteBuckets.length} accessible collection
                        {remoteBuckets.length === 1 ? "" : "s"}
                      </span>
                    </p>
                    {connection.error && (
                      <p className="mt-1 text-[9px] text-error">{connection.error}</p>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => void test(connection.id)}
                      title="Refresh collections and status"
                      className="rounded-md border border-border-subtle p-1 text-text-muted hover:bg-bg-hover disabled:opacity-50"
                    >
                      {busy === connection.id ? (
                        <Loader2 size={11} className="animate-spin" />
                      ) : (
                        <RefreshCw size={11} />
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditing(connection)}
                      title="Edit connection or replace its key"
                      className="rounded-md border border-border-subtle p-1 text-text-muted hover:bg-bg-hover"
                    >
                      <Pencil size={11} />
                    </button>
                    <button
                      type="button"
                      onClick={() => void forget(connection)}
                      title="Forget connection"
                      className="rounded-md border border-border-subtle p-1 text-text-muted hover:bg-bg-hover hover:text-error"
                    >
                      <Trash2 size={11} />
                    </button>
                  </div>
                </div>

                {connection.has_api_key && (
                  <button
                    type="button"
                    onClick={() => void clearKey(connection)}
                    className="mt-1 text-[9px] text-text-muted underline-offset-2 hover:text-error hover:underline"
                  >
                    Clear stored key
                  </button>
                )}

                <div className="mt-2 border-t border-border-subtle pt-2">
                  {newCollectionFor === connection.id ? (
                    <div className="flex items-center gap-1.5">
                      <input
                        className={inputClass}
                        value={newCollectionName}
                        onChange={(event) => setNewCollectionName(event.target.value)}
                        placeholder="Collection name"
                        aria-label={`New collection on ${connection.label}`}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") void createCollection(connection.id);
                        }}
                      />
                      <button
                        type="button"
                        disabled={!newCollectionName.trim() || !selectedProfileId || busy !== null}
                        onClick={() => void createCollection(connection.id)}
                        className="shrink-0 rounded-md border border-border-subtle px-2 py-1 text-[10px] text-text-secondary disabled:opacity-50"
                      >
                        Create
                      </button>
                      <button
                        type="button"
                        onClick={() => setNewCollectionFor(null)}
                        className="rounded p-1 text-text-muted"
                      >
                        <X size={11} />
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      disabled={!selectedProfileId}
                      onClick={() => setNewCollectionFor(connection.id)}
                      title={
                        selectedProfileId
                          ? "Create a managed Qdrant collection"
                          : "Select an embedding profile above first"
                      }
                      className="flex items-center gap-1 text-[9px] text-text-muted hover:text-text-secondary disabled:opacity-50"
                    >
                      <Plus size={10} /> New collection
                    </button>
                  )}
                  {!selectedProfileId && (
                    <p className="mt-1 text-[9px] text-text-muted">
                      Select an embedding profile above before creating a collection.
                    </p>
                  )}
                </div>

                {remoteBuckets.length > 0 && (
                  <ul className="mt-2 space-y-1 border-t border-border-subtle pt-2">
                    {remoteBuckets.map((bucket) => (
                      <li
                        key={bucket.ref.source === "qdrant" ? bucket.ref.collection : bucket.label}
                        className="flex items-center justify-between gap-2 text-[10px]"
                      >
                        <span className="min-w-0 truncate text-text-secondary">{bucket.label}</span>
                        <span
                          className={
                            bucket.attachable
                              ? "shrink-0 text-accent"
                              : bucket.compatibility === "incompatible" ||
                                  bucket.compatibility === "unreadable"
                                ? "shrink-0 text-error"
                                : "shrink-0 text-warning"
                          }
                          title={bucket.compatibility_reason ?? undefined}
                        >
                          {compatibilityLabel(bucket.compatibility)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

function ConnectionForm({
  connection,
  onSave,
  onCancel,
}: {
  connection: QdrantConnection | null;
  onSave: (input: QdrantConnectionInput) => Promise<void>;
  onCancel: () => void;
}) {
  const [label, setLabel] = useState(connection?.label ?? "");
  const [url, setUrl] = useState(connection?.url ?? "");
  const [apiKey, setApiKey] = useState("");
  const [allowInsecure, setAllowInsecure] = useState(connection?.allow_insecure ?? false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const insecureUrl = /^http:\/\//i.test(url) && !isLoopbackUrl(url);
  const endpointChanged =
    connection !== null && url.trim().replace(/\/+$/, "") !== connection.url;
  const valid = label.trim().length > 0 && url.trim().length > 0;

  const save = async () => {
    if (!valid) return;
    setSaving(true);
    setError(null);
    try {
      await onSave({
        id: connection?.id,
        label: label.trim(),
        url: url.trim().replace(/\/+$/, ""),
        ...(apiKey.length > 0 ? { api_key: apiKey } : {}),
        allow_insecure: allowInsecure,
      });
      setApiKey("");
    } catch (reason) {
      setError(String(reason));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      className="space-y-2 rounded-lg border border-accent/30 bg-bg-card p-3"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="flex items-center justify-between">
        <p className="text-[11px] font-medium text-text-primary">
          {connection ? `Edit ${connection.label}` : "Connect Qdrant"}
        </p>
        <button type="button" onClick={onCancel} className="rounded p-0.5 text-text-muted">
          <X size={12} />
        </button>
      </div>
      <input
        className={inputClass}
        value={label}
        onChange={(event) => setLabel(event.target.value)}
        placeholder="Connection name"
        aria-label="Connection name"
      />
      <input
        className={inputClass}
        value={url}
        onChange={(event) => setUrl(event.target.value)}
        placeholder="https://cluster.example.qdrant.io:6333"
        aria-label="Qdrant URL"
        inputMode="url"
      />
      <input
        className={inputClass}
        type="password"
        value={apiKey}
        onChange={(event) => setApiKey(event.target.value)}
        placeholder={connection?.has_api_key ? "API key stored — type to replace" : "Database API Key"}
        aria-label="Qdrant API key"
        autoComplete="off"
      />
      <p className="text-[9px] leading-relaxed text-text-muted">
        Use a Database API Key or granular cluster token, not a Qdrant Cloud management key.
        The stored value is never shown again.
      </p>
      {endpointChanged && connection?.has_api_key && apiKey.length === 0 && (
        <p className="rounded border border-warning/30 bg-warning/10 px-2 py-1 text-[9px] text-warning">
          This changes the credential origin. Enter the new endpoint&apos;s key, or cancel and
          clear the saved key before changing the URL.
        </p>
      )}
      {insecureUrl && (
        <label className="flex items-start gap-2 rounded border border-warning/30 bg-warning/10 p-2 text-[9px] text-warning">
          <input
            type="checkbox"
            checked={allowInsecure}
            onChange={(event) => setAllowInsecure(event.target.checked)}
          />
          Allow this non-local HTTP connection. Its API key and document data can be read in transit.
        </label>
      )}
      {error && <p className="text-[9px] text-error">{error}</p>}
      <div className="flex justify-end gap-1.5">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-border-subtle px-2 py-1 text-[10px] text-text-secondary"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={!valid || saving || (insecureUrl && !allowInsecure)}
          className="flex items-center gap-1 rounded-md bg-accent px-2 py-1 text-[10px] text-white disabled:opacity-50"
        >
          {saving && <Loader2 size={10} className="animate-spin" />}
          Save &amp; test
        </button>
      </div>
    </form>
  );
}

function StatusBadge({ status }: { status: QdrantConnection["status"] }) {
  const text =
    status === "connected"
      ? "Connected"
      : status === "stale"
        ? "Stale"
        : status === "error"
          ? "Error"
          : status === "checking"
            ? "Checking"
            : "Not checked";
  const color =
    status === "connected"
      ? "bg-accent/10 text-accent"
      : status === "error"
        ? "bg-error/10 text-error"
        : "bg-bg-elevated text-text-muted";
  return <span className={`rounded px-1 py-0.5 text-[8px] uppercase tracking-wide ${color}`}>{text}</span>;
}

function isLoopbackUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
  } catch {
    return false;
  }
}
