//! Strict, versioned runbook definitions.
//!
//! YAML is only the authoring syntax.  The runtime receives a validated, typed
//! [`RunbookDefinition`] and snapshots its deterministic JSON representation.  This
//! module deliberately does not interpret templates, load includes, or execute an
//! action: keeping those concerns out of deserialization makes an imported package
//! inert until the engine has performed its approval checks.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashSet};
use std::fmt;

use super::state::EvidenceCaptureMode;

pub const API_VERSION: &str = "runbooks.veviad.com/v1alpha1";
pub const KIND: &str = "Runbook";
pub const MAX_DEFINITION_BYTES: usize = 1024 * 1024;
pub const MAX_SHELL_COMMAND_CHARS: usize = 4_096;
pub const MAX_MARKDOWN_CHARS: usize = 16_384;
pub const MAX_INPUT_STRING_CHARS: usize = 4_096;
pub const MAX_STEPS: usize = 256;
pub const RUNBOOK_ENV_PREFIX: &str = "VRUN_";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct RunbookDefinition {
    pub api_version: String,
    pub kind: String,
    pub metadata: Metadata,
    pub spec: Spec,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct Metadata {
    pub id: String,
    pub version: String,
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct Spec {
    pub target: Target,
    #[serde(default)]
    pub inputs: BTreeMap<String, InputDefinition>,
    #[serde(default)]
    pub declared_capabilities: DeclaredCapabilities,
    #[serde(default)]
    pub defaults: Defaults,
    /// Absent unless the package asks for a specific retention level. It MUST
    /// stay `skip_serializing_if`: canonical JSON is hashed into every source
    /// registration and every persisted run, and an always-emitted `"audit":
    /// null` would change `canonical_sha256` for every definition that already
    /// exists — which `verify_snapshot_bytes` treats as a corrupt run rather
    /// than a stale one, and no refresh can repair that.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub audit: Option<AuditSettings>,
    pub steps: Vec<Step>,
}

/// What a package asks the operator to keep as an audit record.
///
/// This is a request, never a grant. The operator's Settings → Runbooks policy
/// supplies the floor, and a package that asks for less than the floor gets the
/// floor anyway — see `EvidenceRecordingPolicy::floor`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct AuditSettings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub record_output: Option<EvidenceCaptureMode>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub kind: TargetKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum TargetKind {
    ActiveTerminal,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct InputDefinition {
    #[serde(rename = "type")]
    pub input_type: InputType,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub required: bool,
    #[serde(default)]
    pub default: Option<Value>,
    #[serde(default)]
    pub values: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum InputType {
    String,
    Integer,
    Boolean,
    Path,
    Enum,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct DeclaredCapabilities {
    #[serde(default)]
    pub network: bool,
    #[serde(default)]
    pub privilege: Privilege,
    #[serde(default)]
    pub writes: Vec<String>,
}

impl Default for DeclaredCapabilities {
    fn default() -> Self {
        Self {
            network: false,
            privilege: Privilege::None,
            writes: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum Privilege {
    #[default]
    None,
    Root,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct Defaults {
    #[serde(default)]
    pub on_failure: FailurePolicy,
}

impl Default for Defaults {
    fn default() -> Self {
        Self {
            on_failure: FailurePolicy::Pause,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum FailurePolicy {
    #[default]
    Pause,
    Stop,
    Continue,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct Step {
    pub id: String,
    pub title: String,
    #[serde(default = "default_required")]
    pub required: bool,
    pub check: CheckAction,
    #[serde(default)]
    pub apply: Option<ApplyAction>,
    #[serde(default)]
    pub verify: Option<VerifyAction>,
    #[serde(default)]
    pub on_failure: Option<FailurePolicy>,
}

fn default_required() -> bool {
    true
}

/// A check must distinguish a compliant result from a non-compliant result.
/// Any other shell exit code is an execution error, not merely non-compliance.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "uses")]
#[serde(deny_unknown_fields)]
pub enum CheckAction {
    #[serde(rename = "shell")]
    Shell {
        #[serde(rename = "with")]
        action: ShellAction,
        outcomes: CheckOutcomes,
    },
    #[serde(rename = "agent")]
    Agent { instructions: String },
    #[serde(rename = "manual")]
    Manual { instructions: String },
    #[serde(rename = "ansible.playbook")]
    AnsiblePlaybook {
        #[serde(rename = "with")]
        action: AnsiblePlaybookAction,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "uses")]
#[serde(deny_unknown_fields)]
pub enum ApplyAction {
    #[serde(rename = "shell")]
    Shell {
        #[serde(rename = "with")]
        action: ShellAction,
        #[serde(default = "zero_exit_codes", rename = "successExitCodes")]
        success_exit_codes: Vec<i32>,
    },
    #[serde(rename = "agent")]
    Agent { instructions: String },
    #[serde(rename = "manual")]
    Manual { instructions: String },
    #[serde(rename = "ansible.playbook")]
    AnsiblePlaybook {
        #[serde(rename = "with")]
        action: AnsiblePlaybookAction,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "uses")]
#[serde(deny_unknown_fields)]
pub enum VerifyAction {
    #[serde(rename = "shell")]
    Shell {
        #[serde(rename = "with")]
        action: ShellAction,
        #[serde(rename = "passExitCodes")]
        pass_exit_codes: Vec<i32>,
    },
    #[serde(rename = "agent")]
    Agent { instructions: String },
    #[serde(rename = "manual")]
    Manual { instructions: String },
    #[serde(rename = "ansible.playbook")]
    AnsiblePlaybook {
        #[serde(rename = "with")]
        action: AnsiblePlaybookAction,
    },
}

fn zero_exit_codes() -> Vec<i32> {
    vec![0]
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct ShellAction {
    pub command: String,
    /// Environment variable name to input ID.  Values are never interpolated into
    /// the shell command itself.
    #[serde(default)]
    pub env: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct CheckOutcomes {
    pub compliant_exit_codes: Vec<i32>,
    pub noncompliant_exit_codes: Vec<i32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct AnsiblePlaybookAction {
    /// Package-relative path beneath `ansible/`.
    pub playbook: String,
    /// Optional package-relative static inventory.  Interactive credentials are
    /// intentionally not representable in v1alpha1.
    #[serde(default)]
    pub inventory: Option<String>,
    #[serde(default)]
    pub limit: Option<String>,
    /// Ansible variable name to runbook input ID.
    #[serde(default)]
    pub input_vars: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum VerificationAssurance {
    DeterministicShell,
    AgentAssessed,
    OperatorAttested,
    AnsibleRunner,
}

impl VerifyAction {
    pub fn assurance(&self) -> VerificationAssurance {
        match self {
            Self::Shell { .. } => VerificationAssurance::DeterministicShell,
            Self::Agent { .. } => VerificationAssurance::AgentAssessed,
            Self::Manual { .. } => VerificationAssurance::OperatorAttested,
            Self::AnsiblePlaybook { .. } => VerificationAssurance::AnsibleRunner,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ExecutorAvailability {
    Native,
    FollowOnAdapter,
}

impl CheckAction {
    pub fn availability(&self) -> ExecutorAvailability {
        match self {
            Self::AnsiblePlaybook { .. } => ExecutorAvailability::FollowOnAdapter,
            _ => ExecutorAvailability::Native,
        }
    }
}

impl ApplyAction {
    pub fn availability(&self) -> ExecutorAvailability {
        match self {
            Self::AnsiblePlaybook { .. } => ExecutorAvailability::FollowOnAdapter,
            _ => ExecutorAvailability::Native,
        }
    }
}

impl VerifyAction {
    pub fn availability(&self) -> ExecutorAvailability {
        match self {
            Self::AnsiblePlaybook { .. } => ExecutorAvailability::FollowOnAdapter,
            _ => ExecutorAvailability::Native,
        }
    }
}

impl RunbookDefinition {
    pub fn uses_unavailable_executor(&self) -> bool {
        self.spec.steps.iter().any(|step| {
            step.check.availability() == ExecutorAvailability::FollowOnAdapter
                || step.apply.as_ref().is_some_and(|action| {
                    action.availability() == ExecutorAvailability::FollowOnAdapter
                })
                || step.verify.as_ref().is_some_and(|action| {
                    action.availability() == ExecutorAvailability::FollowOnAdapter
                })
        })
    }

    pub fn effective_failure_policy(&self, step: &Step) -> FailurePolicy {
        step.on_failure.unwrap_or(self.spec.defaults.on_failure)
    }

    /// The retention this package asks for, if any. The operator's policy still
    /// decides the floor; this only ever raises a run above `tail`.
    pub fn declared_record_output(&self) -> Option<EvidenceCaptureMode> {
        self.spec.audit.and_then(|audit| audit.record_output)
    }

    /// Resolve provided values over definition defaults and validate the exact data
    /// that may be exposed to an executor. Unknown input IDs and missing required
    /// values fail before a run is created.
    pub fn resolve_inputs(
        &self,
        provided: &BTreeMap<String, Value>,
    ) -> Result<BTreeMap<String, Value>, Vec<ValidationError>> {
        let mut errors = Vec::new();
        for name in provided.keys() {
            if !self.spec.inputs.contains_key(name) {
                error(
                    &mut errors,
                    format!("inputs.{name}"),
                    "is not declared by this runbook",
                );
            }
        }

        let mut resolved = BTreeMap::new();
        for (name, input) in &self.spec.inputs {
            let value = provided.get(name).or(input.default.as_ref());
            match value {
                Some(value) => {
                    if let Some(message) = input_value_error(input, value) {
                        error(&mut errors, format!("inputs.{name}"), message);
                    } else {
                        resolved.insert(name.clone(), value.clone());
                    }
                }
                None if input.required => error(
                    &mut errors,
                    format!("inputs.{name}"),
                    "is required and has no default",
                ),
                None => {}
            }
        }

        if errors.is_empty() {
            Ok(resolved)
        } else {
            Err(errors)
        }
    }

    pub fn validate(&self) -> Result<(), Vec<ValidationError>> {
        let mut errors = Vec::new();

        if self.api_version != API_VERSION {
            error(&mut errors, "apiVersion", format!("must be {API_VERSION}"));
        }
        if self.kind != KIND {
            error(&mut errors, "kind", format!("must be {KIND}"));
        }
        validate_identifier(&self.metadata.id, "metadata.id", &mut errors);
        if semver::Version::parse(&self.metadata.version).is_err() {
            error(
                &mut errors,
                "metadata.version",
                "must be a valid semantic version such as 1.0.0",
            );
        }
        validate_single_line_text(&self.metadata.title, "metadata.title", 160, &mut errors);
        validate_markdown(
            &self.metadata.description,
            "metadata.description",
            &mut errors,
        );

        let mut tags = HashSet::new();
        for (index, tag) in self.metadata.tags.iter().enumerate() {
            let path = format!("metadata.tags[{index}]");
            validate_identifier(tag, &path, &mut errors);
            if !tags.insert(tag) {
                error(&mut errors, path, "duplicate tag");
            }
        }

        for (name, input) in &self.spec.inputs {
            let path = format!("spec.inputs.{name}");
            validate_input_identifier(name, &path, &mut errors);
            if looks_secret_input_id(name) {
                error(
                    &mut errors,
                    &path,
                    "secret-like inputs are not supported in v1; use an external secret reference in a future adapter",
                );
            }
            validate_input(input, &path, &mut errors);
        }

        let mut writes = HashSet::new();
        for (index, path) in self.spec.declared_capabilities.writes.iter().enumerate() {
            let field = format!("spec.declaredCapabilities.writes[{index}]");
            validate_posix_absolute_path(path, &field, &mut errors);
            if !writes.insert(path) {
                error(&mut errors, field, "duplicate write path");
            }
        }

        if self.spec.steps.is_empty() {
            error(&mut errors, "spec.steps", "must contain at least one step");
        } else if self.spec.steps.len() > MAX_STEPS {
            error(
                &mut errors,
                "spec.steps",
                format!("must contain no more than {MAX_STEPS} steps"),
            );
        }

        let mut step_ids = HashSet::new();
        for (index, step) in self.spec.steps.iter().enumerate() {
            let path = format!("spec.steps[{index}]");
            validate_identifier(&step.id, &format!("{path}.id"), &mut errors);
            if !step_ids.insert(&step.id) {
                error(&mut errors, format!("{path}.id"), "duplicate step ID");
            }
            validate_single_line_text(&step.title, &format!("{path}.title"), 160, &mut errors);

            validate_check(&step.check, &format!("{path}.check"), self, &mut errors);
            if let Some(apply) = &step.apply {
                validate_apply(apply, &format!("{path}.apply"), self, &mut errors);
                if step.verify.is_none() {
                    error(
                        &mut errors,
                        format!("{path}.verify"),
                        "is required when apply is present",
                    );
                }
            } else if step.verify.is_some() {
                error(
                    &mut errors,
                    format!("{path}.verify"),
                    "cannot be present without apply",
                );
            }
            if let Some(verify) = &step.verify {
                validate_verify(verify, &format!("{path}.verify"), self, &mut errors);
            }
        }

        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors)
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct ValidationError {
    pub path: String,
    pub message: String,
}

impl fmt::Display for ValidationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.path, self.message)
    }
}

#[derive(Debug, thiserror::Error)]
pub enum DefinitionError {
    #[error("runbook definition exceeds the {MAX_DEFINITION_BYTES}-byte limit")]
    TooLarge,
    #[error("unsafe or unsupported YAML at line {line}: {message}")]
    UnsafeYaml { line: usize, message: String },
    #[error("invalid runbook YAML: {0}")]
    Yaml(String),
    #[error("runbook validation failed: {0}")]
    Validation(ValidationErrors),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidationErrors(pub Vec<ValidationError>);

impl fmt::Display for ValidationErrors {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        for (index, issue) in self.0.iter().enumerate() {
            if index != 0 {
                write!(f, "; ")?;
            }
            write!(f, "{issue}")?;
        }
        Ok(())
    }
}

/// Parse one deliberately small YAML document with extensions disabled, then run
/// semantic validation.  Parser defaults already reject duplicate keys; the
/// explicit options document and lock down that security boundary.
pub fn parse_and_validate(source: &str) -> Result<RunbookDefinition, DefinitionError> {
    if source.len() > MAX_DEFINITION_BYTES {
        return Err(DefinitionError::TooLarge);
    }
    reject_yaml_extensions(source)?;

    let options = serde_saphyr::options! {
        budget: serde_saphyr::budget! {
            max_documents: 1,
            max_anchors: 0,
        },
        duplicate_keys: serde_saphyr::DuplicateKeyPolicy::Error,
        merge_keys: serde_saphyr::MergeKeyPolicy::Error,
        strict_booleans: true,
    };
    let definition: RunbookDefinition = serde_saphyr::from_str_with_options(source, options)
        .map_err(|err| DefinitionError::Yaml(err.to_string()))?;
    definition
        .validate()
        .map_err(|issues| DefinitionError::Validation(ValidationErrors(issues)))?;
    Ok(definition)
}

/// JSON Schema Draft 2020-12 for editor tooling and package validation outside the
/// application.  The Rust types remain authoritative; checked-in schema files must
/// be generated from this value.
pub fn generated_schema() -> Value {
    let schema = schemars::schema_for!(RunbookDefinition);
    let mut value = serde_json::to_value(schema).expect("schemars emits serializable JSON");
    if let Value::Object(root) = &mut value {
        root.insert(
            "$schema".into(),
            Value::String("https://json-schema.org/draft/2020-12/schema".into()),
        );
        root.insert(
            "$id".into(),
            Value::String("https://schemas.veviad.com/runbooks/v1alpha1.json".into()),
        );
        root.insert(
            "title".into(),
            Value::String("Veviad Runbook v1alpha1".into()),
        );
        // These two discriminators are runtime constants rather than Rust enum
        // fields, so teach the generated schema the same exact-version contract the
        // semantic validator enforces.
        if let Some(Value::Object(properties)) = root.get_mut("properties") {
            if let Some(Value::Object(api_version)) = properties.get_mut("apiVersion") {
                api_version.insert("const".into(), Value::String(API_VERSION.into()));
            }
            if let Some(Value::Object(kind)) = properties.get_mut("kind") {
                kind.insert("const".into(), Value::String(KIND.into()));
            }
        }
    }
    value
}

pub fn generated_schema_pretty() -> String {
    serde_json::to_string_pretty(&generated_schema()).expect("schema contains only JSON values")
        + "\n"
}

fn validate_input(input: &InputDefinition, path: &str, errors: &mut Vec<ValidationError>) {
    validate_markdown(&input.description, &format!("{path}.description"), errors);
    let mut values = HashSet::new();
    for (index, value) in input.values.iter().enumerate() {
        let field = format!("{path}.values[{index}]");
        validate_single_line_text(value, &field, 256, errors);
        if !values.insert(value) {
            error(errors, field, "duplicate enum value");
        }
    }

    if input.input_type == InputType::Enum {
        if input.values.is_empty() {
            error(
                errors,
                format!("{path}.values"),
                "enum inputs require values",
            );
        }
    } else if !input.values.is_empty() {
        error(
            errors,
            format!("{path}.values"),
            "is only valid for enum inputs",
        );
    }

    if let Some(default) = &input.default {
        if let Some(message) = input_value_error(input, default) {
            error(errors, format!("{path}.default"), message);
        }
    }
}

fn looks_secret_input_id(value: &str) -> bool {
    let mut normalized = String::with_capacity(value.len() + 4);
    for (index, character) in value.chars().enumerate() {
        if index > 0 && character.is_ascii_uppercase() {
            normalized.push('_');
        }
        normalized.push(character.to_ascii_lowercase());
    }
    let normalized = normalized.replace('-', "_");
    [
        "password",
        "passwd",
        "passphrase",
        "secret",
        "token",
        "api_key",
        "apikey",
        "private_key",
        "client_secret",
        "credential",
        "cookie",
    ]
    .iter()
    .any(|marker| normalized == *marker || normalized.ends_with(&format!("_{marker}")))
}

fn input_value_error(input: &InputDefinition, value: &Value) -> Option<&'static str> {
    let safe_string = |value: &str| {
        value.chars().count() <= MAX_INPUT_STRING_CHARS
            && !value.chars().any(is_unsafe_single_line_character)
    };
    let valid = match input.input_type {
        InputType::String => value.as_str().is_some_and(safe_string),
        InputType::Integer => value.as_i64().is_some() || value.as_u64().is_some(),
        InputType::Boolean => value.is_boolean(),
        InputType::Path => value
            .as_str()
            .is_some_and(|value| safe_string(value) && is_valid_posix_absolute_path(value)),
        InputType::Enum => value.as_str().is_some_and(|value| {
            safe_string(value) && input.values.iter().any(|item| item == value)
        }),
    };
    (!valid).then_some(
        "does not match its declared type, allowed values, length or character constraints",
    )
}

fn validate_check(
    action: &CheckAction,
    path: &str,
    definition: &RunbookDefinition,
    errors: &mut Vec<ValidationError>,
) {
    match action {
        CheckAction::Shell { action, outcomes } => {
            validate_shell(action, path, definition, errors);
            validate_exit_codes(
                &outcomes.compliant_exit_codes,
                &format!("{path}.outcomes.compliantExitCodes"),
                errors,
            );
            validate_exit_codes(
                &outcomes.noncompliant_exit_codes,
                &format!("{path}.outcomes.noncompliantExitCodes"),
                errors,
            );
            let compliant: HashSet<_> = outcomes.compliant_exit_codes.iter().collect();
            if outcomes
                .noncompliant_exit_codes
                .iter()
                .any(|code| compliant.contains(code))
            {
                error(
                    errors,
                    format!("{path}.outcomes"),
                    "compliant and noncompliant exit codes must be disjoint",
                );
            }
        }
        CheckAction::Agent { instructions } | CheckAction::Manual { instructions } => {
            validate_markdown_required(instructions, &format!("{path}.instructions"), errors);
        }
        CheckAction::AnsiblePlaybook { action } => {
            validate_ansible(action, path, definition, errors)
        }
    }
}

fn validate_apply(
    action: &ApplyAction,
    path: &str,
    definition: &RunbookDefinition,
    errors: &mut Vec<ValidationError>,
) {
    match action {
        ApplyAction::Shell {
            action,
            success_exit_codes,
        } => {
            validate_shell(action, path, definition, errors);
            validate_exit_codes(
                success_exit_codes,
                &format!("{path}.successExitCodes"),
                errors,
            );
        }
        ApplyAction::Agent { instructions } | ApplyAction::Manual { instructions } => {
            validate_markdown_required(instructions, &format!("{path}.instructions"), errors);
        }
        ApplyAction::AnsiblePlaybook { action } => {
            validate_ansible(action, path, definition, errors)
        }
    }
}

fn validate_verify(
    action: &VerifyAction,
    path: &str,
    definition: &RunbookDefinition,
    errors: &mut Vec<ValidationError>,
) {
    match action {
        VerifyAction::Shell {
            action,
            pass_exit_codes,
        } => {
            validate_shell(action, path, definition, errors);
            validate_exit_codes(pass_exit_codes, &format!("{path}.passExitCodes"), errors);
        }
        VerifyAction::Agent { instructions } | VerifyAction::Manual { instructions } => {
            validate_markdown_required(instructions, &format!("{path}.instructions"), errors);
        }
        VerifyAction::AnsiblePlaybook { action } => {
            validate_ansible(action, path, definition, errors)
        }
    }
}

fn validate_shell(
    action: &ShellAction,
    path: &str,
    definition: &RunbookDefinition,
    errors: &mut Vec<ValidationError>,
) {
    let field = format!("{path}.with.command");
    if action.command.trim().is_empty() {
        error(errors, &field, "must not be empty");
    }
    if action.command.chars().count() > MAX_SHELL_COMMAND_CHARS {
        error(
            errors,
            &field,
            format!("must be {MAX_SHELL_COMMAND_CHARS} characters or fewer"),
        );
    }
    if action.command.contains('\n') || action.command.contains('\r') {
        error(errors, &field, "must contain exactly one line");
    }
    if action.command.chars().any(is_unsafe_single_line_character) {
        error(
            errors,
            &field,
            "must not contain control, bidi, zero-width or other format characters",
        );
    }
    if action.command.contains("<<") {
        error(
            errors,
            &field,
            "heredoc and here-string operators are unsupported",
        );
    }

    for (name, input_id) in &action.env {
        let env_path = format!("{path}.with.env.{name}");
        if !is_valid_env_name(name) {
            error(errors, &env_path, "must be a valid POSIX environment name");
        } else if !name.starts_with(RUNBOOK_ENV_PREFIX) || name.len() == RUNBOOK_ENV_PREFIX.len() {
            error(
                errors,
                &env_path,
                format!("must use the dedicated {RUNBOOK_ENV_PREFIX}<NAME> namespace"),
            );
        }
        if !definition.spec.inputs.contains_key(input_id) {
            error(
                errors,
                env_path,
                format!("references unknown input {input_id:?}"),
            );
        }
    }
}

fn validate_ansible(
    action: &AnsiblePlaybookAction,
    path: &str,
    definition: &RunbookDefinition,
    errors: &mut Vec<ValidationError>,
) {
    validate_package_relative_ansible_path(
        &action.playbook,
        &format!("{path}.with.playbook"),
        errors,
    );
    if let Some(inventory) = &action.inventory {
        validate_package_relative_ansible_path(
            inventory,
            &format!("{path}.with.inventory"),
            errors,
        );
    }
    if let Some(limit) = &action.limit {
        validate_single_line_text(limit, &format!("{path}.with.limit"), 512, errors);
    }
    for (name, input_id) in &action.input_vars {
        let field = format!("{path}.with.inputVars.{name}");
        if !is_valid_ansible_var_name(name) {
            error(errors, &field, "must be a valid Ansible variable name");
        }
        if !definition.spec.inputs.contains_key(input_id) {
            error(
                errors,
                field,
                format!("references unknown input {input_id:?}"),
            );
        }
    }
}

fn validate_exit_codes(codes: &[i32], path: &str, errors: &mut Vec<ValidationError>) {
    if codes.is_empty() {
        error(errors, path, "must contain at least one exit code");
        return;
    }
    let mut seen = HashSet::new();
    for code in codes {
        if !(0..=255).contains(code) {
            error(errors, path, format!("exit code {code} is outside 0..=255"));
        }
        if !seen.insert(code) {
            error(errors, path, format!("duplicate exit code {code}"));
        }
    }
}

fn validate_markdown_required(value: &str, path: &str, errors: &mut Vec<ValidationError>) {
    validate_required_text(value, path, MAX_MARKDOWN_CHARS, errors);
    validate_text_controls(value, path, errors);
}

fn validate_markdown(value: &str, path: &str, errors: &mut Vec<ValidationError>) {
    if value.chars().count() > MAX_MARKDOWN_CHARS {
        error(
            errors,
            path,
            format!("must be {MAX_MARKDOWN_CHARS} characters or fewer"),
        );
    }
    validate_text_controls(value, path, errors);
}

fn validate_required_text(
    value: &str,
    path: &str,
    max_chars: usize,
    errors: &mut Vec<ValidationError>,
) {
    if value.trim().is_empty() {
        error(errors, path, "must not be empty");
    }
    if value.chars().count() > max_chars {
        error(
            errors,
            path,
            format!("must be {max_chars} characters or fewer"),
        );
    }
    validate_text_controls(value, path, errors);
}

/// Labels and other title-like values are rendered in compact UI and report
/// contexts. Keep them to one printable line so they cannot smuggle structure
/// into logs, Markdown, terminal prompts, or accessibility labels.
fn validate_single_line_text(
    value: &str,
    path: &str,
    max_chars: usize,
    errors: &mut Vec<ValidationError>,
) {
    validate_required_text(value, path, max_chars, errors);
    if value.chars().any(is_unsafe_single_line_character) {
        error(
            errors,
            path,
            "must contain exactly one line with no control characters",
        );
    }
}

pub(crate) fn is_unsafe_single_line_character(character: char) -> bool {
    character.is_control()
        || character.is_whitespace() && character != ' '
        || is_unicode_format_character(character)
}

// Rust's standard library does not expose Unicode general categories or the
// Default_Ignorable_Code_Point property. Keep both sets explicit so labels do
// not accept zero-width shaping/variation characters that render as blank or
// visually misleading text. The final supplementary-plane range is the
// Unicode-reserved tag/variation-selector block and intentionally includes
// currently unassigned default-ignorable code points.
fn is_unicode_format_character(character: char) -> bool {
    matches!(
        character,
        '\u{00ad}'
            | '\u{034f}'
            | '\u{0600}'..='\u{0605}'
            | '\u{061c}'
            | '\u{06dd}'
            | '\u{070f}'
            | '\u{0890}'..='\u{0891}'
            | '\u{08e2}'
            | '\u{115f}'..='\u{1160}'
            | '\u{17b4}'..='\u{17b5}'
            | '\u{180b}'..='\u{180f}'
            | '\u{200b}'..='\u{200f}'
            | '\u{202a}'..='\u{202e}'
            | '\u{2060}'..='\u{206f}'
            | '\u{3164}'
            | '\u{fe00}'..='\u{fe0f}'
            | '\u{feff}'
            | '\u{ffa0}'
            | '\u{fff0}'..='\u{fffb}'
            | '\u{110bd}'
            | '\u{110cd}'
            | '\u{13430}'..='\u{13455}'
            | '\u{1bca0}'..='\u{1bca3}'
            | '\u{1d173}'..='\u{1d17a}'
            | '\u{e0000}'..='\u{e0fff}'
    )
}

fn validate_text_controls(value: &str, path: &str, errors: &mut Vec<ValidationError>) {
    if value
        .chars()
        .any(|character| character.is_control() && !matches!(character, '\n' | '\t'))
    {
        error(
            errors,
            path,
            "must not contain control characters other than newline and tab",
        );
    }
}

fn validate_identifier(value: &str, path: &str, errors: &mut Vec<ValidationError>) {
    let valid = !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_lowercase())
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'-' | b'.')
        })
        && !value.contains("..")
        && !value.ends_with('-')
        && !value.ends_with('.');
    if !valid {
        error(
            errors,
            path,
            "must be a lowercase stable ID using letters, digits, '-' or '.'",
        );
    }
}

fn validate_input_identifier(value: &str, path: &str, errors: &mut Vec<ValidationError>) {
    let valid = !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_alphabetic())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'));
    if !valid {
        error(
            errors,
            path,
            "input IDs must start with a letter and use letters, digits, '_' or '-'",
        );
    }
}

fn validate_posix_absolute_path(value: &str, path: &str, errors: &mut Vec<ValidationError>) {
    if !is_valid_posix_absolute_path(value) {
        error(
            errors,
            path,
            "must be an absolute POSIX path without '.', '..' or control characters",
        );
    }
}

fn is_valid_posix_absolute_path(value: &str) -> bool {
    value.starts_with('/')
        && !value.chars().any(char::is_control)
        && value
            .split('/')
            .skip(1)
            .all(|segment| !matches!(segment, "." | ".."))
}

fn validate_package_relative_ansible_path(
    value: &str,
    path: &str,
    errors: &mut Vec<ValidationError>,
) {
    let mut parts = value.split('/');
    let first = parts.next();
    let valid = first == Some("ansible")
        && parts.clone().next().is_some()
        && !value.starts_with('/')
        && !value.ends_with('/')
        && !value.contains('\\')
        && !value.chars().any(char::is_control)
        && value
            .split('/')
            .all(|part| !part.is_empty() && !matches!(part, "." | ".."));
    if !valid {
        error(
            errors,
            path,
            "must be a package-relative path beneath ansible/",
        );
    }
}

fn is_valid_env_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_alphabetic() || byte == b'_')
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}

fn is_valid_ansible_var_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_alphabetic() || byte == b'_')
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}

fn error(errors: &mut Vec<ValidationError>, path: impl Into<String>, message: impl Into<String>) {
    errors.push(ValidationError {
        path: path.into(),
        message: message.into(),
    });
}

/// Reject YAML features that can obscure the exact authored data before Serde sees
/// it. The scanner skips comments, quoted scalars and block-scalar bodies; parser
/// options independently reject anchors and merge keys so this preflight is not the
/// sole enforcement layer.
fn reject_yaml_extensions(source: &str) -> Result<(), DefinitionError> {
    let mut block_scalar_indent: Option<usize> = None;

    for (line_index, line) in source.lines().enumerate() {
        let line_number = line_index + 1;
        let indent = line
            .chars()
            .take_while(|character| *character == ' ')
            .count();
        let trimmed = line.trim();

        if let Some(parent_indent) = block_scalar_indent {
            if trimmed.is_empty() || indent > parent_indent {
                continue;
            }
            block_scalar_indent = None;
        }

        let visible = visible_yaml_syntax(line);
        let syntax = visible.trim();
        if syntax.is_empty() {
            continue;
        }
        if syntax.starts_with('%') {
            return Err(DefinitionError::UnsafeYaml {
                line: line_number,
                message: "YAML directives are unsupported".into(),
            });
        }
        if matches!(syntax, "---" | "...") {
            return Err(DefinitionError::UnsafeYaml {
                line: line_number,
                message: "document separators and multiple YAML documents are unsupported".into(),
            });
        }

        let chars: Vec<char> = visible.chars().collect();
        for (index, character) in chars.iter().copied().enumerate() {
            let previous = index.checked_sub(1).and_then(|pos| chars.get(pos)).copied();
            let boundary = previous.is_none_or(|value| {
                value.is_whitespace() || matches!(value, '[' | '{' | ',' | ':' | '?')
            });
            if boundary && matches!(character, '!' | '&' | '*') {
                let feature = match character {
                    '!' => "explicit YAML tags and includes",
                    '&' | '*' => "YAML anchors and aliases",
                    _ => unreachable!(),
                };
                return Err(DefinitionError::UnsafeYaml {
                    line: line_number,
                    message: format!("{feature} are unsupported"),
                });
            }
            if character == '<'
                && chars.get(index + 1) == Some(&'<')
                && chars.get(index + 2).is_some_and(|value| *value == ':')
                && boundary
            {
                return Err(DefinitionError::UnsafeYaml {
                    line: line_number,
                    message: "YAML merge keys are unsupported".into(),
                });
            }
        }

        if is_block_scalar_header(&visible) {
            block_scalar_indent = Some(indent);
        }
    }
    Ok(())
}

/// Preserve character positions but replace quoted strings and comments with spaces.
fn visible_yaml_syntax(line: &str) -> String {
    let chars: Vec<char> = line.chars().collect();
    let mut visible = String::with_capacity(line.len());
    let mut index = 0;
    let mut single_quoted = false;
    let mut double_quoted = false;

    while index < chars.len() {
        let character = chars[index];
        if single_quoted {
            visible.push(' ');
            if character == '\'' {
                if chars.get(index + 1) == Some(&'\'') {
                    visible.push(' ');
                    index += 2;
                    continue;
                }
                single_quoted = false;
            }
        } else if double_quoted {
            visible.push(' ');
            if character == '\\' {
                if index + 1 < chars.len() {
                    visible.push(' ');
                    index += 2;
                    continue;
                }
            } else if character == '"' {
                double_quoted = false;
            }
        } else {
            match character {
                '\'' => {
                    single_quoted = true;
                    visible.push(' ');
                }
                '"' => {
                    double_quoted = true;
                    visible.push(' ');
                }
                '#' if index == 0 || chars[index - 1].is_whitespace() => break,
                _ => visible.push(character),
            }
        }
        index += 1;
    }
    visible
}

fn is_block_scalar_header(visible: &str) -> bool {
    let Some((_, suffix)) = visible.rsplit_once(':') else {
        return false;
    };
    let suffix = suffix.trim();
    let Some(first) = suffix.chars().next() else {
        return false;
    };
    if !matches!(first, '|' | '>') {
        return false;
    }
    let modifiers = &suffix[first.len_utf8()..];
    modifiers.len() <= 2
        && modifiers
            .chars()
            .all(|character| matches!(character, '+' | '-' | '1'..='9'))
}

#[cfg(test)]
mod tests {
    use super::*;

    const VALID: &str = r#"
apiVersion: runbooks.veviad.com/v1alpha1
kind: Runbook
metadata:
  id: linux-server-baseline
  version: 1.0.0
  title: Linux server security baseline
  description: |
    Check the host! Markdown *and aliases are prose here.
  tags: [linux, security]
spec:
  target:
    kind: active-terminal
  inputs:
    sshdConfig:
      type: path
      default: /etc/ssh/sshd_config
  declaredCapabilities:
    network: false
    privilege: root
    writes: [/etc/ssh/sshd_config]
  defaults:
    onFailure: pause
  steps:
    - id: ssh-root-login-disabled
      title: Disable direct root SSH login
      required: true
      check:
        uses: shell
        with:
          command: "sshd -T | grep -q '^permitrootlogin no$'"
          env:
            VRUN_SSHD_CONFIG: sshdConfig
        outcomes:
          compliantExitCodes: [0]
          noncompliantExitCodes: [1]
      apply:
        uses: agent
        instructions: |
          Make the smallest safe change and validate sshd configuration.
      verify:
        uses: shell
        with:
          command: "sshd -T | grep -q '^permitrootlogin no$'"
        passExitCodes: [0]
      onFailure: pause
"#;

    #[test]
    fn parses_the_minimum_v1alpha1_shape() {
        let definition = parse_and_validate(VALID).unwrap();
        assert_eq!(definition.metadata.id, "linux-server-baseline");
        assert_eq!(definition.spec.steps.len(), 1);
        assert!(!definition.uses_unavailable_executor());
        assert_eq!(
            definition.spec.steps[0]
                .verify
                .as_ref()
                .unwrap()
                .assurance(),
            VerificationAssurance::DeterministicShell
        );
    }

    #[test]
    fn unknown_and_duplicate_fields_are_rejected() {
        let unknown = VALID.replace("  title: Linux", "  surprise: true\n  title: Linux");
        assert!(matches!(
            parse_and_validate(&unknown),
            Err(DefinitionError::Yaml(_))
        ));

        let duplicate = VALID.replace("  version: 1.0.0", "  version: 1.0.0\n  version: 2.0.0");
        assert!(matches!(
            parse_and_validate(&duplicate),
            Err(DefinitionError::Yaml(_))
        ));
    }

    #[test]
    fn yaml_extensions_and_multiple_documents_are_rejected() {
        for source in [
            VALID.replace("metadata:\n", "metadata: &metadata\n"),
            VALID.replace("metadata:\n", "metadata: !include metadata.yaml\n"),
            VALID.replace("metadata:\n", "metadata:\n  <<: *metadata\n"),
        ] {
            assert!(matches!(
                parse_and_validate(&source),
                Err(DefinitionError::UnsafeYaml { .. }) | Err(DefinitionError::Yaml(_))
            ));
        }
        let multiple = format!("{VALID}\n---\n{VALID}");
        let result = parse_and_validate(&multiple);
        assert!(result.is_err(), "accepted multiple documents: {result:?}");
    }

    #[test]
    fn duplicate_steps_and_invalid_semver_are_rejected() {
        let duplicate_step = VALID.replace(
            "      onFailure: pause",
            "      onFailure: pause\n    - id: ssh-root-login-disabled\n      title: Again\n      check:\n        uses: manual\n        instructions: Confirm it",
        );
        let error = parse_and_validate(&duplicate_step).unwrap_err().to_string();
        assert!(error.contains("duplicate step ID"), "{error}");

        let invalid_version = VALID.replace("version: 1.0.0", "version: latest");
        let error = parse_and_validate(&invalid_version)
            .unwrap_err()
            .to_string();
        assert!(error.contains("semantic version"), "{error}");
    }

    #[test]
    fn title_like_fields_are_printable_single_lines() {
        for source in [
            VALID.replace(
                "  title: Linux server security baseline",
                "  title: |\n    Linux server\n    security baseline",
            ),
            VALID.replace(
                "      title: Disable direct root SSH login",
                "      title: \"Disable\\troot login\"",
            ),
            VALID.replace(
                "      type: path\n      default: /etc/ssh/sshd_config",
                "      type: enum\n      values: [\"staging\\nproduction\"]\n      default: \"staging\\nproduction\"",
            ),
            VALID.replace(
                "  title: Linux server security baseline",
                "  title: \"Linux\\u2028security baseline\"",
            ),
            VALID.replace(
                "      title: Disable direct root SSH login",
                "      title: \"Disable root \\u202elogin\"",
            ),
            VALID.replace(
                "  title: Linux server security baseline",
                "  title: \"Linux\\u180esecurity baseline\"",
            ),
            VALID.replace(
                "  title: Linux server security baseline",
                "  title: \"Linux\\ufff9security baseline\"",
            ),
            VALID.replace(
                "  title: Linux server security baseline",
                "  title: \"\\u034f\"",
            ),
            VALID.replace(
                "  title: Linux server security baseline",
                "  title: \"Linux\\ufe0f security baseline\"",
            ),
        ] {
            let error = parse_and_validate(&source).unwrap_err().to_string();
            assert!(error.contains("exactly one line"), "{error}");
        }
    }

    #[test]
    fn apply_requires_verify_and_verify_requires_apply() {
        let missing_verify = VALID.replace(
            "      verify:\n        uses: shell\n        with:\n          command: \"sshd -T | grep -q '^permitrootlogin no$'\"\n        passExitCodes: [0]\n",
            "",
        );
        let error = parse_and_validate(&missing_verify).unwrap_err().to_string();
        assert!(error.contains("required when apply is present"), "{error}");

        let missing_apply = VALID.replace(
            "      apply:\n        uses: agent\n        instructions: |\n          Make the smallest safe change and validate sshd configuration.\n",
            "",
        );
        let error = parse_and_validate(&missing_apply).unwrap_err().to_string();
        assert!(error.contains("cannot be present without apply"), "{error}");
    }

    #[test]
    fn shell_commands_are_one_bounded_line_without_heredocs() {
        for invalid in [
            "echo one\\necho two",
            "echo one <<EOF",
            "echo \\u{7}",
            "echo safe\\u202espoof",
            "echo zero\\u200bwidth",
        ] {
            let source = VALID.replace("sshd -T | grep -q '^permitrootlogin no$'", invalid);
            assert!(parse_and_validate(&source).is_err(), "accepted {invalid:?}");
        }

        let long = "x".repeat(MAX_SHELL_COMMAND_CHARS + 1);
        let source = VALID.replace("sshd -T | grep -q '^permitrootlogin no$'", &long);
        let error = parse_and_validate(&source).unwrap_err().to_string();
        assert!(error.contains("4096"), "{error}");
    }

    #[test]
    fn input_bindings_are_explicit_and_known() {
        let unknown = VALID.replace("VRUN_SSHD_CONFIG: sshdConfig", "VRUN_VALUE: missing");
        let error = parse_and_validate(&unknown).unwrap_err().to_string();
        assert!(error.contains("unknown input"), "{error}");

        for dangerous_name in ["PATH", "GIT_EXTERNAL_DIFF", "VRUN_"] {
            let dangerous = VALID.replace(
                "VRUN_SSHD_CONFIG: sshdConfig",
                &format!("{dangerous_name}: sshdConfig"),
            );
            let error = parse_and_validate(&dangerous).unwrap_err().to_string();
            assert!(
                error.contains("dedicated VRUN_"),
                "{dangerous_name}: {error}"
            );
        }
    }

    #[test]
    fn v1_rejects_secret_like_input_names() {
        for name in ["password", "apiToken", "client_secret", "ssh-private-key"] {
            let source = VALID.replace("sshdConfig:", &format!("{name}:"));
            let error = parse_and_validate(&source).unwrap_err().to_string();
            assert!(error.contains("secret-like inputs"), "{name}: {error}");
        }
    }

    #[test]
    fn runtime_inputs_are_typed_resolved_and_closed() {
        let mut definition = parse_and_validate(VALID).unwrap();
        definition.spec.inputs.insert(
            "environment".into(),
            InputDefinition {
                input_type: InputType::Enum,
                description: String::new(),
                required: true,
                default: None,
                values: vec!["staging".into(), "production".into()],
            },
        );

        let mut supplied = BTreeMap::new();
        supplied.insert("environment".into(), Value::String("staging".into()));
        let resolved = definition.resolve_inputs(&supplied).unwrap();
        assert_eq!(resolved["environment"], "staging");
        assert_eq!(resolved["sshdConfig"], "/etc/ssh/sshd_config");

        supplied.insert("environment".into(), Value::String("unknown".into()));
        assert!(definition.resolve_inputs(&supplied).is_err());
        supplied.insert("environment".into(), Value::String("staging".into()));
        supplied.insert("undeclared".into(), Value::Bool(true));
        assert!(definition.resolve_inputs(&supplied).is_err());
    }

    #[test]
    fn ansible_is_recognized_but_not_native() {
        let source = VALID.replace(
            "uses: agent\n        instructions: |\n          Make the smallest safe change and validate sshd configuration.",
            "uses: ansible.playbook\n        with:\n          playbook: ansible/site.yml",
        );
        let definition = parse_and_validate(&source).unwrap();
        assert!(definition.uses_unavailable_executor());
    }

    #[test]
    fn schema_is_draft_2020_12_and_deterministic() {
        let first = generated_schema_pretty();
        assert_eq!(first, generated_schema_pretty());
        assert!(first.contains("https://json-schema.org/draft/2020-12/schema"));
        assert!(first.contains("runbooks.veviad.com/v1alpha1"));
    }

    #[test]
    fn checked_in_schema_is_current() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("schemas/runbook-v1alpha1.schema.json");
        let expected = generated_schema_pretty();
        // Maintainers can intentionally refresh the artifact with one focused test
        // invocation; ordinary test runs are read-only and catch schema drift.
        if std::env::var_os("UPDATE_RUNBOOK_SCHEMA").is_some() {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, &expected).unwrap();
        }
        let actual = std::fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("cannot read {}: {error}", path.display()));
        assert_eq!(
            actual, expected,
            "run UPDATE_RUNBOOK_SCHEMA=1 cargo test checked_in_schema_is_current"
        );
    }
}
