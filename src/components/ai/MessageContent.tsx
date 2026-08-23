import { useState } from "react";
import {
  BookOpen,
  ChevronDown,
  ChevronRight,
  FileText,
  Image as ImageIcon,
  ScanText,
} from "lucide-react";

import { thumbnailSrc } from "../../lib/attachments";
import { S } from "../../lib/strings";
import type { FoldedBlock } from "../../lib/attachInput";
import type { Attachment } from "../../lib/types";

/** Terminal-independent rendering for file, OCR, and Knowledge text folded
 * into a model prompt. Both the terminal AI panel and Chat use this component. */
export function FoldedBlockSection({ block }: { block: FoldedBlock }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-1.5 rounded-lg border border-border-subtle bg-bg-primary/50">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-[10px] font-medium uppercase tracking-widest text-text-muted"
      >
        <span className="shrink-0">
          {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        </span>
        <span className="shrink-0">
          {block.kind === "transcript" ? (
            <ScanText size={11} />
          ) : block.kind === "docs" ? (
            <BookOpen size={11} />
          ) : (
            <FileText size={11} />
          )}
        </span>
        {block.kind !== "docs" && (
          <span className="shrink-0 whitespace-nowrap">
            {block.kind === "transcript"
              ? S.attachments.blockTranscript
              : S.attachments.blockFile}
          </span>
        )}
        <span className="min-w-0 flex-1 truncate font-normal normal-case tracking-normal">
          {block.name}
          {block.model ? ` ${S.attachments.blockReadBy(block.model)}` : ""}
        </span>
        {block.locator && (
          <span className="max-w-[45%] shrink-0 truncate font-normal normal-case tracking-normal">
            {block.locator}
          </span>
        )}
      </button>
      {open && (
        <div className="max-h-40 overflow-y-auto whitespace-pre-wrap px-3 pb-2 text-[11px] leading-relaxed text-text-muted">
          {block.body}
          {block.truncated && (
            <p className="mt-1.5 italic">{S.attachments.blockTruncated}</p>
          )}
        </div>
      )}
    </div>
  );
}

/** Terminal-independent display of the files and images used for a turn. */
export function AttachmentStrip({ attachments }: { attachments: Attachment[] }) {
  if (attachments.length === 0) return null;
  return (
    <div className="mb-1.5 flex flex-wrap gap-1.5">
      {attachments.map((attachment) => {
        const src = attachment.kind === "image" ? thumbnailSrc(attachment) : null;
        return src ? (
          <img
            key={attachment.id}
            src={src}
            alt={attachment.name}
            title={attachment.name}
            className="h-24 max-w-full rounded-lg border border-border-subtle object-cover"
          />
        ) : (
          <span
            key={attachment.id}
            className="flex items-center gap-1 rounded-md border border-border-subtle bg-bg-hover px-1.5 py-0.5 text-[10px] text-text-secondary"
          >
            {attachment.kind === "image" ? <ImageIcon size={9} /> : <FileText size={9} />}
            {attachment.name}
          </span>
        );
      })}
    </div>
  );
}
