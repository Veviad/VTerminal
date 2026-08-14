import { useEffect, useMemo, useRef, useState } from "react";
import { BookOpen, Cloud, HardDrive, X } from "lucide-react";

import { useAppStore } from "../../stores/appStore";
import { S } from "../../lib/strings";
import { refreshBuckets, refreshKnowledgeBuckets } from "../../lib/docsIndex";
import {
  knowledgeBucketKey,
  normalizeKnowledgeBucketRef,
  sameKnowledgeBucket,
} from "../../lib/knowledge";
import type { KnowledgeBucketDescriptor, KnowledgeBucketRef } from "../../lib/types";

const NO_REFS: KnowledgeBucketRef[] = [];

async function refreshPickerBuckets(): Promise<void> {
  await refreshBuckets();
  await refreshKnowledgeBuckets();
}

/** Source-aware knowledge picker. Only proven-compatible, non-empty buckets are
 * attachable here. Settings shows managed buckets that need remediation, while
 * unmarked collections remain hidden and legacy v0.2.0 bindings stay Advanced-only. */
export function BucketPicker({ sessionId }: { sessionId: string }) {
  const docsEnabled = useAppStore((s) => s.docsEnabled);
  const buckets = useAppStore((s) => s.knowledgeBuckets);
  const stream = useAppStore((s) => s.aiStreams[sessionId]);
  const attached =
    stream?.attachedBucketRefs ??
    stream?.attachedBucketIds?.map(normalizeKnowledgeBucketRef) ??
    NO_REFS;
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (docsEnabled && buckets.length === 0) void refreshPickerBuckets();
  }, [docsEnabled, buckets.length]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const attachable = useMemo(
    // Qdrant's indexed_vectors_count remains zero for small, fully searchable
    // collections below the HNSW indexing threshold. The backend's attachable
    // verdict uses actual non-emptiness plus exact profile compatibility.
    () => buckets.filter((bucket) => bucket.attachable),
    [buckets],
  );
  const groups = useMemo(() => groupBuckets(attachable), [attachable]);
  const selectedBuckets = attached
    .map((attachedRef) => buckets.find((bucket) => sameKnowledgeBucket(bucket.ref, attachedRef)))
    .filter((bucket): bucket is KnowledgeBucketDescriptor => bucket !== undefined);
  const localProfileCount = new Set(
    selectedBuckets
      .filter((bucket) => bucket.profile?.provider === "local")
      .map((bucket) => bucket.profile?.fingerprint),
  ).size;

  if (!docsEnabled || attachable.length === 0) return null;

  const attach = useAppStore.getState().attachBucketToAi;
  const detach = useAppStore.getState().detachBucketFromAi;

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-label={S.aiPanel.docsLabel}
        title={S.aiPanel.docsHint}
        aria-expanded={open}
        className={
          attached.length > 0
            ? "flex items-center gap-1 rounded-md border border-accent/40 bg-accent/10 px-1.5 py-0.5 text-[10px] text-accent"
            : "flex items-center gap-1 rounded-md border border-border-subtle px-1.5 py-0.5 text-[10px] text-text-muted hover:bg-bg-hover"
        }
      >
        <BookOpen size={11} />
        {attached.length > 0 ? String(attached.length) : S.aiPanel.docsLabel}
      </button>

      {open && (
        <div className="absolute right-0 z-20 mt-1 max-h-80 w-72 overflow-y-auto rounded-md border border-border-subtle bg-bg-card p-1 shadow-lg">
          <p className="px-1.5 py-1 text-[10px] leading-snug text-text-muted">
            {S.aiPanel.docsHint}
          </p>
          {groups.map((group) => (
            <div key={group.key} className="mt-1 border-t border-border-subtle pt-1 first:border-0">
              <p className="flex items-center gap-1 px-1.5 py-1 text-[9px] font-semibold uppercase tracking-wide text-text-muted">
                {group.source === "local" ? <HardDrive size={10} /> : <Cloud size={10} />}
                {group.label}
              </p>
              {group.buckets.map((bucket) => {
                const on = attached.some((candidate) => sameKnowledgeBucket(candidate, bucket.ref));
                return (
                  <label
                    key={knowledgeBucketKey(bucket.ref)}
                    className="flex cursor-pointer items-center gap-1.5 rounded px-1.5 py-1 text-[11px] text-text-primary hover:bg-bg-hover"
                  >
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() =>
                        on ? detach(sessionId, bucket.ref) : attach(sessionId, bucket.ref)
                      }
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{bucket.label}</span>
                      <span className="block truncate text-[9px] text-text-muted">
                        {bucket.profile?.label ?? "Keyword search"}
                      </span>
                    </span>
                    <span className="shrink-0 text-[10px] text-text-muted">
                      {bucket.chunk_count}
                    </span>
                  </label>
                );
              })}
            </div>
          ))}
          {localProfileCount > 1 && (
            <p className="mt-1 rounded border border-warning/30 bg-warning/10 px-1.5 py-1 text-[9px] leading-relaxed text-warning">
              These buckets need {localProfileCount} local embedding models. Searching may switch
              models and add latency or memory pressure.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function groupBuckets(buckets: KnowledgeBucketDescriptor[]) {
  const groups = new Map<
    string,
    { key: string; label: string; source: "local" | "qdrant"; buckets: KnowledgeBucketDescriptor[] }
  >();
  for (const bucket of buckets) {
    const source = bucket.ref.source;
    const key = source === "local" ? "local" : `qdrant:${bucket.ref.connection_id}`;
    const label = source === "local" ? "Local" : bucket.connection_label || bucket.ref.connection_id;
    const group = groups.get(key) ?? { key, label, source, buckets: [] };
    group.buckets.push(bucket);
    groups.set(key, group);
  }
  return Array.from(groups.values());
}

/** An attached knowledge source in the shared context strip. */
export function BucketChip({
  label,
  source,
  connectionLabel,
  chunkCount,
  onRemove,
}: {
  label: string;
  source: "local" | "qdrant";
  connectionLabel?: string | null;
  chunkCount: number;
  onRemove: () => void;
}) {
  const qualified =
    source === "local" ? `Local / ${label}` : `Qdrant / ${connectionLabel ?? "Remote"} / ${label}`;
  return (
    <span
      className="flex max-w-[220px] items-center gap-1 rounded-md border border-border-subtle bg-bg-elevated px-1.5 py-0.5 text-[10px] text-text-secondary"
      title={S.aiPanel.docsChipHint(qualified, chunkCount)}
    >
      {source === "local" ? (
        <HardDrive size={10} className="shrink-0 text-text-muted" />
      ) : (
        <Cloud size={10} className="shrink-0 text-text-muted" />
      )}
      <span className="min-w-0 truncate">{qualified}</span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={S.aiPanel.docsDetach(qualified)}
        className="shrink-0 rounded text-text-muted hover:text-error"
      >
        <X size={10} />
      </button>
    </span>
  );
}
