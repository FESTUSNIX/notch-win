//! Somewhere to put a thought without deciding where it goes.
//!
//! ⚠️ **Not tasks, and deliberately not in TickTick.** A task is something you
//! have committed to doing, and it costs a list, a day and a place in a
//! hierarchy to file one. Most of what you want to write down is none of those:
//! a licence key, a name you will need in an hour, the shape of an idea. Put
//! that in a task list and it is either clutter in a list you review or lost in
//! one you do not — and either way you have made a decision about it at the one
//! moment you had no time to.
//!
//! So: one field, no fields. Everything else here exists to make the pile
//! findable afterwards rather than to make writing to it slower.
//!
//! ⚠️ **Kept beside the config as its own file**, the way `stars.json` and
//! `snooze.json` are. A corrupt list of notes must never stop the app starting
//! with the user's edge intact, and notes are the one thing here that is
//! genuinely the user's own writing — nothing else in this app holds anything
//! that cannot be re-derived from somewhere else.

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

const FILE: &str = "notes.json";

/// ⚠️ Belt and braces on a file the user cannot get back. A note is the only
/// thing this app stores that is not a cache of something else, so the list is
/// capped rather than left to grow without bound — but the cap is high enough
/// that nobody reaches it by writing notes, only by a loop with a bug in it.
const MAX_NOTES: usize = 2000;
/// One note, capped. Long enough for a stack trace, short enough that a
/// mis-aimed paste of a binary cannot take the file with it.
const MAX_BODY: usize = 20_000;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Note {
    pub id: String,
    pub body: String,
    /// Unix milliseconds. ⚠️ Two of them: a note edited a month after it was
    /// written is still a note from a month ago, and sorting the list by the
    /// edit would quietly reorder your history every time you fixed a typo.
    pub written: i64,
    pub edited: i64,

    /* ── Stuck to the desktop ──────────────────────────────────────
     * ⚠️ Window state, kept on the note rather than in a file of its own —
     * the two are one to one, a pinned note with no note is nothing, and a
     * second file would be a second thing to keep in step. */
    pub pinned: bool,
    /// Which side of the screen it is docked to: `left` or `right`.
    ///
    /// ⚠️ Empty means the right, which is what `Default` gives a note written
    /// before this existed. A note that loaded with no edge and docked nowhere
    /// would be a window off the side of the screen.
    pub edge: String,
    /// How far down the edge the sliver sits, in physical pixels. 0 means
    /// "never docked", and the drawer starts halfway down instead.
    pub y: i32,
    /* ⚠️ Dead, and kept anyway. A docked note has no x, width or height of its
     * own any more — the edge decides two of them and the drawer's own sizes
     * decide the rest — but a note file written by an older build still
     * carries them, and a field dropped from the struct is a field `serde`
     * would have to be told to ignore. Cheaper to keep three integers than to
     * find out later that one of them mattered. */
    pub x: i32,
    pub w: u32,
    pub h: u32,

    /// One of the palette's colour keys, or empty for plain paper.
    ///
    /// ⚠️ A KEY, not a colour. The screen maps it to a custom property, so a
    /// note cannot carry a string that ends up in a stylesheet — and the
    /// palette can be retuned in one place without rewriting every note.
    pub tint: String,
}

/// The drawer's window, in logical pixels.
///
/// ⚠️ It does not resize, and that is the whole design. A window that grows
/// on hover can only jump: there is no way to animate one at sixty frames a
/// second across a process boundary. The island solved this by being a big
/// transparent window that is click-through everywhere it is not painted, with
/// the SHAPE animating inside it — `watch_pin` below is this window's half of
/// that bargain, and `note-window.ts` draws the shape with the island's own
/// `notchPath` and its own spring.
///
/// ⚠️ BIGGER than the drawer it holds (330 by 340). The spring overshoots
/// its target — that is what makes it read as a spring — and the overshoot
/// needs somewhere to go, or the shape is sliced off square at the moment it is
/// moving fastest.
const WINDOW_W: f64 = 362.0;
const WINDOW_H: f64 = 400.0;

#[derive(Default)]
pub struct Store(pub Mutex<Vec<Note>>);

pub fn load(app: &AppHandle) {
    let stored: Vec<Note> = crate::config::load_beside(FILE).unwrap_or_default();
    if let Ok(mut held) = app.state::<Store>().0.lock() {
        *held = stored;
    }
}

fn publish(app: &AppHandle, held: &[Note]) {
    crate::config::save_beside(FILE, &held.to_vec());
    let _ = app.emit("notch:notes", held.to_vec());
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}

#[tauri::command]
pub fn get_notes(app: AppHandle) -> Vec<Note> {
    app.state::<Store>().0.lock().map(|held| held.clone()).unwrap_or_default()
}

/// Write one down, or change one already written.
///
/// ⚠️ One command for both, because from the island they are the same gesture:
/// you press a note, the words appear in the field, you change them and press
/// save. Two commands would mean the screen deciding which it is, and the one
/// case it would get wrong is the one that loses what you typed.
///
/// ⚠️ An empty body DELETES rather than storing a blank. Clearing the field and
/// saving is the obvious way to throw a note away, and a list of empty rows is
/// the alternative.
#[tauri::command]
pub fn save_note(app: AppHandle, id: String, body: String) -> Vec<Note> {
    let body = body.trim().to_string();
    let body = if body.len() > MAX_BODY {
        // ⚠️ On a CHARACTER boundary. `body[..MAX_BODY]` panics the moment a
        // note contains anything outside ASCII, which for a Polish user is
        // most of them.
        body.chars().take(MAX_BODY).collect()
    } else {
        body
    };

    let snapshot = {
        let state = app.state::<Store>();
        let Ok(mut held) = state.0.lock() else { return Vec::new() };
        let at = now();
        // ⚠️ Read before the mutable borrow, not inside the arm that needs it:
        // `held.len()` in there is an immutable borrow while `iter_mut` holds a
        // mutable one, and the compiler is right to refuse.
        let count = held.len() as u64;
        match held.iter_mut().find(|note| note.id == id) {
            Some(existing) if body.is_empty() => {
                let gone = existing.id.clone();
                held.retain(|note| note.id != gone);
            }
            Some(existing) => {
                existing.body = body;
                existing.edited = at;
            }
            None if body.is_empty() => {}
            None => {
                /* Newest first, so the list is in the order you would look for
                 * things in it and the screen never has to sort. */
                held.insert(0, Note {
                    // ⚠️ Not the index and not the millisecond: two notes
                    // written in the same millisecond would share an id, and an
                    // index changes the moment anything above it is deleted.
                    id: format!("{at:x}-{:x}", count + rand_bits()),
                    body,
                    written: at,
                    edited: at,
                    // A new note is not on the desktop and has never been placed.
                    ..Note::default()
                });
                held.truncate(MAX_NOTES);
            }
        }
        held.clone()
    };
    publish(&app, &snapshot);
    snapshot
}

#[tauri::command]
pub async fn remove_note(app: AppHandle, id: String) -> Vec<Note> {
    /* ⚠️ The window goes with the note. A sticky note whose note has been
     * deleted is a square of text on the desktop that nothing can reach. */
    close_pin(&app, &id);
    let snapshot = {
        let state = app.state::<Store>();
        let Ok(mut held) = state.0.lock() else { return Vec::new() };
        held.retain(|note| note.id != id);
        held.clone()
    };
    publish(&app, &snapshot);
    snapshot
}

/// The window label for a note.
///
/// ⚠️ One definition. The label is how everything else here finds the window
/// again, and two spellings of it is two windows for one note.
fn label(id: &str) -> String {
    format!("note-{id}")
}

fn close_pin(app: &AppHandle, id: &str) {
    if let Some(window) = app.get_webview_window(&label(id)) {
        let _ = window.close();
    }
}

/// Stick a note to the desktop, or take it off again.
///
/// ⚠️ `async`, because WebView2 construction deadlocks inside a synchronous
/// command on Windows — the same reason `open_task_editor` is. It presents as
/// the whole app hanging on the click.
#[tauri::command]
pub async fn pin_note(
    app: AppHandle,
    id: String,
    pinned: bool,
    edge: Option<String>,
    y: Option<i32>,
) -> Result<Vec<Note>, String> {
    let snapshot = {
        let state = app.state::<Store>();
        let Ok(mut held) = state.0.lock() else { return Ok(Vec::new()) };
        match held.iter_mut().find(|note| note.id == id) {
            Some(note) => {
                note.pinned = pinned;
                /* Where it was dropped, when it was dropped rather than
                 * clicked. ⚠️ Applied BEFORE the window opens, because the
                 * page reads the note to decide where to dock — set it after
                 * and the drawer opens on the old edge and jumps. */
                if let Some(side) = edge.as_deref() {
                    note.edge = side_of(side);
                }
                if let Some(at) = y {
                    note.y = at;
                }
            }
            None => return Ok(held.clone()),
        }
        held.clone()
    };
    publish(&app, &snapshot);
    if pinned {
        let note = snapshot.iter().find(|note| note.id == id).cloned().unwrap_or_default();
        open_pin(&app, &note)?;
    } else {
        close_pin(&app, &id);
    }
    Ok(snapshot)
}

/// Put one note on the desktop.
fn open_pin(app: &AppHandle, note: &Note) -> Result<(), String> {
    let name = label(&note.id);
    if let Some(existing) = app.get_webview_window(&name) {
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(());
    }
    /* ⚠️ The id rides in the QUERY. The page has to know which note it is
     * before it can ask for anything, and reading its own window label back is
     * a round trip on every load for something already known here. */
    let url = format!("note.html?id={}", note.id);
    tauri::WebviewWindowBuilder::new(app, &name, tauri::WebviewUrl::App(url.into()))
        .title("Note")
        /* ⚠️ Undecorated, but NOT `WS_EX_NOACTIVATE`. This is the one window
         * in the app that is MEANT to take focus — you click a note to type in
         * it. The island is the opposite and pays for it in plumbing; copying
         * that here would make the note unwritable. */
        .decorations(false)
        .transparent(true)
        /* ⚠️ Windows draws its OWN frame on an undecorated window — rounded
         * corners, a hairline and a drop shadow, all from DWM — and it lands on
         * the window's rectangle, not on the shape painted inside it. So the
         * drawer came out as a rounded rectangle with a border and a shadow,
         * with our notch invisible inside it: the "doubled" look, and the
         * reason the flares could not be seen. Every other window in this app
         * already says `"shadow": false` in `tauri.conf.json`; this one is
         * built in code and had never been told. */
        .shadow(false)
        .always_on_top(true)
        /* Out of Alt-Tab and off the taskbar: eight docked notes in the task
         * switcher is the cost of having eight of them, and always-on-top
         * means there is nowhere for one to be lost. */
        .skip_taskbar(true)
        /* ⚠️ NOT resizable, and not because a drawer should not be resized.
         * An undecorated resizable window on Windows still carries invisible
         * resize borders, and a collapsed drawer is 22px wide — it is ALL
         * border. Every drag along the edge would have resized it instead of
         * moving it. `move_pin` below is unaffected: tao's `set_inner_size` is
         * a `SetWindowPos` and never consults the flag. */
        .resizable(false)
        /* ⚠️ Hidden until the page has docked it, and this is load-bearing.
         * The edge, the monitor and the expanded size are all worked out in
         * `note-window.ts` — one place, where the hover expansion also lives —
         * so anything built here is a guess, and a guess that is shown is a
         * window seen in the wrong corner for the frame before it moves. */
        .visible(false)
        .inner_size(WINDOW_W, WINDOW_H)
        .build()
        .map_err(|e| e.to_string())?;
    /* ⚠️ One watcher per docked note, and it is what makes the window above
     * usable at all: 330x340 of transparent window at the edge of the screen
     * would otherwise swallow every click on whatever is behind it. */
    watch_pin(app.clone(), name);
    Ok(())
}

/// Keep a docked note click-through everywhere it is not painted, and tell it
/// when the pointer arrives.
///
/// ⚠️ A copy of `hover::spawn`, deliberately, and a short one. That loop is
/// the island's: it re-places the window when the taskbar moves, watches for a
/// click elsewhere to dismiss on, and carries a drop zone — none of which a
/// note has, and all of which would have to grow a label test to stay out of
/// its way. What the two genuinely share is the state the rects live in.
///
/// ⚠️ It exits when the window does. `pin_note(false)` closes the window and
/// this is how the thread finds out; without the break there would be one
/// 100ms poll per note ever docked, for the life of the app.
fn watch_pin(app: AppHandle, label: String) {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;

    crate::guard::spawn("note hover", move || {
        /* ⚠️ `Option`, not `bool` — the same trap `hover.rs` documents. Starting
         * at `false` means the first tick sees no change and never calls
         * `set_ignore_cursor_events`, so the window ships as whatever the
         * builder left it: an invisible rectangle that eats clicks. */
        let mut was: Option<bool> = None;
        loop {
            std::thread::sleep(std::time::Duration::from_millis(100));
            let Some(window) = app.get_webview_window(&label) else { return };
            if !window.is_visible().unwrap_or(false) {
                was = None;
                continue;
            }
            let mut point = POINT::default();
            if unsafe { GetCursorPos(&mut point) }.is_err() {
                continue;
            }
            let (Ok(origin), Ok(scale)) = (window.outer_position(), window.scale_factor()) else {
                continue;
            };
            let rects = {
                let guard = app.state::<crate::hover::InteractiveRects>();
                let Ok(held) = guard.0.lock() else { continue };
                held.get(&label).cloned().unwrap_or_default()
            };
            // CSS pixels relative to the window -> physical pixels on screen.
            let on = rects.iter().any(|r| {
                let left = origin.x as f64 + r.x * scale;
                let top = origin.y as f64 + r.y * scale;
                (point.x as f64) >= left
                    && (point.x as f64) < left + r.width * scale
                    && (point.y as f64) >= top
                    && (point.y as f64) < top + r.height * scale
            });
            if was != Some(on) {
                was = Some(on);
                let _ = window.set_ignore_cursor_events(!on);
                /* ⚠️ Re-hardened immediately. That call rewrites the whole
                 * extended-style word, which drops the tool-window bit — and
                 * for a note it must also NOT put the no-activate bit back, or
                 * the note stops being typeable. See `win::harden`. */
                crate::win::harden(&window);
            }
            if was == Some(true) || on {
                let _ = window.emit_to(
                    label.as_str(),
                    "note:hover",
                    NoteHover {
                        hover: on,
                        y: (point.y as f64 - origin.y as f64) / scale,
                    },
                );
            }
        }
    });
}

/// Where the pointer is on a docked note, in CSS pixels down its own window.
#[derive(Clone, serde::Serialize)]
pub struct NoteHover {
    pub hover: bool,
    pub y: f64,
}

/// `left` or `right`, and never anything else.
///
/// ⚠️ Folded here rather than trusted from the page. The edge is written into
/// a data attribute a stylesheet reads, and every value that is not one of
/// these two means a drawer docked nowhere.
fn side_of(said: &str) -> String {
    if said == "left" { "left".into() } else { "right".into() }
}

/// Move and resize a docked note in one go.
///
/// ⚠️ ONE command for both, and that is the whole reason it exists. The page
/// could call `setPosition` and `setSize` itself, but each is an IPC round
/// trip — and between the two the drawer is the new width at the old x, which
/// on the right-hand edge is a window hanging off the side of the screen. Sent
/// together they reach the message loop in one pass and paint once.
#[tauri::command]
pub fn move_pin(app: AppHandle, id: String, x: i32, y: i32, w: u32, h: u32) {
    let Some(window) = app.get_webview_window(&label(&id)) else { return };
    let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
    let _ = window.set_size(tauri::PhysicalSize::new(w.max(1), h.max(1)));
}

/// Where a docked note is being dragged to, right now.
///
/// ⚠️ Sent to the drawer's own window rather than acted on here, because the
/// geometry — the monitor, the work area, the two sizes — lives in
/// `note-window.ts` and must live in exactly one place. See `move_pin`.
#[derive(Clone, serde::Serialize)]
pub struct DockAt {
    pub id: String,
    pub edge: String,
    pub y: i32,
    /// Whether this is a drag in progress. The drawer stays OPEN while it is
    /// true — the point of dragging a note to the edge is watching it land,
    /// and a sliver landing tells you nothing about which note it was.
    pub dragging: bool,
}

/// Follow the pointer while a note is being dragged out of the island.
///
/// ⚠️ Nothing is WRITTEN. This fires on every frame of a drag; `dock_note` is
/// what saves, once, when the pointer goes up. A file written sixty times a
/// second for a gesture that has not finished is the same mistake `place_note`
/// was built to avoid.
#[tauri::command]
pub fn drag_pin(app: AppHandle, id: String, edge: String, y: i32) {
    let side = side_of(&edge);
    if let Ok(mut held) = app.state::<Store>().0.lock() {
        if let Some(note) = held.iter_mut().find(|note| note.id == id) {
            note.edge = side.clone();
            note.y = y;
        }
    }
    let _ = app.emit("notch:note-dock", DockAt { id, edge: side, y, dragging: true });
}

/// Remember which edge a note is docked to, and how far down it.
///
/// ⚠️ Called by the window itself rather than from a `Moved` handler here.
/// Tauri reports a move on every pixel of a drag; the page sends one when the
/// pointer goes up, which is one write per drag rather than four hundred.
#[tauri::command]
pub fn dock_note(app: AppHandle, id: String, edge: String, y: i32) {
    let side = side_of(&edge);
    let snapshot = {
        let state = app.state::<Store>();
        let Ok(mut held) = state.0.lock() else { return };
        let Some(note) = held.iter_mut().find(|note| note.id == id) else { return };
        if note.edge == side && note.y == y {
            return;
        }
        note.edge = side.clone();
        note.y = y;
        held.clone()
    };
    /* ⚠️ `notch:notes` is NOT emitted. That one redraws every note everywhere,
     * and an edge is of no interest to any of them — one per drag would
     * repaint the island's whole wall for a window moving on another monitor.
     * The drawer gets its own event, which only it listens to. */
    crate::config::save_beside(FILE, &snapshot);
    let _ = app.emit("notch:note-dock", DockAt { id, edge: side, y, dragging: false });
}

/// Colour one note.
///
/// ⚠️ The whole list comes back and is emitted, like a save: the colour is on
/// the note, so the wall, the open editor and the docked drawer are three
/// views of one thing that has changed.
#[tauri::command]
pub fn tint_note(app: AppHandle, id: String, tint: String) -> Vec<Note> {
    /* A key, capped. Anything longer is not one of ours, and a stylesheet is
     * what reads it. */
    let tint: String = tint.chars().filter(|c| c.is_ascii_alphabetic()).take(16).collect();
    let snapshot = {
        let state = app.state::<Store>();
        let Ok(mut held) = state.0.lock() else { return Vec::new() };
        if let Some(note) = held.iter_mut().find(|note| note.id == id) {
            note.tint = tint;
        }
        held.clone()
    };
    publish(&app, &snapshot);
    snapshot
}

/// Put back whatever was on the desktop when the app last closed.
pub fn restore(app: &AppHandle) {
    let pinned: Vec<Note> = app
        .state::<Store>()
        .0
        .lock()
        .map(|held| held.iter().filter(|note| note.pinned).cloned().collect())
        .unwrap_or_default();
    for note in pinned {
        if let Err(error) = open_pin(app, &note) {
            crate::log::note(&format!("note {} could not be pinned: {error}", note.id));
        }
    }
}


/* ── Dragging a note out of the island ───────────────────────────────────
 *
 * ⚠️ The thing being dragged cannot be drawn by the island. A drag out ENDS
 * outside the island's window, and a window cannot paint past its own edge —
 * so the card stayed behind and the gesture was a pointer moving over the
 * desktop with nothing under it. What follows the pointer is a window of its
 * own: full screen, transparent, click-through, and drawn by `dragzone.ts`.
 *
 * ⚠️ And the pointer is read HERE rather than sent from the island. The
 * overlay ignores cursor events — it has to, or it would swallow every click
 * on the screen it covers — and a window that ignores them receives none, so
 * it cannot know where the pointer is. One poll in Rust feeds both it and the
 * docking decision, and the island is left holding nothing but the gesture. */

const DRAG_LABEL: &str = "dragzone";
static DRAGGING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// How near an edge counts as "drop it here", in physical pixels.
///
/// ⚠️ A fraction of the screen with a floor and a ceiling, not a constant. On a
/// 4K monitor 140px is a sliver nobody can aim at; on a laptop a sixth of the
/// width is a third of the usable desktop.
fn zone_width(work: &windows::Win32::Foundation::RECT) -> i32 {
    ((work.right - work.left) / 6).clamp(120, 260)
}

/// What the overlay is told, sixty times a second.
#[derive(Clone, serde::Serialize)]
struct DragAt {
    /// CSS pixels inside the overlay window.
    x: f64,
    y: f64,
    /// `left`, `right`, or empty for "not near an edge".
    edge: String,
}

/// Put the overlay over the monitor the pointer is on, and show it.
fn drag_window(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    let existing = app.get_webview_window(DRAG_LABEL);
    let window = match existing {
        Some(found) => found,
        None => tauri::WebviewWindowBuilder::new(
            app,
            DRAG_LABEL,
            tauri::WebviewUrl::App("dragzone.html".into()),
        )
        .title("Codenotch drop zones")
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .focused(false)
        .visible(false)
        .build()
        .ok()?,
    };
    /* ⚠️ Click-through, always. This window covers the entire screen; one
     * moment of it taking the pointer is every click on the desktop going
     * nowhere. */
    let _ = window.set_ignore_cursor_events(true);
    crate::win::harden(&window);
    Some(window)
}

/// Begin the gesture: the overlay appears and the pointer starts being read.
#[tauri::command]
pub async fn note_drag_start(app: AppHandle, id: String) {
    use std::sync::atomic::Ordering;
    if DRAGGING.swap(true, Ordering::SeqCst) {
        return;
    }
    let Some(window) = drag_window(&app) else {
        DRAGGING.store(false, Ordering::SeqCst);
        return;
    };
    // Over the monitor the pointer is on, whichever that is.
    if let Some((x, y)) = crate::win::cursor() {
        if let Ok(Some(monitor)) = window.monitor_from_point(x as f64, y as f64) {
            let at = monitor.position();
            let size = monitor.size();
            let _ = window.set_position(tauri::PhysicalPosition::new(at.x, at.y));
            let _ = window.set_size(tauri::PhysicalSize::new(size.width, size.height));
        }
    }
    let _ = window.show();
    watch_drag(app, id);
}

/// End it. ⚠️ Where it lands is decided by the POLLER, from the last place the
/// pointer actually was — not by the island, which by then is reporting a
/// release it saw through a pointer capture and cannot map to a screen.
#[tauri::command]
pub fn note_drag_end() {
    DRAGGING.store(false, std::sync::atomic::Ordering::SeqCst);
}

fn watch_drag(app: AppHandle, id: String) {
    use std::sync::atomic::Ordering;
    crate::guard::spawn("note drag", move || {
        let mut docked = false;
        let mut last = String::new();
        while DRAGGING.load(Ordering::SeqCst) {
            std::thread::sleep(std::time::Duration::from_millis(16));
            let Some((cx, cy)) = crate::win::cursor() else { continue };
            let Some(window) = app.get_webview_window(DRAG_LABEL) else { break };
            let Some(work) = crate::win::work_area(&window) else { continue };
            let (Ok(origin), Ok(scale)) = (window.outer_position(), window.scale_factor())
            else {
                continue;
            };

            let zone = zone_width(&work);
            let edge = if cx <= work.left + zone {
                "left"
            } else if cx >= work.right - zone {
                "right"
            } else {
                ""
            };
            last = edge.to_string();
            let _ = window.emit_to(
                DRAG_LABEL,
                "note:drag",
                DragAt {
                    x: (cx - origin.x) as f64 / scale,
                    y: (cy - origin.y) as f64 / scale,
                    edge: edge.to_string(),
                },
            );

            if edge.is_empty() {
                continue;
            }
            /* ⚠️ The drawer is opened ONCE, the first time the pointer reaches
             * an edge — not on the first millimetre of the drag. Building a
             * webview is the expensive part of this whole gesture, and doing
             * it for every drag that was going somewhere else is the cost
             * nobody sees but everybody feels. */
            if !docked {
                docked = true;
                dock_for_drag(&app, &id, edge, cy);
            } else {
                let _ = app.emit(
                    "notch:note-dock",
                    DockAt { id: id.clone(), edge: edge.to_string(), y: cy, dragging: true },
                );
            }
        }

        if let Some(window) = app.get_webview_window(DRAG_LABEL) {
            let _ = window.hide();
        }
        if !docked {
            return;
        }
        if last.is_empty() {
            /* Let go in the middle of the screen: the note goes back where it
             * was. ⚠️ The window is closed as well as unpinned, or the drawer
             * stays on the edge with nothing in the store saying it should. */
            let snapshot = {
                let state = app.state::<Store>();
                let Ok(mut held) = state.0.lock() else { return };
                if let Some(note) = held.iter_mut().find(|note| note.id == id) {
                    note.pinned = false;
                }
                held.clone()
            };
            close_pin(&app, &id);
            publish(&app, &snapshot);
            return;
        }
        let Some((_, cy)) = crate::win::cursor() else { return };
        dock_note(app.clone(), id.clone(), last, cy);
    });
}

/// Pin a note to an edge mid-drag, and open its drawer there.
fn dock_for_drag(app: &AppHandle, id: &str, edge: &str, y: i32) {
    let snapshot = {
        let state = app.state::<Store>();
        let Ok(mut held) = state.0.lock() else { return };
        let Some(note) = held.iter_mut().find(|note| note.id == id) else { return };
        note.pinned = true;
        note.edge = side_of(edge);
        note.y = y;
        held.clone()
    };
    publish(app, &snapshot);
    if let Some(note) = snapshot.iter().find(|note| note.id == id) {
        if let Err(error) = open_pin(app, note) {
            crate::log::note(&format!("note {id} could not be docked: {error}"));
        }
    }
    let _ = app.emit(
        "notch:note-dock",
        DockAt { id: id.to_string(), edge: side_of(edge), y, dragging: true },
    );
}

/// A few bits of entropy for the id. ⚠️ Not `rand::random` on a `u64`: this is
/// a tiebreaker inside one millisecond, not a security decision, and pulling
/// the RNG in for it is a dependency in a hot path for nothing.
fn rand_bits() -> u64 {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    RandomState::new().build_hasher().finish() & 0xffff
}

#[cfg(test)]
mod tests {
    use super::*;

    /// ⚠️ Truncation on a character boundary. `&body[..MAX_BODY]` panics on the
    /// first note containing a non-ASCII character, which for a Polish user is
    /// most of them — and a panic here takes the note with it.
    #[test]
    fn a_long_note_is_cut_without_panicking_on_a_multibyte_character() {
        let long: String = "ąćęłń".repeat(MAX_BODY);
        let cut: String = long.chars().take(MAX_BODY).collect();
        assert_eq!(cut.chars().count(), MAX_BODY);
        // The bytes are more than the characters, which is the whole point.
        assert!(cut.len() > MAX_BODY);
    }

    /// ⚠️ A note written by an older build, or edited by hand, must load rather
    /// than take the whole list with it. A parse error here loses every note,
    /// and a note is the one thing in this app that cannot be re-derived.
    #[test]
    fn a_half_written_note_still_loads() {
        let held: Vec<Note> = serde_json::from_str(r#"[{"body":"just words"}]"#).unwrap();
        assert_eq!(held[0].body, "just words");
        assert_eq!(held[0].id, "");
        assert_eq!(held[0].written, 0);
    }

    /// Two notes in the same millisecond must not share an id.
    #[test]
    fn ids_do_not_collide_within_a_millisecond() {
        let at = 1_700_000_000_000i64;
        let a = format!("{at:x}-{:x}", 0u64 + rand_bits());
        let b = format!("{at:x}-{:x}", 1u64 + rand_bits());
        assert_ne!(a, b);
    }
}
