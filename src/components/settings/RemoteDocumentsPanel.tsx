import { useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  FileText,
  Loader2,
  Pencil,
  RefreshCw,
  RotateCcw,
  Save,
  Trash2,
  Upload,
  X,
} from "lucide-react";

import * as api from "../../lib/tauri";
import { sameKnowledgeBucket } from "../../lib/knowledge";
import { ingestKnowledgeFiles } from "../../lib/knowledgeIngest";
import type {
  KnowledgeBucketDescriptor,
  KnowledgeDocumentManifest,
  KnowledgeDocumentSummary,
  KnowledgeJob,
} from "../../lib/types";
import { inputClass } from "../ui/Row";

const FILE_ACCEPT =
  ".pdf,.md,.markdown,.txt,.html,.htm,.csv,.json,.yaml,.yml,.png,.jpg,.jpeg,.webp";

interface LocalIngestState {
  file: string;
  stage: "extracting" | "queued" | "failed";
  error: string | null;
}

export function RemoteDocumentsPanel({
  bucket,
  onChanged,
}: {
  bucket: KnowledgeBucketDescriptor;
  onChanged: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [documents, setDocuments] = useState<KnowledgeDocumentSummary[]>([]);
  const [cursor, setCursor] = useState<string | number | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [jobs, setJobs] = useState<KnowledgeJob[]>([]);
  const [localIngest, setLocalIngest] = useState<LocalIngestState | null>(null);
  const [replaceTarget, setReplaceTarget] = useState<KnowledgeDocumentManifest | null>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const replaceRef = useRef<HTMLInputElement>(null);
  const latestCompleted = useRef(0);

  const loadDocuments = useCallback(
    async (reset: boolean) => {
      if (bucket.ref.source !== "qdrant") return;
      setLoading(true);
      setError(null);
      try {
        const page = await api.knowledgeDocumentsList(bucket.ref, reset ? null : cursor, 25);
        setDocuments((current) => (reset ? page.documents : mergeDocuments(current, page.documents)));
        setCursor(page.next_cursor);
        setLoaded(true);
      } catch (reason) {
        setError(String(reason));
      } finally {
        setLoading(false);
      }
    },
    [bucket.ref, cursor],
  );

  const refreshJobs = useCallback(async () => {
    try {
      const all = await api.knowledgeJobsList();
      const matching = all.filter((job) => {
        try {
          return sameKnowledgeBucket(job.target_ref, bucket.ref);
        } catch {
          return false;
        }
      });
      setJobs(matching);
      const completedAt = matching
        .filter((job) => job.status === "completed")
        .reduce((latest, job) => Math.max(latest, job.updated_at), 0);
      if (completedAt > latestCompleted.current) {
        latestCompleted.current = completedAt;
        await Promise.all([loadDocuments(true), onChanged()]);
      }
    } catch {
      // Document browsing must remain useful if the durable job list cannot be read.
    }
  }, [bucket.ref, loadDocuments, onChanged]);

  useEffect(() => {
    if (!open || loaded) return;
    void loadDocuments(true);
  }, [open, loaded, loadDocuments]);

  useEffect(() => {
    if (!open) return;
    void refreshJobs();
    const timer = window.setInterval(() => void refreshJobs(), 2500);
    return () => window.clearInterval(timer);
  }, [open, refreshJobs]);

  if (bucket.ref.source !== "qdrant") return null;
  if (bucket.imported) {
    return (
      <p className="border-t border-border-subtle pt-2 text-[9px] leading-relaxed text-text-muted">
        Imported collections are attach/search-only in v1. Their existing payloads are not treated
        as VTerminal document manifests, so upload, replace, and document CRUD stay unavailable.
      </p>
    );
  }
  const remoteRef = bucket.ref;
  const canAttemptWrite = bucket.writable || bucket.write_capability === "unknown";

  const ingest = async (files: File[], replacement?: KnowledgeDocumentManifest) => {
    const outcomes = await ingestKnowledgeFiles(remoteRef, files, {
      replacement,
      onExtracting: (file) =>
        setLocalIngest({ file: file.name, stage: "extracting", error: null }),
    });
    const failed = outcomes.find((outcome) => outcome.error);
    const last = outcomes[outcomes.length - 1];
    if (failed) {
      setLocalIngest({ file: failed.file, stage: "failed", error: failed.error });
    } else if (last) {
      setLocalIngest({ file: last.file, stage: "queued", error: null });
    }
    setReplaceTarget(null);
    if (replaceRef.current) replaceRef.current.value = "";
    if (uploadRef.current) uploadRef.current.value = "";
    await refreshJobs();
    await loadDocuments(true);
  };

  return (
    <div className="space-y-2 border-t border-border-subtle pt-2">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="flex items-center gap-1 text-[10px] font-medium text-text-secondary hover:text-text-primary"
        >
          {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          Documents
          <span className="text-text-muted">({bucket.file_count})</span>
        </button>
        {canAttemptWrite && (
          <button
            type="button"
            onClick={() => uploadRef.current?.click()}
            className="flex items-center gap-1 rounded-md border border-border-subtle px-2 py-1 text-[10px] text-text-secondary hover:bg-bg-hover"
          >
            <Upload size={11} /> Add files…
          </button>
        )}
      </div>

      <input
        ref={uploadRef}
        hidden
        multiple
        type="file"
        accept={FILE_ACCEPT}
        aria-label={`Upload documents to ${bucket.label}`}
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          if (files.length > 0) void ingest(files);
        }}
      />
      <input
        ref={replaceRef}
        hidden
        type="file"
        accept={FILE_ACCEPT}
        aria-label={`Replace document in ${bucket.label}`}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file && replaceTarget) void ingest([file], replaceTarget);
        }}
      />

      {localIngest && (
        <div
          className={`rounded border px-2 py-1.5 text-[10px] ${
            localIngest.stage === "failed"
              ? "border-error/30 bg-error/10 text-error"
              : "border-border-subtle bg-bg-elevated text-text-muted"
          }`}
        >
          <p className="flex items-center gap-1.5">
            {localIngest.stage === "extracting" && <Loader2 size={10} className="animate-spin" />}
            {localIngest.stage === "queued" && <RefreshCw size={10} />}
            {localIngest.file} — {localIngest.stage}
          </p>
          {localIngest.error && <p className="mt-0.5">{localIngest.error}</p>}
        </div>
      )}

      {open && (
        <div className="space-y-2">
          <JobList jobs={jobs} onRefresh={refreshJobs} />
          {error && <p className="text-[10px] text-error">{error}</p>}
          {loading && documents.length === 0 ? (
            <p className="flex items-center gap-1.5 text-[10px] text-text-muted">
              <Loader2 size={10} className="animate-spin" /> Loading documents…
            </p>
          ) : documents.length === 0 ? (
            <p className="rounded border border-dashed border-border-subtle px-2 py-2 text-[10px] text-text-muted">
              No document manifests yet. Files are extracted locally, embedded with this bucket’s
              immutable profile, then stored as passages in Qdrant.
            </p>
          ) : (
            <ul className="space-y-1">
              {documents.map((document) => (
                <RemoteDocumentRow
                  key={document.manifest.document_id}
                  bucket={bucket}
                  document={document}
                  canAttemptWrite={canAttemptWrite}
                  onReplace={() => {
                    setReplaceTarget(document.manifest);
                    replaceRef.current?.click();
                  }}
                  onChanged={() => loadDocuments(true)}
                />
              ))}
            </ul>
          )}
          {cursor !== null && (
            <button
              type="button"
              disabled={loading}
              onClick={() => void loadDocuments(false)}
              className="w-full rounded-md border border-border-subtle px-2 py-1 text-[10px] text-text-secondary hover:bg-bg-hover disabled:opacity-50"
            >
              {loading ? "Loading…" : "Load more"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function RemoteDocumentRow({
  bucket,
  document,
  canAttemptWrite,
  onReplace,
  onChanged,
}: {
  bucket: KnowledgeBucketDescriptor;
  document: KnowledgeDocumentSummary;
  canAttemptWrite: boolean;
  onReplace: () => void;
  onChanged: () => Promise<void>;
}) {
  const manifest = document.manifest;
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(manifest.title);
  const [sourceUri, setSourceUri] = useState(manifest.source_uri);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (!title.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.knowledgeDocumentUpdate(bucket.ref, manifest.document_id, {
        title: title.trim(),
        source_uri: sourceUri.trim(),
        mime_type: manifest.mime_type,
        updated_at: new Date().toISOString(),
      });
      setEditing(false);
      await onChanged();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Delete “${manifest.title}” from ${bucket.label}?`)) return;
    setBusy(true);
    setError(null);
    try {
      // The backend deletes by exact document id, never by title or source URI.
      await api.knowledgeDocumentDelete(bucket.ref, manifest.document_id);
      await onChanged();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="rounded border border-border-subtle bg-bg-elevated p-2 text-[10px]">
      {editing ? (
        <div className="space-y-1.5">
          <input
            className={inputClass}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            aria-label={`Title for ${manifest.title}`}
          />
          <input
            className={inputClass}
            value={sourceUri}
            onChange={(event) => setSourceUri(event.target.value)}
            placeholder="Source URI"
            aria-label={`Source URI for ${manifest.title}`}
          />
          <div className="flex justify-end gap-1">
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="rounded border border-border-subtle p-1 text-text-muted"
            >
              <X size={10} />
            </button>
            <button
              type="button"
              disabled={busy || !title.trim()}
              onClick={() => void save()}
              aria-label={`Save ${manifest.title}`}
              className="rounded border border-border-subtle p-1 text-text-secondary disabled:opacity-50"
            >
              {busy ? <Loader2 size={10} className="animate-spin" /> : <Save size={10} />}
            </button>
          </div>
        </div>
      ) : (
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-1 truncate font-medium text-text-secondary">
              <FileText size={10} className="shrink-0 text-text-muted" /> {manifest.title}
            </p>
            <p className="mt-0.5 truncate text-[9px] text-text-muted" title={manifest.source_uri}>
              {manifest.source_uri || "No source URI"} · revision {manifest.revision} ·{" "}
              {manifest.chunk_count} passages
            </p>
          </div>
          {canAttemptWrite && (
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                disabled={busy}
                onClick={() => setEditing(true)}
                title="Edit metadata"
                className="rounded p-0.5 text-text-muted hover:text-text-secondary"
              >
                <Pencil size={10} />
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={onReplace}
                title="Replace source file, preserving document id"
                className="rounded p-0.5 text-text-muted hover:text-text-secondary"
              >
                <RotateCcw size={10} />
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void remove()}
                title="Delete document"
                className="rounded p-0.5 text-text-muted hover:text-error"
              >
                <Trash2 size={10} />
              </button>
            </div>
          )}
        </div>
      )}
      {error && <p className="mt-1 text-[9px] text-error">{error}</p>}
    </li>
  );
}

function JobList({ jobs, onRefresh }: { jobs: KnowledgeJob[]; onRefresh: () => Promise<void> }) {
  const visible = jobs.filter((job) => job.status !== "completed").slice(0, 4);
  if (visible.length === 0) return null;
  return (
    <div className="space-y-1 rounded border border-border-subtle p-2">
      <p className="text-[9px] font-medium uppercase tracking-wide text-text-muted">Ingestion jobs</p>
      {visible.map((job) => {
        const total = job.total_items;
        const pct = total && total > 0 ? Math.min(100, (job.completed_items / total) * 100) : 0;
        return (
          <div key={job.id} className="space-y-1 text-[9px] text-text-muted">
            <div className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate capitalize">
                {job.stage.replaceAll("_", " ")} · {job.status}
              </span>
              <span className="flex shrink-0 items-center gap-1">
                {(job.status === "queued" || job.status === "running") && (
                  <button
                    type="button"
                    onClick={() => void api.knowledgeJobCancel(job.id).then(onRefresh)}
                    className="hover:text-error"
                  >
                    Cancel
                  </button>
                )}
                {(job.status === "failed" || job.status === "cancelled") && (
                  <button
                    type="button"
                    onClick={() => void api.knowledgeJobRetry(job.id).then(onRefresh)}
                    className="hover:text-text-secondary"
                  >
                    Retry
                  </button>
                )}
              </span>
            </div>
            <div className="h-px bg-bg-elevated">
              <div
                className={`h-px ${job.status === "failed" ? "bg-error" : "bg-accent"}`}
                style={{ width: `${pct}%` }}
              />
            </div>
            {job.error && <p className="text-error">{job.error}</p>}
          </div>
        );
      })}
    </div>
  );
}

function mergeDocuments(
  current: KnowledgeDocumentSummary[],
  incoming: KnowledgeDocumentSummary[],
): KnowledgeDocumentSummary[] {
  const merged = new Map(current.map((document) => [document.manifest.document_id, document]));
  for (const document of incoming) merged.set(document.manifest.document_id, document);
  return Array.from(merged.values());
}
