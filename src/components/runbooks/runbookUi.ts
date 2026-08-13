import type { RunbookRunState, RunbookStepState } from "../../lib/runbooks";

export function humanizeRunbookState(state: string): string {
  return state
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function runStateTone(state: RunbookRunState): string {
  switch (state) {
    case "succeeded":
      return "border-success/30 bg-success/10 text-success";
    case "completed_with_exceptions":
    case "waiting_approval":
    case "waiting_operator":
    case "paused":
    case "interrupted":
      return "border-warning/30 bg-warning/10 text-warning";
    case "failed":
    case "cancelled":
      return "border-error/30 bg-error/10 text-error";
    case "created":
    case "ready":
    case "running":
      return "border-accent/30 bg-accent/10 text-accent";
  }
}

export function stepStateTone(state: RunbookStepState): string {
  switch (state) {
    case "already_compliant":
    case "remediated_verified":
      return "text-success";
    case "checking":
    case "needs_action":
    case "applying":
    case "verifying":
      return "text-accent";
    case "paused":
    case "skipped":
    case "waived":
    case "unknown":
      return "text-warning";
    case "failed":
    case "blocked":
      return "text-error";
    case "pending":
      return "text-text-muted";
  }
}

export function formatRunbookDuration(milliseconds: number | null | undefined): string {
  if (milliseconds === null || milliseconds === undefined) return "—";
  if (milliseconds < 1_000) return `${milliseconds} ms`;
  const seconds = Math.round(milliseconds / 1_000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder ? `${minutes} min ${remainder} s` : `${minutes} min`;
}

export const secondaryButton =
  "inline-flex items-center justify-center gap-1.5 rounded-md border border-border-subtle bg-bg-card px-2.5 py-1.5 text-[11px] text-text-secondary transition-colors duration-150 hover:bg-bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40";

export const primaryButton =
  "inline-flex items-center justify-center gap-1.5 rounded-md bg-accent px-2.5 py-1.5 text-[11px] font-medium text-bg-primary transition-colors duration-150 hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40";

export const dangerButton =
  "inline-flex items-center justify-center gap-1.5 rounded-md border border-error/30 bg-error/10 px-2.5 py-1.5 text-[11px] text-error transition-colors duration-150 hover:bg-error/20 disabled:cursor-not-allowed disabled:opacity-40";

export const runbookInputClass =
  "w-full rounded-md border border-border-subtle bg-bg-primary px-2 py-1.5 text-[12px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none";
