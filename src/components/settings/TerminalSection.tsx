import { useAppStore } from "../../stores/appStore";
import { useSettings } from "../../hooks/useSettings";
import * as api from "../../lib/tauri";
import { S } from "../../lib/strings";
import { isWindows } from "../../lib/platform";
import { Row, Stepper, Toggle } from "../ui/Row";

export function TerminalSection() {
  const s = useAppStore();
  const { save } = useSettings();

  /**
   * Lowering a retention limit has to take effect NOW.
   *
   * The prune otherwise runs on the next archive write, so "keep 10" would leave
   * 50 rows sitting in the browser and the setting would look broken.
   */
  const saveAndPrune = async (patch: Parameters<typeof save>[0]) => {
    await save(patch);
    void api.archivePrune().catch(() => {});
  };

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <h3 className="text-[10px] font-semibold uppercase tracking-widest text-text-muted">
          {S.settings.tabs.terminal}
        </h3>

        <Row label={S.settings.terminal.fontSize}>
          <Stepper
            value={s.fontSize}
            min={10}
            max={20}
            onChange={(v) => void save({ font_size: v })}
          />
        </Row>

        <Row label={S.settings.terminal.scrollback}>
          <select
            value={s.scrollbackLines}
            onChange={(e) => void save({ scrollback_lines: Number(e.target.value) })}
            className="rounded-md border border-border-subtle bg-bg-card px-2 py-1 text-[12px] text-text-primary"
          >
            {[1000, 5000, 10000, 20000, 50000].map((n) => (
              <option key={n} value={n}>
                {n.toLocaleString()}
              </option>
            ))}
          </select>
        </Row>

        <Row label={S.settings.terminal.cursorStyle}>
          <select
            value={s.cursorStyle}
            onChange={(e) => void save({ cursor_style: e.target.value })}
            className="rounded-md border border-border-subtle bg-bg-card px-2 py-1 text-[12px] text-text-primary"
          >
            <option value="block">Block</option>
            <option value="bar">Bar</option>
            <option value="underline">Underline</option>
          </select>
        </Row>

        <Toggle
          label={S.settings.terminal.cursorBlink}
          checked={s.cursorBlink}
          onChange={(v) => void save({ cursor_blink: v })}
        />
        <Toggle
          label={S.settings.terminal.copyOnSelect}
          checked={s.copyOnSelect}
          onChange={(v) => void save({ copy_on_select: v })}
        />

        <Row
          label={S.settings.terminal.shellPath}
          hint={isWindows() ? "Windows sessions use Bash in the default WSL2 distribution." : S.settings.terminal.shellPathHint}
        >
          <input
            defaultValue={isWindows() ? "/bin/bash" : (s.shellPath ?? "")}
            onBlur={(e) => void save({ shell_path: e.target.value })}
            placeholder={isWindows() ? "/bin/bash" : "/bin/zsh"}
            disabled={isWindows()}
            className="w-48 rounded-md border border-border-subtle bg-bg-card px-2 py-1 font-mono text-[12px] text-text-primary placeholder:text-text-muted"
          />
        </Row>

        <Toggle
          label={S.settings.terminal.shellIntegration}
          checked={s.shellIntegrationEnabled}
          onChange={(v) => void save({ shell_integration_enabled: v })}
        />
      </section>

      <section className="space-y-3">
        <h3 className="text-[10px] font-semibold uppercase tracking-widest text-text-muted">
          {S.settings.restore.title}
        </h3>
        <Toggle
          label={S.settings.restore.enabled}
          hint={S.settings.restore.enabledHint}
          checked={s.restoreSessionsOnStart}
          onChange={(v) => void save({ restore_sessions_on_start: v })}
        />
        <Row label={S.settings.restore.scrollback} hint={S.settings.restore.scrollbackHint}>
          <select
            value={s.restoreScrollbackLines}
            onChange={(e) => void save({ restore_scrollback_lines: Number(e.target.value) })}
            disabled={!s.restoreSessionsOnStart}
            className="rounded-md border border-border-subtle bg-bg-card px-2 py-1 text-[12px] text-text-primary disabled:opacity-60"
          >
            <option value={0}>{S.settings.restore.scrollbackOff}</option>
            {[500, 1000, 5000, 10000].map((n) => (
              <option key={n} value={n}>
                {n.toLocaleString()}
              </option>
            ))}
          </select>
        </Row>
        <Row label={S.settings.restore.clear} hint={S.settings.restore.clearHint}>
          <button
            onClick={() => void api.workspaceClear().catch(() => {})}
            className="rounded-md border border-border-subtle px-2 py-1 text-[11px] text-error hover:bg-bg-hover"
          >
            {S.settings.restore.clearButton}
          </button>
        </Row>
      </section>

      {/* Its own section, not part of Session restore: restore is about the NEXT
          launch, the archive is about the PAST. Folded together they produce two
          rows both called "saved session state" with two different Clear buttons. */}
      <section className="space-y-3">
        <h3 className="text-[10px] font-semibold uppercase tracking-widest text-text-muted">
          {S.settings.archive.title}
        </h3>
        <Toggle
          label={S.settings.archive.enabled}
          hint={S.settings.archive.enabledHint}
          checked={s.archiveEnabled}
          onChange={(v) => void save({ archive_enabled: v })}
        />
        <Row label={S.settings.archive.keepSessions} hint={S.settings.archive.keepSessionsHint}>
          <select
            value={s.archiveMaxSessions}
            onChange={(e) => void saveAndPrune({ archive_max_sessions: Number(e.target.value) })}
            disabled={!s.archiveEnabled}
            className="rounded-md border border-border-subtle bg-bg-card px-2 py-1 text-[12px] text-text-primary disabled:opacity-60"
          >
            {[10, 25, 50, 100, 200].map((n) => (
              <option key={n} value={n}>
                {n.toLocaleString()}
              </option>
            ))}
          </select>
        </Row>
        <Row label={S.settings.archive.keepDays} hint={S.settings.archive.keepDaysHint}>
          <select
            value={s.archiveMaxAgeDays}
            onChange={(e) => void saveAndPrune({ archive_max_age_days: Number(e.target.value) })}
            disabled={!s.archiveEnabled}
            className="rounded-md border border-border-subtle bg-bg-card px-2 py-1 text-[12px] text-text-primary disabled:opacity-60"
          >
            {[7, 14, 30, 90, 365].map((n) => (
              <option key={n} value={n}>
                {n} {S.settings.archive.days}
              </option>
            ))}
          </select>
        </Row>
        <Row label={S.settings.archive.clear} hint={S.settings.archive.clearHint}>
          <button
            onClick={() => void api.archiveClear().catch(() => {})}
            className="rounded-md border border-border-subtle px-2 py-1 text-[11px] text-error hover:bg-bg-hover"
          >
            {S.settings.archive.clearButton}
          </button>
        </Row>
        {/* Command history is a separate store with its own retention (none), but
            someone clearing "past sessions" reasonably expects to find this in the
            same place rather than hunting for it. */}
        <Row label={S.settings.archive.commandHistory} hint={S.settings.archive.commandHistoryHint}>
          <button
            onClick={() => void api.historyClear().catch(() => {})}
            className="rounded-md border border-border-subtle px-2 py-1 text-[11px] text-error hover:bg-bg-hover"
          >
            {S.settings.archive.commandHistoryButton}
          </button>
        </Row>
      </section>

      <section className="space-y-3">
        <h3 className="text-[10px] font-semibold uppercase tracking-widest text-text-muted">
          Privacy
        </h3>
        <Toggle
          label={S.settings.terminal.historyEnabled}
          checked={s.historyEnabled}
          onChange={(v) => void save({ history_enabled: v })}
        />
        <Toggle
          label={S.settings.terminal.sendContext}
          checked={s.sendContextToAi}
          onChange={(v) => void save({ send_context_to_ai: v })}
        />
        <Toggle
          label={S.settings.terminal.aiSessionNaming}
          hint={S.settings.terminal.aiSessionNamingHint}
          checked={s.aiSessionNaming}
          onChange={(v) => void save({ ai_session_naming: v })}
        />
      </section>
    </div>
  );
}
