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
    render(<AiMessageView content={'[Open docs](https://example.com/docs?q=terminal#links "Docs")'} />);

    const link = screen.getByRole("link", { name: "Open docs" });
    expect(link).toHaveAttribute("href", "https://example.com/docs?q=terminal#links");
    expect(link).toHaveAttribute("title", "Docs");
    expect(fireEvent.click(link)).toBe(false);
    expect(openUrl).toHaveBeenCalledOnce();
    expect(openUrl).toHaveBeenCalledWith("https://example.com/docs?q=terminal#links");
  });

  it("also keeps middle clicks out of the webview", () => {
    render(<AiMessageView content="[Open docs](https://example.com/docs)" />);

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
    render(<AiMessageView content={content} />);

    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(openUrl).not.toHaveBeenCalled();
  });
});
