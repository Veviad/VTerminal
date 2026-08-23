//! Durable terminal-independent Chat workspace threads.
//!
//! Unlike the terminal archive, these rows are live application state: active
//! and archived threads share one table, are never retention-pruned, and are
//! removed only by an explicit delete.

use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};

use crate::knowledge::KnowledgeBucketRef;
use crate::provider::{ChatMessage, WebCitation};

#[derive(Debug, Clone, Serialize)]
pub struct ChatSummary {
    pub id: String,
    pub title: String,
    pub title_source: String,
    pub created_at: String,
    pub updated_at: String,
    pub archived_at: Option<String>,
    pub message_count: i64,
    pub first_prompt: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatAttachment {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub media_type: String,
    pub bytes: i64,
    pub path: Option<String>,
    pub width: Option<i64>,
    pub height: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ChatDisplayMessage {
    pub id: String,
    pub sort_order: i64,
    pub role: String,
    pub content: String,
    pub thinking: Option<String>,
    pub model: Option<String>,
    pub prompt_tokens: Option<i64>,
    pub completion_tokens: Option<i64>,
    pub citations: Vec<WebCitation>,
    pub attachments: Vec<ChatAttachment>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ChatDetail {
    pub summary: ChatSummary,
    pub messages: Vec<ChatDisplayMessage>,
    pub model_transcript: Vec<ChatMessage>,
    pub model_transcript_version: i64,
    pub attached_bucket_refs: Vec<KnowledgeBucketRef>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ChatMessageInput {
    pub id: String,
    pub role: String,
    pub content: String,
    pub thinking: Option<String>,
    pub model: Option<String>,
    pub prompt_tokens: Option<i64>,
    pub completion_tokens: Option<i64>,
    #[serde(default)]
    pub citations: Vec<WebCitation>,
    #[serde(default)]
    pub attachments: Vec<ChatAttachment>,
    pub created_at: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ChatSaveInput {
    pub id: String,
    pub title: String,
    pub title_source: String,
    pub created_at: String,
    pub updated_at: String,
    pub archived_at: Option<String>,
    #[serde(default)]
    pub messages: Vec<ChatMessageInput>,
    #[serde(default)]
    pub model_transcript: Vec<ChatMessage>,
    #[serde(default = "transcript_v1")]
    pub model_transcript_version: i64,
    #[serde(default)]
    pub attached_bucket_refs: Vec<KnowledgeBucketRef>,
}

fn transcript_v1() -> i64 {
    1
}

#[derive(Debug)]
pub struct ChatRemoval {
    pub attachment_paths: Vec<String>,
}

const SUMMARY_COLS: &str = "t.id, t.title, t.title_source, t.created_at, t.updated_at, \
    t.archived_at, (SELECT COUNT(*) FROM chat_messages m WHERE m.chat_id = t.id), \
    (SELECT substr(m.content, 1, 240) FROM chat_messages m \
       WHERE m.chat_id = t.id AND m.role = 'user' AND m.content <> '' \
       ORDER BY m.sort_order LIMIT 1)";

fn summary(row: &rusqlite::Row<'_>) -> rusqlite::Result<ChatSummary> {
    Ok(ChatSummary {
        id: row.get(0)?,
        title: row.get(1)?,
        title_source: row.get(2)?,
        created_at: row.get(3)?,
        updated_at: row.get(4)?,
        archived_at: row.get(5)?,
        message_count: row.get(6)?,
        first_prompt: row.get(7)?,
    })
}

pub fn list(conn: &Connection) -> Result<Vec<ChatSummary>, String> {
    let sql = format!(
        "SELECT {SUMMARY_COLS} FROM chat_threads t \
         ORDER BY (t.archived_at IS NOT NULL) ASC, t.updated_at DESC, t.id DESC"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], summary)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

fn json_or_default<T: serde::de::DeserializeOwned + Default>(raw: Option<String>) -> T {
    raw.and_then(|value| serde_json::from_str(&value).ok())
        .unwrap_or_default()
}

pub fn get(conn: &Connection, id: &str) -> Result<Option<ChatDetail>, String> {
    let sql = format!("SELECT {SUMMARY_COLS} FROM chat_threads t WHERE t.id = ?1");
    let found = conn
        .query_row(&sql, params![id], summary)
        .optional()
        .map_err(|e| e.to_string())?;
    let Some(found) = found else { return Ok(None) };

    let (transcript, transcript_version, buckets): (Option<String>, i64, String) = conn
        .query_row(
            "SELECT model_transcript, transcript_version, attached_bucket_refs \
             FROM chat_threads WHERE id = ?1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(|e| e.to_string())?;

    let mut message_stmt = conn
        .prepare(
            "SELECT id, sort_order, role, content, thinking, model, prompt_tokens, \
                    completion_tokens, citations, created_at \
               FROM chat_messages WHERE chat_id = ?1 ORDER BY sort_order",
        )
        .map_err(|e| e.to_string())?;
    let rows = message_stmt
        .query_map(params![id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, Option<i64>>(6)?,
                row.get::<_, Option<i64>>(7)?,
                row.get::<_, String>(8)?,
                row.get::<_, String>(9)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    let mut attachment_stmt = conn
        .prepare(
            "SELECT id, kind, name, media_type, bytes, path, width, height \
               FROM chat_attachments WHERE message_id = ?1 ORDER BY sort_order",
        )
        .map_err(|e| e.to_string())?;
    let mut messages = Vec::with_capacity(rows.len());
    for row in rows {
        let attachments = attachment_stmt
            .query_map(params![&row.0], |attachment| {
                Ok(ChatAttachment {
                    id: attachment.get(0)?,
                    kind: attachment.get(1)?,
                    name: attachment.get(2)?,
                    media_type: attachment.get(3)?,
                    bytes: attachment.get(4)?,
                    path: attachment.get(5)?,
                    width: attachment.get(6)?,
                    height: attachment.get(7)?,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        messages.push(ChatDisplayMessage {
            id: row.0,
            sort_order: row.1,
            role: row.2,
            content: row.3,
            thinking: row.4,
            model: row.5,
            prompt_tokens: row.6,
            completion_tokens: row.7,
            citations: serde_json::from_str(&row.8).unwrap_or_default(),
            attachments,
            created_at: row.9,
        });
    }

    Ok(Some(ChatDetail {
        summary: found,
        messages,
        model_transcript: json_or_default(transcript),
        model_transcript_version: transcript_version,
        attached_bucket_refs: serde_json::from_str(&buckets).unwrap_or_default(),
    }))
}

fn validate(input: &ChatSaveInput) -> Result<(), String> {
    if input.id.trim().is_empty() {
        return Err("chat id is empty".into());
    }
    if !["placeholder", "fallback", "generated", "manual"].contains(&input.title_source.as_str()) {
        return Err("invalid chat title source".into());
    }
    if input.messages.len() > 2_000 {
        return Err("chat has too many messages".into());
    }
    if input.model_transcript_version < 1 {
        return Err("invalid chat transcript version".into());
    }
    for message in &input.messages {
        if !["user", "assistant"].contains(&message.role.as_str()) {
            return Err("invalid chat message role".into());
        }
        if message.attachments.len() > 24 {
            return Err("chat message has too many attachments".into());
        }
        for attachment in &message.attachments {
            if !["image", "text"].contains(&attachment.kind.as_str()) {
                return Err("invalid chat attachment kind".into());
            }
        }
    }
    Ok(())
}

fn replace_messages(tx: &Transaction<'_>, input: &ChatSaveInput) -> Result<(), String> {
    tx.execute(
        "DELETE FROM chat_messages WHERE chat_id = ?1",
        params![input.id],
    )
    .map_err(|e| format!("clear chat messages: {e}"))?;
    for (index, message) in input.messages.iter().enumerate() {
        let citations = serde_json::to_string(&message.citations).map_err(|e| e.to_string())?;
        tx.execute(
            "INSERT INTO chat_messages \
               (id, chat_id, sort_order, role, content, thinking, model, prompt_tokens, \
                completion_tokens, citations, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                message.id,
                input.id,
                index as i64,
                message.role,
                message.content,
                message.thinking,
                message.model,
                message.prompt_tokens,
                message.completion_tokens,
                citations,
                message.created_at,
            ],
        )
        .map_err(|e| format!("insert chat message {index}: {e}"))?;
        for (attachment_index, attachment) in message.attachments.iter().enumerate() {
            tx.execute(
                "INSERT INTO chat_attachments \
                   (id, message_id, sort_order, kind, name, media_type, bytes, path, width, height) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![
                    attachment.id,
                    message.id,
                    attachment_index as i64,
                    attachment.kind,
                    attachment.name,
                    attachment.media_type,
                    attachment.bytes,
                    attachment.path,
                    attachment.width,
                    attachment.height,
                ],
            )
            .map_err(|e| format!("insert chat attachment {attachment_index}: {e}"))?;
        }
    }
    Ok(())
}

pub fn save(conn: &mut Connection, input: &ChatSaveInput) -> Result<(), String> {
    validate(input)?;
    let transcript = serde_json::to_string(&input.model_transcript).map_err(|e| e.to_string())?;
    let buckets = serde_json::to_string(&input.attached_bucket_refs).map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO chat_threads \
           (id, title, title_source, created_at, updated_at, archived_at, \
            attached_bucket_refs, model_transcript, transcript_version) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9) \
         ON CONFLICT(id) DO UPDATE SET \
           title=CASE WHEN chat_threads.title_source='manual' AND excluded.title_source<>'manual' \
                      THEN chat_threads.title ELSE excluded.title END, \
           title_source=CASE WHEN chat_threads.title_source='manual' AND excluded.title_source<>'manual' \
                             THEN chat_threads.title_source ELSE excluded.title_source END, \
           updated_at=MAX(chat_threads.updated_at, excluded.updated_at), \
           archived_at=excluded.archived_at, \
           attached_bucket_refs=excluded.attached_bucket_refs, \
           model_transcript=excluded.model_transcript, \
           transcript_version=excluded.transcript_version",
        params![
            input.id,
            input.title,
            input.title_source,
            input.created_at,
            input.updated_at,
            input.archived_at,
            buckets,
            transcript,
            input.model_transcript_version,
        ],
    )
    .map_err(|e| format!("save chat thread: {e}"))?;
    replace_messages(&tx, input)?;
    tx.commit().map_err(|e| e.to_string())
}

pub fn set_archived(conn: &Connection, id: &str, archived_at: Option<&str>) -> Result<(), String> {
    let changed = conn
        .execute(
            "UPDATE chat_threads SET archived_at = ?2, updated_at = ?3 \
             WHERE id = ?1",
            params![id, archived_at, chrono::Utc::now().to_rfc3339()],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err("chat no longer exists".into());
    }
    Ok(())
}

pub fn update_title(
    conn: &Connection,
    id: &str,
    title: &str,
    source: &str,
    expected_title: Option<&str>,
) -> Result<bool, String> {
    if !["fallback", "generated", "manual"].contains(&source) {
        return Err("invalid chat title source".into());
    }
    let title = title.trim();
    if title.is_empty() || title.chars().count() > 80 {
        return Err("chat title must contain 1-80 characters".into());
    }
    let changed = if let Some(expected) = expected_title {
        conn.execute(
            "UPDATE chat_threads SET title = ?2, title_source = ?3, updated_at = ?4 \
             WHERE id = ?1 AND title = ?5 AND (?3 = 'manual' OR title_source <> 'manual')",
            params![id, title, source, chrono::Utc::now().to_rfc3339(), expected],
        )
    } else {
        conn.execute(
            "UPDATE chat_threads SET title = ?2, title_source = ?3, updated_at = ?4 WHERE id = ?1",
            params![id, title, source, chrono::Utc::now().to_rfc3339()],
        )
    }
    .map_err(|e| e.to_string())?;
    Ok(changed > 0)
}

pub fn delete(conn: &mut Connection, id: &str) -> Result<ChatRemoval, String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let mut stmt = tx
        .prepare(
            "SELECT DISTINCT owned.path \
             FROM chat_attachments owned \
             JOIN chat_messages owned_message ON owned_message.id = owned.message_id \
             WHERE owned_message.chat_id = ?1 AND owned.path IS NOT NULL \
               AND NOT EXISTS ( \
                 SELECT 1 FROM chat_attachments other \
                 JOIN chat_messages other_message ON other_message.id = other.message_id \
                 WHERE other.path = owned.path AND other_message.chat_id <> ?1 \
               )",
        )
        .map_err(|e| e.to_string())?;
    let paths = stmt
        .query_map(params![id], |row| row.get(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<String>, _>>()
        .map_err(|e| e.to_string())?;
    drop(stmt);
    tx.execute("DELETE FROM chat_threads WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(ChatRemoval {
        attachment_paths: paths,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        crate::database::migrations::run(&conn).unwrap();
        conn
    }

    fn input(id: &str, content: &str) -> ChatSaveInput {
        ChatSaveInput {
            id: id.into(),
            title: "Test chat".into(),
            title_source: "fallback".into(),
            created_at: "2026-08-23T10:00:00Z".into(),
            updated_at: "2026-08-23T10:00:00Z".into(),
            archived_at: None,
            messages: vec![ChatMessageInput {
                id: format!("message-{id}"),
                role: "user".into(),
                content: content.into(),
                thinking: None,
                model: None,
                prompt_tokens: None,
                completion_tokens: None,
                citations: vec![],
                attachments: vec![],
                created_at: "2026-08-23T10:00:00Z".into(),
            }],
            model_transcript: vec![],
            model_transcript_version: 1,
            attached_bucket_refs: vec![],
        }
    }

    #[test]
    fn round_trip_and_archive_are_independent_of_terminal_retention() {
        let mut conn = db();
        save(&mut conn, &input("chat-a", "first prompt")).unwrap();
        let detail = get(&conn, "chat-a").unwrap().unwrap();
        assert_eq!(detail.messages[0].content, "first prompt");
        set_archived(&conn, "chat-a", Some("2026-08-23T11:00:00Z")).unwrap();
        assert!(list(&conn).unwrap()[0].archived_at.is_some());

        crate::database::archive::prune(
            &conn,
            crate::database::archive::Retention {
                max_sessions: 0,
                max_age_days: 1,
            },
        )
        .unwrap();
        assert!(get(&conn, "chat-a").unwrap().is_some());
    }

    #[test]
    fn replacing_and_deleting_cascades_messages() {
        let mut conn = db();
        save(&mut conn, &input("chat-a", "first")).unwrap();
        save(&mut conn, &input("chat-a", "replacement")).unwrap();
        assert_eq!(get(&conn, "chat-a").unwrap().unwrap().messages.len(), 1);
        delete(&mut conn, "chat-a").unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM chat_messages", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn shared_attachment_directory_waits_for_the_last_owner() {
        let mut conn = db();
        let path = "/app/attachments/original/image.png";
        for chat_id in ["chat-a", "chat-b"] {
            let mut value = input(chat_id, "image");
            value.messages[0].attachments.push(ChatAttachment {
                id: format!("attachment-{chat_id}"),
                kind: "image".into(),
                name: "image.png".into(),
                media_type: "image/png".into(),
                bytes: 10,
                path: Some(path.into()),
                width: Some(10),
                height: Some(10),
            });
            save(&mut conn, &value).unwrap();
        }

        let first = delete(&mut conn, "chat-a").unwrap();
        assert!(first.attachment_paths.is_empty());
        let last = delete(&mut conn, "chat-b").unwrap();
        assert_eq!(last.attachment_paths, vec![path]);
    }

    #[test]
    fn mixed_shared_and_unshared_attachments_are_filtered_individually() {
        let mut conn = db();
        let shared = "/app/attachments/chat-a/shared.png";
        let unique = "/app/attachments/chat-a/unique.png";
        let mut first = input("chat-a", "two images");
        for (suffix, path) in [("shared", shared), ("unique", unique)] {
            first.messages[0].attachments.push(ChatAttachment {
                id: format!("attachment-{suffix}"),
                kind: "image".into(),
                name: format!("{suffix}.png"),
                media_type: "image/png".into(),
                bytes: 10,
                path: Some(path.into()),
                width: Some(10),
                height: Some(10),
            });
        }
        save(&mut conn, &first).unwrap();
        let mut second = input("chat-b", "shared image");
        second.messages[0].attachments.push(ChatAttachment {
            id: "attachment-shared-copy".into(),
            kind: "image".into(),
            name: "shared.png".into(),
            media_type: "image/png".into(),
            bytes: 10,
            path: Some(shared.into()),
            width: Some(10),
            height: Some(10),
        });
        save(&mut conn, &second).unwrap();

        let first_removal = delete(&mut conn, "chat-a").unwrap();
        assert_eq!(first_removal.attachment_paths, vec![unique]);
        let second_removal = delete(&mut conn, "chat-b").unwrap();
        assert_eq!(second_removal.attachment_paths, vec![shared]);
    }

    #[test]
    fn generated_title_cannot_overwrite_a_manual_rename() {
        let mut conn = db();
        save(&mut conn, &input("chat-a", "question")).unwrap();
        assert!(update_title(&conn, "chat-a", "My title", "manual", None).unwrap());
        // A response checkpoint captured before the rename still carries the
        // fallback title. Saving it must not roll the manual edit back.
        save(&mut conn, &input("chat-a", "question plus checkpoint")).unwrap();
        assert!(!update_title(
            &conn,
            "chat-a",
            "Late generated title",
            "generated",
            Some("My title"),
        )
        .unwrap());
        let detail = get(&conn, "chat-a").unwrap().unwrap();
        assert_eq!(detail.summary.title, "My title");
        assert_eq!(detail.summary.title_source, "manual");
    }
}
