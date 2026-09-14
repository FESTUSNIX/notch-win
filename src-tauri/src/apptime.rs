//! Where the day actually went.
//!
//! Polls the foreground window and adds the elapsed seconds to whichever
//! executable owns it. Local only: the totals live beside the config and never
//! leave the machine, and nothing but the process name is recorded — not window
//! titles, which are where the private part of "what were you doing" lives.
//!
//! ⚠️ Idle time is not counted. Without that, a machine left on overnight
//! reports fourteen hours in whatever happened to be in front, and the number
//! stops meaning anything at all.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use chrono::Local;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use windows::Win32::Foundation::{CloseHandle, HWND, MAX_PATH};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_FORMAT, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};

/// How often the foreground is sampled. Each tick credits this many seconds, so
/// a shorter interval buys precision nobody reads at the cost of waking more.
const TICK: u64 = 5;
/// No input for this long and the clock stops. Sixty seconds is short enough
/// that a coffee is not counted and long enough that reading a page is.
const IDLE_AFTER: u64 = 60;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSlice {
    /// The display name, e.g. "VS Code".
    pub name: String,
    pub seconds: u64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppTime {
    pub day: String,
    pub total: u64,
    /// Longest first, and only what is worth showing — see `snapshot`.
    pub apps: Vec<AppSlice>,
}

/// `{ "2026-09-09": { "Code.exe": 5400 } }`, kept small by dropping old days.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct Store {
    days: HashMap<String, HashMap<String, u64>>,
}

#[derive(Default)]
pub struct AppTimeState(Mutex<Store>);

/// Executables whose file name is not what anyone calls them.
fn display(exe: &str) -> String {
    let stem = exe.trim_end_matches(".exe").trim_end_matches(".EXE");
    match stem.to_ascii_lowercase().as_str() {
        "code" | "code - insiders" => "VS Code".into(),
        "devenv" => "Visual Studio".into(),
        "idea64" | "idea" => "IntelliJ".into(),
        "windowsterminal" => "Terminal".into(),
        "chrome" => "Chrome".into(),
        "msedge" => "Edge".into(),
        "brave" => "Brave".into(),
        "firefox" => "Firefox".into(),
        "explorer" => "File Explorer".into(),
        "ms-teams" | "teams" => "Teams".into(),
        "olk" | "outlook" => "Outlook".into(),
        "spotify" => "Spotify".into(),
        "discord" => "Discord".into(),
        "slack" => "Slack".into(),
        "figma" => "Figma".into(),
        "photoshop" => "Photoshop".into(),
        "codenotch" => "Codenotch".into(),
        _ => stem.to_string(),
    }
}

fn idle_seconds() -> u64 {
    let mut info = LASTINPUTINFO {
        cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
        dwTime: 0,
    };
    unsafe {
        if GetLastInputInfo(&mut info).as_bool() {
            let now = windows::Win32::System::SystemInformation::GetTickCount64();
            return (now.saturating_sub(info.dwTime as u64)) / 1000;
        }
    }
    0
}

/// The executable behind the foreground window, if there is one worth counting.
fn foreground_exe() -> Option<String> {
    unsafe {
        let hwnd: HWND = GetForegroundWindow();
        if hwnd.0.is_null() {
            return None;      // the desktop, a lock screen, an Alt-Tab switcher
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == 0 {
            return None;
        }
        // LIMITED_INFORMATION so this works without elevation against processes
        // running at a higher integrity level than us.
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buffer = [0u16; MAX_PATH as usize];
        let mut length = buffer.len() as u32;
        let ok = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_FORMAT(0),
            windows::core::PWSTR(buffer.as_mut_ptr()),
            &mut length,
        );
        let _ = CloseHandle(handle);
        ok.ok()?;
        let path = String::from_utf16_lossy(&buffer[..length as usize]);
        path.rsplit('\\').next().map(|name| name.to_string())
    }
}

fn path() -> Option<std::path::PathBuf> {
    crate::config::path().map(|p| p.with_file_name("apptime.json"))
}

fn load() -> Store {
    path()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn save(store: &Store) {
    let Some(path) = path() else { return };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(text) = serde_json::to_string(store) {
        let _ = std::fs::write(path, text);
    }
}

/// Today's totals, longest first.
///
/// Anything under a minute is dropped: a day has dozens of windows touched in
/// passing, and a list of thirty apps at "0m" says less than a list of five.
fn snapshot(store: &Store) -> AppTime {
    let day = Local::now().format("%Y-%m-%d").to_string();
    let today = store.days.get(&day).cloned().unwrap_or_default();
    let mut apps: Vec<AppSlice> = today
        .iter()
        .filter(|(_, seconds)| **seconds >= 60)
        .map(|(exe, seconds)| AppSlice { name: display(exe), seconds: *seconds })
        .collect();
    apps.sort_by(|a, b| b.seconds.cmp(&a.seconds));
    AppTime {
        total: today.values().sum(),
        apps,
        day,
    }
}

#[tauri::command]
pub fn get_app_time(app: AppHandle) -> AppTime {
    snapshot(&app.state::<AppTimeState>().0.lock().unwrap())
}

pub fn spawn(app: AppHandle) {
    std::thread::spawn(move || {
        {
            let state = app.state::<AppTimeState>();
            *state.0.lock().unwrap() = load();
        }
        let mut since_save = 0u64;
        loop {
            std::thread::sleep(Duration::from_secs(TICK));
            if idle_seconds() >= IDLE_AFTER {
                continue;
            }
            let Some(exe) = foreground_exe() else { continue };
            let day = Local::now().format("%Y-%m-%d").to_string();
            let state = app.state::<AppTimeState>();
            let next = {
                let mut store = state.0.lock().unwrap();
                *store.days.entry(day).or_default().entry(exe).or_insert(0) += TICK;
                // A fortnight is plenty to answer "how did this week go" and
                // keeps the file a few kilobytes rather than growing forever.
                if store.days.len() > 14 {
                    let mut keys: Vec<String> = store.days.keys().cloned().collect();
                    keys.sort();
                    for old in keys.iter().take(store.days.len() - 14) {
                        store.days.remove(old);
                    }
                }
                snapshot(&store)
            };
            let _ = app.emit_to("tasks", "apptime:changed", &next);
            since_save += TICK;
            // Written every couple of minutes, not every tick: this is a
            // background counter, not something worth a disk write per sample.
            if since_save >= 120 {
                since_save = 0;
                save(&state.0.lock().unwrap());
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn executables_become_names_people_use() {
        assert_eq!(display("Code.exe"), "VS Code");
        assert_eq!(display("chrome.exe"), "Chrome");
        // Unknown ones keep their own stem rather than being guessed at.
        assert_eq!(display("Obsidian.exe"), "Obsidian");
        assert_eq!(display("weird"), "weird");
    }

    #[test]
    fn the_snapshot_drops_the_noise_and_sorts_by_time() {
        let day = Local::now().format("%Y-%m-%d").to_string();
        let mut store = Store::default();
        let today = store.days.entry(day).or_default();
        today.insert("Code.exe".into(), 3600);
        today.insert("chrome.exe".into(), 1800);
        today.insert("notepad.exe".into(), 30); // a window touched in passing
        let out = snapshot(&store);
        assert_eq!(out.total, 5430, "the total counts everything, listed or not");
        assert_eq!(out.apps.len(), 2, "under a minute is not worth a row");
        assert_eq!(out.apps[0].name, "VS Code");
        assert_eq!(out.apps[1].name, "Chrome");
    }
}
