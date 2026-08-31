import { describe, expect, it } from "vitest";

import {
  describeRecurrence,
  formatDuration,
  formatFireTime,
  formatRelativeFire,
  humanizeScheduleState,
  localeWeekdayOrder,
  scheduleRunTone,
  scheduleStepTone,
} from "../components/schedules/scheduleUi";
import { SCHEDULE_WEEKDAYS } from "../lib/schedules";

describe("schedule formatting", () => {
  it("describes every recurrence shape", () => {
    expect(describeRecurrence({ kind: "interval", every_minutes: 30 })).toBe(
      "Every 30 minutes",
    );
    expect(describeRecurrence({ kind: "interval", every_minutes: 1 })).toBe("Every minute");
    // Whole hours read as hours, because "Every 120 minutes" is not how anyone
    // says it.
    expect(describeRecurrence({ kind: "interval", every_minutes: 60 })).toBe("Every hour");
    expect(describeRecurrence({ kind: "interval", every_minutes: 180 })).toBe("Every 3 hours");
    expect(
      describeRecurrence({ kind: "daily", at: { hour: 3, minute: 5 } }),
    ).toBe("Daily at 03:05");
    expect(
      describeRecurrence({
        kind: "weekly",
        weekdays: ["monday", "friday"],
        at: { hour: 7, minute: 0 },
      }),
    ).toMatch(/Mon.*Fri.*07:00/);
  });

  /** An empty weekly rule genuinely never fires, and the copy has to say so
   *  rather than rendering an empty day list. */
  it("says a weekly rule with no days never runs", () => {
    expect(
      describeRecurrence({ kind: "weekly", weekdays: [], at: { hour: 7, minute: 0 } }),
    ).toMatch(/Never/i);
  });

  it("does not pretend to read an unparseable one-off", () => {
    expect(describeRecurrence({ kind: "once", at: "next tuesday" })).toMatch(
      /could not be read/,
    );
  });

  it("orders weekday chips by locale while keeping ISO ids", () => {
    const order = localeWeekdayOrder();
    expect(order).toHaveLength(7);
    expect([...order].sort()).toEqual([...SCHEDULE_WEEKDAYS].sort());
  });

  it("formats durations and fire times without throwing on bad input", () => {
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(400)).toBe("400 ms");
    expect(formatDuration(4_000)).toBe("4 s");
    expect(formatDuration(90_000)).toBe("1 min 30 s");
    expect(formatFireTime(null)).toBe("—");
    expect(formatFireTime("not a date")).toBe("—");
  });

  it("reports a past occurrence as overdue rather than a negative countdown", () => {
    const now = Date.parse("2026-06-02T09:00:00Z");
    expect(formatRelativeFire("2026-06-02T08:59:00Z", now)).toBe("overdue");
    expect(formatRelativeFire("2026-06-02T09:20:00Z", now)).toBe("in 20 min");
    expect(formatRelativeFire("2026-06-02T11:00:00Z", now)).toBe("in 2 hours");
  });

  it("humanizes wire spellings", () => {
    expect(humanizeScheduleState("awaiting_target")).toBe("Awaiting Target");
    expect(humanizeScheduleState("succeeded")).toBe("Succeeded");
  });

  /** The tone functions switch exhaustively with no `default`, which is the
   *  compile-time guard. This asserts they are also total at runtime. */
  it("gives every status a tone", () => {
    for (const status of [
      "pending",
      "awaiting_target",
      "running",
      "succeeded",
      "failed",
      "cancelled",
      "skipped",
      "interrupted",
    ] as const) {
      expect(scheduleRunTone(status)).toBeTruthy();
    }
    for (const status of [
      "pending",
      "running",
      "succeeded",
      "failed",
      "skipped",
      "blocked",
      "unknown",
      "cancelled",
    ] as const) {
      expect(scheduleStepTone(status)).toBeTruthy();
    }
  });
});
