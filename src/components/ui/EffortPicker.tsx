import { EFFORT_ORDER, type Effort } from "../../lib/types";
import { S } from "../../lib/strings";
import { Segmented } from "./Segmented";

const LABELS: Record<Effort, string> = {
  off: S.effort.off,
  low: S.effort.low,
  medium: S.effort.medium,
  high: S.effort.high,
  max: S.effort.max,
};

/**
 * Reasoning-depth selector, rendered from the model's OWN capability list.
 *
 * The whole point is that this is not a fixed five-way switch: Mistral offers
 * only off/high, Claude Haiku 4.5 spends depth as a token budget and errors on
 * the effort parameter outright, and the on-device models are an on/off toggle.
 * `available` comes straight from the catalog entry, so a rung the model would
 * reject is never offered — every one of these is a 400, not a downgrade.
 *
 * Renders nothing when there is no choice to make (Mistral Large 3 rejects the
 * parameter entirely, so it declares no rungs at all). An empty control that
 * does nothing is worse than no control.
 */
export function EffortPicker({
  value,
  available,
  onChange,
  disabled,
  size = "md",
}: {
  value: Effort;
  available: Effort[];
  onChange: (e: Effort) => void;
  disabled?: boolean;
  size?: "sm" | "md";
}) {
  if (available.length < 2) return null;
  // Keep ladder order regardless of how the backend listed them.
  const rungs = EFFORT_ORDER.filter((e) => available.includes(e));

  return (
    <Segmented
      value={value}
      options={rungs.map((rung) => ({ value: rung, label: LABELS[rung] }))}
      onChange={onChange}
      ariaLabel={S.effort.label}
      hint={S.effort.hint}
      disabled={disabled}
      size={size}
    />
  );
}
