//! What survives a restart.
//!
//! Small on purpose: the notch's position along its edge, and the edge itself.
//! Everything else is derived from the readings or from the design.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::win::Edge;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    /// Which edge the notch is welded to.
    pub edge: Edge,
    /// Where it sits *along* that edge, as a fraction of the usable area —
    /// 0 is the top (or left), 1 the bottom (or right), 0.5 centred. Written
    /// back after a drag, and stored as a ratio rather than a pixel offset so
    /// it survives a resolution change or a different monitor.
    pub along: f64,
    pub task_edge: Edge,
    pub task_along: f64,
    pub task_visible: bool,
    /// 24-hour clock on the resting pill. Default true: the app is written in
    /// a place that reads 14:32, and the platform locale is not a safe proxy
    /// (a Polish install of Windows set to en-US reports a 12-hour preference
    /// for someone who has never used one).
    pub clock_24h: bool,
    /// Where the resting pill's weather module reports for. Empty means the
    /// module is off and nothing is ever requested -- see weather.rs on why
    /// this is typed rather than resolved from the IP address.
    pub weather_place: String,
    /// Resolved once from `weather_place` and kept, so the ordinary case is one
    /// request every half hour to one host rather than two.
    pub weather_lat: Option<f64>,
    pub weather_lon: Option<f64>,
    /// Which display each window is welded to, as `win::Screen::id`.
    ///
    /// `None` means "wherever it already is", which is what every install had
    /// before this existed and what a single-monitor machine should keep — a
    /// recorded id that later goes missing is a display that is merely off, and
    /// placement falls back rather than clearing it.
    pub monitor: Option<String>,
    pub task_monitor: Option<String>,
    /// When Claude's endpoint may next be asked, as unix milliseconds.
    ///
    /// ⚠️ Persisted on purpose. The endpoint answers 429 with `Retry-After: 0`,
    /// so the wait is the client's to invent — and a wait that lives only in
    /// memory is spent the moment the app restarts. Relaunching during a
    /// penalty then costs another attempt and *deepens* it, which is exactly
    /// how a development session digs itself into a rate limit it cannot get
    /// out of. This is `UsageArchive.saveBackoffUntil` in the macOS app.
    pub claude_backoff_until_ms: Option<i64>,
    /// Both notches taken off screen by the hide shortcut. Persisted so the
    /// choice survives a restart — someone who hid the chrome to present or to
    /// record did not ask for it back the next time the app launches.
    pub chrome_hidden: bool,
    pub shortcut_toggle: String,
    pub shortcut_hide: String,
    pub shortcut_capture: String,
    pub shortcut_display: String,
    pub shortcut_shelf: String,
    pub shortcut_palette: String,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            edge: Edge::Right,
            along: 0.5,
            // The island is designed for the top edge; the usage notch keeps
            // the right. An existing config keeps whatever it already chose.
            task_edge: Edge::Top,
            task_along: 0.5,
            task_visible: true,
            clock_24h: true,
            weather_place: String::new(),
            weather_lat: None,
            weather_lon: None,
            monitor: None,
            task_monitor: None,
            claude_backoff_until_ms: None,
            chrome_hidden: false,
            shortcut_toggle: crate::shortcuts::DEFAULT_TOGGLE.into(),
            shortcut_hide: crate::shortcuts::DEFAULT_HIDE.into(),
            shortcut_capture: crate::shortcuts::DEFAULT_CAPTURE.into(),
            shortcut_display: crate::shortcuts::DEFAULT_DISPLAY.into(),
            shortcut_shelf: crate::shortcuts::DEFAULT_SHELF.into(),
            shortcut_palette: crate::shortcuts::DEFAULT_PALETTE.into(),
        }
    }
}

/// ⚠️ **Not `codenotch`.** `%APPDATA%\codenotch\` already belongs to the other
/// Windows port (Im-Midi/codenotch-windows), whose config carries `port`,
/// `lang`, `bar_*` and `notch_y`. Sharing the directory would have this app
/// deserialize that file into its own shape — which `serde(default)` accepts
/// without complaint — and then write it back with every one of those fields
/// gone, breaking a working install on the first drag. Both can be installed
/// at once, so the directories have to be distinct.
pub fn path() -> Option<PathBuf> {
    dirs::config_dir().map(|dir| dir.join("codenotch-win").join("config.json"))
}

pub fn load() -> Config {
    let Some(path) = path() else {
        return Config::default();
    };
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

pub fn save(config: &Config) {
    let Some(path) = path() else { return };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(text) = serde_json::to_string_pretty(config) {
        let _ = std::fs::write(path, text);
    }
}

/// The last good reading per provider, kept beside the config.
///
/// ⚠️ Separate from `Config` on purpose: this is a cache that can be thrown
/// away, not a setting, and a corrupt or outdated readings file must never stop
/// the app from starting with the user's edge and position intact.
///
/// Without it, a launch whose first fetch fails has nothing to carry forward
/// and shows a dash — which is exactly what a rate-limited restart looks like,
/// and is strictly worse than the true figure from four minutes ago.
pub fn readings_path() -> Option<PathBuf> {
    path().map(|p| p.with_file_name("readings.json"))
}

pub fn load_readings<T: serde::de::DeserializeOwned>() -> Option<T> {
    let path = readings_path()?;
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

pub fn save_readings<T: Serialize>(value: &T) {
    let Some(path) = readings_path() else { return };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(text) = serde_json::to_string(value) {
        let _ = std::fs::write(path, text);
    }
}

/// A file beside the config, for state that is neither a setting nor a cache.
///
/// ⚠️ Separate files rather than more fields on `Config`. The shelf, the run
/// log and the snooze list are each written on their own schedule by their own
/// thread; folding them into the one struct would mean every write of any of
/// them rewrites the user's edge, position and shortcuts too, and a torn write
/// would cost all of it at once.
pub fn beside(name: &str) -> Option<PathBuf> {
    path().map(|p| p.with_file_name(name))
}

pub fn load_beside<T: serde::de::DeserializeOwned>(name: &str) -> Option<T> {
    let text = std::fs::read_to_string(beside(name)?).ok()?;
    serde_json::from_str(&text).ok()
}

pub fn save_beside<T: Serialize>(name: &str, value: &T) {
    let Some(path) = beside(name) else { return };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(text) = serde_json::to_string_pretty(value) {
        let _ = std::fs::write(path, text);
    }
}
