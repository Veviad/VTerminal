import { useEffect, useRef, useState } from "react";
import { useAppStore } from "../../stores/appStore";
import { useSettings } from "../../hooks/useSettings";
import { useAutoGrow } from "../../hooks/useAutoGrow";
import { S } from "../../lib/strings";
import type { SettingsPatch } from "../../lib/types";

/** Mirrors `agent::instructions::MAX_CHARS`. Rust is the enforcer — it REJECTS a
 *  save over the cap rather than truncating — so this copy exists to show the
 *  counter and stop the doomed request, never as the check itself. */
export const MAX_INSTRUCTION_CHARS = 4000;

/** Roughly twelve lines before the box starts scrolling. Standing instructions
 *  are read back far more often than they are written, and a field that grows
 *  to 4000 characters would push the other two off the screen. */
const MAX_TEXTAREA_PX = 260;

/** The three fields, in the order the section shows them: shared text first,
 *  because that is the order they are concatenated in on the Rust side. */
const FIELDS = [
  {
    key: "custom_instructions",
    label: S.settings.instructions.global,
    hint: S.settings.instructions.globalHint,
    placeholder: S.settings.instructions.globalPlaceholder,
    select: (s: ReturnType<typeof useAppStore.getState>) => s.customInstructions,
  },
  {
    key: "agent_custom_instructions",
    label: S.settings.instructions.agent,
    hint: S.settings.instructions.agentHint,
    placeholder: S.settings.instructions.agentPlaceholder,
    select: (s: ReturnType<typeof useAppStore.getState>) => s.agentCustomInstructions,
  },
  {
    key: "chat_custom_instructions",
    label: S.settings.instructions.chat,
    hint: S.settings.instructions.chatHint,
    placeholder: S.settings.instructions.chatPlaceholder,
    select: (s: ReturnType<typeof useAppStore.getState>) => s.chatCustomInstructions,
  },
] as const;

type FieldKey = (typeof FIELDS)[number]["key"];

function InstructionsEditor({
  fieldKey,
  label,
  hint,
  placeholder,
  value,
  onSave,
}: {
  fieldKey: FieldKey;
  label: string;
  hint: string;
  placeholder: string;
  value: string;
  onSave: (patch: Partial<SettingsPatch>) => Promise<void>;
}) {
  // A free-form draft while focused, reconciled on blur — the same contract
  // `Stepper` uses, for a sharper reason here: every commit is a Rust store
  // write plus an fsync, and per-keystroke saving would make one per character.
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  useAutoGrow(ref, MAX_TEXTAREA_PX, [draft]);

  // Re-sync when the store changes underneath — a `loadSettings` after a failed
  // save, or the Clear button below. Keyed on `value` so a save that Rust
  // normalised (it trims) settles the box rather than leaving it dirty forever.
  useEffect(() => {
    setDraft(value);
  }, [value]);

  const used = draft.trim().length;
  const tooLong = used > MAX_INSTRUCTION_CHARS;

  const commit = async (next: string) => {
    if (next === value) return;
    // Refusing here rather than letting Rust reject keeps the message specific:
    // the backend's error names a character count, this names the field the user
    // is looking at, and neither round-trips.
    if (next.trim().length > MAX_INSTRUCTION_CHARS) return;
    setError(null);
    try {
      await onSave({ [fieldKey]: next } as Partial<SettingsPatch>);
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // The "Saved" flash is time-based, so it has to be cleaned up: a section that
  // unmounts mid-flash (the user switches tab) would set state on a dead node.
  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => {
      setSaved(false);
    }, 1600);
    return () => {
      clearTimeout(timer);
    };
  }, [saved]);

  const counterClass = tooLong ? "text-error" : "text-text-muted";

  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-[12px] text-text-secondary">{label}</p>
        <span className={`shrink-0 text-[10px] tabular-nums ${counterClass}`}>
          {S.settings.instructions.charCount(used, MAX_INSTRUCTION_CHARS)}
        </span>
      </div>
      <textarea
        ref={ref}
        value={draft}
        aria-label={label}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(e) => {
          setDraft(e.target.value);
          setSaved(false);
        }}
        onBlur={() => void commit(draft)}
        onKeyDown={(e) => {
          // Enter inserts a newline — these are paragraphs, not a one-line
          // field. ⌘/Ctrl+Enter is the explicit commit, and Escape reverts.
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            e.currentTarget.blur();
          } else if (e.key === "Escape") {
            setDraft(value);
            setError(null);
          }
        }}
        rows={3}
        className={`w-full resize-none rounded-md border bg-bg-card px-2 py-1.5 text-[12px] leading-relaxed text-text-primary placeholder:text-text-muted focus:outline-none ${
          tooLong ? "border-error" : "border-border-subtle focus:border-accent"
        }`}
      />
      <div className="flex items-start justify-between gap-3">
        {/* An error REPLACES the hint rather than stacking under it, matching
            `Field` in ui/Row — the row height must not jump while you type. */}
        <p className={`min-w-0 text-[10px] leading-relaxed ${error || tooLong ? "text-error" : "text-text-muted"}`}>
          {tooLong
            ? S.settings.instructions.tooLong(MAX_INSTRUCTION_CHARS)
            : (error ?? hint)}
        </p>
        <div className="flex shrink-0 items-center gap-2">
          {saved && <span className="text-[10px] text-text-muted">{S.settings.instructions.saved}</span>}
          {value.length > 0 && (
            <button
              type="button"
              className="rounded px-1.5 py-0.5 text-[10px] text-text-muted hover:bg-bg-hover hover:text-text-secondary"
              // Empty string is the clear sentinel over IPC — JSON null is
              // indistinguishable from "not provided" once serde sees Option.
              onClick={() => void commit("")}
            >
              {S.settings.instructions.clear}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export function InstructionsSection() {
  const s = useAppStore();
  const { save } = useSettings();

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <h3 className="text-[10px] font-semibold uppercase tracking-widest text-text-muted">
          {S.settings.instructions.title}
        </h3>
        <p className="text-[11px] leading-relaxed text-text-secondary">
          {S.settings.instructions.intro}
        </p>
        <p className="rounded-md border border-border-subtle bg-bg-card px-3 py-2 text-[11px] leading-relaxed text-text-muted">
          {S.settings.instructions.limits}
        </p>
      </section>

      <section className="space-y-5">
        {FIELDS.map((field) => (
          <InstructionsEditor
            key={field.key}
            fieldKey={field.key}
            label={field.label}
            hint={field.hint}
            placeholder={field.placeholder}
            value={field.select(s)}
            onSave={save}
          />
        ))}
        <p className="text-[10px] text-text-muted">{S.settings.instructions.saveHint}</p>
      </section>
    </div>
  );
}
