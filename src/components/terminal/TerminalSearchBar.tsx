import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { useAppStore } from "../../stores/appStore";
import { getTerm } from "../../lib/termRegistry";
import { cssVar } from "../../lib/xtermTheme";
import { S } from "../../lib/strings";

export function TerminalSearchBar({ sessionId }: { sessionId: string }) {
  const open = useAppStore((s) => s.sessionUi[sessionId]?.searchOpen ?? false);
  const updateSessionUi = useAppStore((s) => s.updateSessionUi);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) inputRef.current?.focus();
    else getTerm(sessionId)?.search.clearDecorations();
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
    if (query) getTerm(sessionId)?.search.findNext(query, searchOpts);
  };
  const findPrev = () => {
    if (query) getTerm(sessionId)?.search.findPrevious(query, searchOpts);
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
          if (e.target.value) getTerm(sessionId)?.search.findNext(e.target.value, { ...searchOpts, incremental: true });
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
