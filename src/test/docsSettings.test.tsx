import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { S } from "../lib/strings";
import type { DocBucket } from "../lib/types";

// The Docs tab is the ONLY place the experimental toggle can be reached, so it is
// registered in `SettingsPage` unconditionally — three separate edits (the `Tab` union,
// `TABS`, and the render chain) that a hand-maintained router makes easy to do
// incompletely. A missing render-chain arm shows the tab, lets it be selected, and
// renders an empty pane: no error anywhere, exactly the failure mode
// `modelsSettingsProviders.test.tsx` exists for on the provider side.

const api = {
  docsBucketsList: vi.fn(() => Promise.resolve([] as DocBucket[])),
  docsBucketCreate: vi.fn(() => Promise.resolve("b-new")),
  docsBucketDelete: vi.fn(() => Promise.resolve()),
  docsBucketRename: vi.fn(() => Promise.resolve()),
  docsBucketReindex: vi.fn(() => Promise.resolve(0)),
  docsFilesList: vi.fn(() => Promise.resolve([])),
  docsFilesNeedingWork: vi.fn(() => Promise.resolve([])),
  docsFileRemove: vi.fn(() => Promise.resolve()),
  docsFileFailed: vi.fn(() => Promise.resolve()),
  docsRefreshStates: vi.fn(() => Promise.resolve(0)),
  docsSearch: vi.fn(() => Promise.resolve([])),
  docsReadSource: vi.fn(),
  docsPutText: vi.fn(),
  knowledgeBucketsList: vi.fn(() => Promise.resolve([])),
  knowledgeEmbeddingModelsList: vi.fn(() => Promise.resolve([])),
  knowledgeQdrantConnectionsList: vi.fn(() => Promise.resolve([])),
  knowledgeJobsList: vi.fn(() => Promise.resolve([])),
  knowledgeBucketEmbed: vi.fn(),
  knowledgeBucketSemanticEnable: vi.fn(),
  knowledgeCliInstall: vi.fn(() => Promise.resolve("/tmp/vterminal-docs")),
  saveSettings: vi.fn(() => Promise.resolve()),
  getSettings: vi.fn(),
  modelsCatalog: vi.fn(() => Promise.resolve([])),
  modelStatus: vi.fn(() => Promise.resolve({ loaded: null, state: "idle", available: true })),
  getModelEffort: vi.fn(() => Promise.resolve({})),
  visionCatalog: vi.fn(() => Promise.resolve([])),
  visionStatus: vi.fn(() => Promise.resolve({ loaded: null, state: "idle", available: false })),
  remoteServersList: vi.fn(() => Promise.resolve([])),
  setModelEffort: vi.fn(() => Promise.resolve()),
  modelUnload: vi.fn(() => Promise.resolve()),
  archiveClear: vi.fn(() => Promise.resolve()),
  visionDescribe: vi.fn(),
};
vi.mock("../lib/tauri", () => api);
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(() => Promise.resolve(null)) }));

const { DocsSettings } = await import("../components/settings/DocsSettings");
const { SettingsPage } = await import("../components/settings/SettingsPage");
const { useAppStore } = await import("../stores/appStore");

function bucket(over: Partial<DocBucket> = {}): DocBucket {
  return {
    id: "b1",
    label: "Runbooks",
    created_at: 0,
    indexed_at: 1,
    embed_model_id: null,
    chunk_chars: 1000,
    chunk_overlap: 150,
    roots: ["/docs"],
    file_count: 3,
    chunk_count: 42,
    pending_count: 0,
    stale_count: 0,
    missing_count: 0,
    failed_count: 0,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  api.docsBucketsList.mockResolvedValue([]);
  api.docsFilesList.mockResolvedValue([]);
  useAppStore.setState({ docsEnabled: false, docBuckets: [], docsIndexing: {}, docsError: null });
});

describe("the Docs tab is reachable", () => {
  /** All three registration points at once: the tab is listed, selecting it renders
   *  the section, and the section is the Docs one rather than an empty pane. */
  it("is listed in Settings and renders its section when selected", async () => {
    render(<SettingsPage />);
    const tab = screen.getByRole("button", { name: S.settings.tabs.docs });
    expect(tab).toBeInTheDocument();

    const { fireEvent } = await import("@testing-library/react");
    fireEvent.click(tab);

    await waitFor(() => {
      expect(screen.getByText(S.settings.docs.enable)).toBeInTheDocument();
    });
  });
});

describe("the experimental toggle", () => {
  /** The toggle lives INSIDE the tab it controls, and the tab is shown regardless. A
   *  tab that only appeared once the feature was on would leave the switch nowhere to
   *  be found. */
  it("is visible while the feature is off, and gates everything else", () => {
    render(<DocsSettings />);
    expect(screen.getByText(S.settings.docs.enable)).toBeInTheDocument();
    expect(screen.getByText(S.settings.docs.disabledNotice)).toBeInTheDocument();
    // No bucket-creation affordance until it is on.
    expect(screen.queryByLabelText(S.settings.docs.addBucket)).not.toBeInTheDocument();
  });

  it("does not query the backend while it is off", () => {
    render(<DocsSettings />);
    expect(api.docsBucketsList).not.toHaveBeenCalled();
  });

  it("reveals bucket management once enabled", async () => {
    useAppStore.setState({ docsEnabled: true });
    render(<DocsSettings />);
    await waitFor(() => {
      expect(screen.getByLabelText(S.settings.docs.addBucket)).toBeInTheDocument();
    });
    expect(screen.queryByText(S.settings.docs.disabledNotice)).not.toBeInTheDocument();
  });

  /** The copy must not oversell the framing. `webAccessHint` carries the same kind of
   *  honesty clause and CLAUDE.md calls it "a test-pinned promise, not filler". */
  it("says the data/instruction marking is best-effort", () => {
    expect(S.settings.docs.intro).toMatch(/best-effort/);
    expect(S.settings.docs.intro).toMatch(/reference material|data rather than instructions/);
    expect(S.settings.docs.enableHint).toMatch(/experimental/i);
    // And it must state that nothing exists on disk while off — the property the lazy
    // open in `docs::db` provides.
    expect(S.settings.docs.enableHint).toMatch(/no index file exists|nothing is indexed/i);
  });
});

describe("bucket rendering", () => {
  it("shows a bucket's file and passage counts", async () => {
    useAppStore.setState({ docsEnabled: true });
    api.docsBucketsList.mockResolvedValue([bucket()]);
    render(<DocsSettings />);
    await waitFor(() => {
      expect(screen.getByText("Runbooks")).toBeInTheDocument();
    });
    // Both counts live in one <p> as separate text nodes, which `getByText` cannot
    // match directly — assert against the card's text instead.
    const card = screen.getByText("Runbooks").closest("section");
    expect(card?.textContent).toMatch(/3 files/);
    expect(card?.textContent).toMatch(/42 passages/);
  });

  /** An un-indexed bucket must say so rather than showing "0 passages", which reads as
   *  a broken index rather than an unstarted one. */
  it("says a bucket has never been indexed instead of showing zero", async () => {
    useAppStore.setState({ docsEnabled: true });
    api.docsBucketsList.mockResolvedValue([
      bucket({ chunk_count: 0, pending_count: 3, indexed_at: null }),
    ]);
    render(<DocsSettings />);
    await waitFor(() => {
      expect(screen.getByText(new RegExp(S.settings.docs.neverIndexed))).toBeInTheDocument();
    });
  });

  it("offers Index now only when there is work to do", async () => {
    useAppStore.setState({ docsEnabled: true });
    api.docsBucketsList.mockResolvedValue([bucket()]);
    const { unmount } = render(<DocsSettings />);
    await waitFor(() => expect(screen.getByText("Runbooks")).toBeInTheDocument());
    expect(screen.queryByText(S.settings.docs.indexNow)).not.toBeInTheDocument();
    unmount();

    api.docsBucketsList.mockResolvedValue([bucket({ pending_count: 2 })]);
    render(<DocsSettings />);
    await waitFor(() => {
      expect(screen.getByText(S.settings.docs.indexNow)).toBeInTheDocument();
    });
  });

  it("shows indexing progress with the current file name", async () => {
    useAppStore.setState({
      docsEnabled: true,
      docsIndexing: { b1: { done: 2, total: 5, current: "runbook.pdf", cancel: false } },
    });
    api.docsBucketsList.mockResolvedValue([bucket({ pending_count: 5 })]);
    render(<DocsSettings />);
    await waitFor(() => {
      expect(screen.getByText(/runbook\.pdf/)).toBeInTheDocument();
    });
    // And the stop affordance replaces the start one while a pass is live.
    expect(screen.getByText(S.settings.docs.cancel)).toBeInTheDocument();
    expect(screen.queryByText(S.settings.docs.indexNow)).not.toBeInTheDocument();
  });
});

describe("the scan summary", () => {
  /** Refused files are REPORTED. A silent skip reads as "everything was indexed", which
   *  is how a user concludes retrieval is broken when it is working exactly as designed.
   */
  it("names every category it refused", () => {
    const text = S.settings.docs.scanSummary({
      added: 12,
      skipped_secret: 2,
      skipped_noise: 40,
      skipped_unsupported: 5,
      skipped_symlink: 1,
      skipped_too_large: 1,
      truncated: 3,
    });
    expect(text).toContain("Added 12");
    expect(text).toMatch(/2 as private keys or credentials/);
    expect(text).toMatch(/1 symlink/);
    expect(text).toMatch(/5 of unsupported types/);
    expect(text).toMatch(/40 hidden or generated/);
    expect(text).toMatch(/1 as too large/);
    expect(text).toMatch(/3 beyond the per-scan limit/);
  });

  it("stays quiet about categories with nothing in them", () => {
    const text = S.settings.docs.scanSummary({
      added: 4,
      skipped_secret: 0,
      skipped_noise: 0,
      skipped_unsupported: 0,
      skipped_symlink: 0,
      skipped_too_large: 0,
      truncated: 0,
    });
    expect(text).toBe("Added 4.");
  });
});

describe("per-file state labels", () => {
  /** Every state the Rust CHECK constraint admits needs a label, or a file renders with
   *  a raw enum string the user cannot interpret. */
  it("covers every state docs.db can store", () => {
    for (const state of ["pending", "indexed", "stale", "missing", "failed"]) {
      expect(S.settings.docs.state[state]).toBeTruthy();
    }
    // The three that would be opaque as raw enum names must read as English.
    expect(S.settings.docs.state.pending).not.toBe("pending");
    expect(S.settings.docs.state.stale).toMatch(/changed/);
    expect(S.settings.docs.state.missing).toMatch(/not found/);
  });
});
