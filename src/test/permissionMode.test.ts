import { describe, expect, it } from "vitest";
import {
  askReason,
  PERMISSION_MODES,
  type CommandVerdict,
} from "../lib/permissionMode";

// The three command shapes the modes have to tell apart. The backend
// (`agent::policy`) decides which one a command is; this file only pins what
// each mode does with that answer.
const LOCAL_READ: CommandVerdict = { readOnly: true, network: false };
const NETWORK_READ: CommandVerdict = { readOnly: true, network: true };
const WRITE: CommandVerdict = { readOnly: false, network: false };
const UNKNOWN: CommandVerdict = { readOnly: false, network: false };

describe("permission modes", () => {
  it("exposes every backend-owned permission mode", () => {
    expect(PERMISSION_MODES).toEqual(["ask", "auto_read", "auto_smart", "auto_all", "full"]);
  });
});

describe("askReason", () => {
  it("explains a card that appears despite Reads mode", () => {
    expect(askReason("auto_read", NETWORK_READ)).toBeNull();
    expect(askReason("auto_read", WRITE)).toBe("writes");
    expect(askReason("auto_read", { readOnly: false, network: true })).toBe("writes");
    expect(askReason("auto_smart", WRITE)).toBe("writes");
  });

  it("says nothing when the mode asks about everything anyway", () => {
    expect(askReason("ask", WRITE)).toBeNull();
    expect(askReason("ask", NETWORK_READ)).toBeNull();
  });

  it("says nothing for a command the mode did not stop", () => {
    expect(askReason("auto_read", LOCAL_READ)).toBeNull();
    expect(askReason("auto_all", WRITE)).toBeNull();
  });

  /** Whenever a card is up under Reads, there is a reason for it — otherwise the
   *  mode reads as broken. */
  it("always has a reason when Reads mode declined to auto-run", () => {
    for (const verdict of [WRITE, UNKNOWN, { readOnly: false, network: true }]) {
      expect(askReason("auto_read", verdict)).not.toBeNull();
    }
  });
});
