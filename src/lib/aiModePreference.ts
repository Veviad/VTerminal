import { useAppStore } from "../stores/appStore";
import { saveSettings } from "./tauri";
import type { SelectableAiMode } from "./types";

let pendingSave: Promise<void> = Promise.resolve();

/** Remember explicit selector choices. Automatic Explain requests and stream
 * initialization never change the user's remembered mode. */
export function selectAiMode(sessionId: string, mode: SelectableAiMode): Promise<void> {
  const store = useAppStore.getState();
  if (!store.sessions.some((session) => session.id === sessionId)) return Promise.resolve();
  store.setAiMode(sessionId, mode);
  useAppStore.setState({ lastAiMode: mode });

  // Serialize writes across panels so an older IPC cannot overwrite a newer
  // choice. A failed save is reported to the caller without blocking retries.
  const saved = pendingSave.then(() => saveSettings({ last_ai_mode: mode }));
  pendingSave = saved.catch(() => {});
  return saved;
}
