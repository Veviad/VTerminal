import { TerminalView } from "./TerminalView";
import { BlockGutter } from "./BlockGutter";
import { TerminalSearchBar } from "./TerminalSearchBar";
import { ReconnectBar } from "./ReconnectBar";
import { AiComposer } from "../ai/AiComposer";
import { useAppStore } from "../../stores/appStore";
import { S } from "../../lib/strings";

export function TerminalPane({
  sessionId,
  active,
  visible = active,
  showComposer = true,
  rendererActive = active,
}: {
  sessionId: string;
  /** Owns keyboard focus. */
  active: boolean;
  /** Sidecar keeps two panes visible while only one is active. */
  visible?: boolean;
  /** A linked workspace has one shared Agent panel, not two inline composers. */
  showComposer?: boolean;
  /** Owns a WebGL renderer. Sidecar keeps both visible panes rendered so focus
   *  changes cannot swap one pane between WebGL and DOM font rasterization. */
  rendererActive?: boolean;
}) {
  const session = useAppStore((s) => s.sessions.find((x) => x.id === sessionId));

  return (
    <div className={visible ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
      <div className="relative min-h-0 flex-1 bg-bg-terminal">
        <TerminalView sessionId={sessionId} active={active} rendererActive={rendererActive} />
        <BlockGutter sessionId={sessionId} />
        <TerminalSearchBar sessionId={sessionId} />
        {!session?.exited && <ReconnectBar sessionId={sessionId} />}
        {session?.exited && (
          <div className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-2 border-t border-border-subtle bg-bg-secondary/95 px-3 py-1.5 text-[11px] text-text-muted">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-error" />
            {S.terminal.exited}
            {session.exitCode !== null ? ` (${session.exitCode})` : ""} · {S.terminal.pressEnterToClose}
          </div>
        )}
      </div>
      {showComposer && <AiComposer sessionId={sessionId} />}
    </div>
  );
}
