import { describe, expect, it } from "vitest";
import {
  askReason,
  autoRuns,
  PERMISSION_MODES,
  type CommandVerdict,
  type PermissionMode,
} from "../lib/permissionMode";

// The three command shapes the modes have to tell apart. The backend
// (`agent::policy`) decides which one a command is; this file only pins what
// each mode does with that answer.
const LOCAL_READ: CommandVerdict = { readOnly: true, network: false };
const NETWORK_READ: CommandVerdict = { readOnly: true, network: true };
const WRITE: CommandVerdict = { readOnly: false, network: false };
const UNKNOWN: CommandVerdict = { readOnly: false, network: false };

describe("autoRuns — the full mode × command matrix", () => {
  const cases: [PermissionMode, CommandVerdict, boolean, string][] = [
    ["ask", LOCAL_READ, false, "confirm asks about a plain read"],
    ["ask", NETWORK_READ, false, "confirm asks about a fetch"],
    ["ask", WRITE, false, "confirm asks about a write"],
    ["auto_read", LOCAL_READ, true, "reads mode runs a plain read"],
    ["auto_read", NETWORK_READ, true, "reads mode runs a proven network read"],
    ["auto_read", WRITE, false, "reads mode still asks about a write"],
    ["auto_all", LOCAL_READ, true, "all runs a read"],
    ["auto_all", NETWORK_READ, true, "all runs a fetch"],
    ["auto_all", WRITE, true, "all runs a write"],
  ];

  it.each(cases)("%s + %o → %s (%s)", (mode, verdict, expected) => {
    expect(autoRuns(mode, verdict)).toBe(expected);
  });

  /** `readOnly: false` covers both "writes" and "could not tell", and the
   *  unprovable case must never auto-run below `auto_all`. */
  it("an unclassifiable command never skips the human except under All", () => {
    expect(autoRuns("ask", UNKNOWN)).toBe(false);
    expect(autoRuns("auto_read", UNKNOWN)).toBe(false);
    expect(autoRuns("auto_all", UNKNOWN)).toBe(true);
  });

  it("allows network access only when the backend also proves the command read-only", () => {
    expect(autoRuns("auto_read", NETWORK_READ)).toBe(true);
    expect(autoRuns("auto_read", { readOnly: false, network: true })).toBe(false);
  });

  it("every mode is covered by the matrix above", () => {
    expect(new Set(cases.map(([m]) => m))).toEqual(new Set(PERMISSION_MODES));
  });
});

describe("askReason", () => {
  it("explains a card that appears despite Reads mode", () => {
    expect(askReason("auto_read", NETWORK_READ)).toBeNull();
    expect(askReason("auto_read", WRITE)).toBe("writes");
    expect(askReason("auto_read", { readOnly: false, network: true })).toBe("writes");
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
      expect(autoRuns("auto_read", verdict)).toBe(false);
      expect(askReason("auto_read", verdict)).not.toBeNull();
    }
  });
});
