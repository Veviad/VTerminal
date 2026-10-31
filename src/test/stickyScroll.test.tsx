import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

it("follows height changes, respects a reader above the threshold, and resumes by explicit jump", async () => {
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
  await waitFor(() => expect(scrollTo).toHaveBeenLastCalledWith({ top: 1000, behavior: "auto" }));

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


it("follows layout growth and shrink after Jump before queued WebKit scroll events arrive", () => {
  Element.prototype.scrollTo = vi.fn(function (this: HTMLElement, options?: ScrollToOptions | number, y?: number) {
    const top = typeof options === "number" ? y ?? 0 : options?.top ?? 0;
    this.scrollTop = Math.max(0, Math.min(top, this.scrollHeight - this.clientHeight));
  });
  const view = render(<Fixture />);
  const viewport = screen.getByTestId("viewport");
  Object.defineProperties(viewport, {
    scrollHeight: { configurable: true, value: 1000 },
    clientHeight: { configurable: true, value: 300 },
    scrollTop: { configurable: true, writable: true, value: 700 },
  });
  viewport.scrollTop = 100;
  fireEvent.scroll(viewport);
  fireEvent.click(screen.getByRole("button", { name: "Jump to latest" }));
  expect(viewport.scrollTop).toBe(700);

  // A new user bubble or a reasoning/Markdown layout transition can alter
  // height before a queued native scroll event arrives. Following completes
  // synchronously with that render, so the event sees the current bottom.
  for (const height of [1300, 800, 1600]) {
    Object.defineProperty(viewport, "scrollHeight", { configurable: true, value: height });
    view.rerender(<Fixture text={`Response layout at ${height}`} />);
    fireEvent.scroll(viewport);
    expect(viewport.scrollTop).toBe(height - 300);
    expect(screen.queryByRole("button", { name: "Jump to latest" })).not.toBeInTheDocument();
  }

  viewport.scrollTop = 800;
  fireEvent.scroll(viewport);
  Object.defineProperty(viewport, "scrollHeight", { configurable: true, value: 1900 });
  view.rerender(<Fixture text="More response chunks after the reader scrolls up" />);
  expect(viewport.scrollTop).toBe(800);
  expect(screen.getByRole("button", { name: "Jump to latest" })).toBeVisible();
});
