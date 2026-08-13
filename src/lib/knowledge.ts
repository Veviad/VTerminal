import type {
  DocBucket,
  KnowledgeBucketDescriptor,
  KnowledgeBucketRef,
  KnowledgeCompatibility,
} from "./types";

/** Convert the v1 local-id attachment shape at the frontend boundary. */
export function normalizeKnowledgeBucketRef(
  ref: string | KnowledgeBucketRef,
): KnowledgeBucketRef {
  return typeof ref === "string" ? { source: "local", bucket_id: ref } : ref;
}
/** JSON is intentionally not used as an identity key: field ordering must not be able
 * to turn one collection into two checkbox entries. */
export function knowledgeBucketKey(ref: string | KnowledgeBucketRef): string {
  const normalized = normalizeKnowledgeBucketRef(ref);
  return normalized.source === "local"
    ? `local:${normalized.bucket_id}`
    : `qdrant:${encodeURIComponent(normalized.connection_id)}:${encodeURIComponent(normalized.collection)}`;
}

export function sameKnowledgeBucket(
  left: string | KnowledgeBucketRef,
  right: string | KnowledgeBucketRef,
): boolean {
  return knowledgeBucketKey(left) === knowledgeBucketKey(right);
}

export function localBucketDescriptor(bucket: DocBucket): KnowledgeBucketDescriptor {
  return {
    ref: { source: "local", bucket_id: bucket.id },
    label: bucket.label,
    connection_label: null,
    profile: null,
    compatibility: "managed_compatible",
    compatibility_reason: null,
    attachable: bucket.chunk_count > 0,
    writable: true,
    manageable: true,
    file_count: bucket.file_count,
    chunk_count: bucket.chunk_count,
    pending_count: bucket.pending_count + bucket.stale_count,
    stale: false,
    error: null,
  };
}

export function compatibilityLabel(status: KnowledgeCompatibility): string {
  switch (status) {
    case "managed_compatible":
      return "Compatible";
    case "attach_only":
      return "Read only";
    case "needs_import":
      return "Import required";
    case "upgrade_required":
      return "Upgrade required";
    case "incompatible":
      return "Incompatible";
    case "unreadable":
      return "No access";
  }
}
