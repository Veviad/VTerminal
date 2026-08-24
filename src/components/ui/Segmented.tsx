/**
 * A single-choice segmented control: `radiogroup` of `radio` buttons.
 *
 * Extracted from `EffortPicker`, which now renders through it. `Row.tsx` exists
 * so "a third caller does not fork them again", and a second hand-rolled
 * segmented control is exactly what that warns against — so the a11y shape and
 * the active/hover styling live here once. Callers keep their own domain logic
 * (which options exist, whether to render at all).
 *
 * `tone` picks the active-segment colour: `accent` for a neutral choice,
 * `warning` for one the user should notice they are in.
 *
 * **Choosing between this and `Dropdown`.** They take the same `SegmentedOption`s, so the
 * choice is about room, not behaviour: this shows every option at once and belongs
 * anywhere with horizontal space (Settings rows), while `Dropdown` shows only the current
 * value and belongs in the AI panel header, which is a fixed-height row inside a panel
 * that floors at 320px. `EffortPicker` renders through both, picked by its `layout` prop.
 */
export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  /** Per-option tooltip. Falls back to the group's `hint`. */
  title?: string;
  tone?: "accent" | "warning";
}

export interface SingleSelectProps<T extends string> {
  value: T;
  options: readonly SegmentedOption<T>[];
  onChange: (value: T) => void;
  ariaLabel: string;
  hint?: string;
  disabled?: boolean;
  size?: "sm" | "md";
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  hint,
  disabled,
  size = "md",
}: SingleSelectProps<T>) {
  const pad = size === "sm" ? "px-1.5 py-0.5 text-[9px]" : "px-2 py-1 text-[10px]";

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={`inline-flex shrink-0 rounded-md border border-border-subtle bg-bg-card p-0.5 ${
        disabled ? "opacity-50" : ""
      }`}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        const activeClass =
          opt.tone === "warning" ? "bg-warning text-bg-primary" : "bg-accent text-bg-primary";
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            title={opt.title ?? hint}
            onClick={() => onChange(opt.value)}
            className={`rounded ${pad} font-medium transition-colors duration-150 ${
              active ? activeClass : "text-text-muted hover:bg-bg-hover hover:text-text-secondary"
            }`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
