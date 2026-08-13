/** Cleaning citation markup out of model output before it is rendered.
 *
 *  **Why this exists.** Asked to cite grounded content, Claude reaches for
 *  `<cite index="1-1,1-2">…</cite>` — the shape from Anthropic's long-context citation
 *  convention, where the index refers to a `<document_index>` supplied in the request.
 *  This app supplies no such indices (retrieved passages are labelled
 *  `[docs: file — p.12 — Heading]`), so those numbers point at nothing. And
 *  `AiMessageView` renders markdown WITHOUT `rehype-raw`, so the tags never become
 *  elements — they show up as literal angle-bracket text in the middle of a sentence.
 *
 *  The prompts now ask for plain-prose citations instead, which is the real fix. This is
 *  the backstop: prompt wording cannot bind a model, and the failure mode is visible in
 *  every answer rather than rare.
 *
 *  **Applied at RENDER time, not on the way in.** Stored `content` stays the wire truth —
 *  what was sent, what is archived, what gets replayed — exactly as `splitFoldedBlocks`
 *  treats folded attachments. Cleaning on ingest would also have to cope with tags split
 *  across streamed chunks; cleaning at render sees whole (or knowably partial) text.
 */

/** Fence lines, so transformation can skip code blocks. */
const FENCE = /^\s*(`{3,}|~{3,})/;

/** A complete tag, opening or closing. Attribute-tolerant, case-insensitive. */
const CITE_TAG = /<\/?cite\b[^>]*>/gi;

/** A tag still arriving — `<cite index="1-` at the very end of a streamed buffer.
 *
 *  Requires at least `<ci`, deliberately not `<c`. Streaming re-renders on every delta,
 *  so without this the opening tag is visible character by character on every cited
 *  sentence; with `<c` included it would instead truncate prose that happens to end
 *  mid-word after a bracket. `<ci` is specific enough never to be real text, and the
 *  worst case left is a two-character flash that the next delta resolves. */
const PARTIAL_CITE = /<\/?ci(t(e\b[^>]*)?)?$/i;

/** Split a line into alternating outside/inside-backticks segments.
 *
 *  Inline code needs the same protection as a fenced block: an answer explaining the HTML
 *  element would write `` `<cite>` ``, and stripping inside it would leave empty inline
 *  code. Odd indices are the code spans.
 */
function byCodeSpan(line: string): string[] {
  return line.split(/(`[^`]*`)/);
}

/** Unwrap `<cite …>text</cite>` to `text`, dropping the tags and keeping the words.
 *
 *  Unwrapping rather than deleting the element: the text inside is the model's answer, and
 *  the tag is the only part that is noise. Nothing is substituted for the index either —
 *  a footnote marker would imply a link back to a passage the index cannot identify. The
 *  foldable "From your documents" block already shows which passages were supplied.
 */
export function stripCiteTags(content: string): string {
  const hasTag = /<\/?cite/i.test(content);
  const hasPartial = PARTIAL_CITE.test(content);
  // The overwhelmingly common case: nothing to do, and no scanning cost.
  if (!hasTag && !hasPartial) return content;

  const lines = content.split("\n");
  let inFence = false;
  const cleaned = lines.map((line) => {
    if (FENCE.test(line)) {
      inFence = !inFence;
      return line;
    }
    if (inFence) return line;
    return byCodeSpan(line)
      .map((seg, i) => (i % 2 === 1 ? seg : seg.replace(CITE_TAG, "")))
      .join("");
  });

  let text = cleaned.join("\n");
  // A half-arrived tag, only outside a fence and only at the very end.
  if (!inFence) text = text.replace(PARTIAL_CITE, "");
  return text;
}
