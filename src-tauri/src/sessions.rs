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
    /// The working directory's last component — "akcesfonia", not a path. With
    /// two or three sessions open, which one finished is the whole message.
    pub project: String,
    pub seconds: u64,
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

struct Session {
    session_id: String,
    pid: u32,
    /// Where the session was started, so a finish can name it.
    cwd: Option<String>,
}

fn live_sessions() -> Vec<Session> {
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
        out.push(Session {
            session_id: session_id.to_string(),
            pid,
            cwd,
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
}

struct Tracked {
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
    project: String,
    branch: Option<String>,
    pid: u32,
}

fn state_of(turn: crate::transcript::Turn) -> Activity {
    match turn {
        crate::transcript::Turn::Working => Activity::Working,
        crate::transcript::Turn::Waiting => Activity::Waiting,
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
                let Some(path) = transcript_for(&session.session_id) else {
                    continue;
                };
                let opening = crate::transcript::opening_scan(&path);
                let turn = opening.turn.unwrap_or(crate::transcript::Turn::Unknown);
                self.tracked.insert(
                    session.session_id.clone(),
                    Tracked {
                        offset: crate::transcript::opening_offset(&path),
                        transcript: path,
                        turn,
                        state: state_of(turn),
                        since: Instant::now(),
                        // A session already working when it is first seen has
                        // no start to measure from; the next run gets one.
                        started: None,
                        last_run: Duration::ZERO,
                        usage: Default::default(),
                        project: session
                            .cwd
                            .as_deref()
                            .map(project_of)
                            .unwrap_or_else(|| "Claude Code".to_string()),
                        branch: opening.branch,
                        pid: session.pid,
                    },
                );
            }
            let Some(entry) = self.tracked.get_mut(&session.session_id) else {
                continue;
            };
            entry.pid = session.pid;

            // Only the bytes appended since last time. The transcripts on this
            // machine reach 49 MB; re-reading one every 900ms is not an option.
            if let Some((offset, chunk)) =
                crate::transcript::read_from(&entry.transcript, entry.offset)
            {
                entry.offset = offset;
                if !chunk.is_empty() {
                    let scanned = crate::transcript::scan(&chunk);
                    if let Some(turn) = scanned.turn {
                        entry.turn = turn;
                    }
                    entry.usage.add(scanned.usage);
                    if scanned.branch.is_some() {
                        entry.branch = scanned.branch;
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
                        provider: "claude".to_string(),
                        project: entry.project.clone(),
                        seconds: ran.as_secs().max(1),
                        waiting: next == Activity::Waiting,
                    });
                } else if next == Activity::Working {
                    entry.started = Some(Instant::now());
                }
                entry.state = next;
                entry.since = Instant::now();
            }

            views.push(SessionView {
                id: session.session_id.clone(),
                project: entry.project.clone(),
                branch: entry.branch.clone(),
                pid: entry.pid,
                state: entry.state,
                for_secs: entry.since.elapsed().as_secs(),
                input: entry.usage.input,
                output: entry.usage.output,
                last_run_secs: entry.last_run.as_secs(),
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
fn overall(views: &[SessionView]) -> Activity {
    if views.iter().any(|v| v.state == Activity::Waiting) {
        Activity::Waiting
    } else if views.iter().any(|v| v.state == Activity::Working) {
        Activity::Working
    } else {
        Activity::Idle
    }
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

/// Bring the terminal a session is running in to the front.
///
/// Returns false when there is nothing to raise, which is a real outcome
/// rather than an error: a session started from a detached process, or one
/// whose terminal has since been closed, owns no window.
#[tauri::command]
pub fn focus_session(pid: u32) -> bool {
    crate::win::raise_process(pid)
}

pub fn spawn(app: AppHandle) {
    crate::notify::register();
    crate::guard::spawn("agent watcher", move || {
        let mut watcher = Watcher::default();
        let mut last: Option<(Activity, u32)> = None;
        let mut last_views: Vec<SessionView> = Vec::new();

        loop {
            let (views, finished) = watcher.tick();
            for run in &finished {
                crate::log::note(&format!(
                    "run finished: {} in {}s, waiting={}",
                    run.project, run.seconds, run.waiting
                ));
                crate::notify::toast(
                    &format!(
                        "{} {}",
                        run.project,
                        if run.waiting { "needs you" } else { "stopped" }
                    ),
                    &format!("Claude Code ran for {}.", spoken(run.seconds)),
                );
                // The notch keeps its own indicator up until it is looked at.
                // A toast is gone in five seconds, and the whole point of this
                // is the run you were not watching.
                // Kept, so the Review screen can look backwards at all.
                crate::runlog::record(&app, &run.project, run.seconds, run.waiting);
                let _ = app.emit("notch:finished", run.clone());
            }

            let state = overall(&views);
            let running = views.iter().filter(|v| v.state == Activity::Working).count() as u32;

            if let Ok(mut held) = app.state::<Sessions>().0.lock() {
                *held = views.clone();
            }
            /* ⚠️ Compared on what is *drawn*, not on the whole view. `for_secs`
             * climbs every tick, so comparing the views wholesale would emit an
             * event 65 times a minute for ever and wake both WebViews for
             * nothing. The elapsed figures are recomputed in the web layer from
             * the state it already has. */
            let drawn: Vec<_> = views
                .iter()
                .map(|v| (v.id.clone(), v.state, v.input, v.output, v.branch.clone()))
                .collect();
            let previous: Vec<_> = last_views
                .iter()
                .map(|v| (v.id.clone(), v.state, v.input, v.output, v.branch.clone()))
                .collect();
            if drawn != previous {
                last_views = views.clone();
                let _ = app.emit("notch:sessions", views);
            }

            // Only on change: this runs every 900ms forever, and an event per
            // tick would wake the WebView for nothing.
            if last != Some((state, running)) {
                last = Some((state, running));
                if cfg!(debug_assertions) {
                    println!("[notch] claude activity: {state:?} ({running} working)");
                }
                let payload = vec![ProviderActivity {
                    provider: "claude".to_string(),
                    state,
                    running,
                }];
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
                "{:<9?} {:<18} pid {:<7} branch {}",
                view.state,
                view.project,
                view.pid,
                view.branch.clone().unwrap_or_else(|| "-".into()),
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
