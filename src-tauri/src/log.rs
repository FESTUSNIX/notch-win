//! A few hundred lines of what just happened.
//!
//! ⚠️ **`println!` goes nowhere in this app.** The release build is a windows
//! subsystem binary with no console attached, so every `println!` and
//! `eprintln!` in the tree is dead outside `cargo run` — which is exactly when
//! nothing interesting is wrong. Nineteen background threads, forty-three
//! `unwrap`s and a dozen Win32 calls that fail silently, and until now the
//! record of all of it was nothing at all.
//!
//! Deliberately small: one file, capped, no levels, no crate. The question it
//! has to answer is "what did the app think happened just before the thing I
//! am complaining about", and a rolling text file answers that.

use std::io::Write;

const FILE: &str = "log.txt";
/// Trimmed to half this when it is exceeded, so the trim is rare rather than
/// on every line.
const CAP: u64 = 256 * 1024;

fn path() -> Option<std::path::PathBuf> {
    crate::config::beside(FILE)
}

/// Append one line. Never fails loudly: a logger that can panic is worse than
/// no logger, and this runs on every background thread in the app.
/// One line, from the web layer.
///
/// ⚠️ The only way to see what a page did. Three of the windows in this app are
/// invisible when they misbehave — the ring, the drop zones, a hidden drawer —
/// and `console.log` in a WebView nobody can open a devtools window on is a
/// message to nobody. Capped, because a page in a loop is a page that can fill
/// a disk.
#[tauri::command]
pub fn log_line(window: tauri::WebviewWindow, line: String) {
    let said: String = line.chars().take(200).collect();
    note(&format!("{}: {said}", window.label()));
}

pub fn note(line: &str) {
    let Some(path) = path() else { return };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0) > CAP {
        trim(&path);
    }
    let stamp = chrono::Local::now().format("%H:%M:%S%.3f");
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(file, "{stamp} {line}");
    }
    // Still useful under `cargo run`, where there IS a console.
    if cfg!(debug_assertions) {
        println!("[notch] {line}");
    }
}

/// Keep the newest half. ⚠️ Read, cut, write — not a truncate: something else
/// may be appending, and a file this small is cheaper to rewrite than to
/// coordinate over.
fn trim(path: &std::path::Path) {
    let Ok(text) = std::fs::read_to_string(path) else {
        let _ = std::fs::remove_file(path);
        return;
    };
    let keep: Vec<&str> = text.lines().skip(text.lines().count() / 2).collect();
    let _ = std::fs::write(path, keep.join("\n") + "\n");
}

/// Open it in whatever reads .txt. Offered from the tray, because a log nobody
/// can find is a log nobody reads.
#[tauri::command]
pub fn open_log() -> Result<(), String> {
    let path = path().ok_or("There is nowhere to keep a log.")?;
    if !path.exists() {
        note("log opened");
    }
    crate::calendar::open_path(&path.to_string_lossy())
}
