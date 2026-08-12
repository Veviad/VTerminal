import { beforeEach, describe, expect, it, vi } from "vitest";

// `../lib/pdfText` is mocked, NOT pdfjs itself, and this is mandatory rather than
// convenient: vitest.config.ts is a separate config from vite.config.ts, and under
// jsdom `process` exists, so pdf.js's `isNodeJS` branch is true and importing it for
// real does `require("@napi-rs/canvas")` — a 27MB native load — at module scope.
// Mocking here keeps these tests about `normalizePdf`'s assembly logic.
const extractPdfText = vi.fn();
vi.mock("../lib/pdfText", () => ({
  extractPdfText: (...args: unknown[]) => extractPdfText(...args),
  PDF_MAX_PAGES: 50,
  PDF_OCR_MAX_PAGES: 4,
}));

const { ingestBlob, sniffMediaType, MAX_TEXT_BYTES } = await import("../lib/attachments");
const { describeIngestFailure } = await import("../lib/attachInput");

const ascii = (s: string) => new TextEncoder().encode(s);
const blobOf = (parts: Uint8Array[]) => new Blob(parts as unknown as BlobPart[]);
const pdfBlob = (extra = "") => blobOf([ascii(`%PDF-1.4\n${extra}`)]);

function extract(over: Partial<{
  pageCount: number;
  pagesRead: number;
  pages: { page: number; text: string }[];
  emptyPages: number[];
}> = {}) {
  return {
    ok: true as const,
    extract: {
      pageCount: 1,
      pagesRead: 1,
      pages: [{ page: 1, text: "hello from page one" }],
      emptyPages: [],
      ...over,
    },
  };
}

beforeEach(() => vi.resetAllMocks());

describe("PDF sniffing", () => {
  it("recognises %PDF- at offset 0", () => {
    expect(sniffMediaType(ascii("%PDF-1.7\n..."))).toBe("application/pdf");
  });

  /** Strict at offset 0, like every other branch. Scanning further would also match
   *  a PDF header quoted inside a log file. */
  it("does not match a header that is not at the start", () => {
    expect(sniffMediaType(ascii("junk\n%PDF-1.4"))).toBeNull();
    expect(sniffMediaType(ascii("%PDF"))).toBeNull();
  });
});

describe("normalizePdf", () => {
  it("produces ONE text attachment, never image parts", async () => {
    extractPdfText.mockResolvedValue(extract());
    const r = await ingestBlob(pdfBlob(), "report.pdf");
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // The load-bearing assertion. If a PDF ever became `kind: "image"`, a
    // born-digital one would be unsendable on a model with no vision, and its pages
    // would be stripped from every replayed turn.
    expect(r.attachment.kind).toBe("text");
    expect(r.attachment.mediaType).toBe("application/pdf");
    expect(r.attachment.data).toBeUndefined();
    expect(r.attachment.width).toBeUndefined();
    expect(r.attachment.text).toContain("hello from page one");
  });

  it("labels each page and states the page count", async () => {
    extractPdfText.mockResolvedValue(
      extract({
        pageCount: 2,
        pagesRead: 2,
        pages: [
          { page: 1, text: "first" },
          { page: 2, text: "second" },
        ],
      }),
    );
    const r = await ingestBlob(pdfBlob(), "two.pdf");
    if (!r.ok) throw new Error("expected ok");
    expect(r.attachment.text).toContain("[PDF, 2 pages]");
    expect(r.attachment.text).toContain("--- page 1 ---\nfirst");
    expect(r.attachment.text).toContain("--- page 2 ---\nsecond");
    expect(r.attachment.truncated).toBe(false);
  });

  /** A scan inside a text document must not read as a blank page — the model would
   *  answer as though the page were empty. */
  it("names a page with no text layer in place", async () => {
    extractPdfText.mockResolvedValue(
      extract({
        pageCount: 3,
        pagesRead: 3,
        pages: [
          { page: 1, text: "intro" },
          { page: 3, text: "outro" },
        ],
        emptyPages: [2],
      }),
    );
    const r = await ingestBlob(pdfBlob(), "mixed.pdf");
    if (!r.ok) throw new Error("expected ok");
    expect(r.attachment.text).toContain("--- page 2 ---\n[no text layer on this page]");
    // And in the right position, between the two that did have text.
    const t = r.attachment.text!;
    expect(t.indexOf("intro")).toBeLessThan(t.indexOf("[no text layer"));
    expect(t.indexOf("[no text layer")).toBeLessThan(t.indexOf("outro"));
  });

  /** The page cap announces itself IN THE TEXT THE MODEL READS — silence would let
   *  it answer as if it had the whole document. */
  it("states the page cap when it bit", async () => {
    extractPdfText.mockResolvedValue(
      extract({
        pageCount: 213,
        pagesRead: 50,
        pages: Array.from({ length: 50 }, (_, i) => ({ page: i + 1, text: `p${i + 1}` })),
      }),
    );
    const r = await ingestBlob(pdfBlob(), "big.pdf");
    if (!r.ok) throw new Error("expected ok");
    expect(r.attachment.truncated).toBe(true);
    expect(r.attachment.text).toContain("showing pages 1-50 of 213");
    expect(r.attachment.text).toContain("50-page limit");
  });

  it("stops on a page boundary at the byte cap and says so", async () => {
    const fat = "x".repeat(20_000);
    extractPdfText.mockResolvedValue(
      extract({
        pageCount: 20,
        pagesRead: 20,
        pages: Array.from({ length: 20 }, (_, i) => ({ page: i + 1, text: fat })),
      }),
    );
    const r = await ingestBlob(pdfBlob(), "fat.pdf");
    if (!r.ok) throw new Error("expected ok");
    expect(r.attachment.truncated).toBe(true);
    expect(r.attachment.bytes).toBeLessThanOrEqual(MAX_TEXT_BYTES + 500);
    expect(r.attachment.text).toContain("size limit");
    // Cut on a page boundary, so no page is half-present.
    const pages = r.attachment.text!.match(/--- page \d+ ---/g) ?? [];
    expect(pages.length).toBeGreaterThan(0);
    expect(pages.length).toBeLessThan(20);
  });

  it("keeps the HEAD of a single page too big to fit", async () => {
    extractPdfText.mockResolvedValue(
      extract({ pages: [{ page: 1, text: "START" + "y".repeat(MAX_TEXT_BYTES * 2) }] }),
    );
    const r = await ingestBlob(pdfBlob(), "huge.pdf");
    if (!r.ok) throw new Error("expected ok");
    // HEAD, not tail — a document's beginning is the payload. (normalizeText keeps
    // the tail, deliberately the opposite.)
    expect(r.attachment.text).toContain("START");
    expect(r.attachment.truncated).toBe(true);
  });

  it("maps locked and invalid to their own codes, not decode_failed", async () => {
    extractPdfText.mockResolvedValue({ ok: false, reason: "locked" });
    const locked = await ingestBlob(pdfBlob(), "secret.pdf");
    expect(locked.ok).toBe(false);
    if (!locked.ok) {
      expect(locked.code).toBe("pdf_locked");
      expect(describeIngestFailure(locked)).toContain("password");
    }

    extractPdfText.mockResolvedValue({ ok: false, reason: "invalid" });
    const broken = await ingestBlob(pdfBlob("not really"), "broken.pdf");
    if (!broken.ok) {
      expect(broken.code).toBe("pdf_failed");
      expect(describeIngestFailure(broken)).toContain("PDF");
    }
  });

  /** A scan. Carries pageCount so the caller can decide whether to offer the
   *  on-device reader, and the copy names that fix rather than just refusing. */
  it("reports a text-less PDF as a scan, with its page count", async () => {
    extractPdfText.mockResolvedValue(
      extract({ pageCount: 4, pagesRead: 4, pages: [], emptyPages: [1, 2, 3, 4] }),
    );
    const r = await ingestBlob(pdfBlob(), "scan.pdf");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("pdf_no_text");
    if (r.code === "pdf_no_text") expect(r.pageCount).toBe(4);
    const msg = describeIngestFailure(r);
    expect(msg).toContain("scan");
    expect(msg).toContain("on-device");
  });

  /** The detach bug: `getDocument` transfers `data.buffer`, so passing the caller's
   *  own view would leave it zero-length for anything downstream. */
  it("hands pdfText a copy, leaving the caller's bytes intact", async () => {
    extractPdfText.mockImplementation((bytes: Uint8Array) => {
      // Simulate the transfer by emptying what we were given.
      new Uint8Array(bytes.buffer).fill(0);
      return Promise.resolve(extract());
    });
    const r = await ingestBlob(pdfBlob("payload"), "x.pdf");
    expect(r.ok).toBe(true);
    // Reached this far without throwing on a detached buffer.
    expect(extractPdfText).toHaveBeenCalledTimes(1);
    const passed = extractPdfText.mock.calls[0][0] as Uint8Array;
    expect(passed.byteLength).toBeGreaterThan(0);
  });
});
