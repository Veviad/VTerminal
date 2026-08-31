import { openUrl } from "@tauri-apps/plugin-opener";
import type { ComponentPropsWithoutRef, MouseEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";

import { sanitizeExternalWebUrl } from "../../lib/externalUrl";
import { sanitizeModelMarkdown } from "../../lib/modelOutput";

function ExternalChatLink({ children, href, title }: ComponentPropsWithoutRef<"a">) {
  const safeUrl = typeof href === "string" ? sanitizeExternalWebUrl(href) : null;
  if (!safeUrl) {
    return (
      <span className="underline decoration-dotted" title={href ? `Link omitted: ${href}` : title}>
        {children}
      </span>
    );
  }

  const openInOsBrowser = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    void openUrl(safeUrl);
  };

  const openMiddleClickInOsBrowser = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 1) return;
    openInOsBrowser(event);
  };

  return (
    <a href={safeUrl} title={title} onClick={openInOsBrowser} onAuxClick={openMiddleClickInOsBrowser}>
      {children}
    </a>
  );
}

export type AiMessageOrigin = "model" | "literal";

/**
 * Render Markdown with an explicit trust/origin boundary. Model prose receives
 * presentation-only cleanup for known provider markup. User prompts and MCP tool
 * output are literal data and must never be rewritten as if the model authored them.
 */
export function AiMessageView({
  content,
  origin,
  streaming = false,
}: {
  content: string;
  origin: AiMessageOrigin;
  streaming?: boolean;
}) {
  const markdown = origin === "model"
    ? sanitizeModelMarkdown(content, { streaming })
    : content;
  return (
    <div className="prose max-w-none text-[13px] leading-relaxed prose-p:my-1.5 prose-pre:my-2 prose-headings:my-2">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{ a: ExternalChatLink }}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
}
