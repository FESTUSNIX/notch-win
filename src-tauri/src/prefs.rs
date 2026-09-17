//! Everything about the app that was a constant in the source until now.
//!
//! The app already had settings — in three places. The island's gear popover
//! held the edge, the clock and the task view; the editor window held the
//! connections, the shortcuts and the notch's position; and the rest were
//! numbers in TypeScript. This is one struct, one file and one command pair, so
//! the settings window has one thing to read and one thing to write.
//!
//! ⚠️ **Kept beside the config, not in it.** `config.json` is the app's own
//! state — which edge, which monitor, how far along, when Claude's endpoint may
//! next be asked — and a bad write there costs the user their placement. These
//! are preferences: losing the file means everything goes back to the defaults
//! below, which is a shrug rather than a bug.
//!
//! ⚠️ **Every field is `serde(default)`.** A preferences file written by an
//! older build is missing whatever was added since, and a parse error would
//! throw away all of them to add one. The defaults here are the constants the
//! code used to carry, so an empty file behaves exactly like the old app.

use std::collections::BTreeMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

const FILE: &str = "prefs.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Prefs {
    /* ── Appearance ─────────────────────────────────────────────────────── */
    /// The one colour the whole surface is tinted by. Every elevation value is
    /// white or black at low alpha over it, so this is genuinely one variable.
    pub accent: String,
    /// ⚠️ This was removed once, correctly: neither week on the island was
    /// week-ALIGNED — Home's strip was the days either side of today and the
    /// Calendar's was seven columns from today — so the switch had nothing on
    /// the other end of it. Both are real weeks now, so it is back, and it
    /// defaults to MONDAY: Sunday is the platform default and wrong in most of
    /// Europe.
    pub week_starts_monday: bool,
    pub fahrenheit: bool,

    /* ── Behaviour ──────────────────────────────────────────────────────── */
    /// Whether pointing at the pill opens the panel. Off, it takes a click.
    ///
    /// ⚠️ The most opinionated behaviour in the app and the one that was not
    /// changeable: an island that opens when the pointer passes over it is
    /// either the whole point or the whole problem, depending on where the
    /// pointer spends its day.
    pub open_on_hover: bool,
    /// How long the panel waits after the pointer leaves. The old constant.
    pub fold_delay_ms: u64,
    /// `system`, `always` or `never`. Anything else reads as `system`.
    pub motion: String,

    /* ── The island ─────────────────────────────────────────────────────── */
    /// The panel's width along its edge, in design pixels. 0 means the default.
    pub panel_width: u32,
    /// How many screens the rail shows at once. The rest blur away either
    /// side. ⚠️ Clamped where it is read — a rail of one is a label, and a
    /// rail of twelve is the strip this replaced wearing a new shape.
    pub rail_visible: u32,
    /// Whether the rail shows its screens without being asked for. Off, it is
    /// a bare shape until the pointer is on it, like the two arcs.
    pub rail_always: bool,
    /// How far the finger travels for one screen, as a percentage of the
    /// default. Higher is heavier: more drag for the same change.
    pub rail_grip: u32,
    /// How many screens either side of the middle stay sharp. 0 blurs the
    /// immediate neighbours; 1 leaves them alone and starts at the next.
    pub rail_sharp: u32,
    /// Lay every screen out at once, all of them sharp and clickable, instead
    /// of centring one and blurring its neighbours away.
    pub rail_flat: bool,
    /// The screens, in the order they sit on the rail.
    ///
    /// ⚠️ A partial list is fine and is the normal case. Anything the island
    /// knows about that is missing here keeps its built-in place at the end,
    /// so a preferences file written before a screen existed does not hide it
    /// — and the default is simply empty.
    pub rail_order: Vec<String>,
    /// The screens that are not on the rail at all.
    pub rail_hidden: Vec<String>,
    /// A colour per screen, keyed by name. ⚠️ Partial on purpose: anything
    /// missing takes the accent, so the default is an empty map rather than a
    /// palette somebody has to maintain alongside the screens.
    pub rail_colours: BTreeMap<String, String>,

    /* ── In a call ───────────────────────────────────────── */
    /// Whether the microphone is watched at all. Off, nothing polls and the
    /// call screen never appears.
    pub call_mode: bool,
    /// Whether the mute button also cuts the microphone ENDPOINT, as well as
    /// sending the app its own mute shortcut.
    ///
    /// ⚠️ On by default, and the argument is the failure mode rather than
    /// thoroughness: a keystroke that does not land is a mute you can neither
    /// see nor hear, and you carry on talking. Cutting the endpoint too means
    /// every failure is silent in the safe direction. Off, the mute is only as
    /// reliable as the app's own shortcut.
    pub call_mute_mic: bool,
    /// Whether a call arriving puts the island on its screen, so opening it
    /// during a call shows the call.
    pub call_open: bool,

    /* ── Notifications ───────────────────────────────────── */
    /// Whether Windows' own notification centre is mirrored on the island.
    ///
    /// ⚠️ Reading it means every toast on the machine passes through this
    /// app, so it is a switch rather than an assumption — and off, nothing is
    /// asked for and nothing is polled.
    pub notice_mode: bool,

    /* ── The timer ──────────────────────────────────────── */
    /// Minutes in a pomodoro, in the short break after one, and in the long
    /// break after four.
    pub pomodoro_work: u32,
    pub pomodoro_break: u32,
    pub pomodoro_long: u32,
    /// Which of Windows' own notification sounds a finished countdown makes.
    /// Empty is silence. ⚠️ Validated against the offered list on the way in:
    /// an alias Windows does not know plays the system DEFAULT ding rather
    /// than nothing, which is a wrong noise instead of a silent failure.
    pub timer_sound: String,
    /// `timer` or `pomodoro` — which face the screen opens on.
    pub timer_mode: String,
    /// How a running pomodoro shows on the collapsed strip: `bar` is a quiet
    /// line along the bottom with the time under the pointer, `time` is the
    /// countdown itself. ⚠️ `bar` is the default on purpose — a 21px
    /// countdown is the brightest thing on the screen for twenty-five minutes
    /// at a stretch, which is the opposite of what a focus tool should do to
    /// somebody's attention.
    pub pomodoro_pill: String,

    /* ── The palette ────────────────────────────────────────────────────── */
    pub use_everything: bool,
    /// ⚠️ Off, nothing walks the Start Menu at launch — which is a shell call
    /// per shortcut and about 1.7s on a real machine.
    pub index_apps: bool,

    /* ── Notifications ──────────────────────────────────────────────────── */
    pub notify_runs: bool,

    /* ── The resting pill ───────────────────────────────────────────────── */
    /// Which ambient modules may NOT take the pill's third slot.
    ///
    /// ⚠️ Muted rather than enabled, and that is not a naming preference. An
    /// enabled list cannot express "none of them": empty has to mean "all", so
    /// switching the last module off would switch them all back on. Empty here
    /// means nothing is muted, which is also what an older file says.
    pub muted_modules: Vec<String>,
    /// Percent at which a module starts having something to say.
    ///
    /// ⚠️ This is the one that was actually asked for: a disk that lives above
    /// 95% is not news, it is a fact about the machine, and a threshold nobody
    /// could move meant the pill said so for ever.
    pub thresholds: BTreeMap<String, u8>,

    /* Today */
    /// `day` or `all`. Anything else reads as `day`.
    ///
    /// ⚠️ This was island state and nothing else — chosen from the gear
    /// popover and forgotten on the next restart. A switch that only lasts the
    /// session is worse than no switch, because you stop trusting the ones
    /// beside it.
    pub task_view: String,
}

impl Default for Prefs {
    fn default() -> Self {
        Self {
            accent: "#00ff88".into(),
            week_starts_monday: true,
            fahrenheit: false,
            open_on_hover: true,
            fold_delay_ms: 450,
            motion: "system".into(),
            panel_width: 0,
            rail_visible: 5,
            rail_always: true,
            rail_grip: 100,
            rail_sharp: 0,
            rail_flat: false,
            rail_order: Vec::new(),
            rail_hidden: Vec::new(),
            rail_colours: BTreeMap::new(),
            notice_mode: true,
            pomodoro_work: 25,
            pomodoro_break: 5,
            pomodoro_long: 15,
            timer_sound: "Notification.Reminder".into(),
            timer_mode: "pomodoro".into(),
            pomodoro_pill: "bar".into(),
            call_mode: true,
            call_mute_mic: true,
            call_open: true,
            use_everything: true,
            index_apps: true,
            notify_runs: true,
            muted_modules: Vec::new(),
            thresholds: BTreeMap::new(),
            task_view: "day".into(),
        }
    }
}

#[derive(Default)]
pub struct Store(pub Mutex<Prefs>);

pub fn load(app: &AppHandle) {
    let stored: Prefs = crate::config::load_beside(FILE).unwrap_or_default();
    if let Ok(mut held) = app.state::<Store>().0.lock() {
        *held = stored;
    }
}

/// What the rest of the process should read rather than guessing.
pub fn current(app: &AppHandle) -> Prefs {
    app.state::<Store>().0.lock().map(|held| held.clone()).unwrap_or_default()
}

#[tauri::command]
pub fn get_prefs(app: AppHandle) -> Prefs {
    current(&app)
}

/// ⚠️ Takes the WHOLE struct, never a field at a time. A settings window with
/// twenty controls and twenty commands is twenty chances for one of them to
/// write a stale copy of everything else — the same trap `set_shortcuts` is
/// built around.
#[tauri::command]
pub fn set_prefs(app: AppHandle, prefs: Prefs) -> Prefs {
    let clean = Prefs {
        // A colour that is not a colour would leave the whole surface unpainted.
        accent: if is_hex(&prefs.accent) { prefs.accent } else { Prefs::default().accent },
        // Bounded: a fold delay of zero folds the panel while it is being
        // reached for, and one of a minute is a panel that never closes.
        fold_delay_ms: prefs.fold_delay_ms.clamp(120, 5_000),
        motion: match prefs.motion.as_str() {
            "always" | "never" => prefs.motion,
            _ => "system".into(),
        },
        task_view: match prefs.task_view.as_str() {
            "all" => prefs.task_view,
            _ => "day".into(),
        },
        thresholds: prefs.thresholds.into_iter()
            .map(|(key, value)| (key, value.clamp(1, 100)))
            .collect(),
        /* ⚠️ Bounded, like the fold delay: a pomodoro of zero minutes ends
         * the instant it starts and fires a toast on every render, and one of
         * a day is not a pomodoro. */
        pomodoro_work: prefs.pomodoro_work.clamp(1, 180),
        pomodoro_break: prefs.pomodoro_break.clamp(1, 60),
        pomodoro_long: prefs.pomodoro_long.clamp(1, 120),
        timer_sound: if crate::sound::is_known(&prefs.timer_sound) {
            prefs.timer_sound
        } else {
            Prefs::default().timer_sound
        },
        timer_mode: match prefs.timer_mode.as_str() {
            "timer" => prefs.timer_mode,
            _ => "pomodoro".into(),
        },
        pomodoro_pill: match prefs.pomodoro_pill.as_str() {
            "time" => prefs.pomodoro_pill,
            _ => "bar".into(),
        },
        ..prefs
    };
    let snapshot = {
        let state = app.state::<Store>();
        let Ok(mut held) = state.0.lock() else { return clean };
        *held = clean.clone();
        clean
    };
    crate::config::save_beside(FILE, &snapshot);
    /* ⚠️ Emitted to every window. The settings window is not the island, and a
     * preference the island only picked up on its next restart would be a
     * settings screen that looks broken. */
    let _ = app.emit("notch:prefs", snapshot.clone());
    snapshot
}

fn is_hex(value: &str) -> bool {
    let body = value.strip_prefix('#').unwrap_or("");
    (body.len() == 6 || body.len() == 3) && body.chars().all(|c| c.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// ⚠️ A file written by an older build is missing whatever was added since.
    /// A parse error here would throw away every preference to add one.
    #[test]
    fn a_file_from_an_older_build_keeps_its_defaults() {
        /* ⚠️ `r##`, not `r#`. The JSON holds a colour, and a `"#` inside an
         * `r#"..."#` string closes it — the delimiter has to out-hash the
         * content. */
        let loaded: Prefs = serde_json::from_str(r##"{"accent":"#ff0000"}"##).unwrap();
        assert_eq!(loaded.accent, "#ff0000");
        assert_eq!(loaded.fold_delay_ms, 450);
        assert!(loaded.open_on_hover);
        assert!(loaded.index_apps);
        // And an empty file is the old app exactly.
        let empty: Prefs = serde_json::from_str("{}").unwrap();
        assert_eq!(empty.accent, "#00ff88");
        assert!(empty.muted_modules.is_empty());
        assert_eq!(empty.task_view, "day");
    }

    /// ⚠️ Values arrive from a WebView. A colour that is not a colour leaves
    /// the whole surface unpainted, and a fold delay of zero folds the panel
    /// while it is being reached for.
    #[test]
    fn nonsense_is_replaced_rather_than_stored() {
        assert!(is_hex("#00ff88"));
        assert!(is_hex("#abc"));
        assert!(!is_hex("green"));
        assert!(!is_hex("#00ff8"));
        assert!(!is_hex(""));

        let mut thresholds = BTreeMap::new();
        thresholds.insert("disk".to_string(), 0u8);
        thresholds.insert("cpu".to_string(), 200u8.min(u8::MAX));
        let cleaned: BTreeMap<String, u8> = thresholds.into_iter()
            .map(|(k, v)| (k, v.clamp(1, 100)))
            .collect();
        assert_eq!(cleaned["disk"], 1);
        assert_eq!(cleaned["cpu"], 100);
        assert_eq!(0u64.clamp(120, 5_000), 120);
        assert_eq!(999_999u64.clamp(120, 5_000), 5_000);
    }
}
