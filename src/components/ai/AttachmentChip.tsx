import { FileText, Image as ImageIcon, X } from "lucide-react";
import { formatAttachmentBytes, thumbnailSrc } from "../../lib/attachments";
import { S } from "../../lib/strings";
import type { Attachment } from "../../lib/types";

/** A staged file, above the composer.
 *
 *  A sibling of `BlockContextChip` rather than a variant of it: that one is a
 *  command with an exit code, this one is a file with a thumbnail and a size, and
 *  the paperclip icon is already spoken for there. The wrapper classes are
 *  deliberately identical so the two strips read as one row.
 */
export function AttachmentChip({
  attachment,
  onRemove,
  onShowAsText,
}: {
  attachment: Attachment;
  onRemove: () => void;
  onShowAsText?: () => void;
}) {
  const thumb = attachment.kind === "image" ? thumbnailSrc(attachment) : null;
  return (
    <span className="flex max-w-full items-center gap-1.5 rounded-full border border-border-subtle bg-bg-hover px-2 py-0.5 text-[10px] text-text-secondary">
      {thumb ? (
        <img
          src={thumb}
          alt=""
          className="-ms-1 h-4 w-4 shrink-0 rounded-full object-cover"
        />
      ) : attachment.kind === "image" ? (
        <ImageIcon size={10} className="shrink-0 text-accent" />
      ) : (
        <FileText size={10} className="shrink-0 text-accent" />
      )}
      <span className="truncate">{attachment.name}</span>
      <span className="shrink-0 font-mono text-text-muted">
        {formatAttachmentBytes(attachment.bytes)}
      </span>
      {attachment.truncated && (
        <span className="shrink-0 text-text-muted">{S.attachments.truncated}</span>
      )}
      {onShowAsText && (
        <button
          type="button"
          onClick={onShowAsText}
          title={S.attachments.showAsTextNamed(attachment.name)}
          aria-label={S.attachments.showAsTextNamed(attachment.name)}
          className="shrink-0 rounded-full px-1 py-0.5 text-accent transition-colors duration-100 hover:bg-bg-elevated hover:text-accent-hover"
        >
          {S.attachments.showAsText}
        </button>
      )}
      <button
        type="button"
        onClick={onRemove}
        title={S.attachments.removeNamed(attachment.name)}
        aria-label={S.attachments.removeNamed(attachment.name)}
        className="shrink-0 rounded-full p-0.5 transition-colors duration-100 hover:bg-bg-elevated hover:text-text-primary"
      >
        <X size={9} />
      </button>
    </span>
  );
}
