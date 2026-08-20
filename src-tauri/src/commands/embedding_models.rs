//! UI-first installation lifecycle for the closed local embedding catalog.

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{Manager, State, Wry};

use crate::commands::settings;
use crate::docs::db::DocsDb;
use crate::knowledge::embedding::{EmbeddingInput, EmbeddingPurpose};
use crate::knowledge::local::{self, EmbeddingHost};
use crate::models::{download, registry, DownloadEvent, DownloadState, EventSink};

fn models_dir(app: &tauri::AppHandle<Wry>) -> Result<std::path::PathBuf, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    let override_dir = settings::read_string(app, "models_dir");
    Ok(registry::models_dir(&app_data, override_dir.as_deref()))
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type")]
pub enum EmbeddingInstallEvent {
    Started {
        total_bytes: Option<u64>,
        resumed_from: u64,
    },
    Progress {
        downloaded: u64,
        total_bytes: Option<u64>,
        bytes_per_sec: u64,
    },
    Phase {
        phase: &'static str,
    },
    Ready {
        profile_id: String,
    },
    Cancelled,
    Error {
        message: String,
    },
}

struct InstallSink<'a>(&'a Channel<EmbeddingInstallEvent>);

impl EventSink for InstallSink<'_> {
    fn emit(&self, event: DownloadEvent) {
        let event = match event {
            DownloadEvent::Started {
                total_bytes,
                resumed_from,
                ..
            } => Some(EmbeddingInstallEvent::Started {
                total_bytes,
                resumed_from,
            }),
            DownloadEvent::Progress {
                downloaded,
                total_bytes,
                bytes_per_sec,
            } => Some(EmbeddingInstallEvent::Progress {
                downloaded,
                total_bytes,
                bytes_per_sec,
            }),
            // The generic downloader has completed only the transfer. The UI
            // must not declare success until the embedding host loads and probes.
            DownloadEvent::Completed { .. } => None,
            DownloadEvent::Cancelled => Some(EmbeddingInstallEvent::Cancelled),
            DownloadEvent::Error { message } => Some(EmbeddingInstallEvent::Error { message }),
        };
        if let Some(event) = event {
            let _ = self.0.send(event);
        }
    }

    fn phase(&self, phase: &'static str) {
        let _ = self.0.send(EmbeddingInstallEvent::Phase { phase });
    }
}

/// Download, verify, load, and run query/document probes. No repository, URL,
/// filename, digest, or arbitrary local path crosses IPC.
#[tauri::command(rename_all = "snake_case")]
pub async fn knowledge_embedding_model_download(
    app: tauri::AppHandle<Wry>,
    docs: State<'_, DocsDb>,
    downloads: State<'_, DownloadState>,
    download_id: String,
    model_id: String,
    // Optional solely so older frontend builds can still invoke the command.
    // A gated model is never downloaded without explicit acceptance.
    license_accepted: Option<bool>,
    on_event: Channel<EmbeddingInstallEvent>,
) -> Result<(), String> {
    crate::commands::knowledge::gate(&app)?;
    if !cfg!(feature = "local-llm") {
        return Err(
            "local embeddings are unavailable in this build (compile with --features local-llm)"
                .into(),
        );
    }
    let artifact = local::artifact(&model_id).ok_or_else(|| {
        if let Some(model) = crate::knowledge::embedding::builtin_model(&model_id) {
            model
                .artifact
                .unavailable_reason()
                .unwrap_or("this built-in model has no published signed artifact")
                .to_string()
        } else {
            format!("unknown built-in embedding model: {model_id}")
        }
    })?;
    let model = crate::knowledge::embedding::builtin_model(&model_id)
        .ok_or_else(|| format!("unknown built-in embedding model: {model_id}"))?;
    let requires_license = matches!(
        model.artifact,
        crate::knowledge::embedding::ArtifactAvailability::HuggingFace {
            requires_license: true,
            ..
        }
    );
    if requires_license && license_accepted != Some(true) {
        return Err(format!(
            "{} requires accepting its model license before download",
            model.display_name
        ));
    }

    let file_key = format!("{}/{}", artifact.repo_id, artifact.filename);
    let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel();
    {
        let mut in_flight = downloads
            .in_flight
            .lock()
            .map_err(|_| "download state poisoned")?;
        if !in_flight.insert(file_key.clone()) {
            return Err("this embedding artifact is already downloading".into());
        }
        downloads
            .cancel
            .lock()
            .map_err(|_| "download state poisoned")?
            .insert(download_id.clone(), cancel_tx);
    }

    let dir = models_dir(&app)?;
    let request = download::DownloadRequest {
        download_id: download_id.clone(),
        repo_id: artifact.repo_id.into(),
        filename: artifact.filename.into(),
        revision: Some(artifact.revision.into()),
        expected_size: Some(artifact.size_bytes),
        expected_sha256: Some(artifact.sha256.into()),
        models_dir: dir.clone(),
        hf_token: settings::read_credential(&app, crate::credentials::CredentialId::HuggingFace)?,
    };
    let sink = InstallSink(&on_event);
    let download_result = download::run(request, &sink, cancel_rx).await;

    if let Ok(mut cancel) = downloads.cancel.lock() {
        cancel.remove(&download_id);
    }
    if let Ok(mut in_flight) = downloads.in_flight.lock() {
        in_flight.remove(&file_key);
    }

    let downloaded = match download_result? {
        download::Outcome::Cancelled => return Ok(()),
        download::Outcome::Completed(model) => model,
    };
    let installed = local::installation_record(&downloaded)?;
    let profile =
        local::profile_for_installation(&installed, None).map_err(|error| error.to_string())?;

    let _ = on_event.send(EmbeddingInstallEvent::Phase { phase: "loading" });
    let host = app.state::<EmbeddingHost>();
    // Both roles are exercised so a malformed GGUF/pooling declaration does not
    // produce a "Ready" profile which fails only after the first ingestion.
    host.embed(
        &installed,
        &profile,
        EmbeddingPurpose::Query,
        &[EmbeddingInput::text("multilingual retrieval test")],
    )
    .await
    .map_err(|error| error.to_string())?;
    host.embed(
        &installed,
        &profile,
        EmbeddingPurpose::Document,
        &[EmbeddingInput::document(
            "multilingual retrieval test",
            Some("Installation test".into()),
        )],
    )
    .await
    .map_err(|error| error.to_string())?;

    let profile_json = serde_json::to_value(&profile).map_err(|error| error.to_string())?;
    docs.with(|connection| {
        crate::docs::semantic::put_profile(
            connection,
            &model_id,
            profile.fingerprint(),
            &profile_json,
            "ready",
        )?;
        connection
            .execute(
                "UPDATE knowledge_embedding_profiles
                    SET status='ready', error=NULL, last_verified_at=?2
                  WHERE id=?1",
                rusqlite::params![&model_id, crate::docs::semantic::now_ms()],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    })?;
    // Only now is the artifact considered installed/ready. A transfer which
    // hashes correctly but cannot produce conforming vectors stays recoverable
    // as a downloaded file without creating a usable semantic profile.
    local::save_installation(&dir, &installed)?;
    let _ = on_event.send(EmbeddingInstallEvent::Ready {
        profile_id: model_id,
    });
    Ok(())
}

#[tauri::command]
pub fn knowledge_embedding_model_cancel(
    app: tauri::AppHandle<Wry>,
    downloads: State<'_, DownloadState>,
    download_id: String,
) -> Result<(), String> {
    crate::commands::knowledge::gate(&app)?;
    if let Ok(mut cancel) = downloads.cancel.lock() {
        if let Some(sender) = cancel.remove(&download_id) {
            let _ = sender.send(());
        }
    }
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
pub async fn knowledge_embedding_model_delete(
    app: tauri::AppHandle<Wry>,
    docs: State<'_, DocsDb>,
    model_id: String,
) -> Result<(), String> {
    crate::commands::knowledge::gate(&app)?;
    let dir = models_dir(&app)?;
    let Some(installed) = local::remove_installation(&dir, &model_id)? else {
        return Ok(());
    };
    let host = app.state::<EmbeddingHost>();
    if host.status().await.as_deref() == Some(model_id.as_str()) {
        host.unload().await;
    }
    let removed = registry::remove(&dir, &installed.registry_model_id)?;
    if let Some(model) = removed {
        download::delete_model_files(&dir, &model)?;
    }
    if docs.exists() {
        docs.with(|connection| {
            connection
                .execute(
                    "UPDATE knowledge_embedding_profiles
                        SET status='unavailable', error='Local model artifact was removed'
                      WHERE id=?1",
                    [&model_id],
                )
                .map_err(|error| error.to_string())?;
            Ok(())
        })?;
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EmbeddingModelState {
    NotInstalled,
    Ready,
    Error,
}

#[derive(Debug, Clone, Serialize)]
pub struct EmbeddingModelStatus {
    pub id: String,
    pub state: EmbeddingModelState,
    pub installed: bool,
    pub loaded: bool,
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
    pub error: Option<String>,
    pub profile_id: Option<String>,
}

#[tauri::command]
pub async fn knowledge_embedding_model_status(
    app: tauri::AppHandle<Wry>,
) -> Result<Vec<EmbeddingModelStatus>, String> {
    let dir = models_dir(&app)?;
    let installed = local::installed_artifacts(&dir);
    let loaded = app.state::<EmbeddingHost>().status().await;
    Ok(crate::knowledge::embedding::BUILTIN_EMBEDDING_MODELS
        .iter()
        .map(|model| {
            let artifact = local::artifact(model.id);
            let installed = installed
                .iter()
                .find(|record| record.builtin_model_id == model.id);
            let unavailable = artifact.is_none() && model.artifact.unavailable_reason().is_some();
            EmbeddingModelStatus {
                id: model.id.into(),
                state: if installed.is_some() {
                    EmbeddingModelState::Ready
                } else if unavailable {
                    EmbeddingModelState::Error
                } else {
                    EmbeddingModelState::NotInstalled
                },
                installed: installed.is_some(),
                loaded: loaded.as_deref() == Some(model.id),
                downloaded_bytes: installed.map_or(0, |record| record.size_bytes),
                total_bytes: artifact.map(|value| value.size_bytes),
                error: if unavailable {
                    model.artifact.unavailable_reason().map(str::to_owned)
                } else {
                    None
                },
                profile_id: installed.map(|_| model.id.into()),
            }
        })
        .collect())
}
