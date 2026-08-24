/**
 * How much an agent run may do without stopping to ask.
 *
 * Per-session and never persisted (see `AiStreamState.permissionMode`): a fresh
 * tab always starts at `ask`, which is the same safety property the boolean
 * `autoAccept` this replaced was guarding.
 *
 * The backend owns classification and dispatch. The frontend stores the chosen
 * mode for the session, sends it to the active run, and renders explanations.
 * It never infers approval from proposal fields. Explicitly selecting Full may
 * release the exact approval already on screen as part of that user gesture.
 */
/** `auto_all` is the stable wire id for the guarded mode now labelled Auto. */
export type PermissionMode = "ask" | "auto_read" | "auto_smart" | "auto_all" | "full";

export const PERMISSION_MODES: readonly PermissionMode[] = [
  "ask",
  "auto_read",
  "auto_smart",
  "auto_all",
  "full",
];

/** The backend's verdict on one command. */
export interface CommandVerdict {
  /** Provably reads and changes nothing. False also means "could not tell". */
  readOnly: boolean;
  /** Reaches the network, as far as the command text shows. */
  network: boolean;
}

/** Why a card is showing even though an auto mode is armed. Null in `ask`. */
export function askReason(mode: PermissionMode, verdict: CommandVerdict): "writes" | null {
  if (mode !== "auto_read" && mode !== "auto_smart") return null;
  return verdict.readOnly ? null : "writes";
}
