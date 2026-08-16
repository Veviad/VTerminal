//! One-click local embedding artifacts and the dedicated llama.cpp host.
//!
//! The guided catalog is intentionally closed: callers select a built-in id and
//! never provide a repository, URL, or path. Published artifacts are resolved at
//! immutable Hugging Face commits and checked against their LFS SHA-256 before an
//! installation record is written. The two E5 cards remain visible through
//! `embedding::BUILTIN_EMBEDDING_MODELS`, but are not installable until Veviad's
//! signed release manifest exists.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[cfg(feature = "local-llm")]
use super::embedding::EmbeddingBatchReport;
#[cfg(any(feature = "local-llm", test))]
use super::embedding::EmbeddingProviderDialect;
#[cfg(feature = "local-llm")]
use super::embedding::Pooling;
use super::embedding::{
    builtin_model, builtin_profile, EmbeddedBatch, EmbeddingError, EmbeddingInput,
    EmbeddingProfile, EmbeddingPurpose,
};

/// An immutable, release-reviewed artifact. These are official Hub LFS hashes,
/// not CDN etags (Xet-backed CDN etags identify reconstructed chunks instead).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct LocalEmbeddingArtifact {
    pub builtin_model_id: &'static str,
    pub repo_id: &'static str,
    pub filename: &'static str,
    pub revision: &'static str,
    pub sha256: &'static str,
    pub size_bytes: u64,
}

pub const LOCAL_EMBEDDING_ARTIFACTS: &[LocalEmbeddingArtifact] = &[
    LocalEmbeddingArtifact {
        builtin_model_id: "local/qwen3-embedding-0.6b",
        repo_id: "Qwen/Qwen3-Embedding-0.6B-GGUF",
        filename: "Qwen3-Embedding-0.6B-Q8_0.gguf",
        revision: "370f27d7550e0def9b39c1f16d3fbaa13aa67728",
        sha256: "06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439",
        size_bytes: 639_150_592,
    },
    LocalEmbeddingArtifact {
        builtin_model_id: "local/qwen3-embedding-4b",
        repo_id: "Qwen/Qwen3-Embedding-4B-GGUF",
        filename: "Qwen3-Embedding-4B-Q4_K_M.gguf",
        revision: "f4602530db1d980e16da9d7d3a70294cf5c190be",
        sha256: "2b0cf8f17b4c723c27303015383c27ec4bf2d8314bb677d05e920dd70bb0f16b",
        size_bytes: 2_496_703_776,
    },
    LocalEmbeddingArtifact {
        builtin_model_id: "local/qwen3-embedding-8b",
        repo_id: "Qwen/Qwen3-Embedding-8B-GGUF",
        filename: "Qwen3-Embedding-8B-Q4_K_M.gguf",
        revision: "69d0e58a13e463cd99a9b83e3f5fee7c10265fab",
        sha256: "3fcd3febec8b3fd64435204db75bf0dd73b91e8d0661e0331acfe7e7c3120b85",
        size_bytes: 4_676_804_928,
    },
    LocalEmbeddingArtifact {
        builtin_model_id: "local/embeddinggemma-300m",
        repo_id: "ggml-org/embeddinggemma-300M-GGUF",
        filename: "embeddinggemma-300M-Q8_0.gguf",
        revision: "0f741b5a6585bd53aeb15cd1372c56f2a0f65e12",
        sha256: "b5ce9d77a3fc4b3b39ccb5643c36777911cc4eb46a66962eadfa3f5f60490d63",
        size_bytes: 333_590_944,
    },
];

pub fn artifact(model_id: &str) -> Option<&'static LocalEmbeddingArtifact> {
    LOCAL_EMBEDDING_ARTIFACTS
        .iter()
        .find(|artifact| artifact.builtin_model_id == model_id)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InstalledEmbeddingArtifact {
    pub builtin_model_id: String,
    pub registry_model_id: String,
    pub repo_id: String,
    pub filename: String,
    pub path: String,
    pub size_bytes: u64,
    pub revision: String,
    pub sha256: String,
    pub installed_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct EmbeddingModelInstallView {
    pub model_id: String,
    pub installable: bool,
    pub unavailable_reason: Option<String>,
    pub repo_id: Option<String>,
    pub filename: Option<String>,
    pub revision: Option<String>,
    pub sha256: Option<String>,
    pub verified_size_bytes: Option<u64>,
    pub requires_license: bool,
    pub installed: bool,
    pub installed_path: Option<String>,
    pub default_profile: Option<EmbeddingProfile>,
    pub runtime_available: bool,
}

const INSTALL_REGISTRY_FILE: &str = "embedding-registry.json";
static INSTALL_REGISTRY_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn install_registry_path(models_dir: &Path) -> PathBuf {
    models_dir.join(INSTALL_REGISTRY_FILE)
}

fn read_install_registry(models_dir: &Path) -> Vec<InstalledEmbeddingArtifact> {
    let Ok(json) = std::fs::read_to_string(install_registry_path(models_dir)) else {
        return Vec::new();
    };
    let mut installed: Vec<InstalledEmbeddingArtifact> =
        serde_json::from_str(&json).unwrap_or_default();
    installed.retain(|record| Path::new(&record.path).is_file());
    installed
}

fn write_install_registry(
    models_dir: &Path,
    installed: &[InstalledEmbeddingArtifact],
) -> Result<(), String> {
    std::fs::create_dir_all(models_dir)
        .map_err(|error| format!("create model directory: {error}"))?;
    let path = install_registry_path(models_dir);
    let temporary = path.with_extension("json.tmp");
    let json = serde_json::to_vec_pretty(installed).map_err(|error| error.to_string())?;
    std::fs::write(&temporary, json)
        .map_err(|error| format!("write embedding registry: {error}"))?;
    std::fs::rename(&temporary, &path)
        .map_err(|error| format!("commit embedding registry: {error}"))
}

pub fn installed_artifacts(models_dir: &Path) -> Vec<InstalledEmbeddingArtifact> {
    read_install_registry(models_dir)
}

pub fn installed_artifact(models_dir: &Path, model_id: &str) -> Option<InstalledEmbeddingArtifact> {
    read_install_registry(models_dir)
        .into_iter()
        .find(|record| record.builtin_model_id == model_id)
}

/// Record an artifact only after `models::download` has verified its pinned size
/// and SHA-256. A catalog mismatch fails closed rather than adopting a file.
pub fn record_installation(
    models_dir: &Path,
    model: &crate::models::registry::LocalModel,
) -> Result<InstalledEmbeddingArtifact, String> {
    let record = installation_record(model)?;
    save_installation(models_dir, &record)?;
    Ok(record)
}

/// Build the exact record before the load/probe phase. It deliberately does not
/// make the artifact visible as installed; call `save_installation` only after
/// the runtime probe succeeds.
pub fn installation_record(
    model: &crate::models::registry::LocalModel,
) -> Result<InstalledEmbeddingArtifact, String> {
    let spec = LOCAL_EMBEDDING_ARTIFACTS
        .iter()
        .find(|spec| spec.repo_id == model.repo_id && spec.filename == model.filename)
        .ok_or_else(|| "downloaded file is not a guided embedding artifact".to_string())?;
    if model.size_bytes != spec.size_bytes {
        return Err(format!(
            "downloaded artifact has {} bytes; expected {}",
            model.size_bytes, spec.size_bytes
        ));
    }
    Ok(InstalledEmbeddingArtifact {
        builtin_model_id: spec.builtin_model_id.into(),
        registry_model_id: model.id.clone(),
        repo_id: model.repo_id.clone(),
        filename: model.filename.clone(),
        path: model.path.clone(),
        size_bytes: model.size_bytes,
        revision: spec.revision.into(),
        sha256: spec.sha256.into(),
        installed_at: chrono::Utc::now().to_rfc3339(),
    })
}

pub fn save_installation(
    models_dir: &Path,
    record: &InstalledEmbeddingArtifact,
) -> Result<(), String> {
    let _guard = INSTALL_REGISTRY_LOCK
        .lock()
        .map_err(|_| "embedding registry lock poisoned")?;
    let mut installed = read_install_registry(models_dir);
    installed.retain(|old| old.builtin_model_id != record.builtin_model_id);
    installed.push(record.clone());
    write_install_registry(models_dir, &installed)
}

pub fn remove_installation(
    models_dir: &Path,
    model_id: &str,
) -> Result<Option<InstalledEmbeddingArtifact>, String> {
    let _guard = INSTALL_REGISTRY_LOCK
        .lock()
        .map_err(|_| "embedding registry lock poisoned")?;
    let mut installed = read_install_registry(models_dir);
    let removed = installed
        .iter()
        .position(|record| record.builtin_model_id == model_id)
        .map(|index| installed.remove(index));
    write_install_registry(models_dir, &installed)?;
    Ok(removed)
}

pub fn profile_for_installation(
    installed: &InstalledEmbeddingArtifact,
    dimensions: Option<u32>,
) -> Result<EmbeddingProfile, EmbeddingError> {
    let model = builtin_model(&installed.builtin_model_id).ok_or_else(|| {
        EmbeddingError::Profile(format!(
            "unknown installed built-in {}",
            installed.builtin_model_id
        ))
    })?;
    builtin_profile(
        &installed.builtin_model_id,
        dimensions.unwrap_or(model.native_dimensions),
        &installed.revision,
        &installed.sha256,
    )
}

pub fn install_views(models_dir: &Path) -> Vec<EmbeddingModelInstallView> {
    let installed = read_install_registry(models_dir);
    super::embedding::BUILTIN_EMBEDDING_MODELS
        .iter()
        .map(|model| {
            let pin = artifact(model.id);
            let existing = installed
                .iter()
                .find(|record| record.builtin_model_id == model.id);
            let requires_license = matches!(
                model.artifact,
                super::embedding::ArtifactAvailability::HuggingFace {
                    requires_license: true,
                    ..
                }
            );
            EmbeddingModelInstallView {
                model_id: model.id.into(),
                installable: pin.is_some(),
                unavailable_reason: if pin.is_some() {
                    None
                } else {
                    model.artifact.unavailable_reason().map(str::to_owned)
                },
                repo_id: pin.map(|value| value.repo_id.into()),
                filename: pin.map(|value| value.filename.into()),
                revision: pin.map(|value| value.revision.into()),
                sha256: pin.map(|value| value.sha256.into()),
                verified_size_bytes: pin.map(|value| value.size_bytes),
                requires_license,
                installed: existing.is_some(),
                installed_path: existing.map(|value| value.path.clone()),
                default_profile: existing
                    .and_then(|value| profile_for_installation(value, None).ok()),
                runtime_available: cfg!(feature = "local-llm"),
            }
        })
        .collect()
}

pub async fn verify_installed_artifact(
    installed: &InstalledEmbeddingArtifact,
) -> Result<(), String> {
    let expected = artifact(&installed.builtin_model_id)
        .ok_or_else(|| "installation no longer belongs to the guided catalog".to_string())?;
    if installed.revision != expected.revision
        || !installed.sha256.eq_ignore_ascii_case(expected.sha256)
        || installed.size_bytes != expected.size_bytes
    {
        return Err("installation metadata does not match the pinned catalog artifact".into());
    }
    let path = PathBuf::from(&installed.path);
    let metadata = tokio::fs::metadata(&path)
        .await
        .map_err(|error| format!("read installed artifact: {error}"))?;
    if metadata.len() != expected.size_bytes {
        return Err(format!(
            "installed artifact has {} bytes; expected {}",
            metadata.len(),
            expected.size_bytes
        ));
    }
    let actual = tokio::task::spawn_blocking(move || crate::models::download::sha256_file(&path))
        .await
        .map_err(|error| format!("artifact verification task failed: {error}"))??;
    if !actual.eq_ignore_ascii_case(expected.sha256) {
        return Err(format!(
            "installed artifact SHA-256 is {actual}; expected {}",
            expected.sha256
        ));
    }
    Ok(())
}

#[cfg(feature = "local-llm")]
mod runtime {
    use std::num::NonZeroU32;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Arc;

    use llama_cpp_2::context::params::{LlamaContextParams, LlamaPoolingType};
    use llama_cpp_2::llama_batch::LlamaBatch;
    use llama_cpp_2::model::{AddBos, LlamaModel};

    use super::*;

    enum HostSlot {
        Empty,
        Ready {
            builtin_model_id: String,
            artifact_sha256: String,
            path: String,
            model: Arc<LlamaModel>,
            acceleration: crate::provider::local::LocalAcceleration,
        },
    }

    struct ReadyEmbedding {
        model: Arc<LlamaModel>,
        #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
        acceleration: crate::provider::local::LocalAcceleration,
    }

    #[derive(Debug)]
    enum EmbedAttemptError {
        /// Context allocation and decode can fail after a Vulkan model has
        /// loaded successfully. These are the only failures a CPU reload can
        /// reasonably repair.
        Runtime(EmbeddingError),
        Permanent(EmbeddingError),
    }

    impl EmbedAttemptError {
        fn into_error(self) -> EmbeddingError {
            match self {
                Self::Runtime(error) | Self::Permanent(error) => error,
            }
        }
    }

    #[cfg(any(target_os = "windows", test))]
    fn should_retry_on_cpu(
        acceleration: &crate::provider::local::LocalAcceleration,
        error: &EmbedAttemptError,
    ) -> bool {
        acceleration.backend == "vulkan" && matches!(error, EmbedAttemptError::Runtime(_))
    }

    pub struct EmbeddingHost {
        inner: tokio::sync::Mutex<HostSlot>,
        gate: Arc<tokio::sync::Semaphore>,
        generation: AtomicU64,
    }

    impl Default for EmbeddingHost {
        fn default() -> Self {
            Self::with_gate(Arc::new(tokio::sync::Semaphore::new(1)))
        }
    }

    impl EmbeddingHost {
        pub fn with_gate(gate: Arc<tokio::sync::Semaphore>) -> Self {
            Self {
                inner: tokio::sync::Mutex::new(HostSlot::Empty),
                gate,
                generation: AtomicU64::new(0),
            }
        }

        pub async fn status(&self) -> Option<String> {
            match &*self.inner.lock().await {
                HostSlot::Empty => None,
                HostSlot::Ready {
                    builtin_model_id, ..
                } => Some(builtin_model_id.clone()),
            }
        }

        pub async fn acceleration_snapshot(&self) -> serde_json::Value {
            let acceleration = match &*self.inner.lock().await {
                HostSlot::Ready { acceleration, .. } => acceleration.clone(),
                HostSlot::Empty => crate::provider::local::LocalAcceleration::unloaded(),
            };
            serde_json::to_value(acceleration)
                .unwrap_or_else(|_| serde_json::json!({ "backend": "unknown" }))
        }

        pub async fn unload(&self) {
            self.generation.fetch_add(1, Ordering::SeqCst);
            *self.inner.lock().await = HostSlot::Empty;
        }

        async fn ready_model(
            &self,
            installed: &InstalledEmbeddingArtifact,
            _profile: &EmbeddingProfile,
        ) -> Result<ReadyEmbedding, EmbeddingError> {
            {
                let slot = self.inner.lock().await;
                if let HostSlot::Ready {
                    builtin_model_id,
                    artifact_sha256,
                    path,
                    model,
                    acceleration,
                } = &*slot
                {
                    if builtin_model_id == &installed.builtin_model_id
                        && artifact_sha256.eq_ignore_ascii_case(&installed.sha256)
                        && path == &installed.path
                    {
                        return Ok(ReadyEmbedding {
                            model: Arc::clone(model),
                            acceleration: acceleration.clone(),
                        });
                    }
                }
            }

            let my_generation = self.generation.load(Ordering::SeqCst);
            verify_installed_artifact(installed)
                .await
                .map_err(EmbeddingError::Profile)?;
            let path = installed.path.clone();
            #[cfg(target_os = "windows")]
            let profile = _profile.clone();
            let (model, acceleration) = tokio::task::spawn_blocking(move || {
                let (model, acceleration) =
                    crate::provider::local::load_model_with_fallback(&path, "embedding model")?;
                #[cfg(target_os = "windows")]
                let (model, acceleration) = {
                    let (model, acceleration, ()) =
                        crate::provider::local::validate_or_retry_on_cpu(
                            &path,
                            "embedding model",
                            model,
                            acceleration,
                            |model, _| validate_embedding_context(model, &profile),
                        )?;
                    (model, acceleration)
                };
                Ok::<_, String>((Arc::new(model), acceleration))
            })
            .await
            .map_err(|error| {
                EmbeddingError::Transport(format!("embedding load task failed: {error}"))
            })?
            .map_err(EmbeddingError::Transport)?;

            let mut slot = self.inner.lock().await;
            if self.generation.load(Ordering::SeqCst) != my_generation {
                return Err(EmbeddingError::Transport(
                    "embedding load cancelled by unload".into(),
                ));
            }
            *slot = HostSlot::Ready {
                builtin_model_id: installed.builtin_model_id.clone(),
                artifact_sha256: installed.sha256.clone(),
                path: installed.path.clone(),
                model: Arc::clone(&model),
                acceleration: acceleration.clone(),
            };
            Ok(ReadyEmbedding {
                model,
                acceleration,
            })
        }

        // Kept type-checked on non-Windows hosts even though only the Windows
        // call site is enabled. Native behavior remains unchanged, while CI on
        // another host can still catch ownership mistakes in this transition.
        #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
        async fn reload_on_cpu_after_runtime_failure(
            &self,
            installed: &InstalledEmbeddingArtifact,
            ready: ReadyEmbedding,
            failure: &EmbeddingError,
        ) -> Result<ReadyEmbedding, EmbeddingError> {
            let my_generation = self.generation.load(Ordering::SeqCst);
            let slot_model = {
                let mut slot = self.inner.lock().await;
                let matches_failed_model = matches!(
                    &*slot,
                    HostSlot::Ready {
                        builtin_model_id,
                        artifact_sha256,
                        path,
                        model,
                        acceleration,
                    } if builtin_model_id == &installed.builtin_model_id
                        && artifact_sha256.eq_ignore_ascii_case(&installed.sha256)
                        && path == &installed.path
                        && acceleration.backend == "vulkan"
                        && Arc::ptr_eq(model, &ready.model)
                );
                if !matches_failed_model {
                    return Err(EmbeddingError::Transport(format!(
                        "embedding Vulkan runtime failed, but the loaded model changed before CPU fallback: {failure}"
                    )));
                }
                match std::mem::replace(&mut *slot, HostSlot::Empty) {
                    HostSlot::Ready { model, .. } => model,
                    HostSlot::Empty => unreachable!("matched slot was ready"),
                }
            };

            // No request can acquire another embedding model while `embed`
            // holds the shared inference permit. Drop the host's Arc and
            // require unique ownership before loading CPU weights, so the
            // Vulkan allocation is actually gone rather than merely hidden.
            drop(slot_model);
            let model = Arc::try_unwrap(ready.model).map_err(|_| {
                EmbeddingError::Transport(
                    "embedding Vulkan model was still in use; CPU fallback was not attempted"
                        .into(),
                )
            })?;
            let path = installed.path.clone();
            let runtime_error = failure.to_string();
            let (model, acceleration) = tokio::task::spawn_blocking(move || {
                let (model, acceleration, ()) = crate::provider::local::validate_or_retry_on_cpu(
                    &path,
                    "embedding model",
                    model,
                    ready.acceleration,
                    |_model, accelerated| {
                        if accelerated {
                            Err(runtime_error.clone())
                        } else {
                            Ok(())
                        }
                    },
                )?;
                Ok::<_, String>((Arc::new(model), acceleration))
            })
            .await
            .map_err(|error| {
                EmbeddingError::Transport(format!(
                    "embedding CPU fallback task failed after {failure}: {error}"
                ))
            })?
            .map_err(|error| {
                EmbeddingError::Transport(format!(
                    "embedding CPU fallback failed after {failure}: {error}"
                ))
            })?;

            let mut slot = self.inner.lock().await;
            if self.generation.load(Ordering::SeqCst) != my_generation {
                return Err(EmbeddingError::Transport(
                    "embedding CPU fallback cancelled by unload".into(),
                ));
            }
            *slot = HostSlot::Ready {
                builtin_model_id: installed.builtin_model_id.clone(),
                artifact_sha256: installed.sha256.clone(),
                path: installed.path.clone(),
                model: Arc::clone(&model),
                acceleration: acceleration.clone(),
            };
            Ok(ReadyEmbedding {
                model,
                acceleration,
            })
        }

        /// Transform, tokenize, pool, MRL-truncate, and L2-normalize a batch.
        /// The shared inference permit prevents chat/vision/embedding contexts
        /// from allocating concurrently when the app wires all three hosts to it.
        pub async fn embed(
            &self,
            installed: &InstalledEmbeddingArtifact,
            profile: &EmbeddingProfile,
            purpose: EmbeddingPurpose,
            inputs: &[EmbeddingInput],
        ) -> Result<EmbeddedBatch, EmbeddingError> {
            validate_profile_matches_installation(installed, profile)?;
            if inputs.is_empty() {
                return Ok(empty_batch(profile.dimensions()));
            }
            if let Some(index) = inputs.iter().position(|input| input.text.trim().is_empty()) {
                return Err(EmbeddingError::Vector(format!(
                    "input {index} is empty or whitespace-only"
                )));
            }
            let transformed: Vec<String> = inputs
                .iter()
                .map(|input| profile.transform(purpose, input))
                .collect();
            // Acquire before cloning the resident model. This makes the
            // Vulkan-to-CPU transition exclusive: no queued embedding request
            // can retain and later execute against the discarded GPU model.
            let _permit =
                self.gate.acquire().await.map_err(|_| {
                    EmbeddingError::Transport("local inference gate is closed".into())
                })?;
            let ready = self.ready_model(installed, profile).await?;
            if usize::try_from(ready.model.n_embd_out()).unwrap_or(0) < profile.dimensions() {
                return Err(EmbeddingError::Profile(format!(
                    "GGUF emits {} dimensions, fewer than profile's {}",
                    ready.model.n_embd_out(),
                    profile.dimensions()
                )));
            }
            let profile = Arc::new(profile.clone());
            let transformed = Arc::new(transformed);
            let first_model = Arc::clone(&ready.model);
            let first_profile = Arc::clone(&profile);
            let first_inputs = Arc::clone(&transformed);
            let first = tokio::task::spawn_blocking(move || {
                embed_blocking(&first_model, &first_profile, &first_inputs)
            })
            .await
            .map_err(|error| {
                EmbeddingError::Transport(format!("embedding task failed: {error}"))
            })?;

            match first {
                Ok(batch) => Ok(batch),
                Err(failure) => {
                    // Unit-test builds keep this branch type-checked on other
                    // hosts; the predicate still restricts it to a literal
                    // Vulkan status, which non-Windows production never has.
                    #[cfg(any(target_os = "windows", test))]
                    {
                        if should_retry_on_cpu(&ready.acceleration, &failure) {
                            let original = failure.into_error();
                            let cpu = self
                                .reload_on_cpu_after_runtime_failure(installed, ready, &original)
                                .await?;
                            let retry = tokio::task::spawn_blocking(move || {
                                embed_blocking(&cpu.model, &profile, &transformed)
                            })
                            .await
                            .map_err(|error| {
                                EmbeddingError::Transport(format!(
                                    "embedding CPU retry task failed: {error}"
                                ))
                            })?;
                            return retry.map_err(EmbedAttemptError::into_error);
                        }
                    }
                    Err(failure.into_error())
                }
            }
        }
    }

    fn pooling(value: Pooling) -> Result<LlamaPoolingType, EmbeddingError> {
        match value {
            Pooling::Mean => Ok(LlamaPoolingType::Mean),
            Pooling::LastToken => Ok(LlamaPoolingType::Last),
            Pooling::Cls => Ok(LlamaPoolingType::Cls),
            Pooling::ProviderDefined => Err(EmbeddingError::Profile(
                "a local profile must define its pooling operation".into(),
            )),
        }
    }

    #[cfg(target_os = "windows")]
    fn validate_embedding_context(
        model: &LlamaModel,
        profile: &EmbeddingProfile,
    ) -> Result<(), String> {
        let threads = crate::provider::local::perf_cores();
        let params = LlamaContextParams::default()
            .with_n_ctx(NonZeroU32::new(512.min(model.n_ctx_train()).max(1)))
            .with_n_batch(512)
            .with_n_ubatch(512)
            .with_n_threads(threads)
            .with_n_threads_batch(threads)
            .with_embeddings(true)
            .with_pooling_type(
                pooling(profile.semantic().pooling).map_err(|error| error.to_string())?,
            );
        let context = model
            .new_context(
                crate::provider::local::backend().map_err(|error| error.to_string())?,
                params,
            )
            .map_err(|error| format!("embedding context creation failed: {error}"))?;
        drop(context);
        Ok(())
    }

    fn embed_blocking(
        model: &LlamaModel,
        profile: &EmbeddingProfile,
        inputs: &[String],
    ) -> Result<EmbeddedBatch, EmbedAttemptError> {
        let backend = crate::provider::local::backend()
            .map_err(EmbeddingError::Transport)
            .map_err(EmbedAttemptError::Permanent)?;
        let mut vectors = Vec::with_capacity(inputs.len());
        for (index, input) in inputs.iter().enumerate() {
            // `add_special=true` is how llama.cpp's embedding runner applies the
            // vocabulary-declared BOS/EOS policy; it is not a hand-written token.
            let tokens = model.str_to_token(input, AddBos::Always).map_err(|error| {
                EmbedAttemptError::Permanent(EmbeddingError::Vector(format!(
                    "tokenize input {index}: {error}"
                )))
            })?;
            if tokens.is_empty() {
                return Err(EmbedAttemptError::Permanent(EmbeddingError::Vector(
                    format!("input {index} tokenized to no tokens"),
                )));
            }
            let max_tokens = profile
                .semantic()
                .max_input_tokens
                .unwrap_or(model.n_ctx_train());
            if tokens.len() > max_tokens as usize {
                return Err(EmbedAttemptError::Permanent(EmbeddingError::Vector(
                    format!(
                        "input {index} is {} tokens; this profile rejects inputs over {max_tokens}",
                        tokens.len()
                    ),
                )));
            }
            let n_ctx = u32::try_from(tokens.len())
                .unwrap_or(u32::MAX)
                .max(512)
                .min(model.n_ctx_train());
            if tokens.len() > n_ctx as usize {
                return Err(EmbedAttemptError::Permanent(EmbeddingError::Vector(
                    format!(
                        "input {index} is {} tokens; GGUF context is {n_ctx}",
                        tokens.len()
                    ),
                )));
            }
            let n_batch = u32::try_from(tokens.len()).unwrap_or(u32::MAX).max(512);
            let threads = crate::provider::local::perf_cores();
            let params = LlamaContextParams::default()
                .with_n_ctx(NonZeroU32::new(n_ctx))
                .with_n_batch(n_batch)
                .with_n_ubatch(n_batch.min(512))
                .with_n_threads(threads)
                .with_n_threads_batch(threads)
                .with_embeddings(true)
                .with_pooling_type(
                    pooling(profile.semantic().pooling).map_err(EmbedAttemptError::Permanent)?,
                );
            let mut context = model.new_context(backend, params).map_err(|error| {
                EmbedAttemptError::Runtime(EmbeddingError::Transport(format!(
                    "create context for input {index}: {error}"
                )))
            })?;
            let mut batch = LlamaBatch::new(tokens.len(), 1);
            batch.add_sequence(&tokens, 0, false).map_err(|error| {
                EmbedAttemptError::Permanent(EmbeddingError::Vector(format!(
                    "batch input {index}: {error}"
                )))
            })?;
            context.decode(&mut batch).map_err(|error| {
                EmbedAttemptError::Runtime(EmbeddingError::Transport(format!(
                    "evaluate input {index}: {error}"
                )))
            })?;
            let output = context.embeddings_seq_ith(0).map_err(|error| {
                EmbedAttemptError::Permanent(EmbeddingError::Vector(format!(
                    "read embedding {index}: {error}"
                )))
            })?;
            if output.len() < profile.dimensions() {
                return Err(EmbedAttemptError::Permanent(EmbeddingError::Vector(
                    format!(
                        "embedding {index} has {} dimensions; expected at least {}",
                        output.len(),
                        profile.dimensions()
                    ),
                )));
            }
            // Qwen3 and EmbeddingGemma publish Matryoshka spaces. Reduction is
            // the leading slice followed by normalization, and the chosen width
            // is already part of the immutable profile fingerprint.
            vectors.push(output[..profile.dimensions()].to_vec());
        }
        let (vectors, report) = super::super::embedding::validate_and_normalize(
            vectors,
            inputs.len(),
            profile.dimensions(),
        )
        .map_err(EmbedAttemptError::Permanent)?;
        Ok(EmbeddedBatch { vectors, report })
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn acceleration(backend: &str) -> crate::provider::local::LocalAcceleration {
            crate::provider::local::LocalAcceleration {
                backend: backend.into(),
                device_name: None,
                device_memory_bytes: None,
                fallback_reason: None,
            }
        }

        #[test]
        fn cpu_retry_is_limited_to_vulkan_runtime_failures() {
            let runtime = EmbedAttemptError::Runtime(EmbeddingError::Transport(
                "create context for input 0: allocation failed".into(),
            ));
            let invalid = EmbedAttemptError::Permanent(EmbeddingError::Vector(
                "input 0 exceeds the profile limit".into(),
            ));

            assert!(should_retry_on_cpu(&acceleration("vulkan"), &runtime));
            assert!(!should_retry_on_cpu(&acceleration("cpu"), &runtime));
            assert!(!should_retry_on_cpu(&acceleration("metal"), &runtime));
            assert!(!should_retry_on_cpu(&acceleration("vulkan"), &invalid));
        }

        #[test]
        fn retryable_failure_preserves_the_original_user_facing_error() {
            let failure = EmbedAttemptError::Runtime(EmbeddingError::Transport(
                "evaluate input 2: device allocation failed".into(),
            ));
            assert_eq!(
                failure.into_error().to_string(),
                "embedding request failed: evaluate input 2: device allocation failed"
            );
        }
    }
}

#[cfg(feature = "local-llm")]
pub use runtime::EmbeddingHost;

#[cfg(not(feature = "local-llm"))]
#[derive(Default)]
pub struct EmbeddingHost;

#[cfg(not(feature = "local-llm"))]
impl EmbeddingHost {
    pub fn with_gate(_gate: std::sync::Arc<tokio::sync::Semaphore>) -> Self {
        Self
    }

    pub async fn status(&self) -> Option<String> {
        None
    }

    pub async fn unload(&self) {}

    pub async fn acceleration_snapshot(&self) -> serde_json::Value {
        serde_json::json!({
            "backend": "unavailable",
            "device_name": null,
            "device_memory_bytes": null,
            "fallback_reason": "local inference is not included in this build"
        })
    }

    pub async fn embed(
        &self,
        _installed: &InstalledEmbeddingArtifact,
        _profile: &EmbeddingProfile,
        _purpose: EmbeddingPurpose,
        _inputs: &[EmbeddingInput],
    ) -> Result<EmbeddedBatch, EmbeddingError> {
        Err(EmbeddingError::Transport(
            "local embedding runtime is unavailable in this build (compile with --features local-llm)"
                .into(),
        ))
    }
}

#[cfg(any(feature = "local-llm", test))]
fn validate_profile_matches_installation(
    installed: &InstalledEmbeddingArtifact,
    profile: &EmbeddingProfile,
) -> Result<(), EmbeddingError> {
    let catalog = builtin_model(&installed.builtin_model_id).ok_or_else(|| {
        EmbeddingError::Profile("installed artifact is not in the guided catalog".into())
    })?;
    let semantic = profile.semantic();
    if semantic.provider != EmbeddingProviderDialect::LocalLlamaCpp
        || semantic.model_id != catalog.upstream_model_id
        || semantic.revision.as_deref() != Some(installed.revision.as_str())
        || !semantic
            .artifact_sha256
            .as_deref()
            .is_some_and(|digest| digest.eq_ignore_ascii_case(&installed.sha256))
        || !catalog.dimensions.supports(semantic.dimensions)
        || semantic.pooling != catalog.pooling
    {
        return Err(EmbeddingError::Profile(
            "embedding profile does not exactly match the installed artifact and built-in semantics"
                .into(),
        ));
    }
    Ok(())
}

#[cfg(feature = "local-llm")]
fn empty_batch(dimensions: usize) -> EmbeddedBatch {
    EmbeddedBatch {
        vectors: Vec::new(),
        report: EmbeddingBatchReport {
            count: 0,
            dimensions,
            provider_vectors_were_normalized: true,
            min_original_norm: 0.0,
            max_original_norm: 0.0,
        },
    }
}

/// Query-time convenience used by unified retrieval. It resolves the exact
/// digest-pinned installation from the profile, never merely by dimension.
pub async fn embed_query(
    app: &tauri::AppHandle<tauri::Wry>,
    profile: &EmbeddingProfile,
    query: &str,
) -> Result<Vec<f32>, String> {
    use tauri::Manager;

    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    let override_dir = crate::commands::settings::read_string(app, "models_dir");
    let models_dir = crate::models::registry::models_dir(&app_data, override_dir.as_deref());
    let semantic = profile.semantic();
    let expected_digest = semantic
        .artifact_sha256
        .as_deref()
        .ok_or_else(|| "local embedding profile has no artifact digest".to_string())?;
    let installed = read_install_registry(&models_dir)
        .into_iter()
        .find(|value| {
            value.sha256.eq_ignore_ascii_case(expected_digest)
                && builtin_model(&value.builtin_model_id)
                    .is_some_and(|model| model.upstream_model_id == semantic.model_id)
        })
        .ok_or_else(|| {
            format!(
                "the exact local embedding artifact for profile {} is not installed",
                profile.fingerprint()
            )
        })?;
    let host = app.state::<EmbeddingHost>();
    let mut batch = host
        .embed(
            &installed,
            profile,
            EmbeddingPurpose::Query,
            &[EmbeddingInput::text(query)],
        )
        .await
        .map_err(|error| error.to_string())?;
    batch
        .vectors
        .pop()
        .ok_or_else(|| "local embedding runtime returned no query vector".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn published_catalog_is_exact_and_closed() {
        assert_eq!(LOCAL_EMBEDDING_ARTIFACTS.len(), 4);
        for value in LOCAL_EMBEDDING_ARTIFACTS {
            assert_eq!(value.revision.len(), 40);
            assert!(value.revision.bytes().all(|byte| byte.is_ascii_hexdigit()));
            assert_eq!(value.sha256.len(), 64);
            assert!(value.sha256.bytes().all(|byte| byte.is_ascii_hexdigit()));
            assert!(value.size_bytes > 300_000_000);
            assert!(builtin_model(value.builtin_model_id).is_some());
        }
        assert!(artifact("local/multilingual-e5-base").is_none());
        assert!(artifact("local/multilingual-e5-large").is_none());
    }

    #[test]
    fn installation_creates_a_digest_pinned_default_profile() {
        let spec = artifact("local/qwen3-embedding-0.6b").unwrap();
        let installed = InstalledEmbeddingArtifact {
            builtin_model_id: spec.builtin_model_id.into(),
            registry_model_id: "registry".into(),
            repo_id: spec.repo_id.into(),
            filename: spec.filename.into(),
            path: "/does/not/matter.gguf".into(),
            size_bytes: spec.size_bytes,
            revision: spec.revision.into(),
            sha256: spec.sha256.into(),
            installed_at: "now".into(),
        };
        let profile = profile_for_installation(&installed, None).unwrap();
        assert_eq!(profile.dimensions(), 1024);
        assert_eq!(
            profile.semantic().artifact_sha256.as_deref(),
            Some(spec.sha256)
        );
        validate_profile_matches_installation(&installed, &profile).unwrap();
    }

    #[test]
    fn an_mrl_dimension_is_immutable_profile_state() {
        let spec = artifact("local/qwen3-embedding-8b").unwrap();
        let installed = InstalledEmbeddingArtifact {
            builtin_model_id: spec.builtin_model_id.into(),
            registry_model_id: "registry".into(),
            repo_id: spec.repo_id.into(),
            filename: spec.filename.into(),
            path: "/does/not/matter.gguf".into(),
            size_bytes: spec.size_bytes,
            revision: spec.revision.into(),
            sha256: spec.sha256.into(),
            installed_at: "now".into(),
        };
        let native = profile_for_installation(&installed, None).unwrap();
        let reduced = profile_for_installation(&installed, Some(768)).unwrap();
        assert_ne!(native.fingerprint(), reduced.fingerprint());
        assert_eq!(reduced.dimensions(), 768);
    }

    #[cfg(feature = "local-llm")]
    #[tokio::test]
    async fn an_empty_embedding_host_has_its_own_unloaded_status() {
        let host = EmbeddingHost::default();
        assert_eq!(host.acceleration_snapshot().await["backend"], "unloaded");
    }
}
