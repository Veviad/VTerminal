import { S } from "../../lib/strings";
import type {
  ScheduleRecurrence,
  ScheduleRunStatus,
  ScheduleStepStatus,
  ScheduleWeekday,
} from "../../lib/schedules";

/** Snake-case wire value → Title Case. Pure, and shared with nothing: the tone
 *  functions below deliberately stay feature-local so their exhaustive `switch`
 *  keeps failing to compile when Rust gains a variant. */
export function humanizeScheduleState(state: string): string {
  return state
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/** No `default` on purpose: a new Rust status becomes a TypeScript error here
 *  rather than rendering with no colour. */
export function scheduleRunTone(status: ScheduleRunStatus): string {
  switch (status) {
    case "succeeded":
      return "border-success/30 bg-success/10 text-success";
    case "pending":
    case "awaiting_target":
    case "running":
      return "border-accent/30 bg-accent/10 text-accent";
    case "skipped":
    case "interrupted":
      return "border-warning/30 bg-warning/10 text-warning";
    case "failed":
    case "cancelled":
      return "border-error/30 bg-error/10 text-error";
  }
}

export function scheduleStepTone(status: ScheduleStepStatus): string {
  switch (status) {
    case "succeeded":
      return "text-success";
    case "running":
      return "text-accent";
    case "skipped":
    case "unknown":
      return "text-warning";
    case "failed":
    case "blocked":
    case "cancelled":
      return "text-error";
    case "pending":
      return "text-text-muted";
  }
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1_000) return `${ms} ms`;
  const seconds = Math.round(ms / 1_000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder ? `${minutes} min ${remainder} s` : `${minutes} min`;
}

/** A `switch` rather than a record lookup, for the same reason the tone
 *  functions below are: no `default` means a new weekday is a TypeScript error
 *  rather than an `undefined` rendered into a chip. */
export function weekdayShort(day: ScheduleWeekday): string {
  switch (day) {
    case "monday":
      return "Mon";
    case "tuesday":
      return "Tue";
    case "wednesday":
      return "Wed";
    case "thursday":
      return "Thu";
    case "friday":
      return "Fri";
    case "saturday":
      return "Sat";
    case "sunday":
      return "Sun";
  }
}

/** The user's own week start, not a hard-coded Monday — the app is RTL-aware and
 *  this is the same class of assumption. Storage order stays ISO regardless. */
export function localeWeekdayOrder(): ScheduleWeekday[] {
  const iso: ScheduleWeekday[] = [
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
  ];
  let firstDay = 1;
  try {
    // `getWeekInfo` where available; both spellings appear across engines.
    const locale = new Intl.Locale(navigator.language) as Intl.Locale & {
      getWeekInfo?: () => { firstDay: number };
      weekInfo?: { firstDay: number };
    };
    firstDay = locale.getWeekInfo?.().firstDay ?? locale.weekInfo?.firstDay ?? 1;
  } catch {
    firstDay = 1;
  }
  const offset = ((firstDay - 1) % 7 + 7) % 7;
  return [...iso.slice(offset), ...iso.slice(0, offset)];
}

function timeLabel(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function describeRecurrence(rule: ScheduleRecurrence): string {
  switch (rule.kind) {
    case "interval": {
      const minutes = rule.every_minutes;
      if (minutes % 60 === 0 && minutes >= 60) {
        const hours = minutes / 60;
        return hours === 1 ? "Every hour" : `Every ${hours} hours`;
      }
      return minutes === 1 ? "Every minute" : `Every ${minutes} minutes`;
    }
    case "daily":
      return `Daily at ${timeLabel(rule.at.hour, rule.at.minute)}`;
    case "weekly": {
      if (rule.weekdays.length === 0) return S.schedules.neverRuns;
      const days = localeWeekdayOrder()
        .filter((day) => rule.weekdays.includes(day))
        .map(weekdayShort)
        .join(", ");
      return `${days} at ${timeLabel(rule.at.hour, rule.at.minute)}`;
    }
    case "once": {
      const at = Date.parse(rule.at);
      if (!Number.isFinite(at)) return "Once, at a time that could not be read";
      return `Once, ${new Date(at).toLocaleString()}`;
    }
  }
}

/** An absolute local timestamp. Deliberately not a relative "in 14 minutes" for
 *  the stored value: the panel does not tick, so a relative label goes stale the
 *  moment it renders. */
export function formatFireTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "—";
  return new Date(at).toLocaleString();
}

export function formatRelativeFire(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "—";
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "—";
  const deltaMinutes = Math.round((at - now) / 60_000);
  if (deltaMinutes < -60 * 24) return formatFireTime(iso);
  if (deltaMinutes < 0) return "overdue";
  if (deltaMinutes < 1) return "in under a minute";
  if (deltaMinutes < 60) return `in ${deltaMinutes} min`;
  const hours = Math.round(deltaMinutes / 60);
  if (hours < 24) return hours === 1 ? "in 1 hour" : `in ${hours} hours`;
  return formatFireTime(iso);
}

export const secondaryButton =
  "inline-flex items-center justify-center gap-1.5 rounded-md border border-border-subtle bg-bg-card px-2.5 py-1.5 text-[11px] text-text-secondary transition-colors duration-150 hover:bg-bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40";

export const primaryButton =
  "inline-flex items-center justify-center gap-1.5 rounded-md bg-accent px-2.5 py-1.5 text-[11px] font-medium text-bg-primary transition-colors duration-150 hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40";

export const dangerButton =
  "inline-flex items-center justify-center gap-1.5 rounded-md border border-error/30 bg-error/10 px-2.5 py-1.5 text-[11px] text-error transition-colors duration-150 hover:bg-error/20 disabled:cursor-not-allowed disabled:opacity-40";

export const scheduleInputClass =
  "w-full rounded-md border border-border-subtle bg-bg-primary px-2 py-1.5 text-[12px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none";
