# Windows 11 WSL2 beta

VTerminal's Windows beta targets Windows 11 x64 and the default WSL2
distribution. The terminal backend is deliberately fixed to Bash inside that
distribution. PowerShell, cmd, distro selection, Windows 10, ARM64, MSI, and
Microsoft Store packages are not supported in this beta.

## Prerequisites

Run these in PowerShell before installing VTerminal:

```powershell
wsl.exe --status
wsl.exe --list --verbose
wsl.exe --exec /bin/bash --noprofile --norc -c "/usr/bin/printf 'Bash is ready\n'"
```

The default distribution (marked `*`) must report version `2`. It must provide
`/bin/bash`, `/bin/sh`, `/bin/true`, `/usr/bin/env`, `/usr/bin/setsid`,
`/usr/bin/printf`, and the standard `base64`, `tr`, `grep`, `ps`, `awk`, `sort`,
and `sleep` commands. The absolute `printf` path is required by the agent and
Runbook terminal bridge; a shell builtin alone is not sufficient.
VTerminal reports missing WSL, WSL1, Bash, or required integration tools with
setup guidance; it never performs an administrator-level WSL installation or
upgrade.
Microsoft's current setup instructions are at
<https://learn.microsoft.com/windows/wsl/install>.

## Download, verify, and install

Download the `VTerminal_<version>_x64-setup.exe` installer and
`SHA256SUMS.txt` from the same GitHub release. In PowerShell, run:

```powershell
Get-FileHash .\VTerminal_<version>_x64-setup.exe -Algorithm SHA256
Get-Content .\SHA256SUMS.txt
Get-AuthenticodeSignature .\VTerminal_<version>_x64-setup.exe
```

The first hash must match the installer entry in `SHA256SUMS.txt`, and the
Authenticode `Status` must be `Valid`. Then run the installer. It installs for
the current user and bootstraps WebView2 when the runtime is absent; it does not
request an administrator-level WSL installation.

On first launch, VTerminal checks the default WSL distribution and Bash. After
setup or repair, close and reopen VTerminal. New PowerShell windows also pick up
the managed `vterminal-docs.exe` PATH entry; already-open shells retain their old
environment.

To upgrade, run the newer signed installer or approve an update in
**Settings → Updates**. Uninstall through **Settings → Apps → Installed apps**.
Uninstall removes only VTerminal's exact managed CLI PATH entry and does not
remove WSL, distributions, models, or unrelated PATH entries.

## Build from source

Install Node.js, the pinned Rust toolchain, Visual Studio Build Tools with the
MSVC/Windows SDK workload, CMake, and the Vulkan SDK. Then run:

```powershell
npm run build:windows
```

This produces a per-user NSIS installer. The build contains dynamically loaded
CPU and Vulkan llama.cpp backends; the same installer starts without a Vulkan
device and retries model allocation entirely on CPU when GPU loading fails.
The managed PATH transformation can be exercised without touching the registry:

```powershell
.\scripts\windows-cli-path.tests.ps1
```

Production builds use `npm run build:windows:signed` and require:

- .NET 8, Azure CLI, `artifact-signing-cli`, and a current Windows SDK containing
  Authenticode inspection tools

- `TAURI_SIGNING_PRIVATE_KEY` and optional password for updater signatures
- `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, and `AZURE_TENANT_ID`
- `AZURE_ARTIFACT_SIGNING_ENDPOINT`, `AZURE_ARTIFACT_SIGNING_ACCOUNT`, and
  `AZURE_ARTIFACT_SIGNING_PROFILE`

The sidecar and backend DLLs are signed first. Tauri then signs the application
and NSIS installer before creating the updater signature, so updater verification
covers the exact Authenticode-signed bytes.

## Troubleshooting

### VTerminal says WSL is missing or WSL1

Run `wsl.exe --status` and `wsl.exe --list --verbose`. Install WSL by following
Microsoft's guide, convert the intended distribution to version 2 if necessary,
and make it the default. VTerminal deliberately does not do this administrative
work.

### VTerminal says Bash or required tools are missing

Confirm the default distribution is the one you intend to use, then run:

```powershell
wsl.exe --exec /bin/bash --noprofile --norc -c "/usr/bin/printf 'Bash is ready\n'"
```

Install Bash and the standard tools listed in **Prerequisites** inside that
distribution, or choose a distribution that provides them as the WSL default.
Distro and shell selection are outside this beta.

### A restored tab falls back to home

Saved terminal directories are Linux paths inside WSL. If a directory was
renamed, deleted, or belongs to another distribution, VTerminal starts in the
WSL home directory and prints a visible warning. Change to a valid Linux path
and close the tab normally so the next workspace snapshot records it.

### The companion CLI is not found

Open **Settings → Knowledge → Command-line access** and choose **Repair CLI**.
Then open a new PowerShell window. The managed executable is
`%LOCALAPPDATA%\Programs\VTerminal\bin\vterminal-docs.exe`.

### Local inference uses CPU

Open **Settings → Models** and inspect the accelerator and fallback reason.
Update the GPU driver if it does not expose a working Vulkan device. CPU fallback
is intentional and uses the same installer; CUDA-specific packages are not part
of this beta. Chat, vision, and embedding hosts retain their own accelerator
status. The system summary aggregates only currently loaded hosts, reports
`mixed` when they use different backends, and returns `unloaded` after the last
host unloads.

## Behavior

- Restored working directories are Linux paths and are passed through
  `wsl.exe --cd` as a separate argument. Missing paths visibly fall back to WSL
  home.
- VTerminal writes versioned integration files under
  `~/.local/share/vterminal/` inside WSL. It does not modify Bash dotfiles.
- App shortcuts use `Ctrl+Shift`; terminal copy/paste use `Ctrl+Shift+C/V`, and
  plain `Ctrl+C` remains interrupt.
- Credentials use Windows Credential Manager. App data and Runbook artifacts
  use user-only ACLs; Runbook host paths reject UNC paths, non-NTFS volumes, and
  reparse points.
- `vterminal-docs.exe` is managed at
  `%LOCALAPPDATA%\Programs\VTerminal\bin`. Setup and the Settings repair action
  manage only that exact user PATH entry.

## Clean-VM acceptance

Before publishing a Windows beta, exercise this checklist on clean Windows 11
x64 VMs and retain the installer hashes and logs with the release candidate:

1. Verify Authenticode is `Valid` for the application, installer, companion CLI,
   and every bundled backend DLL. Install, upgrade, updater-failure recovery,
   rollback behavior, and uninstall must leave no VTerminal process or managed
   PATH entry behind. Confirm the final workspace/archive flush completes after
   updater verification and before installer handoff.
2. Verify ConPTY read/write/resize, Unicode, CRLF, Ctrl+C, sleep/resume, more than
   1 MB of unacknowledged output, command/cwd/exit OSC reporting, custom Bash
   profiles, spaces and non-ASCII Linux paths, and invalid-cwd fallback. Exercise
   every `Ctrl+Shift` app shortcut plus terminal `Ctrl+Shift+C/V`, while plain
   `Ctrl+C` continues to interrupt the foreground command.
3. Verify missing WSL, WSL1, and a WSL2 distribution without Bash or another
   required integration tool are blocked with guidance rather than an attempted
   installation.
4. Verify Credential Manager create/read/delete and legacy migration, companion
   CLI status/repair, saved SSH commands, and Runbook rejection of UNC, reparse,
   non-local, and non-NTFS destinations.
5. Generate chat, vision, and embeddings on representative NVIDIA, AMD, and
   Intel Vulkan systems and a no-GPU VM. Force a low-memory Vulkan allocation
   failure and confirm automatic CPU retry plus the visible fallback reason.
6. Exercise WebView2 installation and an already-installed WebView2 runtime,
   terminal clipboard selection/paste, host file and directory dialogs, PDF text
   extraction, image/vision attachment handling, external links, and display
   recovery after sleep/resume on clean Windows 11 VMs.

The repository's required Windows validation runs three `windows-latest` jobs
in parallel. The core job compiles and tests the feature-off configuration and
produces an NSIS smoke bundle with only the companion sidecar and common
installer resources. The local-model verification job runs Clippy and tests
against both CPU and Vulkan support, while the package job independently
produces the production-shaped NSIS smoke containing both backends. Verification
and release artifacts use separate immutable caches, each written by exactly one
job on trusted `main` pushes; pull requests only restore them. A monthly
scheduled workflow runs all three jobs without restoring or saving a cache to
preserve clean-build coverage. Windows CI also disables incremental compilation
and development/test debug information because hosted runners do not retain a
debugging session and those artifacts substantially increase MSVC work and cache
size.
Windows local-inference builds require CMake's Ninja generator in addition to
the MSVC toolchain and pinned Vulkan SDK; `scripts/build-windows.ps1` verifies
Ninja and selects it explicitly before Cargo configures llama.cpp. The script
also uses a drive-root Cargo target directory (`C:\vt` locally and `<workspace
drive>:\t` in CI) so llama.cpp's nested Vulkan shader build stays below MSVC's
effective path limit and the cache targets the directory Cargo actually uses.
The hardware and WSL lifecycle checks above remain release acceptance tests
because hosted CI cannot represent the required driver and clean-VM matrix.
