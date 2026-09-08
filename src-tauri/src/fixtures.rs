//! The three providers from the design frame, at the levels it shows.
//!
//! A port of Sources/Model/Fixtures.swift. Run with `CODENOTCH_DEMO=1` to see
//! these instead of live readings — which is how the rendering is checked
//! against docs/design/frame-124-hover-tooltip.png rather than against
//! whatever this machine's own usage happens to be today.

use chrono::{Duration, Utc};

use crate::model::{Fidelity, LimitWindow, Snapshot, Status};

pub fn enabled() -> bool {
    std::env::var("CODENOTCH_DEMO").map(|v| v == "1").unwrap_or(false)
}

pub fn snapshots() -> Vec<Snapshot> {
    let now = Utc::now();
    let session_reset = now + Duration::minutes(51);
    let midnight = (now + Duration::days(1))
        .date_naive()
        .and_hms_opt(0, 0, 0)
        .map(|dt| dt.and_utc())
        .unwrap_or(now);

    vec![
        Snapshot {
            id: "claude".into(),
            display_name: "Claude".into(),
            glyph: "claude".into(),
            fidelity: Fidelity::Derived,
            status: Status::Ok,
            windows: vec![
                LimitWindow {
                    id: "claude.session".into(),
                    label: "Current session".into(),
                    used_fraction: 0.73,
                    resets_at: session_reset,
                },
                LimitWindow {
                    id: "claude.all".into(),
                    label: "All models".into(),
                    used_fraction: 0.07,
                    resets_at: midnight,
                },
            ],
            headline_id: "claude.session".into(),
            read_at_ms: None,
            stale: false,
        },
        Snapshot {
            id: "openai".into(),
            display_name: "OpenAI".into(),
            glyph: "openai".into(),
            fidelity: Fidelity::Manual,
            status: Status::Ok,
            windows: vec![LimitWindow {
                id: "openai.session".into(),
                label: "Current session".into(),
                used_fraction: 0.21,
                resets_at: now + Duration::hours(3),
            }],
            headline_id: "openai.session".into(),
            read_at_ms: None,
            stale: false,
        },
        Snapshot {
            id: "third".into(),
            display_name: "Perplexity".into(),
            glyph: "third".into(),
            fidelity: Fidelity::Manual,
            status: Status::Ok,
            windows: vec![LimitWindow {
                id: "third.daily".into(),
                label: "Daily quota".into(),
                used_fraction: 0.52,
                resets_at: midnight,
            }],
            headline_id: "third.daily".into(),
            read_at_ms: None,
            stale: false,
        },
    ]
}
