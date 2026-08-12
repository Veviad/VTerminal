import { describe, expect, it } from "vitest";
import { fitTextarea } from "../hooks/useAutoGrow";

/** jsdom has no layout engine, so `scrollHeight` is always 0. Stub it as a
 *  function of the content height the test wants to simulate — which is exactly
 *  why `fitTextarea` is a pure DOM function and not buried in the hook.
 *
 *  The stub also reproduces the property that makes the collapse-to-0 step
 *  necessary: a real `scrollHeight` never reports less than the element's own
 *  height, so it only tells the truth while the height is 0.
 */
function stub(contentPx: number): {
  el: HTMLTextAreaElement;
  setContent: (px: number) => void;
} {
  const el = document.createElement("textarea");
  let content = contentPx;
  Object.defineProperty(el, "scrollHeight", {
    get() {
      return Math.max(content, parseInt(el.style.height || "0", 10));
    },
  });
  return { el, setContent: (px) => (content = px) };
}

describe("fitTextarea", () => {
  it("sizes to content below the cap and keeps overflow hidden", () => {
    const { el } = stub(60);
    expect(fitTextarea(el, 320)).toBe(60);
    expect(el.style.height).toBe("60px");
    expect(el.style.overflowY).toBe("hidden");
  });

  it("caps at maxPx and turns on scrolling", () => {
    const { el } = stub(900);
    expect(fitTextarea(el, 320)).toBe(320);
    expect(el.style.height).toBe("320px");
    expect(el.style.overflowY).toBe("auto");
  });

  it("does not scroll at exactly the cap", () => {
    const { el } = stub(320);
    fitTextarea(el, 320);
    expect(el.style.overflowY).toBe("hidden");
  });

  /** The regression that motivated collapsing to 0 before measuring. Without it
   *  a box that has grown can never come back down, so the prompt stays tall
   *  over an empty composer after a send. */
  it("shrinks back after the content is deleted", () => {
    const { el, setContent } = stub(240);
    fitTextarea(el, 320);
    expect(el.style.height).toBe("240px");

    setContent(24); // one line, as after `setInput("")`
    expect(fitTextarea(el, 320)).toBe(24);
    expect(el.style.height).toBe("24px");
  });

  it("recovers from a capped, scrolling state back to a short one", () => {
    const { el, setContent } = stub(900);
    fitTextarea(el, 320);
    expect(el.style.overflowY).toBe("auto");

    setContent(48);
    fitTextarea(el, 320);
    expect(el.style.height).toBe("48px");
    expect(el.style.overflowY).toBe("hidden");
  });
});
