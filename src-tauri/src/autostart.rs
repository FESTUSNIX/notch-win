//! Start with Windows.
//!
//! The `Run` key rather than a scheduled task or a Startup-folder shortcut:
//! it needs no elevation, no XML, and no shortcut file to go stale when the
//! executable moves. It is also the one every settings UI on Windows shows the
//! user, so removing it by hand does what they expect.
//!
//! `SMAppService.mainApp` is the macOS counterpart, and it has a failure mode
//! this does not: it refuses unless the app lives in /Applications. Here the
//! path is simply recorded, wherever it is.

use std::path::PathBuf;

use windows_registry::CURRENT_USER;

const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const VALUE: &str = "Codenotch";

fn executable() -> Option<PathBuf> {
    std::env::current_exe().ok()
}

/// The command line the Run key should hold: the exe, quoted, because
/// `%LOCALAPPDATA%\Programs\...` reliably contains spaces on some installs and
/// an unquoted path there starts a different program.
fn command() -> Option<String> {
    Some(format!("\"{}\"", executable()?.display()))
}

pub fn is_enabled() -> bool {
    let Ok(key) = CURRENT_USER.open(RUN_KEY) else {
        return false;
    };
    let Ok(stored) = key.get_string(VALUE) else {
        return false;
    };
    // Enabled *and* pointing at this build. A stale entry from a previous
    // location is worse than none: it silently launches the old executable.
    command().map(|want| stored == want).unwrap_or(false)
}

pub fn set(enabled: bool) -> Result<(), String> {
    let key = CURRENT_USER
        .create(RUN_KEY)
        .map_err(|error| error.to_string())?;
    if enabled {
        let value = command().ok_or_else(|| "cannot locate this executable".to_string())?;
        key.set_string(VALUE, &value)
            .map_err(|error| error.to_string())
    } else {
        match key.remove_value(VALUE) {
            Ok(()) => Ok(()),
            // Already absent is the state that was asked for.
            Err(_) if !is_enabled() => Ok(()),
            Err(error) => Err(error.to_string()),
        }
    }
}

#[tauri::command]
pub fn get_autostart() -> bool {
    is_enabled()
}

#[tauri::command]
pub fn set_autostart(enabled: bool) -> Result<(), String> {
    set(enabled)
}
