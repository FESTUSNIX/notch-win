//! Accepting a dropped file, without going through Tauri.
//!
//! ⚠️ **Tauri's own drag-and-drop never fires for this window.** Measured, not
//! assumed: the web layer logs every `tauri://drag-*` event it receives, a
//! synthetic `drag-drop` emitted at the same webview arrives and puts the file
//! on the shelf, and a real file dragged from Explorer produces **nothing at
//! all** — not a drop, not an enter, not an over. Whatever wry registers as an
//! OLE drop target is not being found for a window that is layered,
//! click-through, non-activating and undecorated.
//!
//! So the window asks the shell directly. `DragAcceptFiles` is the older and
//! much simpler contract — no `IDataObject`, no `IDropSource`, no modal
//! `DoDragDrop` — and it is exactly the case that matters: a file dragged out
//! of Explorer. The window procedure is subclassed to catch the one message it
//! sends.
//!
//! ⚠️ `DragAcceptFiles` is a **shell registration, not a style bit**, so it
//! survives `set_ignore_cursor_events` rewriting the whole extended-style word
//! — which is the trap `win::harden` exists for. The subclass survives it too.
//!
//! ⚠️ It still obeys hit testing, and this window is a hole almost everywhere.
//! The file has to be dropped on **painted** chrome — the pill, or the open
//! panel — because everywhere else the island genuinely is not there.

use tauri::{AppHandle, Emitter, Manager};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::UI::Shell::{
    DefSubclassProc, DragAcceptFiles, DragFinish, DragQueryFileW, SetWindowSubclass, HDROP,
};
use windows::Win32::UI::WindowsAndMessaging::WM_DROPFILES;

/// Any constant; it only has to be unique among subclasses of this window.
const SUBCLASS_ID: usize = 0x0C0D_E401;

/// The paths out of an `HDROP`.
unsafe fn paths_of(drop: HDROP) -> Vec<String> {
    let mut out = Vec::new();
    unsafe {
        // 0xFFFF_FFFF asks how many there are rather than for one of them.
        let count = DragQueryFileW(drop, 0xFFFF_FFFF, None);
        for index in 0..count {
            let length = DragQueryFileW(drop, index, None) as usize;
            if length == 0 {
                continue;
            }
            let mut buffer = vec![0u16; length + 1];
            let written = DragQueryFileW(drop, index, Some(&mut buffer)) as usize;
            if written > 0 {
                out.push(String::from_utf16_lossy(&buffer[..written]));
            }
        }
    }
    out
}

unsafe extern "system" fn subclass(
    window: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _id: usize,
    data: usize,
) -> LRESULT {
    if message == WM_DROPFILES {
        // ⚠️ Leaked on purpose at install time; it lives as long as the app.
        let app = unsafe { &*(data as *const AppHandle) };
        let drop = HDROP(wparam.0 as *mut std::ffi::c_void);
        let paths = unsafe { paths_of(drop) };
        // ⚠️ Always, even on an empty list. `DragFinish` frees the memory the
        // shell allocated for this drop; skipping it leaks it into the shell's
        // heap for the life of the process.
        unsafe { DragFinish(drop) };

        crate::log::note(&format!("WM_DROPFILES: {} path(s)", paths.len()));
        if !paths.is_empty() {
            crate::shelf::add_paths(app, paths);
            let _ = app.emit_to("tasks", "island:dropped", ());
        }
        return LRESULT(0);
    }
    unsafe { DefSubclassProc(window, message, wparam, lparam) }
}

/// Let files be dropped on a window.
pub fn accept(app: &AppHandle, label: &str) {
    let Some(window) = app.get_webview_window(label) else {
        return;
    };
    let Some(hwnd) = crate::win::hwnd_of(&window) else {
        return;
    };
    // One handle for the life of the process; the subclass proc has no other
    // way to reach the app, and there is nothing to free it at.
    let handle: &'static AppHandle = Box::leak(Box::new(app.clone()));
    unsafe {
        DragAcceptFiles(hwnd, true);
        let ok = SetWindowSubclass(hwnd, Some(subclass), SUBCLASS_ID, handle as *const _ as usize);
        crate::log::note(&format!("drop target on {label}: subclassed={}", ok.as_bool()));
    }
}

#[cfg(test)]
mod tests {
    /// `WM_DROPFILES` is 0x0233 and the shell's contract depends on it; a
    /// mistyped constant here would mean a subclass that quietly forwards
    /// every drop to the default window procedure.
    #[test]
    fn the_message_is_the_one_the_shell_sends() {
        assert_eq!(super::WM_DROPFILES, 0x0233);
    }
}
