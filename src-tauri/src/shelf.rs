//! A place to put a thing down.
//!
//! Drag a file onto the island and it parks there; press `Ctrl+Alt+S` and
//! whatever is on the clipboard parks there. Later you take it out again —
//! into Explorer, a Slack message, an upload field — wherever you were going
//! with it.
//!
//! ⚠️ **Files are referenced, never copied.** A shelf that copied would
//! duplicate a 2 GB video to park it for ten minutes, and would then hold a
//! stale copy of a file you kept editing. The cost of that choice is that a
//! shelved file can be moved or deleted behind the shelf's back, so every item
//! is checked before it is offered and shown as missing rather than failing
//! when it is used.
//!
//! ⚠️ **Three drop mechanisms were tried before the one that works**, and the
//! symptom that settled it was a **no-drop cursor**: the circle-slash means the
//! window *is* being targeted and something is refusing, not that the shell is
//! walking past it.
//!
//!   1. Tauri's `tauri://drag-*` events never fired once, for any real drag.
//!   2. `DragAcceptFiles` + a `WM_DROPFILES` subclass on the window: provable
//!      by posting the message by hand, and never reached by a real drag —
//!      WebView2 registers an OLE drop target on its own **child** window, the
//!      drag loop finds that first, and the parent's shell registration is
//!      never consulted. That code is deleted; it fired zero times.
//!   3. So WebView2 keeps it (`dragDropEnabled: false` on the tasks window)
//!      and the page handles the drop. `preventDefault()` on **both**
//!      `dragenter` and `dragover` is what turns the circle-slash into a copy
//!      cursor and lets `drop` fire.
//!
//! ⚠️ **Taking a file OUT by CLIPBOARD, beside the drag.** Dragging a real
//! file *out* of a WebView is not something HTML can do — the browser can only
//! offer text or a URL, and Explorer wants a `CF_HDROP`. Doing it properly
//! means becoming an OLE drag source: a hand-written `IDataObject` and
//! `IDropSource`, and a modal `DoDragDrop` running its own message loop inside
//! a window that is click-through and non-activating. That is the same class of
//! hand-rolled COM as `IPolicyConfig`, which is the most dangerous code in this
//! tree, for a gesture that is awkward from a 35px strip anyway. Putting the
//! file on the clipboard is one documented call, it pastes into Explorer, Slack,
//! a browser upload and everything else, and it cannot crash the message loop.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

const FILE: &str = "shelf.json";
/// Enough to be a shelf, few enough that it never becomes a filing system.
const LIMIT: usize = 40;
/// Named rather than written, so no patch tool can eat it. See AGENTS.md.
const SEP: char = '\\';

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub id: String,
    /// `file`, `text` or `link`. The web layer picks an icon from this.
    pub kind: String,
    /// What to show. A file's name, or the first line of the text.
    pub name: String,
    /// Set for `file`.
    #[serde(default)]
    pub path: Option<String>,
    /// Set for `text` and `link`.
    #[serde(default)]
    pub text: Option<String>,
    pub added_ms: i64,
    /// Recomputed on every read, never trusted from the file.
    #[serde(default, skip_deserializing)]
    pub missing: bool,
    /// Bytes, for files that are still there.
    #[serde(default)]
    pub size: u64,
}

#[derive(Default)]
pub struct Store(pub std::sync::Mutex<Vec<Item>>);

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn id_for(seed: &str) -> String {
    // Enough to tell two items apart within one shelf; not a security boundary.
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in seed.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

/// Windows' own spelling of a path.
///
/// ⚠️ Forward slashes work for opening a file and for `std::fs`, and **do not**
/// work for the shell's parser: `SHCreateItemFromParsingName` answers
/// `E_INVALIDARG` for `C:/Windows/.../hosts` and the drag never starts. Paths
/// arrive here from three places — a uri-list, a clipboard `CF_HDROP`, and the
/// app's own drop folder — and only one of them is guaranteed to use
/// backslashes, so they are normalised on the way in and on the way out.
pub fn windows_path(path: &str) -> String {
    path.replace('/', &SEP.to_string())
}

/// A short label for something pasted. ⚠️ Not the whole text: a shelf row is
/// one line, and a pasted stack trace would otherwise be the row.
pub fn label_for(text: &str) -> String {
    let first = text.lines().find(|line| !line.trim().is_empty()).unwrap_or("").trim();
    let mut label: String = first.chars().take(70).collect();
    if first.chars().count() > 70 {
        label.push('…');
    }
    if label.is_empty() {
        "Empty note".to_string()
    } else {
        label
    }
}

/// Does this look like something to open rather than something to read?
pub fn is_link(text: &str) -> bool {
    let trimmed = text.trim();
    !trimmed.contains(char::is_whitespace)
        && (trimmed.starts_with("http://") || trimmed.starts_with("https://"))
}

fn refresh(items: &mut [Item]) {
    for item in items.iter_mut() {
        match item.path.as_deref() {
            Some(path) => match std::fs::metadata(path) {
                Ok(meta) => {
                    item.missing = false;
                    item.size = meta.len();
                }
                // Moved or deleted behind the shelf's back, which is the price
                // of referencing rather than copying.
                Err(_) => {
                    item.missing = true;
                    item.size = 0;
                }
            },
            None => item.missing = false,
        }
    }
}

fn publish(app: &AppHandle, items: &[Item]) {
    crate::log::note(&format!("shelf: {} item(s)", items.len()));
    crate::config::save_beside(FILE, &items.to_vec());
    let _ = app.emit("notch:shelf", items.to_vec());
}

pub fn load(app: &AppHandle) {
    let mut stored: Vec<Item> = crate::config::load_beside(FILE).unwrap_or_default();
    refresh(&mut stored);
    if let Ok(mut items) = app.state::<Store>().0.lock() {
        *items = stored;
    }
}

#[tauri::command]
pub fn get_shelf(app: AppHandle) -> Vec<Item> {
    let state = app.state::<Store>();
    let Ok(mut items) = state.0.lock() else {
        return Vec::new();
    };
    refresh(&mut items);
    items.clone()
}

/// Put paths on the shelf. Newest first, and the same path twice moves it up
/// rather than appearing twice.
pub fn add_paths(app: &AppHandle, paths: Vec<String>) -> usize {
    let snapshot = {
        let state = app.state::<Store>();
        let Ok(mut items) = state.0.lock() else { return 0 };
        for path in paths.iter().rev() {
            if path.trim().is_empty() {
                continue;
            }
            let path = &windows_path(path);
            let name = Path::new(path)
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| path.clone());
            items.retain(|item| item.path.as_deref() != Some(path.as_str()));
            items.insert(
                0,
                Item {
                    id: id_for(path),
                    kind: "file".into(),
                    name,
                    path: Some(path.clone()),
                    text: None,
                    added_ms: now_ms(),
                    missing: false,
                    size: 0,
                },
            );
        }
        items.truncate(LIMIT);
        refresh(&mut items);
        items.clone()
    };
    publish(app, &snapshot);
    snapshot.len()
}

pub fn add_text(app: &AppHandle, text: String) -> bool {
    if text.trim().is_empty() {
        return false;
    }
    let snapshot = {
        let state = app.state::<Store>();
        let Ok(mut items) = state.0.lock() else { return false };
        items.retain(|item| item.text.as_deref() != Some(text.as_str()));
        items.insert(
            0,
            Item {
                id: id_for(&text),
                kind: if is_link(&text) { "link".into() } else { "text".into() },
                name: label_for(&text),
                path: None,
                text: Some(text),
                added_ms: now_ms(),
                missing: false,
                size: 0,
            },
        );
        items.truncate(LIMIT);
        items.clone()
    };
    publish(app, &snapshot);
    true
}

#[tauri::command]
pub fn shelf_add_paths(app: AppHandle, paths: Vec<String>) -> usize {
    add_paths(&app, paths)
}

#[tauri::command]
pub fn shelf_add_text(app: AppHandle, text: String) -> bool {
    add_text(&app, text)
}

/// A small picture of one shelved file, for the card to show.
///
/// ⚠️ By ID, never by path. The WebView asks for something it can already
/// see and gets a PNG back; it cannot name a file of its own, so nothing here
/// can be turned into "read that one instead". See `thumbs.rs` on why the
/// asset protocol was not the answer.
///
/// ⚠️ And it answers `None` for anything that is not a real file on disk.
/// A shelved link or scrap of text has no path, and a file that has moved has
/// one that no longer resolves — the card draws its glyph in both cases.
#[tauri::command]
pub fn shelf_thumb(app: AppHandle, id: String) -> Option<String> {
    let path = {
        let state = app.state::<Store>();
        let items = state.0.lock().ok()?;
        let item = items.iter().find(|one| one.id == id)?;
        if item.kind != "file" || item.missing {
            return None;
        }
        item.path.clone()?
    };
    crate::thumbs::of(&path)
}

#[tauri::command]
pub fn shelf_remove(app: AppHandle, id: String) {
    let snapshot = {
        let state = app.state::<Store>();
        let Ok(mut items) = state.0.lock() else { return };
        if id.is_empty() {
            items.clear();
        } else {
            items.retain(|item| item.id != id);
        }
        items.clone()
    };
    publish(&app, &snapshot);
}

/// Shared with `dragout.rs`, which needs the path before it can start a drag.
pub fn find_item(app: &AppHandle, id: &str) -> Option<Item> {
    find(app, id)
}

fn find(app: &AppHandle, id: &str) -> Option<Item> {
    let state = app.state::<Store>();
    let items = state.0.lock().ok()?;
    items.iter().find(|item| item.id == id).cloned()
}

/// Take it out: onto the clipboard, as the real thing.
///
/// A file goes on as `CF_HDROP`, which is what Explorer, Slack, a browser
/// upload field and every other paste target expects — so Ctrl+V pastes the
/// file, not its name.
/// Put a piece of text on the clipboard without parking it on the shelf.
///
/// ⚠️ Deliberately NOT `navigator.clipboard.writeText`. The island runs
/// `WS_EX_NOACTIVATE` and the palette hands the caret back before an action
/// runs, so by the time a copy happens the document is very often not focused —
/// and the web clipboard API rejects on an unfocused document, silently, in a
/// promise nobody is awaiting. The Win32 path does not care who has focus.
#[tauri::command]
pub fn copy_text(text: String) -> Result<(), String> {
    clipboard::set_text(&text)
}

#[tauri::command]
pub fn shelf_copy(app: AppHandle, id: String) -> Result<(), String> {
    let item = find(&app, &id).ok_or("That is no longer on the shelf.")?;
    match item.path {
        Some(path) => {
            if !Path::new(&path).exists() {
                return Err(format!("{} has moved or been deleted.", item.name));
            }
            clipboard::set_files(&[PathBuf::from(path)])
        }
        None => clipboard::set_text(item.text.as_deref().unwrap_or_default()),
    }
}

#[tauri::command]
pub fn shelf_open(app: AppHandle, id: String) -> Result<(), String> {
    let item = find(&app, &id).ok_or("That is no longer on the shelf.")?;
    let target = match (&item.path, &item.text) {
        (Some(path), _) => path.clone(),
        (None, Some(text)) if is_link(text) => text.clone(),
        _ => return Err("There is nothing to open.".into()),
    };
    crate::calendar::open_path(&target)
}

/// Show it where it lives. `/select,` highlights the file in its folder rather
/// than opening the file itself.
#[tauri::command]
pub fn shelf_reveal(app: AppHandle, id: String) -> Result<(), String> {
    let item = find(&app, &id).ok_or("That is no longer on the shelf.")?;
    let path = item.path.ok_or("That is not a file.")?;
    if !Path::new(&path).exists() {
        return Err(format!("{} has moved or been deleted.", item.name));
    }
    crate::calendar::explore(&path)
}

/// Whatever is on the clipboard, onto the shelf. What `Ctrl+Alt+S` calls.
#[tauri::command]
pub fn shelf_capture(app: AppHandle) -> Result<String, String> {
    let files = clipboard::get_files();
    if !files.is_empty() {
        let count = files.len();
        add_paths(&app, files);
        return Ok(if count == 1 { "1 file".into() } else { format!("{count} files") });
    }
    match clipboard::get_text() {
        Some(text) if !text.trim().is_empty() => {
            let link = is_link(&text);
            add_text(&app, text);
            Ok(if link { "Link".into() } else { "Note".into() })
        }
        _ => Err("The clipboard is empty.".into()),
    }
}

/* ── The clipboard ────────────────────────────────────────────────────────
 *
 * Win32 directly rather than a crate: the only unusual thing here is
 * `CF_HDROP`, which the clipboard crates either do not offer or offer only for
 * reading, and it is the whole reason this module exists.
 */
pub mod clipboard {
    use std::path::PathBuf;

    // ⚠️ `GlobalFree` is in `Foundation`, not beside GlobalAlloc/Lock/Unlock
    // in `System::Memory`.
    use windows::Win32::Foundation::{GlobalFree, HANDLE, HGLOBAL, HWND};
    use windows::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, GetClipboardData, OpenClipboard, SetClipboardData,
    };
    use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
    use windows::Win32::System::Ole::{CF_HDROP, CF_UNICODETEXT};
    use windows::Win32::UI::Shell::{DragQueryFileW, DROPFILES, HDROP};

    /// ⚠️ Every path out of here closes the clipboard. Leaving it open locks it
    /// for the whole desktop — nothing else on the machine can copy or paste
    /// until this process exits, and there is no error anywhere to say why.
    struct Clipboard;

    impl Clipboard {
        fn open() -> Option<Self> {
            unsafe { OpenClipboard(Some(HWND::default())).ok().map(|_| Clipboard) }
        }
    }

    impl Drop for Clipboard {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseClipboard();
            }
        }
    }

    /// A `DROPFILES` header followed by the paths, each NUL-terminated, and a
    /// second NUL to end the list.
    fn hdrop_bytes(paths: &[PathBuf]) -> Vec<u8> {
        let header = std::mem::size_of::<DROPFILES>();
        let mut wide: Vec<u16> = Vec::new();
        for path in paths {
            wide.extend(path.as_os_str().encode_wide());
            wide.push(0);
        }
        // ⚠️ The list terminator. Without it the receiver keeps reading past
        // the buffer looking for the next path.
        wide.push(0);

        let mut bytes = vec![0u8; header + wide.len() * 2];
        let drop_files = DROPFILES {
            pFiles: header as u32,
            fWide: true.into(),
            ..Default::default()
        };
        unsafe {
            std::ptr::copy_nonoverlapping(
                &drop_files as *const DROPFILES as *const u8,
                bytes.as_mut_ptr(),
                header,
            );
            std::ptr::copy_nonoverlapping(
                wide.as_ptr() as *const u8,
                bytes.as_mut_ptr().add(header),
                wide.len() * 2,
            );
        }
        bytes
    }

    use std::os::windows::ffi::OsStrExt;

    /// ⚠️ The handle is **given away**, not lent. Once `SetClipboardData`
    /// succeeds the clipboard owns that global block and freeing it here is a
    /// double free; if it *fails*, nobody owns it and not freeing it leaks.
    unsafe fn put(format: u16, bytes: &[u8]) -> Result<(), String> {
        unsafe {
            let handle: HGLOBAL =
                GlobalAlloc(GMEM_MOVEABLE, bytes.len()).map_err(|_| "Out of memory.".to_string())?;
            let target = GlobalLock(handle);
            if target.is_null() {
                let _ = GlobalFree(Some(handle));
                return Err("Could not lock the clipboard buffer.".into());
            }
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), target as *mut u8, bytes.len());
            let _ = GlobalUnlock(handle);
            SetClipboardData(format as u32, Some(HANDLE(handle.0)))
                .map_err(|_| {
                    let _ = GlobalFree(Some(handle));
                    "Windows would not take it.".to_string()
                })
                .map(|_| ())
        }
    }

    pub fn set_files(paths: &[PathBuf]) -> Result<(), String> {
        let _guard = Clipboard::open().ok_or("Something else is holding the clipboard.")?;
        unsafe {
            EmptyClipboard().map_err(|_| "Could not clear the clipboard.".to_string())?;
            put(CF_HDROP.0, &hdrop_bytes(paths))
        }
    }

    pub fn set_text(text: &str) -> Result<(), String> {
        let _guard = Clipboard::open().ok_or("Something else is holding the clipboard.")?;
        let wide: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
        let bytes: Vec<u8> = wide.iter().flat_map(|unit| unit.to_le_bytes()).collect();
        unsafe {
            EmptyClipboard().map_err(|_| "Could not clear the clipboard.".to_string())?;
            put(CF_UNICODETEXT.0, &bytes)
        }
    }

    pub fn get_files() -> Vec<String> {
        let Some(_guard) = Clipboard::open() else {
            return Vec::new();
        };
        let mut out = Vec::new();
        unsafe {
            let Ok(handle) = GetClipboardData(CF_HDROP.0 as u32) else {
                return out;
            };
            let drop = HDROP(handle.0);
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

    pub fn get_text() -> Option<String> {
        let _guard = Clipboard::open()?;
        unsafe {
            let handle = GetClipboardData(CF_UNICODETEXT.0 as u32).ok()?;
            let block = HGLOBAL(handle.0);
            let pointer = GlobalLock(block) as *const u16;
            if pointer.is_null() {
                return None;
            }
            let mut length = 0usize;
            while *pointer.add(length) != 0 && length < 1_000_000 {
                length += 1;
            }
            let text = String::from_utf16_lossy(std::slice::from_raw_parts(pointer, length));
            let _ = GlobalUnlock(block);
            Some(text)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Written this way so no patch tool can eat it. See AGENTS.md.
    const SEPS: &str = "\\";

    #[test]
    fn a_pasted_wall_of_text_is_one_line_on_the_shelf() {
        let stack = "Traceback (most recent call last):\n  File \"x.py\", line 1\n    boom";
        assert_eq!(label_for(stack), "Traceback (most recent call last):");
        // Leading blank lines are not the label.
        assert_eq!(label_for("\n\n  hello  "), "hello");
        assert_eq!(label_for("   "), "Empty note");
        let long = "a".repeat(200);
        assert_eq!(label_for(&long).chars().count(), 71);
    }

    #[test]
    fn a_path_is_normalised_for_the_shell() {
        /* ⚠️ The shell's parser answers E_INVALIDARG for forward slashes, so a
         * file dropped as a `file:///C:/...` uri-list could be opened and
         * copied but never dragged back out. */
        let want = "C:".to_owned() + SEPS + "Windows" + SEPS + "System32" + SEPS + "drivers" + SEPS + "etc" + SEPS + "hosts";
        assert_eq!(windows_path("C:/Windows/System32/drivers/etc/hosts"), want);
        assert_eq!(windows_path(&want), want);
    }

    #[test]
    fn a_link_is_something_to_open_and_a_sentence_is_not() {
        assert!(is_link("https://open-meteo.com/en/docs"));
        assert!(is_link("http://localhost:1420/"));
        // A sentence that happens to mention a URL is a note, not a link.
        assert!(!is_link("see https://example.com for details"));
        assert!(!is_link("just some words"));
        assert!(!is_link(""));
    }

    #[test]
    fn a_file_that_has_gone_is_marked_missing_rather_than_dropped() {
        // Referencing rather than copying is what makes this possible at all,
        // so the shelf has to be honest about it instead of failing on use.
        let mut items = vec![Item {
            id: "x".into(),
            kind: "file".into(),
            name: "gone.txt".into(),
            path: Some(r"C:\definitely\not\here\gone.txt".into()),
            text: None,
            added_ms: 0,
            missing: false,
            size: 99,
        }];
        refresh(&mut items);
        assert!(items[0].missing);
        assert_eq!(items[0].size, 0);
    }

    /// A real round trip through the Windows clipboard.
    /// `cargo test --lib shelf -- --ignored --nocapture`
    ///
    /// ⚠️ Ignored because it takes the machine's clipboard, which would throw
    /// away whatever the person running the tests had copied.
    #[test]
    #[ignore]
    fn puts_a_real_file_on_the_clipboard_and_reads_it_back() {
        let dir = std::env::temp_dir().join("codenotch-shelf-test");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("shelved.txt");
        std::fs::write(&path, b"hello").unwrap();

        clipboard::set_files(&[path.clone()]).unwrap();
        let back = clipboard::get_files();
        println!("read back: {back:?}");
        assert_eq!(back.len(), 1);
        assert_eq!(PathBuf::from(&back[0]), path);
        assert!(Path::new(&back[0]).exists());

        clipboard::set_text("shelf round trip").unwrap();
        assert_eq!(clipboard::get_text().as_deref(), Some("shelf round trip"));
        // …and text on the clipboard must not read back as a file.
        assert!(clipboard::get_files().is_empty());
        let _ = std::fs::remove_file(&path);
    }
}

/// Take the *bytes* of a dropped file, when no path could be had.
///
/// ⚠️ This **copies**, which the shelf otherwise never does — see the note at
/// the top of this file. It exists only because a browser `File` has no path
/// by design, so a drop that arrives through the page rather than through the
/// shell has nothing else to offer. The copy goes in the app's own folder, so
/// the reference the shelf then holds is one it is allowed to rely on.
#[tauri::command]
pub fn shelf_add_bytes(app: AppHandle, name: String, bytes: Vec<u8>) -> Result<(), String> {
    let safe: String = name
        .chars()
        .filter(|c| !matches!(c, '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|') && *c != SEP)
        .collect();
    let safe = if safe.trim().is_empty() { "dropped".to_string() } else { safe };
    let dir = crate::config::beside("dropped").ok_or("There is nowhere to keep it.")?;
    std::fs::create_dir_all(&dir).map_err(|_| "Could not make the drop folder.".to_string())?;

    // Never overwrite something already parked under the same name.
    let mut target = dir.join(&safe);
    let mut n = 1;
    while target.exists() {
        let stem = Path::new(&safe)
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        let ext = Path::new(&safe)
            .extension()
            .map(|e| format!(".{}", e.to_string_lossy()))
            .unwrap_or_default();
        target = dir.join(format!("{stem} ({n}){ext}"));
        n += 1;
    }
    std::fs::write(&target, bytes).map_err(|_| "Could not write it.".to_string())?;
    crate::log::note(&format!("shelf: copied bytes to {}", target.display()));
    add_paths(&app, vec![target.to_string_lossy().into_owned()]);
    Ok(())
}
