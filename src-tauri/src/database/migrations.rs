use rusqlite::Connection;

// APPEND-ONLY. Once a migration has run anywhere, editing it is a no-op for
// every database that already recorded its version — add a new `migrate_vN`
// instead. (Learned the hard way: extending v2 after it had already applied
// left a database at version 2 permanently missing the tables added later.)
pub fn run(conn: &Connection) -> Result<(), String> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);")
        .map_err(|e| e.to_string())?;

    let version: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(version), 0) FROM schema_version",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;

    if version < 1 {
        migrate_v1(conn)?;
    }
    if version < 2 {
        migrate_v2(conn)?;
    }
    if version < 3 {
        migrate_v3(conn)?;
    }
    if version < 4 {
        migrate_v4(conn)?;
    }
    if version < 5 {
        migrate_v5(conn)?;
    }
    if version < 6 {
        crate::runbooks::db::migrate_v6(conn)?;
    }
    if version < 7 {
        migrate_v7(conn)?;
    }
    if version < 8 {
        crate::runbooks::db::migrate_v8(conn)?;
    }
    if version < 9 {
        crate::runbooks::db::migrate_v9(conn)?;
    }
    if version < 10 {
        crate::runbooks::db::migrate_v10(conn)?;
    }
    if version < 11 {
        migrate_v11(conn)?;
    }
    if version < 12 {
        migrate_v12(conn)?;
    }
    if version < 13 {
        migrate_v13(conn)?;
    }
    if version < 14 {
        migrate_v14(conn)?;
    }
    crate::runbooks::db::ensure_v6_runtime_indexes(conn)?;

    Ok(())
}

fn migrate_v1(conn: &Connection) -> Result<(), String> {
    // Single transaction including the schema_version bump: a crash mid-way
    // must not leave half-created tables that brick every later startup.
    conn.execute_batch(
        r#"
        BEGIN;
        CREATE TABLE command_history (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            cwd TEXT NOT NULL,
            command TEXT NOT NULL,
            exit_code INTEGER,
            duration_ms INTEGER,
            output_tail TEXT,
            git_branch TEXT,
            shell TEXT NOT NULL DEFAULT 'zsh',
            started_at TEXT NOT NULL,
            ended_at TEXT
        );
        CREATE INDEX idx_history_started ON command_history(started_at DESC);
        CREATE INDEX idx_history_command ON command_history(command);

        CREATE TABLE conversations (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL DEFAULT 'New Conversation',
            kind TEXT NOT NULL CHECK(kind IN ('suggest','explain','ask','agent')),
            model TEXT NOT NULL,
            session_id TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE ai_messages (
            id TEXT PRIMARY KEY,
            conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
            role TEXT NOT NULL CHECK(role IN ('user','assistant','system','tool')),
            content TEXT NOT NULL,
            tool_calls TEXT,
            tool_call_id TEXT,
            token_count INTEGER,
            created_at TEXT NOT NULL,
            sort_order INTEGER NOT NULL
        );
        CREATE INDEX idx_ai_messages_conv ON ai_messages(conversation_id, sort_order);
        INSERT INTO schema_version (version) VALUES (1);
        COMMIT;
        "#,
    )
    .map_err(|e| format!("migration v1 failed: {e}"))
}

fn migrate_v2(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        BEGIN;
        -- Saved SSH hosts. Note what is NOT here: no password, no passphrase,
        -- no key material. This file is on-disk plaintext. `identity_file`
        -- holds a PATH only. A later migration adds a presence flag for SSH
        -- passwords stored in the operating-system credential vault.
        CREATE TABLE ssh_hosts (
            id TEXT PRIMARY KEY,
            label TEXT NOT NULL,
            hostname TEXT NOT NULL,
            username TEXT,
            port INTEGER,
            identity_file TEXT,
            jump_host TEXT,
            extra_args TEXT,
            remote_dir TEXT,
            post_connect TEXT,
            tag TEXT,
            color TEXT,
            source TEXT NOT NULL DEFAULT 'manual'
                CHECK(source IN ('manual','ssh_config')),
            config_alias TEXT,
            use_count INTEGER NOT NULL DEFAULT 0,
            last_used_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX idx_ssh_hosts_label ON ssh_hosts(label COLLATE NOCASE);
        -- Partial index: this is what makes re-importing ~/.ssh/config idempotent
        -- while still allowing any number of hand-added rows.
        CREATE UNIQUE INDEX idx_ssh_hosts_alias ON ssh_hosts(config_alias COLLATE NOCASE)
            WHERE config_alias IS NOT NULL;
        CREATE INDEX idx_ssh_hosts_frecency ON ssh_hosts(use_count DESC, last_used_at DESC);
        INSERT INTO schema_version (version) VALUES (2);
        COMMIT;
        "#,
    )
    .map_err(|e| format!("migration v2 failed: {e}"))
}

fn migrate_v3(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        BEGIN;
        -- Session restore. One workspace row: tauri.conf.json declares a single
        -- window, and the CHECK makes multi-window a deliberate future
        -- migration rather than an accident.
        CREATE TABLE workspace_state (
            id                TEXT PRIMARY KEY CHECK (id = 'default'),
            generation        INTEGER NOT NULL DEFAULT 0,
            active_session_id TEXT,
            clean_exit        INTEGER NOT NULL DEFAULT 1,
            restore_attempts  INTEGER NOT NULL DEFAULT 0,
            app_version       TEXT NOT NULL DEFAULT '',
            updated_at        TEXT NOT NULL DEFAULT ''
        );
        INSERT INTO workspace_state (id) VALUES ('default');

        CREATE TABLE session_snapshots (
            session_id       TEXT PRIMARY KEY,
            generation       INTEGER NOT NULL,
            tab_index        INTEGER NOT NULL,
            title            TEXT NOT NULL,
            shell            TEXT NOT NULL,
            cwd              TEXT,
            host_id          TEXT,
            -- Recorded for the restore separator only. NEVER replayed into
            -- sessionUi.remote: the connection is dead, and claiming otherwise
            -- would make the status bar and the AI context lie.
            remote_kind      TEXT,
            remote_target    TEXT,
            cols             INTEGER NOT NULL DEFAULT 80,
            rows             INTEGER NOT NULL DEFAULT 24,
            script_version   TEXT,
            format_version   INTEGER NOT NULL DEFAULT 1,
            scrollback       TEXT,
            scrollback_lines INTEGER NOT NULL DEFAULT 0,
            created_at       TEXT NOT NULL,
            updated_at       TEXT NOT NULL
        );
        CREATE INDEX idx_session_snapshots_gen ON session_snapshots(generation, tab_index);
        INSERT INTO schema_version (version) VALUES (3);
        COMMIT;
        "#,
    )
    .map_err(|e| format!("migration v3 failed: {e}"))
}

fn migrate_v4(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        BEGIN;
        -- Dead since v1: no code path ever inserted a row into either table.
        -- Superseded rather than extended, because the three things the archive
        -- needs from them — a widened `conversations.kind` CHECK, a different
        -- `role` CHECK, and a cascading FK on session_id — are all things
        -- SQLite's ALTER TABLE cannot add. Child first: the FK points that way.
        DROP TABLE IF EXISTS ai_messages;
        DROP TABLE IF EXISTS conversations;

        -- One row per ENDED session, browsable and reopenable on demand.
        --
        -- Deliberately NOT part of session_snapshots. That table's reads are
        -- `WHERE generation = MAX(generation)` and three of its DELETEs are
        -- unconditional, so an archive row living there would either be swept by
        -- the mark-and-sweep or come back as a LIVE TAB. Keeping the archive in
        -- its own table is what lets restore()/snapshot() stay byte-identical.
        CREATE TABLE archived_sessions (
            -- The ORIGINAL frontend session id, not a fresh uuid: a row is the
            -- tombstone of exactly one run, so re-archiving the same session
            -- (transcript tick, then close) is an upsert, never a duplicate.
            session_id            TEXT PRIMARY KEY,
            opened_at             TEXT NOT NULL,
            -- The browser orders by this, not opened_at: "the thing I just
            -- closed" has to be first.
            closed_at             TEXT NOT NULL,
            updated_at            TEXT NOT NULL,
            -- 1 while the session is still open. Written by the debounced
            -- transcript tick so an AI conversation survives kill -9, then
            -- flipped by reap_open_sessions() at the next boot. The browser
            -- lists is_open = 0 only, so a live tab never appears as history.
            is_open               INTEGER NOT NULL DEFAULT 0,
            close_reason          TEXT NOT NULL DEFAULT 'closed'
                                  CHECK (close_reason IN ('closed','quit','crash')),

            -- Same columns and meanings as session_snapshots, so archiving is a
            -- column copy and reopening feeds LaunchSpec with no translation.
            title                 TEXT NOT NULL DEFAULT '',
            shell                 TEXT NOT NULL,
            cwd                   TEXT,
            host_id               TEXT,
            -- Recorded for the reopen separator only, NEVER replayed as a live
            -- connection — the same rule as session_snapshots.
            remote_kind           TEXT,
            remote_target         TEXT,
            cols                  INTEGER NOT NULL DEFAULT 80,
            rows                  INTEGER NOT NULL DEFAULT 24,
            script_version        TEXT,
            format_version        INTEGER NOT NULL DEFAULT 1,
            scrollback            TEXT,
            scrollback_lines      INTEGER NOT NULL DEFAULT 0,

            -- Denormalized so the browser list is one index scan with no
            -- correlated count per row. Maintained by the writer, in its own
            -- transaction.
            message_count         INTEGER NOT NULL DEFAULT 0,
            agent_command_count   INTEGER NOT NULL DEFAULT 0,
            history_command_count INTEGER NOT NULL DEFAULT 0,
            -- Catalog id of the model that produced the transcript. '' when the
            -- session had no AI turns.
            model                 TEXT NOT NULL DEFAULT '',

            -- The model's OWN view of the agent run: serde_json of
            -- Vec<ChatMessage>, verbatim. Opaque to SQL for the same reason
            -- `scrollback` is — never queried, only round-tripped into the next
            -- agent_start, so normalizing it into rows buys nothing and drifts
            -- every time ChatMessage gains a field.
            model_transcript      TEXT,
            -- Lets a future ChatMessage shape change be refused cleanly instead
            -- of erroring, mirroring format_version/script_version.
            transcript_version    INTEGER NOT NULL DEFAULT 1
        );

        -- Serves all three hot queries — the browser list, the count prune and
        -- the age prune — because every one of them filters on is_open first.
        CREATE INDEX idx_archived_sessions_list
            ON archived_sessions(is_open, closed_at DESC);

        -- The DISPLAY transcript: one row per frontend AiMessage. Structured
        -- rather than a blob because the browser needs a message count and a
        -- first-prompt preview without deserializing megabytes.
        CREATE TABLE archived_messages (
            id            TEXT PRIMARY KEY,
            session_id    TEXT NOT NULL
                          REFERENCES archived_sessions(session_id) ON DELETE CASCADE,
            -- Dense, 0-based, from the array index. The ONLY ordering: created_at
            -- is a wall clock and several messages in one set() share it.
            sort_order    INTEGER NOT NULL,
            -- Narrower than v1's ai_messages.role on purpose: a DISPLAY
            -- transcript has no system and no tool rows. Tool results live inside
            -- cmd_output and in archived_sessions.model_transcript.
            role          TEXT NOT NULL CHECK (role IN ('user','assistant')),
            kind          TEXT NOT NULL DEFAULT 'text'
                          CHECK (kind IN ('text','command','compaction')),
            content       TEXT NOT NULL,
            thinking      TEXT,
            -- kind='command' only: the synthetic assistant card the agent makes.
            cmd_command   TEXT,
            cmd_output    TEXT,
            cmd_exit_code INTEGER,
            cmd_status    TEXT CHECK (cmd_status IS NULL OR cmd_status IN
                              ('running','done','skipped','timeout','blocked')),
            cmd_note      TEXT,
            created_at    TEXT NOT NULL
        );

        -- Ordered fetch, and it makes delete-then-insert provably free of
        -- duplicate sort_orders. Also the child-side index ON DELETE CASCADE
        -- needs to avoid a table scan per parent delete.
        CREATE UNIQUE INDEX idx_archived_messages_order
            ON archived_messages(session_id, sort_order);

        -- command_history has been written since v1 with no session_id index,
        -- because nothing ever queried it that way. The archive counts a
        -- session's commands once, at close; this keeps that a lookup rather
        -- than a full scan of a table that is never pruned.
        CREATE INDEX idx_history_session ON command_history(session_id);

        INSERT INTO schema_version (version) VALUES (4);
        COMMIT;
        "#,
    )
    .map_err(|e| format!("migration v4 failed: {e}"))
}

fn migrate_v5(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        BEGIN;
        -- Files attached to a chat turn. METADATA AND A PATH, never the bytes:
        -- `archive_put` runs inside a ~500ms budget on the tab-close path, and a
        -- few MB of base64 per image would blow it. The bytes live under
        -- <app_data>/attachments/<session_id>/ and are removed alongside the
        -- session by `commands::attachments::remove_archive_attachments` —
        -- CASCADE takes care of these rows but cannot touch the filesystem.
        --
        -- A text attachment's CONTENT is deliberately absent: it was folded into
        -- the message's own `content` at send time, so storing it again would
        -- duplicate the transcript. These rows exist to redraw the chips.
        CREATE TABLE archived_attachments (
            id          TEXT PRIMARY KEY,
            message_id  TEXT NOT NULL
                        REFERENCES archived_messages(id) ON DELETE CASCADE,
            -- Dense, 0-based, from the array index — the only ordering, for the
            -- same reason archived_messages does not trust created_at.
            sort_order  INTEGER NOT NULL,
            kind        TEXT NOT NULL CHECK (kind IN ('image','text')),
            name        TEXT NOT NULL,
            media_type  TEXT NOT NULL,
            bytes       INTEGER NOT NULL,
            -- NULL when the disk write failed. The chip then renders by name
            -- instead of as a thumbnail, which is the honest outcome.
            path        TEXT,
            width       INTEGER,
            height      INTEGER
        );

        -- Ordered fetch per message, and the child-side index ON DELETE CASCADE
        -- needs to avoid a table scan per parent delete.
        CREATE UNIQUE INDEX idx_archived_attachments_order
            ON archived_attachments(message_id, sort_order);

        INSERT INTO schema_version (version) VALUES (5);
        COMMIT;
        "#,
    )
    .map_err(|e| format!("migration v5 failed: {e}"))
}

fn migrate_v7(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        BEGIN;
        -- A reopened archive is collapsed only after the whole app-exit
        -- barrier succeeds. The open archive row is otherwise crash-recoverable,
        -- so deleting its source during preparation would be data loss when an
        -- update or quit is abandoned.
        CREATE TABLE archive_pending_supersedes (
            session_id            TEXT PRIMARY KEY
                                  REFERENCES archived_sessions(session_id)
                                  ON DELETE CASCADE,
            supersedes_session_id TEXT NOT NULL
        );
        INSERT INTO schema_version (version) VALUES (7);
        COMMIT;
        "#,
    )
    .map_err(|e| format!("migration v7 failed: {e}"))
}

fn migrate_v11(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        BEGIN;
        -- Sidecar command cards keep their execution destination after the live
        -- pairing is gone. Nullable keeps every pre-sidecar archive valid.
        ALTER TABLE archived_messages ADD COLUMN cmd_target_role TEXT
            CHECK (cmd_target_role IS NULL OR cmd_target_role IN ('local','remote'));
        ALTER TABLE archived_messages ADD COLUMN cmd_target_label TEXT;
        INSERT INTO schema_version (version) VALUES (11);
        COMMIT;
        "#,
    )
    .map_err(|e| format!("migration v11 failed: {e}"))
}

fn migrate_v12(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        BEGIN;
        -- Terminal-independent Chat workspace threads. These deliberately do
        -- not share archived_sessions: a chat may be active for months, has no
        -- shell/scrollback lifecycle, and is retained until explicit deletion.
        CREATE TABLE chat_threads (
            id                   TEXT PRIMARY KEY,
            title                TEXT NOT NULL DEFAULT 'New chat',
            title_source         TEXT NOT NULL DEFAULT 'placeholder'
                                 CHECK (title_source IN
                                   ('placeholder','fallback','generated','manual')),
            created_at           TEXT NOT NULL,
            updated_at           TEXT NOT NULL,
            archived_at          TEXT,
            attached_bucket_refs TEXT NOT NULL DEFAULT '[]',
            model_transcript     TEXT,
            transcript_version   INTEGER NOT NULL DEFAULT 1
        );
        CREATE INDEX idx_chat_threads_active
            ON chat_threads(archived_at, updated_at DESC);

        CREATE TABLE chat_messages (
            id                TEXT PRIMARY KEY,
            chat_id           TEXT NOT NULL
                              REFERENCES chat_threads(id) ON DELETE CASCADE,
            sort_order        INTEGER NOT NULL,
            role              TEXT NOT NULL CHECK (role IN ('user','assistant')),
            content           TEXT NOT NULL,
            thinking          TEXT,
            model             TEXT,
            prompt_tokens     INTEGER,
            completion_tokens INTEGER,
            citations         TEXT NOT NULL DEFAULT '[]',
            created_at        TEXT NOT NULL
        );
        CREATE UNIQUE INDEX idx_chat_messages_order
            ON chat_messages(chat_id, sort_order);

        CREATE TABLE chat_attachments (
            id         TEXT PRIMARY KEY,
            message_id TEXT NOT NULL
                       REFERENCES chat_messages(id) ON DELETE CASCADE,
            sort_order INTEGER NOT NULL,
            kind       TEXT NOT NULL CHECK (kind IN ('image','text')),
            name       TEXT NOT NULL,
            media_type TEXT NOT NULL,
            bytes      INTEGER NOT NULL,
            path       TEXT,
            width      INTEGER,
            height     INTEGER
        );
        CREATE UNIQUE INDEX idx_chat_attachments_order
            ON chat_attachments(message_id, sort_order);
        CREATE INDEX idx_chat_attachments_path ON chat_attachments(path)
            WHERE path IS NOT NULL;

        INSERT INTO schema_version (version) VALUES (12);
        COMMIT;
        "#,
    )
    .map_err(|e| format!("migration v12 failed: {e}"))
}

fn migrate_v13(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        BEGIN;
        -- Presence only. The password itself lives in macOS Keychain or
        -- Windows Credential Manager and never enters this plaintext database.
        ALTER TABLE ssh_hosts ADD COLUMN has_password INTEGER NOT NULL DEFAULT 0
            CHECK (has_password IN (0, 1));
        INSERT INTO schema_version (version) VALUES (13);
        COMMIT;
        "#,
    )
    .map_err(|e| format!("migration v13 failed: {e}"))
}

fn migrate_v14(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        BEGIN;
        -- Preserve the effective output boundary on restored Agent cards.
        -- Existing cards predate private output and therefore remain normal.
        ALTER TABLE archived_messages ADD COLUMN cmd_output_policy TEXT NOT NULL DEFAULT 'normal'
            CHECK (cmd_output_policy IN ('normal','private'));
        INSERT INTO schema_version (version) VALUES (14);
        COMMIT;
        "#,
    )
    .map_err(|e| format!("migration v14 failed: {e}"))
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;

    fn mem() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        conn
    }

    fn version(conn: &Connection) -> i64 {
        conn.query_row(
            "SELECT COALESCE(MAX(version), 0) FROM schema_version",
            [],
            |r| r.get(0),
        )
        .unwrap()
    }

    #[test]
    fn run_is_idempotent() {
        let conn = mem();
        super::run(&conn).unwrap();
        let first = version(&conn);
        super::run(&conn).unwrap();
        assert_eq!(version(&conn), first);
        assert_eq!(first, 14);
    }

    #[test]
    fn v11_to_v12_adds_terminal_independent_chat_tables() {
        let conn = mem();
        conn.execute_batch("CREATE TABLE schema_version (version INTEGER PRIMARY KEY);")
            .unwrap();
        super::migrate_v1(&conn).unwrap();
        super::migrate_v2(&conn).unwrap();
        super::migrate_v3(&conn).unwrap();
        super::migrate_v4(&conn).unwrap();
        super::migrate_v5(&conn).unwrap();
        crate::runbooks::db::migrate_v6(&conn).unwrap();
        super::migrate_v7(&conn).unwrap();
        crate::runbooks::db::migrate_v8(&conn).unwrap();
        crate::runbooks::db::migrate_v9(&conn).unwrap();
        crate::runbooks::db::migrate_v10(&conn).unwrap();
        super::migrate_v11(&conn).unwrap();
        assert_eq!(version(&conn), 11);

        super::run(&conn).unwrap();

        assert_eq!(version(&conn), 14);
        let tables: Vec<String> = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'chat_%' ORDER BY name")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(
            tables,
            vec!["chat_attachments", "chat_messages", "chat_threads"]
        );
    }

    #[test]
    fn v11_preserves_old_cards_and_adds_checked_sidecar_provenance() {
        let conn = mem();
        conn.execute_batch("CREATE TABLE schema_version (version INTEGER PRIMARY KEY);")
            .unwrap();
        super::migrate_v1(&conn).unwrap();
        super::migrate_v2(&conn).unwrap();
        super::migrate_v3(&conn).unwrap();
        super::migrate_v4(&conn).unwrap();
        super::migrate_v5(&conn).unwrap();
        crate::runbooks::db::migrate_v6(&conn).unwrap();
        super::migrate_v7(&conn).unwrap();
        crate::runbooks::db::migrate_v8(&conn).unwrap();
        crate::runbooks::db::migrate_v9(&conn).unwrap();
        crate::runbooks::db::migrate_v10(&conn).unwrap();
        assert_eq!(version(&conn), 10);

        // A real pre-Sidecar command row, deliberately inserted before the new
        // columns exist. The migration must preserve it and backfill NULLs.
        conn.execute_batch(
            r#"
            INSERT INTO archived_sessions
                (session_id, title, shell, cwd, cols, rows, opened_at, closed_at,
                 updated_at, is_open)
            VALUES ('s1', 't', '/bin/zsh', NULL, 80, 24, '2026-01-01T00:00:00Z',
                    '2026-01-01T00:01:00Z', '2026-01-01T00:01:00Z', 0);
            INSERT INTO archived_messages
                (id, session_id, sort_order, role, kind, content, cmd_command,
                 cmd_output, cmd_exit_code, cmd_status, created_at)
            VALUES ('s1:0', 's1', 0, 'assistant', 'command', '', 'pwd', '/srv', 0,
                    'done', '2026-01-01T00:00:01Z');
            "#,
        )
        .unwrap();

        super::run(&conn).unwrap();
        assert_eq!(version(&conn), 14);
        let migrated: (String, Option<String>, Option<String>) = conn
            .query_row(
                "SELECT cmd_command, cmd_target_role, cmd_target_label
                   FROM archived_messages WHERE id = 's1:0'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(migrated, ("pwd".into(), None, None));

        conn.execute(
            "UPDATE archived_messages
                SET cmd_target_role = 'remote', cmd_target_label = 'deploy@prod-01'
              WHERE id = 's1:0'",
            [],
        )
        .unwrap();
        assert!(
            conn.execute(
                "UPDATE archived_messages SET cmd_target_role = 'somewhere' WHERE id = 's1:0'",
                [],
            )
            .is_err(),
            "the role CHECK must reject values the frontend cannot render"
        );
    }

    /// The migration chain is append-only, so this asserts the shape a v4
    /// database upgrades INTO — including the CASCADE, which is the only thing
    /// pruning a session relies on to clear its attachment rows.
    #[test]
    fn v5_adds_attachments_that_cascade_with_their_message() {
        let conn = mem();
        super::run(&conn).unwrap();

        conn.execute_batch(
            r#"
            INSERT INTO archived_sessions
                (session_id, title, shell, cwd, cols, rows, opened_at, closed_at,
                 updated_at, is_open)
            VALUES ('s1', 't', '/bin/zsh', NULL, 80, 24, '2026-01-01T00:00:00Z',
                    '2026-01-01T00:01:00Z', '2026-01-01T00:01:00Z', 0);
            INSERT INTO archived_messages
                (id, session_id, sort_order, role, kind, content, created_at)
            VALUES ('s1:0', 's1', 0, 'user', 'text', 'what is this',
                    '2026-01-01T00:00:00Z');
            INSERT INTO archived_attachments
                (id, message_id, sort_order, kind, name, media_type, bytes, path,
                 width, height)
            VALUES ('s1:0:0', 's1:0', 0, 'image', 'shot.png', 'image/png', 2048,
                    '/tmp/shot.png', 1568, 980);
            "#,
        )
        .unwrap();

        let count = |conn: &Connection| -> i64 {
            conn.query_row("SELECT COUNT(*) FROM archived_attachments", [], |r| {
                r.get(0)
            })
            .unwrap()
        };
        assert_eq!(count(&conn), 1);

        // Deleting the SESSION must reach the attachment two levels down.
        conn.execute("DELETE FROM archived_sessions WHERE session_id = 's1'", [])
            .unwrap();
        assert_eq!(count(&conn), 0);
    }

    #[test]
    fn v5_rejects_an_unknown_attachment_kind() {
        let conn = mem();
        super::run(&conn).unwrap();
        conn.execute_batch(
            r#"
            INSERT INTO archived_sessions
                (session_id, title, shell, cwd, cols, rows, opened_at, closed_at,
                 updated_at, is_open)
            VALUES ('s1', 't', '/bin/zsh', NULL, 80, 24, '2026-01-01T00:00:00Z',
                    '2026-01-01T00:01:00Z', '2026-01-01T00:01:00Z', 0);
            INSERT INTO archived_messages
                (id, session_id, sort_order, role, kind, content, created_at)
            VALUES ('s1:0', 's1', 0, 'user', 'text', 'x', '2026-01-01T00:00:00Z');
            "#,
        )
        .unwrap();
        let err = conn.execute(
            "INSERT INTO archived_attachments
                (id, message_id, sort_order, kind, name, media_type, bytes)
             VALUES ('a', 's1:0', 0, 'video', 'x.mp4', 'video/mp4', 1)",
            [],
        );
        assert!(err.is_err(), "the CHECK must reject an unknown kind");
    }

    #[test]
    fn v1_data_survives_v2() {
        // The flat `if version < N` chain is exactly the kind of code that rots
        // quietly — pin that an upgrade preserves existing rows.
        let conn = mem();
        // Stand up a v1-only database the way `run` would have left it.
        conn.execute_batch("CREATE TABLE schema_version (version INTEGER PRIMARY KEY);")
            .unwrap();
        super::migrate_v1(&conn).unwrap();
        assert_eq!(version(&conn), 1);
        conn.execute(
            "INSERT INTO command_history (id, session_id, cwd, command, shell, started_at)
             VALUES ('h1', 's1', '/tmp', 'echo hi', 'zsh', '2026-01-01T00:00:00Z')",
            [],
        )
        .unwrap();
        super::run(&conn).unwrap();
        assert_eq!(version(&conn), 14);
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM command_history", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1);
    }

    #[test]
    fn a_v6_runbook_source_upgrades_to_a_visible_user_source() {
        let conn = mem();
        conn.execute_batch("CREATE TABLE schema_version (version INTEGER PRIMARY KEY);")
            .unwrap();
        // A database at v6 necessarily passed through the app-owned v1-v5
        // migrations too. Keeping the fixture faithful matters now that v11
        // extends the archive table created by v4.
        super::migrate_v1(&conn).unwrap();
        super::migrate_v2(&conn).unwrap();
        super::migrate_v3(&conn).unwrap();
        super::migrate_v4(&conn).unwrap();
        super::migrate_v5(&conn).unwrap();
        crate::runbooks::db::migrate_v6(&conn).unwrap();
        conn.execute(
            "INSERT INTO runbook_sources
               (id, package_path, definition_id, definition_version, title,
                source_sha256, canonical_sha256, valid, created_at, updated_at)
             VALUES ('source', '/tmp/source', 'existing', '1.2.3', 'Existing',
                     ?1, ?2, 1, 'created', 'updated')",
            rusqlite::params!["a".repeat(64), "b".repeat(64)],
        )
        .unwrap();

        super::run(&conn).unwrap();

        assert_eq!(version(&conn), 14);
        let migrated: (String, i64, Option<i64>, String, String) = conn
            .query_row(
                "SELECT source_kind, hidden, builtin_order, created_at, updated_at
                 FROM runbook_sources WHERE id = 'source'",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(
            migrated,
            ("user".into(), 0, None, "created".into(), "updated".into())
        );
    }

    #[test]
    fn a_v8_database_gains_resumable_runbook_drafts() {
        let conn = mem();
        conn.execute_batch("CREATE TABLE schema_version (version INTEGER PRIMARY KEY);")
            .unwrap();
        super::migrate_v1(&conn).unwrap();
        super::migrate_v2(&conn).unwrap();
        super::migrate_v3(&conn).unwrap();
        super::migrate_v4(&conn).unwrap();
        super::migrate_v5(&conn).unwrap();
        crate::runbooks::db::migrate_v6(&conn).unwrap();
        super::migrate_v7(&conn).unwrap();
        crate::runbooks::db::migrate_v8(&conn).unwrap();

        assert_eq!(version(&conn), 8);

        super::run(&conn).unwrap();

        assert_eq!(version(&conn), 14);
        let columns: Vec<String> = conn
            .prepare("PRAGMA table_info(runbook_drafts)")
            .unwrap()
            .query_map([], |row| row.get(1))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert!(columns.contains(&"revision".into()));
        assert!(columns.contains(&"last_published_document_sha256".into()));
    }

    #[test]
    fn a_v2_database_gains_the_workspace_tables() {
        // The real upgrade path: a database that stopped at v2 (saved hosts but
        // no session restore) must pick up v3 on the next launch. This is the
        // case that would have been silently missed had the workspace tables
        // been appended to migrate_v2 instead of getting their own migration.
        let conn = mem();
        conn.execute_batch("CREATE TABLE schema_version (version INTEGER PRIMARY KEY);")
            .unwrap();
        super::migrate_v1(&conn).unwrap();
        super::migrate_v2(&conn).unwrap();
        conn.execute(
            "INSERT INTO ssh_hosts (id, label, hostname, created_at, updated_at)
             VALUES ('h1', 'Prod', 'prod-01', 'now', 'now')",
            [],
        )
        .unwrap();
        assert_eq!(version(&conn), 2);

        super::run(&conn).unwrap();

        // Upgrades run the whole chain, so this lands on the current head.
        assert_eq!(version(&conn), 14);
        let tables: Vec<String> = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert!(
            tables.contains(&"workspace_state".to_string()),
            "got {tables:?}"
        );
        assert!(
            tables.contains(&"session_snapshots".to_string()),
            "got {tables:?}"
        );
        // And the saved host survived the upgrade.
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM ssh_hosts", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1);
    }

    #[test]
    fn a_v3_database_gains_the_archive_tables() {
        // The sibling of the v2 case above: a database that stopped at v3
        // (session restore but no archive) must pick up v4, and — the part worth
        // pinning — its stored snapshot rows must survive, because v4 drops two
        // tables and a careless DROP would be easy to point at the wrong one.
        let conn = mem();
        conn.execute_batch("CREATE TABLE schema_version (version INTEGER PRIMARY KEY);")
            .unwrap();
        super::migrate_v1(&conn).unwrap();
        super::migrate_v2(&conn).unwrap();
        super::migrate_v3(&conn).unwrap();
        conn.execute(
            "INSERT INTO session_snapshots
                (session_id, generation, tab_index, title, shell, created_at, updated_at)
             VALUES ('s1', 1, 0, 'tab', '/bin/zsh', 'now', 'now')",
            [],
        )
        .unwrap();
        assert_eq!(version(&conn), 3);

        super::run(&conn).unwrap();

        assert_eq!(version(&conn), 14);
        let tables: Vec<String> = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert!(
            tables.contains(&"archived_sessions".to_string()),
            "got {tables:?}"
        );
        assert!(
            tables.contains(&"archived_messages".to_string()),
            "got {tables:?}"
        );
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM session_snapshots", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1, "v4 must not disturb session_snapshots");
    }

    #[test]
    fn v4_supersedes_the_dead_conversation_tables() {
        // v1 created `conversations`/`ai_messages` and nothing ever wrote to
        // them. v4 replaces them; everything else v1 and v2 created stays.
        let conn = mem();
        super::run(&conn).unwrap();
        let tables: Vec<String> = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert!(
            !tables.contains(&"conversations".to_string()),
            "got {tables:?}"
        );
        assert!(
            !tables.contains(&"ai_messages".to_string()),
            "got {tables:?}"
        );
        for kept in [
            "command_history",
            "ssh_hosts",
            "session_snapshots",
            "workspace_state",
        ] {
            assert!(
                tables.contains(&kept.to_string()),
                "{kept} missing, got {tables:?}"
            );
        }
    }

    #[test]
    fn the_history_session_index_exists() {
        // The archive's per-session command count depends on it, and an index is
        // exactly the kind of thing a later hand-edited migration drops silently.
        let conn = mem();
        super::run(&conn).unwrap();
        let indices: Vec<String> = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='index'")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert!(
            indices.contains(&"idx_history_session".to_string()),
            "got {indices:?}"
        );
    }

    #[test]
    fn ssh_password_migration_adds_presence_without_secret_storage() {
        let conn = mem();
        super::run(&conn).unwrap();
        conn.execute(
            "INSERT INTO ssh_hosts (id, label, hostname, created_at, updated_at)
             VALUES ('h1', 'Prod', 'prod-01', 'now', 'now')",
            [],
        )
        .unwrap();
        let has_password: bool = conn
            .query_row(
                "SELECT has_password FROM ssh_hosts WHERE id = 'h1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!has_password);

        let columns: Vec<String> = conn
            .prepare("PRAGMA table_info(ssh_hosts)")
            .unwrap()
            .query_map([], |row| row.get(1))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert!(columns.contains(&"has_password".into()));
        assert!(!columns.iter().any(|column| column == "password"));
    }

    #[test]
    fn alias_index_is_partial() {
        let conn = mem();
        super::run(&conn).unwrap();
        let insert = |id: &str, label: &str, alias: Option<&str>| {
            conn.execute(
                "INSERT INTO ssh_hosts (id, label, hostname, config_alias, created_at, updated_at)
                 VALUES (?1, ?2, 'h', ?3, 'now', 'now')",
                rusqlite::params![id, label, alias],
            )
        };
        // Any number of NULL aliases coexist...
        insert("a", "A", None).unwrap();
        insert("b", "B", None).unwrap();
        // ...but a real alias is unique, case-insensitively.
        insert("c", "C", Some("prod")).unwrap();
        assert!(insert("d", "D", Some("PROD")).is_err());
        // And labels are unique regardless of case.
        assert!(insert("e", "a", None).is_err());
    }
}
