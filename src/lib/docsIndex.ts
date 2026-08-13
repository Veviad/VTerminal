/** Driving the indexing pass for a document bucket.
 *
 *  **Why the loop lives in the frontend at all.** `pdfText.ts` is the only module in
 *  the app that can read a PDF (pdf.js, main thread, no worker — for verified reasons
 *  in its header), and there is no `fs` plugin, so the webview cannot open a path. The
 *  split that falls out is: **Rust owns paths, bytes, hashes and the database; the
 *  frontend owns turning bytes into text.** Each file makes one round trip —
 *  `docsReadSource` down, `docsPutText` back up — which is cheaper than adding a Rust
 *  PDF extractor that would duplicate this logic and be worse at it.
 *
 *  Extraction is sequential, never `Promise.all`: a 400-page PDF is tens of MB of
 *  parsed page objects, and `stageInputs` already made the same choice for the same
 *  reason. It also means cancelling between files is exact.
 */

import * as api from "./tauri";
import { sniffMediaType, fitUtf8 } from "./attachments";
import { extractPdfText } from "./pdfText";
import { ocrAvailable } from "./attachInput";
import { useAppStore } from "../stores/appStore";
import { S } from "./strings";
import type { DocFile, DocPutPage } from "./types";
import { localBucketDescriptor } from "./knowledge";

/** Pages read per PDF in a LIBRARY, as opposed to `PDF_MAX_PAGES = 50` for one chat
 *  turn. The chat cap bounds a single message's token cost; a bucket has no such
 *  constraint — a 400-page manual should be indexed whole, because retrieval only
 *  ever returns the handful of passages that matched. */
export const DOC_MAX_PAGES = 2000;

/** Extracted text kept per file. Far above the chat path's `MAX_TEXT_BYTES` (128 KB)
 *  and for the same reason as the page cap. */
export const DOC_MAX_TEXT_BYTES = 8 * 1024 * 1024;

/** Files claimed from Rust per round trip. */
const BATCH = 25;

export interface IndexReport {
  indexed: number;
  unchanged: number;
  failed: number;
  cancelled: boolean;
}

/** Strip what has no business in reference text.
 *
 *  Framed as HYGIENE, not as a security control, and the distinction is deliberate:
 *  trying to detect prompt injection at index time does not work — the phrasings are
 *  unbounded — and a filter that half-works produces false confidence. What actually
 *  holds the boundary is the fencing and labelling in `docs::search::render_results`
 *  plus the `AGENT_DOCS` prompt.
 *
 *  These two removals earn their place on different grounds. Control characters would
 *  reach a terminal-adjacent UI and cannot appear in legitimate prose. Zero-width
 *  characters are worse than useless here: they survive into a chunk, and they let text
 *  the user reviewed differ from the text the model receives — which defeats the user's
 *  ability to audit their own bucket. */
export function sanitizeIndexText(text: string): string {
  return (
    text
      // Control characters except tab and newline.
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
      // Zero-width space/joiner/non-joiner, BOM, and the bidi overrides.
      .replace(/[\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g, "")
      .replace(/\r\n?/g, "\n")
  );
}

/** HTML to readable text.
 *
 *  `DOMParser` rather than a regex: it decodes entities correctly and cannot be fooled
 *  by an attribute containing `>`. It produces an INERT document — no script executes,
 *  no subresource is fetched — so parsing a downloaded page here is safe. `<script>`
 *  and `<style>` bodies are dropped because they are not prose; keeping them would
 *  spend the chunk budget on minified JavaScript.
 */
export function htmlToText(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("script, style, noscript, template, svg").forEach((el) => el.remove());
  const text = doc.body?.innerText ?? doc.body?.textContent ?? "";
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** Turn one file's bytes into pages, or explain why not.
 *
 *  Exported for testing: this is the whole per-format decision table, and it is worth
 *  asserting directly rather than through the loop. */
export async function extractPages(
  file: DocFile,
  bytes: Uint8Array,
): Promise<{ ok: true; pages: DocPutPage[] } | { ok: false; reason: string }> {
  // Magic bytes, never the extension or the stored media type. The scanner used the
  // extension to decide what was worth OFFERING; what a file actually IS gets decided
  // here, so a `.md`-named PDF is read as a PDF and a `.png`-named text file is not
  // handed to an image reader.
  const sniffed = sniffMediaType(bytes);
  const kind = sniffed ?? file.media_type;

  if (kind === "application/pdf") {
    const outcome = await extractPdfText(bytes, DOC_MAX_PAGES);
    if (!outcome.ok) {
      return {
        ok: false,
        reason: outcome.reason === "locked" ? S.settings.docs.pdfLocked : S.settings.docs.pdfInvalid,
      };
    }
    const { pages, pageCount } = outcome.extract;
    if (pages.length === 0) {
      // A scan with no text layer. The vision sidecar can read these, and stage 3
      // wires that in; saying so is better than a bare failure the user cannot act on.
      return { ok: false, reason: S.settings.docs.pdfNoText(pageCount) };
    }
    return {
      ok: true,
      pages: pages.map((p) => ({ page: p.page, text: sanitizeIndexText(p.text) })),
    };
  }

  if (kind.startsWith("image/")) {
    // Reuses the on-device sidecar that already transcribes chat attachments. Without
    // one there is nothing to fall back to — an image has no text layer to read.
    if (!ocrAvailable()) {
      return { ok: false, reason: S.settings.docs.imageNeedsReader };
    }
    const base64 = btoa(String.fromCharCode(...bytes.subarray(0, bytes.length)));
    try {
      const text = await api.visionDescribe(`docs-${file.id}`, base64);
      const clean = sanitizeIndexText(text).trim();
      if (!clean) return { ok: false, reason: S.settings.docs.imageEmpty };
      return { ok: true, pages: [{ page: null, text: clean }] };
    } catch (e) {
      return { ok: false, reason: String(e) };
    }
  }

  const decoded = decodeUtf8(bytes);
  if (decoded === null) return { ok: false, reason: S.settings.docs.notText };

  const text =
    kind === "text/html"
      ? htmlToText(decoded)
      : sanitizeIndexText(decoded);
  const trimmed = sanitizeIndexText(text).trim();
  if (!trimmed) return { ok: false, reason: S.settings.docs.noTextInFile };

  // `"start"` keeps the HEAD, per `fitUtf8`'s own note that a document's beginning is
  // the payload where a log's end is. A reference document that overruns the cap loses
  // its tail, not its title and introduction.
  return {
    ok: true,
    pages: [{ page: null, text: fitUtf8(trimmed, DOC_MAX_TEXT_BYTES, "start").text }],
  };
}

/** Index everything in `bucketId` that is pending or stale.
 *
 *  Never throws: a bucket with one unreadable file must still index the other
 *  thirty-nine. Per-file failures are recorded as `failed` with a reason the user can
 *  read, and the loop continues — the same tolerance `stageInputs` applies to a batch
 *  of dropped files.
 */
export async function indexBucket(bucketId: string): Promise<IndexReport> {
  const store = useAppStore.getState();
  const report: IndexReport = { indexed: 0, unchanged: 0, failed: 0, cancelled: false };

  // Re-stat first, so a file edited on disk since the last pass is picked up in this
  // one rather than after a second click.
  try {
    await api.docsRefreshStates(bucketId);
  } catch {
    // Non-fatal: the worst case is that an edited file is indexed next time.
  }

  // The total comes from the bucket's own counts, which `list_buckets` already computes
  // in SQL. Asking `docsFilesNeedingWork` for a big number instead would be wrong as
  // well as wasteful: the command clamps `limit` to 500, so any bucket with more pending
  // files than that would report a total short of the real one and the progress line
  // would stall at "500 of 500" while work continued.
  let done = 0;
  try {
    await refreshBuckets();
  } catch (e) {
    store.setDocsError(String(e));
    return report;
  }
  const bucket = useAppStore.getState().docBuckets.find((b) => b.id === bucketId);
  const total = (bucket?.pending_count ?? 0) + (bucket?.stale_count ?? 0);
  store.setDocsIndexing(bucketId, { done: 0, total, current: null });

  try {
    for (;;) {
      if (useAppStore.getState().docsIndexing[bucketId]?.cancel) {
        report.cancelled = true;
        break;
      }
      const batch = await api.docsFilesNeedingWork(bucketId, BATCH);
      if (batch.length === 0) break;

      for (const file of batch) {
        // Checked per FILE, not per batch: a cancel must take effect within one file,
        // and never mid-file, so the bucket is never left half-written.
        if (useAppStore.getState().docsIndexing[bucketId]?.cancel) {
          report.cancelled = true;
          break;
        }
        store.setDocsIndexing(bucketId, { done, total, current: file.name });

        try {
          const bytes = await api.docsReadSource(file.id);
          const extracted = await extractPages(file, bytes);
          if (!extracted.ok) {
            await api.docsFileFailed(file.id, extracted.reason);
            report.failed += 1;
          } else {
            const outcome = await api.docsPutText(file.id, extracted.pages);
            if (outcome.kind === "unchanged") report.unchanged += 1;
            else report.indexed += 1;
          }
        } catch (e) {
          // Includes the Rust-side refusals: a path that became a symlink, or one
          // outside the bucket's roots. Recording the reason is what makes those
          // visible rather than mysterious.
          try {
            await api.docsFileFailed(file.id, String(e));
          } catch {
            // The bucket may have been deleted mid-pass; nothing left to record onto.
          }
          report.failed += 1;
        }
        done += 1;
      }
      if (report.cancelled) break;
    }
  } catch (e) {
    store.setDocsError(String(e));
  } finally {
    store.setDocsIndexing(bucketId, null);
    await refreshBuckets();
  }

  return report;
}

/** Reload the bucket list into the store.
 *
 *  Safe to call when the feature is off: the command refuses and the list is emptied,
 *  which is the correct rendering for "no buckets" and keeps every caller free of a
 *  `docsEnabled` check. */
export async function refreshBuckets(): Promise<void> {
  try {
    useAppStore.getState().setDocBuckets(await api.docsBucketsList());
  } catch {
    useAppStore.getState().setDocBuckets([]);
  }
}

/** Refresh source-qualified local and remote knowledge buckets without making the
 * legacy local list depend on a Qdrant connection being reachable. */
export async function refreshKnowledgeBuckets(): Promise<void> {
  try {
    useAppStore.getState().setKnowledgeBuckets(await api.knowledgeBucketsList());
  } catch {
    const state = useAppStore.getState();
    // A backend that fails the whole unified call must not make already-loaded local
    // buckets disappear from the picker.
    state.setKnowledgeBuckets(state.docBuckets.map(localBucketDescriptor));
  }
}
