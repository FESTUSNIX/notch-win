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
use std::time::{Duration, SystemTime};

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

        if !is_alive(pid, proc_start) {
            continue;
        }
        out.push(Session {
            session_id: session_id.to_string(),
            pid,
            proc_start,
        });
    }
    out
}

#[derive(Default)]
pub struct Watcher {
    /// sessionId → transcript, so the directory is walked once per session
    /// rather than once per tick.
    transcripts: HashMap<String, PathBuf>,
}

impl Watcher {
    fn claude_activity(&mut self) -> Activity {
        let sessions = live_sessions();
        self.transcripts
            .retain(|id, _| sessions.iter().any(|s| &s.session_id == id));

        for session in &sessions {
            let path = match self.transcripts.get(&session.session_id) {
                Some(path) => path.clone(),
                None => {
                    let Some(found) = transcript_for(&session.session_id) else {
                        continue;
                    };
                    self.transcripts
                        .insert(session.session_id.clone(), found.clone());
                    found
                }
            };
            let _ = session.pid;
            let _ = session.proc_start;
            if written_within(&path, WORKING_WINDOW) {
                return Activity::Working;
            }
        }
        Activity::Idle
    }
}

#[derive(Default)]
pub struct Latest(pub std::sync::Mutex<Vec<ProviderActivity>>);

#[tauri::command]
pub fn get_activity(state: tauri::State<Latest>) -> Vec<ProviderActivity> {
    state.0.lock().map(|held| held.clone()).unwrap_or_default()
}

pub fn spawn(app: AppHandle) {
    std::thread::spawn(move || {
        let mut watcher = Watcher::default();
        let mut last: Option<Activity> = None;

        loop {
            let state = watcher.claude_activity();
            // Only on change: this runs every 900ms forever, and an event per
            // tick would wake the WebView for nothing.
            if last != Some(state) {
                last = Some(state);
                if cfg!(debug_assertions) {
                    println!("[notch] claude activity: {state:?}");
                }
                let payload = vec![ProviderActivity {
                    provider: "claude".to_string(),
                    state,
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
