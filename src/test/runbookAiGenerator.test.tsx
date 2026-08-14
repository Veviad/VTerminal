import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  generate: vi.fn(),
  create: vi.fn(),
  aiCancel: vi.fn(),
  readBlockOutput: vi.fn<(sessionId: string, block: { id: string }) => string>(),
}));

vi.mock("../lib/runbooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/runbooks")>();
  return { ...actual, runbooksAiGenerate: mocks.generate, runbooksDraftCreate: mocks.create };
});
vi.mock("../lib/tauri", () => ({ aiCancel: mocks.aiCancel }));
vi.mock("../hooks/useAiStream", () => ({ readBlockOutput: mocks.readBlockOutput }));

import { RunbookAiGenerator } from "../components/runbooks/RunbookAiGenerator";
import { resetRunbookTerminalPrivacyForTests } from "../lib/runbookTerminalPrivacy";
import { useAppStore } from "../stores/appStore";
import type { Block, Session } from "../lib/types";

function session(id: string): Session {
  return {
    id,
    shell: "/bin/zsh",
    cwd: "/Users/op",
    createdAt: "2026-08-14T10:00:00Z",
    exited: false,
    exitCode: null,
    hostId: null,
    hostLabel: null,
    userTitle: id,
    aiTitle: null,
  } as Session;
}

function block(id: string, command: string): Block {
  return {
    id,
    sessionId: "s1",
    command,
    state: "done",
    exitCode: 0,
    startLine: 0,
    endLine: 1,
    startedAt: "2026-08-14T10:00:00Z",
    endedAt: "2026-08-14T10:00:01Z",
    origin: "user",
  };
}

const draft = {
  id: "draft-9",
  revision: 1,
  document: { definitionId: "nginx", title: "nginx" },
  publishedSourceId: null,
  lastPublishedVersion: null,
  dirty: true,
  createdAt: "2026-08-14T10:00:00Z",
  updatedAt: "2026-08-14T10:00:00Z",
};

beforeEach(() => {
  resetRunbookTerminalPrivacyForTests();
  Object.values(mocks).forEach((mock) => mock.mockReset());
  mocks.readBlockOutput.mockImplementation((_s, b) => `output-${b.id}`);
  mocks.generate.mockResolvedValue({ definitionId: "nginx" });
  mocks.create.mockResolvedValue(draft);
  useAppStore.setState({
    sendContextToAi: true,
    sessions: [session("s1")],
    activeSessionId: "s1",
    sessionUi: {
      s1: {
        ...(useAppStore.getState().sessionUi.s1 ?? {}),
        blocks: [block("b1", "brew install nginx"), block("b2", "nginx -t")],
      },
    },
  } as never);
});

function openPanel() {
  const onGenerated = vi.fn().mockResolvedValue(undefined);
  render(<RunbookAiGenerator onGenerated={onGenerated} />);
  fireEvent.click(screen.getByRole("button", { name: /generate with ai/i }));
  return { onGenerated };
}

const requirement = (value: string) =>
  fireEvent.change(screen.getByLabelText(/What should this runbook do/i), { target: { value } });
const clickGenerate = () =>
  fireEvent.click(screen.getByRole("button", { name: /generate draft/i }));
const attachContext = () =>
  fireEvent.click(screen.getByRole("checkbox", { name: /terminal session as context/i }));

describe("RunbookAiGenerator", () => {
  it("generates from requirements alone, sending no terminal context", async () => {
    const { onGenerated } = openPanel();
    requirement("verify nginx");
    clickGenerate();

    await waitFor(() => {
      expect(mocks.generate).toHaveBeenCalled();
    });
    expect(mocks.generate.mock.calls[0][2]).toBeNull();
    // The generated document becomes an ordinary draft through the ordinary
    // command — nothing downstream is special-cased for AI.
    expect(mocks.create).toHaveBeenCalledWith({ definitionId: "nginx" });
    expect(onGenerated).toHaveBeenCalledWith(draft);
  });

  it("sends the session transcript when attached", async () => {
    openPanel();
    requirement("repeat this");
    attachContext();
    clickGenerate();

    await waitFor(() => {
      expect(mocks.generate).toHaveBeenCalled();
    });
    const context = mocks.generate.mock.calls[0][2] as string;
    expect(context).toContain("brew install nginx");
    expect(context).toContain("nginx -t");
  });

  it("excludes an unchecked block from the payload", async () => {
    openPanel();
    requirement("repeat this");
    attachContext();

    fireEvent.click(await screen.findByRole("checkbox", { name: /brew install nginx/i }));
    clickGenerate();

    await waitFor(() => {
      expect(mocks.generate).toHaveBeenCalled();
    });
    const context = mocks.generate.mock.calls[0][2] as string;
    expect(context).not.toContain("brew install nginx");
    expect(context).toContain("nginx -t");
  });

  it("sends the operator's edit verbatim, so a redaction cannot be undone", async () => {
    // The payload tracks the checkboxes until it is edited. If ticking a box
    // afterwards regenerated it, a hand-removed secret would silently return.
    openPanel();
    requirement("repeat this");
    attachContext();

    const payload = await screen.findByLabelText(/Exactly this text is sent/i);
    fireEvent.change(payload, { target: { value: "redacted by hand" } });
    clickGenerate();

    await waitFor(() => {
      expect(mocks.generate).toHaveBeenCalled();
    });
    expect(mocks.generate.mock.calls[0][2]).toBe("redacted by hand");
  });

  it("refuses the attachment when the operator switched context off", async () => {
    useAppStore.setState({ sendContextToAi: false } as never);
    openPanel();
    expect(screen.getByRole("checkbox", { name: /terminal session as context/i })).toBeDisabled();
    expect(screen.getByText(/switched off in Settings/i)).toBeInTheDocument();

    requirement("verify nginx");
    clickGenerate();
    await waitFor(() => {
      expect(mocks.generate).toHaveBeenCalled();
    });
    expect(mocks.generate.mock.calls[0][2]).toBeNull();
  });

  it("cancels an in-flight generation with the same request id", async () => {
    let release: (value: unknown) => void = () => {};
    mocks.generate.mockReturnValue(new Promise((resolve) => (release = resolve)));
    openPanel();
    requirement("verify nginx");
    clickGenerate();

    fireEvent.click(await screen.findByRole("button", { name: /^stop$/i }));
    expect(mocks.aiCancel).toHaveBeenCalledWith(mocks.generate.mock.calls[0][0]);
    release({ definitionId: "nginx" });
  });

  it("keeps the request open and reports a failure", async () => {
    mocks.generate.mockRejectedValue("no model loaded");
    const { onGenerated } = openPanel();
    requirement("verify nginx");
    clickGenerate();

    expect(await screen.findByText(/no model loaded/)).toBeInTheDocument();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(onGenerated).not.toHaveBeenCalled();
  });

  it("requires a requirement before it will generate", async () => {
    openPanel();
    expect(screen.getByRole("button", { name: /generate draft/i })).toBeDisabled();
  });
});
