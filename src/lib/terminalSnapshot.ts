import type { IBuffer } from "@xterm/xterm";
import { getTerm } from "./termRegistry";

// Reading text back out of the live xterm buffer.
//
// Two rules that both callers depend on:
//  - Walk BACKWARD from the end and stop once the char budget is spent. A block
//    can be 50k lines long; translating all of them to throw away everything
//    but the last 2 KB is pure waste.
//  - Respect `line.isWrapped`. A wrapped continuation is the SAME logical line,
//    so joining it with "\n" injects a newline mid-token (e.g. splitting a long
//    path or a JSON blob), which then gets fed to the model as fact.

export interface ReadRangeOptions {
  /** Max characters to return (tail-biased). */
  limit: number;
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
  const entry = getTerm(sessionId);
  if (!entry || entry.disposed) return "";
  const buf = entry.term.buffer.active;
  const start = Math.max(0, from);
  const end = Math.min(toInclusive, buf.length - 1);
  if (end < start) return "";

  // Collect backward into logical lines, stopping once the budget is spent.
  const chunks: string[] = [];
  let budget = limit;
  for (let y = end; y >= start && budget > 0; y--) {
    const line = buf.getLine(y);
    if (!line) continue;
    const text = line.translateToString(true);
    // A wrapped row continues the row above it: glue, don't separate.
    if (chunks.length > 0 && !isWrapped(buf, y + 1)) {
      chunks.push("\n");
      budget -= 1;
    }
    chunks.push(text);
    budget -= text.length;
  }
  const out = chunks.reverse().join("");
  return out.length > limit ? out.slice(-limit) : out;
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
