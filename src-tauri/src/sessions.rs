//! "Is it still working?" — and the question that actually matters, "is it
//! waiting for *me*?"
//!
//! ⚠️ **The macOS route does not exist on Windows.** `ClaudeSessionMonitor`
//! reads a `status` / `tempo` pair out of `~/.claude/sessions/<pid>.json`;
//! Claude Code on Windows writes that file with an entirely different shape —
//! `pid`, `sessionId`, `cwd`, `startedAt`, `procStart`, `entrypoint`,
//! `messagingSocketPath` — and **no status field at all**. It registers that a
//! session exists, not what it is doing.
//!
//! So the state comes from the transcript. This file used to say that telling
//! *waiting* from *finished* needed Claude Code's hooks, because both stop
//! writing and a modification time cannot tell them apart. That was true of
//! the modification time and false of the file: the last conversational record
//! says which it is, and `transcript.rs` reads it. No hook to install and
//! nothing of the user's configuration to modify.
//!
//! Each session is tracked on its own — one collapsed answer is all the usage
//! notch's single arc can draw, but with three terminals open the useful fact
//! is *which* of them is waiting, and that is what the island's Agents screen
//! and `focus_session` are for.

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use windows::Win32::Foundation::{CloseHandle, FILETIME, HANDLE};
use windows::Win32::System::Threading::{
    GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
};

/// Fast enough that work starting is noticed while you are still looking at the
/// screen; cheap enough to run forever — it stats a handful of known paths.
const POLL: Duration = Duration::from_millis(900);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Activity {
    /// A tool call is pending, or the model is thinking.
    Working,
    /// The turn ended with prose. Nothing will happen until you type.
    ///
    /// ⚠️ The style for this has been in `style.css` since the first version
    /// (`.ring__activity.is-waiting`, an amber pulse) waiting for the day the
    /// state could actually be produced. It can now.
    Waiting,
    /// No live session, or one that has said nothing legible.
    Idle,
}

#[derive(Clone, Debug, Serialize)]
pub struct ProviderActivity {
    pub provider: String,
    pub state: Activity,
    /// How many live sessions are writing right now. `state` collapses them
    /// into one answer for the notch's activity arc, which has room for one;
    /// the island's pill can say "2 agents", which on a machine with three
    /// terminals open is the difference between the fact and a hint of it.
    pub running: u32,
}

/// A run that has just ended, emitted once on `notch:finished`.
///
/// ⚠️ Deliberately **not** a field on `ProviderActivity`. That struct is cached
/// in `Latest` and handed to whoever asks, so a one-shot fact living on it
/// would be replayed as news every time the WebView reloaded.
#[derive(Clone, Debug, Serialize)]
pub struct Finished {
    /// Whether the run ended *waiting for you* or simply went quiet. Almost
    /// always the former, and it is what the notification says.
    pub waiting: bool,
    pub provider: String,
    /// Which model ran it, so a day's spend can be broken down by one.
    pub model: Option<String>,
    /// The working directory's last component — "akcesfonia", not a path. With
    /// two or three sessions open, which one finished is the whole message.
    pub project: String,
    pub seconds: u64,
    /// What THIS run cost.
    ///
    /// ⚠️ A delta, not the session's running total. `Tracked.usage` climbs for
    /// the life of the session, so filing that against one run would count
    /// every earlier run again — and the day's total would grow quadratically
    /// while looking entirely plausible.
    pub input: u64,
    pub output: u64,
}

fn claude_home() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".claude"))
}

/// Windows' epoch is 1601 and the unit is 100ns ticks.
fn filetime_ticks(ft: FILETIME) -> u64 {
    ((ft.dwHighDateTime as u64) << 32) | ft.dwLowDateTime as u64
}

/// The creation time of the process with this pid, in raw FILETIME ticks.
fn process_start_ticks(pid: u32) -> Option<u64> {
    unsafe {
        let handle: HANDLE = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut creation = FILETIME::default();
        let (mut exit, mut kernel, mut user) = Default::default();
        let ok = GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user).is_ok();
        let _ = CloseHandle(handle);
        ok.then(|| filetime_ticks(creation))
    }
}

/// Is that pid still running, and is it still the *same* process?
///
/// A session that crashes leaves its file behind, and pids are recycled — a
/// recycled one would resurrect a dead session under a live process's number.
/// The file records `procStart`, the process's own creation FILETIME, so the
/// comparison is exact rather than a tolerance around a registration time.
fn is_alive(pid: u32, proc_start: Option<u64>) -> bool {
    let Some(actual) = process_start_ticks(pid) else {
        return false;
    };
    match proc_start {
        Some(recorded) => actual == recorded,
        // Older sessions predate the field; trust the pid rather than hide a
        // session that is probably real.
        None => true,
    }
}

/// Where Claude Code is appending this session's transcript.
///
/// The project directory is the working directory with its separators mangled,
/// and the exact encoding is Claude Code's business — so the sub-directories
/// are searched for the session's own file rather than the name reconstructed.
fn transcript_for(session_id: &str) -> Option<PathBuf> {
    let projects = claude_home()?.join("projects");
    let name = format!("{session_id}.jsonl");
    for entry in std::fs::read_dir(projects).ok()?.flatten() {
        let candidate = entry.path().join(&name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

/// Which agent a session belongs to.
///
/// ⚠️ This is a *reader* choice, not a label. The two write nothing alike —
/// see `codex.rs` — so everything from finding the file to deciding whether a
/// turn ended forks here, and the provider string the island draws is
/// downstream of the fork rather than beside it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Claude,
    Codex,
}

impl Kind {
    fn provider(self) -> &'static str {
        match self {
            Kind::Claude => "claude",
            Kind::Codex => "codex",
        }
    }

    /// What to call a session whose working directory nothing recorded.
    fn unnamed(self) -> &'static str {
        match self {
            Kind::Claude => "Claude Code",
            Kind::Codex => "Codex",
        }
    }
}

/// A session found on disk, whoever wrote it.
struct Found {
    session_id: String,
    kind: Kind,
    /// The file to tail. Resolved at discovery, because the two agents keep
    /// theirs in completely different places.
    transcript: PathBuf,
    /// Where the session was started, so a finish can name it.
    cwd: Option<String>,
    /// ⚠️ `None` for Codex, which runs every thread inside ONE process — so
    /// there is no window of its own to raise and `focus_session` falls back
    /// to finding one by name. See `focus_session`.
    pid: Option<u32>,
}

fn claude_sessions() -> Vec<Found> {
    let Some(dir) = claude_home().map(|home| home.join("sessions")) else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };

    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
            continue;
        };
        let (Some(pid), Some(session_id)) = (
            value.get("pid").and_then(|v| v.as_u64()).map(|p| p as u32),
            value.get("sessionId").and_then(|v| v.as_str()),
        ) else {
            continue;
        };
        // Written as a string because it does not fit a JS number exactly.
        let proc_start = value
            .get("procStart")
            .and_then(|v| v.as_str())
            .and_then(|s| s.parse::<u64>().ok());
        let cwd = value
            .get("cwd")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        if !is_alive(pid, proc_start) {
            continue;
        }
        let Some(transcript) = transcript_for(session_id) else {
            continue;
        };
        out.push(Found {
            session_id: session_id.to_string(),
            kind: Kind::Claude,
            transcript,
            pid: Some(pid),
            cwd,
        });
    }
    out
}

/// Both agents, in one list.
///
/// ⚠️ Claude first, and then sorted by state later — not because Claude
/// matters more, but because the order here is only a tie-break and the one
/// that decides what you see is `views.sort_by_key` at the end of `tick`.
fn live_sessions() -> Vec<Found> {
    let mut out = claude_sessions();
    for live in crate::codex::live_sessions() {
        let meta = crate::codex::meta_of(&live.rollout);
        out.push(Found {
            session_id: live.session_id,
            kind: Kind::Codex,
            transcript: live.rollout,
            cwd: meta.cwd,
            pid: None,
        });
    }
    out
}

/// The last component of a working directory: "akcesfonia" out of
/// `C:\Users\matko\CODE\akcesfonia`. Separators are handled both ways because
/// the field is written by whatever shell launched the session.
pub fn project_of(cwd: &str) -> String {
    cwd.trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(cwd)
        .to_string()
}

/// A duration a person would say out loud. Seconds alone under a minute,
/// because "0m 8s" is worse than "8s".
pub fn spoken(seconds: u64) -> String {
    if seconds < 60 {
        format!("{seconds}s")
    } else {
        format!("{}m {:02}s", seconds / 60, seconds % 60)
    }
}

/// One session, as the island draws it.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionView {
    pub id: String,
    /// Which agent this is — `claude` or `codex`.
    ///
    /// ⚠️ It was carried while it was still constant, for exactly this day:
    /// the island draws the agent's own mark, and the alternative to the field
    /// was the WEB layer assuming what the watcher happens to read. That
    /// assumption would now be a wrong logo on half the rows.
    pub provider: String,
    /// Which model is answering, as the provider names it — `claude-opus-5`,
    /// `gpt-6-astra`. `None` until a record says.
    pub model: Option<String>,
    /// The working directory's last component — "akcesfonia", not a path.
    pub project: String,
    /// Whatever branch the transcript last recorded, where it recorded one.
    pub branch: Option<String>,
    /// What `focus_session` needs. Not a window handle: see `win::raise_process`.
    pub pid: u32,
    pub state: Activity,
    /// Seconds in this state, so "waiting 40s" reads differently from
    /// "waiting since lunch".
    pub for_secs: u64,
    /// ⚠️ **Since Codenotch started watching**, not for the session's life. A
    /// historical scan of every open transcript at launch would read hundreds
    /// of megabytes to learn something the tail already says; the UI says
    /// "seen" rather than "total" for the same reason.
    pub input: u64,
    pub output: u64,
    /// How long the last completed run took, 0 if none has been seen.
    pub last_run_secs: u64,
    /// The session's working directory, which is what a workspace is made of.
    /// `None` where the session file did not record one.
    pub folder: Option<String>,
    /// What it is doing right now, in words — `editing palette.ts`.
    ///
    /// ⚠️ `None` whenever the session is not working. A phrase left behind by
    /// a finished run is a status that WAS true, which is worse than none.
    pub doing: Option<String>,
    /// The last few tool calls, oldest first, with whether each has come back.
    ///
    /// ⚠️ What an agent is DOING is a list, not a sentence. One phrase says
    /// "running cargo test" and says nothing about the four things before it
    /// — which is most of what somebody glancing at the screen wants to know,
    /// because it is the difference between stuck and working through.
    pub steps: Vec<crate::transcript::Step>,
    /// The last thing it said, in prose.
    ///
    /// ⚠️ NOT cleared when the turn ends, unlike `doing`. A status that has
    /// stopped being true is a lie; a sentence that has stopped being written
    /// is just the last thing that was said, and it is the line worth reading
    /// when a session has gone quiet.
    pub say: Option<String>,
    /// What it is reasoning about, where the agent reports that at all.
    pub thinking: Option<String>,
    /// How much of the plan is gone, where the agent says. Codex only today.
    pub limits: Option<crate::transcript::Limits>,
}

struct Tracked {
    kind: Kind,
    transcript: PathBuf,
    /// How far into the transcript this watcher has read.
    offset: u64,
    turn: crate::transcript::Turn,
    state: Activity,
    /// When the current state began, for `for_secs`.
    since: Instant,
    /// When the current run of work began. `None` between runs.
    started: Option<Instant>,
    last_run: Duration,
    usage: crate::transcript::Usage,
    /// `usage` as it stood when the current run began, so a run's own cost is
    /// the difference. See `Finished::input`.
    usage_at_start: crate::transcript::Usage,
    doing: Option<crate::transcript::Doing>,
    /// The last few tool calls, oldest first. ⚠️ Held ACROSS scans: a call
    /// and the result that finishes it are minutes apart, and the poll reads a
    /// few hundred bytes at a time, so a list rebuilt per chunk would be a
    /// list of things that were started.
    steps: Vec<crate::transcript::Step>,
    say: Option<String>,
    thinking: Option<String>,
    model: Option<String>,
    limits: Option<crate::transcript::Limits>,
    /// Whether a question is outstanding. ⚠️ Held here rather than in the
    /// reader because Codex's question tool returns immediately and the turn
    /// it belongs to can end several polls later — see `codex::scan`.
    asked: bool,
    project: String,
    branch: Option<String>,
    folder: Option<String>,
    pid: u32,
}

fn state_of(turn: crate::transcript::Turn) -> Activity {
    match turn {
        crate::transcript::Turn::Working => Activity::Working,
        crate::transcript::Turn::Waiting => Activity::Waiting,
        // ⚠️ Done is IDLE, not waiting. The work came back and nothing is
        // expected of you — only `Waiting` claims the pill and pulses.
        crate::transcript::Turn::Done => Activity::Idle,
        crate::transcript::Turn::Unknown => Activity::Idle,
    }
}

#[derive(Default)]
pub struct Watcher {
    /// sessionId -> what is known about it, so the projects directory is walked
    /// once per session rather than once per tick.
    tracked: HashMap<String, Tracked>,
}

impl Watcher {
    /// One round: every live session, plus any run that ended on this tick.
    fn tick(&mut self) -> (Vec<SessionView>, Vec<Finished>) {
        let sessions = live_sessions();
        self.tracked
            .retain(|id, _| sessions.iter().any(|s| &s.session_id == id));

        let mut finished = Vec::new();
        let mut views = Vec::new();

        for session in &sessions {
            if !self.tracked.contains_key(&session.session_id) {
                let path = session.transcript.clone();
                let opening = match session.kind {
                    Kind::Claude => crate::transcript::opening_scan(&path),
                    Kind::Codex => crate::codex::opening_scan(&path),
                };
                let turn = opening.turn.unwrap_or(crate::transcript::Turn::Unknown);
                self.tracked.insert(
                    session.session_id.clone(),
                    Tracked {
                        kind: session.kind,
                        offset: crate::transcript::opening_offset(&path),
                        transcript: path,
                        turn,
                        // Whatever the opening tail already showed it doing.
                        doing: opening.doing.clone(),
                        /* ⚠️ And whatever it had already done, with the results
                         * that had already landed applied — a session first
                         * seen mid-run otherwise shows every step as still in
                         * flight, which reads as an agent that has stalled. */
                        steps: {
                            let mut steps = opening.steps.clone();
                            for id in &opening.finished {
                                if let Some(step) = steps.iter_mut().find(|one| &one.id == id) {
                                    step.done = true;
                                }
                            }
                            let over = steps.len().saturating_sub(8);
                            steps.drain(..over);
                            steps
                        },
                        usage_at_start: crate::transcript::Usage::default(),
                        state: state_of(turn),
                        since: Instant::now(),
                        // A session already working when it is first seen has
                        // no start to measure from; the next run gets one.
                        started: None,
                        last_run: Duration::ZERO,
                        /* ⚠️ A total where the agent reports one. Claude's
                         * figure is what this app has watched it spend; Codex
                         * states the session's own running total, so a session
                         * picked up mid-afternoon arrives with its real cost
                         * rather than with zero. */
                        usage: opening.total.unwrap_or_default(),
                        say: opening.say,
                        thinking: opening.thinking,
                        model: opening.model,
                        limits: opening.limits,
                        asked: opening.asked,
                        project: session
                            .cwd
                            .as_deref()
                            .map(project_of)
                            .unwrap_or_else(|| session.kind.unnamed().to_string()),
                        branch: opening.branch,
                        folder: session.cwd.clone(),
                        pid: session.pid.unwrap_or(0),
                    },
                );
            }
            let Some(entry) = self.tracked.get_mut(&session.session_id) else {
                continue;
            };
            entry.pid = session.pid.unwrap_or(0);

            // Only the bytes appended since last time. The transcripts on this
            // machine reach 49 MB; re-reading one every 900ms is not an option.
            if let Some((offset, chunk)) =
                crate::transcript::read_from(&entry.transcript, entry.offset)
            {
                entry.offset = offset;
                if !chunk.is_empty() {
                    let scanned = match entry.kind {
                        Kind::Claude => crate::transcript::scan(&chunk),
                        Kind::Codex => crate::codex::scan(&chunk, entry.asked),
                    };
                    entry.asked = scanned.asked;
                    if let Some(turn) = scanned.turn {
                        entry.turn = turn;
                    }
                    /* ⚠️ Set, or added, but never both. See `Scan::total`: one
                     * agent reports what an answer cost and the other reports
                     * what the session has cost, and adding up the second kind
                     * counts the whole session again every few seconds. */
                    match scanned.total {
                        Some(total) => entry.usage = total,
                        None => entry.usage.add(scanned.usage),
                    }
                    if scanned.model.is_some() {
                        entry.model = scanned.model;
                    }
                    if scanned.limits.is_some() {
                        entry.limits = scanned.limits;
                    }
                    /* ⚠️ Kept when the chunk says nothing, unlike `doing`. The
                     * sentence an agent ended on is still true an hour later;
                     * "editing palette.ts" is not. */
                    if scanned.say.is_some() {
                        entry.say = scanned.say;
                    }
                    /* ⚠️ Replaced only when the chunk had something to say
                     * about it — a new thought, a tool going out, or the turn
                     * ending. Blanked on every quiet poll instead, a session
                     * that thinks for two minutes flickers between the thought
                     * and nothing at 900ms, which is the same bug `doing` has
                     * the guard below for. */
                    if scanned.thinking.is_some()
                        || scanned.doing.is_some()
                        || matches!(scanned.turn, Some(crate::transcript::Turn::Waiting)
                            | Some(crate::transcript::Turn::Done))
                    {
                        entry.thinking = scanned.thinking;
                    }
                    if scanned.branch.is_some() {
                        entry.branch = scanned.branch;
                    }
                    /* ⚠️ Only replaced when the chunk said something. A poll
                     * that read nothing conversational must leave the phrase
                     * alone — the tool call is still in flight, and blanking it
                     * would make a long `cargo build` flicker between "running
                     * cargo build" and nothing every second. */
                    if scanned.doing.is_some()
                        || matches!(scanned.turn, Some(crate::transcript::Turn::Waiting)
                            | Some(crate::transcript::Turn::Done))
                    {
                        entry.doing = scanned.doing;
                    }
                    /* The list of steps, patched rather than replaced. ⚠️ The
                     * results are applied FIRST: a chunk routinely carries a
                     * call and its own result, and applying them the other way
                     * round marks the new call done the moment it arrives. */
                    for id in &scanned.finished {
                        if let Some(step) = entry.steps.iter_mut().find(|one| &one.id == id) {
                            step.done = true;
                        }
                    }
                    if scanned.cleared {
                        entry.steps.clear();
                    }
                    entry.steps.extend(scanned.steps);
                    /* ⚠️ Capped from the FRONT. A run can make hundreds of
                     * calls; the screen has room for about five, and the ones
                     * worth keeping are the newest. */
                    let over = entry.steps.len().saturating_sub(8);
                    if over > 0 {
                        entry.steps.drain(..over);
                    }
                }
            }

            let next = state_of(entry.turn);
            if next != entry.state {
                // Working -> anything else is a run ending. ⚠️ A session whose
                // process is gone was dropped above and never reaches here:
                // closing a terminal mid-run is not an achievement to be
                // congratulated for, and a toast for it would fire every time
                // a window was shut.
                if entry.state == Activity::Working {
                    let ran = entry
                        .started
                        .map(|start| start.elapsed())
                        .unwrap_or_else(|| entry.since.elapsed());
                    entry.last_run = ran;
                    entry.started = None;
                    finished.push(Finished {
                        provider: entry.kind.provider().to_string(),
                        model: entry.model.clone(),
                        project: entry.project.clone(),
                        input: entry.usage.input.saturating_sub(entry.usage_at_start.input),
                        output: entry.usage.output.saturating_sub(entry.usage_at_start.output),
                        seconds: ran.as_secs().max(1),
                        waiting: next == Activity::Waiting,
                    });
                } else if next == Activity::Working {
                    entry.started = Some(Instant::now());
                    /* ⚠️ The mark against which this run's cost is measured.
                     * Taken when the run STARTS rather than subtracting the
                     * previous run's total afterwards — a session can be
                     * dropped and re-tracked between runs, which resets the
                     * counter, and a subtraction against a stale total would
                     * file a negative cost as a very large one. */
                    entry.usage_at_start = entry.usage;
                }
                entry.state = next;
                entry.since = Instant::now();
            }

            views.push(SessionView {
                id: session.session_id.clone(),
                provider: entry.kind.provider().to_string(),
                model: entry.model.clone(),
                project: entry.project.clone(),
                branch: entry.branch.clone(),
                pid: entry.pid,
                state: entry.state,
                for_secs: entry.since.elapsed().as_secs(),
                input: entry.usage.input,
                output: entry.usage.output,
                last_run_secs: entry.last_run.as_secs(),
                /* ⚠️ Gated on the state, not just on the phrase. The transcript
                 * goes quiet the moment a tool call is answered, so the last
                 * one seen outlives the run that made it. */
                folder: entry.folder.clone(),
                doing: (entry.state == Activity::Working)
                    .then(|| entry.doing.as_ref().map(|d| d.say()))
                    .flatten(),
                steps: entry.steps.clone(),
                say: entry.say.clone(),
                // Thinking is a live state: gated on the run, exactly as the
                // phrase above is.
                thinking: (entry.state == Activity::Working)
                    .then(|| entry.thinking.clone())
                    .flatten(),
                limits: entry.limits.clone(),
            });
        }

        // Whoever wants you most, first.
        views.sort_by_key(|view| match view.state {
            Activity::Waiting => 0,
            Activity::Working => 1,
            Activity::Idle => 2,
        });
        (views, finished)
    }
}

/// The one answer the usage notch's single arc can draw.
///
/// ⚠️ Waiting outranks working. With one session thinking and another blocked
/// on you, the one that needs you is the news — the other will carry on by
/// itself.
fn overall(views: &[&SessionView]) -> Activity {
    if views.iter().any(|v| v.state == Activity::Waiting) {
        Activity::Waiting
    } else if views.iter().any(|v| v.state == Activity::Working) {
        Activity::Working
    } else {
        Activity::Idle
    }
}

/// The agent's name as a person says it.
pub fn named(provider: &str) -> &str {
    match provider {
        "codex" => "Codex",
        _ => "Claude Code",
    }
}

/// Everything about a session that is actually DRAWN, for deciding whether to
/// wake the WebViews.
///
/// ⚠️ `for_secs` is deliberately absent — it climbs every tick, and comparing
/// the views wholesale emitted an event 65 times a minute for ever. Everything
/// else that appears on a card has to be here, though: the steps and the
/// sentence change while the token figures stand still, so a digest of the
/// numbers alone would leave a working card frozen on what it was doing a
/// minute ago.
fn shown(views: &[SessionView]) -> Vec<String> {
    views
        .iter()
        .map(|view| {
            let steps: String = view
                .steps
                .iter()
                .map(|step| format!("{}{}", step.id, step.done as u8))
                .collect();
            format!(
                "{}|{:?}|{}|{}|{:?}|{:?}|{:?}|{:?}|{:?}|{steps}",
                view.id,
                view.state,
                view.input,
                view.output,
                view.branch,
                view.model,
                view.doing,
                view.thinking,
                view.say,
            )
        })
        .collect()
}

#[derive(Default)]
pub struct Latest(pub std::sync::Mutex<Vec<ProviderActivity>>);

#[derive(Default)]
pub struct Sessions(pub std::sync::Mutex<Vec<SessionView>>);

#[tauri::command]
pub fn get_activity(state: tauri::State<Latest>) -> Vec<ProviderActivity> {
    state.0.lock().map(|held| held.clone()).unwrap_or_default()
}

#[tauri::command]
pub fn get_sessions(state: tauri::State<Sessions>) -> Vec<SessionView> {
    state.0.lock().map(|held| held.clone()).unwrap_or_default()
}

/// Bring the window a session is living in to the front.
///
/// Returns false when there is nothing to raise, which is a real outcome
/// rather than an error: a session started from a detached process, or one
/// whose terminal has since been closed, owns no window.
///
/// ⚠️ **A pid is not always the answer, and for Codex it never is.** Every
/// Codex thread runs inside one `codex.exe` that owns no window of its own —
/// the session is a panel in whatever editor opened it. So the fallback is the
/// window TITLE: an editor puts the folder in it, which is the same string the
/// row is labelled with. It is a guess, and it is the only one available.
#[tauri::command]
pub fn focus_session(pid: u32, hint: Option<String>) -> bool {
    if pid != 0 && crate::win::raise_process(pid) {
        return true;
    }
    let Some(hint) = hint.filter(|hint| hint.len() >= 3) else {
        return false;
    };
    let wanted = hint.to_lowercase();
    for (window, _) in crate::win::visible_windows() {
        let title = crate::win::title_of(window).to_lowercase();
        /* ⚠️ The title has to CONTAIN the folder, not equal it: editors write
         * "file.ts - akcesfonia - Visual Studio Code". And the app's own
         * windows are skipped by the length test above rather than by name —
         * they are never titled after one of your projects. */
        if title.contains(&wanted) && crate::win::force_foreground(window) {
            return true;
        }
    }
    false
}

pub fn spawn(app: AppHandle) {
    crate::notify::register();
    crate::guard::spawn("agent watcher", move || {
        let mut watcher = Watcher::default();
        let mut last: Vec<(String, Activity, u32)> = Vec::new();
        let mut last_views: Vec<SessionView> = Vec::new();

        loop {
            let (views, finished) = watcher.tick();
            for run in &finished {
                crate::log::note(&format!(
                    "run finished: {} in {}s, waiting={}",
                    run.project, run.seconds, run.waiting
                ));
                // ⚠️ Read per run, not once at spawn: this thread outlives every
                // trip through the settings window.
                if crate::prefs::current(&app).notify_runs {
                    crate::notify::toast(
                        &format!(
                            "{} {}",
                            run.project,
                            if run.waiting { "needs you" } else { "stopped" }
                        ),
                        &format!("{} ran for {}.", named(&run.provider), spoken(run.seconds)),
                    );
                }
                // The notch keeps its own indicator up until it is looked at.
                // A toast is gone in five seconds, and the whole point of this
                // is the run you were not watching.
                // Kept, so the Review screen can look backwards at all.
                crate::runlog::record(&app, run);
                let _ = app.emit("notch:finished", run.clone());
            }

            /* One answer PER AGENT. The notch keys its map on the provider, so
             * two agents working at once are two arcs rather than one that
             * cannot say whose. ⚠️ An agent with no session at all contributes
             * no entry — an idle row for something that is not installed is a
             * fact about this app rather than about the machine. */
            let payload: Vec<ProviderActivity> = [Kind::Claude, Kind::Codex]
                .into_iter()
                .filter_map(|kind| {
                    let mine: Vec<&SessionView> = views
                        .iter()
                        .filter(|view| view.provider == kind.provider())
                        .collect();
                    (!mine.is_empty()).then(|| ProviderActivity {
                        provider: kind.provider().to_string(),
                        state: overall(&mine),
                        running: mine
                            .iter()
                            .filter(|view| view.state == Activity::Working)
                            .count() as u32,
                    })
                })
                .collect();

            if let Ok(mut held) = app.state::<Sessions>().0.lock() {
                *held = views.clone();
            }
            /* ⚠️ Compared on what is *drawn*, not on the whole view. `for_secs`
             * climbs every tick, so comparing the views wholesale would emit an
             * event 65 times a minute for ever and wake both WebViews for
             * nothing. The elapsed figures are recomputed in the web layer from
             * the state it already has. */
            let drawn = shown(&views);
            let previous = shown(&last_views);
            if drawn != previous {
                last_views = views.clone();
                let _ = app.emit("notch:sessions", views);
            }

            // Only on change: this runs every 900ms forever, and an event per
            // tick would wake the WebView for nothing.
            let now: Vec<_> = payload
                .iter()
                .map(|one| (one.provider.clone(), one.state, one.running))
                .collect();
            if last != now {
                last = now;
                if cfg!(debug_assertions) {
                    println!("[notch] agents: {payload:?}");
                }
                if let Ok(mut held) = app.state::<Latest>().0.lock() {
                    *held = payload.clone();
                }
                let _ = app.emit("notch:activity", payload);
            }
            std::thread::sleep(POLL);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_the_project_whichever_way_the_shell_wrote_the_path() {
        assert_eq!(project_of(r"C:\Users\matko\CODE\akcesfonia"), "akcesfonia");
        assert_eq!(project_of("/c/Users/matko/CODE/codenotch-win"), "codenotch-win");
        // A trailing separator must not name the project the empty string,
        // which would toast a title of just "finished".
        assert_eq!(project_of(r"C:\CODE\esono\"), "esono");
        assert_eq!(project_of("esono"), "esono");
    }

    #[test]
    fn says_durations_the_way_a_person_would() {
        assert_eq!(spoken(8), "8s");
        assert_eq!(spoken(59), "59s");
        assert_eq!(spoken(60), "1m 00s");
        assert_eq!(spoken(252), "4m 12s");
    }
}

#[cfg(test)]
mod live {
    /// `cargo test --lib sessions::live -- --ignored --nocapture` — what this
    /// machine's own open sessions look like through the watcher.
    #[test]
    #[ignore]
    fn reports_the_real_sessions() {
        let mut watcher = super::Watcher::default();
        let (views, _) = watcher.tick();
        for view in &views {
            println!(
                "{:<7} {:<9?} {:<18} pid {:<7} model {:<14} steps {} | {}",
                view.provider,
                view.state,
                view.project,
                view.pid,
                view.model.clone().unwrap_or_else(|| "-".into()),
                view.steps.len(),
                view.say.clone().unwrap_or_else(|| "-".into()).chars().take(40).collect::<String>(),
            );
        }
        println!("{} live session(s)", views.len());
    }

    /// Can we actually get to the terminal a session is in?
    /// `cargo test --lib sessions::live::raises -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn raises_the_terminal_a_session_is_in() {
        let mut watcher = super::Watcher::default();
        let (views, _) = watcher.tick();
        for view in &views {
            let raised = crate::win::raise_process(view.pid);
            println!("{} (pid {}) -> raised: {}", view.project, view.pid, raised);
        }
    }
}
