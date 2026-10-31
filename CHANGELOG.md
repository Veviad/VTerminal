# Changelog

## 0.6.13

- Stream final Agent answers and show native web-search and MCP activity; preserve reading position during output.
- Show requested commands without execution wrappers and improve terminal control-sequence, progress, and Unicode handling.
- Preserve instruction edits across overlapping saves and retries; strengthen sensitive-output detection and bind SSH password autofill to one validated connection attempt, with manual entry for ambiguous authentication.
- Add GPT-6.1 Terra and fix runbook validation and history selection races.
- Keep schedules bound to their saved plan, target, working directory, and permission limits; improve cancellation and timezone handling and reject unattended SSH terminal execution without verified authentication.

## 0.6.12

- Prevent Escape from terminal search reaching the shell and altering the next command.
- Show an agent’s follow-up response separately when a message or attachment is queued during generation.
- Preserve retry state when queued-message delivery fails or is cancelled.

## 0.6.11

- Preserve queued agent attachments and retry state through provider responses and restored sessions.
- Protect SSH commands with remote prompt confirmation and original-target binding; recognize `command ssh` sessions.
- Fix terminal input ordering, binary input, resizing, output capture, and search selection cleanup.
- Add explicit runbook target platforms, preserve remote Docker context for approved commands, and include an OrbStack cleanup example.
- Fix the Windows unit-test manifest required for Common Controls v6.

## 0.6.10

- Stabilize Windows console-probe tests by allowing cold PowerShell/.NET startup while retaining bounded execution and the no-console assertion.
- Refresh frontend dependencies: lucide-react 1.61.0, Zustand 5.0.16, Tauri CLI 2.12.4, and Vite 8.3.5.
- Refresh Rust dependencies: Tauri 2.12.5, Tokio 1.54.1, rmcp 3.7.0, MiniJinja and minijinja-contrib 3.0.2, libc 0.2.191, plist 1.10.3, and tauri-build 2.7.4.
- Update the Rust cache action to 2.9.3 across CI and release builds.

## 0.6.9

- Render leaked `invoke`/`parameter` finish wrappers as readable Agent summaries in live and saved replies, while preserving literal user messages, tool output, and code examples.

## 0.6.8

- Remember each terminal tab's Ask or Agent selection across restarts, including tabs with saved conversations, while retaining configured defaults for new tabs and command approval on restored Agent tabs.

## 0.6.7

- Preserve shell tracking when startup tools replace the local shell, covering saved-host reconnect and local Agent commands without editing user profiles or depending on a particular CLI.
- Bind terminal prompt reports to a private per-tab scope before startup, preventing remote or unrelated prompt messages from claiming local shell ownership.
- Distinguish unavailable connection tracking from disconnection, offer a new SSH tab when the current connection cannot be verified, and explain missing shell integration instead of reporting a busy foreground program.
- Repair all generated integration assets when missing or corrupted, including the login-stage startup file.

## 0.6.6

- Fixed SSH sessions incorrectly showing “not connected” when remote shell prompt markers ended local connection tracking, preventing nested reconnects and preserving remote AI context.
- Updated cloud tiers to Claude Haiku/Sonnet/Opus 5.5, GPT-6 Luna/GPT-6.1 Sol/GPT-6 Astra, and Mistral Small 4/Medium 3.5/Large 4 Preview, retaining saved model selections and effort preferences.
- Updated adaptive thinking and reasoning controls to each current model's supported settings, including Sonnet's lowest thinking mode and always-on reasoning models.
- Refreshed dependencies from open Dependabot updates and adjusted provider integration for the current OpenAI Responses API.

## 0.4.4

- Added first-class MCP tools in Ask and Agent with per-chat multi-server selection, defaults, tool switches, approvals, archive persistence, and progressive tool discovery.
- Added Streamable HTTP/JSON/SSE and local stdio transports with modern MCP 2026-07-28 discovery plus compatible legacy lifecycle fallback.
- Added OAuth 2.1 with metadata discovery, PKCE, loopback callback, refresh rotation and revocation, plus bearer/custom-header authentication.
- Added guided and advanced MCP settings, Claude/VS Code JSON import, redacted export, status, Start/Stop/Test, logs, tool counts, and trust review.
- Added fail-closed local isolation: macOS Seatbelt with a domain-filtering loopback proxy, plus WSL2 bubblewrap namespaces, a bundled Linux relay, authenticated Rust allowlist proxy, and seccomp supervisor with no unsandboxed fallback.
- Aligned application, JavaScript package, Cargo package, lockfile, and Tauri bundle versions with 0.4.4 from main.
