// The write half of the markdown prompt editor: what ⌘B, ⌘I, ⌘K and Enter do.
//
// Every operation is a pure function over (value, selection) so the behaviour is
// testable without a DOM and without a browser's selection model. They return
// the replaced SPAN as well as the finished value, because the caller applies
// the edit through `document.execCommand("insertText")` when it can — that is
// the only way to change a textarea's text and keep the native undo stack, so
// ⌘Z still walks back through a ⌘B.

export interface TextEdit {
  /** The whole field after the edit — the fallback path for callers that cannot
   *  splice through the DOM. */
  value: string;
  /** Start of the replaced span. */
  from: number;
  /** End of the replaced span. */
  to: number;
  /** What replaces it. Empty means "delete the span". */
  insert: string;
  selectionStart: number;
  selectionEnd: number;
}

function edit(
  value: string,
  from: number,
  to: number,
  insert: string,
  selectionStart: number,
  selectionEnd: number,
): TextEdit {
  return {
    value: value.slice(0, from) + insert + value.slice(to),
    from,
    to,
    insert,
    selectionStart,
    selectionEnd,
  };
}

/**
 * What Enter does inside a list, a task list or a block quote: repeat the
 * prefix. Returns null when the caret is not in one of those, so the caller
 * leaves the keystroke to the browser.
 *
 * Enter on an item that is still EMPTY removes the prefix instead of making
 * another one — that is how a list is ended everywhere else, and without it the
 * only way out of a list is to delete the marker by hand.
 */
export function continueBlock(value: string, start: number, end: number): TextEdit | null {
  // With a selection, Enter means "replace this", which is the browser's job.
  if (start !== end) return null;

  const lineStart = value.lastIndexOf("\n", start - 1) + 1;
  const before = value.slice(lineStart, start);
  const match = /^(\s*)((?:>\s?)*)(?:([-*+])(\s+)|(\d{1,9})([.)])(\s+))?/.exec(before);
  if (!match) return null;

  const [prefix, indent, quote, bullet, bulletGap, number, delimiter, numberGap] = match;
  if (!quote && !bullet && !number) return null;

  let body = before.slice(prefix.length);
  let task = "";
  const box = /^\[[ xX]\](\s+)/.exec(body);
  if ((bullet || number) && box) {
    // A new item starts unchecked however the one above it ended.
    task = `[ ]${box[1]}`;
    body = body.slice(box[0].length);
  }

  if (!body.trim()) {
    return edit(value, lineStart, start, "", lineStart, lineStart);
  }

  const marker = bullet
    ? bullet + bulletGap
    : number
      ? `${Number(number) + 1}${delimiter}${numberGap}`
      : "";
  const insert = `\n${indent}${quote}${marker}${task}`;
  const caret = start + insert.length;
  return edit(value, start, end, insert, caret, caret);
}

/** The word the caret sits in, so ⌘B works without selecting anything first. */
function wordAround(value: string, at: number): [number, number] {
  const word = /[\w-]/;
  let from = at;
  let to = at;
  while (from > 0 && word.test(value[from - 1])) from--;
  while (to < value.length && word.test(value[to])) to++;
  return [from, to];
}

/**
 * Wrap the selection in `marker`, or unwrap it if it is already wrapped —
 * pressing ⌘B twice has to leave the text as it was found.
 *
 * With nothing selected the word under the caret is used; with no word there
 * either, the markers are inserted and the caret lands between them.
 */
export function toggleWrap(value: string, start: number, end: number, marker: string): TextEdit {
  let from = start;
  let to = end;
  if (from === to) [from, to] = wordAround(value, from);

  const width = marker.length;
  const selected = value.slice(from, to);

  // Markers just outside the selection — the shape left behind by a previous
  // ⌘B, whose selection covers the text but not its delimiters.
  if (value.slice(from - width, from) === marker && value.slice(to, to + width) === marker) {
    return edit(value, from - width, to + width, selected, from - width, from - width + selected.length);
  }

  // Markers inside the selection — the shape left behind by selecting a word
  // that was already bold, delimiters included.
  if (selected.length >= width * 2 && selected.startsWith(marker) && selected.endsWith(marker)) {
    const inner = selected.slice(width, selected.length - width);
    return edit(value, from, to, inner, from, from + inner.length);
  }

  return edit(
    value,
    from,
    to,
    marker + selected + marker,
    from + width,
    from + width + selected.length,
  );
}

/** A URL, near enough to decide which half of `[](…)` the selection belongs in. */
const LOOKS_LIKE_URL = /^(?:https?:\/\/|mailto:|www\.)\S+$/i;

/**
 * Turn the selection into a link. A selected URL becomes the target and the
 * caret lands in the empty label; anything else becomes the label and the caret
 * lands in the empty target. Neither half is filled with placeholder text —
 * `[text](url)` left behind by a mistyped shortcut is prose the model would
 * read as an instruction.
 */
export function insertLink(value: string, start: number, end: number): TextEdit {
  const selected = value.slice(start, end);
  if (LOOKS_LIKE_URL.test(selected)) {
    const insert = `[](${selected})`;
    return edit(value, start, end, insert, start + 1, start + 1);
  }
  const insert = `[${selected}]()`;
  // The caret goes to whichever half is still empty. With nothing selected both
  // are, and a link is written left to right.
  const caret = selected ? start + selected.length + 3 : start + 1;
  return edit(value, start, end, insert, caret, caret);
}
