//! Commands for the on-device vision sidecar.
//!
//! Every one is mirrored by a `#[cfg(not(feature = "local-llm"))]` stub whose
//! `rename_all` matches — the trap `commands/models.rs` records, where a mismatched
//! stub fails at runtime with "missing required key" in a build nobody tested.

use tauri::ipc::Channel;
use tauri::{Manager, State, Wry};

use crate::commands::settings;
#[cfg(feature = "local-llm")]
use crate::models::download;
use crate::models::vision::{self, VisionModel};
use crate::models::{registry, DownloadEvent, DownloadState, LoadEvent};

/// Decoded ceiling on one image. Above this the sidecar's own token budget would
/// reject it anyway, and base64 of a 20MB image is a 27MB IPC argument.
#[cfg_attr(not(feature = "local-llm"), allow(dead_code))]
const MAX_IMAGE_BYTES: usize = 20 * 1024 * 1024;

#[cfg_attr(not(feature = "local-llm"), allow(dead_code))]
fn models_dir(app: &tauri::AppHandle<Wry>) -> Result<std::path::PathBuf, String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let override_dir = settings::read_string(app, "models_dir");
    Ok(registry::models_dir(&app_data, override_dir.as_deref()))
}

#[cfg_attr(not(feature = "local-llm"), allow(dead_code))]
fn spec(model_id: &str) -> Result<&'static VisionModel, String> {
    vision::find(model_id).ok_or_else(|| format!("unknown vision model: {model_id}"))
}

/// Both files present on disk, per the registry's own retention rule (it drops
/// entries whose file has vanished, which is why two entries beat one row with an
/// `mmproj_path` field).
#[cfg_attr(not(feature = "local-llm"), allow(dead_code))]
fn both_downloaded(dir: &std::path::Path, m: &VisionModel) -> bool {
    let have = registry::load(dir);
    let wanted = [
        registry::model_id(m.repo_id, m.filename),
        registry::model_id(m.repo_id, m.mmproj_filename),
    ];
    wanted.iter().all(|id| have.iter().any(|l| &l.id == id))
}

#[cfg_attr(not(feature = "local-llm"), allow(dead_code))]
fn path_of(dir: &std::path::Path, repo_id: &str, filename: &str) -> Option<String> {
    let id = registry::model_id(repo_id, filename);
    registry::load(dir)
        .into_iter()
        .find(|l| l.id == id)
        .map(|l| l.path)
}

/// One row of the sidecar picker.
#[derive(serde::Serialize)]
pub struct VisionCatalogEntry {
    #[serde(flatten)]
    pub model: &'static VisionModel,
    pub total_bytes: u64,
    /// Whether it fits **alongside the currently selected chat model**, not in
    /// isolation. A sidecar that fits alone but not next to the model actually
    /// loaded is not usable, and saying otherwise sets up a failure at load time.
    pub fits: bool,
    /// RAM the PAIR needs, so the UI can name a number instead of "too big".
    pub required_ram_gb: u64,
    /// Both files, not just the weights.
    pub downloaded: bool,
    pub selected: bool,
}

#[cfg(feature = "local-llm")]
mod enabled {
    use super::*;
    use crate::provider::vision::VisionHost;

    /// Bytes of the chat model the user has selected, for the pair-fit question.
    /// Zero for a cloud or remote model — those cost nothing locally, so the
    /// sidecar only has to fit on its own.
    fn active_chat_bytes(app: &tauri::AppHandle<Wry>) -> u64 {
        crate::commands::ai::active_model(app)
            .local
            .map(|l| l.size_bytes)
            .unwrap_or(0)
    }

    fn total_ram() -> u64 {
        use sysinfo::System;
        let mut sys = System::new();
        sys.refresh_memory();
        sys.total_memory()
    }

    #[tauri::command(rename_all = "snake_case")]
    pub async fn vision_catalog(
        app: tauri::AppHandle<Wry>,
    ) -> Result<Vec<VisionCatalogEntry>, String> {
        let dir = models_dir(&app)?;
        let ram = total_ram();
        let chat_bytes = active_chat_bytes(&app);
        let selected = settings::read_string(&app, "vision_model_id");

        Ok(vision::VISION_CATALOG
            .iter()
            .map(|m| {
                let total = m.total_bytes();
                // Both gates: its own floor AND room beside the chat model.
                let alone = registry::fits_in_ram(total, m.min_ram_gb, ram);
                let paired = registry::pair_fits_in_ram(chat_bytes, total, ram);
                VisionCatalogEntry {
                    model: m,
                    total_bytes: total,
                    fits: alone && paired,
                    // The pair's requirement, rounded up, so the copy can say
                    // "needs 24 GB with Qwen3.5 9B" rather than just "too big".
                    required_ram_gb: required_ram_gb(chat_bytes, total),
                    downloaded: both_downloaded(&dir, m),
                    selected: selected.as_deref() == Some(m.id),
                }
            })
            .collect())
    }

    /// Smallest total RAM at which `pair_fits_in_ram` would pass, in whole GB.
    fn required_ram_gb(chat_bytes: u64, vision_bytes: u64) -> u64 {
        // (chat + vision) * 1.3 < total * 0.6  =>  total > (sum * 1.3) / 0.6
        let needed = ((chat_bytes + vision_bytes) as f64) * 1.3 / 0.6;
        // Report in GiB, since that is how machines are sold.
        (needed / (1024.0 * 1024.0 * 1024.0)).ceil() as u64
    }

    /// Download weights + projector as ONE progress stream.
    ///
    /// The projector goes first: it is the small file and the one that proves the
    /// repo layout still matches the catalog. Failing after 880MB beats failing
    /// after 5GB.
    #[tauri::command(rename_all = "snake_case")]
    pub async fn vision_download(
        app: tauri::AppHandle<Wry>,
        state: State<'_, DownloadState>,
        download_id: String,
        model_id: String,
        on_event: Channel<DownloadEvent>,
    ) -> Result<(), String> {
        let m = spec(&model_id)?;
        let dir = models_dir(&app)?;
        let hf_token =
            settings::read_credential(&app, crate::credentials::CredentialId::HuggingFace)?;
        let total = m.total_bytes();

        // Per-FILE guards, matching models_download: download_id is caller-chosen
        // and fresh per click, so it guards nothing.
        let keys = [
            format!("{}/{}", m.repo_id, m.mmproj_filename),
            format!("{}/{}", m.repo_id, m.filename),
        ];
        {
            let mut in_flight = state
                .in_flight
                .lock()
                .map_err(|_| "download state poisoned")?;
            for key in &keys {
                if in_flight.contains(key) {
                    return Err("this model is already downloading".into());
                }
            }
            for key in &keys {
                in_flight.insert(key.clone());
            }
        }

        // A oneshot cannot be split, so the outer cancel fans out to two inner ones
        // through a relay task.
        let (outer_tx, outer_rx) = tokio::sync::oneshot::channel::<()>();
        let (mmproj_cancel_tx, mmproj_cancel_rx) = tokio::sync::oneshot::channel::<()>();
        let (weights_cancel_tx, weights_cancel_rx) = tokio::sync::oneshot::channel::<()>();
        {
            let mut map = state.cancel.lock().map_err(|_| "download state poisoned")?;
            map.insert(download_id.clone(), outer_tx);
        }
        tokio::spawn(async move {
            if outer_rx.await.is_ok() {
                let _ = mmproj_cancel_tx.send(());
                let _ = weights_cancel_tx.send(());
            }
        });

        // ONE Started for the batch, with the total known from the catalog — so no
        // HEAD is needed and the bar never jumps when the second file begins.
        on_event
            .send(DownloadEvent::Started {
                download_id: download_id.clone(),
                total_bytes: Some(total),
                resumed_from: 0,
            })
            .ok();

        let result = run_pair(
            m,
            &dir,
            hf_token,
            &download_id,
            &on_event,
            total,
            mmproj_cancel_rx,
            weights_cancel_rx,
        )
        .await;

        if let Ok(mut map) = state.cancel.lock() {
            map.remove(&download_id);
        }
        if let Ok(mut in_flight) = state.in_flight.lock() {
            for key in &keys {
                in_flight.remove(key);
            }
        }
        result
    }

    #[allow(clippy::too_many_arguments)]
    async fn run_pair(
        m: &'static VisionModel,
        dir: &std::path::Path,
        hf_token: Option<crate::credentials::Secret>,
        download_id: &str,
        on_event: &Channel<DownloadEvent>,
        total: u64,
        mmproj_cancel: tokio::sync::oneshot::Receiver<()>,
        weights_cancel: tokio::sync::oneshot::Receiver<()>,
    ) -> Result<(), String> {
        let request = |filename: &str| download::DownloadRequest {
            download_id: download_id.to_string(),
            repo_id: m.repo_id.to_string(),
            filename: filename.to_string(),
            revision: None,
            expected_size: None,
            expected_sha256: None,
            models_dir: dir.to_path_buf(),
            hf_token: hf_token.clone(),
        };

        // File 1 of 2: the projector, rebased at offset 0.
        {
            let sink = download::RebasedSink::new(on_event, 0, total);
            match download::run(request(m.mmproj_filename), &sink, mmproj_cancel).await? {
                download::Outcome::Cancelled => {
                    // The whole batch is off. The .part stays for resume, and the
                    // Cancelled event already went out through the sink.
                    return Ok(());
                }
                download::Outcome::Completed(_) => {}
            }
        }

        // File 2 of 2: the weights, offset by everything already on disk.
        let weights = {
            let sink = download::RebasedSink::new(on_event, m.mmproj_size_bytes, total);
            match download::run(request(m.filename), &sink, weights_cancel).await? {
                download::Outcome::Cancelled => return Ok(()),
                download::Outcome::Completed(model) => model,
            }
        };

        // ONE Completed for the batch, naming the CATALOG id rather than either
        // registry id — that is what the frontend keys its rows on.
        on_event
            .send(DownloadEvent::Completed {
                model_id: m.id.to_string(),
                path: weights.path,
            })
            .ok();
        Ok(())
    }

    #[tauri::command(rename_all = "snake_case")]
    pub async fn vision_load(
        app: tauri::AppHandle<Wry>,
        model_id: String,
        on_event: Channel<LoadEvent>,
    ) -> Result<(), String> {
        let m = spec(&model_id)?;
        let dir = models_dir(&app)?;

        // Re-check server-side. A disabled button is not a guarantee: the chat
        // model can be switched between rendering the row and clicking it.
        let ram = total_ram();
        let chat_bytes = active_chat_bytes(&app);
        let total = m.total_bytes();
        if !registry::fits_in_ram(total, m.min_ram_gb, ram) {
            return Err(format!(
                "{} needs at least {} GB of memory",
                m.label, m.min_ram_gb
            ));
        }
        if !registry::pair_fits_in_ram(chat_bytes, total, ram) {
            let chat = crate::commands::ai::active_model(&app);
            return Err(format!(
                "{} will not fit alongside {} — about {} GB would be needed. Pick a smaller \
                 model on either side.",
                m.label,
                chat.label,
                required_ram_gb(chat_bytes, total)
            ));
        }

        // Two concurrent Metal allocations peak at the sum plus fragmentation.
        let chat_host = app.state::<crate::provider::local::ModelHost>();
        if chat_host.status().await.1 == "loading" {
            return Err("a chat model is loading right now — try again once it is ready".into());
        }

        let gguf = path_of(&dir, m.repo_id, m.filename)
            .ok_or_else(|| format!("{} is not downloaded yet", m.label))?;
        let mmproj = path_of(&dir, m.repo_id, m.mmproj_filename)
            .ok_or_else(|| format!("{}'s projector is missing — re-download it", m.label))?;

        app.state::<VisionHost>()
            .load(m, gguf, mmproj, &on_event)
            .await
    }

    #[tauri::command(rename_all = "snake_case")]
    pub async fn vision_unload(app: tauri::AppHandle<Wry>) -> Result<(), String> {
        app.state::<VisionHost>().unload().await;
        Ok(())
    }

    #[tauri::command(rename_all = "snake_case")]
    pub async fn vision_status(
        app: tauri::AppHandle<Wry>,
    ) -> Result<crate::commands::models::ModelStatus, String> {
        let (loaded, state) = app.state::<VisionHost>().status().await;
        let acceleration = app.state::<VisionHost>().acceleration_snapshot().await;
        Ok(crate::commands::models::ModelStatus {
            loaded,
            state: state.to_string(),
            available: true,
            acceleration,
        })
    }

    #[tauri::command(rename_all = "snake_case")]
    pub async fn vision_delete(app: tauri::AppHandle<Wry>, model_id: String) -> Result<(), String> {
        let m = spec(&model_id)?;
        let host = app.state::<VisionHost>();
        if host.status().await.0.as_deref() == Some(m.id) {
            return Err("this model is loaded — unload it first".into());
        }
        let dir = models_dir(&app)?;
        // Both entries and both files. `delete_model_files` uses `remove_dir` (not
        // `_all`) and ignores the error, so the second call is what clears the now
        // empty repo directory.
        for filename in [m.filename, m.mmproj_filename] {
            let id = registry::model_id(m.repo_id, filename);
            if let Some(model) = registry::remove(&dir, &id)? {
                download::delete_model_files(&dir, &model)?;
            }
        }
        Ok(())
    }

    /// Transcribe one image with the loaded sidecar.
    ///
    /// Base64 rather than `Vec<u8>`: over Tauri IPC a byte vector serializes as a
    /// JSON number array, roughly seven times the size.
    #[tauri::command(rename_all = "snake_case")]
    pub async fn vision_describe(
        app: tauri::AppHandle<Wry>,
        ai_state: State<'_, crate::agent::AiState>,
        request_id: String,
        image_base64: String,
        prompt: Option<String>,
    ) -> Result<String, String> {
        use base64::Engine;

        let image = base64::engine::general_purpose::STANDARD
            .decode(image_base64.as_bytes())
            .map_err(|_| "the image was not valid base64".to_string())?;
        if image.is_empty() {
            return Err("the image was empty".into());
        }
        if image.len() > MAX_IMAGE_BYTES {
            return Err(format!(
                "that image is {} MB — {} MB is the limit",
                image.len() / (1024 * 1024),
                MAX_IMAGE_BYTES / (1024 * 1024)
            ));
        }

        let ready = app.state::<VisionHost>().get_ready().await?;
        // The model's own default when the user has not written one, so an OCR
        // specialist is asked to transcribe and a general VLM to describe.
        let prompt = prompt
            .filter(|p| !p.trim().is_empty())
            .or_else(|| settings::read_string(&app, "vision_prompt"))
            .filter(|p| !p.trim().is_empty())
            .unwrap_or_else(|| {
                vision::find(&ready.model_id)
                    .map(|m| m.default_prompt.to_string())
                    .unwrap_or_else(|| "Transcribe all text in this image.".into())
            });

        // Registered on the same cancel registry as a chat turn, so Stop reaches it.
        let cancel_rx = ai_state.register(&request_id);
        let result = ready.describe(image, prompt, cancel_rx).await;
        ai_state.finish(&request_id);
        result
    }
}

#[cfg(feature = "local-llm")]
pub use enabled::*;

// Stubs for a build with no local engine. Signatures and `rename_all` must match
// the real ones exactly — a drifted stub fails at runtime, not at compile time.
#[cfg(not(feature = "local-llm"))]
mod disabled {
    use super::*;

    const NO_ENGINE: &str =
        "on-device inference is not available in this build (compile with --features local-llm)";

    #[tauri::command(rename_all = "snake_case")]
    pub async fn vision_catalog(
        _app: tauri::AppHandle<Wry>,
    ) -> Result<Vec<VisionCatalogEntry>, String> {
        // An empty list rather than an error: the settings section then renders
        // nothing at all, which is the honest state of a build with no engine.
        Ok(Vec::new())
    }

    #[tauri::command(rename_all = "snake_case")]
    pub async fn vision_download(
        _app: tauri::AppHandle<Wry>,
        _state: State<'_, DownloadState>,
        _download_id: String,
        _model_id: String,
        _on_event: Channel<DownloadEvent>,
    ) -> Result<(), String> {
        Err(NO_ENGINE.into())
    }

    #[tauri::command(rename_all = "snake_case")]
    pub async fn vision_load(
        _app: tauri::AppHandle<Wry>,
        _model_id: String,
        _on_event: Channel<LoadEvent>,
    ) -> Result<(), String> {
        Err(NO_ENGINE.into())
    }

    #[tauri::command(rename_all = "snake_case")]
    pub async fn vision_unload(_app: tauri::AppHandle<Wry>) -> Result<(), String> {
        Ok(())
    }

    #[tauri::command(rename_all = "snake_case")]
    pub async fn vision_status(
        _app: tauri::AppHandle<Wry>,
    ) -> Result<crate::commands::models::ModelStatus, String> {
        Ok(crate::commands::models::ModelStatus {
            loaded: None,
            state: "idle".into(),
            available: false,
            acceleration: serde_json::json!({
                "backend": "unavailable",
                "device_name": null,
                "device_memory_bytes": null,
                "fallback_reason": "local inference is not included in this build"
            }),
        })
    }

    #[tauri::command(rename_all = "snake_case")]
    pub async fn vision_delete(
        _app: tauri::AppHandle<Wry>,
        _model_id: String,
    ) -> Result<(), String> {
        Err(NO_ENGINE.into())
    }

    #[tauri::command(rename_all = "snake_case")]
    pub async fn vision_describe(
        _app: tauri::AppHandle<Wry>,
        _ai_state: State<'_, crate::agent::AiState>,
        _request_id: String,
        _image_base64: String,
        _prompt: Option<String>,
    ) -> Result<String, String> {
        Err(NO_ENGINE.into())
    }
}

#[cfg(not(feature = "local-llm"))]
pub use disabled::*;
