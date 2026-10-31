import { Globe2 } from "lucide-react";
import { activityLabel } from "../../lib/activity";
import type { ProviderActivity } from "../../lib/types";

/** Labels come from our vocabulary, not model prose or raw tool inputs. */
export function ProviderActivityFeed({ activities }: { activities?: ProviderActivity[] }) {
  if (!activities?.length) return null;
  const running = [...activities].reverse().find((activity) => activity.status === "running");
  const latest = running ?? activities[activities.length - 1];
  return (
    <details className="rounded-lg border border-border-subtle bg-bg-card px-3 py-2 text-[11px] text-text-secondary">
      <summary className="cursor-pointer">
        <span className="inline-flex items-center gap-1.5"><Globe2 size={12} />
          <span role="status">{activityLabel(latest)}</span>
          {activities.length > 1 && <span className="text-text-muted"> · {activities.length} activities</span>}
        </span>
      </summary>
      <ol className="mt-2 space-y-1 border-t border-border-subtle pt-2">
        {activities.map((activity) => <li key={activity.id}>{activityLabel(activity)}</li>)}
      </ol>
    </details>
  );
}
