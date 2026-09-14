//! What the agents did today.
//!
//! The watcher already knows when a run ends and how long it took; it just
//! threw the fact away after raising a toast. The Review screen is the first
//! thing in this app that looks *backwards*, and this is the only one of its
//! four sources that was not already being kept.
//!
//! ⚠️ Written on the watcher's own thread, beside the config rather than in it
//! — a run ending must never rewrite the user's edge, position and shortcuts.

use chrono::Local;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const FILE: &str = "runs.json";
/// Two weeks. Long enough to answer "was last Tuesday as bad as it felt",
/// short enough that the file stays a few kilobytes.
const RETAIN_DAYS: i64 = 14;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    /// Local day, `YYYY-MM-DD`. Stored rather than derived from `endedMs` so a
    /// run is filed under the day it *felt* like, whatever the reader's
    /// timezone does later.
    pub day: String,
    pub project: String,
    pub seconds: u64,
    pub ended_ms: i64,
    /// Whether it ended waiting for you rather than simply stopping.
    #[serde(default)]
    pub waiting: bool,
}

#[derive(Default)]
pub struct Store(pub std::sync::Mutex<Vec<Run>>);

pub fn today() -> String {
    Local::now().format("%Y-%m-%d").to_string()
}

fn cutoff() -> String {
    (Local::now() - chrono::Duration::days(RETAIN_DAYS))
        .format("%Y-%m-%d")
        .to_string()
}

pub fn load(app: &AppHandle) {
    let mut stored: Vec<Run> = crate::config::load_beside(FILE).unwrap_or_default();
    let floor = cutoff();
    stored.retain(|run| run.day >= floor);
    if let Ok(mut runs) = app.state::<Store>().0.lock() {
        *runs = stored;
    }
}

/// File one finished run.
pub fn record(app: &AppHandle, project: &str, seconds: u64, waiting: bool) {
    let snapshot = {
        let state = app.state::<Store>();
        let Ok(mut runs) = state.0.lock() else { return };
        runs.push(Run {
            day: today(),
            project: project.to_string(),
            seconds,
            ended_ms: chrono::Utc::now().timestamp_millis(),
            waiting,
        });
        let floor = cutoff();
        runs.retain(|run| run.day >= floor);
        runs.clone()
    };
    crate::config::save_beside(FILE, &snapshot);
}

/// Every run on a given local day, oldest first. An empty `day` means today.
#[tauri::command]
pub fn get_runs(app: AppHandle, day: String) -> Vec<Run> {
    let wanted = if day.is_empty() { today() } else { day };
    let state = app.state::<Store>();
    let Ok(runs) = state.0.lock() else {
        return Vec::new();
    };
    let mut out: Vec<Run> = runs.iter().filter(|run| run.day == wanted).cloned().collect();
    out.sort_by_key(|run| run.ended_ms);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_last_fortnight_is_kept() {
        let floor = cutoff();
        assert!(floor < today(), "the cutoff is in the past");
        let old = (Local::now() - chrono::Duration::days(RETAIN_DAYS + 1))
            .format("%Y-%m-%d")
            .to_string();
        assert!(old < floor, "a run older than the window sorts below the cutoff");
        // String comparison is the whole retention rule, and it only works
        // because the format is zero-padded and big-endian.
        assert!("2026-01-02" < "2026-01-10");
        assert!("2025-12-31" < "2026-01-01");
    }
}
