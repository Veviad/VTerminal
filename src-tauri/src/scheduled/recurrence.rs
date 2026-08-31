//! When does a rule next fire?
//!
//! This file owns every piece of DST logic in the feature and deliberately owns
//! nothing else: no clock, no database, no settings. `next_fire_after` takes the
//! moment to search from as a parameter and reads the zone off it, so production
//! passes a real zone and tests pass `chrono_tz::Europe::Berlin` and get
//! deterministic coverage of both transitions.
//!
//! Two rules that are easy to get backwards:
//!
//! * **Interval is absolute-instant arithmetic.** Thirty minutes means thirty
//!   real minutes; a DST transition does not shift it. It phases from the last
//!   real fire, so editing an action does not re-phase it onto a fixed grid.
//! * **Daily and weekly are wall-clock.** "09:00" means 09:00 on the clock in
//!   the room, which is a different instant either side of a transition. Every
//!   local resolution therefore goes through `resolve_local`, and NOTHING here
//!   calls `.unwrap()` or `.single()` on a `LocalResult`.

use chrono::{DateTime, Datelike, Duration, LocalResult, NaiveDate, NaiveTime, TimeZone};

use super::types::{Recurrence, Weekday};

/// How far past a missed slot an interval rule will jump in one multiplication.
/// A year-old anchor on a one-minute interval is half a million slots; looping
/// through them would hang the tick.
const MAX_INTERVAL_STEPS: i64 = 10_000_000;

/// A spring-forward gap is at most a couple of hours anywhere on earth. Search
/// three, one minute at a time — this runs at most twice a year.
const MAX_GAP_SEARCH_MINUTES: i64 = 180;

/// The first instant strictly after `after` at which `rule` fires, or `None` if
/// it never will again.
///
/// `anchor` is the interval phase reference (the last real fire). It is ignored
/// by every other rule.
pub fn next_fire_after<Tz: TimeZone>(
    rule: &Recurrence,
    anchor: Option<DateTime<Tz>>,
    after: DateTime<Tz>,
) -> Option<DateTime<Tz>> {
    match rule {
        Recurrence::Interval { every_minutes } => next_interval(*every_minutes, anchor, after),
        Recurrence::Daily { at } => next_daily(at.to_naive()?, &after),
        Recurrence::Weekly { weekdays, at } => next_weekly(weekdays, at.to_naive()?, &after),
        Recurrence::Once { at } => {
            let instant = DateTime::parse_from_rfc3339(at).ok()?;
            let in_zone = after.timezone().from_utc_datetime(&instant.naive_utc());
            (in_zone > after).then_some(in_zone)
        }
    }
}

/// Absolute-instant stepping, phased from `anchor`.
///
/// The multiplication is what collapses a closed laptop into one next fire: an
/// eight-hour gap on a thirty-minute interval advances the phase sixteen slots in
/// one step, so the scheduler sees one due occurrence rather than sixteen.
fn next_interval<Tz: TimeZone>(
    every_minutes: u32,
    anchor: Option<DateTime<Tz>>,
    after: DateTime<Tz>,
) -> Option<DateTime<Tz>> {
    if every_minutes == 0 {
        // An unclamped zero would be an infinite fire loop. `validate` refuses it
        // and the CHECK constraint refuses it, but never fires is the safe answer
        // if one reaches here anyway.
        return None;
    }
    let step = Duration::minutes(every_minutes as i64);
    let base = anchor.unwrap_or_else(|| after.clone());
    if base > after {
        return Some(base);
    }
    let elapsed = after.clone().signed_duration_since(base.clone());
    let steps = elapsed.num_minutes() / every_minutes as i64 + 1;
    if steps > MAX_INTERVAL_STEPS {
        // The anchor is implausibly stale (a restored database, a clock that was
        // years off). Re-phase from now rather than computing a date far outside
        // chrono's range.
        return Some(after.clone() + step);
    }
    let mut next = base + step * (steps as i32);
    // `num_minutes` truncates, so one correction step is enough.
    while next <= after {
        next = next + step;
    }
    Some(next)
}

fn next_daily<Tz: TimeZone>(at: NaiveTime, after: &DateTime<Tz>) -> Option<DateTime<Tz>> {
    let tz = after.timezone();
    let today = after.date_naive();
    // Two candidate days is always enough: today's slot, else tomorrow's. A third
    // would only matter if a whole calendar day had no valid instant at all.
    for offset in 0..3 {
        let date = today + Duration::days(offset);
        if let Some(candidate) = resolve_local(date, at, &tz) {
            if candidate > *after {
                return Some(candidate);
            }
        }
    }
    None
}

fn next_weekly<Tz: TimeZone>(
    weekdays: &[Weekday],
    at: NaiveTime,
    after: &DateTime<Tz>,
) -> Option<DateTime<Tz>> {
    if weekdays.is_empty() {
        // An empty selection genuinely never fires. Saying so is better than
        // picking a day the user did not choose; `validate` refuses it up front.
        return None;
    }
    let mask = Weekday::mask_of(weekdays);
    let tz = after.timezone();
    let today = after.date_naive();
    // Eight days covers "later today" plus a full wrap around the week.
    for offset in 0..8 {
        let date = today + Duration::days(offset);
        let day = Weekday::from_chrono(date.weekday());
        if mask & day.bit() == 0 {
            continue;
        }
        if let Some(candidate) = resolve_local(date, at, &tz) {
            if candidate > *after {
                return Some(candidate);
            }
        }
    }
    None
}

/// Resolve a wall-clock date and time in `tz`, handling both DST edge cases
/// explicitly.
///
/// `.unwrap()` here would panic twice a year and `.single()` would silently
/// return `None`, losing the day with no record — which is why neither appears
/// anywhere in this file.
fn resolve_local<Tz: TimeZone>(date: NaiveDate, time: NaiveTime, tz: &Tz) -> Option<DateTime<Tz>> {
    match tz.from_local_datetime(&date.and_time(time)) {
        LocalResult::Single(dt) => Some(dt),
        // Fall back: the wall clock reads 02:30 twice. Fire on the FIRST
        // occurrence, so a daily action runs once per calendar day rather than
        // twice on one of them.
        LocalResult::Ambiguous(earlier, _) => Some(earlier),
        // Spring forward: 02:30 does not exist today. Fire at the first instant
        // that does — the end of the gap — rather than skipping the day.
        LocalResult::None => first_instant_after_gap(date, time, tz),
    }
}

fn first_instant_after_gap<Tz: TimeZone>(
    date: NaiveDate,
    time: NaiveTime,
    tz: &Tz,
) -> Option<DateTime<Tz>> {
    let start = date.and_time(time);
    for minute in 1..=MAX_GAP_SEARCH_MINUTES {
        let probe = start + Duration::minutes(minute);
        match tz.from_local_datetime(&probe) {
            LocalResult::Single(dt) => return Some(dt),
            LocalResult::Ambiguous(earlier, _) => return Some(earlier),
            LocalResult::None => continue,
        }
    }
    None
}

/// The next `count` fire times, for the editor's preview. Pure, so the preview
/// and the scheduler cannot disagree about what a rule means.
pub fn preview<Tz: TimeZone>(
    rule: &Recurrence,
    anchor: Option<DateTime<Tz>>,
    after: DateTime<Tz>,
    count: usize,
) -> Vec<DateTime<Tz>> {
    let mut out = Vec::with_capacity(count);
    let mut cursor = after;
    for _ in 0..count {
        match next_fire_after(rule, anchor.clone(), cursor.clone()) {
            Some(next) => {
                cursor = next.clone();
                out.push(next);
            }
            None => break,
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scheduled::types::TimeOfDay;
    use chrono_tz::Europe::Berlin;
    use chrono_tz::Tz as TzId;

    fn berlin(y: i32, m: u32, d: u32, h: u32, min: u32) -> DateTime<TzId> {
        match Berlin.with_ymd_and_hms(y, m, d, h, min, 0) {
            LocalResult::Single(dt) => dt,
            LocalResult::Ambiguous(dt, _) => dt,
            LocalResult::None => panic!("{y}-{m}-{d} {h}:{min} does not exist in Berlin"),
        }
    }

    fn at(hour: u8, minute: u8) -> TimeOfDay {
        TimeOfDay { hour, minute }
    }

    #[test]
    fn interval_fires_every_n_minutes_from_its_anchor() {
        let rule = Recurrence::Interval { every_minutes: 30 };
        let anchor = berlin(2026, 6, 1, 9, 0);
        let next = next_fire_after(&rule, Some(anchor), berlin(2026, 6, 1, 9, 5)).unwrap();
        assert_eq!(next, berlin(2026, 6, 1, 9, 30));
        // Exactly on a slot boundary must advance, never return `after` itself.
        let next = next_fire_after(&rule, Some(anchor), berlin(2026, 6, 1, 9, 30)).unwrap();
        assert_eq!(next, berlin(2026, 6, 1, 10, 0));
    }

    /// The laptop-closed case. Sixteen slots elapse; exactly one next fire comes
    /// back, which is what stops a backlog stampede at the source.
    #[test]
    fn interval_collapses_every_missed_slot_into_one_next_fire() {
        let rule = Recurrence::Interval { every_minutes: 30 };
        let anchor = berlin(2026, 6, 1, 1, 0);
        let now = berlin(2026, 6, 1, 9, 0);
        let next = next_fire_after(&rule, Some(anchor), now).unwrap();
        assert_eq!(next, berlin(2026, 6, 1, 9, 30));
        assert!(next > now);
    }

    #[test]
    fn interval_jumps_in_one_step_rather_than_looping() {
        let rule = Recurrence::Interval { every_minutes: 1 };
        let anchor = berlin(2025, 6, 1, 0, 0);
        let now = berlin(2026, 6, 1, 0, 0);
        // A year of one-minute slots is ~525k iterations. This must return fast
        // and land on the very next minute.
        let next = next_fire_after(&rule, Some(anchor), now).unwrap();
        assert_eq!(next, berlin(2026, 6, 1, 0, 1));
    }

    #[test]
    fn interval_with_an_implausible_anchor_rephases_from_now() {
        let rule = Recurrence::Interval { every_minutes: 1 };
        let anchor = berlin(1980, 1, 1, 0, 0);
        let now = berlin(2026, 6, 1, 0, 0);
        let next = next_fire_after(&rule, Some(anchor), now).unwrap();
        assert_eq!(next, berlin(2026, 6, 1, 0, 1));
    }

    #[test]
    fn interval_without_an_anchor_phases_from_now() {
        let rule = Recurrence::Interval { every_minutes: 15 };
        let now = berlin(2026, 6, 1, 9, 7);
        let next = next_fire_after(&rule, None, now).unwrap();
        assert_eq!(next, berlin(2026, 6, 1, 9, 22));
    }

    #[test]
    fn interval_of_zero_never_fires() {
        let rule = Recurrence::Interval { every_minutes: 0 };
        assert!(next_fire_after(&rule, None, berlin(2026, 6, 1, 9, 0)).is_none());
    }

    #[test]
    fn daily_rolls_to_tomorrow_when_todays_time_has_passed() {
        let rule = Recurrence::Daily { at: at(3, 0) };
        let next = next_fire_after(&rule, None, berlin(2026, 6, 1, 9, 0)).unwrap();
        assert_eq!(next, berlin(2026, 6, 2, 3, 0));
        let next = next_fire_after(&rule, None, berlin(2026, 6, 1, 1, 0)).unwrap();
        assert_eq!(next, berlin(2026, 6, 1, 3, 0));
    }

    /// 2026-03-29 in Berlin: 02:00 CET jumps to 03:00 CEST, so 02:30 has no
    /// instant. Firing at the end of the gap keeps the day; `.single()` would
    /// have dropped it silently.
    #[test]
    fn daily_at_a_nonexistent_local_time_fires_at_the_end_of_the_spring_forward_gap() {
        let rule = Recurrence::Daily { at: at(2, 30) };
        let before = berlin(2026, 3, 29, 0, 30);
        let next = next_fire_after(&rule, None, before).unwrap();
        assert_eq!(next.naive_local(), berlin(2026, 3, 29, 3, 0).naive_local());
        assert_eq!(next.date_naive(), before.date_naive());
    }

    /// 2026-10-25 in Berlin: 03:00 CEST falls back to 02:00 CET, so 02:30 happens
    /// twice. Fire once, on the first (CEST) occurrence.
    #[test]
    fn daily_at_an_ambiguous_local_time_fires_once_at_the_first_occurrence() {
        let rule = Recurrence::Daily { at: at(2, 30) };
        let before = Berlin.with_ymd_and_hms(2026, 10, 25, 0, 30, 0).unwrap();
        let next = next_fire_after(&rule, None, before).unwrap();
        let expected = match Berlin.with_ymd_and_hms(2026, 10, 25, 2, 30, 0) {
            LocalResult::Ambiguous(earlier, later) => {
                assert!(earlier < later, "the transition must be ambiguous here");
                earlier
            }
            other => panic!("expected an ambiguous local time, got {other:?}"),
        };
        assert_eq!(next, expected);
        // And the next one after that is the following day, not the second 02:30.
        let after_that = next_fire_after(&rule, None, next).unwrap();
        assert_eq!(
            after_that.date_naive(),
            next.date_naive() + Duration::days(1)
        );
    }

    /// The counterpart property: an interval rule measures real elapsed time, so
    /// the same transition must not shift or duplicate it.
    #[test]
    fn an_interval_schedule_is_unaffected_by_a_dst_transition() {
        let rule = Recurrence::Interval { every_minutes: 30 };
        let anchor = Berlin.with_ymd_and_hms(2026, 3, 29, 1, 30, 0).unwrap();
        let next = next_fire_after(&rule, Some(anchor), anchor).unwrap();
        assert_eq!(next.signed_duration_since(anchor), Duration::minutes(30));
        // Wall clock jumped an hour; elapsed real time did not.
        assert_eq!(next.naive_local(), berlin(2026, 3, 29, 3, 0).naive_local());
    }

    #[test]
    fn weekly_selects_the_next_chosen_weekday_and_wraps_across_the_week() {
        // 2026-06-01 is a Monday.
        let rule = Recurrence::Weekly {
            weekdays: vec![Weekday::Monday, Weekday::Thursday],
            at: at(7, 0),
        };
        let monday_late = berlin(2026, 6, 1, 9, 0);
        let next = next_fire_after(&rule, None, monday_late).unwrap();
        assert_eq!(next, berlin(2026, 6, 4, 7, 0)); // Thursday
        let thursday_late = berlin(2026, 6, 4, 9, 0);
        let next = next_fire_after(&rule, None, thursday_late).unwrap();
        assert_eq!(next, berlin(2026, 6, 8, 7, 0)); // wraps to next Monday
                                                    // Earlier the same chosen day still fires today.
        let next = next_fire_after(&rule, None, berlin(2026, 6, 1, 6, 0)).unwrap();
        assert_eq!(next, berlin(2026, 6, 1, 7, 0));
    }

    #[test]
    fn weekly_with_an_empty_weekday_set_never_fires() {
        let rule = Recurrence::Weekly {
            weekdays: vec![],
            at: at(7, 0),
        };
        assert!(next_fire_after(&rule, None, berlin(2026, 6, 1, 0, 0)).is_none());
    }

    #[test]
    fn once_returns_none_after_its_instant_has_passed() {
        let rule = Recurrence::Once {
            at: "2026-06-01T09:00:00+02:00".into(),
        };
        let next = next_fire_after(&rule, None, berlin(2026, 6, 1, 8, 0)).unwrap();
        assert_eq!(next, berlin(2026, 6, 1, 9, 0));
        assert!(next_fire_after(&rule, None, berlin(2026, 6, 1, 9, 0)).is_none());
        assert!(next_fire_after(&rule, None, berlin(2026, 6, 1, 10, 0)).is_none());
    }

    #[test]
    fn once_with_an_unparseable_instant_never_fires() {
        let rule = Recurrence::Once {
            at: "next tuesday".into(),
        };
        assert!(next_fire_after(&rule, None, berlin(2026, 6, 1, 0, 0)).is_none());
    }

    #[test]
    fn preview_returns_strictly_increasing_instants_and_stops_at_the_end() {
        let daily = Recurrence::Daily { at: at(3, 0) };
        let fires = preview(&daily, None, berlin(2026, 6, 1, 9, 0), 3);
        assert_eq!(fires.len(), 3);
        assert!(fires.windows(2).all(|w| w[0] < w[1]));

        let once = Recurrence::Once {
            at: "2026-06-01T09:00:00+02:00".into(),
        };
        assert_eq!(preview(&once, None, berlin(2026, 6, 1, 8, 0), 5).len(), 1);
    }
}
