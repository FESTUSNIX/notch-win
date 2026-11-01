//! JARVIS's hands (2 Nov, stage 1): what the Guardian decides to do on the
//! PC arrives in its chat stream as a `pc` event (Helm's `PcAction`), and is
//! carried out here at once — opening apps, workspaces, sites and files, the
//! music, the volume and the screen, locking, timers.
//!
//! Nothing goes back to Helm: the Guardian has already said "Gotowe." by the
//! time this runs. So when something can't be done (an app nobody installed,
//! nothing playing), it says so itself, as a `peek:pc` in the island.
//!
//! ⚠️ Every action is one of the existing commands, called as functions —
//! the palette's app list, the workspaces, Everything, the media session,
//! the system state, Spotify. A second way to open a thing would drift from
//! the first.

use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

/// The Guardian's `PcAction`, as Helm sends it.
#[derive(Debug, Deserialize)]
#[serde(tag = "do", rename_all = "lowercase")]
enum Action {
    Open { kind: String, target: String },
    Media { action: String },
    Music { query: String },
    Volume { level: Option<i32>, change: Option<i32>, mute: Option<bool> },
    Brightness { level: Option<i32>, change: Option<i32> },
    Lock,
    Timer { seconds: u64, label: Option<String> },
}

/// What the island shows when something couldn't be done, or a timer is up.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Note {
    id: String,
    title: String,
    line: Option<String>,
}

static NOTES: AtomicU64 = AtomicU64::new(1);
/// The voice orders sentences by (turn, seq); a timer speaks as a turn of its
/// own, numbered far above any spoken reply's so the two never wait on each other.
static TIMER_TURN: AtomicU64 = AtomicU64::new(1 << 40);
/// A timer longer than this is a reminder, which Helm keeps.
const LONGEST_TIMER: u64 = 24 * 60 * 60;

/// Carry out one `pc` event's action, in the background.
pub fn perform(app: AppHandle, action: &serde_json::Value) {
    // Something the Guardian needs back (stage 2): the eyes answer it.
    if action.get("ask").is_some() {
        return crate::eyes::answer(app, action);
    }
    let action = match serde_json::from_value::<Action>(action.clone()) {
        Ok(action) => action,
        Err(_) => return note(&app, "Tego nie umiem zrobić na tym komputerze.", None),
    };
    tauri::async_runtime::spawn(async move {
        if let Err(why) = run(&app, action).await {
            note(&app, &why, None);
        }
    });
}

fn note(app: &AppHandle, title: &str, line: Option<String>) {
    let id = format!("pc:{}", NOTES.fetch_add(1, Ordering::SeqCst));
    let _ = app.emit_to("tasks", "peek:pc", Note { id, title: title.to_string(), line });
}

async fn run(app: &AppHandle, action: Action) -> Result<(), String> {
    match action {
        Action::Open { kind, target } => open(app, &kind, target.trim()).await,
        Action::Media { action } => media(app, &action).await,
        Action::Music { query } => music(app, query.trim()).await,
        Action::Volume { level, change, mute } => {
            let now = crate::system::get_system().await?;
            if now.volume < 0 && mute.is_none() {
                return Err("Nie widzę głośników.".into());
            }
            let level = match (level, change) {
                (Some(level), _) => level,
                (None, Some(change)) => now.volume + change,
                (None, None) => now.volume,
            };
            // A change of the level is heard: it unmutes, unless he asked otherwise.
            let muted = mute.or(if level != now.volume { Some(false) } else { None });
            crate::system::set_volume(level.clamp(0, 100), muted).await
        }
        Action::Brightness { level, change } => {
            let now = crate::system::get_system().await?;
            if now.brightness < 0 {
                return Err("Ten monitor nie daje sobie zmienić jasności.".into());
            }
            let level = level.unwrap_or(now.brightness + change.unwrap_or(0));
            crate::system::set_brightness(level.clamp(0, 100)).await
        }
        Action::Lock => crate::system::lock_workstation(),
        Action::Timer { seconds, label } => {
            if seconds == 0 || seconds > LONGEST_TIMER {
                return Err("Taki timer to raczej przypomnienie.".into());
            }
            let app = app.clone();
            tauri::async_runtime::spawn(async move { ring(app, seconds, label).await });
            Ok(())
        }
    }
}

/* ── Opening things ───────────────────────────────────────────────────── */

async fn open(app: &AppHandle, kind: &str, target: &str) -> Result<(), String> {
    match kind {
        "app" => {
            let apps = crate::apps::list_apps().await?;
            let names: Vec<&str> = apps.iter().map(|a| a.name.as_str()).collect();
            let at = best(target, &names).ok_or_else(|| format!("Nie znalazłem aplikacji „{target}”."))?;
            crate::apps::launch_app(apps[at].path.clone())
        }
        "workspace" => {
            let all = crate::workspaces::get_workspaces(app.clone());
            let ids: Vec<&String> = all.keys().collect();
            let names: Vec<&str> = all.values().map(|w| w.name.as_str()).collect();
            let at = best(target, &names).ok_or_else(|| format!("Nie ma workspace’u „{target}”."))?;
            crate::workspaces::open_workspace(app.clone(), ids[at].clone()).map(|_| ())
        }
        "site" => {
            if !(target.starts_with("https://") || target.starts_with("http://")) || target.chars().any(char::is_whitespace) {
                return Err("To nie jest adres strony.".into());
            }
            crate::calendar::open_path(target)
        }
        "file" | "folder" if std::path::Path::new(target).is_absolute() && std::path::Path::new(target).exists() => crate::everything::found_open(target.to_string()),
        "file" | "folder" => {
            let hits = crate::everything::everything_search(target.to_string(), 20).await.map_err(|_| "Wyszukiwanie plików (Everything) nie odpowiada.".to_string())?;
            let want_folder = kind == "folder";
            let hit = hits.iter().find(|h| h.folder == want_folder).ok_or_else(|| format!("Nie znalazłem „{target}”."))?;
            crate::everything::found_open(hit.full.clone())
        }
        _ => Err("Tego nie umiem otworzyć.".into()),
    }
}

/// Folds a name for matching: lower case, Polish letters as plain ones, only letters and digits.
fn fold(s: &str) -> String {
    s.to_lowercase()
        .chars()
        .map(|c| match c {
            'ą' => 'a', 'ć' => 'c', 'ę' => 'e', 'ł' => 'l', 'ń' => 'n', 'ó' => 'o', 'ś' => 's', 'ź' | 'ż' => 'z',
            other => other,
        })
        .filter(|c| c.is_alphanumeric())
        .collect()
}

/// What people say for an app whose name is longer.
fn alias(folded: &str) -> &str {
    match folded {
        "vscode" | "code" => "visualstudiocode",
        "przegladarka" | "browser" => "chrome",
        "terminal" => "windowsterminal",
        "kalkulator" => "calculator",
        "notatnik" => "notepad",
        "eksplorator" | "explorer" => "fileexplorer",
        other => other,
    }
}

/// The name that best fits what he said, by its index: the same name, then one
/// that starts with it, then one that has it inside, then one with all its
/// words; the shortest name wins a tie ("Spotify" over "Spotify Widget").
fn best(said: &str, names: &[&str]) -> Option<usize> {
    let said_folded = fold(said);
    let want = alias(&said_folded);
    if want.is_empty() {
        return None;
    }
    let words: Vec<String> = said.split_whitespace().map(fold).filter(|w| !w.is_empty()).collect();
    let score = |name: &str| -> u8 {
        let name = fold(name);
        if name == want {
            4
        } else if name.starts_with(want) {
            3
        } else if name.contains(want) {
            2
        } else if words.len() > 1 && words.iter().all(|w| name.contains(w.as_str())) {
            1
        } else {
            0
        }
    };
    names
        .iter()
        .enumerate()
        .map(|(i, n)| (i, score(n), n.chars().count()))
        .filter(|(_, s, _)| *s > 0)
        .max_by(|a, b| a.1.cmp(&b.1).then(b.2.cmp(&a.2)))
        .map(|(i, _, _)| i)
}

/* ── Music ────────────────────────────────────────────────────────────── */

async fn media(app: &AppHandle, action: &str) -> Result<(), String> {
    let now = crate::media::get_media(app.clone());
    // There is only a toggle: play and pause read the state first, so "pauza"
    // on something already paused doesn't start it.
    let wanted = match action {
        "play" if now.playing => return Ok(()),
        "pause" if !now.playing => return Ok(()),
        "play" | "pause" | "toggle" => "playpause",
        "next" => "next",
        "previous" => "previous",
        _ => return Err("Tego nie umiem z muzyką.".into()),
    };
    crate::media::media_command(wanted.to_string()).await.map_err(|why| if now.active { why } else { "Nic teraz nie gra.".into() })
}

/// Something to play, from Spotify: the best match goes into the queue and is
/// skipped to, so it plays now.
async fn music(app: &AppHandle, query: &str) -> Result<(), String> {
    if !crate::spotify::spotify_status() {
        return Err("Spotify nie jest połączony (Ustawienia → Połączenia).".into());
    }
    let found = crate::spotify::spotify_search(query.to_string()).await?;
    let first = found.first().ok_or_else(|| format!("Spotify nie zna „{query}”."))?;
    crate::spotify::spotify_enqueue(first.uri.clone()).await?;
    crate::media::media_command("next".into()).await?;
    tokio::time::sleep(Duration::from_millis(800)).await;
    if !crate::media::get_media(app.clone()).playing {
        let _ = crate::media::media_command("playpause".into()).await;
    }
    Ok(())
}

/* ── Timers ───────────────────────────────────────────────────────────── */

/// A timer: its time, then the alarm, a peek that stays until he looks, and
/// the label said out loud (unless he's in a call, presenting, or has spoken
/// replies off — the voice's own rule).
async fn ring(app: AppHandle, seconds: u64, label: Option<String>) {
    tokio::time::sleep(Duration::from_secs(seconds)).await;
    crate::sound::play("Notification.Reminder");
    let label = label.map(|l| l.trim().to_string()).filter(|l| !l.is_empty());
    let said = match &label {
        Some(label) => format!("Czas minął: {label}."),
        None => "Czas minął.".to_string(),
    };
    let id = format!("timer:{}", NOTES.fetch_add(1, Ordering::SeqCst));
    let _ = app.emit_to("tasks", "peek:timer", json!({ "id": id, "title": label.clone().unwrap_or_else(|| "Timer".into()), "line": minutes_said(seconds) }));
    let turn = TIMER_TURN.fetch_add(1, Ordering::SeqCst);
    let _ = crate::voice::voice_say(app, said, turn, 0).await;
}

/// "9 min", "1 h 30 min", "45 s": how long it ran.
fn minutes_said(seconds: u64) -> String {
    match seconds {
        s if s < 60 => format!("{s} s"),
        s if s < 3600 => format!("{} min", s / 60),
        s if s % 3600 == 0 => format!("{} h", s / 3600),
        s => format!("{} h {} min", s / 3600, (s % 3600) / 60),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const APPS: [&str; 7] = ["Figma", "Visual Studio Code", "Spotify", "Spotify Widget", "Google Chrome", "Microsoft Edge", "Notion Calendar"];

    #[test]
    fn the_app_he_names_is_the_one_opened() {
        let at = |said: &str| best(said, &APPS).map(|i| APPS[i]);
        assert_eq!(at("figma"), Some("Figma"));
        assert_eq!(at("Figmę").is_none(), true, "an inflected name is the Guardian's to give in full");
        assert_eq!(at("VS Code"), Some("Visual Studio Code"));
        assert_eq!(at("spotify"), Some("Spotify"), "the shorter name wins a tie");
        assert_eq!(at("chrome"), Some("Google Chrome"));
        assert_eq!(at("przeglądarka"), Some("Google Chrome"));
        assert_eq!(at("notion calendar"), Some("Notion Calendar"));
        assert_eq!(at("photoshop"), None);
        assert_eq!(at(""), None);
    }

    #[test]
    fn polish_letters_fold() {
        assert_eq!(fold("Zażółć Gęślą"), "zazolcgesla");
    }

    #[test]
    fn the_guardian_s_actions_parse() {
        let parse = |v: serde_json::Value| serde_json::from_value::<Action>(v).is_ok();
        assert!(parse(json!({ "do": "open", "kind": "app", "target": "Figma" })));
        assert!(parse(json!({ "do": "volume", "level": null, "change": -15, "mute": null })));
        assert!(parse(json!({ "do": "timer", "seconds": 540, "label": "makaron" })));
        assert!(parse(json!({ "do": "lock" })));
        assert!(!parse(json!({ "do": "format_disk" })));
    }

    #[test]
    fn a_timer_says_how_long_it_ran() {
        assert_eq!(minutes_said(45), "45 s");
        assert_eq!(minutes_said(540), "9 min");
        assert_eq!(minutes_said(7200), "2 h");
        assert_eq!(minutes_said(5400), "1 h 30 min");
    }
}
