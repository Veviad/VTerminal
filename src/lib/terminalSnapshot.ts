import type { IBuffer } from "@xterm/xterm";
import { getTerm } from "./termRegistry";

// Reading text back out of the live xterm buffer.
//
// Two rules that both callers depend on:
//  - Tail limits are UTF-8 BYTES, matching Rust's persistence/IPC boundaries.
//    The metadata path counts the complete observed range so truncation is
//    explicit rather than inferred from an already-capped tail.
//  - Respect `line.isWrapped`. A wrapped continuation is the SAME logical line,
//    so joining it with "\n" injects a newline mid-token (e.g. splitting a long
//    path or a JSON blob), which then gets fed to the model as fact.

export interface ReadRangeOptions {
  /** Max UTF-8 bytes to return (tail-biased). */
  limit: number;
}

export interface ReadRangeResult {
  text: string;
  /** UTF-8 bytes in the normalized terminal text before tail capture. */
  observedBytes: number;
  /** UTF-8 bytes returned in `text`. */
  capturedBytes: number;
  truncated: boolean;
}

export function utf8Tail(value: string, limit: number): Omit<ReadRangeResult, "observedBytes"> & { observedBytes: number } {
  const encoded = new TextEncoder().encode(value);
  let startByte = Math.max(0, encoded.length - Math.max(0, limit));
  while (startByte < encoded.length && (encoded[startByte] & 0xc0) === 0x80) startByte += 1;
  const text = new TextDecoder().decode(encoded.slice(startByte));
  return {
    text,
    observedBytes: encoded.length,
    capturedBytes: encoded.length - startByte,
    truncated: startByte > 0,
  };
}

/**
 * Read absolute buffer rows [from, toInclusive] as text, tail-capped at
 * `limit` characters. Returns "" when the range is empty or the terminal is
 * gone.
 */
export function readLineRange(
  sessionId: string,
  from: number,
  toInclusive: number,
  { limit }: ReadRangeOptions,
): string {
  return readLineRangeResult(sessionId, from, toInclusive, { limit }).text;
}

/** Read a tail plus explicit capture metadata. This walks the complete observed
 * range so callers never mistake a locally capped tail for complete evidence. */
export function readLineRangeResult(
  sessionId: string,
  from: number,
  toInclusive: number,
  { limit }: ReadRangeOptions,
): ReadRangeResult {
  const entry = getTerm(sessionId);
  if (!entry || entry.disposed) {
    return { text: "", observedBytes: 0, capturedBytes: 0, truncated: false };
  }
  const buf = entry.term.buffer.active;
  const start = Math.max(0, from);
  const end = Math.min(toInclusive, buf.length - 1);
  if (end < start) {
    return { text: "", observedBytes: 0, capturedBytes: 0, truncated: false };
  }

  const chunks: string[] = [];
  for (let y = start; y <= end; y++) {
    const line = buf.getLine(y);
    if (!line) continue;
    const text = line.translateToString(true);
    if (chunks.length > 0 && !isWrapped(buf, y)) chunks.push("\n");
    chunks.push(text);
  }
  const observed = chunks.join("");
  return utf8Tail(observed, limit);
}

function isWrapped(buf: IBuffer, y: number): boolean {
  return buf.getLine(y)?.isWrapped ?? false;
}

/**
 * A capped snapshot of what is currently on screen, trailing blank rows
 * stripped. This is the grounding of last resort: in a remote shell that emits
 * no OSC markers, it is the ONLY thing that describes the session truthfully.
 */
export function readScreenTail(sessionId: string, maxChars = 4000): string {
  const entry = getTerm(sessionId);
  if (!entry || entry.disposed) return "";
  const buf = entry.term.buffer.active;
  // Last row holding anything, so a screen with a short prompt at the top does
  // not come back as a wall of blank lines.
  let last = buf.length - 1;
  while (last > 0 && (buf.getLine(last)?.translateToString(true).trim() ?? "") === "") last--;
  const rows = entry.term.rows;
  const first = Math.max(0, last - rows * 2);
  return readLineRange(sessionId, first, last, { limit: maxChars }).trimEnd();
}
