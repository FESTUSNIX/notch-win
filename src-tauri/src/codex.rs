//! The other agent on this machine.
//!
//! Codex keeps a far better record of itself than Claude Code does, and almost
//! none of it needs guessing:
//!
//! | | Claude Code | Codex |
//! |---|---|---|
//! | a turn starting | inferred from a `user` record | `task_started` |
//! | a turn ending | inferred from the shape of the last block | `task_complete` |
//! | tokens | per assistant record, summed | a running total, restated |
//! | the model | on every assistant record | `turn_context.model` |
//! | rate limits | nowhere | on every `token_count` |
//!
//! So this reader states what the Claude one has to deduce, and the two meet at
//! [`crate::transcript::Scan`] — one shape for the watcher, whichever agent
//! produced it.
//!
//! ⚠️ **Liveness is the lock file, not the process.** Codex runs as one
//! `codex.exe` hosting every thread, so there is no pid per session to check
//! the way `sessions.rs` checks Claude's — and a session living in VS Code has
//! no terminal of its own at all. What there is instead is
//! `~/.codex/thread-writer-locks/<id>.lock`, created with the session and
//! **deleted when it closes**: 33 rollouts on this machine, two locks.
//!
//! ⚠️ And the lock is read by its EXISTENCE, never by opening it. Whether a
//! lock is still held can be asked exactly — an exclusive open fails while
//! Codex holds it, which was measured — but the probe has to deny sharing for
//! the microseconds it holds the file, and a poll that runs every 900ms
//! forever would eventually land on the instant Codex opens that very file.
//! Being slightly wrong about a crashed session is cheaper than being the
//! reason a session failed to start.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use crate::transcript::{Doing, Limits, Scan, Step, Turn, Usage};

/// How long a lock may outlive its session's last write before it is debris.
///
/// ⚠️ This answers a crash, not ordinary use — a lock is removed on exit, so
/// the only ones left behind are from a session that died. Long enough that
/// one left open overnight is still there in the morning.
const STALE: Duration = Duration::from_secs(12 * 60 * 60);

pub fn home() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".codex"))
}

/// One live Codex thread.
pub struct Live {
    pub session_id: String,
    pub rollout: PathBuf,
}

/// Every session whose lock is still on disk and whose rollout is fresh.
///
/// ⚠️ A lock with no rollout is skipped rather than shown. Codex takes a lock
/// per *writer*, and a sub-thread takes one without ever opening a rollout of
/// its own — counted, it would put a row on the screen for something that is
/// not a session and can never be gone to.
pub fn live_sessions() -> Vec<Live> {
    let Some(dir) = home().map(|home| home.join("thread-writer-locks")) else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let ids: Vec<String> = entries
        .flatten()
        .filter(|entry| entry.path().extension().and_then(|e| e.to_str()) == Some("lock"))
        .filter_map(|entry| {
            entry
                .path()
                .file_stem()
                .and_then(|stem| stem.to_str())
                .map(str::to_string)
        })
        // `.coordination.lock`, and anything else that is not a thread id.
        .filter(|id| !id.starts_with('.') && id.len() >= 20)
        .collect();
    if ids.is_empty() {
        return Vec::new();
    }

    let rollouts = rollout_index();
    let mut out = Vec::new();
    for id in ids {
        let Some(rollout) = rollouts.iter().find(|path| names(path, &id)).cloned() else {
            continue;
        };
        if stale(&rollout) {
            continue;
        }
        out.push(Live { session_id: id, rollout });
    }
    out
}

fn names(path: &Path, id: &str) -> bool {
    path.file_stem()
        .and_then(|stem| stem.to_str())
        .is_some_and(|stem| stem.ends_with(id))
}

fn stale(rollout: &Path) -> bool {
    std::fs::metadata(rollout)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|when| SystemTime::now().duration_since(when).ok())
        .is_some_and(|age| age > STALE)
}

/// Every rollout file, newest day first.
///
/// ⚠️ Walked rather than reconstructed. The path is
/// `sessions/YYYY/MM/DD/rollout-<timestamp>-<id>.jsonl` — the id is in the
/// name, but the day is the day the session STARTED, which the lock file does
/// not know, so there is nothing to build a path out of.
fn rollout_index() -> Vec<PathBuf> {
    let Some(root) = home().map(|home| home.join("sessions")) else {
        return Vec::new();
    };
    // year / month / day, and no deeper.
    let mut walk = vec![root];
    for _ in 0..3 {
        let mut next = Vec::new();
        for dir in walk.drain(..) {
            let Ok(entries) = std::fs::read_dir(&dir) else { continue };
            for entry in entries.flatten() {
                if entry.path().is_dir() {
                    next.push(entry.path());
                }
            }
        }
        walk = next;
    }
    // Newest first, so a lookup usually hits in the first directory it opens.
    walk.sort();
    walk.reverse();

    let mut out = Vec::new();
    for day in walk {
        let Ok(entries) = std::fs::read_dir(day) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
                out.push(path);
            }
        }
    }
    out
}

/// What the head of a rollout says about the session it belongs to.
#[derive(Clone, Debug, Default)]
pub struct Meta {
    pub cwd: Option<String>,
    /// `codex_vscode`, `codex_cli`, … — which shell the session lives in, and
    /// therefore what "go to it" could even mean.
    pub originator: Option<String>,
}

/// Read the first records of a rollout for its `session_meta`.
///
/// ⚠️ From the FRONT, where every other read in this app is from the back. The
/// working directory is written once, at the top, and a session that has been
/// going all day has it a long way behind the tail.
///
/// ⚠️ And half a megabyte of front, not a few kilobytes. `session_meta`
/// carries `base_instructions` — the agent's entire system prompt, tens of
/// kilobytes of it — so a smaller read returns half of line one, which is not
/// JSON, parses as nothing, and leaves every Codex row labelled "Codex" with
/// no project name and nothing to raise.
pub fn meta_of(path: &Path) -> Meta {
    use std::io::Read;
    let Ok(mut file) = std::fs::File::open(path) else {
        return Meta::default();
    };
    let mut head = Vec::new();
    // ⚠️ `take` + `read_to_end`, not one `read`: a single read returns
    // whatever the filesystem felt like handing over, which for a large first
    // record is reliably less than the whole of it.
    if file.by_ref().take(512 * 1024).read_to_end(&mut head).is_err() {
        return Meta::default();
    }
    let text = String::from_utf8_lossy(&head);
    let mut out = Meta::default();
    for line in text.lines() {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if value.get("type").and_then(|v| v.as_str()) != Some("session_meta") {
            continue;
        }
        let Some(payload) = value.get("payload") else { continue };
        out.cwd = payload.get("cwd").and_then(|v| v.as_str()).map(str::to_string);
        out.originator = payload
            .get("originator")
            .and_then(|v| v.as_str())
            .map(str::to_string);
        break;
    }
    out
}

/// A quoted string out of a fragment of JavaScript.
///
/// ⚠️ String surgery, deliberately. The `exec` tool's input is a *program* —
/// `const r = await tools.shell_command({"command":"…"})` — so there is no
/// JSON here to parse, and a JS parser to recover one phrase for a 40-pixel
/// line would be the most expensive thing in this file by an order of
/// magnitude. What it can misread is a quote inside a command, which costs a
/// few characters of a label.
fn js_string(source: &str, key: &str) -> Option<String> {
    let at = source.find(key)? + key.len();
    let rest = &source[at..];
    let open = rest.find('"')?;
    let mut out = String::new();
    let mut escaped = false;
    for ch in rest[open + 1..].chars() {
        if escaped {
            match ch {
                'n' | 't' | 'r' => out.push(' '),
                other => out.push(other),
            }
            escaped = false;
            continue;
        }
        match ch {
            '\\' => escaped = true,
            '"' => break,
            other => out.push(other),
        }
        if out.len() > 200 {
            break;
        }
    }
    let out = out.trim().to_string();
    (!out.is_empty()).then_some(out)
}

/// The file a patch is about — `*** Update File: C:\…\palette.ts`.
fn patched(source: &str) -> Option<String> {
    for marker in ["*** Update File: ", "*** Add File: ", "*** Delete File: "] {
        let Some(at) = source.find(marker) else { continue };
        let rest = &source[at + marker.len()..];
        /* ⚠️ The line ends at a LITERAL backslash-n, two characters, because
         * the patch is a string inside a JavaScript program and its newlines
         * are still escaped. Cutting at the first backslash instead — the
         * obvious thing — cuts `C:\Users\…` after the drive letter. */
        let line = rest.split("\\n").next().unwrap_or(rest);
        let line = line.split(['"', '\n']).next().unwrap_or(line);
        let leaf = line
            .rsplit(['/', '\\'])
            .find(|part| !part.trim().is_empty())
            .unwrap_or_default()
            .trim();
        if !leaf.is_empty() {
            return Some(leaf.to_string());
        }
    }
    None
}

/// Turn one Codex tool call into the phrase the screen prints.
pub fn phrase(name: &str, input: &str) -> Doing {
    let say = |verb: &str, subject: String| Doing { verb: verb.into(), subject };
    match name {
        /* ⚠️ The question tool does NOT block. Codex asks and carries on
         * working, which is why `Waiting` is decided by a turn ending with a
         * question outstanding rather than by this call. */
        "request_user_input_async" => {
            let title = js_string(input, "\"title\":")
                .or_else(|| js_string(input, "title:"))
                .unwrap_or_default();
            say("asking you", crate::transcript::gist(&title))
        }
        "wait" | "sleep" => say("waiting for", "the last command".into()),
        _ => {
            if let Some(file) = patched(input) {
                return say("editing", file);
            }
            if input.contains("tools.web__run") || input.contains("web_search") {
                let query = js_string(input, "q:")
                    .or_else(|| js_string(input, "\"q\":"))
                    .or_else(|| js_string(input, "search_query"))
                    .unwrap_or_default();
                return say("looking up", crate::transcript::gist(&query));
            }
            if input.contains("tools.request_permissions") {
                return say("asking to allow", String::new());
            }
            if let Some(command) =
                js_string(input, "\"command\":").or_else(|| js_string(input, "command:"))
            {
                return say("running", crate::transcript::gist(&command));
            }
            match name {
                "js" | "exec" | "exec_command" => say("running", "a script".into()),
                other => say("using", other.replace('_', " ")),
            }
        }
    }
}

/// `**Designing the RSS sync**` -> `Designing the RSS sync`.
///
/// ⚠️ The summary is MARKDOWN and its first line is a bold heading. Two stars
/// at 10px read as a typo rather than as emphasis.
fn plain(text: &str) -> String {
    text.replace("**", "").replace('#', "").trim().to_string()
}

/// One pass over a chunk of rollout.
///
/// `asked` is whether a question was put to you earlier in this session and is
/// still outstanding — see [`Scan::asked`].
pub fn scan(chunk: &str, asked: bool) -> Scan {
    let mut out = Scan { asked, ..Scan::default() };
    for line in chunk.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let kind = value.get("type").and_then(|v| v.as_str()).unwrap_or_default();
        let Some(payload) = value.get("payload") else { continue };
        let sub = payload.get("type").and_then(|v| v.as_str()).unwrap_or_default();

        match (kind, sub) {
            ("turn_context", _) => {
                if let Some(model) = payload.get("model").and_then(|v| v.as_str()) {
                    out.model = Some(model.to_string());
                }
            }
            ("event_msg", "task_started") => {
                out.turn = Some(Turn::Working);
                /* A new turn, so whatever was asked in the last one has been
                 * answered — or abandoned, which comes to the same thing:
                 * nothing is blocked on you now. */
                out.asked = false;
                out.cleared = true;
            }
            ("event_msg", "task_complete") => {
                /* ⚠️ Waiting only where a question is outstanding. Codex ends a
                 * turn by handing work back, which wants nothing from you —
                 * reported as waiting it would pulse amber after every reply,
                 * which is the bug this app already had once with Claude and is
                 * written up in `transcript.rs`. */
                out.turn = Some(if out.asked { Turn::Waiting } else { Turn::Done });
                out.doing = None;
                out.thinking = None;
                if let Some(said) = payload.get("last_agent_message").and_then(|v| v.as_str()) {
                    out.say = Some(plain(said));
                }
            }
            ("event_msg", "turn_aborted") => {
                out.turn = Some(Turn::Done);
                out.doing = None;
                out.thinking = None;
            }
            ("event_msg", "token_count") => {
                /* ⚠️ A TOTAL, not a delta. Codex restates the session's running
                 * cost on every one of these, so adding them up would count the
                 * whole session again every few seconds. */
                if let Some(info) = payload.get("info").and_then(|info| info.get("total_token_usage"))
                {
                    let field = |name: &str| info.get(name).and_then(|v| v.as_u64()).unwrap_or(0);
                    /* `input_tokens` already contains the cached read: the
                     * fields only add up to `total_tokens` that way. Claude's
                     * reader has to add three fields for the same figure. */
                    out.total = Some(Usage {
                        input: field("input_tokens"),
                        output: field("output_tokens"),
                    });
                }
                if let Some(limits) = payload.get("rate_limits") {
                    let percent = |key: &str| {
                        limits
                            .get(key)
                            .and_then(|window| window.get("used_percent"))
                            .and_then(|v| v.as_f64())
                    };
                    out.limits = Some(Limits {
                        window: percent("primary"),
                        week: percent("secondary"),
                        plan: limits
                            .get("plan_type")
                            .and_then(|v| v.as_str())
                            .map(str::to_string),
                    });
                }
            }
            ("event_msg", "item_completed") => {
                let Some(item) = payload.get("item") else { continue };
                match item.get("type").and_then(|v| v.as_str()).unwrap_or_default() {
                    /* What it last handed back, for the bubble. ⚠️ Not a step:
                     * it is not a thing it DID, it is what it said about the
                     * things it did. */
                    "AgentMessage" => {
                        if let Some(text) = item
                            .get("content")
                            .and_then(|content| content.as_array())
                            .and_then(|blocks| blocks.first())
                            .and_then(|block| block.get("text"))
                            .and_then(|v| v.as_str())
                        {
                            out.say = Some(plain(text));
                        }
                    }
                    /* ⚠️ Thinking is a STATE, not a step. It is the one thing a
                     * long turn can show while no tool is out — without it a
                     * session that reasons for two minutes reads as one that
                     * has stopped. */
                    "Reasoning" => {
                        if let Some(text) = item
                            .get("summary_text")
                            .and_then(|summary| summary.as_array())
                            .and_then(|all| all.first())
                            .and_then(|v| v.as_str())
                        {
                            out.thinking = Some(plain(text));
                        }
                    }
                    _ => {}
                }
            }
            ("response_item", "function_call") | ("response_item", "custom_tool_call") => {
                let name = payload.get("name").and_then(|v| v.as_str()).unwrap_or("a tool");
                let input = payload
                    .get("input")
                    .or_else(|| payload.get("arguments"))
                    .and_then(|v| v.as_str())
                    .unwrap_or_default();
                let doing = phrase(name, input);
                if name == "request_user_input_async" {
                    out.asked = true;
                }
                if let Some(id) = payload.get("call_id").and_then(|v| v.as_str()) {
                    out.steps.push(Step { id: id.to_string(), say: doing.say(), done: false });
                }
                out.cleared = false;
                out.doing = Some(doing);
                // Something is out, so it is not merely thinking.
                out.thinking = None;
            }
            ("response_item", "function_call_output")
            | ("response_item", "custom_tool_call_output") => {
                if let Some(id) = payload.get("call_id").and_then(|v| v.as_str()) {
                    out.finished.push(id.to_string());
                }
            }
            _ => {}
        }
    }
    out
}

/// The tail of a rollout, the way `sessions.rs` opens Claude's.
///
/// ⚠️ `opening_offset` is the END of the file — it is where the watcher starts
/// *following* from, not where it starts reading. Handing it to `read_from`
/// here reads nothing at all, which is not an error and shows up only as a
/// session that knows nothing about itself until it next writes.
pub fn opening_scan(path: &Path) -> Scan {
    let from = crate::transcript::opening_offset(path)
        .saturating_sub(crate::transcript::TAIL_BYTES);
    match crate::transcript::read_from(path, from) {
        Some((_, chunk)) => scan(&chunk, false),
        None => Scan::default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Real records, trimmed. Every field read below is one this machine's own
    /// rollouts actually carry.
    const TURN: &str = r#"{"type":"event_msg","payload":{"type":"task_started","turn_id":"t1"}}
{"type":"turn_context","payload":{"turn_id":"t1","model":"gpt-6-astra","effort":"high"}}
{"type":"response_item","payload":{"type":"custom_tool_call","call_id":"call_a","name":"exec","input":"const r = await tools.shell_command({\"command\":\"cargo test --lib\"});"}}
{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":21826,"cached_input_tokens":12416,"output_tokens":14,"total_tokens":21840}},"rate_limits":{"primary":{"used_percent":4.0},"secondary":{"used_percent":10.0},"plan_type":"plus"}}}
"#;

    #[test]
    fn reads_the_model_the_work_and_the_running_total() {
        let out = scan(TURN, false);
        assert_eq!(out.turn, Some(Turn::Working));
        assert_eq!(out.model.as_deref(), Some("gpt-6-astra"));
        assert_eq!(out.doing.map(|d| d.say()).as_deref(), Some("running cargo test --lib"));
        assert_eq!(out.steps.len(), 1);
        assert_eq!(out.steps[0].id, "call_a");
        assert!(!out.steps[0].done);
        // ⚠️ A total, not a sum of deltas.
        assert_eq!(out.total, Some(Usage { input: 21826, output: 14 }));
        let limits = out.limits.expect("rate limits");
        assert_eq!(limits.week, Some(10.0));
        assert_eq!(limits.plan.as_deref(), Some("plus"));
    }

    #[test]
    fn the_output_finishes_the_call_that_asked_for_it() {
        let out = scan(
            r#"{"type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"call_a","output":"ok"}}"#,
            false,
        );
        assert_eq!(out.finished, vec!["call_a".to_string()]);
    }

    /// ⚠️ The bug this state machine exists to avoid: a turn that simply ENDED
    /// wants nothing from you.
    #[test]
    fn a_turn_that_ends_is_done_unless_a_question_is_outstanding() {
        let ended = r#"{"type":"event_msg","payload":{"type":"task_complete","turn_id":"t1","last_agent_message":"**Done.** I fixed it."}}"#;
        let quiet = scan(ended, false);
        assert_eq!(quiet.turn, Some(Turn::Done));
        // And the message it handed back, with the markdown taken off.
        assert_eq!(quiet.say.as_deref(), Some("Done. I fixed it."));

        let asked = scan(ended, true);
        assert_eq!(asked.turn, Some(Turn::Waiting));
    }

    /// The question tool is asynchronous, so the flag has to outlive its own
    /// call — and a new turn starting is what answers it.
    #[test]
    fn a_question_outlives_its_own_call_and_dies_with_the_next_turn() {
        let asked = scan(
            r#"{"type":"response_item","payload":{"type":"function_call","call_id":"c1","name":"request_user_input_async","arguments":"{\"questions\":[{\"title\":\"Which folder?\"}]}"}}"#,
            false,
        );
        assert!(asked.asked);
        assert_eq!(asked.doing.map(|d| d.say()).as_deref(), Some("asking you Which folder?"));

        let next = scan(r#"{"type":"event_msg","payload":{"type":"task_started"}}"#, true);
        assert!(!next.asked);
    }

    #[test]
    fn thinking_is_a_state_and_a_tool_call_ends_it() {
        let thinking = scan(
            r#"{"type":"event_msg","payload":{"type":"item_completed","item":{"type":"Reasoning","summary_text":["**Designing RSS sync architecture**"]}}}"#,
            false,
        );
        assert_eq!(thinking.thinking.as_deref(), Some("Designing RSS sync architecture"));

        let acting = scan(
            r#"{"type":"event_msg","payload":{"type":"item_completed","item":{"type":"Reasoning","summary_text":["**Thinking**"]}}}
{"type":"response_item","payload":{"type":"custom_tool_call","call_id":"c","name":"exec","input":"text(1)"}}"#,
            false,
        );
        assert_eq!(acting.thinking, None);
    }

    #[test]
    fn phrases_a_patch_by_the_file_it_changes() {
        let patch = "const patch = \"*** Begin Patch\\n*** Update File: C:\\\\Users\\\\matko\\\\CODE\\\\src\\\\palette.ts\\n\";";
        assert_eq!(phrase("exec", patch).say(), "editing palette.ts");
    }

    #[test]
    fn falls_back_to_the_tools_own_name_rather_than_to_nothing() {
        /* ⚠️ The set grows. A call this file has no branch for must still put a
         * line on the screen, or a session using it looks like one that has
         * stopped — the same rule as `transcript::phrase`. */
        assert_eq!(phrase("browser_open", "{}").say(), "using browser open");
    }
}

#[cfg(test)]
mod live {
    /// `cargo test --lib codex::live -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn reports_the_real_codex_sessions() {
        for live in super::live_sessions() {
            let meta = super::meta_of(&live.rollout);
            let scan = super::opening_scan(&live.rollout);
            println!(
                "{} | {:?} | {:?} | model {:?} | {:?} | steps {} | say {:?}",
                &live.session_id[..8],
                meta.cwd,
                meta.originator,
                scan.model,
                scan.turn,
                scan.steps.len(),
                scan.say.as_deref().map(|said| &said[..said.len().min(48)]),
            );
        }
    }
}
