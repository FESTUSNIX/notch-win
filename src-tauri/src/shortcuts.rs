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
/// those may be used here. The letters below are chosen from what is left.
pub const DEFAULT_TOGGLE: &str = "Ctrl+Alt+Space";
pub const DEFAULT_HIDE: &str = "Ctrl+Alt+H";
/// ⚠️ Was `Ctrl+Alt+N`, which is `AltGr+N` — it ate `ń`. T for task.
pub const DEFAULT_CAPTURE: &str = "Ctrl+Alt+T";
/// M for monitor. Only does anything on a machine with more than one.
pub const DEFAULT_DISPLAY: &str = "Ctrl+Alt+M";
/// ⚠️ Was `Ctrl+Alt+S`, which is `AltGr+S` — it ate `ś`. V for the
/// clipboard verb: this parks whatever is on it.
pub const DEFAULT_SHELF: &str = "Ctrl+Alt+V";
/// K for the palette. ⚠️ Not Alt+Space: Flow Launcher, PowerToys Run and
/// half the launchers on Windows already claim that, and a shortcut that
/// silently fails to register is worse than an unfamiliar one.
pub const DEFAULT_PALETTE: &str = "Ctrl+Alt+K";
/// R for ring. ⚠️ Not on the AltGr list above, and deliberately not one of
/// the letters a screen might want later: this is the key that exists so that
/// no screen ever needs one of its own.
pub const DEFAULT_RING: &str = "Ctrl+Alt+R";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Shortcuts {
    /// Expands or collapses the island.
    pub toggle: String,
    /// Takes the island and the usage notch off screen entirely.
    pub hide: String,
    /// Opens the island on Today with the caret already in the composer.
    pub capture: String,
    /// Sends the island to the next display.
    pub display: String,
    /// Puts whatever is on the clipboard on the shelf.
    pub shelf: String,
    /// Opens the command palette.
    pub palette: String,
    /// Puts the ring of screens around the pointer.
    pub ring: String,
}

impl Default for Shortcuts {
    fn default() -> Self {
        Self {
            toggle: DEFAULT_TOGGLE.into(),
            hide: DEFAULT_HIDE.into(),
            capture: DEFAULT_CAPTURE.into(),
            display: DEFAULT_DISPLAY.into(),
            shelf: DEFAULT_SHELF.into(),
            palette: DEFAULT_PALETTE.into(),
            ring: DEFAULT_RING.into(),
        }
    }
}

#[derive(Default)]
pub struct ShortcutState_(pub Mutex<Shortcuts>);

/// When the ring's key went down, in milliseconds since the app started. Zero
/// means "not down". ⚠️ An atomic rather than a `Mutex<Instant>`: this is
/// read and written from the shortcut handler, which must not block.
static RING_DOWN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn now_ms() -> u64 {
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
fn keys_of(shortcut: &str) -> Vec<i32> {
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

/// Is every one of them still held?
fn all_down(keys: &[i32]) -> bool {
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
                let hand = app.clone();
                let _ = app.run_on_main_thread(move || crate::ring::ring_pick(hand, what));
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
    let hidden = crate::config::load().chrome_hidden || AUTO_HIDDEN.load(Ordering::Relaxed);
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

/// Replace both bindings.
///
/// Registration is all-or-nothing on purpose: a half-applied pair leaves the
/// user with one working key and no way to tell which, so a rejected binding
/// puts the previous pair back before returning the error.
#[tauri::command]
pub fn set_shortcuts(
    app: AppHandle,
    toggle: String,
    hide: String,
    capture: String,
    display: String,
    shelf: String,
    palette: String,
    ring: String,
) -> Result<(), String> {
    let next = Shortcuts {
        toggle: toggle.trim().into(),
        hide: hide.trim().into(),
        capture: capture.trim().into(),
        display: display.trim().into(),
        shelf: shelf.trim().into(),
        palette: palette.trim().into(),
        ring: ring.trim().into(),
    };
    let all = [&next.toggle, &next.hide, &next.capture, &next.display, &next.shelf,
        &next.palette, &next.ring];
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
    let previous = app.state::<ShortcutState_>().0.lock().unwrap().clone();
    let manager = app.global_shortcut();
    let _ = manager.unregister_all();
    match apply(&app, &next) {
        Ok(()) => {
            *app.state::<ShortcutState_>().0.lock().unwrap() = next.clone();
            let mut config = crate::config::load();
            config.shortcut_toggle = next.toggle;
            config.shortcut_hide = next.hide;
            config.shortcut_capture = next.capture;
            config.shortcut_display = next.display;
            config.shortcut_shelf = next.shelf;
            config.shortcut_palette = next.palette;
            config.shortcut_ring = next.ring;
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
    for (name, binding) in [
        ("Expand", &shortcuts.toggle),
        ("Hide", &shortcuts.hide),
        ("Capture", &shortcuts.capture),
        ("Next display", &shortcuts.display),
        ("Shelf", &shortcuts.shelf),
        ("Palette", &shortcuts.palette),
        ("Ring", &shortcuts.ring),
    ] {
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
    for (field, fallback, name) in [
        (&mut config.shortcut_toggle, DEFAULT_TOGGLE, "open"),
        (&mut config.shortcut_hide, DEFAULT_HIDE, "hide"),
        (&mut config.shortcut_capture, DEFAULT_CAPTURE, "add a task"),
        (&mut config.shortcut_display, DEFAULT_DISPLAY, "next display"),
        (&mut config.shortcut_shelf, DEFAULT_SHELF, "shelf"),
        (&mut config.shortcut_palette, DEFAULT_PALETTE, "search"),
        (&mut config.shortcut_ring, DEFAULT_RING, "ring"),
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
        toggle: config.shortcut_toggle,
        hide: config.shortcut_hide,
        capture: config.shortcut_capture,
        display: config.shortcut_display,
        shelf: config.shortcut_shelf,
        palette: config.shortcut_palette,
        ring: config.shortcut_ring,
    };

    let handler = app.clone();
    app.plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_handler(move |_app, shortcut, event| {
                let current = handler.state::<ShortcutState_>().0.lock().unwrap().clone();
                let pressed = shortcut.into_string();
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
                    let hidden = crate::config::load().chrome_hidden;
                    set_chrome_hidden(&handler, !hidden);
                } else if matches(&pressed, &current.capture) {
                    // Capture must work from anywhere, so it un-hides first and
                    // always lands on the composer.
                    if crate::config::load().chrome_hidden {
                        set_chrome_hidden(&handler, false);
                    }
                    let _ = handler.emit_to("tasks", "island:capture", ());
                } else if matches(&pressed, &current.toggle) {
                    // Bringing the island up should also bring it back on screen:
                    // otherwise the expand key does nothing while it is hidden,
                    // which reads as a broken shortcut rather than a hidden app.
                    if crate::config::load().chrome_hidden {
                        set_chrome_hidden(&handler, false);
                    }
                    let _ = handler.emit_to("tasks", "island:toggle", ());
                } else if matches(&pressed, &current.palette) {
                    /* Unlike the shelf shortcut, this one DOES bring the island
                     * back: a palette you cannot see is not a palette. */
                    if crate::config::load().chrome_hidden {
                        set_chrome_hidden(&handler, false);
                    }
                    let _ = handler.emit_to("tasks", "island:palette", ());
                } else if matches(&pressed, &current.shelf) {
                    /* Deliberately does NOT open the island. The point is to
                     * park something without leaving what you are in; showing
                     * a panel would be the interruption the shelf exists to
                     * avoid. The pill says what landed. */
                    match crate::shelf::shelf_capture(handler.clone()) {
                        Ok(what) => {
                            let _ = handler.emit_to("tasks", "island:shelved", what);
                        }
                        Err(message) => {
                            let _ = handler.emit_to("tasks", "island:shelved-failed", message);
                        }
                    }
                } else if matches(&pressed, &current.display) {
                    // Moving it while it is off screen would be a keypress with
                    // no visible result, so bring it back first.
                    if crate::config::load().chrome_hidden {
                        set_chrome_hidden(&handler, false);
                    }
                    if let Some(name) = crate::drag::next_display(&handler, "tasks") {
                        // The island is click-through chrome on a bezel; moved
                        // to a screen you were not looking at it reads as gone.
                        let _ = handler.emit_to("tasks", "island:moved", name);
                    }
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
        // The ones actually shipped.
        for safe in ["Ctrl+Alt+Space", "Ctrl+Alt+H", "Ctrl+Alt+T", "Ctrl+Alt+V", "Ctrl+Alt+M", "Ctrl+Alt+K"] {
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
        for binding in [
            &defaults.toggle, &defaults.hide, &defaults.capture,
            &defaults.display, &defaults.shelf, &defaults.palette,
        ] {
            assert!(!eats_a_letter(binding), "{binding}");
        }
    }
}
