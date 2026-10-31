import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useStickyScroll } from "../hooks/useStickyScroll";
import { JumpToLatest } from "../components/ai/JumpToLatest";

function Fixture({ identity = "a", text = "First" }: { identity?: string; text?: string }) {
  const sticky = useStickyScroll(identity, text);
  return <><div data-testid="viewport" ref={sticky.scrollRef} onScroll={sticky.onScroll}>
    <div ref={sticky.contentRef}>{text}</div>
  </div>{sticky.showJump && <JumpToLatest onClick={sticky.jumpToLatest} />}</>;
}

afterEach(() => vi.unstubAllGlobals());

it("follows height changes, respects a reader above the threshold, and resumes by explicit jump", () => {
  let resize!: ResizeObserverCallback;
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: ResizeObserverCallback) { resize = callback; }
    observe() {}
    disconnect() {}
  });
  const scrollTo = vi.fn();
  Element.prototype.scrollTo = scrollTo;
  const view = render(<Fixture />);
  const viewport = screen.getByTestId("viewport");
  Object.defineProperties(viewport, {
    scrollHeight: { configurable: true, value: 1000 },
    clientHeight: { configurable: true, value: 300 },
    scrollTop: { configurable: true, writable: true, value: 700 },
  });
  scrollTo.mockClear();
  act(() => resize([], {} as ResizeObserver));
  expect(scrollTo).toHaveBeenLastCalledWith({ top: 1000, behavior: "auto" });

  viewport.scrollTop = 650;
  fireEvent.scroll(viewport);
  scrollTo.mockClear();
  view.rerender(<Fixture text="More text, thinking or a tool result" />);
  act(() => resize([], {} as ResizeObserver));
  expect(scrollTo).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Jump to latest" }));
  expect(scrollTo).toHaveBeenLastCalledWith({ top: 1000, behavior: "auto" });
  expect(screen.queryByRole("button", { name: "Jump to latest" })).not.toBeInTheDocument();

  viewport.scrollTop = 100;
  fireEvent.scroll(viewport);
  scrollTo.mockClear();
  view.rerender(<Fixture identity="another conversation" />);
  expect(scrollTo).toHaveBeenCalled();
});
