import { useEffect } from "react";
import { dismissUpdatePrompt, startAutoUpdateChecks } from "../lib/appUpdates";
import { useAppStore } from "../stores/appStore";

export function useAutoUpdater(workspaceReady = false): void {
  const settingsLoaded = useAppStore((state) => state.settingsLoaded);
  const enabled = useAppStore((state) => state.autoUpdateEnabled);

  useEffect(() => {
    if (!settingsLoaded || !workspaceReady) return;
    if (!enabled) {
      dismissUpdatePrompt();
      return;
    }
    return startAutoUpdateChecks();
  }, [settingsLoaded, enabled, workspaceReady]);
}
