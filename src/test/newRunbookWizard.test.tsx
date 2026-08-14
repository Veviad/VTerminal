import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  discard: vi.fn(),
  get: vi.fn(),
  list: vi.fn(),
  publish: vi.fn(),
  save: vi.fn(),
  validate: vi.fn(),
}));

vi.mock("../lib/runbooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/runbooks")>();
  return {
    ...actual,
    runbooksDraftCreate: mocks.create,
    runbooksDraftDiscard: mocks.discard,
    runbooksDraftGet: mocks.get,
    runbooksDraftPublish: mocks.publish,
    runbooksDraftSave: mocks.save,
    runbooksDraftValidate: mocks.validate,
    runbooksDraftsList: mocks.list,
  };
});

import { NewRunbookWizard } from "../components/runbooks/NewRunbookWizard";
import type { RunbookDraft, RunbookDraftDocument, RunbookSource } from "../lib/runbooks";

const document: RunbookDraftDocument = {
  definitionId: "wizard-health",
  version: "1.0.0",
  title: "Wizard Health",
  description: "Assessment",
  tags: ["assessment"],
  platform: "macos13",
  network: false,
  privilege: "none",
  defaultOnFailure: "continue",
  inputs: [],
  steps: [
    {
      id: "health-check",
      title: "Health passes",
      required: true,
      onFailure: null,
      check: {
        kind: "shell",
        command: "true",
        env: {},
        compliantExitCodes: [0],
        noncompliantExitCodes: [1],
      },
    },
  ],
};

function draft(revision = 1, nextDocument = document): RunbookDraft {
  return {
    id: "draft-1",
    revision,
    document: nextDocument,
    publishedSourceId: null,
    lastPublishedVersion: null,
    dirty: true,
    createdAt: "2026-08-13T12:00:00Z",
    updatedAt: "2026-08-13T12:00:00Z",
  };
}

const source: RunbookSource = {
  source_id: "source-1",
  source_kind: "user",
  package_path: "/app-data/authored/draft-1",
  definition_id: "wizard-health",
  version: "1.0.0",
  title: "Wizard Health",
  digest_sha256: "digest",
  state: "valid",
  validation_issues: [],
  imported_at: "2026-08-13T12:00:00Z",
  refreshed_at: "2026-08-13T12:00:00Z",
};

beforeEach(() => {
  Object.values(mocks).forEach((mock) => mock.mockReset());
  mocks.list.mockResolvedValue([]);
  mocks.create.mockResolvedValue(draft());
  mocks.get.mockResolvedValue(draft());
  mocks.save.mockImplementation((_id, _revision, nextDocument) =>
    Promise.resolve(draft(2, nextDocument)),
  );
  mocks.validate.mockResolvedValue({
    definition: { kind: "Runbook", metadata: { id: "wizard-health", version: "1.0.0", title: "Wizard Health" }, spec: { target: { kind: "active-terminal" }, steps: [] } },
    sourceYaml: "kind: Runbook\n",
    readme: "# Wizard Health\n",
    issues: [],
  });
  mocks.publish.mockResolvedValue(source);
});

describe("NewRunbookWizard", () => {
  it("creates, autosaves, reviews, and publishes an assessment", async () => {
    const onPublished = vi.fn().mockResolvedValue(undefined);
    render(<NewRunbookWizard onPublished={onPublished} />);

    fireEvent.click(screen.getByRole("button", { name: "New" }));
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: /Create a new assessment/ }));
    await screen.findByRole("heading", { name: "New runbook wizard" });

    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Updated Health" } });
    await waitFor(() => expect(mocks.save).toHaveBeenCalled(), { timeout: 1500 });

    fireEvent.click(screen.getByRole("button", { name: /Review/ }));
    await screen.findByText("Ready to publish");
    fireEvent.click(screen.getByRole("button", { name: /Publish to Library/ }));

    await waitFor(() => {
      expect(mocks.publish).toHaveBeenCalledWith("draft-1", 2);
      expect(onPublished).toHaveBeenCalledWith(source);
    });
  });

  it("lists and resumes durable drafts", async () => {
    mocks.list.mockResolvedValue([
      {
        id: "draft-1",
        revision: 1,
        title: "Wizard Health",
        definitionId: "wizard-health",
        version: "1.0.0",
        publishedSourceId: null,
        lastPublishedVersion: null,
        dirty: true,
        updatedAt: "2026-08-13T12:00:00Z",
      },
    ]);
    render(<NewRunbookWizard onPublished={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "New" }));
    await screen.findByText("Wizard Health");
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    await waitFor(() => expect(mocks.get).toHaveBeenCalledWith("draft-1"));
    expect(await screen.findByDisplayValue("wizard-health")).toBeInTheDocument();
  });

  it("shows structured validation issues and blocks publication", async () => {
    mocks.validate.mockResolvedValue({
      definition: null,
      sourceYaml: null,
      readme: null,
      issues: [{ path: "metadata.id", message: "must not be empty" }],
    });
    render(<NewRunbookWizard onPublished={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "New" }));
    await screen.findByRole("button", { name: /Create a new assessment/ });
    fireEvent.click(screen.getByRole("button", { name: /Create a new assessment/ }));
    await screen.findByRole("heading", { name: "New runbook wizard" });
    fireEvent.click(screen.getByRole("button", { name: /Review/ }));
    const issue = await screen.findByRole("button", { name: /metadata.id/ });
    expect(screen.getByRole("button", { name: /Publish to Library/ })).toBeDisabled();
    expect(mocks.publish).not.toHaveBeenCalled();
    fireEvent.click(issue);
    await waitFor(() => expect(screen.getByLabelText("Runbook ID")).toHaveFocus());
  });
});
