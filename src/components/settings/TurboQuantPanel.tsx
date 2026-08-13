import { useEffect, useState } from "react";
import { Gauge, Loader2 } from "lucide-react";

import * as api from "../../lib/tauri";
import type { KnowledgeBucketDescriptor, TurboQuantBits } from "../../lib/types";

type Selection = "off" | TurboQuantBits;

export function TurboQuantPanel({
  bucket,
  onChanged,
}: {
  bucket: KnowledgeBucketDescriptor;
  onChanged: () => Promise<void>;
}) {
  const current: Selection =
    bucket.quantization?.state === "turbo" ? bucket.quantization.bits : "off";
  const [selection, setSelection] = useState<Selection>(current);
  const [alwaysRam, setAlwaysRam] = useState(
    bucket.quantization?.state === "turbo" ? bucket.quantization.always_ram : false,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSelection(current);
    setAlwaysRam(
      bucket.quantization?.state === "turbo" ? bucket.quantization.always_ram : false,
    );
  }, [current, bucket.quantization]);

  if (!bucket.manageable || bucket.ref.source !== "qdrant") return null;

  const apply = async () => {
    if (
      selection !== "off" &&
      selection !== "bits4" &&
      // eslint-disable-next-line no-alert
      !window.confirm(
        `${labelFor(selection)} uses more aggressive compression than bits4. It saves more sidecar memory but can reduce retrieval recall. Keep full original vectors and enable it?`,
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.knowledgeQdrantTurboQuantSet(
        bucket.ref,
        selection === "off" ? null : { bits: selection, always_ram: alwaysRam },
      );
      await onChanged();
    } catch (reason) {
      // Includes the backend's explicit Qdrant <1.18 and manage-permission errors.
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  const dirty =
    selection !== current ||
    (selection !== "off" &&
      alwaysRam !==
        (bucket.quantization?.state === "turbo" ? bucket.quantization.always_ram : false));

  return (
    <details className="border-t border-border-subtle pt-2">
      <summary className="cursor-pointer text-[10px] font-medium text-text-muted hover:text-text-secondary">
        Advanced · TurboQuant
      </summary>
      <div className="mt-2 space-y-2 rounded border border-border-subtle bg-bg-elevated p-2">
        <p className="flex items-center gap-1 text-[10px] text-text-secondary">
          <Gauge size={11} /> Qdrant sidecar quantization
        </p>
        <p className="text-[9px] leading-relaxed text-text-muted">
          Off by default. TurboQuant keeps the original float vectors and builds a compressed search
          sidecar in the background, so it can be disabled later without re-embedding.
        </p>
        <label className="block text-[9px] text-text-muted">
          Compression
          <select
            value={selection}
            onChange={(event) => setSelection(event.target.value as Selection)}
            className="mt-1 w-full rounded-md border border-border-subtle bg-bg-card px-2 py-1 text-[10px] text-text-primary"
          >
            <option value="off">Off</option>
            <option value="bits4">bits4 — recommended (~8× sidecar compression)</option>
            <option value="bits2">bits2 — advanced</option>
            <option value="bits1_5">bits1.5 — advanced</option>
            <option value="bits1">bits1 — maximum compression</option>
          </select>
        </label>
        {selection !== "off" && (
          <label className="flex items-center gap-1.5 text-[9px] text-text-muted">
            <input
              type="checkbox"
              checked={alwaysRam}
              onChange={(event) => setAlwaysRam(event.target.checked)}
            />
            Keep the compressed sidecar in RAM
          </label>
        )}
        {selection !== "off" && selection !== "bits4" && (
          <p className="text-[9px] text-warning">
            Aggressive compression can reduce recall. bits4 is the recommended balance.
          </p>
        )}
        {bucket.quantization?.state === "other" && (
          <p className="text-[9px] text-warning">
            This collection currently uses another quantization mode ({bucket.quantization.kind}).
            Applying TurboQuant replaces that sidecar configuration.
          </p>
        )}
        {error && <p className="text-[9px] text-error">{error}</p>}
        <div className="flex justify-end">
          <button
            type="button"
            disabled={!dirty || busy}
            onClick={() => void apply()}
            className="flex items-center gap-1 rounded-md border border-border-subtle px-2 py-1 text-[10px] text-text-secondary hover:bg-bg-hover disabled:opacity-50"
          >
            {busy && <Loader2 size={10} className="animate-spin" />}
            Apply
          </button>
        </div>
      </div>
    </details>
  );
}
function labelFor(bits: Exclude<Selection, "off">): string {
  return bits === "bits1_5" ? "bits1.5" : bits;
}
