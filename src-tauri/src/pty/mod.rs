pub mod session;

use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Arc, Condvar, Mutex};

use session::PtySession;

/// Lifecycle events on the JSON side-channel; the data plane is the separate
/// raw-bytes channel.
#[derive(Clone, Serialize)]
#[serde(tag = "type")]
pub enum PtyEvent {
    Spawned {
        pid: u32,
    },
    Exit {
        exit_code: Option<i32>,
    },
    #[allow(dead_code)] // part of the wire contract; frontend handles it
    Error {
        message: String,
    },
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    Warning {
        message: String,
    },
}

#[derive(Debug)]
struct PtyAdmission {
    accepting: bool,
    in_flight_spawns: usize,
    pending: HashMap<String, bool>,
}

pub struct PtyManager {
    pub sessions: Mutex<HashMap<String, PtySession>>,
    admission: Arc<Mutex<PtyAdmission>>,
    admission_idle: Arc<Condvar>,
}

impl Default for PtyManager {
    fn default() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            admission: Arc::new(Mutex::new(PtyAdmission {
                accepting: true,
                in_flight_spawns: 0,
                pending: HashMap::new(),
            })),
            admission_idle: Arc::new(Condvar::new()),
        }
    }
}

/// Keeps verified shutdown from passing a terminal whose OS process was being
/// created outside the sessions mutex. Cleanup closes admission and waits for
/// every permit; a permit that observes the closed gate kills its new process
/// before releasing the in-flight count.
pub struct PtySpawnPermit {
    admission: Arc<Mutex<PtyAdmission>>,
    admission_idle: Arc<Condvar>,
    session_id: String,
    active: bool,
}

impl PtySpawnPermit {
    pub fn check_active(&self) -> Result<(), String> {
        let admission = self
            .admission
            .lock()
            .map_err(|_| "PTY admission state poisoned".to_string())?;
        if !admission.accepting {
            return Err("terminal creation is disabled while the application is exiting".into());
        }
        if admission.pending.get(&self.session_id) != Some(&false) {
            return Err("terminal creation was cancelled because its tab was closed".into());
        }
        Ok(())
    }

    pub fn insert(mut self, manager: &PtyManager, session: PtySession) -> Result<u32, String> {
        let pid = session.pid;
        let mut session = Some(session);
        let insert_result = match self.admission.lock() {
            Err(_) => Err("PTY admission state poisoned".to_string()),
            Ok(admission) if !admission.accepting => {
                Err("terminal creation is disabled while the application is exiting".to_string())
            }
            Ok(admission) if admission.pending.get(&self.session_id) != Some(&false) => {
                Err("terminal creation was cancelled because its tab was closed".to_string())
            }
            Ok(_admission) => match manager.sessions.lock() {
                Err(_) => Err("pty state poisoned".to_string()),
                Ok(sessions) if sessions.contains_key(&self.session_id) => {
                    Err(format!("session {} already exists", self.session_id))
                }
                Ok(mut sessions) => {
                    sessions.insert(
                        self.session_id.clone(),
                        session
                            .take()
                            .expect("spawned PTY is present before insertion"),
                    );
                    Ok(())
                }
            },
        };

        if insert_result.is_ok() {
            self.release()?;
            return Ok(pid);
        }

        let mut error = insert_result.expect_err("failed PTY insertion has a reason");
        let mut rejected = session.expect("failed PTY insertion retains the spawned session");
        if let Err(kill_error) = rejected.kill_verified() {
            error.push_str(&format!(
                "; additionally could not verify spawned PTY cleanup: {kill_error}"
            ));
            if let Err(retain_error) = manager.retain_failed_spawn(&self.session_id, rejected) {
                error.push_str(&format!(
                    "; additionally could not retain the PTY cleanup handle: {retain_error}"
                ));
            }
        }
        if let Err(release_error) = self.release() {
            error.push_str(&format!(
                "; additionally could not release PTY spawn admission: {release_error}"
            ));
        }
        Err(error)
    }

    fn release(&mut self) -> Result<(), String> {
        if self.active {
            let mut admission = self
                .admission
                .lock()
                .map_err(|_| "PTY admission state poisoned".to_string())?;
            admission.in_flight_spawns = admission
                .in_flight_spawns
                .checked_sub(1)
                .ok_or_else(|| "PTY spawn admission count underflow".to_string())?;
            admission.pending.remove(&self.session_id);
            if admission.in_flight_spawns == 0 {
                self.admission_idle.notify_all();
            }
            self.active = false;
        }
        Ok(())
    }
}

impl Drop for PtySpawnPermit {
    fn drop(&mut self) {
        if let Err(error) = self.release() {
            log::error!("could not release PTY spawn permit: {error}");
        }
    }
}

impl PtyManager {
    pub fn begin_spawn(&self, session_id: String) -> Result<PtySpawnPermit, String> {
        let mut admission = self
            .admission
            .lock()
            .map_err(|_| "PTY admission state poisoned".to_string())?;
        if !admission.accepting {
            return Err("terminal creation is disabled while the application is exiting".into());
        }
        if admission.pending.contains_key(&session_id) {
            return Err(format!("session {session_id} is already being created"));
        }
        if self
            .sessions
            .lock()
            .map_err(|_| "pty state poisoned".to_string())?
            .contains_key(&session_id)
        {
            return Err(format!("session {session_id} already exists"));
        }
        admission.in_flight_spawns = admission
            .in_flight_spawns
            .checked_add(1)
            .ok_or_else(|| "too many in-flight PTY spawns".to_string())?;
        admission.pending.insert(session_id.clone(), false);
        Ok(PtySpawnPermit {
            admission: Arc::clone(&self.admission),
            admission_idle: Arc::clone(&self.admission_idle),
            session_id,
            active: true,
        })
    }

    fn retain_failed_spawn(&self, session_id: &str, session: PtySession) -> Result<(), String> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "pty state poisoned while retaining failed spawn cleanup".to_string())?;
        let retained_id = if sessions.contains_key(session_id) {
            format!("{session_id}#cleanup-{}", uuid::Uuid::new_v4())
        } else {
            session_id.to_string()
        };
        sessions.insert(retained_id, session);
        Ok(())
    }

    #[cfg(test)]
    fn enable_admission(&self) -> Result<(), String> {
        self.admission
            .lock()
            .map_err(|_| "PTY admission state poisoned".to_string())?
            .accepting = true;
        Ok(())
    }

    pub fn list(&self) -> Vec<String> {
        self.sessions
            .lock()
            .map(|s| s.keys().cloned().collect())
            .unwrap_or_default()
    }

    /// Write a credential directly from the backend vault into a PTY. The
    /// frontend requests the action but never receives the secret bytes.
    pub fn write_secret_line(
        &self,
        session_id: &str,
        secret: &crate::credentials::Secret,
    ) -> Result<(), String> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| "pty state poisoned".to_string())?;
        let session = sessions
            .get(session_id)
            .ok_or_else(|| format!("no session {session_id}"))?;
        session.write_secret_line(secret)
    }

    /// Close one PTY without losing the only cleanup handle on a verification
    /// failure. Holding the admission lock prevents a same-id spawn from
    /// occupying the map slot before the failed session is restored.
    pub fn kill_session_verified(&self, session_id: &str) -> Result<(), String> {
        let mut admission = self
            .admission
            .lock()
            .map_err(|_| "PTY admission state poisoned".to_string())?;
        let pending = if let Some(cancelled) = admission.pending.get_mut(session_id) {
            *cancelled = true;
            true
        } else {
            false
        };
        let session = self
            .sessions
            .lock()
            .map_err(|_| "pty state poisoned".to_string())?
            .remove(session_id);
        let Some(mut session) = session else {
            return if pending {
                Ok(())
            } else {
                Err(format!("no session {session_id}"))
            };
        };
        match session.kill_verified() {
            Ok(()) => Ok(()),
            Err(kill_error) => {
                self.sessions
                    .lock()
                    .map_err(|_| {
                        format!(
                            "{kill_error}; additionally could not retain the PTY cleanup handle"
                        )
                    })?
                    .insert(session_id.to_string(), session);
                Err(kill_error)
            }
        }
    }

    /// Drain every registered terminal and require platform cleanup to be
    /// verifiable. This is intentionally separate from window-destroy cleanup,
    /// where there is no longer a useful error surface for the user.
    pub fn kill_all_verified(&self) -> Result<(), String> {
        let sessions: Vec<(String, PtySession)> = {
            let mut admission = self
                .admission
                .lock()
                .map_err(|_| "PTY admission state poisoned".to_string())?;
            admission.accepting = false;
            while admission.in_flight_spawns != 0 {
                admission = self
                    .admission_idle
                    .wait(admission)
                    .map_err(|_| "PTY admission state poisoned while waiting for spawns")?;
            }
            self.sessions
                .lock()
                .map_err(|_| "pty state poisoned".to_string())?
                .drain()
                .collect()
        };
        let mut failures = Vec::new();
        let mut retryable = Vec::new();
        for (id, mut session) in sessions {
            if let Err(error) = session.kill_verified() {
                failures.push(format!("{id}: {error}"));
                retryable.push((id, session));
            }
        }
        if !retryable.is_empty() {
            self.sessions
                .lock()
                .map_err(|_| "pty state poisoned while retaining failed cleanup".to_string())?
                .extend(retryable);
        }
        if failures.is_empty() {
            Ok(())
        } else {
            Err(format!(
                "could not safely close all terminal sessions: {}",
                failures.join("; ")
            ))
        }
    }

    #[cfg(test)]
    fn admission_is_open(&self) -> bool {
        self.admission
            .lock()
            .map(|admission| admission.accepting)
            .unwrap_or(false)
    }
}

#[cfg(test)]
mod tests {
    use super::PtyManager;
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    #[test]
    fn closing_a_queued_spawn_cancels_its_owned_permit() {
        let manager = PtyManager::default();
        let permit = manager.begin_spawn("queued".into()).unwrap();
        assert!(manager.begin_spawn("queued".into()).is_err());
        manager.kill_session_verified("queued").unwrap();
        let worker = std::thread::spawn(move || permit.check_active());
        assert!(worker.join().unwrap().unwrap_err().contains("cancelled"));
        assert!(manager.list().is_empty());
        assert!(manager.begin_spawn("queued".into()).is_ok());
        manager.kill_all_verified().unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn closing_during_os_creation_reaps_the_late_process() {
        use std::os::unix::fs::PermissionsExt;
        use std::sync::atomic::Ordering;
        use tauri::ipc::Channel;
        let home = tempfile::tempdir().unwrap();
        let shell = home.path().join("test-shell");
        std::fs::write(&shell, "#!/bin/sh\nexec /bin/sleep 60\n").unwrap();
        std::fs::set_permissions(&shell, std::fs::Permissions::from_mode(0o700)).unwrap();
        let manager = PtyManager::default();
        let permit = manager.begin_spawn("creating".into()).unwrap();
        permit.check_active().unwrap();
        let session = super::session::spawn(
            super::session::SpawnParams {
                session_id: "creating".into(),
                cols: 80,
                rows: 24,
                cwd: None,
                shell_path: Some(shell.to_string_lossy().into_owned()),
                zdotdir: None,
                integration_enabled: false,
            },
            Channel::new(|_| Ok(())),
            Channel::new(|_| Ok(())),
        )
        .unwrap();
        let exited = Arc::clone(&session.exited);
        manager.kill_session_verified("creating").unwrap();
        assert!(permit
            .insert(&manager, session)
            .unwrap_err()
            .contains("cancelled"));
        assert!(manager.list().is_empty());
        let deadline = Instant::now() + Duration::from_secs(2);
        while !exited.load(Ordering::Relaxed) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(
            exited.load(Ordering::Relaxed),
            "cancelled process must be reaped"
        );
    }

    #[test]
    fn verified_cleanup_closes_admission_until_explicitly_reenabled() {
        let manager = PtyManager::default();
        manager.kill_all_verified().unwrap();
        assert!(manager.begin_spawn("blocked".into()).is_err());

        manager.enable_admission().unwrap();
        let permit = manager.begin_spawn("accepted".into()).unwrap();
        drop(permit);
        assert!(manager.admission_is_open());
    }

    #[test]
    fn verified_cleanup_waits_for_a_racing_spawn_permit() {
        let manager = Arc::new(PtyManager::default());
        let permit = manager.begin_spawn("racing".into()).unwrap();
        let cleanup_manager = Arc::clone(&manager);
        let cleanup = std::thread::spawn(move || cleanup_manager.kill_all_verified());

        let deadline = Instant::now() + Duration::from_secs(1);
        while manager.admission_is_open() && Instant::now() < deadline {
            std::thread::yield_now();
        }
        assert!(!manager.admission_is_open());
        assert!(manager.begin_spawn("late".into()).is_err());

        drop(permit);
        cleanup.join().unwrap().unwrap();
        assert!(!manager.admission_is_open());
    }
}
