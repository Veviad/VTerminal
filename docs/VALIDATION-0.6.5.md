# Windows stability validation for 0.6.5

Source baseline: `v0.6.4` (`eb464a1`). Validation date: September 11, 2026.
Local host: macOS, Apple Silicon. The Windows machine's GPU is unknown.

## Diagnosis and correction

The supplied Windows event records a native application failure in
`ucrtbase.dll` with exception `0xc0000409`. That event alone does not identify
the failing inference operation.

A separate native test executable reproduced an abort with the catalog's
Qwen3.5 2B MTP model before this patch. llama.cpp reported
`MTP block missing nextn.eh_proj`. Version 0.1.156 defaults `load_mtp` to false,
while the application still created an MTP context. The patched Rust wrapper
exposes the native flag, and the loaders retain it through CPU retries.
This reproduction does not mean the user's installed Mac application crashed.

Windows setup previously provisioned integration scripts synchronously and
repeated WSL calls during prerequisite checks and restored terminal creation.
The new coordinator shares two commands under one 15-second deadline. It runs
off the IPC thread, reuses successful preparation, and supports Retry.
Background process factories use Microsoft's
[CREATE_NO_WINDOW flag](https://learn.microsoft.com/en-us/windows/win32/procthread/process-creation-flags).
ConPTY terminal creation continues using its existing launch path.

## Local checks

- Frontend: 120 test files, 1,590 tests passed. Production frontend build passed.
- Rust with local inference: 1,082 tests passed, including agent harness and
  runbook fixtures. New checks cover MTP loading intent, CPU offload settings,
  cancellation under backpressure, inference permit lifetime, shared WSL
  preparation, unchanged integration files, and close during terminal creation.
- Rust without local inference: 1,037 tests passed. All-target Clippy passed
  with warnings treated as errors in both feature configurations. The 30 local
  provider tests also passed after the final diagnostic changes.
- Release catalog: 14 tests passed. Windows installer contract: 5 tests passed.
- Version consistency and embedding manifest validation passed.
- PowerShell smoke evidence validation passed all 10 cases and accepted the
  real CPU smoke output. It rejects standard fallback, missing draft tokens,
  empty output, the wrong backend, and incomplete tool/cancellation evidence.
  PowerShell parsing passed.
- Targeted Codacy/Opengrep analysis completed without execution errors. Its
  four findings flag Rust `unsafe` usage: three native diagnostic callback
  boundaries, reviewed and documented, and one existing macOS CPU query.

The final Qwen3.5 2B smoke succeeded on explicit CPU (7.37 seconds) and Metal
(7.43 seconds). Both first Agent requests produced a real tool call with 25
output tokens, 21 drafted tokens, and 20 accepted drafts. Continuations using
those actual tool call IDs and synthetic successful results generated text with
MTP active. Both runs cancelled an actively streaming request and then completed
ordinary chat through the same inference gate.

The CPU run unloaded Qwen and reloaded it without MTP. The Metal run unloaded
Qwen and loaded the separate `gemma-4-E4B-it-Q4_K_M.gguf` model without its MTP
sidecar. Both standard runs generated text with zero drafts and exited
successfully. Earlier checks also passed a repeated identical MTP request and
Qwen standard reload on both backends. No downloaded model was changed.

## Windows acceptance still required

The Windows package and release workflows now build the native smoke executable
and run it against isolated copies of the installed DLLs with a pinned Qwen2B
artifact. CPU selection is mandatory in hosted CI. These jobs have not been run
from this Mac workspace.

Before publishing, retain results from a Windows CPU host and a Vulkan laptop,
including driver and installer versions. Exercise ordinary chat, first Agent
request, tool continuations, cancellation, and reload in the installed GUI.
Repeat launches with running and stopped WSL, multiple restored tabs, disabled
integration, missing prerequisites, timeout, successful Retry, and closing
during startup. Verify that no background console windows flash.

See [the Windows acceptance procedure](WINDOWS.md) for commands and the broader
clean-VM matrix. Native console-window regression tests run only on Windows;
local macOS results cannot establish the absence of Windows console flashes.
