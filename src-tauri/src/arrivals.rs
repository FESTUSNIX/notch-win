//! Peek sources about new files (batch 13): a download that finished, and a
//! screenshot Windows saved (Win+PrtScn, the Snipping Tool's auto-save).
//!
//! Two folders, read every two seconds: `Downloads` and `Pictures\Screenshots`.
//! A file is news once — when it first appears complete — and only if it
//! arrived while codenotch was running; the folder's contents at launch seed.
//!
//! ⚠️ **"Complete" is guessed from the outside**, because no browser says when
//! it is done. Chrome and Edge write `*.crdownload` and rename at the end;
//! Firefox makes the final name EMPTY at the start and writes `*.part` beside
//! it. So a file counts once it is not a partial name, is not empty, has no
//! `.part` sibling, and has kept its size across two reads.
//!
//! ⚠️ **The page never gets the path**, as with thumbs.rs and the shelf. It
//! gets a token, a name and (for a picture) a small preview; opening, showing
//! in the folder and copying go through the commands below by token.

use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Arrival {
    /// Opaque; what the commands below take.
    pub token: String,
    /// `download` or `screenshot`.
    pub kind: &'static str,
    pub name: String,
    /// A `data:image/png` preview (the shell's), for pictures only.
    pub thumb: Option<String>,
}

/// The files announced this session, by token. Bounded: the last few are all
/// a peek can still be clicked for.
static HELD: Mutex<Vec<(String, PathBuf)>> = Mutex::new(Vec::new());

/// Names a browser or an editor is still writing, or never meant to be seen.
pub fn is_partial(name: &str) -> bool {
    let lower = name.to_lowercase();
    const ENDINGS: [&str; 8] = [".crdownload", ".part", ".partial", ".tmp", ".download", ".opdownload", ".!ut", ".temp"];
    lower.starts_with('.')
        || lower.starts_with("~$")
        || lower == "desktop.ini"
        || lower == "thumbs.db"
        || ENDINGS.iter().any(|end| lower.ends_with(end))
}

/// Whether a file seen at `size` now (and `before` on the previous read) is
/// done: a real name, not empty, steady, and no Firefox `.part` beside it.
pub fn is_ready(name: &str, size: u64, before: Option<u64>, siblings: &[String]) -> bool {
    if is_partial(name) || size == 0 || before != Some(size) {
        return false;
    }
    let part = format!("{}.part", name.to_lowercase());
    !siblings.iter().any(|s| s.to_lowercase() == part)
}

fn token_of(path: &Path) -> String {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    path.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

fn is_picture(name: &str) -> bool {
    let lower = name.to_lowercase();
    [".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"].iter().any(|end| lower.ends_with(end))
}

/// Files directly in a folder, with their sizes. Folders are skipped: an
/// unzipped archive is not a download.
fn listing(folder: &Path) -> HashMap<String, u64> {
    let mut out = HashMap::new();
    let Ok(entries) = std::fs::read_dir(folder) else { return out };
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_file() {
            out.insert(entry.file_name().to_string_lossy().into_owned(), meta.len());
        }
    }
    out
}

struct Watch {
    kind: &'static str,
    folder: PathBuf,
    /// Size at the previous read, by name.
    sizes: HashMap<String, u64>,
    /// Already announced, or there at launch.
    done: std::collections::HashSet<String>,
}

impl Watch {
    fn new(kind: &'static str, folder: PathBuf) -> Self {
        let sizes = listing(&folder);
        let done = sizes.keys().cloned().collect();
        Self { kind, folder, sizes, done }
    }

    fn step(&mut self) -> Vec<String> {
        let now = listing(&self.folder);
        let names: Vec<String> = now.keys().cloned().collect();
        let mut ready = Vec::new();
        for (name, size) in &now {
            if self.done.contains(name) {
                continue;
            }
            if is_ready(name, *size, self.sizes.get(name).copied(), &names) {
                self.done.insert(name.clone());
                ready.push(name.clone());
            }
        }
        // A file that went away may come back under the same name as news.
        self.done.retain(|name| now.contains_key(name));
        self.sizes = now;
        ready
    }
}

fn announce(app: &AppHandle, kind: &'static str, path: PathBuf) {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let token = token_of(&path);
    let thumb = if is_picture(&name) { crate::thumbs::of(&path.to_string_lossy()) } else { None };
    {
        let mut held = HELD.lock().unwrap();
        held.retain(|(t, _)| *t != token);
        held.push((token.clone(), path));
        let excess = held.len().saturating_sub(16);
        held.drain(..excess);
    }
    let _ = app.emit_to("tasks", "peek:file", Arrival { token, kind, name, thumb });
}

pub fn spawn(app: AppHandle) {
    crate::guard::spawn("arrivals watch", move || {
        unsafe {
            // The shell's thumbnail cache is COM.
            let _ = windows::Win32::System::Com::CoInitializeEx(None, windows::Win32::System::Com::COINIT_APARTMENTTHREADED);
        }
        let mut watches: Vec<Watch> = Vec::new();
        if let Some(downloads) = dirs::download_dir() {
            watches.push(Watch::new("download", downloads));
        }
        if let Some(pictures) = dirs::picture_dir() {
            // ⚠️ May not exist until the first Win+PrtScn makes it: read anyway,
            // an absent folder is an empty listing and appears later on its own.
            watches.push(Watch::new("screenshot", pictures.join("Screenshots")));
        }
        loop {
            std::thread::sleep(Duration::from_secs(2));
            for watch in &mut watches {
                for name in watch.step() {
                    announce(&app, watch.kind, watch.folder.join(name));
                }
            }
        }
    });
}

fn held(token: &str) -> Result<PathBuf, String> {
    let path = HELD
        .lock()
        .unwrap()
        .iter()
        .find(|(t, _)| t == token)
        .map(|(_, p)| p.clone())
        .ok_or("That file is no longer at hand.")?;
    if !path.exists() {
        return Err("It has moved or been deleted.".into());
    }
    Ok(path)
}

#[tauri::command]
pub fn arrival_open(token: String) -> Result<(), String> {
    crate::calendar::open_path(&held(&token)?.to_string_lossy())
}

#[tauri::command]
pub fn arrival_reveal(token: String) -> Result<(), String> {
    crate::calendar::explore(&held(&token)?.to_string_lossy())
}

/// The file itself onto the clipboard, as Explorer's Copy puts it.
#[tauri::command]
pub fn arrival_copy(token: String) -> Result<(), String> {
    crate::shelf::clipboard::set_files(&[held(&token)?])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn partial_names_are_ignored() {
        for name in ["Unconfirmed 1234.crdownload", "faktura.pdf.part", "x.TMP", ".hidden", "~$doc.docx", "desktop.ini"] {
            assert!(is_partial(name), "{name}");
        }
        assert!(!is_partial("faktura.pdf"));
    }

    #[test]
    fn a_file_is_ready_once_it_is_steady() {
        assert!(!is_ready("a.pdf", 100, None, &[]), "first sight is not enough");
        assert!(!is_ready("a.pdf", 200, Some(100), &[]), "still growing");
        assert!(!is_ready("a.pdf", 0, Some(0), &[]), "Firefox's empty placeholder");
        assert!(!is_ready("a.pdf", 100, Some(100), &["a.pdf.part".into()]), "Firefox still writing");
        assert!(is_ready("a.pdf", 100, Some(100), &["a.pdf".into()]));
    }

    #[test]
    fn a_folder_is_watched_from_now_on() {
        let dir = std::env::temp_dir().join(format!("cn-arrivals-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("old.txt"), b"there at launch").unwrap();
        let mut watch = Watch::new("download", dir.clone());
        std::fs::write(dir.join("new.pdf.crdownload"), b"half").unwrap();
        assert!(watch.step().is_empty());
        std::fs::rename(dir.join("new.pdf.crdownload"), dir.join("new.pdf")).unwrap();
        assert!(watch.step().is_empty(), "seen once");
        assert_eq!(watch.step(), vec!["new.pdf".to_string()]);
        assert!(watch.step().is_empty(), "said once");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
