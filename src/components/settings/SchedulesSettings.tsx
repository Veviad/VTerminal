import { useEffect, useState } from "react";

import { useSettings } from "../../hooks/useSettings";
import { S } from "../../lib/strings";
import { schedulesList, scheduleRunsPrune } from "../../lib/schedules";
import { useAppStore } from "../../stores/appStore";
import { Field, Toggle } from "../ui/Row";

/**
 * Capability gate for the experimental Scheduled Actions subsystem.
 *
 * The switch controls discovery in the webview; Rust independently checks
 * `scheduled_actions_enabled` on every IPC entry point, and turning it off also
 * stops the scheduler and cancels whatever is in flight — a stale or modified
 * frontend must not be able to keep a run going through a disable.
 */
export function SchedulesSettings() {
  const enabled = useAppStore((s) => s.schedulesEnabled);
  const tabExecution = useAppStore((s) => s.schedulesTabExecutionEnabled);
  const { save } = useSettings();
  const [count, setCount] = useState<number | null>(null);
  const [pruned, setPruned] = useState<number | null>(null);

  useEffect(() => {
    if (!enabled) {
      setCount(null);
      return;
    }
    void schedulesList()
      .then((actions) => setCount(actions.length))
      .catch(() => setCount(null));
  }, [enabled]);

  const pruneOlderThan = async (days: number) => {
    const before = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    try {
      setPruned(await scheduleRunsPrune(before));
    } catch {
      setPruned(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h2 className="text-[14px] font-medium text-text-primary">
          {S.settings.schedules.title}
        </h2>
        <p className="text-[11px] leading-relaxed text-text-muted">
          {S.settings.schedules.intro}
        </p>
      </div>

      <Toggle
        label={S.settings.schedules.enable}
        hint={S.settings.schedules.enableHint}
        checked={enabled}
        onChange={(v) => void save({ scheduled_actions_enabled: v })}
      />

      <p className="text-[10px] leading-relaxed text-text-muted">
        {enabled
          ? S.settings.schedules.enabledNotice
          : S.settings.schedules.disabledNotice}
      </p>

      {enabled && (
        <>
          {/* A second switch on purpose. A tab run types into a real PTY with a
              pre-armed mode, and the webview timers driving it are throttled
              while the window is backgrounded — which is usually when a schedule
              fires. That deserves its own decision, not a side effect of
              enabling the feature. */}
          <Toggle
            label={S.settings.schedules.tabExecution}
            hint={S.settings.schedules.tabExecutionHint}
            checked={tabExecution}
            onChange={(v) => void save({ scheduled_tab_execution_enabled: v })}
          />

          <Field
            label={S.settings.schedules.retention}
            hint={S.settings.schedules.retentionHint}
          >
            <div className="flex flex-wrap items-center gap-1.5">
              {[7, 30, 90].map((days) => (
                <button
                  key={days}
                  type="button"
                  onClick={() => void pruneOlderThan(days)}
                  className="rounded-md border border-border-subtle bg-bg-card px-2 py-1 text-[11px] text-text-secondary hover:bg-bg-hover hover:text-text-primary"
                >
                  {S.settings.schedules.days(days)}
                </button>
              ))}
              {pruned !== null && (
                <span className="text-[10px] text-text-muted">
                  {pruned === 1 ? "1 run removed" : `${pruned} runs removed`}
                </span>
              )}
            </div>
          </Field>

          {count !== null && (
            <p className="text-[10px] text-text-muted">
              {count === 1 ? "1 action configured" : `${count} actions configured`}
            </p>
          )}
        </>
      )}
    </div>
  );
}
