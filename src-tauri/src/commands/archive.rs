//! Session archive commands.
//!
//! Split the same way the restore commands are (`commands/workspace.rs`): the
//! list must be small and instant, so the scrollback blob and the model
//! transcript are SEPARATE lazy commands fetched only for the row actually being
//! reopened. Opening the browser deserializes metadata and nothing else.

use tauri::{State, Wry};

use crate::commands::settings;
use crate::database::{archive, DbState};
use crate::provider::ChatMessage;

/// Matches `history_recent`'s ceiling. The retention limit tops out at 1000, but
/// a list that long is a scrolling problem, not a browsing one.
const MAX_LIST: u32 = 200;

/// Beyond this a quit-time batch is a serialization storm — the same reasoning
/// (and the same number) as `MAX_TABS_PERSISTED`.
const MAX_BATCH: usize = 24;

pub(crate) fn retention(app: &tauri::AppHandle<Wry>) -> archive::Retention {
    archive::Retention {
        max_sessions: settings::read_u32(app, "archive_max_sessions", 50).min(1000),
        max_age_days: settings::read_u32(app, "archive_max_age_days", 30).clamp(1, 3650),
    }
}

/// Is the archive allowed to accept new writes?
///
/// Gated on `restore_sessions_on_start` as well as its own toggle, and for the
/// same reason `workspace_snapshot` is: the archive is a SECOND on-disk copy of
/// captured terminal output, so turning session restore off has to stop it
/// growing immediately, not at the next launch.
fn writes_allowed(app: &tauri::AppHandle<Wry>) -> bool {
    settings::read_bool(app, "restore_sessions_on_start", true)
        && settings::read_bool(app, "archive_enabled", true)
}

#[tauri::command]
pub fn archive_list(
    db: State<'_, DbState>,
    limit: u32,
    offset: u32,
) -> Result<Vec<archive::ArchiveSummary>, String> {
    let conn = db.0.lock().map_err(|_| "db poisoned")?;
    archive::list(&conn, limit.clamp(1, MAX_LIST), offset)
}

#[tauri::command]
pub fn archive_get(
    db: State<'_, DbState>,
    session_id: String,
) -> Result<Option<archive::ArchiveDetail>, String> {
    let conn = db.0.lock().map_err(|_| "db poisoned")?;
    archive::get(&conn, &session_id)
}

#[tauri::command]
pub fn archive_scrollback(
    db: State<'_, DbState>,
    session_id: String,
) -> Result<Option<String>, String> {
    let conn = db.0.lock().map_err(|_| "db poisoned")?;
    archive::scrollback(&conn, &session_id)
}

/// The model's own transcript, to hand straight back to `agent_start`.
///
/// The frontend must treat this array as OPAQUE: never reorder it, never edit a
/// `content`, and above all never drop an element — dropping an assistant turn
/// that carries `tool_calls` orphans its tool result, which Anthropic answers
/// with a 400. All trimming happens in Rust.
#[tauri::command]
pub fn archive_transcript(
    db: State<'_, DbState>,
    session_id: String,
) -> Result<Vec<ChatMessage>, String> {
    let conn = db.0.lock().map_err(|_| "db poisoned")?;
    archive::transcript(&conn, &session_id)
}

#[tauri::command]
pub fn archive_put(
    app: tauri::AppHandle<Wry>,
    db: State<'_, DbState>,
    session: archive::ArchiveSessionInput,
) -> Result<(), String> {
    archive_put_many(app, db, vec![session])
}

#[tauri::command]
pub fn archive_put_many(
    app: tauri::AppHandle<Wry>,
    db: State<'_, DbState>,
    sessions: Vec<archive::ArchiveSessionInput>,
) -> Result<(), String> {
    if !writes_allowed(&app) {
        return Ok(());
    }
    let mut sessions = sessions;
    sessions.truncate(MAX_BATCH);
    if settings::read_u32(&app, "restore_scrollback_lines", 1000) == 0 {
        // Scrollback capture is off. Drop any payload rather than trusting the
        // frontend to have checked, and blank what is already stored — the same
        // belt-and-braces as workspace_snapshot.
        for s in &mut sessions {
            s.scrollback = Some(String::new());
            s.scrollback_lines = Some(0);
        }
    }
    let retention = retention(&app);
    let removed = {
        let mut conn = db.0.lock().map_err(|_| "db poisoned")?;
        archive::put_many(&mut conn, &sessions, retention)?
    };
    remove_archived_attachments(&app, removed);
    Ok(())
}

pub(crate) fn remove_archived_attachments(
    app: &tauri::AppHandle<Wry>,
    removed: Vec<archive::ArchiveRemoval>,
) {
    for removal in removed {
        crate::commands::attachments::remove_archive_attachments(
            app,
            &removal.session_id,
            removal.remove_session_dir,
            &removal.attachment_paths,
        );
    }
}

// Each of the three removal paths below also drops the session's attachment
// FILES. `ON DELETE CASCADE` clears the `archived_attachments` rows, but the bytes
// live under <app_data>/attachments/ — nothing in SQLite can reach them, so a
// missing call here is a permanent disk leak rather than a visible bug.
// Best-effort by design: failing the user's delete because a file was already gone
// would be worse than the leak.

#[tauri::command]
pub fn archive_delete(
    app: tauri::AppHandle<Wry>,
    db: State<'_, DbState>,
    session_id: String,
) -> Result<(), String> {
    let removed = {
        let conn = db.0.lock().map_err(|_| "db poisoned")?;
        archive::delete(&conn, &session_id)?
    };
    remove_archived_attachments(&app, vec![removed]);
    Ok(())
}

#[tauri::command]
pub fn archive_clear(app: tauri::AppHandle<Wry>, db: State<'_, DbState>) -> Result<(), String> {
    {
        let conn = db.0.lock().map_err(|_| "db poisoned")?;
        archive::clear(&conn)?;
    }
    // Everything went, so the whole tree goes rather than one dir per session.
    if let Ok(root) = crate::commands::attachments::attachments_root(&app) {
        let _ = std::fs::remove_dir_all(root);
    }
    Ok(())
}

/// Returns how many rows went, so Settings can say what it removed.
#[tauri::command]
pub fn archive_prune(app: tauri::AppHandle<Wry>, db: State<'_, DbState>) -> Result<u32, String> {
    let retention = retention(&app);
    let removed = {
        let conn = db.0.lock().map_err(|_| "db poisoned")?;
        archive::prune(&conn, retention)?
    };
    let count = removed.len() as u32;
    remove_archived_attachments(&app, removed);
    Ok(count)
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;

    use super::archive;
    use crate::commands::attachments::remove_archive_attachments_at;
    use crate::database::workspace;

    const KEEP_ALL: archive::Retention = archive::Retention {
        max_sessions: 100,
        max_age_days: 3650,
    };

    fn mem() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        crate::database::migrations::run(&conn).unwrap();
        conn
    }

    fn row(
        session_id: &str,
        path: &std::path::Path,
        is_open: bool,
        supersedes: Option<&str>,
    ) -> archive::ArchiveSessionInput {
        archive::ArchiveSessionInput {
            session_id: session_id.into(),
            title: session_id.into(),
            shell: "/bin/zsh".into(),
            cwd: None,
            host_id: None,
            remote_kind: None,
            remote_target: None,
            cols: 80,
            rows: 24,
            script_version: None,
            scrollback: None,
            scrollback_lines: None,
            opened_at: "2026-08-01T00:00:00Z".into(),
            is_open,
            close_reason: (!is_open).then(|| "closed".into()),
            messages: Some(vec![archive::ArchiveMessageInput {
                role: "user".into(),
                kind: None,
                content: "image".into(),
                thinking: None,
                command: None,
                attachments: Some(vec![archive::ArchiveAttachmentInput {
                    kind: "image".into(),
                    name: "image.png".into(),
                    media_type: "image/png".into(),
                    bytes: 5,
                    path: Some(path.to_string_lossy().into_owned()),
                    width: Some(1),
                    height: Some(1),
                }]),
                created_at: "2026-08-01T00:00:00Z".into(),
            }]),
            model_transcript: None,
            model: None,
            supersedes: supersedes.map(str::to_string),
        }
    }

    fn source_image() -> (std::path::PathBuf, std::path::PathBuf, std::path::PathBuf) {
        let base = std::env::temp_dir().join(format!(
            "vterminal-supersede-cleanup-{}",
            uuid::Uuid::new_v4()
        ));
        let root = base.join("attachments");
        let source_dir = root.join("source");
        std::fs::create_dir_all(&source_dir).unwrap();
        let image = source_dir.join("image.png");
        std::fs::write(&image, b"image").unwrap();
        (base, root, image)
    }

    fn remove_at(root: &std::path::Path, removed: Vec<archive::ArchiveRemoval>) {
        for removal in removed {
            remove_archive_attachments_at(
                root,
                &removal.session_id,
                removal.remove_session_dir,
                &removal.attachment_paths,
            );
        }
    }

    #[test]
    fn pruning_a_closed_reopen_removes_the_superseded_source_image_bytes() {
        let (base, root, image) = source_image();
        let mut conn = mem();
        archive::put(&mut conn, &row("source", &image, false, None), KEEP_ALL).unwrap();
        archive::put(
            &mut conn,
            &row("replacement", &image, false, Some("source")),
            KEEP_ALL,
        )
        .unwrap();

        let removed = archive::prune(
            &conn,
            archive::Retention {
                max_sessions: 0,
                max_age_days: 3650,
            },
        )
        .unwrap();
        remove_at(&root, removed);
        assert!(!image.exists());
        assert!(!root.join("source").exists());

        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn deleting_one_of_two_reopens_keeps_the_shared_source_image_for_the_survivor() {
        let (base, root, image) = source_image();
        let mut conn = mem();
        archive::put(&mut conn, &row("source", &image, false, None), KEEP_ALL).unwrap();
        archive::put(
            &mut conn,
            &row("replacement-a", &image, false, Some("source")),
            KEEP_ALL,
        )
        .unwrap();
        archive::put(
            &mut conn,
            &row("replacement-b", &image, false, Some("source")),
            KEEP_ALL,
        )
        .unwrap();

        let first = archive::delete(&conn, "replacement-a").unwrap();
        assert!(first.attachment_paths.is_empty());
        remove_at(&root, vec![first]);
        assert!(
            image.exists(),
            "the second reopen still references the image"
        );

        let last = archive::delete(&conn, "replacement-b").unwrap();
        assert_eq!(
            last.attachment_paths,
            vec![image.to_string_lossy().into_owned()]
        );
        remove_at(&root, vec![last]);
        assert!(!image.exists());

        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn pruning_one_reopen_keeps_the_source_image_for_a_second_live_reopen() {
        let (base, root, image) = source_image();
        let mut conn = mem();
        archive::put(&mut conn, &row("source", &image, false, None), KEEP_ALL).unwrap();

        // Reopen the same archive twice. The frontend registers each replacement
        // as an open row before returning it to the session browser.
        archive::put(
            &mut conn,
            &row("replacement-a", &image, true, None),
            KEEP_ALL,
        )
        .unwrap();
        archive::put(
            &mut conn,
            &row("replacement-b", &image, true, None),
            KEEP_ALL,
        )
        .unwrap();

        // Closing the first replacement collapses the source row. Its filesystem
        // cleanup must still see both replacement rows as owners.
        let superseded = archive::put_many(
            &mut conn,
            &[row("replacement-a", &image, false, Some("source"))],
            KEEP_ALL,
        )
        .unwrap();
        remove_at(&root, superseded);
        assert!(image.exists());

        // Prune the closed replacement while the second reopen remains live.
        // The live row is excluded from pruning but must participate in attachment
        // ownership, or this cleanup deletes its source directory underneath it.
        let removed = archive::prune(
            &conn,
            archive::Retention {
                max_sessions: 0,
                max_age_days: 3650,
            },
        )
        .unwrap();
        assert_eq!(removed.len(), 1);
        assert_eq!(removed[0].session_id, "replacement-a");
        assert!(removed[0].attachment_paths.is_empty());
        remove_at(&root, removed);
        assert!(
            image.exists(),
            "the second live reopen still references the source image"
        );

        let last = archive::delete(&conn, "replacement-b").unwrap();
        remove_at(&root, vec![last]);
        assert!(!image.exists());

        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn a_removed_row_directory_survives_while_another_archive_references_it() {
        let base = std::env::temp_dir().join(format!(
            "vterminal-shared-owner-cleanup-{}",
            uuid::Uuid::new_v4()
        ));
        let root = base.join("attachments");
        let owner_dir = root.join("owner");
        std::fs::create_dir_all(&owner_dir).unwrap();
        let image = owner_dir.join("image.png");
        std::fs::write(&image, b"image").unwrap();

        let mut conn = mem();
        archive::put(&mut conn, &row("owner", &image, false, None), KEEP_ALL).unwrap();
        archive::put(&mut conn, &row("survivor", &image, false, None), KEEP_ALL).unwrap();

        let owner = archive::delete(&conn, "owner").unwrap();
        assert!(!owner.remove_session_dir);
        assert!(owner.attachment_paths.is_empty());
        remove_at(&root, vec![owner]);
        assert!(image.exists());

        let survivor = archive::delete(&conn, "survivor").unwrap();
        remove_at(&root, vec![survivor]);
        assert!(!image.exists());

        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn deleting_an_atomically_committed_reopen_removes_the_source_image_bytes() {
        let (base, root, image) = source_image();
        let mut conn = mem();
        archive::put(&mut conn, &row("source", &image, false, None), KEEP_ALL).unwrap();
        archive::put(
            &mut conn,
            &row("replacement", &image, true, Some("source")),
            KEEP_ALL,
        )
        .unwrap();
        workspace::commit_clean_exit(&mut conn, KEEP_ALL).unwrap();

        let removed = archive::delete(&conn, "replacement").unwrap();
        remove_at(&root, vec![removed]);
        assert!(!image.exists());
        assert!(!root.join("source").exists());

        let _ = std::fs::remove_dir_all(base);
    }
}
