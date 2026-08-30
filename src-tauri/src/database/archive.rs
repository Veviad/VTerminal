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
const COMPLETION_UNKNOWN_NOTE: &str =
    "Completion unknown: this archived command did not contain a trusted settled status.";
const INTERRUPT_UNKNOWN_NOTE: &str =
    "The interrupt was sent, but no completion signal was observed. The exit status is unknown.";

/// Archive statuses are an allowlist, not an arbitrary display string. Missing,
/// unsupported, legacy/live `running`, and `done` without an exit code all become
/// completion unknown.
fn settled_command_status(status: Option<&str>, exit_code: Option<i32>) -> &'static str {
    match status {
        Some("done") if exit_code.is_some() => "done",
        Some("done") => "timeout",
        Some("skipped") => "skipped",
        Some("timeout") => "timeout",
        Some("blocked") => "blocked",
        Some("interrupted") => "interrupted",
        Some("running") | None => "timeout",
        Some(_) => "timeout",
    }
}

fn with_completion_unknown_note(note: Option<String>, completion_unknown: bool) -> Option<String> {
    if !completion_unknown {
        return note;
    }
    match note {
        Some(note) if note.contains("Completion unknown") => Some(note),
        Some(note) => Some(format!("{note} {COMPLETION_UNKNOWN_NOTE}")),
        None => Some(COMPLETION_UNKNOWN_NOTE.to_string()),
    }
}

fn private_command_note(status: &str, exit_code: Option<i32>) -> String {
    const PRIVATE_NOTICE: &str = "[private output suppressed]";
    if status == "timeout" {
        format!("{PRIVATE_NOTICE} {COMPLETION_UNKNOWN_NOTE}")
    } else if status == "interrupted" && exit_code.is_none() {
        format!("{PRIVATE_NOTICE} {INTERRUPT_UNKNOWN_NOTE}")
    } else {
        PRIVATE_NOTICE.to_string()
    }
}

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
    pub output_policy: String,
    pub target_role: Option<String>,
    pub target_label: Option<String>,
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
    pub mcp_selection: Option<crate::mcp::config::McpChatSelection>,
}

// ---------- Input shapes ----------

#[derive(Debug, Deserialize)]
pub struct ArchiveCommandInput {
    pub command: String,
    pub output: String,
    pub exit_code: Option<i32>,
    pub status: String,
    pub note: Option<String>,
    #[serde(default = "default_output_policy")]
    pub output_policy: String,
    #[serde(default)]
    pub target_role: Option<String>,
    #[serde(default)]
    pub target_label: Option<String>,
}

fn default_output_policy() -> String {
    "normal".into()
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
    /// `None` preserves the stored value on metadata-only writes. Old rows and
    /// pre-0.4 callers therefore reopen with no MCP servers selected.
    #[serde(default)]
    pub mcp_selection: Option<crate::mcp::config::McpChatSelection>,
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

/// Filesystem cleanup that must follow a committed archive deletion. A reopened
/// transcript can keep paths under the superseded session's directory, so the
/// removed row id alone is not enough to identify every owned byte.
#[derive(Debug, PartialEq, Eq)]
pub struct ArchiveRemoval {
    pub session_id: String,
    pub remove_session_dir: bool,
    pub attachment_paths: Vec<String>,
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

    let mcp_selection = conn
        .query_row(
            "SELECT mcp_selection_json FROM archived_sessions WHERE session_id = ?1",
            params![session_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .flatten()
        .and_then(|raw| serde_json::from_str(&raw).ok());

    let mut stmt = conn
        .prepare(
            "SELECT id, sort_order, role, kind, content, thinking, cmd_command, cmd_output,
                    cmd_exit_code, cmd_status, cmd_note, cmd_output_policy, cmd_target_role,
                    cmd_target_label, created_at
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
                ("command", Some(c)) => {
                    let exit_code = row.get(8)?;
                    let raw_status = row.get::<_, Option<String>>(9)?;
                    let status = settled_command_status(raw_status.as_deref(), exit_code);
                    let output_policy = row.get::<_, String>(11)?;
                    let note = with_completion_unknown_note(
                        if output_policy == "private" {
                            Some(private_command_note(status, exit_code))
                        } else {
                            row.get::<_, Option<String>>(10)?.or_else(|| {
                                (status == "interrupted" && exit_code.is_none())
                                    .then(|| INTERRUPT_UNKNOWN_NOTE.to_string())
                            })
                        },
                        status == "timeout",
                    );
                    Some(ArchivedCommand {
                        command: c,
                        output: if output_policy == "private" {
                            String::new()
                        } else {
                            row.get::<_, Option<String>>(7)?.unwrap_or_default()
                        },
                        exit_code,
                        status: status.into(),
                        note,
                        output_policy,
                        target_role: row.get(12)?,
                        target_label: row.get(13)?,
                    })
                }
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
                created_at: row.get(14)?,
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

    Ok(Some(ArchiveDetail {
        summary,
        messages,
        mcp_selection,
    }))
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
    put_many(conn, std::slice::from_ref(input), retention).map(|_| ())
}

/// Write many sessions in ONE transaction — the quit path archives every tab at
/// once, inside a 1.5s budget.
pub fn put_many(
    conn: &mut Connection,
    inputs: &[ArchiveSessionInput],
    retention: Retention,
) -> Result<Vec<ArchiveRemoval>, String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let now = chrono::Utc::now().to_rfc3339();
    let mut removed = Vec::new();

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
        let mcp_selection = input
            .mcp_selection
            .as_ref()
            .map(serde_json::to_string)
            .transpose()
            .map_err(|e| format!("serialize MCP selection: {e}"))?;

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
                 model_transcript, transcript_version, mcp_selection_json)
             VALUES (?1, ?2, ?3, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, 1,
                     ?15, COALESCE(?16, 0), COALESCE(?17, 0), COALESCE(?18, 0), ?19,
                     COALESCE(?20, ''), ?21, 1, ?22)
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
                model_transcript = COALESCE(?21, archived_sessions.model_transcript),
                mcp_selection_json = COALESCE(?22, archived_sessions.mcp_selection_json)",
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
                mcp_selection,
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
                    Some(k @ ("literal" | "command" | "compaction")) => k,
                    _ => "text",
                };
                let (cmd, out, exit, status, note, output_policy, target_role, target_label) =
                    match &m.command {
                        Some(c) => {
                            let private = c.output_policy == "private";
                            let status =
                                settled_command_status(Some(c.status.as_str()), c.exit_code);
                            (
                                Some(head(&c.command, MAX_MESSAGE_CONTENT)),
                                Some(if private {
                                    String::new()
                                } else {
                                    tail(&c.output, MAX_COMMAND_OUTPUT)
                                }),
                                c.exit_code,
                                Some(status),
                                with_completion_unknown_note(
                                    if private {
                                        Some(private_command_note(status, c.exit_code))
                                    } else {
                                        c.note.clone().or_else(|| {
                                            (status == "interrupted" && c.exit_code.is_none())
                                                .then(|| INTERRUPT_UNKNOWN_NOTE.to_string())
                                        })
                                    },
                                    status == "timeout",
                                ),
                                if private {
                                    Some("private")
                                } else {
                                    Some("normal")
                                },
                                match c.target_role.as_deref() {
                                    Some(role @ ("local" | "remote")) => Some(role),
                                    _ => None,
                                },
                                c.target_label.as_deref().map(|label| head(label, 256)),
                            )
                        }
                        None => (None, None, None, None, None, Some("normal"), None, None),
                    };
                tx.execute(
                    "INSERT INTO archived_messages
                        (id, session_id, sort_order, role, kind, content, thinking,
                         cmd_command, cmd_output, cmd_exit_code, cmd_status, cmd_note,
                         cmd_output_policy, cmd_target_role, cmd_target_label, created_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
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
                        output_policy,
                        target_role,
                        target_label,
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

        if input.is_open {
            // A final-exit preparation carries `supersedes`, but the old row
            // must survive until the clean marker commits. Ordinary open ticks
            // carry None and clear a mapping after an abandoned exit.
            if let Some(old) = &input.supersedes {
                if old != &input.session_id {
                    tx.execute(
                        "INSERT INTO archive_pending_supersedes
                            (session_id, supersedes_session_id)
                         VALUES (?1, ?2)
                         ON CONFLICT(session_id) DO UPDATE SET
                            supersedes_session_id = excluded.supersedes_session_id",
                        params![input.session_id, old],
                    )
                    .map_err(|e| e.to_string())?;
                }
            } else {
                tx.execute(
                    "DELETE FROM archive_pending_supersedes WHERE session_id = ?1",
                    params![input.session_id],
                )
                .map_err(|e| e.to_string())?;
            }
        } else {
            // The ordinary tab-close path can collapse immediately. A missing
            // source is legitimate when one archive was reopened twice.
            if let Some(old) = &input.supersedes {
                if old != &input.session_id {
                    removed.push(removal_for(&tx, old)?);
                    tx.execute(
                        "DELETE FROM archived_sessions WHERE session_id = ?1",
                        params![old],
                    )
                    .map_err(|e| e.to_string())?;
                }
            }
            tx.execute(
                "DELETE FROM archive_pending_supersedes WHERE session_id = ?1",
                params![input.session_id],
            )
            .map_err(|e| e.to_string())?;
        }
    }

    // Exit preparation is deliberately reversible. Pruning unrelated closed
    // history while staging an all-open batch would make a later rollback only
    // superficially successful, and would also leak those sessions' attachment
    // directories because this database layer cannot remove filesystem bytes.
    if inputs.iter().any(|input| !input.is_open) {
        removed.extend(prune_unfiltered_in(&tx, retention)?);
    }
    let removed = finalize_removals(&tx, removed)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(removed)
}

/// Enforce both retention limits, reporting WHICH sessions went.
///
/// `is_open = 0` on both statements is mandatory: pruning an open row would delete
/// a live tab's transcript out from under it.
///
/// Removal targets include both row ids and attachment paths because attachment
/// BYTES live outside SQLite. Paths must be captured before `ON DELETE CASCADE`
/// clears their metadata, including paths still owned by superseded sessions.
pub(crate) fn removal_for(conn: &Connection, session_id: &str) -> Result<ArchiveRemoval, String> {
    let mut stmt = conn
        .prepare(
            "SELECT DISTINCT attachment.path
               FROM archived_attachments attachment
               JOIN archived_messages message ON message.id = attachment.message_id
              WHERE message.session_id = ?1 AND attachment.path IS NOT NULL",
        )
        .map_err(|e| e.to_string())?;
    let attachment_paths = stmt
        .query_map(params![session_id], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(ArchiveRemoval {
        session_id: session_id.to_string(),
        remove_session_dir: true,
        attachment_paths,
    })
}

fn attachment_owner(path: &str) -> Option<String> {
    std::path::Path::new(path)
        .parent()?
        .file_name()?
        .to_str()
        .map(str::to_string)
}

/// A directory is removable only when no surviving archive attachment points
/// anywhere inside it. This is load-bearing when the same source archive is
/// reopened into two tabs: both replacement rows share the source image path.
pub(crate) fn finalize_removals(
    conn: &Connection,
    mut removed: Vec<ArchiveRemoval>,
) -> Result<Vec<ArchiveRemoval>, String> {
    let surviving_owners = {
        let mut stmt = conn
            .prepare("SELECT DISTINCT path FROM archived_attachments WHERE path IS NOT NULL")
            .map_err(|e| e.to_string())?;
        let paths = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        paths
            .into_iter()
            .filter_map(|path| attachment_owner(&path))
            .collect::<std::collections::HashSet<_>>()
    };
    for removal in &mut removed {
        removal.remove_session_dir = !surviving_owners.contains(&removal.session_id);
        removal.attachment_paths.retain(|path| {
            attachment_owner(path).is_some_and(|owner| !surviving_owners.contains(&owner))
        });
    }
    Ok(removed)
}

fn delete_sessions_unfiltered(
    conn: &Connection,
    session_ids: Vec<String>,
) -> Result<Vec<ArchiveRemoval>, String> {
    let mut removed = Vec::with_capacity(session_ids.len());
    for session_id in session_ids {
        // Capture paths before ON DELETE CASCADE removes the attachment rows.
        removed.push(removal_for(conn, &session_id)?);
        conn.execute(
            "DELETE FROM archived_sessions WHERE session_id = ?1",
            params![session_id],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(removed)
}

pub(crate) fn prune_unfiltered_in(
    conn: &Connection,
    retention: Retention,
) -> Result<Vec<ArchiveRemoval>, String> {
    let mut removed = Vec::new();

    // Select authoritative ids once, then capture their paths and delete those
    // exact rows. No retention predicate is re-derived after cleanup metadata
    // has been collected.
    let count_ids = {
        let mut stmt = conn
            .prepare(
                "SELECT session_id FROM archived_sessions
                  WHERE is_open = 0
                    AND session_id NOT IN (
                         SELECT session_id FROM archived_sessions
                          WHERE is_open = 0 ORDER BY closed_at DESC LIMIT ?1)
                  ORDER BY closed_at ASC, session_id ASC",
            )
            .map_err(|e| e.to_string())?;
        let ids = stmt
            .query_map(params![retention.max_sessions], |row| {
                row.get::<_, String>(0)
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        ids
    };
    removed.extend(delete_sessions_unfiltered(conn, count_ids)?);

    // Lexicographic compare is only correct because every writer in this file
    // uses `chrono::Utc::now().to_rfc3339()` — fixed-width and UTC. One
    // local-time write would break this silently.
    let cutoff = (chrono::Utc::now() - chrono::Duration::days(i64::from(retention.max_age_days)))
        .to_rfc3339();
    let age_ids = {
        let mut stmt = conn
            .prepare(
                "SELECT session_id FROM archived_sessions
                  WHERE is_open = 0 AND closed_at < ?1
                  ORDER BY closed_at ASC, session_id ASC",
            )
            .map_err(|e| e.to_string())?;
        let ids = stmt
            .query_map(params![cutoff], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        ids
    };
    removed.extend(delete_sessions_unfiltered(conn, age_ids)?);

    Ok(removed)
}

pub(crate) fn prune_in(
    conn: &Connection,
    retention: Retention,
) -> Result<Vec<ArchiveRemoval>, String> {
    let removed = prune_unfiltered_in(conn, retention)?;
    finalize_removals(conn, removed)
}

/// Standalone prune, so lowering a limit in Settings takes effect immediately
/// rather than at the next archive write. Returns the sessions removed, so the
/// caller can drop their attachment files too.
pub fn prune(conn: &Connection, retention: Retention) -> Result<Vec<ArchiveRemoval>, String> {
    prune_in(conn, retention)
}

pub fn delete(conn: &Connection, session_id: &str) -> Result<ArchiveRemoval, String> {
    let removed = removal_for(conn, session_id)?;
    conn.execute(
        "DELETE FROM archived_sessions WHERE session_id = ?1",
        params![session_id],
    )
    .map_err(|e| e.to_string())?;
    finalize_removals(conn, vec![removed])?
        .pop()
        .ok_or_else(|| "archive cleanup target disappeared".to_string())
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
pub fn reap_open_sessions(conn: &mut Connection) -> Result<u32, String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let now = chrono::Utc::now().to_rfc3339();
    tx.execute(
        "DELETE FROM archive_pending_supersedes
          WHERE session_id IN (SELECT session_id FROM archived_sessions WHERE is_open = 1)",
        [],
    )
    .map_err(|e| e.to_string())?;
    let n = tx
        .execute(
            "UPDATE archived_sessions
                SET is_open = 0, close_reason = 'crash', closed_at = ?1, updated_at = ?1
              WHERE is_open = 1",
            params![now],
        )
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
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
            mcp_selection: None,
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
                output_policy: "normal".into(),
                target_role: None,
                target_label: None,
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
    fn literal_display_rows_round_trip_without_losing_their_origin() {
        let mut conn = mem();
        let mut r = row("literal-display");
        let mut literal = msg(0, "assistant");
        literal.kind = Some("literal".into());
        literal.content = "<finish> <summary> Literal tool data\n</summary> </finish>".into();
        r.messages = Some(vec![literal]);

        put(&mut conn, &r, KEEP_ALL).unwrap();
        let detail = get(&conn, "literal-display").unwrap().unwrap();

        assert_eq!(detail.messages[0].kind, "literal");
        assert!(detail.messages[0].content.contains("<finish>"));
        assert!(detail.messages[0].content.contains("<summary>"));
        assert!(detail.messages[0].command.is_none());
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
        let mut linked = card(7);
        let linked_command = linked.command.as_mut().unwrap();
        linked_command.target_role = Some("remote".into());
        linked_command.target_label = Some("deploy@prod-01".into());
        r.messages = Some(vec![linked]);
        put(&mut conn, &r, KEEP_ALL).unwrap();

        let detail = get(&conn, "a").unwrap().unwrap();
        let cmd = detail.messages[0].command.as_ref().unwrap();
        assert_eq!(detail.messages[0].kind, "command");
        assert_eq!(cmd.command, "ls -la /7");
        assert_eq!(cmd.exit_code, Some(0));
        assert_eq!(cmd.status, "done");
        assert_eq!(cmd.output_policy, "normal");
        assert_eq!(cmd.target_role.as_deref(), Some("remote"));
        assert_eq!(cmd.target_label.as_deref(), Some("deploy@prod-01"));
    }

    #[test]
    fn interrupted_is_persisted_and_running_is_reconciled_to_unknown() {
        let mut conn = mem();
        let mut r = row("command-statuses");
        let mut interrupted = card(1);
        interrupted.command.as_mut().unwrap().status = "interrupted".into();
        interrupted.command.as_mut().unwrap().exit_code = Some(130);
        let mut orphaned = card(2);
        orphaned.command.as_mut().unwrap().status = "running".into();
        orphaned.command.as_mut().unwrap().exit_code = None;
        let missing_status = card(3);
        let mut legacy_done = card(4);
        legacy_done.command.as_mut().unwrap().exit_code = None;
        let legacy_private_timeout = card(5);
        let mut unconfirmed_private_interrupt = card(6);
        let unconfirmed = unconfirmed_private_interrupt.command.as_mut().unwrap();
        unconfirmed.status = "interrupted".into();
        unconfirmed.exit_code = None;
        unconfirmed.output_policy = "private".into();
        r.messages = Some(vec![
            interrupted,
            orphaned,
            missing_status,
            legacy_done,
            legacy_private_timeout,
            unconfirmed_private_interrupt,
        ]);

        put(&mut conn, &r, KEEP_ALL).unwrap();
        conn.execute(
            "UPDATE archived_messages SET cmd_status = NULL
             WHERE session_id = 'command-statuses' AND sort_order = 2",
            [],
        )
        .unwrap();
        conn.execute(
            "UPDATE archived_messages
                SET cmd_status = 'timeout', cmd_exit_code = NULL,
                    cmd_note = '[private output suppressed]',
                    cmd_output_policy = 'private'
              WHERE session_id = 'command-statuses' AND sort_order = 4",
            [],
        )
        .unwrap();

        let detail = get(&conn, "command-statuses").unwrap().unwrap();
        let interrupted = detail.messages[0].command.as_ref().unwrap();
        assert_eq!(interrupted.status, "interrupted");
        assert_eq!(interrupted.exit_code, Some(130));
        let orphaned = detail.messages[1].command.as_ref().unwrap();
        assert_eq!(orphaned.status, "timeout");
        assert!(orphaned
            .note
            .as_deref()
            .is_some_and(|note| note.contains("Completion unknown")));
        let missing_status = detail.messages[2].command.as_ref().unwrap();
        assert_eq!(missing_status.status, "timeout");
        assert!(missing_status
            .note
            .as_deref()
            .is_some_and(|note| note.contains("Completion unknown")));
        let legacy_done = detail.messages[3].command.as_ref().unwrap();
        assert_eq!(legacy_done.status, "timeout");
        assert!(legacy_done
            .note
            .as_deref()
            .is_some_and(|note| note.contains("Completion unknown")));
        let legacy_private_timeout = detail.messages[4].command.as_ref().unwrap();
        assert_eq!(legacy_private_timeout.status, "timeout");
        let note = legacy_private_timeout.note.as_deref().unwrap();
        assert_eq!(legacy_private_timeout.output, "");
        assert!(note.contains("[private output suppressed]"));
        assert_eq!(note.matches("Completion unknown").count(), 1);
        let unconfirmed = detail.messages[5].command.as_ref().unwrap();
        assert_eq!(unconfirmed.status, "interrupted");
        assert_eq!(unconfirmed.exit_code, None);
        let note = unconfirmed.note.as_deref().unwrap();
        assert!(note.contains("[private output suppressed]"));
        assert!(note.contains("no completion signal was observed"));
        assert!(note.contains("exit status is unknown"));
    }

    #[test]
    fn private_command_output_is_discarded_before_archive_storage() {
        let mut conn = mem();
        let mut r = row("private");
        let mut private = card(1);
        let command = private.command.as_mut().unwrap();
        command.output = "must-never-be-archived".into();
        command.output_policy = "private".into();
        let mut private_timeout = card(2);
        let timeout = private_timeout.command.as_mut().unwrap();
        timeout.output = "also-must-never-be-archived".into();
        timeout.output_policy = "private".into();
        timeout.status = "timeout".into();
        timeout.exit_code = None;
        timeout.note = Some("untrusted private note".into());
        r.messages = Some(vec![private, private_timeout]);
        put(&mut conn, &r, KEEP_ALL).unwrap();

        let detail = get(&conn, "private").unwrap().unwrap();
        let command = detail.messages[0].command.as_ref().unwrap();
        assert_eq!(command.output_policy, "private");
        assert_eq!(command.output, "");
        assert_eq!(command.note.as_deref(), Some("[private output suppressed]"));
        let timeout = detail.messages[1].command.as_ref().unwrap();
        assert_eq!(timeout.status, "timeout");
        assert_eq!(timeout.output, "");
        assert!(timeout
            .note
            .as_deref()
            .is_some_and(|note| note.contains("[private output suppressed]")
                && note.contains("Completion unknown")
                && !note.contains("untrusted private note")));
        let raw: String = conn
            .query_row(
                "SELECT group_concat(cmd_output, '') FROM archived_messages
                 WHERE session_id = 'private'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!raw.contains("must-never-be-archived"));
        assert!(!raw.contains("also-must-never-be-archived"));
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
        assert_eq!(
            removed
                .iter()
                .map(|removal| removal.session_id.as_str())
                .collect::<Vec<_>>(),
            vec!["old"]
        );
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

        assert_eq!(reap_open_sessions(&mut conn).unwrap(), 1);
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
        assert_eq!(reap_open_sessions(&mut conn).unwrap(), 0);
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
    fn provisional_supersede_survives_prepare_and_is_cleared_on_rollback() {
        let mut conn = mem();
        put(&mut conn, &row("source"), KEEP_ALL).unwrap();

        let mut prepared = row("reopened");
        prepared.is_open = true;
        prepared.supersedes = Some("source".into());
        put(&mut conn, &prepared, KEEP_ALL).unwrap();

        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM archived_sessions", [], |row| {
                row.get(0)
            })
            .unwrap();
        let pending: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM archive_pending_supersedes",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(rows, 2, "preparation must not delete the source archive");
        assert_eq!(pending, 1);

        // Persistence resumed after an abandoned update/quit. The ordinary
        // open row cancels the staged collapse but preserves both archives.
        prepared.supersedes = None;
        put(&mut conn, &prepared, KEEP_ALL).unwrap();
        let pending: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM archive_pending_supersedes",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let source: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM archived_sessions WHERE session_id = 'source'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(pending, 0);
        assert_eq!(source, 1);
    }

    #[test]
    fn provisional_batches_do_not_prune_closed_history_before_rollback() {
        let mut conn = mem();
        put(&mut conn, &row("older"), KEEP_ALL).unwrap();
        closed_at(&conn, "older", "2026-08-01T00:00:00+00:00");
        put(&mut conn, &row("newer"), KEEP_ALL).unwrap();
        closed_at(&conn, "newer", "2026-08-02T00:00:00+00:00");

        let mut prepared = row("live");
        prepared.is_open = true;
        let retention = Retention {
            max_sessions: 1,
            max_age_days: 3650,
        };
        assert!(
            put_many(&mut conn, std::slice::from_ref(&prepared), retention)
                .unwrap()
                .is_empty()
        );

        // A failed update/quit writes the same row open without its pending
        // supersede mapping. Neither reversible write may enforce retention.
        prepared.supersedes = None;
        assert!(put_many(&mut conn, &[prepared], retention)
            .unwrap()
            .is_empty());
        let mut closed: Vec<String> = list(&conn, 50, 0)
            .unwrap()
            .into_iter()
            .map(|summary| summary.session_id)
            .collect();
        closed.sort();
        assert_eq!(closed, vec!["newer".to_string(), "older".to_string()]);
    }

    #[test]
    fn a_closed_batch_returns_every_retention_pruned_session_id() {
        let mut conn = mem();
        put(&mut conn, &row("oldest"), KEEP_ALL).unwrap();
        closed_at(&conn, "oldest", "2026-08-01T00:00:00+00:00");
        put(&mut conn, &row("middle"), KEEP_ALL).unwrap();
        closed_at(&conn, "middle", "2026-08-02T00:00:00+00:00");

        let removed = put_many(
            &mut conn,
            &[row("newest")],
            Retention {
                max_sessions: 1,
                max_age_days: 3650,
            },
        )
        .unwrap();
        let mut removed_ids: Vec<_> = removed
            .iter()
            .map(|removal| removal.session_id.as_str())
            .collect();
        removed_ids.sort();
        assert_eq!(removed_ids, vec!["middle", "oldest"]);
        assert_eq!(list(&conn, 50, 0).unwrap()[0].session_id, "newest");
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
    fn model_transcript_round_trips_tool_calls_ids_and_structured_results() {
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
                structured_tool_result: None,
                images: None,
            },
            ChatMessage {
                role: Role::Tool,
                content: "exit code: 0".into(),
                tool_calls: None,
                tool_call_id: Some("call_1".into()),
                structured_tool_result: Some(crate::provider::StructuredToolResult {
                    content: vec![serde_json::json!({
                        "type": "resource_link",
                        "uri": "docs://result/1"
                    })],
                    structured_content: Some(serde_json::json!({"files": 3})),
                    is_error: false,
                    truncated: false,
                }),
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
        let structured = back[3].structured_tool_result.as_ref().unwrap();
        assert_eq!(structured.content[0]["uri"], "docs://result/1");
        assert_eq!(structured.structured_content.as_ref().unwrap()["files"], 3);
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
        let command = detail.messages[1].command.as_ref().unwrap();
        assert_eq!(command.status, "timeout");
        assert!(command
            .note
            .as_deref()
            .is_some_and(|note| note.contains("Completion unknown")));
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
