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
    case "requires_profile":
      return "Model required";
    case "unmanaged":
      return "Not a VTerminal collection";
    case "legacy_import":
      return "Legacy read only";
    case "upgrade_required":
      return "Upgrade required";
    case "incompatible":
      return "Incompatible";
    case "unreadable":
      return "No access";
    default:
      // A cached descriptor from an older app must fail closed rather than
      // reviving a removed workflow such as the v0.2.0 import wizard.
      return "Unavailable";
  }
}

/** True only for shared-contract Qdrant collections that belong in the normal
 * Knowledge UI. Legacy local bindings have their own Advanced compatibility
 * surface; unknown statuses from an older cache stay hidden. */
export function isManagedQdrantBucket(bucket: KnowledgeBucketDescriptor): boolean {
  if (bucket.ref.source !== "qdrant" || bucket.imported) return false;
  switch (bucket.compatibility) {
    case "managed_compatible":
    case "attach_only":
    case "requires_profile":
    case "upgrade_required":
    case "incompatible":
    case "unreadable":
      return true;
    case "unmanaged":
    case "legacy_import":
    default:
      return false;
  }
}
