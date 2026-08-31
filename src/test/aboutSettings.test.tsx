import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { S } from "../lib/strings";

const { openUrl } = vi.hoisted(() => ({ openUrl: vi.fn(() => Promise.resolve()) }));

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl }));

const { SettingsPage } = await import("../components/settings/SettingsPage");
const { useAppStore } = await import("../stores/appStore");

beforeEach(() => {
  openUrl.mockClear();
  useAppStore.setState({ settingsTab: "about" });
});

describe("About settings", () => {
  it("shows the GPL identifier, permissions notice, and a working license link", () => {
    render(<SettingsPage />);

    expect(screen.getByText(S.settings.about.license)).toBeInTheDocument();
    expect(screen.getByText(S.settings.about.licenseName)).toBeInTheDocument();
    expect(screen.getByText("GPL-3.0-only")).toBeInTheDocument();
    expect(screen.getByText(S.settings.about.licenseNotice)).toBeInTheDocument();
    expect(screen.queryByText(/all rights reserved/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "GPL-3.0-only" }));
    expect(openUrl).toHaveBeenCalledOnce();
    expect(openUrl).toHaveBeenCalledWith("https://www.gnu.org/licenses/gpl-3.0.html");
  });

  it("keeps the shipped GPL metadata and license text in sync", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
      license?: string;
    };
    const cargoToml = readFileSync("src-tauri/Cargo.toml", "utf8");
    const tauriConfig = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8")) as {
      bundle: { copyright?: string; license?: string; licenseFile?: string };
    };
    const licenseText = readFileSync("LICENSE", "utf8");

    expect(packageJson.license).toBe("GPL-3.0-only");
    expect(cargoToml).toMatch(/^license = "GPL-3\.0-only"$/m);
    expect(tauriConfig.bundle.license).toBe("GPL-3.0-only");
    expect(tauriConfig.bundle.licenseFile).toBe("../LICENSE");
    expect(tauriConfig.bundle.copyright).not.toMatch(/all rights reserved/i);
    expect(licenseText).toContain("GNU GENERAL PUBLIC LICENSE");
    expect(licenseText).toContain("Version 3, 29 June 2007");
  });
});
