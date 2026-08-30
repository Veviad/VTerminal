import { useEffect, useState } from "react";
import { useAppStore } from "../../stores/appStore";
import { useSettings } from "../../hooks/useSettings";
import { S } from "../../lib/strings";
import { Row, Stepper, Toggle } from "../ui/Row";
import type { CommandPolicyRule } from "../../lib/types";
import { tokenizeCommand } from "../../lib/nesting";

// Agents wait far longer than an interactive user does: a cold `cargo build` or
// a container pull outlives every ceiling a "sane" ladder would stop at. Claude
// Code defaults to 2 min and documents 10 min as its maximum, and 2 min is the
// default here too. That ceiling exists because it KILLS the process at the
// deadline. This app never does (the command runs in the user's own shell, see
// `pty_exec.rs`); the timeout only decides when completion becomes unknown and
// the Agent stops before dispatching another command. The ladder therefore runs
// to the backend's own clamp of 3600s rather than stopping at 10 min.
const TIMEOUT_CHOICES = [30, 60, 120, 300, 600, 1200, 1800, 3600];

const fmtTimeout = (secs: number) => (secs < 60 ? `${secs}s` : `${secs / 60} min`);

function quoteArgvToken(token: string): string {
  if (token !== "" && !/[\s'\"]/.test(token)) return token;
  if (!token.includes("'")) return `'${token}'`;
  if (!token.includes('"')) return `"${token}"`;
  return token;
}

export function formatArgvPattern(argv: string[]): string {
  return argv.map(quoteArgvToken).join(" ");
}

export function parseArgvPattern(value: string): string[] {
  return tokenizeCommand(value);
}

function RuleArgvInput({
  rule,
  onCommit,
}: {
  rule: CommandPolicyRule;
  onCommit: (argv: string[]) => void;
}) {
  const formatted = formatArgvPattern(rule.argv);
  const [draft, setDraft] = useState(formatted);

  useEffect(() => {
    setDraft(formatted);
  }, [formatted]);

  const commit = () => {
    const argv = parseArgvPattern(draft);
    if (argv.length > 0) onCommit(argv);
    else setDraft(formatted);
  };

  return (
    <input
      aria-label="Argv pattern"
      value={draft}
      onChange={(event) => { setDraft(event.target.value); }}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
      }}
      className="min-w-0 rounded border border-border-subtle bg-bg-primary px-2 py-1 font-mono text-[11px]"
    />
  );
}

export function AgentSection() {
  const s = useAppStore();
  const { save } = useSettings();
  const persistRules = (rules: CommandPolicyRule[]) => {
    void save({ agent_command_policy_rules: rules });
  };
  const updateRule = (id: string, patch: Partial<CommandPolicyRule>) => {
    persistRules(s.agentCommandPolicyRules.map((rule) => (rule.id === id ? { ...rule, ...patch } : rule)));
  };

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

      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="text-[10px] font-semibold uppercase tracking-widest text-text-muted">
              Command policy rules
            </h3>
            <p className="mt-1 text-[11px] leading-relaxed text-text-secondary">
              Match parsed arguments, not shell text. <code>*</code> matches one argument and <code>**</code> matches the remainder. Deny and always-ask rules override every auto mode.
            </p>
          </div>
          <button
            type="button"
            className="shrink-0 rounded-md border border-border-subtle px-2 py-1 text-[11px] text-text-secondary hover:bg-bg-hover"
            onClick={() => {
              persistRules([...s.agentCommandPolicyRules, {
                id: `rule-${crypto.randomUUID()}`,
                effect: "ask",
                scope: "local",
                argv: ["command", "**"],
                enabled: true,
                description: "",
              }]);
            }}
          >
            Add rule
          </button>
        </div>

        {s.agentCommandPolicyRules.length === 0 ? (
          <p className="rounded-md border border-dashed border-border-subtle px-3 py-2 text-[11px] text-text-muted">
            No saved rules. Reads remains deterministic and Smart fails closed when uncertain.
          </p>
        ) : (
          <div className="space-y-2">
            {s.agentCommandPolicyRules.map((rule) => (
              <div key={rule.id} className="space-y-2 rounded-md border border-border-subtle bg-bg-card p-2">
                <div className="grid grid-cols-[auto_1fr_auto] gap-2">
                  <select
                    aria-label="Rule effect"
                    value={rule.effect}
                    onChange={(event) => {
                      updateRule(rule.id, { effect: event.target.value as CommandPolicyRule["effect"] });
                    }}
                    className="rounded border border-border-subtle bg-bg-primary px-2 text-[11px]"
                  >
                    <option value="allow">Allow</option>
                    <option value="ask">Always ask</option>
                    <option value="deny">Deny</option>
                  </select>
                  <RuleArgvInput
                    rule={rule}
                    onCommit={(argv) => { updateRule(rule.id, { argv }); }}
                  />
                  <button
                    type="button"
                    className="rounded px-2 text-[11px] text-danger hover:bg-danger/10"
                    onClick={() => {
                      persistRules(s.agentCommandPolicyRules.filter((candidate) => candidate.id !== rule.id));
                    }}
                  >
                    Delete
                  </button>
                </div>
                <div className="grid grid-cols-[1fr_1fr_auto] gap-2">
                  <input
                    aria-label="Rule scope"
                    value={rule.scope}
                    onChange={(event) => { updateRule(rule.id, { scope: event.target.value }); }}
                    className="min-w-0 rounded border border-border-subtle bg-bg-primary px-2 py-1 text-[11px]"
                    placeholder="local or remote:host-id"
                  />
                  <input
                    aria-label="Rule description"
                    value={rule.description}
                    onChange={(event) => { updateRule(rule.id, { description: event.target.value }); }}
                    className="min-w-0 rounded border border-border-subtle bg-bg-primary px-2 py-1 text-[11px]"
                    placeholder="Description"
                  />
                  <label className="flex items-center gap-1 text-[11px] text-text-secondary">
                    <input type="checkbox" checked={rule.enabled} onChange={(event) => { updateRule(rule.id, { enabled: event.target.checked }); }} />
                    Enabled
                  </label>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
