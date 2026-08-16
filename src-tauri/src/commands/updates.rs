//! Signed application updates discovered through VTerminal's static release
//! catalog. The Pages release renderer builds that catalog from authenticated
//! GitHub data whenever a release is published, including prereleases. Desktop
//! clients therefore do not share GitHub's small unauthenticated API quota.
//! Tauri still owns manifest parsing, download, signature verification, and
//! installation.

use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use std::time::{Duration, Instant};

use semver::Version;
use serde::{Deserialize, Serialize};
#[cfg(target_os = "windows")]
use tauri::Manager;
use tauri::{ipc::Channel, AppHandle, State, Wry};
use tauri_plugin_updater::{Update, UpdaterExt};
use tokio::sync::Notify;

use crate::database::DbState;

const RELEASE_CATALOG_URL: &str = "https://vterminal.veviad.com/release.json";
const RELEASE_DOWNLOAD_BASE: &str = "https://github.com/Veviad/VTerminal/releases/download/";
const MANIFEST_NAME: &str = "latest.json";
const MANIFEST_CHECK_TIMEOUT: Duration = Duration::from_secs(30);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(20 * 60);
const PROGRESS_EMIT_INTERVAL: Duration = Duration::from_millis(150);
const MAX_SAFE_JAVASCRIPT_INTEGER: u64 = 9_007_199_254_740_991;
const DOWNLOAD_CANCELLED: &str = "update download cancelled";

struct PendingUpdate {
    update: Update,
    expected_bytes: Option<u64>,
}

struct DownloadedUpdate {
    id: String,
    update: Update,
    bytes: Vec<u8>,
}

#[derive(Default)]
pub struct UpdateState {
    pending: Mutex<Option<PendingUpdate>>,
    downloaded: Mutex<Option<DownloadedUpdate>>,
    // One gate across BOTH operations. Two separate flags leave a check/install
    // race where each observes the other as idle before setting itself busy.
    busy: AtomicBool,
    cancel_requested: AtomicBool,
    cancel_notify: Notify,
}

/// Applying a verified package can still fail before restart. Preserve the
/// exact payload so a retry does not need to redownload it, and leave durable
/// process state untouched until the explicit restart command succeeds.
fn recover_failed_apply<T>(
    downloaded_slot: &Mutex<Option<T>>,
    downloaded: T,
    apply_error: String,
) -> String {
    match downloaded_slot.lock() {
        Ok(mut slot) => {
            *slot = Some(downloaded);
            apply_error
        }
        Err(error) => format!(
            "{apply_error}; additionally could not restore the verified update payload: {error}"
        ),
    }
}

fn apply_recoverably<T>(
    downloaded_slot: &Mutex<Option<T>>,
    downloaded: T,
    install: impl FnOnce(&T) -> Result<(), String>,
) -> Result<(), String> {
    match install(&downloaded) {
        Ok(()) => Ok(()),
        Err(error) => Err(recover_failed_apply(downloaded_slot, downloaded, error)),
    }
}

/// Cross the irreversible restart boundary in one fixed order. Cleanup errors
/// are logged but cannot return control to a frontend whose workspace has
/// already been marked clean and whose live runtime may be partly torn down.
fn request_restart_after_cleanup(
    commit_clean_exit: impl FnOnce() -> Result<(), String>,
    cleanup_runtime: impl FnOnce() -> Result<(), String>,
    request_restart: impl FnOnce(),
) -> Result<(), String> {
    commit_clean_exit()?;
    if let Err(error) = cleanup_runtime() {
        log::error!("restart cleanup failed: {error}");
    }
    request_restart();
    Ok(())
}

impl UpdateState {
    fn reset_cancellation(&self) {
        self.cancel_requested.store(false, Ordering::Release);
    }

    fn request_cancellation(&self) {
        self.cancel_requested.store(true, Ordering::Release);
        // `busy` permits only one download. notify_one stores a permit if the
        // select branch has not registered yet, preventing a lost wake-up.
        self.cancel_notify.notify_one();
    }

    fn cancellation_requested(&self) -> bool {
        self.cancel_requested.load(Ordering::Acquire)
    }

    async fn cancelled(&self) {
        loop {
            if self.cancellation_requested() {
                return;
            }
            // A stale permit from a previous request is harmless: consume it,
            // then check the current operation's atomic flag again.
            self.cancel_notify.notified().await;
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
struct ReleaseCatalog {
    schema_version: u32,
    release: CatalogRelease,
    #[serde(default)]
    updater_bytes: HashMap<String, u64>,
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

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "event", content = "data")]
pub enum UpdateDownloadEvent {
    #[serde(rename_all = "camelCase")]
    Started {
        total_bytes: Option<u64>,
    },
    #[serde(rename_all = "camelCase")]
    Progress {
        downloaded_bytes: u64,
        total_bytes: Option<u64>,
    },
    Verifying,
    ReadyToInstall,
}

trait UpdateEventSink: Send + Sync {
    fn emit(&self, event: UpdateDownloadEvent);
}

impl UpdateEventSink for Channel<UpdateDownloadEvent> {
    fn emit(&self, event: UpdateDownloadEvent) {
        // A window closing must not invalidate an otherwise verified package.
        let _ = self.send(event);
    }
}

/// Converts the updater plugin's high-frequency chunk deltas into an absolute,
/// monotonic stream. The transfer's final sample is always emitted.
struct ProgressEmitter<'a> {
    sink: &'a dyn UpdateEventSink,
    total_bytes: Option<u64>,
    downloaded_bytes: u64,
    last_reported_bytes: Option<u64>,
    last_emit: Instant,
}

impl<'a> ProgressEmitter<'a> {
    fn new(sink: &'a dyn UpdateEventSink, total_bytes: Option<u64>) -> Self {
        Self::new_at(sink, total_bytes, Instant::now())
    }

    fn new_at(sink: &'a dyn UpdateEventSink, total_bytes: Option<u64>, now: Instant) -> Self {
        Self {
            sink,
            total_bytes,
            downloaded_bytes: 0,
            last_reported_bytes: None,
            last_emit: now,
        }
    }

    fn start(&self) {
        self.sink.emit(UpdateDownloadEvent::Started {
            total_bytes: self.total_bytes,
        });
    }

    fn chunk(&mut self, chunk_length: usize, content_length: Option<u64>) {
        self.chunk_at(chunk_length, content_length, Instant::now());
    }

    fn chunk_at(&mut self, chunk_length: usize, content_length: Option<u64>, now: Instant) {
        let learned_total =
            self.total_bytes.is_none() && valid_total_bytes(content_length).is_some();
        if self.total_bytes.is_none() {
            self.total_bytes = valid_total_bytes(content_length);
        }
        self.downloaded_bytes = self.downloaded_bytes.saturating_add(chunk_length as u64);
        if learned_total || now.saturating_duration_since(self.last_emit) >= PROGRESS_EMIT_INTERVAL
        {
            self.emit_progress();
            self.last_emit = now;
        }
    }

    fn emit_progress(&mut self) {
        if self.last_reported_bytes == Some(self.downloaded_bytes) {
            return;
        }
        self.sink.emit(UpdateDownloadEvent::Progress {
            downloaded_bytes: self.downloaded_bytes,
            total_bytes: self.total_bytes,
        });
        self.last_reported_bytes = Some(self.downloaded_bytes);
    }

    fn transfer_finished(&mut self) {
        self.emit_progress();
        // Tauri invokes its finish callback before minisign verification.
        self.sink.emit(UpdateDownloadEvent::Verifying);
    }
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

fn updater_target() -> Result<&'static str, String> {
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        Ok("darwin-aarch64")
    } else if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        Ok("windows-x86_64")
    } else {
        Err("application updates are not published for this platform".into())
    }
}

fn valid_total_bytes(bytes: Option<u64>) -> Option<u64> {
    bytes.filter(|bytes| *bytes > 0 && *bytes <= MAX_SAFE_JAVASCRIPT_INTEGER)
}

fn expected_updater_bytes_for(catalog: &ReleaseCatalog, target: &str) -> Option<u64> {
    valid_total_bytes(catalog.updater_bytes.get(target).copied())
}

fn validate_download_size(actual: usize, expected: Option<u64>) -> Result<(), String> {
    let Some(expected) = expected else {
        return Ok(());
    };
    let actual = u64::try_from(actual).unwrap_or(u64::MAX);
    if actual != expected {
        return Err(format!(
            "verified update size mismatch: downloaded {actual} bytes, expected {expected}"
        ));
    }
    Ok(())
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
    state.reset_cancellation();

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
        *state.downloaded.lock().map_err(|e| e.to_string())? = None;
        return Ok(None);
    }
    let expected_bytes = expected_updater_bytes_for(&catalog, updater_target()?);

    let endpoint = manifest_url(&catalog.release.tag)?;
    let updater_builder = app
        .updater_builder()
        .endpoints(vec![endpoint])
        .map_err(|e| e.to_string())?;
    #[cfg(target_os = "windows")]
    let updater_builder = {
        let exit_app = app.clone();
        updater_builder.on_before_exit(move || {
            // Windows launches NSIS and terminates inside `Update::install`, so
            // the normal frontend restart command is unreachable. Commit the
            // already-flushed workspace and stop WSL/process activity at the
            // plugin's final pre-exit boundary instead.
            let db = exit_app.state::<DbState>();
            if let Err(error) = crate::commands::workspace::commit_clean_exit(&exit_app, &db) {
                log::error!("could not commit clean Windows update exit: {error}");
            }
            if let Err(error) = crate::app_exit::cleanup_processes_for_exit(&exit_app) {
                log::error!("Windows update pre-exit cleanup failed: {error}");
            }
            exit_app.cleanup_before_exit();
        })
    };
    let updater = updater_builder.build().map_err(|e| e.to_string())?;
    let update = tokio::time::timeout(MANIFEST_CHECK_TIMEOUT, updater.check())
        .await
        .map_err(|_| "checking the signed update manifest timed out".to_string())?
        .map_err(|e| format!("could not check the signed update manifest: {e}"))?;

    let Some(update) = update else {
        *state.pending.lock().map_err(|e| e.to_string())? = None;
        *state.downloaded.lock().map_err(|e| e.to_string())? = None;
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
    let mut pending_slot = state.pending.lock().map_err(|e| e.to_string())?;
    if state.cancellation_requested() {
        return Err(DOWNLOAD_CANCELLED.into());
    }
    *pending_slot = Some(PendingUpdate {
        update,
        expected_bytes,
    });
    drop(pending_slot);
    *state.downloaded.lock().map_err(|e| e.to_string())? = None;
    Ok(Some(metadata))
}

#[tauri::command]
pub async fn update_download(
    state: State<'_, UpdateState>,
    on_event: Channel<UpdateDownloadEvent>,
) -> Result<String, String> {
    let _guard = begin(&state.busy, "operation")?;
    state.reset_cancellation();
    *state.downloaded.lock().map_err(|e| e.to_string())? = None;
    let pending = state
        .pending
        .lock()
        .map_err(|e| e.to_string())?
        .take()
        .ok_or_else(|| "there is no pending update; check again first".to_string())?;

    let progress = Mutex::new(ProgressEmitter::new(&on_event, pending.expected_bytes));
    progress.lock().map_err(|e| e.to_string())?.start();
    let bytes = {
        let download = tokio::time::timeout(
            DOWNLOAD_TIMEOUT,
            pending.update.download(
                |chunk_length, content_length| {
                    if let Ok(mut progress) = progress.lock() {
                        progress.chunk(chunk_length, content_length);
                    }
                },
                || {
                    if let Ok(mut progress) = progress.lock() {
                        progress.transfer_finished();
                    }
                },
            ),
        );
        tokio::pin!(download);
        tokio::select! {
            _ = state.cancelled() => return Err(DOWNLOAD_CANCELLED.into()),
            result = &mut download => result
                .map_err(|_| "downloading the update timed out".to_string())?
                .map_err(|e| format!("could not download or verify the update: {e}"))?,
        }
    };

    validate_download_size(bytes.len(), pending.expected_bytes)?;
    let id = uuid::Uuid::new_v4().to_string();
    let mut downloaded_slot = state.downloaded.lock().map_err(|e| e.to_string())?;
    if state.cancellation_requested() {
        return Err(DOWNLOAD_CANCELLED.into());
    }
    *downloaded_slot = Some(DownloadedUpdate {
        id: id.clone(),
        update: pending.update,
        bytes,
    });
    drop(downloaded_slot);
    // Update::download returns only after minisign verification; the catalog
    // size is also exact before this ready event is emitted.
    on_event.emit(UpdateDownloadEvent::ReadyToInstall);
    Ok(id)
}

#[tauri::command]
pub fn update_cancel(state: State<'_, UpdateState>) -> Result<(), String> {
    // Cancellation must not wait on the busy gate held by update_download.
    state.request_cancellation();
    *state.pending.lock().map_err(|e| e.to_string())? = None;
    *state.downloaded.lock().map_err(|e| e.to_string())? = None;
    Ok(())
}

#[tauri::command(async)]
pub fn update_apply(state: State<'_, UpdateState>, download_id: String) -> Result<(), String> {
    let _guard = begin(&state.busy, "operation")?;
    let mut slot = state.downloaded.lock().map_err(|e| e.to_string())?;
    let downloaded = slot
        .take()
        .ok_or_else(|| "there is no verified update ready to apply".to_string())?;
    if downloaded.id != download_id {
        *slot = Some(downloaded);
        return Err("the verified update id does not match".into());
    }
    drop(slot);

    apply_recoverably(&state.downloaded, downloaded, |downloaded| {
        downloaded
            .update
            .install(&downloaded.bytes)
            .map_err(|e| format!("could not apply the verified update: {e}"))
    })
}

#[tauri::command(async)]
pub fn app_restart(app: AppHandle<Wry>, db: State<'_, DbState>) -> Result<(), String> {
    // `request_restart`, rather than killing the process, lets the run callback
    // distinguish this exit from an ordinary quit and hand control back to
    // Tauri's relaunch path.
    //
    // Mark clean only after the frontend persistence barrier and installation
    // have both succeeded, immediately before the irreversible restart request.
    request_restart_after_cleanup(
        || crate::commands::workspace::commit_clean_exit(&app, &db),
        || crate::app_exit::cleanup_processes_for_exit(&app),
        || app.request_restart(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    fn catalog(tag: &str, version: &str, prerelease: bool) -> ReleaseCatalog {
        ReleaseCatalog {
            schema_version: 1,
            release: CatalogRelease {
                tag: tag.into(),
                version: version.into(),
                prerelease,
                published_at: Some("2026-08-13T00:00:00Z".into()),
            },
            updater_bytes: HashMap::from([
                ("darwin-aarch64".into(), 1_000),
                ("windows-x86_64".into(), 2_000),
            ]),
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

    #[test]
    fn failed_apply_restores_the_verified_payload() {
        let downloaded = Mutex::new(None);
        let error = apply_recoverably(&downloaded, "signature-verified-payload", |_| {
            Err("installer preparation failed".into())
        })
        .unwrap_err();

        assert_eq!(error, "installer preparation failed");
        assert_eq!(
            downloaded.lock().unwrap().as_deref(),
            Some("signature-verified-payload")
        );
    }

    #[test]
    fn restart_commits_then_cleans_runtime_then_requests_restart() {
        let steps = RefCell::new(Vec::new());

        request_restart_after_cleanup(
            || {
                steps.borrow_mut().push("commit");
                Ok(())
            },
            || {
                steps.borrow_mut().push("cleanup");
                Ok(())
            },
            || steps.borrow_mut().push("restart"),
        )
        .unwrap();

        assert_eq!(*steps.borrow(), ["commit", "cleanup", "restart"]);
    }

    #[test]
    fn restart_is_still_requested_after_cleanup_failure() {
        let steps = RefCell::new(Vec::new());

        request_restart_after_cleanup(
            || {
                steps.borrow_mut().push("commit");
                Ok(())
            },
            || {
                steps.borrow_mut().push("cleanup");
                Err("PTY cleanup failed".into())
            },
            || steps.borrow_mut().push("restart"),
        )
        .unwrap();

        assert_eq!(*steps.borrow(), ["commit", "cleanup", "restart"]);
    }

    #[test]
    fn failed_clean_commit_does_not_destroy_runtime_or_restart() {
        let steps = RefCell::new(Vec::new());

        let error = request_restart_after_cleanup(
            || {
                steps.borrow_mut().push("commit");
                Err("clean commit failed".into())
            },
            || {
                steps.borrow_mut().push("cleanup");
                Ok(())
            },
            || steps.borrow_mut().push("restart"),
        )
        .unwrap_err();

        assert_eq!(error, "clean commit failed");
        assert_eq!(*steps.borrow(), ["commit"]);
    }

    #[test]
    fn updater_sizes_are_targeted_positive_and_javascript_safe() {
        let mut catalog = catalog("v1.2.0", "1.2.0", false);
        assert_eq!(
            expected_updater_bytes_for(&catalog, "darwin-aarch64"),
            Some(1_000)
        );
        catalog.updater_bytes.insert("darwin-aarch64".into(), 0);
        assert_eq!(expected_updater_bytes_for(&catalog, "darwin-aarch64"), None);
        catalog
            .updater_bytes
            .insert("darwin-aarch64".into(), MAX_SAFE_JAVASCRIPT_INTEGER + 1);
        assert_eq!(expected_updater_bytes_for(&catalog, "darwin-aarch64"), None);
    }

    #[test]
    fn older_schema_one_catalogs_without_sizes_remain_valid() {
        let catalog: ReleaseCatalog = serde_json::from_value(serde_json::json!({
            "schema_version": 1,
            "release": {
                "tag": "v1.2.0",
                "version": "1.2.0",
                "prerelease": false,
                "published_at": "2026-08-13T00:00:00Z"
            }
        }))
        .unwrap();

        assert!(catalog.updater_bytes.is_empty());
        assert_eq!(validate_catalog(&catalog).unwrap(), Version::new(1, 2, 0));
        assert_eq!(expected_updater_bytes_for(&catalog, "darwin-aarch64"), None);
    }

    #[test]
    fn download_size_must_match_the_catalog_exactly() {
        assert!(validate_download_size(1_000, Some(1_000)).is_ok());
        assert!(validate_download_size(999, Some(1_000)).is_err());
        assert!(validate_download_size(1_001, Some(1_000)).is_err());
        assert!(validate_download_size(999, None).is_ok());
    }

    #[tokio::test]
    async fn cancellation_wakes_a_waiter_and_can_be_reset_for_a_retry() {
        let state = std::sync::Arc::new(UpdateState::default());
        let waiting = state.clone();
        let waiter = tokio::spawn(async move { waiting.cancelled().await });
        tokio::task::yield_now().await;

        state.request_cancellation();
        tokio::time::timeout(Duration::from_secs(1), waiter)
            .await
            .expect("cancellation waiter timed out")
            .expect("cancellation waiter panicked");
        assert!(state.cancellation_requested());

        state.reset_cancellation();
        assert!(!state.cancellation_requested());
    }

    #[tokio::test]
    async fn a_stale_notification_does_not_cancel_the_next_download() {
        let state = UpdateState::default();
        state.request_cancellation();
        state.reset_cancellation();

        assert!(
            tokio::time::timeout(Duration::from_millis(10), state.cancelled())
                .await
                .is_err()
        );
        state.request_cancellation();
        tokio::time::timeout(Duration::from_secs(1), state.cancelled())
            .await
            .expect("fresh cancellation was not observed");
    }

    #[derive(Default)]
    struct Recorder(Mutex<Vec<UpdateDownloadEvent>>);

    impl UpdateEventSink for Recorder {
        fn emit(&self, event: UpdateDownloadEvent) {
            self.0.lock().unwrap().push(event);
        }
    }

    #[test]
    fn progress_is_absolute_throttled_and_finishes_exactly_before_verification() {
        let recorder = Recorder::default();
        let start = Instant::now();
        let mut progress = ProgressEmitter::new_at(&recorder, Some(100), start);
        progress.start();
        progress.chunk_at(10, Some(999), start + Duration::from_millis(25));
        progress.chunk_at(20, Some(999), start + Duration::from_millis(149));
        progress.chunk_at(30, Some(999), start + Duration::from_millis(150));
        progress.chunk_at(40, Some(999), start + Duration::from_millis(200));
        progress.transfer_finished();

        assert_eq!(
            *recorder.0.lock().unwrap(),
            vec![
                UpdateDownloadEvent::Started {
                    total_bytes: Some(100),
                },
                UpdateDownloadEvent::Progress {
                    downloaded_bytes: 60,
                    total_bytes: Some(100),
                },
                UpdateDownloadEvent::Progress {
                    downloaded_bytes: 100,
                    total_bytes: Some(100),
                },
                UpdateDownloadEvent::Verifying,
            ]
        );
    }

    #[test]
    fn http_length_is_a_fallback_and_missing_lengths_stay_indeterminate() {
        let recorder = Recorder::default();
        let start = Instant::now();
        let mut progress = ProgressEmitter::new_at(&recorder, None, start);
        progress.start();
        progress.chunk_at(10, None, start + PROGRESS_EMIT_INTERVAL);
        progress.chunk_at(20, Some(100), start + PROGRESS_EMIT_INTERVAL * 2);
        progress.transfer_finished();

        assert_eq!(
            *recorder.0.lock().unwrap(),
            vec![
                UpdateDownloadEvent::Started { total_bytes: None },
                UpdateDownloadEvent::Progress {
                    downloaded_bytes: 10,
                    total_bytes: None,
                },
                UpdateDownloadEvent::Progress {
                    downloaded_bytes: 30,
                    total_bytes: Some(100),
                },
                UpdateDownloadEvent::Verifying,
            ]
        );
    }
}
