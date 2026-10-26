//! Decode only the user-facing summary of a finish call while it is generated.
//! Complete calls still travel separately and remain the authority for dispatch.

use super::ProviderEvent;

#[derive(Default)]
pub(crate) struct ToolSummaryStream {
    decoder: Option<JsonStringPrefix>,
    #[cfg(any(feature = "local-llm", test))]
    envelope_decoder: Option<JsonStringPrefix>,
    emitted: usize,
}

impl ToolSummaryStream {
    /// `arguments` is the accumulated JSON argument prefix for ONE tool call.
    pub(crate) fn push_json(
        &mut self,
        call_id: &str,
        name: &str,
        arguments: &str,
    ) -> Option<ProviderEvent> {
        if name != "finish" {
            return None;
        }
        if self.decoder.is_none() {
            let start = json_field_start(arguments, "summary")?;
            if arguments.as_bytes().get(start) != Some(&b'"') {
                return None;
            }
            self.decoder = Some(JsonStringPrefix::new(start + 1));
        }
        let decoder = self.decoder.as_mut()?;
        decoder.push(arguments);
        let content = decoder.text.get(self.emitted..)?;
        if content.is_empty() {
            return None;
        }
        let content = content.to_string();
        self.emitted = decoder.text.len();
        Some(ProviderEvent::ToolSummaryDelta {
            call_id: call_id.into(),
            content,
        })
    }

    /// Local XML/DSL envelopes already carry literal, decoded string prefixes.
    #[cfg(any(feature = "local-llm", test))]
    pub(crate) fn push_text(&mut self, call_id: &str, text: &str) -> Option<ProviderEvent> {
        let content = text.get(self.emitted..)?;
        if content.is_empty() {
            return None;
        }
        let content = content.to_string();
        self.emitted = text.len();
        Some(ProviderEvent::ToolSummaryDelta {
            call_id: call_id.into(),
            content,
        })
    }

    #[cfg(any(feature = "local-llm", test))]
    pub(crate) fn push_qwen(&mut self, call_id: &str, payload: &str) -> Option<ProviderEvent> {
        let payload = payload.trim_start();
        if payload.starts_with('{') {
            let start = json_field_start(payload, "name")?;
            let name = serde_json::Deserializer::from_str(&payload[start..])
                .into_iter::<String>()
                .next()?
                .ok()?;
            if name != "finish" {
                return None;
            }
            let arguments = json_field_start(payload, "arguments")?;
            match payload.as_bytes().get(arguments) {
                Some(b'{') => self.push_json(call_id, &name, &payload[arguments..]),
                Some(b'"') => {
                    let decoder = self
                        .envelope_decoder
                        .get_or_insert_with(|| JsonStringPrefix::new(arguments + 1));
                    decoder.push(payload);
                    let arguments = decoder.text.clone();
                    self.push_json(call_id, &name, &arguments)
                }
                _ => None,
            }
        } else {
            let rest = payload.strip_prefix("<function=")?;
            let header = rest.find('>')?;
            if rest[..header].trim() != "finish" {
                return None;
            }
            let mut rest = &rest[header + 1..];
            loop {
                let parameter = rest.find("<parameter=")?;
                rest = &rest[parameter + "<parameter=".len()..];
                let header = rest.find('>')?;
                let name = rest[..header].trim();
                let body = &rest[header + 1..];
                if name == "summary" {
                    let preview = literal_prefix(body, "</parameter>", true);
                    return self.push_text(call_id, preview);
                }
                let close = body.find("</parameter>")?;
                rest = &body[close + "</parameter>".len()..];
            }
        }
    }

    #[cfg(any(feature = "local-llm", test))]
    pub(crate) fn push_gemma(&mut self, call_id: &str, payload: &str) -> Option<ProviderEvent> {
        const QUOTE: &str = "<|\"|>";
        let rest = payload.trim_start().strip_prefix("call:")?;
        let brace = rest.find('{')?;
        if rest[..brace].trim() != "finish" {
            return None;
        }
        let mut rest = &rest[brace + 1..];
        loop {
            rest = rest
                .trim_start()
                .strip_prefix(',')
                .unwrap_or(rest)
                .trim_start();
            let colon = rest.find(':')?;
            let name = rest[..colon].trim();
            let value = rest[colon + 1..].trim_start();
            if name == "summary" {
                let body = value.strip_prefix(QUOTE)?;
                return self.push_text(call_id, literal_prefix(body, QUOTE, false));
            }
            // Skip a preceding value without observing keys nested inside it.
            let mut offset = 0;
            let mut depth = 0usize;
            loop {
                let tail = &value[offset..];
                if let Some(body) = tail.strip_prefix(QUOTE) {
                    offset += QUOTE.len() + body.find(QUOTE)? + QUOTE.len();
                    continue;
                }
                let ch = tail.chars().next()?;
                match ch {
                    ',' if depth == 0 => {
                        rest = tail;
                        break;
                    }
                    '{' | '[' => depth += 1,
                    '}' | ']' if depth > 0 => depth -= 1,
                    '}' | ']' => return None,
                    _ => {}
                }
                offset += ch.len_utf8();
            }
        }
    }
}

/// Hold only a possible closing marker and the XML envelope's final newline.
/// A partial marker must never appear as user-facing text.
#[cfg(any(feature = "local-llm", test))]
fn literal_prefix<'a>(body: &'a str, marker: &str, trim_newline: bool) -> &'a str {
    let mut body = body;
    if trim_newline {
        body = body
            .strip_prefix("\r\n")
            .or_else(|| body.strip_prefix('\n'))
            .unwrap_or(body);
        if body == "\r" {
            return "";
        }
    }
    let (end, closed) = match body.find(marker) {
        Some(end) => (end, true),
        None => {
            let held = (1..marker.len())
                .rev()
                .find(|&length| body.ends_with(&marker[..length]))
                .unwrap_or(0);
            (body.len() - held, false)
        }
    };
    let text = &body[..end];
    if trim_newline {
        let text = text
            .strip_suffix("\r\n")
            .or_else(|| text.strip_suffix('\n'))
            .unwrap_or(text);
        if !closed {
            return text.strip_suffix('\r').unwrap_or(text);
        }
        return text;
    }
    text
}

/// Locate a top-level object's field without mistaking a nested key or a quoted
/// fragment for it. Incomplete preceding values simply wait for the next piece.
pub(crate) fn json_field_start(input: &str, field: &str) -> Option<usize> {
    let mut cursor = input.len() - input.trim_start().len();
    if input.as_bytes().get(cursor) != Some(&b'{') {
        return None;
    }
    cursor += 1;
    loop {
        cursor += input[cursor..].len() - input[cursor..].trim_start().len();
        let mut key = serde_json::Deserializer::from_str(&input[cursor..]).into_iter::<String>();
        let name = key.next()?.ok()?;
        cursor += key.byte_offset();
        cursor += input[cursor..].len() - input[cursor..].trim_start().len();
        if input.as_bytes().get(cursor) != Some(&b':') {
            return None;
        }
        cursor += 1;
        cursor += input[cursor..].len() - input[cursor..].trim_start().len();
        if name == field {
            return Some(cursor);
        }
        let mut value = serde_json::Deserializer::from_str(&input[cursor..])
            .into_iter::<serde::de::IgnoredAny>();
        value.next()?.ok()?;
        cursor += value.byte_offset();
        cursor += input[cursor..].len() - input[cursor..].trim_start().len();
        if input.as_bytes().get(cursor) != Some(&b',') {
            return None;
        }
        cursor += 1;
    }
}

/// Retains a byte cursor so long summaries do not re-decode their whole prefix
/// for each token. An unfinished escape (including a surrogate pair) is held.
pub(crate) struct JsonStringPrefix {
    cursor: usize,
    pub(crate) text: String,
    closed: bool,
}

impl JsonStringPrefix {
    pub(crate) fn new(cursor: usize) -> Self {
        Self {
            cursor,
            text: String::new(),
            closed: false,
        }
    }

    pub(crate) fn push(&mut self, input: &str) {
        while !self.closed && self.cursor < input.len() {
            let Some(rest) = input.get(self.cursor..) else {
                break;
            };
            let ch = rest.chars().next().unwrap();
            if ch == '"' {
                self.closed = true;
                break;
            }
            if ch != '\\' {
                if ch.is_control() {
                    break;
                }
                self.text.push(ch);
                self.cursor += ch.len_utf8();
                continue;
            }
            let Some(escape) = rest.as_bytes().get(1).copied() else {
                break;
            };
            let (decoded, consumed) = match escape {
                b'"' => ('"', 2),
                b'\\' => ('\\', 2),
                b'/' => ('/', 2),
                b'b' => ('\u{0008}', 2),
                b'f' => ('\u{000c}', 2),
                b'n' => ('\n', 2),
                b'r' => ('\r', 2),
                b't' => ('\t', 2),
                b'u' => {
                    let Some(unit) = rest.get(2..6).and_then(|s| u16::from_str_radix(s, 16).ok())
                    else {
                        break;
                    };
                    if (0xd800..=0xdbff).contains(&unit) {
                        if rest.get(6..8) != Some("\\u") {
                            break;
                        }
                        let Some(low) = rest
                            .get(8..12)
                            .and_then(|s| u16::from_str_radix(s, 16).ok())
                        else {
                            break;
                        };
                        if !(0xdc00..=0xdfff).contains(&low) {
                            break;
                        }
                        let code = 0x10000 + ((unit as u32 - 0xd800) << 10) + (low as u32 - 0xdc00);
                        (char::from_u32(code).unwrap(), 12)
                    } else {
                        let Some(ch) = char::from_u32(unit as u32) else {
                            break;
                        };
                        (ch, 6)
                    }
                }
                _ => break,
            };
            self.text.push(decoded);
            self.cursor += consumed;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn streams_before_json_completes_and_decodes_split_escapes() {
        let input = r#"{"summary":"Fertig: \"Grüße\"\n\uD83D\uDE80"}"#;
        let mut preview = ToolSummaryStream::default();
        let mut text = String::new();
        let mut before_end = false;
        for end in input.char_indices().map(|(at, ch)| at + ch.len_utf8()) {
            if let Some(ProviderEvent::ToolSummaryDelta { call_id, content }) =
                preview.push_json("finish-1", "finish", &input[..end])
            {
                assert_eq!(call_id, "finish-1");
                text.push_str(&content);
                before_end |= end < input.len() - 2;
            }
        }
        assert!(before_end);
        assert_eq!(text, "Fertig: \"Grüße\"\n🚀");
        assert!(preview.push_json("finish-1", "finish", input).is_none());
    }

    #[test]
    fn only_exposes_top_level_finish_summary() {
        let input = r#"{"other":{"summary":"hidden"},"summary":"visible"}"#;
        assert!(ToolSummaryStream::default()
            .push_json("run", "run_command", input)
            .is_none());
        let event = ToolSummaryStream::default()
            .push_json("finish", "finish", input)
            .unwrap();
        assert!(
            matches!(event, ProviderEvent::ToolSummaryDelta { content, .. } if content == "visible")
        );
        assert!(ToolSummaryStream::default()
            .push_json("finish", "finish", r#"{"nested":{"summary":"hidden"}}"#)
            .is_none());
    }

    #[test]
    fn interrupted_unicode_never_emits_replacement_characters() {
        let mut preview = ToolSummaryStream::default();
        let event = preview
            .push_json("finish", "finish", r#"{"summary":"partial\uD83D\uDE"#)
            .unwrap();
        assert!(
            matches!(event, ProviderEvent::ToolSummaryDelta { content, .. } if content == "partial")
        );
    }

    #[test]
    fn all_local_envelopes_stream_before_the_call_is_complete() {
        for (gemma, payload, expected) in [
            (
                false,
                r#"{"name":"finish","arguments":{"summary":"Grüße\n🚀"}}"#,
                "Grüße\n🚀",
            ),
            (
                false,
                r#"{"arguments":{"summary":"first"},"name":"finish"}"#,
                "first",
            ),
            (
                false,
                r#"{"name":"finish","arguments":"{\"summary\":\"escaped\\ntext\"}"}"#,
                "escaped\ntext",
            ),
            (
                false,
                "<function=finish>\n<parameter=summary>\nGrüße\n🚀\n</parameter>\n</function>",
                "Grüße\n🚀",
            ),
            (
                false,
                "<function=finish><parameter=summary>\r\n\r\nGrüße\r\n\r\n</parameter></function>",
                "\r\nGrüße\r\n",
            ),
            (
                true,
                "call:finish{summary:<|\"|>Grüße\n🚀<|\"|>}",
                "Grüße\n🚀",
            ),
            (
                true,
                "call:finish{other:{summary:<|\"|>hidden<|\"|>},summary:<|\"|>visible<|\"|>}",
                "visible",
            ),
        ] {
            let mut preview = ToolSummaryStream::default();
            let mut text = String::new();
            for end in payload.char_indices().map(|(at, ch)| at + ch.len_utf8()) {
                let event = if gemma {
                    preview.push_gemma("call", &payload[..end])
                } else {
                    preview.push_qwen("call", &payload[..end])
                };
                if let Some(ProviderEvent::ToolSummaryDelta { content, .. }) = event {
                    text.push_str(&content);
                }
            }
            assert_eq!(text, expected, "{payload}");
        }
    }

    #[test]
    fn local_command_arguments_and_nested_summaries_stay_hidden() {
        for payload in [
            r#"{"name":"run_command","arguments":{"summary":"hidden"}}"#,
            "<function=run_command><parameter=summary>hidden</parameter></function>",
        ] {
            assert!(ToolSummaryStream::default()
                .push_qwen("call", payload)
                .is_none());
        }
        assert!(ToolSummaryStream::default()
            .push_gemma("call", "call:run_command{summary:<|\"|>hidden<|\"|>}")
            .is_none());
    }
}
