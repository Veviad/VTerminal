import { create } from "zustand";
import type { UpdateMetadata } from "../lib/types";

export type UpdateStatus =
  | "idle"
  | "checking"
  | "up_to_date"
  | "available"
  | "downloading"
  | "installing"
  | "error";

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
