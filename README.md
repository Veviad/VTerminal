# VTerminal

A lean, AI-powered terminal for macOS and the Windows 11 preview — Warp-style command blocks and an AI agent, without the bulk. Local models run **in-process** with Metal on Mac or Vulkan with CPU fallback on Windows: no Ollama, no vLLM, no daemon to babysit. Cloud models sit behind the same interface.

**[Download the latest release](https://vterminal.veviad.com/#download)** (macOS Apple Silicon or Windows 11 x64 preview) · **[vterminal.veviad.com](https://vterminal.veviad.com)**

The sections below build from source. If you just want to run the app, take the download above — release installers include on-device inference. Published macOS releases beginning with v0.2.3 are Developer ID signed with hardened runtime, notarized by Apple, and stapled for normal Gatekeeper verification. The Windows preview installer is intentionally not Authenticode signed.

On macOS, quit VTerminal completely before replacing `/Applications/VTerminal.app` and eject older disk images. On Windows, run the newer per-user preview installer; it upgrades the existing installation and preserves app data.

![platform](https://img.shields.io/badge/macOS%20%7C%20Windows%2011-Apple%20Silicon%20%7C%20x64-black)
![stack](https://img.shields.io/badge/Tauri%202-Rust-informational)
![ui](https://img.shields.io/badge/React%2019-Tailwind%204-informational)
![license](https://img.shields.io/badge/license-GPL--3.0-blue)

> **Status: early.** VTerminal is pre-1.0 and developed in the open. It is used daily by its author, but expect rough edges and breaking changes between versions.

> **Windows status: preview/testing.** Windows 11 support is not yet considered stable. Its installer is unsigned, so Windows reports an unknown publisher and SmartScreen may require **More info → Run anyway**. Verify the published SHA-256 checksum before running it.

---

## Why

Modern AI terminals tend to be Electron apps that phone home for every completion. VTerminal takes the opposite position:

- **Your shell, not a reimplementation.** A real `zsh -il` on macOS or default-distribution WSL2 Bash on Windows over a native PTY. vim, htop, tmux, and `ssh` behave like they do in the underlying shell.
- **On-device by default.** The default model is a 9B GGUF running inside the app process via llama.cpp. Nothing leaves the machine unless you pick a cloud model.
- **Nothing runs without you.** Model-authored commands always pass an approval gate. Natural-language suggestions are *inserted* into your prompt, never executed.

## Features

**Terminal**
- Real `zsh` on macOS or default-distribution WSL2 Bash on Windows via `portable-pty`, xterm.js 6 with a WebGL renderer, tabs, split search
- Flow-controlled output — `cat`-ing a gigabyte file won't balloon memory
- Full TUI support, and saved SSH hosts with one-click connect

**Command blocks**
- OSC 133 shell integration marks every command: exit-code badges, copy command or output, re-run, attach as AI context
- Restored tabs never reconnect on their own — an `ssh` tab offers *Reconnect* instead

**AI**
- **Command suggestion** (⌘I on macOS, Ctrl+Shift+I on Windows, or `#` at an empty prompt) — describe the goal, get a command inserted into your prompt
- **Explain & fix** — one click on a failed block streams a diagnosis and a corrected command
- **Ask** — a chat panel with your blocks, output, and files as context
- **Agent mode** — multi-step runs that propose commands, execute them in your *visible* terminal, and read the real output
- **Per-model reasoning effort** — `off → low → medium → high → max`, showing only the rungs each model actually accepts
- **Image & file attachments** — drag, paste, or pick. An optional on-device vision sidecar transcribes screenshots so even a non-vision chat model can use them.
- **Knowledge buckets** — attach local SQLite document buckets and compatible Qdrant collections to one Ask or Agent request, with UI-first ingestion and source-qualified citations.
- **Reusable Runbooks** *(experimental and disabled by default)* — versioned YAML checklists with immutable run snapshots, per-action approvals, visible-terminal execution, evidence, and canonical JSON/Markdown reports. See [the authoring guide](docs/RUNBOOKS.md).

**Interface**
- Six themes — Veviad Developer UI (default), Veviad UI, Midnight, Nord, Solarized Dark, Light — each with a matched terminal ANSI palette
- Command palette (⌘K on macOS, Ctrl+Shift+K on Windows), persistent command history, and model switching
- Resizable AI panel that keeps its proportion when you resize the window

## Requirements

| | |
|---|---|
| **OS** | macOS on Apple Silicon, or Windows 11 x64 with WSL2, a default distribution, and Bash |
| **Node** | 20 or newer |
| **Rust** | pinned by `rust-toolchain.toml` |
| **Native tools** | macOS: Xcode CLT; Windows: Visual Studio Build Tools with MSVC and Windows SDK |
| **cmake / Vulkan SDK** | Local inference only; Vulkan SDK is required for a Windows source build |

`cmake` is required because the `local-llm` feature compiles llama.cpp from source. Terminal-only and cloud-only builds do not need it.

## Quick start

```bash
npm install
```

```bash
npm run tauri dev
```

That gives you the terminal plus cloud AI. To add on-device inference:

```bash
npm run tauri dev -- --features local-llm
```

> The first `local-llm` build compiles llama.cpp and its Metal or Vulkan/CPU backends — budget **10–30 minutes**. Incremental builds afterwards are normal speed.

Then open **Settings → Models**, download **Qwen3.5 9B** (~5.3 GB), and press **Load**.

Local optimized build:

```bash
npm run tauri build -- --features local-llm
```

This local artifact uses whatever signing identity is configured on your Mac; it does not reproduce the Developer ID-signed and notarized GitHub release unless you supply the corresponding release signing environment.

On Windows 11, first confirm `wsl.exe --status` reports WSL2 and a default
distribution. Then build the unsigned local NSIS package:

```powershell
npm run build:windows
```

For a downloaded release, fetch the installer and `SHA256SUMS.txt` from the same
GitHub release, then verify the installer in PowerShell before running it:

```powershell
Get-FileHash .\VTerminal_*_x64-setup.exe -Algorithm SHA256
Get-AuthenticodeSignature .\VTerminal_*_x64-setup.exe
```

Compare the first command's hash with `SHA256SUMS.txt`. The preview installer is
expected to report `NotSigned`; the hash is the public download-integrity check.
The installer is per-user and VTerminal checks WSL2/Bash on first launch rather
than making an administrator-level WSL change.

The app launches only the fixed default-distribution WSL2/Bash backend. Native
PowerShell, cmd, distro selection, Windows 10, ARM64, MSI, and Store packaging
are intentionally outside this beta. See the [Windows build, troubleshooting,
and clean-VM acceptance guide](docs/WINDOWS.md).

## Experimental updates

VTerminal includes an experimental cryptographically signed update chain for macOS Apple Silicon and the Windows 11 x64 preview. This updater signature is independent of the Windows preview installer's missing Authenticode publisher signature. Open **Settings → Updates** to check manually or opt in to automatic checks.

- **Automatic updates are off by default.** Enabling them checks immediately, then every 24 hours.
- **Stable releases and prereleases share one channel.** Manual **Check now** remains available while automatic checks are disabled.
- **Installation is never silent.** VTerminal shows the release notes and asks before downloading, installing, and restarting; running terminal processes stop during the restart.
- **Updater payloads are cryptographically verified.** The updater signature is separate from macOS Developer ID/notarization and Windows Authenticode verification.

## Models

Chat, vision and embedding models have separate jobs. Chat models write answers and commands; the optional vision sidecar transcribes attached images; embedding models turn document chunks and queries into vectors for Knowledge retrieval.

**On-device** (GGUF, downloaded from Hugging Face with resumable transfers). Chat and vision model
cards keep their own live progress, speed, ETA, cancel, failure and retry controls directly beneath
the model being downloaded.

| Model | Notes |
|---|---|
| Qwen3.5 4B / 9B | 9B is the default — sized to run on a 32 GB machine |
| Qwen3.6 27B | needs a large-memory machine |
| Gemma 4 E2B / E4B / 31B | |

**Cloud** — bring your own API key; provider keys, Hugging Face tokens, and remote-server tokens are stored by the Rust backend in macOS Keychain or Windows Credential Manager (service `com.veviad.terminal`) and never round-trip to the UI or `settings.json`.

- Anthropic — Claude Haiku 4.5, Sonnet 5, Opus 5
- OpenAI — GPT-5.6 Luna, Terra, Sol
- Mistral — Mistral Small 4, Magistral Medium, Mistral Large 3

**Self-hosted** — point VTerminal at any OpenAI-compatible server: Ollama, LM Studio, llama.cpp's server, vLLM, LiteLLM. Add the address in **Settings → Models**, press **Test**, and pick which of the served models to expose. Per-server tokens are supported and optional; token-bearing connections require HTTPS except for localhost/loopback HTTP.

**Vision sidecar** *(optional, on-device)* — PaddleOCR-VL 1.6, Qwen3-VL 4B, or Qwen3-VL 8B, loaded alongside the chat model to transcribe attached images.

## Knowledge

Settings → Knowledge manages local and remote document buckets, embedding profiles, files and persistent ingestion jobs. A single request can mix keyword-only local buckets, semantic local buckets and multiple compatible Qdrant collections. VTerminal queries each source independently and combines ranked results, so scores from different embedding spaces are never compared as though they were interchangeable.

**One-click local embedding models**

| Model | Packaged profile |
|---|---|
| Qwen3-Embedding 0.6B | Q8, recommended default |
| Qwen3-Embedding 4B | Q4_K_M |
| Qwen3-Embedding 8B | Q4_K_M |
| EmbeddingGemma | Q8, 768 dimensions |
| Multilingual E5 Base | Q8; visible but unavailable until signed Veviad GGUFs pass multilingual parity tests |
| Multilingual E5 Large | Q8; visible but unavailable until signed Veviad GGUFs pass multilingual parity tests |

The built-in artifacts are pinned, checksum-verified, loaded and tested by the app. Users never compile, convert, run Python or choose arbitrary files. OpenAI and Mistral are the only guided cloud embedding providers; Anthropic has no embedding model. Ollama and LM Studio are available only under Advanced after a real embedding probe.

**Qdrant** — add the database REST endpoint (normally port 6333) and a granular database key. VTerminal uses REST only; it does not require or configure Qdrant's gRPC port. Normal Knowledge views show only managed VTerminal collections. Each app-created collection stores its complete, immutable `metadata.vterminal` contract—including profile fingerprint, vector name and payload schema—in Qdrant itself, so another VTerminal client discovers the same bucket without repeating a local mapping wizard. Document identities are derived from the collection and source identity rather than a client-local connection ID, while monotonic staged revisions keep concurrent clients from overwriting newer content. Unmarked collections stay hidden; a v0.2.0 local import binding remains available for one compatibility release as an Advanced, read-only legacy entry.

Qdrant receives extracted manifests, chunks, metadata and vectors, not original binaries. Read-only credentials can attach and search; wider permissions unlock document upload, replace and deletion or collection management. Upload jobs persist immediately, run automatically in the background and stay visible through Extract → Chunk → Embed → Upload, including retryable failures. TurboQuant is an advanced, opt-in sidecar for Qdrant 1.18+; bits4 is recommended, original vectors remain, and confirmed state is read back from Qdrant before the UI reports success.

The standalone `vterminal-docs` CLI installs from the UI into `~/.local/bin` on macOS. The Windows installer places it under `%LOCALAPPDATA%\Programs\VTerminal\bin`, and the Settings action reports or repairs that managed copy. Windows setup manages only that exact user PATH entry, and uninstall removes only the managed entry. It shares the app's saved profiles, connections, model cache, chunking and job records. It can list profiles; list/test connections; list/create/delete buckets; list/ingest/replace/delete documents; and search, with JSON output and stdin support. Text, structured text, page JSON and text-layer PDFs work headlessly; OCR-required inputs direct you to the UI.

Local embedding stays on the device. Qdrant and cloud-provider credentials stay backend-only in the operating-system credential vault. Before the first cloud ingestion, the UI explains that document chunks—and later search queries—will leave the device. Embedding profiles are immutable fingerprints of the exact model, revision, dimensions and query/document transforms; changing any of those creates a new profile and requires re-embedding.

## How command execution is gated

This matters more in a terminal than anywhere else, so it is worth being precise:

- Every command a model proposes is **classified** on two independent axes — is it read-only, and does it reach the network — and both are shown on the approval card.
- The **permission mode** is per-session, never persisted, and never inherited. Arming it *is* the authorization.
- Commands run in your **visible PTY**, so you see exactly what ran, and it runs wherever that tab is — including over `ssh`.
- Commands you edit before approving are treated as *your* text, not the model's.

When web access is disabled, VTerminal withholds the model's fetch tooling and rejects network-shaped commands before an approval card is even drawn.

> **This is a safety rail, not a sandbox.** It cannot see through a script the agent wrote earlier, a shell alias in your dotfiles, or an obfuscated one-liner. It is deliberately documented as best-effort, and should not be relied on as a security boundary.

## Keyboard

| macOS | Windows | Action |
|---|---|---|
| ⌘T / ⌘W | Ctrl+Shift+T / Ctrl+Shift+W | New / close tab |
| ⌘1…9 | Ctrl+Shift+1…9 | Jump to tab |
| ⌘K | Ctrl+Shift+K | Command palette |
| ⌘I | Ctrl+Shift+I | AI command suggestion |
| ⌘J | Ctrl+Shift+J | Toggle AI panel |
| ⌘F | Ctrl+Shift+F | Search terminal |
| ⌘, | Ctrl+Shift+, | Settings |
| ⌘= / ⌘- / ⌘0 | Ctrl+Shift+= / - / 0 | Font size |

Terminal copy and paste on Windows are `Ctrl+Shift+C` / `Ctrl+Shift+V`; plain
`Ctrl+C` remains the shell interrupt.

## Architecture

**Rust** (`src-tauri/`)
- PTY sessions on dedicated reader threads, streaming raw bytes over Tauri channels with watermark-based flow control
- A single `Provider` trait covering in-process llama.cpp (feature `local-llm`), Anthropic, OpenAI, Mistral, and any user-configured OpenAI-compatible server
- A curated model catalog carrying each model's tier, legal reasoning-effort rungs, and RAM floor
- Prompts rendered from each GGUF's own Jinja chat template, so native tool-calling and thinking modes work per model family
- Backend-only credentials in macOS Keychain or Windows Credential Manager; settings store contains presence flags, not secret values
- SQLite (WAL, versioned migrations) for history, transcripts, local knowledge metadata, canonical vectors and rebuildable sqlite-vec indexes
- One asynchronous Knowledge service for hybrid local retrieval, profile-aware Qdrant search, persistent ingestion jobs and deterministic rank fusion

**React** (`src/`)
- xterm instances live in a registry *outside* React state, which keeps them StrictMode-safe; only the active tab holds a WebGL context
- Command blocks are overlay decorations driven by live xterm markers, not stored line numbers
- One zustand store with per-session maps; settings persist through Rust only
- Source-qualified Knowledge attachments and progress-driven model, connection, bucket and document management

## Development

```bash
npm test
```

```bash
cd src-tauri && cargo test
```

Because `local-llm` is a feature gate, `cargo check` alone skips the entire local inference engine — check both configurations before assuming the backend compiles:

```bash
cd src-tauri && cargo check && cargo check --features local-llm
```

Headless smoke examples live in `src-tauri/examples/` and exercise inference, the agent loop, the vision sidecar, and shutdown behaviour against a real GGUF.

The project page at [vterminal.veviad.com](https://vterminal.veviad.com) is hand-written static HTML in `docs/`. GitHub Pages runs the dependency-free renderer in `scripts/site-release/` at deploy time to inject the greatest published SemVer release, download links, stars and application-download counts into a staging copy; the browser makes no GitHub API request. Preview the generic fallbacks with `npx vite docs`, or render the checked-in fixture into a fresh temporary path with `node scripts/site-release/render.mjs --source docs --output "$(mktemp -d)/site" --fixture scripts/site-release/fixtures/releases.json`.

## Contributing

Issues and pull requests are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md)
before starting; substantial changes should begin with an issue so the approach can
be agreed first. Contributions require a Developer Certificate of Origin signoff.

## License

Copyright (C) 2026 Veviad

VTerminal is free software: you may redistribute and modify it under the terms of the **GNU General Public License, version 3** as published by the Free Software Foundation. See [LICENSE](LICENSE) for the full text.

It is distributed in the hope that it will be useful, but **without any warranty** — without even the implied warranty of merchantability or fitness for a particular purpose.

In short: use it freely, privately or commercially, and modify it as you like. If you distribute a modified version, that version must also be GPL-3.0 and its source must be available.
