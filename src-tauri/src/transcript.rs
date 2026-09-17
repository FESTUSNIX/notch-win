//! Reading a Claude Code transcript to find out what a session is doing.
//!
//! The session file in `~/.claude/sessions/` says a session *exists*. What it
//! is doing is in the transcript it streams to
//! `~/.claude/projects/<project>/<sessionId>.jsonl`, and the interesting part
//! is the distinction the file's modification time cannot make: **a session
//! blocked on you looks exactly like one that has finished** — both stop
//! writing. That is the note at the top of `sessions.rs`, and this module is
//! the answer to it.
//!
//! The rule is one line long: **the last conversational record wins.**
//!
//! | last record                     | the session is |
//! |---------------------------------|----------------|
//! | `assistant` with a `tool_use`   | working — a tool call is pending |
//! | `assistant` with only prose     | **waiting for you** |
//! | `user` (a prompt or a result)   | working — the model is thinking |
//!
//! ⚠️ **"The last record" is not the last line.** A transcript carries fifteen
//! record types and barely half are conversational; `bridge-session`,
//! `atis-latch`, `attachment`, `last-prompt` and friends land at the tail
//! constantly. Reading the final line and looking for a role finds `None` and
//! learns nothing, silently and for ever.
//!
//! ⚠️ **And it is not read by loading the file.** These reach 49 MB on this
//! machine. Everything here works on a bounded tail, or on the bytes appended
//! since the last look.

use serde::Serialize;
use std::path::Path;

/// What the transcript says is happening. Ordered by how much it wants you.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Turn {
    /// A tool call is pending, or a prompt just went in and the model is
    /// thinking. Either way nobody is waiting on you.
    Working,
    /// The assistant is BLOCKED on you — it asked a question and cannot carry
    /// on until it is answered.
    ///
    /// ⚠️ Not the same as the turn merely ending, and conflating the two had
    /// them exactly backwards. A turn that ends in prose is the model handing
    /// work back, which wants no attention at all; a question is a `tool_use`
    /// block, which every other tool call also is — so the one state that
    /// genuinely needed you was reported as *working*, and the one that needed
    /// nothing pulsed amber until the terminal was closed.
    Waiting,
    /// The assistant's turn ended with prose and asked for nothing. The work is
    /// done; nothing more will be written until you type something, and nothing
    /// is expected of you before then.
    Done,
    /// Nothing conversational in what was read.
    Unknown,
}

/// Tokens, as the pill and the usage notch would say them.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Usage {
    /// Everything the model read, cache included — what the limit is spent on.
    pub input: u64,
    pub output: u64,
}

impl Usage {
    pub fn add(&mut self, other: Usage) {
        self.input += other.input;
        self.output += other.output;
    }
}

/// How much of the end of a file to read when a session is first seen.
///
/// Big enough to contain a conversational record even after a run of
/// bookkeeping and a large attachment; small enough that noticing ten sessions
/// at launch costs a few megabytes rather than half a gigabyte.
pub const TAIL_BYTES: u64 = 512 * 1024;

/// The most bytes to take in one poll. A session that has been writing hard
/// while the app was asleep must not stall the watcher for a second.
pub const CHUNK_BYTES: u64 = 4 * 1024 * 1024;

/// What a session is doing right now, in words.
///
/// ⚠️ The status was three bits — working / waiting / idle — for something you
/// are paying real attention to. The transcript has always carried the answer:
/// an `assistant` record mid-flight ends in a `tool_use` block that names the
/// tool and carries its arguments. "working" becomes "editing palette.ts".
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Doing {
    /// The verb, already conjugated: `editing`, `running`, `reading`.
    pub verb: String,
    /// What it is doing it to, short enough for a pill. May be empty.
    pub subject: String,
}

impl Doing {
    pub fn say(&self) -> String {
        if self.subject.is_empty() { self.verb.clone() }
        else { format!("{} {}", self.verb, self.subject) }
    }
}

/// The last path segment, so a row says `palette.ts` rather than 60 characters
/// of absolute path nobody can read at 11px.
fn leaf(path: &str) -> String {
    path.rsplit([SEP, '/']).next().unwrap_or(path).to_string()
}

/// ⚠️ Built, never typed. A literal backslash in this repo has been eaten by
/// patch tooling often enough to be worth a constant — see `win.rs`.
const SEP: char = '\\';

/// The first few words of a command, which is the part that says what it is.
///
/// ⚠️ Truncated hard. A `Bash` input is routinely a 400-character pipeline with
/// a heredoc in it; the pill has room for about twenty characters and the
/// agents row for forty.
fn gist(command: &str) -> String {
    let head = command.trim().lines().next().unwrap_or("").trim();
    let mut out = String::new();
    for word in head.split_whitespace() {
        if out.len() + word.len() > 28 {
            break;
        }
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(word);
    }
    if out.is_empty() { head.chars().take(28).collect() } else { out }
}

/// Turn a `tool_use` block into a phrase.
///
/// ⚠️ Unknown tools fall back to the tool's own name rather than to nothing.
/// The set grows — an MCP server adds its own — and a session that went quiet
/// because this function had no branch for `mcp__figma__get_design` would look
/// exactly like one that had stopped.
fn phrase(name: &str, input: Option<&serde_json::Value>) -> Doing {
    let arg = |key: &str| -> String {
        input
            .and_then(|value| value.get(key))
            .and_then(|value| value.as_str())
            .unwrap_or_default()
            .to_string()
    };
    let (verb, subject) = match name {
        "Edit" | "Write" | "NotebookEdit" => ("editing", leaf(&arg("file_path"))),
        "Read" => ("reading", leaf(&arg("file_path"))),
        "Bash" | "PowerShell" => ("running", gist(&arg("command"))),
        "Glob" | "Grep" => ("searching", gist(&arg("pattern"))),
        "Task" | "Agent" => ("delegating", arg("description")),
        "WebFetch" | "WebSearch" => ("looking up", gist(&arg("query"))),
        "TodoWrite" => ("planning", String::new()),
        "Skill" => ("using", arg("skill")),
        other => {
            // `mcp__figma__get_design_context` -> `get design context`
            let tail = other.rsplit("__").next().unwrap_or(other);
            return Doing { verb: "using".into(), subject: tail.replace('_', " ") };
        }
    };
    Doing { verb: verb.into(), subject }
}

/// The tool call a mid-flight `assistant` record is making, if any.
pub fn doing(line: &str) -> Option<Doing> {
    let value: serde_json::Value = serde_json::from_str(line).ok()?;
    if value.get("isSidechain").and_then(|v| v.as_bool()) == Some(true) {
        return None;
    }
    if value.get("type").and_then(|v| v.as_str())? != "assistant" {
        return None;
    }
    let content = value.get("message")?.get("content")?.as_array()?;
    // ⚠️ The LAST tool_use in the block, not the first. One assistant turn can
    // carry several calls, and the last one written is the one in flight.
    let block = content
        .iter()
        .filter(|block| block.get("type").and_then(|v| v.as_str()) == Some("tool_use"))
        .next_back()?;
    Some(phrase(
        block.get("name").and_then(|v| v.as_str()).unwrap_or("a tool"),
        block.get("input"),
    ))
}

/// One thing the agent did, for the list of them on the Agents screen.
///
/// ⚠️ The ID is the whole point. A tool call and the result that finishes it
/// are two records, minutes apart, and the only thing joining them is
/// `tool_use_id` — without it a list of steps is a list of things that were
/// STARTED, which reads as an agent that never finishes anything.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Step {
    pub id: String,
    /// Already conjugated and shortened: `running cargo test`, `reading x.ts`.
    pub say: String,
    /// Whether its result has come back.
    pub done: bool,
}

/// Every tool call an assistant record makes, in order.
///
/// ⚠️ ALL of them, where `doing` takes only the last. One assistant turn can
/// carry several calls and the pill wants the newest; a list wants every one,
/// or it skips steps and reads as an agent that did half the work.
pub fn steps_of(line: &str) -> Vec<Step> {
    let mut out = Vec::new();
    let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
        return out;
    };
    if value.get("isSidechain").and_then(|v| v.as_bool()) == Some(true) {
        return out;
    }
    if value.get("type").and_then(|v| v.as_str()) != Some("assistant") {
        return out;
    }
    let Some(content) = value
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_array())
    else {
        return out;
    };
    for block in content {
        if block.get("type").and_then(|v| v.as_str()) != Some("tool_use") {
            continue;
        }
        let Some(id) = block.get("id").and_then(|v| v.as_str()) else { continue };
        let say = phrase(
            block.get("name").and_then(|v| v.as_str()).unwrap_or("a tool"),
            block.get("input"),
        )
        .say();
        out.push(Step { id: id.to_string(), say, done: false });
    }
    out
}

/// The ids of the tool calls a user record is answering.
///
/// ⚠️ A `tool_result` arrives in a USER record, which is the thing that is
/// easy to get wrong here: the agent's own turn never says that its call
/// finished, because the result is fed back to it as input.
pub fn results_of(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
        return out;
    };
    if value.get("type").and_then(|v| v.as_str()) != Some("user") {
        return out;
    }
    let Some(content) = value
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_array())
    else {
        return out;
    };
    for block in content {
        if block.get("type").and_then(|v| v.as_str()) != Some("tool_result") {
            continue;
        }
        if let Some(id) = block.get("tool_use_id").and_then(|v| v.as_str()) {
            out.push(id.to_string());
        }
    }
    out
}

/// Classify one JSONL line, or `None` if it is not a conversational record.
///
/// ⚠️ `isSidechain` records are a **subagent's** conversation, not yours. A
/// subagent ending its turn with prose is not the session waiting for you —
/// the parent picks the result up and carries on — and counting it would make
/// every Task call look like a prompt.
pub fn classify(line: &str) -> Option<Turn> {
    let value: serde_json::Value = serde_json::from_str(line).ok()?;
    if value.get("isSidechain").and_then(|v| v.as_bool()) == Some(true) {
        return None;
    }
    let message = value.get("message")?;
    match value.get("type").and_then(|v| v.as_str())? {
        "user" => Some(Turn::Working),
        "assistant" => {
            let content = message.get("content")?.as_array()?;
            /* ⚠️ A question comes through as a TOOL CALL, and that is the whole
             * reason this was wrong. `AskUserQuestion` is a `tool_use` block
             * like `Bash` or `Read`, so the check below counts it as the model
             * being mid-flight — and the one moment a session genuinely wants
             * you reported as *working*, with no pulse and no notification.
             * Verified against a real transcript: the record is an assistant
             * message whose only block is that tool call, and nothing follows
             * it until the answer arrives as a `tool_result`. */
            if content.iter().any(|block| {
                block.get("type").and_then(|v| v.as_str()) == Some("tool_use")
                    && block.get("name").and_then(|v| v.as_str()) == Some("AskUserQuestion")
            }) {
                return Some(Turn::Waiting);
            }
            // Anything else in the block list means the model is mid-flight.
            let acting = content.iter().any(|block| {
                !matches!(
                    block.get("type").and_then(|v| v.as_str()),
                    Some("text") | Some("thinking") | Some("redacted_thinking")
                )
            });
            /* ⚠️ And a turn that simply ENDS is done, not waiting. It used to
             * be waiting, which is true of the file — nothing more is written
             * until you type — and false of you: the work came back, there was
             * no question, and there is nothing to answer. Reported as waiting
             * it pulsed amber and held the pill for the rest of the session. */
            Some(if acting { Turn::Working } else { Turn::Done })
        }
        _ => None,
    }
}

/// The tokens an assistant record reports, or `None` if it reports none.
///
/// ⚠️ Cache reads count. They are most of what a long session spends and they
/// are what the limit is measured against — a figure that left them out would
/// say a few thousand tokens for an afternoon that used half a million.
pub fn usage_of(line: &str) -> Option<Usage> {
    let value: serde_json::Value = serde_json::from_str(line).ok()?;
    if value.get("isSidechain").and_then(|v| v.as_bool()) == Some(true) {
        return None;
    }
    let usage = value.get("message")?.get("usage")?;
    let field = |name: &str| usage.get(name).and_then(|v| v.as_u64()).unwrap_or(0);
    let input = field("input_tokens")
        + field("cache_read_input_tokens")
        + field("cache_creation_input_tokens");
    let output = field("output_tokens");
    (input > 0 || output > 0).then_some(Usage { input, output })
}

/// The branch a record was written on, where Claude Code recorded one.
pub fn branch_of(line: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(line).ok()?;
    value
        .get("gitBranch")
        .and_then(|v| v.as_str())
        .filter(|b| !b.is_empty())
        .map(|b| b.to_string())
}

/// What a chunk of transcript said.
#[derive(Debug, Default)]
pub struct Scan {
    /// The last conversational record in the chunk, if there was one.
    pub turn: Option<Turn>,
    pub usage: Usage,
    pub branch: Option<String>,
    /// What the newest tool call in the chunk is doing.
    ///
    /// ⚠️ Cleared by a record that ENDS the turn, not merely left behind. A
    /// session that finished editing and is now waiting for you must not still
    /// read "editing palette.ts" — that is a status that was true and is now a
    /// lie, which is worse than no status at all.
    pub doing: Option<Doing>,
    /// The tool calls seen in this chunk, oldest first.
    pub steps: Vec<Step>,
    /// The ids finished in this chunk. ⚠️ Kept separately from `steps`,
    /// because a result routinely lands in a chunk whose call was read minutes
    /// ago — the caller holds the list across scans and this is the patch.
    pub finished: Vec<String>,
    /// ⚠️ A turn that ENDED clears the list as well as the phrase. The steps
    /// of a run that finished are what the agent did last time, and a screen
    /// still showing them while the agent waits for you says it is busy.
    pub cleared: bool,
}

/// Walk a chunk of transcript, newest fact winning.
pub fn scan(chunk: &str) -> Scan {
    let mut out = Scan::default();
    for line in chunk.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Some(turn) = classify(line) {
            out.turn = Some(turn);
            if matches!(turn, Turn::Waiting | Turn::Done) {
                out.doing = None;
                out.cleared = true;
            }
        }
        for step in steps_of(line) {
            out.cleared = false;
            out.steps.push(step);
        }
        out.finished.extend(results_of(line));
        if let Some(action) = doing(line) {
            out.doing = Some(action);
        }
        if let Some(usage) = usage_of(line) {
            out.usage.add(usage);
        }
        if let Some(branch) = branch_of(line) {
            out.branch = Some(branch);
        }
    }
    out
}

/// Read `from..len` of a file, and say where reading stopped.
///
/// ⚠️ A file **shorter** than the offset was replaced, not rewound — a new
/// session reusing the name, or a rotation. Re-reading from zero would mean
/// parsing 49 MB on the tick that happened; the offset jumps to the new end
/// and the next append is picked up normally.
///
/// ⚠️ The read is byte-bounded and the tail of the buffer may be **half a
/// line**, because an append can land between the poll's `metadata` and its
/// `read`. The offset is therefore rewound to the last newline, so the partial
/// line is read again — whole — next time rather than parsed as truncated JSON.
pub fn read_from(path: &Path, from: u64) -> Option<(u64, String)> {
    use std::io::{Read, Seek, SeekFrom};

    let mut file = std::fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    if len <= from {
        return Some((len.min(from), String::new()));
    }
    let start = from.max(len.saturating_sub(CHUNK_BYTES));
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut buffer = vec![0u8; (len - start) as usize];
    let read = file.read(&mut buffer).ok()?;
    buffer.truncate(read);

    // Stop at the last complete line; anything after it is read again later.
    let end = match buffer.iter().rposition(|b| *b == b'\n') {
        Some(index) => index + 1,
        // Not one whole line yet. Stay put rather than parse a fragment.
        None => return Some((start, String::new())),
    };
    let text = String::from_utf8_lossy(&buffer[..end]).into_owned();
    Some((start + end as u64, text))
}

/// Where to start watching a file that has just been noticed.
///
/// The end, not the beginning: a historical scan of every open session's
/// transcript at launch would read hundreds of megabytes to learn something
/// the last few kilobytes already say. The cost of that choice is that token
/// totals are "since Codenotch was watching", which is what the UI says.
pub fn opening_offset(path: &Path) -> u64 {
    std::fs::metadata(path).map(|m| m.len()).unwrap_or(0)
}

/// What a newly noticed session should be given, from its tail.
///
/// ⚠️ The whole `Scan`, not just the turn: the branch comes from the same read
/// and is otherwise blank until the session next writes — which for a session
/// sitting there waiting for you is never.
pub fn opening_scan(path: &Path) -> Scan {
    let len = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    let from = len.saturating_sub(TAIL_BYTES);
    match read_from(path, from) {
        Some((_, chunk)) => scan(&chunk),
        None => Scan::default(),
    }
}

#[cfg(test)]
mod tests {
    fn step_call(id: &str, name: &str, input: &str) -> String {
        format!(
            r#"{{"type":"assistant","message":{{"content":[{{"type":"tool_use","id":"{id}","name":"{name}","input":{input}}}]}}}}"#
        )
    }

    #[test]
    fn a_step_is_only_done_when_its_result_comes_back() {
        /* ⚠️ The ID is the whole point. A call and the result that finishes it
         * are two records minutes apart, and `tool_use_id` is the only thing
         * joining them — without it a list of steps is a list of things that
         * were STARTED, which reads as an agent that finishes nothing. */
        let chunk = [
            // ⚠️ Forward slashes: a raw string keeps a backslash literal, and `\w` is
            // not a valid JSON escape — the record simply fails to parse and the
            // step vanishes, which is exactly what a wrong fixture looks like.
            step_call("t1", "Read", r#"{"file_path":"work/palette.ts"}"#),
            r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1"}]}}"#.to_string(),
            step_call("t2", "Bash", r#"{"command":"cargo test --lib"}"#),
        ]
        .join("
");
        let seen = scan(&chunk);
        assert_eq!(seen.steps.len(), 2);
        assert_eq!(seen.finished, vec!["t1".to_string()]);
        assert!(seen.steps[0].say.contains("palette.ts"));
        assert!(seen.steps[1].say.contains("cargo test"));
        // The scan reports; joining them up is the caller's, across chunks.
        assert!(!seen.steps[0].done);
    }

    #[test]
    fn several_calls_in_one_turn_are_all_steps() {
        /* ⚠️ ALL of them, where `doing` takes only the last: one assistant
         * turn routinely carries several calls, and a list that kept the last
         * would skip steps and read as an agent that did half the work. */
        let line = r#"{"type":"assistant","message":{"content":[
            {"type":"tool_use","id":"a","name":"Read","input":{"file_path":"one.ts"}},
            {"type":"tool_use","id":"b","name":"Read","input":{"file_path":"two.ts"}}
        ]}}"#;
        let steps = steps_of(line);
        assert_eq!(steps.len(), 2);
        assert_eq!(steps.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), ["a", "b"]);
        // And `doing` still answers with the newest, which is what a pill wants.
        assert!(doing(line).unwrap().say().contains("two.ts"));
    }

    #[test]
    fn a_subagents_calls_are_not_the_sessions_steps() {
        // Same rule `classify` follows: a sidechain is a subagent's own
        // conversation, and counting it makes every Task call look like work
        // the session is doing.
        let line = format!(
            r#"{{"isSidechain":true,"type":"assistant","message":{{"content":[{{"type":"tool_use","id":"x","name":"Read","input":{{"file_path":"a.ts"}}}}]}}}}"#
        );
        assert!(steps_of(&line).is_empty());
    }

    #[test]
    fn a_turn_that_ends_clears_the_list() {
        /* ⚠️ The steps of a run that finished are what the agent did LAST
         * time, and a screen still showing them while it waits for you says it
         * is busy. */
        let chunk = [
            step_call("t1", "Bash", r#"{"command":"ls"}"#),
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"done"}]}}"#.to_string(),
        ]
        .join("
");
        assert!(scan(&chunk).cleared);
        // And a chunk that ends mid-call does not.
        assert!(!scan(&step_call("t9", "Bash", r#"{"command":"ls"}"#)).cleared);
    }

    use super::*;

    fn call(name: &str, input: serde_json::Value) -> String {
        serde_json::json!({
            "type": "assistant",
            "message": {"content": [{"type": "tool_use", "name": name, "input": input}]}
        })
        .to_string()
    }

    /// ⚠️ "working" was three bits of information about something you are
    /// paying real attention to. The transcript always carried the answer.
    #[test]
    fn a_tool_call_says_what_it_is_doing() {
        let edit = call("Edit", serde_json::json!({"file_path": "C:/CODE/app/src/palette.ts"}));
        assert_eq!(doing(&edit).unwrap().say(), "editing palette.ts");

        let read = call("Read", serde_json::json!({"file_path": "/home/x/notes.md"}));
        assert_eq!(doing(&read).unwrap().say(), "reading notes.md");

        let bash = call("Bash", serde_json::json!({"command": "cargo test --lib"}));
        assert_eq!(doing(&bash).unwrap().say(), "running cargo test --lib");

        assert_eq!(doing(&call("TodoWrite", serde_json::json!({}))).unwrap().say(), "planning");
    }

    /// ⚠️ A `Bash` input is routinely a 400-character pipeline with a heredoc
    /// in it, and the row it lands in is about forty characters wide.
    #[test]
    fn a_long_command_is_cut_to_its_gist() {
        let long = call("Bash", serde_json::json!({
            "command": "cargo test --lib --all-features -- --nocapture --test-threads 1 | grep -E 'ok|FAILED'"
        }));
        let said = doing(&long).unwrap().say();
        assert!(said.len() < 44, "{said}");
        assert!(said.starts_with("running cargo test"), "{said}");

        // A heredoc is many lines; only the first one says anything.
        let heredoc = call("Bash", serde_json::json!({"command": "python - <<PY\nimport os\nPY"}));
        assert!(!doing(&heredoc).unwrap().say().contains("import"));
    }

    /// ⚠️ The set of tools grows — an MCP server adds its own — and a session
    /// that went blank because there was no branch for it would look exactly
    /// like one that had stopped.
    #[test]
    fn an_unknown_tool_still_says_something() {
        let mcp = call("mcp__figma__get_design_context", serde_json::json!({}));
        assert_eq!(doing(&mcp).unwrap().say(), "using get design context");
        let odd = call("SomeNewThing", serde_json::json!({}));
        assert_eq!(doing(&odd).unwrap().say(), "using SomeNewThing");
    }

    /// ⚠️ The LAST call in the block, not the first: one assistant turn can
    /// carry several, and the last written is the one in flight.
    #[test]
    fn the_newest_call_in_a_turn_wins() {
        let two = serde_json::json!({
            "type": "assistant",
            "message": {"content": [
                {"type": "tool_use", "name": "Read", "input": {"file_path": "a.ts"}},
                {"type": "tool_use", "name": "Edit", "input": {"file_path": "b.ts"}}
            ]}
        })
        .to_string();
        assert_eq!(doing(&two).unwrap().say(), "editing b.ts");
    }

    /// ⚠️ A subagent's tool call is not the session's. Same rule as `classify`.
    #[test]
    fn a_subagent_is_not_the_session() {
        let side = serde_json::json!({
            "type": "assistant",
            "isSidechain": true,
            "message": {"content": [{"type": "tool_use", "name": "Edit", "input": {"file_path": "x.ts"}}]}
        })
        .to_string();
        assert!(doing(&side).is_none());
        // And prose carries no call at all.
        let prose = serde_json::json!({
            "type": "assistant", "message": {"content": [{"type": "text", "text": "done"}]}
        })
        .to_string();
        assert!(doing(&prose).is_none());
    }

    /// ⚠️ A phrase that outlives its run is a status that WAS true, which is
    /// worse than no status. Prose ending the turn clears it.
    #[test]
    fn ending_the_turn_clears_what_it_was_doing() {
        let working = call("Bash", serde_json::json!({"command": "cargo build"}));
        let prose = serde_json::json!({
            "type": "assistant", "message": {"content": [{"type": "text", "text": "Built."}]}
        })
        .to_string();
        assert_eq!(scan(&working).doing.unwrap().say(), "running cargo build");
        assert!(scan(&format!("{working}\n{prose}")).doing.is_none());
        // ...and the other order keeps it: the call came after the prose.
        assert!(scan(&format!("{prose}\n{working}")).doing.is_some());
    }

    const TOOL: &str = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Bash"}],"usage":{"input_tokens":2,"cache_read_input_tokens":532375,"cache_creation_input_tokens":4334,"output_tokens":1760}}}"#;
    const PROSE: &str = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Done."}],"usage":{"input_tokens":10,"output_tokens":20}}}"#;
    const THINKING: &str = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"thinking","thinking":"hmm"},{"type":"text","text":"Done."}]}}"#;
    const RESULT: &str = r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"ok"}]}}"#;
    const PROMPT: &str = r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"go"}]}}"#;
    const SIDE: &str = r#"{"type":"assistant","isSidechain":true,"message":{"role":"assistant","content":[{"type":"text","text":"subagent done"}],"usage":{"input_tokens":99,"output_tokens":99}}}"#;
    /// The record types that actually land at the tail of a live transcript.
    const NOISE: &[&str] = &[
        r#"{"type":"bridge-session"}"#,
        r#"{"type":"atis-latch"}"#,
        r#"{"type":"last-prompt"}"#,
        r#"{"type":"ai-title"}"#,
        r#"{"type":"attachment","message":{"content":"x"}}"#,
        r#"{"type":"file-history-snapshot"}"#,
        r#"{"type":"queue-operation"}"#,
        r#"{"type":"mode"}"#,
        r#"{"type":"frame-link"}"#,
        "not json at all",
        "",
    ];

    /// An assistant turn whose only block is a question. ⚠️ Taken from a real
    /// transcript on this machine, not invented: `AskUserQuestion` is a
    /// `tool_use` with a name, which is exactly why the old check could not
    /// tell it apart from `Bash`.
    const ASKING: &str = r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"AskUserQuestion","input":{}}]}}"#;

    #[test]
    fn prose_is_done_a_question_waits_and_a_tool_call_is_neither() {
        assert_eq!(classify(TOOL), Some(Turn::Working));
        /* ⚠️ DONE, not waiting. The work came back and there was no question,
         * so there is nothing to answer — true of you, even though the file
         * will not grow again until you type. Called waiting, it pulsed amber
         * and held the pill for the rest of the session. */
        assert_eq!(classify(PROSE), Some(Turn::Done));
        /* ⚠️ And a QUESTION is the case that genuinely waits. It arrives as a
         * `tool_use` block like every other tool call, so the mid-flight check
         * swallowed it and the one state that wanted you was reported as
         * working — no pulse, no notification. */
        assert_eq!(classify(ASKING), Some(Turn::Waiting));
        // Thinking is not acting: a turn that thought and then answered has
        // still ended.
        assert_eq!(classify(THINKING), Some(Turn::Done));
        assert_eq!(classify(RESULT), Some(Turn::Working));
        assert_eq!(classify(PROMPT), Some(Turn::Working));
    }

    #[test]
    fn bookkeeping_records_are_not_conversational() {
        // ⚠️ The whole reason this is not "read the last line". Every one of
        // these appears at the tail of a live transcript.
        for line in NOISE {
            assert_eq!(classify(line), None, "{line}");
        }
    }

    #[test]
    fn a_subagent_ending_its_turn_is_not_the_session_waiting() {
        assert_eq!(classify(SIDE), None);
        assert_eq!(usage_of(SIDE), None);
    }

    #[test]
    fn the_newest_conversational_record_wins_through_the_noise() {
        let mut chunk = vec![PROMPT, TOOL, RESULT, PROSE];
        chunk.extend_from_slice(NOISE);
        assert_eq!(scan(&chunk.join("\n")).turn, Some(Turn::Done));

        let mut asked = vec![PROMPT, TOOL, RESULT, ASKING];
        asked.extend_from_slice(NOISE);
        assert_eq!(scan(&asked.join("\n")).turn, Some(Turn::Waiting));

        let mut working = vec![PROSE, PROMPT, TOOL];
        working.extend_from_slice(NOISE);
        assert_eq!(scan(&working.join("\n")).turn, Some(Turn::Working));

        assert_eq!(scan(&NOISE.join("\n")).turn, None);
    }

    #[test]
    fn cache_reads_are_counted_because_that_is_what_a_limit_is_spent_on() {
        let usage = usage_of(TOOL).unwrap();
        assert_eq!(usage.input, 2 + 532_375 + 4_334);
        assert_eq!(usage.output, 1760);
        // Leaving them out would report an afternoon of work as a few thousand.
        assert!(usage.input > 500_000);
    }

    #[test]
    fn usage_accumulates_across_a_chunk() {
        let scanned = scan(&[TOOL, PROSE, SIDE].join("\n"));
        assert_eq!(scanned.usage.output, 1760 + 20);
        assert_eq!(scanned.usage.input, 2 + 532_375 + 4_334 + 10);
    }

    #[test]
    fn a_branch_is_picked_up_when_one_is_recorded() {
        let line = r#"{"type":"assistant","gitBranch":"master","message":{"content":[{"type":"text"}]}}"#;
        assert_eq!(branch_of(line).as_deref(), Some("master"));
        assert_eq!(branch_of(PROSE), None);
    }

    #[test]
    fn reading_stops_at_the_last_whole_line() {
        use std::io::Write;
        let dir = std::env::temp_dir().join("codenotch-transcript-test");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("partial.jsonl");
        let mut file = std::fs::File::create(&path).unwrap();
        // Two whole records and the beginning of a third, which is exactly
        // what a poll lands on while Claude Code is mid-append.
        write!(file, "{PROMPT}\n{PROSE}\n{{\"type\":\"assi").unwrap();
        drop(file);

        let (offset, chunk) = read_from(&path, 0).unwrap();
        assert_eq!(chunk.lines().count(), 2);
        assert_eq!(scan(&chunk).turn, Some(Turn::Done));
        // The fragment is left for next time rather than parsed as truncated.
        assert_eq!(offset as usize, PROMPT.len() + PROSE.len() + 2);

        // Completing the line makes it readable, and nothing is read twice.
        let mut file = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
        writeln!(file, "stant\",\"message\":{{\"content\":[{{\"type\":\"tool_use\"}}]}}}}").unwrap();
        drop(file);
        let (_, more) = read_from(&path, offset).unwrap();
        assert_eq!(more.lines().count(), 1);
        assert_eq!(scan(&more).turn, Some(Turn::Working));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_file_that_shrank_was_replaced_and_is_not_re_read() {
        use std::io::Write;
        let dir = std::env::temp_dir().join("codenotch-transcript-test");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("shrunk.jsonl");
        let mut file = std::fs::File::create(&path).unwrap();
        writeln!(file, "{PROSE}").unwrap();
        drop(file);
        // Pretend we had read far past the end.
        let (offset, chunk) = read_from(&path, 10_000_000).unwrap();
        assert!(chunk.is_empty());
        assert!(offset <= 10_000_000);
        let _ = std::fs::remove_file(&path);
    }

    /// `cargo test --lib transcript -- --ignored --nocapture` — what this
    /// machine's own open sessions are actually doing.
    #[test]
    #[ignore]
    fn reads_the_real_sessions() {
        let home = dirs::home_dir().unwrap().join(".claude").join("projects");
        let mut seen = 0;
        for project in std::fs::read_dir(&home).unwrap().flatten() {
            for entry in std::fs::read_dir(project.path()).unwrap().flatten() {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                    continue;
                }
                let size = std::fs::metadata(&path).unwrap().len();
                let scan = opening_scan(&path);
                /* ⚠️ The phrase is checked against REAL transcripts, not only
                 * against hand-written fixtures. Every mistake in this parser
                 * comes back as an empty phrase, which is indistinguishable
                 * from a session that simply is not working — exactly the
                 * failure mode a unit test cannot see. */
                let said = scan.doing.as_ref().map(|d| d.say()).unwrap_or_default();
                println!(
                    "{:>7.1} MB  {:?}  {:<40}  {}",
                    size as f64 / 1_048_576.0,
                    scan.turn,
                    said,
                    path.file_name().unwrap().to_string_lossy()
                );
                assert!(said.len() < 60, "a phrase has to fit a row: {said}");
                assert!(!said.starts_with(' '), "{said:?}");
                if scan.turn == Some(Turn::Waiting) {
                    assert!(said.is_empty(), "a waiting session is doing nothing: {said}");
                }
                seen += 1;
            }
        }
        assert!(seen > 0, "no transcripts found");
    }
}
