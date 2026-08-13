import { useSettings } from "../../hooks/useSettings";
import { S } from "../../lib/strings";
import { useAppStore } from "../../stores/appStore";
import { Toggle } from "../ui/Row";

/** Capability gate for the experimental Runbooks subsystem.
 *
 * The switch only controls discovery in the webview. Rust independently checks
 * `runbooks_enabled` on every IPC entry point because a stale or modified
 * frontend must not be able to import definitions or drive a terminal while
 * the feature is disabled.
 */
export function RunbooksSettings() {
  const enabled = useAppStore((s) => s.runbooksEnabled);
  const { save } = useSettings();

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <h3 className="text-[10px] font-semibold uppercase tracking-widest text-text-muted">
          {S.settings.runbooks.title}
        </h3>
        <p className="text-[11px] leading-relaxed text-text-secondary">
          {S.settings.runbooks.intro}
        </p>
        <Toggle
          label={S.settings.runbooks.enable}
          hint={S.settings.runbooks.enableHint}
          checked={enabled}
          onChange={(value) => void save({ runbooks_enabled: value })}
        />
      </section>

      <p className="rounded-md border border-border-subtle bg-bg-card px-3 py-2 text-[11px] leading-relaxed text-text-muted">
        {enabled ? S.settings.runbooks.enabledNotice : S.settings.runbooks.disabledNotice}
      </p>
    </div>
  );
}
