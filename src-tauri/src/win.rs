//! The Win32 half of the notch window.
//!
//! Three things AppKit gave the macOS panel for free, which have to be asked
//! for by hand here:
//!
//!   * `.nonactivatingPanel` -> `WS_EX_NOACTIVATE`. Glancing at your usage must
//!     never take focus off what you were doing.
//!   * a panel that is not an app -> `WS_EX_TOOLWINDOW`, which also keeps it
//!     out of Alt-Tab.
//!   * `level = .statusBar` -> `HWND_TOPMOST`.
//!
//! And one that is a direct analogue rather than a workaround: `visibleFrame`,
//! the usable area that excludes the Dock, is `MONITORINFO.rcWork`, which
//! excludes the taskbar and tracks it when it auto-hides or moves.

use std::ffi::c_void;

use tauri::{PhysicalPosition, WebviewWindow};
use windows::Win32::Foundation::{HWND, RECT};
use windows::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetWindowLongPtrW, SetWindowLongPtrW, SetWindowPos, GWL_EXSTYLE, HWND_TOPMOST, SWP_NOACTIVATE,
    SWP_NOMOVE, SWP_NOSIZE, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Edge {
    Top,
    Bottom,
    Left,
    #[default]
    Right,
}

impl Edge {
    pub fn is_vertical(self) -> bool {
        matches!(self, Edge::Left | Edge::Right)
    }
}

/// Tauri and this crate may not agree on a `windows` version, and `HWND` has
/// changed shape between them. The raw handle is the one thing both spell the
/// same, so round-trip through it rather than through the type.
pub fn hwnd_of(window: &WebviewWindow) -> Option<HWND> {
    window.hwnd().ok().map(|h| HWND(h.0 as *mut c_void))
}

/// Extended styles AppKit would have implied.
///
/// ⚠️ **Must be re-applied after every `set_ignore_cursor_events` call**, which
/// is not belt-and-braces: tao implements click-through by rewriting the whole
/// extended-style word, so a toggle silently drops any bit set behind its back.
/// Measured — after one toggle the window read back `0xC0138`: topmost and
/// layered survived because tao sets those itself, while `WS_EX_NOACTIVATE` and
/// `WS_EX_TOOLWINDOW` were gone. The notch then steals focus on click and
/// reappears in Alt-Tab, with nothing in any log to say why.
pub fn harden(window: &WebviewWindow) {
    let Some(hwnd) = hwnd_of(window) else { return };

    unsafe {
        let current = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
        let next = current | WS_EX_NOACTIVATE.0 | WS_EX_TOOLWINDOW.0;
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, next as isize);

        // Topmost is set through SetWindowPos rather than the style bit —
        // the bit alone does not re-order an existing window.
        let _ = SetWindowPos(
            hwnd,
            Some(HWND_TOPMOST),
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        );
    }
}

/// The usable rectangle of the monitor the window is on, in physical pixels.
/// This is `NSScreen.visibleFrame`'s counterpart: it already excludes the
/// taskbar, and it changes when the taskbar hides, moves or resizes.
pub fn work_area(window: &WebviewWindow) -> Option<RECT> {
    let hwnd = hwnd_of(window)?;

    unsafe {
        let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if GetMonitorInfoW(monitor, &mut info).as_bool() {
            Some(info.rcWork)
        } else {
            None
        }
    }
}

/// Pin the window to one edge of the usable area, `along` of the way down (or
/// across) it. 0.5 is centred; a drag writes the ratio back to the config.
///
/// The window is always its *expanded* size — folding is drawn inside it, so
/// the OS window never resizes mid-animation. That is the same bargain the
/// AppKit panel makes, and it is why mouse events are masked per-rect instead.
pub fn place(window: &WebviewWindow, edge: Edge, along: f64) {
    let Some(work) = work_area(window) else { return };
    let Ok(size) = window.outer_size() else { return };

    let (w, h) = (size.width as i32, size.height as i32);
    let work_w = work.right - work.left;
    let work_h = work.bottom - work.top;
    let along = along.clamp(0.0, 1.0);

    // The ratio positions the window's *centre*, so a notch dragged to the top
    // ends flush with the work area rather than half off it.
    let slide = |span: i32, size: i32| -> i32 {
        let travel = (span - size).max(0);
        ((travel as f64) * along).round() as i32
    };

    let (x, y) = match edge {
        Edge::Top => (work.left + slide(work_w, w), work.top),
        Edge::Bottom => (work.left + slide(work_w, w), work.bottom - h),
        Edge::Left => (work.left, work.top + slide(work_h, h)),
        Edge::Right => (work.right - w, work.top + slide(work_h, h)),
    };

    let _ = window.set_position(PhysicalPosition::new(x, y));
}

/// Where the window currently sits along its edge, as the ratio `place` takes.
/// Inverting the same maths rather than a second formula, so a drag round-trips
/// to exactly the position it was dropped at.
pub fn along_ratio(window: &WebviewWindow, edge: Edge) -> Option<f64> {
    let work = work_area(window)?;
    let size = window.outer_size().ok()?;
    let position = window.outer_position().ok()?;

    let (span, extent, offset) = if edge.is_vertical() {
        (
            work.bottom - work.top,
            size.height as i32,
            position.y - work.top,
        )
    } else {
        (
            work.right - work.left,
            size.width as i32,
            position.x - work.left,
        )
    };

    let travel = (span - extent).max(0);
    if travel == 0 {
        return Some(0.5);
    }
    Some((offset as f64 / travel as f64).clamp(0.0, 1.0))
}
