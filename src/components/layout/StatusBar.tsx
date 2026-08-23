import { Server } from "lucide-react";
import { useAppStore, useActiveSessionUi } from "../../stores/appStore";
import { describeRemote } from "../../lib/nesting";
import { collapseHome } from "../../lib/sessionTitle";
import { S } from "../../lib/strings";
import { useChatStore } from "../../stores/chatStore";

export function StatusBar() {
  const workspaceMode = useChatStore((s) => s.workspaceMode);
  const chatStream = useChatStore((s) => s.stream);
  const chat = useChatStore((s) => s.current);
  const modelState = useAppStore((s) => s.modelState);
  const aiReady = useAppStore((s) => s.aiReady());
  const activeLabel = useAppStore(
    (s) => s.catalog.find((m) => m.id === s.activeModelId)?.label ?? null,
  );
  const activeRenderer = useAppStore((s) => s.activeRenderer);
  const termDims = useAppStore((s) => s.termDims);
  const aiStreams = useAppStore((s) => s.aiStreams);
  const ui = useActiveSessionUi();

  const streaming = Object.values(aiStreams).some((s) => s.status === "streaming");
  const dotColor =
    aiReady ? "bg-accent" : modelState === "loading" ? "bg-warning" : "bg-text-muted";
  const cwd = ui?.cwd;
  const remote = ui?.remote ?? null;

  if (workspaceMode === "chat") {
    const model = useAppStore.getState().catalog.find((entry) => entry.id === useAppStore.getState().activeModelId);
    const web = !useAppStore.getState().aiWebAccess
      ? "web off"
      : model?.native_web_search && model.native_web_fetch
        ? "web ready"
        : "web unsupported";
    return (
      <footer className="flex h-7 shrink-0 items-center justify-between border-t border-border-subtle px-4 text-[10px] bg-bg-primary text-text-muted">
        <span className="font-mono">{chatStream.model ?? activeLabel ?? S.statusBar.noModel}</span>
        <span className="flex items-center gap-3">
          <span>{web}</span>
          <span>{chat?.attached_bucket_refs.length ? `${chat.attached_bucket_refs.length} Knowledge source${chat.attached_bucket_refs.length === 1 ? "" : "s"}` : "Knowledge not attached"}</span>
          {chatStream.status === "streaming" && <span className="flex items-center gap-1.5 text-accent"><span className="h-1 w-1 animate-pulse rounded-full bg-accent" />{S.statusBar.generating}</span>}
        </span>
      </footer>
    );
  }

  return (
    <footer className="flex h-7 shrink-0 items-center justify-between border-t border-border-subtle px-4 text-[10px] bg-bg-primary text-text-muted">
      <div className="flex min-w-0 items-center gap-3">
        <span className="flex items-center gap-1.5">
          <span
            className={`inline-block h-1.5 w-1.5 rounded-full ${dotColor} ${
              modelState === "loading" ? "animate-pulse" : ""
            }`}
          />
          <span className="font-mono">
            {activeLabel ?? S.statusBar.noModel}
          </span>
        </span>
        {/* While nested, cwd and branch describe THIS machine, not the one the
            user is looking at. useAiStream already refuses to send them to the
            model for that reason — showing them here would be the same lie. */}
        {remote ? (
          <span className="flex items-center gap-1 rounded-full bg-warning/15 px-1.5 py-0.5 font-mono text-[9px] text-warning">
            <Server size={9} />
            {ui?.remoteHost?.label ?? describeRemote(remote)}
          </span>
        ) : (
          <>
            {/* No opacity here: this row is already text-muted, and 70% of it put
                the most-read string in the status bar at 1.82:1. */}
            {cwd && <span className="truncate font-mono">{shortenPath(cwd)}</span>}
            {ui?.gitBranch && (
              <span className="rounded-full bg-bg-hover px-1.5 py-0.5 font-mono text-[9px]">
                {ui.gitBranch}
              </span>
            )}
          </>
        )}
      </div>
      <div className="flex items-center gap-3">
        {streaming && (
          <span className="flex items-center gap-1.5 text-accent">
            <span className="inline-block h-1 w-1 animate-pulse rounded-full bg-accent" />
            {S.statusBar.generating}
          </span>
        )}
        <span className="font-mono">
          {termDims.cols}×{termDims.rows}
        </span>
        <span
          className={`rounded-full px-1.5 py-0.5 text-[9px] font-medium ${
            activeRenderer === "webgl"
              ? "bg-accent/10 text-accent"
              : "bg-bg-hover text-text-secondary"
          }`}
        >
          {activeRenderer === "webgl" ? S.terminal.rendererGpu : S.terminal.rendererDom}
        </span>
      </div>
    </footer>
  );
}

function shortenPath(path: string): string {
  // Home collapsing is shared with the tab-title resolver so the two surfaces
  // can never disagree about what home looks like.
  const p = collapseHome(path);
  const parts = p.split("/");
  if (parts.length > 4) {
    return `${parts[0]}/…/${parts.slice(-2).join("/")}`;
  }
  return p;
}
