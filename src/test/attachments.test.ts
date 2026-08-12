import { afterEach, describe, expect, it, vi } from "vitest";
import {
  IMAGE_MAX_EDGE,
  MAX_SOURCE_BYTES,
  MAX_TEXT_BYTES,
  formatAttachmentBytes,
  ingestBlob,
  sniffMediaType,
  thumbnailSrc,
} from "../lib/attachments";

const bytes = (...b: number[]) => new Uint8Array(b);
const ascii = (s: string) => new TextEncoder().encode(s);

/** A Uint8Array IS a valid BlobPart at runtime; the cast only sidesteps a
 *  lib.dom nuance about SharedArrayBuffer-backed views. */
const blobOf = (parts: Uint8Array[], opts?: BlobPropertyBag) =>
  new Blob(parts as unknown as BlobPart[], opts);

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** jsdom has neither createImageBitmap nor a working canvas. Stub both so the
 *  scale MATH can be asserted — the pixels are WebKit's problem, not ours. */
function stubImagePipeline(srcW: number, srcH: number, encodedSize = 1000) {
  const drawn: { w: number; h: number }[] = [];
  const encoded: { type: string; quality?: number }[] = [];

  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async () => ({ width: srcW, height: srcH, close: () => {} })),
  );
  vi.stubGlobal(
    "OffscreenCanvas",
    class {
      constructor(
        public width: number,
        public height: number,
      ) {
        drawn.push({ w: width, h: height });
      }
      getContext() {
        return { drawImage: () => {} };
      }
      convertToBlob(opts: { type: string; quality?: number }) {
        encoded.push({ type: opts.type, quality: opts.quality });
        return Promise.resolve(blobOf([new Uint8Array(encodedSize)], { type: opts.type }));
      }
    },
  );
  return { drawn, encoded };
}

afterEach(() => vi.unstubAllGlobals());

describe("sniffMediaType", () => {
  it("recognises the image formats we accept", () => {
    expect(sniffMediaType(concat(bytes(0x89), ascii("PNG"), bytes(13, 10, 26, 10)))).toBe(
      "image/png",
    );
    expect(sniffMediaType(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe("image/jpeg");
    expect(sniffMediaType(ascii("GIF89a"))).toBe("image/gif");
    expect(sniffMediaType(concat(ascii("RIFF"), bytes(0, 0, 0, 0), ascii("WEBP")))).toBe(
      "image/webp",
    );
    expect(sniffMediaType(concat(bytes(0, 0, 0, 24), ascii("ftyp"), ascii("heic")))).toBe(
      "image/heic",
    );
  });

  it("returns null for text and for a truncated header", () => {
    expect(sniffMediaType(ascii("#!/bin/zsh\necho hi\n"))).toBeNull();
    expect(sniffMediaType(bytes(0x89, 0x50))).toBeNull();
  });
});

describe("ingestBlob", () => {
  it("rejects an oversize file without decoding it", async () => {
    // A real Blob this big would be slow; only `.size` is read before the gate.
    const huge = { size: MAX_SOURCE_BYTES + 1, arrayBuffer: vi.fn() } as unknown as Blob;
    const r = await ingestBlob(huge, "big.png");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("too_large");
      if (r.code === "too_large") expect(r.limit).toBe(MAX_SOURCE_BYTES);
    }
    // The point of the ordering: never read the file to discover its size.
    expect(huge.arrayBuffer).not.toHaveBeenCalled();
  });

  /** The filename is caller metadata. Trusting it would let a text file become
   *  an image part and reach a vision model as garbage. */
  it("treats a .png-named text file as text", async () => {
    const blob = blobOf([ascii("not actually a png")]);
    const r = await ingestBlob(blob, "screenshot.png");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.attachment.kind).toBe("text");
      expect(r.attachment.text).toBe("not actually a png");
    }
  });

  it("rejects non-UTF-8 binary as unsupported", async () => {
    // 0xC3 starts a 2-byte sequence; 0x28 cannot continue it.
    const blob = blobOf([bytes(0x00, 0xc3, 0x28, 0xff, 0xfe)]);
    const r = await ingestBlob(blob, "mystery.bin");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("unsupported");
  });

  it("keeps the TAIL of an oversize text file and says so", async () => {
    const body = "x".repeat(MAX_TEXT_BYTES) + "THE-END";
    const r = await ingestBlob(blobOf([ascii(body)]), "run.log");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.attachment.truncated).toBe(true);
    expect(r.attachment.text).toMatch(/^… \(truncated, showing the last \d+ chars of \d+ bytes\)\n/);
    expect(r.attachment.text?.endsWith("THE-END")).toBe(true);
    expect(r.attachment.bytes).toBeLessThan(MAX_TEXT_BYTES + 200);
  });

  it("leaves a small text file untruncated", async () => {
    const r = await ingestBlob(blobOf([ascii("tail -f app.log\n")]), "cmd.txt");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.attachment.truncated).toBe(false);
      expect(r.attachment.text).toBe("tail -f app.log\n");
    }
  });

  it("downscales a retina screenshot to the long-edge cap, preserving aspect", async () => {
    const { drawn } = stubImagePipeline(3024, 1890);
    const png = concat(bytes(0x89), ascii("PNG"), bytes(13, 10, 26, 10), new Uint8Array(64));
    const r = await ingestBlob(blobOf([png]), "shot.png");
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // 1568/3024 = 0.5185… → 1568 x 980
    expect(drawn[0]).toEqual({ w: IMAGE_MAX_EDGE, h: 980 });
    expect(r.attachment.width).toBe(IMAGE_MAX_EDGE);
    expect(r.attachment.height).toBe(980);
  });

  it("never upscales a small image and skips re-encoding a PNG that already fits", async () => {
    const { drawn, encoded } = stubImagePipeline(200, 120);
    const png = concat(bytes(0x89), ascii("PNG"), bytes(13, 10, 26, 10), new Uint8Array(64));
    const r = await ingestBlob(blobOf([png]), "icon.png");
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(drawn).toHaveLength(0);
    expect(encoded).toHaveLength(0);
    expect(r.attachment.mediaType).toBe("image/png");
    expect(r.attachment.width).toBe(200);
    expect(r.attachment.height).toBe(120);
  });

  /** PNG is tried before the JPEG ladder because a terminal screenshot is flat
   *  colour and text, where PNG is smaller AND sharper. */
  it("prefers PNG over JPEG when a downscaled PNG fits the budget", async () => {
    const { encoded } = stubImagePipeline(4000, 3000);
    const png = concat(bytes(0x89), ascii("PNG"), bytes(13, 10, 26, 10), new Uint8Array(64));
    const r = await ingestBlob(blobOf([png]), "shot.png");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.attachment.mediaType).toBe("image/png");
    expect(encoded[0].type).toBe("image/png");
    expect(encoded).toHaveLength(1);
  });

  it("walks the JPEG quality ladder for a JPEG source", async () => {
    const { encoded } = stubImagePipeline(4000, 3000);
    const r = await ingestBlob(blobOf([bytes(0xff, 0xd8, 0xff, 0xe0, 1, 2, 3)]), "photo.jpg");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.attachment.mediaType).toBe("image/jpeg");
    expect(encoded[0]).toEqual({ type: "image/jpeg", quality: 0.85 });
  });

  it("reports a decode failure rather than throwing", async () => {
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => {
        throw new Error("corrupt");
      }),
    );
    const r = await ingestBlob(blobOf([bytes(0xff, 0xd8, 0xff, 0x00)]), "broken.jpg");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("decode_failed");
  });
});

describe("helpers", () => {
  it("builds a data URI only when bytes are present", () => {
    expect(thumbnailSrc({ id: "a", kind: "image", name: "x", mediaType: "image/png", bytes: 1, data: "QQ==" })).toBe(
      "data:image/png;base64,QQ==",
    );
    expect(
      thumbnailSrc({ id: "a", kind: "image", name: "x", mediaType: "image/png", bytes: 1 }),
    ).toBeNull();
  });

  it("formats sizes at each scale", () => {
    expect(formatAttachmentBytes(512)).toBe("512 B");
    expect(formatAttachmentBytes(2048)).toBe("2 KB");
    expect(formatAttachmentBytes(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});
