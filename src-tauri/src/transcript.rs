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

use std::path::Path;

/// What the transcript says is happening. Ordered by how much it wants you.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Turn {
    /// A tool call is pending, or a prompt just went in and the model is
    /// thinking. Either way nobody is waiting on you.
    Working,
    /// The assistant's turn ended with prose. Nothing more will be written to
    /// this file until you type something.
    Waiting,
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
            // A turn that ends in prose is a turn that ended. Anything else in
            // the block list means the model is mid-flight.
            let acting = content.iter().any(|block| {
                !matches!(
                    block.get("type").and_then(|v| v.as_str()),
                    Some("text") | Some("thinking") | Some("redacted_thinking")
                )
            });
            Some(if acting { Turn::Working } else { Turn::Waiting })
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
    use super::*;

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

    #[test]
    fn prose_is_waiting_and_a_tool_call_is_not() {
        assert_eq!(classify(TOOL), Some(Turn::Working));
        assert_eq!(classify(PROSE), Some(Turn::Waiting));
        // Thinking is not acting: a turn that thought and then answered has
        // still ended.
        assert_eq!(classify(THINKING), Some(Turn::Waiting));
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
        assert_eq!(scan(&chunk.join("\n")).turn, Some(Turn::Waiting));

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
        assert_eq!(scan(&chunk).turn, Some(Turn::Waiting));
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
                println!(
                    "{:>7.1} MB  {:?}  {}",
                    size as f64 / 1_048_576.0,
                    opening_scan(&path).turn,
                    path.file_name().unwrap().to_string_lossy()
                );
                seen += 1;
            }
        }
        assert!(seen > 0, "no transcripts found");
    }
}
