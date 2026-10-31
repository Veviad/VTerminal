//! Plain-text capture for piped commands, not the live xterm byte stream.
//! Keep one decoder per pipe: UTF-8 and escape sequences can span reads, and
//! stderr must never complete a control sequence or character from stdout.

const MAX_LINE: usize = 8_192;
const MAX_CSI: usize = 64;
const UI_CAP: usize = 65_536;
const MODEL_CAP: usize = 8_192;
const TRUNCATED: &str = "\n[output truncated in view — full tail goes to the model]\n";

#[derive(Default)]
enum State {
    #[default]
    Text,
    Escape,
    EscapeIntermediate,
    Csi(String),
    ControlString {
        osc: bool,
        escaped: bool,
    },
}

#[derive(Default)]
pub(super) struct CapturedText {
    utf8: Vec<u8>,
    state: State,
}

/// Both pipes feed the same text surface in read order, like a terminal.
/// Only the parsers are separate, so a split stdout control/UTF-8 sequence
/// cannot consume stderr. Snapshots keep unfinished progress visible without
/// committing a line that a later CR/backspace may still overwrite.
#[derive(Default)]
pub(super) struct CapturedOutput {
    line: Vec<char>,
    cursor: usize,
    view: String,
    tail: String,
    view_truncated: bool,
}

impl CapturedText {
    pub(super) fn push(&mut self, bytes: &[u8], output: &mut CapturedOutput) {
        let mut bytes_to_decode = std::mem::take(&mut self.utf8);
        bytes_to_decode.extend_from_slice(bytes);
        let mut remaining = bytes_to_decode.as_slice();
        while !remaining.is_empty() {
            match std::str::from_utf8(remaining) {
                Ok(text) => {
                    for ch in text.chars() {
                        self.character(ch, output);
                    }
                    break;
                }
                Err(error) => {
                    // The prefix was validated by from_utf8; decode it before
                    // replacing an invalid sequence or retaining a split one.
                    let valid = error.valid_up_to();
                    for ch in std::str::from_utf8(&remaining[..valid]).unwrap().chars() {
                        self.character(ch, output);
                    }
                    remaining = &remaining[valid..];
                    if let Some(invalid) = error.error_len() {
                        self.character('\u{fffd}', output);
                        remaining = &remaining[invalid..];
                    } else {
                        self.utf8.extend_from_slice(remaining);
                        break;
                    }
                }
            }
        }
    }

    pub(super) fn finish(&mut self, output: &mut CapturedOutput) {
        if !self.utf8.is_empty() {
            self.utf8.clear();
            self.character('\u{fffd}', output);
        }
        self.state = State::Text;
    }

    fn character(&mut self, ch: char, output: &mut CapturedOutput) {
        match &mut self.state {
            State::ControlString { osc, escaped } => {
                if (*osc && ch == '\x07')
                    || (*escaped && ch == '\\')
                    || matches!(ch, '\u{009c}' | '\x18' | '\x1a')
                {
                    self.state = State::Text;
                } else {
                    *escaped = ch == '\x1b';
                }
                return;
            }
            _ if matches!(ch, '\x18' | '\x1a') => {
                // CAN/SUB abort an unfinished sequence. Keeping them as CSI
                // parameters would consume the next printed letter as its
                // final byte, corrupting both the command card and model tail.
                self.state = State::Text;
                return;
            }
            _ if (ch < '\x20' && ch != '\x1b') || ch == '\x7f' => {
                // C0 controls execute without changing an escape/CSI parser's
                // state; DEL is ignored. Control-string payloads stay hidden
                // in the earlier arm rather than leaking into captured text.
                output.character(ch);
                return;
            }
            _ if ch == '\x1b' => {
                self.state = State::Escape;
                return;
            }
            State::Escape => {
                self.state = match ch {
                    '[' => State::Csi(String::new()),
                    ']' => State::ControlString {
                        osc: true,
                        escaped: false,
                    },
                    'P' | '^' | '_' => State::ControlString {
                        osc: false,
                        escaped: false,
                    },
                    '\u{0020}'..='\u{002f}' => State::EscapeIntermediate,
                    _ => State::Text,
                };
                return;
            }
            State::EscapeIntermediate => {
                if !('\u{0020}'..='\u{002f}').contains(&ch) {
                    self.state = State::Text;
                }
                return;
            }
            State::Csi(parameters) => {
                if ('@'..='~').contains(&ch) {
                    let parameters = std::mem::take(parameters);
                    self.state = State::Text;
                    output.csi(ch, &parameters);
                } else if parameters.len() < MAX_CSI {
                    parameters.push(ch);
                }
                return;
            }
            State::Text => {}
        }

        match ch {
            '\u{009b}' => self.state = State::Csi(String::new()),
            '\u{009d}' => {
                self.state = State::ControlString {
                    osc: true,
                    escaped: false,
                }
            }
            '\u{0090}' | '\u{009e}' | '\u{009f}' => {
                self.state = State::ControlString {
                    osc: false,
                    escaped: false,
                }
            }
            ch => output.character(ch),
        }
    }
}

impl CapturedOutput {
    pub(super) fn snapshot(&self) -> String {
        let mut text = self.view.clone();
        if self.view_truncated {
            text.push_str(TRUNCATED);
            return text;
        }
        let line: String = self.line.iter().collect();
        let available = UI_CAP.saturating_sub(text.len());
        let mut end = available.min(line.len());
        while !line.is_char_boundary(end) {
            end -= 1;
        }
        text.push_str(&line[..end]);
        if end < line.len() {
            text.push_str(TRUNCATED);
        }
        text
    }

    pub(super) fn tail(&self) -> String {
        let mut text = self.tail.clone();
        text.extend(self.line.iter());
        trim_tail(&mut text);
        text
    }

    fn flush_line(&mut self, newline: bool) {
        let mut text: String = self.line.drain(..).collect();
        if newline {
            text.push('\n');
        }
        self.cursor = 0;
        self.tail.push_str(&text);
        trim_tail(&mut self.tail);
        if !self.view_truncated {
            let mut end = text.len().min(UI_CAP.saturating_sub(self.view.len()));
            while !text.is_char_boundary(end) {
                end -= 1;
            }
            self.view.push_str(&text[..end]);
            self.view_truncated = end < text.len();
        }
    }

    fn character(&mut self, ch: char) {
        match ch {
            '\n' => self.flush_line(true),
            '\r' => self.cursor = 0,
            '\x08' => self.cursor = self.cursor.saturating_sub(1),
            ch if !ch.is_control() || ch == '\t' => {
                // Buffer one bounded line so CR/backspace progress updates
                // can overwrite it. Huge newline-less streams are committed
                // in segments instead of growing memory without bound.
                if self.cursor >= MAX_LINE {
                    self.flush_line(false);
                }
                while self.line.len() < self.cursor {
                    self.line.push(' ');
                }
                if self.cursor < self.line.len() {
                    self.line[self.cursor] = ch;
                } else {
                    self.line.push(ch);
                }
                self.cursor += 1;
            }
            _ => {}
        }
    }

    fn csi(&mut self, command: char, parameters: &str) {
        // Only horizontal editing has a meaningful plain-text equivalent.
        // Styling, queries, full-screen/cursor modes and protocol data vanish.
        let count = if parameters.is_empty() {
            Some(0)
        } else {
            parameters.parse::<usize>().ok()
        };
        let Some(count) = count else { return };
        match command {
            'K' => match count {
                0 => self.line.truncate(self.cursor),
                1 => {
                    for ch in self.line.iter_mut().take(self.cursor.saturating_add(1)) {
                        *ch = ' ';
                    }
                }
                2 => self.line.clear(),
                _ => {}
            },
            'G' => self.cursor = count.clamp(1, MAX_LINE) - 1,
            'C' => self.cursor = self.cursor.saturating_add(count.max(1)).min(MAX_LINE),
            'D' => self.cursor = self.cursor.saturating_sub(count.max(1)),
            _ => {}
        }
    }
}

pub(super) fn trim_tail(text: &mut String) {
    let mut start = text.len().saturating_sub(MODEL_CAP);
    while !text.is_char_boundary(start) {
        start += 1;
    }
    if start > 0 {
        text.drain(..start);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decode_chunks(chunks: &[&[u8]]) -> String {
        let mut decoder = CapturedText::default();
        let mut output = CapturedOutput::default();
        for chunk in chunks {
            decoder.push(chunk, &mut output);
        }
        decoder.finish(&mut output);
        output.snapshot()
    }

    #[test]
    fn unicode_and_controls_are_independent_of_chunk_boundaries() {
        let raw = "\x1b]0;hidden title\x07\x1b[31mGrüße 🍰 東京\x1b[0m\r\n\x1bP$q hidden\x1b\\ok\x1b]8;;https://example.test\x1b\\ link\x1b]8;;\x1b\\\n";
        for split in 0..=raw.len() {
            assert_eq!(
                decode_chunks(&[&raw.as_bytes()[..split], &raw.as_bytes()[split..]]),
                "Grüße 🍰 東京\nok link\n",
                "byte split {split}"
            );
        }
        let chunks: Vec<&[u8]> = raw.as_bytes().chunks(1).collect();
        assert_eq!(decode_chunks(&chunks), "Grüße 🍰 東京\nok link\n");
    }

    #[test]
    fn rewrites_progress_and_backspaces_across_reads() {
        assert_eq!(
            decode_chunks(&[
                b"progress 10%\r",
                b"progress 100%\nabc",
                b"\x08\x08XY\nold text\rnew\x1b[",
                b"K\n"
            ]),
            "progress 100%\naXY\nnew\n"
        );
    }

    #[test]
    fn cancelled_control_sequences_preserve_the_next_printed_character() {
        for &cancel in b"\x18\x1a" {
            for prefix in [b"\x1b[31".as_slice(), b"\x1b[", b"\x1b(", b"\x1b"] {
                let mut raw = b"before".to_vec();
                raw.extend_from_slice(prefix);
                raw.push(cancel);
                raw.extend_from_slice(b"after\n");
                for split in 0..=raw.len() {
                    assert_eq!(
                        decode_chunks(&[&raw[..split], &raw[split..]]),
                        "beforeafter\n",
                        "cancel {cancel:#x}, prefix {prefix:?}, byte split {split}"
                    );
                }
            }
        }
    }

    #[test]
    fn inline_controls_execute_without_ending_a_control_sequence() {
        let raw = b"old\x1b[31\r\n\x7fmnew\x1b\x08[0m!\n";
        for split in 0..=raw.len() {
            assert_eq!(
                decode_chunks(&[&raw[..split], &raw[split..]]),
                "old\nne!\n",
                "byte split {split}"
            );
        }
    }

    #[test]
    fn preserves_real_text_tabs_and_literal_protocol_names() {
        assert_eq!(
            decode_chunks(&[b"printf 6973;RD; text\t[31m\n"]),
            "printf 6973;RD; text\t[31m\n"
        );
    }

    #[test]
    fn invalid_and_incomplete_utf8_are_replaced_once() {
        assert_eq!(decode_chunks(&[b"a\xff\xf0", b"\x9f"]), "a\u{fffd}\u{fffd}");
    }

    #[test]
    fn unterminated_control_strings_are_discarded_with_constant_memory() {
        let mut decoder = CapturedText::default();
        let mut output = CapturedOutput::default();
        decoder.push(b"visible\x1b]", &mut output);
        for _ in 0..20 {
            decoder.push(&vec![b'x'; MAX_LINE], &mut output);
            assert_eq!(output.snapshot(), "visible");
            assert_eq!(output.line.len(), 7);
            assert!(decoder.utf8.len() < 4);
        }
        decoder.finish(&mut output);
        assert_eq!(output.snapshot(), "visible");
    }

    #[test]
    fn large_unbroken_output_is_streamed_in_bounded_segments() {
        let raw = "🍰".repeat(MAX_LINE * 3);
        let mut decoder = CapturedText::default();
        let mut output = CapturedOutput::default();
        for chunk in raw.as_bytes().chunks(173) {
            decoder.push(chunk, &mut output);
            assert!(output.line.len() <= MAX_LINE);
            assert!(decoder.utf8.len() < 4);
        }
        decoder.finish(&mut output);
        assert_eq!(output.snapshot(), raw[..UI_CAP].to_string() + TRUNCATED);
        assert_eq!(output.tail(), raw[raw.len() - MODEL_CAP..]);
    }

    #[test]
    fn snapshots_show_partial_lines_and_preserve_pipe_arrival_order() {
        let mut out = CapturedText::default();
        let mut err = CapturedText::default();
        let mut output = CapturedOutput::default();
        out.push(b"out\x1b[", &mut output);
        assert_eq!(output.snapshot(), "out");
        err.push(b"err", &mut output);
        out.push(b"31mend\x1b[0m\nprogress 1%", &mut output);
        assert_eq!(output.snapshot(), "outerrend\nprogress 1%");
        out.push(b"\rprogress 100%", &mut output);
        assert_eq!(output.snapshot(), "outerrend\nprogress 100%");
        out.push(b"\xf0", &mut output);
        err.push(b" error ", &mut output);
        out.push(b"\x9f\x8d\xb0", &mut output);
        assert_eq!(output.snapshot(), "outerrend\nprogress 100% error 🍰");
    }
}
