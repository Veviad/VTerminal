import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { fitTextarea } from "../../hooks/useAutoGrow";
import { continueBlock, insertLink, toggleWrap, type TextEdit } from "../../lib/markdownEditing";
import { tokenizeMarkdown, type MarkdownTokenKind } from "../../lib/markdownHighlight";
import { isWindows } from "../../lib/platform";

// A textarea for prose the model reads, with markdown highlighted as you type.
//
// The highlighting is painted by a second layer BEHIND a textarea whose own text
// is transparent — the standard trick, and the only one that keeps a real
// textarea (native caret, selection, undo, IME, autofill) instead of a
// contenteditable that has to reimplement all of it.
//
// Everything below follows from the two layers having to wrap at the same
// column, and each one is a way that has already been seen to drift here:
//
//  - The font is MONOSPACE, and that is load-bearing rather than a style
//    choice. The textarea lays its own text out in one weight; the layer behind
//    it renders headings bold and emphasis italic. In a proportional family
//    those faces advance differently, so a wrapped line breaks in one layer and
//    not the other, and every glyph after it sits under the wrong character.
//    All four JetBrains Mono faces are bundled and monospaced, so bold and
//    italic are free here and cost nothing in alignment. The family is set in
//    `app.css` for both layers at once and NOT as a `font-mono` class, because
//    the unlayered `textarea` rule there outranks every utility — measured:
//    the box rendered in Inter while the layer behind it rendered JetBrains
//    Mono, and `resize-y` was silently dead for the same reason.
//  - No token style may change font-size, font-family, letter-spacing or
//    padding, for the same reason. Colour, background, weight, slant and
//    decoration are safe. `no markdown style changes glyph metrics` pins it.
//  - The box scrolls without a visible scrollbar (`.md-editor` in app.css).
//    The app's 6px custom scrollbar narrows the textarea's content box and
//    nothing narrows the layer behind it.
//  - A value ending in a newline gets one more for the layer only: a trailing
//    newline creates no final line box in CSS, while the textarea reserves a
//    line for the caret to sit on.

/** Roughly 23 lines before the box starts scrolling instead of growing. */
export const MARKDOWN_EDITOR_MAX_PX = 460;

/** Wide enough to hold a paragraph before it starts growing. */
export const MARKDOWN_EDITOR_MIN_PX = 132;

/** Applied to BOTH layers. Everything here decides where a line wraps — the
 *  font family included, which `.md-editor`/`.md-editor-layer` carry instead. */
const METRICS = "w-full px-2.5 py-2 text-[12px] leading-[1.65] whitespace-pre-wrap break-words";

const KIND_CLASS: Record<MarkdownTokenKind, string> = {
  text: "",
  syntax: "text-text-muted",
  heading: "font-bold text-accent",
  strong: "font-bold text-text-primary",
  em: "italic",
  strongEm: "font-bold italic text-text-primary",
  strike: "text-text-muted line-through",
  // No padding on the inline-code background: padding on an inline span pushes
  // the glyphs after it sideways, which is exactly the drift this file avoids.
  code: "bg-accent-subtle text-accent",
  codeBlock: "text-text-secondary",
  quote: "text-text-secondary",
  link: "text-accent underline decoration-dotted",
  url: "text-text-muted underline",
  rule: "text-text-muted",
};

/** Exported for the test that keeps the styles metric-safe. */
export const MARKDOWN_KIND_CLASS: Readonly<Record<MarkdownTokenKind, string>> = KIND_CLASS;

/** The modifier the formatting keys are spelled with in help text. Plain Ctrl on
 *  Windows, where every app-reserved binding takes Ctrl+Shift and none of these
 *  collide. */
export const formattingModifier = (): string => (isWindows() ? "Ctrl+" : "⌘");

/** A markdown-highlighted textarea. See the file comment for what holds the
 *  highlighting in step with the text it sits behind. */
export function MarkdownEditor({
  value,
  onChange,
  onBlur,
  onKeyDown,
  placeholder,
  ariaLabel,
  invalid = false,
  minPx = MARKDOWN_EDITOR_MIN_PX,
  maxPx = MARKDOWN_EDITOR_MAX_PX,
}: {
  value: string;
  onChange: (next: string) => void;
  onBlur?: () => void;
  /** Runs for every key this editor does not claim — ⌘Enter, Escape, … */
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  placeholder?: string;
  ariaLabel: string;
  invalid?: boolean;
  minPx?: number;
  maxPx?: number;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  /** The height auto-grow last wrote, to tell our own resizes from the user's. */
  const applied = useRef(0);
  /** A selection to restore once React has rendered the edited value. */
  const pending = useRef<[number, number] | null>(null);
  const [dragged, setDragged] = useState(false);

  // Auto-grow, with the applied height recorded. `useAutoGrow` is the same
  // measurement without either of those, so this cannot just call it.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || dragged) return;
    fitTextarea(el, maxPx);
    // Read back rather than trusting the write: `minPx` is a CSS floor, so a
    // short value ends up taller than the height that was just set.
    applied.current = el.offsetHeight;
  }, [value, maxPx, dragged]);

  // Until the bundled font has loaded, every measurement above came from the
  // fallback family and is wrong — same reason the terminal re-fits here.
  useEffect(() => {
    let cancelled = false;
    void document.fonts?.ready.then(() => {
      const el = ref.current;
      if (cancelled || !el || dragged) return;
      fitTextarea(el, maxPx);
      applied.current = el.offsetHeight;
    });
    return () => {
      cancelled = true;
    };
  }, [maxPx, dragged]);

  /** A height nobody here applied came from the user dragging the resize corner.
   *  Auto-grow then steps aside for good: snapping the box back to fit on the
   *  next keystroke reads as the drag having failed. */
  const noteHeight = () => {
    const el = ref.current;
    if (el && Math.abs(el.offsetHeight - applied.current) > 2) setDragged(true);
  };

  // The resize gesture ends with a mouseup on the textarea itself, which is the
  // one signal that does not depend on the page rendering. ResizeObserver is the
  // backstop for a drag that ends elsewhere, and it is DELIVERED WITH THE FRAME:
  // a window that is not painting (hidden, occluded, minimised) never runs it,
  // which is exactly the case a resize-heavy interaction has to survive.
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(noteHeight);
    observer.observe(el);
    return () => {
      observer.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Both halves of an edit have to land after the re-render, or the browser
  // clamps the selection to the length of the text it is replacing.
  useLayoutEffect(() => {
    const el = ref.current;
    const selection = pending.current;
    if (!el || !selection) return;
    pending.current = null;
    el.setSelectionRange(selection[0], selection[1]);
  }, [value]);

  const tokens = useMemo(
    // A trailing newline needs a second one HERE only — see the file comment.
    () => tokenizeMarkdown(value.endsWith("\n") ? `${value}\n` : value),
    [value],
  );

  const apply = (change: TextEdit | null): void => {
    const el = ref.current;
    if (!change || !el) return;
    el.setSelectionRange(change.from, change.to);
    // execCommand keeps the native undo stack, which a controlled re-render
    // does not. jsdom implements neither verb, so tests take the fallback.
    let spliced = false;
    try {
      spliced =
        change.insert === ""
          ? (document.execCommand?.("delete") ?? false)
          : (document.execCommand?.("insertText", false, change.insert) ?? false);
    } catch {
      spliced = false;
    }
    if (!spliced) onChange(change.value);
    // execCommand fires `input`, so React has the new value either way; the
    // selection still has to wait for the render above.
    pending.current = [change.selectionStart, change.selectionEnd];
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    // Cmd on macOS, Ctrl on Windows — and never the other one. On macOS Ctrl+B,
    // Ctrl+E and Ctrl+K are the emacs bindings WebKit gives every text field
    // (back a character, end of line, kill to end of line), which is muscle
    // memory a terminal's users have and this editor has no business taking.
    const mod = isWindows() ? e.ctrlKey && !e.metaKey : e.metaKey && !e.ctrlKey;

    if (mod && !e.altKey && !e.shiftKey) {
      const key = e.key.toLowerCase();
      const marker = key === "b" ? "**" : key === "i" ? "_" : key === "e" ? "`" : null;
      if (marker || key === "k") {
        e.preventDefault();
        // ⌘I and ⌘K are app-reserved (AI composer, command palette) and
        // `useGlobalShortcuts` listens on `window` — one level above React's
        // root container, so stopping propagation here is what lets a focused
        // prose editor keep the formatting keys every editor has. Nothing in
        // the app claims ⌘B or ⌘E, and on Windows nothing collides at all.
        e.stopPropagation();
        apply(
          marker
            ? toggleWrap(el.value, el.selectionStart, el.selectionEnd, marker)
            : insertLink(el.value, el.selectionStart, el.selectionEnd),
        );
        return;
      }
    }

    if (e.key === "Enter" && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
      const change = continueBlock(el.value, el.selectionStart, el.selectionEnd);
      if (change) {
        e.preventDefault();
        apply(change);
        return;
      }
    }

    onKeyDown?.(e);
  };

  return (
    <div
      className={`relative rounded-md border bg-bg-card ${
        invalid ? "border-error" : "border-border-subtle focus-within:border-accent"
      }`}
    >
      <div
        ref={layer}
        aria-hidden="true"
        className={`md-editor-layer pointer-events-none absolute inset-0 overflow-hidden text-text-primary ${METRICS}`}
      >
        {tokens.map((token, index) => (
          <span key={index} className={KIND_CLASS[token.kind]}>
            {token.text}
          </span>
        ))}
      </div>
      <textarea
        ref={ref}
        value={value}
        aria-label={ariaLabel}
        placeholder={placeholder}
        // Off for the same reason the command boxes turn it off: standing
        // instructions are half flags, paths and package names, and a field of
        // red squiggles under transparent text is noise, not a proofreader.
        spellCheck={false}
        style={{ minHeight: `${minPx}px` }}
        className={`md-editor relative block bg-transparent text-transparent caret-text-primary outline-none placeholder:text-text-muted ${METRICS}`}
        onChange={(e) => {
          onChange(e.target.value);
        }}
        onBlur={onBlur}
        onKeyDown={handleKeyDown}
        onMouseUp={noteHeight}
        onScroll={() => {
          const box = layer.current;
          const el = ref.current;
          if (!box || !el) return;
          box.scrollTop = el.scrollTop;
          box.scrollLeft = el.scrollLeft;
        }}
      />
    </div>
  );
}
