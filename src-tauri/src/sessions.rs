//! "Is it still working?" — the other question the notch answers.
//!
//! ⚠️ **The macOS route does not exist on Windows.** `ClaudeSessionMonitor`
//! reads a `status` / `tempo` pair out of `~/.claude/sessions/<pid>.json`;
//! Claude Code on Windows writes that file with an entirely different shape —
//! `pid`, `sessionId`, `cwd`, `startedAt`, `procStart`, `entrypoint`,
//! `messagingSocketPath` — and **no status field at all**. It registers that a
//! session exists, not what it is doing. Reading it the macOS way yields
//! `idle` for ever, silently.
//!
//! So the state comes from the transcript instead: Claude Code appends to
//! `~/.claude/projects/<project>/<sessionId>.jsonl` as it streams, and a file
//! touched within the last few seconds means it is working right now. No hook
//! to install and nothing of the user's configuration to modify.
//!
//! What this cannot see is **waiting**. A session blocked on a prompt stops
//! writing exactly as a finished one does, so the two are identical from here.
//! Telling them apart needs Claude Code's hooks — which is why the other
//! Windows port ships a separate hook executable — and that is not built.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use windows::Win32::Foundation::{CloseHandle, FILETIME, HANDLE};
use windows::Win32::System::Threading::{
    GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
};

/// Fast enough that work starting is noticed while you are still looking at the
/// screen; cheap enough to run forever — it stats a handful of known paths.
const POLL: Duration = Duration::from_millis(900);

/// How recently the transcript must have been written to count as working.
/// Generous, because streaming pauses: a model thinking between tool calls can
/// leave several seconds between appends, and a spinner that stutters off and
/// on through one answer is worse than one that lingers a moment past the end.
const WORKING_WINDOW: Duration = Duration::from_secs(8);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Activity {
    Working,
    /// Never produced yet — see the note at the top of this file.
    #[allow(dead_code)]
    Waiting,
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

fn written_within(path: &Path, window: Duration) -> bool {
    let Ok(modified) = std::fs::metadata(path).and_then(|m| m.modified()) else {
        return false;
    };
    SystemTime::now()
        .duration_since(modified)
        .map(|age| age <= window)
        .unwrap_or(true) // a clock skew into the future is not "old"
}

struct Session {
    session_id: String,
    pid: u32,
    proc_start: Option<u64>,
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
            proc_start,
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

struct Tracked {
    transcript: PathBuf,
    /// When this session was first seen writing. `None` between runs.
    started: Option<Instant>,
    project: String,
}

#[derive(Default)]
pub struct Watcher {
    /// sessionId -> what is known about it, so the projects directory is walked
    /// once per session rather than once per tick.
    tracked: HashMap<String, Tracked>,
}

impl Watcher {
    /// One round: the state to show, plus any run that ended on this tick.
    fn tick(&mut self) -> (Activity, u32, Vec<Finished>) {
        let sessions = live_sessions();
        self.tracked
            .retain(|id, _| sessions.iter().any(|s| &s.session_id == id));

        let mut state = Activity::Idle;
        let mut running = 0u32;
        let mut finished = Vec::new();

        for session in &sessions {
            if !self.tracked.contains_key(&session.session_id) {
                let Some(found) = transcript_for(&session.session_id) else {
                    continue;
                };
                self.tracked.insert(
                    session.session_id.clone(),
                    Tracked {
                        transcript: found,
                        started: None,
                        project: session
                            .cwd
                            .as_deref()
                            .map(project_of)
                            .unwrap_or_else(|| "Claude Code".to_string()),
                    },
                );
            }
            let _ = session.pid;
            let _ = session.proc_start;
            let Some(entry) = self.tracked.get_mut(&session.session_id) else {
                continue;
            };

            if written_within(&entry.transcript, WORKING_WINDOW) {
                state = Activity::Working;
                running += 1;
                entry.started.get_or_insert_with(Instant::now);
            } else if let Some(started) = entry.started.take() {
                // The transcript went quiet WORKING_WINDOW ago, and the run
                // began up to one poll before it was first seen; subtracting
                // the window is the larger of the two corrections.
                let ran = started
                    .elapsed()
                    .saturating_sub(WORKING_WINDOW)
                    .as_secs()
                    .max(1);
                finished.push(Finished {
                    provider: "claude".to_string(),
                    project: entry.project.clone(),
                    seconds: ran,
                });
            }
        }
        (state, running, finished)
    }
}

#[derive(Default)]
pub struct Latest(pub std::sync::Mutex<Vec<ProviderActivity>>);

#[tauri::command]
pub fn get_activity(state: tauri::State<Latest>) -> Vec<ProviderActivity> {
    state.0.lock().map(|held| held.clone()).unwrap_or_default()
}

pub fn spawn(app: AppHandle) {
    crate::notify::register();
    std::thread::spawn(move || {
        let mut watcher = Watcher::default();
        let mut last: Option<(Activity, u32)> = None;

        loop {
            let (state, running, finished) = watcher.tick();
            for run in &finished {
                if cfg!(debug_assertions) {
                    println!("[notch] finished: {} in {}s", run.project, run.seconds);
                }
                crate::notify::toast(
                    &format!("{} finished", run.project),
                    &format!("Claude Code ran for {}.", spoken(run.seconds)),
                );
                // The notch keeps its own indicator up until it is looked at.
                // A toast is gone in five seconds, and the whole point of this
                // is the run you were not watching.
                let _ = app.emit("notch:finished", run.clone());
            }
            // Only on change: this runs every 900ms forever, and an event per
            // tick would wake the WebView for nothing.
            // ⚠️ The count is part of the comparison, not just the state. Two
            // sessions starting and one stopping leaves `state` at Working, and
            // without this the pill would keep saying "2 agents" indefinitely.
            if last != Some((state, running)) {
                last = Some((state, running));
                if cfg!(debug_assertions) {
                    println!("[notch] claude activity: {state:?}");
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
