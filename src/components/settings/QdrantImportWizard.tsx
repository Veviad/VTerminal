import { useState } from "react";
import { Loader2 } from "lucide-react";

import * as api from "../../lib/tauri";
import type { KnowledgeBucketDescriptor } from "../../lib/types";

/**
 * One-release compatibility surface for bindings created by v0.2.0.
 *
 * New collections are never mapped locally: a managed collection carries the
 * immutable VTerminal contract in Qdrant collection metadata, which is shared by
 * every client. Keeping the old binding read-only avoids silently breaking a
 * previously attached collection while removing the error-prone import wizard.
 */
export function QdrantImportWizard({
  bucket,
  onChanged,
}: {
  bucket: KnowledgeBucketDescriptor;
  onChanged: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!bucket.imported && bucket.compatibility !== "legacy_import") return null;

  const forget = async () => {
    // eslint-disable-next-line no-alert
    if (
      !window.confirm(
        `Forget VTerminal’s legacy local mapping for “${bucket.label}”? The Qdrant collection and all of its points stay untouched.`,
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.knowledgeQdrantImportRemove(bucket.ref);
      await onChanged();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded border border-warning/30 bg-warning/10 p-2 text-[9px] leading-relaxed text-warning">
      <p>
        Legacy v0.2.0 import binding. It remains attach/search-only for compatibility. New clients
        do not share this local mapping; create a managed VTerminal collection to use shared
        Qdrant metadata instead.
      </p>
      <button
        type="button"
        disabled={busy}
        onClick={() => void forget()}
        className="mt-1.5 flex items-center gap-1 text-text-muted underline-offset-2 hover:text-error hover:underline disabled:opacity-50"
      >
        {busy && <Loader2 size={9} className="animate-spin" />}
        Forget legacy mapping
      </button>
      {error && <p className="mt-1 text-error">{error}</p>}
    </div>
  );
}
