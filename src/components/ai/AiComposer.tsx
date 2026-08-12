import { useEffect, useRef, useState } from "react";
import { Sparkles, CornerDownLeft } from "lucide-react";
import { useAppStore } from "../../stores/appStore";
import { useAiStream } from "../../hooks/useAiStream";
import { useAutoGrow } from "../../hooks/useAutoGrow";
import { getTerm } from "../../lib/termRegistry";
import { ptyWrite, aiCancel } from "../../lib/tauri";
import { Kbd } from "../ui/Kbd";
import { S } from "../../lib/strings";

// Docked strip below the terminal (Cmd+I). Suggested commands are INSERTED
// into the shell prompt — never executed by the app.
export function AiComposer({ sessionId }: { sessionId: string }) {
  const ui = useAppStore((s) => s.sessionUi[sessionId]);
  const updateSessionUi = useAppStore((s) => s.updateSessionUi);
  // The reason, not just the boolean: "load a model" is wrong advice when the
  // block is a missing key or a build with no on-device engine at all.
  const blocked = useAppStore((s) => s.aiBlockedReason());
  const modelReady = blocked === null;
  const activeModelLabel = useAppStore(
    (s) => s.catalog.find((m) => m.id === s.activeModelId)?.label ?? null,
  );
  const { generateCommand } = useAiStream();
  const [prompt, setPrompt] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const open = ui?.composerOpen ?? false;
  const status = ui?.composerStatus ?? "idle";
  const proposal = ui?.composerProposal;

  useEffect(() => {
    if (open) inputRef.current?.focus();
    else setPrompt("");
  }, [open]);

  // Fixed cap, not a share of anything: this strip is not bounded by a sibling
  // scroll region, so every row it grows is a row taken from xterm — which fires
  // TerminalView's ResizeObserver and a debounced `pty_resize` (SIGWINCH at the
  // shell). Keep it tight. `open` is a dep because the box mounts on open.
  useAutoGrow(inputRef, 160, [prompt, open]);

  if (!open) return null;

  const submit = () => {
    if (!prompt.trim() || !modelReady || status === "generating") return;
    void generateCommand(sessionId, prompt.trim());
  };

  const insert = () => {
    if (!proposal?.command) return;
    void ptyWrite(sessionId, proposal.command); // no trailing \r — lands in the prompt
    close();
  };

  const close = () => {
    if (status === "generating" && ui?.composerRequestId) {
      void aiCancel(ui.composerRequestId).catch(() => {});
    }
    updateSessionUi(sessionId, {
      composerOpen: false,
      composerStatus: "idle",
      composerProposal: null,
      composerError: null,
      composerRequestId: null,
    });
    getTerm(sessionId)?.term.focus();
  };

  return (
    <div className="border-t border-border-subtle bg-bg-secondary px-3 py-2">
      <div className="flex items-start gap-2">
        <Sparkles size={13} className="mt-1.5 shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <textarea
              ref={inputRef}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  if (status === "proposal") insert();
                  else submit();
                }
              }}
              rows={1}
              placeholder={blocked ? S.composer.blocked[blocked] : S.composer.placeholder}
              disabled={!modelReady}
              /* Height/overflow are inline styles owned by useAutoGrow. */
              className="w-full resize-none bg-transparent py-1 text-[13px] text-text-primary placeholder:text-text-muted disabled:opacity-50"
            />
          </div>

          {status === "generating" && (
            <div className="flex items-center gap-2 py-1 text-[11px] text-text-muted">
              <span className="inline-block h-1 w-1 animate-pulse rounded-full bg-accent" />
              {S.composer.generating}
              {proposal?.command && (
                <code className="truncate font-mono text-[11px] text-text-secondary">
                  {proposal.command}
                </code>
              )}
            </div>
          )}

          {status === "proposal" && proposal && (
            <div className="mt-1 space-y-1">
              <div className="rounded-md bg-bg-terminal px-2 py-1.5 font-mono text-[12px] text-text-primary">
                {proposal.command}
              </div>
              {proposal.explanation && (
                <p className="text-[11px] text-text-muted">{proposal.explanation}</p>
              )}
              <div className="flex items-center gap-2 pt-0.5">
                <button
                  onClick={insert}
                  className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1 text-[12px] font-medium text-bg-primary transition-colors duration-150 hover:bg-accent-hover"
                >
                  <CornerDownLeft size={12} />
                  {S.composer.insert}
                </button>
                <button
                  onClick={close}
                  className="rounded-md px-3 py-1 text-[12px] text-text-muted transition-colors duration-150 hover:bg-bg-hover hover:text-text-secondary"
                >
                  {S.composer.discard}
                </button>
              </div>
            </div>
          )}

          {status === "error" && ui?.composerError && (
            <p className="py-1 text-[11px] text-error">{ui.composerError}</p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2 pt-1">
          {activeModelLabel && (
            <span className="font-mono text-[10px] text-text-muted">
              {activeModelLabel}
            </span>
          )}
          <button
            onClick={() => {
              if (status === "generating" && ui?.composerRequestId) {
                void aiCancel(ui.composerRequestId).catch(() => {});
              }
              close();
            }}
          >
            <Kbd>esc</Kbd>
          </button>
        </div>
      </div>
    </div>
  );
}
