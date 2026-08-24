import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { SshHost } from "../lib/types";
import { S } from "../lib/strings";
import { useAppStore } from "../stores/appStore";

const mocks = vi.hoisted(() => ({
  list: vi.fn<() => Promise<SshHost[]>>(),
  create: vi.fn<(...args: unknown[]) => Promise<string>>(),
  update: vi.fn<(...args: unknown[]) => Promise<void>>(),
  setCredential: vi.fn<(...args: unknown[]) => Promise<void>>(),
}));

vi.mock("../lib/tauri", () => ({
  sshHostsList: () => mocks.list(),
  sshHostsCreate: (...args: unknown[]) => mocks.create(...args),
  sshHostsUpdate: (...args: unknown[]) => mocks.update(...args),
  sshHostsSetPassword: (...args: unknown[]) => mocks.setCredential(...args),
  sshHostsDelete: vi.fn(() => Promise.resolve()),
  sshHostsScanConfig: vi.fn(() => Promise.resolve([])),
  sshHostsImport: vi.fn(() => Promise.resolve(0)),
  sshWslIdentityRoot: vi.fn(() => Promise.resolve(null)),
  sshWslPathFromHost: vi.fn((path: string) => Promise.resolve(path)),
}));

vi.mock("../hooks/useSessions", () => ({
  useSessions: () => ({ createSession: vi.fn() }),
}));

vi.mock("../lib/sshConnect", () => ({
  connectToHost: vi.fn(() => Promise.resolve(null)),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(() => Promise.resolve(null)),
}));

const { SshHostsSection } = await import("../components/settings/SshHostsSection");

const savedHost: SshHost = {
  id: "host-1",
  label: "Production web",
  hostname: "prod-01.example.com",
  username: "deploy",
  port: null,
  identity_file: null,
  jump_host: null,
  extra_args: null,
  remote_dir: null,
  post_connect: null,
  tag: null,
  color: null,
  source: "manual",
  config_alias: null,
  use_count: 0,
  last_used_at: null,
  created_at: "2026-08-24T00:00:00.000Z",
  updated_at: "2026-08-24T00:00:00.000Z",
  has_password: true,
};

describe("SshHostsSection passwords", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.list.mockResolvedValue([]);
    mocks.create.mockResolvedValue("host-new");
    mocks.update.mockResolvedValue(undefined);
    mocks.setCredential.mockResolvedValue(undefined);
    useAppStore.setState({ credentialStoreStatus: "ready" });
  });

  it("sends a new host password through the separate create argument", async () => {
    render(<SshHostsSection />);
    fireEvent.click(await screen.findByText(S.settings.sshHosts.add));
    fireEvent.change(screen.getByPlaceholderText("Production web"), {
      target: { value: "Production" },
    });
    fireEvent.change(screen.getByPlaceholderText("prod-01.example.com"), {
      target: { value: "prod-01.example.com" },
    });
    fireEvent.change(screen.getByLabelText(S.settings.sshHosts.password), {
      target: { value: " saved secret " },
    });
    fireEvent.click(screen.getByText(S.settings.sshHosts.save));

    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1));
    expect(mocks.create.mock.calls[0]?.[1]).toBe(" saved secret ");
    expect(JSON.stringify(mocks.create.mock.calls[0]?.[0])).not.toContain("saved secret");
  });

  it("replaces or clears an existing password without reading it back", async () => {
    mocks.list.mockResolvedValue([savedHost]);
    const { unmount } = render(<SshHostsSection />);
    fireEvent.click(await screen.findByTitle(S.settings.sshHosts.edit));
    const secretInput = screen.getByLabelText(S.settings.sshHosts.password) as HTMLInputElement;
    expect(secretInput.value).toBe("");
    expect(secretInput.placeholder).toBe(S.settings.sshHosts.passwordStored);
    fireEvent.change(secretInput, { target: { value: "replacement" } });
    fireEvent.click(screen.getByText(S.settings.sshHosts.save));

    await waitFor(() =>
      expect(mocks.setCredential).toHaveBeenCalledWith(savedHost.id, "replacement"),
    );
    unmount();

    render(<SshHostsSection />);
    fireEvent.click(await screen.findByTitle(S.settings.sshHosts.edit));
    fireEvent.click(screen.getByText(S.settings.sshHosts.removePassword));
    fireEvent.click(screen.getByText(S.settings.sshHosts.save));
    await waitFor(() => expect(mocks.setCredential).toHaveBeenCalledWith(savedHost.id, ""));
  });
});
