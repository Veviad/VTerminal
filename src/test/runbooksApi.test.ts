import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
  Channel: class<T> {
    onmessage?: (message: T) => void;
  },
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));

import { runbooksDelete, type RunbookDeleteResult } from "../lib/runbooks";

beforeEach(() => invokeMock.mockReset());

describe("runbooks API", () => {
  it("sends the backend's explicit confirmation flag when deleting history", async () => {
    const result: RunbookDeleteResult = {
      run_id: "run-1",
      database_deleted: true,
      evidence_cleanup: {
        expected: 1,
        deleted: 1,
        missing: 0,
        errors: [],
        complete: true,
      },
    };
    invokeMock.mockResolvedValue(result);

    await expect(runbooksDelete("run-1")).resolves.toEqual(result);
    expect(invokeMock).toHaveBeenCalledWith("runbooks_delete", {
      run_id: "run-1",
      confirmed: true,
    });
  });
});
