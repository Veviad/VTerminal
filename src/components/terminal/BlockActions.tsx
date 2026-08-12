import { Copy, ClipboardList, RotateCcw, Paperclip, CircleHelp } from "lucide-react";
import type { Block } from "../../lib/types";
import { ptyWrite } from "../../lib/tauri";
import { useAppStore } from "../../stores/appStore";
import { useAiStream, readBlockOutput } from "../../hooks/useAiStream";
import { setAiPanelOpen } from "../../lib/aiPanel";
import { S } from "../../lib/strings";

export function BlockActions({ sessionId, block }: { sessionId: string; block: Block }) {
  const { explainBlock } = useAiStream();
  const failed = block.state === "done" && (block.exitCode ?? 0) !== 0;

  const copyCommand = () => void navigator.clipboard.writeText(block.command);

  const copyOutput = async () => {
    const output = await readBlockOutput(sessionId, block);
    await navigator.clipboard.writeText(output);
  };

  const rerun = () => {
    if (block.command.trim()) void ptyWrite(sessionId, `${block.command}\r`);
  };

  const attach = () => {
    useAppStore.getState().attachBlockToAi(sessionId, block.id);
    setAiPanelOpen(true);
  };

  return (
    <div className="flex items-center gap-0.5 rounded-lg border border-border-subtle bg-bg-card p-0.5 shadow-sm">
      <ActionButton title={S.blocks.copyCommand} onClick={copyCommand}>
        <Copy size={13} />
      </ActionButton>
      <ActionButton title={S.blocks.copyOutput} onClick={() => void copyOutput()}>
        <ClipboardList size={13} />
      </ActionButton>
      <ActionButton title={S.blocks.rerun} onClick={rerun}>
        <RotateCcw size={13} />
      </ActionButton>
      <ActionButton title={S.blocks.attachContext} onClick={attach}>
        <Paperclip size={13} />
      </ActionButton>
      {failed && (
        <button
          onClick={() => void explainBlock(sessionId, block)}
          className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-medium text-error transition-colors duration-100 hover:bg-error-subtle"
          title={S.blocks.explainError}
        >
          <CircleHelp size={13} />
          {S.blocks.explainError}
        </button>
      )}
    </div>
  );
}

function ActionButton({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className="rounded-md p-1 text-text-muted transition-colors duration-100 hover:bg-bg-hover hover:text-text-secondary"
      title={title}
    >
      {children}
    </button>
  );
}
