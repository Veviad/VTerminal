use std::collections::BTreeMap;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::ipc::Channel;
use tauri::Wry;

use crate::agent::StreamEvent;
use crate::provider::{ToolCall, ToolDef};

use super::approval::{McpApprovalDecision, McpApprovalState};
use super::client::{grant_matches, McpManager, McpToolResultView, McpToolView};
use super::config::{self, McpChatSelection, McpServerConfig, McpToolGrant};

const APPROVAL_TIMEOUT: Duration = Duration::from_secs(600);
const DIRECT_SCHEMA_BUDGET_PERCENT: usize = 3;
const SEARCH_RESULT_LIMIT: usize = 8;

pub struct McpDispatchResult {
    pub model_text: String,
    pub structured_tool_result: Option<crate::provider::StructuredToolResult>,
}

impl McpDispatchResult {
    pub fn text(model_text: impl Into<String>) -> Self {
        Self {
            model_text: model_text.into(),
            structured_tool_result: None,
        }
    }
}

/// One immutable view of the selected MCP capabilities for a model run. Server
/// configuration and tool schemas are captured once so approvals and the
/// provider's cached prefix cannot change underneath an active turn.
pub struct McpRunContext<'a> {
    app: &'a tauri::AppHandle<Wry>,
    manager: &'a McpManager,
    approvals: &'a McpApprovalState,
    pub request_id: String,
    pub conversation_id: String,
    servers: BTreeMap<String, McpServerConfig>,
    pub tools: Vec<McpToolView>,
    brokered: bool,
}

impl<'a> McpRunContext<'a> {
    pub async fn prepare(
        app: &'a tauri::AppHandle<Wry>,
        manager: &'a McpManager,
        approvals: &'a McpApprovalState,
        request_id: &str,
        conversation_id: &str,
        selection: &McpChatSelection,
        context_tokens: u32,
        on_event: &Channel<StreamEvent>,
    ) -> Result<Self, String> {
        let configured = config::read_servers(app);
        let mut servers = BTreeMap::new();
        let mut tools = Vec::new();
        for id in &selection.server_ids {
            let Some(server) = configured.iter().find(|candidate| &candidate.id == id) else {
                let _ = on_event.send(StreamEvent::McpServerProblem {
                    server_id: id.clone(),
                    message: "This selected MCP server was deleted or is unavailable".into(),
                });
                continue;
            };
            if !server.enabled {
                let _ = on_event.send(StreamEvent::McpServerProblem {
                    server_id: id.clone(),
                    message: format!("{} is disabled", server.name),
                });
                continue;
            }
            match manager.list_tools(app, conversation_id, server).await {
                Ok(mut found) => {
                    if let Some(disabled) = selection.disabled_tools.get(id) {
                        found.retain(|tool| !disabled.iter().any(|name| name == &tool.name));
                    }
                    tools.extend(found);
                    servers.insert(id.clone(), server.clone());
                }
                Err(message) => {
                    let _ = on_event.send(StreamEvent::McpServerProblem {
                        server_id: id.clone(),
                        message,
                    });
                }
            }
        }
        let schema_bytes = serde_json::to_vec(&tools).map_or(0, |bytes| bytes.len());
        // Four UTF-8 bytes per token is deliberately conservative for JSON. If a
        // model has no trustworthy window metadata, 16 KiB keeps the provider
        // request bounded while still exposing a normal handful of tools.
        let budget = if context_tokens == 0 {
            16 * 1024
        } else {
            (context_tokens as usize * 4 * DIRECT_SCHEMA_BUDGET_PERCENT) / 100
        };
        Ok(Self {
            app,
            manager,
            approvals,
            request_id: request_id.to_owned(),
            conversation_id: conversation_id.to_owned(),
            servers,
            tools,
            brokered: schema_bytes > budget,
        })
    }

    pub fn tool_defs(&self) -> Vec<ToolDef> {
        if self.tools.is_empty() {
            return Vec::new();
        }
        if self.brokered {
            return vec![
                ToolDef {
                    name: "mcp_search_tools".into(),
                    description: "Search the MCP tools selected for this chat. Returns exact aliases and input schemas for the best matches. Use before mcp_call_tool.".into(),
                    parameters: json!({
                        "type": "object",
                        "properties": {
                            "query": { "type": "string", "description": "Capability, service, or operation to find" }
                        },
                        "required": ["query"]
                    }),
                },
                ToolDef {
                    name: "mcp_call_tool".into(),
                    description: "Call one MCP tool returned by mcp_search_tools using its exact alias and arguments matching its exact schema.".into(),
                    parameters: json!({
                        "type": "object",
                        "properties": {
                            "alias": { "type": "string" },
                            "arguments": { "type": "object" }
                        },
                        "required": ["alias", "arguments"]
                    }),
                },
            ];
        }
        self.tools
            .iter()
            .map(|tool| ToolDef {
                name: tool.alias.clone(),
                description: format!(
                    "MCP server: {}. {}",
                    tool.server_name,
                    tool.description
                        .as_deref()
                        .unwrap_or("No description supplied")
                ),
                parameters: tool.input_schema.clone(),
            })
            .collect()
    }

    pub fn owns_call(&self, name: &str) -> bool {
        (self.brokered && matches!(name, "mcp_search_tools" | "mcp_call_tool"))
            || self.tools.iter().any(|tool| tool.alias == name)
    }

    fn find_tool(&self, alias: &str) -> Option<&McpToolView> {
        self.tools.iter().find(|tool| tool.alias == alias)
    }

    fn search(&self, arguments: &Value) -> String {
        let query = arguments
            .get("query")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        if query.is_empty() {
            return "Error: mcp_search_tools requires a non-empty query".into();
        }
        let words = query.split_whitespace().collect::<Vec<_>>();
        let mut scored = self
            .tools
            .iter()
            .filter_map(|tool| {
                let haystack = format!(
                    "{} {} {} {}",
                    tool.server_name,
                    tool.name,
                    tool.title.as_deref().unwrap_or(""),
                    tool.description.as_deref().unwrap_or("")
                )
                .to_ascii_lowercase();
                let score = words
                    .iter()
                    .filter(|word| haystack.contains(**word))
                    .count();
                (score > 0).then_some((score, tool))
            })
            .collect::<Vec<_>>();
        scored.sort_by(|(left, a), (right, b)| right.cmp(left).then_with(|| a.alias.cmp(&b.alias)));
        let results = scored
            .into_iter()
            .take(SEARCH_RESULT_LIMIT)
            .map(|(_, tool)| {
                json!({
                    "server": tool.server_name,
                    "name": tool.name,
                    "alias": tool.alias,
                    "description": tool.description,
                    "inputSchema": tool.input_schema,
                })
            })
            .collect::<Vec<_>>();
        serde_json::to_string_pretty(&results).unwrap_or_else(|_| "[]".into())
    }

    fn resolve_call<'b>(&'b self, call: &'b ToolCall) -> Result<(&'b McpToolView, Value), String> {
        let parsed = serde_json::from_str::<Value>(&call.arguments)
            .map_err(|_| "MCP tool arguments are not valid JSON".to_string())?;
        if call.name == "mcp_call_tool" {
            let alias = parsed
                .get("alias")
                .and_then(Value::as_str)
                .ok_or("mcp_call_tool requires an exact alias")?;
            let arguments = parsed
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            return self
                .find_tool(alias)
                .map(|tool| (tool, arguments))
                .ok_or_else(|| "mcp_call_tool received an unknown alias; search again".into());
        }
        self.find_tool(&call.name)
            .map(|tool| (tool, parsed))
            .ok_or_else(|| "unknown MCP tool alias".into())
    }

    pub async fn dispatch(
        &self,
        call: &ToolCall,
        cancel: &tokio::sync::watch::Receiver<bool>,
        on_event: &Channel<StreamEvent>,
    ) -> Result<McpDispatchResult, String> {
        let parsed = serde_json::from_str::<Value>(&call.arguments).unwrap_or(Value::Null);
        if call.name == "mcp_search_tools" {
            return Ok(McpDispatchResult::text(self.search(&parsed)));
        }
        let (tool, arguments) = self.resolve_call(call)?;
        if !arguments.is_object() && !arguments.is_null() {
            return Err("MCP tool arguments must be a JSON object".into());
        }
        let server = self
            .servers
            .get(&tool.server_id)
            .ok_or("the MCP server is no longer available to this run")?;
        let remembered = grant_matches(&config::read_grants(self.app), server, tool);
        let approval_id = format!("{}-mcp-{}", self.request_id, uuid::Uuid::new_v4());
        if !remembered {
            let receiver = self.approvals.register(&approval_id, &self.request_id);
            let _ = on_event.send(StreamEvent::McpToolProposal {
                approval_id: approval_id.clone(),
                server_id: tool.server_id.clone(),
                server_name: tool.server_name.clone(),
                tool_name: tool.name.clone(),
                title: tool.title.clone(),
                description: tool.description.clone(),
                arguments: arguments.clone(),
                schema_hash: tool.schema_hash.clone(),
            });
            let mut cancel = cancel.clone();
            let decision = tokio::select! {
                response = receiver => response.map_err(|_| "MCP approval was cancelled".to_string())?.decision,
                _ = cancel.changed() => return Err("MCP tool call cancelled".into()),
                _ = tokio::time::sleep(APPROVAL_TIMEOUT) => return Err("MCP approval timed out".into()),
            };
            match decision {
                McpApprovalDecision::Deny => {
                    return Ok(McpDispatchResult::text("User denied this MCP tool call. Do not retry it unless they explicitly ask."));
                }
                McpApprovalDecision::AlwaysAllow => {
                    let mut grants = config::read_grants(self.app);
                    grants.retain(|grant| {
                        grant.server_id != server.id || grant.tool_name != tool.name
                    });
                    grants.push(McpToolGrant {
                        server_id: server.id.clone(),
                        tool_name: tool.name.clone(),
                        revision: server.revision,
                        schema_hash: tool.schema_hash.clone(),
                    });
                    config::write_grants(self.app, &grants)?;
                }
                McpApprovalDecision::AllowOnce => {}
            }
        }
        let _ = on_event.send(StreamEvent::McpToolStarted {
            approval_id: approval_id.clone(),
            server_id: tool.server_id.clone(),
            server_name: tool.server_name.clone(),
            tool_name: tool.name.clone(),
            arguments: arguments.clone(),
        });
        let result = self
            .manager
            .call_tool(
                self.app,
                &self.conversation_id,
                server,
                &tool.name,
                arguments,
            )
            .await;
        match result {
            Ok(result) => {
                let model_text = result.model_text.clone();
                let structured_tool_result = Some(result.transcript_content());
                let _ = on_event.send(StreamEvent::McpToolResult {
                    approval_id,
                    server_id: tool.server_id.clone(),
                    server_name: tool.server_name.clone(),
                    tool_name: tool.name.clone(),
                    result,
                    error: None,
                });
                Ok(McpDispatchResult {
                    model_text,
                    structured_tool_result,
                })
            }
            Err(error) => {
                let _ = on_event.send(StreamEvent::McpToolResult {
                    approval_id,
                    server_id: tool.server_id.clone(),
                    server_name: tool.server_name.clone(),
                    tool_name: tool.name.clone(),
                    result: McpToolResultView {
                        content: Vec::new(),
                        structured_content: None,
                        is_error: true,
                        model_text: error.clone(),
                        truncated: false,
                    },
                    error: Some(error.clone()),
                });
                // Transport/protocol failures are visible tool results so one
                // unavailable server does not discard the rest of the turn.
                Ok(McpDispatchResult {
                    model_text: format!("MCP tool error: {error}"),
                    structured_tool_result: Some(crate::provider::StructuredToolResult {
                        content: Vec::new(),
                        structured_content: None,
                        is_error: true,
                        truncated: false,
                    }),
                })
            }
        }
    }
}
