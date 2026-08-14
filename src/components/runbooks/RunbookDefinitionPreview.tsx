import {
  Bot,
  CheckCircle2,
  CircleDot,
  ListChecks,
  Network,
  Search,
  Shield,
  ShieldCheck,
  Target,
  TerminalSquare,
  Wrench,
} from "lucide-react";

import {
  definitionApiVersion,
  definitionCapabilities,
  type RunbookAction,
  type RunbookConstraints,
  type RunbookDefinition,
  type RunbookGoal,
} from "../../lib/runbooks";
import { RunbookMarkdown } from "./RunbookMarkdown";
import { humanizeRunbookState, primaryButton } from "./runbookUi";

export function RunbookDefinitionPreview({
  definition,
  onStart,
  startDisabled = false,
}: {
  definition: RunbookDefinition;
  onStart?(): void;
  startDisabled?: boolean;
}) {
  const capabilities = definitionCapabilities(definition);
  const inputs = Object.entries(definition.spec.inputs ?? {});

  return (
    <div className="space-y-5">
      <section className="space-y-2">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold text-text-primary">
              {definition.metadata.title}
            </h2>
            <p className="mt-0.5 font-mono text-[10px] text-text-muted">
              {definition.metadata.id} · v{definition.metadata.version} · {definitionApiVersion(definition)}
            </p>
          </div>
          {onStart && (
            <button onClick={onStart} disabled={startDisabled} className={primaryButton}>
              <CheckCircle2 size={12} />
              Preflight
            </button>
          )}
        </div>
        {definition.metadata.description && (
          <RunbookMarkdown>{definition.metadata.description}</RunbookMarkdown>
        )}
        {!!definition.metadata.tags?.length && (
          <div className="flex flex-wrap gap-1">
            {definition.metadata.tags.map((tag) => (
              <span
                key={tag}
                className="rounded border border-border-subtle bg-bg-card px-1.5 py-0.5 text-[9px] text-text-muted"
              >
                {tag}
              </span>
            ))}
          </div>
        )}
      </section>

      <section className="space-y-2 rounded-md border border-border-subtle bg-bg-card p-3">
        <h3 className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-widest text-text-muted">
          <Shield size={11} /> Declared capabilities
        </h3>
        <p className="text-[10px] leading-relaxed text-text-muted">
          Preview only. Every privileged, networked, opaque or mutating action is still approved at execution time.
        </p>
        <div className="grid grid-cols-2 gap-2 text-[11px]">
          <Capability
            icon={<Network size={11} />}
            label="Network"
            value={capabilities.network ? "Declared" : "Not declared"}
          />
          <Capability
            icon={<Shield size={11} />}
            label="Privilege"
            value={capabilities.privilege ?? "none"}
          />
        </div>
        {!!capabilities.writes?.length && (
          <div>
            <p className="text-[10px] text-text-muted">Declared writes</p>
            <ul className="mt-1 space-y-0.5 font-mono text-[10px] text-text-secondary">
              {capabilities.writes.map((path) => (
                <li key={path} className="break-all">{path}</li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {inputs.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-[10px] font-semibold uppercase tracking-widest text-text-muted">
            Inputs
          </h3>
          <div className="divide-y divide-border-subtle overflow-hidden rounded-md border border-border-subtle bg-bg-card">
            {inputs.map(([name, input]) => (
              <div key={name} className="flex items-start justify-between gap-3 px-3 py-2">
                <div className="min-w-0">
                  <p className="font-mono text-[11px] text-text-primary">{name}</p>
                  {input.description && (
                    <p className="text-[10px] text-text-muted">{input.description}</p>
                  )}
                </div>
                <span className="shrink-0 text-[10px] text-text-muted">
                  {input.type}{input.required ? " · required" : ""}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="space-y-2">
        {(definition.spec.context?.discover?.length ?? 0) > 0 && (
          <div className="rounded-md border border-border-subtle bg-bg-card p-3">
            <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-widest text-text-muted">
              <Search size={11} /> Target facts
            </p>
            <p className="mt-1 text-[10px] leading-relaxed text-text-muted">
              Run once before the first step, each with its own approval, so the model can adapt
              to this host instead of guessing. Their output is shown to every model phase.
            </p>
            <ul className="mt-1.5 space-y-0.5">
              {definition.spec.context?.discover?.map((probe) => (
                <li key={probe.name} className="font-mono text-[9px] text-text-secondary">
                  <span className="text-text-muted">{probe.name} · </span>
                  {probe.command}
                </li>
              ))}
            </ul>
          </div>
        )}
        <h3 className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-widest text-text-muted">
          <ListChecks size={11} /> {definition.spec.steps.length} steps
        </h3>
        <ol className="space-y-2">
          {definition.spec.steps.map((step, index) => (
            <li key={step.id} className="rounded-md border border-border-subtle bg-bg-card p-3">
              <div className="flex items-start gap-2">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-bg-elevated font-mono text-[9px] text-text-secondary">
                  {index + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <p className="text-[12px] font-medium text-text-primary">{step.title}</p>
                    <span className="font-mono text-[9px] text-text-muted">{step.id}</span>
                    {!step.required && (
                      <span className="rounded bg-bg-elevated px-1 text-[9px] text-text-secondary">
                        optional
                      </span>
                    )}
                  </div>
                  {step.description && (
                    <p className="mt-1 text-[10px] leading-relaxed text-text-muted">
                      {step.description}
                    </p>
                  )}
                  {step.goal && <StepGoal goal={step.goal} />}
                  {step.constraints && <StepBounds constraints={step.constraints} />}
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    {step.check ? (
                      <ActionPill phase="check" action={step.check} />
                    ) : (
                      // A goal-directed step has no `check:` of its own; the
                      // engine runs the goal conditions for that phase.
                      <span className="rounded bg-bg-elevated px-1.5 py-0.5 text-[9px] text-text-secondary">
                        check: goal conditions
                      </span>
                    )}
                    {step.apply && <ActionPill phase="apply" action={step.apply} />}
                    {step.verify ? (
                      <ActionPill phase="verify" action={step.verify} />
                    ) : (
                      step.apply && (
                        <span className="rounded bg-bg-elevated px-1.5 py-0.5 text-[9px] text-text-secondary">
                          verify: goal conditions
                        </span>
                      )
                    )}
                    <span className="text-[9px] text-text-muted">
                      failure: {humanizeRunbookState(step.onFailure ?? step.on_failure ?? "pause")}
                    </span>
                  </div>
                </div>
              </div>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

/** The objective, and the exact conditions the engine will grade it by.
 *
 * Both are shown because they answer different questions: the intent is what
 * the author meant, the conditions are what will actually decide the step. A
 * runbook whose conditions do not match its stated intent is reviewable only if
 * you can see them side by side. */
function StepGoal({ goal }: { goal: RunbookGoal }) {
  return (
    <div className="mt-2 rounded border border-border-subtle bg-bg-primary p-2">
      <p className="flex items-center gap-1 text-[9px] font-semibold uppercase tracking-widest text-text-muted">
        <Target size={10} /> Goal
      </p>
      <p className="mt-1 whitespace-pre-line text-[10px] leading-relaxed text-text-secondary">
        {goal.intent.trim()}
      </p>
      <p className="mt-1.5 text-[9px] text-text-muted">
        Met when {goal.checks.length === 1 ? "this condition holds" : "all of these hold"}:
      </p>
      <ul className="mt-1 space-y-0.5">
        {goal.checks.map((check) => (
          <li key={check.command} className="font-mono text-[9px] text-text-secondary">
            <span className="text-text-muted">exit {check.expect.join(" or ")} · </span>
            {check.command}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Only the bounds that actually refuse something are listed. `network: true`
 * and `privilege: root` permit rather than narrow, so showing them as "bounds"
 * would imply an enforcement that does not exist. */
function StepBounds({ constraints }: { constraints: RunbookConstraints }) {
  const bounds: string[] = [];
  if (constraints.maxCommands) bounds.push(`at most ${constraints.maxCommands} commands`);
  if (constraints.maxSeconds) bounds.push(`${constraints.maxSeconds}s`);
  if (constraints.maxRounds) bounds.push(`at most ${constraints.maxRounds} model rounds`);
  if (constraints.network === false) bounds.push("no network");
  if (constraints.privilege === "none") bounds.push("no privilege escalation");
  if (bounds.length === 0) return null;
  return (
    <p className="mt-1.5 flex flex-wrap items-center gap-1 text-[9px] text-text-muted">
      <ShieldCheck size={10} /> Bounded: {bounds.join(" · ")}
    </p>
  );
}

function Capability({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-start gap-1.5">
      <span className="mt-0.5 text-text-muted">{icon}</span>
      <span>
        <span className="block text-[10px] text-text-muted">{label}</span>
        <span className="block text-text-secondary">{value}</span>
      </span>
    </div>
  );
}

function ActionPill({ phase, action }: { phase: string; action: RunbookAction }) {
  const icon =
    action.uses === "shell" ? (
      <TerminalSquare size={10} />
    ) : action.uses === "agent" ? (
      <Bot size={10} />
    ) : action.uses === "manual" ? (
      <CircleDot size={10} />
    ) : (
      <Wrench size={10} />
    );
  return (
    <span className="inline-flex items-center gap-1 rounded border border-border-subtle bg-bg-primary px-1.5 py-0.5 text-[9px] text-text-secondary">
      {icon} {phase}: {action.uses}
    </span>
  );
}
