//! Cross-process serialization for durable knowledge-job ownership.

use std::fs::{File, OpenOptions};
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use fs2::FileExt;

/// At most one desktop future waits on the operating-system lock. Without this
/// small local gate, a burst of UI writes during a long CLI ingest would consume
/// one blocking-pool thread per invocation.
static LOCAL_WRITER: OnceLock<Arc<tokio::sync::Mutex<()>>> = OnceLock::new();

pub struct KnowledgeProcessLock {
    file: File,
    _local: Option<tokio::sync::OwnedMutexGuard<()>>,
}

impl KnowledgeProcessLock {
    /// Try to become the sole cross-process knowledge writer without waiting.
    /// Read-only operations deliberately do not acquire this lock.
    pub fn try_acquire(app_data: &Path) -> Result<Self, String> {
        let file = open_lock_file(app_data)?;
        file.try_lock_exclusive().map_err(|error| {
            format!(
                "another VTerminal process is changing knowledge; wait for that operation to finish ({error})"
            )
        })?;
        Ok(Self { file, _local: None })
    }

    /// Wait off the async runtime until the current writer finishes. The returned
    /// guard is intentionally owned by the whole mutation/job future.
    pub async fn acquire(app_data: PathBuf) -> Result<Self, String> {
        let local = LOCAL_WRITER
            .get_or_init(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone()
            .lock_owned()
            .await;
        // Move the local guard into the blocking task as well. If an IPC future
        // is cancelled, the detached blocking task still owns the only local
        // waiter until it acquires and immediately releases the file lock.
        tokio::task::spawn_blocking(move || {
            let file = open_lock_file(&app_data)?;
            file.lock_exclusive().map_err(|error| {
                format!("wait for the active VTerminal knowledge operation: {error}")
            })?;
            Ok(Self {
                file,
                _local: Some(local),
            })
        })
        .await
        .map_err(|error| format!("join knowledge lock task: {error}"))?
    }
}

fn open_lock_file(app_data: &Path) -> Result<File, String> {
    std::fs::create_dir_all(app_data).map_err(|error| error.to_string())?;
    OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(app_data.join("knowledge-jobs.lock"))
        .map_err(|error| error.to_string())
}

impl Drop for KnowledgeProcessLock {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.file);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_dir() -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "vterminal-knowledge-process-lock-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn try_lock_is_exclusive_and_released_with_guard() {
        let path = test_dir();
        let first = KnowledgeProcessLock::try_acquire(&path).unwrap();
        assert!(KnowledgeProcessLock::try_acquire(&path).is_err());
        drop(first);
        KnowledgeProcessLock::try_acquire(&path).unwrap();
    }

    #[tokio::test]
    async fn async_lock_waits_for_the_current_writer() {
        let path = test_dir();
        let first = KnowledgeProcessLock::try_acquire(&path).unwrap();
        let waiter = tokio::spawn(KnowledgeProcessLock::acquire(path));
        tokio::task::yield_now().await;
        assert!(!waiter.is_finished());
        drop(first);
        tokio::time::timeout(std::time::Duration::from_secs(2), waiter)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
    }
}
