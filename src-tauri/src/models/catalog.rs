//! The single source of truth for every model the app offers.
//!
//! This is a strict allowlist: if a model is not in `CATALOG`, it cannot be
//! selected, downloaded, or sent a request. Two invariants make that workable:
//!
//! 1. Every entry declares the reasoning-effort rungs it *actually* supports
//!    (`efforts`). A boolean can't express `low|medium|high|xhigh|max`
//!    (Anthropic Sonnet 5 / Opus 5, OpenAI), a ladder that stops at `high`
//!    (Mistral), a numeric `budget_tokens` (Claude Haiku 4.5, which *errors* on
//!    the effort param) and a plain on/off toggle (Qwen and Gemma hybrid
//!    thinking) at once — so the app carries one normalized ladder and each
//!    provider maps it onto its own wire parameter. The UI renders exactly
//!    these rungs, so a rung the model would reject is never offered.
//! 2. Local entries name a concrete GGUF file whose architecture the embedded
//!    llama.cpp engine can load. Sizes and `min_ram_gb` below were taken from
//!    the Hugging Face tree API and rounded up through the fit rule in
//!    `registry::fits_in_ram` (`size * 1.3 < ram * 0.6`).
//!
//! Refreshing the lineup is a single-file edit — that is the whole point of
//! keeping this flat and declarative.

use serde::{Deserialize, Serialize};

/// Normalized reasoning-effort ladder.
///
/// `Off` means "do not think at all"; the rest are relative depths. Providers
/// clamp a requested rung to what the model declares, then translate. Ordering
/// is meaningful — `clamp` walks it to find the nearest supported rung.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Effort {
    Off,
    Low,
    Medium,
    High,
    Max,
}

impl Effort {
    pub fn as_str(self) -> &'static str {
        match self {
            Effort::Off => "off",
            Effort::Low => "low",
            Effort::Medium => "medium",
            Effort::High => "high",
            Effort::Max => "max",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "off" => Some(Effort::Off),
            "low" => Some(Effort::Low),
            "medium" => Some(Effort::Medium),
            "high" => Some(Effort::High),
            "max" => Some(Effort::Max),
            _ => None,
        }
    }

    /// Position on the ladder, for nearest-rung math.
    fn rank(self) -> i32 {
        match self {
            Effort::Off => 0,
            Effort::Low => 1,
            Effort::Medium => 2,
            Effort::High => 3,
            Effort::Max => 4,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderId {
    Local,
    Anthropic,
    /// Renamed by hand. `rename_all = "snake_case"` emits "open_ai", which is
    /// neither what `as_str()` says nor what `BuiltInProviderId` in
    /// `src/lib/types.ts` matches on — and the frontend groups the settings rows
    /// by this string, so the mismatch deleted the entire OpenAI section (heading,
    /// API-key field and all three models) with no error anywhere.
    #[serde(rename = "openai")]
    OpenAi,
    Mistral,
    /// A server the user configured themselves — Ollama, LM Studio, or anything
    /// else speaking the chat-completions shape. One variant rather than one per
    /// product: the product only decides which endpoint the *probe* asks for a
    /// model list, and that lives on the server record (`models::remote`). These
    /// models are NEVER in `CATALOG` — they are minted at runtime from settings.
    Remote,
}

impl ProviderId {
    pub fn as_str(self) -> &'static str {
        match self {
            ProviderId::Local => "local",
            ProviderId::Anthropic => "anthropic",
            ProviderId::OpenAi => "openai",
            ProviderId::Mistral => "mistral",
            ProviderId::Remote => "remote",
        }
    }

    /// Display name for the settings UI.
    pub fn label(self) -> &'static str {
        match self {
            ProviderId::Local => "On-device",
            ProviderId::Anthropic => "Anthropic",
            ProviderId::OpenAi => "OpenAI",
            ProviderId::Mistral => "Mistral",
            ProviderId::Remote => "Remote server",
        }
    }

    /// Settings key holding this provider's API key. `None` for local.
    ///
    /// Also `None` for `Remote`, and that is load-bearing rather than incidental:
    /// a remote token belongs to ONE server, not to every server of that kind, so
    /// it lives in Keychain keyed by server id. A `Some` here would
    /// make `resolve_provider` demand a key that has no single home.
    pub fn api_key_setting(self) -> Option<&'static str> {
        match self {
            ProviderId::Local | ProviderId::Remote => None,
            ProviderId::Anthropic => Some("anthropic_api_key"),
            ProviderId::OpenAi => Some("openai_api_key"),
            ProviderId::Mistral => Some("mistral_api_key"),
        }
    }
}

/// Quality level. Every provider offers exactly one model per tier.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Tier {
    Fast,
    Balanced,
    Max,
}

/// GGUF family. Selects the chat-template thinking control and the tool-call
/// parser the local engine uses — llama.cpp hands us raw text, so the format
/// of a tool call is per-family knowledge we have to hold ourselves.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LocalFamily {
    Qwen,
    Gemma,
}

#[derive(Debug, Clone, Copy, Serialize)]
pub struct LocalSpec {
    pub repo_id: &'static str,
    pub filename: &'static str,
    pub size_bytes: u64,
    pub min_ram_gb: u64,
    pub family: LocalFamily,
}

#[derive(Debug, Clone, Copy, Serialize)]
pub struct CatalogModel {
    /// Stable app-side id, e.g. "anthropic/claude-opus-5". Persisted in
    /// settings and used as the key of the per-model effort map, so it must
    /// not change once shipped.
    pub id: &'static str,
    pub provider: ProviderId,
    pub tier: Tier,
    pub label: &'static str,
    pub description: &'static str,
    /// What actually goes on the wire / identifies the GGUF.
    pub wire_model: &'static str,
    pub context_tokens: u32,
    /// The ONLY effort rungs this model accepts. Empty = cannot reason at all,
    /// and the UI hides the picker entirely.
    pub efforts: &'static [Effort],
    pub default_effort: Effort,
    /// Claude Opus 5 and Sonnet 5 reject `temperature` with a 400, as do the
    /// GPT-5.6 reasoning models — the request builder must omit it entirely.
    pub supports_temperature: bool,
    /// Whether this model serves a SERVER-SIDE web fetch on the wire shape
    /// this app speaks. Anthropic's Messages API does; OpenAI and Mistral
    /// both keep web tools on a different API (Responses / Conversations)
    /// than the chat-completions call `openai_compat` makes, so they are
    /// false here even though the models themselves are capable. Local
    /// GGUFs have nothing. False means the app falls back to the curl tier.
    ///
    /// Backend-only, like `supports_temperature` — there is no picker for it.
    pub native_web_fetch: bool,
    /// Whether an image may be sent to this model.
    ///
    /// For every LOCAL entry this is false, and that is **not a claim about the
    /// weights** — Qwen3.5-VL and Gemma 4 are multimodal. It is a claim about this
    /// app's engine: `chat_template.rs` renders `content` as a plain string, and
    /// llama.cpp needs an `mmproj` projector that `models/download.rs` does not
    /// fetch. Flipping one of these to true without building that path sends
    /// images into a renderer that silently drops them.
    ///
    /// Maintained by hand from 400s, exactly like `efforts`: provider `/v1/models`
    /// endpoints do not reliably report this, and guessing wrong is a failed
    /// request rather than a degraded one.
    pub supports_vision: bool,
    pub local: Option<LocalSpec>,
}

impl CatalogModel {
    pub fn is_local(&self) -> bool {
        self.local.is_some()
    }

    /// Nearest rung this model actually supports. Ties resolve downward, so a
    /// model offering only low/high/max answers a Medium request with Low
    /// rather than silently spending more than asked.
    pub fn clamp_effort(&self, requested: Effort) -> Effort {
        if self.efforts.contains(&requested) {
            return requested;
        }
        self.efforts
            .iter()
            .copied()
            .min_by_key(|e| ((e.rank() - requested.rank()).abs(), e.rank()))
            .unwrap_or(self.default_effort)
    }

    /// Effort to use when the user has expressed no preference.
    pub fn effective_effort(&self, stored: Option<Effort>) -> Effort {
        match stored {
            Some(e) => self.clamp_effort(e),
            None => self.default_effort,
        }
    }
}

/// Full ladder — the common case for models with a real effort parameter.
const FULL: &[Effort] = &[
    Effort::Off,
    Effort::Low,
    Effort::Medium,
    Effort::High,
    Effort::Max,
];
/// Hybrid-thinking models: on/off plus depth expressed as a token budget.
const TOGGLE_PLUS: &[Effort] = &[Effort::Off, Effort::Low, Effort::Medium, Effort::High];
/// No reasoning parameter at all. Not "the model always thinks" and not "it
/// never thinks" — it means the vendor's effort field is not accepted on this
/// model and sending it *fails the request*. Mistral Large 3 answers one with
/// `400 reasoning_effort is not enabled for this model`. Adapters must omit the
/// field entirely for these, and the UI hides the picker.
const NO_REASONING: &[Effort] = &[];
/// Mistral has no depth control at all — its API accepts exactly `none` and
/// `high`, and rejects anything else with a 400 naming the two legal values.
/// This is the whole Mistral lineup, not just the reasoning model.
const MISTRAL_TOGGLE: &[Effort] = &[Effort::Off, Effort::High];

pub const CATALOG: &[CatalogModel] = &[
    // ---------------------------------------------------------------- local
    // Sizes are the real Q4_K_M byte counts from the HF tree API; min_ram_gb
    // is derived from them via the recommend() fit rule, not guessed.
    CatalogModel {
        id: "local/qwen3.5-4b",
        provider: ProviderId::Local,
        tier: Tier::Fast,
        label: "Qwen3.5 4B",
        description: "Lightweight on-device default. Hybrid thinking and native tool calling on 8GB systems.",
        wire_model: "Qwen3.5-4B-Q4_K_M.gguf",
        context_tokens: 262_144,
        efforts: TOGGLE_PLUS,
        default_effort: Effort::Low,
        supports_temperature: true,
        native_web_fetch: false,
        supports_vision: false,
        local: Some(LocalSpec {
            repo_id: "unsloth/Qwen3.5-4B-GGUF",
            filename: "Qwen3.5-4B-Q4_K_M.gguf",
            size_bytes: 2_740_937_888,
            min_ram_gb: 8,
            family: LocalFamily::Qwen,
        }),
    },
    CatalogModel {
        id: "local/qwen3.5-9b",
        provider: ProviderId::Local,
        tier: Tier::Balanced,
        label: "Qwen3.5 9B",
        description: "Recommended on-device default. Best quality that runs comfortably with 16GB of memory.",
        wire_model: "Qwen3.5-9B-Q4_K_M.gguf",
        context_tokens: 262_144,
        efforts: TOGGLE_PLUS,
        default_effort: Effort::Medium,
        supports_temperature: true,
        native_web_fetch: false,
        supports_vision: false,
        local: Some(LocalSpec {
            repo_id: "unsloth/Qwen3.5-9B-GGUF",
            filename: "Qwen3.5-9B-Q4_K_M.gguf",
            size_bytes: 5_680_522_464,
            min_ram_gb: 16,
            family: LocalFamily::Qwen,
        }),
    },
    CatalogModel {
        id: "local/qwen3.6-27b",
        provider: ProviderId::Local,
        tier: Tier::Max,
        label: "Qwen3.6 27B",
        description: "Strongest on-device Qwen. Near-frontier agentic quality; needs about 48GB of memory.",
        wire_model: "Qwen3.6-27B-Q4_K_M.gguf",
        context_tokens: 262_144,
        efforts: TOGGLE_PLUS,
        default_effort: Effort::Medium,
        supports_temperature: true,
        native_web_fetch: false,
        supports_vision: false,
        local: Some(LocalSpec {
            repo_id: "unsloth/Qwen3.6-27B-GGUF",
            filename: "Qwen3.6-27B-Q4_K_M.gguf",
            size_bytes: 16_817_244_384,
            min_ram_gb: 48,
            family: LocalFamily::Qwen,
        }),
    },
    CatalogModel {
        id: "local/gemma-4-e2b",
        provider: ProviderId::Local,
        tier: Tier::Fast,
        label: "Gemma 4 E2B",
        description: "Smallest supported model. Apache 2.0, runs on 8GB Macs with a configurable thinking mode.",
        wire_model: "gemma-4-E2B-it-Q4_K_M.gguf",
        context_tokens: 131_072,
        efforts: TOGGLE_PLUS,
        default_effort: Effort::Low,
        supports_temperature: true,
        native_web_fetch: false,
        supports_vision: false,
        local: Some(LocalSpec {
            repo_id: "unsloth/gemma-4-E2B-it-GGUF",
            filename: "gemma-4-E2B-it-Q4_K_M.gguf",
            size_bytes: 3_106_738_272,
            min_ram_gb: 8,
            family: LocalFamily::Gemma,
        }),
    },
    CatalogModel {
        id: "local/gemma-4-e4b",
        provider: ProviderId::Local,
        tier: Tier::Balanced,
        label: "Gemma 4 E4B",
        description: "Google's balanced open model. Apache 2.0, native function calling, 16GB Macs and up.",
        wire_model: "gemma-4-E4B-it-Q4_K_M.gguf",
        context_tokens: 131_072,
        efforts: TOGGLE_PLUS,
        default_effort: Effort::Medium,
        supports_temperature: true,
        native_web_fetch: false,
        supports_vision: false,
        local: Some(LocalSpec {
            repo_id: "unsloth/gemma-4-E4B-it-GGUF",
            filename: "gemma-4-E4B-it-Q4_K_M.gguf",
            size_bytes: 4_977_171_584,
            min_ram_gb: 16,
            family: LocalFamily::Gemma,
        }),
    },
    CatalogModel {
        id: "local/gemma-4-31b",
        provider: ProviderId::Local,
        tier: Tier::Max,
        label: "Gemma 4 31B",
        description: "Largest Gemma 4. Best open-weight reasoning here, but needs 48GB of unified memory.",
        wire_model: "gemma-4-31B-it-Q4_K_M.gguf",
        context_tokens: 131_072,
        efforts: TOGGLE_PLUS,
        default_effort: Effort::Medium,
        supports_temperature: true,
        native_web_fetch: false,
        supports_vision: false,
        local: Some(LocalSpec {
            repo_id: "unsloth/gemma-4-31B-it-GGUF",
            filename: "gemma-4-31B-it-Q4_K_M.gguf",
            size_bytes: 18_323_733_440,
            min_ram_gb: 48,
            family: LocalFamily::Gemma,
        }),
    },
    // ------------------------------------------------------------ anthropic
    CatalogModel {
        id: "anthropic/claude-haiku-4-5",
        provider: ProviderId::Anthropic,
        tier: Tier::Fast,
        label: "Claude Haiku 4.5",
        description: "Fastest and cheapest Claude. Depth is a thinking budget — it has no effort parameter.",
        wire_model: "claude-haiku-4-5",
        context_tokens: 200_000,
        // Haiku 4.5 ERRORS on output_config.effort; the adapter spends these
        // rungs as thinking budget_tokens instead.
        efforts: TOGGLE_PLUS,
        default_effort: Effort::Low,
        supports_temperature: true,
        native_web_fetch: true,
        supports_vision: true,
        local: None,
    },
    CatalogModel {
        id: "anthropic/claude-sonnet-5",
        provider: ProviderId::Anthropic,
        tier: Tier::Balanced,
        label: "Claude Sonnet 5",
        description: "Near-Opus quality on coding and agentic work at Sonnet cost. 1M context.",
        wire_model: "claude-sonnet-5",
        context_tokens: 1_000_000,
        efforts: FULL,
        default_effort: Effort::High,
        // Sonnet 5 rejects temperature/top_p/top_k with a 400.
        supports_temperature: false,
        native_web_fetch: true,
        supports_vision: true,
        local: None,
    },
    CatalogModel {
        id: "anthropic/claude-opus-5",
        provider: ProviderId::Anthropic,
        tier: Tier::Max,
        label: "Claude Opus 5",
        description: "Strongest Claude for long-horizon agentic work. Thinking is on by default.",
        wire_model: "claude-opus-5",
        context_tokens: 1_000_000,
        efforts: FULL,
        default_effort: Effort::High,
        // Same 400 as Sonnet 5. Also: disabling thinking is only legal at
        // effort <= high, which the adapter enforces.
        supports_temperature: false,
        native_web_fetch: true,
        supports_vision: true,
        local: None,
    },
    // --------------------------------------------------------------- openai
    CatalogModel {
        id: "openai/gpt-5.6-luna",
        provider: ProviderId::OpenAi,
        tier: Tier::Fast,
        label: "GPT-5.6 Luna",
        description: "Most cost-efficient GPT-5.6. Built for high-volume, latency-sensitive work.",
        wire_model: "gpt-5.6-luna",
        context_tokens: 400_000,
        efforts: FULL,
        default_effort: Effort::Low,
        supports_temperature: false,
        native_web_fetch: false,
        supports_vision: true,
        local: None,
    },
    CatalogModel {
        id: "openai/gpt-5.6-terra",
        provider: ProviderId::OpenAi,
        tier: Tier::Balanced,
        label: "GPT-5.6 Terra",
        description: "Balance of intelligence and cost across the GPT-5.6 family.",
        wire_model: "gpt-5.6-terra",
        context_tokens: 400_000,
        efforts: FULL,
        default_effort: Effort::Medium,
        supports_temperature: false,
        native_web_fetch: false,
        supports_vision: true,
        local: None,
    },
    CatalogModel {
        id: "openai/gpt-5.6-sol",
        provider: ProviderId::OpenAi,
        tier: Tier::Max,
        label: "GPT-5.6 Sol",
        description: "Frontier GPT-5.6. Highest capability, highest spend.",
        wire_model: "gpt-5.6-sol",
        context_tokens: 400_000,
        efforts: FULL,
        default_effort: Effort::High,
        supports_temperature: false,
        native_web_fetch: false,
        supports_vision: true,
        local: None,
    },
    // -------------------------------------------------------------- mistral
    CatalogModel {
        id: "mistral/mistral-small-latest",
        provider: ProviderId::Mistral,
        tier: Tier::Fast,
        label: "Mistral Small 4",
        description: "Reasoning, vision and agentic coding in one small model. Reasoning is on or off.",
        wire_model: "mistral-small-latest",
        context_tokens: 128_000,
        efforts: MISTRAL_TOGGLE,
        default_effort: Effort::Off,
        supports_temperature: true,
        native_web_fetch: false,
        supports_vision: true,
        local: None,
    },
    CatalogModel {
        id: "mistral/magistral-medium-latest",
        provider: ProviderId::Mistral,
        tier: Tier::Balanced,
        label: "Magistral Medium",
        description: "Mistral's dedicated reasoning model with tokenized thinking chunks.",
        wire_model: "magistral-medium-latest",
        context_tokens: 128_000,
        efforts: MISTRAL_TOGGLE,
        // A dedicated reasoning model defaults to reasoning.
        default_effort: Effort::High,
        supports_temperature: true,
        native_web_fetch: false,
        supports_vision: true,
        local: None,
    },
    CatalogModel {
        id: "mistral/mistral-large-latest",
        provider: ProviderId::Mistral,
        tier: Tier::Max,
        label: "Mistral Large 3",
        description: "Mistral's flagship. Best quality in the lineup for complex agentic work.",
        wire_model: "mistral-large-latest",
        context_tokens: 128_000,
        // Not a reasoning model: it rejects the field rather than ignoring it.
        efforts: NO_REASONING,
        default_effort: Effort::Off,
        supports_temperature: true,
        native_web_fetch: false,
        // The one entry in this column not yet confirmed against a real
        // request. Mistral Large 3 already rejects `reasoning_effort`
        // outright (see NO_REASONING above), so its capability set is not
        // predictable from the rest of the lineup — if an image 400s here,
        // this is the bool to flip.
        supports_vision: true,
        local: None,
    },
];

/// The model selected when the user has never chosen one. Must run comfortably
/// on the 32GB M1 Pro baseline.
pub const DEFAULT_MODEL_ID: &str = "local/qwen3.5-9b";

pub fn find(id: &str) -> Option<&'static CatalogModel> {
    CATALOG.iter().find(|m| m.id == id)
}

/// Resolve a legacy `local_model_id` (a `repo_id::filename` pair from the
/// pre-catalog registry) onto a catalog id, so an upgrading user keeps their
/// selection instead of being silently reset.
pub fn find_by_legacy_local_id(legacy: &str) -> Option<&'static CatalogModel> {
    let (repo_id, filename) = legacy.split_once("::")?;
    CATALOG.iter().find(|m| {
        m.local
            .as_ref()
            .is_some_and(|l| l.repo_id == repo_id && l.filename == filename)
    })
}

pub fn local_models() -> impl Iterator<Item = &'static CatalogModel> {
    CATALOG.iter().filter(|m| m.is_local())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_unique_and_namespaced() {
        let mut seen = std::collections::HashSet::new();
        for m in CATALOG {
            assert!(seen.insert(m.id), "duplicate catalog id: {}", m.id);
            assert!(
                m.id.starts_with(&format!("{}/", m.provider.as_str())),
                "{} is not namespaced under its provider",
                m.id
            );
        }
    }

    /// Runtime-configured models are minted by `models::remote`, which every
    /// CATALOG-walking test below would otherwise have to reason about. Keeping
    /// them out of the table is what makes those tests correct as written — most
    /// of all `every_provider_offers_each_tier_once`, whose provider list is
    /// hard-coded precisely so `Remote` cannot wander into it.
    #[test]
    fn no_catalog_entry_is_remote() {
        assert!(
            CATALOG.iter().all(|m| m.provider != ProviderId::Remote),
            "remote models are built from settings at runtime, never listed here"
        );
    }

    /// The serialized name IS the frontend's `BuiltInProviderId`
    /// (`src/lib/types.ts`), because `CatalogEntry` flattens `CatalogModel` over
    /// IPC and the settings page groups its rows by that string. `rename_all =
    /// "snake_case"` mangles any multi-word variant — it emitted "open_ai" for a
    /// while, and the failure mode is not an error but a whole settings section
    /// rendering as nothing. `as_str()` is the single spelling both sides agree on,
    /// so every variant is pinned to it rather than to a literal list that would
    /// go stale.
    #[test]
    fn every_provider_serializes_as_its_own_str() {
        // The literals are pinned rather than derived, exactly as
        // `the_stored_kind_keeps_its_wire_spelling` pins `ServerKind`'s: this list
        // must read as `BuiltInProviderId | "remote"` does in src/lib/types.ts, and
        // asserting only `to_value == as_str()` would let both sides move together
        // while the frontend stayed behind.
        for (provider, wire) in [
            (ProviderId::Local, "local"),
            (ProviderId::Anthropic, "anthropic"),
            (ProviderId::OpenAi, "openai"),
            (ProviderId::Mistral, "mistral"),
            (ProviderId::Remote, "remote"),
        ] {
            assert_eq!(
                serde_json::to_value(provider).unwrap(),
                serde_json::json!(wire),
                "{provider:?} serializes as something the frontend does not match on"
            );
            // `as_str()` is the same name spelled a second way — it namespaces
            // every catalog id and answers `Provider::id()`, so a divergence would
            // give one provider two names on one wire.
            assert_eq!(provider.as_str(), wire);
        }
    }

    #[test]
    fn every_provider_offers_each_tier_once() {
        // Deliberately explicit, not `all providers`: Local is exempt (six
        // entries, two families) and Remote is not in the table at all.
        for provider in [
            ProviderId::Anthropic,
            ProviderId::OpenAi,
            ProviderId::Mistral,
        ] {
            for tier in [Tier::Fast, Tier::Balanced, Tier::Max] {
                let n = CATALOG
                    .iter()
                    .filter(|m| m.provider == provider && m.tier == tier)
                    .count();
                assert_eq!(
                    n, 1,
                    "{:?} should offer exactly one {:?} model",
                    provider, tier
                );
            }
        }
    }

    #[test]
    fn default_effort_is_always_supported() {
        for m in CATALOG {
            // A model with no rungs has no picker and no effort to default to;
            // its default is inert, and `Off` is the only honest spelling.
            if m.efforts.is_empty() {
                assert_eq!(
                    m.default_effort,
                    Effort::Off,
                    "{} declares no rungs but defaults to reasoning",
                    m.id
                );
                continue;
            }
            assert!(
                m.efforts.contains(&m.default_effort),
                "{} defaults to an effort it does not declare",
                m.id
            );
        }
    }

    #[test]
    fn clamp_picks_nearest_supported_rung() {
        // A hypothetical ladder with a hole in it: Off clamps up to the cheapest
        // rung, and a missing middle resolves downward rather than upward.
        let sparse = CatalogModel {
            efforts: &[Effort::Low, Effort::High, Effort::Max],
            ..*find("mistral/mistral-large-latest").unwrap()
        };
        assert_eq!(sparse.clamp_effort(Effort::Off), Effort::Low);
        assert_eq!(sparse.clamp_effort(Effort::Medium), Effort::Low);
        assert_eq!(sparse.clamp_effort(Effort::Max), Effort::Max);

        // Mistral tops out at high.
        let small = find("mistral/mistral-small-latest").unwrap();
        assert_eq!(small.clamp_effort(Effort::Max), Effort::High);

        // A full-ladder model passes everything through untouched.
        let opus = find("anthropic/claude-opus-5").unwrap();
        for e in FULL {
            assert_eq!(opus.clamp_effort(*e), *e);
        }
    }

    #[test]
    fn local_ram_requirements_match_the_fit_rule() {
        // min_ram_gb must actually admit the model under recommend()'s rule,
        // otherwise a model can be "recommended" at a tier it cannot load.
        for m in local_models() {
            let spec = m.local.unwrap();
            let budget = (spec.min_ram_gb as f64) * 1_000_000_000.0 * 0.6;
            assert!(
                (spec.size_bytes as f64) * 1.3 < budget,
                "{} claims {}GB but does not fit the 1.3x/60% rule",
                m.id,
                spec.min_ram_gb
            );
        }
    }

    /// Native web is a claim about the WIRE SHAPE this app speaks, not about
    /// the model's abilities. Setting it on a GPT or Mistral entry would build
    /// an Anthropic-only `tools` body for a vendor that 400s on it; setting it
    /// on a local entry would offer llama.cpp a tool no one serves. Same spirit
    /// as the Mistral effort-rung guard.
    #[test]
    fn only_anthropic_declares_native_web_fetch() {
        for m in CATALOG {
            assert_eq!(
                m.native_web_fetch,
                m.provider == ProviderId::Anthropic,
                "{} declares native_web_fetch={} but is a {:?} model",
                m.id,
                m.native_web_fetch,
                m.provider
            );
        }
        // And the capability must actually exist somewhere, or the whole native
        // tier is dead code that no test would notice.
        assert!(CATALOG.iter().any(|m| m.native_web_fetch));
    }

    /// The load-bearing half is the local one. `supports_vision: true` on a local
    /// entry would send images into `chat_template.rs`, which renders `content` as
    /// a plain string — the images would vanish with no error and the model would
    /// answer about an image it never received.
    #[test]
    fn no_local_model_claims_vision() {
        for m in CATALOG {
            if m.is_local() {
                assert!(
                    !m.supports_vision,
                    "{} claims vision, but the local engine has no mmproj path",
                    m.id
                );
            }
        }
    }

    /// Every Claude in the lineup reads images, and the panel's gating is designed
    /// around that being the reliable tier.
    #[test]
    fn every_anthropic_model_declares_vision() {
        for m in CATALOG
            .iter()
            .filter(|m| m.provider == ProviderId::Anthropic)
        {
            assert!(m.supports_vision, "{} should declare vision", m.id);
        }
    }

    /// Otherwise the whole attachment path is dead code no test would notice.
    #[test]
    fn some_model_declares_vision() {
        assert!(CATALOG.iter().any(|m| m.supports_vision));
    }

    #[test]
    fn default_model_exists_and_is_local() {
        let m = find(DEFAULT_MODEL_ID).expect("default model must be in the catalog");
        assert!(m.is_local());
    }

    #[test]
    fn legacy_local_ids_resolve() {
        assert_eq!(
            find_by_legacy_local_id("unsloth/Qwen3.5-9B-GGUF::Qwen3.5-9B-Q4_K_M.gguf")
                .map(|m| m.id),
            Some("local/qwen3.5-9b")
        );
        assert!(find_by_legacy_local_id("unsloth/Nope-GGUF::nope.gguf").is_none());
        assert!(find_by_legacy_local_id("not-a-legacy-id").is_none());
    }
}
