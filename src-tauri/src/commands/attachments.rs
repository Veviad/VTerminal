//! Chat attachments on disk.
//!
//! Normalization (downscale, re-encode, MIME sniffing, caps) is all frontend-side
//! in `lib/attachments.ts` — WKWebView already has the bytes and a system image
//! decoder, and Rust has no `image` crate. This module does the one thing the
//! webview cannot: give the bytes somewhere to live so a reopened transcript still
//! shows its thumbnails.
//!
//! Files land in `<app_data>/attachments/<session_id>/<attachment_id>.<ext>`. The
//! archive stores the path, never the bytes: `archive_put` runs inside a ~500 ms
//! budget on the tab-close path, contending with the snapshot tick, and a few MB of
//! base64 per image would blow it.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use base64::Engine;
use serde::Serialize;
use tauri::{AppHandle, Manager, Wry};

/// Extensions we are willing to write, keyed by the media type the frontend
/// sniffed from the leading bytes. Deliberately an allowlist rather than
/// `split('/').last()`: the value ultimately derives from a file the user dropped
/// in, and it is about to become part of a filesystem path.
fn extension_for(media_type: &str) -> Option<&'static str> {
    match media_type {
        "image/png" => Some("png"),
        "image/jpeg" => Some("jpg"),
        "image/gif" => Some("gif"),
        "image/webp" => Some("webp"),
        _ => None,
    }
}

/// One path component, from an id the frontend generated.
///
/// `att-<base36>-<base36>` by construction, but this is the check that makes it
/// true: without it an id of `../../../../etc/passwd` is a path, not a name.
fn safe_component(value: &str, what: &str) -> Result<String, String> {
    let ok = !value.is_empty()
        && value.len() <= 128
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if ok {
        Ok(value.to_string())
    } else {
        Err(format!("invalid {what}"))
    }
}

pub fn attachments_root(app: &AppHandle<Wry>) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?
        .join("attachments"))
}

fn session_dir(app: &AppHandle<Wry>, session_id: &str) -> Result<PathBuf, String> {
    let session = safe_component(session_id, "session id")?;
    Ok(attachments_root(app)?.join(session))
}

#[derive(Serialize)]
pub struct StoredAttachment {
    pub path: String,
    pub bytes: u64,
}

/// Persist one attachment's bytes and hand back where they went.
///
/// Called from the send path, not from the drop handler: attaching and then
/// removing a file would otherwise leave an orphan on disk for a message that was
/// never sent.
#[tauri::command(rename_all = "snake_case")]
pub async fn attachment_put(
    app: AppHandle<Wry>,
    session_id: String,
    attachment_id: String,
    media_type: String,
    data_base64: String,
) -> Result<StoredAttachment, String> {
    let ext = extension_for(&media_type).ok_or("unsupported attachment type")?;
    let id = safe_component(&attachment_id, "attachment id")?;
    let dir = session_dir(&app, &session_id)?;

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64.as_bytes())
        .map_err(|e| format!("attachment is not valid base64: {e}"))?;

    std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let path = dir.join(format!("{id}.{ext}"));
    std::fs::write(&path, &bytes).map_err(|e| format!("write {}: {e}", path.display()))?;

    Ok(StoredAttachment {
        path: path.to_string_lossy().into_owned(),
        bytes: bytes.len() as u64,
    })
}

/// Read a stored attachment back, for a thumbnail on a restored transcript.
///
/// Raw bytes rather than base64, following `pty_spawn`: this reaches JS as an
/// `ArrayBuffer` with no expansion and no decode step.
///
/// The path comes out of the archive database, so it is not user input in the
/// usual sense — but it IS a path from persistent storage being handed to
/// `fs::read`, and confining it to the attachments root is cheap.
#[tauri::command(rename_all = "snake_case")]
pub async fn attachment_read(
    app: AppHandle<Wry>,
    path: String,
) -> Result<tauri::ipc::Response, String> {
    let root = attachments_root(&app)?;
    let canonical =
        std::fs::canonicalize(Path::new(&path)).map_err(|_| "attachment is gone".to_string())?;
    // canonicalize the root too, or a symlinked app-data dir fails the compare on
    // macOS (/var vs /private/var).
    let canonical_root =
        std::fs::canonicalize(&root).map_err(|_| "no attachments yet".to_string())?;
    if !canonical.starts_with(&canonical_root) {
        return Err("attachment is outside the attachments directory".into());
    }
    let bytes = std::fs::read(&canonical).map_err(|e| format!("read attachment: {e}"))?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Drop both the archive row's own directory and any older directories still
/// referenced by a transcript carried through one or more reopens.
pub fn remove_archive_attachments(
    app: &AppHandle<Wry>,
    session_id: &str,
    remove_session_dir: bool,
    stored_paths: &[String],
) {
    let Ok(root) = attachments_root(app) else {
        return;
    };
    remove_archive_attachments_at(&root, session_id, remove_session_dir, stored_paths);
}

/// Remove only files whose final Chat owner was deleted.
///
/// A Chat can contain a shared path beside an unshared path in the same owner
/// directory. Removing paths one by one preserves the shared file; `remove_dir`
/// then drops the owner directory only after its last referenced file is gone.
pub fn remove_chat_attachments(app: &AppHandle<Wry>, stored_paths: &[String]) {
    let Ok(root) = attachments_root(app) else {
        return;
    };
    remove_chat_attachment_paths_at(&root, stored_paths);
}

pub(crate) fn remove_chat_attachment_paths_at(root: &Path, paths: &[String]) {
    let Ok(canonical_root) = std::fs::canonicalize(root) else {
        return;
    };
    let mut dirs = HashSet::new();
    for stored in paths {
        let path = Path::new(stored);
        let Some(parent) = path.parent() else {
            continue;
        };
        let Ok(canonical_parent) = std::fs::canonicalize(parent) else {
            continue;
        };
        if canonical_parent.parent() != Some(canonical_root.as_path()) {
            continue;
        }
        if std::fs::remove_file(path).is_ok() {
            dirs.insert(canonical_parent);
        }
    }
    for dir in dirs {
        // Unlike archive cleanup, Chat directories may still contain a file
        // referenced by another thread. Only remove an empty owner directory.
        let _ = std::fs::remove_dir(dir);
    }
}

pub(crate) fn remove_archive_attachments_at(
    root: &Path,
    session_id: &str,
    remove_session_dir: bool,
    stored_paths: &[String],
) {
    if remove_session_dir {
        if let Ok(session) = safe_component(session_id, "session id") {
            let _ = std::fs::remove_dir_all(root.join(session));
        }
    }
    remove_stored_attachment_paths_at(root, stored_paths);
}

/// Remove the direct child directories that own paths retained by a deleted
/// archive row. Reopened transcripts keep their original absolute attachment
/// paths, so the owner directory can be an earlier, superseded session id.
fn remove_stored_attachment_paths_at(root: &Path, paths: &[String]) {
    let Ok(canonical_root) = std::fs::canonicalize(root) else {
        return;
    };
    let mut dirs = HashSet::new();
    for stored in paths {
        let Some(parent) = Path::new(stored).parent() else {
            continue;
        };
        let Ok(canonical_parent) = std::fs::canonicalize(parent) else {
            continue;
        };
        // attachment_put writes exactly root/session/file. Refuse nested paths,
        // siblings, and symlinks that resolve outside the real app-data root.
        if canonical_parent.parent() == Some(canonical_root.as_path()) {
            dirs.insert(canonical_parent);
        }
    }
    for dir in dirs {
        let _ = std::fs::remove_dir_all(dir);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_known_image_types_get_an_extension() {
        assert_eq!(extension_for("image/png"), Some("png"));
        assert_eq!(extension_for("image/jpeg"), Some("jpg"));
        // Not derived from the string: a made-up type has no extension at all.
        assert_eq!(extension_for("image/../../etc"), None);
        assert_eq!(extension_for("text/plain"), None);
        assert_eq!(extension_for(""), None);
    }

    /// The check that stops an id from being a path.
    #[test]
    fn path_traversal_is_rejected_as_a_component() {
        assert!(safe_component("att-abc-123", "id").is_ok());
        assert!(safe_component("s1", "id").is_ok());
        for bad in ["../etc", "a/b", "..", "", "a b", "a.b", "a\0b"] {
            assert!(
                safe_component(bad, "id").is_err(),
                "{bad:?} should be rejected"
            );
        }
    }

    #[test]
    fn an_over_long_component_is_rejected() {
        assert!(safe_component(&"a".repeat(128), "id").is_ok());
        assert!(safe_component(&"a".repeat(129), "id").is_err());
    }

    #[test]
    fn stored_paths_remove_only_their_confined_direct_owner_directory() {
        let base = std::env::temp_dir().join(format!(
            "vterminal-attachment-cleanup-{}",
            uuid::Uuid::new_v4()
        ));
        let root = base.join("attachments");
        let source = root.join("source");
        let nested = root.join("nested").join("not-a-session");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::create_dir_all(&nested).unwrap();
        let image = source.join("image.png");
        let refused = nested.join("image.png");
        std::fs::write(&image, b"image").unwrap();
        std::fs::write(&refused, b"keep").unwrap();

        remove_stored_attachment_paths_at(
            &root,
            &[
                image.to_string_lossy().into_owned(),
                refused.to_string_lossy().into_owned(),
            ],
        );
        assert!(!source.exists());
        assert!(refused.exists());

        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn chat_cleanup_preserves_shared_siblings_until_the_last_owner() {
        let base = std::env::temp_dir().join(format!(
            "vterminal-chat-attachment-cleanup-{}",
            uuid::Uuid::new_v4()
        ));
        let root = base.join("attachments");
        let owner = root.join("chat-a");
        std::fs::create_dir_all(&owner).unwrap();
        let unique = owner.join("unique.png");
        let shared = owner.join("shared.png");
        std::fs::write(&unique, b"unique").unwrap();
        std::fs::write(&shared, b"shared").unwrap();

        remove_chat_attachment_paths_at(&root, &[unique.to_string_lossy().into_owned()]);
        assert!(!unique.exists());
        assert!(shared.exists());
        assert!(owner.exists());

        remove_chat_attachment_paths_at(&root, &[shared.to_string_lossy().into_owned()]);
        assert!(!shared.exists());
        assert!(!owner.exists());

        let _ = std::fs::remove_dir_all(base);
    }
}
