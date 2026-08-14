import { render, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const initialize = vi.hoisted(() => vi.fn());

vi.mock("../hooks/useRunbooks", () => ({
  useRunbooks: () => ({ initialize }),
}));

import { RunbooksWorkspace } from "../components/runbooks/RunbooksWorkspace";
import { useRunbookStore } from "../stores/runbookStore";

beforeEach(() => {
  initialize.mockReset();
  initialize.mockResolvedValue(undefined);
  useRunbookStore.getState().reset();
});

describe("RunbooksWorkspace", () => {
  it("initializes library and history only once when StrictMode replays effects", async () => {
    render(
      <StrictMode>
        <RunbooksWorkspace sessionId={null} />
      </StrictMode>,
    );

    await waitFor(() => expect(initialize).toHaveBeenCalledTimes(1));
  });
});
