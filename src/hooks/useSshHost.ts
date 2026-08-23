import { useEffect, useState } from "react";
import * as api from "../lib/tauri";
import type { SshHost } from "../lib/types";

interface SshHostLookup {
  host: SshHost | null;
  loading: boolean;
}

interface LookupState extends SshHostLookup {
  hostId: string | null;
}

/** Resolve a saved SSH host without ever exposing a result from an older id. */
export function useSshHost(hostId: string | null): SshHostLookup {
  const [lookup, setLookup] = useState<LookupState>({
    hostId: null,
    host: null,
    loading: false,
  });

  useEffect(() => {
    if (!hostId) {
      setLookup({ hostId: null, host: null, loading: false });
      return;
    }

    let cancelled = false;
    setLookup({ hostId, host: null, loading: true });
    void api
      .sshHostsGet(hostId)
      .then((host) => {
        if (!cancelled) setLookup({ hostId, host, loading: false });
      })
      .catch(() => {
        if (!cancelled) setLookup({ hostId, host: null, loading: false });
      });
    return () => {
      cancelled = true;
    };
  }, [hostId]);

  if (!hostId) return { host: null, loading: false };
  if (lookup.hostId !== hostId) return { host: null, loading: true };
  return { host: lookup.host, loading: lookup.loading };
}
