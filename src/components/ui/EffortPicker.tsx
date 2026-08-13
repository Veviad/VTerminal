import { Brain } from "lucide-react";

import { EFFORT_ORDER, type Effort } from "../../lib/types";
import { S } from "../../lib/strings";
import { Dropdown } from "./Dropdown";
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
 *
 * `layout` picks the presentation, not the behaviour. `"segmented"` shows every rung and
 * suits Settings, where there is room. `"dropdown"` is for the AI panel header: five rungs
 * at ~150px do not fit a row that also holds the mode tabs, the permission control and the
 * docs picker inside a panel that floors at 320px. Reasoning depth is a per-model setting
 * changed rarely, which is why it is the one that collapses rather than the mode switch.
 */
export function EffortPicker({
  value,
  available,
  onChange,
  disabled,
  size = "md",
  layout = "segmented",
}: {
  value: Effort;
  available: Effort[];
  onChange: (e: Effort) => void;
  disabled?: boolean;
  size?: "sm" | "md";
  layout?: "segmented" | "dropdown";
}) {
  if (available.length < 2) return null;
  // Keep ladder order regardless of how the backend listed them.
  const rungs = EFFORT_ORDER.filter((e) => available.includes(e));
  const options = rungs.map((rung) => ({ value: rung, label: LABELS[rung] }));

  if (layout === "dropdown") {
    return (
      <Dropdown
        value={value}
        options={options}
        onChange={onChange}
        ariaLabel={S.effort.label}
        hint={S.effort.hint}
        disabled={disabled}
        size={size}
        // The label alone ("High") says nothing about what is high.
        icon={<Brain size={size === "sm" ? 10 : 11} className="shrink-0 opacity-70" />}
      />
    );
  }

  return (
    <Segmented
      value={value}
      options={options}
      onChange={onChange}
      ariaLabel={S.effort.label}
      hint={S.effort.hint}
      disabled={disabled}
      size={size}
    />
  );
}
