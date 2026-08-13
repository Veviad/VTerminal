import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";

import { stripCiteTags } from "../../lib/citations";

/** The one place model prose is rendered — every assistant message and the live
 *  streaming buffer both come through here.
 *
 *  `stripCiteTags` runs at render rather than on the way in so the stored `content` stays
 *  the wire truth (what was sent, what is archived, what gets replayed), which is the same
 *  stance `splitFoldedBlocks` takes for folded attachments. It is a no-op on the vast
 *  majority of messages — see its own doc comment for why it is needed at all. */
export function AiMessageView({ content }: { content: string }) {
  return (
    <div className="prose max-w-none text-[13px] leading-relaxed prose-p:my-1.5 prose-pre:my-2 prose-headings:my-2">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
        {stripCiteTags(content)}
      </ReactMarkdown>
    </div>
  );
}
