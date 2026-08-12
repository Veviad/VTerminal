import { Paperclip, X } from "lucide-react";
import type { Block } from "../../lib/types";

export function BlockContextChip({ block, onRemove }: { block: Block; onRemove: () => void }) {
  return (
    <span className="flex max-w-full items-center gap-1.5 rounded-full border border-border-subtle bg-bg-hover px-2 py-0.5 text-[10px] text-text-secondary">
      <Paperclip size={10} className="shrink-0 text-accent" />
      <code className="truncate font-mono">{block.command || "(command)"}</code>
      {block.exitCode !== null && block.exitCode !== 0 && (
        <span className="shrink-0 font-mono text-error">exit {block.exitCode}</span>
      )}
      <button
        onClick={onRemove}
        className="shrink-0 rounded-full p-0.5 transition-colors duration-100 hover:bg-bg-elevated hover:text-text-primary"
      >
        <X size={9} />
      </button>
    </span>
  );
}
