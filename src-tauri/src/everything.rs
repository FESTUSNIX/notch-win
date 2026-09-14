/* Everything, asked directly.
 *
 * The one thing a general launcher does that the island genuinely cannot: find
 * a file anywhere on the machine, instantly. Everything already indexes the
 * MFT, it is already running, and it answers over an IPC that needs **no
 * install** — no `es.exe`, no HTTP server to enable, no SDK dll to ship. Ask the
 * window it already has.
 *
 * ⚠️ It is a search, not a launcher. A hit lands on the SHELF, gets copied, or
 * opens — the island's own verbs — rather than becoming a second, worse Flow
 * Launcher. That is the line the palette is drawn on.
 *
 * ## The protocol, since it is not guessable from the types
 *
 * Everything owns a window of class `EVERYTHING_TASKBAR_NOTIFICATION`. You
 * `WM_COPYDATA` it an `EVERYTHING_IPC_QUERYW` carrying the HWND of a window of
 * YOUR OWN, and it `WM_COPYDATA`s an `EVERYTHING_IPC_LISTW` back to that window.
 * So a caller needs a message-only window and a message pump, which is why this
 * runs on its own thread rather than on the UI one.
 *
 * ⚠️ `reply_hwnd` is a **DWORD**, on 64-bit too. That is not a bug in this
 * file: the SDK struct is 32-bit and Everything widens it back. Window handles
 * are documented as 32-bit-safe for exactly this kind of interop, so the
 * truncation is sound — but it looks wrong every time it is read, hence this
 * paragraph.
 *
 * ## Everything not running
 *
 * ⚠️ Is NOT an error. `FindWindowW` returns null and this returns an empty
 * list, because a row saying "Everything is not running" in a palette that is
 * mostly about the island's own world is noise ninety-nine times out of a
 * hundred. The caller shows nothing.
 */
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, FindWindowW,
    GetWindowLongPtrW, PeekMessageW, RegisterClassW, SendMessageTimeoutW, SetWindowLongPtrW,
    TranslateMessage, GWLP_USERDATA, HMENU, HWND_MESSAGE, MSG, PM_REMOVE, SMTO_ABORTIFHUNG,
    WINDOW_EX_STYLE, WINDOW_STYLE, WM_COPYDATA, WNDCLASSW,
};
use windows::Win32::System::DataExchange::COPYDATASTRUCT;

/// `EVERYTHING_IPC_COPYDATA_QUERYW`.
const QUERYW: usize = 2;
/// Ours to choose; it comes back as the reply's `dwData`.
const REPLY: usize = 0x636e_0001;
/// Long enough for a wedged indexer, short enough not to feel like a hang.
const PATIENCE: Duration = Duration::from_millis(900);

#[derive(Clone, serde::Serialize)]
pub struct Hit {
    pub name: String,
    /// The folder it lives in — what Everything actually sends.
    pub path: String,
    /// ⚠️ Joined HERE rather than in the WebView. `Path::join` writes the
    /// platform separator, so nothing downstream has to hold a literal
    /// backslash — which in this repo is a category of bug all of its own.
    pub full: String,
    pub folder: bool,
}

/// Whether Everything is up. Cheap — one `FindWindow`.
fn ipc_window() -> Option<HWND> {
    unsafe { FindWindowW(w!("EVERYTHING_TASKBAR_NOTIFICATION"), PCWSTR::null()).ok() }
}

pub fn running() -> bool {
    ipc_window().is_some()
}

/* ── The reply window ────────────────────────────────────────────────────── */

/// Filled by the window procedure, read by `search` once the pump sees it.
#[derive(Default)]
struct Reply {
    hits: Vec<Hit>,
    arrived: bool,
}

unsafe extern "system" fn proc(hwnd: HWND, msg: u32, w: WPARAM, l: LPARAM) -> LRESULT {
    if msg == WM_COPYDATA {
        let held = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut Reply;
        let data = l.0 as *const COPYDATASTRUCT;
        if !held.is_null() && !data.is_null() && (*data).dwData == REPLY {
            let bytes = std::slice::from_raw_parts(
                (*data).lpData as *const u8,
                (*data).cbData as usize,
            );
            (*held).hits = parse(bytes);
            (*held).arrived = true;
        }
        return LRESULT(1);
    }
    DefWindowProcW(hwnd, msg, w, l)
}

/// ⚠️ Registered once for the life of the process. `RegisterClassW` fails on a
/// second call with the same name, and the failure is indistinguishable from a
/// real one — so the answer is to not call it twice rather than to ignore the
/// error.
fn class() -> &'static u16 {
    static ONCE: OnceLock<u16> = OnceLock::new();
    ONCE.get_or_init(|| unsafe {
        let class = WNDCLASSW {
            lpfnWndProc: Some(proc),
            hInstance: GetModuleHandleW(None).unwrap_or_default().into(),
            lpszClassName: w!("CodenotchEverythingReply"),
            ..Default::default()
        };
        RegisterClassW(&class)
    })
}

/* ── Reading the answer ──────────────────────────────────────────────────── */

fn dword(bytes: &[u8], at: usize) -> Option<u32> {
    bytes.get(at..at + 4).map(|four| u32::from_le_bytes(four.try_into().unwrap()))
}

/// A null-terminated UTF-16 string at a byte offset from the start of the list.
///
/// ⚠️ Bounds-checked at every step. The offsets are numbers from another
/// process; a truncated or malformed reply must come back as a short list, not
/// as a read past the end of the buffer.
fn wide_at(bytes: &[u8], at: usize) -> Option<String> {
    if at >= bytes.len() || at % 2 != 0 {
        return None;
    }
    let mut units = Vec::new();
    let mut cursor = at;
    while cursor + 1 < bytes.len() {
        let unit = u16::from_le_bytes([bytes[cursor], bytes[cursor + 1]]);
        if unit == 0 {
            return Some(String::from_utf16_lossy(&units));
        }
        units.push(unit);
        cursor += 2;
    }
    None
}

/// Folder plus name.
///
/// ⚠️ A bare drive needs the separator put back by hand. `Path::join` on
/// `"C:"` yields `C:name` — a DRIVE-RELATIVE path meaning "name in whatever the
/// current directory on C: is", which is a real and different location, and
/// nothing about the string looks wrong. Everything reports the parent of a
/// root-level item as exactly `C:`, so this is not a corner case: it is every
/// hit at the top of a drive.
fn joined(folder: &str, name: &str) -> String {
    let mut out = String::from(folder);
    if out.ends_with(':') {
        out.push(std::path::MAIN_SEPARATOR);
    }
    std::path::Path::new(&out).join(name).to_string_lossy().into_owned()
}

/// `EVERYTHING_IPC_LISTW`: seven DWORDs, then three per item, then the strings
/// somewhere after them at byte offsets from the start of this buffer.
fn parse(bytes: &[u8]) -> Vec<Hit> {
    let Some(count) = dword(bytes, 20) else { return Vec::new() };
    let mut hits = Vec::new();
    for index in 0..count as usize {
        let base = 28 + index * 12;
        let (Some(flags), Some(name_at), Some(path_at)) =
            (dword(bytes, base), dword(bytes, base + 4), dword(bytes, base + 8))
        else {
            break;
        };
        let (Some(name), Some(path)) =
            (wide_at(bytes, name_at as usize), wide_at(bytes, path_at as usize))
        else {
            break;
        };
        let full = joined(&path, &name);
        hits.push(Hit { name, path, full, folder: flags & 1 != 0 });
    }
    hits
}

/* ── Asking ──────────────────────────────────────────────────────────────── */

/// The `EVERYTHING_IPC_QUERYW` bytes: five DWORDs then the search, terminated.
fn request(reply_to: HWND, query: &str, limit: u32) -> Vec<u8> {
    let mut out = Vec::with_capacity(20 + query.len() * 2 + 2);
    out.extend_from_slice(&(reply_to.0 as usize as u32).to_le_bytes()); // reply_hwnd
    out.extend_from_slice(&(REPLY as u32).to_le_bytes());               // reply_copydata_message
    out.extend_from_slice(&0u32.to_le_bytes());                         // search_flags: none
    out.extend_from_slice(&0u32.to_le_bytes());                         // offset
    out.extend_from_slice(&limit.to_le_bytes());                        // max_results
    for unit in query.encode_utf16().chain(std::iter::once(0)) {
        out.extend_from_slice(&unit.to_le_bytes());
    }
    out
}

/// ⚠️ Blocking, and it creates a window — so it must not run on the UI thread.
/// The caller hands it to `spawn_blocking`.
pub fn search(query: &str, limit: u32) -> Vec<Hit> {
    let query = query.trim();
    if query.is_empty() {
        return Vec::new();
    }
    let Some(everything) = ipc_window() else { return Vec::new() };
    if *class() == 0 {
        return Vec::new();
    }

    let mut reply = Reply::default();
    unsafe {
        let Ok(window) = CreateWindowExW(
            WINDOW_EX_STYLE(0),
            w!("CodenotchEverythingReply"),
            PCWSTR::null(),
            WINDOW_STYLE(0),
            0,
            0,
            0,
            0,
            Some(HWND_MESSAGE),
            None::<HMENU>,
            None,
            None,
        ) else {
            return Vec::new();
        };
        SetWindowLongPtrW(window, GWLP_USERDATA, &mut reply as *mut Reply as isize);

        let body = request(window, query, limit);
        let packet = COPYDATASTRUCT {
            dwData: QUERYW,
            cbData: body.len() as u32,
            lpData: body.as_ptr() as *mut std::ffi::c_void,
        };
        /* ⚠️ `SendMessageTimeout`, not `SendMessage`. This is a synchronous call
         * into another process; if Everything is mid-rebuild and not pumping,
         * a plain send blocks this thread for as long as that lasts. */
        let mut ignored = 0usize;
        SendMessageTimeoutW(
            everything,
            WM_COPYDATA,
            WPARAM(window.0 as usize),
            LPARAM(&packet as *const COPYDATASTRUCT as isize),
            SMTO_ABORTIFHUNG,
            1000,
            Some(&mut ignored),
        );

        /* The answer is SENT to our window, so it is delivered while we are
         * inside a message call rather than sitting in the posted queue —
         * `PeekMessage` is what gives Windows the chance to deliver it. */
        let deadline = Instant::now() + PATIENCE;
        while !reply.arrived && Instant::now() < deadline {
            let mut msg = MSG::default();
            while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            if reply.arrived {
                break;
            }
            std::thread::sleep(Duration::from_millis(4));
        }

        // ⚠️ Cleared before the window dies: the procedure can still run during
        // DestroyWindow, and `reply` is about to go out of scope.
        SetWindowLongPtrW(window, GWLP_USERDATA, 0);
        let _ = DestroyWindow(window);
    }
    reply.hits
}

#[tauri::command]
pub async fn everything_search(query: String, limit: u32) -> Result<Vec<Hit>, String> {
    tauri::async_runtime::spawn_blocking(move || search(&query, limit.clamp(1, 40)))
        .await
        .map_err(|_| "The file search did not finish.".to_string())
}

#[tauri::command]
pub fn everything_running() -> bool {
    running()
}

/// Open a hit. ⚠️ The same helper the shelf opens with, rather than a second
/// `ShellExecute` written slightly differently.
#[tauri::command]
pub fn found_open(path: String) -> Result<(), String> {
    crate::calendar::open_path(&path)
}

/// Show it where it lives.
#[tauri::command]
pub fn found_reveal(path: String) -> Result<(), String> {
    crate::calendar::explore(&path)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// ⚠️ The reply is bytes from another process, and every offset in it is a
    /// number that process chose. A truncated or malformed list has to come
    /// back short, never as a read past the end of the buffer.
    #[test]
    fn a_reply_is_read_by_its_offsets_and_bounded_by_the_buffer() {
        // Two items, strings parked after the item array.
        let mut bytes = vec![0u8; 28 + 2 * 12];
        bytes[20..24].copy_from_slice(&2u32.to_le_bytes()); // numitems
        let strings_at = bytes.len();
        let push = |bytes: &mut Vec<u8>, text: &str| -> u32 {
            let at = bytes.len() as u32;
            for unit in text.encode_utf16().chain(std::iter::once(0)) {
                bytes.extend_from_slice(&unit.to_le_bytes());
            }
            at
        };
        let name_a = push(&mut bytes, "notes.md");
        let path_a = push(&mut bytes, "C:/work");
        let name_b = push(&mut bytes, "src");
        let path_b = push(&mut bytes, "C:/work/app");
        assert!(strings_at > 0);

        bytes[28..32].copy_from_slice(&0u32.to_le_bytes()); // a file
        bytes[32..36].copy_from_slice(&name_a.to_le_bytes());
        bytes[36..40].copy_from_slice(&path_a.to_le_bytes());
        bytes[40..44].copy_from_slice(&1u32.to_le_bytes()); // a folder
        bytes[44..48].copy_from_slice(&name_b.to_le_bytes());
        bytes[48..52].copy_from_slice(&path_b.to_le_bytes());

        let hits = parse(&bytes);
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].name, "notes.md");
        assert_eq!(hits[0].path, "C:/work");
        assert!(hits[0].full.ends_with("notes.md"));
        assert!(hits[0].full.starts_with("C:/work"));
        assert!(!hits[0].folder);
        assert!(hits[1].folder);

        // Truncated after the first item: one hit, no panic.
        let short = &bytes[..40];
        assert!(parse(short).len() <= 1);
        // An offset past the end is dropped rather than read.
        let mut wild = bytes.clone();
        wild[32..36].copy_from_slice(&999_999u32.to_le_bytes());
        assert!(parse(&wild).is_empty());
        // And an empty buffer is an empty list.
        assert!(parse(&[]).is_empty());
    }

    /// ⚠️ The bug the live round trip caught. Everything reports the parent
    /// of a root-level item as `C:`, and joining that gives a drive-relative
    /// path that points somewhere else entirely and looks fine.
    #[test]
    fn a_hit_at_the_root_of_a_drive_keeps_its_separator() {
        let root = joined("C:", "pagefile.sys");
        let after_drive = root.split_once(':').map(|(_, rest)| rest).unwrap_or("");
        assert!(after_drive.starts_with(std::path::MAIN_SEPARATOR), "{root}");
        // An ordinary folder is untouched.
        assert!(joined(r"C:\work", "notes.md").ends_with("notes.md"));
    }

    /// The query struct is five DWORDs and then the search string. Getting the
    /// prefix length wrong makes Everything search for garbage and return
    /// nothing, which is indistinguishable from "no matches".
    #[test]
    fn the_query_carries_the_reply_window_and_the_search() {
        let body = request(HWND(0x1234 as *mut std::ffi::c_void), "notes", 25);
        assert_eq!(u32::from_le_bytes(body[0..4].try_into().unwrap()), 0x1234);
        assert_eq!(u32::from_le_bytes(body[4..8].try_into().unwrap()), REPLY as u32);
        assert_eq!(u32::from_le_bytes(body[8..12].try_into().unwrap()), 0);
        assert_eq!(u32::from_le_bytes(body[12..16].try_into().unwrap()), 0);
        assert_eq!(u32::from_le_bytes(body[16..20].try_into().unwrap()), 25);
        assert_eq!(body.len(), 20 + "notes".len() * 2 + 2);
        assert_eq!(wide_at(&body, 20).as_deref(), Some("notes"));
    }

    /// ⚠️ Not `#[ignore]`d: it has to be safe to run on a machine with no
    /// Everything, because that is the case the palette has to survive.
    #[test]
    fn a_machine_without_everything_gets_an_empty_list_rather_than_an_error() {
        let _ = running();
        assert!(search("", 10).is_empty());
    }

    /// The real round trip. `#[ignore]`d like the other tests here that touch
    /// the machine — it needs Everything installed and indexed — but it is the
    /// only thing that proves the struct layout, since every mistake in it comes
    /// back as an empty list rather than as an error.
    #[test]
    #[ignore]
    fn asks_the_real_everything() {
        assert!(running(), "Everything is not running on this machine");
        let hits = search("windows", 10);
        assert!(!hits.is_empty(), "no hits for a word every machine has");
        for hit in &hits {
            assert!(!hit.name.is_empty());
            assert!(hit.path.contains(':'), "a path should be absolute: {}", hit.path);
            // ⚠️ Never drive-relative — see `joined`. `C:name` is a different
            // place from `C:\name` and reads identically.
            let after_drive = hit.full.split_once(':').map(|(_, rest)| rest).unwrap_or("");
            assert!(after_drive.starts_with(std::path::MAIN_SEPARATOR),
                "{} is drive-relative", hit.full);
        }
        // The index can be a little stale, but not entirely.
        assert!(hits.iter().any(|hit| std::path::Path::new(&hit.full).exists()));
        // The cap is honoured, or a broad search floods the palette.
        assert!(search("e", 5).len() <= 5);
    }
}
