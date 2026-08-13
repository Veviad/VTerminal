import { useEffect, useRef, useState } from "react";
import { BookOpen, X } from "lucide-react";

import { useAppStore } from "../../stores/appStore";
import { S } from "../../lib/strings";
import { refreshBuckets } from "../../lib/docsIndex";

/** Per-session document-bucket picker, rendered beside the permission mode.
 *
 *  Multi-select, so this is a checkbox popover rather than a `Segmented` — a bucket set
 *  is not a set of mutually exclusive modes, and `Segmented` stops fitting past three
 *  options anyway. The closest existing precedent for a checkbox list is the model
 *  picker in `RemoteServersSection`.
 *
 *  Renders nothing unless the feature is on AND at least one bucket exists, the same
 *  way `VisionSection` returns null on an empty backend list and `EffortPicker` returns
 *  null below two rungs: a control with nothing to control is noise.
 */
/** Shared empty array for the selector below.
 *
 *  NOT a cosmetic detail. `useAppStore((s) => … ?? [])` allocates a new array on every
 *  call, and zustand compares snapshots with `Object.is` — so a fresh literal reads as
 *  "changed" every time and `useSyncExternalStore` re-renders until React gives up with
 *  "Maximum update depth exceeded". `AiPanel` keeps `NO_ATTACHMENTS` for exactly this. */
const NO_BUCKETS: string[] = [];

export function BucketPicker({ sessionId }: { sessionId: string }) {
  const docsEnabled = useAppStore((s) => s.docsEnabled);
  const buckets = useAppStore((s) => s.docBuckets);
  const attached = useAppStore((s) => s.aiStreams[sessionId]?.attachedBucketIds) ?? NO_BUCKETS;
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // The list is loaded by the Settings tab, which the user may never have opened in
  // this session. Fetch once when the feature is on so the picker can appear at all.
  //
  // Guarded on `docsEnabled` before anything reaches IPC: this component now mounts in
  // ask mode too, which is the panel's default, so an unguarded fetch here would put a
  // Tauri call on the render path of every session — something `aiPanelRenders.test.tsx`
  // explicitly relies on not happening.
  useEffect(() => {
    if (docsEnabled && buckets.length === 0) void refreshBuckets();
  }, [docsEnabled, buckets.length]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!docsEnabled || buckets.length === 0) return null;

  const attach = useAppStore.getState().attachBucketToAi;
  const detach = useAppStore.getState().detachBucketFromAi;

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
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
        <div className="absolute right-0 z-20 mt-1 w-56 rounded-md border border-border-subtle bg-bg-card p-1 shadow-lg">
          <p className="px-1.5 py-1 text-[10px] leading-snug text-text-muted">
            {S.aiPanel.docsHint}
          </p>
          {buckets.map((b) => {
            const on = attached.includes(b.id);
            // A bucket with nothing indexed would contribute no passages, so it is
            // shown but not offerable — silently listing it as attachable invites the
            // conclusion that retrieval is broken.
            const empty = b.chunk_count === 0;
            return (
              <label
                key={b.id}
                className={
                  empty
                    ? "flex cursor-not-allowed items-center gap-1.5 rounded px-1.5 py-1 text-[11px] text-text-muted opacity-60"
                    : "flex cursor-pointer items-center gap-1.5 rounded px-1.5 py-1 text-[11px] text-text-primary hover:bg-bg-hover"
                }
              >
                <input
                  type="checkbox"
                  checked={on}
                  disabled={empty}
                  onChange={() => (on ? detach(sessionId, b.id) : attach(sessionId, b.id))}
                />
                <span className="min-w-0 flex-1 truncate">{b.label}</span>
                <span className="shrink-0 text-[10px] text-text-muted">
                  {empty ? S.settings.docs.neverIndexed : b.chunk_count}
                </span>
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** An attached bucket in the shared context strip, alongside block and file chips. */
export function BucketChip({
  label,
  chunkCount,
  onRemove,
}: {
  label: string;
  chunkCount: number;
  onRemove: () => void;
}) {
  return (
    <span
      className="flex max-w-[180px] items-center gap-1 rounded-md border border-border-subtle bg-bg-elevated px-1.5 py-0.5 text-[10px] text-text-secondary"
      title={S.aiPanel.docsChipHint(label, chunkCount)}
    >
      <BookOpen size={10} className="shrink-0 text-text-muted" />
      <span className="min-w-0 truncate">{label}</span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={S.aiPanel.docsDetach(label)}
        className="shrink-0 rounded text-text-muted hover:text-error"
      >
        <X size={10} />
      </button>
    </span>
  );
}
