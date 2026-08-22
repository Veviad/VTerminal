import { useEffect, useRef } from "react";
import { acquireWebgl, getTerm, releaseWebgl } from "../../lib/termRegistry";
import { ptyResize } from "../../lib/tauri";
import { isPanelResizing } from "../../lib/aiPanel";
import { useAppStore } from "../../stores/appStore";

// Attach/detach shim only. The Terminal itself is created in useSessions via
// termRegistry (never in React state), which makes StrictMode's
// mount→cleanup→mount cycle harmless: we move the container div, never re-open.
export function TerminalView({
  sessionId,
  active,
  rendererActive = active,
}: {
  sessionId: string;
  /** Receives keyboard focus and reports the active terminal dimensions. */
  active: boolean;
  /** Keeps the GPU renderer attached independently from keyboard focus. */
  rendererActive?: boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    const entry = getTerm(sessionId);
    if (!host || !entry || entry.disposed) return;

    host.appendChild(entry.container);
    const safeFit = () => {
      if (entry.disposed || !host.offsetParent) return; // hidden → 0×0 → NaN cols
      try {
        entry.fit.fit();
      } catch {
        // fit() can throw on zero-size hosts during layout transitions
      }
    };
    safeFit();
    void document.fonts.ready.then(() => {
      if (!entry.disposed) {
        // Re-measure after the bundled mono font loads — cell metrics from the
        // fallback font would misalign the grid.
        entry.term.refresh(0, entry.term.rows - 1);
        safeFit();
      }
    });

    let t: ReturnType<typeof setTimeout> | null = null;
    const ro = new ResizeObserver(() => {
      if (t) clearTimeout(t);
      // This is the only place that resizes the PTY, so the debounce doubles as
      // the rate limit on SIGWINCH. Dragging the AI panel's splitter changes our
      // width every frame; 16ms there would mean ~60 resizes a second at the
      // shell, so a live drag gets a slacker one.
      t = setTimeout(
        () => {
          if (entry.disposed || !host.offsetParent) return;
          safeFit();
          void ptyResize(sessionId, entry.term.cols, entry.term.rows);
        },
        isPanelResizing() ? 120 : 16,
      );
    });
    ro.observe(host);

    return () => {
      ro.disconnect();
      if (t) clearTimeout(t);
      if (entry.container.parentElement === host) entry.container.remove();
    };
  }, [sessionId]);

  // Renderer ownership is deliberately separate from keyboard focus. A normal
  // workspace still gives WebGL only to the active tab. Sidecar has two visible
  // panes, so both keep WebGL for the lifetime of the linked view; otherwise
  // every focus switch changes one pane to DOM rendering and the same font
  // visibly changes weight/metrics between the two terminals.
  useEffect(() => {
    const entry = getTerm(sessionId);
    if (!entry || entry.disposed) return;
    if (rendererActive) acquireWebgl(entry);
    else releaseWebgl(entry);

    return () => {
      if (rendererActive) releaseWebgl(entry);
    };
  }, [rendererActive, sessionId]);

  useEffect(() => {
    const entry = getTerm(sessionId);
    if (!entry || entry.disposed || !active) return;
    // The renderer effect is declared first, so this reports the renderer that
    // was selected for the focused pane in the same commit.
    useAppStore.getState().setActiveRenderer(entry.webgl ? "webgl" : "dom");
    useAppStore.getState().setTermDims(entry.term.cols, entry.term.rows);
    try {
      entry.fit.fit();
    } catch {
      // host may still be hidden mid-switch
    }
    entry.term.focus();
  }, [active, rendererActive, sessionId]);

  return <div ref={hostRef} className="absolute inset-0" />;
}
