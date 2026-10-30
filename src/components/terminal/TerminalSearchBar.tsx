import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { useAppStore } from "../../stores/appStore";
import { getTerm } from "../../lib/termRegistry";
import { cssVar } from "../../lib/xtermTheme";
import { S } from "../../lib/strings";
import type { IBufferRange } from "@xterm/xterm";

export function TerminalSearchBar({ sessionId }: { sessionId: string }) {
  const open = useAppStore((s) => s.sessionUi[sessionId]?.searchOpen ?? false);
  const updateSessionUi = useAppStore((s) => s.updateSessionUi);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const searchSelection = useRef<{ sessionId: string; range: IBufferRange } | null>(null);

  const clearSearch = () => {
    const entry = getTerm(sessionId);
    if (!entry) return;
    entry.search.clearDecorations();
    const range = entry.term.getSelectionPosition();
    const owned = searchSelection.current;
    // clearDecorations removes highlights but xterm's search addon keeps its
    // active match selected. Do not erase a selection the user made afterward.
    if (owned?.sessionId === sessionId && range &&
        range.start.x === owned.range.start.x && range.start.y === owned.range.start.y &&
        range.end.x === owned.range.end.x && range.end.y === owned.range.end.y) {
      entry.term.clearSelection();
    }
    searchSelection.current = null;
  };

  const recordSelection = (found: boolean, entry: NonNullable<ReturnType<typeof getTerm>>) => {
    const range = found ? entry.term.getSelectionPosition() : undefined;
    searchSelection.current = range ? { sessionId, range } : null;
  };

  useEffect(() => {
    if (open) inputRef.current?.focus();
    else clearSearch();
  }, [open, sessionId]);

  if (!open) return null;

  // Resolved per render, not hoisted: the ruler is a literal color, so a
  // hoisted constant would keep the emerald of whichever theme was active when
  // this module first evaluated.
  const accent = cssVar("--color-accent", "#10b981");
  const searchOpts = {
    decorations: {
      matchOverviewRuler: accent,
      activeMatchColorOverviewRuler: accent,
    },
  };

  const findNext = () => {
    const entry = getTerm(sessionId);
    if (query && entry) recordSelection(entry.search.findNext(query, searchOpts), entry);
  };
  const findPrev = () => {
    const entry = getTerm(sessionId);
    if (query && entry) recordSelection(entry.search.findPrevious(query, searchOpts), entry);
  };
  const close = () => {
    updateSessionUi(sessionId, { searchOpen: false });
    getTerm(sessionId)?.term.focus();
  };

  return (
    <div className="absolute right-3 top-2 z-20 flex items-center gap-1 rounded-lg border border-border-subtle bg-bg-card p-1 shadow-lg">
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          const entry = getTerm(sessionId);
          if (e.target.value && entry) recordSelection(entry.search.findNext(e.target.value, { ...searchOpts, incremental: true }), entry);
          else if (!e.target.value) clearSearch();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && e.shiftKey) findPrev();
          else if (e.key === "Enter") findNext();
          else if (e.key === "Escape") {
            e.stopPropagation(); // keep the window handler from closing the composer too
            close();
          }
        }}
        placeholder={S.terminal.searchPlaceholder}
        className="w-48 bg-transparent px-2 py-1 text-[12px] text-text-primary placeholder:text-text-muted focus:outline-none"
      />
      <button
        onClick={findPrev}
        className="rounded-md p-1 text-text-muted transition-colors duration-100 hover:bg-bg-hover hover:text-text-secondary"
      >
        <ChevronUp size={13} />
      </button>
      <button
        onClick={findNext}
        className="rounded-md p-1 text-text-muted transition-colors duration-100 hover:bg-bg-hover hover:text-text-secondary"
      >
        <ChevronDown size={13} />
      </button>
      <button
        onClick={close}
        className="rounded-md p-1 text-text-muted transition-colors duration-100 hover:bg-bg-hover hover:text-text-secondary"
      >
        <X size={13} />
      </button>
    </div>
  );
}
