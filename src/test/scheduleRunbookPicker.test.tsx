import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ list: vi.fn(), definition: vi.fn(), changed: vi.fn() }));
vi.mock("../lib/runbooks", async (original) => ({
  ...await original<typeof import("../lib/runbooks")>(), runbooksList: mocks.list, runbooksGetDefinition: mocks.definition,
}));

import { ScheduleRunbookPicker } from "../components/schedules/ScheduleRunbookPicker";
import type { ScheduleRunbook } from "../lib/schedules";

const initial: ScheduleRunbook = { source_id: "", canonical_sha256: "", inputs: {}, approval: "none" };
const definition = { kind: "Runbook", metadata: { title: "Cleanup", version: "1.0.0", id: "cleanup" }, spec: {
  target: { kind: "active-terminal" }, steps: [], inputs: { keep_days: { type: "integer", required: true, default: 7, description: "Retention" } },
} };

function Harness({ start = initial }: { start?: ScheduleRunbook }) {
  const [value, setValue] = useState(start);
  return <ScheduleRunbookPicker value={value} onChange={(next) => { mocks.changed(next); setValue(next); }} />;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.list.mockResolvedValue([
    { source_id: "r1", state: "valid", title: "Cleanup", version: "1.0.0", canonical_sha256: "sha-one" },
    { source_id: "r2", state: "valid", title: "Health check", version: "2.0.0", canonical_sha256: "sha-two" },
  ]);
  mocks.definition.mockResolvedValue(definition);
});

describe("scheduled runbook authorization", () => {
  it("pins the selected definition and loads input defaults without granting approval", async () => {
    render(<Harness />);
    await screen.findByRole("option", { name: /Cleanup/ });
    fireEvent.change(screen.getByLabelText("Scheduled runbook"), { target: { value: "r1" } });
    await waitFor(() => expect(mocks.changed).toHaveBeenLastCalledWith({ source_id: "r1", canonical_sha256: "sha-one", inputs: { keep_days: 7 }, approval: "none" }));
    expect((screen.getByLabelText("Runbook input keep_days") as HTMLInputElement).value).toBe("7");
  });

  it("retains saved inputs and makes full automatic approval an explicit selection", async () => {
    render(<Harness start={{ source_id: "r1", canonical_sha256: "sha-one", inputs: { keep_days: 14 }, approval: "read_only" }} />);
    await screen.findByLabelText("Runbook input keep_days");
    expect(mocks.changed).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Runbook automatic approval"), { target: { value: "all" } });
    expect(mocks.changed).toHaveBeenLastCalledWith({ source_id: "r1", canonical_sha256: "sha-one", inputs: { keep_days: 14 }, approval: "all" });
    expect(screen.getByText(/No employee approval is required/)).toBeTruthy();
  });

  it("clears standing approval when switching runbooks", async () => {
    render(<Harness start={{ source_id: "r1", canonical_sha256: "sha-one", inputs: { keep_days: 14 }, approval: "all" }} />);
    await screen.findByRole("option", { name: /Health check/ });
    fireEvent.change(screen.getByLabelText("Scheduled runbook"), { target: { value: "r2" } });
    expect(mocks.changed).toHaveBeenCalledWith({ source_id: "r2", canonical_sha256: "sha-two", inputs: {}, approval: "none" });
    await waitFor(() => expect(mocks.changed).toHaveBeenLastCalledWith(expect.objectContaining({ source_id: "r2", approval: "none" })));
  });

  it("requires a deliberate refresh when the published definition changes", async () => {
    render(<Harness start={{ source_id: "r1", canonical_sha256: "old-sha", inputs: {}, approval: "all" }} />);
    fireEvent.click(await screen.findByRole("button", { name: "Use current definition" }));
    expect(mocks.changed).toHaveBeenCalledWith({ source_id: "r1", canonical_sha256: "sha-one", inputs: {}, approval: "none" });
  });
});
