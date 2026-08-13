// Shared settings primitives. These were copy-pasted between TerminalSection
// and AgentSection; they live here now so a third caller does not fork them again.

import { useRef, useState } from "react";

/** The house text input. Shared so a form does not have to re-derive the border,
 *  padding and focus ring from a sibling file. */
export const inputClass =
  "w-full rounded-md border border-border-subtle bg-bg-card px-2 py-1.5 text-[12px] text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent";

/** A stacked form field, as opposed to `Row`'s label-left/control-right pair for
 *  scalar settings. An error REPLACES the hint rather than stacking under it, so
 *  the row height does not jump while you type. */
export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <p className="text-[11px] text-text-secondary">{label}</p>
      {children}
      {error ? (
        <p className="text-[10px] text-error">{error}</p>
      ) : (
        hint && <p className="text-[10px] text-text-muted">{hint}</p>
      )}
    </div>
  );
}

export function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <p className="text-[12px] text-text-secondary">{label}</p>
        {hint && <p className="text-[10px] text-text-muted">{hint}</p>}
      </div>
      {children}
    </div>
  );
}

export function Toggle({
  label,
  hint,
  checked,
  onChange,
  disabled = false,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <p className="text-[12px] text-text-secondary">{label}</p>
        {hint && <p className="text-[10px] leading-relaxed text-text-muted">{hint}</p>}
      </div>
      <button
        onClick={() => onChange(!checked)}
        disabled={disabled}
        className={`relative h-5 w-9 shrink-0 rounded-full transition-colors duration-150 ${
          checked ? "bg-accent" : "bg-bg-elevated"
        } disabled:cursor-not-allowed disabled:opacity-50`}
        role="switch"
        aria-checked={checked}
        // The visible label is a sibling <p>, so without this the switch has no
        // accessible name at all — a screen reader reads "switch, on" with no
        // indication of what is on.
        aria-label={label}
      >
        <span
          className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all duration-150 ${
            checked ? "start-[18px]" : "start-0.5"
          }`}
        />
      </button>
    </div>
  );
}

/**
 * A number field with ± buttons. The value is TYPEABLE: a range like 1–100
 * stepped one at a time is not a control, it is a chore.
 *
 * `step` sizes the buttons and the arrow keys; Shift multiplies it by 10. The
 * text is a free-form draft while focused and only reconciled on blur/Enter —
 * committing per keystroke would clamp the "1" out of "100" before the second
 * digit lands, and would write to the Rust store once per digit.
 */
export function Stepper({
  value,
  min,
  max,
  step = 1,
  ariaLabel,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  ariaLabel?: string;
  onChange: (v: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  // Enter and Escape decide the value and THEN blur, and the blur handler runs
  // synchronously inside that same event — before React has applied `setDraft`.
  // Without this latch, onBlur would re-read the stale draft and commit the very
  // text Escape just discarded.
  const settled = useRef(false);
  const clamp = (v: number) => Math.max(min, Math.min(max, v));

  // What the field currently reads as. A dirty draft wins so ± and the arrows
  // build on what the user just typed rather than on the last saved value.
  const current = () => {
    const n = Number.parseInt(draft ?? "", 10);
    return Number.isFinite(n) ? clamp(n) : value;
  };

  const set = (v: number) => {
    setDraft(null);
    if (v !== value) onChange(v);
  };

  // Keeping focus in the field is what lets ± step from typed-but-uncommitted
  // text: a blur here would commit the draft and the click would then step from
  // the not-yet-saved `value` prop, writing twice with the second one wrong.
  const keepFocus = (e: React.MouseEvent) => e.preventDefault();

  return (
    <div className="flex items-center gap-1">
      <button
        onClick={() => set(clamp(current() - step))}
        onMouseDown={keepFocus}
        disabled={value <= min}
        aria-label={`−${step}`}
        className="h-6 w-6 rounded-md border border-border-subtle text-[12px] text-text-secondary hover:bg-bg-hover disabled:opacity-60"
      >
        −
      </button>
      <input
        // Not type="number": its native arrows walk min + n·step, which for
        // (min 1, step 5) would snap 10 to 11. It also accepts "1e3" and "-".
        type="text"
        inputMode="numeric"
        value={draft ?? String(value)}
        aria-label={ariaLabel}
        onChange={(e) => setDraft(e.target.value.replace(/[^\d]/g, ""))}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={() => {
          if (settled.current) {
            settled.current = false;
            return;
          }
          set(current());
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            settled.current = true;
            set(current());
            e.currentTarget.blur();
          } else if (e.key === "Escape") {
            settled.current = true;
            setDraft(null);
            e.currentTarget.blur();
          } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            const delta = (e.key === "ArrowUp" ? step : -step) * (e.shiftKey ? 10 : 1);
            set(clamp(current() + delta));
          }
        }}
        // The same resting box as every other input in Settings — a borderless
        // number reads as a label, and nobody types into a label.
        className="h-6 w-12 rounded-md border border-border-subtle bg-bg-card text-center text-[12px] text-text-primary tabular-nums focus:border-accent focus:outline-none"
      />
      <button
        onClick={() => set(clamp(current() + step))}
        onMouseDown={keepFocus}
        disabled={value >= max}
        aria-label={`+${step}`}
        className="h-6 w-6 rounded-md border border-border-subtle text-[12px] text-text-secondary hover:bg-bg-hover disabled:opacity-60"
      >
        +
      </button>
    </div>
  );
}
