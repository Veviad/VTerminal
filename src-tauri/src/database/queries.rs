use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
pub struct HistoryEntryInput {
    pub session_id: String,
    pub cwd: String,
    pub command: String,
    pub exit_code: Option<i32>,
    pub duration_ms: Option<i64>,
    pub output_tail: Option<String>,
    pub git_branch: Option<String>,
    pub started_at: String,
}

#[derive(Debug, Serialize)]
pub struct HistoryEntry {
    pub id: String,
    pub session_id: String,
    pub cwd: String,
    pub command: String,
    pub exit_code: Option<i32>,
    pub duration_ms: Option<i64>,
    pub output_tail: Option<String>,
    pub git_branch: Option<String>,
    pub shell: String,
    pub started_at: String,
    pub ended_at: Option<String>,
}

pub fn insert_history(
    conn: &Connection,
    entry: &HistoryEntryInput,
    shell: &str,
) -> Result<String, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let ended_at = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO command_history
            (id, session_id, cwd, command, exit_code, duration_ms, output_tail, git_branch, shell, started_at, ended_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            id,
            entry.session_id,
            entry.cwd,
            entry.command,
            entry.exit_code,
            entry.duration_ms,
            entry.output_tail,
            entry.git_branch,
            shell,
            entry.started_at,
            ended_at,
        ],
    )
    .map_err(|e| format!("insert history: {e}"))?;
    Ok(id)
}

fn row_to_entry(row: &rusqlite::Row<'_>) -> rusqlite::Result<HistoryEntry> {
    Ok(HistoryEntry {
        id: row.get(0)?,
        session_id: row.get(1)?,
        cwd: row.get(2)?,
        command: row.get(3)?,
        exit_code: row.get(4)?,
        duration_ms: row.get(5)?,
        output_tail: row.get(6)?,
        git_branch: row.get(7)?,
        shell: row.get(8)?,
        started_at: row.get(9)?,
        ended_at: row.get(10)?,
    })
}

const HISTORY_COLS: &str =
    "id, session_id, cwd, command, exit_code, duration_ms, output_tail, git_branch, shell, started_at, ended_at";

/// Latest run per distinct command, newest first.
pub fn recent_history(conn: &Connection, limit: u32) -> Result<Vec<HistoryEntry>, String> {
    let sql = format!(
        "SELECT {HISTORY_COLS} FROM command_history
         WHERE id IN (SELECT id FROM command_history GROUP BY command HAVING MAX(started_at))
         ORDER BY started_at DESC LIMIT ?1"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![limit], row_to_entry)
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

pub fn search_history(
    conn: &Connection,
    query: &str,
    limit: u32,
    offset: u32,
) -> Result<Vec<HistoryEntry>, String> {
    // Escape the escape character itself FIRST, or user backslashes swallow
    // the escapes added for % and _.
    let pattern = format!(
        "%{}%",
        query
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_")
    );
    let sql = format!(
        "SELECT {HISTORY_COLS} FROM command_history
         WHERE command LIKE ?1 ESCAPE '\\'
         ORDER BY started_at DESC LIMIT ?2 OFFSET ?3"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![pattern, limit, offset], row_to_entry)
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

pub fn clear_history(conn: &Connection) -> Result<(), String> {
    conn.execute("DELETE FROM command_history", [])
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ---------- SSH hosts ----------

/// What the frontend sends. No password/passphrase field exists by design —
/// see the `ssh_hosts` table comment in migrations.rs.
///
/// Also `Serialize`, because the ~/.ssh/config importer hands parsed candidates
/// back to the UI for review in exactly this shape before they are inserted.
#[derive(Debug, Default, Deserialize, Serialize)]
pub struct SshHostInput {
    pub label: String,
    pub hostname: String,
    pub username: Option<String>,
    pub port: Option<u16>,
    pub identity_file: Option<String>,
    pub jump_host: Option<String>,
    pub extra_args: Option<String>,
    pub remote_dir: Option<String>,
    pub post_connect: Option<String>,
    pub tag: Option<String>,
    pub color: Option<String>,
    #[serde(default = "default_source")]
    pub source: String,
    #[serde(default)]
    pub config_alias: Option<String>,
}

fn default_source() -> String {
    "manual".to_string()
}

#[derive(Debug, Serialize)]
pub struct SshHost {
    pub id: String,
    pub label: String,
    pub hostname: String,
    pub username: Option<String>,
    pub port: Option<u16>,
    pub identity_file: Option<String>,
    pub jump_host: Option<String>,
    pub extra_args: Option<String>,
    pub remote_dir: Option<String>,
    pub post_connect: Option<String>,
    pub tag: Option<String>,
    pub color: Option<String>,
    pub source: String,
    pub config_alias: Option<String>,
    pub use_count: i64,
    pub last_used_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

const SSH_HOST_COLS: &str = "id, label, hostname, username, port, identity_file, jump_host, \
     extra_args, remote_dir, post_connect, tag, color, source, config_alias, use_count, \
     last_used_at, created_at, updated_at";

fn row_to_ssh_host(row: &rusqlite::Row<'_>) -> rusqlite::Result<SshHost> {
    Ok(SshHost {
        id: row.get(0)?,
        label: row.get(1)?,
        hostname: row.get(2)?,
        username: row.get(3)?,
        port: row.get(4)?,
        identity_file: row.get(5)?,
        jump_host: row.get(6)?,
        extra_args: row.get(7)?,
        remote_dir: row.get(8)?,
        post_connect: row.get(9)?,
        tag: row.get(10)?,
        color: row.get(11)?,
        source: row.get(12)?,
        config_alias: row.get(13)?,
        use_count: row.get(14)?,
        last_used_at: row.get(15)?,
        created_at: row.get(16)?,
        updated_at: row.get(17)?,
    })
}

/// A raw `UNIQUE constraint failed: ssh_hosts.label` is unusable in a form.
fn map_ssh_host_err(e: rusqlite::Error, label: &str) -> String {
    let s = e.to_string();
    if s.contains("ssh_hosts.label") {
        format!("a host named \"{label}\" already exists")
    } else if s.contains("ssh_hosts.config_alias") {
        format!("\"{label}\" was already imported from ~/.ssh/config")
    } else {
        format!("save host: {s}")
    }
}

/// Frecency order: most-used first, then most-recent, then alphabetical.
pub fn list_ssh_hosts(conn: &Connection) -> Result<Vec<SshHost>, String> {
    let sql = format!(
        "SELECT {SSH_HOST_COLS} FROM ssh_hosts
         ORDER BY use_count DESC, COALESCE(last_used_at, '') DESC, label COLLATE NOCASE ASC"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], row_to_ssh_host)
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

pub fn get_ssh_host(conn: &Connection, id: &str) -> Result<Option<SshHost>, String> {
    let sql = format!("SELECT {SSH_HOST_COLS} FROM ssh_hosts WHERE id = ?1");
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let mut rows = stmt
        .query_map(params![id], row_to_ssh_host)
        .map_err(|e| e.to_string())?;
    match rows.next() {
        Some(row) => Ok(Some(row.map_err(|e| e.to_string())?)),
        None => Ok(None),
    }
}

pub fn insert_ssh_host(conn: &Connection, h: &SshHostInput) -> Result<String, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO ssh_hosts
            (id, label, hostname, username, port, identity_file, jump_host, extra_args,
             remote_dir, post_connect, tag, color, source, config_alias,
             use_count, last_used_at, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, 0, NULL, ?15, ?15)",
        params![
            id,
            h.label,
            h.hostname,
            h.username,
            h.port,
            h.identity_file,
            h.jump_host,
            h.extra_args,
            h.remote_dir,
            h.post_connect,
            h.tag,
            h.color,
            h.source,
            h.config_alias,
            now,
        ],
    )
    .map_err(|e| map_ssh_host_err(e, &h.label))?;
    Ok(id)
}

/// Config edit. Deliberately leaves `use_count`/`last_used_at` alone — those
/// belong to `touch_ssh_host`.
pub fn update_ssh_host(conn: &Connection, id: &str, h: &SshHostInput) -> Result<(), String> {
    let now = chrono::Utc::now().to_rfc3339();
    let n = conn
        .execute(
            "UPDATE ssh_hosts SET
                label = ?2, hostname = ?3, username = ?4, port = ?5, identity_file = ?6,
                jump_host = ?7, extra_args = ?8, remote_dir = ?9, post_connect = ?10,
                tag = ?11, color = ?12, updated_at = ?13
             WHERE id = ?1",
            params![
                id,
                h.label,
                h.hostname,
                h.username,
                h.port,
                h.identity_file,
                h.jump_host,
                h.extra_args,
                h.remote_dir,
                h.post_connect,
                h.tag,
                h.color,
                now,
            ],
        )
        .map_err(|e| map_ssh_host_err(e, &h.label))?;
    if n == 0 {
        return Err(format!("no ssh host {id}"));
    }
    Ok(())
}

pub fn delete_ssh_host(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM ssh_hosts WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Frecency bump. Not `updated_at` — that means "the config changed".
pub fn touch_ssh_host(conn: &Connection, id: &str) -> Result<(), String> {
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE ssh_hosts SET use_count = use_count + 1, last_used_at = ?2 WHERE id = ?1",
        params![id, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Import dedupe: match the config alias first, then the normalized
/// (hostname, username, port) triple so a hand-added row is recognised too.
pub fn find_ssh_host_duplicate(
    conn: &Connection,
    alias: Option<&str>,
    hostname: &str,
    username: Option<&str>,
    port: Option<u16>,
) -> Result<Option<String>, String> {
    if let Some(alias) = alias {
        let mut stmt = conn
            .prepare("SELECT id FROM ssh_hosts WHERE config_alias = ?1 COLLATE NOCASE LIMIT 1")
            .map_err(|e| e.to_string())?;
        let mut rows = stmt
            .query_map(params![alias], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        if let Some(row) = rows.next() {
            return Ok(Some(row.map_err(|e| e.to_string())?));
        }
    }
    let mut stmt = conn
        .prepare(
            "SELECT id FROM ssh_hosts
             WHERE hostname = ?1 COLLATE NOCASE
               AND IFNULL(username, '') = IFNULL(?2, '')
               AND IFNULL(port, 22) = IFNULL(?3, 22)
             LIMIT 1",
        )
        .map_err(|e| e.to_string())?;
    let mut rows = stmt
        .query_map(params![hostname, username, port], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    match rows.next() {
        Some(row) => Ok(Some(row.map_err(|e| e.to_string())?)),
        None => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        crate::database::migrations::run(&conn).unwrap();
        conn
    }

    fn host(label: &str, hostname: &str) -> SshHostInput {
        SshHostInput {
            label: label.into(),
            hostname: hostname.into(),
            source: "manual".into(),
            ..Default::default()
        }
    }

    #[test]
    fn insert_get_roundtrip_preserves_every_field() {
        let conn = mem();
        let mut h = host("Prod", "prod-01");
        h.username = Some("deploy".into());
        h.port = Some(2222);
        h.identity_file = Some("/keys/id_ed25519".into());
        h.jump_host = Some("bastion".into());
        h.extra_args = Some("-o ConnectTimeout=5".into());
        h.remote_dir = Some("/srv/app".into());
        h.post_connect = Some("tmux attach".into());
        h.tag = Some("web".into());
        h.color = Some("accent".into());

        let id = insert_ssh_host(&conn, &h).unwrap();
        let got = get_ssh_host(&conn, &id).unwrap().unwrap();
        assert_eq!(got.label, "Prod");
        assert_eq!(got.username.as_deref(), Some("deploy"));
        assert_eq!(got.port, Some(2222));
        assert_eq!(got.identity_file.as_deref(), Some("/keys/id_ed25519"));
        assert_eq!(got.jump_host.as_deref(), Some("bastion"));
        assert_eq!(got.remote_dir.as_deref(), Some("/srv/app"));
        assert_eq!(got.post_connect.as_deref(), Some("tmux attach"));
        assert_eq!(got.use_count, 0);
        assert_eq!(got.last_used_at, None);
        assert_eq!(got.source, "manual");
    }

    #[test]
    fn nulls_survive_the_roundtrip() {
        let conn = mem();
        let id = insert_ssh_host(&conn, &host("Bare", "bare-01")).unwrap();
        let got = get_ssh_host(&conn, &id).unwrap().unwrap();
        assert_eq!(got.username, None);
        assert_eq!(got.port, None);
        assert_eq!(got.config_alias, None);
    }

    #[test]
    fn duplicate_label_gets_a_readable_error() {
        let conn = mem();
        insert_ssh_host(&conn, &host("Prod", "a")).unwrap();
        let err = insert_ssh_host(&conn, &host("prod", "b")).unwrap_err();
        assert!(err.contains("already exists"), "got: {err}");
        assert!(
            !err.contains("UNIQUE constraint"),
            "raw sqlite error leaked: {err}"
        );
    }

    #[test]
    fn duplicate_config_alias_gets_the_import_error() {
        let conn = mem();
        let mut a = host("A", "a");
        a.config_alias = Some("prod".into());
        a.source = "ssh_config".into();
        insert_ssh_host(&conn, &a).unwrap();

        let mut b = host("B", "b");
        b.config_alias = Some("PROD".into());
        b.source = "ssh_config".into();
        let err = insert_ssh_host(&conn, &b).unwrap_err();
        assert!(err.contains("already imported"), "got: {err}");
    }

    #[test]
    fn touch_bumps_frecency_but_not_updated_at() {
        let conn = mem();
        let id = insert_ssh_host(&conn, &host("Prod", "prod-01")).unwrap();
        let before = get_ssh_host(&conn, &id).unwrap().unwrap();

        touch_ssh_host(&conn, &id).unwrap();
        touch_ssh_host(&conn, &id).unwrap();

        let after = get_ssh_host(&conn, &id).unwrap().unwrap();
        assert_eq!(after.use_count, 2);
        assert!(after.last_used_at.is_some());
        // updated_at means "the config changed" — connecting is not a change.
        assert_eq!(after.updated_at, before.updated_at);
    }

    #[test]
    fn update_leaves_frecency_alone() {
        let conn = mem();
        let id = insert_ssh_host(&conn, &host("Prod", "prod-01")).unwrap();
        touch_ssh_host(&conn, &id).unwrap();

        let mut edited = host("Prod", "prod-02");
        edited.username = Some("root".into());
        update_ssh_host(&conn, &id, &edited).unwrap();

        let got = get_ssh_host(&conn, &id).unwrap().unwrap();
        assert_eq!(got.hostname, "prod-02");
        assert_eq!(got.username.as_deref(), Some("root"));
        assert_eq!(got.use_count, 1);
    }

    #[test]
    fn update_of_a_missing_row_errors() {
        let conn = mem();
        assert!(update_ssh_host(&conn, "nope", &host("X", "x")).is_err());
    }

    #[test]
    fn list_orders_by_frecency_then_label() {
        let conn = mem();
        let a = insert_ssh_host(&conn, &host("Alpha", "a")).unwrap();
        insert_ssh_host(&conn, &host("Bravo", "b")).unwrap();
        let c = insert_ssh_host(&conn, &host("Charlie", "c")).unwrap();

        touch_ssh_host(&conn, &c).unwrap();
        touch_ssh_host(&conn, &c).unwrap();
        touch_ssh_host(&conn, &a).unwrap();

        let labels: Vec<_> = list_ssh_hosts(&conn)
            .unwrap()
            .into_iter()
            .map(|h| h.label)
            .collect();
        // Charlie (2 uses), Alpha (1), then unused Bravo alphabetically last.
        assert_eq!(labels, vec!["Charlie", "Alpha", "Bravo"]);
    }

    #[test]
    fn find_duplicate_matches_alias_then_the_host_triple() {
        let conn = mem();
        let mut a = host("A", "prod-01");
        a.config_alias = Some("prod".into());
        a.username = Some("deploy".into());
        a.port = Some(2222);
        let id = insert_ssh_host(&conn, &a).unwrap();

        // By alias.
        assert_eq!(
            find_ssh_host_duplicate(&conn, Some("prod"), "other", None, None).unwrap(),
            Some(id.clone())
        );
        // By (hostname, username, port).
        assert_eq!(
            find_ssh_host_duplicate(&conn, None, "prod-01", Some("deploy"), Some(2222)).unwrap(),
            Some(id)
        );
        // A different port is a different host.
        assert_eq!(
            find_ssh_host_duplicate(&conn, None, "prod-01", Some("deploy"), Some(22)).unwrap(),
            None
        );
        assert_eq!(
            find_ssh_host_duplicate(&conn, None, "nope", None, None).unwrap(),
            None
        );
    }

    #[test]
    fn delete_removes_the_row() {
        let conn = mem();
        let id = insert_ssh_host(&conn, &host("Prod", "prod-01")).unwrap();
        delete_ssh_host(&conn, &id).unwrap();
        assert!(get_ssh_host(&conn, &id).unwrap().is_none());
    }
}
