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
pub const DEFAULT_TOGGLE: &str = "Ctrl+Alt+Space";
pub const DEFAULT_HIDE: &str = "Ctrl+Alt+H";
pub const DEFAULT_CAPTURE: &str = "Ctrl+Alt+N";
/// M for monitor. Only does anything on a machine with more than one.
pub const DEFAULT_DISPLAY: &str = "Ctrl+Alt+M";

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
}

impl Default for Shortcuts {
    fn default() -> Self {
        Self {
            toggle: DEFAULT_TOGGLE.into(),
            hide: DEFAULT_HIDE.into(),
            capture: DEFAULT_CAPTURE.into(),
            display: DEFAULT_DISPLAY.into(),
        }
    }
}

#[derive(Default)]
pub struct ShortcutState_(pub Mutex<Shortcuts>);

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
    std::thread::spawn(move || loop {
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
) -> Result<(), String> {
    let next = Shortcuts {
        toggle: toggle.trim().into(),
        hide: hide.trim().into(),
        capture: capture.trim().into(),
        display: display.trim().into(),
    };
    let all = [&next.toggle, &next.hide, &next.capture, &next.display];
    if all.iter().any(|value| value.is_empty()) {
        return Err("Every shortcut needs a key combination.".into());
    }
    for (i, a) in all.iter().enumerate() {
        if all.iter().skip(i + 1).any(|b| a.eq_ignore_ascii_case(b)) {
            return Err("The shortcuts all have to differ.".into());
        }
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

fn apply(app: &AppHandle, shortcuts: &Shortcuts) -> Result<(), String> {
    let manager = app.global_shortcut();
    for (name, binding) in [
        ("Expand", &shortcuts.toggle),
        ("Hide", &shortcuts.hide),
        ("Capture", &shortcuts.capture),
        ("Next display", &shortcuts.display),
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
    let config = crate::config::load();
    let shortcuts = Shortcuts {
        toggle: config.shortcut_toggle,
        hide: config.shortcut_hide,
        capture: config.shortcut_capture,
        display: config.shortcut_display,
    };

    let handler = app.clone();
    app.plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_handler(move |_app, shortcut, event| {
                // Fire on press. Without this guard both the press and the
                // release run the action, so every toggle is a no-op.
                if event.state() != ShortcutState::Pressed {
                    return;
                }
                let current = handler.state::<ShortcutState_>().0.lock().unwrap().clone();
                let pressed = shortcut.into_string();
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
