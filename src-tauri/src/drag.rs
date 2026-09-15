//! Dragging the notch along its edge.
//!
//! ⚠️ **The gesture is recognised in the web layer but performed here.** Once
//! the window itself starts moving, the WebView's own `mousemove` stops being
//! reliable — the pointer leaves and re-enters the moving window, and the
//! events arrive with coordinates relative to a frame that has already shifted.
//! So the page only says "this is a drag", and a thread follows the *system*
//! cursor from then on. The same reason `hover.rs` polls `GetCursorPos` rather
//! than listening for mouse events.
//!
//! The notch stays welded to its edge throughout: only the position *along*
//! that edge moves, and it is clamped to the usable area, so a drag can never
//! push it off screen or off the bezel.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, PhysicalPosition};
use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};

use crate::config::Config;
use crate::win::{self, Edge};

pub struct Settings(pub Mutex<Config>);

/// One drag at a time. A second `drag_begin` while the first thread is still
/// following the cursor would give two threads the same window to move.
static DRAGGING: AtomicBool = AtomicBool::new(false);

pub fn is_dragging() -> bool {
    DRAGGING.load(Ordering::SeqCst)
}

/// ⚠️ Shared with `hover.rs`, which watches for a click OUTSIDE the island.
/// One reader of the mouse button, so the two cannot disagree about what "down"
/// means — and the comment about the low bit stays in one place.
pub(crate) fn left_button_down() -> bool {
    // The high bit is "currently down"; the low bit is "pressed since last
    // call" and would latch a release for a frame.
    unsafe { (GetAsyncKeyState(VK_LBUTTON.0 as i32) as u16 & 0x8000) != 0 }
}

#[tauri::command]
pub fn drag_begin(app: AppHandle, window: tauri::WebviewWindow) {
    let label = window.label().to_string();
    if label != "notch" && label != "tasks" {
        return;
    }
    if DRAGGING.swap(true, Ordering::SeqCst) {
        return;
    }

    std::thread::spawn(move || {
        let finish = |app: &AppHandle, moved: bool| {
            DRAGGING.store(false, Ordering::SeqCst);
            let _ = app.emit_to(
                label.as_str(),
                if label == "tasks" {
                    "tasks:drag_end"
                } else {
                    "notch:drag_end"
                },
                moved,
            );
        };

        let Some(window) = app.get_webview_window(&label) else {
            return finish(&app, false);
        };
        let edge = current_for(&app, &label).0;

        let (Ok(start_cursor), Ok(start_position), Ok(size), Some(work)) = (
            app.cursor_position(),
            window.outer_position(),
            window.outer_size(),
            win::work_area(&window),
        ) else {
            return finish(&app, false);
        };

        // Clamp to the usable area along the drag axis; the other axis is the
        // bezel and does not move.
        let vertical = edge.is_vertical();
        let (lo, hi) = if vertical {
            (work.top, work.bottom - size.height as i32)
        } else {
            (work.left, work.right - size.width as i32)
        };
        let hi = hi.max(lo);

        let mut moved = false;
        loop {
            if !left_button_down() {
                break;
            }
            if let Ok(cursor) = app.cursor_position() {
                let next = if vertical {
                    (start_position.y as f64 + (cursor.y - start_cursor.y)).round() as i32
                } else {
                    (start_position.x as f64 + (cursor.x - start_cursor.x)).round() as i32
                };
                let next = next.clamp(lo, hi);
                let target = if vertical {
                    PhysicalPosition::new(start_position.x, next)
                } else {
                    PhysicalPosition::new(next, start_position.y)
                };
                if window.outer_position().map(|p| p != target).unwrap_or(true) {
                    moved = true;
                    let _ = window.set_position(target);
                }
            }
            // ~120 Hz. Fast enough that the notch tracks the pointer rather
            // than trailing it, cheap enough that a drag costs nothing.
            std::thread::sleep(Duration::from_millis(8));
        }

        if moved {
            if let Some(along) = win::along_ratio(&window, edge) {
                if let Ok(mut config) = app.state::<Settings>().0.lock() {
                    if label == "tasks" {
                        config.task_along = along;
                    } else {
                        config.along = along;
                    }
                    crate::config::save(&config);
                }
            }
        }
        finish(&app, moved);
    });
}

/// Put it back in the middle of its edge.
#[tauri::command]
pub fn reset_position(app: AppHandle) {
    let Some(window) = app.get_webview_window("notch") else {
        return;
    };
    {
        let settings = app.state::<Settings>();
        let Ok(mut config) = settings.0.lock() else {
            return;
        };
        config.along = 0.5;
        crate::config::save(&config);
    }
    place_now(&app, &window);
}

/// The edge to draw against, for whoever needs it without the lock ceremony.
pub fn current(app: &AppHandle) -> (Edge, f64) {
    current_for(app, "notch")
}

pub fn current_for(app: &AppHandle, label: &str) -> (Edge, f64) {
    app.state::<Settings>()
        .0
        .lock()
        .map(|c| {
            if label == "tasks" {
                (c.task_edge, c.task_along)
            } else {
                (c.edge, c.along)
            }
        })
        .unwrap_or((Edge::Right, 0.5))
}

/// Which display this window is welded to, if one was chosen.
pub fn monitor_for(app: &AppHandle, label: &str) -> Option<String> {
    app.state::<Settings>()
        .0
        .lock()
        .ok()
        .and_then(|c| {
            if label == "tasks" {
                c.task_monitor.clone()
            } else {
                c.monitor.clone()
            }
        })
}

/// Put a window where the config says it goes — edge, position along it, and
/// display. The one place all three are read together, so no caller can place
/// a window on the right edge of the wrong screen.
pub fn place_now(app: &AppHandle, window: &tauri::WebviewWindow) {
    let label = window.label().to_string();
    let (edge, along) = current_for(app, &label);
    win::place_on(window, edge, along, monitor_for(app, &label).as_deref());
}

/// Send a window to the next display, and remember it.
///
/// Returns the display's name so the caller can say where it went — a window
/// that is click-through and lives on a bezel is easy to lose, and moving it
/// silently to a screen you are not looking at reads as it having vanished.
pub fn next_display(app: &AppHandle, label: &str) -> Option<String> {
    let window = app.get_webview_window(label)?;
    let screens = win::screens();
    if screens.len() < 2 {
        return None;
    }

    let current = monitor_for(app, label)
        .and_then(|id| screens.iter().position(|s| s.id == id))
        .or_else(|| {
            let here = win::screen_of(&window)?;
            screens.iter().position(|s| s.id == here.id)
        })
        .unwrap_or(0);
    let next = &screens[(current + 1) % screens.len()];

    if let Ok(mut config) = app.state::<Settings>().0.lock() {
        if label == "tasks" {
            config.task_monitor = Some(next.id.clone());
        } else {
            config.monitor = Some(next.id.clone());
        }
        crate::config::save(&config);
    }
    place_now(app, &window);
    Some(next.name.clone())
}

/// Re-place both windows whenever the desktop's shape changes.
///
/// ⚠️ There is no event for this here. Win32 sends `WM_DISPLAYCHANGE`, but tao
/// owns the notch's window procedure and Tauri surfaces nothing equivalent — so
/// a monitor being plugged in, a resolution change, or waking from sleep can
/// leave both windows pinned to a bezel that has moved, or off screen entirely,
/// with nothing to notice. Enumerating monitors is a handful of microseconds,
/// so polling it is cheaper than it looks and needs no window procedure.
pub fn watch_displays(app: AppHandle) {
    crate::guard::spawn("display watch", move || {
        let signature = || -> Vec<(String, (i32, i32, i32, i32))> {
            win::screens()
                .into_iter()
                .map(|s| (s.id, (s.work.left, s.work.top, s.work.right, s.work.bottom)))
                .collect()
        };
        let mut last = signature();
        loop {
            std::thread::sleep(Duration::from_secs(3));
            let now = signature();
            if now == last {
                continue;
            }
            last = now;
            crate::sync_display_items(&app);
            let _ = app.emit("notch:displays", crate::get_displays(app.clone()));
            // A drag in flight is the person moving the window by hand; putting
            // it back underneath them would fight the pointer.
            if is_dragging() {
                continue;
            }
            for label in ["notch", "tasks"] {
                if let Some(window) = app.get_webview_window(label) {
                    place_now(&app, &window);
                }
            }
        }
    });
}
