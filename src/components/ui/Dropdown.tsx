import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";

import type { SegmentedOption } from "./Segmented";

/**
 * A single-choice dropdown, taking the same options as {@link Segmented}.
 *
 * **Why both exist.** A segmented control shows every option at once, which is ideal
 * until the options stop fitting. The AI panel's header is a fixed-height row with no
 * wrapping and no horizontal scroll, and the panel itself defaults to 420px and floors at
 * 320px — while agent mode's three segmented controls plus two buttons need about 510px.
 * So the widest, least-frequently-changed choices collapse to this and the primary ones
 * stay segmented.
 *
 * **The trigger always renders the current value, with its `tone`.** That is the whole
 * reason a safety control can live in here: hiding the *options* is fine, hiding the
 * *state* is not. Arming auto-accept has to stay visible at a glance, so "All" shows in
 * warning colour on the trigger exactly as it did on the segment.
 *
 * Deliberately no portal. The popover is absolutely positioned inside a relative wrapper,
 * which is what `BucketPicker` already does in this same header — a portal would need
 * scroll/resize tracking to stay attached, for a menu two rows tall.
 */
export function Dropdown<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  hint,
  disabled,
  size = "md",
  icon,
}: {
  value: T;
  options: readonly SegmentedOption<T>[];
  onChange: (value: T) => void;
  ariaLabel: string;
  hint?: string;
  disabled?: boolean;
  size?: "sm" | "md";
  /** Optional leading glyph, for a control whose label alone is ambiguous. */
  icon?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const listId = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Closing when the control becomes disabled mid-run: the agent path disables these
  // while a turn is streaming, and a menu left open over a disabled trigger is a menu
  // whose clicks do nothing.
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  const current = options.find((o) => o.value === value);
  const pad = size === "sm" ? "px-1.5 py-0.5 text-[9px]" : "px-2 py-1 text-[10px]";
  const tone =
    current?.tone === "warning"
      ? "border-warning/50 bg-warning/15 text-warning"
      : "border-border-subtle bg-bg-card text-text-secondary";

  return (
    <div className="relative shrink-0" ref={ref}>
      <button
        type="button"
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        title={current?.title ?? hint}
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center gap-1 rounded-md border ${pad} font-medium transition-colors duration-150 ${tone} ${
          disabled ? "opacity-50" : "hover:bg-bg-hover"
        }`}
      >
        {icon}
        <span className="max-w-[7rem] truncate">{current?.label ?? value}</span>
        <ChevronDown size={size === "sm" ? 9 : 10} className="shrink-0 opacity-70" />
      </button>

      {open && (
        <div
          id={listId}
          role="listbox"
          aria-label={ariaLabel}
          className="absolute right-0 z-30 mt-1 min-w-[11rem] rounded-md border border-border-subtle bg-bg-card p-1 shadow-lg"
        >
          {hint && (
            <p className="px-1.5 py-1 text-[10px] leading-snug text-text-muted">{hint}</p>
          )}
          {options.map((opt) => {
            const active = opt.value === value;
            return (
              <button
                key={opt.value}
                type="button"
                role="option"
                aria-selected={active}
                onClick={() => {
                  onChange(opt.value);
                  setOpen(false);
                }}
                className={`flex w-full flex-col items-start gap-0.5 rounded px-1.5 py-1 text-left text-[11px] transition-colors duration-100 ${
                  active
                    ? opt.tone === "warning"
                      ? "bg-warning/15 text-warning"
                      : "bg-accent/15 text-accent"
                    : "text-text-primary hover:bg-bg-hover"
                }`}
              >
                <span className="font-medium">{opt.label}</span>
                {/* The per-option `title` is a tooltip on a segmented control, where
                    there is no room for prose. Here there is, and a permission mode the
                    user has to hover to understand is one they will pick wrongly. */}
                {opt.title && (
                  <span className="text-[10px] leading-snug text-text-muted">{opt.title}</span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
