import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TabStrip } from "../components/layout/TabStrip";
import { S } from "../lib/strings";
import { useAppStore } from "../stores/appStore";
import { makeSession } from "./factories";

const { renameMock } = vi.hoisted(() => ({ renameMock: vi.fn() }));

vi.mock("../lib/sessionNaming", () => ({
  isNaming: () => false,
  renameSessionWithAi: (sessionId: string) => renameMock(sessionId),
}));

vi.mock("../hooks/useSessions", () => ({
  useSessions: () => ({
    createSession: vi.fn(),
    closeSession: vi.fn(),
  }),
}));

beforeEach(() => {
  renameMock.mockReset();
  useAppStore.setState({
    sessions: [],
    activeSessionId: null,
    sessionUi: {},
    aiStreams: {},
    sidecars: {},
    renamingSessionId: null,
  });
  useAppStore.getState().addSession(makeSession({ id: "tab-1", cwd: "/Users/tester" }));
});

describe("Rename with AI tab menu", () => {
  it("keeps the menu open and renders an actionable failure", async () => {
    renameMock.mockRejectedValue(new Error("The selected AI model is not ready."));
    render(<TabStrip />);

    fireEvent.contextMenu(screen.getByText("~").closest("button")!);
    fireEvent.click(screen.getByRole("button", { name: S.tabs.renameWithAi }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The selected AI model is not ready.",
    );
    expect(screen.getByRole("button", { name: S.tabs.renameWithAi })).toBeInTheDocument();
    expect(renameMock).toHaveBeenCalledWith("tab-1");
  });
});
