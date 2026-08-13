pub mod catalog;
pub mod download;
pub mod hf;
pub mod registry;
pub mod remote;
pub mod remote_probe;
pub mod vision;

/// The ONE place the strict catalog widens to include user-configured models.
///
/// Every allowlist gate goes through here rather than calling `catalog::find`
/// directly — `active_model`, `save_settings`, `set_model_effort` — so a future
/// model source is one function to change instead of five call sites.
pub fn find_model(
    app: &tauri::AppHandle<tauri::Wry>,
    id: &str,
) -> Option<&'static catalog::CatalogModel> {
    catalog::find(id).or_else(|| remote::find(app, id))
}

use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;

#[derive(Clone, Serialize)]
#[serde(tag = "type")]
pub enum DownloadEvent {
    Started {
        download_id: String,
        total_bytes: Option<u64>,
        resumed_from: u64,
    },
    Progress {
        downloaded: u64,
        total_bytes: Option<u64>,
        bytes_per_sec: u64,
    },
    Completed {
        model_id: String,
        path: String,
    },
    Cancelled,
    Error {
        message: String,
    },
}

/// Where a download reports progress.
///
/// A trait rather than the `Channel` itself because `tauri::ipc::Channel` cannot be
/// constructed outside an IPC call, so a driver that downloads TWO files under one
/// `download_id` has no way to wrap the real channel and rebase the byte counts.
/// With this seam, the vision downloader interposes a `RebasedSink` and the
/// frontend's `DownloadEvent`, `DownloadProgress`, `ActiveDownloads` and
/// `DownloadRow` all stay exactly as they were.
pub trait EventSink: Send + Sync {
    fn emit(&self, event: DownloadEvent);

    /// Optional lifecycle hook for drivers that expose verification separately
    /// from transfer progress. Existing chat/vision sinks deliberately ignore
    /// it; the embedding installer maps it to its richer UI event contract.
    fn phase(&self, _phase: &'static str) {}
}

impl EventSink for tauri::ipc::Channel<DownloadEvent> {
    fn emit(&self, event: DownloadEvent) {
        // Same posture as the direct `let _ = on_event.send(...)` calls this
        // replaces: a closed channel means the window went away, which is not a
        // reason to fail a download that is still writing correct bytes to disk.
        let _ = self.send(event);
    }
}

#[cfg_attr(not(feature = "local-llm"), allow(dead_code))]
#[derive(Clone, Serialize)]
#[serde(tag = "type")]
pub enum LoadEvent {
    Phase { name: String },
    Ready { context_len: u32 },
    Error { message: String },
}

#[derive(Default)]
pub struct DownloadState {
    pub cancel: Mutex<HashMap<String, tokio::sync::oneshot::Sender<()>>>,
    /// In-flight guard keyed by "repo_id/filename" — two concurrent writers on
    /// the same .part would interleave appends and corrupt it.
    pub in_flight: Mutex<std::collections::HashSet<String>>,
}
