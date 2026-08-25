//! On-device inference on llama.cpp.
//!
//! All `llama_cpp_2` types stay confined to this file so upstream API drift is
//! contained — the rest of the app only sees the `Provider` trait. Exactly one
//! model is loaded process-wide (the `ModelHost` singleton); accelerator buffers free
//! when the last `Arc<LlamaModel>` drops.
//!
//! Prompts are built by rendering each model's own Jinja template (see
//! `super::chat_template`), which is what gives us native tool calling and
//! native thinking control. What llama.cpp still does NOT give us is the other
//! direction: parsing tool calls back **out** of the token stream. Each family
//! emits its own envelope, so `OutputSplitter` is driven by per-family markers.
//!
//! Generation runs on a blocking thread: `LlamaContext` is deliberately not
//! `Send`, and decode is CPU/GPU-bound work that has no business occupying an
//! async worker.

use std::num::NonZeroU32;
use std::sync::{Arc, Mutex, OnceLock};

use llama_cpp_2::context::params::{KvCacheType, LlamaContextParams, LlamaContextType};
use llama_cpp_2::llama_backend::LlamaBackend;
use llama_cpp_2::llama_batch::LlamaBatch;
use llama_cpp_2::model::params::LlamaModelParams;
use llama_cpp_2::model::{AddBos, LlamaModel};
use llama_cpp_2::sampling::LlamaSampler;
use llama_cpp_2::speculative::{MtpSpeculative, MtpSpeculativeParams};
use serde_json::{Map, Value};
use tauri::ipc::Channel;

use super::chat_template::ChatTemplate;
use super::{
    ChatMessage, ChatParams, Effort, FinishReason, Provider, ProviderError, ProviderEvent,
    ToolCall, ToolDef,
};
use crate::models::catalog::LocalFamily;
use crate::models::LoadEvent;

/// llama.cpp's backend is global and may only be initialized once per process.
static BACKEND: OnceLock<Result<LlamaBackend, String>> = OnceLock::new();
#[cfg(target_os = "windows")]
static BACKEND_MODULES: OnceLock<std::path::PathBuf> = OnceLock::new();

#[derive(Clone, Debug, serde::Serialize)]
pub struct LocalAcceleration {
    pub backend: String,
    pub device_name: Option<String>,
    pub device_memory_bytes: Option<u64>,
    pub fallback_reason: Option<String>,
    pub generation_mode: Option<String>,
    pub generation_fallback_reason: Option<String>,
}

impl LocalAcceleration {
    pub(crate) fn unloaded() -> Self {
        Self {
            backend: "unloaded".into(),
            device_name: None,
            device_memory_bytes: None,
            fallback_reason: None,
            generation_mode: None,
            generation_fallback_reason: None,
        }
    }

    pub(crate) fn uses_gpu(&self) -> bool {
        matches!(self.backend.as_str(), "metal" | "vulkan")
    }
}

static ACCELERATION: OnceLock<Mutex<LocalAcceleration>> = OnceLock::new();
static LAST_GENERATION_METRICS: OnceLock<Mutex<Option<GenerationMetrics>>> = OnceLock::new();

#[derive(Clone, Debug, serde::Serialize)]
pub struct GenerationMetrics {
    pub mode: String,
    pub drafted_tokens: u64,
    pub accepted_tokens: u64,
    pub acceptance_rate: f64,
    pub completion_tokens: u32,
    pub first_token_ms: u128,
    pub elapsed_ms: u128,
    pub backend: String,
}

pub fn last_generation_metrics() -> Option<GenerationMetrics> {
    LAST_GENERATION_METRICS
        .get_or_init(|| Mutex::new(None))
        .lock()
        .ok()
        .and_then(|metrics| metrics.clone())
}

fn store_generation_metrics(metrics: GenerationMetrics) {
    if let Ok(mut slot) = LAST_GENERATION_METRICS
        .get_or_init(|| Mutex::new(None))
        .lock()
    {
        *slot = Some(metrics);
    }
}

fn set_acceleration(value: LocalAcceleration) {
    if let Ok(mut current) = ACCELERATION
        .get_or_init(|| Mutex::new(LocalAcceleration::unloaded()))
        .lock()
    {
        *current = value;
    }
}

pub fn acceleration_snapshot() -> serde_json::Value {
    let current = ACCELERATION
        .get_or_init(|| Mutex::new(LocalAcceleration::unloaded()))
        .lock()
        .map(|value| value.clone())
        .unwrap_or_else(|_| LocalAcceleration::unloaded());
    serde_json::to_value(current).unwrap_or_else(|_| serde_json::json!({ "backend": "unknown" }))
}

#[cfg(target_os = "windows")]
pub fn configure_backend_modules(path: std::path::PathBuf) {
    let _ = BACKEND_MODULES.set(path);
}

#[cfg(not(target_os = "windows"))]
pub fn configure_backend_modules(_path: std::path::PathBuf) {}

pub(crate) fn backend() -> Result<&'static LlamaBackend, String> {
    BACKEND
        .get_or_init(|| {
            #[cfg(target_os = "windows")]
            {
                if let Some(path) = BACKEND_MODULES.get().filter(|path| path.is_dir()) {
                    llama_cpp_2::llama_backend::load_backends_from_path(path);
                } else {
                    // Developer builds use the path exported by llama-cpp-sys.
                    llama_cpp_2::llama_backend::load_backends();
                }
            }
            LlamaBackend::init().map_err(|e| format!("llama backend init: {e}"))
        })
        .as_ref()
        .map_err(Clone::clone)
}

/// Load with the best safe accelerator for this machine. Windows Vulkan is a
/// dynamically loaded optional backend; failure or insufficient reported VRAM
/// retries the same model with zero GPU layers so local AI remains usable.
pub(crate) fn load_model_with_fallback(
    path: &str,
    label: &str,
) -> Result<(LlamaModel, LocalAcceleration), String> {
    let backend = backend()?;
    #[cfg(target_os = "windows")]
    {
        use llama_cpp_2::{list_llama_ggml_backend_devices, LlamaBackendDeviceType};
        let mut devices: Vec<_> = list_llama_ggml_backend_devices()
            .into_iter()
            .filter(|device| {
                device.backend.eq_ignore_ascii_case("vulkan")
                    && matches!(
                        device.device_type,
                        LlamaBackendDeviceType::Gpu | LlamaBackendDeviceType::IntegratedGpu
                    )
            })
            .collect();
        // Prefer a discrete device, then the one reporting the most free memory.
        // Trying every candidate avoids falling all the way back to CPU merely
        // because an integrated adapter was enumerated first.
        devices.sort_by_key(|device| {
            (
                matches!(device.device_type, LlamaBackendDeviceType::Gpu),
                device.memory_free,
            )
        });
        let model_bytes = std::fs::metadata(path).map(|meta| meta.len()).unwrap_or(0);
        let mut failures = Vec::new();
        for device in devices.into_iter().rev() {
            let device_name = if device.description.is_empty() {
                device.name.clone()
            } else {
                device.description.clone()
            };
            // Leave at least 1 GiB and 20% of the model size free for context,
            // driver allocations, and fragmentation. Unknown VRAM is allowed to
            // try once, because some Vulkan drivers report zero.
            let reserve = (model_bytes / 5).max(1_073_741_824);
            let fits = device.memory_free == 0
                || (device.memory_free as u64) >= model_bytes.saturating_add(reserve);
            if !fits {
                failures.push(format!(
                    "Vulkan device {device_name} has insufficient free memory for {label}"
                ));
                continue;
            }
            let params = match LlamaModelParams::default().with_devices(&[device.index]) {
                Ok(params) => params.with_n_gpu_layers(u32::MAX),
                Err(error) => {
                    failures.push(format!(
                        "Vulkan device {device_name} could not be selected ({error})"
                    ));
                    continue;
                }
            };
            match LlamaModel::load_from_file(backend, path, &params) {
                Ok(model) => {
                    let acceleration = LocalAcceleration {
                        backend: "vulkan".into(),
                        device_name: Some(device_name),
                        device_memory_bytes: Some(device.memory_total as u64),
                        fallback_reason: None,
                        generation_mode: None,
                        generation_fallback_reason: None,
                    };
                    set_acceleration(acceleration.clone());
                    return Ok((model, acceleration));
                }
                Err(error) => failures.push(format!(
                    "Vulkan device {device_name} could not load {label} ({error})"
                )),
            }
        }
        let fallback_reason = if failures.is_empty() {
            "No usable Vulkan device was found; using CPU".into()
        } else {
            format!("{}; using CPU", failures.join("; "))
        };
        load_model_on_cpu(path, label, fallback_reason)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let params = LlamaModelParams::default().with_n_gpu_layers(u32::MAX);
        let model = LlamaModel::load_from_file(backend, path, &params)
            .map_err(|error| format!("{label} load failed: {error}"))?;
        let acceleration = LocalAcceleration {
            backend: if cfg!(target_os = "macos") {
                "metal".into()
            } else {
                "gpu".into()
            },
            device_name: None,
            device_memory_bytes: None,
            fallback_reason: None,
            generation_mode: None,
            generation_fallback_reason: None,
        };
        set_acceleration(acceleration.clone());
        Ok((model, acceleration))
    }
}

#[cfg(target_os = "windows")]
fn load_model_on_cpu(
    path: &str,
    label: &str,
    fallback_reason: String,
) -> Result<(LlamaModel, LocalAcceleration), String> {
    let params = LlamaModelParams::default().with_n_gpu_layers(0);
    let model = LlamaModel::load_from_file(backend()?, path, &params)
        .map_err(|error| format!("{label} CPU load failed: {error}"))?;
    let acceleration = LocalAcceleration {
        backend: "cpu".into(),
        device_name: None,
        device_memory_bytes: None,
        fallback_reason: Some(fallback_reason),
        generation_mode: None,
        generation_fallback_reason: None,
    };
    set_acceleration(acceleration.clone());
    Ok((model, acceleration))
}

/// Validate allocations that happen after weight loading (KV context, vision
/// projector, embedding context). A Vulkan model that cannot complete this
/// host-specific initialization is discarded and reloaded entirely on CPU.
pub(crate) fn validate_or_retry_on_cpu<T, F>(
    path: &str,
    label: &str,
    model: LlamaModel,
    acceleration: LocalAcceleration,
    validate: F,
) -> Result<(LlamaModel, LocalAcceleration, T), String>
where
    F: Fn(&LlamaModel, bool) -> Result<T, String>,
{
    match validate(&model, acceleration.uses_gpu()) {
        Ok(value) => Ok((model, acceleration, value)),
        Err(error) => {
            #[cfg(target_os = "windows")]
            if acceleration.uses_gpu() {
                drop(model);
                let reason = runtime_fallback_reason(label, &error);
                let (cpu_model, cpu_acceleration) = load_model_on_cpu(path, label, reason)?;
                let value = validate(&cpu_model, false).map_err(|cpu_error| {
                    format!("{label} CPU runtime initialization failed: {cpu_error}")
                })?;
                return Ok((cpu_model, cpu_acceleration, value));
            }

            #[cfg(not(target_os = "windows"))]
            let _ = (path, label);
            Err(error)
        }
    }
}

#[cfg(any(target_os = "windows", test))]
fn runtime_fallback_reason(label: &str, error: &str) -> String {
    format!("Vulkan loaded {label}, but its runtime allocation failed ({error}); using CPU")
}

/// Physical performance cores, the way llama.cpp picks its macOS thread count
/// (`common/common.cpp` reads `hw.perflevel0.physicalcpu`).
/// `available_parallelism` counts efficiency cores too, and oversubscribing
/// llama.cpp's per-op barrier onto them makes the E-core threads the straggler
/// at every synchronization point. It never helps.
pub(crate) fn perf_cores() -> i32 {
    #[cfg(target_os = "macos")]
    {
        let mut out: i32 = 0;
        let mut len = std::mem::size_of::<i32>();
        let rc = unsafe {
            libc::sysctlbyname(
                c"hw.perflevel0.physicalcpu".as_ptr(),
                std::ptr::addr_of_mut!(out).cast(),
                &mut len,
                std::ptr::null_mut(),
                0,
            )
        };
        if rc == 0 && out > 0 {
            return out;
        }
    }
    std::thread::available_parallelism()
        .map(|n| n.get() as i32)
        .unwrap_or(4)
}

pub enum HostSlot {
    Empty,
    Loading { model_id: String, generation: u64 },
    Ready(LoadedModel),
}

pub struct LoadedModel {
    pub model_id: String,
    pub model: Arc<LlamaModel>,
    pub template: Arc<ChatTemplate>,
    pub family: LocalFamily,
    pub context_len: u32,
    pub sampling: Sampling,
    pub acceleration: LocalAcceleration,
    pub mtp: Option<LoadedMtp>,
}

#[derive(Clone)]
pub struct LoadedMtp {
    pub drafter: LoadedMtpDrafter,
    pub draft_tokens: u32,
}

#[derive(Clone)]
pub enum LoadedMtpDrafter {
    /// Qwen stores its MTP head in the target GGUF. Its draft context must not
    /// share recurrent state with the target context.
    Embedded,
    /// Gemma uses an assistant GGUF whose recurrent state is explicitly bound
    /// to the target context.
    Sidecar(Arc<LlamaModel>),
}

#[derive(Clone, Debug)]
pub struct MtpLoadSpec {
    pub draft_path: Option<String>,
    pub draft_tokens: u32,
}

type ModelParts = (
    Arc<LlamaModel>,
    Arc<ChatTemplate>,
    u32,
    Sampling,
    LocalAcceleration,
    Option<LoadedMtp>,
);

/// Sampling parameters, preferring what the GGUF itself declares.
///
/// llama.cpp reads `general.sampling.*` out of the file and applies it unless
/// the user explicitly overrode each knob (`common/common.cpp`). We do not use
/// common's sampler builder, so we read the same keys ourselves. Otherwise a model that ships
/// a tuned config (Gemma 4 declares top_k 64 / top_p 0.95 / temp 1.0) silently
/// gets llama.cpp's generic CLI defaults instead.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Sampling {
    pub top_k: i32,
    pub top_p: f32,
    pub min_p: f32,
    pub temp: f32,
    pub penalty_repeat: f32,
}

impl Default for Sampling {
    fn default() -> Self {
        // llama.cpp's own CLI defaults, used when the GGUF declares nothing.
        Self {
            top_k: 40,
            top_p: 0.95,
            min_p: 0.05,
            temp: 0.8,
            penalty_repeat: 1.0,
        }
    }
}

impl Sampling {
    pub(crate) fn from_metadata(model: &LlamaModel) -> Self {
        let mut s = Self::default();
        let get = |key: &str| model.meta_val_str(key).ok();
        if let Some(v) = get("general.sampling.top_k").and_then(|v| v.trim().parse().ok()) {
            s.top_k = v;
        }
        if let Some(v) = get("general.sampling.top_p").and_then(|v| v.trim().parse().ok()) {
            s.top_p = v;
        }
        if let Some(v) = get("general.sampling.min_p").and_then(|v| v.trim().parse().ok()) {
            s.min_p = v;
        }
        if let Some(v) = get("general.sampling.temp").and_then(|v| v.trim().parse().ok()) {
            s.temp = v;
        }
        if let Some(v) = get("general.sampling.penalty_repeat").and_then(|v| v.trim().parse().ok())
        {
            s.penalty_repeat = v;
        }
        s
    }

    /// Apply the user's override when they set one. `None` means "use the
    /// model's own", which is the default and the same precedence llama.cpp
    /// uses.
    pub fn with_override(mut self, temperature: Option<f32>) -> Self {
        if let Some(t) = temperature {
            self.temp = t;
        }
        // Greedy decoding is never what we want here: Qwen3 documents it as
        // producing endless repetition in thinking mode, and thinking is on by
        // default. Floor rather than silently shipping the one configuration
        // the vendor warns against.
        self.temp = self.temp.clamp(0.05, 2.0);
        self
    }
}

/// Everything a request needs, cloned out from under the host lock so
/// generation never holds it.
pub struct ReadyModel {
    pub model_id: String,
    pub model: Arc<LlamaModel>,
    pub template: Arc<ChatTemplate>,
    pub family: LocalFamily,
    pub context_len: u32,
    pub sampling: Sampling,
    pub acceleration: LocalAcceleration,
    pub mtp: Option<LoadedMtp>,
    /// Serializes generations — see `ModelHost::gate`.
    pub gate: Arc<tokio::sync::Semaphore>,
}

/// Build the renderer from the GGUF's own metadata.
///
/// Everything here comes from the file rather than from a per-family guess:
/// Gemma 4 sets `add_bos_token = true` and its template emits no BOS, while
/// Qwen sets it false. Hardcoding either answer silently degrades the other.
pub(crate) fn load_template(model: &LlamaModel) -> Result<ChatTemplate, String> {
    let source = model
        .chat_template(None)
        .map_err(|e| {
            format!("this GGUF has no embedded chat template ({e}) — it cannot be used for chat")
        })?
        .to_string()
        .map_err(|e| format!("chat template is not valid UTF-8: {e}"))?;

    let mut decoder = encoding_rs::UTF_8.new_decoder();
    let mut piece = |token| {
        model
            .token_to_piece(token, &mut decoder, true, None)
            .unwrap_or_default()
    };
    let bos_token = piece(model.token_bos());
    let eos_token = piece(model.token_eos());

    let add_bos = model
        .meta_val_str("tokenizer.ggml.add_bos_token")
        .map(|v| {
            let v = v.trim();
            v.eq_ignore_ascii_case("true") || v == "1"
        })
        .unwrap_or(false);

    ChatTemplate::new(source, bos_token, eos_token, add_bos)
}

impl ReadyModel {
    /// Load a GGUF straight from a path, with no Tauri app around it.
    ///
    /// This is what the headless smoke-test examples use, so they exercise the
    /// same loader and the same `Provider` implementation the app does rather
    /// than a parallel one that can quietly drift.
    pub fn load_standalone(
        path: &str,
        family: LocalFamily,
        max_context: u32,
    ) -> Result<Self, String> {
        let (model, acceleration) = load_model_with_fallback(path, "model")?;
        let template = load_template(&model)?;
        let sampling = Sampling::from_metadata(&model);
        let context_len = max_context.min(model.n_ctx_train()).max(512);
        let (model, acceleration) = prepare_chat_model(path, model, acceleration, context_len)?;
        Ok(Self {
            model_id: path.to_string(),
            model: Arc::new(model),
            template: Arc::new(template),
            family,
            context_len,
            sampling,
            acceleration,
            mtp: None,
            gate: Arc::new(tokio::sync::Semaphore::new(1)),
        })
    }

    /// Developer benchmark loader. `draft_path = None` selects an embedded
    /// Qwen MTP head; Gemma supplies its assistant GGUF path.
    pub fn load_standalone_with_mtp(
        path: &str,
        draft_path: Option<&str>,
        family: LocalFamily,
        max_context: u32,
        draft_tokens: u32,
    ) -> Result<Self, String> {
        let mut ready = Self::load_standalone(path, family, max_context)?;
        let drafter = match draft_path {
            Some(path) => {
                let (model, draft_acceleration) = load_model_with_fallback(path, "MTP drafter")?;
                if draft_acceleration.backend != ready.acceleration.backend
                    || draft_acceleration.device_name != ready.acceleration.device_name
                {
                    return Err(format!(
                        "MTP drafter used {} ({}) while target used {} ({})",
                        draft_acceleration.backend,
                        draft_acceleration
                            .device_name
                            .as_deref()
                            .unwrap_or("default"),
                        ready.acceleration.backend,
                        ready
                            .acceleration
                            .device_name
                            .as_deref()
                            .unwrap_or("default")
                    ));
                }
                LoadedMtpDrafter::Sidecar(Arc::new(model))
            }
            None => LoadedMtpDrafter::Embedded,
        };
        ready.mtp = Some(LoadedMtp {
            drafter,
            draft_tokens,
        });
        ready.acceleration.generation_mode = Some("mtp".into());
        ready.acceleration.generation_fallback_reason = None;
        set_acceleration(ready.acceleration.clone());
        Ok(ready)
    }
}

pub struct ModelHost {
    pub inner: tokio::sync::Mutex<HostSlot>,
    /// Only one local generation at a time — and since the vision sidecar shares
    /// this exact semaphore (`provider::InferenceGate`), that means one across
    /// BOTH resident models, not one each.
    ///
    /// Each request builds its own `LlamaContext`, and the KV cache is sized by
    /// n_ctx — 32k on an 8B model is gigabytes. Two overlapping requests would
    /// hold two full caches plus the model, which is how a 16GB machine dies.
    /// Overlap is reachable in practice: AI tab-naming is dispatched per
    /// session, so naming one tab while asking in another does it.
    gate: Arc<tokio::sync::Semaphore>,
    /// Bumped by unload(); a load only installs its result if the generation
    /// it started with is still current (otherwise the user unloaded mid-load
    /// and the freshly built model must be dropped, not installed).
    generation: std::sync::atomic::AtomicU64,
}

impl Default for ModelHost {
    /// Its own private gate. Used by `load_standalone` and the smoke examples,
    /// which are the only single-host configurations left — the app injects the
    /// shared one so the vision sidecar cannot generate concurrently.
    fn default() -> Self {
        Self::with_gate(Arc::new(tokio::sync::Semaphore::new(1)))
    }
}

impl ModelHost {
    pub fn with_gate(gate: Arc<tokio::sync::Semaphore>) -> Self {
        Self {
            inner: tokio::sync::Mutex::new(HostSlot::Empty),
            generation: std::sync::atomic::AtomicU64::new(0),
            gate,
        }
    }
}

impl ModelHost {
    pub async fn status(&self) -> (Option<String>, &'static str) {
        match &*self.inner.lock().await {
            HostSlot::Empty => (None, "idle"),
            HostSlot::Loading { model_id, .. } => (Some(model_id.clone()), "loading"),
            HostSlot::Ready(m) => (Some(m.model_id.clone()), "ready"),
        }
    }

    pub async fn acceleration_snapshot(&self) -> serde_json::Value {
        match &*self.inner.lock().await {
            HostSlot::Ready(_) => acceleration_snapshot(),
            HostSlot::Empty | HostSlot::Loading { .. } => {
                serde_json::to_value(LocalAcceleration::unloaded())
                    .unwrap_or_else(|_| serde_json::json!({ "backend": "unknown" }))
            }
        }
    }

    pub async fn unload(&self) {
        self.generation
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let mut slot = self.inner.lock().await;
        *slot = HostSlot::Empty;
        set_acceleration(LocalAcceleration::unloaded());
    }

    /// Load a GGUF from a local path. The registry always hands us local files,
    /// so llama.cpp never reaches out to the network.
    pub async fn load(
        &self,
        model_id: String,
        gguf_path: String,
        family: LocalFamily,
        max_context: u32,
        mtp_spec: Option<MtpLoadSpec>,
        on_event: &Channel<LoadEvent>,
    ) -> Result<(), String> {
        let my_generation = {
            let mut slot = self.inner.lock().await;
            if matches!(&*slot, HostSlot::Loading { .. }) {
                return Err("a model is already loading".into());
            }
            let generation = self.generation.load(std::sync::atomic::Ordering::SeqCst);
            // Drop any previous model first; accelerator buffers free once in-flight
            // streams finish with their Arc clones.
            *slot = HostSlot::Loading {
                model_id: model_id.clone(),
                generation,
            };
            generation
        };

        let _ = on_event.send(LoadEvent::Phase {
            name: "loading".into(),
        });

        // mmap + accelerator allocation is blocking work. Unlike mistral.rs, an
        // unsupported architecture comes back as an Err rather than a panic, so
        // there is no unwind to catch here.
        let build = tokio::task::spawn_blocking(move || -> Result<ModelParts, String> {
            let (model, acceleration) = load_model_with_fallback(&gguf_path, "model")?;
            let template = load_template(&model)?;
            let sampling = Sampling::from_metadata(&model);
            // Never promise more context than the model was trained for.
            let context_len = max_context.min(model.n_ctx_train()).max(512);
            let (model, mut acceleration) =
                prepare_chat_model(&gguf_path, model, acceleration, context_len)?;
            let mtp = mtp_spec.and_then(|spec| {
                let drafter = match spec.draft_path.as_deref() {
                    Some(path) => match load_model_with_fallback(path, "MTP drafter") {
                        Ok((draft, draft_acceleration))
                            if draft_acceleration.backend == acceleration.backend =>
                        {
                            Some(LoadedMtpDrafter::Sidecar(Arc::new(draft)))
                        }
                        Ok((_draft, draft_acceleration)) => {
                            acceleration.generation_fallback_reason = Some(format!(
                                "MTP drafter used {} while the target used {}; using standard decoding",
                                draft_acceleration.backend, acceleration.backend
                            ));
                            None
                        }
                        Err(error) => {
                            acceleration.generation_fallback_reason =
                                Some(format!("MTP drafter could not load ({error})"));
                            None
                        }
                    },
                    None => Some(LoadedMtpDrafter::Embedded),
                };
                let usable = drafter.is_some();
                acceleration.generation_mode = Some(if usable { "mtp" } else { "standard" }.into());
                drafter.map(|drafter| LoadedMtp {
                    drafter,
                    draft_tokens: spec.draft_tokens,
                })
            }).filter(|_| acceleration.generation_mode.as_deref() == Some("mtp"));
            if mtp.is_none() && acceleration.generation_mode.is_none() {
                acceleration.generation_mode = Some("standard".into());
                acceleration.generation_fallback_reason =
                    Some("MTP artifacts are not installed".into());
            }
            set_acceleration(acceleration.clone());
            Ok((
                Arc::new(model),
                Arc::new(template),
                context_len,
                sampling,
                acceleration,
                mtp,
            ))
        })
        .await
        .map_err(|e| format!("model load task failed: {e}"))?;

        let mut slot = self.inner.lock().await;
        // The user unloaded while we were building — drop the model instead of
        // resurrecting it behind their back.
        if self.generation.load(std::sync::atomic::Ordering::SeqCst) != my_generation {
            *slot = HostSlot::Empty;
            let message = "load cancelled by unload".to_string();
            let _ = on_event.send(LoadEvent::Error {
                message: message.clone(),
            });
            return Err(message);
        }
        match build {
            Ok((model, template, context_len, sampling, acceleration, mtp)) => {
                *slot = HostSlot::Ready(LoadedModel {
                    model_id,
                    model,
                    template,
                    family,
                    context_len,
                    sampling,
                    acceleration,
                    mtp,
                });
                let _ = on_event.send(LoadEvent::Ready { context_len });
                Ok(())
            }
            Err(message) => {
                *slot = HostSlot::Empty;
                let _ = on_event.send(LoadEvent::Error {
                    message: message.clone(),
                });
                Err(message)
            }
        }
    }

    pub async fn get_ready(&self) -> Result<ReadyModel, ProviderError> {
        match &*self.inner.lock().await {
            HostSlot::Ready(m) => Ok(ReadyModel {
                model_id: m.model_id.clone(),
                model: Arc::clone(&m.model),
                template: Arc::clone(&m.template),
                family: m.family,
                context_len: m.context_len,
                sampling: m.sampling,
                acceleration: m.acceleration.clone(),
                mtp: m.mtp.clone(),
                gate: Arc::clone(&self.gate),
            }),
            _ => Err(ProviderError::NoModel),
        }
    }
}

// ------------------------------------------------------ per-family output

/// The markers a family wraps its reasoning and tool calls in.
///
/// These are read off each model's own chat template, not invented: Qwen uses
/// `<think>` / `<tool_call>`, while Gemma 4 uses a channel form and a brace DSL
/// (`<|tool_call>call:name{…}<tool_call|>`). Parsing one family's stream with
/// the other's markers silently turns tool calls into prose.
#[derive(Clone, Copy)]
struct Markers {
    think_open: &'static str,
    think_close: &'static str,
    tool_open: &'static str,
    tool_close: &'static str,
}

impl Markers {
    fn for_family(family: LocalFamily) -> Self {
        match family {
            LocalFamily::Qwen => Markers {
                think_open: "<think>",
                think_close: "</think>",
                tool_open: "<tool_call>",
                tool_close: "</tool_call>",
            },
            LocalFamily::Gemma => Markers {
                think_open: "<|channel>thought",
                think_close: "<channel|>",
                tool_open: "<|tool_call>",
                tool_close: "<tool_call|>",
            },
        }
    }

    /// Whether a rendered prompt already ends INSIDE an open reasoning span.
    ///
    /// Both shipped families do this, and it is not an edge case: Qwen3.5 ends
    /// its generation prompt with `<think>\n` whenever thinking is on, and
    /// Gemma 4 ends it with `<|channel>thought\n` after a tool response. The
    /// model therefore emits only the CLOSING marker, so a splitter that starts
    /// in `Text` mode streams the entire reasoning trace to the user as the
    /// answer and leaks the closing tag at the end of it.
    ///
    /// A prefilled *closed* block (Qwen's thinking-OFF branch emits the whole
    /// `<think>\n\n</think>\n\n`) does not match: the tail is the close marker,
    /// and neither family's close marker ends with its own open marker.
    fn opens_thought(&self, prompt: &str) -> bool {
        prompt.trim_end().ends_with(self.think_open)
    }

    /// Longest marker, so a tag split across token boundaries is never released
    /// as text before it can be recognized.
    fn hold(&self) -> usize {
        [
            self.think_open,
            self.think_close,
            self.tool_open,
            self.tool_close,
        ]
        .iter()
        .map(|m| m.chars().count())
        .max()
        .unwrap_or(12)
    }
}

/// Splits the raw token stream into user-visible text, reasoning, and tool
/// calls. Tags routinely straddle token boundaries, so text is only released
/// once it can no longer turn out to be the start of one.
struct OutputSplitter {
    mode: Mode,
    buf: String,
    calls: Vec<ToolCall>,
    markers: Markers,
    family: LocalFamily,
}

#[derive(PartialEq, Clone, Copy)]
enum Mode {
    Text,
    Think,
    Tool,
}

/// Byte offset such that at least `keep` *characters* remain after it. Slicing
/// on a raw byte count would split multibyte characters.
fn hold_back(s: &str, keep: usize) -> usize {
    match s.char_indices().nth_back(keep.saturating_sub(1)) {
        Some((idx, _)) if keep > 0 => idx,
        _ if keep == 0 => s.len(),
        _ => 0,
    }
}

impl OutputSplitter {
    /// `thinking_prefilled` starts the stream INSIDE a reasoning span, for the
    /// templates that open one in the prompt (`Markers::opens_thought`). Getting
    /// it wrong is silent: the reasoning trace is delivered as the answer.
    fn new(family: LocalFamily, thinking_prefilled: bool) -> Self {
        Self {
            mode: if thinking_prefilled {
                Mode::Think
            } else {
                Mode::Text
            },
            buf: String::new(),
            calls: Vec::new(),
            markers: Markers::for_family(family),
            family,
        }
    }

    /// Feed one decoded piece; returns the events it completes.
    fn push(&mut self, piece: &str) -> Vec<ProviderEvent> {
        self.buf.push_str(piece);
        let m = self.markers;
        let hold = m.hold();
        let mut out = Vec::new();
        loop {
            match self.mode {
                Mode::Text => {
                    // The close marker is in the running too: a stray one is a
                    // control token, never content, so it gets swallowed instead
                    // of reaching the user. That happens whenever a template
                    // opens a reasoning span this splitter was not told about —
                    // the failure `thinking_prefilled` exists to prevent, kept
                    // here as the backstop for the next template that does it.
                    let found = [
                        (self.buf.find(m.think_open), m.think_open, Mode::Think),
                        (self.buf.find(m.tool_open), m.tool_open, Mode::Tool),
                        (self.buf.find(m.think_close), m.think_close, Mode::Text),
                    ];
                    // First match wins a tie, keeping reasoning ahead of tools.
                    let earliest = found
                        .into_iter()
                        .filter_map(|(at, tag, next)| at.map(|at| (at, tag, next)))
                        .min_by_key(|(at, _, _)| *at);
                    let Some((at, tag, next)) = earliest else {
                        // No tag in sight: release everything that cannot
                        // still become one.
                        let cut = hold_back(&self.buf, hold);
                        if cut > 0 {
                            out.push(ProviderEvent::TextDelta(self.buf[..cut].to_string()));
                            self.buf.drain(..cut);
                        }
                        return out;
                    };
                    if at > 0 {
                        out.push(ProviderEvent::TextDelta(self.buf[..at].to_string()));
                    }
                    self.buf.drain(..at + tag.len());
                    self.mode = next;
                }
                Mode::Think => {
                    let Some(at) = self.buf.find(m.think_close) else {
                        let cut = hold_back(&self.buf, hold);
                        if cut > 0 {
                            out.push(ProviderEvent::ReasoningDelta(self.buf[..cut].to_string()));
                            self.buf.drain(..cut);
                        }
                        return out;
                    };
                    if at > 0 {
                        out.push(ProviderEvent::ReasoningDelta(self.buf[..at].to_string()));
                    }
                    self.buf.drain(..at + m.think_close.len());
                    self.mode = Mode::Text;
                }
                Mode::Tool => {
                    // Withhold everything until the call is whole — a half
                    // parsed call must never reach the user or the agent loop.
                    let Some(at) = self.buf.find(m.tool_close) else {
                        return out;
                    };
                    let payload = self.buf[..at].trim().to_string();
                    self.buf.drain(..at + m.tool_close.len());
                    self.mode = Mode::Text;
                    match parse_tool_call(self.family, &payload) {
                        Some(call) => self.calls.push(call),
                        None => log::warn!("discarding unparseable tool call: {payload}"),
                    }
                }
            }
        }
    }

    /// Flush whatever is left once the model stops.
    fn finish(&mut self) -> Vec<ProviderEvent> {
        let mut out = Vec::new();
        if !self.buf.is_empty() {
            let rest = std::mem::take(&mut self.buf);
            match self.mode {
                // An unterminated tool call is a malformed call, not prose.
                Mode::Tool => log::warn!("stream ended inside a tool call: {rest}"),
                Mode::Think => out.push(ProviderEvent::ReasoningDelta(rest)),
                Mode::Text => out.push(ProviderEvent::TextDelta(rest)),
            }
        }
        out
    }
}

fn parse_tool_call(family: LocalFamily, payload: &str) -> Option<ToolCall> {
    let (name, arguments) = match family {
        // Qwen changed envelopes mid-generation: Qwen3 put JSON inside
        // `<tool_call>`, Qwen3.5 replaced it with an XML form. Both are tried
        // because the catalog spans both and a stale download should keep
        // working. JSON goes first — it is unambiguous, so it cannot swallow a
        // call meant for the other parser.
        LocalFamily::Qwen => parse_json_call(payload).or_else(|| parse_qwen_xml_call(payload))?,
        LocalFamily::Gemma => parse_gemma_call(payload)?,
    };
    Some(ToolCall {
        id: format!("call_{}", uuid::Uuid::new_v4().simple()),
        name,
        arguments,
    })
}

/// Qwen3's envelope wraps plain JSON: `{"name": …, "arguments": {…}}`.
fn parse_json_call(payload: &str) -> Option<(String, String)> {
    let v: Value = serde_json::from_str(payload).ok()?;
    let name = v.get("name")?.as_str()?.to_string();
    // `arguments` is an object on the wire but ToolCall carries the raw JSON
    // string, matching what the cloud providers hand back.
    let arguments = match v.get("arguments") {
        Some(Value::String(s)) => s.clone(),
        Some(other) => serde_json::to_string(other).ok()?,
        None => "{}".to_string(),
    };
    Some((name, arguments))
}

/// Qwen3.5 dropped the JSON body for an XML form, which its template spells out
/// verbatim in the system prompt:
///
/// ```text
/// <function=run_command>
/// <parameter=command>
/// ls -la /tmp
/// </parameter>
/// </function>
/// ```
///
/// Values are **raw text, never JSON**. Every parameter the agent declares is a
/// string, and shell commands routinely start with the characters that would
/// make a value look like JSON — `[[ -f x ]] && …` is an array to any sniffing
/// parser and a test to zsh. So each value is taken literally; a future tool
/// with a non-string parameter has to coerce at the call site rather than have
/// this guess.
fn parse_qwen_xml_call(payload: &str) -> Option<(String, String)> {
    let open = payload.find("<function=")?;
    let rest = &payload[open + "<function=".len()..];
    let gt = rest.find('>')?;
    let name = rest[..gt].trim().to_string();
    if name.is_empty() {
        return None;
    }

    let mut args = Map::new();
    let mut cursor = &rest[gt + 1..];
    while let Some(at) = cursor.find("<parameter=") {
        let after = &cursor[at + "<parameter=".len()..];
        let Some(gt) = after.find('>') else { break };
        let key = after[..gt].trim().to_string();
        let body = &after[gt + 1..];
        // An unterminated parameter means the call was truncated; keep what
        // parsed rather than dropping an otherwise usable call.
        let Some(end) = body.find("</parameter>") else {
            break;
        };
        if !key.is_empty() {
            args.insert(
                key,
                Value::String(strip_one_newline(&body[..end]).to_string()),
            );
        }
        cursor = &body[end + "</parameter>".len()..];
    }

    Some((name, serde_json::to_string(&Value::Object(args)).ok()?))
}

/// The template writes `<parameter=k>\nvalue\n</parameter>`, so exactly one
/// newline on each side belongs to the envelope. Interior newlines are part of
/// a multi-line command and must survive.
fn strip_one_newline(s: &str) -> &str {
    let s = s
        .strip_prefix("\r\n")
        .or_else(|| s.strip_prefix('\n'))
        .unwrap_or(s);
    s.strip_suffix("\r\n")
        .or_else(|| s.strip_suffix('\n'))
        .unwrap_or(s)
}

/// Gemma 4 does not emit JSON. Its own template defines a brace DSL:
///
/// ```text
/// call:run_command{command:<|"|>ls -la<|"|>,count:3,flag:true}
/// ```
///
/// Strings are delimited by `<|"|>` rather than quotes, keys are bare at the
/// top level, and values nest as `{…}` maps and `[…]` lists. We parse it back
/// into ordinary JSON so the rest of the app never learns this format exists.
fn parse_gemma_call(payload: &str) -> Option<(String, String)> {
    let rest = payload.trim().strip_prefix("call:")?;
    let open = rest.find('{')?;
    let name = rest[..open].trim().to_string();
    if name.is_empty() {
        return None;
    }
    let body = rest[open + 1..].trim_end().strip_suffix('}')?;

    let mut p = GemmaParser {
        s: body.as_bytes(),
        i: 0,
    };
    let map = p.parse_pairs(false)?;
    Some((name, Value::Object(map).to_string()))
}

const GSTR: &str = "<|\"|>";

struct GemmaParser<'a> {
    s: &'a [u8],
    i: usize,
}

impl<'a> GemmaParser<'a> {
    fn rest(&self) -> &'a str {
        std::str::from_utf8(&self.s[self.i..]).unwrap_or("")
    }
    fn starts_with(&self, pat: &str) -> bool {
        self.rest().starts_with(pat)
    }
    fn skip_ws(&mut self) {
        while self.i < self.s.len() && (self.s[self.i] as char).is_whitespace() {
            self.i += 1;
        }
    }

    /// `key:value,key:value` until the end of the slice or a closing brace.
    fn parse_pairs(&mut self, escaped_keys: bool) -> Option<Map<String, Value>> {
        let mut map = Map::new();
        loop {
            self.skip_ws();
            if self.i >= self.s.len() || self.starts_with("}") {
                return Some(map);
            }
            let key = if escaped_keys && self.starts_with(GSTR) {
                self.parse_string()?
            } else {
                let start = self.i;
                while self.i < self.s.len() && self.s[self.i] != b':' {
                    self.i += 1;
                }
                std::str::from_utf8(&self.s[start..self.i])
                    .ok()?
                    .trim()
                    .to_string()
            };
            self.skip_ws();
            if self.i >= self.s.len() || self.s[self.i] != b':' {
                return None;
            }
            self.i += 1; // ':'
            let value = self.parse_value()?;
            map.insert(key, value);
            self.skip_ws();
            if self.i < self.s.len() && self.s[self.i] == b',' {
                self.i += 1;
                continue;
            }
            return Some(map);
        }
    }

    fn parse_string(&mut self) -> Option<String> {
        if !self.starts_with(GSTR) {
            return None;
        }
        self.i += GSTR.len();
        let start = self.i;
        let end = self.rest().find(GSTR)? + start;
        let out = std::str::from_utf8(&self.s[start..end]).ok()?.to_string();
        self.i = end + GSTR.len();
        Some(out)
    }

    fn parse_value(&mut self) -> Option<Value> {
        self.skip_ws();
        if self.starts_with(GSTR) {
            return self.parse_string().map(Value::String);
        }
        if self.starts_with("{") {
            self.i += 1;
            // Nested maps escape their keys; the top level does not.
            let map = self.parse_pairs(true)?;
            self.skip_ws();
            if self.starts_with("}") {
                self.i += 1;
            }
            return Some(Value::Object(map));
        }
        if self.starts_with("[") {
            self.i += 1;
            let mut arr = Vec::new();
            loop {
                self.skip_ws();
                if self.starts_with("]") {
                    self.i += 1;
                    return Some(Value::Array(arr));
                }
                arr.push(self.parse_value()?);
                self.skip_ws();
                if self.starts_with(",") {
                    self.i += 1;
                } else if self.starts_with("]") {
                    self.i += 1;
                    return Some(Value::Array(arr));
                } else {
                    return None;
                }
            }
        }
        // Bare literal up to the next delimiter: true / false / null / number.
        let start = self.i;
        while self.i < self.s.len() && !matches!(self.s[self.i], b',' | b'}' | b']') {
            self.i += 1;
        }
        let raw = std::str::from_utf8(&self.s[start..self.i]).ok()?.trim();
        Some(match raw {
            "true" => Value::Bool(true),
            "false" => Value::Bool(false),
            "null" | "" => Value::Null,
            other => serde_json::from_str(other).unwrap_or_else(|_| Value::String(other.into())),
        })
    }
}

/// Headroom the reasoning trace gets on top of the caller's answer budget.
fn thinking_allowance(effort: Effort) -> u32 {
    match effort {
        Effort::Off => 0,
        Effort::Low => 1024,
        Effort::Medium => 4096,
        Effort::High => 8192,
        Effort::Max => 16384,
    }
}

// ------------------------------------------------------------------ provider

pub struct LocalLlamaCpp {
    pub ready: ReadyModel,
}

#[async_trait::async_trait]
impl Provider for LocalLlamaCpp {
    fn id(&self) -> &'static str {
        "local"
    }

    fn model_name(&self) -> String {
        self.ready.model_id.clone()
    }

    async fn chat_stream(
        &self,
        messages: Vec<ChatMessage>,
        tools: Vec<ToolDef>,
        params: ChatParams,
        mut cancel: tokio::sync::watch::Receiver<bool>,
        tx: tokio::sync::mpsc::Sender<ProviderEvent>,
    ) -> Result<(), ProviderError> {
        let effort = params.effort;
        // The model's own template decides how tools and thinking are framed.
        let prompt = self
            .ready
            .template
            .render(&messages, &tools, effort != Effort::Off)
            .map_err(ProviderError::Inference)?;

        // Hold a permit for the whole generation: one local decode at a time.
        // Acquired AFTER rendering so a queued request is not holding the gate
        // while it templates.
        let acquire = Arc::clone(&self.ready.gate).acquire_owned();
        tokio::pin!(acquire);
        let _permit = loop {
            tokio::select! {
                biased;
                changed = cancel.changed() => match changed {
                    Ok(()) if *cancel.borrow() => return Err(ProviderError::Cancelled),
                    Ok(()) => continue,
                    Err(_) => return Err(ProviderError::Cancelled),
                },
                permit = &mut acquire => break permit
                    .map_err(|_| ProviderError::Inference("model host shut down".into()))?,
            }
        };

        let model = Arc::clone(&self.ready.model);
        let context_len = self.ready.context_len;
        let add_bos = self.ready.template.add_bos;
        let family = self.ready.family;
        // Read off the rendered prompt, not off `effort`: whether the template
        // opens the reasoning span itself is the template's decision, and the
        // two shipped families make it differently (Qwen3.5 on every thinking
        // turn, Gemma 4 only after a tool response).
        let thinking_prefilled = Markers::for_family(family).opens_thought(&prompt);
        let sampling = self.ready.sampling.with_override(params.temperature);
        let mtp = self.ready.mtp.clone();
        let budget = params
            .max_tokens
            .unwrap_or(2048)
            .saturating_add(thinking_allowance(effort));

        // LlamaContext is not Send and decode is blocking work — the whole
        // generation runs on a blocking thread and streams back over `tx`.
        tokio::task::spawn_blocking(move || {
            generate(
                &model,
                mtp.as_ref(),
                &prompt,
                Params {
                    context_len,
                    sampling,
                    budget,
                    add_bos,
                    family,
                    thinking_prefilled,
                },
                &cancel,
                &tx,
            )
        })
        .await
        .map_err(|e| ProviderError::Inference(format!("generation task failed: {e}")))?
    }
}

struct Params {
    context_len: u32,
    sampling: Sampling,
    budget: u32,
    add_bos: bool,
    family: LocalFamily,
    /// The prompt already opened a reasoning span, so the model will emit only
    /// the closing marker.
    thinking_prefilled: bool,
}

fn chat_context_params(n_ctx: u32) -> LlamaContextParams {
    let threads = perf_cores();
    let n_batch: u32 = 512;
    LlamaContextParams::default()
        .with_n_ctx(NonZeroU32::new(n_ctx.max(512)))
        .with_n_batch(n_batch)
        .with_n_ubatch(n_batch)
        .with_n_threads(threads)
        .with_n_threads_batch(threads)
        // Quantized KV halves the cache (an 8B model at 32k ctx is ~4.5 GiB at
        // F16) for negligible quality cost — llama-server's most-used memory
        // flag. This is the difference between a second model fitting and not.
        .with_type_k(KvCacheType::Q8_0)
        .with_type_v(KvCacheType::Q8_0)
        // llama.cpp defaults this to true, which allocates sliding-window
        // layers at full n_ctx anyway. Gemma 4 declares a 512-token window, so
        // leaving it on wastes most of its KV.
        .with_swa_full(false)
}

fn prepare_chat_model(
    path: &str,
    model: LlamaModel,
    acceleration: LocalAcceleration,
    context_len: u32,
) -> Result<(LlamaModel, LocalAcceleration), String> {
    #[cfg(target_os = "windows")]
    {
        let (model, acceleration, ()) =
            validate_or_retry_on_cpu(path, "model", model, acceleration, |model, _| {
                validate_chat_context(model, context_len)
            })?;
        Ok((model, acceleration))
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (path, context_len);
        Ok((model, acceleration))
    }
}

#[cfg(target_os = "windows")]
fn validate_chat_context(model: &LlamaModel, n_ctx: u32) -> Result<(), String> {
    let context = model
        .new_context(backend()?, chat_context_params(n_ctx))
        .map_err(|error| format!("context creation failed: {error}"))?;
    drop(context);
    Ok(())
}

fn generate(
    model: &LlamaModel,
    mtp_config: Option<&LoadedMtp>,
    prompt: &str,
    p: Params,
    cancel: &tokio::sync::watch::Receiver<bool>,
    tx: &tokio::sync::mpsc::Sender<ProviderEvent>,
) -> Result<(), ProviderError> {
    let backend = backend().map_err(ProviderError::Inference)?;

    // Whether BOS belongs here is a property of the model, read from GGUF
    // metadata at load: Gemma 4 wants one and its template emits none, Qwen
    // does not want one at all.
    let add_bos = if p.add_bos {
        AddBos::Always
    } else {
        AddBos::Never
    };
    let tokens = model
        .str_to_token(prompt, add_bos)
        .map_err(|e| ProviderError::Inference(format!("tokenize failed: {e}")))?;
    if tokens.is_empty() {
        return Err(ProviderError::Inference(
            "the chat template produced an empty prompt".into(),
        ));
    }

    let n_ctx = p.context_len.max(512);
    if tokens.len() as u32 >= n_ctx {
        return Err(ProviderError::Inference(format!(
            "prompt is {} tokens but the context window is {n_ctx} — start a new conversation or raise the context size",
            tokens.len()
        )));
    }

    // Values come from the GGUF where it declares them (`Sampling`), not from
    // hardcoded CLI defaults. Order follows llama.cpp: penalties, truncate the
    // tail, then temperature, then sample.
    let seed = std::env::var("VTERMINAL_MTP_BENCH_SEED")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or_else(|| {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.subsec_nanos())
                .unwrap_or(0)
        });
    let mut chain = Vec::new();
    if (p.sampling.penalty_repeat - 1.0).abs() > f32::EPSILON {
        chain.push(LlamaSampler::penalties(
            64,
            p.sampling.penalty_repeat,
            0.0,
            0.0,
        ));
    }
    chain.extend([
        LlamaSampler::top_k(p.sampling.top_k),
        LlamaSampler::top_p(p.sampling.top_p, 1),
        LlamaSampler::min_p(p.sampling.min_p, 1),
        // `Sampling::with_override` floors this above zero: greedy decoding is
        // what Qwen3 documents as causing endless repetition in thinking mode.
        LlamaSampler::temp(p.sampling.temp),
        LlamaSampler::dist(seed),
    ]);
    let mut sampler = LlamaSampler::chain_simple(chain);
    let mut decoder = encoding_rs::UTF_8.new_decoder();
    let mut splitter = OutputSplitter::new(p.family, p.thinking_prefilled);
    let mut produced: u32 = 0;
    let started = std::time::Instant::now();
    let mut first_token_ms = None;

    if let Some(config) = mtp_config {
        let target_params = chat_context_params(n_ctx).with_n_rs_seq(config.draft_tokens);
        let mtp_setup = model
            .new_context(backend, target_params)
            .map_err(|error| format!("target context creation failed: {error}"))
            .and_then(|target| {
                let draft_params = chat_context_params(n_ctx)
                    .with_context_type(LlamaContextType::Mtp)
                    .with_n_rs_seq(0);
                let draft = match &config.drafter {
                    LoadedMtpDrafter::Embedded => model.new_context(backend, draft_params),
                    LoadedMtpDrafter::Sidecar(draft_model) => {
                        draft_model.new_context_with_ctx_other(backend, draft_params, &target)
                    }
                };
                draft
                    .map_err(|error| format!("draft context creation failed: {error}"))
                    .and_then(|draft| {
                        MtpSpeculative::new(
                            target,
                            draft,
                            MtpSpeculativeParams {
                                n_max: config.draft_tokens as i32,
                                n_min: 0,
                                p_min: 0.0,
                            },
                        )
                        .map_err(|error| error.to_string())
                    })
            });

        match mtp_setup {
            Ok(mut speculative) => {
                update_generation_status("mtp", None);
                let mut batch = LlamaBatch::new(512, 1);
                let prompt_prefix = &tokens[..tokens.len() - 1];
                let prefill = prefill_mtp(&mut speculative, prompt_prefix, &mut batch, cancel, tx);
                if let Err(error) = prefill {
                    update_generation_status("standard", Some(error.to_string()));
                } else if let Err(error) = speculative.begin(prompt_prefix) {
                    update_generation_status("standard", Some(error.to_string()));
                } else {
                    let mut prompt_tokens = prompt_prefix.to_vec();
                    prompt_tokens.reserve(n_ctx as usize);
                    let mut id_last = *tokens.last().expect("non-empty tokens");
                    let mut n_past = prompt_prefix.len() as i32;
                    let mut drafted = 0_u64;
                    let mut accepted = 0_u64;
                    let mut fallback_reason = None;
                    let mut finish = FinishReason::Stop;

                    'generate: loop {
                        if *cancel.borrow() {
                            let _ = tx.blocking_send(ProviderEvent::Done {
                                finish_reason: FinishReason::Cancelled,
                            });
                            return Err(ProviderError::Cancelled);
                        }
                        if produced >= p.budget || n_past as u32 >= n_ctx.saturating_sub(1) {
                            finish = FinishReason::Length;
                            break;
                        }

                        let draft = match speculative.draft(n_past, id_last, &prompt_tokens) {
                            Ok(tokens) => tokens,
                            Err(error) => {
                                fallback_reason = Some(format!("MTP draft failed: {error}"));
                                break;
                            }
                        };
                        drafted = drafted.saturating_add(draft.len() as u64);
                        let base = n_past;

                        // Qwen's embedded MTP context decodes `id_last` and the
                        // proposed tokens while producing a draft. Rewind that
                        // speculative region before feeding the target's verified
                        // hidden states back through `process`. Otherwise the draft
                        // context sees the same positions twice and llama.cpp rejects
                        // its first state update.
                        if let Err(error) = speculative.draft_context_mut().kv_cache_seq_rm(
                            0,
                            Some(mtp_draft_reset_position(base)),
                            None,
                        ) {
                            fallback_reason =
                                Some(format!("MTP draft verification reset failed: {error}"));
                            break;
                        }

                        batch.clear();
                        if let Err(error) = batch.add(id_last, base, &[0], true) {
                            fallback_reason = Some(format!("MTP batch add failed: {error}"));
                            break;
                        }
                        for (index, token) in draft.iter().enumerate() {
                            if let Err(error) =
                                batch.add(*token, base + 1 + index as i32, &[0], true)
                            {
                                fallback_reason = Some(format!("MTP batch add failed: {error}"));
                                break 'generate;
                            }
                        }
                        if let Err(error) = speculative.target_context_mut().decode(&mut batch) {
                            fallback_reason = Some(format!("MTP target decode failed: {error}"));
                            break;
                        }
                        if let Err(error) = speculative.process(&batch) {
                            fallback_reason = Some(format!("MTP state update failed: {error}"));
                            break;
                        }

                        let mut sampled = Vec::with_capacity(draft.len() + 1);
                        for index in 0..=draft.len() {
                            let token = sampler.sample(speculative.target_context(), index as i32);
                            sampler.accept(token);
                            sampled.push(token);
                            if index == draft.len() || token != draft[index] {
                                break;
                            }
                        }
                        let accepted_now = accepted_draft_prefix(&sampled, &draft);
                        let acceptance_error = speculative
                            .accept(accepted_now as u16)
                            .err()
                            .map(|error| format!("MTP acceptance failed: {error}"));
                        accepted = accepted.saturating_add(accepted_now as u64);
                        // The target batch decoded `id_last` at `base`, followed by the
                        // draft. Keep that token and the accepted draft prefix. The next
                        // sampled token remains pending for the following decode.
                        n_past = mtp_next_position(base, accepted_now);

                        for token in sampled {
                            prompt_tokens.push(id_last);
                            id_last = token;
                            if model.is_eog_token(token) {
                                break 'generate;
                            }
                            if produced >= p.budget || n_past as u32 >= n_ctx {
                                finish = FinishReason::Length;
                                break 'generate;
                            }
                            stream_token(model, token, &mut decoder, &mut splitter, tx)?;
                            first_token_ms.get_or_insert_with(|| started.elapsed().as_millis());
                            produced += 1;
                        }

                        if let Some(reason) = acceptance_error {
                            fallback_reason = Some(reason);
                            break;
                        }

                        if let Err(error) = speculative.target_context_mut().kv_cache_seq_rm(
                            0,
                            Some(n_past as u32),
                            None,
                        ) {
                            fallback_reason = Some(format!("MTP target rollback failed: {error}"));
                            break;
                        }
                        if let Err(error) = speculative.draft_context_mut().kv_cache_seq_rm(
                            0,
                            Some(n_past as u32),
                            None,
                        ) {
                            fallback_reason = Some(format!("MTP draft rollback failed: {error}"));
                            break;
                        }
                    }

                    let fell_back = fallback_reason.is_some();
                    if let Some(reason) = fallback_reason {
                        log::warn!("{reason}; continuing with standard decoding");
                        update_generation_status("standard", Some(reason));
                        // Rebuild from confirmed history instead of trusting partially
                        // updated speculative KV or recurrent state. This also makes a
                        // failed rollback recoverable without duplicating streamed text.
                        speculative.target_context_mut().clear_kv_cache();
                        if !prompt_tokens.is_empty() {
                            prefill_standard(
                                speculative.target_context_mut(),
                                &prompt_tokens,
                                &mut batch,
                                cancel,
                                tx,
                            )?;
                        }
                        n_past = prompt_tokens.len() as i32;
                        finish = standard_decode(
                            speculative.target_context_mut(),
                            model,
                            &mut sampler,
                            &mut batch,
                            Some((id_last, n_past)),
                            n_past,
                            n_ctx,
                            p.budget,
                            &mut produced,
                            &started,
                            &mut first_token_ms,
                            &mut decoder,
                            &mut splitter,
                            cancel,
                            tx,
                        )?;
                    }

                    log::info!(
                        "MTP generation: drafted={drafted}, accepted={accepted}, acceptance={:.1}%, completion_tokens={produced}, elapsed_ms={}",
                        if drafted == 0 { 0.0 } else { accepted as f64 * 100.0 / drafted as f64 },
                        started.elapsed().as_millis()
                    );
                    store_generation_metrics(GenerationMetrics {
                        mode: if fell_back { "standard" } else { "mtp" }.into(),
                        drafted_tokens: drafted,
                        accepted_tokens: accepted,
                        acceptance_rate: if drafted == 0 {
                            0.0
                        } else {
                            accepted as f64 / drafted as f64
                        },
                        completion_tokens: produced,
                        first_token_ms: first_token_ms.unwrap_or(0),
                        elapsed_ms: started.elapsed().as_millis(),
                        backend: acceleration_backend(),
                    });
                    return finish_generation(tokens.len() as u32, produced, finish, splitter, tx);
                }
            }
            Err(error) => update_generation_status(
                "standard",
                Some(format!("MTP initialization failed: {error}")),
            ),
        }
    }

    let mut ctx = model
        .new_context(backend, chat_context_params(n_ctx))
        .map_err(|e| ProviderError::Inference(format!("context creation failed: {e}")))?;
    let mut batch = LlamaBatch::new(512, 1);
    prefill_standard(&mut ctx, &tokens, &mut batch, cancel, tx)?;
    let finish = standard_decode(
        &mut ctx,
        model,
        &mut sampler,
        &mut batch,
        None,
        tokens.len() as i32,
        n_ctx,
        p.budget,
        &mut produced,
        &started,
        &mut first_token_ms,
        &mut decoder,
        &mut splitter,
        cancel,
        tx,
    )?;
    log::info!(
        "standard generation: completion_tokens={produced}, elapsed_ms={}",
        started.elapsed().as_millis()
    );
    store_generation_metrics(GenerationMetrics {
        mode: "standard".into(),
        drafted_tokens: 0,
        accepted_tokens: 0,
        acceptance_rate: 0.0,
        completion_tokens: produced,
        first_token_ms: first_token_ms.unwrap_or(0),
        elapsed_ms: started.elapsed().as_millis(),
        backend: acceleration_backend(),
    });
    finish_generation(tokens.len() as u32, produced, finish, splitter, tx)
}

fn acceleration_backend() -> String {
    ACCELERATION
        .get_or_init(|| Mutex::new(LocalAcceleration::unloaded()))
        .lock()
        .map(|acceleration| acceleration.backend.clone())
        .unwrap_or_else(|_| "unknown".into())
}

fn accepted_draft_prefix(
    sampled: &[llama_cpp_2::token::LlamaToken],
    draft: &[llama_cpp_2::token::LlamaToken],
) -> usize {
    sampled
        .iter()
        .zip(draft)
        .take_while(|(sampled, drafted)| sampled == drafted)
        .count()
}

fn mtp_next_position(base: i32, accepted_draft_tokens: usize) -> i32 {
    base.saturating_add(1)
        .saturating_add(i32::try_from(accepted_draft_tokens).unwrap_or(i32::MAX))
}

fn mtp_draft_reset_position(base: i32) -> u32 {
    u32::try_from(base).unwrap_or_default()
}

fn update_generation_status(mode: &str, reason: Option<String>) {
    if let Ok(mut acceleration) = ACCELERATION
        .get_or_init(|| Mutex::new(LocalAcceleration::unloaded()))
        .lock()
    {
        acceleration.generation_mode = Some(mode.into());
        acceleration.generation_fallback_reason = reason;
    }
}

fn cancelled(
    cancel: &tokio::sync::watch::Receiver<bool>,
    tx: &tokio::sync::mpsc::Sender<ProviderEvent>,
) -> Result<(), ProviderError> {
    if *cancel.borrow() {
        let _ = tx.blocking_send(ProviderEvent::Done {
            finish_reason: FinishReason::Cancelled,
        });
        Err(ProviderError::Cancelled)
    } else {
        Ok(())
    }
}

fn prefill_standard(
    ctx: &mut llama_cpp_2::context::LlamaContext<'_>,
    tokens: &[llama_cpp_2::token::LlamaToken],
    batch: &mut LlamaBatch<'_>,
    cancel: &tokio::sync::watch::Receiver<bool>,
    tx: &tokio::sync::mpsc::Sender<ProviderEvent>,
) -> Result<(), ProviderError> {
    let last = tokens.len() - 1;
    for (chunk_index, chunk) in tokens.chunks(512).enumerate() {
        batch.clear();
        let base = chunk_index * 512;
        for (index, token) in chunk.iter().enumerate() {
            let position = base + index;
            batch
                .add(*token, position as i32, &[0], position == last)
                .map_err(|error| ProviderError::Inference(format!("batch add: {error}")))?;
        }
        ctx.decode(batch)
            .map_err(|error| ProviderError::Inference(format!("prefill decode: {error}")))?;
        cancelled(cancel, tx)?;
    }
    Ok(())
}

fn prefill_mtp(
    speculative: &mut MtpSpeculative<'_>,
    tokens: &[llama_cpp_2::token::LlamaToken],
    batch: &mut LlamaBatch<'_>,
    cancel: &tokio::sync::watch::Receiver<bool>,
    tx: &tokio::sync::mpsc::Sender<ProviderEvent>,
) -> Result<(), ProviderError> {
    for (chunk_index, chunk) in tokens.chunks(512).enumerate() {
        batch.clear();
        let base = chunk_index * 512;
        for (index, token) in chunk.iter().enumerate() {
            batch
                .add(*token, (base + index) as i32, &[0], false)
                .map_err(|error| ProviderError::Inference(format!("MTP batch add: {error}")))?;
        }
        speculative
            .target_context_mut()
            .decode(batch)
            .map_err(|error| ProviderError::Inference(format!("MTP prefill decode: {error}")))?;
        speculative
            .process(batch)
            .map_err(|error| ProviderError::Inference(format!("MTP prefill state: {error}")))?;
        cancelled(cancel, tx)?;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn standard_decode(
    ctx: &mut llama_cpp_2::context::LlamaContext<'_>,
    model: &LlamaModel,
    sampler: &mut LlamaSampler,
    batch: &mut LlamaBatch<'_>,
    pending: Option<(llama_cpp_2::token::LlamaToken, i32)>,
    mut n_cur: i32,
    n_ctx: u32,
    budget: u32,
    produced: &mut u32,
    started: &std::time::Instant,
    first_token_ms: &mut Option<u128>,
    decoder: &mut encoding_rs::Decoder,
    splitter: &mut OutputSplitter,
    cancel: &tokio::sync::watch::Receiver<bool>,
    tx: &tokio::sync::mpsc::Sender<ProviderEvent>,
) -> Result<FinishReason, ProviderError> {
    if let Some((token, position)) = pending {
        batch.clear();
        batch
            .add(token, position, &[0], true)
            .map_err(|error| ProviderError::Inference(format!("fallback batch add: {error}")))?;
        ctx.decode(batch)
            .map_err(|error| ProviderError::Inference(format!("fallback decode: {error}")))?;
        n_cur = position + 1;
    }
    loop {
        cancelled(cancel, tx)?;
        let token = sampler.sample(ctx, -1);
        sampler.accept(token);
        if model.is_eog_token(token) {
            return Ok(FinishReason::Stop);
        }
        if *produced >= budget || n_cur as u32 >= n_ctx {
            return Ok(FinishReason::Length);
        }
        stream_token(model, token, decoder, splitter, tx)?;
        first_token_ms.get_or_insert_with(|| started.elapsed().as_millis());
        batch.clear();
        batch
            .add(token, n_cur, &[0], true)
            .map_err(|error| ProviderError::Inference(format!("batch add: {error}")))?;
        ctx.decode(batch)
            .map_err(|error| ProviderError::Inference(format!("decode failed: {error}")))?;
        n_cur += 1;
        *produced += 1;
    }
}

fn stream_token(
    model: &LlamaModel,
    token: llama_cpp_2::token::LlamaToken,
    decoder: &mut encoding_rs::Decoder,
    splitter: &mut OutputSplitter,
    tx: &tokio::sync::mpsc::Sender<ProviderEvent>,
) -> Result<(), ProviderError> {
    let piece = model
        .token_to_piece(token, decoder, true, None)
        .map_err(|error| ProviderError::Inference(format!("detokenize failed: {error}")))?;
    for event in splitter.push(&piece) {
        tx.blocking_send(event)
            .map_err(|_| ProviderError::Cancelled)?;
    }
    Ok(())
}

fn finish_generation(
    prompt_tokens: u32,
    completion_tokens: u32,
    mut finish: FinishReason,
    mut splitter: OutputSplitter,
    tx: &tokio::sync::mpsc::Sender<ProviderEvent>,
) -> Result<(), ProviderError> {
    for event in splitter.finish() {
        let _ = tx.blocking_send(event);
    }
    if !splitter.calls.is_empty() {
        finish = FinishReason::ToolCalls;
        tx.blocking_send(ProviderEvent::ToolCalls(std::mem::take(
            &mut splitter.calls,
        )))
        .map_err(|_| ProviderError::Cancelled)?;
    }
    let _ = tx.blocking_send(ProviderEvent::Usage {
        prompt_tokens,
        completion_tokens,
    });
    let _ = tx.blocking_send(ProviderEvent::Done {
        finish_reason: finish,
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mtp_acceptance_stops_at_the_first_target_mismatch() {
        use llama_cpp_2::token::LlamaToken;
        let draft = [LlamaToken(10), LlamaToken(11), LlamaToken(12)];
        assert_eq!(
            accepted_draft_prefix(&[LlamaToken(10), LlamaToken(11), LlamaToken(99)], &draft),
            2
        );
        assert_eq!(accepted_draft_prefix(&draft, &draft), 3);
        assert_eq!(accepted_draft_prefix(&[LlamaToken(99)], &draft), 0);
    }

    #[test]
    fn mtp_rollback_starts_at_the_first_unaccepted_position() {
        // Draft generation temporarily writes `id_last` at base and must be
        // rewound to base before the verified target batch is processed.
        assert_eq!(mtp_draft_reset_position(17), 17);
        // `id_last` is decoded at base. With no accepted draft tokens, the
        // pending sampled replacement belongs at base + 1.
        assert_eq!(mtp_next_position(17, 0), 18);
        // Accepted draft tokens stay in the cache. Rollback begins immediately
        // after them, where the pending target-sampled token will be decoded.
        assert_eq!(mtp_next_position(17, 3), 21);
    }

    fn drain(splitter: &mut OutputSplitter, chunks: &[&str]) -> (String, String) {
        let (mut text, mut think) = (String::new(), String::new());
        let mut events: Vec<ProviderEvent> = Vec::new();
        for c in chunks {
            events.extend(splitter.push(c));
        }
        events.extend(splitter.finish());
        for e in events {
            match e {
                ProviderEvent::TextDelta(s) => text.push_str(&s),
                ProviderEvent::ReasoningDelta(s) => think.push_str(&s),
                _ => {}
            }
        }
        (text, think)
    }

    #[test]
    fn splits_reasoning_from_answer() {
        let mut s = OutputSplitter::new(LocalFamily::Qwen, false);
        let (text, think) = drain(&mut s, &["<think>weigh it</think>the answer"]);
        assert_eq!(think, "weigh it");
        assert_eq!(text, "the answer");
    }

    #[test]
    fn gemma_uses_its_own_reasoning_channel() {
        // Gemma 4 does not emit <think>; parsing it with Qwen's markers would
        // leak the whole reasoning trace to the user as prose.
        let mut s = OutputSplitter::new(LocalFamily::Gemma, false);
        let (text, think) = drain(
            &mut s,
            &["<|channel>thought", "weigh it", "<channel|>", "done"],
        );
        assert_eq!(think, "weigh it");
        assert_eq!(text, "done");
    }

    #[test]
    fn a_prompt_that_opens_the_reasoning_span_is_recognized() {
        let q = Markers::for_family(LocalFamily::Qwen);
        // Qwen3.5's thinking-ON generation prompt, verbatim.
        assert!(q.opens_thought("<|im_start|>assistant\n<think>\n"));
        // Thinking OFF prefills a CLOSED block — there is nothing to resume.
        assert!(!q.opens_thought("<|im_start|>assistant\n<think>\n\n</think>\n\n"));

        let g = Markers::for_family(LocalFamily::Gemma);
        // Gemma 4 opens the channel only when continuing after a tool response.
        assert!(g.opens_thought("<|channel>thought\n"));
        assert!(!g.opens_thought("<|turn>model\n"));
        // A replayed, already-closed thought channel is not open either.
        assert!(!g.opens_thought("<|channel>thought\nold\n<channel|>"));
    }

    #[test]
    fn prefilled_thinking_is_reasoning_not_the_answer() {
        // The bug: both shipped families open the reasoning span in the PROMPT,
        // so the model emits only the closing marker. Starting in Text mode
        // handed the user the entire reasoning trace as the answer, with the
        // stray closing tag on the end of it.
        for (family, close) in [
            (LocalFamily::Qwen, "</think>"),
            (LocalFamily::Gemma, "<channel|>"),
        ] {
            let mut s = OutputSplitter::new(family, true);
            let (text, think) = drain(&mut s, &["weigh ", "it", close, "the answer"]);
            assert_eq!(think, "weigh it");
            assert_eq!(text, "the answer");
        }
    }

    #[test]
    fn a_stray_close_marker_is_swallowed_not_shown() {
        // Backstop for the next template that opens a span nothing told us
        // about: the marker is a control token, never content. The text ahead of
        // it is already gone — that is what `thinking_prefilled` prevents — but
        // the tag itself must not reach the user.
        for (family, close) in [
            (LocalFamily::Qwen, "</think>"),
            (LocalFamily::Gemma, "<channel|>"),
        ] {
            let mut s = OutputSplitter::new(family, false);
            let (text, think) = drain(&mut s, &["missed it", close, "the answer"]);
            assert_eq!(text, "missed itthe answer");
            assert!(think.is_empty());
        }
    }

    #[test]
    fn tags_split_across_token_boundaries() {
        // The realistic case: llama.cpp hands back pieces, not tags.
        let mut s = OutputSplitter::new(LocalFamily::Qwen, false);
        let (text, think) = drain(&mut s, &["<th", "ink>", "hmm", "</thi", "nk>", "done"]);
        assert_eq!(think, "hmm");
        assert_eq!(text, "done");
    }

    #[test]
    fn qwen_tool_call_is_withheld_and_parsed_whole() {
        let mut s = OutputSplitter::new(LocalFamily::Qwen, false);
        let (text, _) = drain(
            &mut s,
            &[
                "ok ",
                "<tool_call>",
                r#"{"name": "run_command", "arg"#,
                r#"uments": {"cmd": "ls"}}"#,
                "</tool_call>",
            ],
        );
        // The envelope must never reach the user as prose.
        assert_eq!(text, "ok ");
        assert_eq!(s.calls.len(), 1);
        assert_eq!(s.calls[0].name, "run_command");
        assert_eq!(s.calls[0].arguments, r#"{"cmd":"ls"}"#);
    }

    #[test]
    fn qwen35_xml_tool_call_is_parsed() {
        // Qwen3.5 replaced Qwen3's JSON body with this XML form. Parsing it
        // with the JSON parser alone yields no calls at all, which surfaced as
        // "the loaded model did not produce tool calls" on the default model.
        let mut s = OutputSplitter::new(LocalFamily::Qwen, false);
        let (text, _) = drain(
            &mut s,
            &[
                "I will list them.",
                "<tool_call>\n<function=run_command>\n",
                "<parameter=command>\nls -la /tmp\n</parameter>\n",
                "<parameter=explanation>\nlist files\n</parameter>\n",
                "</function>\n</tool_call>",
            ],
        );
        assert_eq!(text, "I will list them.");
        assert_eq!(s.calls.len(), 1);
        assert_eq!(s.calls[0].name, "run_command");
        let args: serde_json::Value = serde_json::from_str(&s.calls[0].arguments).unwrap();
        assert_eq!(args["command"], "ls -la /tmp");
        assert_eq!(args["explanation"], "list files");
    }

    #[test]
    fn qwen35_values_stay_literal_text() {
        // The hazard that rules out JSON-sniffing values: these are ordinary
        // zsh, and a sniffing parser reads the first as an array and the
        // second as a number.
        let (name, args) = parse_qwen_xml_call(
            "<function=run_command>\n<parameter=command>\n[[ -f x ]] && echo yes\n</parameter>\n\
             <parameter=explanation>\n42\n</parameter>\n</function>",
        )
        .unwrap();
        assert_eq!(name, "run_command");
        let v: serde_json::Value = serde_json::from_str(&args).unwrap();
        assert_eq!(v["command"], "[[ -f x ]] && echo yes");
        assert_eq!(v["explanation"], "42");
    }

    #[test]
    fn qwen35_multiline_value_keeps_interior_newlines() {
        // Only the envelope's own newlines are stripped — a heredoc must
        // survive intact.
        let (_, args) = parse_qwen_xml_call(
            "<function=run_command>\n<parameter=command>\nline one\nline two\n</parameter>\n</function>",
        )
        .unwrap();
        let v: serde_json::Value = serde_json::from_str(&args).unwrap();
        assert_eq!(v["command"], "line one\nline two");
    }

    #[test]
    fn qwen_still_accepts_the_qwen3_json_body() {
        // The catalog spans both generations; an older download must keep
        // working after the XML fallback was added.
        let (name, args) = parse_tool_call(
            LocalFamily::Qwen,
            r#"{"name":"finish","arguments":{"summary":"ok"}}"#,
        )
        .map(|c| (c.name, c.arguments))
        .unwrap();
        assert_eq!(name, "finish");
        assert_eq!(args, r#"{"summary":"ok"}"#);
    }

    #[test]
    fn gemma_tool_call_dsl_becomes_json() {
        // Gemma 4 emits its own brace DSL, not JSON: strings are delimited by
        // <|"|> and top-level keys are bare.
        let mut s = OutputSplitter::new(LocalFamily::Gemma, false);
        let (text, _) = drain(
            &mut s,
            &[
                "sure ",
                "<|tool_call>call:run_command{command:<|\"|>ls -la /tmp<|\"|>",
                ",explanation:<|\"|>list files<|\"|>}",
                "<tool_call|>",
            ],
        );
        assert_eq!(text, "sure ");
        assert_eq!(s.calls.len(), 1);
        assert_eq!(s.calls[0].name, "run_command");
        let args: serde_json::Value = serde_json::from_str(&s.calls[0].arguments).unwrap();
        assert_eq!(args["command"], "ls -la /tmp");
        assert_eq!(args["explanation"], "list files");
    }

    #[test]
    fn gemma_dsl_handles_non_string_scalars_and_nesting() {
        let (name, args) = parse_gemma_call(
            r#"call:x{n:3,ok:true,missing:null,inner:{<|"|>k<|"|>:<|"|>v<|"|>},list:[1,2]}"#,
        )
        .unwrap();
        assert_eq!(name, "x");
        let v: serde_json::Value = serde_json::from_str(&args).unwrap();
        assert_eq!(v["n"], 3);
        assert_eq!(v["ok"], true);
        assert!(v["missing"].is_null());
        assert_eq!(v["inner"]["k"], "v");
        assert_eq!(v["list"], serde_json::json!([1, 2]));
    }

    #[test]
    fn a_comma_inside_a_gemma_string_does_not_split_arguments() {
        let (_, args) =
            parse_gemma_call(r#"call:x{cmd:<|"|>find . -name "a,b" -type f<|"|>,n:1}"#).unwrap();
        let v: serde_json::Value = serde_json::from_str(&args).unwrap();
        assert_eq!(v["cmd"], r#"find . -name "a,b" -type f"#);
        assert_eq!(v["n"], 1);
    }

    #[test]
    fn unterminated_tool_call_is_dropped_not_leaked() {
        for family in [LocalFamily::Qwen, LocalFamily::Gemma] {
            let mut s = OutputSplitter::new(family, false);
            let open = Markers::for_family(family).tool_open;
            let (text, _) = drain(&mut s, &[open, r#"{"name": "x""#]);
            assert!(text.is_empty(), "a half-written call must not become prose");
            assert!(s.calls.is_empty());
        }
    }

    #[test]
    fn multibyte_text_survives_holdback() {
        let mut s = OutputSplitter::new(LocalFamily::Qwen, false);
        let (text, _) = drain(&mut s, &["héllo wörld — ok", " done"]);
        assert_eq!(text, "héllo wörld — ok done");
    }

    #[test]
    fn plain_text_passes_through_untouched() {
        for family in [LocalFamily::Qwen, LocalFamily::Gemma] {
            let mut s = OutputSplitter::new(family, false);
            let (text, think) = drain(&mut s, &["just ", "a ", "sentence"]);
            assert_eq!(text, "just a sentence");
            assert!(think.is_empty());
        }
    }

    #[test]
    fn gguf_sampling_wins_over_generic_defaults() {
        // Gemma 4 ships general.sampling.top_k=64/top_p=0.95/temp=1.0; the old
        // code sent llama.cpp's generic CLI defaults instead.
        let d = Sampling::default();
        assert_eq!(d.top_k, 40, "fallback stays llama.cpp's default");
        let gemma = Sampling {
            top_k: 64,
            temp: 1.0,
            ..Sampling::default()
        };
        // No override: the model's own value survives.
        assert_eq!(gemma.with_override(None).temp, 1.0);
        assert_eq!(gemma.with_override(None).top_k, 64);
        // An explicit override wins, matching llama.cpp's precedence.
        assert_eq!(gemma.with_override(Some(0.2)).temp, 0.2);
    }

    #[test]
    fn temperature_is_floored_above_greedy() {
        // Qwen3 documents greedy decoding in thinking mode as producing endless
        // repetition, and thinking is on by default — so 0 must be unreachable
        // even though the settings key allows it.
        assert!(Sampling::default().with_override(Some(0.0)).temp > 0.0);
        assert!(Sampling::default().with_override(Some(-5.0)).temp > 0.0);
        assert_eq!(Sampling::default().with_override(Some(9.0)).temp, 2.0);
    }

    #[test]
    fn thinking_allowance_scales_with_effort() {
        assert_eq!(thinking_allowance(Effort::Off), 0);
        assert!(thinking_allowance(Effort::Max) > thinking_allowance(Effort::Low));
    }

    #[test]
    fn runtime_fallback_status_explains_the_cpu_retry() {
        assert_eq!(
            runtime_fallback_reason("vision model", "projector allocation failed"),
            "Vulkan loaded vision model, but its runtime allocation failed (projector allocation failed); using CPU"
        );
    }

    #[tokio::test]
    async fn an_empty_host_never_reports_another_hosts_accelerator() {
        let host = ModelHost::default();
        assert_eq!(host.acceleration_snapshot().await["backend"], "unloaded");
    }
}
