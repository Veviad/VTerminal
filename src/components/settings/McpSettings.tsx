import {
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type FormEvent,
  type SetStateAction,
} from "react";
import {
  Check,
  Copy,
  ExternalLink,
  FileJson,
  Play,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import * as api from "../../lib/tauri";
import type {
  McpAuthMode,
  McpServerConfig,
  McpServerView,
} from "../../lib/types";
import { useAppStore } from "../../stores/appStore";

const emptyHttp = (): McpServerConfig => ({
  version: 1,
  id: "",
  name: "",
  enabled: true,
  default_for_new_chats: false,
  revision: 1,
  transport: {
    type: "streamable_http",
    url: "https://",
    auth: { mode: "none", scopes: [] },
    headers: [],
  },
  timeouts: { startup_ms: 10_000, list_ms: 30_000, call_ms: 60_000 },
  disabled_tools: [],
  trust_hash: null,
});

const emptyStdio = (): McpServerConfig => ({
  ...emptyHttp(),
  transport: {
    type: "stdio",
    command: "npx",
    args: ["-y", ""],
    cwd: null,
    env: [],
    sandbox: { allow_read: [], allow_write: [], allowed_domains: [] },
  },
});

const inputClass =
  "w-full rounded-md border border-border-subtle bg-bg-secondary px-2.5 py-2 text-[12px] text-text-primary outline-none focus:border-accent";
const buttonClass =
  "rounded-md border border-border-subtle px-2.5 py-1.5 text-[11px] text-text-secondary transition hover:bg-bg-hover hover:text-text-primary disabled:opacity-40";

interface KeyValueEntry {
  name: string;
  value?: string;
  secret?: boolean;
}

export function KeyValueEditor({
  label,
  entries,
  slotPrefix,
  forceSecret,
  keyPlaceholder,
  valuePlaceholder,
  addLabel,
  secrets,
  setSecrets,
  onChange,
}: {
  label: string;
  entries: KeyValueEntry[];
  slotPrefix: "header" | "env";
  forceSecret: boolean;
  keyPlaceholder: string;
  valuePlaceholder: string;
  addLabel: string;
  secrets: Record<string, string>;
  setSecrets: Dispatch<SetStateAction<Record<string, string>>>;
  onChange: (entries: KeyValueEntry[]) => void;
}) {
  const slot = (name: string) => `${slotPrefix}:${name}`;
  return (
    <div className="space-y-2">
      <p className="text-[11px] text-text-muted">{label}</p>
      {entries.map((entry, index) => {
        const isSecret = forceSecret || Boolean(entry.secret);
        return (
          <div
            className={
              forceSecret
                ? "flex gap-2"
                : "grid grid-cols-[1fr_1fr_auto_auto] gap-2"
            }
            key={`${slotPrefix}-${index}`}
          >
            <input
              className={inputClass}
              placeholder={keyPlaceholder}
              value={entry.name}
              onChange={(event) => {
                const nextName = event.target.value;
                const oldSlot = slot(entry.name);
                const nextSlot = slot(nextName);
                const nextEntries = [...entries];
                nextEntries[index] = { ...entry, name: nextName };
                setSecrets((current) => {
                  if (!(oldSlot in current)) return current;
                  const next = { ...current, [nextSlot]: current[oldSlot] };
                  delete next[oldSlot];
                  return next;
                });
                onChange(nextEntries);
              }}
            />
            <input
              type={isSecret ? "password" : "text"}
              className={inputClass}
              placeholder={isSecret ? valuePlaceholder : "Value"}
              value={isSecret ? (secrets[slot(entry.name)] ?? "") : entry.value ?? ""}
              onChange={(event) => {
                if (isSecret) {
                  setSecrets((current) => ({
                    ...current,
                    [slot(entry.name)]: event.target.value,
                  }));
                  return;
                }
                const nextEntries = [...entries];
                nextEntries[index] = { ...entry, value: event.target.value };
                onChange(nextEntries);
              }}
            />
            {!forceSecret && (
              <label className="flex items-center gap-1 text-[10px] text-text-muted">
                <input
                  type="checkbox"
                  checked={isSecret}
                  onChange={(event) => {
                    const secret = event.target.checked;
                    const nextEntries = [...entries];
                    const secretSlot = slot(entry.name);
                    if (secret) {
                      if (entry.value) {
                        setSecrets((current) => ({
                          ...current,
                          [secretSlot]: entry.value ?? "",
                        }));
                      }
                      nextEntries[index] = { ...entry, value: "", secret: true };
                    } else {
                      nextEntries[index] = {
                        ...entry,
                        value: secrets[secretSlot] ?? "",
                        secret: false,
                      };
                      setSecrets((current) => {
                        const next = { ...current };
                        delete next[secretSlot];
                        return next;
                      });
                    }
                    onChange(nextEntries);
                  }}
                />
                Secret
              </label>
            )}
            <button
              type="button"
              className={buttonClass}
              onClick={() => {
                setSecrets((current) => {
                  const next = { ...current };
                  delete next[slot(entry.name)];
                  return next;
                });
                onChange(entries.filter((_, at) => at !== index));
              }}
            >
              Remove
            </button>
          </div>
        );
      })}
      <button
        type="button"
        className={buttonClass}
        onClick={() =>
          onChange([
            ...entries,
            forceSecret
              ? { name: "" }
              : { name: "", value: "", secret: false },
          ])
        }
      >
        {addLabel}
      </button>
    </div>
  );
}

function asConfig(
  value: unknown,
): { config: McpServerConfig; secrets: Record<string, string> }[] {
  if (!value || typeof value !== "object")
    throw new Error("JSON must contain a server object");
  const root = value as Record<string, unknown>;
  const entries =
    root.mcpServers && typeof root.mcpServers === "object"
      ? Object.entries(root.mcpServers as Record<string, unknown>)
      : root.servers && typeof root.servers === "object"
        ? Object.entries(root.servers as Record<string, unknown>)
        : [[String(root.name ?? "Imported MCP"), root] as [string, unknown]];
  return entries.map(([name, raw]) => {
    if (!raw || typeof raw !== "object")
      throw new Error(`${name} is not a server object`);
    const server = raw as Record<string, any>;
    if (server.transport?.type) {
      const base =
        server.transport.type === "stdio" ? emptyStdio() : emptyHttp();
      const transport = structuredClone(server.transport) as Record<
        string,
        any
      >;
      const values: Record<string, string> = {};
      if (transport.type === "stdio" && Array.isArray(transport.env)) {
        transport.env = transport.env.map((entry: Record<string, unknown>) => {
          if (
            entry.secret &&
            entry.value != null &&
            String(entry.value) !== ""
          ) {
            values[`env:${String(entry.name ?? "")}`] = String(entry.value);
          }
          return {
            ...entry,
            value: entry.secret ? "" : String(entry.value ?? ""),
          };
        });
      }
      if (transport.type === "streamable_http") {
        transport.headers = Array.isArray(transport.headers)
          ? transport.headers.map((header: Record<string, unknown>) => {
              if (header.value != null && String(header.value) !== "") {
                values[`header:${String(header.name ?? "")}`] = String(
                  header.value,
                );
              }
              return { name: String(header.name ?? "") };
            })
          : [];
        if (transport.auth?.token || transport.auth?.bearer_token) {
          values.bearer = String(
            transport.auth.token ?? transport.auth.bearer_token,
          );
          delete transport.auth.token;
          delete transport.auth.bearer_token;
        }
        if (transport.auth?.client_secret) {
          values.oauth_client_secret = String(transport.auth.client_secret);
          delete transport.auth.client_secret;
        }
      }
      return {
        config: {
          ...base,
          ...server,
          transport,
          id: server.id ?? "",
          name: server.name ?? name,
        } as McpServerConfig,
        secrets: values,
      };
    }
    if (server.command || server.type === "stdio") {
      const values: Record<string, string> = {};
      const env = Object.entries(
        (server.env ?? {}) as Record<string, unknown>,
      ).map(([key, item]) => {
        values[`env:${key}`] = String(item ?? "");
        return { name: key, value: "", secret: true };
      });
      const config = emptyStdio();
      config.name = name;
      config.transport = {
        type: "stdio",
        command: String(server.command ?? ""),
        args: Array.isArray(server.args) ? server.args.map(String) : [],
        cwd: typeof server.cwd === "string" ? server.cwd : null,
        env,
        sandbox: server.sandbox ?? {
          allow_read: [],
          allow_write: [],
          allowed_domains: [],
        },
      };
      return { config, secrets: values };
    }
    const url = String(server.url ?? server.endpoint ?? "");
    if (!url) throw new Error(`${name} has neither command nor URL`);
    const values: Record<string, string> = {};
    const headerNames: { name: string }[] = [];
    let mode: McpAuthMode = "none";
    for (const [header, item] of Object.entries(
      (server.headers ?? {}) as Record<string, unknown>,
    )) {
      if (
        header.toLowerCase() === "authorization" &&
        /^Bearer /i.test(String(item))
      ) {
        mode = "bearer";
        values.bearer = String(item).replace(/^Bearer\s+/i, "");
      } else {
        headerNames.push({ name: header });
        values[`header:${header}`] = String(item ?? "");
      }
    }
    const config = emptyHttp();
    config.name = name;
    config.transport = {
      type: "streamable_http",
      url,
      auth: { mode, scopes: [] },
      headers: headerNames,
    };
    return { config, secrets: values };
  });
}

export function McpSettings() {
  const servers = useAppStore((state) => state.mcpServers);
  const setServers = useAppStore((state) => state.setMcpServers);
  const [draft, setDraft] = useState<McpServerConfig | null>(null);
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [advanced, setAdvanced] = useState(false);
  const [jsonText, setJsonText] = useState("");
  const [sandbox, setSandbox] = useState<string>("Checking local sandbox…");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [logs, setLogs] = useState<string | null>(null);

  const refresh = async () => {
    const rows = await api.mcpServersList();
    setServers(rows);
  };

  useEffect(() => {
    void refresh().catch((error) => setNotice(String(error)));
    void api
      .mcpSandboxStatus()
      .then((status) => setSandbox(status.message))
      .catch((error) => setSandbox(String(error)));
  }, []);

  const preview = useMemo(() => {
    if (!draft) return "";
    let value = draft;
    if (advanced && jsonText.trim()) {
      try {
        value = JSON.parse(jsonText) as McpServerConfig;
      } catch {
        return "Invalid JSON";
      }
    }
    if (value.transport.type === "streamable_http") return value.transport.url;
    return JSON.stringify([value.transport.command, ...value.transport.args]);
  }, [advanced, draft, jsonText]);

  const trustServer = async (server: McpServerView) => {
    const target =
      server.transport.type === "streamable_http"
        ? server.transport.url
        : JSON.stringify([server.transport.command, ...server.transport.args]);
    const grants =
      server.transport.type === "stdio"
        ? `

Read-only: ${server.transport.sandbox.allow_read.join(", ") || "none"}
Writable: ${server.transport.sandbox.allow_write.join(", ") || "private per-server cache only"}
Network: ${server.transport.sandbox.allowed_domains.join(", ") || "none"}`
        : "";
    if (
      !window.confirm(
        `Trust and allow this MCP server to start?

${target}${grants}

Every individual tool call will still require approval.`,
      )
    ) {
      return;
    }
    setBusy(server.id);
    try {
      await api.mcpServerTrust(server.id);
      await refresh();
    } catch (error) {
      setNotice(String(error));
    } finally {
      setBusy(null);
    }
  };

  const edit = (server: McpServerView) => {
    const {
      trusted: _trusted,
      missing_secret_slots: _missing,
      runtime: _runtime,
      oauth: _oauth,
      ...config
    } = server;
    setDraft(structuredClone(config));
    setSecrets({});
    setAdvanced(false);
    setJsonText(JSON.stringify(config, null, 2));
    setNotice(null);
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft) return;
    setBusy("save");
    setNotice(null);
    try {
      const value = advanced
        ? (JSON.parse(jsonText) as McpServerConfig)
        : draft;
      await api.mcpServerUpsert(value, secrets);
      setDraft(null);
      setSecrets({});
      await refresh();
    } catch (error) {
      setNotice(String(error));
    } finally {
      setBusy(null);
    }
  };

  const mutate = async (
    server: McpServerView,
    patch: Partial<McpServerConfig>,
  ) => {
    const {
      trusted: _trusted,
      missing_secret_slots: _missing,
      runtime: _runtime,
      oauth: _oauth,
      ...config
    } = server;
    await api.mcpServerUpsert({ ...config, ...patch });
    await refresh();
  };

  const connectOAuth = async (server: McpServerView) => {
    setBusy(server.id);
    setNotice(null);
    try {
      const started = await api.mcpOauthStart(server.id);
      if (!started.browser_opened) {
        try {
          await navigator.clipboard.writeText(started.authorization_url);
          setNotice(
            "The authorization URL was copied because the browser could not be opened. Complete authorization, then return here.",
          );
        } catch {
          window.prompt(
            "Open this authorization URL in your browser:",
            started.authorization_url,
          );
          setNotice(
            "Complete authorization in your browser, then return here.",
          );
        }
      } else {
        setNotice(
          "Complete authorization in your browser. VTerminal is waiting for the secure loopback callback…",
        );
      }
      const connected = await api.mcpOauthFinish(server.id);
      setNotice(
        `Connected to ${server.name}${connected.granted_scopes.length ? ` with scopes: ${connected.granted_scopes.join(", ")}` : ""}.`,
      );
      await refresh();
    } catch (error) {
      setNotice(String(error));
    } finally {
      setBusy(null);
    }
  };

  const importJson = async () => {
    try {
      const imported = asConfig(JSON.parse(jsonText));
      for (const item of imported)
        await api.mcpServerUpsert(item.config, item.secrets);
      setNotice(
        `Imported ${imported.length} MCP server${imported.length === 1 ? "" : "s"}. Secrets were moved to the credential vault.`,
      );
      setDraft(null);
      await refresh();
    } catch (error) {
      setNotice(String(error));
    }
  };

  if (draft) {
    const transport = draft.transport;
    return (
      <form className="space-y-4" onSubmit={save}>
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-[14px] font-semibold text-text-primary">
              {draft.id ? "Edit MCP server" : "Add MCP server"}
            </h2>
            <p className="mt-1 text-[11px] text-text-muted">
              Server code starts only after an explicit trust confirmation.
            </p>
          </div>
          <button
            type="button"
            className={buttonClass}
            onClick={() => setDraft(null)}
          >
            Cancel
          </button>
        </div>

        <div className="flex gap-2">
          <button
            type="button"
            className={buttonClass}
            onClick={() => {
              setAdvanced(false);
              setDraft({
                ...emptyHttp(),
                name: draft.name,
                id: draft.id,
                revision: draft.revision,
              });
            }}
          >
            Remote HTTP
          </button>
          <button
            type="button"
            className={buttonClass}
            onClick={() => {
              setAdvanced(false);
              setDraft({
                ...emptyStdio(),
                name: draft.name,
                id: draft.id,
                revision: draft.revision,
              });
            }}
          >
            Local stdio
          </button>
          <button
            type="button"
            className={buttonClass}
            onClick={() => {
              setAdvanced(true);
              setJsonText(JSON.stringify(draft, null, 2));
            }}
          >
            <FileJson size={13} className="me-1 inline" />
            Advanced JSON
          </button>
        </div>

        {advanced ? (
          <div className="space-y-2">
            <textarea
              className={`${inputClass} min-h-72 font-mono`}
              value={jsonText}
              onChange={(event) => setJsonText(event.target.value)}
              spellCheck={false}
            />
            <button type="button" className={buttonClass} onClick={importJson}>
              Import Claude / VS Code JSON
            </button>
          </div>
        ) : (
          <>
            <label className="block text-[11px] text-text-muted">
              Display name
              <input
                required
                className={`${inputClass} mt-1`}
                value={draft.name}
                onChange={(event) =>
                  setDraft({ ...draft, name: event.target.value })
                }
              />
            </label>
            {transport.type === "streamable_http" ? (
              <div className="space-y-3">
                <label className="block text-[11px] text-text-muted">
                  Streamable HTTP URL
                  <input
                    required
                    className={`${inputClass} mt-1 font-mono`}
                    value={transport.url}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        transport: { ...transport, url: event.target.value },
                      })
                    }
                  />
                </label>
                <label className="block text-[11px] text-text-muted">
                  Authentication
                  <select
                    className={`${inputClass} mt-1`}
                    value={transport.auth.mode}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        transport: {
                          ...transport,
                          auth: {
                            ...transport.auth,
                            mode: event.target.value as McpAuthMode,
                          },
                        },
                      })
                    }
                  >
                    <option value="none">None</option>
                    <option value="oauth">OAuth 2.1</option>
                    <option value="bearer">Bearer token</option>
                    <option value="headers">Custom headers</option>
                  </select>
                </label>
                {transport.auth.mode === "bearer" && (
                  <label className="block text-[11px] text-text-muted">
                    Bearer token
                    <input
                      type="password"
                      className={`${inputClass} mt-1`}
                      placeholder={
                        draft.id ? "Leave empty to keep stored token" : "Token"
                      }
                      value={secrets.bearer ?? ""}
                      onChange={(event) =>
                        setSecrets({ ...secrets, bearer: event.target.value })
                      }
                    />
                  </label>
                )}
                {transport.auth.mode === "oauth" && (
                  <div className="space-y-2">
                    <label className="block text-[11px] text-text-muted">
                      Scopes (space separated)
                      <input
                        className={`${inputClass} mt-1`}
                        value={transport.auth.scopes.join(" ")}
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            transport: {
                              ...transport,
                              auth: {
                                ...transport.auth,
                                scopes: event.target.value
                                  .split(/\s+/)
                                  .filter(Boolean),
                              },
                            },
                          })
                        }
                      />
                    </label>
                    <label className="block text-[11px] text-text-muted">
                      Client ID or client-ID metadata URL (optional)
                      <input
                        className={`${inputClass} mt-1 font-mono`}
                        value={transport.auth.client_id ?? ""}
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            transport: {
                              ...transport,
                              auth: {
                                ...transport.auth,
                                client_id: event.target.value || null,
                              },
                            },
                          })
                        }
                      />
                    </label>
                    <label className="block text-[11px] text-text-muted">
                      Client secret (optional)
                      <input
                        type="password"
                        className={`${inputClass} mt-1`}
                        placeholder={
                          draft.id
                            ? "Leave empty to keep stored secret"
                            : "Client secret"
                        }
                        value={secrets.oauth_client_secret ?? ""}
                        onChange={(event) =>
                          setSecrets({
                            ...secrets,
                            oauth_client_secret: event.target.value,
                          })
                        }
                      />
                    </label>
                    <label className="block text-[11px] text-text-muted">
                      Loopback callback port (optional)
                      <input
                        type="number"
                        min={1024}
                        max={65535}
                        className={`${inputClass} mt-1`}
                        value={transport.auth.callback_port ?? ""}
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            transport: {
                              ...transport,
                              auth: {
                                ...transport.auth,
                                callback_port: event.target.value
                                  ? Number(event.target.value)
                                  : null,
                              },
                            },
                          })
                        }
                      />
                    </label>
                    <p className="rounded-md border border-border-subtle bg-bg-secondary p-2 text-[11px] text-text-muted">
                      Save the server, review trust, then use Connect on its
                      card. PKCE S256, state validation, resource indicators and
                      discovered authorization metadata are required.
                    </p>
                  </div>
                )}
                <KeyValueEditor
                  label="Custom secret headers"
                  entries={transport.headers}
                  slotPrefix="header"
                  forceSecret
                  keyPlaceholder="Header name"
                  valuePlaceholder="Value (stored in vault)"
                  addLabel="Add header"
                  secrets={secrets}
                  setSecrets={setSecrets}
                  onChange={(headers) =>
                    setDraft({
                      ...draft,
                      transport: {
                        ...transport,
                        headers: headers.map(({ name }) => ({ name })),
                      },
                    })
                  }
                />
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className={buttonClass}
                    onClick={() =>
                      setDraft({
                        ...draft,
                        transport: {
                          ...transport,
                          command: "npx",
                          args: ["-y", ""],
                          sandbox: {
                            ...transport.sandbox,
                            allowed_domains: [],
                          },
                        },
                      })
                    }
                  >
                    npx
                  </button>
                  <button
                    type="button"
                    className={buttonClass}
                    onClick={() =>
                      setDraft({
                        ...draft,
                        transport: {
                          ...transport,
                          command: "uvx",
                          args: [""],
                          sandbox: {
                            ...transport.sandbox,
                            allowed_domains: [],
                          },
                        },
                      })
                    }
                  >
                    uvx
                  </button>
                  <button
                    type="button"
                    className={buttonClass}
                    onClick={() =>
                      setDraft({
                        ...draft,
                        transport: {
                          ...transport,
                          command: "docker",
                          args: [
                            "run",
                            "--rm",
                            "-i",
                            "--read-only",
                            "--cap-drop=ALL",
                            "--security-opt=no-new-privileges",
                            "--network=none",
                            "",
                          ],
                          sandbox: {
                            ...transport.sandbox,
                            allowed_domains: [],
                          },
                        },
                      })
                    }
                  >
                    Locked-down Docker
                  </button>
                </div>
                <label className="block text-[11px] text-text-muted">
                  Executable
                  <input
                    required
                    className={`${inputClass} mt-1 font-mono`}
                    value={transport.command}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        transport: {
                          ...transport,
                          command: event.target.value,
                        },
                      })
                    }
                  />
                </label>
                <label className="block text-[11px] text-text-muted">
                  Arguments (one per line)
                  <textarea
                    className={`${inputClass} mt-1 min-h-28 font-mono`}
                    value={transport.args.join("\n")}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        transport: {
                          ...transport,
                          args: event.target.value.split("\n"),
                        },
                      })
                    }
                  />
                </label>
                <label className="block text-[11px] text-text-muted">
                  Fixed working directory
                  <input
                    className={`${inputClass} mt-1 font-mono`}
                    value={transport.cwd ?? ""}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        transport: {
                          ...transport,
                          cwd: event.target.value || null,
                        },
                      })
                    }
                  />
                </label>
                <KeyValueEditor
                  label="Environment variables"
                  entries={transport.env}
                  slotPrefix="env"
                  forceSecret={false}
                  keyPlaceholder="NAME"
                  valuePlaceholder="Stored in vault"
                  addLabel="Add environment variable"
                  secrets={secrets}
                  setSecrets={setSecrets}
                  onChange={(env) =>
                    setDraft({
                      ...draft,
                      transport: {
                        ...transport,
                        env: env.map((entry) => ({
                          name: entry.name,
                          value: entry.value ?? "",
                          secret: Boolean(entry.secret),
                        })),
                      },
                    })
                  }
                />
                <label className="block text-[11px] text-text-muted">
                  Read-only paths (one per line)
                  <textarea
                    className={`${inputClass} mt-1 min-h-20 font-mono`}
                    value={transport.sandbox.allow_read.join("\n")}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        transport: {
                          ...transport,
                          sandbox: {
                            ...transport.sandbox,
                            allow_read: event.target.value
                              .split("\n")
                              .filter(Boolean),
                          },
                        },
                      })
                    }
                  />
                </label>
                <label className="block text-[11px] text-text-muted">
                  Writable paths (one per line)
                  <textarea
                    className={`${inputClass} mt-1 min-h-20 font-mono`}
                    value={transport.sandbox.allow_write.join("\n")}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        transport: {
                          ...transport,
                          sandbox: {
                            ...transport.sandbox,
                            allow_write: event.target.value
                              .split("\n")
                              .filter(Boolean),
                          },
                        },
                      })
                    }
                  />
                </label>
                <label className="block text-[11px] text-text-muted">
                  Allowed network domains (one per line)
                  <textarea
                    className={`${inputClass} mt-1 min-h-20 font-mono`}
                    value={transport.sandbox.allowed_domains.join("\n")}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        transport: {
                          ...transport,
                          sandbox: {
                            ...transport.sandbox,
                            allowed_domains: event.target.value
                              .split("\n")
                              .map((item) => item.trim().toLowerCase())
                              .filter(Boolean),
                          },
                        },
                      })
                    }
                  />
                </label>
              </div>
            )}
          </>
        )}
        <div className="rounded-md bg-bg-secondary p-2 font-mono text-[10px] text-text-muted">
          <span className="font-sans">Exact launch target: </span>
          {preview}
        </div>
        {notice && <p className="text-[11px] text-danger">{notice}</p>}
        <button
          disabled={busy !== null}
          className="rounded-md bg-accent px-3 py-2 text-[12px] font-medium text-white disabled:opacity-50"
        >
          Save server
        </button>
      </form>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-[14px] font-semibold text-text-primary">
            Model Context Protocol
          </h2>
          <p className="mt-1 text-[11px] leading-relaxed text-text-muted">
            Connect remote Streamable HTTP servers or sandboxed local stdio
            servers. Every tool call still asks for approval.
          </p>
        </div>
        <button className={buttonClass} onClick={() => setDraft(emptyHttp())}>
          <Plus size={13} className="me-1 inline" />
          Add server
        </button>
      </div>
      <div className="rounded-md border border-border-subtle bg-bg-secondary p-2 text-[11px] text-text-muted">
        <ShieldCheck size={13} className="me-1 inline" />
        Local sandbox: {sandbox}
      </div>
      {servers.length === 0 && (
        <div className="rounded-lg border border-dashed border-border-subtle p-6 text-center text-[12px] text-text-muted">
          No MCP servers configured.
        </div>
      )}
      {servers.map((server) => (
        <div
          key={server.id}
          className="space-y-3 rounded-lg border border-border-subtle bg-bg-secondary p-3"
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-[13px] font-medium text-text-primary">
                {server.name}
              </p>
              <p className="mt-0.5 font-mono text-[10px] text-text-muted">
                {server.transport.type === "streamable_http"
                  ? server.transport.url
                  : JSON.stringify([
                      server.transport.command,
                      ...server.transport.args,
                    ])}
              </p>
              {server.oauth?.authenticated && (
                <p className="mt-1 text-[10px] text-success">
                  OAuth connected
                  {server.oauth.granted_scopes.length
                    ? ` · ${server.oauth.granted_scopes.join(", ")}`
                    : ""}
                </p>
              )}
              {server.runtime.tool_count != null && (
                <p className="mt-1 text-[10px] text-text-muted">
                  {server.runtime.tool_count} discovered tool
                  {server.runtime.tool_count === 1 ? "" : "s"}
                </p>
              )}
            </div>
            <span
              className={`rounded-full px-2 py-0.5 text-[10px] ${server.runtime.connected ? "bg-success/15 text-success" : server.missing_secret_slots.length ? "bg-danger/15 text-danger" : "bg-bg-hover text-text-muted"}`}
            >
              {server.runtime.connected
                ? "Connected"
                : server.missing_secret_slots.length
                  ? "Authentication needed"
                  : "Stopped"}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1.5 text-[11px] text-text-secondary">
              <input
                type="checkbox"
                checked={server.enabled}
                onChange={(event) =>
                  void mutate(server, { enabled: event.target.checked })
                }
              />
              Enabled
            </label>
            <label className="flex items-center gap-1.5 text-[11px] text-text-secondary">
              <input
                type="checkbox"
                checked={server.default_for_new_chats}
                onChange={(event) =>
                  void mutate(server, {
                    default_for_new_chats: event.target.checked,
                  })
                }
              />
              Default for new chats
            </label>
          </div>
          <div className="flex flex-wrap gap-2">
            {!server.trusted && (
              <button
                className={buttonClass}
                onClick={() => void trustServer(server)}
              >
                <ShieldCheck size={12} className="me-1 inline" />
                Review & trust
              </button>
            )}
            {server.transport.type === "streamable_http" &&
              server.transport.auth.mode === "oauth" && (
                <>
                  {!server.oauth?.authenticated ? (
                    <button
                      disabled={!server.trusted || busy === server.id}
                      className={buttonClass}
                      onClick={() => void connectOAuth(server)}
                    >
                      <ExternalLink size={12} className="me-1 inline" />
                      Connect OAuth
                    </button>
                  ) : (
                    <>
                      <button
                        disabled={busy === server.id}
                        className={buttonClass}
                        onClick={() => void connectOAuth(server)}
                      >
                        Reconnect OAuth
                      </button>
                      <button
                        disabled={busy === server.id}
                        className={buttonClass}
                        onClick={async () => {
                          setBusy(server.id);
                          try {
                            const result = await api.mcpOauthRevoke(server.id);
                            setNotice(
                              result.revoked_remotely
                                ? "OAuth authorization revoked."
                                : "Local OAuth credentials removed. The authorization server did not confirm remote revocation.",
                            );
                            await refresh();
                          } catch (error) {
                            setNotice(String(error));
                          } finally {
                            setBusy(null);
                          }
                        }}
                      >
                        Revoke OAuth
                      </button>
                    </>
                  )}
                </>
              )}
            {server.runtime.connected ? (
              <button
                disabled={busy === server.id}
                className={buttonClass}
                onClick={async () => {
                  setBusy(server.id);
                  try {
                    await api.mcpServerDisconnect(server.id);
                    await refresh();
                  } catch (error) {
                    setNotice(String(error));
                  } finally {
                    setBusy(null);
                  }
                }}
              >
                Stop
              </button>
            ) : (
              <button
                disabled={
                  !server.trusted ||
                  busy === server.id ||
                  server.missing_secret_slots.length > 0
                }
                className={buttonClass}
                onClick={async () => {
                  setBusy(server.id);
                  try {
                    const tools = await api.mcpServerConnect(server.id);
                    setNotice(
                      `${server.name} started with ${tools.length} tool${tools.length === 1 ? "" : "s"}.`,
                    );
                    await refresh();
                  } catch (error) {
                    setNotice(String(error));
                  } finally {
                    setBusy(null);
                  }
                }}
              >
                Start
              </button>
            )}
            <button
              disabled={!server.trusted || busy === server.id}
              className={buttonClass}
              onClick={async () => {
                setBusy(server.id);
                try {
                  const tools = await api.mcpServerTest(server.id);
                  setNotice(
                    `${server.name}: ${tools.length} valid tool${tools.length === 1 ? "" : "s"}.`,
                  );
                } catch (error) {
                  setNotice(String(error));
                } finally {
                  setBusy(null);
                  await refresh();
                }
              }}
            >
              <Play size={12} className="me-1 inline" />
              Test
            </button>
            <button className={buttonClass} onClick={() => edit(server)}>
              Edit
            </button>
            <button
              className={buttonClass}
              onClick={async () => setLogs(await api.mcpLogs(server.id))}
            >
              Logs
            </button>
            <button
              className={buttonClass}
              onClick={async () => {
                await api.mcpForgetApprovals(server.id);
                setNotice(`Forgot approvals for ${server.name}.`);
              }}
            >
              Forget approvals
            </button>
            <button
              className={buttonClass}
              onClick={async () => {
                if (
                  window.confirm(
                    `Delete ${server.name}? Stored secrets will also be removed.`,
                  )
                ) {
                  await api.mcpServerDelete(server.id);
                  await refresh();
                }
              }}
            >
              <Trash2 size={12} className="me-1 inline" />
              Delete
            </button>
          </div>
        </div>
      ))}
      <div className="flex gap-2">
        <button
          className={buttonClass}
          onClick={async () => {
            await navigator.clipboard.writeText(
              JSON.stringify(await api.mcpExportRedacted(), null, 2),
            );
            setNotice("Redacted MCP JSON copied.");
          }}
        >
          <Copy size={12} className="me-1 inline" />
          Copy redacted JSON
        </button>
        <button
          className={buttonClass}
          onClick={() => {
            setDraft(emptyHttp());
            setAdvanced(true);
            setJsonText("");
          }}
        >
          <FileJson size={12} className="me-1 inline" />
          Import JSON
        </button>
        <button className={buttonClass} onClick={() => void refresh()}>
          <RefreshCw size={12} />
        </button>
      </div>
      {notice && <p className="text-[11px] text-text-muted">{notice}</p>}
      {logs !== null && (
        <div className="space-y-2">
          <div className="flex justify-between">
            <p className="text-[11px] font-medium text-text-primary">
              Redacted MCP logs
            </p>
            <button className={buttonClass} onClick={() => setLogs(null)}>
              <Check size={12} />
            </button>
          </div>
          <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded-md bg-bg-tertiary p-2 text-[10px] text-text-muted">
            {logs || "No logs yet."}
          </pre>
        </div>
      )}
    </div>
  );
}
