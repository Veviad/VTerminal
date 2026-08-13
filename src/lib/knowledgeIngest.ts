import { sniffMediaType } from "./attachments";
import { extractPages } from "./docsIndex";
import * as api from "./tauri";
import type {
  DocFile,
  KnowledgeBucketRef,
  KnowledgeDocumentManifest,
  KnowledgeJob,
} from "./types";

export interface KnowledgeFileIngestOutcome {
  file: string;
  job: KnowledgeJob | null;
  error: string | null;
}
/** Extract and enqueue selected files for a remote bucket. Shared by the bucket-level
 * document browser and the primary Add knowledge wizard so format/security behavior
 * cannot drift between the two entry points. */
export async function ingestKnowledgeFiles(
  bucket: KnowledgeBucketRef,
  files: File[],
  options: {
    replacement?: KnowledgeDocumentManifest;
    onExtracting?: (file: File, index: number, total: number) => void;
  } = {},
): Promise<KnowledgeFileIngestOutcome[]> {
  if (bucket.source !== "qdrant") {
    throw new Error("direct file ingestion applies only to Qdrant buckets");
  }
  const outcomes: KnowledgeFileIngestOutcome[] = [];
  for (const [index, file] of files.entries()) {
    options.onExtracting?.(file, index, files.length);
    try {
      const bytes = await readFileBytes(file);
      const mediaType = sniffMediaType(bytes) ?? (file.type || "application/octet-stream");
      const source: DocFile = {
        id: `remote-${Date.now()}-${index}`,
        bucket_id: bucket.collection,
        path: file.name,
        name: file.name,
        media_type: mediaType,
        size_bytes: file.size,
        mtime_ms: file.lastModified,
        state: "pending",
        state_reason: null,
        page_count: null,
        chunk_count: 0,
        indexed_at: null,
      };
      const extracted = await extractPages(source, bytes);
      if (!extracted.ok) throw new Error(extracted.reason);
      const job = await api.knowledgeDocumentIngest({
        bucket,
        title: options.replacement?.title ?? file.name,
        source_uri: file.name,
        mime_type: mediaType,
        pages: extracted.pages,
        size_bytes: file.size,
        mtime_ms: file.lastModified,
        ...(options.replacement ? { document_id: options.replacement.document_id } : {}),
      });
      outcomes.push({ file: file.name, job, error: null });
    } catch (reason) {
      outcomes.push({ file: file.name, job: null, error: String(reason) });
    }
  }
  return outcomes;
}

/** Coarse pre-extraction estimate, deliberately shown with a `~`. Text density and PDF
 * structure make exact chunk counts unknowable until extraction; 3 KB of source per
 * 1,000-character overlapping passage is a useful planning estimate without promising
 * false precision. */
export function estimateKnowledgeFiles(files: File[]): {
  bytes: number;
  chunks: number;
} {
  const bytes = files.reduce((sum, file) => sum + file.size, 0);
  return { bytes, chunks: files.length === 0 ? 0 : Math.max(files.length, Math.ceil(bytes / 3000)) };
}

async function readFileBytes(file: File): Promise<Uint8Array> {
  if (typeof file.arrayBuffer === "function") {
    return new Uint8Array(await file.arrayBuffer());
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error(`Could not read ${file.name}`));
    reader.onload = () => {
      const value = reader.result;
      if (!(value instanceof ArrayBuffer)) {
        reject(new Error(`Could not read ${file.name}`));
        return;
      }
      resolve(new Uint8Array(value));
    };
    reader.readAsArrayBuffer(file);
  });
}
