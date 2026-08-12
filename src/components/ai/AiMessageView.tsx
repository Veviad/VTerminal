import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";

export function AiMessageView({ content }: { content: string }) {
  return (
    <div className="prose max-w-none text-[13px] leading-relaxed prose-p:my-1.5 prose-pre:my-2 prose-headings:my-2">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
