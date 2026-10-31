import { useCallback, useLayoutEffect, useRef, useState } from "react";

export const CHAT_BOTTOM_THRESHOLD_PX = 48;

export function isNearChatBottom(
  viewport: Pick<HTMLElement, "scrollTop" | "scrollHeight" | "clientHeight">,
): boolean {
  return viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= CHAT_BOTTOM_THRESHOLD_PX;
}

/** Follow new content until the reader scrolls away. Observe layout as well as
 * text: images, expanded tools and a resized panel can all change its height. */
export function useStickyScroll(identity: unknown, revision: unknown) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const jumpToLatest = useCallback(() => {
    following.current = true;
    setShowJump(false);
    const viewport = scrollRef.current;
    viewport?.scrollTo({ top: viewport.scrollHeight, behavior: "auto" });
  }, []);
  const onScroll = useCallback(() => {
    const viewport = scrollRef.current;
    if (!viewport) return;
    following.current = isNearChatBottom(viewport);
    setShowJump(!following.current);
  }, []);
  useLayoutEffect(jumpToLatest, [identity, jumpToLatest]);
  useLayoutEffect(() => {
    if (following.current) jumpToLatest();
  }, [revision, jumpToLatest]);
  useLayoutEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (following.current) jumpToLatest();
    });
    if (scrollRef.current) observer.observe(scrollRef.current);
    if (contentRef.current) observer.observe(contentRef.current);
    return () => {
      observer.disconnect();
    };
  }, [identity, jumpToLatest]);
  return { scrollRef, contentRef, onScroll, showJump, jumpToLatest };
}
