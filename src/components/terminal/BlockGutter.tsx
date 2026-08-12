import { useSyncExternalStore, useState, useCallback } from "react";
import { useAppStore } from "../../stores/appStore";
import { getTerm } from "../../lib/termRegistry";
import { BlockActions } from "./BlockActions";
import type { Block } from "../../lib/types";
import { S } from "../../lib/strings";

interface VisibleBlock {
  block: Block;
  top: number;
  height: number;
}

// Absolutely-positioned overlay rail on the terminal's left edge. Positioning
// derives from xterm markers vs the viewport scroll offset; re-renders are
// driven by the registry's scroll/resize/render events via useSyncExternalStore.
export function BlockGutter({ sessionId }: { sessionId: string }) {
  const blocks = useAppStore((s) => s.sessionUi[sessionId]?.blocks);
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  const subscribe = useCallback(
    (cb: () => void) => {
      const entry = getTerm(sessionId);
      if (!entry) return () => {};
      entry.scrollListeners.add(cb);
      return () => entry.scrollListeners.delete(cb);
    },
    [sessionId],
  );

  // Snapshot = viewportY (scroll position); any change re-renders the overlay.
  const viewportY = useSyncExternalStore(
    subscribe,
    () => getTerm(sessionId)?.term.buffer.active.viewportY ?? 0,
  );

  const entry = getTerm(sessionId);
  if (!entry || entry.disposed || !blocks?.length) return null;

  const term = entry.term;
  const screen = entry.container.querySelector(".xterm-screen");
  const cellHeight = screen ? screen.clientHeight / term.rows : 0;
  if (!cellHeight) return null;
  // .terminal-host has 8px top padding
  const padTop = 8;

  const visible: VisibleBlock[] = [];
  for (const block of blocks) {
    if (block.state === "trimmed") continue;
    // Live marker lines — static snapshots drift when scrollback trims/reflows.
    const markers = entry.blockMarkers.get(block.id);
    const startLine =
      markers && !markers.start.isDisposed ? markers.start.line : block.startLine;
    const rawEndLine =
      markers?.end && !markers.end.isDisposed ? markers.end.line : block.endLine;
    const startRow = startLine - viewportY;
    // The end marker sits on the NEXT prompt's row — exclusive.
    const endLine = rawEndLine !== null ? rawEndLine - 1 : viewportY + term.rows - 1;
    const endRow = Math.min(endLine - viewportY, term.rows - 1);
    if (endRow < 0 || startRow > term.rows - 1 || endRow < startRow) continue;
    const top = Math.max(startRow, 0) * cellHeight + padTop;
    const height = (Math.min(endRow, term.rows - 1) - Math.max(startRow, 0) + 1) * cellHeight;
    if (height <= 0) continue;
    visible.push({ block, top, height });
  }

  if (!visible.length) return null;

  return (
    <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-full">
      {visible.map(({ block, top, height }) => {
        const failed = block.state === "done" && (block.exitCode ?? 0) !== 0;
        const hovered = hoveredId === block.id;
        return (
          <div key={block.id} className="absolute inset-x-0" style={{ top, height }}>
            {/* Left rule spanning the block's rows. Agent-typed commands are
                real commands in this shell — the accent rule just makes them
                attributable after the fact. */}
            <div
              className={`pointer-events-auto absolute left-0 top-0 h-full w-[3px] rounded-full transition-colors duration-150 ${
                failed
                  ? "bg-error/60"
                  : hovered
                    ? "bg-accent/60"
                    : block.origin === "agent"
                      ? "bg-accent/30"
                      : "bg-border-subtle"
              }`}
              onMouseEnter={() => setHoveredId(block.id)}
              onMouseLeave={() => setHoveredId(null)}
            />
            {block.origin === "agent" && (
              <span
                className="pointer-events-none absolute left-2 top-0 rounded bg-accent/10 px-1 py-0.5 font-mono text-[9px] text-accent"
                title={S.blocks.agentRun}
              >
                {S.blocks.agentBadge}
              </span>
            )}
            {/* Exit badge for failures */}
            {failed && (
              <span
                className="pointer-events-auto absolute right-2 top-0 rounded bg-error-subtle px-1.5 py-0.5 font-mono text-[10px] text-error"
                onMouseEnter={() => setHoveredId(block.id)}
                onMouseLeave={() => setHoveredId(null)}
              >
                {S.blocks.exit} {block.exitCode}
              </span>
            )}
            {/* Hover toolbar */}
            {hovered && (
              <div
                className="pointer-events-auto absolute right-2 z-20"
                style={{ top: failed ? 22 : 0 }}
                onMouseEnter={() => setHoveredId(block.id)}
                onMouseLeave={() => setHoveredId(null)}
              >
                <BlockActions sessionId={sessionId} block={block} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
