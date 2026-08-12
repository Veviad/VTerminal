// Hugging Face Hub filename helpers.
//
// Open-ended repo search and file listing used to live here. They are gone on
// purpose: the app now offers a strict allowlist (`models::catalog`), so the
// only files it ever fetches are ones it already knows the name and size of.

pub fn parse_quant(filename: &str) -> Option<String> {
    let stem = filename.trim_end_matches(".gguf").trim_end_matches(".GGUF");
    // Match trailing quant tokens like Q4_K_M, UD-Q4_K_XL, IQ4_XS, Q8_0, BF16, F16
    let upper = stem.to_uppercase();
    for part in upper.rsplit(['-', '.']) {
        let second_is_digit = part.chars().nth(1).is_some_and(|c| c.is_ascii_digit());
        if (part.starts_with('Q') && second_is_digit)
            || part.starts_with("IQ")
            || part == "BF16"
            || part == "F16"
            || part == "F32"
        {
            return Some(part.to_string());
        }
        // "UD-Q4_K_XL" style: rsplit on '-' already separates UD from Q4_K_XL
    }
    None
}

pub fn is_multipart(filename: &str) -> bool {
    // e.g. model-00001-of-00004.gguf
    let lower = filename.to_lowercase();
    lower.contains("-of-") && lower.ends_with(".gguf")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_common_quants() {
        assert_eq!(parse_quant("Qwen3.5-9B-Q4_K_M.gguf").as_deref(), Some("Q4_K_M"));
        assert_eq!(
            parse_quant("Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf").as_deref(),
            Some("Q4_K_XL")
        );
        assert_eq!(parse_quant("model-IQ4_XS.gguf").as_deref(), Some("IQ4_XS"));
        assert_eq!(parse_quant("model-Q8_0.gguf").as_deref(), Some("Q8_0"));
        assert_eq!(parse_quant("model-BF16.gguf").as_deref(), Some("BF16"));
        assert_eq!(parse_quant("no-quant-here.gguf"), None);
    }

    #[test]
    fn detects_multipart() {
        assert!(is_multipart("big-00001-of-00004.gguf"));
        assert!(!is_multipart("single.gguf"));
    }
}
