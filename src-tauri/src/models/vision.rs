//! The on-device vision/OCR sidecar allowlist.
//!
//! **Deliberately a separate table from `CATALOG`.** That one is definitionally
//! "models that can be `active_model_id`" — it feeds `models::find_model`, which
//! feeds `settings::active_model_id`, `resolve_provider`, the header menu and
//! `set_model_effort`. A transcriber in that table becomes selectable as the model
//! that *answers*, which it must never be. The id namespaces are kept disjoint and
//! a test asserts it.
//!
//! What an entry is NOT: no `tier`, no `efforts`, no `default_effort`, no
//! `supports_temperature`, no `native_web_fetch`. A transcriber does not
//! deliberate, so there is no effort ladder and no picker for it.
//!
//! Each entry names TWO files — the weights and an `mmproj` projector. llama.cpp's
//! `mtmd` layer loads the projector against an already-loaded `LlamaModel`, so a
//! vision sidecar is a second full model plus its projector, not an add-on to the
//! chat model.

use serde::Serialize;

/// Which family's preprocessing and markers `mtmd` will apply.
///
/// Recorded rather than inferred because it decides two things we have to get
/// right ourselves: the default prompt's phrasing, and — via `mtmd`'s own
/// `img_beg`/`img_end` injection — that the rendered prompt must carry ONLY the
/// media marker. See `provider::vision`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum VisionArch {
    /// `LLM_ARCH_QWEN3VL` + `PROJECTOR_TYPE_QWEN3VL` ("qwen3vl_merger").
    /// mtmd wraps the embeddings in `<|vision_start|>`/`<|vision_end|>`.
    Qwen3Vl,
    /// `LLM_ARCH_PADDLEOCR` + `PROJECTOR_TYPE_PADDLEOCR`.
    /// mtmd wraps the embeddings in `<|IMAGE_START|>`/`<|IMAGE_END|>`.
    PaddleOcr,
}

#[derive(Debug, Clone, Copy, Serialize)]
pub struct VisionModel {
    /// Always `vision/…`, and never a value `catalog::find` resolves.
    pub id: &'static str,
    pub label: &'static str,
    pub description: &'static str,
    pub repo_id: &'static str,
    pub filename: &'static str,
    pub size_bytes: u64,
    /// The projector. Same repo, so the download path needs no new URL shape.
    pub mmproj_filename: &'static str,
    pub mmproj_size_bytes: u64,
    /// Floor for this sidecar ALONE, on the same rule as `LocalSpec` and
    /// cross-checked by a unit test. Whether it fits *alongside* the chat model is
    /// a separate question — `registry::pair_fits_in_ram`.
    pub min_ram_gb: u64,
    /// Ceiling from the GGUF. The sidecar clamps well below this: an image costs
    /// one KV cell per token and a retina screenshot is ~1300 of them.
    pub context_tokens: u32,
    pub arch: VisionArch,
    /// What to ask when the user has not set `vision_prompt`. "Transcribe this"
    /// and "describe this" are genuinely different jobs, and the right default
    /// depends on whether the model is an OCR specialist.
    pub default_prompt: &'static str,
}

impl VisionModel {
    /// Weights + projector. The projector is a separate allocation, so every
    /// memory question has to use this, never `size_bytes`.
    pub fn total_bytes(&self) -> u64 {
        self.size_bytes + self.mmproj_size_bytes
    }
}

const OCR_PROMPT: &str =
    "Transcribe every piece of text visible in this image, exactly as written. \
     Preserve line breaks and reading order. Do not summarize, explain, or add commentary.";

const DESCRIBE_PROMPT: &str =
    "Describe this image in enough detail that someone who cannot see it could act on it. \
     Transcribe any text, code, or error messages exactly as written.";

/// Sizes and filenames were read from the Hugging Face tree API and re-verified
/// immediately before shipping. A wrong `size_bytes` is not cosmetic: `finalize`
/// in `download.rs` compares against it and rejects the completed file.
///
/// Both projector types were confirmed present in the PINNED llama.cpp
/// (`PROJECTOR_TYPE_NAMES` in `tools/mtmd/clip-impl.h`) — a projector this build
/// does not know surfaces only as a null context, with no diagnosis.
pub const VISION_CATALOG: &[VisionModel] = &[
    // The OCR answer, and the default: a first-party PaddlePaddle GGUF release
    // purpose-built for document and screenshot text, at 1.82GB for the pair. Small
    // enough that "does it fit next to the chat model" almost never bites — which
    // matters most on a 16GB machine, where the default 9B chat model plus this is
    // the only combination that fits at all.
    VisionModel {
        id: "vision/paddleocr-vl-1.6",
        label: "PaddleOCR-VL 1.6",
        description:
            "Reads text out of screenshots and documents. Smallest, and the best at dense text.",
        repo_id: "PaddlePaddle/PaddleOCR-VL-1.6-GGUF",
        filename: "PaddleOCR-VL-1.6-GGUF.gguf",
        size_bytes: 935_769_056,
        mmproj_filename: "PaddleOCR-VL-1.6-GGUF-mmproj.gguf",
        mmproj_size_bytes: 881_770_560,
        min_ram_gb: 8,
        context_tokens: 131_072,
        arch: VisionArch::PaddleOcr,
        default_prompt: OCR_PROMPT,
    },
    // General vision: "what is this UI doing", "read this chart". Same publisher
    // and Q4_K_M naming as the seven existing local chat entries, so the download
    // path needs nothing new.
    VisionModel {
        id: "vision/qwen3-vl-4b",
        label: "Qwen3-VL 4B",
        description: "Describes images as well as reading them. Good balance of size and ability.",
        repo_id: "unsloth/Qwen3-VL-4B-Instruct-GGUF",
        filename: "Qwen3-VL-4B-Instruct-Q4_K_M.gguf",
        size_bytes: 2_497_282_336,
        // F16 rather than BF16 or F32: same accuracy in practice at half of F32,
        // and BF16 is 3MB larger for no measured benefit in supported backends.
        mmproj_filename: "mmproj-F16.gguf",
        mmproj_size_bytes: 836_180_640,
        min_ram_gb: 8,
        context_tokens: 262_144,
        arch: VisionArch::Qwen3Vl,
        default_prompt: DESCRIBE_PROMPT,
    },
    // The honest ceiling: deliberately the same size class as the DEFAULT chat
    // model, so "both loaded" is a real 32GB configuration and an impossible 16GB
    // one.
    VisionModel {
        id: "vision/qwen3-vl-8b",
        label: "Qwen3-VL 8B",
        description: "Most capable at reasoning about what an image shows. Needs 16GB or more.",
        repo_id: "unsloth/Qwen3-VL-8B-Instruct-GGUF",
        filename: "Qwen3-VL-8B-Instruct-Q4_K_M.gguf",
        size_bytes: 5_027_785_568,
        mmproj_filename: "mmproj-F16.gguf",
        mmproj_size_bytes: 1_159_030_336,
        min_ram_gb: 16,
        context_tokens: 262_144,
        arch: VisionArch::Qwen3Vl,
        default_prompt: DESCRIBE_PROMPT,
    },
];

pub const DEFAULT_VISION_MODEL_ID: &str = "vision/paddleocr-vl-1.6";

pub fn find(id: &str) -> Option<&'static VisionModel> {
    VISION_CATALOG.iter().find(|m| m.id == id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{catalog, hf, registry};

    #[test]
    fn ids_are_unique_and_namespaced() {
        let mut seen = Vec::new();
        for m in VISION_CATALOG {
            assert!(
                m.id.starts_with("vision/"),
                "{} must be namespaced so it can never be mistaken for a chat model",
                m.id
            );
            assert!(!seen.contains(&m.id), "duplicate vision id {}", m.id);
            seen.push(m.id);
        }
    }

    /// The load-bearing invariant. `CATALOG` is what `active_model_id` is validated
    /// against, so an id resolvable by BOTH tables could be selected as the model
    /// that answers — and a transcriber has no effort ladder, no tools, and no
    /// business holding a conversation.
    #[test]
    fn vision_ids_are_not_in_the_chat_catalog() {
        for m in VISION_CATALOG {
            assert!(
                catalog::find(m.id).is_none(),
                "{} resolves in CATALOG too — it would become selectable as the chat model",
                m.id
            );
        }
        // And the reverse, so a future chat entry cannot claim a vision id.
        for m in catalog::CATALOG {
            assert!(
                find(m.id).is_none(),
                "{} resolves in VISION_CATALOG too",
                m.id
            );
        }
    }

    /// Two distinct single-file GGUFs. A multipart name would fail at runtime with
    /// download.rs's "pick a single-file quant" error, which is baffling for an
    /// entry the app itself curated.
    #[test]
    fn every_entry_declares_two_distinct_single_file_ggufs() {
        for m in VISION_CATALOG {
            assert_ne!(
                m.filename, m.mmproj_filename,
                "{}: weights == projector",
                m.id
            );
            for f in [m.filename, m.mmproj_filename] {
                assert!(f.ends_with(".gguf"), "{}: {f} is not a .gguf", m.id);
                assert!(!hf::is_multipart(f), "{}: {f} is multipart", m.id);
            }
            assert!(
                m.size_bytes > 0 && m.mmproj_size_bytes > 0,
                "{}: zero size",
                m.id
            );
            assert_eq!(m.total_bytes(), m.size_bytes + m.mmproj_size_bytes);
        }
    }

    /// Same cross-check the chat catalog gets, against `total_bytes()` — the
    /// projector is a separate allocation and budgeting only the weights would
    /// under-count by up to 900MB.
    #[test]
    fn min_ram_requirements_match_the_fit_rule() {
        for m in VISION_CATALOG {
            let floor = m.min_ram_gb * 1_000_000_000;
            assert!(
                registry::fits_in_ram(m.total_bytes(), m.min_ram_gb, floor),
                "{} claims {}GB but does not fit its own floor",
                m.id,
                m.min_ram_gb
            );
        }
    }

    /// A sidecar with no prompt asks the model nothing at all.
    #[test]
    fn default_prompts_are_present_and_specific() {
        for m in VISION_CATALOG {
            assert!(m.default_prompt.len() > 40, "{}: prompt is too vague", m.id);
            assert!(
                !m.label.is_empty() && !m.description.is_empty(),
                "{}: no label",
                m.id
            );
        }
    }

    #[test]
    fn the_default_model_exists_and_is_the_smallest() {
        let default = find(DEFAULT_VISION_MODEL_ID).expect("default must be in the catalog");
        // The default has to be the one most likely to fit alongside a chat model;
        // if a smaller entry is ever added, this is the decision to revisit.
        let smallest = VISION_CATALOG
            .iter()
            .min_by_key(|m| m.total_bytes())
            .expect("catalog is not empty");
        assert_eq!(default.id, smallest.id);
    }
}
