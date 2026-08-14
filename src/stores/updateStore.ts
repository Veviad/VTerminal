import { create } from "zustand";
import type { UpdateMetadata } from "../lib/types";

export type UpdateStatus =
  | "idle"
  | "checking"
  | "up_to_date"
  | "available"
  | "downloading"
  | "verifying"
  | "cancelling"
  | "saving"
  | "installing"
  | "restarting"
  | "error";

/** Once durable exit preparation starts, frontend actions must not create or
 * mutate terminal state until restart succeeds or persistence is resumed. */
export const isUpdateExitBarrier = (status: UpdateStatus): boolean =>
  ["saving", "installing", "restarting"].includes(status);

export interface UpdateUiState {
  status: UpdateStatus;
  metadata: UpdateMetadata | null;
  lastCheckedAt: string | null;
  error: string | null;
  promptOpen: boolean;
  dismissedVersion: string | null;
  downloadedBytes: number;
  totalBytes: number | null;
  workspaceReady: boolean;
}

export const initialUpdateState: UpdateUiState = {
  status: "idle",
  metadata: null,
  lastCheckedAt: null,
  error: null,
  promptOpen: false,
  dismissedVersion: null,
  downloadedBytes: 0,
  totalBytes: null,
  workspaceReady: false,
};

export const useUpdateStore = create<UpdateUiState>(() => ({ ...initialUpdateState }));
