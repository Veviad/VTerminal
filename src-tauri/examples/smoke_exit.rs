//! Reproduces — and proves the fix for — the SIGABRT on quit with a model
//! resident, without the Tauri UI.
//!
//! Usage: cargo run --features local-llm --example smoke_exit -- <file.gguf> [exit|_exit]
//!
//! `exit` is what tao and AppKit do on their own, and it runs C++ static
//! destructors: llama.cpp's Metal device registry then asserts that every buffer
//! was freed first (`GGML_ASSERT([rsets->data count] == 0)` in
//! ggml-metal-device.m), which aborts. That abort is what macOS reported as
//! "VTerminal quit unexpectedly" on an app the user closed deliberately.
//!
//! `_exit` is what `lib.rs` now does on `RunEvent::Exit`, and must exit 0 with
//! the model still resident.

// This reproducer is specifically for AppKit's Metal teardown. Keeping its
// libc::_exit path out of non-macOS builds also makes `--all-targets` a valid
// Windows local-LLM CI gate.
#[cfg(all(feature = "local-llm", target_os = "macos"))]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    use vterminal_lib::models::catalog::LocalFamily;
    use vterminal_lib::provider::local::ReadyModel;

    let mut args = std::env::args().skip(1);
    let file = args
        .next()
        .expect("usage: smoke_exit <file.gguf> [exit|_exit]");
    let hard = !matches!(args.next().as_deref(), Some("exit"));

    // HELD, not dropped: a resident model with live Metal buffers is the state
    // the app quits in, and the only state the assert fires on. The family is
    // irrelevant here — nothing generates.
    let _resident = ReadyModel::load_standalone(&file, LocalFamily::Qwen, 2048)?;

    eprintln!(
        "smoke_exit: model resident, leaving via {}",
        if hard { "_exit(0)" } else { "exit(0)" }
    );
    if hard {
        unsafe { libc::_exit(0) };
    }
    std::process::exit(0)
}

#[cfg(not(all(feature = "local-llm", target_os = "macos")))]
fn main() {
    eprintln!("smoke_exit needs macOS and --features local-llm");
}
