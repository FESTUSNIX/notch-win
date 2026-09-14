//! Dragging a file *out* of the island.
//!
//! The shelf takes files in through the page (`dragDropEnabled: false`, see
//! `shelf.rs`), but a page cannot hand a real file *out*: HTML can offer text
//! or a URL, and Explorer wants a `CF_HDROP`. Doing it properly means being an
//! OLE drag source.
//!
//! ⚠️ This is the thing `shelf.rs` says is not worth hand-rolling, and that
//! judgement still stands for the *vtable* version. What makes it reasonable
//! here is that almost none of it has to be written:
//!
//!   * The `IDataObject` comes from the shell. `SHCreateItemFromParsingName`
//!     plus `BindToHandler(BHID_DataObject)` produces one carrying a proper
//!     `CF_HDROP` — nine methods nobody has to implement.
//!   * `IDropSource` is two methods, and `#[implement]` writes the vtable.
//!
//! So the risky part — a hand-maintained COM vtable, which is what makes
//! `IPolicyConfig` the most dangerous code in this tree — does not exist here.
//!
//! ⚠️ `DoDragDrop` runs a **modal message loop** until the drop finishes. It
//! gets its own thread for that reason: on the UI thread it would freeze the
//! island for the length of the drag, and on Tauri's async pool it would hold
//! a worker. The thread is also where `OleInitialize` is called, because the
//! drag source must be in a single-threaded apartment.

use windows::core::{implement, BOOL, HRESULT, HSTRING, PCWSTR};
use windows::Win32::Foundation::{
    DRAGDROP_S_CANCEL, DRAGDROP_S_DROP, DRAGDROP_S_USEDEFAULTCURSORS, S_OK,
};
use windows::Win32::System::Com::IDataObject;
// ⚠️ `MODIFIERKEYS_FLAGS` is in `System::SystemServices`, not beside the mouse
// and keyboard input it describes.
use windows::Win32::System::SystemServices::MODIFIERKEYS_FLAGS;
use windows::Win32::System::Ole::{
    DoDragDrop, IDropSource, IDropSource_Impl, OleInitialize, OleUninitialize, DROPEFFECT,
    DROPEFFECT_COPY, DROPEFFECT_LINK,
};
use windows::Win32::UI::Shell::{BHID_DataObject, IShellItem, SHCreateItemFromParsingName};

/// The two decisions a drag source has to make, and nothing else.
#[implement(IDropSource)]
struct Source;

/// `MK_LBUTTON`. The one bit that ends a drag.
const MK_LBUTTON: u32 = 0x0001;

/// Whether a drag should carry on, drop, or be abandoned.
///
/// ⚠️ A free function so it can be tested, because **this is the rule that
/// decides whether `DoDragDrop` ever returns**. Get the bit wrong and the loop
/// follows the cursor for ever, holding the mouse capture — which does not
/// break the app, it breaks dragging everywhere on the desktop until the
/// process is killed.
pub fn continue_drag(escape: bool, key_state: u32) -> HRESULT {
    if escape {
        return DRAGDROP_S_CANCEL;
    }
    if key_state & MK_LBUTTON == 0 {
        return DRAGDROP_S_DROP;
    }
    S_OK
}

impl IDropSource_Impl for Source_Impl {
    fn QueryContinueDrag(&self, escape: BOOL, key_state: MODIFIERKEYS_FLAGS) -> HRESULT {
        continue_drag(escape.as_bool(), key_state.0)
    }

    /// Let the shell draw its own cursors; there is nothing here worth
    /// replacing them with.
    fn GiveFeedback(&self, _effect: DROPEFFECT) -> HRESULT {
        DRAGDROP_S_USEDEFAULTCURSORS
    }
}

/// The shell's own data object for a path — a real `CF_HDROP`, made by the
/// shell rather than assembled by hand.
fn data_object(path: &str) -> windows::core::Result<IDataObject> {
    unsafe {
        // See `shelf::windows_path`: the shell's parser refuses forward slashes.
        let wide = HSTRING::from(crate::shelf::windows_path(path));
        let item: IShellItem = SHCreateItemFromParsingName(PCWSTR(wide.as_ptr()), None)?;
        item.BindToHandler(None, &BHID_DataObject)
    }
}

/// True while a drag-out is running, so nothing else touches the window.
pub static DRAGGING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Start dragging a file out of the island.
///
/// ⚠️ **On the main thread, and this is not negotiable.** `DoDragDrop` drives
/// its own modal loop out of the *calling thread's* message queue: it pumps
/// messages, and calls `QueryContinueDrag` for each mouse one it sees. A plain
/// worker thread has no message queue and receives no mouse input, so the loop
/// never learns that the button came up and **never returns**. Measured: the
/// first version spawned a thread, the drag did nothing, no completion was
/// ever logged, and the stuck loop held the mouse capture — which broke
/// dragging everywhere else on the desktop until the app was killed.
///
/// Blocking the main thread for the length of a drag is not a compromise
/// either; it is what every Windows app does. The island is busy dragging.
pub fn begin(app: &tauri::AppHandle, path: String) {
    use std::sync::atomic::Ordering;
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        DRAGGING.store(true, Ordering::SeqCst);
        watchdog();
        unsafe {
            // ⚠️ `OleInitialize`, not `CoInitializeEx`: OLE drag and drop needs
            // the full OLE apartment and fails with CO_E_NOTINITIALIZED
            // without it. Already-initialised is fine and is the normal case
            // on the main thread, so the result is deliberately ignored.
            let fresh = OleInitialize(None).is_ok();
            let note = match data_object(&path) {
                Ok(data) => {
                    let source: IDropSource = Source.into();
                    let mut effect = DROPEFFECT::default();
                    let result =
                        DoDragDrop(&data, &source, DROPEFFECT_COPY | DROPEFFECT_LINK, &mut effect);
                    format!("returned {result:?}, effect {:?}", effect.0)
                }
                Err(error) => format!("no data object: {error}"),
            };
            crate::log::note(&format!("drag out {path}: {note}"));
            if fresh {
                OleUninitialize();
            }
        }
        DRAGGING.store(false, Ordering::SeqCst);
        let _ = handle;
    });
}

/// Get out of a drag that has stopped making sense.
///
/// ⚠️ A safety net for the failure that cannot be allowed to happen twice: a
/// `DoDragDrop` that never returns holds the mouse capture, and the desktop
/// stops responding to dragging until the app is killed. Escape is the one
/// thing the loop always listens to — `continue_drag` answers
/// `DRAGDROP_S_CANCEL` for it — so a keystroke after a plainly excessive delay
/// converts "kill the app" into "wait a few seconds".
///
/// Sent only if the drag is *still* running, so an ordinary drag that finished
/// long ago never sees a stray Escape.
fn watchdog() {
    use std::sync::atomic::Ordering;
    std::thread::spawn(|| {
        std::thread::sleep(std::time::Duration::from_secs(12));
        if !DRAGGING.load(Ordering::SeqCst) {
            return;
        }
        crate::log::note("drag out: still running after 12s, cancelling");
        unsafe {
            use windows::Win32::UI::Input::KeyboardAndMouse::*;
            let mut key = INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT { wVk: VK_ESCAPE, ..Default::default() },
                },
            };
            SendInput(&[key], std::mem::size_of::<INPUT>() as i32);
            key.Anonymous.ki.dwFlags = KEYEVENTF_KEYUP;
            SendInput(&[key], std::mem::size_of::<INPUT>() as i32);
        }
    });
}

#[tauri::command]
pub fn shelf_drag(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let item = crate::shelf::find_item(&app, &id).ok_or("That is no longer on the shelf.")?;
    let path = item.path.ok_or("Only a file can be dragged out.")?;
    if !std::path::Path::new(&path).exists() {
        return Err(format!("{} has moved or been deleted.", item.name));
    }
    begin(&app, path);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The shell has to be able to make a data object for the path, or the
    /// drag cannot start at all.
    ///
    /// ⚠️ This is where `E_INVALIDARG` came from the first time: the path had
    /// forward slashes, which `std::fs` and `ShellExecute` both accept and
    /// `SHCreateItemFromParsingName` does not. Nothing downstream of here can
    /// tell you that; the drag simply never begins.
    ///
    /// `cargo test --lib dragout -- --ignored --nocapture`
    /// The rule that decides whether the loop ever ends.
    #[test]
    fn a_released_button_ends_the_drag() {
        // Button still down: keep going.
        assert_eq!(continue_drag(false, MK_LBUTTON), S_OK);
        // Released: drop. This is the one that stops the loop.
        assert_eq!(continue_drag(false, 0), DRAGDROP_S_DROP);
        // Released, with other modifiers still held.
        assert_eq!(continue_drag(false, 0x0004 | 0x0008), DRAGDROP_S_DROP);
        // Escape always wins, button or no button.
        assert_eq!(continue_drag(true, MK_LBUTTON), DRAGDROP_S_CANCEL);
        assert_eq!(continue_drag(true, 0), DRAGDROP_S_CANCEL);
    }

    #[test]
    #[ignore]
    fn the_shell_makes_a_data_object_for_a_real_file() {
        unsafe {
            OleInitialize(None).unwrap();
        }
        let path = r"C:\Windows\System32\drivers\etc\hosts";
        assert!(data_object(path).is_ok(), "backslashes");
        // The spelling the uri-list branch produces, which used to fail.
        let slashed = "C:/Windows/System32/drivers/etc/hosts";
        assert!(
            data_object(&crate::shelf::windows_path(slashed)).is_ok(),
            "normalised forward slashes"
        );
        // Either spelling, because `data_object` normalises before it parses.
        // Belt and braces: the shelf stores backslashes too, but a path can
        // reach here from a uri-list without passing through the shelf.
        assert!(data_object(slashed).is_ok(), "raw forward slashes, normalised inside");
        println!("shell data objects: ok");
        unsafe { OleUninitialize() };
    }
}
