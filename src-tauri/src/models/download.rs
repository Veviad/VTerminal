use futures::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::{Path, PathBuf};
use tokio::io::AsyncWriteExt;

use super::{registry, DownloadEvent, EventSink};

// Resumable GGUF download from the HF CDN: streams to `<file>.part`, resumes
// via Range header when the stored etag still matches, verifies size, then
// atomically renames and registers the model.

#[derive(Serialize, Deserialize)]
struct PartMeta {
    url: String,
    etag: Option<String>,
    expected_size: Option<u64>,
}

pub struct DownloadRequest {
    pub download_id: String,
    pub repo_id: String,
    pub filename: String,
    /// Immutable Hub commit. `None` keeps the legacy chat/vision behavior and
    /// resolves `main`; security-sensitive catalogs should always pin this.
    pub revision: Option<String>,
    /// Catalog-pinned file size. When present it takes precedence over HEAD and
    /// is checked both before and after the transfer.
    pub expected_size: Option<u64>,
    /// Catalog-pinned SHA-256 (the Hugging Face LFS oid). Verification happens
    /// before the `.part` file is atomically promoted or registered.
    pub expected_sha256: Option<String>,
    pub models_dir: PathBuf,
    pub hf_token: Option<crate::credentials::Secret>,
}

fn client(hf_token: Option<&crate::credentials::Secret>) -> Result<reqwest::Client, String> {
    let mut headers = reqwest::header::HeaderMap::new();
    if let Some(token) = hf_token {
        if !token.expose().trim().is_empty() {
            headers.insert(
                reqwest::header::AUTHORIZATION,
                format!("Bearer {}", token.expose().trim())
                    .parse()
                    .map_err(|_| "invalid HF token".to_string())?,
            );
        }
    }
    reqwest::Client::builder()
        .user_agent(concat!("vterminal/", env!("CARGO_PKG_VERSION")))
        .default_headers(headers)
        .build()
        .map_err(|e| e.to_string())
}

/// How a download ended.
///
/// The distinction exists because `run` used to answer `Ok(())` for both, and a
/// driver downloading two files under one id cannot decide whether to start the
/// second without knowing which happened. Cancelling after the projector must not
/// silently go on to pull 5GB of weights.
pub enum Outcome {
    Completed(registry::LocalModel),
    Cancelled,
}

pub async fn run(
    req: DownloadRequest,
    on_event: &dyn EventSink,
    mut cancel: tokio::sync::oneshot::Receiver<()>,
) -> Result<Outcome, String> {
    let result = run_inner(&req, on_event, &mut cancel).await;
    if let Err(e) = &result {
        on_event.emit(DownloadEvent::Error { message: e.clone() });
    }
    result
}

async fn run_inner(
    req: &DownloadRequest,
    on_event: &dyn EventSink,
    cancel: &mut tokio::sync::oneshot::Receiver<()>,
) -> Result<Outcome, String> {
    if super::hf::is_multipart(&req.filename) {
        return Err(
            "Multi-part GGUF files are not supported yet — pick a single-file quant.".into(),
        );
    }

    let revision = req.revision.as_deref().unwrap_or("main");
    let url = format!(
        "https://huggingface.co/{}/resolve/{revision}/{}",
        req.repo_id, req.filename
    );
    let dir = registry::repo_dir(&req.models_dir, &req.repo_id);
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| format!("create model dir: {e}"))?;
    let final_path = dir.join(&req.filename);
    let part_path = dir.join(format!("{}.part", req.filename));
    let meta_path = dir.join(format!("{}.part.json", req.filename));

    let http = client(req.hf_token.as_ref())?;

    // HEAD for etag + size (follows redirects to the CDN).
    let head = http
        .head(&url)
        .send()
        .await
        .map_err(|e| format!("HEAD failed: {e}"))?;
    if !head.status().is_success() {
        return Err(format!("File not available: HTTP {}", head.status()));
    }
    let etag = head
        .headers()
        .get(reqwest::header::ETAG)
        .and_then(|v| v.to_str().ok())
        .map(String::from);
    let remote_size = head
        .headers()
        .get(reqwest::header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok());
    if let (Some(expected), Some(remote)) = (req.expected_size, remote_size) {
        if expected != remote {
            return Err(format!(
                "Catalog size mismatch before download: server reports {remote} bytes, expected {expected}"
            ));
        }
    }
    let total_size = req.expected_size.or(remote_size);

    // Resume only when the stored etag matches the remote file.
    let mut resume_from: u64 = 0;
    if let (Ok(part_meta), Ok(part_file)) = (
        tokio::fs::read_to_string(&meta_path).await,
        tokio::fs::metadata(&part_path).await,
    ) {
        if let Ok(meta) = serde_json::from_str::<PartMeta>(&part_meta) {
            if meta.etag.is_some() && meta.etag == etag {
                resume_from = part_file.len();
            }
        }
    }
    if let Some(total) = total_size {
        // A .part at exactly the full size (cancel landed after the last chunk
        // but before the rename) is already complete — finalize it directly; a
        // ranged GET from EOF would get HTTP 416 and wedge every retry.
        if resume_from == total {
            return finalize(
                req,
                on_event,
                &part_path,
                &meta_path,
                &final_path,
                total_size,
            )
            .await;
        }
        // Oversized part = corrupt; start over.
        if resume_from > total {
            resume_from = 0;
        }
    }
    if resume_from == 0 {
        let _ = tokio::fs::remove_file(&part_path).await;
    }

    tokio::fs::write(
        &meta_path,
        serde_json::to_string(&PartMeta {
            url: url.clone(),
            etag: etag.clone(),
            expected_size: total_size,
        })
        .map_err(|e| e.to_string())?,
    )
    .await
    .map_err(|e| format!("write part meta: {e}"))?;

    let mut request = http.get(&url);
    if resume_from > 0 {
        request = request.header(reqwest::header::RANGE, format!("bytes={resume_from}-"));
    }
    let resp = request
        .send()
        .await
        .map_err(|e| format!("GET failed: {e}"))?;
    let status = resp.status();
    if status == reqwest::StatusCode::RANGE_NOT_SATISFIABLE {
        // Stale/corrupt .part — clean up so the NEXT attempt starts fresh
        // instead of wedging on the same range forever.
        let _ = tokio::fs::remove_file(&part_path).await;
        let _ = tokio::fs::remove_file(&meta_path).await;
        return Err("Download state was stale (HTTP 416) — cleaned up, please retry.".into());
    }
    if !(status.is_success() || status == reqwest::StatusCode::PARTIAL_CONTENT) {
        return Err(format!("Download failed: HTTP {status}"));
    }
    // Server ignored the Range header → start over.
    if resume_from > 0 && status != reqwest::StatusCode::PARTIAL_CONTENT {
        resume_from = 0;
        let _ = tokio::fs::remove_file(&part_path).await;
    }

    on_event.emit(DownloadEvent::Started {
        download_id: req.download_id.clone(),
        total_bytes: total_size,
        resumed_from: resume_from,
    });

    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&part_path)
        .await
        .map_err(|e| format!("open part file: {e}"))?;

    let mut downloaded = resume_from;
    let mut stream = resp.bytes_stream();
    let mut last_emit = std::time::Instant::now();
    let mut window_start = std::time::Instant::now();
    let mut window_bytes: u64 = 0;
    let mut bps: u64 = 0;

    loop {
        tokio::select! {
            _ = &mut *cancel => {
                let _ = file.flush().await;
                on_event.emit(DownloadEvent::Cancelled);
                // Keep .part for later resume.
                return Ok(Outcome::Cancelled);
            }
            chunk = stream.next() => {
                let Some(chunk) = chunk else { break };
                let chunk = chunk.map_err(|e| format!("stream error: {e}"))?;
                file.write_all(&chunk)
                    .await
                    .map_err(|e| format!("write error: {e}"))?;
                downloaded += chunk.len() as u64;
                window_bytes += chunk.len() as u64;
                let now = std::time::Instant::now();
                if now.duration_since(window_start).as_millis() >= 1000 {
                    bps = window_bytes * 1000 / now.duration_since(window_start).as_millis().max(1) as u64;
                    window_bytes = 0;
                    window_start = now;
                }
                if now.duration_since(last_emit).as_millis() >= 150 {
                    last_emit = now;
                    // total_size came from the un-ranged HEAD → already the full size
                    on_event.emit(DownloadEvent::Progress {
                        downloaded,
                        total_bytes: total_size,
                        bytes_per_sec: bps,
                    });
                }
            }
        }
    }
    file.flush().await.map_err(|e| format!("flush: {e}"))?;
    drop(file);

    finalize(
        req,
        on_event,
        &part_path,
        &meta_path,
        &final_path,
        total_size,
    )
    .await
}

/// Verify the .part against the expected size, atomically rename it into
/// place, register the model, and emit Completed. On a size mismatch the
/// stale .part/.part.json are removed so the next attempt starts fresh.
async fn finalize(
    req: &DownloadRequest,
    on_event: &dyn EventSink,
    part_path: &Path,
    meta_path: &Path,
    final_path: &Path,
    total_size: Option<u64>,
) -> Result<Outcome, String> {
    let disk_size = tokio::fs::metadata(part_path)
        .await
        .map_err(|e| format!("stat part: {e}"))?
        .len();
    if let Some(expected) = total_size {
        if disk_size != expected {
            let _ = tokio::fs::remove_file(part_path).await;
            let _ = tokio::fs::remove_file(meta_path).await;
            return Err(format!(
                "Size mismatch after download: got {disk_size} bytes, expected {expected} — cleaned up, please retry."
            ));
        }
    }

    if let Some(expected) = req.expected_sha256.as_deref() {
        on_event.phase("verifying");
        let path = part_path.to_path_buf();
        let actual = tokio::task::spawn_blocking(move || sha256_file(&path))
            .await
            .map_err(|e| format!("artifact verification task failed: {e}"))??;
        if !actual.eq_ignore_ascii_case(expected) {
            let _ = tokio::fs::remove_file(part_path).await;
            let _ = tokio::fs::remove_file(meta_path).await;
            return Err(format!(
                "SHA-256 mismatch after download: got {actual}, expected {} — cleaned up, please retry.",
                expected.to_ascii_lowercase()
            ));
        }
    }

    tokio::fs::rename(part_path, final_path)
        .await
        .map_err(|e| format!("finalize failed: {e}"))?;
    let _ = tokio::fs::remove_file(meta_path).await;

    let model = registry::make_local_model(&req.repo_id, &req.filename, final_path, disk_size);
    registry::add(&req.models_dir, model.clone())?;

    on_event.emit(DownloadEvent::Completed {
        model_id: model.id.clone(),
        path: final_path.to_string_lossy().into_owned(),
    });
    Ok(Outcome::Completed(model))
}

/// Hash a file without buffering multi-gigabyte GGUF weights in memory.
pub fn sha256_file(path: &Path) -> Result<String, String> {
    use std::fmt::Write;

    let mut file = std::fs::File::open(path).map_err(|e| format!("open for SHA-256: {e}"))?;
    let mut digest = Sha256::new();
    let mut buffer = vec![0u8; 1024 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|e| format!("read for SHA-256: {e}"))?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    let digest = digest.finalize();
    let mut output = String::with_capacity(digest.len() * 2);
    for byte in digest {
        let _ = write!(output, "{byte:02x}");
    }
    Ok(output)
}

pub fn delete_model_files(models_dir: &Path, model: &registry::LocalModel) -> Result<(), String> {
    let path = Path::new(&model.path);
    if path.exists() {
        std::fs::remove_file(path).map_err(|e| format!("delete model file: {e}"))?;
    }
    // Remove the repo dir if now empty.
    if let Some(parent) = path.parent() {
        if parent.starts_with(models_dir) {
            let _ = std::fs::remove_dir(parent);
        }
    }
    Ok(())
}

/// Presents a MULTI-FILE download as one progress stream.
///
/// A vision model is weights + an mmproj projector, but the frontend's
/// `DownloadProgress` / `ActiveDownloads` / `DownloadRow` all assume one file per
/// `download_id`. Rebasing here is what keeps every one of them unchanged.
///
/// `total` comes from the catalog, so no HEAD request is needed and the bar never
/// jumps backwards when the second file's own total arrives.
pub struct RebasedSink<'a> {
    inner: &'a dyn EventSink,
    /// Bytes already finished by earlier files in this batch.
    offset: u64,
    /// The batch total, across every file.
    total: u64,
}

impl<'a> RebasedSink<'a> {
    pub fn new(inner: &'a dyn EventSink, offset: u64, total: u64) -> Self {
        Self {
            inner,
            offset,
            total,
        }
    }
}

impl EventSink for RebasedSink<'_> {
    fn emit(&self, event: DownloadEvent) {
        match event {
            // Per-FILE start and finish are not batch start and finish. The driver
            // emits exactly one of each around the whole batch; forwarding these
            // would make the row appear twice and then vanish before the weights
            // had begun.
            DownloadEvent::Started { .. } | DownloadEvent::Completed { .. } => {}
            DownloadEvent::Progress {
                downloaded,
                bytes_per_sec,
                ..
            } => {
                self.inner.emit(DownloadEvent::Progress {
                    downloaded: self.offset + downloaded,
                    total_bytes: Some(self.total),
                    bytes_per_sec,
                });
            }
            // Both end the batch, so both belong to the caller.
            event @ (DownloadEvent::Cancelled | DownloadEvent::Error { .. }) => {
                self.inner.emit(event);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[derive(Default)]
    struct Recorder(Mutex<Vec<DownloadEvent>>);

    impl EventSink for Recorder {
        fn emit(&self, event: DownloadEvent) {
            self.0.lock().unwrap().push(event);
        }
    }

    impl Recorder {
        /// (downloaded, total) for each Progress event seen.
        fn progress(&self) -> Vec<(u64, Option<u64>)> {
            self.0
                .lock()
                .unwrap()
                .iter()
                .filter_map(|e| match e {
                    DownloadEvent::Progress {
                        downloaded,
                        total_bytes,
                        ..
                    } => Some((*downloaded, *total_bytes)),
                    _ => None,
                })
                .collect()
        }

        fn kinds(&self) -> Vec<&'static str> {
            self.0
                .lock()
                .unwrap()
                .iter()
                .map(|e| match e {
                    DownloadEvent::Started { .. } => "started",
                    DownloadEvent::Progress { .. } => "progress",
                    DownloadEvent::Completed { .. } => "completed",
                    DownloadEvent::Cancelled => "cancelled",
                    DownloadEvent::Error { .. } => "error",
                })
                .collect()
        }
    }

    fn progress(downloaded: u64, total: Option<u64>) -> DownloadEvent {
        DownloadEvent::Progress {
            downloaded,
            total_bytes: total,
            bytes_per_sec: 1_000,
        }
    }

    /// The bookkeeping most likely to be off by one file's size: two files must
    /// read as one monotonic run from 0 to the batch total.
    #[test]
    fn two_files_rebase_into_one_monotonic_run() {
        const MMPROJ: u64 = 900;
        const WEIGHTS: u64 = 2_100;
        const TOTAL: u64 = MMPROJ + WEIGHTS;
        let out = Recorder::default();

        // File 1: the projector, first because it is small and proves the repo
        // layout before 5GB of weights are pulled.
        {
            let sink = RebasedSink::new(&out, 0, TOTAL);
            sink.emit(DownloadEvent::Started {
                download_id: "d1".into(),
                total_bytes: Some(MMPROJ),
                resumed_from: 0,
            });
            sink.emit(progress(450, Some(MMPROJ)));
            sink.emit(progress(MMPROJ, Some(MMPROJ)));
            sink.emit(DownloadEvent::Completed {
                model_id: "m".into(),
                path: "p".into(),
            });
        }
        // File 2: the weights, offset by everything already on disk.
        {
            let sink = RebasedSink::new(&out, MMPROJ, TOTAL);
            sink.emit(progress(1_000, Some(WEIGHTS)));
            sink.emit(progress(WEIGHTS, Some(WEIGHTS)));
        }

        let seen = out.progress();
        assert_eq!(
            seen,
            vec![
                (450, Some(TOTAL)),
                (900, Some(TOTAL)),
                (1_900, Some(TOTAL)),
                (TOTAL, Some(TOTAL)),
            ]
        );
        // Monotonic, and it lands exactly on the total rather than near it.
        assert!(seen.windows(2).all(|w| w[0].0 <= w[1].0));
        assert_eq!(seen.last().unwrap().0, TOTAL);
        // Per-file Started/Completed never reach the frontend.
        assert_eq!(out.kinds(), vec!["progress"; 4]);
    }

    /// Cancel and error are the batch's business — swallowing them would leave the
    /// row spinning forever.
    #[test]
    fn cancel_and_error_pass_straight_through() {
        let out = Recorder::default();
        let sink = RebasedSink::new(&out, 0, 100);
        sink.emit(DownloadEvent::Cancelled);
        sink.emit(DownloadEvent::Error {
            message: "boom".into(),
        });
        assert_eq!(out.kinds(), vec!["cancelled", "error"]);
    }

    /// A resumed file reports its own absolute position, not a delta, so the
    /// offset still applies unchanged.
    #[test]
    fn a_resumed_second_file_still_lands_on_the_total() {
        let out = Recorder::default();
        let sink = RebasedSink::new(&out, 900, 3_000);
        sink.emit(progress(2_100, Some(2_100)));
        assert_eq!(out.progress(), vec![(3_000, Some(3_000))]);
    }

    #[test]
    fn sha256_is_streamed_and_hex_encoded() {
        let path = std::env::temp_dir().join(format!(
            "vterminal-download-sha-{}.bin",
            uuid::Uuid::new_v4()
        ));
        std::fs::write(&path, b"abc").unwrap();
        assert_eq!(
            sha256_file(&path).unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        std::fs::remove_file(path).ok();
    }
}
