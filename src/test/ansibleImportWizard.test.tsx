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
    mocks.importProject.mockResolvedValue({
      source_id: "source-ansible",
      source_kind: "user",
      package_path: "/library/ansible-imports/source-ansible",
      definition_id: "web",
      version: "1.0.0",
      title: "Web",
      digest_sha256: "a".repeat(64),
      state: "valid",
      validation_issues: [],
      imported_at: "2026-08-25T12:00:00Z",
      refreshed_at: "2026-08-25T12:00:00Z",
    });
  });

  async function openInputsStage() {
    render(<AnsibleImportWizard onImported={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Import Ansible" }));
    await screen.findByText("Ansible Runner is not ready");
    fireEvent.click(screen.getByRole("button", { name: "Select project directory" }));
    await screen.findByText("/projects/web");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByText("Extra variables")).toBeInTheDocument();
  }

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

  it("validates identifiers and preserves rows when an earlier input is removed", async () => {
    await openInputsStage();
    const continueButton = screen.getByRole("button", { name: "Continue" });

    fireEvent.click(screen.getByRole("button", { name: "Add input" }));
    fireEvent.change(screen.getByLabelText("Input 1 ID"), {
      target: { value: "region" },
    });
    fireEvent.change(screen.getByLabelText("Input 1 variable"), {
      target: { value: "bad-variable" },
    });
    expect(
      screen.getByText(/letter or underscore and use only letters/i),
    ).toBeInTheDocument();
    expect(continueButton).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Input 1 variable"), {
      target: { value: "deploy_region" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add input" }));
    fireEvent.change(screen.getByLabelText("Input 2 ID"), {
      target: { value: "region" },
    });
    fireEvent.change(screen.getByLabelText("Input 2 variable"), {
      target: { value: "deploy_region" },
    });
    expect(screen.getAllByText("Input IDs must be unique.")).toHaveLength(2);
    expect(
      screen.getAllByText("Ansible variables must be unique."),
    ).toHaveLength(2);

    fireEvent.change(screen.getByLabelText("Input 2 ID"), {
      target: { value: "port" },
    });
    fireEvent.change(screen.getByLabelText("Input 2 variable"), {
      target: { value: "http_port" },
    });
    expect(continueButton).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "Remove input 1" }));
    expect(screen.getByLabelText("Input 1 ID")).toHaveValue("port");
    expect(screen.getByLabelText("Input 1 variable")).toHaveValue("http_port");
  });

  it("requires enum values and includes them in the import request", async () => {
    const onImported = vi.fn(async () => {});
    render(<AnsibleImportWizard onImported={onImported} />);
    fireEvent.click(screen.getByRole("button", { name: "Import Ansible" }));
    await screen.findByText("Ansible Runner is not ready");
    fireEvent.click(screen.getByRole("button", { name: "Select project directory" }));
    await screen.findByText("/projects/web");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    fireEvent.click(screen.getByRole("button", { name: "Add input" }));
    fireEvent.change(screen.getByLabelText("Input 1 ID"), {
      target: { value: "environment" },
    });
    fireEvent.change(screen.getByLabelText("Input 1 variable"), {
      target: { value: "deploy_environment" },
    });
    fireEvent.change(screen.getByLabelText("Input 1 type"), {
      target: { value: "enum" },
    });
    expect(screen.getByText("Add at least one allowed value.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Input 1 allowed values"), {
      target: { value: "development, production" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: "Import Runbook" }));

    await waitFor(() => expect(mocks.importProject).toHaveBeenCalledOnce());
    expect(mocks.importProject).toHaveBeenCalledWith(
      expect.objectContaining({
        inputs: [
          expect.objectContaining({
            id: "environment",
            variable: "deploy_environment",
            type: "enum",
            values: ["development", "production"],
          }),
        ],
      }),
    );
    await waitFor(() => expect(onImported).toHaveBeenCalledOnce());
  });
});
