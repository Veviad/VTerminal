import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { RunbookMarkdown } from "../components/runbooks/RunbookMarkdown";

describe("RunbookMarkdown", () => {
  it("does not let imported markdown fetch images or create navigable links", () => {
    const { container } = render(
      <RunbookMarkdown>
        {"[operator guide](https://example.invalid/guide) ![tracking pixel](https://example.invalid/pixel)"}
      </RunbookMarkdown>,
    );

    expect(screen.getByText("operator guide")).toHaveAttribute(
      "title",
      "Link omitted: https://example.invalid/guide",
    );
    expect(screen.getByText("[Image omitted: tracking pixel]")).toBeInTheDocument();
    expect(container.querySelector("a")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
  });
});
