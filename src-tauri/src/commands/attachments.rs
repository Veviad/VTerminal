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

/// Drop a session's attachment directory.
///
/// The DB rows go with the session through `ON DELETE CASCADE`; files do not, so
/// this is called from the same places that delete or prune an archived session.
/// Best-effort: a session whose files are already gone is not an error, and a
/// failure here must never fail the delete the user asked for.
pub fn remove_session_attachments(app: &AppHandle<Wry>, session_id: &str) {
    if let Ok(dir) = session_dir(app, session_id) {
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
}
