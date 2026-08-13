# VTerminal

A lean, AI-powered terminal for macOS — Warp-style command blocks and an AI agent, without the bulk. Local models run **in-process** with Metal acceleration: no Ollama, no vLLM, no daemon to babysit. Cloud models sit behind the same interface, so switching between on-device and frontier models is one keystroke.

**[Download 0.1.2 for macOS](https://github.com/Veviad/VTerminal/releases/download/v0.1.2/VTerminal_0.1.2_aarch64.dmg)** (Apple Silicon, 11 MB) · **[vterminal.veviad.com](https://vterminal.veviad.com)**

The sections below build from source. If you just want to run the app, take the download above — it already includes on-device inference, and a locally built app is the one case that skips the Gatekeeper prompt.

![platform](https://img.shields.io/badge/macOS-Apple%20Silicon-black)
![stack](https://img.shields.io/badge/Tauri%202-Rust-informational)
![ui](https://img.shields.io/badge/React%2019-Tailwind%204-informational)
![license](https://img.shields.io/badge/license-GPL--3.0-blue)

> **Status: early.** VTerminal is pre-1.0 (`0.1.2`) and developed in the open. It is used daily by its author, but expect rough edges and breaking changes between versions.

---

## Why

Modern AI terminals tend to be Electron apps that phone home for every completion. VTerminal takes the opposite position:

- **Your shell, not a reimplementation.** A real `zsh -il` login shell over a PTY. vim, htop, tmux, and `ssh` all behave exactly as they do in Terminal.app.
- **On-device by default.** The default model is a 9B GGUF running inside the app process via llama.cpp. Nothing leaves the machine unless you pick a cloud model.
- **Nothing runs without you.** Model-authored commands always pass an approval gate. Natural-language suggestions are *inserted* into your prompt, never executed.

## Features

**Terminal**
- Real `zsh` login shell via `portable-pty`, xterm.js 6 with a WebGL renderer, tabs, split search
- Flow-controlled output — `cat`-ing a gigabyte file won't balloon memory
- Full TUI support, and saved SSH hosts with one-click connect

**Command blocks**
- OSC 133 shell integration marks every command: exit-code badges, copy command or output, re-run, attach as AI context
- Restored tabs never reconnect on their own — an `ssh` tab offers *Reconnect* instead

**AI**
- **Command suggestion** (⌘I, or `#` at an empty prompt) — describe the goal, get a command inserted into your prompt
- **Explain & fix** — one click on a failed block streams a diagnosis and a corrected command
- **Ask** — a chat panel with your blocks, output, and files as context
- **Agent mode** — multi-step runs that propose commands, execute them in your *visible* terminal, and read the real output
- **Per-model reasoning effort** — `off → low → medium → high → max`, showing only the rungs each model actually accepts
- **Image & file attachments** — drag, paste, or pick. An optional on-device vision sidecar transcribes screenshots so even a non-vision chat model can use them.

**Interface**
- Six themes — Veviad Developer UI (default), Veviad UI, Midnight, Nord, Solarized Dark, Light — each with a matched terminal ANSI palette
- ⌘K palette for actions, persistent command history, and model switching
- Resizable AI panel that keeps its proportion when you resize the window

## Requirements

| | |
|---|---|
| **OS** | macOS on Apple Silicon (Intel is untested) |
| **Node** | 20 or newer |
| **Rust** | pinned by `rust-toolchain.toml` |
| **Xcode CLT** | `xcode-select --install` |
| **cmake** | `brew install cmake` — **only** for the `local-llm` feature |

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

> The first `local-llm` build compiles llama.cpp and its Metal kernels — budget **10–30 minutes**. Incremental builds afterwards are normal speed.

Then open **Settings → Models**, download **Qwen3.5 9B** (~5.3 GB), and press **Load**.

Release build:

```bash
npm run tauri build -- --features local-llm
```

## Experimental updates

Version 0.1.2 establishes VTerminal's signed update chain for future macOS Apple Silicon releases. Open **Settings → Updates** to check manually or opt in to automatic checks.

- **Automatic updates are off by default.** Enabling them checks immediately, then every 24 hours.
- **Stable releases and prereleases share one channel.** Manual **Check now** remains available while automatic checks are disabled.
- **Installation is never silent.** VTerminal shows the release notes and asks before downloading, installing, and restarting; running terminal processes stop during the restart.
- **Updater archives are cryptographically verified.** This signature is separate from the app's current ad-hoc Apple code signature and Gatekeeper status.

## Models

**On-device** (GGUF, downloaded from Hugging Face with resumable transfers)

| Model | Notes |
|---|---|
| Qwen3.5 4B / 9B | 9B is the default — sized to run on a 32 GB M1 Pro |
| Qwen3.6 27B | needs a large-memory machine |
| Gemma 4 E2B / E4B / 31B | |

**Cloud** — bring your own API key; keys are stored by the Rust backend and never round-trip to the UI.

- Anthropic — Claude Haiku 4.5, Sonnet 5, Opus 5
- OpenAI — GPT-5.6 Luna, Terra, Sol
- Mistral — Mistral Small 4, Magistral Medium, Mistral Large 3

**Self-hosted** — point VTerminal at any OpenAI-compatible server: Ollama, LM Studio, llama.cpp's server, vLLM, LiteLLM. Add the address in **Settings → Models**, press **Test**, and pick which of the served models to expose. Per-server tokens are supported and optional.

**Vision sidecar** *(optional, on-device)* — PaddleOCR-VL 1.6, Qwen3-VL 4B, or Qwen3-VL 8B, loaded alongside the chat model to transcribe attached images.

## How command execution is gated

This matters more in a terminal than anywhere else, so it is worth being precise:

- Every command a model proposes is **classified** on two independent axes — is it read-only, and does it reach the network — and both are shown on the approval card.
- The **permission mode** is per-session, never persisted, and never inherited. Arming it *is* the authorization.
- Commands run in your **visible PTY**, so you see exactly what ran, and it runs wherever that tab is — including over `ssh`.
- Commands you edit before approving are treated as *your* text, not the model's.

When web access is disabled, VTerminal withholds the model's fetch tooling and rejects network-shaped commands before an approval card is even drawn.

> **This is a safety rail, not a sandbox.** It cannot see through a script the agent wrote earlier, a shell alias in your dotfiles, or an obfuscated one-liner. It is deliberately documented as best-effort, and should not be relied on as a security boundary.

## Keyboard

| Key | Action |
|---|---|
| ⌘T / ⌘W | New / close tab |
| ⌘1…9 | Jump to tab |
| ⌘K | Command palette |
| ⌘I | AI command suggestion |
| ⌘J | Toggle AI panel |
| ⌘F | Search terminal |
| ⌘, | Settings |
| ⌘= / ⌘- / ⌘0 | Font size |

## Architecture

**Rust** (`src-tauri/`)
- PTY sessions on dedicated reader threads, streaming raw bytes over Tauri channels with watermark-based flow control
- A single `Provider` trait covering in-process llama.cpp (feature `local-llm`), Anthropic, OpenAI, Mistral, and any user-configured OpenAI-compatible server
- A curated model catalog carrying each model's tier, legal reasoning-effort rungs, and RAM floor
- Prompts rendered from each GGUF's own Jinja chat template, so native tool-calling and thinking modes work per model family
- Two-tier persistence: a settings store plus SQLite (WAL, versioned migrations) for history and archived transcripts

**React** (`src/`)
- xterm instances live in a registry *outside* React state, which keeps them StrictMode-safe; only the active tab holds a WebGL context
- Command blocks are overlay decorations driven by live xterm markers, not stored line numbers
- One zustand store with per-session maps; settings persist through Rust only

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

The project page at [vterminal.veviad.com](https://vterminal.veviad.com) is hand-written static HTML in `docs/` — no build step and no dependencies. Preview it with `npx vite docs`; pushing a change to `docs/` on `main` deploys it.

## Contributing

Issues and pull requests are welcome. Please open an issue before starting substantial work so we can agree on the approach first.

Note that VTerminal is GPL-3.0 licensed and its copyright is held by Veviad. If you intend to contribute regularly, contact us first — contributions may need a licensing agreement to keep future relicensing possible.

## License

Copyright (C) 2026 Veviad

VTerminal is free software: you may redistribute and modify it under the terms of the **GNU General Public License, version 3** as published by the Free Software Foundation. See [LICENSE](LICENSE) for the full text.

It is distributed in the hope that it will be useful, but **without any warranty** — without even the implied warranty of merchantability or fitness for a particular purpose.

In short: use it freely, privately or commercially, and modify it as you like. If you distribute a modified version, that version must also be GPL-3.0 and its source must be available.
