import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  select: vi.fn(),
  inspect: vi.fn(),
  importProject: vi.fn(),
}));

vi.mock("../lib/runbooks", () => ({
  runbooksAnsibleStatus: mocks.status,
  selectAnsibleProjectDirectory: mocks.select,
  runbooksAnsibleInspect: mocks.inspect,
  runbooksAnsibleImport: mocks.importProject,
}));

import { AnsibleImportWizard } from "../components/runbooks/AnsibleImportWizard";

describe("AnsibleImportWizard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.status.mockResolvedValue({
      supported: true,
      installed: false,
      path: null,
      version: null,
      error: "ansible-runner was not found",
      installUrl: "https://ansible.readthedocs.io/projects/runner/en/latest/install/",
    });
    mocks.select.mockResolvedValue("/projects/web");
    mocks.inspect.mockResolvedValue({
      projectPath: "/projects/web",
      playbooks: ["site.yml", "verify.yml"],
      inventoryCandidates: ["inventory/hosts.ini"],
      includedFiles: 3,
      totalBytes: 4096,
      excluded: [".git"],
    });
  });

  it("guides a missing-Runner project through phase review", async () => {
    render(<AnsibleImportWizard onImported={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Import Ansible" }));
    expect(await screen.findByText("Ansible Runner is not ready")).toBeInTheDocument();
    expect(screen.getByText("Import is allowed without Runner. Execution remains blocked until it is installed.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Select project directory" }));
    expect(await screen.findByText("/projects/web")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByText("Remote hosts are reached through this inventory and Ansible SSH settings. Open VTerminal SSH sessions and credentials are not reused.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByText(/Check and verify always run with/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByText("Extra variables")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(screen.getAllByText("site.yml").length).toBeGreaterThan(0));
    expect(screen.getAllByText("--check --diff")).toHaveLength(2);
  });
});
