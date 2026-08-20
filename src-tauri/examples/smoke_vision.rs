//! End-to-end smoke test for the on-device VISION path, runnable without the
//! Tauri UI: loads a GGUF plus its mmproj projector and transcribes one image
//! through the same code the app uses.
//!
//! **This is the go/no-go gate for the whole vision feature.** Two things cannot be
//! verified any other way:
//!
//! 1. **M-RoPE positions.** Every model in `VISION_CATALOG` uses M-RoPE (PaddleOCR
//!    is MROPE, Qwen3-VL is IMROPE), so `total_positions()` and `total_tokens()`
//!    differ and the decode loop must continue from what `eval_chunks` returned. The
//!    failure surfaces as a `llama_decode` error about inconsistent sequence
//!    positions, so the numbers print BEFORE the transcript — a mismatch is then one
//!    line to read rather than a diagnosis from garbage output.
//! 2. **Accelerated CLIP kernels per projector.** A projector this build cannot run comes
//!    back only as a null context. `--cpu-clip` puts the fallback one flag away.
//!
//! Usage:
//!   cargo run --features local-llm --example smoke_vision -- \
//!       <model.gguf> <mmproj.gguf> <image.png> [prompt] [--cpu-clip]

#[cfg(feature = "local-llm")]
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    use vterminal_lib::models::vision::{VisionArch, VISION_CATALOG};
    use vterminal_lib::provider::vision::ReadyVision;

    let args: Vec<String> = std::env::args().skip(1).collect();
    let cpu_clip = args.iter().any(|a| a == "--cpu-clip");
    let positional: Vec<&String> = args.iter().filter(|a| !a.starts_with("--")).collect();
    if positional.len() < 3 {
        eprintln!(
            "usage: smoke_vision <model.gguf> <mmproj.gguf> <image.png> [prompt] [--cpu-clip]"
        );
        std::process::exit(2);
    }
    let (model_path, mmproj_path, image_path) = (
        positional[0].as_str(),
        positional[1].as_str(),
        positional[2].as_str(),
    );

    // Infer the family from the filename so the right default prompt is used —
    // "transcribe this" and "describe this" are different jobs.
    let arch = if model_path.to_lowercase().contains("paddle") {
        VisionArch::PaddleOcr
    } else {
        VisionArch::Qwen3Vl
    };
    let prompt = positional.get(3).map(|s| s.to_string()).unwrap_or_else(|| {
        VISION_CATALOG
            .iter()
            .find(|m| m.arch == arch)
            .map(|m| m.default_prompt.to_string())
            .expect("every arch has a catalog entry")
    });

    let image = std::fs::read(image_path)?;
    eprintln!("image:  {image_path} ({} bytes)", image.len());
    eprintln!("arch:   {arch:?}  use_gpu={}", !cpu_clip);

    eprintln!("loading {model_path} + {mmproj_path}…");
    let start = std::time::Instant::now();
    let ready = ReadyVision::load_standalone(model_path, mmproj_path, arch, 4096, !cpu_clip)?;
    eprintln!("loaded in {:.1}s", start.elapsed().as_secs_f32());

    let (_cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);
    let report = |line: &str| eprintln!("  [mtmd] {line}");

    let gen_start = std::time::Instant::now();
    let text = ready.transcribe_blocking(&image, &prompt, &cancel_rx, Some(&report))?;
    let secs = gen_start.elapsed().as_secs_f32();

    println!("\n--- transcript ---\n{text}\n--- end ---");
    eprintln!("transcribed in {secs:.1}s");
    assert!(!text.trim().is_empty(), "the model produced nothing at all");
    eprintln!("SMOKE OK");
    Ok(())
}

#[cfg(not(feature = "local-llm"))]
fn main() {
    // Without this arm, `cargo check --examples` passes while proving nothing —
    // the same trap the other two smoke examples guard against.
    eprintln!("build with --features local-llm");
}
