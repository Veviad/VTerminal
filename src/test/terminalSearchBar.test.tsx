import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findNext: vi.fn(),
  findPrevious: vi.fn(),
  clearDecorations: vi.fn(),
  getSelectionPosition: vi.fn(),
  clearSelection: vi.fn(),
  focus: vi.fn(),
}));

vi.mock("../lib/termRegistry", () => ({
  getTerm: () => ({ search: mocks, term: { focus: mocks.focus, getSelectionPosition: mocks.getSelectionPosition, clearSelection: mocks.clearSelection } }),
}));
vi.mock("../lib/xtermTheme", () => ({ cssVar: (_name: string, fallback: string) => fallback }));

import { TerminalSearchBar } from "../components/terminal/TerminalSearchBar";
import { useAppStore } from "../stores/appStore";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findNext.mockReturnValue(true);
  mocks.findPrevious.mockReturnValue(true);
  mocks.getSelectionPosition.mockReturnValue({ start: { x: 0, y: 2 }, end: { x: 7, y: 2 } });
  useAppStore.setState({
    sessions: [{ id: "local" } as never],
    sessionUi: { local: { searchOpen: true } as never },
  });
});

describe("terminal search", () => {
  it("removes stale highlights when the search text is cleared", () => {
    render(<TerminalSearchBar sessionId="local" />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "failure" } });
    expect(mocks.findNext).toHaveBeenCalledWith("failure", expect.objectContaining({ incremental: true }));
    fireEvent.change(input, { target: { value: "" } });
    expect(mocks.clearDecorations).toHaveBeenCalledOnce();
    expect(mocks.clearSelection).toHaveBeenCalledOnce();
  });

  it("keeps a different selection made after the search", () => {
    render(<TerminalSearchBar sessionId="local" />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "failure" } });
    mocks.getSelectionPosition.mockReturnValue({ start: { x: 3, y: 4 }, end: { x: 8, y: 4 } });
    fireEvent.change(input, { target: { value: "" } });
    expect(mocks.clearDecorations).toHaveBeenCalledOnce();
    expect(mocks.clearSelection).not.toHaveBeenCalled();
  });

  it("does not clear a pre-existing selection when search was never used", () => {
    render(<TerminalSearchBar sessionId="local" />);
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
    expect(mocks.clearSelection).not.toHaveBeenCalled();
  });

  it("searches in either direction and returns focus to the terminal on escape", () => {
    render(<TerminalSearchBar sessionId="local" />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "status" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(mocks.findPrevious).toHaveBeenCalledWith("status", expect.any(Object));
    fireEvent.keyDown(input, { key: "Enter" });
    expect(mocks.findNext).toHaveBeenLastCalledWith("status", expect.not.objectContaining({ incremental: true }));
    fireEvent.keyDown(input, { key: "Escape" });
    expect(mocks.focus).toHaveBeenCalledOnce();
    expect(mocks.clearSelection).toHaveBeenCalledOnce();
    expect(screen.queryByRole("textbox")).toBeNull();
  });
});
