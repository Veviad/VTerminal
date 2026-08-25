import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  chooseExportFolder: vi.fn(),
  choosePackage: vi.fn(),
  exportPackage: vi.fn(),
  importPackage: vi.fn(),
  loadLibrary: vi.fn(),
  refreshSource: vi.fn(),
  removeSource: vi.fn(),
  restoreBuiltins: vi.fn(),
  selectSource: vi.fn(),
  start: vi.fn(),
}));

vi.mock("../hooks/useRunbooks", () => ({
  useRunbooks: () => ({
    exportPackage: mocks.exportPackage,
    importPackage: mocks.importPackage,
    loadLibrary: mocks.loadLibrary,
    refreshSource: mocks.refreshSource,
    removeSource: mocks.removeSource,
    restoreBuiltins: mocks.restoreBuiltins,
    selectSource: mocks.selectSource,
    start: mocks.start,
  }),
}));

vi.mock("../lib/runbooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/runbooks")>();
  return {
    ...actual,
    chooseRunbookExportFolder: mocks.chooseExportFolder,
    chooseRunbookPackage: mocks.choosePackage,
  };
});

import { RunbookLibrary } from "../components/runbooks/RunbookLibrary";
import { useRunbookStore } from "../stores/runbookStore";
import type { RunbookSource } from "../lib/runbooks";

function source(
  sourceKind: RunbookSource["source_kind"],
  state: RunbookSource["state"] = "valid",
): RunbookSource {
  return {
    source_id: `${sourceKind}-security`,
    source_kind: sourceKind,
    package_path: `/runbooks/${sourceKind}-security`,
    definition_id: `${sourceKind}-security`,
    version: "1.0.0",
    title: "macOS Security Posture",
    digest_sha256: "source-digest",
    state,
    validation_issues: [],
    imported_at: "2026-08-13T12:00:00Z",
    refreshed_at: "2026-08-13T12:00:00Z",
  };
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.chooseExportFolder.mockResolvedValue("/exports");
  mocks.choosePackage.mockResolvedValue(null);
  mocks.exportPackage.mockResolvedValue(null);
  mocks.importPackage.mockResolvedValue(null);
  mocks.loadLibrary.mockResolvedValue(undefined);
  mocks.refreshSource.mockResolvedValue(undefined);
  mocks.removeSource.mockResolvedValue(undefined);
  mocks.restoreBuiltins.mockResolvedValue([]);
  mocks.selectSource.mockResolvedValue(undefined);
  mocks.start.mockResolvedValue(null);
  useRunbookStore.getState().reset();
});

describe("RunbookLibrary", () => {
  it("groups creation and maintenance actions into aligned rows", () => {
    render(<RunbookLibrary sessionId={null} />);

    const creationActions = screen.getByRole("group", { name: "Runbook creation actions" });
    expect(within(creationActions).getByRole("button", { name: "New" })).toBeInTheDocument();
    expect(within(creationActions).getByRole("button", { name: "Import" })).toBeInTheDocument();
    const importAnsible = within(creationActions).getByRole("button", { name: "Import Ansible" });
    expect(importAnsible.parentElement).toHaveClass("col-span-2");

    const maintenanceActions = screen.getByRole("group", { name: "Runbook library maintenance" });
    expect(within(maintenanceActions).getByRole("button", { name: "Restore examples" })).toHaveClass("flex-1");
    expect(within(maintenanceActions).getByRole("button", { name: "Refresh library" })).toHaveClass("w-8");
  });

  it("labels included examples, omits disk refresh, and exports the selected package", async () => {
    const builtin = source("builtin");
    useRunbookStore.getState().setSources([builtin]);
    useRunbookStore.getState().selectSource(builtin.source_id);
    useRunbookStore.getState().setLoading("definition", true);

    render(<RunbookLibrary sessionId={null} />);

    expect(screen.getAllByText("Included with VTerminal")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Refresh runbook from disk" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Export runbook" }));

    await waitFor(() => {
      expect(mocks.exportPackage).toHaveBeenCalledWith(builtin.source_id, "/exports");
    });
  });

  it("does not export when the folder picker is cancelled", async () => {
    const builtin = source("builtin");
    useRunbookStore.getState().setSources([builtin]);
    useRunbookStore.getState().selectSource(builtin.source_id);
    mocks.chooseExportFolder.mockResolvedValue(null);

    render(<RunbookLibrary sessionId={null} />);
    fireEvent.click(screen.getByRole("button", { name: "Export runbook" }));

    await waitFor(() => expect(mocks.chooseExportFolder).toHaveBeenCalledTimes(1));
    expect(mocks.exportPackage).not.toHaveBeenCalled();
  });

  it("does not offer export for an invalid package", () => {
    const invalid = source("user", "invalid");
    useRunbookStore.getState().setSources([invalid]);
    useRunbookStore.getState().selectSource(invalid.source_id);

    render(<RunbookLibrary sessionId={null} />);

    expect(screen.getByRole("button", { name: "Export runbook" })).toBeDisabled();
    expect(mocks.chooseExportFolder).not.toHaveBeenCalled();
  });

  it("requires confirmation before hiding an included example and can restore examples", async () => {
    const builtin = source("builtin");
    useRunbookStore.getState().setSources([builtin]);
    useRunbookStore.getState().selectSource(builtin.source_id);

    render(<RunbookLibrary sessionId={null} />);

    fireEvent.click(screen.getByRole("button", { name: "Hide example" }));
    expect(mocks.removeSource).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm hide" }));
    await waitFor(() => expect(mocks.removeSource).toHaveBeenCalledWith(builtin.source_id));

    fireEvent.click(screen.getByRole("button", { name: "Restore examples" }));
    await waitFor(() => expect(mocks.restoreBuiltins).toHaveBeenCalledTimes(1));
  });

  it("retains disk refresh for imported runbooks", () => {
    const userSource = source("user");
    useRunbookStore.getState().setSources([userSource]);
    useRunbookStore.getState().selectSource(userSource.source_id);

    render(<RunbookLibrary sessionId={null} />);

    expect(screen.getByRole("button", { name: "Refresh runbook from disk" })).toBeInTheDocument();
    expect(screen.queryByText("Included with VTerminal")).not.toBeInTheDocument();
  });
});
