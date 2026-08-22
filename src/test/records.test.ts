import { describe, expect, it } from "vitest";
import { ownRecordValue, withRecordValue, withoutRecordKey } from "../lib/records";

describe("record helpers", () => {
  it("reads own entries without exposing inherited values", () => {
    const record = Object.assign(Object.create({ inherited: "hidden" }) as Record<string, string>, {
      own: "visible",
    });

    expect(ownRecordValue(record, "own")).toBe("visible");
    expect(ownRecordValue(record, "inherited")).toBeUndefined();
  });

  it("updates and removes one key without mutating or dropping unrelated entries", () => {
    const original = { first: 1, second: 2 };

    expect(withRecordValue(original, "first", 3)).toEqual({ second: 2, first: 3 });
    expect(withoutRecordKey(original, "first")).toEqual({ second: 2 });
    expect(withoutRecordKey(original, "missing")).toBe(original);
    expect(original).toEqual({ first: 1, second: 2 });
  });
});
