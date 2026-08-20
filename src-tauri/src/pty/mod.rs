pub mod session;

use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Condvar, Mutex};

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
}

#[derive(Debug)]
struct PtyAdmission {
    accepting: bool,
    in_flight_spawns: usize,
}

pub struct PtyManager {
    pub sessions: Mutex<HashMap<String, PtySession>>,
    admission: Mutex<PtyAdmission>,
    admission_idle: Condvar,
}

impl Default for PtyManager {
    fn default() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            admission: Mutex::new(PtyAdmission {
                accepting: true,
                in_flight_spawns: 0,
            }),
            admission_idle: Condvar::new(),
        }
    }
}

/// Keeps verified shutdown from passing a terminal whose OS process was being
/// created outside the sessions mutex. Cleanup closes admission and waits for
/// every permit; a permit that observes the closed gate kills its new process
/// before releasing the in-flight count.
pub struct PtySpawnPermit<'a> {
    manager: &'a PtyManager,
    session_id: String,
    active: bool,
}

impl PtySpawnPermit<'_> {
    pub fn insert(mut self, session: PtySession) -> Result<u32, String> {
        let pid = session.pid;
        let mut session = Some(session);
        let insert_result = match self.manager.admission.lock() {
            Err(_) => Err("PTY admission state poisoned".to_string()),
            Ok(admission) if !admission.accepting => {
                Err("terminal creation is disabled while the application is exiting".to_string())
            }
            Ok(_admission) => match self.manager.sessions.lock() {
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
            if let Err(retain_error) = self.manager.retain_failed_spawn(&self.session_id, rejected)
            {
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
            self.manager.finish_spawn()?;
            self.active = false;
        }
        Ok(())
    }
}

impl Drop for PtySpawnPermit<'_> {
    fn drop(&mut self) {
        if let Err(error) = self.release() {
            log::error!("could not release PTY spawn permit: {error}");
        }
    }
}

impl PtyManager {
    pub fn begin_spawn(&self, session_id: String) -> Result<PtySpawnPermit<'_>, String> {
        let mut admission = self
            .admission
            .lock()
            .map_err(|_| "PTY admission state poisoned".to_string())?;
        if !admission.accepting {
            return Err("terminal creation is disabled while the application is exiting".into());
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
        Ok(PtySpawnPermit {
            manager: self,
            session_id,
            active: true,
        })
    }

    fn finish_spawn(&self) -> Result<(), String> {
        let mut admission = self
            .admission
            .lock()
            .map_err(|_| "PTY admission state poisoned".to_string())?;
        admission.in_flight_spawns = admission
            .in_flight_spawns
            .checked_sub(1)
            .ok_or_else(|| "PTY spawn admission count underflow".to_string())?;
        if admission.in_flight_spawns == 0 {
            self.admission_idle.notify_all();
        }
        Ok(())
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

    /// Close one PTY without losing the only cleanup handle on a verification
    /// failure. Holding the admission lock prevents a same-id spawn from
    /// occupying the map slot before the failed session is restored.
    pub fn kill_session_verified(&self, session_id: &str) -> Result<(), String> {
        let _admission = self
            .admission
            .lock()
            .map_err(|_| "PTY admission state poisoned".to_string())?;
        let mut session = self
            .sessions
            .lock()
            .map_err(|_| "pty state poisoned".to_string())?
            .remove(session_id)
            .ok_or_else(|| format!("no session {session_id}"))?;
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
