import { useEffect, useState } from "react";

import { S } from "../../lib/strings";
import { Segmented } from "../ui/Segmented";
import { Field } from "../ui/Row";
import type { ScheduleRecurrence, ScheduleRecurrenceKind } from "../../lib/schedules";
import {
  describeRecurrence,
  formatFireTime,
  localeWeekdayOrder,
  scheduleInputClass,
  weekdayShort,
} from "./scheduleUi";

const KINDS: readonly { value: ScheduleRecurrenceKind; label: string }[] = [
  { value: "interval", label: S.schedules.recurrenceOptions.interval },
  { value: "daily", label: S.schedules.recurrenceOptions.daily },
  { value: "weekly", label: S.schedules.recurrenceOptions.weekly },
  { value: "once", label: S.schedules.recurrenceOptions.once },
];

function timeValue(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function parseTime(value: string): { hour: number; minute: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

/** A local wall-clock `datetime-local` value → RFC3339 with THIS machine's
 *  offset. A one-off genuinely is a single instant, so unlike a recurring rule it
 *  is correct to resolve it here rather than sending wall-clock fields. */
function toRfc3339(local: string): string | null {
  const at = new Date(local);
  if (Number.isNaN(at.getTime())) return null;
  const offset = -at.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const pad = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, "0");
  const iso = new Date(at.getTime() - at.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 19);
  return `${iso}${sign}${pad(offset / 60)}:${pad(offset % 60)}`;
}

function toLocalInput(rfc: string): string {
  const at = Date.parse(rfc);
  if (!Number.isFinite(at)) return "";
  const d = new Date(at);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export function ScheduleRecurrenceEditor({
  value,
  onChange,
  previewFor,
}: {
  value: ScheduleRecurrence;
  onChange(next: ScheduleRecurrence): void;
  /** Fire times from the BACKEND, computed by the same function the scheduler
   *  uses. Two implementations of "when does this fire" would drift, and the one
   *  the user reads has to be the one that acts. */
  previewFor(rule: ScheduleRecurrence): Promise<string[]>;
}) {
  const [preview, setPreview] = useState<string[]>([]);

  useEffect(() => {
    let live = true;
    void previewFor(value).then((fires) => {
      if (live) setPreview(fires);
    });
    return () => {
      live = false;
    };
  }, [previewFor, value]);

  const at = value.kind === "daily" || value.kind === "weekly" ? value.at : null;
  const setKind = (kind: ScheduleRecurrenceKind) => {
    if (kind === value.kind) return;
    const time = at ?? { hour: 3, minute: 0 };
    switch (kind) {
      case "interval":
        return onChange({ kind: "interval", every_minutes: 60 });
      case "daily":
        return onChange({ kind: "daily", at: time });
      case "weekly":
        return onChange({ kind: "weekly", weekdays: ["monday"], at: time });
      case "once": {
        const soon = new Date(Date.now() + 60 * 60 * 1000);
        return onChange({
          kind: "once",
          at:
            toRfc3339(
              new Date(soon.getTime() - soon.getTimezoneOffset() * 60_000)
                .toISOString()
                .slice(0, 16),
            ) ?? soon.toISOString(),
        });
      }
    }
  };

  return (
    <Field label={S.schedules.recurrence}>
      <div className="space-y-2">
        <Segmented
          value={value.kind}
          options={KINDS}
          onChange={setKind}
          ariaLabel={S.schedules.recurrence}
          size="sm"
        />

        {value.kind === "interval" && (
          <div className="flex items-center gap-1.5">
            <input
              type="number"
              min={1}
              max={1440}
              value={value.every_minutes}
              onChange={(e) => {
                // Clamped here AND in Rust AND in the CHECK constraint. An
                // unclamped zero is an infinite fire loop.
                const minutes = Number(e.target.value);
                if (!Number.isFinite(minutes)) return;
                onChange({
                  kind: "interval",
                  every_minutes: Math.min(40320, Math.max(1, Math.round(minutes))),
                });
              }}
              className={`${scheduleInputClass} w-20`}
              aria-label={S.schedules.everyMinutes}
            />
            <span className="text-[11px] text-text-muted">{S.schedules.everyMinutes}</span>
          </div>
        )}

        {(value.kind === "daily" || value.kind === "weekly") && (
          <div className="space-y-2">
            {value.kind === "weekly" && (
              <div className="flex flex-wrap gap-1">
                {/* Ordered by the viewer's own week start; ISO ids are what get
                    stored regardless of display order. */}
                {localeWeekdayOrder().map((day) => {
                  const on = value.weekdays.includes(day);
                  return (
                    <button
                      key={day}
                      type="button"
                      aria-pressed={on}
                      onClick={() =>
                        onChange({
                          ...value,
                          weekdays: on
                            ? value.weekdays.filter((d) => d !== day)
                            : [...value.weekdays, day],
                        })
                      }
                      className={`rounded border px-1.5 py-0.5 text-[10px] transition-colors ${
                        on
                          ? "border-accent/40 bg-accent/10 text-accent"
                          : "border-border-subtle bg-bg-card text-text-muted hover:text-text-secondary"
                      }`}
                    >
                      {weekdayShort(day)}
                    </button>
                  );
                })}
              </div>
            )}
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] text-text-muted">{S.schedules.atTime}</span>
              {/* The native control: hand-rolled time entry plus locale 12/24h
                  formatting is a swamp, and WKWebView renders this correctly. */}
              <input
                type="time"
                value={timeValue(value.at.hour, value.at.minute)}
                onChange={(e) => {
                  const parsed = parseTime(e.target.value);
                  if (parsed) onChange({ ...value, at: parsed });
                }}
                className={`${scheduleInputClass} w-28`}
                aria-label={S.schedules.atTime}
              />
            </div>
          </div>
        )}

        {value.kind === "once" && (
          <input
            type="datetime-local"
            value={toLocalInput(value.at)}
            onChange={(e) => {
              const rfc = toRfc3339(e.target.value);
              if (rfc) onChange({ kind: "once", at: rfc });
            }}
            className={`${scheduleInputClass} w-56`}
            aria-label={S.schedules.recurrenceOptions.once}
          />
        )}

        <p className="text-[10px] text-text-secondary">{describeRecurrence(value)}</p>
        {preview.length > 0 && (
          <div className="space-y-0.5">
            <p className="text-[9px] uppercase tracking-wide text-text-muted">
              {S.schedules.nextThree}
            </p>
            <ul className="space-y-0.5">
              {preview.map((fire) => (
                <li key={fire} className="font-mono text-[10px] text-text-muted">
                  {formatFireTime(fire)}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Field>
  );
}
