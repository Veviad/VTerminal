use tauri::ipc::Channel;
use tauri::{Manager, State, Wry};

use crate::commands::settings;
use crate::models::{catalog, download, registry, DownloadEvent, DownloadState, LoadEvent};

fn models_dir(app: &tauri::AppHandle<Wry>) -> Result<std::path::PathBuf, String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let override_dir = settings::read_string(app, "models_dir");
    Ok(registry::models_dir(&app_data, override_dir.as_deref()))
}

/// Download a model from the catalog. There is no free-form download path on
/// purpose — `model_id` is a catalog id, and the repo/filename come from the
/// allowlist rather than from the caller.
#[tauri::command(rename_all = "snake_case")]
pub async fn models_download(
    app: tauri::AppHandle<Wry>,
    state: State<'_, DownloadState>,
    download_id: String,
    model_id: String,
    on_event: Channel<DownloadEvent>,
) -> Result<(), String> {
    let entry = catalog::find(&model_id).ok_or_else(|| format!("unknown model: {model_id}"))?;
    let spec = entry
        .local
        .ok_or_else(|| format!("{} is an API model — there is nothing to download", entry.label))?;
    let (repo_id, filename) = (spec.repo_id.to_string(), spec.filename.to_string());
    let file_key = format!("{repo_id}/{filename}");
    let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel();
    {
        // The guard that matters is per target FILE — download_id is caller-
        // chosen and fresh on every click.
        let mut in_flight = state
            .in_flight
            .lock()
            .map_err(|_| "download state poisoned")?;
        if !in_flight.insert(file_key.clone()) {
            return Err("this file is already downloading".into());
        }
        let mut map = state.cancel.lock().map_err(|_| "download state poisoned")?;
        map.insert(download_id.clone(), cancel_tx);
    }

    let req = download::DownloadRequest {
        download_id: download_id.clone(),
        repo_id,
        filename,
        models_dir: models_dir(&app)?,
        hf_token: settings::read_string(&app, "hf_token"),
    };

    let result = download::run(req, &on_event, cancel_rx).await;

    if let Ok(mut map) = state.cancel.lock() {
        map.remove(&download_id);
    }
    if let Ok(mut in_flight) = state.in_flight.lock() {
        in_flight.remove(&file_key);
    }
    // The single-file path has no use for WHICH outcome it was — the frontend
    // already learned that from the Completed/Cancelled event. Only the two-file
    // vision driver needs to branch on it.
    result.map(|_| ())
}

#[tauri::command]
pub fn models_cancel_download(
    state: State<'_, DownloadState>,
    download_id: String,
) -> Result<(), String> {
    if let Ok(mut map) = state.cancel.lock() {
        if let Some(tx) = map.remove(&download_id) {
            let _ = tx.send(());
        }
    }
    Ok(())
}

#[tauri::command]
pub fn models_list_local(app: tauri::AppHandle<Wry>) -> Result<Vec<registry::LocalModel>, String> {
    Ok(registry::load(&models_dir(&app)?))
}

/// Delete a downloaded model.
///
/// Accepts a catalog id, or a raw `repo_id::filename` registry id so that files
/// left behind by an older version — downloaded before the catalog existed —
/// can still be reclaimed instead of stranding tens of gigabytes on disk.
#[tauri::command(rename_all = "snake_case")]
pub async fn models_delete(app: tauri::AppHandle<Wry>, model_id: String) -> Result<(), String> {
    let registry_id = match catalog::find(&model_id) {
        Some(entry) => {
            let spec = entry.local.ok_or_else(|| {
                format!("{} is an API model — there is nothing to delete", entry.label)
            })?;
            registry::model_id(spec.repo_id, spec.filename)
        }
        None if model_id.contains("::") => model_id.clone(),
        None => return Err(format!("unknown model: {model_id}")),
    };

    // Refuse while loaded. The host tracks catalog ids, so compare on those.
    #[cfg(feature = "local-llm")]
    {
        let host = app.state::<crate::provider::local::ModelHost>();
        let (loaded, _) = host.status().await;
        if loaded.as_deref() == Some(model_id.as_str()) {
            return Err("model is currently loaded — unload it first".into());
        }
    }
    let dir = models_dir(&app)?;
    let removed = registry::remove(&dir, &registry_id)?;
    if let Some(model) = removed {
        download::delete_model_files(&dir, &model)?;
    }
    Ok(())
}

/// One row per offered model: the catalog entry joined with this machine's
/// reality (does it fit in RAM, is it downloaded, is a key configured) and the
/// user's stored effort. This is the only listing the settings UI needs.
#[derive(serde::Serialize)]
pub struct CatalogEntry {
    #[serde(flatten)]
    pub model: &'static catalog::CatalogModel,
    /// Local models only: does it fit this machine's memory.
    pub fits: bool,
    /// Local models only: is the GGUF already on disk.
    pub downloaded: bool,
    /// API models only: is a key stored for this provider.
    pub configured: bool,
    /// Effective effort — the stored choice, clamped, or the model's default.
    pub effort: catalog::Effort,
    /// Which configured server serves this, for the rows that have one.
    ///
    /// Always serialized, `null` included, exactly like `local` — the frontend
    /// type declares both as nullable siblings and branches on them.
    pub remote: Option<crate::models::remote::RemoteRowInfo>,
}

/// The allowlist joined with reality, plus every enabled model on every
/// configured remote server.
///
/// Reads settings and the download registry. It must never touch the network:
/// this runs on app start and on every visit to the settings tab, and a server
/// that is switched off has to list its models anyway.
#[tauri::command]
pub fn models_catalog(app: tauri::AppHandle<Wry>) -> Result<Vec<CatalogEntry>, String> {
    let sys = sysinfo::System::new_with_specifics(
        sysinfo::RefreshKind::nothing().with_memory(sysinfo::MemoryRefreshKind::everything()),
    );
    let total_ram = sys.total_memory();
    let downloaded: std::collections::HashSet<String> = models_dir(&app)
        .map(|dir| registry::load(&dir).into_iter().map(|m| m.id).collect())
        .unwrap_or_default();

    let built_in = catalog::CATALOG.iter().map(|model| {
        let (fits, is_downloaded) = match &model.local {
            Some(spec) => (
                registry::fits_in_ram(spec.size_bytes, spec.min_ram_gb, total_ram),
                downloaded.contains(&registry::model_id(spec.repo_id, spec.filename)),
            ),
            None => (true, false),
        };
        let configured = match model.provider.api_key_setting() {
            Some(key) => settings::read_string(&app, key).is_some_and(|k| !k.trim().is_empty()),
            None => true,
        };
        CatalogEntry {
            model,
            fits,
            downloaded: is_downloaded,
            configured,
            effort: settings::read_effort(&app, model),
            remote: None,
        }
    });

    let remote = crate::models::remote::enabled_models(&app)
        .into_iter()
        .map(|(model, info)| CatalogEntry {
            model,
            // Nothing to fit and nothing to download — the weights are over
            // there. `configured` is true because the server record existing IS
            // the configuration; whether it also needs a token is per-server
            // state the settings UI shows on the server itself.
            fits: true,
            downloaded: false,
            configured: true,
            effort: settings::read_effort(&app, model),
            remote: Some(info),
        });

    Ok(built_in.chain(remote).collect())
}

// ---------- Model load/unload — feature-gated ----------

#[cfg(feature = "local-llm")]
#[tauri::command(rename_all = "snake_case")]
pub async fn model_load(
    app: tauri::AppHandle<Wry>,
    model_id: String,
    on_event: Channel<LoadEvent>,
) -> Result<(), String> {
    let entry = catalog::find(&model_id).ok_or_else(|| format!("unknown model: {model_id}"))?;
    let spec = entry
        .local
        .ok_or_else(|| format!("{} runs over the API, not on-device", entry.label))?;

    let dir = models_dir(&app)?;
    let registry_id = registry::model_id(spec.repo_id, spec.filename);
    let downloaded = registry::load(&dir)
        .into_iter()
        .find(|m| m.id == registry_id)
        .ok_or_else(|| format!("{} has not been downloaded yet", entry.label))?;

    // Never ask for more context than the model itself advertises.
    let max_context =
        settings::read_u32(&app, "max_context_tokens", 32_768).min(entry.context_tokens);

    let host = app.state::<crate::provider::local::ModelHost>();
    host.load(
        model_id,
        downloaded.path,
        spec.family,
        max_context,
        &on_event,
    )
    .await
}

#[cfg(not(feature = "local-llm"))]
// Must mirror the feature-gated arm's `rename_all`, or a build without the
// local engine rejects the call on arg names ("missing required key modelId")
// instead of reporting the real reason below.
#[tauri::command(rename_all = "snake_case")]
pub async fn model_load(
    _model_id: String,
    on_event: Channel<LoadEvent>,
) -> Result<(), String> {
    let message = "local inference not available in this build (compile with --features local-llm)";
    let _ = on_event.send(LoadEvent::Error {
        message: message.into(),
    });
    Err(message.into())
}

#[cfg(feature = "local-llm")]
#[tauri::command]
pub async fn model_unload(app: tauri::AppHandle<Wry>) -> Result<(), String> {
    let host = app.state::<crate::provider::local::ModelHost>();
    host.unload().await;
    Ok(())
}

#[cfg(not(feature = "local-llm"))]
#[tauri::command]
pub async fn model_unload() -> Result<(), String> {
    Ok(())
}

#[derive(serde::Serialize)]
pub struct ModelStatus {
    pub loaded: Option<String>,
    pub state: String,
    pub available: bool,
}

#[cfg(feature = "local-llm")]
#[tauri::command]
pub async fn model_status(app: tauri::AppHandle<Wry>) -> Result<ModelStatus, String> {
    let host = app.state::<crate::provider::local::ModelHost>();
    let (loaded, state) = host.status().await;
    Ok(ModelStatus {
        loaded,
        state: state.to_string(),
        available: true,
    })
}

#[cfg(not(feature = "local-llm"))]
#[tauri::command]
pub async fn model_status() -> Result<ModelStatus, String> {
    Ok(ModelStatus {
        loaded: None,
        state: "idle".into(),
        available: false,
    })
}
