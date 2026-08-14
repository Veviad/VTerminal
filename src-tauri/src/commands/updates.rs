//! Signed application updates discovered through VTerminal's static release
//! catalog. The Pages release renderer builds that catalog from authenticated
//! GitHub data whenever a release is published, including prereleases. Desktop
//! clients therefore do not share GitHub's small unauthenticated API quota.
//! Tauri still owns manifest parsing, download, signature verification, and
//! installation.

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use std::time::Duration;

use semver::Version;
use serde::{Deserialize, Serialize};
use tauri::{ipc::Channel, AppHandle, State, Wry};
use tauri_plugin_updater::{Update, UpdaterExt};

const RELEASE_CATALOG_URL: &str = "https://vterminal.veviad.com/release.json";
const RELEASE_DOWNLOAD_BASE: &str = "https://github.com/Veviad/VTerminal/releases/download/";
const MANIFEST_NAME: &str = "latest.json";
const MANIFEST_CHECK_TIMEOUT: Duration = Duration::from_secs(30);
const INSTALL_TIMEOUT: Duration = Duration::from_secs(20 * 60);

#[derive(Default)]
pub struct UpdateState {
    pending: Mutex<Option<Update>>,
    // One gate across BOTH operations. Two separate flags leave a check/install
    // race where each observes the other as idle before setting itself busy.
    busy: AtomicBool,
}

#[derive(Clone, Debug, Deserialize)]
struct ReleaseCatalog {
    schema_version: u32,
    release: CatalogRelease,
}

#[derive(Clone, Debug, Deserialize)]
struct CatalogRelease {
    tag: String,
    version: String,
    prerelease: bool,
    published_at: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct UpdateMetadata {
    current_version: String,
    version: String,
    notes: String,
    published_at: Option<String>,
    prerelease: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "event", content = "data")]
pub enum UpdateDownloadEvent {
    #[serde(rename_all = "camelCase")]
    Started {
        content_length: Option<u64>,
    },
    #[serde(rename_all = "camelCase")]
    Progress {
        chunk_length: usize,
    },
    Finished,
}

struct BusyGuard<'a>(&'a AtomicBool);

impl Drop for BusyGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

fn begin<'a>(flag: &'a AtomicBool, operation: &str) -> Result<BusyGuard<'a>, String> {
    flag.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .map_err(|_| format!("an update {operation} is already in progress"))?;
    Ok(BusyGuard(flag))
}

fn parse_tag(tag: &str) -> Option<Version> {
    Version::parse(tag.strip_prefix('v').unwrap_or(tag)).ok()
}

fn validate_catalog(catalog: &ReleaseCatalog) -> Result<Version, String> {
    if catalog.schema_version != 1 {
        return Err(format!(
            "unsupported release catalog schema {}",
            catalog.schema_version
        ));
    }
    let tag_version = parse_tag(&catalog.release.tag)
        .ok_or_else(|| "release catalog has an invalid tag".to_string())?;
    let declared_version = Version::parse(&catalog.release.version)
        .map_err(|e| format!("release catalog has an invalid version: {e}"))?;
    if tag_version != declared_version {
        return Err("release catalog tag and version do not match".into());
    }
    if catalog.release.prerelease != !declared_version.pre.is_empty() {
        return Err("release catalog prerelease flag and version do not match".into());
    }
    Ok(declared_version)
}

fn manifest_url(tag: &str) -> Result<url::Url, String> {
    let mut url = url::Url::parse(RELEASE_DOWNLOAD_BASE)
        .map_err(|e| format!("invalid updater download base URL: {e}"))?;
    url.path_segments_mut()
        .map_err(|_| "updater download base URL cannot contain path segments".to_string())?
        .pop_if_empty()
        .push(tag)
        .push(MANIFEST_NAME);
    Ok(url)
}

#[tauri::command]
pub async fn update_check(
    app: AppHandle<Wry>,
    state: State<'_, UpdateState>,
) -> Result<Option<UpdateMetadata>, String> {
    let _guard = begin(&state.busy, "operation")?;

    let current_version = app.package_info().version.to_string();
    let current = Version::parse(&current_version)
        .map_err(|e| format!("invalid installed version {current_version}: {e}"))?;
    let catalog = reqwest::Client::builder()
        .user_agent(format!("VTerminal/{current_version}"))
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?
        .get(RELEASE_CATALOG_URL)
        .send()
        .await
        .map_err(|e| format!("could not reach the release catalog: {e}"))?
        .error_for_status()
        .map_err(|e| format!("the release catalog returned an error: {e}"))?
        .json::<ReleaseCatalog>()
        .await
        .map_err(|e| format!("could not read the release catalog: {e}"))?;

    let release_version = validate_catalog(&catalog)?;
    if release_version <= current {
        *state.pending.lock().map_err(|e| e.to_string())? = None;
        return Ok(None);
    }

    let endpoint = manifest_url(&catalog.release.tag)?;
    let updater = app
        .updater_builder()
        .endpoints(vec![endpoint])
        .map_err(|e| e.to_string())?
        .build()
        .map_err(|e| e.to_string())?;
    let update = tokio::time::timeout(MANIFEST_CHECK_TIMEOUT, updater.check())
        .await
        .map_err(|_| "checking the signed update manifest timed out".to_string())?
        .map_err(|e| format!("could not check the signed update manifest: {e}"))?;

    let Some(update) = update else {
        *state.pending.lock().map_err(|e| e.to_string())? = None;
        return Ok(None);
    };
    let manifest_version = Version::parse(&update.version)
        .map_err(|e| format!("signed updater manifest has an invalid version: {e}"))?;
    if manifest_version != release_version {
        return Err(format!(
            "signed updater manifest version {manifest_version} does not match release catalog version {release_version}"
        ));
    }
    let metadata = UpdateMetadata {
        current_version,
        version: update.version.clone(),
        notes: update.body.clone().unwrap_or_default(),
        published_at: catalog.release.published_at,
        prerelease: catalog.release.prerelease,
    };
    *state.pending.lock().map_err(|e| e.to_string())? = Some(update);
    Ok(Some(metadata))
}

#[tauri::command]
pub async fn update_install(
    state: State<'_, UpdateState>,
    on_event: Channel<UpdateDownloadEvent>,
) -> Result<(), String> {
    let _guard = begin(&state.busy, "operation")?;
    let update = state
        .pending
        .lock()
        .map_err(|e| e.to_string())?
        .take()
        .ok_or_else(|| "there is no pending update; check again first".to_string())?;

    let mut started = false;
    tokio::time::timeout(
        INSTALL_TIMEOUT,
        update.download_and_install(
            |chunk_length, content_length| {
                if !started {
                    started = true;
                    let _ = on_event.send(UpdateDownloadEvent::Started { content_length });
                }
                let _ = on_event.send(UpdateDownloadEvent::Progress { chunk_length });
            },
            || {
                let _ = on_event.send(UpdateDownloadEvent::Finished);
            },
        ),
    )
    .await
    .map_err(|_| "downloading or installing the update timed out".to_string())?
    .map_err(|e| format!("could not install the update: {e}"))
}

#[tauri::command]
pub fn app_restart(app: AppHandle<Wry>) {
    // `request_restart`, rather than killing the process, lets the run callback
    // distinguish this exit from an ordinary quit and hand control back to
    // Tauri's relaunch path.
    app.request_restart();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn catalog(tag: &str, version: &str, prerelease: bool) -> ReleaseCatalog {
        ReleaseCatalog {
            schema_version: 1,
            release: CatalogRelease {
                tag: tag.into(),
                version: version.into(),
                prerelease,
                published_at: Some("2026-08-13T00:00:00Z".into()),
            },
        }
    }

    #[test]
    fn accepts_a_consistent_prerelease_catalog() {
        let catalog = catalog("v0.3.0-beta.2", "0.3.0-beta.2", true);
        assert_eq!(
            validate_catalog(&catalog).unwrap(),
            Version::parse("0.3.0-beta.2").unwrap()
        );
        assert_eq!(
            manifest_url(&catalog.release.tag).unwrap().as_str(),
            "https://github.com/Veviad/VTerminal/releases/download/v0.3.0-beta.2/latest.json"
        );
    }

    #[test]
    fn rejects_catalog_schema_or_release_identity_drift() {
        let mut wrong_schema = catalog("v1.2.0", "1.2.0", false);
        wrong_schema.schema_version = 2;
        assert!(validate_catalog(&wrong_schema).is_err());

        let wrong_version = catalog("v1.2.0", "1.2.1", false);
        assert!(validate_catalog(&wrong_version).is_err());

        let wrong_channel = catalog("v1.2.0-rc.1", "1.2.0-rc.1", false);
        assert!(validate_catalog(&wrong_channel).is_err());

        let invalid_tag = catalog("nightly", "1.2.0", false);
        assert!(validate_catalog(&invalid_tag).is_err());
    }

    #[test]
    fn one_gate_serializes_checks_and_installs() {
        let busy = AtomicBool::new(false);
        let first = begin(&busy, "operation").unwrap();
        assert!(begin(&busy, "operation").is_err());
        drop(first);
        assert!(begin(&busy, "operation").is_ok());
    }
}
