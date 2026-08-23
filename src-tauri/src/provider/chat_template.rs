//! Chat templating for on-device models.
//!
//! Renders each GGUF's **own** Jinja template, the way llama.cpp's
//! `common/chat.cpp` does with minja — not the legacy C
//! `llama_chat_apply_template`, which picks one of a fixed set of built-in
//! renderers by *substring-matching* the template and returns `-1` when nothing
//! matches. That is not a corner case: Gemma 4 changed its turn markers from
//! `<start_of_turn>` to `<|turn>`, so the built-in GEMMA detector misses and
//! every Gemma 4 request failed with `chat template failed: ffi error -1`.
//! Qwen only worked by luck, because its template happens to contain the
//! literal ChatML marker the CHATML detector looks for.
//!
//! Rendering the real template also buys two things the C API structurally
//! cannot give us, both of which used to be worked around with prompt hacks:
//!
//! * **Native tool calling.** Both templates take a `tools` variable and render
//!   the schemas in the exact shape the model was trained on (Qwen builds a
//!   `<tools>` block, Gemma 4 has `format_parameters` macros). We no longer
//!   describe tools in prose and hope.
//! * **Native thinking control.** `enable_thinking` is a documented template
//!   variable; we no longer append `/think` or `/no_think` to the system turn.

use serde_json::{json, Map, Value};

use super::{ChatMessage, Role, ToolDef};

/// A model's chat template plus the tokenizer facts needed to drive it.
pub struct ChatTemplate {
    env: minijinja::Environment<'static>,
    bos_token: String,
    eos_token: String,
    /// From `tokenizer.ggml.add_bos_token`. Gemma 4 sets this true and its
    /// template does NOT emit BOS itself; Qwen sets it false. Hardcoding either
    /// answer silently degrades one of them, so it comes from metadata.
    pub add_bos: bool,
}

const TEMPLATE_NAME: &str = "chat";

impl ChatTemplate {
    pub fn new(
        source: String,
        bos_token: String,
        eos_token: String,
        add_bos: bool,
    ) -> Result<Self, String> {
        let mut env = minijinja::Environment::new();
        // HF templates are written for Python's Jinja2 and call Python methods
        // directly: Qwen uses `str.split/.strip/.lstrip`, Gemma 4 uses
        // `dict.get`. Without this both fail to render with "unknown method".
        env.set_unknown_method_callback(minijinja_contrib::pycompat::unknown_method_callback);
        // Jinja2 trims differently to minijinja's defaults; matching it keeps
        // whitespace-sensitive turn markers exactly where the model expects.
        env.set_lstrip_blocks(true);
        env.set_trim_blocks(true);
        env.add_template_owned(TEMPLATE_NAME, source)
            .map_err(|e| format!("chat template failed to parse: {e}"))?;
        Ok(Self {
            env,
            bos_token,
            eos_token,
            add_bos,
        })
    }

    /// Render a conversation into the prompt string the model expects.
    pub fn render(
        &self,
        messages: &[ChatMessage],
        tools: &[ToolDef],
        enable_thinking: bool,
    ) -> Result<String, String> {
        let tmpl = self
            .env
            .get_template(TEMPLATE_NAME)
            .map_err(|e| format!("chat template missing: {e}"))?;

        let ctx = minijinja::context! {
            messages => Value::Array(messages.iter().map(render_message).collect()),
            tools => if tools.is_empty() { Value::Null } else {
                Value::Array(tools.iter().map(render_tool).collect())
            },
            add_generation_prompt => true,
            enable_thinking => enable_thinking,
            bos_token => self.bos_token.as_str(),
            eos_token => self.eos_token.as_str(),
        };

        tmpl.render(ctx)
            .map_err(|e| format!("chat template failed to render: {e:#}"))
    }
}

/// One conversation turn in the shape HF templates expect.
fn render_message(msg: &ChatMessage) -> Value {
    let role = match msg.role {
        Role::System => "system",
        Role::User => "user",
        Role::Assistant => "assistant",
        Role::Tool => "tool",
    };
    let mut m = Map::new();
    m.insert("role".into(), json!(role));
    m.insert("content".into(), json!(msg.content));

    if let Some(calls) = msg.tool_calls.as_ref().filter(|c| !c.is_empty()) {
        // `arguments` goes in as a parsed object, not a string: templates either
        // access it structurally or pipe it through `tojson`, and both work on
        // an object while only the latter works on a string.
        let rendered: Vec<Value> = calls
            .iter()
            .map(|c| {
                let args: Value = serde_json::from_str(&c.arguments)
                    .unwrap_or_else(|_| Value::Object(Map::new()));
                json!({
                    "id": c.id,
                    "type": "function",
                    "function": { "name": c.name, "arguments": args },
                })
            })
            .collect();
        m.insert("tool_calls".into(), Value::Array(rendered));
    }
    if let Some(id) = &msg.tool_call_id {
        m.insert("tool_call_id".into(), json!(id));
    }
    Value::Object(m)
}

/// OpenAI function-schema shape — what every HF template's `tools` loop assumes.
fn render_tool(tool: &ToolDef) -> Value {
    json!({
        "type": "function",
        "function": {
            "name": tool.name,
            "description": tool.description,
            "parameters": tool.parameters,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // The real templates, extracted from the shipped GGUFs. These are the
    // regression test for the Gemma 4 failure: if a future dependency bump
    // stops rendering either of them, that is a broken model, not a warning.
    //
    // Keep them in step with what the catalog actually offers. The Qwen fixture
    // was a Qwen**3** template long after the catalog moved to 3.5, and it hid a
    // real bug: 3.5 prefills `<think>` in the generation prompt and 3 did not.
    const QWEN35: &str = include_str!("../../tests/fixtures/qwen3.5-chat-template.jinja");
    const GEMMA4: &str = include_str!("../../tests/fixtures/gemma4-chat-template.jinja");

    fn qwen() -> ChatTemplate {
        ChatTemplate::new(QWEN35.into(), String::new(), "<|im_end|>".into(), false).unwrap()
    }
    fn gemma() -> ChatTemplate {
        ChatTemplate::new(GEMMA4.into(), "<bos>".into(), "<turn|>".into(), true).unwrap()
    }

    fn convo() -> Vec<ChatMessage> {
        vec![
            ChatMessage::system("You are a terminal assistant."),
            ChatMessage::user("list large files"),
        ]
    }

    fn run_command_tool() -> ToolDef {
        ToolDef {
            name: "run_command".into(),
            description: "Run one shell command.".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "command": {"type": "string", "description": "The command"},
                    "explanation": {"type": "string", "description": "Why"}
                },
                "required": ["command", "explanation"]
            }),
        }
    }

    /// A round that ran one command, with a steering message appended AFTER the
    /// tool result — the only placement the agent loop ever produces.
    fn steered_convo() -> Vec<ChatMessage> {
        vec![
            ChatMessage::system("You are a terminal assistant."),
            ChatMessage::user("list large files"),
            ChatMessage {
                role: Role::Assistant,
                content: String::new(),
                tool_calls: Some(vec![crate::provider::ToolCall {
                    id: "t1".into(),
                    name: "run_command".into(),
                    arguments: r#"{"command":"du -sh *","explanation":"sizes"}"#.into(),
                }]),
                tool_call_id: None,
                structured_tool_result: None,
                images: None,
            },
            ChatMessage {
                role: Role::Tool,
                content: "exit code: 0\noutput (tail):\nTOOL_RESULT_MARKER".into(),
                tool_calls: None,
                tool_call_id: Some("t1".into()),
                structured_tool_result: None,
                images: None,
            },
            ChatMessage::user("STEER_MARKER use ripgrep instead"),
        ]
    }

    #[test]
    fn a_steer_at_the_round_boundary_keeps_the_tool_result_on_both_families() {
        for (name, tmpl) in [("qwen", qwen()), ("gemma", gemma())] {
            let out = tmpl
                .render(&steered_convo(), &[run_command_tool()], true)
                .unwrap_or_else(|e| panic!("{name} failed to render a steered convo: {e}"));
            assert!(
                out.contains("TOOL_RESULT_MARKER"),
                "{name} dropped the tool result:\n{out}"
            );
            assert!(
                out.contains("STEER_MARKER"),
                "{name} dropped the steering message:\n{out}"
            );
        }
    }

    /// The executable statement of the whole constraint. Move the same steer one
    /// slot earlier — between the tool_call and its result — and Gemma 4's
    /// template silently deletes the command output: it renders `role: tool`
    /// messages only via a forward-scan from the assistant turn that called them,
    /// and that scan stops dead at a non-tool message. No error, no warning, just
    /// a model that never sees what its command printed.
    ///
    /// If this test ever starts failing, the constraint may have been relaxed
    /// upstream — verify against a real GGUF before loosening `append_steers`.
    #[test]
    fn the_same_steer_one_slot_earlier_destroys_gemmas_tool_result() {
        let mut messages = steered_convo();
        let steer = messages.pop().unwrap();
        messages.insert(messages.len() - 1, steer);

        let out = gemma()
            .render(&messages, &[run_command_tool()], true)
            .unwrap();
        assert!(
            !out.contains("TOOL_RESULT_MARKER"),
            "Gemma now survives mid-round injection — re-verify before relaxing the rule:\n{out}"
        );
        assert!(out.contains("STEER_MARKER"), "{out}");
    }

    #[test]
    fn qwen_renders_without_tools() {
        let out = qwen().render(&convo(), &[], false).unwrap();
        assert!(out.contains("<|im_start|>system"), "{out}");
        assert!(out.contains("You are a terminal assistant."), "{out}");
        assert!(out.contains("list large files"), "{out}");
        // add_generation_prompt must open an assistant turn for the model to
        // continue from; without it the model re-emits the conversation.
        assert!(out.contains("<|im_start|>assistant"), "{out}");
        // With thinking off, Qwen's own template closes an empty <think> block
        // to suppress reasoning — the native mechanism the `/no_think` string
        // hack used to approximate.
        assert!(out.contains("<think>"), "{out}");
    }

    #[test]
    fn gemma_renders_without_tools() {
        // This is the exact case that produced `ffi error -1`.
        let out = gemma().render(&convo(), &[], false).unwrap();
        assert!(out.contains("You are a terminal assistant."), "{out}");
        assert!(out.contains("list large files"), "{out}");
        assert!(!out.is_empty());
    }

    #[test]
    fn tools_reach_the_template_natively() {
        // The whole point of dropping the C API: the model sees tool schemas in
        // the format it was trained on, instead of prose in the system prompt.
        let tools = [run_command_tool()];

        let q = qwen().render(&convo(), &tools, false).unwrap();
        assert!(
            q.contains("<tools>"),
            "qwen should build its own tools block: {q}"
        );
        assert!(q.contains("run_command"), "{q}");

        let g = gemma().render(&convo(), &tools, false).unwrap();
        assert!(
            g.contains("run_command"),
            "gemma should render the tool: {g}"
        );
    }

    #[test]
    fn thinking_toggle_reaches_the_template() {
        // Gemma 4 branches on `enable_thinking` directly.
        let on = gemma().render(&convo(), &[], true).unwrap();
        let off = gemma().render(&convo(), &[], false).unwrap();
        assert_ne!(on, off, "enable_thinking should change Gemma's prompt");
    }

    #[test]
    fn qwen_thinking_prompt_ends_inside_an_open_think_block() {
        // Qwen3.5 opens the reasoning span ITSELF, so the model emits only the
        // closing `</think>`. `OutputSplitter` has to be told (see
        // `Markers::opens_thought`) or the whole reasoning trace is delivered as
        // the answer with a stray `</think>` on the end of it.
        let on = qwen().render(&convo(), &[], true).unwrap();
        assert!(on.trim_end().ends_with("<think>"), "{on}");

        // Thinking off prefills a CLOSED block instead — nothing to resume.
        let off = qwen().render(&convo(), &[], false).unwrap();
        assert!(off.trim_end().ends_with("</think>"), "{off}");
    }

    #[test]
    fn assistant_tool_calls_and_results_round_trip() {
        // The agent loop replays its own tool calls plus the tool results; both
        // templates have dedicated branches for this and used to receive an
        // off-distribution bare `tool` role instead.
        let msgs = vec![
            ChatMessage::system("You are a terminal assistant."),
            ChatMessage::user("what is in /tmp?"),
            ChatMessage {
                role: Role::Assistant,
                content: String::new(),
                tool_calls: Some(vec![super::super::ToolCall {
                    id: "call_1".into(),
                    name: "run_command".into(),
                    arguments: r#"{"command":"ls /tmp","explanation":"list"}"#.into(),
                }]),
                tool_call_id: None,
                structured_tool_result: None,
                images: None,
            },
            ChatMessage {
                role: Role::Tool,
                content: "a.txt\nb.txt".into(),
                tool_calls: None,
                tool_call_id: Some("call_1".into()),
                structured_tool_result: None,
                images: None,
            },
        ];
        let tools = [run_command_tool()];

        let q = qwen().render(&msgs, &tools, false).unwrap();
        assert!(q.contains("ls /tmp"), "{q}");
        assert!(q.contains("a.txt"), "{q}");

        let g = gemma().render(&msgs, &tools, false).unwrap();
        assert!(g.contains("ls /tmp"), "{g}");
        assert!(g.contains("a.txt"), "{g}");
    }

    #[test]
    fn add_bos_comes_from_metadata_not_a_guess() {
        // Gemma 4 wants BOS and its template does not emit one; Qwen does not.
        // Getting this backwards degrades output with no error at all.
        assert!(gemma().add_bos);
        assert!(!qwen().add_bos);
    }
}
