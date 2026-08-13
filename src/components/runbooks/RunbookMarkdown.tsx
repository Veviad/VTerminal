import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** Raw HTML is intentionally not enabled. Imported runbooks are local but are
 * still untrusted presentation data, and no definition needs DOM authority or
 * permission to fetch remote resources. Links are displayed without navigation
 * and images are never loaded by the webview. */
export function RunbookMarkdown({ children }: { children: string }) {
  return (
    <div className="prose prose-sm max-w-none text-[11px] leading-relaxed">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          a: ({ children: label, href }) => (
            <span className="underline decoration-dotted" title={href ? `Link omitted: ${href}` : undefined}>
              {label}
            </span>
          ),
          img: ({ alt }) => <span className="italic">[Image omitted{alt ? `: ${alt}` : ""}]</span>,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
