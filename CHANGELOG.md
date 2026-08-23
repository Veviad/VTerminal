# Changelog

## 0.4.0

- Added first-class MCP tools in Ask and Agent with per-chat multi-server selection, defaults, tool switches, approvals, archive persistence, and progressive tool discovery.
- Added Streamable HTTP/JSON/SSE and local stdio transports with modern MCP 2026-07-28 discovery plus compatible legacy lifecycle fallback.
- Added OAuth 2.1 with metadata discovery, PKCE, loopback callback, refresh rotation and revocation, plus bearer/custom-header authentication.
- Added guided and advanced MCP settings, Claude/VS Code JSON import, redacted export, status, Start/Stop/Test, logs, tool counts, and trust review.
- Added fail-closed local isolation: macOS Seatbelt with a domain-filtering loopback proxy, plus WSL2 bubblewrap namespaces, a bundled Linux relay, authenticated Rust allowlist proxy, and seccomp supervisor with no unsandboxed fallback.
- Bumped application, JavaScript package, Cargo package, lockfile, and Tauri bundle versions to 0.4.0.
