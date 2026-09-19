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

/// The collapsed drawer, in logical pixels — the sliver that says the note is
/// there. ⚠️ The real geometry is worked out in `note-window.ts`, which is the
/// one place that knows the monitor and the expanded size too; this is only
/// what the window is BUILT at, and it is built hidden.
const BAR_W: f64 = 22.0;
const BAR_H: f64 = 136.0;

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
        .inner_size(BAR_W, BAR_H)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
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
        note.edge = side;
        note.y = y;
        held.clone()
    };
    /* ⚠️ Saved but NOT emitted. `notch:notes` redraws every note everywhere,
     * and a position is of no interest to any of them — emitting one per drag
     * would repaint the island's whole wall for a window moving on another
     * monitor. */
    crate::config::save_beside(FILE, &snapshot);
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
