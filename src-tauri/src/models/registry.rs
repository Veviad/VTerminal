use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use super::hf::parse_quant;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocalModel {
    /// "unsloth/Qwen3.5-9B-GGUF::Qwen3.5-9B-Q4_K_M.gguf"
    pub id: String,
    pub repo_id: String,
    pub filename: String,
    pub path: String,
    pub size_bytes: u64,
    pub quant: String,
    pub downloaded_at: String,
}

// The list of offered models now lives in `models::catalog` — this module only
// tracks what has actually been downloaded to disk.

pub fn model_id(repo_id: &str, filename: &str) -> String {
    format!("{repo_id}::{filename}")
}

pub fn models_dir(app_data_dir: &Path, override_dir: Option<&str>) -> PathBuf {
    match override_dir.filter(|s| !s.trim().is_empty()) {
        Some(dir) => PathBuf::from(dir),
        None => app_data_dir.join("models"),
    }
}

pub fn repo_dir(models_dir: &Path, repo_id: &str) -> PathBuf {
    models_dir.join(repo_id.replace('/', "__"))
}

fn registry_path(models_dir: &Path) -> PathBuf {
    models_dir.join("registry.json")
}

pub fn load(models_dir: &Path) -> Vec<LocalModel> {
    let path = registry_path(models_dir);
    let Ok(data) = std::fs::read_to_string(&path) else {
        return Vec::new();
    };
    let mut models: Vec<LocalModel> = serde_json::from_str(&data).unwrap_or_default();
    // Drop entries whose files vanished (user deleted them outside the app).
    models.retain(|m| Path::new(&m.path).exists());
    models
}

/// Serializes every registry read-modify-write in this process — two downloads
/// completing at once must not clobber each other's entries.
static REGISTRY_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

pub fn save(models_dir: &Path, models: &[LocalModel]) -> Result<(), String> {
    std::fs::create_dir_all(models_dir).map_err(|e| format!("create models dir: {e}"))?;
    let json = serde_json::to_string_pretty(models).map_err(|e| e.to_string())?;
    // Temp-file + rename so a crash mid-write can't truncate the registry.
    let tmp = models_dir.join("registry.json.tmp");
    std::fs::write(&tmp, json).map_err(|e| format!("write registry: {e}"))?;
    std::fs::rename(&tmp, registry_path(models_dir)).map_err(|e| format!("commit registry: {e}"))
}

pub fn add(models_dir: &Path, model: LocalModel) -> Result<(), String> {
    let _guard = REGISTRY_LOCK.lock().map_err(|_| "registry lock poisoned")?;
    let mut models = load(models_dir);
    models.retain(|m| m.id != model.id);
    models.push(model);
    save(models_dir, &models)
}

pub fn remove(models_dir: &Path, id: &str) -> Result<Option<LocalModel>, String> {
    let _guard = REGISTRY_LOCK.lock().map_err(|_| "registry lock poisoned")?;
    let mut models = load(models_dir);
    let removed = models
        .iter()
        .position(|m| m.id == id)
        .map(|i| models.remove(i));
    save(models_dir, &models)?;
    Ok(removed)
}

pub fn make_local_model(repo_id: &str, filename: &str, path: &Path, size_bytes: u64) -> LocalModel {
    LocalModel {
        id: model_id(repo_id, filename),
        repo_id: repo_id.to_string(),
        filename: filename.to_string(),
        path: path.to_string_lossy().into_owned(),
        size_bytes,
        quant: parse_quant(filename).unwrap_or_else(|| "unknown".to_string()),
        downloaded_at: chrono::Utc::now().to_rfc3339(),
    }
}

/// Whether a model of this size can realistically run in `total_ram_bytes`.
///
/// Weights * 1.3 (KV cache + runtime overhead) must stay under 60% of unified
/// memory, and the model's own declared RAM floor must be met. The catalog's
/// `min_ram_gb` values are cross-checked against this rule by a unit test.
pub fn fits_in_ram(size_bytes: u64, min_ram_gb: u64, total_ram_bytes: u64) -> bool {
    let ram_gb = total_ram_bytes / 1_000_000_000;
    let budget = (total_ram_bytes as f64) * 0.6;
    ram_gb >= min_ram_gb && (size_bytes as f64) * 1.3 < budget
}

/// The same budget, for a chat model and a vision sidecar resident TOGETHER.
///
/// `vision_bytes` must be weights **plus** the mmproj projector: the projector is a
/// separate allocation and is not covered by the 1.3x on weights. Budgeting only
/// the weights under-counts by up to 900MB, which is the whole margin on a 16GB
/// machine.
///
/// No individual floor here — `fits_in_ram` has already applied each model's own
/// `min_ram_gb`; this is purely the question of whether both fit at once.
///
/// Keeping `1.3` on the SUM is deliberately conservative: it budgets a KV cache for
/// each model, whereas the shared `InferenceGate` means only one can be generating.
/// One number that can be cross-checked by a test beats a second term needing
/// `n_ctx`, which is user-settable via `max_context_tokens`.
pub fn pair_fits_in_ram(chat_bytes: u64, vision_bytes: u64, total_ram_bytes: u64) -> bool {
    let budget = (total_ram_bytes as f64) * 0.6;
    ((chat_bytes + vision_bytes) as f64) * 1.3 < budget
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ram_fit_respects_both_the_floor_and_the_budget() {
        // Qwen3.5 9B (5.68GB, 16GB floor) on the 32GB M1 Pro baseline.
        assert!(fits_in_ram(5_680_522_464, 16, 32 * 1_000_000_000));
        // Same model on an 8GB Mac: the declared floor rules it out.
        assert!(!fits_in_ram(5_680_522_464, 16, 8 * 1_000_000_000));
        // Qwen3.6 27B (16.8GB) does not fit 32GB even though 32 >= its floor
        // would suggest otherwise — the 1.3x/60% budget is the binding limit.
        assert!(!fits_in_ram(16_817_244_384, 48, 32 * 1_000_000_000));
        assert!(fits_in_ram(16_817_244_384, 48, 64 * 1_000_000_000));
    }

    /// Which chat+sidecar combinations actually fit, written down as assertions
    /// rather than left to be rediscovered.
    ///
    /// GiB, not GB: `sysinfo::total_memory` reports bytes, and a "16GB" Mac is
    /// 17,179,869,184 of them. The test above uses round `1_000_000_000` because
    /// there its margins are wide; here they are not — 9B + PaddleOCR passes on
    /// 16GiB with 0.56GB to spare and would FAIL against 16e9.
    #[test]
    fn pair_fit_says_which_combinations_are_possible() {
        const GIB: u64 = 1024 * 1024 * 1024;
        // Catalog sizes.
        let chat_9b = 5_680_522_464u64;
        let chat_27b = 16_817_244_384u64;
        let paddleocr = 935_769_056 + 881_770_560u64; // 1.82GB pair
        let qwen_vl_4b = 2_497_282_336 + 836_180_640u64; // 3.33GB pair
        let qwen_vl_8b = 5_027_785_568 + 1_159_030_336u64; // 6.19GB pair

        // 16GiB is the TIGHT configuration, not 32: exactly one combination fits,
        // so the UI must name the pair rather than just say "too big".
        assert!(
            pair_fits_in_ram(chat_9b, paddleocr, 16 * GIB),
            "9B + PaddleOCR on 16GiB"
        );
        assert!(
            !pair_fits_in_ram(chat_9b, qwen_vl_4b, 16 * GIB),
            "9B + Qwen3-VL 4B must NOT fit 16GiB"
        );

        // 32GiB takes everything the single-model rule already allows.
        assert!(pair_fits_in_ram(chat_9b, qwen_vl_8b, 32 * GIB));

        // Passes with only ~1.0GB of slack — the one combination worth MEASURING
        // against real RSS before trusting it.
        assert!(pair_fits_in_ram(chat_27b, qwen_vl_8b, 48 * GIB));

        // And the pair rule never has to reject 27B on 32GiB, because the
        // single-model rule already did — see
        // `ram_fit_respects_both_the_floor_and_the_budget`.
        assert!(!fits_in_ram(chat_27b, 48, 32 * GIB));
    }

    /// Why `vision_bytes` must be weights PLUS projector.
    ///
    /// Deliberately synthetic and sitting on the boundary: the point is that the
    /// projector is part of the sum, and picking a real pair would tie the test to
    /// which models happen to be offered — a catalog edit could make it pass for
    /// the wrong reason. An mmproj is 0.8–1.2GB, so this is the real magnitude.
    #[test]
    fn the_projector_counts_toward_the_budget() {
        const TOTAL: u64 = 16 * 1024 * 1024 * 1024; // budget = 10.31GB
        let chat = 5_000_000_000u64;
        let weights = 2_000_000_000u64;
        let projector = 1_000_000_000u64;

        assert!(pair_fits_in_ram(chat, weights, TOTAL), "7GB pair fits");
        assert!(
            !pair_fits_in_ram(chat, weights + projector, TOTAL),
            "the same pair must NOT fit once the projector is counted"
        );
    }

    #[test]
    fn registry_roundtrip() {
        let dir = std::env::temp_dir().join(format!("veviad-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        // File must exist for load() retention
        let file = dir.join("m.gguf");
        std::fs::write(&file, b"x").unwrap();
        let model = make_local_model("org/repo", "m.gguf", &file, 1);
        add(&dir, model.clone()).unwrap();
        let loaded = load(&dir);
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].id, "org/repo::m.gguf");
        remove(&dir, &model.id).unwrap();
        assert!(load(&dir).is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }
}
