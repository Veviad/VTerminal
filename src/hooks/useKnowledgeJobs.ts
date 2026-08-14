import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useCallback, useEffect, useState } from "react";

import * as api from "../lib/tauri";
import type { KnowledgeJob } from "../lib/types";

const JOB_UPDATED_EVENT = "knowledge-job-updated";

function newestFirst(jobs: KnowledgeJob[]): KnowledgeJob[] {
  return [...jobs].sort((left, right) => right.updated_at - left.updated_at);
}

/** One app-level durable job feed. Backend events make progress responsive; the
 * short poll is an intentional fallback for app resume, CLI-owned jobs, and an
 * event emitted before the webview subscribed. */
export function useKnowledgeJobs(enabled: boolean): {
  jobs: KnowledgeJob[];
  refresh: () => Promise<void>;
} {
  const [jobs, setJobs] = useState<KnowledgeJob[]>([]);

  const refresh = useCallback(async () => {
    if (!enabled) {
      setJobs([]);
      return;
    }
    setJobs(newestFirst(await api.knowledgeJobsList()));
  }, [enabled]);

  useEffect(() => {
    if (!enabled) {
      setJobs([]);
      return;
    }
    void refresh().catch(() => {});
    const timer = window.setInterval(() => void refresh().catch(() => {}), 2500);
    return () => window.clearInterval(timer);
  }, [enabled, refresh]);

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let unlisten: UnlistenFn | null = null;
    void listen<KnowledgeJob>(JOB_UPDATED_EVENT, ({ payload }) => {
      setJobs((current) =>
        newestFirst([payload, ...current.filter((candidate) => candidate.id !== payload.id)]),
      );
    })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch(() => {
        // Polling above remains the complete fallback outside a Tauri webview.
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [enabled]);

  return { jobs, refresh };
}
