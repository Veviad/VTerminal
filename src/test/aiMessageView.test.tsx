import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AiMessageView } from "../components/ai/AiMessageView";

const { openUrl } = vi.hoisted(() => ({ openUrl: vi.fn() }));

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl }));

describe("AiMessageView links", () => {
  beforeEach(() => {
    openUrl.mockReset();
  });

  it("opens absolute web links with the operating system instead of navigating the webview", () => {
    render(<AiMessageView content={'[Open docs](https://example.com/docs?q=terminal#links "Docs")'} origin="model" />);

    const link = screen.getByRole("link", { name: "Open docs" });
    expect(link).toHaveAttribute("href", "https://example.com/docs?q=terminal#links");
    expect(link).toHaveAttribute("title", "Docs");
    expect(fireEvent.click(link)).toBe(false);
    expect(openUrl).toHaveBeenCalledOnce();
    expect(openUrl).toHaveBeenCalledWith("https://example.com/docs?q=terminal#links");
  });

  it("also keeps middle clicks out of the webview", () => {
    render(<AiMessageView content="[Open docs](https://example.com/docs)" origin="model" />);

    const link = screen.getByRole("link", { name: "Open docs" });
    expect(
      fireEvent(
        link,
        new MouseEvent("auxclick", { bubbles: true, button: 1, cancelable: true }),
      ),
    ).toBe(false);
    expect(openUrl).toHaveBeenCalledOnce();
    expect(openUrl).toHaveBeenCalledWith("https://example.com/docs");
  });

  it.each([
    ["relative paths", "[Local](/settings)"],
    ["non-web schemes", "[File](file:///etc/passwd)"],
  ])("renders %s as inert text", (_label, content) => {
    render(<AiMessageView content={content} origin="model" />);

    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(openUrl).not.toHaveBeenCalled();
  });
});

describe("AiMessageView origin", () => {
  const wrapped = [
    "<finish>",
    "<summary>",
    "Model answer",
    "</summary>",
    "</finish>",
  ].join("\n");

  it("cleans known control markup from model prose", () => {
    const { container } = render(<AiMessageView content={wrapped} origin="model" />);

    expect(container).toHaveTextContent("Model answer");
    expect(container).not.toHaveTextContent("<finish>");
    expect(container).not.toHaveTextContent("<summary>");
  });

  it("hides an ambiguous opening prefix only while model output is streaming", () => {
    const live = render(
      <AiMessageView content="<finish>" origin="model" streaming />,
    );
    expect(live.container).not.toHaveTextContent("<finish>");
    live.unmount();

    const finalized = render(
      <AiMessageView content="<finish>" origin="model" />,
    );
    expect(finalized.container).toHaveTextContent("<finish>");
  });

  it("renders the screenshot-shaped summary as Markdown without wrapper text", () => {
    const screenshotOutput = [
      "Great! The package check completed and the shell prompt returned.",
      "",
      "<finish> <summary> ## Issue Found and Fixed",
      "",
      "- The update list completed.",
      "- The terminal is ready for another command.",
      "",
      "```sh",
      "sudo -n apt list --upgradable",
      "```",
      "",
      "</summary> </finish>",
    ].join("\n");

    const { container } = render(
      <AiMessageView content={screenshotOutput} origin="model" />,
    );

    expect(screen.getByText(/Great! The package check completed/)).toBeVisible();
    expect(
      screen.getByRole("heading", { level: 2, name: "Issue Found and Fixed" }),
    ).toBeVisible();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(container.querySelector("pre code")).toHaveTextContent(
      "sudo -n apt list --upgradable",
    );
    expect(container).not.toHaveTextContent("<finish>");
    expect(container).not.toHaveTextContent("<summary>");
  });

  it("renders identical user or tool data literally", () => {
    const { container } = render(<AiMessageView content={wrapped} origin="literal" />);

    expect(container).toHaveTextContent("<finish>");
    expect(container).toHaveTextContent("<summary>");
    expect(container).toHaveTextContent("Model answer");
  });

  it("does not apply citation cleanup to literal data", () => {
    const content = '<cite index="1-1">tool result</cite>';
    const { container } = render(<AiMessageView content={content} origin="literal" />);

    expect(container).toHaveTextContent('<cite index="1-1">');
    expect(container).toHaveTextContent("tool result");
    expect(container).toHaveTextContent("</cite>");
  });
});
