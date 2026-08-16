//! Canonical run reports and the deterministic Markdown projection.
//!
//! `report.json` is the source of truth. `report.md` is always generated from a
//! deserialized and validated `RunbookReport`; it is never incrementally edited
//! or independently summarized.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;

use super::definition::is_unsafe_single_line_character;
use super::redact::{FULL_EVIDENCE_BYTES, OUTPUT_TAIL_BYTES};
use super::state::{
    ApprovalStatus, AttemptStatus, EvidenceAvailability, RunStatus, RunbookPhase, StepStatus,
    VerificationAssurance, Waiver,
};

pub const REPORT_API_VERSION: &str = "runbooks.veviad.com/report/v1alpha1";
pub const MAX_REPORT_ATTEMPTS: usize = 4_096;
pub const MAX_REPORT_EVIDENCE_ITEMS: usize = 2_048;
pub const MAX_REPORT_PERSISTED_OUTPUT_BYTES: u64 = 16 * 1024 * 1024;
pub const MAX_REPORT_EVIDENCE_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReportDefinition {
    pub id: String,
    pub version: String,
    pub title: String,
    pub source_sha256: String,
    pub canonical_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReportTarget {
    pub kind: String,
    pub session_id: String,
    pub shell: Option<String>,
    pub cwd: Option<String>,
    pub remote_kind: Option<String>,
    pub remote_target: Option<String>,
    pub context_marker: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReportEnvironment {
    /// Environment at immutable run creation.
    pub app_version: String,
    pub model: Option<String>,
    /// Append-only execution environments introduced by explicit interrupted
    /// run rebinds. Empty for a run completed in its original process.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub resumes: Vec<ReportResumeEnvironment>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReportResumeEnvironment {
    pub resumed_at: String,
    pub app_version: String,
    pub model: Option<String>,
    pub previous_target: ReportTarget,
    pub target: ReportTarget,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReportTiming {
    pub created_at: String,
    pub started_at: Option<String>,
    pub finished_at: String,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReportAttempt {
    pub id: String,
    pub phase: RunbookPhase,
    pub executor: String,
    pub status: AttemptStatus,
    pub proposed_command: Option<String>,
    pub executed_command: Option<String>,
    pub exit_code: Option<i32>,
    pub duration_ms: Option<u64>,
    pub output_tail: Option<String>,
    /// Bytes observed by the terminal bridge before any transport cap.
    pub output_observed_bytes: u64,
    /// UTF-8 bytes actually delivered to the engine before persistence
    /// redaction/tail-capping. This is always at most `output_observed_bytes`.
    pub output_captured_bytes: u64,
    pub output_redacted: bool,
    pub output_truncated: bool,
    pub error: Option<String>,
    #[serde(default)]
    pub structured_outcomes: Option<Value>,
    pub intent_at: String,
    pub result_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReportApproval {
    pub id: String,
    pub phase: RunbookPhase,
    pub status: ApprovalStatus,
    pub proposed_command: Option<String>,
    pub executed_command: Option<String>,
    pub read_only: bool,
    pub network: bool,
    pub privileged: bool,
    pub opaque: bool,
    #[serde(default)]
    pub project_digest: Option<String>,
    #[serde(default)]
    pub inventory_digest: Option<String>,
    pub actor: Option<String>,
    pub reason: Option<String>,
    pub requested_at: String,
    pub decided_at: Option<String>,
    pub edited: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReportDeviation {
    pub kind: String,
    pub detail: String,
    pub proposed_command: Option<String>,
    pub executed_command: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReportEvidence {
    pub id: String,
    pub attempt_id: String,
    pub mode: String,
    pub availability: EvidenceAvailability,
    pub relative_path: Option<String>,
    pub bytes: u64,
    pub sha256: String,
    pub redacted: bool,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReportChecklistItem {
    pub id: String,
    pub title: String,
    pub required: bool,
    pub status: StepStatus,
    pub checked: bool,
    pub changed: bool,
    pub assurance: Option<VerificationAssurance>,
    pub summary: Option<String>,
    pub operator_comment: Option<String>,
    pub waiver: Option<Waiver>,
    pub attempts: Vec<ReportAttempt>,
    pub approvals: Vec<ReportApproval>,
    pub deviations: Vec<ReportDeviation>,
    pub evidence: Vec<ReportEvidence>,
    pub exceptions: Vec<String>,
    pub unresolved_risks: Vec<String>,
}

impl ReportChecklistItem {
    pub fn validate(&self) -> Result<(), String> {
        validate_identifier(&self.id, "checklist step id")?;
        validate_single_line(&self.title, "checklist step title")?;
        if self.checked != self.status.is_checked() {
            return Err(format!(
                "step {} has checked={} but status {} requires checked={}",
                self.id,
                self.checked,
                self.status,
                self.status.is_checked()
            ));
        }
        if self.status == StepStatus::Waived {
            self.waiver
                .as_ref()
                .ok_or_else(|| format!("waived step {} has no waiver", self.id))?
                .validate()?;
        } else if self.waiver.is_some() {
            return Err(format!("non-waived step {} carries a waiver", self.id));
        }
        if self.status == StepStatus::RemediatedVerified && !self.changed {
            return Err(format!(
                "remediated step {} must be recorded as changed",
                self.id
            ));
        }
        if self.status == StepStatus::AlreadyCompliant && self.changed {
            return Err(format!(
                "already-compliant step {} cannot be recorded as changed",
                self.id
            ));
        }
        let attempt_ids: HashSet<&str> =
            self.attempts.iter().map(|item| item.id.as_str()).collect();
        if attempt_ids.len() != self.attempts.len() {
            return Err(format!("step {} contains duplicate attempt IDs", self.id));
        }
        for attempt in &self.attempts {
            validate_identifier(&attempt.id, "attempt id")?;
            if attempt.output_captured_bytes > attempt.output_observed_bytes {
                return Err(format!(
                    "attempt {} captured more bytes than the terminal observed",
                    attempt.id
                ));
            }
            if !attempt.output_truncated
                && attempt.output_captured_bytes != attempt.output_observed_bytes
            {
                return Err(format!(
                    "attempt {} has uncaptured output without a truncation marker",
                    attempt.id
                ));
            }
            let persisted_bytes = attempt
                .output_tail
                .as_ref()
                .map_or(0, |value| value.len() as u64);
            if persisted_bytes > OUTPUT_TAIL_BYTES as u64 {
                return Err(format!(
                    "attempt {} exceeds the persisted output tail limit",
                    attempt.id
                ));
            }
            if !attempt.output_redacted && persisted_bytes > attempt.output_captured_bytes {
                return Err(format!(
                    "attempt {} persisted more output bytes than it captured",
                    attempt.id
                ));
            }
        }
        for evidence in &self.evidence {
            if !attempt_ids.contains(evidence.attempt_id.as_str()) {
                return Err(format!(
                    "evidence {} refers to an attempt outside step {}",
                    evidence.id, self.id
                ));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RunbookReport {
    pub api_version: String,
    pub run_id: String,
    pub status: RunStatus,
    pub definition: ReportDefinition,
    pub target: ReportTarget,
    /// V1 inputs are explicitly non-secret. Values remain JSON so typed inputs
    /// do not lose their number/bool/list shape in the report.
    pub inputs: Value,
    pub environment: ReportEnvironment,
    pub timing: ReportTiming,
    pub checklist: Vec<ReportChecklistItem>,
    pub executive_summary: String,
    pub exceptions: Vec<String>,
    pub unresolved_risks: Vec<String>,
}

impl RunbookReport {
    pub fn validate(&self) -> Result<(), String> {
        if self.api_version != REPORT_API_VERSION {
            return Err(format!(
                "unsupported report api_version: {}",
                self.api_version
            ));
        }
        if !self.status.is_terminal() {
            return Err(format!("report status {} is not terminal", self.status));
        }
        if self.run_id.trim().is_empty() {
            return Err("report run_id is required".into());
        }
        validate_identifier(&self.run_id, "report run id")?;
        validate_identifier(&self.definition.id, "definition id")?;
        validate_single_line(&self.definition.title, "definition title")?;
        validate_sha256(&self.definition.source_sha256, "definition source SHA-256")?;
        validate_sha256(
            &self.definition.canonical_sha256,
            "definition canonical SHA-256",
        )?;
        let mut evidence_ids = HashSet::new();
        let mut attempt_count = 0usize;
        let mut evidence_count = 0usize;
        let mut persisted_output_bytes = 0u64;
        let mut evidence_bytes = 0u64;
        for step in &self.checklist {
            step.validate()?;
            attempt_count = attempt_count
                .checked_add(step.attempts.len())
                .ok_or("report attempt count overflow")?;
            evidence_count = evidence_count
                .checked_add(step.evidence.len())
                .ok_or("report evidence count overflow")?;
            for attempt in &step.attempts {
                persisted_output_bytes = persisted_output_bytes
                    .checked_add(
                        attempt
                            .output_tail
                            .as_ref()
                            .map_or(0, |value| value.len() as u64),
                    )
                    .ok_or("report persisted output byte count overflow")?;
            }
            for evidence in &step.evidence {
                evidence.validate(&self.run_id)?;
                evidence_bytes = evidence_bytes
                    .checked_add(evidence.bytes)
                    .ok_or("report evidence byte count overflow")?;
                if !evidence_ids.insert(evidence.id.as_str()) {
                    return Err(format!("duplicate evidence ID: {}", evidence.id));
                }
            }
        }
        if attempt_count > MAX_REPORT_ATTEMPTS {
            return Err(format!(
                "report contains more than {MAX_REPORT_ATTEMPTS} attempts"
            ));
        }
        if evidence_count > MAX_REPORT_EVIDENCE_ITEMS {
            return Err(format!(
                "report contains more than {MAX_REPORT_EVIDENCE_ITEMS} evidence items"
            ));
        }
        if persisted_output_bytes > MAX_REPORT_PERSISTED_OUTPUT_BYTES {
            return Err("report persisted output exceeds its aggregate byte limit".into());
        }
        if evidence_bytes > MAX_REPORT_EVIDENCE_BYTES {
            return Err("report evidence exceeds its aggregate byte limit".into());
        }
        let has_required_exception = self
            .checklist
            .iter()
            .any(|step| step.required && !step.status.is_checked());
        let has_unavailable_evidence = self.checklist.iter().any(|step| {
            step.evidence
                .iter()
                .any(|item| item.availability != EvidenceAvailability::Complete)
        });
        if self.status == RunStatus::Succeeded
            && (has_required_exception || has_unavailable_evidence || !self.exceptions.is_empty())
        {
            return Err(
                "a succeeded report cannot contain required exceptions or unavailable evidence"
                    .into(),
            );
        }
        Ok(())
    }

    /// Stable compact JSON. Struct field order is fixed and `serde_json::Map`
    /// uses sorted keys without its `preserve_order` feature, so identical
    /// reports produce identical bytes and hashes.
    pub fn canonical_json(&self) -> Result<String, String> {
        self.validate()?;
        serde_json::to_string(self).map_err(|e| format!("serialize runbook report: {e}"))
    }

    pub fn pretty_json(&self) -> Result<String, String> {
        self.validate()?;
        serde_json::to_string_pretty(self).map_err(|e| format!("serialize runbook report: {e}"))
    }

    pub fn markdown(&self) -> Result<String, String> {
        self.validate()?;
        let canonical = serde_json::to_string(self)
            .map_err(|e| format!("serialize runbook report for Markdown: {e}"))?;
        Ok(render_markdown(self, &canonical))
    }
}

/// Generates Markdown only from the canonical report shape. Unknown fields and
/// inconsistent checked/status pairs are rejected before anything is exported.
pub fn markdown_from_json(json: &str) -> Result<String, String> {
    let report: RunbookReport =
        serde_json::from_str(json).map_err(|e| format!("parse runbook report: {e}"))?;
    report.markdown()
}

/// Final run status after the caller has separately handled explicit failure or
/// cancellation. Optional steps do not downgrade a run; required unchecked
/// steps do.
pub fn status_from_checklist(checklist: &[ReportChecklistItem]) -> RunStatus {
    if checklist.iter().any(|step| {
        (step.required && !step.status.is_checked())
            || step
                .evidence
                .iter()
                .any(|item| item.availability != EvidenceAvailability::Complete)
    }) {
        RunStatus::CompletedWithExceptions
    } else {
        RunStatus::Succeeded
    }
}

fn render_markdown(report: &RunbookReport, canonical_json: &str) -> String {
    let mut out = String::new();
    out.push_str("# Runbook report: ");
    out.push_str(&inline(&report.definition.title));
    out.push_str("\n\n");
    field(&mut out, "Run", &report.run_id);
    field(&mut out, "Status", report.status.as_str());
    field(
        &mut out,
        "Definition",
        &format!("{} @ {}", report.definition.id, report.definition.version),
    );
    field(&mut out, "Target", &target_label(&report.target));
    field(&mut out, "App version", &report.environment.app_version);
    field(
        &mut out,
        "Model",
        report.environment.model.as_deref().unwrap_or("—"),
    );
    for (index, resume) in report.environment.resumes.iter().enumerate() {
        field(
            &mut out,
            &format!("Resume {}", index + 1),
            &format!(
                "{}; app {}; model {}; target {} -> {}",
                resume.resumed_at,
                resume.app_version,
                resume.model.as_deref().unwrap_or("none"),
                target_label(&resume.previous_target),
                target_label(&resume.target),
            ),
        );
    }
    field(
        &mut out,
        "Started",
        report.timing.started_at.as_deref().unwrap_or("—"),
    );
    field(&mut out, "Finished", &report.timing.finished_at);
    field(
        &mut out,
        "Duration",
        &format_duration(report.timing.duration_ms),
    );

    out.push_str("\n## Executive summary\n\n");
    paragraph(&mut out, &report.executive_summary);

    out.push_str("\n## Checklist\n\n");
    out.push_str("| Done | Step | Status | Changed | Assurance | Summary |\n");
    out.push_str("| --- | --- | --- | --- | --- | --- |\n");
    for step in &report.checklist {
        out.push_str(&format!(
            "| {} | {} | {} | {} | {} | {} |\n",
            if step.checked { "✓" } else { "" },
            table(&step.title),
            step.status.as_str(),
            if step.changed { "yes" } else { "no" },
            step.assurance.map(|v| v.as_str()).unwrap_or("—"),
            table(step.summary.as_deref().unwrap_or("—")),
        ));
    }

    for (index, step) in report.checklist.iter().enumerate() {
        out.push_str(&format!("\n### {}. {}\n\n", index + 1, inline(&step.title)));
        field(&mut out, "Step ID", &step.id);
        field(
            &mut out,
            "Required",
            if step.required { "yes" } else { "no" },
        );
        field(&mut out, "Status", step.status.as_str());
        field(&mut out, "Changed", if step.changed { "yes" } else { "no" });
        if let Some(summary) = &step.summary {
            out.push_str("\n**Summary**\n\n");
            paragraph(&mut out, summary);
        }
        if let Some(comment) = &step.operator_comment {
            out.push_str("\n**Operator comment**\n\n");
            paragraph(&mut out, comment);
        }
        if let Some(waiver) = &step.waiver {
            out.push_str("\n**Waiver**\n\n");
            field(&mut out, "Actor", &waiver.actor);
            field(&mut out, "Reason", &waiver.reason);
            field(&mut out, "Time", &waiver.created_at);
        }

        if !step.attempts.is_empty() {
            out.push_str("\n**Attempts**\n\n");
            out.push_str("| Phase | Executor | Status | Exit | Duration | Command |\n");
            out.push_str("| --- | --- | --- | --- | --- | --- |\n");
            for attempt in &step.attempts {
                out.push_str(&format!(
                    "| {} | {} | {} | {} | {} | {} |\n",
                    attempt.phase.as_str(),
                    table(&attempt.executor),
                    attempt.status.as_str(),
                    attempt
                        .exit_code
                        .map(|v| v.to_string())
                        .unwrap_or_else(|| "—".into()),
                    attempt
                        .duration_ms
                        .map(format_duration)
                        .unwrap_or_else(|| "—".into()),
                    table(
                        attempt
                            .executed_command
                            .as_deref()
                            .or(attempt.proposed_command.as_deref())
                            .unwrap_or("—")
                    ),
                ));
            }
        }

        if !step.approvals.is_empty() {
            out.push_str("\n**Approvals**\n\n");
            // `Basis` carries the reason, which is the only place a reader learns
            // that a step was pre-authorized rather than individually displayed.
            // The derived `phase_deviation` also embeds it, but only for non-apply
            // phases — so without this column a bulk-approved apply step, the
            // highest-consequence case, left no trace anywhere.
            out.push_str(
                "| Status | Phase | Actor | Edited | Digests | Basis | Requested | Decided |\n",
            );
            out.push_str("| --- | --- | --- | --- | --- | --- | --- | --- |\n");
            for approval in &step.approvals {
                let digests = match (&approval.project_digest, &approval.inventory_digest) {
                    (Some(project), Some(inventory)) => {
                        format!("project {project}; inventory {inventory}")
                    }
                    (Some(project), None) => format!("project {project}"),
                    _ => "—".into(),
                };
                out.push_str(&format!(
                    "| {} | {} | {} | {} | {} | {} | {} | {} |\n",
                    approval.status.as_str(),
                    approval.phase.as_str(),
                    table(approval.actor.as_deref().unwrap_or("—")),
                    if approval.edited { "yes" } else { "no" },
                    table(&digests),
                    table(approval.reason.as_deref().unwrap_or("—")),
                    table(&approval.requested_at),
                    table(approval.decided_at.as_deref().unwrap_or("—")),
                ));
            }
        }

        bullet_section(
            &mut out,
            "Deviations",
            step.deviations.iter().map(|v| v.detail.as_str()),
        );
        bullet_section(
            &mut out,
            "Exceptions",
            step.exceptions.iter().map(String::as_str),
        );
        bullet_section(
            &mut out,
            "Unresolved risks",
            step.unresolved_risks.iter().map(String::as_str),
        );

        if !step.evidence.is_empty() {
            out.push_str("\n**Evidence**\n\n");
            for evidence in &step.evidence {
                let location = evidence.relative_path.as_deref().unwrap_or("metadata only");
                out.push_str(&format!(
                    "- {} — availability: {} — {} bytes expected — {} — {}{}{}\n",
                    inline(location),
                    evidence.availability,
                    evidence.bytes,
                    inline(&evidence.sha256),
                    inline(&evidence.mode),
                    if evidence.redacted { ", redacted" } else { "" },
                    if evidence.truncated {
                        ", truncated"
                    } else {
                        ""
                    },
                ));
            }
        }
    }

    bullet_section(
        &mut out,
        "Exceptions",
        report.exceptions.iter().map(String::as_str),
    );
    bullet_section(
        &mut out,
        "Unresolved risks",
        report.unresolved_risks.iter().map(String::as_str),
    );

    out.push_str("\n## Integrity\n\n");
    field(&mut out, "Source SHA-256", &report.definition.source_sha256);
    field(
        &mut out,
        "Canonical SHA-256",
        &report.definition.canonical_sha256,
    );

    // The readable projection above is intentionally concise. Preserve a
    // deterministic, complete projection as an indented JSON code block so no
    // canonical field is omitted from report.md. String punctuation and unsafe
    // Unicode formatting characters are JSON-escaped first; the resulting
    // value still deserializes to the byte-for-byte equivalent report while
    // remaining inert even in Markdown renderers with permissive extensions.
    out.push_str("\n## Complete report data (JSON)\n\n");
    out.push_str("    ");
    out.push_str(&inert_json_for_markdown(canonical_json));
    out.push('\n');
    out
}

fn inert_json_for_markdown(canonical_json: &str) -> String {
    let mut out = String::with_capacity(canonical_json.len());
    let mut in_string = false;
    let mut escaped = false;

    for character in canonical_json.chars() {
        if !in_string {
            out.push(character);
            if character == '"' {
                in_string = true;
            }
            continue;
        }
        if escaped {
            // serde_json has already emitted a valid JSON escape. Keeping it
            // preserves the represented scalar and cannot terminate the
            // single-line indented code block.
            out.push(character);
            escaped = false;
            continue;
        }
        match character {
            '\\' => {
                out.push(character);
                escaped = true;
            }
            '"' => {
                out.push(character);
                in_string = false;
            }
            character
                if character.is_ascii_punctuation()
                    || is_unsafe_single_line_character(character) =>
            {
                push_json_unicode_escape(&mut out, character);
            }
            _ => out.push(character),
        }
    }
    out
}

fn push_json_unicode_escape(out: &mut String, character: char) {
    let mut units = [0u16; 2];
    for unit in character.encode_utf16(&mut units) {
        use std::fmt::Write as _;
        write!(out, "\\u{unit:04x}").expect("writing into a String cannot fail");
    }
}

fn field(out: &mut String, label: &str, value: &str) {
    out.push_str(&format!("**{}:** {}  \n", inline(label), inline(value)));
}

fn paragraph(out: &mut String, value: &str) {
    out.push_str(&inline(value));
    out.push('\n');
}

fn bullet_section<'a>(out: &mut String, title: &str, values: impl Iterator<Item = &'a str>) {
    let values: Vec<_> = values.collect();
    if values.is_empty() {
        return;
    }
    out.push_str(&format!("\n**{}**\n\n", inline(title)));
    for value in values {
        out.push_str("- ");
        out.push_str(&inline(value));
        out.push('\n');
    }
}

fn target_label(target: &ReportTarget) -> String {
    match (&target.remote_kind, &target.remote_target) {
        (Some(kind), Some(remote)) => format!(
            "{} / {}:{} ({})",
            target.kind, kind, remote, target.session_id
        ),
        _ => format!("{} ({})", target.kind, target.session_id),
    }
}

fn format_duration(ms: u64) -> String {
    if ms < 1_000 {
        format!("{ms} ms")
    } else {
        format!("{:.1} s", ms as f64 / 1_000.0)
    }
}

fn table(value: &str) -> String {
    inline(value)
}

fn inline(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut pending_space = false;
    for character in value.chars() {
        if is_unsafe_single_line_character(character) {
            pending_space = !out.is_empty();
            continue;
        }
        if pending_space {
            out.push(' ');
            pending_space = false;
        }
        // CommonMark permits a backslash escape for every ASCII punctuation
        // character. Escaping the complete set keeps links, images, autolinks,
        // raw HTML, emphasis and block markers inert across renderers.
        if character.is_ascii_punctuation() {
            out.push('\\');
        }
        out.push(character);
    }
    out
}

impl ReportEvidence {
    fn validate(&self, run_id: &str) -> Result<(), String> {
        validate_identifier(&self.id, "evidence id")?;
        validate_identifier(&self.attempt_id, "evidence attempt id")?;
        validate_sha256(&self.sha256, "evidence SHA-256")?;
        match (self.mode.as_str(), self.relative_path.as_deref()) {
            ("none", None)
                if self.bytes == 0 && self.availability == EvidenceAvailability::Complete => {}
            ("none", None) => {
                return Err(format!(
                    "evidence {} in none mode is not complete or contains bytes",
                    self.id
                ));
            }
            ("tail", None)
                if self.bytes <= OUTPUT_TAIL_BYTES as u64
                    && self.availability == EvidenceAvailability::Complete => {}
            ("tail", None) => {
                return Err(format!(
                    "evidence {} exceeds the tail byte limit or is unavailable",
                    self.id
                ));
            }
            ("full", Some(path)) => {
                if self.bytes > FULL_EVIDENCE_BYTES as u64 {
                    return Err(format!("evidence {} exceeds the full byte limit", self.id));
                }
                let expected = format!("runbooks/{run_id}/{}.log", self.attempt_id);
                if path != expected || path.contains('\\') || path.chars().any(char::is_control) {
                    return Err(format!(
                        "evidence {} has a path outside its run/attempt directory",
                        self.id
                    ));
                }
            }
            ("none" | "tail" | "full", _) => {
                return Err(format!(
                    "evidence {} path does not match capture mode {}",
                    self.id, self.mode
                ));
            }
            _ => return Err(format!("evidence {} has an invalid mode", self.id)),
        }
        Ok(())
    }
}

fn validate_identifier(value: &str, label: &str) -> Result<(), String> {
    let valid = !value.is_empty()
        && value.len() <= 256
        && !matches!(value, "." | "..")
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'));
    if valid {
        Ok(())
    } else {
        Err(format!("{label} is not a safe identifier"))
    }
}

fn validate_single_line(value: &str, label: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        return Err(format!("{label} is required"));
    }
    if value.chars().any(is_unsafe_single_line_character) {
        return Err(format!("{label} must be one printable line"));
    }
    Ok(())
}

fn validate_sha256(value: &str, label: &str) -> Result<(), String> {
    if value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
    {
        Ok(())
    } else {
        Err(format!(
            "{label} must be 64 lowercase hexadecimal characters"
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn report(status: RunStatus, step_status: StepStatus) -> RunbookReport {
        RunbookReport {
            api_version: REPORT_API_VERSION.into(),
            run_id: "run-1".into(),
            status,
            definition: ReportDefinition {
                id: "linux-baseline".into(),
                version: "1.0.0".into(),
                title: "Linux baseline".into(),
                source_sha256: "a".repeat(64),
                canonical_sha256: "b".repeat(64),
            },
            target: ReportTarget {
                kind: "active-terminal".into(),
                session_id: "s1".into(),
                shell: Some("zsh".into()),
                cwd: Some("/srv".into()),
                remote_kind: Some("ssh".into()),
                remote_target: Some("prod".into()),
                context_marker: Some("ctx".into()),
            },
            inputs: serde_json::json!({"port": 22}),
            environment: ReportEnvironment {
                app_version: "0.1.1".into(),
                model: Some("model".into()),
                resumes: vec![],
            },
            timing: ReportTiming {
                created_at: "2026-01-01T00:00:00Z".into(),
                started_at: Some("2026-01-01T00:00:01Z".into()),
                finished_at: "2026-01-01T00:00:02Z".into(),
                duration_ms: 1_000,
            },
            checklist: vec![ReportChecklistItem {
                id: "ssh".into(),
                title: "SSH root disabled".into(),
                required: true,
                status: step_status,
                checked: step_status.is_checked(),
                changed: step_status == StepStatus::RemediatedVerified,
                assurance: Some(VerificationAssurance::DeterministicShell),
                summary: Some("Validated sshd configuration.".into()),
                operator_comment: None,
                waiver: None,
                attempts: vec![],
                approvals: vec![],
                deviations: vec![],
                evidence: vec![],
                exceptions: vec![],
                unresolved_risks: vec![],
            }],
            executive_summary: "The baseline was evaluated.".into(),
            exceptions: vec![],
            unresolved_risks: vec![],
        }
    }

    #[test]
    fn canonical_json_round_trips_into_the_markdown_projection() {
        let mut report = report(RunStatus::CompletedWithExceptions, StepStatus::Waived);
        report.inputs = serde_json::json!({
            "nested": {"enabled": true},
            "ports": [22, 443],
            "label": "[input](https://example.invalid)"
        });
        let mut rebound_target = report.target.clone();
        rebound_target.session_id = "s2".into();
        report.environment.resumes.push(ReportResumeEnvironment {
            resumed_at: "2026-01-01T00:00:01Z".into(),
            app_version: "0.1.2".into(),
            model: Some("resume-model".into()),
            previous_target: report.target.clone(),
            target: rebound_target,
        });
        let output_tail = "result [not a link](javascript:alert(1))\nnext".to_string();
        report.checklist[0].operator_comment = Some("operator <b>comment</b>".into());
        report.checklist[0].waiver = Some(Waiver {
            actor: "operator".into(),
            reason: "approved exception".into(),
            created_at: "2026-01-01T00:00:02Z".into(),
        });
        report.checklist[0].attempts.push(ReportAttempt {
            id: "attempt-1".into(),
            phase: RunbookPhase::Check,
            executor: "shell".into(),
            status: AttemptStatus::Failed,
            proposed_command: Some("printf '<unsafe>'".into()),
            executed_command: Some("printf '<edited>'".into()),
            exit_code: Some(1),
            duration_ms: Some(42),
            output_tail: Some(output_tail.clone()),
            output_observed_bytes: output_tail.len() as u64,
            output_captured_bytes: output_tail.len() as u64,
            output_redacted: false,
            output_truncated: false,
            error: Some("failed > expected".into()),
            structured_outcomes: None,
            intent_at: "2026-01-01T00:00:00Z".into(),
            result_at: Some("2026-01-01T00:00:01Z".into()),
        });
        report.checklist[0].approvals.push(ReportApproval {
            id: "approval-1".into(),
            phase: RunbookPhase::Apply,
            status: ApprovalStatus::Approved,
            proposed_command: Some("echo proposed".into()),
            executed_command: Some("echo edited".into()),
            read_only: false,
            network: true,
            privileged: true,
            opaque: true,
            project_digest: None,
            inventory_digest: None,
            actor: Some("operator".into()),
            reason: Some("reviewed".into()),
            requested_at: "2026-01-01T00:00:00Z".into(),
            decided_at: Some("2026-01-01T00:00:01Z".into()),
            edited: true,
        });
        report.checklist[0].deviations.push(ReportDeviation {
            kind: "edited_command".into(),
            detail: "approved command differed".into(),
            proposed_command: Some("echo proposed".into()),
            executed_command: Some("echo edited".into()),
        });
        report.checklist[0].evidence.push(ReportEvidence {
            id: "evidence-1".into(),
            attempt_id: "attempt-1".into(),
            mode: "tail".into(),
            availability: EvidenceAvailability::Complete,
            relative_path: None,
            bytes: output_tail.len() as u64,
            sha256: "c".repeat(64),
            redacted: true,
            truncated: true,
        });
        report.checklist[0].exceptions.push("step exception".into());
        report.checklist[0]
            .unresolved_risks
            .push("step risk".into());
        report.exceptions.push("run exception".into());
        report.unresolved_risks.push("run risk".into());

        let json = report.canonical_json().unwrap();
        let markdown = markdown_from_json(&json).unwrap();
        assert!(markdown.contains("# Runbook report: Linux baseline"));
        assert!(markdown.contains(&report.definition.canonical_sha256));

        let appendix = markdown
            .split_once("## Complete report data (JSON)\n\n    ")
            .expect("complete report appendix")
            .1
            .trim_end();
        assert!(!appendix.contains('\n'));
        assert!(!appendix.contains("<unsafe>"));
        assert!(!appendix.contains("](javascript:"));
        let projected: RunbookReport = serde_json::from_str(appendix).unwrap();
        assert_eq!(projected, report);
    }

    #[test]
    fn checked_flag_cannot_disagree_with_engine_status() {
        let mut report = report(RunStatus::Succeeded, StepStatus::AlreadyCompliant);
        report.checklist[0].checked = false;
        assert!(report
            .canonical_json()
            .unwrap_err()
            .contains("checked=false"));
    }

    #[test]
    fn succeeded_cannot_hide_a_required_exception() {
        let invalid_report = report(RunStatus::Succeeded, StepStatus::Failed);
        assert!(invalid_report.validate().is_err());
        let exceptional = report(RunStatus::CompletedWithExceptions, StepStatus::Failed);
        exceptional.validate().unwrap();
    }

    #[test]
    fn succeeded_cannot_claim_unavailable_requested_evidence() {
        let mut invalid = report(RunStatus::Succeeded, StepStatus::AlreadyCompliant);
        invalid.checklist[0].attempts.push(ReportAttempt {
            id: "attempt-1".into(),
            phase: RunbookPhase::Check,
            executor: "shell".into(),
            status: AttemptStatus::Succeeded,
            proposed_command: None,
            executed_command: None,
            exit_code: Some(0),
            duration_ms: Some(1),
            output_tail: None,
            output_observed_bytes: 0,
            output_captured_bytes: 0,
            output_redacted: false,
            output_truncated: false,
            error: None,
            structured_outcomes: None,
            intent_at: "2026-01-01T00:00:00Z".into(),
            result_at: Some("2026-01-01T00:00:01Z".into()),
        });
        invalid.checklist[0].evidence.push(ReportEvidence {
            id: "missing-evidence".into(),
            attempt_id: "attempt-1".into(),
            mode: "full".into(),
            availability: EvidenceAvailability::Missing,
            relative_path: Some("runbooks/run-1/attempt-1.log".into()),
            bytes: 2,
            sha256: "c".repeat(64),
            redacted: false,
            truncated: false,
        });
        assert!(invalid
            .validate()
            .unwrap_err()
            .contains("unavailable evidence"));
        assert_eq!(
            status_from_checklist(&invalid.checklist),
            RunStatus::CompletedWithExceptions
        );
        invalid.status = RunStatus::CompletedWithExceptions;
        invalid.validate().unwrap();
    }

    #[test]
    fn approvals_table_records_the_basis_of_each_approval() {
        // An APPLY-phase approval produces no derived phase_deviation, so the
        // reason column is the only place a report reader can see that a step
        // was pre-authorized instead of individually displayed.
        let mut report = report(RunStatus::Succeeded, StepStatus::RemediatedVerified);
        report.checklist[0].approvals.push(ReportApproval {
            id: "approval-auto".into(),
            phase: RunbookPhase::Apply,
            status: ApprovalStatus::Approved,
            proposed_command: Some("systemctl restart nginx".into()),
            executed_command: Some("systemctl restart nginx".into()),
            read_only: false,
            network: false,
            privileged: true,
            opaque: false,
            project_digest: None,
            inventory_digest: None,
            actor: Some("operator".into()),
            reason: Some(
                "operator pre-authorized this step via run-level auto-approve for bound target local session s1; the proposed command was not individually displayed"
                    .into(),
            ),
            requested_at: "2026-01-01T00:00:00Z".into(),
            decided_at: Some("2026-01-01T00:00:01Z".into()),
            edited: false,
        });

        let markdown = report.markdown().unwrap();
        assert!(markdown.contains(
            "| Status | Phase | Actor | Edited | Digests | Basis | Requested | Decided |"
        ));
        assert!(markdown.contains("was not individually displayed"));
        assert!(
            report.checklist[0]
                .deviations
                .iter()
                .all(|item| item.kind != "phase_deviation"),
            "an apply approval must not rely on a phase deviation to be visible"
        );
    }

    #[test]
    fn markdown_escapes_structure_from_untrusted_titles_and_comments() {
        let mut report = report(RunStatus::Succeeded, StepStatus::AlreadyCompliant);
        report.definition.title =
            "[click](javascript:alert(1)) ![image](https://example.invalid/x) <script>".into();
        report.checklist[0].summary = Some(
            "safe | still a cell\n# injected heading\r\n![pixel](https://example.invalid/p)\u{7}\u{202e}"
                .into(),
        );
        let markdown = report.markdown().unwrap();
        assert!(!markdown.contains("<script>"));
        assert!(!markdown.contains("[click](javascript:"));
        assert!(!markdown.contains("![image]("));
        assert!(!markdown.contains("\n# injected heading"));
        assert!(!markdown.contains('\u{7}'));
        assert!(!markdown.contains('\u{202e}'));
        assert!(markdown.contains("safe \\| still a cell"));
        assert!(markdown.contains("\\[click\\]\\(javascript\\:alert\\(1\\)\\)"));
    }

    #[test]
    fn evidence_must_match_safe_run_and_attempt_components() {
        let mut report = report(RunStatus::Succeeded, StepStatus::AlreadyCompliant);
        report.checklist[0].attempts.push(ReportAttempt {
            id: "attempt-1".into(),
            phase: RunbookPhase::Check,
            executor: "shell".into(),
            status: AttemptStatus::Succeeded,
            proposed_command: None,
            executed_command: None,
            exit_code: Some(0),
            duration_ms: Some(1),
            output_tail: Some("ok".into()),
            output_observed_bytes: 2,
            output_captured_bytes: 2,
            output_redacted: false,
            output_truncated: false,
            error: None,
            structured_outcomes: None,
            intent_at: "2026-01-01T00:00:00Z".into(),
            result_at: Some("2026-01-01T00:00:01Z".into()),
        });
        report.checklist[0].evidence.push(ReportEvidence {
            id: "evidence-1".into(),
            attempt_id: "attempt-1".into(),
            mode: "full".into(),
            availability: EvidenceAvailability::Complete,
            relative_path: Some("runbooks/run-1/../private-key".into()),
            bytes: 2,
            sha256: "c".repeat(64),
            redacted: false,
            truncated: false,
        });
        assert!(report.validate().unwrap_err().contains("outside"));

        report.checklist[0].evidence[0].relative_path = Some("runbooks/run-1/attempt-1.log".into());
        report.validate().unwrap();

        report.checklist[0].evidence[0].bytes = FULL_EVIDENCE_BYTES as u64 + 1;
        assert!(report.validate().unwrap_err().contains("full byte limit"));
        report.checklist[0].evidence[0].bytes = 2;
        report.checklist[0].attempts[0].output_observed_bytes = 1;
        report.checklist[0].attempts[0].output_captured_bytes = 1;
        assert!(report.validate().unwrap_err().contains("more output bytes"));
        report.checklist[0].attempts[0].output_tail = Some("[REDACTED]".into());
        report.checklist[0].attempts[0].output_redacted = true;
        report.validate().unwrap();
    }

    #[test]
    fn aggregate_attempt_and_evidence_budgets_are_bounded() {
        let mut report = report(RunStatus::Succeeded, StepStatus::AlreadyCompliant);
        for index in 0..=MAX_REPORT_ATTEMPTS {
            report.checklist[0].attempts.push(ReportAttempt {
                id: format!("attempt-{index}"),
                phase: RunbookPhase::Check,
                executor: "shell".into(),
                status: AttemptStatus::Succeeded,
                proposed_command: None,
                executed_command: None,
                exit_code: Some(0),
                duration_ms: Some(1),
                output_tail: None,
                output_observed_bytes: 0,
                output_captured_bytes: 0,
                output_redacted: false,
                output_truncated: false,
                error: None,
                structured_outcomes: None,
                intent_at: "2026-01-01T00:00:00Z".into(),
                result_at: Some("2026-01-01T00:00:01Z".into()),
            });
        }
        assert!(report.validate().unwrap_err().contains("attempts"));

        report.checklist[0].attempts.clear();
        for index in 0..65 {
            let attempt_id = format!("evidence-attempt-{index}");
            report.checklist[0].attempts.push(ReportAttempt {
                id: attempt_id.clone(),
                phase: RunbookPhase::Check,
                executor: "shell".into(),
                status: AttemptStatus::Succeeded,
                proposed_command: None,
                executed_command: None,
                exit_code: Some(0),
                duration_ms: Some(1),
                output_tail: None,
                output_observed_bytes: 0,
                output_captured_bytes: 0,
                output_redacted: false,
                output_truncated: false,
                error: None,
                structured_outcomes: None,
                intent_at: "2026-01-01T00:00:00Z".into(),
                result_at: Some("2026-01-01T00:00:01Z".into()),
            });
            report.checklist[0].evidence.push(ReportEvidence {
                id: format!("evidence-{index}"),
                attempt_id: attempt_id.clone(),
                mode: "full".into(),
                availability: EvidenceAvailability::Complete,
                relative_path: Some(format!("runbooks/run-1/{attempt_id}.log")),
                bytes: FULL_EVIDENCE_BYTES as u64,
                sha256: "c".repeat(64),
                redacted: false,
                truncated: false,
            });
        }
        assert!(report
            .validate()
            .unwrap_err()
            .contains("aggregate byte limit"));
    }
}
