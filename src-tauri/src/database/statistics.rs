//! Durable, append-only token usage statistics.
//!
//! Usage is intentionally independent from chat/session retention. Deleting a
//! conversation removes its content, but it must not rewrite a lifetime counter.
//! One row represents one provider call for which the provider reported usage.

use std::collections::HashMap;

use rusqlite::{params, Connection};
use serde::Serialize;

use crate::models::catalog::{CatalogModel, ProviderId, CATALOG};

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct TokenTotals {
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub model_calls: i64,
}

impl TokenTotals {
    fn add(&mut self, input_tokens: i64, output_tokens: i64, model_calls: i64) {
        self.input_tokens = self.input_tokens.saturating_add(input_tokens);
        self.output_tokens = self.output_tokens.saturating_add(output_tokens);
        self.model_calls = self.model_calls.saturating_add(model_calls);
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TokenGroup {
    pub id: String,
    pub label: String,
    pub provider: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub model_calls: i64,
    pub last_used_at: Option<String>,
}

impl TokenGroup {
    fn total_tokens(&self) -> i64 {
        self.input_tokens.saturating_add(self.output_tokens)
    }

    fn cmp_by_usage(&self, other: &Self) -> std::cmp::Ordering {
        other
            .total_tokens()
            .cmp(&self.total_tokens())
            .then_with(|| self.label.cmp(&other.label))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TokenStatistics {
    pub total: TokenTotals,
    pub local: TokenTotals,
    pub cloud: TokenTotals,
    pub by_provider: Vec<TokenGroup>,
    pub by_model: Vec<TokenGroup>,
    pub tracking_since: Option<String>,
}

/// Persist one provider-reported usage event. A provider call is the honest
/// denominator here: an Agent turn can make several provider calls as it uses
/// tools, and every one has its own billed input and output.
pub fn record(
    conn: &Connection,
    model: &CatalogModel,
    input_tokens: u32,
    output_tokens: u32,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO token_usage_events
            (id, model_id, model_label, provider, input_tokens, output_tokens, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            uuid::Uuid::new_v4().to_string(),
            model.id,
            model.label,
            model.provider.as_str(),
            i64::from(input_tokens),
            i64::from(output_tokens),
            chrono::Utc::now().to_rfc3339(),
        ],
    )
    .map(|_| ())
    .map_err(|error| format!("record token usage: {error}"))
}

#[derive(Debug)]
struct RawModelGroup {
    provider: String,
    model_id: String,
    model_label: String,
    input_tokens: i64,
    output_tokens: i64,
    model_calls: i64,
    last_used_at: Option<String>,
}

fn catalog_match(raw: &RawModelGroup) -> Option<&'static CatalogModel> {
    if !raw.model_id.is_empty() {
        CATALOG.iter().find(|model| model.id == raw.model_id)
    } else {
        CATALOG.iter().find(|model| model.label == raw.model_label)
    }
}

fn normalized_group(raw: RawModelGroup) -> TokenGroup {
    let known = catalog_match(&raw);
    let provider = if raw.provider == "unknown" {
        known
            .map(|model| model.provider.as_str())
            .unwrap_or("unknown")
            .to_string()
    } else {
        raw.provider
    };
    let id = if raw.model_id.is_empty() {
        known
            .map(|model| model.id.to_string())
            .unwrap_or_else(|| format!("legacy:{}", raw.model_label))
    } else {
        raw.model_id
    };
    TokenGroup {
        id,
        label: raw.model_label,
        provider,
        input_tokens: raw.input_tokens,
        output_tokens: raw.output_tokens,
        model_calls: raw.model_calls,
        last_used_at: raw.last_used_at,
    }
}

fn newer_timestamp(left: Option<String>, right: Option<String>) -> Option<String> {
    match (left, right) {
        (Some(left), Some(right)) => Some(left.max(right)),
        (left @ Some(_), None) => left,
        (None, right) => right,
    }
}

fn merge_model_groups(groups: Vec<TokenGroup>) -> Vec<TokenGroup> {
    let mut merged: HashMap<(String, String), TokenGroup> = HashMap::new();
    for group in groups {
        let key = (group.provider.clone(), group.id.clone());
        match merged.get_mut(&key) {
            Some(existing) => {
                existing.input_tokens = existing.input_tokens.saturating_add(group.input_tokens);
                existing.output_tokens = existing.output_tokens.saturating_add(group.output_tokens);
                existing.model_calls = existing.model_calls.saturating_add(group.model_calls);
                existing.last_used_at =
                    newer_timestamp(existing.last_used_at.take(), group.last_used_at);
            }
            None => {
                merged.insert(key, group);
            }
        }
    }
    let mut groups = merged.into_values().collect::<Vec<_>>();
    groups.sort_by(TokenGroup::cmp_by_usage);
    groups
}

fn provider_label(provider: &str) -> &str {
    match provider {
        "local" => "On-device",
        "anthropic" => "Anthropic",
        "openai" => "OpenAI",
        "mistral" => "Mistral",
        "remote" => "Remote providers",
        _ => "Other cloud models",
    }
}

pub fn get(conn: &Connection) -> Result<TokenStatistics, String> {
    let mut stmt = conn
        .prepare(
            "SELECT provider, model_id, model_label,
                    SUM(input_tokens), SUM(output_tokens), COUNT(*), MAX(created_at)
               FROM token_usage_events
              GROUP BY provider, model_id, model_label",
        )
        .map_err(|error| error.to_string())?;
    let raw = stmt
        .query_map([], |row| {
            Ok(RawModelGroup {
                provider: row.get(0)?,
                model_id: row.get(1)?,
                model_label: row.get(2)?,
                input_tokens: row.get(3)?,
                output_tokens: row.get(4)?,
                model_calls: row.get(5)?,
                last_used_at: row.get(6)?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;

    let by_model = merge_model_groups(raw.into_iter().map(normalized_group).collect());
    let mut total = TokenTotals::default();
    let mut local = TokenTotals::default();
    let mut cloud = TokenTotals::default();
    let mut providers: HashMap<String, TokenGroup> = HashMap::new();

    for model in &by_model {
        total.add(model.input_tokens, model.output_tokens, model.model_calls);
        // The user-facing distinction is deliberately binary: only the app's
        // on-device provider is local. Configured servers and every API provider
        // count as cloud because they are not running in-process on this machine.
        if model.provider == ProviderId::Local.as_str() {
            local.add(model.input_tokens, model.output_tokens, model.model_calls);
        } else {
            cloud.add(model.input_tokens, model.output_tokens, model.model_calls);
        }
        let provider = providers
            .entry(model.provider.clone())
            .or_insert_with(|| TokenGroup {
                id: model.provider.clone(),
                label: provider_label(&model.provider).to_string(),
                provider: model.provider.clone(),
                input_tokens: 0,
                output_tokens: 0,
                model_calls: 0,
                last_used_at: None,
            });
        provider.input_tokens = provider.input_tokens.saturating_add(model.input_tokens);
        provider.output_tokens = provider.output_tokens.saturating_add(model.output_tokens);
        provider.model_calls = provider.model_calls.saturating_add(model.model_calls);
        provider.last_used_at =
            newer_timestamp(provider.last_used_at.take(), model.last_used_at.clone());
    }

    let mut by_provider = providers.into_values().collect::<Vec<_>>();
    by_provider.sort_by(TokenGroup::cmp_by_usage);
    let tracking_since = conn
        .query_row(
            "SELECT MIN(created_at) FROM token_usage_events",
            [],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;

    Ok(TokenStatistics {
        total,
        local,
        cloud,
        by_provider,
        by_model,
        tracking_since,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn database() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::database::migrations::run(&conn).unwrap();
        conn
    }

    fn insert(
        conn: &Connection,
        id: &str,
        model_id: &str,
        label: &str,
        provider: &str,
        input: i64,
        output: i64,
    ) {
        conn.execute(
            "INSERT INTO token_usage_events
                (id, model_id, model_label, provider, input_tokens, output_tokens, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, '2026-08-26T10:00:00Z')",
            params![id, model_id, label, provider, input, output],
        )
        .unwrap();
    }

    #[test]
    fn aggregates_lifetime_usage_by_location_provider_and_model() {
        let conn = database();
        insert(
            &conn,
            "1",
            "local/qwen3.5-9b",
            "Qwen3.5 9B",
            "local",
            100,
            25,
        );
        insert(
            &conn,
            "2",
            "local/qwen3.5-9b",
            "Qwen3.5 9B",
            "local",
            50,
            10,
        );
        insert(
            &conn,
            "3",
            "openai/gpt-5.6-terra",
            "GPT-5.6 Terra",
            "openai",
            200,
            40,
        );
        insert(&conn, "4", "remote/s/model", "Custom", "remote", 30, 5);

        let stats = get(&conn).unwrap();
        assert_eq!(
            stats.total,
            TokenTotals {
                input_tokens: 380,
                output_tokens: 80,
                model_calls: 4
            }
        );
        assert_eq!(
            stats.local,
            TokenTotals {
                input_tokens: 150,
                output_tokens: 35,
                model_calls: 2
            }
        );
        assert_eq!(
            stats.cloud,
            TokenTotals {
                input_tokens: 230,
                output_tokens: 45,
                model_calls: 2
            }
        );
        assert_eq!(stats.by_model[0].label, "GPT-5.6 Terra");
        assert_eq!(stats.by_model[1].model_calls, 2);
        assert_eq!(stats.by_provider.len(), 3);
    }

    #[test]
    fn recognizes_imported_local_chat_rows_by_catalog_label() {
        let conn = database();
        insert(&conn, "legacy", "", "Qwen3.5 9B", "unknown", 80, 20);

        let stats = get(&conn).unwrap();
        assert_eq!(stats.local.input_tokens + stats.local.output_tokens, 100);
        assert_eq!(stats.cloud.input_tokens + stats.cloud.output_tokens, 0);
        assert_eq!(stats.by_model[0].id, "local/qwen3.5-9b");
        assert_eq!(stats.by_model[0].provider, "local");
    }

    #[test]
    fn future_provider_ids_remain_countable_as_cloud_usage() {
        let conn = database();
        insert(
            &conn,
            "future",
            "future/model",
            "Future model",
            "future_provider",
            40,
            10,
        );

        let stats = get(&conn).unwrap();
        assert_eq!(stats.local, TokenTotals::default());
        assert_eq!(
            stats.cloud,
            TokenTotals {
                input_tokens: 40,
                output_tokens: 10,
                model_calls: 1,
            }
        );
        assert_eq!(stats.by_provider[0].provider, "future_provider");
        assert_eq!(stats.by_provider[0].label, "Other cloud models");
    }
}
