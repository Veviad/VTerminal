export interface MarkdownLine {
  start: number;
  text: string;
  protectedByFence: boolean;
}

interface SourceLine extends MarkdownLine {
  end: number;
}

interface Fence {
  marker: "`" | "~";
  width: number;
  containerIndent: number;
  blockquoteDepth: number;
}

interface ProtectedRange {
  start: number;
  end: number;
}

export interface MarkdownProtection {
  lines: readonly MarkdownLine[];
  isProtected(offset: number): boolean;
}

function fenceMarker(text: string): string | null {
  return text.match(/^ {0,3}(`{3,}|~{3,})/u)?.[1] ?? null;
}

function validFenceOpening(text: string, marker: string): boolean {
  // CommonMark does not allow a backtick in a backtick fence's info string.
  return marker[0] !== "`" || !text.slice(text.indexOf(marker) + marker.length).includes("`");
}

/**
 * Read one or more list markers before a fence on the list item's first line.
 * The returned indentation is the number of spaces required by continuation
 * lines in the innermost item.
 */
function listFenceOpening(text: string): Fence | null {
  let offset = 0;
  let containerIndent = 0;
  let foundList = false;

  while (offset < text.length) {
    const list = /^( {0,3})(?:[*+-]|\d{1,9}[.)])( {1,4})/u.exec(text.slice(offset));
    if (!list) break;
    const width = list[0].length;
    offset += width;
    containerIndent += width;
    foundList = true;
  }

  if (!foundList) return null;
  const remaining = text.slice(offset);
  const marker = fenceMarker(remaining);
  if (!marker || !validFenceOpening(remaining, marker)) return null;
  return {
    marker: marker[0] as "`" | "~",
    width: marker.length,
    containerIndent,
    blockquoteDepth: 0,
  };
}

function rootFenceOpening(text: string): Fence | null {
  const marker = fenceMarker(text);
  if (!marker || !validFenceOpening(text, marker)) return null;
  return {
    marker: marker[0] as "`" | "~",
    width: marker.length,
    containerIndent: 0,
    blockquoteDepth: 0,
  };
}

function removeBlockquotePrefix(text: string, depth: number): string | null {
  let remaining = text;
  for (let index = 0; index < depth; index += 1) {
    const marker = /^ {0,3}>[ \t]?/u.exec(remaining);
    if (!marker) return null;
    remaining = remaining.slice(marker[0].length);
  }
  return remaining;
}

function blockquoteFenceOpening(text: string): Fence | null {
  let remaining = text;
  let blockquoteDepth = 0;

  while (true) {
    const marker = /^ {0,3}>[ \t]?/u.exec(remaining);
    if (!marker) break;
    remaining = remaining.slice(marker[0].length);
    blockquoteDepth += 1;
  }

  if (blockquoteDepth === 0) return null;
  const opening = rootFenceOpening(remaining) ?? listFenceOpening(remaining);
  return opening ? { ...opening, blockquoteDepth } : null;
}

function removeIndent(text: string, required: number): string | null {
  if (required === 0) return text;
  let offset = 0;
  let columns = 0;

  while (offset < text.length && columns < required) {
    if (text[offset] === " ") {
      columns += 1;
      offset += 1;
      continue;
    }
    if (text[offset] === "\t") {
      columns += 4 - (columns % 4);
      offset += 1;
      continue;
    }
    return null;
  }

  if (columns < required) return null;
  return " ".repeat(columns - required) + text.slice(offset);
}

function closesFence(text: string, fence: Fence): boolean {
  const quoted = removeBlockquotePrefix(text, fence.blockquoteDepth);
  if (quoted === null) return false;
  const continuation = removeIndent(quoted, fence.containerIndent);
  if (continuation === null) return false;
  const match = /^ {0,3}(`{3,}|~{3,})[ \t]*$/u.exec(continuation);
  if (!match) return false;
  const marker = match[1];
  return marker[0] === fence.marker && marker.length >= fence.width;
}

function sourceLines(content: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;

  while (start < content.length) {
    const newline = content.indexOf("\n", start);
    const end = newline === -1 ? content.length : newline;
    const textEnd = end > start && content[end - 1] === "\r" ? end - 1 : end;
    lines.push({
      start,
      end: newline === -1 ? content.length : newline + 1,
      text: content.slice(start, textEnd),
      protectedByFence: false,
    });
    if (newline === -1) break;
    start = newline + 1;
  }

  return lines;
}

function isEscapedBacktick(text: string, offset: number): boolean {
  let backslashes = 0;
  for (let index = offset - 1; index >= 0 && text[index] === "\\"; index -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function mergedRanges(ranges: ProtectedRange[]): ProtectedRange[] {
  ranges.sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: ProtectedRange[] = [];

  for (const range of ranges) {
    const previous = merged[merged.length - 1];
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }

  return merged;
}

/**
 * Precompute source offsets protected by fenced or inline Markdown code. This
 * intentionally models only code syntax. It is not a general Markdown parser.
 */
export function markdownProtection(content: string): MarkdownProtection {
  const lines = sourceLines(content);
  const ranges: ProtectedRange[] = [];
  let fence: Fence | null = null;

  for (const line of lines) {
    if (fence) {
      const remainsInBlockquote =
        fence.blockquoteDepth === 0 ||
        removeBlockquotePrefix(line.text, fence.blockquoteDepth) !== null;
      if (remainsInBlockquote) {
        line.protectedByFence = true;
        ranges.push({ start: line.start, end: line.end });
        if (closesFence(line.text, fence)) fence = null;
        continue;
      }
      fence = null;
    }

    const opening =
      rootFenceOpening(line.text) ??
      listFenceOpening(line.text) ??
      blockquoteFenceOpening(line.text);
    if (!opening) continue;
    fence = opening;
    line.protectedByFence = true;
    ranges.push({ start: line.start, end: line.end });
  }

  let inline: { start: number; width: number } | null = null;
  for (const line of lines) {
    if (line.protectedByFence) {
      if (inline) {
        ranges.push({ start: inline.start, end: line.start });
        inline = null;
      }
      continue;
    }

    let offset = 0;
    while (offset < line.text.length) {
      if (line.text[offset] !== "`" || isEscapedBacktick(line.text, offset)) {
        offset += 1;
        continue;
      }

      let end = offset + 1;
      while (end < line.text.length && line.text[end] === "`") end += 1;
      const width = end - offset;
      if (!inline) {
        inline = { start: line.start + offset, width };
      } else if (inline.width === width) {
        ranges.push({ start: inline.start, end: line.start + end });
        inline = null;
      }
      offset = end;
    }
  }

  if (inline) ranges.push({ start: inline.start, end: content.length });
  const protectedRanges = mergedRanges(ranges);

  return {
    lines,
    isProtected(offset: number): boolean {
      let low = 0;
      let high = protectedRanges.length - 1;
      while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        const range = protectedRanges[middle];
        if (offset < range.start) high = middle - 1;
        else if (offset >= range.end) low = middle + 1;
        else return true;
      }
      return false;
    },
  };
}
