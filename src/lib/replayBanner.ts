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
