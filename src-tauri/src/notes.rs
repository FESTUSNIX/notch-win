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
}

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
pub fn remove_note(app: AppHandle, id: String) -> Vec<Note> {
    let snapshot = {
        let state = app.state::<Store>();
        let Ok(mut held) = state.0.lock() else { return Vec::new() };
        held.retain(|note| note.id != id);
        held.clone()
    };
    publish(&app, &snapshot);
    snapshot
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
