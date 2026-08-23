use tauri::ipc::Channel;
use tauri::{Manager, State, Wry};

use crate::commands::settings;
use crate::models::{catalog, download, registry, DownloadEvent, DownloadState, LoadEvent};

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MtpInstallState {
    NotInstalled,
    UpgradeAvailable,
    Ready,
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct MtpCatalogInfo {
    pub kind: &'static str,
    pub state: MtpInstallState,
    pub download_bytes: u64,
    pub disk_delta_bytes: u64,
    pub draft_tokens: u32,
}

struct LocalInstall {
    target: Option<registry::LocalModel>,
    #[cfg(any(feature = "local-llm", test))]
    sidecar: Option<registry::LocalModel>,
    mtp: MtpCatalogInfo,
}

fn find_artifact(
    installed: &[registry::LocalModel],
    artifact: catalog::ArtifactSpec,
) -> Option<registry::LocalModel> {
    let id = registry::model_id(artifact.repo_id, artifact.filename);
    installed.iter().find(|model| model.id == id).cloned()
}

fn remove_legacy_after_upgrade(
    models_dir: &std::path::Path,
    legacy: &registry::LocalModel,
) -> Result<(), String> {
    // Keep the registry entry until deletion succeeds. A failed cleanup then
    // remains visible and manageable instead of leaving orphaned weights.
    download::delete_model_files(models_dir, legacy)?;
    registry::remove(models_dir, &legacy.id).map(|_| ())
}

fn resolve_install(spec: catalog::LocalSpec, installed: &[registry::LocalModel]) -> LocalInstall {
    let preferred = find_artifact(installed, spec.artifact);
    match spec.mtp {
        catalog::MtpSpec::Embedded {
            legacy,
            draft_tokens,
        } => {
            let old = find_artifact(installed, legacy);
            let state = if preferred.is_some() {
                MtpInstallState::Ready
            } else if old.is_some() {
                MtpInstallState::UpgradeAvailable
            } else {
                MtpInstallState::NotInstalled
            };
            LocalInstall {
                target: preferred.clone().or_else(|| old.clone()),
                #[cfg(any(feature = "local-llm", test))]
                sidecar: None,
                mtp: MtpCatalogInfo {
                    kind: "embedded",
                    state,
                    download_bytes: if preferred.is_some() {
                        0
                    } else {
                        spec.artifact.size_bytes
                    },
                    disk_delta_bytes: if preferred.is_some() {
                        0
                    } else if installed.iter().any(|model| {
                        model.id == registry::model_id(legacy.repo_id, legacy.filename)
                    }) {
                        spec.artifact.size_bytes.saturating_sub(legacy.size_bytes)
                    } else {
                        spec.artifact.size_bytes
                    },
                    draft_tokens,
                },
            }
        }
        catalog::MtpSpec::Sidecar {
            artifact,
            draft_tokens,
        } => {
            let sidecar = find_artifact(installed, artifact);
            let state = if preferred.is_some() && sidecar.is_some() {
                MtpInstallState::Ready
            } else if preferred.is_some() {
                MtpInstallState::UpgradeAvailable
            } else {
                MtpInstallState::NotInstalled
            };
            let target_download_bytes = if preferred.is_none() {
                spec.artifact.size_bytes
            } else {
                0
            };
            let sidecar_download_bytes = if sidecar.is_none() {
                artifact.size_bytes
            } else {
                0
            };
            let missing_bytes = target_download_bytes.saturating_add(sidecar_download_bytes);
            LocalInstall {
                target: preferred.clone(),
                #[cfg(any(feature = "local-llm", test))]
                sidecar: sidecar.clone(),
                mtp: MtpCatalogInfo {
                    kind: "sidecar",
                    state,
                    download_bytes: missing_bytes,
                    disk_delta_bytes: missing_bytes,
                    draft_tokens,
                },
            }
        }
    }
}

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
    let spec = entry.local.ok_or_else(|| {
        format!(
            "{} is an API model — there is nothing to download",
            entry.label
        )
    })?;
    let dir = models_dir(&app)?;
    let token = settings::read_credential(&app, crate::credentials::CredentialId::HuggingFace)?;
    let installed = registry::load(&dir);
    let resolution = resolve_install(spec, &installed);

    #[cfg(feature = "local-llm")]
    if resolution.mtp.kind == "embedded"
        && resolution.mtp.state == MtpInstallState::UpgradeAvailable
    {
        let host = app.state::<crate::provider::local::ModelHost>();
        let (loaded, _) = host.status().await;
        if loaded.as_deref() == Some(model_id.as_str()) {
            return Err(
                "unload this model before replacing its weights with the MTP version".into(),
            );
        }
    }

    let mut artifacts = Vec::new();
    if find_artifact(&installed, spec.artifact).is_none() {
        artifacts.push(spec.artifact);
    }
    if let Some(sidecar) = spec.mtp.sidecar() {
        if find_artifact(&installed, sidecar).is_none() {
            artifacts.push(sidecar);
        }
    }
    if artifacts.is_empty() {
        on_event
            .send(DownloadEvent::Completed {
                model_id,
                path: resolution
                    .target
                    .map_or_else(String::new, |model| model.path),
            })
            .ok();
        return Ok(());
    }

    let keys: Vec<String> = artifacts
        .iter()
        .map(|artifact| format!("{}/{}", artifact.repo_id, artifact.filename))
        .collect();
    {
        // The guard that matters is per target FILE — download_id is caller-
        // chosen and fresh on every click.
        let mut in_flight = state
            .in_flight
            .lock()
            .map_err(|_| "download state poisoned")?;
        if keys.iter().any(|key| in_flight.contains(key)) {
            return Err("this model is already downloading".into());
        }
        in_flight.extend(keys.iter().cloned());
    }

    let (outer_tx, outer_rx) = tokio::sync::oneshot::channel::<()>();
    let mut cancel_receivers = Vec::with_capacity(artifacts.len());
    let mut cancel_senders = Vec::with_capacity(artifacts.len());
    for _ in &artifacts {
        let (tx, rx) = tokio::sync::oneshot::channel();
        cancel_senders.push(tx);
        cancel_receivers.push(rx);
    }
    state
        .cancel
        .lock()
        .map_err(|_| "download state poisoned")?
        .insert(download_id.clone(), outer_tx);
    tokio::spawn(async move {
        if outer_rx.await.is_ok() {
            for sender in cancel_senders {
                let _ = sender.send(());
            }
        }
    });

    let total = artifacts.iter().map(|artifact| artifact.size_bytes).sum();
    on_event
        .send(DownloadEvent::Started {
            download_id: download_id.clone(),
            total_bytes: Some(total),
            resumed_from: 0,
        })
        .ok();
    let mut offset = 0_u64;
    let mut completed_target = resolution.target;
    let mut result = Ok(());
    for (artifact, cancel) in artifacts.into_iter().zip(cancel_receivers) {
        let req = download::DownloadRequest {
            download_id: download_id.clone(),
            repo_id: artifact.repo_id.to_string(),
            filename: artifact.filename.to_string(),
            revision: None,
            expected_size: Some(artifact.size_bytes),
            expected_sha256: None,
            models_dir: dir.clone(),
            hf_token: token.clone(),
        };
        let sink = download::RebasedSink::new(&on_event, offset, total);
        match download::run(req, &sink, cancel).await {
            Ok(download::Outcome::Completed(model)) => {
                if artifact.repo_id == spec.artifact.repo_id
                    && artifact.filename == spec.artifact.filename
                {
                    completed_target = Some(model);
                }
                offset = offset.saturating_add(artifact.size_bytes);
            }
            Ok(download::Outcome::Cancelled) => break,
            Err(error) => {
                result = Err(error);
                break;
            }
        }
    }

    if result.is_ok() && offset == total {
        if let Some(legacy) = spec
            .mtp
            .legacy()
            .and_then(|artifact| find_artifact(&installed, artifact))
        {
            if let Err(error) = remove_legacy_after_upgrade(&dir, &legacy) {
                log::warn!("MTP upgrade installed but legacy cleanup failed: {error}");
            }
        }
        on_event
            .send(DownloadEvent::Completed {
                model_id,
                path: completed_target.map_or_else(String::new, |model| model.path),
            })
            .ok();
    }

    if let Ok(mut map) = state.cancel.lock() {
        map.remove(&download_id);
    }
    if let Ok(mut in_flight) = state.in_flight.lock() {
        for key in &keys {
            in_flight.remove(key);
        }
    }
    // The frontend already learned the aggregate outcome from the single
    // Completed/Cancelled event, so this command can return the batch result.
    result
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
    let registry_ids = match catalog::find(&model_id) {
        Some(entry) => {
            let spec = entry.local.ok_or_else(|| {
                format!(
                    "{} is an API model — there is nothing to delete",
                    entry.label
                )
            })?;
            let mut ids = vec![registry::model_id(
                spec.artifact.repo_id,
                spec.artifact.filename,
            )];
            if let Some(artifact) = spec.mtp.legacy() {
                ids.push(registry::model_id(artifact.repo_id, artifact.filename));
            }
            if let Some(artifact) = spec.mtp.sidecar() {
                ids.push(registry::model_id(artifact.repo_id, artifact.filename));
            }
            ids
        }
        None if model_id.contains("::") => vec![model_id.clone()],
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
    for registry_id in registry_ids {
        let removed = registry::remove(&dir, &registry_id)?;
        if let Some(model) = removed {
            download::delete_model_files(&dir, &model)?;
        }
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
    /// Local chat models only: MTP packaging and installation readiness.
    pub mtp: Option<MtpCatalogInfo>,
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
fn catalog_provider_presence(
    mut is_blocked: impl FnMut() -> bool,
    mut has: impl FnMut(&crate::credentials::CredentialId) -> Result<bool, String>,
) -> Result<std::collections::BTreeMap<&'static str, bool>, String> {
    let mut presence = std::collections::BTreeMap::new();
    for key in catalog::CATALOG
        .iter()
        .filter_map(|model| model.provider.api_key_setting())
    {
        if presence.contains_key(key) {
            continue;
        }
        let id = crate::credentials::CredentialId::from_setting(key)
            .ok_or_else(|| format!("unknown credential setting {key:?}"))?;
        // The catalog's wire format is intentionally boolean. An item-level
        // Keychain error means presence is unknown, not missing, so leave the
        // model usable and let the actual credential read report the error.
        // A globally blocked store is different: credentials are unavailable
        // until Keychain access is restored, and no item query should run.
        let configured = if is_blocked() {
            false
        } else {
            has(&id).unwrap_or(true)
        };
        presence.insert(key, configured);
    }
    // A metadata query can be the operation that discovers Keychain is
    // globally unavailable. Do not leave an earlier unknown item looking
    // configured once the store has entered that blocked state.
    if is_blocked() {
        presence
            .values_mut()
            .for_each(|configured| *configured = false);
    }
    Ok(presence)
}

#[tauri::command]
pub fn models_catalog(app: tauri::AppHandle<Wry>) -> Result<Vec<CatalogEntry>, String> {
    let sys = sysinfo::System::new_with_specifics(
        sysinfo::RefreshKind::nothing().with_memory(sysinfo::MemoryRefreshKind::everything()),
    );
    let total_ram = sys.total_memory();
    let downloaded = models_dir(&app)
        .map(|dir| registry::load(&dir))
        .unwrap_or_default();
    let credentials = crate::credentials::state(&app);
    let provider_presence =
        catalog_provider_presence(|| credentials.is_blocked(), |id| credentials.has(id))?;

    let built_in = catalog::CATALOG.iter().map(|model| {
        let (fits, is_downloaded, mtp) = match model.local {
            Some(spec) => {
                let install = resolve_install(spec, &downloaded);
                (
                    registry::fits_in_ram(spec.resident_size_bytes(), spec.min_ram_gb, total_ram),
                    install.target.is_some(),
                    Some(install.mtp),
                )
            }
            None => (true, false, None),
        };
        let configured = match model.provider.api_key_setting() {
            Some(key) => provider_presence.get(key).copied().unwrap_or(false),
            None => true,
        };
        CatalogEntry {
            model,
            fits,
            downloaded: is_downloaded,
            mtp,
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
            mtp: None,
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
    let install = resolve_install(spec, &registry::load(&dir));
    let downloaded = install
        .target
        .ok_or_else(|| format!("{} has not been downloaded yet", entry.label))?;
    let mtp = if install.mtp.state == MtpInstallState::Ready {
        Some(crate::provider::local::MtpLoadSpec {
            draft_path: install.sidecar.map(|model| model.path),
            draft_tokens: spec.mtp.draft_tokens(),
        })
    } else {
        None
    };

    // Never ask for more context than the model itself advertises.
    let max_context =
        settings::read_u32(&app, "max_context_tokens", 32_768).min(entry.context_tokens);

    let host = app.state::<crate::provider::local::ModelHost>();
    host.load(
        model_id,
        downloaded.path,
        spec.family,
        max_context,
        mtp,
        &on_event,
    )
    .await
}

#[cfg(not(feature = "local-llm"))]
// Must mirror the feature-gated arm's `rename_all`, or a build without the
// local engine rejects the call on arg names ("missing required key modelId")
// instead of reporting the real reason below.
#[tauri::command(rename_all = "snake_case")]
pub async fn model_load(_model_id: String, on_event: Channel<LoadEvent>) -> Result<(), String> {
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
    pub acceleration: serde_json::Value,
}

#[cfg(feature = "local-llm")]
#[tauri::command]
pub async fn model_status(app: tauri::AppHandle<Wry>) -> Result<ModelStatus, String> {
    let host = app.state::<crate::provider::local::ModelHost>();
    let (loaded, state) = host.status().await;
    let acceleration = host.acceleration_snapshot().await;
    Ok(ModelStatus {
        loaded,
        state: state.to_string(),
        available: true,
        acceleration,
    })
}

#[cfg(not(feature = "local-llm"))]
#[tauri::command]
pub async fn model_status() -> Result<ModelStatus, String> {
    Ok(ModelStatus {
        loaded: None,
        state: "idle".into(),
        available: false,
        acceleration: serde_json::json!({
            "backend": "unavailable",
            "device_name": null,
            "device_memory_bytes": null,
            "fallback_reason": "local inference is not included in this build",
            "generation_mode": null,
            "generation_fallback_reason": null
        }),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn installed(artifact: catalog::ArtifactSpec) -> registry::LocalModel {
        registry::make_local_model(
            artifact.repo_id,
            artifact.filename,
            std::path::Path::new("/tmp/test.gguf"),
            artifact.size_bytes,
        )
    }

    #[test]
    fn mtp_install_resolution_preserves_legacy_targets_and_detects_ready_bundles() {
        let qwen = catalog::find("local/qwen3.5-4b").unwrap().local.unwrap();
        let legacy = qwen.mtp.legacy().unwrap();
        let old = resolve_install(qwen, &[installed(legacy)]);
        assert!(old.target.is_some());
        assert_eq!(old.mtp.state, MtpInstallState::UpgradeAvailable);
        assert_eq!(old.mtp.download_bytes, qwen.artifact.size_bytes);
        assert_eq!(
            old.mtp.disk_delta_bytes,
            qwen.artifact.size_bytes - legacy.size_bytes
        );
        let optimized = resolve_install(qwen, &[installed(qwen.artifact)]);
        assert_eq!(optimized.mtp.state, MtpInstallState::Ready);

        let gemma = catalog::find("local/gemma-4-e2b").unwrap().local.unwrap();
        let target_only = resolve_install(gemma, &[installed(gemma.artifact)]);
        assert!(target_only.target.is_some());
        assert_eq!(target_only.mtp.state, MtpInstallState::UpgradeAvailable);
        let sidecar = gemma.mtp.sidecar().unwrap();
        let ready = resolve_install(gemma, &[installed(gemma.artifact), installed(sidecar)]);
        assert_eq!(ready.mtp.state, MtpInstallState::Ready);
        assert!(ready.sidecar.is_some());
    }

    #[test]
    fn failed_legacy_file_cleanup_preserves_its_registry_entry() {
        let temp = tempfile::tempdir().unwrap();
        let artifact = catalog::find("local/qwen3.5-4b")
            .unwrap()
            .local
            .unwrap()
            .mtp
            .legacy()
            .unwrap();
        let file_path = temp.path().join("legacy-as-directory.gguf");
        std::fs::create_dir(&file_path).unwrap();
        let legacy = registry::make_local_model(
            artifact.repo_id,
            artifact.filename,
            &file_path,
            artifact.size_bytes,
        );
        registry::add(temp.path(), legacy.clone()).unwrap();

        assert!(remove_legacy_after_upgrade(temp.path(), &legacy).is_err());
        assert!(registry::load(temp.path())
            .iter()
            .any(|model| model.id == legacy.id));
    }

    #[test]
    fn successful_legacy_cleanup_removes_the_file_and_registry_entry() {
        let temp = tempfile::tempdir().unwrap();
        let artifact = catalog::find("local/qwen3.5-4b")
            .unwrap()
            .local
            .unwrap()
            .mtp
            .legacy()
            .unwrap();
        let file_path = temp.path().join("legacy.gguf");
        std::fs::write(&file_path, b"legacy weights").unwrap();
        let legacy = registry::make_local_model(
            artifact.repo_id,
            artifact.filename,
            &file_path,
            artifact.size_bytes,
        );
        registry::add(temp.path(), legacy.clone()).unwrap();

        remove_legacy_after_upgrade(temp.path(), &legacy).unwrap();
        assert!(!file_path.exists());
        assert!(registry::load(temp.path())
            .iter()
            .all(|model| model.id != legacy.id));
    }

    #[test]
    fn catalog_presence_checks_each_provider_once_and_preserves_unknown_state() {
        let mut calls = std::collections::BTreeMap::new();
        let presence = catalog_provider_presence(
            || false,
            |id| {
                *calls.entry(id.clone()).or_insert(0_usize) += 1;
                Ok(true)
            },
        )
        .unwrap();

        let expected_settings = catalog::CATALOG
            .iter()
            .filter_map(|model| model.provider.api_key_setting())
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(presence.len(), expected_settings.len());
        assert_eq!(calls.len(), expected_settings.len());
        assert!(calls.values().all(|count| *count == 1));
        assert!(presence.values().all(|configured| *configured));

        let mut mixed_calls = 0;
        let mixed = catalog_provider_presence(
            || false,
            |id| {
                mixed_calls += 1;
                match id {
                    crate::credentials::CredentialId::OpenAi => Err("item denied".into()),
                    crate::credentials::CredentialId::Mistral => Ok(false),
                    _ => Ok(true),
                }
            },
        )
        .unwrap();
        assert_eq!(mixed_calls, expected_settings.len());
        assert!(mixed["openai_api_key"], "unknown is not missing");
        assert!(!mixed["mistral_api_key"], "known missing stays missing");
        assert!(mixed["anthropic_api_key"]);

        let blocked = catalog_provider_presence(
            || true,
            |_| panic!("a globally blocked store must not be queried"),
        )
        .unwrap();
        assert!(blocked.values().all(|configured| !configured));

        let discovered_block = std::cell::Cell::new(false);
        let mut attempted = 0;
        let blocked_during_query = catalog_provider_presence(
            || discovered_block.get(),
            |_| {
                attempted += 1;
                discovered_block.set(true);
                Err("keychain unavailable".into())
            },
        )
        .unwrap();
        assert_eq!(
            attempted, 1,
            "stop querying after a global block is discovered"
        );
        assert!(blocked_during_query.values().all(|configured| !configured));
    }

    /// The payload the settings page actually parses.
    ///
    /// `models_catalog` needs an `AppHandle`, so the row is built by hand — but the
    /// `#[serde(flatten)]` is the part worth pinning: `provider` reaches the
    /// frontend through it, and the frontend GROUPS rows by that value, so a
    /// misspelling deletes a whole section rather than raising anything.
    /// `catalog::every_provider_serializes_as_its_own_str` pins the enum; this pins
    /// that the flatten still puts it where `CatalogEntry` in src/lib/types.ts
    /// looks for it.
    #[test]
    fn a_cloud_row_carries_the_provider_the_frontend_groups_by() {
        let entry = CatalogEntry {
            model: catalog::find("openai/gpt-5.6-terra").unwrap(),
            fits: true,
            downloaded: false,
            mtp: None,
            configured: false,
            effort: catalog::Effort::Medium,
            remote: None,
        };
        let json = serde_json::to_value(&entry).unwrap();
        assert_eq!(json["provider"], "openai");
        // Flattened siblings, so a regression in one is visible in the others.
        assert_eq!(json["id"], "openai/gpt-5.6-terra");
        assert_eq!(json["configured"], false);
        assert!(json["local"].is_null(), "a cloud row has no local spec");
    }
}
