import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type RefObject,
  type SyntheticEvent,
} from "react";
import { inputFromClipboardText, inputsFromClipboard, stageInputs } from "../lib/attachInput";
import { S } from "../lib/strings";
import type { Attachment } from "../lib/types";
import { useAppStore } from "../stores/appStore";

interface ClipboardStagingOptions {
  sessionId: string | null;
  steering: boolean;
  pendingAttachments: readonly Attachment[];
}

interface ClipboardStaging {
  input: string;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  pasteAnnouncement: string;
  pastedTextStaging: boolean;
  isPastedTextStaging(): boolean;
  clearInput(): void;
  handleInputChange(event: ChangeEvent<HTMLTextAreaElement>): void;
  handleInputSelection(event: SyntheticEvent<HTMLTextAreaElement>): void;
  handlePaste(event: ClipboardEvent<HTMLTextAreaElement>): void;
  showAttachmentAsText(attachment: Attachment): void;
}

function maxPastedTextSequence(attachments: readonly Attachment[]): number {
  return attachments.reduce((max, attachment) => {
    if (attachment.origin !== "pasted-text") return max;
    const found = /^pasted-text-(\d+)\.txt$/.exec(attachment.name);
    return found ? Math.max(max, Number(found[1])) : max;
  }, 0);
}

/** Own the composer state that is specific to clipboard text promotion.
 *
 * Keeping the queue, per-session fence, generated-name sequence and caret
 * restoration together makes the ordering invariant explicit: once native
 * paste is prevented, Send stays disabled until that exact paste has either
 * reached pending attachments or failed ingestion.
 */
export function useClipboardStaging({
  sessionId,
  steering,
  pendingAttachments,
}: ClipboardStagingOptions): ClipboardStaging {
  const [input, setInput] = useState("");
  const [pasteAnnouncement, setPasteAnnouncement] = useState("");
  const [, setStageRevision] = useState(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const currentSessionRef = useRef(sessionId);
  currentSessionRef.current = sessionId;
  const lastSelectionRef = useRef({ start: 0, end: 0 });
  const restoreCaretRef = useRef<{ sessionId: string; offset: number } | null>(null);
  const pastedTextSequenceRef = useRef(new Map<string, number>());
  const pastedTextStageQueueRef = useRef(new Map<string, Promise<void>>());
  // This mutable Map is the synchronous submit fence. The revision state exists
  // only to update the button after a count changes; session ids are never used
  // as object properties.
  const pastedTextStageCountRef = useRef(new Map<string, number>());
  const detachFileFromAi = useAppStore((state) => state.detachFileFromAi);

  const stageCount = (targetSessionId: string): number =>
    pastedTextStageCountRef.current.get(targetSessionId) ?? 0;

  const adjustStageCount = (targetSessionId: string, delta: 1 | -1): void => {
    const next = Math.max(0, stageCount(targetSessionId) + delta);
    if (next === 0) pastedTextStageCountRef.current.delete(targetSessionId);
    else pastedTextStageCountRef.current.set(targetSessionId, next);
    setStageRevision((revision) => revision + 1);
  };

  const rememberSelection = (textarea: HTMLTextAreaElement): void => {
    lastSelectionRef.current = {
      start: textarea.selectionStart,
      end: textarea.selectionEnd,
    };
  };

  const clearInput = (): void => {
    restoreCaretRef.current = null;
    lastSelectionRef.current = { start: 0, end: 0 };
    setInput("");
  };

  const handleInputChange = (event: ChangeEvent<HTMLTextAreaElement>): void => {
    setInput(event.currentTarget.value);
    rememberSelection(event.currentTarget);
  };

  const handleInputSelection = (event: SyntheticEvent<HTMLTextAreaElement>): void => {
    rememberSelection(event.currentTarget);
  };

  const showAttachmentAsText = (attachment: Attachment): void => {
    if (!sessionId || typeof attachment.text !== "string") return;
    const start = Math.min(lastSelectionRef.current.start, input.length);
    const end = Math.min(Math.max(start, lastSelectionRef.current.end), input.length);
    const next = input.slice(0, start) + attachment.text + input.slice(end);
    const caret = start + attachment.text.length;
    restoreCaretRef.current = { sessionId, offset: caret };
    detachFileFromAi(sessionId, attachment.id);
    setInput(next);
    setPasteAnnouncement(S.attachments.pastedTextInserted(attachment.name));
  };

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    const fileInputs = inputsFromClipboard(event.clipboardData.items);
    // Clipboard producers often include both a real file and text/HTML
    // fallbacks. The richer file representation remains authoritative.
    if (fileInputs.length > 0) {
      event.preventDefault();
      if (sessionId) void stageInputs(sessionId, fileInputs);
      return;
    }

    // A running agent accepts steering text only. A staged chip would belong to
    // the next ordinary turn, so leave this paste to the native textarea path.
    if (!sessionId || steering) return;
    const text = event.clipboardData.getData("text/plain");
    const previous = pastedTextSequenceRef.current.get(sessionId) ?? 0;
    const sequence = Math.max(previous, maxPastedTextSequence(pendingAttachments)) + 1;
    const pasted = inputFromClipboardText(text, sequence);
    if (!pasted) return;
    pastedTextSequenceRef.current.set(sessionId, sequence);

    event.preventDefault();
    adjustStageCount(sessionId, 1);
    rememberSelection(event.currentTarget);

    // Blob normalization is async. Serialize qualifying pastes per session so
    // rapid blocks cannot append as #2 then #1 merely because one read wins.
    const prior = pastedTextStageQueueRef.current.get(sessionId) ?? Promise.resolve();
    const queued = prior.catch(() => undefined).then(async () => {
      try {
        const accepted = await stageInputs(sessionId, [pasted]);
        if (
          accepted.some(
            (attachment) =>
              attachment.origin === "pasted-text" && attachment.name === pasted.name,
          ) &&
          currentSessionRef.current === sessionId
        ) {
          setPasteAnnouncement(
            S.attachments.pastedTextAttached(pasted.name, pasted.lineCount ?? 0),
          );
        }
      } catch {
        return;
      }
    });
    pastedTextStageQueueRef.current.set(sessionId, queued);

    const finishQueuedPaste = (): void => {
      if (pastedTextStageQueueRef.current.get(sessionId) === queued) {
        pastedTextStageQueueRef.current.delete(sessionId);
      }
      adjustStageCount(sessionId, -1);
    };
    // Both arms consume a rejection, so failed normalization cannot leave an
    // unhandled promise or a permanently disabled Send button.
    void queued.then(finishQueuedPaste, finishQueuedPaste);
  };

  // Restore focus/caret only after React commits the controlled value. Setting
  // the selection in the click handler races WebKit and resets to the end.
  useEffect(() => {
    const pendingCaret = restoreCaretRef.current;
    if (pendingCaret === null) return;
    restoreCaretRef.current = null;
    if (pendingCaret.sessionId !== sessionId) return;
    inputRef.current?.focus();
    inputRef.current?.setSelectionRange(pendingCaret.offset, pendingCaret.offset);
    lastSelectionRef.current = { start: pendingCaret.offset, end: pendingCaret.offset };
  }, [input, pendingAttachments.length, sessionId]);

  useEffect(() => {
    restoreCaretRef.current = null;
    setPasteAnnouncement("");
    lastSelectionRef.current = { start: 0, end: 0 };
  }, [sessionId]);

  return {
    input,
    inputRef,
    pasteAnnouncement,
    pastedTextStaging: sessionId ? stageCount(sessionId) > 0 : false,
    isPastedTextStaging: () => (sessionId ? stageCount(sessionId) > 0 : false),
    clearInput,
    handleInputChange,
    handleInputSelection,
    handlePaste,
    showAttachmentAsText,
  };
}
