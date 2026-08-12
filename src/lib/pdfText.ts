/** The ONLY module that touches pdf.js.
 *
 *  Pure in the same sense as `attachments.ts`: pdf.js and canvas, no React, no IPC,
 *  no store. Everything about how a PDF becomes an `Attachment` lives in
 *  `attachments.ts`; this just gets the text out.
 *
 *  Three things here are load-bearing and were each verified against the pinned
 *  6.2.108 source rather than assumed — see the comments on `loadPdfjs`,
 *  `extractPdfText`'s buffer copy, and the per-page yield.
 */

/** Pages read for text. A 200-page report is not going into a chat turn; this
 *  bounds the main-thread parse, and `MAX_TEXT_BYTES` bounds the payload. */
export const PDF_MAX_PAGES = 50;

/** Pages sent to the on-device reader when a PDF has no text layer. Each is a real
 *  model call (~1.5s, serialized behind the one process-wide inference permit), so
 *  this is far tighter than the text cap. */
export const PDF_OCR_MAX_PAGES = 4;

export interface PdfExtract {
  pageCount: number;
  /** How many pages were actually looked at — below `pageCount` when capped. */
  pagesRead: number;
  /** Only the pages that yielded text. */
  pages: { page: number; text: string }[];
  /** Pages that were read but had no text layer — a scan inside a document. */
  emptyPages: number[];
}

export type PdfOutcome =
  | { ok: true; extract: PdfExtract }
  | { ok: false; reason: "locked" | "invalid" };

type PdfjsModule = typeof import("pdfjs-dist/legacy/build/pdf.mjs");

let cached: Promise<PdfjsModule> | null = null;

/**
 * Load pdf.js once, configured to run on the MAIN THREAD with no worker.
 *
 * Three verified facts drive every choice here:
 *
 * 1. **The `legacy/` build, not `build/`.** `build/pdf.mjs` uses
 *    `Promise.withResolvers` (27 sites) with no polyfill — that shipped in Safari
 *    17.4, and `minimumSystemVersion: "13.0"` admits a never-updated Ventura on
 *    Safari 16. `legacy/` inlines core-js for it. It is also the only one with a
 *    `.d.mts`, so `build/` would additionally be untyped under `strict`.
 *
 * 2. **`globalThis.pdfjsWorker` is the main-thread lever — not `workerPort = null`,
 *    and there is no `disableWorker` in v6.** `PDFWorker.#initialize()` tests
 *    `#isWorkerDisabled || #mainThreadWorkerMessageHandler` and takes the fake-worker
 *    branch BEFORE anything reads `workerSrc` (whose getter throws when unset). So
 *    assigning the worker module here means no `new Worker`, no `workerSrc`, and —
 *    the point on Tauri — no fetch across the `tauri://` custom scheme. Left to
 *    itself pdf.js would find `URL.parse(location).origin === "null"` on a
 *    non-special scheme, decide the worker is cross-origin, and route through a
 *    `blob:` wrapper that imports `tauri://…` — exactly the fragile combination.
 *
 * 3. **Ordering is load-bearing.** `_setupFakeWorkerGlobal` is `shadow()`-memoized,
 *    so a single `getDocument` before `globalThis.pdfjsWorker` is set caches the
 *    failing path for the life of the process. This function is the only door.
 */
async function loadPdfjs(): Promise<PdfjsModule> {
  cached ??= (async () => {
    const [api, worker] = await Promise.all([
      import("pdfjs-dist/legacy/build/pdf.mjs"),
      import("pdfjs-dist/legacy/build/pdf.worker.mjs"),
    ]);
    (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = worker;
    return api;
  })();
  return cached;
}

/** pdf.js's own text layer joins on `hasEOL`; matching it keeps line structure
 *  that a naive space-join would flatten. */
function pageText(items: { str?: string; hasEOL?: boolean }[]): string {
  return items
    .filter((i) => typeof i.str === "string")
    .map((i) => i.str! + (i.hasEOL ? "\n" : ""))
    .join("")
    .trim();
}

export async function extractPdfText(
  bytes: Uint8Array,
  maxPages: number = PDF_MAX_PAGES,
): Promise<PdfOutcome> {
  const pdfjs = await loadPdfjs();

  // The loading TASK is kept, not just its promise: `destroy()` lives on the task,
  // and it is what releases the parsed document.
  let task: ReturnType<typeof pdfjs.getDocument> | null = null;
  let doc;
  try {
    task = pdfjs.getDocument({
      // A COPY, deliberately. `getDocument` passes `[data.buffer]` as the transfer
      // list and `LoopbackPort.postMessage` structured-clones with it — so the
      // caller's view is detached to zero length even on the main-thread path.
      // `ingestBlob` reuses its `bytes` afterwards; without this the reuse silently
      // sees an empty file.
      data: new Uint8Array(bytes),
      // Silences the "Setting up fake worker." warning, which is expected here.
      verbosity: 0,
    });
    doc = await task.promise;
  } catch (err) {
    const name = (err as { name?: string })?.name;
    return { ok: false, reason: name === "PasswordException" ? "locked" : "invalid" };
  }

  const pageCount = doc.numPages;
  const pagesRead = Math.min(pageCount, Math.max(1, maxPages));
  const pages: { page: number; text: string }[] = [];
  const emptyPages: number[] = [];

  try {
    for (let n = 1; n <= pagesRead; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      const text = pageText(content.items as { str?: string; hasEOL?: boolean }[]);
      if (text) pages.push({ page: n, text });
      else emptyPages.push(n);
      page.cleanup();
      // Yield to the event loop between pages. `LoopbackPort` defers with
      // microtasks only, so without this the main thread never paints and the drop
      // overlay freezes for the whole parse.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  } finally {
    // Frees the parsed document; on the fake worker that is still real memory held
    // by the module for the life of the process.
    await task.destroy().catch(() => {});
  }

  return { ok: true, extract: { pageCount, pagesRead, pages, emptyPages } };
}

/** Render specific pages to PNG, for a PDF with no text layer.
 *
 *  Self-contained on purpose: `attachments.ts` dynamically imports THIS module, so
 *  importing its `encode`/`base64FromBytes` back would be a cycle that happens to
 *  resolve — the kind of thing that works until someone reorders an import. Twelve
 *  lines of canvas is the cheaper price.
 *
 *  pdf.js does the scaling itself via `getViewport`, so `drawScaled` (which takes an
 *  ImageBitmap) is not involved.
 */
export async function rasterizePdfPages(
  bytes: Uint8Array,
  pageNumbers: number[],
  maxEdge: number,
): Promise<{ page: number; mediaType: string; data: string }[]> {
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0 });
  const doc = await task.promise;
  const out: { page: number; mediaType: string; data: string }[] = [];

  try {
    for (const n of pageNumbers) {
      if (n < 1 || n > doc.numPages) continue;
      const page = await doc.getPage(n);
      const unscaled = page.getViewport({ scale: 1 });
      const scale = Math.min(1, maxEdge / Math.max(unscaled.width, unscaled.height));
      const viewport = page.getViewport({ scale });

      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("no 2d context");
      // White ground: a PDF page is transparent where it is unpainted, and a
      // transparent-to-black render makes scanned text unreadable.
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport, canvas }).promise;
      page.cleanup();

      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob((b) => resolve(b), "image/png"),
      );
      if (!blob) continue;
      const buf = new Uint8Array(await blob.arrayBuffer());
      const CHUNK = 0x8000;
      let s = "";
      for (let i = 0; i < buf.length; i += CHUNK) {
        s += String.fromCharCode(...buf.subarray(i, i + CHUNK));
      }
      out.push({ page: n, mediaType: "image/png", data: btoa(s) });
      // Same yield as the text path: rendering does not paint otherwise.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  } finally {
    await task.destroy().catch(() => {});
  }
  return out;
}
