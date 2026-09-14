//! The things you keep.
//!
//! Recency is a guess the palette makes about you and can afford to be wrong
//! about; a star is something you said. That difference is the whole reason
//! this is not another `localStorage` key beside `palette-recent`: the WebView's
//! storage is the right home for a disposable guess and the wrong home for a
//! choice, because a cleared profile is an ordinary event and losing a
//! deliberately-kept list to one would be a bug rather than a shrug.
//!
//! ⚠️ Any stable id may be starred — an application, a screen, a command, a
//! shelf item, and **a file or a folder**, whose id is its path. That last one
//! is the point: starring `codenotch-win` once puts it two keystrokes away for
//! ever, with no round trip to Everything.
//!
//! Kept beside the config as its own file, the way `snooze.json` is, so a
//! corrupt list can never stop the app starting with the user's edge intact.

use std::collections::BTreeMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

const FILE: &str = "stars.json";

/// Enough to rebuild the row without whatever produced it.
///
/// ⚠️ A bare id would NOT have been enough, and that is the whole design
/// here. A star has to show up in the empty palette, and with only an id there
/// is nothing to draw: Everything is not asked on an empty query, so a starred
/// folder would exist in the file and appear nowhere. The snapshot is also what
/// makes a starred file survive Everything being closed.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Star {
    pub title: String,
    pub note: String,
    /// A `TaskIcon` name. Crosses the boundary as data — see task-icons.ts.
    pub icon: String,
    /// What to do with `path`: `app` launches it, `file` opens it. Anything
    /// else is left to whichever provider owns the id, which is the case for
    /// screens, commands and the shelf — they enumerate themselves already.
    pub kind: String,
    pub path: String,
}

/// ⚠️ A `BTreeMap`, so the file is stable between writes. A `HashMap` would
/// reorder the JSON on every save and turn "star one thing" into a whole-file
/// diff, which matters the first time anyone opens it in an editor.
#[derive(Default)]
pub struct Store(pub Mutex<BTreeMap<String, Star>>);

pub fn load(app: &AppHandle) {
    let stored: BTreeMap<String, Star> = crate::config::load_beside(FILE).unwrap_or_default();
    if let Ok(mut held) = app.state::<Store>().0.lock() {
        *held = stored;
    }
}

fn publish(app: &AppHandle, held: &BTreeMap<String, Star>) {
    crate::config::save_beside(FILE, held);
    let _ = app.emit("notch:stars", held.clone());
}

#[tauri::command]
pub fn get_stars(app: AppHandle) -> BTreeMap<String, Star> {
    app.state::<Store>().0.lock().map(|held| held.clone()).unwrap_or_default()
}

/// Star it, or take the star off. Returns whether it is starred afterwards, so
/// the caller never has to guess which way a toggle went.
#[tauri::command]
pub fn set_star(app: AppHandle, id: String, star: Option<Star>) -> bool {
    if id.is_empty() {
        return false;
    }
    let on = star.is_some();
    let snapshot = {
        let state = app.state::<Store>();
        let Ok(mut held) = state.0.lock() else { return false };
        match star {
            Some(record) => { held.insert(id, record); }
            None => { held.remove(&id); }
        }
        held.clone()
    };
    publish(&app, &snapshot);
    on
}

#[cfg(test)]
mod tests {
    use super::*;

    /// ⚠️ Stable order on disk. A `HashSet` reorders the whole file on every
    /// save, so starring one thing rewrites every line of it.
    #[test]
    fn the_file_keeps_a_stable_order() {
        let mut held = BTreeMap::new();
        for id in ["app:C:/z.lnk", "go:today", "app:C:/a.lnk"] {
            held.insert(id.to_string(), Star::default());
        }
        let once = serde_json::to_string(&held).unwrap();
        held.insert("go:shelf".to_string(), Star::default());
        held.remove("go:shelf");
        assert_eq!(once, serde_json::to_string(&held).unwrap());
        assert!(once.find("app:C:/a.lnk").unwrap() < once.find("app:C:/z.lnk").unwrap());
    }

    /// ⚠️ A star written by an older build, or edited by hand, must load
    /// rather than take the whole list down with it. `serde(default)` is what
    /// makes a missing field an empty string instead of a parse error — and a
    /// parse error here loses every star, not one.
    #[test]
    fn a_half_written_record_still_loads() {
        let held: BTreeMap<String, Star> =
            serde_json::from_str(r#"{"go:today":{"title":"Today"}}"#).unwrap();
        assert_eq!(held["go:today"].title, "Today");
        assert_eq!(held["go:today"].kind, "");
        assert_eq!(held["go:today"].path, "");
    }
}
