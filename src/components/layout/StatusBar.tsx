import { Server } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "../../stores/appStore";
import { describeRemote } from "../../lib/nesting";
import { collapseHome } from "../../lib/sessionTitle";
import { S } from "../../lib/strings";
import { useChatStore } from "../../stores/chatStore";

export function StatusBar() {
  const workspaceMode = useChatStore((state) => state.workspaceMode);
  return workspaceMode === "chat" ? <ChatStatusBar /> : <TerminalStatusBar />;
}

function ChatStatusBar() {
  const modelLabel = useChatStore((state) => state.stream.model);
  const streaming = useChatStore((state) => state.stream.status === "streaming");
  const bucketCount = useChatStore((state) => state.current?.attached_bucket_refs.length ?? 0);
  const activeLabel = useAppStore(
    (state) => state.catalog.find((model) => model.id === state.activeModelId)?.label ?? null,
  );
  const web = useAppStore((state) => {
    const model = state.catalog.find((entry) => entry.id === state.activeModelId);
    return !state.aiWebAccess ? "web off"
      : model?.native_web_search && model.native_web_fetch ? "web ready" : "web unsupported";
  });
  return (
    <footer className="flex h-7 shrink-0 items-center justify-between border-t border-border-subtle px-4 text-[10px] bg-bg-primary text-text-muted">
      <span className="font-mono">{modelLabel ?? activeLabel ?? S.statusBar.noModel}</span>
      <span className="flex items-center gap-3">
        <span>{web}</span>
        <span>{bucketCount ? `${bucketCount} Knowledge source${bucketCount === 1 ? "" : "s"}` : "Knowledge not attached"}</span>
        {streaming && <span className="flex items-center gap-1.5 text-accent"><span className="h-1 w-1 animate-pulse rounded-full bg-accent" />{S.statusBar.generating}</span>}
      </span>
    </footer>
  );
}

function TerminalStatusBar() {
  const modelState = useAppStore((state) => state.modelState);
  const aiReady = useAppStore((state) => state.aiReady());
  const activeLabel = useAppStore(
    (state) => state.catalog.find((model) => model.id === state.activeModelId)?.label ?? null,
  );
  const activeRenderer = useAppStore((state) => state.activeRenderer);
  const termDims = useAppStore((state) => state.termDims);
  const streaming = useAppStore((state) => Object.values(state.aiStreams).some((stream) => stream.status === "streaming"));
  // Block output, the composer draft and stream deltas are unrelated to the
  // few terminal facts displayed here. Keep them out of the render dependency.
  const ui = useAppStore(useShallow((state) => {
    const active = state.activeSessionId ? state.sessionUi[state.activeSessionId] : undefined;
    return {
      cwd: active?.cwd,
      gitBranch: active?.gitBranch,
      remote: active?.remote ?? null,
      remoteLabel: active?.remoteHost?.label,
    };
  }));
  const dotColor = aiReady ? "bg-accent" : modelState === "loading" ? "bg-warning" : "bg-text-muted";
  const cwd = ui.cwd;
  const remote = ui.remote;

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
            {ui.remoteLabel ?? describeRemote(remote)}
          </span>
        ) : (
          <>
            {/* No opacity here: this row is already text-muted, and 70% of it put
                the most-read string in the status bar at 1.82:1. */}
            {cwd && <span className="truncate font-mono">{shortenPath(cwd)}</span>}
            {ui.gitBranch && (
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
