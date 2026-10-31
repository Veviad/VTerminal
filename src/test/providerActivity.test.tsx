import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { ProviderActivityFeed } from "../components/ai/ProviderActivityFeed";

it("keeps native activity compact and exposes only fixed status labels", () => {
  const { container, rerender } = render(<ProviderActivityFeed activities={[
    { id: "PRIVATE-ID", kind: "web_search", status: "done" },
    { id: "another", kind: "web_fetch", status: "running" },
  ]} />);
  expect(screen.getByRole("status")).toHaveTextContent("Fetching web page…");
  expect(screen.getByText("Web search · Completed")).not.toBeVisible();
  expect(container).not.toHaveTextContent("PRIVATE-ID");
  fireEvent.click(container.querySelector("summary")!);
  expect(screen.getByText("Web search · Completed")).toBeVisible();
  rerender(<ProviderActivityFeed activities={[
    { id: "PRIVATE-ID", kind: "web_search", status: "done" },
    { id: "another", kind: "web_fetch", status: "cancelled" },
  ]} />);
  expect(screen.getByRole("status")).toHaveTextContent("Cancelled");
  rerender(<ProviderActivityFeed />);
  expect(container).toBeEmptyDOMElement();
});
