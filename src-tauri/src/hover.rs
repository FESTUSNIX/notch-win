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
            let hovering = rects.iter().any(|r| {
                let left = origin.x as f64 + r.x * scale;
                let top = origin.y as f64 + r.y * scale;
                let right = left + r.width * scale;
                let bottom = top + r.height * scale;
                (point.x as f64) >= left
                    && (point.x as f64) < right
                    && (point.y as f64) >= top
                    && (point.y as f64) < bottom
            });

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
