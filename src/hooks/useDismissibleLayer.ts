import { useEffect, type RefObject } from "react";

/** Dismiss an open layer when Escape is pressed or a pointer lands outside it. */
export function useDismissibleLayer(
  layerRef: RefObject<HTMLElement | null>,
  onDismiss: () => void,
) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onDismiss();
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || !layerRef.current?.contains(target)) onDismiss();
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, [layerRef, onDismiss]);
}
