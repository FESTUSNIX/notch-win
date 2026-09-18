//! What the agents have cost, kept.
//!
//! `runlog.rs` keeps every finished run for a fortnight, which is what the
//! Review screen reads and is the right shape for "what happened on Tuesday".
//! It is the wrong shape for "is this month worse than last": a run is a few
//! hundred bytes, there are a couple of dozen a day, and two weeks is where
//! that stops being free.
//!
//! So this is the other half — one bucket per day per agent per model per
//! project, merged as runs land. A day of hard work is four or five buckets
//! rather than forty runs, which is small enough to keep for months and is
//! already grouped the way every question about it is asked.
//!
//! ⚠️ **Additive, and never derived from `runs.json`.** Rebuilding these from
//! the runs would mean the totals silently changed shape the day the fortnight
//! rolled over and the oldest runs were dropped — the numbers would still
//! render, and they would be wrong about exactly the period this file exists
//! to remember.

use chrono::Local;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const FILE: &str = "usage.json";

/// Four months. Long enough for "is this month worse than last" to have an
/// answer, short enough that the file stays tens of kilobytes.
const RETAIN_DAYS: i64 = 120;

/// One day of one model, on one project.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bucket {
    /// Local day, `YYYY-MM-DD`. ⚠️ Stored rather than derived from a
    /// timestamp, so a run stays filed under the day it *felt* like whatever
    /// the reader's timezone does later.
    pub day: String,
    pub provider: String,
    /// The model, as the provider names it. Empty where the transcript never
    /// said — which is normal for a session that was picked up mid-run.
    #[serde(default)]
    pub model: String,
    pub project: String,
    pub input: u64,
    pub output: u64,
    pub runs: u32,
    pub seconds: u64,
}

impl Bucket {
    /// Whether two runs belong in the same bucket.
    fn same(&self, other: &Bucket) -> bool {
        self.day == other.day
            && self.provider == other.provider
            && self.model == other.model
            && self.project == other.project
    }
}

#[derive(Default)]
pub struct Store(pub std::sync::Mutex<Vec<Bucket>>);

fn cutoff() -> String {
    (Local::now() - chrono::Duration::days(RETAIN_DAYS))
        .format("%Y-%m-%d")
        .to_string()
}

pub fn load(app: &AppHandle) {
    let mut stored: Vec<Bucket> = crate::config::load_beside(FILE).unwrap_or_default();
    let floor = cutoff();
    stored.retain(|bucket| bucket.day >= floor);
    /* ⚠️ Seeded from the runs ONCE, when this file does not exist yet.
     *
     * Deriving these from `runs.json` in general is wrong — it drops its own
     * history after a fortnight, so the totals would silently change shape the
     * day the window rolled over. But on the very first run there is nothing
     * to be wrong about and a fortnight of real history sitting one file away:
     * without this the chart is empty for two weeks, which reads as a feature
     * that does not work rather than as one that has not been fed yet.
     *
     * ⚠️ Runs from before providers were recorded default to Claude, which is
     * what they were: it is the only agent this app could see. */
    if stored.is_empty() {
        if let Ok(runs) = app.state::<crate::runlog::Store>().0.lock() {
            for run in runs.iter() {
                let fresh = Bucket {
                    day: run.day.clone(),
                    provider: run.provider.clone(),
                    model: run.model.clone().unwrap_or_default(),
                    project: run.project.clone(),
                    input: run.input,
                    output: run.output,
                    runs: 1,
                    seconds: run.seconds,
                };
                match stored.iter_mut().find(|bucket| bucket.same(&fresh)) {
                    Some(bucket) => {
                        bucket.input += fresh.input;
                        bucket.output += fresh.output;
                        bucket.runs += 1;
                        bucket.seconds += fresh.seconds;
                    }
                    None => stored.push(fresh),
                }
            }
        }
        if !stored.is_empty() {
            crate::config::save_beside(FILE, &stored);
        }
    }
    if let Ok(mut held) = app.state::<Store>().0.lock() {
        *held = stored;
    }
}

/// Fold one finished run into its day.
pub fn record(app: &AppHandle, run: &crate::sessions::Finished) {
    let fresh = Bucket {
        day: crate::runlog::today(),
        provider: run.provider.clone(),
        model: run.model.clone().unwrap_or_default(),
        project: run.project.clone(),
        input: run.input,
        output: run.output,
        runs: 1,
        seconds: run.seconds,
    };
    let snapshot = {
        let state = app.state::<Store>();
        let Ok(mut held) = state.0.lock() else { return };
        match held.iter_mut().find(|bucket| bucket.same(&fresh)) {
            Some(bucket) => {
                bucket.input += fresh.input;
                bucket.output += fresh.output;
                bucket.runs += 1;
                bucket.seconds += fresh.seconds;
            }
            None => held.push(fresh),
        }
        let floor = cutoff();
        held.retain(|bucket| bucket.day >= floor);
        held.clone()
    };
    crate::config::save_beside(FILE, &snapshot);
}

/// Every bucket from the last `days` days, oldest first.
///
/// ⚠️ `days` counts back from today INCLUSIVE, so 1 is today and 7 is the week
/// ending now. Off by one here is a chart that silently starts on Tuesday.
#[tauri::command]
pub fn get_usage(app: AppHandle, days: i64) -> Vec<Bucket> {
    let floor = (Local::now() - chrono::Duration::days(days.max(1) - 1))
        .format("%Y-%m-%d")
        .to_string();
    let state = app.state::<Store>();
    let Ok(held) = state.0.lock() else {
        return Vec::new();
    };
    let mut out: Vec<Bucket> = held.iter().filter(|b| b.day >= floor).cloned().collect();
    out.sort_by(|a, b| a.day.cmp(&b.day));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bucket(day: &str, provider: &str, model: &str, project: &str) -> Bucket {
        Bucket {
            day: day.into(),
            provider: provider.into(),
            model: model.into(),
            project: project.into(),
            input: 10,
            output: 1,
            runs: 1,
            seconds: 5,
        }
    }

    #[test]
    fn a_bucket_is_one_day_one_model_one_project() {
        let a = bucket("2026-09-18", "claude", "claude-opus-5", "akcesfonia");
        assert!(a.same(&bucket("2026-09-18", "claude", "claude-opus-5", "akcesfonia")));
        // ⚠️ The model is part of the key. Folded together, "what did Opus
        // cost me" has no answer — which is most of the reason to keep this.
        assert!(!a.same(&bucket("2026-09-18", "claude", "claude-haiku-4-5", "akcesfonia")));
        assert!(!a.same(&bucket("2026-09-18", "codex", "claude-opus-5", "akcesfonia")));
        assert!(!a.same(&bucket("2026-09-17", "claude", "claude-opus-5", "akcesfonia")));
        assert!(!a.same(&bucket("2026-09-18", "claude", "claude-opus-5", "esono")));
    }

    #[test]
    fn the_window_is_kept_by_string_comparison() {
        // The whole retention rule, and it works only because the format is
        // zero-padded and big-endian. Same rule as `runlog`.
        let floor = cutoff();
        assert!(floor < crate::runlog::today());
        assert!("2026-01-02" < "2026-01-10");
        assert!("2025-12-31" < "2026-01-01");
    }
}
