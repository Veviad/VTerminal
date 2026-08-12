//! The on-device vision sidecar: a second resident model that turns an image into
//! text, for when the chat model cannot see.
//!
//! **Not a `Provider` impl, deliberately.** `chat_stream(messages, tools, params,
//! cancel, tx)` has nowhere to put bytes, and the moment an image shape exists on
//! that trait someone wires it into a cloud adapter without implementing the
//! vendor's base64 block. This sidecar has no tools, no effort ladder, no history
//! and exactly one caller.
//!
//! **`OutputSplitter` is actively wrong here.** It eats `<think>` and `<tool_call>`
//! substrings and holds back the last twelve bytes — and this is a terminal app
//! whose users screenshot code containing precisely those strings. A transcript has
//! to come back verbatim, so the token pieces are concatenated raw.
//!
//! **Collected, not streamed**, for the reason `ai_name_session` gives: the result
//! is folded into a chat turn before anything is shown, so the user waits either
//! way and a channel would be retain-until-done bookkeeping for nothing.

use std::ffi::CString;
use std::num::NonZeroU32;
use std::sync::Arc;

use llama_cpp_2::context::params::{KvCacheType, LlamaContextParams};
use llama_cpp_2::llama_batch::LlamaBatch;
use llama_cpp_2::model::params::LlamaModelParams;
use llama_cpp_2::model::LlamaModel;
use llama_cpp_2::mtmd::{
    mtmd_default_marker, MtmdBitmap, MtmdContext, MtmdContextParams, MtmdInputText,
};
use llama_cpp_2::sampling::LlamaSampler;
use tauri::ipc::Channel;

use super::chat_template::ChatTemplate;
use super::local::{backend, load_template, perf_cores};
use super::ChatMessage;
use crate::models::vision::{VisionArch, VisionModel};
use crate::models::LoadEvent;

/// Ceiling on image tokens, and it has to be a ceiling.
///
/// mtmd's own default is -1, i.e. unbounded: a 2560x1600 retina screenshot through
/// a dynamic-size preprocessor is on the order of 1300 image tokens and a 5K one is
/// several thousand — every single one a KV cell, with no back-pressure anywhere.
/// Some architectures snap this to their own supported budget rather than honouring
/// it exactly, which is why `smoke_vision` prints the resulting token count.
const IMAGE_MAX_TOKENS: i32 = 1024;

/// Sidecar context, well below what the GGUFs advertise (131k / 262k). A
/// transcription is one image plus a sentence; the window only has to hold the
/// image's tokens plus the answer, and every unused cell is still allocated.
const MAX_SIDECAR_CTX: u32 = 4096;

/// Cap on a transcription. A dense page of text is ~1500 tokens; past that the
/// model is repeating itself, which is the documented failure mode.
const MAX_TRANSCRIPT_TOKENS: u32 = 2048;

pub enum VisionSlot {
    Empty,
    Loading { model_id: String, generation: u64 },
    Ready(LoadedVision),
}

pub struct LoadedVision {
    pub model_id: String,
    model: Arc<LlamaModel>,
    /// Built once at load, against `model`. `MtmdContext` is `Send + Sync`.
    mtmd: Arc<MtmdContext>,
    template: Arc<ChatTemplate>,
    arch: VisionArch,
    context_len: u32,
}

/// What the blocking half of `load` carries back across the thread boundary:
/// the four `LoadedVision` fields that only exist once the weights are resident.
/// `model_id` and `arch` are known before the spawn, so they stay on the async
/// side rather than making the round trip.
type VisionParts = (Arc<LlamaModel>, Arc<MtmdContext>, Arc<ChatTemplate>, u32);

/// Cloned out from under the host lock so a transcription never holds it.
pub struct ReadyVision {
    pub model_id: String,
    model: Arc<LlamaModel>,
    mtmd: Arc<MtmdContext>,
    template: Arc<ChatTemplate>,
    arch: VisionArch,
    context_len: u32,
    /// The process-wide gate — see `provider::InferenceGate`.
    gate: Arc<tokio::sync::Semaphore>,
}

/// A second resident model, beside `ModelHost` rather than inside it.
///
/// Not a second slot in `ModelHost`: `get_ready` there yields the `ReadyModel` that
/// `resolve_local` compares against `active_model_id`, and that comparison is the
/// thing that stops the wrong model answering a chat turn. A transcriber must never
/// be reachable through it.
pub struct VisionHost {
    pub inner: tokio::sync::Mutex<VisionSlot>,
    gate: Arc<tokio::sync::Semaphore>,
    /// Same unload-during-load hazard as `ModelHost`, same counter.
    generation: std::sync::atomic::AtomicU64,
}

impl VisionHost {
    pub fn with_gate(gate: Arc<tokio::sync::Semaphore>) -> Self {
        Self {
            inner: tokio::sync::Mutex::new(VisionSlot::Empty),
            gate,
            generation: std::sync::atomic::AtomicU64::new(0),
        }
    }

    pub async fn status(&self) -> (Option<String>, &'static str) {
        match &*self.inner.lock().await {
            VisionSlot::Empty => (None, "idle"),
            VisionSlot::Loading { model_id, .. } => (Some(model_id.clone()), "loading"),
            VisionSlot::Ready(m) => (Some(m.model_id.clone()), "ready"),
        }
    }

    pub async fn unload(&self) {
        self.generation
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        *self.inner.lock().await = VisionSlot::Empty;
    }

    /// Load weights + projector. Both paths come from the registry, so llama.cpp
    /// never reaches the network.
    pub async fn load(
        &self,
        spec: &'static VisionModel,
        gguf_path: String,
        mmproj_path: String,
        on_event: &Channel<LoadEvent>,
    ) -> Result<(), String> {
        let my_generation = {
            let mut slot = self.inner.lock().await;
            if matches!(&*slot, VisionSlot::Loading { .. }) {
                return Err("a vision model is already loading".into());
            }
            let generation = self.generation.load(std::sync::atomic::Ordering::SeqCst);
            *slot = VisionSlot::Loading {
                model_id: spec.id.to_string(),
                generation,
            };
            generation
        };

        let _ = on_event.send(LoadEvent::Phase { name: "loading".into() });

        let build = tokio::task::spawn_blocking(
            move || -> Result<VisionParts, String> {
                let backend = backend()?;
                let params = LlamaModelParams::default().with_n_gpu_layers(u32::MAX);
                let model = LlamaModel::load_from_file(backend, &gguf_path, &params)
                    .map_err(|e| format!("vision model load failed: {e}"))?;
                let template = load_template(&model)?;
                let context_len = MAX_SIDECAR_CTX.min(model.n_ctx_train()).max(512);

                let mtmd = MtmdContext::init_from_file(&mmproj_path, &model, &mtmd_params(true)?)
                    .map_err(|e| projector_error(&e.to_string()))?;
                if !mtmd.support_vision() {
                    return Err("this projector carries no vision encoder".into());
                }
                Ok((Arc::new(model), Arc::new(mtmd), Arc::new(template), context_len))
            },
        )
        .await
        .map_err(|e| format!("vision load task failed: {e}"))?;

        let mut slot = self.inner.lock().await;
        // Unloaded while we were building — drop it rather than resurrecting it.
        if self.generation.load(std::sync::atomic::Ordering::SeqCst) != my_generation {
            *slot = VisionSlot::Empty;
            let message = "load cancelled by unload".to_string();
            let _ = on_event.send(LoadEvent::Error { message: message.clone() });
            return Err(message);
        }
        match build {
            Ok((model, mtmd, template, context_len)) => {
                *slot = VisionSlot::Ready(LoadedVision {
                    model_id: spec.id.to_string(),
                    model,
                    mtmd,
                    template,
                    arch: spec.arch,
                    context_len,
                });
                let _ = on_event.send(LoadEvent::Ready { context_len });
                Ok(())
            }
            Err(message) => {
                *slot = VisionSlot::Empty;
                let _ = on_event.send(LoadEvent::Error { message: message.clone() });
                Err(message)
            }
        }
    }

    pub async fn get_ready(&self) -> Result<ReadyVision, String> {
        match &*self.inner.lock().await {
            VisionSlot::Ready(m) => Ok(ReadyVision {
                model_id: m.model_id.clone(),
                model: Arc::clone(&m.model),
                mtmd: Arc::clone(&m.mtmd),
                template: Arc::clone(&m.template),
                arch: m.arch,
                context_len: m.context_len,
                gate: Arc::clone(&self.gate),
            }),
            _ => Err("no vision model loaded — load one in Settings → Models".into()),
        }
    }
}

/// Render the sidecar's prompt through the model's OWN Jinja template, with the
/// media marker as **literal text** inside the message content.
///
/// > **Doubled-marker gotcha.** Never hand the template a content *array*. Qwen3-VL's
/// > template would then emit its own `<|vision_start|>…<|vision_end|>` and
/// > PaddleOCR-VL's its own `<|IMAGE_START|>…<|IMAGE_END|>`, while `mtmd` injects
/// > `img_beg`/`img_end` around the embeddings itself (`tools/mtmd/mtmd.cpp`) —
/// > doubled markers, silently degraded output, no error anywhere. `mtmd-cli.cpp`
/// > does exactly what this does: append the marker to the content string, then
/// > apply the template.
///
/// Free function so the marker placement is testable against real template
/// fixtures without a GGUF.
pub fn build_vision_prompt(
    template: &ChatTemplate,
    prompt: &str,
) -> Result<String, String> {
    let content = format!("{}\n{}", mtmd_default_marker(), prompt.trim());
    // No tools, and thinking off: a transcriber does not deliberate.
    template.render(&[ChatMessage::user(content)], &[], false)
}

impl ReadyVision {
    /// Build a sidecar with no `VisionHost` and no app around it.
    ///
    /// The twin of `ReadyModel::load_standalone`, and for the same reason: the
    /// smoke example is the only way to verify the M-RoPE arithmetic and the Metal
    /// CLIP path, and it has no Tauri anything. `use_gpu` is a parameter here only
    /// so that example can offer `--cpu-clip`.
    pub fn load_standalone(
        model_path: &str,
        mmproj_path: &str,
        arch: VisionArch,
        max_context: u32,
        use_gpu: bool,
    ) -> Result<Self, String> {
        let backend = backend()?;
        let params = LlamaModelParams::default().with_n_gpu_layers(u32::MAX);
        let model = LlamaModel::load_from_file(backend, model_path, &params)
            .map_err(|e| format!("vision model load failed: {e}"))?;
        let template = load_template(&model)?;
        let context_len = max_context.min(model.n_ctx_train()).max(512);
        let mtmd = MtmdContext::init_from_file(mmproj_path, &model, &mtmd_params(use_gpu)?)
            .map_err(|e| projector_error(&e.to_string()))?;
        if !mtmd.support_vision() {
            return Err("this projector carries no vision encoder".into());
        }
        Ok(Self {
            model_id: format!("standalone:{model_path}"),
            model: Arc::new(model),
            mtmd: Arc::new(mtmd),
            template: Arc::new(template),
            arch,
            context_len,
            gate: Arc::new(tokio::sync::Semaphore::new(1)),
        })
    }

    /// Transcribe or describe one image.
    ///
    /// `image` is the encoded file (PNG/JPEG/…) — mtmd decodes it with stb_image,
    /// which is why no `image` crate is needed on the Rust side.
    pub async fn describe(
        &self,
        image: Vec<u8>,
        prompt: String,
        cancel: tokio::sync::watch::Receiver<bool>,
    ) -> Result<String, String> {
        let rendered = build_vision_prompt(&self.template, &prompt)?;
        let add_bos = self.template.add_bos;

        // Held for the whole generation, and shared with the chat host: two models
        // are resident, so two concurrent generations would mean four large
        // allocations. It also covers `eval_chunks` not being thread-safe.
        let _permit = Arc::clone(&self.gate)
            .acquire_owned()
            .await
            .map_err(|_| "inference gate closed".to_string())?;

        let model = Arc::clone(&self.model);
        let mtmd = Arc::clone(&self.mtmd);
        let context_len = self.context_len;

        // `LlamaContext` is not Send, so it is built and dropped inside the
        // blocking task — the same shape `chat_stream` uses.
        tokio::task::spawn_blocking(move || {
            run(Job {
                model: &model,
                mtmd: &mtmd,
                rendered: &rendered,
                image: &image,
                add_bos,
                context_len,
                cancel: &cancel,
                report: None,
            })
        })
        .await
        .map_err(|e| format!("vision task failed: {e}"))?
    }

    /// The synchronous body, so the smoke example can pass a diagnostics sink.
    /// Skips the gate — a standalone sidecar is the only thing running.
    pub fn transcribe_blocking(
        &self,
        image: &[u8],
        prompt: &str,
        cancel: &tokio::sync::watch::Receiver<bool>,
        report: Option<&dyn Fn(&str)>,
    ) -> Result<String, String> {
        let rendered = build_vision_prompt(&self.template, prompt)?;
        if let Some(report) = report {
            report(&format!(
                "rendered prompt: {} chars, {} media marker(s), add_bos={}",
                rendered.len(),
                rendered.matches(mtmd_default_marker()).count(),
                self.template.add_bos,
            ));
        }
        run(Job {
            model: &self.model,
            mtmd: &self.mtmd,
            rendered: &rendered,
            image,
            add_bos: self.template.add_bos,
            context_len: self.context_len,
            cancel,
            report,
        })
    }

    pub fn arch(&self) -> VisionArch {
        self.arch
    }
}

fn mtmd_params(use_gpu: bool) -> Result<MtmdContextParams, String> {
    Ok(MtmdContextParams {
        // The crate is built with the `metal` feature; forcing the CLIP graph onto
        // CPU costs seconds per image. If a projector turns out to have Metal gaps
        // this is the first thing to flip — the only symptom is a null context.
        use_gpu,
        // The crate default is TRUE, and it writes to stderr on every single call.
        print_timings: false,
        n_threads: perf_cores(),
        media_marker: CString::new(mtmd_default_marker())
            .map_err(|e| format!("media marker: {e}"))?,
        image_min_tokens: -1,
        image_max_tokens: IMAGE_MAX_TOKENS,
    })
}

/// Greedy decoding, NOT the model's chat sampling defaults.
///
/// Measured, not assumed. PaddleOCR-VL's GGUF declares no `general.sampling.*` keys
/// at all, so `Sampling::from_metadata` fell through to the chat defaults — temp
/// 0.8 — and at that temperature the model samples EOS early: **one run in four
/// stopped after the first heading** instead of transcribing the page, on identical
/// input. A transcription that is right 75% of the time is worse than useless,
/// because nothing downstream can tell which case it got.
///
/// The floor in `Sampling::with_override` that deliberately keeps CHAT off greedy
/// exists because Qwen3 loops in thinking mode. Neither half of that applies here:
/// there is no thinking, and the output is grounded in image embeddings rather than
/// free-running. Greedy is also simply what OCR pipelines do.
///
/// The repeat penalty stays as a loop guard — a VLM can still cycle on repeated
/// table rows — with `MAX_TRANSCRIPT_TOKENS` as the hard backstop.
fn transcription_sampler() -> LlamaSampler {
    LlamaSampler::chain_simple(vec![
        LlamaSampler::penalties(64, 1.1, 0.0, 0.0),
        LlamaSampler::greedy(),
    ])
}

fn projector_error(inner: &str) -> String {
    format!(
        "projector load failed ({inner}) — either this build of llama.cpp does not know this \
         projector type, or its Metal kernels are missing"
    )
}

/// Everything one transcription needs, as a struct rather than nine positional
/// arguments.
struct Job<'a> {
    model: &'a LlamaModel,
    mtmd: &'a MtmdContext,
    /// Already through the model's Jinja template, marker included.
    rendered: &'a str,
    /// The encoded image file. mtmd decodes it with stb_image.
    image: &'a [u8],
    add_bos: bool,
    context_len: u32,
    cancel: &'a tokio::sync::watch::Receiver<bool>,
    /// Diagnostics sink for the smoke example. `None` in the app: these numbers
    /// only matter while the M-RoPE arithmetic is being verified.
    report: Option<&'a dyn Fn(&str)>,
}

fn run(t: Job<'_>) -> Result<String, String> {
    let backend = backend()?;
    let note = |msg: String| {
        if let Some(report) = t.report {
            report(&msg);
        }
    };

    let bitmap = MtmdBitmap::from_buffer(t.mtmd, t.image, false)
        .map_err(|e| format!("could not decode the image: {e}"))?;
    note(format!(
        "bitmap {}x{}  support_vision={}  mrope={}  non_causal={}",
        bitmap.nx(),
        bitmap.ny(),
        t.mtmd.support_vision(),
        t.mtmd.decode_use_mrope(),
        t.mtmd.decode_use_non_causal(),
    ));

    let chunks = t
        .mtmd
        .tokenize(
            MtmdInputText {
                text: t.rendered.to_string(),
                // The template already emitted BOS if the model wants one, exactly
                // as on the text path — read from GGUF metadata, never guessed.
                add_special: t.add_bos,
                parse_special: true,
            },
            &[&bitmap],
        )
        .map_err(|e| format!("could not tokenize the image prompt: {e}"))?;

    // TOKENS, not positions: an image costs one KV cell per token but only
    // `max(nx,ny)` positions under M-RoPE, which every model in VISION_CATALOG
    // uses. Sizing the context from `total_positions()` under-allocates the cache
    // and decode fails part-way through the image.
    let image_tokens = chunks.total_tokens() as u32;
    note(format!(
        "chunks={}  total_tokens={}  total_positions={}",
        chunks.len(),
        image_tokens,
        chunks.total_positions(),
    ));

    let n_ctx = t.context_len.max(512);
    if image_tokens + MAX_TRANSCRIPT_TOKENS >= n_ctx {
        return Err(format!(
            "this image needs {image_tokens} tokens and the sidecar window is {n_ctx} — \
             try a smaller screenshot"
        ));
    }

    let threads = perf_cores();
    let n_batch: u32 = 512;
    let ctx_params = LlamaContextParams::default()
        .with_n_ctx(NonZeroU32::new(n_ctx))
        .with_n_batch(n_batch)
        .with_n_ubatch(n_batch)
        .with_n_threads(threads)
        .with_n_threads_batch(threads)
        // Same reasoning as the chat path: quantized KV is what makes a second
        // resident model affordable at all.
        .with_type_k(KvCacheType::Q8_0)
        .with_type_v(KvCacheType::Q8_0)
        .with_swa_full(false);
    let mut ctx = t
        .model
        .new_context(backend, ctx_params)
        .map_err(|e| format!("vision context creation failed: {e}"))?;

    // One call does the whole prefill: `llama_decode` for the text chunks,
    // `mtmd_encode` + `llama_decode` for the image chunk. Returns the next
    // POSITION, which is what the decode loop below must continue from.
    let n_past = chunks
        .eval_chunks(t.mtmd, &ctx, 0, 0, n_batch as i32, true)
        .map_err(|e| {
            format!(
                "image encoding failed ({e}) — if this build's Metal kernels do not cover \
                 this projector, loading with use_gpu=false is the fallback"
            )
        })?;
    note(format!("eval_chunks -> n_past={n_past}"));

    if *t.cancel.borrow() {
        return Err("cancelled".into());
    }

    let mut sampler = transcription_sampler();

    let mut decoder = encoding_rs::UTF_8.new_decoder();
    let mut batch = LlamaBatch::new(n_batch as usize, 1);
    let mut out = String::new();
    let mut produced: u32 = 0;
    // Seeded from what eval_chunks RETURNED, not from the token count. Under
    // M-RoPE llama.cpp asserts each new token position is strictly greater than
    // the max already cached for the sequence; `n_past` satisfies that, and
    // "correcting" it downward to match `total_tokens` is the failure mode — it
    // surfaces as a decode error about inconsistent sequence positions.
    //
    // Nothing else is needed for M-RoPE here: for batches carrying TOKENS rather
    // than embeddings, llama.cpp broadcasts the scalar position across all four
    // rope sections (`llama-batch.cpp`), so a plain `batch.add` is correct.
    let mut n_cur = n_past;

    loop {
        if *t.cancel.borrow() {
            return Err("cancelled".into());
        }
        let token = sampler.sample(&ctx, -1);
        sampler.accept(token);

        if t.model.is_eog_token(token) {
            break;
        }
        if produced >= MAX_TRANSCRIPT_TOKENS || n_cur as u32 >= n_ctx {
            break;
        }

        // Raw concatenation, no OutputSplitter: a transcript must come back
        // verbatim, and this app's users screenshot code containing `<think>`.
        out.push_str(
            &t.model
                .token_to_piece(token, &mut decoder, true, None)
                .map_err(|e| format!("detokenize failed: {e}"))?,
        );

        batch.clear();
        batch
            .add(token, n_cur, &[0], true)
            .map_err(|e| format!("batch add: {e}"))?;
        ctx.decode(&mut batch)
            .map_err(|e| format!("vision decode failed: {e}"))?;
        n_cur += 1;
        produced += 1;
    }

    note(format!("produced {produced} tokens"));
    Ok(out.trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> ChatTemplate {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures")
            .join(name);
        let source = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
        ChatTemplate::new(source, "<bos>".into(), "<eos>".into(), false)
            .expect("fixture template compiles")
    }

    /// Exactly one marker, and NOT wrapped in the family's own image tags — mtmd
    /// adds those itself around the embeddings.
    #[test]
    fn the_marker_appears_once_and_unwrapped() {
        for name in ["qwen3-vl-chat-template.jinja", "paddleocr-vl-chat-template.jinja"] {
            let template = fixture(name);
            let out = build_vision_prompt(&template, "Transcribe this.").unwrap();
            let marker = mtmd_default_marker();

            assert_eq!(out.matches(marker).count(), 1, "{name}: marker count");
            for wrapper in [
                "<|vision_start|>",
                "<|vision_end|>",
                "<|IMAGE_START|>",
                "<|IMAGE_END|>",
                "<|image_pad|>",
                "<|IMAGE_PLACEHOLDER|>",
            ] {
                assert!(
                    !out.contains(wrapper),
                    "{name}: template emitted {wrapper} — mtmd would add its own on top"
                );
            }
            assert!(out.contains("Transcribe this."), "{name}: prompt text is missing");
        }
    }
}
