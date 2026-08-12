import { useEffect, useLayoutEffect } from "react";

/** Size a textarea to its content, capped.
 *
 *  Pure and DOM-only so it can be unit-tested: jsdom has no layout engine, so a
 *  test has to `defineProperty` `scrollHeight` on a stub element — impossible if
 *  the measurement lived inside the hook.
 *
 *  Returns the height actually applied, in px.
 */
export function fitTextarea(el: HTMLTextAreaElement, maxPx: number): number {
  // Collapsing to 0 first is what makes SHRINKING work: `scrollHeight` never
  // reports less than the element's own height, so measuring at the current
  // height means a box that has grown can never come back down.
  //
  // `overflowY: hidden` while measuring because a visible scrollbar narrows the
  // content box and changes where lines wrap — measure without one, then decide.
  el.style.overflowY = "hidden";
  el.style.height = "0px";
  const needed = el.scrollHeight;
  const height = Math.min(needed, maxPx);
  el.style.height = `${height}px`;
  el.style.overflowY = needed > maxPx ? "auto" : "hidden";
  return height;
}

/** Keep a textarea sized to its content.
 *
 *  `deps` must include the controlled value — that is what covers the
 *  `setInput("")` after a send, without which the box stays tall over an empty
 *  prompt. Include anything else that changes where lines wrap (panel width);
 *  rewrapping changes the line count without changing a character.
 */
export function useAutoGrow(
  ref: React.RefObject<HTMLTextAreaElement | null>,
  maxPx: number,
  deps: readonly unknown[] = [],
): void {
  // Layout effect, not effect: sizing after paint shows one frame at the wrong
  // height on every keystroke that adds a line.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el) fitTextarea(el, maxPx);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, maxPx, ...deps]);

  // Same reason the terminal re-fits here: until the bundled font has loaded,
  // line metrics come from the fallback and every measurement above is wrong.
  useEffect(() => {
    let cancelled = false;
    void document.fonts?.ready.then(() => {
      const el = ref.current;
      if (!cancelled && el) fitTextarea(el, maxPx);
    });
    return () => {
      cancelled = true;
    };
  }, [ref, maxPx]);
}
