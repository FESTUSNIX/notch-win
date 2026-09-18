//! A ring of screens around the pointer, on one key.
//!
//! The island has six global shortcuts and every screen added asks for a
//! seventh. This is the answer to that: one key puts every screen under the
//! pointer, where the hand already is, and picking one opens the island on it.
//!
//! ⚠️ **It appears at the CURSOR, not at the island.** That is the whole
//! point — the island is welded to a screen edge, so reaching it is a journey
//! across the monitor, and a menu that opens where you are already looking
//! costs no travel at all. Which also means the window is positioned by hand
//! every time it is shown, in PHYSICAL pixels, because that is what
//! `GetCursorPos` speaks.
//!
//! ⚠️ **It is `WS_EX_NOACTIVATE` like the rest of the chrome**, so it never
//! takes focus from what you were typing in. A window that cannot be focused
//! also cannot be sent a key, so Escape is not the way out of it: moving the
//! pointer away is, and `hover.rs`'s own poll is what notices.

use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, WebviewWindowBuilder, WebviewUrl};
use windows::Win32::Foundation::POINT;
use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;

use crate::win;

pub const LABEL: &str = "ring";

/// How long the key has to be DOWN for the release to count as a pick.
///
/// ⚠️ Two hundred milliseconds, and the number is the whole feel of it. A
/// tap opens the ring and leaves it up — which is what somebody who wants to
/// read the labels is doing — and a hold-and-release is one gesture: press,
/// flick the wrist, let go. Shorter than this and an ordinary press is
/// mistaken for a flick; much longer and the gesture has a pause in it.
/// ⚠️ The DEFAULT only — `prefs.ring_hold_ms` is what the gesture reads. It
/// is the line between a tap and a hold, and the two now do entirely different
/// things: under it the ring is never drawn at all.
pub const HOLD: std::time::Duration = std::time::Duration::from_millis(250);

/// How wide the window is, in design pixels, before the display's scaling.
/// ⚠️ Must be at least the ring's own diameter plus room for the labels that
/// sit outside it, or the shape is clipped by its own window and looks like a
/// rendering bug.
const SIZE: f64 = 420.0;

fn cursor() -> Option<(i32, i32)> {
    let mut point = POINT::default();
    unsafe { GetCursorPos(&mut point).ok()? };
    Some((point.x, point.y))
}

/// Build it the first time it is asked for.
///
/// ⚠️ Created lazily rather than declared in `tauri.conf.json` with the other
/// two. A window that exists from launch is a window whose webview is running
/// all day for a thing used a few times an hour — and this one has to be
/// positioned before it is ever visible, which a declared window cannot be.
fn window(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    if let Some(found) = app.get_webview_window(LABEL) {
        return Some(found);
    }
    let built = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("ring.html".into()))
        .title("Codenotch Ring")
        .inner_size(SIZE, SIZE)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .visible(false)
        .build()
        .ok()?;
    win::harden(&built);
    Some(built)
}

/// Put the ring under the pointer and show it.
pub fn open(app: &AppHandle) {
    let Some(window) = window(app) else { return };
    if window.is_visible().unwrap_or(false) {
        /* ⚠️ Already up, so this is not a second gesture — it is the same one
         * arriving twice, and the ring must stay where it is. It used to close
         * here, on the theory that the key is a toggle, which is what turned a
         * repeated key into a ring that flickered. The way out is letting go,
         * or walking away from it. */
        return;
    }
    let Some((x, y)) = cursor() else { return };
    let size = window.outer_size().unwrap_or_default();

    /* ⚠️ Clamped to the monitor the pointer is ON, not to the primary one. A
     * ring opened near the right-hand edge of a left-hand monitor would
     * otherwise be half-drawn across the seam — and on a single-monitor
     * machine the bug only appears in the last 200 pixels of the screen. */
    let (mut left, mut top) = (x - size.width as i32 / 2, y - size.height as i32 / 2);
    if let Ok(Some(monitor)) = window.monitor_from_point(x as f64, y as f64) {
        let area = monitor.size();
        let at = monitor.position();
        left = left.clamp(at.x, at.x + area.width as i32 - size.width as i32);
        top = top.clamp(at.y, at.y + area.height as i32 - size.height as i32);
    }
    let _ = window.set_position(PhysicalPosition::new(left, top));

    /* Where the pointer is INSIDE the window, so the page can put the ring
     * around it rather than around the window's middle — they differ whenever
     * the clamp above moved it.
     *
     * ⚠️ Sent TWICE, before and after the window is up. A hidden WebView2 is
     * throttled by Windows, so an event delivered to it while it is still
     * hidden can be handled late — and this one carries the reset that takes
     * the ring out of the state the last pick left it in. Before, so the first
     * frame is already right; after, so it is right even if that one was
     * missed. The page does the same work either way. */
    let at = (x - left, y - top);
    let _ = window.emit_to(LABEL, "ring:at", at);
    let _ = window.show();
    let _ = window.emit_to(LABEL, "ring:at", at);
    // See `win::harden`: show() goes through tao and drops the ex-styles.
    win::harden(&window);
}

pub fn close(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.hide();
    }
}

/// True while the ring is up, for the hover poll that dismisses it.
pub fn showing(app: &AppHandle) -> bool {
    app.get_webview_window(LABEL)
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(false)
}

/// The pointer has left the ring's window. ⚠️ Polled rather than listened for:
/// the webview only sees the pointer while it is inside, so "gone somewhere
/// else entirely" is a question only the OS can answer — the same reason
/// `hover.rs` exists.
pub fn wandered(app: &AppHandle) -> bool {
    let Some(window) = app.get_webview_window(LABEL) else { return false };
    let (Some((x, y)), Ok(at), Ok(size)) = (cursor(), window.outer_position(), window.outer_size())
    else {
        return false;
    };
    /* A margin, because the window is square and the ring inside it is round:
     * leaving the corner of the square is not leaving the ring. */
    let slack = 40;
    x < at.x - slack
        || y < at.y - slack
        || x > at.x + size.width as i32 + slack
        || y > at.y + size.height as i32 + slack
}

/// Watch for the pointer leaving, because nothing else can.
///
/// ⚠️ A poll, for the reason `hover.rs` is one: the webview only sees the
/// pointer while it is inside its own window, so "the pointer went somewhere
/// else entirely" is a question only the OS can answer. And the ring MUST have
/// an answer to it — the window takes no focus, so there is no Escape and no
/// blur; moving away has to be the way out or the ring is a thing you have to
/// go and dismiss.
pub fn spawn(app: AppHandle) {
    crate::guard::spawn("ring watch", move || loop {
        if showing(&app) && wandered(&app) {
            close(&app);
        }
        std::thread::sleep(std::time::Duration::from_millis(120));
    });
}

#[tauri::command]
pub fn ring_close(app: AppHandle) {
    close(&app);
}

/// The key was let go after a hold: take whatever is aimed at.
///
/// ⚠️ Asked of the PAGE rather than worked out here. The pointer's position
/// is knowable from Rust, but which wedge it is over depends on the ring's own
/// geometry, the preferences and how many stops are showing — all of which
/// live in the page. Two answers to that question would disagree the first
/// time somebody changed what the ring holds.
pub fn commit(app: &AppHandle) {
    if !showing(app) {
        return;
    }
    /* ⚠️ WHERE the pointer is, sent with the pick — rather than leaving the
     * page to remember where it last saw it move. The page only learns that
     * from `pointermove`, which it gets only if this window is given mouse
     * input at all: it takes no focus, it is a tool window and it is topmost,
     * and if any one of those ever costs it a mouse message then letting go
     * picks nothing and the gesture looks broken while working perfectly.
     *
     * The OS always knows. Physical pixels, like `ring:at`. */
    let at = app
        .get_webview_window(LABEL)
        .and_then(|window| window.outer_position().ok())
        .zip(cursor())
        .map(|(at, (x, y))| (x - at.x, y - at.y));
    let _ = app.emit_to(LABEL, "ring:commit", at);
}

/// Picked one. The island opens on it, and the ring gets out of the way first.
#[tauri::command]
pub fn ring_pick(app: AppHandle, screen: String) {
    close(&app);
    /* ⚠️ Un-hidden first, for the same reason the palette shortcut does it: a
     * ring that picks a screen on an island which is off screen is a key that
     * appears to do nothing at all. */
    if crate::config::load().chrome_hidden {
        crate::shortcuts::set_chrome_hidden(&app, false);
    }
    /* ⚠️ A VERB goes to its own event. The island answers `island:go` by
     * changing screens, and an action that arrived down the same pipe would
     * have to be told apart by the shape of its name in the one place that is
     * hardest to see — in a listener, at the far end of an IPC hop. */
    if let Some(verb) = screen.strip_prefix("act:") {
        let _ = app.emit_to("tasks", "island:do", verb.to_string());
    } else {
        let _ = app.emit_to("tasks", "island:go", screen);
    }
}

#[cfg(test)]
mod tests {
    /// Not a unit test — the pointer, from this machine.
    /// `cargo test --lib reads_the_cursor -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn reads_the_cursor() {
        let at = super::cursor();
        println!("cursor: {at:?}");
        assert!(at.is_some(), "Windows would not say where the pointer is");
    }
}
