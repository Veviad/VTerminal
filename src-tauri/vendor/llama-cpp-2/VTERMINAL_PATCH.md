# VTerminal compatibility patch

Source: crates.io `llama-cpp-2` 0.1.156, from
https://github.com/utilityai/llama-cpp-rs at commit
`63e549708237b16b39018288582655539e0a9d5b`. The upstream MIT and Apache licenses
are preserved in this directory.

Trailing whitespace in the upstream README and JSON grammar is normalized.

The only wrapper API addition is `LlamaModelParams::load_mtp()` and
`with_load_mtp(bool)`, with a regression test. Native llama.cpp added a false
default for `load_mtp` in 0.1.156, but the Rust wrapper did not expose it.
Skipping embedded Qwen MTP tensors and then creating an MTP context aborts at
`models/qwen35.cpp` with `MTP block missing nextn.eh_proj`.

The native dependency is pinned to `=0.1.156` to keep the ABI and this patch
reviewable. Remove this vendored wrapper when an upstream release exposes the
switch and the real embedded-MTP inference smoke passes on macOS and Windows.
