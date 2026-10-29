//! Two global keys: get the island out of the way, and open it without reaching
//! for the mouse.
//!
//! The island lives at the top edge by default, which is where an editor keeps
//! its tab strip — so "hide it entirely" is not a nicety, it is the thing that
//! makes a top-edge island usable at all. Hiding takes both notches down: when
//! you want the chrome gone you want all of it gone.
//!
//! ⚠️ A hidden window still has to be re-hardened when it comes back.
//! `show()` goes through tao, which rewrites the extended-style word — the same
//! trap `win::harden` exists for. Showing without re-hardening returns a notch
//! that steals focus and appears in Alt-Tab.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use windows::Win32::UI::Shell::{
    SHQueryUserNotificationState, QUNS_BUSY, QUNS_PRESENTATION_MODE, QUNS_RUNNING_D3D_FULL_SCREEN,
};

use crate::win;

/// Hidden because something is fullscreen, as opposed to because it was asked for.
///
/// ⚠️ Kept apart from `config.chrome_hidden` on purpose. They are different
/// facts with different lifetimes: one is a preference that survives a restart,
/// the other is a condition that clears itself. One flag for both means a film
/// watched on Tuesday leaves the island hidden on Wednesday.
static AUTO_HIDDEN: AtomicBool = AtomicBool::new(false);

/// A Guardian nudge from Helm is waiting to be read.
///
/// ⚠️ It overrides BOTH reasons to be hidden, the full-screen one and the one
/// asked for. Mateusz's call: a nudge must not be lost because a video was
/// full-screen or the island had been put away. It lasts only while the nudge
/// is unread; reading it (here or in Helm) puts things back as they were.
static NUDGE_UP: AtomicBool = AtomicBool::new(false);

/// Keep the chrome up while a nudge waits, and with `raise` lift it back over
/// whatever went topmost after it (a borderless full-screen player).
pub fn set_nudge_up(app: &AppHandle, up: bool, raise: bool) {
    if NUDGE_UP.swap(up, Ordering::Relaxed) != up {
        apply_visibility(app);
    }
    if up && raise {
        for label in ["notch", "tasks"] {
            if let Some(window) = app.get_webview_window(label) {
                win::harden(&window);
            }
        }
    }
}



/// Chosen to avoid what Windows and the usual editors already claim.
/// Ctrl+Alt leaves Win+… to the shell and Ctrl+Shift+… to the editor.
///
/// ⚠️ **`Ctrl+Alt` IS `AltGr`, and on a Polish layout that types letters.**
/// Windows implements AltGr as left-Ctrl plus right-Alt, so a `Ctrl+Alt+N`
/// hotkey and an `AltGr+N` keystroke are the same event — and registering the
/// hotkey **takes the letter away**. `Ctrl+Alt+N` ate `ń` and `Ctrl+Alt+S` ate
/// `ś`, everywhere on the machine, with nothing to connect the two: the user
/// experiences a keyboard that has stopped typing two characters.
///
/// The Polish (programmers) layout maps AltGr to **A C E L N O S X Z**. None of
pub const DEFAULT_HIDE: &str = "Ctrl+Alt+H";
/// ⚠️ Was `Ctrl+Alt+S`, which is `AltGr+S` — it ate `ś`. V for the
/// K for the palette. ⚠️ Not Alt+Space: Flow Launcher, PowerToys Run and
/// half the launchers on Windows already claim that, and a shortcut that
/// R for ring. ⚠️ Not on the AltGr list above, and deliberately not one of
/// the letters a screen might want later: this is the key that exists so that
/// no screen ever needs one of its own.
/// ⚠️ ONE key for both, and no modifier stack. Tapped it is the palette —
/// which is what most presses of it were for — and held it is the ring, which
/// is where everything else lives. `Alt+W` because it is near the hand and
/// takes nothing from a Polish layout; see `eats_a_letter`.
pub const DEFAULT_RING: &str = "Alt+W";
/// Quick capture: one line to the Guardian from wherever he is.
///
/// ⚠️ A THIRD key, against the ring's whole argument that keys should stop
/// multiplying — and on purpose (his call, 28 Oct). Capture is the one thing
/// whose point is not leaving what you are in: a thought typed mid-sentence in
/// another app, filed, gone. Through the ring it is a hold, an aim and a field;
/// here it is one chord and the field. J because Helm's own Guardian panel is
/// Ctrl+J, and J is not one of the letters AltGr types (see `eats_a_letter`).
pub const DEFAULT_CAPTURE: &str = "Ctrl+Alt+J";
/// Hold to talk to the Guardian, from any app (voice.rs, 29 Oct).
///
/// ⚠️ A FOURTH key, for capture's reason: the point is not leaving what you
/// are in. Two keys, not three, because it is HELD for as long as he speaks,
/// and a three-finger chord held for ten seconds is a cramp. `Alt` rather than
/// `Ctrl+Alt` so it can never be AltGr (see `eats_a_letter`), and Q because it
/// sits beside the ring's W under the same hand, is not a letter AltGr types,
/// and opens no menu in VS Code, a browser or Explorer.
pub const DEFAULT_TALK: &str = "Alt+Q";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Shortcuts {
    /// Takes the island and the usage notch off screen entirely.
    pub hide: String,
    /// Tapped, the command palette; held, the ring of screens around the pointer.
    pub ring: String,
    /// Opens the island on one line for the Guardian (quick capture).
    #[serde(default)]
    pub capture: String,
    /// Held, the microphone for the Guardian; let go, it is sent (voice.rs).
    #[serde(default)]
    pub talk: String,
}

impl Default for Shortcuts {
    fn default() -> Self {
        Self {
            hide: DEFAULT_HIDE.into(),
            ring: DEFAULT_RING.into(),
            capture: DEFAULT_CAPTURE.into(),
            talk: DEFAULT_TALK.into(),
        }
    }
}

/// The capture key was pressed: the island opens on its one line.
///
/// ⚠️ The chrome comes back first if it was hidden, for the reason
/// `show_chrome` gives: a field opened on an island slid off the screen is a
/// key that does nothing at all. The rest is the page's — the field, the
/// caret, the fold — so this only says so.
fn capture(app: &AppHandle) {
    if crate::config::load().chrome_hidden {
        set_chrome_hidden(app, false);
    }
    let _ = app.emit_to("tasks", "helm:capture", ());
}

#[derive(Default)]
pub struct ShortcutState_(pub Mutex<Shortcuts>);

/// When the ring's key went down, in milliseconds since the app started. Zero
/// means "not down". ⚠️ An atomic rather than a `Mutex<Instant>`: this is
/// read and written from the shortcut handler, which must not block.
static RING_DOWN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

pub(crate) fn now_ms() -> u64 {
    use std::sync::OnceLock;
    static START: OnceLock<std::time::Instant> = OnceLock::new();
    START.get_or_init(std::time::Instant::now).elapsed().as_millis() as u64
}

/* ── Watching a key go up, ourselves ────────────────────────────────────
 *
 * ⚠️ **The plugin's `Released` does not arrive on this machine.** The ring is
 * the one shortcut built around letting go — press, flick the wrist, release —
 * and the event that was supposed to carry that never came, so the gesture had
 * never once worked. Worse, the guard against auto-repeat leaned on `Released`
 * to clear its flag: without it the flag stayed set for ever and the ring
 * stopped opening at all after the first time.
 *
 * So the release is detected here, by asking Windows. `GetAsyncKeyState` is
 * how `drag.rs` already watches a mouse button, and it needs no hook, no
 * message loop and no cooperation from the plugin.
 */

/// The virtual-key codes a shortcut string is made of.
///
/// ⚠️ Every part of it, modifiers included. The gesture is over when ANY of
/// them comes up — letting go of Ctrl is letting go, whatever the letter is
/// still doing — and watching only the letter would leave the ring up for
/// anybody who releases the modifier first, which is most people.
pub(crate) fn keys_of(shortcut: &str) -> Vec<i32> {
    let mut out = Vec::new();
    /* ⚠️ On `+` only. A hyphen is a KEY — `Ctrl+-` is a real shortcut — and
     * splitting on it would leave two empty parts and watch nothing. */
    for part in shortcut.split('+') {
        let key = part.trim().to_ascii_lowercase();
        match key.as_str() {
            "ctrl" | "control" | "commandorcontrol" | "cmdorctrl" => out.push(0x11), // VK_CONTROL
            "alt" | "option" | "altgr" => out.push(0x12),                            // VK_MENU
            "shift" => out.push(0x10),                                               // VK_SHIFT
            /* ⚠️ The left Windows key only. `VK_LWIN` and `VK_RWIN` are
             * separate keys with separate states, and a machine has one of
             * each — watching both would end the gesture the moment either is
             * up, which is always. */
            "super" | "meta" | "win" | "cmd" | "command" => out.push(0x5B),
            other => {
                let name = other.strip_prefix("key").or_else(|| other.strip_prefix("digit"))
                    .unwrap_or(other);
                let mut chars = name.chars();
                match (chars.next(), chars.next()) {
                    (Some(one @ 'a'..='z'), None) => out.push(one.to_ascii_uppercase() as i32),
                    (Some(one @ '0'..='9'), None) => out.push(one as i32),
                    (Some('f'), Some(_)) => {
                        if let Ok(number) = name[1..].parse::<u8>() {
                            if (1..=24).contains(&number) {
                                out.push(0x6F + number as i32); // VK_F1 is 0x70
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
    }
    out
}

/// Stop the Alt (or Win) in a global shortcut from opening a menu on its own.
///
/// ⚠️ **The hotkey eats the letter, so the focused window sees a bare Alt.**
/// `RegisterHotKey` takes the W of Alt+W before any window gets it; the window
/// in front sees Alt go down and come up with nothing between, which is
/// Windows' gesture for "activate the menu bar" — `SC_KEYMENU`. A window with
/// no menu then sits in the menu loop until the next keystroke. When the
/// palette was open the island WAS that window, so pressing Alt+W to close it
/// did nothing until some other key was pressed (and in VS Code the same press
/// lit up the menu bar).
///
/// The fix everyone uses (AutoHotkey's "menu mask key", PowerToys): send a key
/// that means nothing, `vkE8` (unassigned), while the modifier is still down.
/// Alt is then no longer pressed alone, and nothing reacts to the E8 itself.
pub(crate) fn mask_menu_key(shortcut: &str) {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP, VIRTUAL_KEY,
    };
    let lower = shortcut.to_ascii_lowercase();
    let lone_modifier = lower.split('+').any(|part| matches!(part.trim(), "alt" | "option" | "super" | "meta" | "win" | "cmd" | "command"));
    if !lone_modifier {
        return;
    }
    let key = |up: bool| INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(0xE8),
                wScan: 0,
                dwFlags: if up { KEYEVENTF_KEYUP } else { KEYBD_EVENT_FLAGS(0) },
                time: 0,
                dwExtraInfo: 0,
            },
        },
    };
    unsafe {
        SendInput(&[key(false), key(true)], std::mem::size_of::<INPUT>() as i32);
    }
}

/// Is every one of them still held?
pub(crate) fn all_down(keys: &[i32]) -> bool {
    use windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;
    !keys.is_empty()
        && keys
            .iter()
            .all(|key| unsafe { (GetAsyncKeyState(*key) as u16 & 0x8000) != 0 })
}

/// The whole gesture, from the key going down to it coming up.
///
/// ⚠️ **A tap is not a small hold.** Pressed and let go, this key opens the
/// command palette (or whatever else is configured) and the ring is never
/// drawn at all — which is the right trade for a key you press forty times a
/// day: the palette is where most of those presses were going anyway, and a
/// menu that flashes up for 90ms on the way there is noise. The ring is what
/// you get for holding on, and by then your hand has already decided.
///
/// ⚠️ And it is all in ONE place: opening, the tap, the pick and the giving
/// up. The previous version had the press in the handler, the release in a
/// thread and the toggle inside `ring::open`, and the three of them disagreed
/// about what state the world was in — which is how the ring ended up
/// impossible to open at all.
///
/// ⚠️ It says what it did, to the log. Every part of this is invisible: a
/// gesture that quietly does nothing is indistinguishable from a shortcut
/// Windows never delivered, and that cost two rounds of guessing.
fn gesture(app: AppHandle, shortcut: String) {
    let keys = keys_of(&shortcut);
    if keys.is_empty() {
        /* Nothing to watch for, so there is no tap and no hold — the ring
         * opens on the press, the way it always did. A shortcut made of keys
         * this file cannot name is rare enough to be worth a fallback rather
         * than a refusal. */
        crate::log::note(&format!("ring: {shortcut} has no watchable keys, opening at once"));
        let hand = app.clone();
        let _ = app.run_on_main_thread(move || crate::ring::open(&hand));
        return;
    }
    std::thread::spawn(move || {
        let prefs = crate::prefs::current(&app);
        let hold = prefs.ring_hold_ms.clamp(80, 2000);
        let since = now_ms();
        let mut opened = false;
        loop {
            std::thread::sleep(std::time::Duration::from_millis(16));
            let held = now_ms().saturating_sub(since);
            let down = all_down(&keys);

            /* Held long enough: the ring comes up under the pointer. ⚠️ On the
             * MAIN thread. Showing a window from a worker is a thing tauri
             * will do and Windows will occasionally not, and the failure is a
             * window that exists and is not on screen. */
            if down && !opened && held >= hold {
                opened = true;
                crate::log::note(&format!("ring: held {held}ms, opening"));
                /* ⚠️ This one DOES go through the main thread — it shows a
                 * window, and a window shown from a worker is a thing Windows
                 * will occasionally not do. It gets away with waiting for the
                 * loop because a hold is a hand in motion, and motion is what
                 * wakes it. */
                let hand = app.clone();
                let _ = app.run_on_main_thread(move || crate::ring::open(&hand));
                continue;
            }

            if down {
                /* Somebody dismissed it by walking away from it — see
                 * `ring::spawn`. The gesture is over even though the key is
                 * still down; releasing it must not then pick something. */
                if opened && !crate::ring::showing(&app) {
                    crate::log::note("ring: went away while the key was down");
                    RING_DOWN.store(0, Ordering::SeqCst);
                    return;
                }
                /* ⚠️ A key that never comes up. The plugin has been seen to
                 * lose a release, and `GetAsyncKeyState` cannot be wrong for
                 * thirty seconds — but if it is, this is what stops a thread
                 * polling for the rest of the session. */
                if held > 30_000 {
                    crate::log::note("ring: gave up waiting for the key");
                    RING_DOWN.store(0, Ordering::SeqCst);
                    return;
                }
                continue;
            }

            /* Let go. ⚠️ `swap`, so whoever gets here first owns the gesture:
             * the plugin's own `Released` may yet arrive on some machine, and
             * two commits for one press would pick twice. */
            let owned = RING_DOWN.swap(0, Ordering::SeqCst) != 0;
            if !owned {
                return;
            }
            if opened {
                crate::log::note(&format!("ring: let go after {held}ms, picking"));
                crate::ring::commit(&app);
            } else {
                /* A tap. ⚠️ The ring was never drawn, so there is nothing to
                 * aim at and nothing to close — this is the whole reason the
                 * ring is not opened on the press any more. */
                let what = prefs.ring_tap.clone();
                crate::log::note(&format!("ring: tapped after {held}ms, doing {what}"));
                /* ⚠️ Straight from this thread, NOT through the main one. What a
                 * tap does is send an event to a WebView, which needs no event
                 * loop — and going through `run_on_main_thread` meant waiting
                 * for that loop to wake, which on a press-and-release it does
                 * not: nothing moves, so nothing wakes it. The palette then
                 * opened on the next keystroke, whatever that keystroke was,
                 * and the one that was supposed to close it appeared to do
                 * nothing at all. */
                crate::ring::ring_pick(app.clone(), what);
            }
            return;
        }
    });
}

/// Put the chrome where the current state says it belongs.
///
/// ⚠️ The windows are never `hide()`n any more, and that is the point. A hidden
/// window has no edge to hover, so there was no way back except the shortcut —
/// and the whole reason the island is hideable is that it sits where an editor
/// keeps its tab strip, which is exactly where a hand already is. Hidden now
/// means the shape has slid out through its bezel, leaving a few pixels of hot
/// strip that reveals it again. The webview owns both, so there is nothing to
/// wait for here.
fn apply_visibility(app: &AppHandle) {
    let hidden = (crate::config::load().chrome_hidden || AUTO_HIDDEN.load(Ordering::Relaxed)) && !NUDGE_UP.load(Ordering::Relaxed);
    for label in ["notch", "tasks"] {
        let Some(window) = app.get_webview_window(label) else { continue };
        if !window.is_visible().unwrap_or(true) {
            let _ = window.show();
            // See the module note: show() drops the hardened ex-styles.
            win::harden(&window);
        }
    }
    let _ = app.emit("chrome:hidden", hidden);
}

/// Show or hide both notches, and remember which it is.
pub fn set_chrome_hidden(app: &AppHandle, hidden: bool) {
    let mut config = crate::config::load();
    config.chrome_hidden = hidden;
    crate::config::save(&config);
    apply_visibility(app);
}

/// Get out of the way of anything fullscreen.
///
/// `SHQueryUserNotificationState` is the API Windows itself uses to decide
/// whether a toast may appear, so it already knows about exclusive-fullscreen
/// games, PowerPoint in presentation mode and screen sharing. Comparing the
/// foreground window's rect against the monitor — the obvious approach — calls
/// a maximised editor fullscreen and hides the island all day.
pub fn watch_presence(app: AppHandle) {
    crate::guard::spawn("fullscreen watch", move || loop {
        let busy = unsafe { SHQueryUserNotificationState() }
            .map(|s| matches!(s, QUNS_BUSY | QUNS_RUNNING_D3D_FULL_SCREEN | QUNS_PRESENTATION_MODE))
            .unwrap_or(false);
        if AUTO_HIDDEN.swap(busy, Ordering::Relaxed) != busy {
            apply_visibility(&app);
        }
        std::thread::sleep(Duration::from_secs(2));
    });
}

#[tauri::command]
pub fn get_chrome_hidden() -> bool {
    crate::config::load().chrome_hidden
}

#[tauri::command]
pub fn toggle_chrome(app: AppHandle) {
    set_chrome_hidden(&app, !crate::config::load().chrome_hidden);
}

/// Bring the chrome back, whatever it was doing.
///
/// ⚠️ Not `toggle_chrome`. Something that needs the island ON SCREEN has to
/// be able to say so: a caller toggling from its own idea of the state hides
/// the island half the time, and the half it gets wrong is the half where the
/// state changed behind it. The command palette is the caller — asking for it
/// while everything is hidden is asking for the app back, and opening it
/// behind a hidden island is a shortcut that does nothing at all.
#[tauri::command]
pub fn show_chrome(app: AppHandle) {
    set_chrome_hidden(&app, false);
}

#[tauri::command]
pub fn get_shortcuts(app: AppHandle) -> Shortcuts {
    app.state::<ShortcutState_>().0.lock().unwrap().clone()
}

/// Replace all the bindings.
///
/// Registration is all-or-nothing on purpose: a half-applied set leaves the
/// user with one working key and no way to tell which, so a rejected binding
/// puts the previous set back before returning the error.
///
/// ⚠️ `talk` is optional, unlike the rest: a settings page that predates it
/// would otherwise fail on the missing argument and save nothing. Left out,
/// the current one stays.
#[tauri::command]
pub fn set_shortcuts(app: AppHandle, hide: String, ring: String, capture: String, talk: Option<String>) -> Result<(), String> {
    let previous = app.state::<ShortcutState_>().0.lock().unwrap().clone();
    let next = Shortcuts {
        hide: hide.trim().into(),
        ring: ring.trim().into(),
        capture: capture.trim().into(),
        talk: talk.map(|t| t.trim().to_string()).unwrap_or_else(|| previous.talk.clone()),
    };
    let all = [&next.hide, &next.ring, &next.capture, &next.talk];
    if all.iter().any(|value| value.is_empty()) {
        return Err("Every shortcut needs a key combination.".into());
    }
    for (i, a) in all.iter().enumerate() {
        if all.iter().skip(i + 1).any(|b| a.eq_ignore_ascii_case(b)) {
            return Err("The shortcuts all have to differ.".into());
        }
    }
    if let Some(bad) = all.iter().find(|value| eats_a_letter(value)) {
        return Err(format!(
            "{bad} is AltGr+{} on a Polish layout, so registering it would stop that              letter being typed anywhere. Pick a different key.",
            bad.rsplit('+').next().unwrap_or("?")
        ));
    }
    if !watchable(&next.talk) {
        return Err(format!("{} can't be watched while it's held. Hold to talk needs a letter, a digit or an F key with Ctrl, Alt, Shift or Win.", next.talk));
    }
    let manager = app.global_shortcut();
    let _ = manager.unregister_all();
    // A live voice turn's Escape went with them; voice.rs takes it again on the next one.
    crate::voice::forget_escape();
    match apply(&app, &next) {
        Ok(()) => {
            *app.state::<ShortcutState_>().0.lock().unwrap() = next.clone();
            let mut config = crate::config::load();
            config.shortcut_hide = next.hide;
            config.shortcut_ring = next.ring;
            config.shortcut_capture = next.capture;
            config.shortcut_talk = next.talk;
            crate::config::save(&config);
            Ok(())
        }
        Err(message) => {
            let _ = manager.unregister_all();
            let _ = apply(&app, &previous);
            Err(message)
        }
    }
}

/// The letters AltGr types on the Polish (programmers) layout.
///
/// ⚠️ Checked rather than trusted to the person picking, because the failure is
/// invisible from inside the app: the shortcut works perfectly, and somewhere
/// else on the machine a letter has quietly stopped existing.
const ALTGR_LETTERS: [&str; 9] = ["A", "C", "E", "L", "N", "O", "S", "X", "Z"];

/// Whether every key of a binding can be watched going up (`keys_of`), which a
/// HELD key needs: hold to talk ends when any of them is let go, and a part this
/// file cannot name would leave the microphone open with nothing to end it.
pub fn watchable(binding: &str) -> bool {
    let parts = binding.split('+').filter(|part| !part.trim().is_empty()).count();
    parts > 1 && keys_of(binding).len() == parts
}

pub fn eats_a_letter(binding: &str) -> bool {
    let lower = binding.to_ascii_lowercase();
    if !(lower.contains("ctrl") || lower.contains("control")) || !lower.contains("alt") {
        return false;
    }
    // Shift+Ctrl+Alt is not AltGr; only the bare pair collides.
    if lower.contains("shift") || lower.contains("super") || lower.contains("win") {
        return false;
    }
    binding
        .rsplit('+')
        .next()
        .map(|key| ALTGR_LETTERS.contains(&key.trim().to_ascii_uppercase().as_str()))
        .unwrap_or(false)
}

fn apply(app: &AppHandle, shortcuts: &Shortcuts) -> Result<(), String> {
    let manager = app.global_shortcut();
    for (name, binding) in [("Hide", &shortcuts.hide), ("Ring", &shortcuts.ring), ("Capture", &shortcuts.capture), ("Hold to talk", &shortcuts.talk)] {
        manager.register(binding.as_str()).map_err(|_| {
            // Almost always another app holding the combination; Windows gives
            // no way to say which, so the message must not pretend it can.
            format!("Windows would not give us {binding} for {name}. Another app probably has it — pick a different combination.")
        })?;
    }
    Ok(())
}

pub fn setup(app: &AppHandle) -> Result<(), String> {
    let mut config = crate::config::load();
    /* ⚠️ Migrated, not just re-defaulted. Changing `DEFAULT_CAPTURE` does
     * nothing for anyone who already has a config — the old `Ctrl+Alt+N` is
     * saved there and would go on eating `ń` for ever. A binding that would
     * take a letter away is replaced by the current default and written back,
     * because the person cannot be expected to connect "my keyboard stopped
     * typing ś" to a hotkey they set weeks ago. */
    let mut moved = Vec::new();
    /* ⚠️ The ring's key took over the palette's job, so anybody still on the
     * ring's OLD default is moved to the new one — otherwise the key they know
     * as "the palette" does nothing at all and the ring stays on a combination
     * chosen when it was one feature among seven. A binding somebody actually
     * chose for themselves is left alone: only the old default is moved. */
    if config.shortcut_ring.eq_ignore_ascii_case("Ctrl+Alt+R") {
        moved.push(format!("ring: {} -> {DEFAULT_RING}", config.shortcut_ring));
        config.shortcut_ring = DEFAULT_RING.to_string();
    }
    /* A config written before capture had a key takes the default through
     * `serde(default)`; an EMPTY one (a hand-edited file) would fail
     * registration for all three, so it is given the default here rather than
     * left to break the other two. */
    if config.shortcut_capture.trim().is_empty() {
        config.shortcut_capture = DEFAULT_CAPTURE.to_string();
        moved.push(format!("capture: none -> {DEFAULT_CAPTURE}"));
    }
    // The same for hold to talk (a config from before it), and for one that
    // cannot be watched while it is held.
    if !watchable(&config.shortcut_talk) {
        let was = if config.shortcut_talk.trim().is_empty() { "none".to_string() } else { config.shortcut_talk.clone() };
        moved.push(format!("talk: {was} -> {DEFAULT_TALK}"));
        config.shortcut_talk = DEFAULT_TALK.to_string();
    }
    for (field, fallback, name) in [
        (&mut config.shortcut_hide, DEFAULT_HIDE, "hide"),
        (&mut config.shortcut_ring, DEFAULT_RING, "ring"),
        (&mut config.shortcut_capture, DEFAULT_CAPTURE, "capture"),
        (&mut config.shortcut_talk, DEFAULT_TALK, "talk"),
    ] {
        if eats_a_letter(field) {
            moved.push(format!("{name}: {field} -> {fallback}"));
            *field = fallback.to_string();
        }
    }
    if !moved.is_empty() {
        crate::log::note(&format!("shortcuts moved off AltGr ({})", moved.join(", ")));
        crate::config::save(&config);
    }

    let shortcuts = Shortcuts {
        hide: config.shortcut_hide,
        ring: config.shortcut_ring,
        capture: config.shortcut_capture,
        talk: config.shortcut_talk,
    };

    let handler = app.clone();
    app.plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_handler(move |_app, shortcut, event| {
                let current = handler.state::<ShortcutState_>().0.lock().unwrap().clone();
                let pressed = shortcut.into_string();
                /* Escape, registered only while a voice turn is live (voice.rs):
                 * it stops the turn from whatever app has the keyboard. */
                if matches(&pressed, crate::voice::ESCAPE) {
                    if event.state() == ShortcutState::Pressed {
                        let _ = handler.emit_to("tasks", "voice:escape", ());
                    }
                    return;
                }
                /* ⚠️ The ring is the one shortcut that cares about the RELEASE.
                 * Held and let go it is a single gesture — press, flick, let go
                 * — and tapped it opens the ring and leaves it up for somebody
                 * who wants to read the labels. Everything else here fires on
                 * the press and ignores the release, without which every
                 * toggle runs twice and is therefore a no-op. */
                if matches(&pressed, &current.ring) {
                    match event.state() {
                        ShortcutState::Pressed => {
                            /* ⚠️ **Windows repeats a held key**, and every repeat
                             * arrives here as another Pressed. Without this the
                             * gesture below would be started thirty times a
                             * second for as long as the key was down.
                             *
                             * ⚠️ And the flag is only trusted while the RING is
                             * up or the gesture is young: it used to be trusted
                             * on its own, and one lost release left the key
                             * doing nothing at all for the rest of the
                             * session. */
                            let down = RING_DOWN.load(Ordering::SeqCst);
                            let live = down != 0
                                && (crate::ring::showing(&handler)
                                    || now_ms().saturating_sub(down) < 3_000);
                            if live {
                                return;
                            }
                            RING_DOWN.store(now_ms().max(1), Ordering::SeqCst);
                            mask_menu_key(&current.ring);
                            /* ⚠️ Nothing is opened here. A tap does something
                             * else entirely and a hold opens the ring; which
                             * of the two this is will not be known for another
                             * couple of hundred milliseconds. See `gesture`. */
                            gesture(handler.clone(), current.ring.clone());
                        }
                        ShortcutState::Released => {
                            /* ⚠️ Kept, and it may never fire: on this machine
                             * the plugin does not report a release at all,
                             * which is why `gesture` watches the keys itself.
                             * If it ever does arrive first, the swap in there
                             * finds a zero and the gesture is not run twice. */
                            crate::log::note("ring: the plugin reported a release");
                        }
                    }
                    return;
                }
                // Fire on press. Without this guard both the press and the
                // release run the action, so every toggle is a no-op.
                if event.state() != ShortcutState::Pressed {
                    return;
                }
                if matches(&pressed, &current.hide) {
                    /* The hide key takes the curtain down first: one more way
                     * out that needs nothing from its page (curtain.rs). */
                    if crate::curtain::OPEN.load(Ordering::SeqCst) {
                        crate::curtain::lift(&handler, crate::curtain::Lift::Closed);
                        return;
                    }
                    let hidden = crate::config::load().chrome_hidden;
                    set_chrome_hidden(&handler, !hidden);
                } else if matches(&pressed, &current.capture) {
                    capture(&handler);
                } else if matches(&pressed, &current.talk) {
                    /* ⚠️ On the press like the rest; the release is watched in
                     * voice.rs, for the ring's reason (the plugin never reports
                     * one here). Its auto-repeat lands there too. */
                    crate::voice::pressed(&handler, &current.talk);
                }
            })
            .build(),
    )
    .map_err(|e| format!("Could not start the global shortcut plugin: {e}"))?;

    *app.state::<ShortcutState_>().0.lock().unwrap() = shortcuts.clone();
    // A shortcut another app already owns must not stop the app from starting;
    // the settings screen reports it and the rest of the island still works.
    if let Err(message) = apply(app, &shortcuts) {
        let _ = app.emit("shortcuts:error", message);
    }
    if crate::config::load().chrome_hidden {
        apply_visibility(app);
    }
    watch_presence(app.clone());
    Ok(())
}

/// The plugin normalises what it parses, so `Ctrl+Alt+Space` comes back as
/// `control+alt+Space`. Compare on the parsed form of both sides rather than
/// on the strings the user typed.
fn matches(pressed: &str, configured: &str) -> bool {
    if pressed.eq_ignore_ascii_case(configured) {
        return true;
    }
    configured
        .parse::<tauri_plugin_global_shortcut::Shortcut>()
        .map(|parsed| parsed.into_string().eq_ignore_ascii_case(pressed))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_shortcut_is_every_key_it_is_made_of() {
        /* ⚠️ The modifiers count. Letting go of Ctrl is letting go, whatever
         * the letter is still doing — and watching only the letter leaves the
         * ring up for anybody who releases the modifier first. */
        assert_eq!(keys_of("Ctrl+Alt+R"), vec![0x11, 0x12, 0x52]);
        assert_eq!(keys_of("ctrl+shift+F5"), vec![0x11, 0x10, 0x74]);
        assert_eq!(keys_of("Super+KeyK"), vec![0x5B, 0x4B]);
        assert_eq!(keys_of("Alt+Digit3"), vec![0x12, 0x33]);
    }

    #[test]
    fn a_shortcut_nothing_can_be_made_of_is_not_watched() {
        /* ⚠️ Empty means "do not poll", not "poll nothing" — `all_down` on an
         * empty list would be vacuously true, which is a thread spinning for
         * ever on a key that is not down. */
        assert!(keys_of("").is_empty());
        assert!(keys_of("Ctrl+Space").len() == 1, "the unknown part is dropped");
        assert!(!all_down(&[]), "an empty list is not held");
    }

    /// ⚠️ The check that stops a shortcut quietly removing a letter from the
    /// keyboard. `Ctrl+Alt` IS `AltGr` on Windows, and the Polish layout maps
    /// it to nine letters; `Ctrl+Alt+N` ate `ń` for several days before anyone
    /// connected the two.
    #[test]
    fn a_shortcut_that_would_eat_a_polish_letter_is_refused() {
        for eaten in ["Ctrl+Alt+N", "Ctrl+Alt+S", "ctrl+alt+e", "Control+Alt+Z", "Ctrl+Alt+X"] {
            assert!(eats_a_letter(eaten), "{eaten}");
        }
        // The ones actually shipped, now or before.
        for safe in ["Ctrl+Alt+Space", "Ctrl+Alt+H", "Ctrl+Alt+T", "Ctrl+Alt+V", "Ctrl+Alt+M", "Ctrl+Alt+K", "Ctrl+Alt+J"] {
            assert!(!eats_a_letter(safe), "{safe}");
        }
        // A third modifier is no longer AltGr.
        assert!(!eats_a_letter("Ctrl+Shift+Alt+N"));
        // And neither is Ctrl or Alt on its own.
        assert!(!eats_a_letter("Ctrl+N"));
        assert!(!eats_a_letter("Alt+N"));
    }

    #[test]
    fn no_shipped_default_eats_a_letter() {
        let defaults = Shortcuts::default();
        for binding in [&defaults.hide, &defaults.ring, &defaults.capture, &defaults.talk] {
            assert!(!eats_a_letter(binding), "{binding}");
        }
    }

    #[test]
    fn the_defaults_are_all_different_keys() {
        /* ⚠️ `set_shortcuts` refuses a set with two the same, and the
         * defaults are what "Back to the defaults" sends — a clash here would
         * be a reset button that always fails. */
        let d = Shortcuts::default();
        let all = [&d.hide, &d.ring, &d.capture, &d.talk];
        for (i, a) in all.iter().enumerate() {
            for b in all.iter().skip(i + 1) {
                assert!(!a.eq_ignore_ascii_case(b), "{a} and {b}");
            }
        }
    }

    /// ⚠️ Hold to talk ends when a key of it comes up, so every key has to be
    /// one `GetAsyncKeyState` can be asked about: a part `keys_of` drops would
    /// leave the microphone open with nothing to close it.
    #[test]
    fn the_talk_key_can_be_watched_while_held() {
        assert!(watchable(DEFAULT_TALK));
        assert_eq!(keys_of(DEFAULT_TALK), vec![0x12, 0x51], "Alt and Q");
        for fine in ["Ctrl+Shift+F9", "Alt+Digit5", "Super+KeyG", "Ctrl+Alt+G"] {
            assert!(watchable(fine), "{fine}");
        }
        for not in ["Ctrl+Space", "Alt+Backquote", "Q", "", "Alt+"] {
            assert!(!watchable(not), "{not}");
        }
        // And Escape, which a live turn takes for itself, is not one he could pick.
        assert!(!watchable(crate::voice::ESCAPE));
    }
}
