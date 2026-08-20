import type { LocalAccelerationInfo } from "../../lib/types";
import { formatBytes } from "./ModelRow";

export function accelerationStatusText(
  label: string,
  acceleration: LocalAccelerationInfo,
): string {
  const details = [acceleration.backend.toUpperCase()];
  if (acceleration.device_name) details.push(acceleration.device_name);
  if (acceleration.device_memory_bytes !== null) {
    details.push(`${formatBytes(acceleration.device_memory_bytes)} device memory`);
  }
  const fallback = acceleration.fallback_reason ? ` — ${acceleration.fallback_reason}` : "";
  return `${label}: ${details.join(" · ")}${fallback}`;
}

/** One honest accelerator line per loaded local host. Chat, vision, and
 * embeddings can select and fall back independently, so they must never share a
 * single ambiguous status banner. */
export function AccelerationStatus({
  label,
  acceleration,
}: {
  label: string;
  acceleration: LocalAccelerationInfo;
}) {
  return (
    <p
      role="status"
      className={`rounded-lg px-3 py-2 text-[11px] leading-relaxed ${
        acceleration.fallback_reason
          ? "border border-warning/30 bg-warning/10 text-warning"
          : "bg-bg-elevated text-text-muted"
      }`}
    >
      {accelerationStatusText(label, acceleration)}
    </p>
  );
}
