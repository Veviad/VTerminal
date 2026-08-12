import type { Attachment } from "./types";

/** Normalization of dropped/pasted/picked files, before anything touches IPC.
 *
 *  Deliberately frontend-side. Rust has no `image` crate, adding one burdens a
 *  build already dominated by llama.cpp, and it still would not decode HEIC —
 *  which is what macOS hands you straight out of Photos. WKWebView decodes HEIC
 *  through the system decoder for free, and in the drop and paste paths the
 *  bytes are already here, so shipping 20MB to Rust to get 200KB back would be a
 *  round trip for nothing.
 *
 *  Pure: no React, no IPC, no store. Every branch is unit-testable.
 */

/** Rejected on `File.size` before any decode — never read a huge file to find
 *  out that it is huge. */
export const MAX_SOURCE_BYTES = 25 * 1024 * 1024;
/** Per-image ceiling AFTER re-encoding. Anthropic's own limit is 5MB of base64;
 *  4 leaves room for the ~33% base64 expansion plus the rest of the body. */
export const MAX_ENCODED_BYTES = 4 * 1024 * 1024;
export const MAX_TEXT_BYTES = 128 * 1024;
export const MAX_ATTACHMENTS = 6;
/** Long-edge cap. The universally safe value: every vision model in the catalog
 *  accepts it, and it costs ~1600 image tokens. Claude Sonnet 5 / Opus 5 are in
 *  a higher tier that takes `HIGH_RES_MAX_EDGE`, at roughly 3x the tokens —
 *  a per-model tuning knob, never the default. */
export const IMAGE_MAX_EDGE = 1568;
export const HIGH_RES_MAX_EDGE = 2576;

const JPEG_QUALITY_LADDER = [0.85, 0.7, 0.55] as const;

export type IngestFailure =
  | { code: "too_large"; bytes: number; limit: number }
  | { code: "unsupported"; name: string }
  | { code: "decode_failed"; name: string }
  // PDFs fail in three genuinely different ways, and the user's next action differs
  // for each. `decode_failed`'s copy ("could not be read as an image") is wrong for
  // all of them. `describeIngestFailure` switches exhaustively with no `default`, so
  // each of these is a compile error until its string exists.
  | { code: "pdf_locked"; name: string }
  | { code: "pdf_failed"; name: string }
  /** No text layer on any page — it is a scan. `pageCount` lets the caller decide
   *  whether to offer on-device reading, and how much of it. */
  | { code: "pdf_no_text"; name: string; pageCount: number };

export type IngestResult = { ok: true; attachment: Attachment } | { ok: false } & IngestFailure;

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/heic"]);

/** Media type from the leading bytes, never from `File.type`.
 *
 *  `File.type` is empty on some clipboard paths and is caller-supplied metadata
 *  everywhere else — a `.png` name on a text file must not become an image part.
 */
export function sniffMediaType(bytes: Uint8Array): string | null {
  const at = (i: number) => bytes[i];
  const ascii = (start: number, s: string) => {
    for (let i = 0; i < s.length; i++) if (at(start + i) !== s.charCodeAt(i)) return false;
    return true;
  };

  if (bytes.length >= 8 && at(0) === 0x89 && ascii(1, "PNG")) return "image/png";
  if (bytes.length >= 3 && at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";
  if (bytes.length >= 6 && ascii(0, "GIF8")) return "image/gif";
  if (bytes.length >= 12 && ascii(0, "RIFF") && ascii(8, "WEBP")) return "image/webp";
  // ISO-BMFF: the brand sits at 8..12, behind the `ftyp` box marker at 4..8.
  if (bytes.length >= 12 && ascii(4, "ftyp")) {
    for (const brand of ["heic", "heix", "hevc", "heim", "heis", "mif1", "msf1"]) {
      if (ascii(8, brand)) return "image/heic";
    }
  }
  // Offset 0 only, strict like every other branch above. A PDF with leading junk
  // falls through to the text path and is rejected as unsupported — scanning for a
  // header anywhere in the first KB would also match a PDF quoted inside a log.
  if (bytes.length >= 5 && ascii(0, "%PDF-")) return "application/pdf";
  return null;
}

/** Checked lazily, not at module load: a module-level constant would freeze the
 *  answer before a test (or a polyfill) had a chance to install anything. */
function canUseOffscreen(): boolean {
  return (
    typeof OffscreenCanvas !== "undefined" &&
    typeof OffscreenCanvas.prototype?.convertToBlob === "function"
  );
}

function drawScaled(
  bitmap: ImageBitmap,
  w: number,
  h: number,
): OffscreenCanvas | HTMLCanvasElement {
  if (canUseOffscreen()) {
    const c = new OffscreenCanvas(w, h);
    const ctx = c.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    ctx.drawImage(bitmap, 0, 0, w, h);
    return c;
  }
  // macOS 13 is the minimum target and predates OffscreenCanvas.convertToBlob
  // in WebKit, so the DOM canvas is a real fallback, not dead code.
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("no 2d context");
  ctx.drawImage(bitmap, 0, 0, w, h);
  return c;
}

function encode(
  canvas: OffscreenCanvas | HTMLCanvasElement,
  type: string,
  quality?: number,
): Promise<Blob> {
  if ("convertToBlob" in canvas) return canvas.convertToBlob({ type, quality });
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("encode failed"))),
      type,
      quality,
    ),
  );
}

export function base64FromBytes(bytes: Uint8Array): string {
  // Chunked because spreading a multi-MB array into fromCharCode overflows the
  // argument list and throws RangeError.
  const CHUNK = 0x8000;
  let s = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

export async function toBase64(blob: Blob): Promise<string> {
  return base64FromBytes(new Uint8Array(await blob.arrayBuffer()));
}

/** A `src` for an <img>. Data URI rather than an object URL so there is no
 *  revoke lifecycle to get wrong across re-renders. */
export function thumbnailSrc(a: Attachment): string | null {
  return a.data ? `data:${a.mediaType};base64,${a.data}` : null;
}

function newId(): string {
  return `att-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function normalizeImage(
  blob: Blob,
  mediaType: string,
  name: string,
  maxEdge: number,
): Promise<IngestResult> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    return { ok: false, code: "decode_failed", name };
  }

  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const finish = async (out: Blob, type: string): Promise<IngestResult> => ({
    ok: true,
    attachment: {
      id: newId(),
      kind: "image",
      name,
      mediaType: type,
      bytes: out.size,
      data: await toBase64(out),
      width,
      height,
    },
  });

  // Untouched PNG that already fits: re-encoding would only lose sharpness.
  if (scale === 1 && mediaType === "image/png" && blob.size <= MAX_ENCODED_BYTES) {
    bitmap.close();
    return finish(blob, "image/png");
  }

  let canvas: OffscreenCanvas | HTMLCanvasElement;
  try {
    canvas = drawScaled(bitmap, width, height);
  } catch {
    return { ok: false, code: "decode_failed", name };
  } finally {
    bitmap.close();
  }

  try {
    // PNG first for anything that arrived as PNG. Screenshots are flat colour and
    // text, where PNG is both smaller AND sharper than JPEG — and a screenshot of
    // a terminal is the whole point of this feature.
    if (mediaType === "image/png") {
      const png = await encode(canvas, "image/png");
      if (png.size <= MAX_ENCODED_BYTES) return finish(png, "image/png");
    }
    let last: Blob | null = null;
    for (const quality of JPEG_QUALITY_LADDER) {
      last = await encode(canvas, "image/jpeg", quality);
      if (last.size <= MAX_ENCODED_BYTES) return finish(last, "image/jpeg");
    }
    // Past the ladder: keep the smallest we produced rather than rejecting. 4MB
    // is our own conservative budget, and the provider limit is above it.
    if (last) return finish(last, "image/jpeg");
    return { ok: false, code: "decode_failed", name };
  } catch {
    return { ok: false, code: "decode_failed", name };
  }
}

/** Cut `text` down to `limit` UTF-8 bytes, keeping whichever end matters.
 *
 *  Slices the DECODED string so the cut always lands on a character boundary, then
 *  shrinks until the re-encoded result fits. Shared because the two callers keep
 *  OPPOSITE ends and the loop is the fiddly part: a log's end says what went wrong,
 *  a document's beginning is the payload.
 */
export function fitUtf8(
  text: string,
  limit: number,
  keepEnd: "start" | "end",
): { text: string; chars: number } {
  const enc = new TextEncoder();
  if (enc.encode(text).length <= limit) return { text, chars: text.length };
  let chars = Math.min(text.length, limit);
  const take = () => (keepEnd === "end" ? text.slice(-chars) : text.slice(0, chars));
  let out = take();
  while (chars > 0 && enc.encode(out).length > limit) {
    chars = Math.floor(chars * 0.9);
    out = take();
  }
  return { text: out, chars };
}

function normalizeText(bytes: Uint8Array, name: string): IngestResult {
  let text: string;
  try {
    // `fatal` is the whole test: a binary file that is not a known image type is
    // rejected here rather than reaching a model as mojibake.
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, code: "unsupported", name };
  }

  let truncated = false;
  if (bytes.length > MAX_TEXT_BYTES) {
    truncated = true;
    // TAIL — the same reasoning as the command-output cap: the end of a log is what
    // says what went wrong. (The PDF path keeps the HEAD instead; see there.)
    const cut = fitUtf8(text, MAX_TEXT_BYTES, "end");
    text = `… (truncated, showing the last ${cut.chars} chars of ${bytes.length} bytes)\n${cut.text}`;
  }

  return {
    ok: true,
    attachment: {
      id: newId(),
      kind: "text",
      name,
      mediaType: "text/plain",
      bytes: new TextEncoder().encode(text).length,
      text,
      truncated,
    },
  };
}

/** A PDF becomes ONE text attachment — never one image part per page.
 *
 *  That is the load-bearing decision here, and four things break if pages become
 *  images instead:
 *
 *  * `imagesBlocked` in the panel would make a born-digital PDF unsendable on a
 *    model with no vision, even though its text extracted perfectly.
 *  * `HISTORY_IMAGE_TURNS = 0` strips images from every replayed turn, so a
 *    follow-up "what does page 4 say?" would hit a model that can no longer see it.
 *    Text folded into `content` IS replayed — for a document that is the point.
 *  * `MAX_ATTACHMENTS = 6` is enforced with a user-facing message; a 9-page PDF
 *    exploding into 9 attachments makes that message a lie about what they did.
 *  * ~1600 image tokens per page against ~400–800 text tokens.
 *
 *  Scanned pages are read by the on-device sidecar and folded into this SAME
 *  attachment — see `transcribePdfScan` in `attachInput.ts`.
 */
async function normalizePdf(bytes: Uint8Array, name: string): Promise<IngestResult> {
  // Dynamic, so the 3.4MB of pdf.js is a lazy chunk nobody fetches until they drop
  // a PDF. `vite.config.ts` excludes it from dep pre-bundling for the dev-reload
  // reason documented there.
  const { extractPdfText, PDF_MAX_PAGES } = await import("./pdfText");

  const out = await extractPdfText(bytes);
  if (!out.ok) {
    return out.reason === "locked"
      ? { ok: false, code: "pdf_locked", name }
      : { ok: false, code: "pdf_failed", name };
  }
  const { pageCount, pagesRead, pages, emptyPages } = out.extract;
  if (pages.length === 0) {
    // Not terminal by itself — `stageInputs` offers the on-device reader when one
    // is available, and only reports this when there is none.
    return { ok: false, code: "pdf_no_text", name, pageCount };
  }

  const body = assemblePdfBody(pages, emptyPages, pageCount, pagesRead, PDF_MAX_PAGES);
  return {
    ok: true,
    attachment: {
      id: newId(),
      kind: "text",
      // `kind` stays "text" so nothing downstream needs a new branch; the media type
      // is what tells the chip to show a PDF icon.
      mediaType: "application/pdf",
      name,
      bytes: new TextEncoder().encode(body.text).length,
      text: body.text,
      truncated: body.truncated,
    },
  };
}

/** Assemble the folded body, page-labelled, under `MAX_TEXT_BYTES`.
 *
 *  Pages are natural cut points, so this stops when the next page would cross the
 *  cap rather than slicing mid-page — and it keeps the HEAD, unlike `normalizeText`.
 *  A document's beginning is the payload; a log's end is.
 */
export function assemblePdfBody(
  pages: { page: number; text: string }[],
  emptyPages: number[],
  pageCount: number,
  pagesRead: number,
  pageCap: number,
): { text: string; truncated: boolean } {
  const enc = new TextEncoder();
  const empty = new Set(emptyPages);
  const chunks: string[] = [];
  let used = 0;
  let lastIncluded = 0;
  let cut = false;

  for (let n = 1; n <= pagesRead; n++) {
    // A scan inside a text document must not read as a blank page — say so where the
    // page would have been.
    const found = pages.find((p) => p.page === n);
    const piece = empty.has(n)
      ? `--- page ${n} ---\n[no text layer on this page]`
      : found
        ? `--- page ${n} ---\n${found.text}`
        : null;
    if (piece === null) continue;
    const cost = enc.encode(piece).length + 2;
    if (used + cost > MAX_TEXT_BYTES) {
      cut = true;
      break;
    }
    chunks.push(piece);
    used += cost;
    lastIncluded = n;
  }

  // If even the first page will not fit, keep its head rather than nothing at all.
  if (chunks.length === 0 && pages.length > 0) {
    cut = true;
    lastIncluded = pages[0].page;
    chunks.push(
      `--- page ${pages[0].page} ---\n${fitUtf8(pages[0].text, MAX_TEXT_BYTES - 200, "start").text}`,
    );
  }

  const truncated = cut || pagesRead < pageCount;
  // The header is the announcement. Every cap that bit is named here, in the text
  // the MODEL reads — silence would let it answer as if it had the whole document.
  const shown = `1-${lastIncluded}`;
  const why = pagesRead < pageCount ? ` (${pageCap}-page limit)` : cut ? " (size limit)" : "";
  const header = truncated
    ? `[PDF, ${pageCount} pages — showing pages ${shown} of ${pageCount}${why}]`
    : `[PDF, ${pageCount} page${pageCount === 1 ? "" : "s"}]`;

  return { text: [header, ...chunks].join("\n\n"), truncated };
}

/** Turn one dropped/pasted/picked file into an `Attachment`, or say why not.
 *
 *  Takes a `Blob` plus an explicit name so the three sources can share it: a
 *  clipboard image has no filename, and the native-drop fallback has a path but
 *  no `File`.
 */
export async function ingestBlob(
  blob: Blob,
  name: string,
  maxEdge: number = IMAGE_MAX_EDGE,
): Promise<IngestResult> {
  if (blob.size > MAX_SOURCE_BYTES) {
    return { ok: false, code: "too_large", bytes: blob.size, limit: MAX_SOURCE_BYTES };
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const mediaType = sniffMediaType(bytes);
  if (mediaType && IMAGE_TYPES.has(mediaType)) {
    return normalizeImage(blob, mediaType, name, maxEdge);
  }
  if (mediaType === "application/pdf") return normalizePdf(bytes, name);
  return normalizeText(bytes, name);
}

export function formatAttachmentBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
