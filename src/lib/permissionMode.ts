/**
 * How much an agent run may do without stopping to ask.
 *
 * Per-session and never persisted (see `AiStreamState.permissionMode`): a fresh
 * tab always starts at `ask`, which is the same safety property the boolean
 * `autoAccept` this replaced was guarding.
 *
 * The backend owns classification AND dispatch. The frontend stores the chosen
 * mode for the session, sends it to the active run, and renders explanations;
 * it never auto-clicks an approval proposal.
 */
export type PermissionMode = "ask" | "auto_read" | "auto_smart" | "auto_all";

export const PERMISSION_MODES: readonly PermissionMode[] = ["ask", "auto_read", "auto_smart", "auto_all"];

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
