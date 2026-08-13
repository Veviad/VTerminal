import { useMemo, useRef, useState } from "react";
import { Cloud, FileText, HardDrive, Loader2, Plus, Upload, X } from "lucide-react";

import { formatAttachmentBytes } from "../../lib/attachments";
import { estimateKnowledgeFiles, ingestKnowledgeFiles } from "../../lib/knowledgeIngest";
import type { KnowledgeBucketDescriptor } from "../../lib/types";

const ACCEPT = ".pdf,.md,.markdown,.txt,.html,.htm,.csv,.json,.yaml,.yml,.png,.jpg,.jpeg,.webp";

export function AddKnowledgeWizard({
  buckets,
  onCreateBucket,
  onOpenBucket,
  onChanged,
}: {
  buckets: KnowledgeBucketDescriptor[];
  onCreateBucket: () => void;
  onOpenBucket: (bucket: KnowledgeBucketDescriptor) => void;
  onChanged: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState<"local" | "qdrant">("local");
  const [bucketKey, setBucketKey] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const choices = useMemo(
    () =>
      buckets.filter(
        (bucket) =>
          bucket.ref.source === source &&
          (source === "local" ||
            (!bucket.imported &&
              (bucket.compatibility === "managed_compatible" ||
                bucket.compatibility === "attach_only"))),
      ),
    [buckets, source],
  );
  const selected = choices.find((bucket) => keyFor(bucket) === bucketKey) ?? null;
  const estimate = estimateKnowledgeFiles(files);
  const canAttemptRemoteWrite =
    selected?.ref.source === "qdrant" &&
    (selected.writable || selected.write_capability === "unknown");

  const reset = () => {
    setOpen(false);
    setBucketKey("");
    setFiles([]);
    setStatus(null);
    setError(null);
  };

  const start = async () => {
    if (!selected) return;
    if (selected.ref.source === "local") {
      onOpenBucket(selected);
      reset();
      return;
    }
    if (!canAttemptRemoteWrite || files.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const outcomes = await ingestKnowledgeFiles(selected.ref, files, {
        onExtracting: (file, index, total) =>
          setStatus(`Extracting ${index + 1} of ${total} — ${file.name}`),
      });
      const failed = outcomes.filter((outcome) => outcome.error);
      const queued = outcomes.length - failed.length;
      setStatus(`${queued} queued${failed.length ? ` · ${failed.length} failed` : ""}`);
      if (failed.length) setError(failed.map((outcome) => `${outcome.file}: ${outcome.error}`).join("\n"));
      await onChanged();
      if (failed.length === 0) reset();
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-[11px] font-medium text-white hover:brightness-110"
      >
        <Plus size={13} /> Add knowledge
      </button>
    );
  }

  return (
    <section className="space-y-3 rounded-lg border border-accent/40 bg-accent-subtle p-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h3 className="text-[12px] font-medium text-text-primary">Add knowledge</h3>
          <p className="text-[9px] text-text-muted">Choose storage, bucket, source, then review before indexing.</p>
        </div>
        <button type="button" onClick={reset} className="text-text-muted"><X size={12} /></button>
      </div>

      <div className="grid grid-cols-2 gap-1.5">
        {(["local", "qdrant"] as const).map((kind) => (
          <button
            key={kind}
            type="button"
            onClick={() => { setSource(kind); setBucketKey(""); setFiles([]); }}
            className={`flex items-center justify-center gap-1.5 rounded-md border px-2 py-2 text-[10px] ${
              source === kind ? "border-accent bg-accent/10 text-accent" : "border-border-subtle text-text-muted"
            }`}
          >
            {kind === "local" ? <HardDrive size={11} /> : <Cloud size={11} />}
            {kind === "local" ? "Local" : "Qdrant"}
          </button>
        ))}
      </div>

      {choices.length === 0 ? (
        <div className="rounded border border-dashed border-border-subtle p-2 text-[10px] text-text-muted">
          No {source === "local" ? "local" : "managed Qdrant"} bucket is ready.
          <button type="button" onClick={onCreateBucket} className="ml-1 text-accent hover:underline">Create one below</button>.
        </div>
      ) : (
        <label className="block text-[9px] text-text-muted">
          Destination bucket
          <select
            value={bucketKey}
            onChange={(event) => setBucketKey(event.target.value)}
            className="mt-1 w-full rounded-md border border-border-subtle bg-bg-card px-2 py-1.5 text-[10px] text-text-primary"
          >
            <option value="">Choose a bucket…</option>
            {choices.map((bucket) => (
              <option key={keyFor(bucket)} value={keyFor(bucket)}>
                {bucket.connection_label ? `${bucket.connection_label} / ` : ""}{bucket.label}
              </option>
            ))}
          </select>
        </label>
      )}

      {selected && (
        <div className="rounded border border-border-subtle bg-bg-card p-2 text-[9px] text-text-muted">
          <p>{selected.profile ? `Embedding: ${selected.profile.label}` : "Keyword-only: semantic search can be added later"}</p>
          {selected.profile?.provider === "openai" || selected.profile?.provider === "mistral" ? (
            <p className="mt-1 text-warning">Document passages and future search queries leave this device through {selected.profile.provider === "openai" ? "OpenAI" : "Mistral"}.</p>
          ) : null}
          {selected.write_capability === "unknown" && <p className="mt-1 text-warning">Qdrant write permission will be tested by this explicit upload.</p>}
        </div>
      )}

      {selected?.ref.source === "local" ? (
        <p className="rounded border border-border-subtle p-2 text-[10px] text-text-muted">
          Continue to this bucket’s existing Add files / Add folder workflow. Folder scanning remains local and applies the secret-file denylist.
        </p>
      ) : selected ? (
        <>
          <input
            ref={fileRef}
            hidden
            multiple
            type="file"
            accept={ACCEPT}
            aria-label="Knowledge files"
            onChange={(event) => setFiles(Array.from(event.target.files ?? []))}
          />
          <button type="button" onClick={() => fileRef.current?.click()} className="flex w-full items-center justify-center gap-1 rounded-md border border-border-subtle px-2 py-2 text-[10px] text-text-secondary hover:bg-bg-hover">
            <Upload size={11} /> {files.length ? `${files.length} file${files.length === 1 ? "" : "s"} selected` : "Choose files…"}
          </button>
          {files.length > 0 && (
            <div className="rounded border border-border-subtle p-2 text-[9px] text-text-muted">
              <p className="flex items-center gap-1"><FileText size={9} /> Preview estimate</p>
              <p className="mt-1">{formatAttachmentBytes(estimate.bytes)} source · ~{estimate.chunks} passages to extract, embed, and upload</p>
            </div>
          )}
        </>
      ) : null}

      {status && <p className="text-[9px] text-text-muted">{status}</p>}
      {error && <pre className="whitespace-pre-wrap text-[9px] text-error">{error}</pre>}
      <div className="flex justify-end">
        <button
          type="button"
          disabled={!selected || busy || (selected.ref.source === "qdrant" && (!canAttemptRemoteWrite || files.length === 0))}
          onClick={() => void start()}
          className="flex items-center gap-1 rounded-md bg-accent px-2 py-1 text-[10px] text-white disabled:opacity-50"
        >
          {busy && <Loader2 size={10} className="animate-spin" />}
          {selected?.ref.source === "local" ? "Open bucket" : "Start ingestion"}
        </button>
      </div>
    </section>
  );
}
function keyFor(bucket: KnowledgeBucketDescriptor): string {
  return bucket.ref.source === "local"
    ? `local:${bucket.ref.bucket_id}`
    : `qdrant:${bucket.ref.connection_id}:${bucket.ref.collection}`;
}
