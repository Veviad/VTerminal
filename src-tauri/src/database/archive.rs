//! The session archive: past sessions the user can browse and reopen.
//!
//! Design notes that are easy to get wrong later:
//!
//! * **This module never touches `session_snapshots` or `workspace_state`.**
//!   Session restore and the archive are two independent stores with two
//!   different lifetimes — restore keeps two generations and sweeps closed tabs,
//!   the archive keeps ended sessions until a retention limit bites. Sharing a
//!   table would mean an archive row could come back as a live tab.
//! * **The COALESCE contract, extended to three fields.** `snapshot()` in
//!   `workspace.rs` established that `scrollback: None` means "leave the stored
//!   blob alone". Here the same applies to `messages` and `model_transcript`,
//!   because the cheap turn-end tick sends only the transcript and the close
//!   path sends everything. A naive `DELETE FROM archived_messages` before every
//!   insert would let a blob-only write silently empty the conversation.
//! * **Two representations of one conversation, stored differently.** Neither is
//!   derivable from the other, so both are kept: the DISPLAY transcript as rows
//!   (the browser needs counts and a preview without pulling blobs) and the
//!   MODEL transcript as one opaque JSON column (round-tripped verbatim into the
//!   next `agent_start`, never queried).
//! * **Caps are enforced here, not in TypeScript.** A single command card allows
//!   131,072 chars in the store; a long agent session is megabytes. The frontend
//!   trimming what it sends is a courtesy, this is the guarantee.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::provider::ChatMessage;

/// Per display message. Generous — a long answer is legitimately long — but
/// bounded, because this is multiplied by MAX_MESSAGES.
const MAX_MESSAGE_CONTENT: usize = 16 * 1024;
/// Per command card. Tail-kept: the end of a command's output is what says
/// whether it worked.
const MAX_COMMAND_OUTPUT: usize = 8 * 1024;
/// Newest kept, in the spirit of MAX_BLOCKS_PER_SESSION on the frontend.
const MAX_MESSAGES: usize = 200;
/// The model transcript is already budget-trimmed by `agent/history.rs`; this is
/// the storage backstop.
const MAX_MODEL_TRANSCRIPT_BYTES: usize = 256 * 1024;
/// First-user-turn preview shown in the browser list.
const PREVIEW_CHARS: usize = 200;

/// Keep the last `n` chars on a CHAR boundary.
///
/// Byte slicing would panic on multibyte input — the same lesson `sanitize_title`
/// records. Terminal output routinely contains box-drawing characters and emoji.
fn tail(s: &str, max_chars: usize) -> String {
    let count = s.chars().count();
    if count <= max_chars {
        return s.to_string();
    }
    s.chars().skip(count - max_chars).collect()
}

/// Keep the first `n` chars on a char boundary.
fn head(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        return s.to_string();
    }
    s.chars().take(max_chars).collect()
}

// ---------- Output shapes ----------

/// One row of the browser list. Carries NO blobs: the scrollback and the model
/// transcript are separate lazy fetches, generalizing the `workspace_scrollback`
/// precedent. Opening the browser must not deserialize megabytes.
#[derive(Debug, Serialize)]
pub struct ArchiveSummary {
    pub session_id: String,
    pub title: String,
    pub shell: String,
    pub cwd: Option<String>,
    pub host_id: Option<String>,
    pub remote_kind: Option<String>,
    pub remote_target: Option<String>,
    pub opened_at: String,
    pub closed_at: String,
    pub close_reason: String,
    pub scrollback_lines: i64,
    pub message_count: i64,
    pub agent_command_count: i64,
    pub history_command_count: i64,
    pub model: String,
    /// So the browser can promise AI continuity without fetching the transcript.
    pub has_model_transcript: bool,
    /// First user turn, capped in SQL. A list whose rows all read "~/proj" is
    /// unnavigable; this is what makes the archive searchable by intent.
    pub first_prompt: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ArchivedCommand {
    pub command: String,
    pub output: String,
    pub exit_code: Option<i32>,
    pub status: String,
    pub note: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ArchivedMessage {
    pub id: String,
    pub sort_order: i64,
    pub role: String,
    pub kind: String,
    pub content: String,
    pub thinking: Option<String>,
    pub command: Option<ArchivedCommand>,
    pub attachments: Vec<ArchivedAttachment>,
    pub created_at: String,
}

/// What was attached to a turn: metadata plus a path, never the bytes. The panel
/// reads the file lazily through `attachment_read` when it draws the thumbnail.
#[derive(Debug, Serialize)]
pub struct ArchivedAttachment {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub media_type: String,
    pub bytes: i64,
    /// `None` when the disk write failed — the chip then renders by name.
    pub path: Option<String>,
    pub width: Option<i64>,
    pub height: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct ArchiveDetail {
    pub summary: ArchiveSummary,
    /// Display shape, `sort_order` ascending.
    pub messages: Vec<ArchivedMessage>,
}

// ---------- Input shapes ----------

#[derive(Debug, Deserialize)]
pub struct ArchiveCommandInput {
    pub command: String,
    pub output: String,
    pub exit_code: Option<i32>,
    pub status: String,
    pub note: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ArchiveMessageInput {
    // No `id`: frontend message ids ("msg-<ms>-<len>") are only unique within a
    // session, and this table's primary key is global. The writer derives
    // "<session_id>:<index>" instead, which is also what makes a rewrite
    // idempotent.
    pub role: String,
    #[serde(default)]
    pub kind: Option<String>,
    pub content: String,
    #[serde(default)]
    pub thinking: Option<String>,
    #[serde(default)]
    pub command: Option<ArchiveCommandInput>,
    /// Metadata for the chips. The bytes were written to disk by
    /// `attachment_put` at send time; only `path` comes back here.
    #[serde(default)]
    pub attachments: Option<Vec<ArchiveAttachmentInput>>,
    pub created_at: String,
}

#[derive(Debug, Deserialize)]
pub struct ArchiveAttachmentInput {
    pub kind: String,
    pub name: String,
    pub media_type: String,
    pub bytes: i64,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub width: Option<i64>,
    #[serde(default)]
    pub height: Option<i64>,
}

/// Field-for-field `SessionSnapshotInput` plus the archive-only fields, so the
/// frontend reuses `buildSnapshot()` and Rust has one input family.
#[derive(Debug, Deserialize)]
pub struct ArchiveSessionInput {
    pub session_id: String,
    pub title: String,
    pub shell: String,
    pub cwd: Option<String>,
    pub host_id: Option<String>,
    pub remote_kind: Option<String>,
    pub remote_target: Option<String>,
    pub cols: u16,
    pub rows: u16,
    pub script_version: Option<String>,
    /// `None` = "keep what is stored" — the snapshot's COALESCE contract.
    pub scrollback: Option<String>,
    pub scrollback_lines: Option<i64>,
    pub opened_at: String,
    /// true for the debounced turn-end tick, false for close/quit.
    #[serde(default)]
    pub is_open: bool,
    /// Ignored while `is_open`; validated against the CHECK otherwise.
    #[serde(default)]
    pub close_reason: Option<String>,
    /// `None` = keep the stored rows. `Some` = full replacement.
    #[serde(default)]
    pub messages: Option<Vec<ArchiveMessageInput>>,
    /// Typed rather than a raw string, so a malformed transcript fails at the
    /// IPC boundary instead of at the next `agent_start`.
    #[serde(default)]
    pub model_transcript: Option<Vec<ChatMessage>>,
    #[serde(default)]
    pub model: Option<String>,
    /// The archive row this session was reopened from. Deleted (CASCADE) inside
    /// this transaction, and its `opened_at` is inherited — otherwise
    /// reopen/close/reopen/close leaves a chain of near-duplicates that evicts
    /// genuinely distinct sessions out of the retention budget.
    #[serde(default)]
    pub supersedes: Option<String>,
}

/// Retention, resolved by the caller from settings so this module stays free of
/// `AppHandle`.
#[derive(Debug, Clone, Copy)]
pub struct Retention {
    pub max_sessions: u32,
    pub max_age_days: u32,
}

const SUMMARY_COLS: &str = "a.session_id, a.title, a.shell, a.cwd, a.host_id, a.remote_kind, \
     a.remote_target, a.opened_at, a.closed_at, a.close_reason, a.scrollback_lines, \
     a.message_count, a.agent_command_count, a.history_command_count, a.model, \
     (a.model_transcript IS NOT NULL AND a.model_transcript <> '')";

fn row_to_summary(row: &rusqlite::Row<'_>) -> rusqlite::Result<ArchiveSummary> {
    Ok(ArchiveSummary {
        session_id: row.get(0)?,
        title: row.get(1)?,
        shell: row.get(2)?,
        cwd: row.get(3)?,
        host_id: row.get(4)?,
        remote_kind: row.get(5)?,
        remote_target: row.get(6)?,
        opened_at: row.get(7)?,
        closed_at: row.get(8)?,
        close_reason: row.get(9)?,
        scrollback_lines: row.get(10)?,
        message_count: row.get(11)?,
        agent_command_count: row.get(12)?,
        history_command_count: row.get(13)?,
        model: row.get(14)?,
        has_model_transcript: row.get(15)?,
        first_prompt: row.get(16)?,
    })
}

/// The browser list. `is_open = 0` only: a live tab is not history.
pub fn list(conn: &Connection, limit: u32, offset: u32) -> Result<Vec<ArchiveSummary>, String> {
    let sql = format!(
        "SELECT {SUMMARY_COLS},
                (SELECT substr(m.content, 1, {PREVIEW_CHARS}) FROM archived_messages m
                  WHERE m.session_id = a.session_id AND m.role = 'user' AND m.content <> ''
                  ORDER BY m.sort_order LIMIT 1)
           FROM archived_sessions a
          WHERE a.is_open = 0
          ORDER BY a.closed_at DESC
          LIMIT ?1 OFFSET ?2"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![limit, offset], row_to_summary)
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

/// Metadata + the display transcript. Still no scrollback blob — that is
/// `scrollback()`, fetched only for the row actually being reopened.
pub fn get(conn: &Connection, session_id: &str) -> Result<Option<ArchiveDetail>, String> {
    let sql =
        format!("SELECT {SUMMARY_COLS}, NULL FROM archived_sessions a WHERE a.session_id = ?1");
    let summary = conn
        .query_row(&sql, params![session_id], row_to_summary)
        .optional()
        .map_err(|e| e.to_string())?;
    let Some(summary) = summary else {
        return Ok(None);
    };

    let mut stmt = conn
        .prepare(
            "SELECT id, sort_order, role, kind, content, thinking, cmd_command, cmd_output,
                    cmd_exit_code, cmd_status, cmd_note, created_at
               FROM archived_messages WHERE session_id = ?1 ORDER BY sort_order ASC",
        )
        .map_err(|e| e.to_string())?;
    let messages = stmt
        .query_map(params![session_id], |row| {
            let kind: String = row.get(3)?;
            let cmd_command: Option<String> = row.get(6)?;
            // A card is only a card if it has a command — a row whose kind says
            // 'command' but carries no command would render as an empty bubble.
            let command = match (kind.as_str(), cmd_command) {
                ("command", Some(c)) => Some(ArchivedCommand {
                    command: c,
                    output: row.get::<_, Option<String>>(7)?.unwrap_or_default(),
                    exit_code: row.get(8)?,
                    status: row
                        .get::<_, Option<String>>(9)?
                        .unwrap_or_else(|| "done".into()),
                    note: row.get(10)?,
                }),
                _ => None,
            };
            Ok(ArchivedMessage {
                id: row.get(0)?,
                sort_order: row.get(1)?,
                role: row.get(2)?,
                kind,
                content: row.get(4)?,
                thinking: row.get(5)?,
                command,
                attachments: Vec::new(),
                created_at: row.get(11)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    // One query for the whole session rather than one per message: a transcript
    // can hold MAX_MESSAGES rows and almost none of them have attachments.
    let mut messages = messages;
    let mut stmt = conn
        .prepare(
            "SELECT a.message_id, a.id, a.kind, a.name, a.media_type, a.bytes,
                    a.path, a.width, a.height
               FROM archived_attachments a
               JOIN archived_messages m ON m.id = a.message_id
              WHERE m.session_id = ?1
              ORDER BY a.message_id ASC, a.sort_order ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![session_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                ArchivedAttachment {
                    id: row.get(1)?,
                    kind: row.get(2)?,
                    name: row.get(3)?,
                    media_type: row.get(4)?,
                    bytes: row.get(5)?,
                    path: row.get(6)?,
                    width: row.get(7)?,
                    height: row.get(8)?,
                },
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    for (message_id, attachment) in rows {
        if let Some(m) = messages.iter_mut().find(|m| m.id == message_id) {
            m.attachments.push(attachment);
        }
    }

    Ok(Some(ArchiveDetail { summary, messages }))
}

/// Twin of `workspace::scrollback`.
pub fn scrollback(conn: &Connection, session_id: &str) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT scrollback FROM archived_sessions WHERE session_id = ?1",
        params![session_id],
        |r| r.get::<_, Option<String>>(0),
    )
    .optional()
    .map(|outer| outer.flatten())
    .map_err(|e| e.to_string())
}

/// The model's own transcript, ready to hand back to `agent_start`.
///
/// An unparseable column degrades to "no continuity" rather than erroring: one
/// bad row must not break the reopen path, and the display transcript — the part
/// the user can see — is stored separately and is unaffected.
pub fn transcript(conn: &Connection, session_id: &str) -> Result<Vec<ChatMessage>, String> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT model_transcript FROM archived_sessions WHERE session_id = ?1",
            params![session_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .flatten();
    let Some(raw) = raw.filter(|s| !s.is_empty()) else {
        return Ok(vec![]);
    };
    match serde_json::from_str::<Vec<ChatMessage>>(&raw) {
        Ok(messages) => Ok(messages),
        Err(e) => {
            log::warn!(
                "archived transcript for {session_id} is unreadable ({e}) — continuing without it"
            );
            Ok(vec![])
        }
    }
}

/// Single-session convenience. The real paths all go through `put_many` — even
/// `archive_put`, so there is exactly one write implementation.
#[cfg(test)]
pub fn put(
    conn: &mut Connection,
    input: &ArchiveSessionInput,
    retention: Retention,
) -> Result<(), String> {
    put_many(conn, std::slice::from_ref(input), retention)
}

/// Write many sessions in ONE transaction — the quit path archives every tab at
/// once, inside a 1.5s budget.
pub fn put_many(
    conn: &mut Connection,
    inputs: &[ArchiveSessionInput],
    retention: Retention,
) -> Result<(), String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let now = chrono::Utc::now().to_rfc3339();

    for input in inputs {
        // A superseded row's opened_at is the true start of this thread of work.
        let inherited_opened_at: Option<String> = match &input.supersedes {
            Some(old) if old != &input.session_id => tx
                .query_row(
                    "SELECT opened_at FROM archived_sessions WHERE session_id = ?1",
                    params![old],
                    |r| r.get(0),
                )
                .optional()
                .map_err(|e| e.to_string())?,
            _ => None,
        };
        let opened_at = inherited_opened_at.unwrap_or_else(|| input.opened_at.clone());

        // `is_open` rows are still live, so they have no meaningful close reason.
        let close_reason = if input.is_open {
            "closed".to_string()
        } else {
            match input.close_reason.as_deref() {
                Some(r @ ("closed" | "quit" | "crash")) => r.to_string(),
                _ => "closed".to_string(),
            }
        };

        let model_transcript = match &input.model_transcript {
            Some(messages) => {
                let json = serde_json::to_string(messages)
                    .map_err(|e| format!("serialize model transcript: {e}"))?;
                // Bytes, not chars: this is a storage bound, and the value is
                // dropped wholesale rather than truncated — half a JSON array
                // would fail to parse on the way back out, which is worse than
                // having no continuity at all.
                if json.len() > MAX_MODEL_TRANSCRIPT_BYTES {
                    log::warn!(
                        "model transcript for {} is {} bytes — storing no continuity for it",
                        input.session_id,
                        json.len()
                    );
                    Some(String::new())
                } else {
                    Some(json)
                }
            }
            None => None,
        };

        // Only recount when the caller actually sent messages; a metadata-only
        // tick must leave the stored counts alone.
        let counts = input.messages.as_ref().map(|messages| {
            let start = messages.len().saturating_sub(MAX_MESSAGES);
            let kept = &messages[start..];
            let commands = kept
                .iter()
                .filter(|m| m.kind.as_deref() == Some("command"))
                .count();
            (kept.len() as i64, commands as i64)
        });

        let history_commands: i64 = tx
            .query_row(
                "SELECT COUNT(*) FROM command_history WHERE session_id = ?1",
                params![input.session_id],
                |r| r.get(0),
            )
            .unwrap_or(0);

        tx.execute(
            "INSERT INTO archived_sessions
                (session_id, opened_at, closed_at, updated_at, is_open, close_reason,
                 title, shell, cwd, host_id, remote_kind, remote_target, cols, rows,
                 script_version, format_version, scrollback, scrollback_lines,
                 message_count, agent_command_count, history_command_count, model,
                 model_transcript, transcript_version)
             VALUES (?1, ?2, ?3, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, 1,
                     ?15, COALESCE(?16, 0), COALESCE(?17, 0), COALESCE(?18, 0), ?19,
                     COALESCE(?20, ''), ?21, 1)
             ON CONFLICT(session_id) DO UPDATE SET
                opened_at = excluded.opened_at,
                closed_at = excluded.closed_at,
                updated_at = excluded.updated_at,
                is_open = excluded.is_open,
                close_reason = excluded.close_reason,
                title = excluded.title,
                shell = excluded.shell,
                cwd = excluded.cwd,
                host_id = excluded.host_id,
                remote_kind = excluded.remote_kind,
                remote_target = excluded.remote_target,
                cols = excluded.cols,
                rows = excluded.rows,
                script_version = excluded.script_version,
                -- NULL means 'this write carried no blob' — keep what is stored.
                scrollback = COALESCE(?15, archived_sessions.scrollback),
                scrollback_lines = COALESCE(?16, archived_sessions.scrollback_lines),
                message_count = COALESCE(?17, archived_sessions.message_count),
                agent_command_count = COALESCE(?18, archived_sessions.agent_command_count),
                history_command_count = excluded.history_command_count,
                model = COALESCE(?20, archived_sessions.model),
                model_transcript = COALESCE(?21, archived_sessions.model_transcript)",
            params![
                input.session_id,
                opened_at,
                now,
                i64::from(input.is_open),
                close_reason,
                input.title,
                input.shell,
                input.cwd,
                input.host_id,
                input.remote_kind,
                input.remote_target,
                input.cols,
                input.rows,
                input.script_version,
                input.scrollback,
                input.scrollback_lines,
                counts.map(|c| c.0),
                counts.map(|c| c.1),
                history_commands,
                input.model,
                model_transcript,
            ],
        )
        .map_err(|e| format!("archive session {}: {e}", input.session_id))?;

        // Full replacement, and ONLY when messages were sent. The delete is
        // inside the same transaction as the inserts, so a failure cannot leave
        // a session with half a transcript.
        if let Some(messages) = &input.messages {
            tx.execute(
                "DELETE FROM archived_messages WHERE session_id = ?1",
                params![input.session_id],
            )
            .map_err(|e| e.to_string())?;

            let start = messages.len().saturating_sub(MAX_MESSAGES);
            for (i, m) in messages[start..].iter().enumerate() {
                // Unknown roles/kinds would violate the CHECK and abort the whole
                // transaction, taking the terminal's scrollback with them. Coerce
                // instead: a mislabelled message is worth less than the session.
                let role = if m.role == "user" {
                    "user"
                } else {
                    "assistant"
                };
                // clippy reads this as `m.kind.as_deref().unwrap_or("text")`, which
                // is NOT the same thing and would undo the coercion above: unwrap_or
                // passes ANY Some(..) through untouched, so an unrecognised kind
                // would reach the CHECK constraint and abort the transaction. The
                // arms are deliberately an allowlist, not a null-default.
                #[allow(clippy::manual_unwrap_or)]
                let kind = match m.kind.as_deref() {
                    Some(k @ ("command" | "compaction")) => k,
                    _ => "text",
                };
                let (cmd, out, exit, status, note) = match &m.command {
                    Some(c) => (
                        Some(head(&c.command, MAX_MESSAGE_CONTENT)),
                        Some(tail(&c.output, MAX_COMMAND_OUTPUT)),
                        c.exit_code,
                        Some(match c.status.as_str() {
                            s @ ("running" | "done" | "skipped" | "timeout" | "blocked") => s,
                            _ => "done",
                        }),
                        c.note.clone(),
                    ),
                    None => (None, None, None, None, None),
                };
                tx.execute(
                    "INSERT INTO archived_messages
                        (id, session_id, sort_order, role, kind, content, thinking,
                         cmd_command, cmd_output, cmd_exit_code, cmd_status, cmd_note, created_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
                    params![
                        // Message ids are only unique per session on the frontend
                        // ("msg-<ms>-<len>" can repeat across tabs), and this
                        // table's PK is global.
                        format!("{}:{}", input.session_id, i),
                        input.session_id,
                        i as i64,
                        role,
                        kind,
                        head(&m.content, MAX_MESSAGE_CONTENT),
                        m.thinking.as_deref().map(|t| head(t, MAX_MESSAGE_CONTENT)),
                        cmd,
                        out,
                        exit,
                        status,
                        note,
                        m.created_at,
                    ],
                )
                .map_err(|e| format!("archive message {i} of {}: {e}", input.session_id))?;

                // Chips for a reopened transcript. The DELETE above cascades the
                // old rows, so this is a full replacement like the messages are.
                for (j, a) in m.attachments.iter().flatten().enumerate() {
                    // Same coercion stance as `role`/`kind` above: an unknown kind
                    // would violate the CHECK and abort the whole transaction,
                    // taking the terminal's scrollback with it.
                    let kind = if a.kind == "image" { "image" } else { "text" };
                    tx.execute(
                        "INSERT INTO archived_attachments
                            (id, message_id, sort_order, kind, name, media_type, bytes,
                             path, width, height)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                        params![
                            format!("{}:{}:{}", input.session_id, i, j),
                            format!("{}:{}", input.session_id, i),
                            j as i64,
                            kind,
                            head(&a.name, 256),
                            head(&a.media_type, 64),
                            a.bytes,
                            a.path,
                            a.width,
                            a.height,
                        ],
                    )
                    .map_err(|e| format!("archive attachment {j} of message {i}: {e}"))?;
                }
            }
        }

        // Collapse the row this session was reopened from. CASCADE takes its
        // messages. A missing row is not an error: the same archive entry may
        // legitimately have been reopened into two tabs.
        if let Some(old) = &input.supersedes {
            if old != &input.session_id {
                tx.execute(
                    "DELETE FROM archived_sessions WHERE session_id = ?1",
                    params![old],
                )
                .map_err(|e| e.to_string())?;
            }
        }
    }

    prune_in(&tx, retention)?;
    tx.commit().map_err(|e| e.to_string())
}

/// Enforce both retention limits, reporting WHICH sessions went.
///
/// `is_open = 0` on both statements is mandatory: pruning an open row would delete
/// a live tab's transcript out from under it.
///
/// The ids are returned rather than a count because attachment BYTES live on disk,
/// outside SQLite — `ON DELETE CASCADE` clears the rows but cannot remove a file.
/// `RETURNING` keeps the retention predicate in exactly one place; a second query
/// that re-derived "which ones are about to go" would drift from this one and leak
/// files silently.
fn prune_in(conn: &Connection, retention: Retention) -> Result<Vec<String>, String> {
    let mut removed: Vec<String> = Vec::new();

    // NOT IN over a bounded subquery: rusqlite has no `array` feature here, and
    // this is one statement either way — the same reasoning as snapshot()'s
    // mark-and-sweep.
    let mut stmt = conn
        .prepare(
            "DELETE FROM archived_sessions
              WHERE is_open = 0
                AND session_id NOT IN (
                     SELECT session_id FROM archived_sessions
                      WHERE is_open = 0 ORDER BY closed_at DESC LIMIT ?1)
           RETURNING session_id",
        )
        .map_err(|e| e.to_string())?;
    let ids = stmt
        .query_map(params![retention.max_sessions], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    removed.extend(ids);
    drop(stmt);

    // Lexicographic compare is only correct because every writer in this file
    // uses `chrono::Utc::now().to_rfc3339()` — fixed-width and UTC. One
    // local-time write would break this silently.
    let cutoff = (chrono::Utc::now() - chrono::Duration::days(i64::from(retention.max_age_days)))
        .to_rfc3339();
    let mut stmt = conn
        .prepare(
            "DELETE FROM archived_sessions
              WHERE is_open = 0 AND closed_at < ?1
           RETURNING session_id",
        )
        .map_err(|e| e.to_string())?;
    let ids = stmt
        .query_map(params![cutoff], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    removed.extend(ids);

    Ok(removed)
}

/// Standalone prune, so lowering a limit in Settings takes effect immediately
/// rather than at the next archive write. Returns the sessions removed, so the
/// caller can drop their attachment files too.
pub fn prune(conn: &Connection, retention: Retention) -> Result<Vec<String>, String> {
    prune_in(conn, retention)
}

pub fn delete(conn: &Connection, session_id: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM archived_sessions WHERE session_id = ?1",
        params![session_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Unconditional, including `is_open = 1` rows: the user asked for the archive to
/// be empty. A live session's next turn-end tick simply recreates its open row.
pub fn clear(conn: &Connection) -> Result<(), String> {
    conn.execute("DELETE FROM archived_sessions", [])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Close out sessions that were still open when the app died.
///
/// This is what recovers an AI conversation after `kill -9` — the one thing
/// session restore cannot do, since it rebuilds terminals but has never known
/// anything about transcripts. Called once per boot.
pub fn reap_open_sessions(conn: &Connection) -> Result<u32, String> {
    let now = chrono::Utc::now().to_rfc3339();
    let n = conn
        .execute(
            "UPDATE archived_sessions
                SET is_open = 0, close_reason = 'crash', closed_at = ?1, updated_at = ?1
              WHERE is_open = 1",
            params![now],
        )
        .map_err(|e| e.to_string())?;
    Ok(n as u32)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::{Role, ToolCall};

    const KEEP_ALL: Retention = Retention {
        max_sessions: 100,
        max_age_days: 3650,
    };

    fn mem() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        crate::database::migrations::run(&conn).unwrap();
        conn
    }

    fn row(id: &str) -> ArchiveSessionInput {
        ArchiveSessionInput {
            session_id: id.into(),
            title: format!("tab {id}"),
            shell: "/bin/zsh".into(),
            cwd: Some("/tmp".into()),
            host_id: None,
            remote_kind: None,
            remote_target: None,
            cols: 120,
            rows: 40,
            script_version: Some("4".into()),
            scrollback: None,
            scrollback_lines: None,
            opened_at: "2026-08-01T00:00:00+00:00".into(),
            is_open: false,
            close_reason: Some("closed".into()),
            messages: None,
            model_transcript: None,
            model: None,
            supersedes: None,
        }
    }

    fn msg(i: usize, role: &str) -> ArchiveMessageInput {
        ArchiveMessageInput {
            role: role.into(),
            kind: None,
            content: format!("message {i}"),
            thinking: None,
            command: None,
            attachments: None,
            created_at: "2026-08-01T00:00:00+00:00".into(),
        }
    }

    fn card(i: usize) -> ArchiveMessageInput {
        ArchiveMessageInput {
            role: "assistant".into(),
            kind: Some("command".into()),
            content: String::new(),
            thinking: None,
            command: Some(ArchiveCommandInput {
                command: format!("ls -la /{i}"),
                output: format!("output {i}"),
                exit_code: Some(0),
                status: "done".into(),
                note: None,
            }),
            attachments: None,
            created_at: "2026-08-01T00:00:00+00:00".into(),
        }
    }

    /// Closing at a known instant, so ordering and age pruning are deterministic.
    fn closed_at(conn: &Connection, id: &str, when: &str) {
        conn.execute(
            "UPDATE archived_sessions SET closed_at = ?2 WHERE session_id = ?1",
            params![id, when],
        )
        .unwrap();
    }

    #[test]
    fn put_then_list_returns_the_summary_without_blobs() {
        let mut conn = mem();
        let mut r = row("a");
        r.scrollback = Some("PAYLOAD".into());
        r.scrollback_lines = Some(42);
        r.messages = Some(vec![msg(0, "user"), msg(1, "assistant"), card(2)]);
        r.model = Some("local/qwen3.5-9b".into());
        put(&mut conn, &r, KEEP_ALL).unwrap();

        let list = list(&conn, 50, 0).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].message_count, 3);
        assert_eq!(list[0].agent_command_count, 1);
        assert_eq!(list[0].scrollback_lines, 42);
        assert_eq!(list[0].model, "local/qwen3.5-9b");
        assert!(!list[0].has_model_transcript);
        // The preview skips the empty-content command card.
        assert_eq!(list[0].first_prompt.as_deref(), Some("message 0"));
        // The blob is reachable only through its own call.
        assert_eq!(scrollback(&conn, "a").unwrap().as_deref(), Some("PAYLOAD"));
    }

    #[test]
    fn a_transcript_only_write_preserves_the_stored_scrollback() {
        // The direct twin of workspace.rs's
        // `a_metadata_only_snapshot_preserves_the_stored_blob`: the turn-end tick
        // sends `scrollback: None` over and over.
        let mut conn = mem();
        let mut with_blob = row("a");
        with_blob.scrollback = Some("PAYLOAD".into());
        with_blob.scrollback_lines = Some(42);
        put(&mut conn, &with_blob, KEEP_ALL).unwrap();

        let mut tick = row("a");
        tick.is_open = true;
        tick.messages = Some(vec![msg(0, "user")]);
        put(&mut conn, &tick, KEEP_ALL).unwrap();

        assert_eq!(scrollback(&conn, "a").unwrap().as_deref(), Some("PAYLOAD"));
        let lines: i64 = conn
            .query_row("SELECT scrollback_lines FROM archived_sessions", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(lines, 42);
    }

    #[test]
    fn messages_omitted_means_keep_the_stored_transcript() {
        // The COALESCE contract extended to rows. An unconditional
        // delete-then-insert would fail this — and it is the failure that
        // silently empties every reopened conversation.
        let mut conn = mem();
        let mut with_messages = row("a");
        with_messages.messages = Some(vec![msg(0, "user"), msg(1, "assistant")]);
        put(&mut conn, &with_messages, KEEP_ALL).unwrap();

        let mut blob_only = row("a");
        blob_only.scrollback = Some("SCREEN".into());
        blob_only.scrollback_lines = Some(9);
        put(&mut conn, &blob_only, KEEP_ALL).unwrap();

        let detail = get(&conn, "a").unwrap().unwrap();
        assert_eq!(detail.messages.len(), 2);
        assert_eq!(detail.summary.message_count, 2);
    }

    #[test]
    fn a_second_write_replaces_the_message_rows_rather_than_appending() {
        let mut conn = mem();
        let mut first = row("a");
        first.messages = Some((0..3).map(|i| msg(i, "user")).collect());
        put(&mut conn, &first, KEEP_ALL).unwrap();

        let mut second = row("a");
        second.messages = Some((0..5).map(|i| msg(i, "user")).collect());
        put(&mut conn, &second, KEEP_ALL).unwrap();

        let detail = get(&conn, "a").unwrap().unwrap();
        assert_eq!(detail.messages.len(), 5);
        assert_eq!(detail.summary.message_count, 5);
        assert_eq!(
            detail
                .messages
                .iter()
                .map(|m| m.sort_order)
                .collect::<Vec<_>>(),
            vec![0, 1, 2, 3, 4]
        );
    }

    #[test]
    fn a_command_card_round_trips_with_its_exit_code_and_status() {
        let mut conn = mem();
        let mut r = row("a");
        r.messages = Some(vec![card(7)]);
        put(&mut conn, &r, KEEP_ALL).unwrap();

        let detail = get(&conn, "a").unwrap().unwrap();
        let cmd = detail.messages[0].command.as_ref().unwrap();
        assert_eq!(detail.messages[0].kind, "command");
        assert_eq!(cmd.command, "ls -la /7");
        assert_eq!(cmd.exit_code, Some(0));
        assert_eq!(cmd.status, "done");
    }

    #[test]
    fn deleting_a_session_cascades_to_its_messages() {
        // Pins both the FK and the `PRAGMA foreign_keys=ON` that the whole
        // delete/clear/prune/supersede story depends on.
        let mut conn = mem();
        let mut r = row("a");
        r.messages = Some(vec![msg(0, "user")]);
        put(&mut conn, &r, KEEP_ALL).unwrap();
        delete(&conn, "a").unwrap();

        let orphans: i64 = conn
            .query_row("SELECT COUNT(*) FROM archived_messages", [], |r| r.get(0))
            .unwrap();
        assert_eq!(orphans, 0);
        assert!(get(&conn, "a").unwrap().is_none());
    }

    #[test]
    fn clear_removes_every_session_and_message() {
        let mut conn = mem();
        for id in ["a", "b"] {
            let mut r = row(id);
            r.messages = Some(vec![msg(0, "user")]);
            put(&mut conn, &r, KEEP_ALL).unwrap();
        }
        clear(&conn).unwrap();
        assert!(list(&conn, 50, 0).unwrap().is_empty());
        let orphans: i64 = conn
            .query_row("SELECT COUNT(*) FROM archived_messages", [], |r| r.get(0))
            .unwrap();
        assert_eq!(orphans, 0);
    }

    #[test]
    fn prune_keeps_the_newest_n_by_closed_at() {
        let mut conn = mem();
        for (id, when) in [
            ("old", "2026-08-01"),
            ("mid", "2026-08-02"),
            ("new", "2026-08-03"),
        ] {
            put(&mut conn, &row(id), KEEP_ALL).unwrap();
            closed_at(&conn, id, &format!("{when}T00:00:00+00:00"));
        }
        let removed = prune(
            &conn,
            Retention {
                max_sessions: 2,
                max_age_days: 3650,
            },
        )
        .unwrap();
        // The IDS, not just the count: they are what the caller uses to delete the
        // matching attachment directories.
        assert_eq!(removed, vec!["old".to_string()]);
        // Assert WHICH rows survived, not just how many.
        let ids: Vec<String> = list(&conn, 50, 0)
            .unwrap()
            .into_iter()
            .map(|s| s.session_id)
            .collect();
        assert_eq!(ids, vec!["new".to_string(), "mid".to_string()]);
    }

    #[test]
    fn prune_drops_rows_older_than_the_age_limit_even_when_under_the_count_limit() {
        // "50 sessions AND 30 days" — whichever bites first.
        let mut conn = mem();
        put(&mut conn, &row("ancient"), KEEP_ALL).unwrap();
        closed_at(&conn, "ancient", "2020-01-01T00:00:00+00:00");
        put(&mut conn, &row("fresh"), KEEP_ALL).unwrap();

        prune(
            &conn,
            Retention {
                max_sessions: 100,
                max_age_days: 30,
            },
        )
        .unwrap();
        let ids: Vec<String> = list(&conn, 50, 0)
            .unwrap()
            .into_iter()
            .map(|s| s.session_id)
            .collect();
        assert_eq!(ids, vec!["fresh".to_string()]);
    }

    #[test]
    fn prune_never_touches_an_open_session() {
        // Otherwise a tab left open for a month loses its transcript mid-run.
        let mut conn = mem();
        let mut open = row("live");
        open.is_open = true;
        put(&mut conn, &open, KEEP_ALL).unwrap();
        closed_at(&conn, "live", "2020-01-01T00:00:00+00:00");

        prune(
            &conn,
            Retention {
                max_sessions: 0,
                max_age_days: 1,
            },
        )
        .unwrap();
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM archived_sessions", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1);
    }

    #[test]
    fn reap_open_sessions_marks_them_crashed_and_lists_them() {
        let mut conn = mem();
        let mut open = row("live");
        open.is_open = true;
        open.messages = Some(vec![msg(0, "user")]);
        put(&mut conn, &open, KEEP_ALL).unwrap();
        // An open row is not history yet.
        assert!(list(&conn, 50, 0).unwrap().is_empty());

        assert_eq!(reap_open_sessions(&conn).unwrap(), 1);
        let listed = list(&conn, 50, 0).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].close_reason, "crash");
        // The transcript is what the reap exists to recover.
        assert_eq!(listed[0].message_count, 1);
    }

    #[test]
    fn reap_is_idempotent() {
        let mut conn = mem();
        put(&mut conn, &row("a"), KEEP_ALL).unwrap();
        closed_at(&conn, "a", "2026-08-01T00:00:00+00:00");
        assert_eq!(reap_open_sessions(&conn).unwrap(), 0);
        // A second reap must not rewrite an already-closed row's closed_at.
        let when: String = conn
            .query_row("SELECT closed_at FROM archived_sessions", [], |r| r.get(0))
            .unwrap();
        assert_eq!(when, "2026-08-01T00:00:00+00:00");
    }

    #[test]
    fn superseding_a_reopened_session_collapses_it_into_one_row() {
        let mut conn = mem();
        let mut first = row("run1");
        first.messages = Some(vec![msg(0, "user")]);
        put(&mut conn, &first, KEEP_ALL).unwrap();

        let mut second = row("run2");
        second.supersedes = Some("run1".into());
        second.messages = Some(vec![msg(0, "user"), msg(1, "assistant")]);
        put(&mut conn, &second, KEEP_ALL).unwrap();

        let listed = list(&conn, 50, 0).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].session_id, "run2");
        // The thread of work keeps its original start.
        assert_eq!(listed[0].opened_at, "2026-08-01T00:00:00+00:00");
        // run1's messages went with it.
        let total: i64 = conn
            .query_row("SELECT COUNT(*) FROM archived_messages", [], |r| r.get(0))
            .unwrap();
        assert_eq!(total, 2);
    }

    #[test]
    fn superseding_a_missing_row_is_not_an_error() {
        // The same archive row reopened into two tabs: the second close finds
        // nothing to collapse.
        let mut conn = mem();
        let mut r = row("run2");
        r.supersedes = Some("gone".into());
        put(&mut conn, &r, KEEP_ALL).unwrap();
        assert_eq!(list(&conn, 50, 0).unwrap().len(), 1);
    }

    #[test]
    fn oversized_content_and_command_output_are_capped_on_the_way_in() {
        // Server-side, not a frontend courtesy.
        let mut conn = mem();
        let mut r = row("a");
        let mut big = msg(0, "assistant");
        big.content = "x".repeat(MAX_MESSAGE_CONTENT * 2);
        let mut big_card = card(1);
        big_card.command.as_mut().unwrap().output = "y".repeat(MAX_COMMAND_OUTPUT * 3);
        r.messages = Some(vec![big, big_card]);
        put(&mut conn, &r, KEEP_ALL).unwrap();

        let detail = get(&conn, "a").unwrap().unwrap();
        assert_eq!(
            detail.messages[0].content.chars().count(),
            MAX_MESSAGE_CONTENT
        );
        let out = &detail.messages[1].command.as_ref().unwrap().output;
        assert_eq!(out.chars().count(), MAX_COMMAND_OUTPUT);
    }

    #[test]
    fn only_the_newest_messages_are_kept_when_a_transcript_is_huge() {
        let mut conn = mem();
        let mut r = row("a");
        r.messages = Some((0..MAX_MESSAGES + 30).map(|i| msg(i, "user")).collect());
        put(&mut conn, &r, KEEP_ALL).unwrap();

        let detail = get(&conn, "a").unwrap().unwrap();
        assert_eq!(detail.messages.len(), MAX_MESSAGES);
        // The NEWEST survive: the first kept message is #30.
        assert_eq!(detail.messages[0].content, "message 30");
    }

    #[test]
    fn truncation_never_splits_a_multibyte_character() {
        // The sanitize_title lesson, applied to the caps. Byte slicing here would
        // panic on any box-drawing character in captured output.
        let mut conn = mem();
        let mut r = row("a");
        let mut m = msg(0, "assistant");
        m.content = "é".repeat(MAX_MESSAGE_CONTENT + 100);
        let mut c = card(1);
        c.command.as_mut().unwrap().output = "→".repeat(MAX_COMMAND_OUTPUT + 100);
        r.messages = Some(vec![m, c]);
        put(&mut conn, &r, KEEP_ALL).unwrap();

        let detail = get(&conn, "a").unwrap().unwrap();
        assert_eq!(
            detail.messages[0].content.chars().count(),
            MAX_MESSAGE_CONTENT
        );
        assert!(detail.messages[0].content.chars().all(|ch| ch == 'é'));
        let out = &detail.messages[1].command.as_ref().unwrap().output;
        assert!(out.chars().all(|ch| ch == '→'));
    }

    #[test]
    fn model_transcript_round_trips_tool_calls_and_ids() {
        let mut conn = mem();
        let mut r = row("a");
        r.model_transcript = Some(vec![
            ChatMessage::system("you are an agent"),
            ChatMessage::user("list the files"),
            ChatMessage {
                role: Role::Assistant,
                content: "running it".into(),
                tool_calls: Some(vec![ToolCall {
                    id: "call_1".into(),
                    name: "run_command".into(),
                    arguments: r#"{"command":"ls"}"#.into(),
                }]),
                tool_call_id: None,
                images: None,
            },
            ChatMessage {
                role: Role::Tool,
                content: "exit code: 0".into(),
                tool_calls: None,
                tool_call_id: Some("call_1".into()),
                images: None,
            },
        ]);
        put(&mut conn, &r, KEEP_ALL).unwrap();

        let back = transcript(&conn, "a").unwrap();
        assert_eq!(back.len(), 4);
        let calls = back[2].tool_calls.as_ref().unwrap();
        assert_eq!(calls[0].id, "call_1");
        assert_eq!(calls[0].arguments, r#"{"command":"ls"}"#);
        assert_eq!(back[3].tool_call_id.as_deref(), Some("call_1"));
        assert!(list(&conn, 50, 0).unwrap()[0].has_model_transcript);
    }

    #[test]
    fn an_unparseable_model_transcript_degrades_to_no_continuity() {
        // One bad row must not break the reopen path.
        let mut conn = mem();
        put(&mut conn, &row("a"), KEEP_ALL).unwrap();
        conn.execute(
            "UPDATE archived_sessions SET model_transcript = '{not json' WHERE session_id = 'a'",
            [],
        )
        .unwrap();
        assert!(transcript(&conn, "a").unwrap().is_empty());
    }

    #[test]
    fn an_oversized_model_transcript_is_dropped_rather_than_truncated() {
        // Half a JSON array would fail to parse on the way out, which is worse
        // than having no continuity.
        let mut conn = mem();
        let mut r = row("a");
        r.model_transcript = Some(vec![ChatMessage::user(
            "z".repeat(MAX_MODEL_TRANSCRIPT_BYTES + 1),
        )]);
        put(&mut conn, &r, KEEP_ALL).unwrap();
        assert!(transcript(&conn, "a").unwrap().is_empty());
        assert!(!list(&conn, 50, 0).unwrap()[0].has_model_transcript);
    }

    #[test]
    fn list_is_ordered_newest_first_and_paginates() {
        let mut conn = mem();
        for i in 0..5 {
            let id = format!("s{i}");
            put(&mut conn, &row(&id), KEEP_ALL).unwrap();
            closed_at(&conn, &id, &format!("2026-08-0{}T00:00:00+00:00", i + 1));
        }
        let first_two: Vec<String> = list(&conn, 2, 0)
            .unwrap()
            .into_iter()
            .map(|s| s.session_id)
            .collect();
        assert_eq!(first_two, vec!["s4".to_string(), "s3".to_string()]);
        let next: Vec<String> = list(&conn, 2, 2)
            .unwrap()
            .into_iter()
            .map(|s| s.session_id)
            .collect();
        assert_eq!(next, vec!["s2".to_string(), "s1".to_string()]);
    }

    #[test]
    fn get_of_an_unknown_session_is_none() {
        let conn = mem();
        assert!(get(&conn, "nope").unwrap().is_none());
        assert_eq!(scrollback(&conn, "nope").unwrap(), None);
        assert!(transcript(&conn, "nope").unwrap().is_empty());
    }

    #[test]
    fn the_history_command_count_comes_from_command_history() {
        let mut conn = mem();
        for i in 0..3 {
            conn.execute(
                "INSERT INTO command_history (id, session_id, cwd, command, shell, started_at)
                 VALUES (?1, 'a', '/tmp', 'echo hi', 'zsh', '2026-08-01T00:00:00Z')",
                params![format!("h{i}")],
            )
            .unwrap();
        }
        put(&mut conn, &row("a"), KEEP_ALL).unwrap();
        assert_eq!(list(&conn, 50, 0).unwrap()[0].history_command_count, 3);
    }

    #[test]
    fn an_unknown_role_or_status_is_coerced_rather_than_aborting_the_write() {
        // A CHECK violation would abort the transaction and take the terminal's
        // scrollback with it. A mislabelled message is worth less than that.
        let mut conn = mem();
        let mut r = row("a");
        let mut weird = msg(0, "system");
        weird.kind = Some("bogus".into());
        let mut weird_card = card(1);
        weird_card.command.as_mut().unwrap().status = "exploded".into();
        r.messages = Some(vec![weird, weird_card]);
        put(&mut conn, &r, KEEP_ALL).unwrap();

        let detail = get(&conn, "a").unwrap().unwrap();
        assert_eq!(detail.messages[0].role, "assistant");
        assert_eq!(detail.messages[0].kind, "text");
        assert_eq!(detail.messages[1].command.as_ref().unwrap().status, "done");
    }

    #[test]
    fn put_many_writes_every_session_in_one_go() {
        let mut conn = mem();
        let rows: Vec<_> = ["a", "b", "c"].iter().map(|id| row(id)).collect();
        put_many(&mut conn, &rows, KEEP_ALL).unwrap();
        assert_eq!(list(&conn, 50, 0).unwrap().len(), 3);
    }

    #[test]
    fn a_close_reason_outside_the_check_is_coerced() {
        let mut conn = mem();
        let mut r = row("a");
        r.close_reason = Some("exploded".into());
        put(&mut conn, &r, KEEP_ALL).unwrap();
        assert_eq!(list(&conn, 50, 0).unwrap()[0].close_reason, "closed");
    }
}
