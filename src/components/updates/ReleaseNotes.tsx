import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";

import { S } from "../../lib/strings";

/** GitHub release bodies are Markdown. Render them with the same safe pipeline
 * used for AI prose: GFM plus syntax highlighting, but never raw HTML. */
export function ReleaseNotes({ notes }: { notes: string }) {
  const content = notes.trim();
  if (!content) {
    return (
      <p className="text-[11px] leading-relaxed text-text-secondary">
        {S.settings.updates.noNotes}
      </p>
    );
  }

  return (
    <div className="prose max-w-none text-[11px] leading-relaxed prose-p:my-1.5 prose-pre:my-2 prose-headings:my-2 prose-h2:text-[13px] prose-h3:text-[12px] prose-ul:my-1.5 prose-ol:my-1.5 prose-li:my-0.5 prose-blockquote:my-2">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        skipHtml
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
