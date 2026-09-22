//! Ambient mode: the player, full screen.
//!
//! A borderless window over the whole monitor the island is on, drawn by
//! `ambient.ts`. Built the way the drop-zone overlay is (`notes.rs`), with the
//! two differences that make it a place rather than an overlay: it is NOT
//! click-through, and it DOES take focus — Escape and the controls have to
//! work, and every other window in this app is built to refuse exactly that.
//!
//! ⚠️ **Made once, then only hidden.** The first build of a webview costs a
//! few hundred milliseconds, and the whole point of the mode is a transition
//! that starts the moment you press the button. The window is created on first
//! use and kept, hidden, for every open after that.
//!
//! ⚠️ **Nothing else may climb over it while it is up.** Every window here is
//! topmost, and `win::harden` re-asserts `HWND_TOPMOST` whenever the pointer
//! crosses the island's edge — which, with this open, would pop the island and
//! the usage notch back above a full-screen player. `OPEN` is what `harden`
//! checks to leave the z-order alone.
//!
//! ⚠️ **The transition crosses two windows.** The island reports where it is,
//! in its own CSS pixels; this turns that into the ambient window's CSS pixels
//! on the same monitor, and the page grows the player out of exactly that
//! rectangle. Leaving shrinks it back into the collapsed pill's rectangle, which
//! is what the island will be by then.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::drag::Settings;

pub const LABEL: &str = "ambient";

/// Whether the ambient window is up. Read by `win::harden`.
pub static OPEN: AtomicBool = AtomicBool::new(false);
static SERIAL: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// What the page needs to play the transition.
#[derive(Clone, Copy, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Opening {
    /// Where the player grows FROM — the island as it was when pressed.
    pub from: Rect,
    /// Where it shrinks back TO — the collapsed pill, which is what the island
    /// will be once this is up.
    pub to: Rect,
    /// ⚠️ Counted, so a page that asks for the pending opening on load and ALSO
    /// hears the event does not run the same transition twice.
    pub serial: u64,
}

#[derive(Default)]
pub struct Pending(pub Mutex<Option<Opening>>);

/// Open ambient mode from the island.
///
/// `from` and `pill` are in the ISLAND window's CSS pixels. ⚠️ Only the task
/// window may open it: it is the only window that knows where the island is.
#[tauri::command]
pub async fn ambient_open(app: AppHandle, window: WebviewWindow, from: Rect, pill: Rect) -> Result<(), String> {
    if window.label() != "tasks" {
        return Err("Ambient mode opens from the island.".into());
    }
    let monitor = window
        .current_monitor()
        .ok()
        .flatten()
        .ok_or("There is no display to open it on.")?;
    let origin = window.inner_position().map_err(|_| "Could not find the island.")?;
    let scale = window.scale_factor().unwrap_or(1.0);
    let at = monitor.position();
    let monitor_scale = monitor.scale_factor();
    /* ⚠️ Through PHYSICAL pixels, both ways. The island's window and the
     * ambient window are on the same monitor and so share a scale today, but
     * converting straight from one window's CSS pixels to the other's would be
     * right only by that coincidence. */
    let convert = |r: Rect| Rect {
        x: (origin.x as f64 + r.x * scale - at.x as f64) / monitor_scale,
        y: (origin.y as f64 + r.y * scale - at.y as f64) / monitor_scale,
        width: r.width * scale / monitor_scale,
        height: r.height * scale / monitor_scale,
    };
    let opening = Opening {
        from: convert(from),
        to: convert(pill),
        serial: SERIAL.fetch_add(1, Ordering::SeqCst) + 1,
    };
    *app.state::<Pending>().0.lock().unwrap() = Some(opening);

    let ambient = ensure(&app)?;
    let _ = ambient.set_position(PhysicalPosition::new(at.x, at.y));
    let _ = ambient.set_size(*monitor.size());
    OPEN.store(true, Ordering::SeqCst);
    let _ = ambient.show();
    let _ = ambient.set_focus();
    crate::win::to_top(&ambient);
    let _ = app.emit_to(LABEL, "ambient:open", opening);
    let _ = app.emit_to("tasks", "ambient:state", true);
    Ok(())
}

/// The opening the page has not played yet, for a page that loaded after the
/// event was sent — which is every first open.
#[tauri::command]
pub fn ambient_pending(app: AppHandle) -> Option<Opening> {
    *app.state::<Pending>().0.lock().unwrap()
}

/// Put it away. Called by the page once its closing transition has finished.
#[tauri::command]
pub fn ambient_close(app: AppHandle) {
    OPEN.store(false, Ordering::SeqCst);
    *app.state::<Pending>().0.lock().unwrap() = None;
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.hide();
    }
    let _ = app.emit_to("tasks", "ambient:state", false);
}

fn ensure(app: &AppHandle) -> Result<WebviewWindow, String> {
    if let Some(found) = app.get_webview_window(LABEL) {
        return Ok(found);
    }
    WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("ambient.html".into()))
        .title("Codenotch — ambient")
        .decorations(false)
        /* ⚠️ Transparent, because the transition starts from a pill-sized
         * window onto the scene: everything outside it has to be the desktop
         * until the player has grown over it. */
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .focused(true)
        .visible(false)
        .build()
        .map_err(|error| format!("Could not open ambient mode: {error}"))
}

/* ── Your own scenes ───────────────────────────────────────────────────────
 * A folder of videos and stills, listed flat. ⚠️ The asset protocol starts
 * with an EMPTY scope (tauri.conf.json) and is opened to this one folder at
 * runtime, so choosing a folder is the only thing that lets the webview read
 * a file off disk — not a wildcard that lets it read anything.
 */

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneFile {
    pub path: String,
    pub name: String,
    /// `video` or `image`.
    pub kind: String,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Scenes {
    pub folder: String,
    pub files: Vec<SceneFile>,
}

/// ⚠️ Formats WebView2 actually plays, not every video extension there is. A
/// file the webview cannot decode would be a black scene with no explanation.
fn kind_of(path: &Path) -> Option<&'static str> {
    let ext = path.extension()?.to_string_lossy().to_ascii_lowercase();
    match ext.as_str() {
        "mp4" | "m4v" | "webm" | "mov" => Some("video"),
        "jpg" | "jpeg" | "png" | "webp" | "avif" | "gif" => Some("image"),
        _ => None,
    }
}

pub fn allow(app: &AppHandle, folder: &str) {
    if folder.is_empty() {
        return;
    }
    let _ = app.asset_protocol_scope().allow_directory(PathBuf::from(folder), false);
}

#[tauri::command]
pub fn ambient_scenes(app: AppHandle) -> Scenes {
    let folder = app.state::<Settings>().0.lock().map(|c| c.ambient_folder.clone()).unwrap_or_default();
    if folder.is_empty() {
        return Scenes::default();
    }
    let mut files: Vec<SceneFile> = std::fs::read_dir(&folder)
        .map(|entries| {
            entries
                .flatten()
                .filter_map(|entry| {
                    let path = entry.path();
                    let kind = kind_of(&path)?;
                    Some(SceneFile {
                        name: path.file_stem()?.to_string_lossy().to_string(),
                        path: path.to_string_lossy().to_string(),
                        kind: kind.into(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    files.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    /* ⚠️ Capped. A folder somebody points at their whole Videos directory is a
     * list of thousands, and a scene picker is not a file browser. */
    files.truncate(120);
    Scenes { folder, files }
}

/// Set the folder, or clear it with an empty string.
#[tauri::command]
pub fn ambient_set_folder(app: AppHandle, folder: String) -> Result<Scenes, String> {
    let folder = folder.trim().to_string();
    if !folder.is_empty() && !Path::new(&folder).is_dir() {
        return Err("That folder does not exist.".into());
    }
    {
        let settings = app.state::<Settings>();
        let mut config = settings.0.lock().map_err(|_| "Settings are locked.")?;
        config.ambient_folder = folder.clone();
        crate::config::save(&config);
    }
    allow(&app, &folder);
    let scenes = ambient_scenes(app.clone());
    let _ = app.emit_to(LABEL, "ambient:scenes", &scenes);
    Ok(scenes)
}

/// Ask for a folder with the system's own picker.
///
/// ⚠️ On a thread of its own with a single-threaded COM apartment: the dialog
/// is modal and blocking, and it will not run in the multi-threaded apartment
/// the async runtime's workers live in.
#[tauri::command]
pub async fn ambient_pick_folder(app: AppHandle, window: WebviewWindow) -> Result<Option<Scenes>, String> {
    let owner = crate::win::hwnd_of(&window).map(|h| h.0 as isize);
    let (send, receive) = tokio::sync::oneshot::channel();
    std::thread::spawn(move || {
        let _ = send.send(pick_folder(owner));
    });
    match receive.await.unwrap_or(None) {
        Some(folder) => ambient_set_folder(app, folder).map(Some),
        None => Ok(None),
    }
}

fn pick_folder(owner: Option<isize>) -> Option<String> {
    use windows::core::w;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoTaskMemFree, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::UI::Shell::{
        FileOpenDialog, IFileOpenDialog, FOS_FORCEFILESYSTEM, FOS_PICKFOLDERS, SIGDN_FILESYSPATH,
    };
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let dialog: IFileOpenDialog = CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER).ok()?;
        let options = dialog.GetOptions().ok()?;
        dialog.SetOptions(options | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM).ok()?;
        let _ = dialog.SetTitle(w!("Choose a folder of ambient scenes"));
        // Cancelling is an error here, and it means "nothing chosen".
        dialog.Show(owner.map(|h| HWND(h as *mut core::ffi::c_void))).ok()?;
        let item = dialog.GetResult().ok()?;
        let name = item.GetDisplayName(SIGDN_FILESYSPATH).ok()?;
        let path = name.to_string().ok();
        CoTaskMemFree(Some(name.0 as *const core::ffi::c_void));
        path
    }
}
