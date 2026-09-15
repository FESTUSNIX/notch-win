//! A project, and everything you open to work on it.
//!
//! Starting on `akcesfonia` is five gestures every time: find the folder, open
//! the editor at it, open the browser at the store, find the terminal, raise the
//! session if one is already running. None of them is hard and all of them are
//! the same five, every morning, per project — and the app already knows the
//! folder, because a live session carries its own `cwd`.
//!
//! ⚠️ **There is no editor for these, and that is the design.** A workspace
//! screen with a folder picker and an app list is a form to fill in before the
//! feature does anything, which is how a feature like this ends up used once.
//! They are made from things already on screen instead: a live session becomes
//! a workspace in one keystroke (its folder is known), and an application is
//! added to one from the palette row that launches it.
//!
//! Kept beside the config as its own file, the way `stars.json` is.

use std::collections::BTreeMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

const FILE: &str = "workspaces.json";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Workspace {
    /// What you type to reach it. The project's folder name, to begin with.
    pub name: String,
    /// The working directory. Opening this is the one thing every workspace
    /// does, so a workspace without one is not saved.
    pub folder: String,
    /// Shortcuts or executables, in the order they should come up.
    pub apps: Vec<String>,
}

#[derive(Default)]
pub struct Store(pub Mutex<BTreeMap<String, Workspace>>);

pub fn load(app: &AppHandle) {
    let stored: BTreeMap<String, Workspace> =
        crate::config::load_beside(FILE).unwrap_or_default();
    if let Ok(mut held) = app.state::<Store>().0.lock() {
        *held = stored;
    }
}

fn publish(app: &AppHandle, held: &BTreeMap<String, Workspace>) {
    crate::config::save_beside(FILE, held);
    let _ = app.emit("notch:workspaces", held.clone());
}

#[tauri::command]
pub fn get_workspaces(app: AppHandle) -> BTreeMap<String, Workspace> {
    app.state::<Store>().0.lock().map(|held| held.clone()).unwrap_or_default()
}

/// Create one, or replace it. The id is the caller's — the folder path, in
/// practice, which is what makes "save this session as a workspace" idempotent
/// however many times it is pressed.
#[tauri::command]
pub fn save_workspace(app: AppHandle, id: String, workspace: Workspace) -> Result<(), String> {
    if id.is_empty() || workspace.folder.is_empty() {
        return Err("A workspace needs a folder.".into());
    }
    let snapshot = {
        let state = app.state::<Store>();
        let Ok(mut held) = state.0.lock() else { return Err("Busy.".into()) };
        held.insert(id, workspace);
        held.clone()
    };
    publish(&app, &snapshot);
    Ok(())
}

#[tauri::command]
pub fn remove_workspace(app: AppHandle, id: String) {
    let snapshot = {
        let state = app.state::<Store>();
        let Ok(mut held) = state.0.lock() else { return };
        held.remove(&id);
        held.clone()
    };
    publish(&app, &snapshot);
}

/// Add an application to a workspace without rewriting the rest of it.
///
/// ⚠️ Deduped. The palette offers this on every app row, so pressing it twice
/// on Brave is an ordinary accident rather than an unusual one.
#[tauri::command]
pub fn add_to_workspace(app: AppHandle, id: String, path: String) -> Result<String, String> {
    let (name, snapshot) = {
        let state = app.state::<Store>();
        let mut held = state.0.lock().map_err(|_| "Busy.")?;
        let workspace = held.get_mut(&id).ok_or("That workspace is gone.")?;
        if !workspace.apps.iter().any(|existing| existing == &path) {
            workspace.apps.push(path);
        }
        (workspace.name.clone(), held.clone())
    };
    publish(&app, &snapshot);
    Ok(name)
}

/// Open the folder, then everything filed under it.
///
/// ⚠️ Every failure is collected rather than returned at the first one. A
/// workspace is several things; an editor that would not start is no reason to
/// leave the browser and the folder unopened, and "3 of 4" is a more useful
/// answer than the first error.
#[tauri::command]
pub fn open_workspace(app: AppHandle, id: String) -> Result<String, String> {
    let workspace = {
        let state = app.state::<Store>();
        let held = state.0.lock().map_err(|_| "Busy.")?;
        held.get(&id).cloned().ok_or("That workspace is gone.")?
    };

    let mut opened = 0;
    let mut failed: Vec<String> = Vec::new();
    match crate::calendar::open_path(&workspace.folder) {
        Ok(()) => opened += 1,
        Err(why) => failed.push(why),
    }
    for path in &workspace.apps {
        match crate::calendar::open_path(path) {
            Ok(()) => opened += 1,
            Err(why) => failed.push(why),
        }
    }
    if failed.is_empty() {
        Ok(format!("{opened} opened"))
    } else if opened > 0 {
        Ok(format!("{opened} opened, {} would not", failed.len()))
    } else {
        Err(failed.remove(0))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// ⚠️ `serde(default)` throughout: a workspace written by an older build,
    /// or edited by hand, must load rather than take every other one down with
    /// it. A parse error here loses the whole file, not one entry.
    #[test]
    fn a_half_written_workspace_still_loads() {
        let held: BTreeMap<String, Workspace> =
            serde_json::from_str(r#"{"c:/code/app":{"name":"app"}}"#).unwrap();
        assert_eq!(held["c:/code/app"].name, "app");
        assert!(held["c:/code/app"].folder.is_empty());
        assert!(held["c:/code/app"].apps.is_empty());
    }

    /// The id is the folder, which is what makes saving the same session twice
    /// idempotent rather than a second workspace with the same name.
    #[test]
    fn saving_the_same_folder_twice_is_one_workspace() {
        let mut held: BTreeMap<String, Workspace> = BTreeMap::new();
        let make = |apps: Vec<String>| Workspace {
            name: "app".into(),
            folder: "c:/code/app".into(),
            apps,
        };
        held.insert("c:/code/app".into(), make(vec![]));
        held.insert("c:/code/app".into(), make(vec!["brave.lnk".into()]));
        assert_eq!(held.len(), 1);
        assert_eq!(held["c:/code/app"].apps.len(), 1);
    }
}
