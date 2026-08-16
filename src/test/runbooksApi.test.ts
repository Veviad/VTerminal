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

import {
  runbooksDelete,
  runbooksDraftPublish,
  runbooksDraftSave,
  runbooksExportPackage,
  runbooksRestoreBuiltins,
  type RunbookDeleteResult,
  type RunbookExportResult,
  type RunbookSourceWire,
} from "../lib/runbooks";

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

  it("passes source and destination to package export without using report export", async () => {
    const result: RunbookExportResult = {
      destination: "/exports/runbook-security-v1.0.0",
      files: ["runbook.vrun.yaml", "README.md"],
    };
    invokeMock.mockResolvedValue(result);

    await expect(runbooksExportPackage("builtin-security", "/exports")).resolves.toEqual(result);
    expect(invokeMock).toHaveBeenCalledWith("runbooks_export_package", {
      source_id: "builtin-security",
      destination: "/exports",
    });
  });

  it("normalizes restored built-ins and preserves their source kind", async () => {
    const source: RunbookSourceWire = {
      id: "builtin-security",
      source_kind: "builtin",
      package_path: "/app-data/runbooks/macos-security-posture",
      definition_id: "macos-security-posture",
      definition_version: "1.0.0",
      title: "macOS Security Posture",
      source_sha256: "source-digest",
      canonical_sha256: "canonical-digest",
      valid: true,
      validation_error: null,
      created_at: "2026-08-13T12:00:00Z",
      updated_at: "2026-08-13T12:00:00Z",
    };
    invokeMock.mockResolvedValue([source]);

    await expect(runbooksRestoreBuiltins()).resolves.toEqual([
      expect.objectContaining({
        source_id: "builtin-security",
        source_kind: "builtin",
        state: "valid",
      }),
    ]);
    expect(invokeMock).toHaveBeenCalledWith("runbooks_restore_builtins");
  });

  it("sends revision-checked draft saves and normalizes published sources", async () => {
    const document = {
      definitionId: "wizard-health",
      version: "1.0.0",
      title: "Wizard Health",
      description: "",
      tags: [],
      platform: "macos13" as const,
      network: false,
      privilege: "none" as const,
      defaultOnFailure: "continue" as const,
      writes: [],
      inputs: [],
      steps: [],
    };
    invokeMock.mockResolvedValueOnce({ id: "draft-1", revision: 3, document });
    await runbooksDraftSave("draft-1", 2, document);
    expect(invokeMock).toHaveBeenLastCalledWith("runbooks_draft_save", {
      draft_id: "draft-1",
      expected_revision: 2,
      document,
    });

    const source: RunbookSourceWire = {
      id: "source-1",
      source_kind: "user",
      package_path: "/app-data/authored/draft-1",
      definition_id: "wizard-health",
      definition_version: "1.0.0",
      title: "Wizard Health",
      source_sha256: "source-digest",
      canonical_sha256: "canonical-digest",
      valid: true,
      validation_error: null,
      created_at: "2026-08-13T12:00:00Z",
      updated_at: "2026-08-13T12:00:00Z",
    };
    invokeMock.mockResolvedValueOnce(source);
    await expect(runbooksDraftPublish("draft-1", 3)).resolves.toEqual(
      expect.objectContaining({ source_id: "source-1", source_kind: "user" }),
    );
    expect(invokeMock).toHaveBeenLastCalledWith("runbooks_draft_publish", {
      draft_id: "draft-1",
      expected_revision: 3,
    });
  });
});
