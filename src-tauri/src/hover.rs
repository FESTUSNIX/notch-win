//! Hover, without the window ever swallowing a click it shouldn't.
//!
//! The window is transparent and always the expanded size, so most of it is a
//! hole. A window that ignores cursor events also receives no mouse events, so
//! it cannot notice the pointer arriving on its own — the pointer has to be
//! watched from outside. The macOS app has exactly this, as a 0.3s cursor
//! timer in NotchWindowController; this is the same idea against GetCursorPos.
//!
//! The same loop re-checks the work area, because an auto-hiding taskbar
//! revealing or concealing itself raises no event either. One rect comparison
//! per tick, no new machinery — again straight from the macOS controller.

use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use windows::Win32::Foundation::POINT;
use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;

use crate::win;

/// Whether the island is currently standing open as a drop target.
///
/// ⚠️ Set from the web layer, because the web layer is the only part of this
/// app that can see a drag at all. The island is click-through, so it receives
/// no mouse or drag messages until `WS_EX_TRANSPARENT` is cleared — and it is
/// only cleared over the painted pill. So the pill is the doorway: a file
/// crossing it reaches WebView2, WebView2 raises `dragenter` on the page, the
/// page sees `Files` on the transfer and says so here, and the whole window
/// opens up as somewhere to drop.
///
/// This replaced a Shift+click gesture. A modifier could make the window
/// interactive, but it could not tell a file from a stray click, and widening
/// a mostly-invisible 969x388 window on any click is the obstruction bug that
/// had to be reverted once already.
pub static DROP_ZONE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Stand the island open for a drag, or let it close again.
#[tauri::command]
pub fn set_drop_zone(active: bool) {
    use std::sync::atomic::Ordering;
    if DROP_ZONE.swap(active, Ordering::SeqCst) != active {
        crate::log::note(&format!("drop zone: {active}"));
    }
}

/// Fast enough that the notch is already open by the time the pointer lands,
/// slow enough to be free. The pill sits on a screen edge, so it is approached
/// rather than jumped to.
const POLL: Duration = Duration::from_millis(100);

/// A rectangle as the web layer knows it: CSS pixels, relative to the window.
#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize)]
pub struct CssRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Default)]
pub struct InteractiveRects(pub Mutex<std::collections::HashMap<String, Vec<CssRect>>>);

/// `x`/`y` are CSS pixels relative to the window, so the web layer can work out
/// which cell the pointer is over — the same job NotchWindowController's cursor
/// timer does when it sets `model.hoveredIndex`.
#[derive(Clone, Serialize)]
struct HoverPayload {
    hover: bool,
    x: f64,
    y: f64,
}

pub fn spawn(app: AppHandle, label: &'static str) {
    std::thread::spawn(move || {
        // ⚠️ `Option`, not `bool`, and that is load-bearing.
        //
        // Starting at `false` matches the initial not-hovering state, so the
        // first tick sees no change and never calls set_ignore_cursor_events —
        // leaving the window as whatever `setup` managed to make it. In a debug
        // build setup's call sticks and everything looks fine; in a release
        // build it does not, and the notch ships as a 410x373 invisible
        // rectangle that swallows every click at the edge of the screen.
        // Measured: exstyle 0x8040198, no WS_EX_TRANSPARENT, no WS_EX_LAYERED.
        //
        // `None` makes the first tick always apply, so this loop is the single
        // authority on click-through and converges within one poll whatever
        // happened at startup.
        let mut was_hovering: Option<bool> = None;
    let mut was_zone = false;
        let mut last_work: Option<(i32, i32, i32, i32)> = None;

        loop {
            std::thread::sleep(POLL);

            let Some(window) = app.get_webview_window(label) else {
                continue;
            };
            if !window.is_visible().unwrap_or(false) {
                was_hovering = None;
                continue;
            }

            // The taskbar moved, hid or came back: take the space, or give it
            // up. Never while a drag is in flight — re-placing then would fight
            // the pointer for the window every 100ms.
            if let Some(work) = win::work_area(&window) {
                let key = (work.left, work.top, work.right, work.bottom);
                if last_work != Some(key) && !crate::drag::is_dragging() {
                    last_work = Some(key);
                    crate::drag::place_now(&app, &window);
                }
            }

            let mut point = POINT::default();
            if unsafe { GetCursorPos(&mut point) }.is_err() {
                continue;
            }

            let (Ok(origin), Ok(scale)) = (window.outer_position(), window.scale_factor()) else {
                continue;
            };

            let rects = {
                let guard = app.state::<InteractiveRects>();
                let held = guard.0.lock().unwrap();
                held.get(label).cloned().unwrap_or_default()
            };

            // CSS pixels relative to the window -> physical pixels on screen.
            let on_chrome = rects.iter().any(|r| {
                let left = origin.x as f64 + r.x * scale;
                let top = origin.y as f64 + r.y * scale;
                let right = left + r.width * scale;
                let bottom = top + r.height * scale;
                (point.x as f64) >= left
                    && (point.x as f64) < right
                    && (point.y as f64) >= top
                    && (point.y as f64) < bottom
            });

            /* ⚠️ The island is a hole: `WS_EX_TRANSPARENT` is what the shell
             * skips when it looks for something to drop on, and clearing it is
             * the only way this window can be dropped on away from the pill.
             * While a file drag is known to be in flight the whole window
             * counts, so the target is the panel rather than a 260x35 strip. */
            let zone = label == "tasks"
                && DROP_ZONE.load(std::sync::atomic::Ordering::SeqCst);
            let _ = &mut was_zone;
            let hovering = on_chrome || zone;

            /* ⚠️ Hands off while a drag-out is running. `set_ignore_cursor_events`
             * is a tao call that goes through the main thread, and the main
             * thread is inside `DoDragDrop`'s modal loop — so this would queue
             * behind it at best, and at worst rewrite the window's styles from
             * under a drag the shell is in the middle of. */
            if crate::dragout::DRAGGING.load(std::sync::atomic::Ordering::SeqCst) {
                continue;
            }

            let changed = was_hovering != Some(hovering);
            if changed {
                was_hovering = Some(hovering);
                // Interactive only while the pointer is actually over painted
                // chrome; a hole everywhere else. Re-harden immediately after —
                // this call rewrites the whole extended-style word and drops the
                // no-activate and tool-window bits every single time. See
                // win::harden for the measurement.
                let _ = window.set_ignore_cursor_events(!hovering);
                win::harden(&window);
                /* ⚠️ Logged, because this flag is the difference between a
                 * window that can be dropped on and one the shell walks
                 * straight past — and it is invisible from everywhere else. */
                crate::log::note(&format!(
                    "{label}: interactive={hovering} at {},{}",
                    point.x, point.y
                ));
            }

            // While the pointer is on the notch its position keeps flowing, so
            // moving down the stack moves the tooltip from cell to cell.
            if !changed && !hovering {
                continue;
            }

            let _ = app.emit_to(
                label,
                if label == "tasks" {
                    "tasks:hover"
                } else {
                    "notch:hover"
                },
                HoverPayload {
                    hover: hovering,
                    x: (point.x as f64 - origin.x as f64) / scale,
                    y: (point.y as f64 - origin.y as f64) / scale,
                },
            );
        }
    });
}
