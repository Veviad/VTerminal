import { useAppStore } from "../../stores/appStore";
import { useSettings } from "../../hooks/useSettings";
import { S } from "../../lib/strings";
import { Row, Stepper, Toggle } from "../ui/Row";

// Agents wait far longer than an interactive user does: a cold `cargo build` or
// a container pull outlives every ceiling a "sane" ladder would stop at. Claude
// Code defaults to 2 min and documents 10 min as its maximum, and 2 min is the
// default here too — but that ceiling exists because it KILLS the process at the
// deadline. This app never does (the command is running in the user's own shell,
// see `pty_exec.rs`); the timeout only decides when the agent stops waiting and
// is told the command is still running. So the ladder runs to the backend's own
// clamp of 3600s rather than stopping at 10 min.
const TIMEOUT_CHOICES = [30, 60, 120, 300, 600, 1200, 1800, 3600];

const fmtTimeout = (secs: number) => (secs < 60 ? `${secs}s` : `${secs / 60} min`);

export function AgentSection() {
  const s = useAppStore();
  const { save } = useSettings();

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <h3 className="text-[10px] font-semibold uppercase tracking-widest text-text-muted">
          {S.settings.agent.title}
        </h3>
        <p className="text-[11px] leading-relaxed text-text-secondary">
          {S.settings.agent.intro}
        </p>

        <Row label={S.settings.agent.maxIterations} hint={S.settings.agent.maxIterationsHint}>
          <Stepper
            value={s.agentMaxIterations}
            min={1}
            max={100}
            step={5}
            ariaLabel={S.settings.agent.maxIterations}
            onChange={(v) => void save({ agent_max_iterations: v })}
          />
        </Row>

        <Row label={S.settings.agent.commandTimeout} hint={S.settings.agent.commandTimeoutHint}>
          <select
            value={s.agentCommandTimeoutSecs}
            aria-label={S.settings.agent.commandTimeout}
            onChange={(e) => void save({ agent_command_timeout_secs: Number(e.target.value) })}
            className="rounded-md border border-border-subtle bg-bg-card px-2 py-1 text-[12px] text-text-primary"
          >
            {TIMEOUT_CHOICES.map((n) => (
              <option key={n} value={n}>
                {fmtTimeout(n)}
              </option>
            ))}
          </select>
        </Row>

        <Toggle
          label={S.settings.agent.webAccess}
          hint={S.settings.agent.webAccessHint}
          checked={s.aiWebAccess}
          onChange={(v) => void save({ ai_web_access: v })}
        />
      </section>
    </div>
  );
}
