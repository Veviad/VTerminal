//! A short-lived credential grant owned by one native PTY instance. Shell
//! boundaries are observed before bytes cross IPC; frontend cancellation is
//! additional cleanup, never the authority for delivering a password.
use base64::Engine;
use std::time::{Duration, Instant};

use crate::credentials::CredentialId;

const TTL: Duration = Duration::from_secs(60);

pub struct Attempt {
    token: String,
    command: String,
    prompt: String,
    pub argv: Vec<String>,
    pub credential: CredentialId,
    expires: Instant,
    dispatched: bool,
    command_seen: bool,
    started: bool,
    output: String,
}

pub struct Grant {
    pub argv: Vec<String>,
    pub credential: CredentialId,
    pub revision: u64,
}

#[derive(Default)]
pub struct Autofill {
    scope: Option<String>,
    at_prompt: bool,
    attempt: Option<Attempt>,
    control: Vec<u8>,
    revision: u64,
}

impl Autofill {
    pub fn new(scope: Option<String>) -> Self {
        Self {
            scope,
            ..Self::default()
        }
    }

    pub fn cancel(&mut self) {
        self.attempt = None;
        self.revision = self.revision.wrapping_add(1);
    }

    pub fn cancel_token(&mut self, token: &str) {
        if self
            .attempt
            .as_ref()
            .is_some_and(|attempt| attempt.token == token)
        {
            self.cancel();
        }
    }

    pub fn input(&mut self) {
        self.cancel();
        self.at_prompt = false;
    }

    pub fn arm(
        &mut self,
        command: String,
        prompt: String,
        argv: Vec<String>,
        credential: CredentialId,
    ) -> Result<String, String> {
        self.cancel();
        if self.scope.is_none() || !self.at_prompt {
            return Err("SSH password autofill requires a verified local shell prompt; enter the password manually".into());
        }
        let token = uuid::Uuid::new_v4().to_string();
        self.attempt = Some(Attempt {
            token: token.clone(),
            command,
            prompt,
            argv,
            credential,
            expires: Instant::now() + TTL,
            dispatched: false,
            command_seen: false,
            started: false,
            output: String::new(),
        });
        Ok(token)
    }

    pub fn dispatch(&mut self, token: &str, bytes: &[u8]) -> Result<(), String> {
        if !self
            .attempt
            .as_ref()
            .is_some_and(|attempt| attempt.token == token)
        {
            return Err("SSH autofill attempt was replaced".into());
        }
        let valid = self.at_prompt
            && self.attempt.as_ref().is_some_and(|attempt| {
                attempt.token == token
                    && !attempt.dispatched
                    && Instant::now() < attempt.expires
                    && bytes == format!("{}\r", attempt.command).as_bytes()
            });
        if !valid {
            self.cancel();
            return Err(
                "SSH autofill launch changed or expired; reconnect or enter the password manually"
                    .into(),
            );
        }
        self.at_prompt = false;
        self.attempt.as_mut().unwrap().dispatched = true;
        Ok(())
    }

    pub fn consume(&mut self, token: &str) -> Result<Grant, String> {
        if !self
            .attempt
            .as_ref()
            .is_some_and(|attempt| attempt.token == token)
        {
            return Err("SSH autofill attempt was replaced".into());
        }
        let attempt = self
            .attempt
            .take()
            .ok_or("SSH autofill is no longer active; enter the password manually")?;
        if attempt.token != token
            || Instant::now() >= attempt.expires
            || !attempt.started
            || attempt.output.trim() != attempt.prompt
        {
            self.cancel();
            return Err(
                "SSH authentication could not be verified; enter the password manually".into(),
            );
        }
        Ok(Grant {
            argv: attempt.argv,
            credential: attempt.credential,
            revision: self.revision,
        })
    }

    pub fn unchanged(&self, grant: &Grant) -> bool {
        self.revision == grant.revision && self.attempt.is_none() && !self.at_prompt
    }

    pub fn observe(&mut self, bytes: &[u8]) {
        self.revision = self.revision.wrapping_add(1);
        if self
            .attempt
            .as_ref()
            .is_some_and(|a| Instant::now() >= a.expires)
        {
            self.cancel();
        }
        for &byte in bytes {
            if !self.control.is_empty() {
                self.control.push(byte);
                if self.control.len() > 8192 {
                    self.cancel();
                    self.control.clear();
                    continue;
                }
                if self.control.len() == 2 && !matches!(byte, b']' | b'[') {
                    self.cancel();
                    self.control.clear();
                } else if self.control.get(1) == Some(&b']')
                    && (byte == 7 || self.control.ends_with(b"\x1b\\"))
                {
                    let end = self.control.len() - if byte == 7 { 1 } else { 2 };
                    let payload = String::from_utf8_lossy(&self.control[2..end]).into_owned();
                    self.control.clear();
                    self.osc(&payload);
                } else if self.control.get(1) == Some(&b'[')
                    && self.control.len() > 2
                    && (0x40..=0x7e).contains(&byte)
                {
                    self.control.clear();
                }
                continue;
            }
            if byte == 27 {
                self.control.push(byte);
                continue;
            }
            let Some(attempt) = self.attempt.as_mut().filter(|a| a.started) else {
                continue;
            };
            if matches!(byte, b'\r' | b'\n') && attempt.output.trim().is_empty() {
                continue;
            }
            if !byte.is_ascii() || byte.is_ascii_control() {
                self.cancel();
                continue;
            }
            attempt.output.push(byte as char);
            let output = attempt.output.trim_start();
            if !attempt.prompt.starts_with(output.trim_end()) || attempt.output.len() > 512 {
                // Banners, host-key confirmation, keyboard-interactive prompts,
                // and any authenticated output all use manual authentication.
                self.cancel();
            }
        }
    }

    fn osc(&mut self, payload: &str) {
        let prefix = self
            .scope
            .as_ref()
            .map(|scope| format!("6973;SHELL;{scope};"));
        if let Some(event) = prefix
            .as_ref()
            .and_then(|prefix| payload.strip_prefix(prefix))
        {
            if event == "133;B" {
                self.at_prompt = true;
            }
            if event == "133;A" || event.starts_with("133;D;") {
                self.cancel();
                self.at_prompt = false;
            }
            if let Some(encoded) = event.strip_prefix("CMD;") {
                let command = base64::engine::general_purpose::STANDARD
                    .decode(encoded)
                    .ok();
                let valid = self.attempt.as_ref().is_some_and(|a| {
                    a.dispatched && command.as_deref() == Some(a.command.as_bytes())
                });
                if valid {
                    self.attempt.as_mut().unwrap().command_seen = true;
                } else {
                    self.cancel();
                }
            }
            if event == "133;C" {
                self.at_prompt = false;
                if let Some(attempt) = self
                    .attempt
                    .as_mut()
                    .filter(|a| a.dispatched && a.command_seen)
                {
                    attempt.started = true;
                } else {
                    self.cancel();
                }
            }
        } else if self.attempt.as_ref().is_some_and(|a| a.started) && payload != "133;C" {
            // A remote integration/terminal title proves there is more than the
            // single standard OpenSSH password prompt we know how to authorize.
            self.cancel();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const SCOPE: &str = "0123456789abcdef0123456789abcdef";
    fn event(state: &mut Autofill, payload: &str) {
        state.observe(format!("\x1b]6973;SHELL;{SCOPE};{payload}\x1b\\").as_bytes());
    }
    fn launched() -> (Autofill, String) {
        let mut state = Autofill::new(Some(SCOPE.into()));
        event(&mut state, "133;B");
        let token = state
            .arm(
                "ssh deploy@prod-01".into(),
                "deploy@prod-01's password:".into(),
                vec!["ssh".into(), "deploy@prod-01".into()],
                CredentialId::SshHost("fixture".into()),
            )
            .unwrap();
        state.dispatch(&token, b"ssh deploy@prod-01\r").unwrap();
        event(
            &mut state,
            &format!(
                "CMD;{}",
                base64::engine::general_purpose::STANDARD.encode("ssh deploy@prod-01")
            ),
        );
        event(&mut state, "133;C");
        (state, token)
    }
    #[test]
    fn exact_native_launch_and_split_prompt_issue_one_grant() {
        let (mut state, token) = launched();
        state.observe(b"deploy@prod-");
        state.observe(b"01's password: ");
        let grant = state.consume(&token).unwrap();
        assert!(state.unchanged(&grant));
        assert!(state.consume(&token).is_err());
    }
    #[test]
    fn stale_local_and_authenticated_remote_prompts_never_receive_grants() {
        for output in [
            "Last login: today\r\ndeploy@prod-01's password: ",
            "another@prod-01's password: ",
            "deploy@prod-01.evil's password: ",
            "Password: ",
        ] {
            let (mut state, token) = launched();
            state.observe(output.as_bytes());
            assert!(state.consume(&token).is_err(), "{output}");
        }
        let (mut state, token) = launched();
        event(&mut state, "133;D;255");
        state.observe(b"deploy@prod-01's password: ");
        assert!(state.consume(&token).is_err());
    }
    #[test]
    fn expiration_replacement_and_output_during_vault_lookup_invalidate() {
        let (mut state, token) = launched();
        state.attempt.as_mut().unwrap().expires = Instant::now();
        state.observe(b"deploy@prod-01's password: ");
        assert!(state.consume(&token).is_err());
        let (mut state, token) = launched();
        state.observe(b"deploy@prod-01's password: ");
        let grant = state.consume(&token).unwrap();
        state.observe(b"\r\n");
        assert!(!state.unchanged(&grant));
        let (mut state, token) = launched();
        state.cancel();
        assert!(state.consume(&token).is_err());
        assert!(Autofill::default().consume(&token).is_err());
    }

    #[test]
    fn stale_tokens_do_not_invalidate_the_current_attempt() {
        let (mut state, current) = launched();
        assert!(state.dispatch("stale", b"ssh somebody@else\r").is_err());
        assert!(state.consume("stale").is_err());
        state.cancel_token("stale");
        state.observe(b"deploy@prod-01's password: ");
        assert!(state.consume(&current).is_ok());
    }
}
