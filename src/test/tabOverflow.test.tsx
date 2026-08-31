import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TabStrip } from "../components/layout/TabStrip";
import { S } from "../lib/strings";
import { useAppStore } from "../stores/appStore";
import { makeSession } from "./factories";

const { createSessionMock, closeSessionMock, scrollIntoViewMock } = vi.hoisted(() => ({
  createSessionMock: vi.fn(),
  closeSessionMock: vi.fn(),
  scrollIntoViewMock: vi.fn(),
}));

vi.mock("../lib/sessionNaming", () => ({
  isNaming: () => false,
  renameSessionWithAi: vi.fn(),
}));

vi.mock("../hooks/useSessions", () => ({
  useSessions: () => ({
    createSession: createSessionMock,
    closeSession: closeSessionMock,
  }),
}));

const originalScrollIntoView = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "scrollIntoView",
);

function setViewportLayout(
  viewport: HTMLDivElement,
  { clientWidth, scrollWidth }: { clientWidth: number; scrollWidth: number },
) {
  Object.defineProperties(viewport, {
    clientWidth: { configurable: true, value: clientWidth },
    scrollWidth: { configurable: true, value: scrollWidth },
    scrollLeft: { configurable: true, value: 0, writable: true },
  });
  fireEvent.scroll(viewport);
}

function renderOverflowingTabs() {
  const view = render(<TabStrip />);
  const viewport = view.container.querySelector<HTMLDivElement>(".tab-strip-scroll");
  expect(viewport).not.toBeNull();
  setViewportLayout(viewport!, { clientWidth: 160, scrollWidth: 480 });
  return { ...view, viewport: viewport! };
}

describe("many-terminal tab overflow", () => {
  beforeEach(() => {
    createSessionMock.mockReset();
    createSessionMock.mockResolvedValue("new-tab");
    closeSessionMock.mockReset();
    scrollIntoViewMock.mockReset();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoViewMock,
    });

    useAppStore.setState({
      sessions: [],
      activeSessionId: null,
      sessionUi: {},
      aiStreams: {},
      sidecars: {},
      renamingSessionId: null,
    });
    useAppStore.getState().addSession(
      makeSession({ id: "alpha", userTitle: "Alpha", ordinal: 1 }),
    );
    useAppStore.getState().addSession(
      makeSession({ id: "bravo", userTitle: "Bravo", ordinal: 2 }),
    );
    useAppStore.getState().addSession(
      makeSession({ id: "charlie", userTitle: "Charlie", ordinal: 3 }),
    );
    useAppStore.getState().setActiveSession("bravo");
  });

  afterEach(() => {
    if (originalScrollIntoView) {
      Object.defineProperty(
        HTMLElement.prototype,
        "scrollIntoView",
        originalScrollIntoView,
      );
    } else {
      delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });

  it("lists every open terminal in stable order and switches to the selected one", () => {
    renderOverflowingTabs();

    const trigger = screen.getByRole("button", {
      name: S.tabs.allOpenHint(3),
    });
    scrollIntoViewMock.mockClear();
    fireEvent.click(trigger);

    const options = screen.getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual([
      expect.stringContaining("Alpha"),
      expect.stringContaining("Bravo"),
      expect.stringContaining("Charlie"),
    ]);
    expect(screen.getByRole("option", { name: /Bravo/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(scrollIntoViewMock).toHaveBeenCalledWith({ block: "nearest" });

    scrollIntoViewMock.mockClear();
    fireEvent.click(screen.getByRole("option", { name: /Charlie/ }));

    expect(useAppStore.getState().activeSessionId).toBe("charlie");
    expect(screen.queryByRole("listbox", { name: S.tabs.allOpen })).not.toBeInTheDocument();
    expect(scrollIntoViewMock).toHaveBeenCalledWith({
      behavior: "auto",
      block: "nearest",
      inline: "nearest",
    });
  });

  it("responds to available width and keeps the new-tab button outside the viewport", () => {
    const { viewport } = renderOverflowingTabs();

    expect(
      screen.getByRole("button", { name: S.tabs.allOpenHint(3) }),
    ).toBeVisible();
    const newTab = screen.getByTitle(S.header.newTab);
    expect(viewport.contains(newTab)).toBe(false);

    setViewportLayout(viewport, { clientWidth: 520, scrollWidth: 480 });

    expect(
      screen.queryByRole("button", { name: S.tabs.allOpenHint(3) }),
    ).not.toBeInTheDocument();
  });

  it("converts vertical wheel movement into horizontal tab scrolling", () => {
    const { viewport } = renderOverflowingTabs();

    fireEvent.wheel(viewport, { deltaX: 0, deltaY: 36 });

    expect(viewport.scrollLeft).toBe(36);
  });

  it("reveals sessions activated outside the tab strip", () => {
    renderOverflowingTabs();
    scrollIntoViewMock.mockClear();

    act(() => useAppStore.getState().setActiveSession("alpha"));

    expect(scrollIntoViewMock).toHaveBeenCalledWith({
      behavior: "auto",
      block: "nearest",
      inline: "nearest",
    });
  });

  it("dismisses the terminal list with Escape and an outside pointer press", () => {
    renderOverflowingTabs();
    const trigger = screen.getByRole("button", {
      name: S.tabs.allOpenHint(3),
    });

    fireEvent.click(trigger);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("listbox", { name: S.tabs.allOpen })).not.toBeInTheDocument();

    fireEvent.click(trigger);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("listbox", { name: S.tabs.allOpen })).not.toBeInTheDocument();
  });
});
