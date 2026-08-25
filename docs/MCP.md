# MCP in VTerminal 0.4.4

VTerminal can use tools from several Model Context Protocol servers in both Ask and Agent mode. Ask receives only MCP tools; Agent also retains its terminal and Knowledge tools. Every MCP call asks for approval unless you explicitly remember that exact tool for that exact server and schema.

## Add a server

Open **Settings → MCP → Add server**.

For a remote server, choose **Remote HTTP**, enter its Streamable HTTP endpoint, then select no authentication, OAuth 2.1, a bearer token, or custom secret headers.

OAuth uses discovered protected-resource and authorization-server metadata, PKCE S256, state validation, resource indicators, and a loopback callback. A pre-registered client ID, client-ID metadata document, optional client secret, scopes, and fixed callback port can be supplied. After saving and trusting the endpoint, choose **Connect OAuth**.

For a local server, choose **Local stdio**. The guided editor accepts an executable, an argument per line, a fixed working directory, environment entries, and sandbox grants. Templates are included for npx, uvx, and a locked-down Docker invocation. Commands and arguments are always passed as arrays and are never interpolated into a shell.

The advanced editor accepts a VTerminal server object, a Claude-style mcpServers object, or a VS Code-style servers object.

Inline bearer values, headers, OAuth client secrets, and secret environment values are moved into the operating-system credential vault during import. Redacted export never includes them.

Example local configuration:

    {
      "mcpServers": {
        "GitHub": {
          "command": "npx",
          "args": ["-y", "@modelcontextprotocol/server-github"],
          "env": {
            "GITHUB_PERSONAL_ACCESS_TOKEN": "secret-value"
          },
          "sandbox": {
            "allow_read": [],
            "allow_write": [],
            "allowed_domains": ["api.github.com"]
          }
        }
      }
    }

## Select tools for a chat

Use the **MCP** chip beside the model and Knowledge controls. Multiple servers can be selected. Expand a selected server to turn individual tools off for that conversation.

Servers marked **Default for new chats** are snapshotted when a new chat is created. Changing defaults does not alter an existing chat. Selection survives archive/reopen; a deleted server remains visibly unavailable until removed from that chat.

Connections are lazy. Each conversation/server pair has an isolated logical session. Removing a server, starting a new chat, closing the tab, editing security-relevant configuration, stopping the server, or exiting VTerminal closes the affected connection and local process tree.

## Approval model

An approval card shows the server, exact tool, description, complete JSON arguments, and schema identity:

- **Allow once**
- **Always allow this tool**
- **Deny**

A remembered approval is bound to the immutable server UUID, configuration revision, exact tool name, and schema fingerprint. It stops matching automatically after a relevant configuration or schema change. Tool annotations such as readOnlyHint are informational only.

## Network and credential security

Remote endpoints require HTTPS except for explicit loopback addresses. URLs containing credentials, fragments, link-local/cloud-metadata targets, or non-HTTP schemes are rejected. The hostname is resolved again before connection and blocked if it resolves to a link-local or special-use destination. Private/LAN endpoints remain possible only after their exact endpoint is reviewed in the trust confirmation.

HTTP redirects never receive VTerminal credentials across origins. OAuth tokens, bearer values, secret header values, OAuth registrations/client secrets, and secret environment entries remain in macOS Keychain or Windows Credential Manager. Logs are bounded and credential-redacted.

## Local stdio sandbox

Local MCP is never launched without a successful platform sandbox check.

On macOS, VTerminal launches through Seatbelt (sandbox-exec). The default has no network and no user-file access. Runtime directories are read-only, while each server receives a private temporary home/cache. Project, home, or user-installed executable paths require explicit grants. When domains are allowed, the child can reach only VTerminal's loopback HTTP/SOCKS proxy; direct egress stays denied and the proxy accepts only the configured DNS names and their subdomains.

On Windows, local commands are Linux commands inside the default WSL2 distribution and launch through bubblewrap with private mount/network/PID namespaces, read-only runtime dependencies, and a seccomp-filtered exec supervisor. A bundled Linux relay carries proxy traffic out of the isolated network namespace to a per-launch authenticated Rust HTTP/SOCKS proxy on Windows; that proxy resolves and enforces only the configured DNS names and their subdomains. VTerminal disables local stdio if its WSL2, bubblewrap, namespace, bundled-relay, or seccomp self-test fails. There is no unsandboxed fallback.

Docker configurations must explicitly use --network=none. Privileged mode, host namespaces, host networking, and mounting the Docker engine socket into the MCP container are rejected.

## Protocol and current scope

VTerminal advertises MCP 2026-07-28, uses server/discover and per-request metadata through the official Tier-1 Rust SDK, negotiates mutually supported versions, and falls back to the legacy initialization lifecycle when required. Streamable HTTP supports JSON and request-scoped SSE responses. Tool discovery is paginated, cached, and invalidated by list-change notifications.

If selected schemas exceed 3% of the active model context, VTerminal exposes stable mcp_search_tools and mcp_call_tool broker tools instead of injecting every schema. Tool output supports text, structured JSON, images, audio, embedded resources, and resource-link metadata. Model-visible text/JSON is capped at 64 KiB with an explicit marker. Resource links are never fetched automatically.

Version 0.4.4 implements MCP tools. Resources, prompts, roots, sampling, elicitation, Tasks, and MCP Apps are deferred. An input_required or background-task response is shown as unsupported instead of silently continuing.
