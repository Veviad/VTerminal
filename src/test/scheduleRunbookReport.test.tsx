import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ report: vi.fn() }));
vi.mock("../lib/runbooks", () => ({ runbooksReport: mocks.report }));
vi.mock("../components/runbooks/RunbookReportViewer", () => ({ RunbookReportViewer: ({ report }: { report: { run_id: string } }) => <div>Native report {report.run_id}</div> }));

import { ScheduleRunbookReport, scheduledRunbookReportId } from "../components/schedules/ScheduleRunbookReport";

const id = "e22e9f84-d585-497f-8dd6-21a67c9e06f1";
beforeEach(() => { vi.clearAllMocks(); });

it("opens full native evidence from a schedule attempt without issuing another run", async () => {
  mocks.report.mockResolvedValue({ run_id: id });
  render(<ScheduleRunbookReport runId={id} />);
  expect(mocks.report).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "View runbook report" }));
  expect(await screen.findByText(`Native report ${id}`)).toBeTruthy();
  expect(mocks.report).toHaveBeenCalledExactlyOnceWith(id);
  fireEvent.click(screen.getByRole("button", { name: "Close runbook report" }));
  fireEvent.click(screen.getByRole("button", { name: "View runbook report" }));
  expect(mocks.report).toHaveBeenCalledTimes(1);
});

it("allows retry when the native report is unavailable", async () => {
  mocks.report.mockRejectedValueOnce("Report unavailable").mockResolvedValue({ run_id: id });
  render(<ScheduleRunbookReport runId={id} />);
  fireEvent.click(screen.getByRole("button", { name: "View runbook report" }));
  fireEvent.click(await screen.findByRole("button", { name: "Retry loading report" }));
  expect(await screen.findByText(`Native report ${id}`)).toBeTruthy();
});

it("accepts only the durable native-report marker", () => {
  expect(scheduledRunbookReportId(`Runbook report: ${id}`)).toBe(id);
  expect(scheduledRunbookReportId(`arbitrary output Runbook report: ${id}`)).toBeNull();
  expect(scheduledRunbookReportId("Runbook report: ../../private")).toBeNull();
  expect(scheduledRunbookReportId(null)).toBeNull();
});
