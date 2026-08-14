import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  FileText,
  FolderOpen,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Terminal,
  Trash2,
  X,
} from "lucide-react";

import { useAppStore } from "../../stores/appStore";
import { useSettings } from "../../hooks/useSettings";
import { useKnowledgeJobs } from "../../hooks/useKnowledgeJobs";
import { S } from "../../lib/strings";
import * as api from "../../lib/tauri";
import { indexBucket, refreshBuckets, refreshKnowledgeBuckets } from "../../lib/docsIndex";
import { formatAttachmentBytes } from "../../lib/attachments";
import {
  compatibilityLabel,
  isManagedQdrantBucket,
  knowledgeBucketKey,
} from "../../lib/knowledge";
import { Toggle, inputClass } from "../ui/Row";
import type {
  DocBucket,
  DocFile,
  DocSearchPreview,
  KnowledgeBucketDescriptor,
  DownloadEvent,
  EmbeddingInstallEvent,
  EmbeddingProfile,
  KnowledgeJob,
} from "../../lib/types";
import { KnowledgeModelsSection } from "./KnowledgeModelsSection";
import { QdrantConnectionsSection } from "./QdrantConnectionsSection";
import { RemoteDocumentsPanel } from "./RemoteDocumentsPanel";
import { TurboQuantPanel } from "./TurboQuantPanel";
import { QdrantImportWizard } from "./QdrantImportWizard";
import { AddKnowledgeWizard } from "./AddKnowledgeWizard";
import { CredentialStoreBanner } from "./ModelsSettings";
import { InlineModelDownloadProgress } from "./InlineModelDownloadProgress";

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
  const knowledgeBuckets = useAppStore((s) => s.knowledgeBuckets);
  const docsError = useAppStore((s) => s.docsError);
  const { save } = useSettings();
  const [newLabel, setNewLabel] = useState("");
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const [focusBucketId, setFocusBucketId] = useState<string | null>(null);
  const { jobs: knowledgeJobs, refresh: refreshKnowledgeJobs } = useKnowledgeJobs(docsEnabled);
  const lastTerminalJob = useRef<number | null>(null);

  const readyProfiles = useMemo(() => {
    const byId = new Map<string, EmbeddingProfile>();
    for (const bucket of knowledgeBuckets) {
      if (bucket.profile?.available) byId.set(bucket.profile.id, bucket.profile);
    }
    return [...byId.values()];
  }, [knowledgeBuckets]);
  const legacyImports = useMemo(
    () =>
      knowledgeBuckets.filter(
        (bucket) =>
          bucket.ref.source === "qdrant" &&
          (bucket.compatibility === "legacy_import" || bucket.imported),
      ),
    [knowledgeBuckets],
  );

  const refreshKnowledge = useCallback(async () => {
    await refreshBuckets();
    await refreshKnowledgeBuckets();
  }, []);

  useEffect(() => {
    if (docsEnabled) void refreshKnowledge();
  }, [docsEnabled, refreshKnowledge]);

  // A profile is immutable and backend-persisted. When Settings is reopened, restore
  // the first runnable profile already bound to a bucket instead of presenting every
  // card as unselected and asking cloud users to run the provider preflight again.
  useEffect(() => {
    if (!selectedProfileId && readyProfiles[0]) {
      setSelectedProfileId(readyProfiles[0].id);
    }
  }, [readyProfiles, selectedProfileId]);

  useEffect(() => {
    const latest = knowledgeJobs
      .filter((job) => job.status === "completed" || job.status === "failed")
      .reduce((value, job) => Math.max(value, job.updated_at), 0);
    if (lastTerminalJob.current === null) {
      lastTerminalJob.current = latest;
      return;
    }
    if (latest > lastTerminalJob.current) {
      lastTerminalJob.current = latest;
      void refreshKnowledge();
    }
  }, [knowledgeJobs, refreshKnowledge]);

  const create = async () => {
    const label = newLabel.trim();
    if (!label) return;
    try {
      if (selectedProfileId) {
        await api.knowledgeBucketCreate(label, { profileId: selectedProfileId });
      } else {
        await api.docsBucketCreate(label);
      }
      setNewLabel("");
      await refreshKnowledge();
    } catch (e) {
      useAppStore.getState().setDocsError(String(e));
    }
  };

  return (
    <div className="space-y-6">
      <CredentialStoreBanner />
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

          <AddKnowledgeWizard
            buckets={knowledgeBuckets}
            jobs={knowledgeJobs}
            onCreateBucket={() =>
              document.getElementById("knowledge-buckets-title")?.scrollIntoView({ behavior: "smooth" })
            }
            onOpenBucket={(bucket) => {
              if (bucket.ref.source === "local") {
                setFocusBucketId(bucket.ref.bucket_id);
                document
                  .getElementById(`knowledge-local-${bucket.ref.bucket_id}`)
                  ?.scrollIntoView({ behavior: "smooth", block: "center" });
              }
            }}
            onChanged={refreshKnowledge}
          />

          <KnowledgeModelsSection
            selectedProfileId={selectedProfileId}
            onSelectProfile={setSelectedProfileId}
            readyProfiles={readyProfiles}
          />

          <div className="border-t border-border-subtle" />

          <QdrantConnectionsSection
            buckets={knowledgeBuckets}
            selectedProfileId={selectedProfileId}
            onChanged={refreshKnowledge}
          />

          <div className="border-t border-border-subtle" />

          <section className="space-y-3" aria-labelledby="knowledge-buckets-title">
            <div>
              <h3
                id="knowledge-buckets-title"
                className="text-[10px] font-semibold uppercase tracking-widest text-text-muted"
              >
                Knowledge buckets
              </h3>
              <p className="mt-1 text-[11px] leading-relaxed text-text-muted">
                Local buckets and compatible Qdrant collections can be attached together.
                Each semantic bucket keeps the embedding profile it was created with.
              </p>
            </div>
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
            <p className="text-[9px] text-text-muted">
              {selectedProfileId
                ? "New local buckets use the selected semantic embedding profile."
                : "No embedding profile selected: new local buckets start with keyword search and can be upgraded later."}
            </p>
          </section>

          {buckets.length === 0 && knowledgeBuckets.every((bucket) => bucket.ref.source !== "qdrant") ? (
            <p className="text-[11px] text-text-muted">{S.settings.docs.empty}</p>
          ) : (
            <div className="space-y-4">
              {buckets.map((b) => (
                <BucketCard
                  key={b.id}
                  bucket={b}
                  knowledgeBucket={knowledgeBuckets.find(
                    (candidate) =>
                      candidate.ref.source === "local" && candidate.ref.bucket_id === b.id,
                  )}
                  selectedProfileId={selectedProfileId}
                  onChanged={refreshKnowledge}
                  focused={focusBucketId === b.id}
                />
              ))}
              {knowledgeBuckets
                .filter(isManagedQdrantBucket)
                .map((bucket) => (
                  <RemoteBucketCard
                    key={knowledgeBucketKey(bucket.ref)}
                    bucket={bucket}
                    jobs={knowledgeJobs}
                    onRefreshJobs={refreshKnowledgeJobs}
                    onChanged={refreshKnowledge}
                  />
                ))}
            </div>
          )}

          {legacyImports.length > 0 && (
            <details className="rounded-md border border-warning/30 bg-warning/5 p-3">
              <summary className="cursor-pointer text-[10px] font-medium text-warning">
                Advanced · Legacy v0.2.0 imports ({legacyImports.length})
              </summary>
              <p className="mt-2 text-[9px] leading-relaxed text-text-muted">
                These local, attested mappings remain search-only for one compatibility release.
                They are not shared with another client. Create a managed VTerminal collection to
                store the immutable profile and payload contract in Qdrant metadata.
              </p>
              <div className="mt-3 space-y-3">
                {legacyImports.map((bucket) => (
                  <RemoteBucketCard
                    key={knowledgeBucketKey(bucket.ref)}
                    bucket={bucket}
                    jobs={knowledgeJobs}
                    onRefreshJobs={refreshKnowledgeJobs}
                    onChanged={refreshKnowledge}
                  />
                ))}
              </div>
            </details>
          )}

          <KnowledgeCliInstall />
        </>
      )}
    </div>
  );
}

function BucketCard({
  bucket,
  knowledgeBucket,
  selectedProfileId,
  onChanged,
  focused,
}: {
  bucket: DocBucket;
  knowledgeBucket?: KnowledgeBucketDescriptor;
  selectedProfileId: string | null;
  onChanged: () => Promise<void>;
  focused: boolean;
}) {
  const progress = useAppStore((s) => s.docsIndexing[bucket.id]);
  const [files, setFiles] = useState<DocFile[] | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<DocSearchPreview[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [embeddingJob, setEmbeddingJob] = useState<KnowledgeJob | null>(null);
  const [semanticError, setSemanticError] = useState<string | null>(null);

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
    if (!report.cancelled && knowledgeBucket?.profile) {
      try {
        setEmbeddingJob(await api.knowledgeBucketEmbed(bucket.id));
      } catch (reason) {
        setNote(`${S.settings.docs.indexed(report)} · Embedding failed to start: ${String(reason)}`);
      }
    }
    await loadFiles();
  };

  const enableSemantic = async () => {
    if (!selectedProfileId) return;
    setSemanticError(null);
    try {
      setEmbeddingJob(await api.knowledgeBucketSemanticEnable(bucket.id, selectedProfileId));
      await onChanged();
    } catch (reason) {
      setSemanticError(String(reason));
    }
  };

  useEffect(() => {
    if (!embeddingJob || !["queued", "running"].includes(embeddingJob.status)) return;
    const timer = window.setInterval(() => {
      void api
        .knowledgeJobsList()
        .then((jobs) => {
          const next = jobs.find((job) => job.id === embeddingJob.id);
          if (next) setEmbeddingJob(next);
        })
        .catch(() => {});
    }, 2000);
    return () => window.clearInterval(timer);
  }, [embeddingJob]);

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
    <section
      id={`knowledge-local-${bucket.id}`}
      className={`space-y-2 rounded-md border bg-bg-card p-3 ${focused ? "border-accent ring-1 ring-accent/20" : "border-border-subtle"}`}
    >
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

      {!knowledgeBucket?.profile && bucket.chunk_count > 0 && (
        <div className="rounded border border-border-subtle bg-bg-elevated p-2">
          <p className="text-[10px] text-text-secondary">This bucket currently uses keyword search.</p>
          <button
            type="button"
            disabled={!selectedProfileId}
            onClick={() => void enableSemantic()}
            title={selectedProfileId ? undefined : "Select a ready embedding profile above first"}
            className="mt-1.5 flex items-center gap-1 rounded-md border border-border-subtle px-2 py-1 text-[10px] text-text-secondary hover:bg-bg-hover disabled:opacity-50"
          >
            <Plus size={10} /> Add semantic search
          </button>
          {!selectedProfileId && (
            <p className="mt-1 text-[9px] text-text-muted">Select a ready embedding profile above first.</p>
          )}
          {semanticError && <p className="mt-1 text-[9px] text-error">{semanticError}</p>}
        </div>
      )}

      {progress && (
        <p className="flex items-center gap-1.5 text-[11px] text-text-muted">
          <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
          {S.settings.docs.indexing(progress.done, progress.total, progress.current)}
        </p>
      )}
      {note && !progress && <p className="text-[11px] text-text-muted">{note}</p>}
      {embeddingJob && (
        <KnowledgeJobProgress job={embeddingJob} label="Semantic embedding" />
      )}

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

export function RemoteBucketCard({
  bucket,
  jobs,
  onRefreshJobs,
  onChanged,
}: {
  bucket: KnowledgeBucketDescriptor;
  jobs: KnowledgeJob[];
  onRefreshJobs: () => Promise<void>;
  onChanged: () => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<DocSearchPreview[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [profileBusy, setProfileBusy] = useState(false);
  const [requiredInstall, setRequiredInstall] = useState<{
    phase: "downloading" | "verifying" | "loading";
    downloaded: number;
    total: number | null;
    bps: number;
  } | null>(null);
  const [requiredLicenseAccepted, setRequiredLicenseAccepted] = useState(false);
  const hasOpenAiKey = useAppStore((state) => state.hasApiKey.openai ?? false);
  const hasMistralKey = useAppStore((state) => state.hasApiKey.mistral ?? false);
  if (bucket.ref.source !== "qdrant") return null;
  const remoteRef = bucket.ref;

  const startRequiredLocalModel = () => {
    const modelId = bucket.required_builtin_model_id;
    if (!modelId) return;
    setProfileBusy(true);
    setError(null);
    setRequiredInstall({ phase: "downloading", downloaded: 0, total: null, bps: 0 });
    void api
      .knowledgeEmbeddingModelInstall(
        modelId,
        (event: EmbeddingInstallEvent | DownloadEvent) => {
          if (event.type === "Started") {
            setRequiredInstall({
              phase: "downloading",
              downloaded: event.resumed_from,
              total: event.total_bytes,
              bps: 0,
            });
          } else if (event.type === "Progress") {
            setRequiredInstall({
              phase: "downloading",
              downloaded: event.downloaded,
              total: event.total_bytes,
              bps: event.bytes_per_sec,
            });
          } else if (event.type === "Phase") {
            setRequiredInstall((current) =>
              current ? { ...current, phase: event.phase } : current,
            );
          } else if (event.type === "Ready") {
            setRequiredInstall(null);
            void onChanged();
          } else if (event.type === "Cancelled") {
            setRequiredInstall(null);
          } else if (event.type === "Error") {
            setRequiredInstall(null);
            setError(event.message);
          }
        },
        modelId === "local/embeddinggemma-300m" && requiredLicenseAccepted,
      )
      .catch((reason) => {
        setRequiredInstall(null);
        setError(String(reason));
      })
      .finally(() => setProfileBusy(false));
  };

  const enableRequiredCloudProfile = () => {
    const provider = bucket.required_provider;
    const profile = bucket.profile;
    if ((provider !== "openai" && provider !== "mistral") || !profile) return;
    const providerLabel = provider === "openai" ? "OpenAI" : "Mistral";
    // eslint-disable-next-line no-alert
    if (
      !window.confirm(
        `Enable this exact ${providerLabel} embedding profile? Document passages and future search queries sent for this bucket will leave the device.`,
      )
    ) {
      return;
    }
    setProfileBusy(true);
    setError(null);
    void api
      .knowledgeEmbeddingProfileCreateCloud(provider, profile.model, profile.dimensions)
      .then(onChanged)
      .catch((reason) => setError(String(reason)))
      .finally(() => setProfileBusy(false));
  };

  const search = async () => {
    if (!query.trim()) return;
    setBusy(true);
    setError(null);
    try {
      setResults(await api.knowledgeSearch([bucket.ref], query));
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!bucket.manageable) return;
    const typed = window.prompt(
      `Delete Qdrant collection “${bucket.label}” and every document in it? Type the collection name to confirm.`,
    );
    if (typed !== remoteRef.collection) return;
    setBusy(true);
    setError(null);
    try {
      await api.knowledgeBucketDelete(bucket.ref);
      await onChanged();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-2 rounded-md border border-border-subtle bg-bg-card p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-1.5 text-[13px] font-medium text-text-primary">
            <span className="truncate">{bucket.label}</span>
            <span className="rounded bg-bg-elevated px-1 py-0.5 text-[8px] uppercase tracking-wide text-text-muted">
              Qdrant · {bucket.connection_label ?? bucket.ref.connection_id}
            </span>
          </p>
          <p className="mt-0.5 text-[10px] text-text-muted">
            {bucket.file_count} document{bucket.file_count === 1 ? "" : "s"} · {bucket.chunk_count}{" "}
            passages · {bucket.profile?.label ?? "Unknown embedding profile"}
          </p>
          <p
            className={`mt-1 text-[10px] ${
              bucket.attachable
                ? "text-accent"
                : bucket.compatibility === "incompatible" || bucket.compatibility === "unreadable"
                  ? "text-error"
                  : "text-warning"
            }`}
          >
            {compatibilityLabel(bucket.compatibility)}
            {bucket.compatibility_reason ? ` — ${bucket.compatibility_reason}` : ""}
          </p>
        </div>
        {bucket.manageable && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void remove()}
            aria-label={`Delete Qdrant collection ${bucket.label}`}
            title="Delete remote collection"
            className="shrink-0 rounded p-1 text-text-muted hover:bg-bg-hover hover:text-error disabled:opacity-50"
          >
            <Trash2 size={13} />
          </button>
        )}
      </div>

      <div className="flex flex-wrap gap-1.5 text-[9px] text-text-muted">
        <span className="rounded bg-bg-elevated px-1.5 py-0.5">
          {bucket.writable || bucket.write_capability === "read_write"
            ? "Documents: read & write"
            : bucket.write_capability === "unknown"
              ? "Write access tested on first upload"
              : "Documents: read only"}
        </span>
        <span className="rounded bg-bg-elevated px-1.5 py-0.5">
          {bucket.manageable ? "Collection: manage" : "Collection: no manage access"}
        </span>
        {bucket.stale && <span className="rounded bg-warning/10 px-1.5 py-0.5 text-warning">Stale status</span>}
      </div>

      {bucket.error && <p className="text-[10px] text-error">{bucket.error}</p>}
      {error && <p className="text-[10px] text-error">{error}</p>}

      {bucket.compatibility === "requires_profile" && (
        <div className="rounded border border-warning/30 bg-warning/10 p-2 text-[9px] leading-relaxed text-warning">
          {bucket.required_builtin_model_id ? (
            <>
              <p>
                This collection is self-describing, but its exact local embedding model is not
                installed on this client.
              </p>
              {bucket.required_builtin_model_id === "local/embeddinggemma-300m" && (
                <label className="mt-1.5 flex items-start gap-1.5">
                  <input
                    type="checkbox"
                    checked={requiredLicenseAccepted}
                    onChange={(event) => setRequiredLicenseAccepted(event.target.checked)}
                  />
                  I accept EmbeddingGemma&apos;s upstream model license.
                </label>
              )}
              <button
                type="button"
                disabled={
                  profileBusy ||
                  (bucket.required_builtin_model_id === "local/embeddinggemma-300m" &&
                    !requiredLicenseAccepted)
                }
                onClick={startRequiredLocalModel}
                className="mt-1.5 flex items-center gap-1 rounded border border-warning/30 px-2 py-1 hover:bg-warning/10 disabled:opacity-50"
              >
                {profileBusy && <Loader2 size={9} className="animate-spin" />}
                Download &amp; use required model
              </button>
              {requiredInstall && (
                <InlineModelDownloadProgress
                  label={bucket.profile?.label ?? "Required embedding model"}
                  phase={requiredInstall.phase}
                  downloaded={requiredInstall.downloaded}
                  total={requiredInstall.total}
                  bytesPerSecond={requiredInstall.bps}
                  onCancel={() =>
                    void api.knowledgeEmbeddingModelCancel(bucket.required_builtin_model_id!)
                  }
                />
              )}
            </>
          ) : bucket.required_provider === "openai" || bucket.required_provider === "mistral" ? (
            <>
              <p>
                This collection requires its exact{" "}
                {bucket.required_provider === "openai" ? "OpenAI" : "Mistral"} embedding profile.
              </p>
              {(bucket.required_provider === "openai" ? hasOpenAiKey : hasMistralKey) ? (
                <button
                  type="button"
                  disabled={profileBusy}
                  onClick={enableRequiredCloudProfile}
                  className="mt-1.5 flex items-center gap-1 rounded border border-warning/30 px-2 py-1 hover:bg-warning/10 disabled:opacity-50"
                >
                  {profileBusy && <Loader2 size={9} className="animate-spin" />}
                  Enable exact cloud profile
                </button>
              ) : (
                <p className="mt-1">
                  Add the matching credential under Settings → Models, then return here to enable
                  it with one click.
                </p>
              )}
            </>
          ) : (
            <p>
              This collection needs its exact {bucket.profile?.label ?? "advanced embedding"}
              profile. Configure and verify that model under Advanced before attaching it.
            </p>
          )}
        </div>
      )}

      <RemoteDocumentsPanel
        bucket={bucket}
        jobs={jobs}
        onRefreshJobs={onRefreshJobs}
        onChanged={onChanged}
      />

      <QdrantImportWizard bucket={bucket} onChanged={onChanged} />

      <TurboQuantPanel bucket={bucket} onChanged={onChanged} />

      {bucket.attachable && bucket.chunk_count > 0 && (
        <div className="space-y-1.5 border-t border-border-subtle pt-2">
          <div className="flex items-center gap-2">
            <input
              className={inputClass}
              value={query}
              placeholder={S.settings.docs.testSearchPlaceholder}
              aria-label={`Search ${bucket.label}`}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void search();
              }}
            />
            <button
              type="button"
              disabled={busy || query.trim().length === 0}
              onClick={() => void search()}
              className="flex shrink-0 items-center gap-1 rounded-md border border-border-subtle px-2 py-1 text-[11px] text-text-primary hover:bg-bg-hover disabled:opacity-50"
            >
              <Search size={12} /> {busy ? "Searching…" : S.settings.docs.testSearch}
            </button>
          </div>
          {results && results.length === 0 && (
            <p className="text-[11px] text-text-muted">{S.settings.docs.noResults}</p>
          )}
          {results && results.length > 0 && (
            <ul className="space-y-1.5">
              {results.map((result, index) => (
                <li key={index} className="rounded border border-border-subtle p-1.5">
                  <p className="text-[10px] text-text-muted">
            Qdrant / {bucket.connection_label ?? remoteRef.connection_id} / {bucket.label} /{" "}
                    {result.file_name}
                    {result.page !== null ? ` — p.${result.page}` : ""}
                  </p>
                  <p className="mt-0.5 line-clamp-3 text-[11px] text-text-secondary">
                    {result.text}
                  </p>
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

function KnowledgeJobProgress({ job, label }: { job: KnowledgeJob; label: string }) {
  const total = job.total_items;
  const pct = total && total > 0 ? Math.min(100, (job.completed_items / total) * 100) : 0;
  return (
    <div
      className={`rounded border px-2 py-1.5 text-[10px] ${
        job.status === "failed"
          ? "border-error/30 bg-error/10 text-error"
          : "border-border-subtle bg-bg-elevated text-text-muted"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5 truncate">
          {(job.status === "queued" || job.status === "running" || job.status === "cancelling") && (
            <Loader2 size={10} className="shrink-0 animate-spin" />
          )}
          {label} · {job.stage.replaceAll("_", " ")} · {job.status}
        </span>
        {(job.status === "queued" || job.status === "running") && (
          <button
            type="button"
            onClick={() => void api.knowledgeJobCancel(job.id)}
            className="shrink-0 hover:text-error"
          >
            Cancel
          </button>
        )}
      </div>
      <div className="mt-1 h-px bg-bg-card">
        <div
          className={`h-px ${job.status === "failed" ? "bg-error" : "bg-accent"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      {job.error && <p className="mt-1">{job.error}</p>}
    </div>
  );
}

function KnowledgeCliInstall() {
  const [busy, setBusy] = useState(false);
  const [target, setTarget] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  return (
    <section className="space-y-2 border-t border-border-subtle pt-4">
      <h3 className="text-[10px] font-semibold uppercase tracking-widest text-text-muted">
        Command-line access
      </h3>
      <p className="text-[10px] leading-relaxed text-text-muted">
        Install the bundled <code className="font-mono">vterminal-docs</code> command into{" "}
        <code className="font-mono">~/.local/bin</code>. This never edits shell profiles; if that
        directory is not on PATH, the result shows the exact executable location.
      </p>
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setError(null);
          void api
            .knowledgeCliInstall()
            .then(setTarget)
            .catch((reason) => setError(String(reason)))
            .finally(() => setBusy(false));
        }}
        className="flex items-center gap-1 rounded-md border border-border-subtle px-2 py-1 text-[10px] text-text-secondary hover:bg-bg-hover disabled:opacity-50"
      >
        {busy ? <Loader2 size={10} className="animate-spin" /> : <Terminal size={10} />}
        Install CLI
      </button>
      {target && (
        <p className="rounded border border-accent/30 bg-accent/10 px-2 py-1.5 font-mono text-[9px] text-accent">
          Installed: {target}
        </p>
      )}
      {error && <p className="text-[9px] text-error">{error}</p>}
    </section>
  );
}
