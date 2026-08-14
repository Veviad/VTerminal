//! Typed, resumable authoring documents for the assessment-only Runbook wizard.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

use super::definition::{
    CheckAction, CheckOutcomes, DeclaredCapabilities, Defaults, FailurePolicy, InputDefinition,
    InputType, Metadata, Privilege, RunbookDefinition, ShellAction, Spec, Step, Target, TargetKind,
    ValidationError, API_VERSION, KIND,
};

pub const MAX_DRAFT_JSON_BYTES: usize = 512 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DraftPlatform {
    Macos13,
    Linux,
    Any,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RunbookDraftDocument {
    pub definition_id: String,
    pub version: String,
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub tags: Vec<String>,
    pub platform: DraftPlatform,
    #[serde(default)]
    pub network: bool,
    #[serde(default)]
    pub privilege: Privilege,
    #[serde(default)]
    pub default_on_failure: FailurePolicy,
    #[serde(default)]
    pub inputs: Vec<DraftInput>,
    #[serde(default)]
    pub steps: Vec<DraftStep>,
}

impl Default for RunbookDraftDocument {
    fn default() -> Self {
        Self {
            definition_id: String::new(),
            version: "1.0.0".into(),
            title: String::new(),
            description: String::new(),
            tags: Vec::new(),
            platform: DraftPlatform::Macos13,
            network: false,
            privilege: Privilege::None,
            default_on_failure: FailurePolicy::Continue,
            inputs: Vec::new(),
            steps: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DraftInput {
    pub id: String,
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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DraftStep {
    pub id: String,
    pub title: String,
    #[serde(default = "required_by_default")]
    pub required: bool,
    #[serde(default)]
    pub on_failure: Option<FailurePolicy>,
    pub check: DraftCheck,
}

fn required_by_default() -> bool {
    true
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum DraftCheck {
    Shell {
        command: String,
        #[serde(default)]
        env: BTreeMap<String, String>,
        #[serde(default = "compliant_default", rename = "compliantExitCodes")]
        compliant_exit_codes: Vec<i32>,
        #[serde(default = "noncompliant_default", rename = "noncompliantExitCodes")]
        noncompliant_exit_codes: Vec<i32>,
    },
    Manual {
        instructions: String,
    },
}

fn compliant_default() -> Vec<i32> {
    vec![0]
}

fn noncompliant_default() -> Vec<i32> {
    vec![1]
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunbookDraft {
    pub id: String,
    pub revision: i64,
    pub document: RunbookDraftDocument,
    pub published_source_id: Option<String>,
    pub last_published_version: Option<String>,
    pub dirty: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunbookDraftSummary {
    pub id: String,
    pub revision: i64,
    pub title: String,
    pub definition_id: String,
    pub version: String,
    pub published_source_id: Option<String>,
    pub last_published_version: Option<String>,
    pub dirty: bool,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunbookDraftPreview {
    pub definition: Option<RunbookDefinition>,
    pub source_yaml: Option<String>,
    pub readme: Option<String>,
    pub issues: Vec<ValidationError>,
}

pub fn document_json(document: &RunbookDraftDocument) -> Result<String, String> {
    let json = serde_json::to_string(document)
        .map_err(|error| format!("encode runbook draft: {error}"))?;
    if json.len() > MAX_DRAFT_JSON_BYTES {
        return Err(format!(
            "runbook draft exceeds {MAX_DRAFT_JSON_BYTES} bytes"
        ));
    }
    Ok(json)
}

pub fn decode_document(json: &str) -> Result<RunbookDraftDocument, String> {
    if json.len() > MAX_DRAFT_JSON_BYTES {
        return Err(format!(
            "stored runbook draft exceeds {MAX_DRAFT_JSON_BYTES} bytes"
        ));
    }
    serde_json::from_str(json).map_err(|error| format!("decode runbook draft: {error}"))
}

pub fn preview(document: &RunbookDraftDocument) -> RunbookDraftPreview {
    let definition = build_definition(document);
    let mut issues = match definition.validate() {
        Ok(()) => Vec::new(),
        Err(issues) => issues,
    };
    if !issues.is_empty() {
        return RunbookDraftPreview {
            definition: None,
            source_yaml: None,
            readme: None,
            issues,
        };
    }
    let source_yaml = match serde_saphyr::to_string(&definition) {
        Ok(source) => source,
        Err(error) => {
            issues.push(ValidationError {
                path: "document".into(),
                message: format!("could not serialize YAML: {error}"),
            });
            return RunbookDraftPreview {
                definition: None,
                source_yaml: None,
                readme: None,
                issues,
            };
        }
    };
    match super::definition::parse_and_validate(&source_yaml) {
        Ok(parsed) => RunbookDraftPreview {
            definition: Some(parsed),
            source_yaml: Some(source_yaml),
            readme: Some(generate_readme(document)),
            issues,
        },
        Err(error) => {
            issues.push(ValidationError {
                path: "document".into(),
                message: error.to_string(),
            });
            RunbookDraftPreview {
                definition: None,
                source_yaml: None,
                readme: None,
                issues,
            }
        }
    }
}

fn build_definition(document: &RunbookDraftDocument) -> RunbookDefinition {
    let mut inputs = BTreeMap::new();
    for input in &document.inputs {
        inputs.insert(
            input.id.clone(),
            InputDefinition {
                input_type: input.input_type,
                description: input.description.clone(),
                required: input.required,
                default: input.default.clone(),
                values: input.values.clone(),
            },
        );
    }
    let mut steps = Vec::new();
    if let Some(guard) = platform_guard(document.platform) {
        steps.push(guard);
    }
    steps.extend(document.steps.iter().map(|step| Step {
        id: step.id.clone(),
        title: step.title.clone(),
        required: step.required,
        check: match &step.check {
            DraftCheck::Shell {
                command,
                env,
                compliant_exit_codes,
                noncompliant_exit_codes,
            } => CheckAction::Shell {
                action: ShellAction {
                    command: command.clone(),
                    env: env.clone(),
                },
                outcomes: CheckOutcomes {
                    compliant_exit_codes: compliant_exit_codes.clone(),
                    noncompliant_exit_codes: noncompliant_exit_codes.clone(),
                },
            },
            DraftCheck::Manual { instructions } => CheckAction::Manual {
                instructions: instructions.clone(),
            },
        },
        apply: None,
        verify: None,
        on_failure: step.on_failure,
    }));
    RunbookDefinition {
        api_version: API_VERSION.into(),
        kind: KIND.into(),
        metadata: Metadata {
            id: document.definition_id.clone(),
            version: document.version.clone(),
            title: document.title.clone(),
            description: document.description.clone(),
            tags: document.tags.clone(),
        },
        spec: Spec {
            target: Target {
                kind: TargetKind::ActiveTerminal,
            },
            inputs,
            declared_capabilities: DeclaredCapabilities {
                network: document.network,
                privilege: document.privilege,
                writes: Vec::new(),
            },
            defaults: Defaults {
                on_failure: document.default_on_failure,
            },
            steps,
        },
    }
}

fn platform_guard(platform: DraftPlatform) -> Option<Step> {
    let (id, title, command) = match platform {
        DraftPlatform::Macos13 => (
            "supported-macos-target",
            "Target is running macOS 13 or newer",
            r#"test "$(uname -s)" = Darwin && major="$(sw_vers -productVersion | cut -d. -f1)" && test "$major" -ge 13 || exit 64"#,
        ),
        DraftPlatform::Linux => (
            "supported-linux-target",
            "Target is running Linux",
            r#"test "$(uname -s)" = Linux || exit 64"#,
        ),
        DraftPlatform::Any => return None,
    };
    Some(Step {
        id: id.into(),
        title: title.into(),
        required: true,
        check: CheckAction::Shell {
            action: ShellAction {
                command: command.into(),
                env: BTreeMap::new(),
            },
            outcomes: CheckOutcomes {
                compliant_exit_codes: vec![0],
                noncompliant_exit_codes: vec![1],
            },
        },
        apply: None,
        verify: None,
        on_failure: Some(FailurePolicy::Stop),
    })
}

fn generate_readme(document: &RunbookDraftDocument) -> String {
    let platform = match document.platform {
        DraftPlatform::Macos13 => "macOS 13 or newer",
        DraftPlatform::Linux => "Linux",
        DraftPlatform::Any => "any active terminal target",
    };
    format!(
        "# {}\n\n{}\n\nVersion: `{}`  \nTarget: {}  \nGenerated by the VTerminal assessment builder.\n",
        document.title,
        if document.description.trim().is_empty() { "Assessment-only VTerminal Runbook." } else { document.description.trim() },
        document.version,
        platform,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_document() -> RunbookDraftDocument {
        RunbookDraftDocument {
            definition_id: "wizard-health".into(),
            version: "1.0.0".into(),
            title: "Wizard Health".into(),
            description: "A deterministic assessment.".into(),
            tags: vec!["assessment".into()],
            platform: DraftPlatform::Macos13,
            network: false,
            privilege: Privilege::None,
            default_on_failure: FailurePolicy::Continue,
            inputs: vec![DraftInput {
                id: "minimumFreeSpaceGb".into(),
                input_type: InputType::Integer,
                description: "Minimum free space.".into(),
                required: false,
                default: Some(Value::from(20)),
                values: Vec::new(),
            }],
            steps: vec![DraftStep {
                id: "free-space".into(),
                title: "Free space is available".into(),
                required: true,
                on_failure: None,
                check: DraftCheck::Shell {
                    command: "test \"$VRUN_MINIMUM_FREE_SPACE_GB\" -gt 0".into(),
                    env: BTreeMap::from([(
                        "VRUN_MINIMUM_FREE_SPACE_GB".into(),
                        "minimumFreeSpaceGb".into(),
                    )]),
                    compliant_exit_codes: vec![0],
                    noncompliant_exit_codes: vec![1],
                },
            }],
        }
    }

    #[test]
    fn wizard_document_generates_strict_importable_yaml_and_platform_guard() {
        let document = valid_document();
        let json = document_json(&document).unwrap();
        assert!(json.contains("compliantExitCodes"));
        assert_eq!(decode_document(&json).unwrap(), document);
        let preview = preview(&document);
        assert!(preview.issues.is_empty(), "{:?}", preview.issues);
        let definition = preview.definition.unwrap();
        assert_eq!(definition.spec.steps[0].id, "supported-macos-target");
        assert_eq!(definition.spec.steps[1].id, "free-space");
        let parsed =
            super::super::definition::parse_and_validate(&preview.source_yaml.unwrap()).unwrap();
        assert_eq!(parsed.metadata.id, "wizard-health");
        assert!(preview
            .readme
            .unwrap()
            .contains("Generated by the VTerminal"));
    }

    #[test]
    fn any_platform_has_no_hidden_guard_and_invalid_documents_report_paths() {
        let mut document = valid_document();
        document.platform = DraftPlatform::Any;
        document.definition_id.clear();
        let invalid_preview = preview(&document);
        assert!(invalid_preview.definition.is_none());
        assert!(invalid_preview
            .issues
            .iter()
            .any(|issue| issue.path == "metadata.id"));
        document.definition_id = "wizard-health".into();
        let preview = preview(&document);
        assert_eq!(preview.definition.unwrap().spec.steps.len(), 1);
    }

    #[test]
    fn wizard_supports_every_input_type_and_manual_checks() {
        let mut document = valid_document();
        document.platform = DraftPlatform::Linux;
        document.inputs = vec![
            DraftInput {
                id: "label".into(),
                input_type: InputType::String,
                description: String::new(),
                required: false,
                default: Some(Value::from("workstation")),
                values: Vec::new(),
            },
            DraftInput {
                id: "count".into(),
                input_type: InputType::Integer,
                description: String::new(),
                required: false,
                default: Some(Value::from(2)),
                values: Vec::new(),
            },
            DraftInput {
                id: "enabled".into(),
                input_type: InputType::Boolean,
                description: String::new(),
                required: false,
                default: Some(Value::from(false)),
                values: Vec::new(),
            },
            DraftInput {
                id: "configPath".into(),
                input_type: InputType::Path,
                description: String::new(),
                required: true,
                default: Some(Value::from("/etc/example.conf")),
                values: Vec::new(),
            },
            DraftInput {
                id: "mode".into(),
                input_type: InputType::Enum,
                description: String::new(),
                required: false,
                default: Some(Value::from("strict")),
                values: vec!["strict".into(), "relaxed".into()],
            },
        ];
        document.steps[0].check = DraftCheck::Shell {
            command: "true".into(),
            env: BTreeMap::new(),
            compliant_exit_codes: vec![0],
            noncompliant_exit_codes: vec![1],
        };
        document.steps.push(DraftStep {
            id: "operator-review".into(),
            title: "Operator reviews the result".into(),
            required: false,
            on_failure: Some(FailurePolicy::Pause),
            check: DraftCheck::Manual {
                instructions: "Confirm the workstation is ready.".into(),
            },
        });
        let preview = preview(&document);
        assert!(preview.issues.is_empty(), "{:?}", preview.issues);
        let definition = preview.definition.unwrap();
        assert_eq!(definition.spec.steps[0].id, "supported-linux-target");
        assert_eq!(definition.spec.inputs.len(), 5);
        assert!(matches!(
            definition.spec.steps[2].check,
            CheckAction::Manual { .. }
        ));
        assert!(!definition.uses_unavailable_executor());
    }
}
