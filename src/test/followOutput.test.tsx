import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useFollowOutput } from "../hooks/useFollowOutput";

function Timeline({ conversation = "one", output = "First token" }) {
  const { viewportRef, contentRef } = useFollowOutput(conversation, output);
  return (
    <div ref={viewportRef} data-testid="viewport">
      <div ref={contentRef}>{output}</div>
    </div>
  );
}

describe("following live output", () => {
  let resize: ResizeObserverCallback;
  let viewport: HTMLElement;
  let scrollTo: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: ResizeObserverCallback) { resize = callback; }
      observe() {}
      disconnect() {}
    });
    scrollTo = vi.fn(function (this: HTMLElement, options: ScrollToOptions) {
      this.scrollTop = Math.min(options.top ?? 0, Math.max(0, this.scrollHeight - this.clientHeight));
    });
    Element.prototype.scrollTo = scrollTo as typeof Element.prototype.scrollTo;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const setGeometry = () => {
    viewport = screen.getByTestId("viewport");
    Object.defineProperties(viewport, {
      scrollHeight: { configurable: true, writable: true, value: 1_000 },
      clientHeight: { configurable: true, writable: true, value: 300 },
      scrollTop: { configurable: true, writable: true, value: 700 },
    });
    act(() => resize([], {} as ResizeObserver));
    scrollTo.mockClear();
  };

  it("keeps following when output grows and resizing moves the bottom", () => {
    const view = render(<Timeline />);
    setGeometry();
    Object.defineProperty(viewport, "scrollHeight", { value: 1_200 });
    view.rerender(<Timeline output="First token and another paragraph" />);
    expect(viewport.scrollTop).toBe(900);

    Object.defineProperty(viewport, "clientHeight", { value: 250 });
    act(() => resize([], {} as ResizeObserver));
    expect(viewport.scrollTop).toBe(950);
  });

  it("pauses on an upward gesture before the next output arrives, even near the bottom", () => {
    const view = render(<Timeline />);
    setGeometry();
    fireEvent.wheel(viewport, { deltaY: -8 });
    view.rerender(<Timeline output="A token arriving before the scroll event" />);
    expect(scrollTo).not.toHaveBeenCalled();

    viewport.scrollTop = 692;
    fireEvent.scroll(viewport);
    view.rerender(<Timeline output="More tokens while the reader scrolls" />);
    act(() => resize([], {} as ResizeObserver));
    expect(scrollTo).not.toHaveBeenCalled();

    viewport.scrollTop = 700;
    fireEvent.scroll(viewport);
    view.rerender(<Timeline output="The reader is following again" />);
    expect(scrollTo).toHaveBeenCalledWith({ top: 1_000, behavior: "auto" });
  });

  it("preserves a reader's position through content layout changes and resets for another chat", () => {
    const view = render(<Timeline />);
    setGeometry();
    viewport.scrollTop = 100;
    fireEvent.scroll(viewport);
    Object.defineProperty(viewport, "scrollHeight", { value: 1_500 });
    act(() => resize([], {} as ResizeObserver));
    expect(scrollTo).not.toHaveBeenCalled();
    expect(viewport.scrollTop).toBe(100);

    view.rerender(<Timeline conversation="two" />);
    expect(viewport.scrollTop).toBe(1_200);
  });
});
