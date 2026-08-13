import { useCallback, useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { FileText, FolderOpen, Plus, RefreshCw, Search, Trash2, X } from "lucide-react";

import { useAppStore } from "../../stores/appStore";
import { useSettings } from "../../hooks/useSettings";
import { S } from "../../lib/strings";
import * as api from "../../lib/tauri";
import { indexBucket, refreshBuckets } from "../../lib/docsIndex";
import { formatAttachmentBytes } from "../../lib/attachments";
import { Toggle, inputClass } from "../ui/Row";
import type { DocBucket, DocFile, DocSearchPreview } from "../../lib/types";

/** The Docs tab.
 *
 *  The experimental toggle sits at the TOP of this tab and everything below is gated on
 *  it, rather than the tab being hidden when the feature is off. A toggle that hides the
 *  only place it can be found is not discoverable, and putting it in an unrelated tab
 *  would orphan it from what it controls.
 *
 *  Note the toggle only reveals UI. The capability is gated in Rust — `commands::docs`
 *  refuses every command and `commands::ai` withholds the `search_docs` tool — so
 *  flipping this frontend-side cannot grant anything.
 */
export function DocsSettings() {
  const docsEnabled = useAppStore((s) => s.docsEnabled);
  const buckets = useAppStore((s) => s.docBuckets);
  const docsError = useAppStore((s) => s.docsError);
  const { save } = useSettings();
  const [newLabel, setNewLabel] = useState("");

  useEffect(() => {
    if (docsEnabled) void refreshBuckets();
  }, [docsEnabled]);

  const create = async () => {
    const label = newLabel.trim();
    if (!label) return;
    try {
      await api.docsBucketCreate(label);
      setNewLabel("");
      await refreshBuckets();
    } catch (e) {
      useAppStore.getState().setDocsError(String(e));
    }
  };

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <h3 className="text-[10px] font-semibold uppercase tracking-widest text-text-muted">
          {S.settings.docs.title}
        </h3>
        <p className="text-[11px] leading-relaxed text-text-secondary">
          {S.settings.docs.intro}
        </p>

        <Toggle
          label={S.settings.docs.enable}
          hint={S.settings.docs.enableHint}
          checked={docsEnabled}
          onChange={(v) => void save({ docs_enabled: v })}
        />
      </section>

      {!docsEnabled ? (
        <p className="rounded-md border border-border-subtle bg-bg-card px-3 py-2 text-[11px] text-text-muted">
          {S.settings.docs.disabledNotice}
        </p>
      ) : (
        <>
          {docsError && (
            <p className="rounded-md border border-error/30 bg-error/10 px-2 py-1.5 text-[11px] text-error">
              {docsError}
            </p>
          )}

          <section className="space-y-2">
            <div className="flex items-center gap-2">
              <input
                className={inputClass}
                value={newLabel}
                placeholder={S.settings.docs.bucketNamePlaceholder}
                aria-label={S.settings.docs.addBucket}
                onChange={(e) => setNewLabel(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void create();
                }}
              />
              <button
                type="button"
                onClick={() => void create()}
                disabled={newLabel.trim().length === 0}
                className="flex shrink-0 items-center gap-1 rounded-md border border-border-subtle px-2 py-1 text-[11px] text-text-primary hover:bg-bg-hover disabled:opacity-40"
              >
                <Plus size={12} />
                {S.settings.docs.addBucket}
              </button>
            </div>
          </section>

          {buckets.length === 0 ? (
            <p className="text-[11px] text-text-muted">{S.settings.docs.empty}</p>
          ) : (
            <div className="space-y-4">
              {buckets.map((b) => (
                <BucketCard key={b.id} bucket={b} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function BucketCard({ bucket }: { bucket: DocBucket }) {
  const progress = useAppStore((s) => s.docsIndexing[bucket.id]);
  const [files, setFiles] = useState<DocFile[] | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<DocSearchPreview[] | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const loadFiles = useCallback(async () => {
    try {
      setFiles(await api.docsFilesList(bucket.id));
    } catch (e) {
      useAppStore.getState().setDocsError(String(e));
    }
  }, [bucket.id]);

  useEffect(() => {
    void loadFiles();
  }, [loadFiles, bucket.file_count, bucket.chunk_count, progress === undefined]);

  const add = async (directory: boolean) => {
    const picked = await openDialog({ multiple: true, directory });
    if (!picked) return;
    const paths = Array.isArray(picked) ? picked : [picked];
    try {
      const summary = await api.docsScan(
        bucket.id,
        directory ? paths : [],
        directory ? [] : paths,
      );
      setNote(S.settings.docs.scanSummary(summary));
      await refreshBuckets();
      await loadFiles();
    } catch (e) {
      useAppStore.getState().setDocsError(String(e));
    }
  };

  const runIndex = async () => {
    setNote(null);
    const report = await indexBucket(bucket.id);
    setNote(report.cancelled ? S.settings.docs.cancelled : S.settings.docs.indexed(report));
    await loadFiles();
  };

  const reindex = async () => {
    try {
      await api.docsBucketReindex(bucket.id);
      await runIndex();
    } catch (e) {
      useAppStore.getState().setDocsError(String(e));
    }
  };

  const remove = async () => {
    // eslint-disable-next-line no-alert
    if (!window.confirm(S.settings.docs.deleteBucketConfirm(bucket.label))) return;
    try {
      await api.docsBucketDelete(bucket.id);
      await refreshBuckets();
    } catch (e) {
      useAppStore.getState().setDocsError(String(e));
    }
  };

  const search = async () => {
    if (!query.trim()) return;
    try {
      setResults(await api.docsSearch([bucket.id], query));
    } catch (e) {
      useAppStore.getState().setDocsError(String(e));
    }
  };

  const needsWork = bucket.pending_count + bucket.stale_count;

  return (
    <section className="space-y-2 rounded-md border border-border-subtle bg-bg-card p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-[13px] font-medium text-text-primary">{bucket.label}</p>
          <p className="text-[11px] text-text-muted">
            {S.settings.docs.fileCount(bucket.file_count)} ·{" "}
            {bucket.chunk_count > 0
              ? S.settings.docs.chunkCount(bucket.chunk_count)
              : S.settings.docs.neverIndexed}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void remove()}
          aria-label={S.settings.docs.deleteBucket}
          title={S.settings.docs.deleteBucket}
          className="shrink-0 rounded p-1 text-text-muted hover:bg-bg-hover hover:text-error"
        >
          <Trash2 size={13} />
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <ActionButton icon={<FolderOpen size={12} />} onClick={() => void add(true)}>
          {S.settings.docs.addFolder}
        </ActionButton>
        <ActionButton icon={<FileText size={12} />} onClick={() => void add(false)}>
          {S.settings.docs.addFiles}
        </ActionButton>
        {progress ? (
          <ActionButton
            icon={<X size={12} />}
            onClick={() => useAppStore.getState().cancelDocsIndexing(bucket.id)}
          >
            {S.settings.docs.cancel}
          </ActionButton>
        ) : (
          <>
            {needsWork > 0 && (
              <ActionButton icon={<RefreshCw size={12} />} onClick={() => void runIndex()}>
                {S.settings.docs.indexNow}
              </ActionButton>
            )}
            {bucket.file_count > 0 && (
              <ActionButton
                icon={<RefreshCw size={12} />}
                onClick={() => void reindex()}
                title={S.settings.docs.reindexHint}
              >
                {S.settings.docs.reindex}
              </ActionButton>
            )}
          </>
        )}
      </div>

      {progress && (
        <p className="flex items-center gap-1.5 text-[11px] text-text-muted">
          <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
          {S.settings.docs.indexing(progress.done, progress.total, progress.current)}
        </p>
      )}
      {note && !progress && <p className="text-[11px] text-text-muted">{note}</p>}

      {files && files.length > 0 && (
        <ul className="max-h-56 space-y-0.5 overflow-y-auto">
          {files.map((f) => (
            <li key={f.id} className="flex items-center justify-between gap-2 text-[11px]">
              <span className="min-w-0 flex-1 truncate text-text-secondary" title={f.path}>
                {f.name}
              </span>
              <span
                className={
                  f.state === "indexed"
                    ? "shrink-0 text-text-muted"
                    : f.state === "failed" || f.state === "missing"
                      ? "shrink-0 text-error"
                      : "shrink-0 text-warning"
                }
                title={f.state_reason ?? undefined}
              >
                {S.settings.docs.state[f.state] ?? f.state}
              </span>
              <span className="shrink-0 text-text-muted">
                {formatAttachmentBytes(f.size_bytes)}
              </span>
              <button
                type="button"
                onClick={async () => {
                  await api.docsFileRemove(f.id);
                  await refreshBuckets();
                  await loadFiles();
                }}
                aria-label={S.settings.docs.remove}
                className="shrink-0 rounded p-0.5 text-text-muted hover:bg-bg-hover hover:text-error"
              >
                <X size={11} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {files && files.length === 0 && (
        <p className="text-[11px] text-text-muted">{S.settings.docs.noFiles}</p>
      )}

      {bucket.chunk_count > 0 && (
        <div className="space-y-1.5 border-t border-border-subtle pt-2">
          <div className="flex items-center gap-2">
            <input
              className={inputClass}
              value={query}
              placeholder={S.settings.docs.testSearchPlaceholder}
              aria-label={S.settings.docs.testSearch}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void search();
              }}
            />
            <button
              type="button"
              onClick={() => void search()}
              className="flex shrink-0 items-center gap-1 rounded-md border border-border-subtle px-2 py-1 text-[11px] text-text-primary hover:bg-bg-hover"
            >
              <Search size={12} />
              {S.settings.docs.testSearch}
            </button>
          </div>
          {results && results.length === 0 && (
            <p className="text-[11px] text-text-muted">{S.settings.docs.noResults}</p>
          )}
          {results && results.length > 0 && (
            <ul className="space-y-1.5">
              {results.map((r, i) => (
                <li key={i} className="rounded border border-border-subtle p-1.5">
                  <p className="text-[10px] text-text-muted">
                    {[r.file_name, r.page !== null ? `p.${r.page}` : null, r.heading]
                      .filter(Boolean)
                      .join(" — ")}
                  </p>
                  <p className="mt-0.5 line-clamp-3 text-[11px] text-text-secondary">{r.text}</p>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

function ActionButton({
  icon,
  onClick,
  title,
  children,
}: {
  icon: React.ReactNode;
  onClick: () => void;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="flex items-center gap-1 rounded-md border border-border-subtle px-2 py-1 text-[11px] text-text-primary hover:bg-bg-hover"
    >
      {icon}
      {children}
    </button>
  );
}
