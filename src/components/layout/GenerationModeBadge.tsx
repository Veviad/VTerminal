import { useAppStore } from "../../stores/appStore";

/** Shows the decoding path confirmed by the loaded on-device model. */
export function GenerationModeBadge({ verbose = false }: { verbose?: boolean }) {
  const mode = useAppStore((state) => {
    const active = state.catalog.find((entry) => entry.id === state.activeModelId);
    if (!active?.local || state.loadedModelId !== active.id || state.modelState !== "ready") {
      return null;
    }
    return state.localAcceleration?.generation_mode ?? null;
  });
  const fallbackReason = useAppStore(
    (state) => state.localAcceleration?.generation_fallback_reason ?? null,
  );

  if (!mode) return null;
  const mtp = mode === "mtp";
  const label = verbose ? (mtp ? "MTP active" : "Standard decoding") : (mtp ? "MTP" : "Standard");
  const title = mtp
    ? "MTP speculative decoding is active."
    : fallbackReason
      ? `Standard decoding is active: ${fallbackReason}`
      : "Standard decoding is active.";

  return (
    <span
      title={title}
      className={`shrink-0 rounded px-1.5 py-0.5 font-sans text-[8px] font-semibold uppercase tracking-wide ${
        mtp ? "bg-success/10 text-success" : fallbackReason ? "bg-warning/10 text-warning" : "bg-bg-elevated text-text-secondary"
      }`}
    >
      {label}
    </span>
  );
}
