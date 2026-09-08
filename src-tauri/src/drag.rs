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

fn left_button_down() -> bool {
    // The high bit is "currently down"; the low bit is "pressed since last
    // call" and would latch a release for a frame.
    unsafe { (GetAsyncKeyState(VK_LBUTTON.0 as i32) as u16 & 0x8000) != 0 }
}

#[tauri::command]
pub fn drag_begin(app: AppHandle) {
    if DRAGGING.swap(true, Ordering::SeqCst) {
        return;
    }

    std::thread::spawn(move || {
        let finish = |app: &AppHandle, moved: bool| {
            DRAGGING.store(false, Ordering::SeqCst);
            let _ = app.emit("notch:drag_end", moved);
        };

        let Some(window) = app.get_webview_window("notch") else {
            return finish(&app, false);
        };
        let edge = app.state::<Settings>().0.lock().map(|c| c.edge).unwrap_or_default();

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
                    config.along = along;
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
    let settings = app.state::<Settings>();
    let edge = {
        let Ok(mut config) = settings.0.lock() else {
            return;
        };
        config.along = 0.5;
        crate::config::save(&config);
        config.edge
    };
    win::place(&window, edge, 0.5);
}

/// The edge to draw against, for whoever needs it without the lock ceremony.
pub fn current(app: &AppHandle) -> (Edge, f64) {
    app.state::<Settings>()
        .0
        .lock()
        .map(|c| (c.edge, c.along))
        .unwrap_or((Edge::Right, 0.5))
}
