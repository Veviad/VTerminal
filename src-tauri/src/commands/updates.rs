//! Signed application updates from GitHub Releases.
//!
//! GitHub's `/releases/latest` route deliberately excludes prereleases. The
//! experimental channel includes them, so the small discovery step below asks
//! the releases API, chooses the greatest published SemVer carrying a
//! `latest.json` asset, and then hands that release-specific manifest to
//! Tauri. Tauri still owns download, signature verification, and installation.

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use std::time::Duration;

use semver::Version;
use serde::{Deserialize, Serialize};
use tauri::{ipc::Channel, AppHandle, State, Wry};
use tauri_plugin_updater::{Update, UpdaterExt};

const RELEASES_URL: &str = "https://api.github.com/repos/Veviad/VTerminal/releases?per_page=100";
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
struct GithubAsset {
    name: String,
    browser_download_url: String,
}

#[derive(Clone, Debug, Deserialize)]
struct GithubRelease {
    tag_name: String,
    draft: bool,
    prerelease: bool,
    published_at: Option<String>,
    body: Option<String>,
    assets: Vec<GithubAsset>,
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

fn select_release(
    releases: &[GithubRelease],
    current: &Version,
) -> Option<(GithubRelease, String)> {
    releases
        .iter()
        .filter(|release| !release.draft)
        .filter_map(|release| {
            let version = parse_tag(&release.tag_name)?;
            if version <= *current {
                return None;
            }
            let manifest = release
                .assets
                .iter()
                .find(|asset| asset.name == MANIFEST_NAME)?;
            Some((
                version,
                release.clone(),
                manifest.browser_download_url.clone(),
            ))
        })
        .max_by(|a, b| a.0.cmp(&b.0))
        .map(|(_, release, manifest)| (release, manifest))
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
    let releases = reqwest::Client::builder()
        .user_agent(format!("VTerminal/{current_version}"))
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?
        .get(RELEASES_URL)
        .send()
        .await
        .map_err(|e| format!("could not reach GitHub Releases: {e}"))?
        .error_for_status()
        .map_err(|e| format!("GitHub Releases returned an error: {e}"))?
        .json::<Vec<GithubRelease>>()
        .await
        .map_err(|e| format!("could not read GitHub Releases: {e}"))?;

    let Some((release, manifest_url)) = select_release(&releases, &current) else {
        *state.pending.lock().map_err(|e| e.to_string())? = None;
        return Ok(None);
    };

    let endpoint = manifest_url
        .parse()
        .map_err(|e| format!("invalid updater manifest URL: {e}"))?;
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
    let release_version = parse_tag(&release.tag_name)
        .ok_or_else(|| "selected GitHub release has an invalid version".to_string())?;
    let manifest_version = Version::parse(&update.version)
        .map_err(|e| format!("signed updater manifest has an invalid version: {e}"))?;
    if manifest_version != release_version {
        return Err(format!(
            "signed updater manifest version {manifest_version} does not match GitHub release {}",
            release.tag_name
        ));
    }
    let metadata = UpdateMetadata {
        current_version,
        version: update.version.clone(),
        notes: release.body.unwrap_or_default(),
        published_at: release.published_at,
        prerelease: release.prerelease,
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

    fn release(tag: &str, draft: bool, manifest: bool) -> GithubRelease {
        GithubRelease {
            tag_name: tag.into(),
            draft,
            prerelease: tag.contains('-'),
            published_at: Some("2026-08-13T00:00:00Z".into()),
            body: Some(format!("notes for {tag}")),
            assets: if manifest {
                vec![GithubAsset {
                    name: MANIFEST_NAME.into(),
                    browser_download_url: format!("https://example.test/{tag}/latest.json"),
                }]
            } else {
                vec![]
            },
        }
    }

    #[test]
    fn selects_highest_published_version_including_prereleases() {
        let releases = vec![
            release("v0.2.0", false, true),
            release("v0.3.0-beta.2", false, true),
            release("v0.3.0-beta.1", false, true),
        ];
        let (picked, _) = select_release(&releases, &Version::new(0, 1, 0)).unwrap();
        assert_eq!(picked.tag_name, "v0.3.0-beta.2");
        assert!(picked.prerelease);
    }

    #[test]
    fn ignores_drafts_invalid_tags_missing_manifests_and_downgrades() {
        let releases = vec![
            release("v9.0.0", true, true),
            release("nightly", false, true),
            release("v3.0.0", false, false),
            release("v1.9.0", false, true),
        ];
        assert!(select_release(&releases, &Version::new(2, 0, 0)).is_none());
    }

    #[test]
    fn stable_release_beats_its_own_prerelease() {
        let releases = vec![
            release("v1.2.0-rc.1", false, true),
            release("v1.2.0", false, true),
        ];
        let (picked, _) = select_release(&releases, &Version::new(1, 1, 0)).unwrap();
        assert_eq!(picked.tag_name, "v1.2.0");
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
