import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KnowledgeBucketRef, TerminalContext } from "../lib/types";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
  Channel: class<T> {
    onmessage?: (message: T) => void;
  },
}));

import { agentStart } from "../lib/tauri";

beforeEach(() => invokeMock.mockReset());

describe("agent API", () => {
  it("sends attached Qdrant buckets under Tauri's camelCase command key", async () => {
    invokeMock.mockResolvedValue([]);
    const context: TerminalContext = {
      session_id: "session-1",
      cwd: "/Users/test/project",
      shell: "/bin/zsh",
      git_branch: null,
      os: "macos",
      recent_blocks: [],
      remote: null,
      screen_tail: "",
      shell_integration: true,
    };
    const docBuckets: KnowledgeBucketRef[] = [
      {
        source: "qdrant",
        connection_id: "connection-1",
        collection: "manuals",
      },
    ];

    await agentStart("request-1", "Search the manuals", context, [], [], docBuckets, vi.fn());

    expect(invokeMock).toHaveBeenCalledOnce();
    const [command, args] = invokeMock.mock.calls[0];
    expect(command).toBe("agent_start");
    expect(args).toMatchObject({
      requestId: "request-1",
      docBuckets,
    });
    expect(args).not.toHaveProperty("doc_buckets");
  });
});
