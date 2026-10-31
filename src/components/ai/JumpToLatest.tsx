import { ArrowDown } from "lucide-react";

export function JumpToLatest({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick}
      className="mx-auto my-1 flex shrink-0 items-center gap-1 rounded-full border border-border-subtle bg-bg-card px-3 py-1 text-[11px] text-text-secondary shadow-sm hover:bg-bg-hover">
      <ArrowDown size={12} /> Jump to latest
    </button>
  );
}
