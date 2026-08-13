import { useEffect, useMemo, useState } from "react";
import { Import, Loader2, X } from "lucide-react";

import * as api from "../../lib/tauri";
import type {
  KnowledgeBucketDescriptor,
  QdrantImportInput,
  QdrantImportInspection,
} from "../../lib/types";
import { inputClass } from "../ui/Row";

export function QdrantImportWizard({
  bucket,
  onChanged,
}: {
  bucket: KnowledgeBucketDescriptor;
  onChanged: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [inspection, setInspection] = useState<QdrantImportInspection | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [input, setInput] = useState<QdrantImportInput>({
    profile_id: "",
    vector_name: "",
    text_field: "text",
    document_id_field: "document_id",
    title_field: "title",
    source_uri_field: "source_uri",
    page_field: "page",
    heading_field: "heading",
    model_attested: false,
  });

  useEffect(() => {
    if (!open || inspection || loading) return;
    setLoading(true);
    setError(null);
    void api
      .knowledgeQdrantImportInspect(bucket.ref)
      .then((result) => {
        setInspection(result);
        const binding = result.binding;
        const vectorName = binding?.vector_name ?? result.vectors[0]?.name ?? "";
        const vector = result.vectors.find((candidate) => candidate.name === vectorName);
        const compatibleProfile = result.profiles.find(
          (profile) =>
            profile.dimensions === vector?.size &&
            vector?.distance.toLowerCase() === "cosine" &&
            (!vector.data_type || vector.data_type.toLowerCase() === "float32"),
        );
        const savedProfileIsCompatible = result.profiles.some(
          (profile) =>
            profile.id === binding?.profile_id &&
            profile.dimensions === vector?.size &&
            vector?.distance.toLowerCase() === "cosine" &&
            (!vector.data_type || vector.data_type.toLowerCase() === "float32"),
        );
        const sampledPaths = new Set<string>();
        result.samples.forEach((sample) =>
          collectPayloadPaths(sample.payload, "", sampledPaths, 0),
        );
        setInput((current) => ({
          ...current,
          ...(binding ?? {}),
          profile_id: savedProfileIsCompatible
            ? (binding?.profile_id ?? "")
            : (compatibleProfile?.id ?? ""),
          vector_name: vectorName,
          title_field: binding?.title_field ?? (sampledPaths.has("title") ? "title" : ""),
          source_uri_field:
            binding?.source_uri_field ?? (sampledPaths.has("source_uri") ? "source_uri" : ""),
          page_field: binding?.page_field ?? (sampledPaths.has("page") ? "page" : ""),
          heading_field:
            binding?.heading_field ?? (sampledPaths.has("heading") ? "heading" : ""),
          model_attested: false,
        }));
      })
      .catch((reason) => setError(String(reason)))
      .finally(() => setLoading(false));
  }, [bucket.ref, inspection, loading, open]);

  const payloadFields = useMemo(() => {
    const fields = new Set<string>();
    for (const sample of inspection?.samples ?? []) {
      collectPayloadPaths(sample.payload, "", fields, 0);
    }
    return Array.from(fields).sort();
  }, [inspection]);
  const selectedVector = inspection?.vectors.find((vector) => vector.name === input.vector_name);
  const compatibleProfiles = (inspection?.profiles ?? []).filter(
    (profile) =>
      selectedVector &&
      profile.dimensions === selectedVector.size &&
      selectedVector.distance.toLowerCase() === "cosine" &&
      (!selectedVector.data_type || selectedVector.data_type.toLowerCase() === "float32"),
  );

  if (bucket.compatibility !== "needs_import" && !bucket.imported) return null;

  const forget = async () => {
    // eslint-disable-next-line no-alert
    if (
      !window.confirm(
        `Forget VTerminal’s local mapping for “${bucket.label}”? The Qdrant collection and all of its points stay untouched.`,
      )
    ) {
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await api.knowledgeQdrantImportRemove(bucket.ref);
      setOpen(false);
      setInspection(null);
      await onChanged();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setLoading(false);
    }
  };

  const save = async () => {
    setLoading(true);
    setError(null);
    try {
      await api.knowledgeQdrantImportSave(bucket.ref, cleanInput(input));
      setOpen(false);
      await onChanged();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="border-t border-border-subtle pt-2">
      {!open ? (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="flex items-center gap-1 rounded-md border border-warning/30 px-2 py-1 text-[10px] text-warning hover:bg-warning/10"
          >
            <Import size={11} /> {bucket.imported ? "Review import mapping…" : "Import existing collection…"}
          </button>
          {bucket.imported && (
            <button
              type="button"
              disabled={loading}
              onClick={() => void forget()}
              className="text-[9px] text-text-muted underline-offset-2 hover:text-error hover:underline"
            >
              Forget local mapping
            </button>
          )}
          {error && <p className="w-full text-[9px] text-error">{error}</p>}
        </div>
      ) : (
        <div className="space-y-2 rounded border border-warning/30 bg-bg-elevated p-2">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[10px] font-medium text-text-secondary">Map existing collection</p>
            <button type="button" onClick={() => setOpen(false)} className="text-text-muted">
              <X size={11} />
            </button>
          </div>
          <p className="text-[9px] leading-relaxed text-text-muted">
            This saves a local interpretation only; it does not change Qdrant. Dimension alone
            never proves which model created existing vectors.
          </p>
          {loading && !inspection ? (
            <p className="flex items-center gap-1 text-[9px] text-text-muted">
              <Loader2 size={9} className="animate-spin" /> Inspecting vectors and sample payloads…
            </p>
          ) : inspection ? (
            <>
              <label className="block text-[9px] text-text-muted">
                Dense vector
                <select
                  className="mt-1 w-full rounded-md border border-border-subtle bg-bg-card px-2 py-1 text-[10px] text-text-primary"
                  value={input.vector_name}
                  onChange={(event) => {
                    const vectorName = event.target.value;
                    const vector = inspection.vectors.find((candidate) => candidate.name === vectorName);
                    const profile = inspection.profiles.find(
                      (candidate) =>
                        candidate.dimensions === vector?.size &&
                        vector?.distance.toLowerCase() === "cosine" &&
                        (!vector.data_type || vector.data_type.toLowerCase() === "float32"),
                    );
                    setInput({
                      ...input,
                      vector_name: vectorName,
                      profile_id: profile?.id ?? "",
                      model_attested: false,
                    });
                  }}
                >
                  {inspection.vectors.map((vector) => (
                    <option key={`${vector.name}:${vector.size}`} value={vector.name}>
                      {vector.name || "(default)"} · {vector.size}d · {vector.distance}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-[9px] text-text-muted">
                Exact embedding profile
                <select
                  className="mt-1 w-full rounded-md border border-border-subtle bg-bg-card px-2 py-1 text-[10px] text-text-primary"
                  value={input.profile_id}
                  onChange={(event) => setInput({ ...input, profile_id: event.target.value })}
                >
                  {compatibleProfiles.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.label} · {profile.dimensions}d
                    </option>
                  ))}
                </select>
              </label>
              {compatibleProfiles.length === 0 && (
                <p className="rounded border border-warning/30 bg-warning/10 px-2 py-1.5 text-[9px] text-warning">
                  No installed ready profile exactly matches this vector’s dimension, cosine
                  distance, and float32 data type. Install or configure the original embedding
                  profile first.
                </p>
              )}
              <div className="grid grid-cols-2 gap-1.5">
                <FieldInput label="Text field *" value={input.text_field} fields={payloadFields} onChange={(value) => setInput({ ...input, text_field: value })} />
                <FieldInput label="Document ID field *" value={input.document_id_field} fields={payloadFields} onChange={(value) => setInput({ ...input, document_id_field: value })} />
                <FieldInput label="Title field" value={input.title_field ?? ""} fields={payloadFields} onChange={(value) => setInput({ ...input, title_field: value })} />
                <FieldInput label="Source URI field" value={input.source_uri_field ?? ""} fields={payloadFields} onChange={(value) => setInput({ ...input, source_uri_field: value })} />
                <FieldInput label="Page field" value={input.page_field ?? ""} fields={payloadFields} onChange={(value) => setInput({ ...input, page_field: value })} />
                <FieldInput label="Heading field" value={input.heading_field ?? ""} fields={payloadFields} onChange={(value) => setInput({ ...input, heading_field: value })} />
              </div>
              {inspection.samples.length > 0 && (
                <details>
                  <summary className="cursor-pointer text-[9px] text-text-muted">
                    Preview sampled payload ({inspection.samples.length})
                  </summary>
                  <pre className="mt-1 max-h-32 overflow-auto rounded bg-bg-card p-1.5 text-[8px] text-text-muted">
                    {JSON.stringify(inspection.samples[0].payload, null, 2)}
                  </pre>
                </details>
              )}
              <label className="flex items-start gap-1.5 rounded border border-warning/30 p-2 text-[9px] leading-relaxed text-warning">
                <input
                  type="checkbox"
                  checked={input.model_attested}
                  onChange={(event) => setInput({ ...input, model_attested: event.target.checked })}
                />
                I attest that this is the exact original model, revision, dimension, pooling,
                normalization, and query/document transform used to create these vectors.
              </label>
              <div className="flex justify-end">
                <button
                  type="button"
                  disabled={loading || compatibleProfiles.length === 0 || !input.model_attested || !input.profile_id || !input.text_field || !input.document_id_field}
                  onClick={() => void save()}
                  className="flex items-center gap-1 rounded-md bg-accent px-2 py-1 text-[10px] text-white disabled:opacity-50"
                >
                  {loading && <Loader2 size={10} className="animate-spin" />} Save import binding
                </button>
              </div>
            </>
          ) : null}
          {error && <p className="text-[9px] text-error">{error}</p>}
        </div>
      )}
    </div>
  );
}

function FieldInput({
  label,
  value,
  fields,
  onChange,
}: {
  label: string;
  value: string;
  fields: string[];
  onChange: (value: string) => void;
}) {
  return (
    <label className="text-[8px] text-text-muted">
      {label}
      <input
        className={`${inputClass} mt-0.5`}
        list="qdrant-payload-fields"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      <datalist id="qdrant-payload-fields">
        {fields.map((field) => (
          <option key={field} value={field} />
        ))}
      </datalist>
    </label>
  );
}

function cleanInput(input: QdrantImportInput): QdrantImportInput {
  const optional = (value?: string | null) => value?.trim() || null;
  return {
    ...input,
    profile_id: input.profile_id.trim(),
    vector_name: input.vector_name.trim(),
    text_field: input.text_field.trim(),
    document_id_field: input.document_id_field.trim(),
    title_field: optional(input.title_field),
    source_uri_field: optional(input.source_uri_field),
    page_field: optional(input.page_field),
    heading_field: optional(input.heading_field),
  };
}

function collectPayloadPaths(
  value: unknown,
  prefix: string,
  output: Set<string>,
  depth: number,
) {
  if (!value || typeof value !== "object" || Array.isArray(value) || depth >= 4) return;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    output.add(path);
    collectPayloadPaths(nested, path, output, depth + 1);
  }
}
