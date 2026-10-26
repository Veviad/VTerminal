import { useLayoutEffect, useRef } from "react";

const BOTTOM_THRESHOLD_PX = 48;

export function isNearOutputBottom(
  viewport: Pick<HTMLElement, "scrollTop" | "scrollHeight" | "clientHeight">,
): boolean {
  return viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= BOTTOM_THRESHOLD_PX;
}

/** Follow growing output until the reader scrolls up. Keep that choice separate
 * from layout: new tokens can move the bottom without any user interaction. */
export function useFollowOutput(
  conversationKey: string | null | undefined,
  revision: unknown,
  enabled = true,
) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(true);
  const lastTopRef = useRef(0);
  const previousKeyRef = useRef(conversationKey);

  const follow = () => {
    const viewport = viewportRef.current;
    if (!enabled || !viewport || !followingRef.current) return;
    // Smooth scrolling keeps moving after a reader tries to scroll upwards.
    // Token updates need an immediate position, with no queued animation.
    viewport.scrollTo({ top: viewport.scrollHeight, behavior: "auto" });
    lastTopRef.current = viewport.scrollTop;
  };

  useLayoutEffect(() => {
    if (previousKeyRef.current !== conversationKey) {
      previousKeyRef.current = conversationKey;
      followingRef.current = true;
      lastTopRef.current = 0;
    }
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!enabled || !viewport || !content) return;

    if (followingRef.current) follow();
    else viewport.scrollTo({ top: lastTopRef.current, behavior: "auto" });

    const onScroll = () => {
      const top = viewport.scrollTop;
      if (top < lastTopRef.current) followingRef.current = false;
      else if (top > lastTopRef.current) followingRef.current = isNearOutputBottom(viewport);
      lastTopRef.current = top;
    };
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY >= 0) return;
      // A nested reasoning box owns its own scrolling. Let it consume the
      // gesture before pausing the surrounding conversation's follow mode.
      let child = event.target instanceof Element ? event.target : null;
      while (child && child !== viewport) {
        if (
          child instanceof HTMLElement &&
          child.scrollTop > 0 &&
          child.scrollHeight > child.clientHeight &&
          /auto|scroll/.test(getComputedStyle(child).overflowY)
        ) return;
        child = child.parentElement;
      }
      followingRef.current = false;
      lastTopRef.current = viewport.scrollTop;
    };
    viewport.addEventListener("scroll", onScroll);
    viewport.addEventListener("wheel", onWheel, { passive: true });
    // Observe the content as well as the viewport: command output, expanded
    // details, images and text reflow can grow without another text delta.
    const observer = new ResizeObserver(follow);
    observer.observe(viewport);
    observer.observe(content);
    return () => {
      viewport.removeEventListener("scroll", onScroll);
      viewport.removeEventListener("wheel", onWheel);
      observer.disconnect();
    };
  }, [conversationKey, enabled]);

  useLayoutEffect(follow, [conversationKey, enabled, revision]);

  return { viewportRef, contentRef };
}
