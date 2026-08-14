/**
 * The line that separates a photograph from a live shell.
 *
 * Everything above it is replayed text: no block gutter, no Re-run, no Copy
 * output. Two callers produce one, and the ONLY difference between them is
 * wording — which is exactly why they share a function. Two copies would drift,
 * and the way that failure looks to a user is the app claiming a reopen was a
 * restore, or claiming a dead ssh connection is live.
 */

import { relativeTime } from "./relativeTime";

export interface BannerSpec {
  kind: "restored" | "reopened";
  /** ISO time the captured output is from. */
  when: string;
  remoteKind?: string | null;
  remoteTarget?: string | null;
  /** Reopen only: the AI transcript came back with the terminal. */
  hadTranscript?: boolean;
  /** Restore only: the previous run ended without a final flush. */
  crashed?: boolean;
}

export function replayBanner(spec: BannerSpec, cols: number): string {
  const when = relativeTime(spec.when);
  const lead = spec.kind === "restored" ? `restored ${when}` : `reopened from ${when}`;

  // Never truncated: without these the banner does not say what it is for.
  const required = `${lead} · new shell`;
  // Dropped from the END when the window is narrow, so the LAST entry is the one
  // we are most willing to lose. `not reconnected` is the highest-priority
  // optional clause because slicing it mid-phrase leaves "was ssh prod-01",
  // which reads as though the connection is live — the exact wrong assumption
  // this banner exists to prevent.
  const optional = [
    spec.remoteKind
      ? `was ${spec.remoteKind}${spec.remoteTarget ? ` ${spec.remoteTarget}` : ""}, not reconnected`
      : "",
    spec.crashed ? "after an unexpected quit" : "",
    spec.hadTranscript ? "AI transcript restored" : "",
  ].filter(Boolean);

  const width = Math.max(20, cols);
  const compose = (parts: string[]) => ` ${[required, ...parts].join(" · ")} `;
  let label = compose(optional);
  // Drop whole clauses rather than characters.
  while (label.length > width - 4 && optional.length > 0) {
    optional.pop();
    label = compose(optional);
  }
  // Last resort: even the required part does not fit. A hard slice is acceptable
  // here because what is left ("reopened from 3h ago · new sh") cannot mislead.
  if (label.length > width - 4) label = `${label.slice(0, width - 5)} `;
  const pad = Math.max(2, width - label.length);
  const left = "─".repeat(pad >> 1);
  const right = "─".repeat(pad - (pad >> 1));
  // The leading reset matters — a serialized payload can end mid-SGR.
  return `\r\n\x1b[0m\x1b[2m${left}${label}${right}\x1b[0m\r\n`;
}

/** CSI/OSC/charset sequences, so a line can be matched on what it SHOWS. */
// eslint-disable-next-line no-control-regex
const ESCAPES = /\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~]|[@-Z\\-_()][0-9A-Za-z]?)/g;

/**
 * Remove replay banners from captured scrollback.
 *
 * The banner is written INTO the terminal, so the next snapshot captures it and
 * the one after that replays it — and appends a fresh banner below. Left alone
 * this compounds once per restore: reopening a tab a dozen times without typing
 * anything produced a dozen separators with nothing between them, each stamped
 * with a relative time measured from a different moment ("2m ago" above "1h
 * ago" above "just now"), which reads as though the tab were restored out of
 * order.
 *
 * Stripping at CAPTURE keeps the invariant one line long: stored scrollback is
 * terminal output and nothing else, so exactly one banner exists at a time and
 * it always sits where it means something — between the photograph and the live
 * shell. A banner already inside the photograph is separating nothing.
 *
 * Matched on visible text rather than the emitted bytes, because the capture
 * comes back through xterm's serializer: it reconstructs SGR from cell
 * attributes, so the `\x1b[0m\x1b[2m` prefix written above is not what returns.
 */
export function stripReplayBanners(payload: string): string {
  if (!payload.includes("─")) return payload;
  return payload
    .split(/(?<=\n)/)
    .filter((line) => !isBannerLine(line))
    .join("");
}

function isBannerLine(line: string): boolean {
  const visible = line.replace(ESCAPES, "").trim();
  // Rules out ordinary output: a banner is box-drawing rules wrapped around its
  // own label, and the padding is never empty on either side.
  if (!/^─+ .+ ─+$/.test(visible)) return false;
  // `restored`/`reopened from` are the only two leads `replayBanner` writes, and
  // both are required — a user's own ─-ruled heading must survive capture.
  return /(?:^|·|\s)(?:restored|reopened from) /.test(visible);
}
