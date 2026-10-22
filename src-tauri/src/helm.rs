//! Helm, in the notch.
//!
//! Helm is Mateusz's work OS (crm.hadastudios.com). Its Guardian nudges him
//! through the day and keeps the day's focus blocks; this module is the PC's
//! side of that:
//!
//! - **Today**: every 20 s it reads `/api/desktop` (the must-win, the blocks,
//!   the Guardian's unread nudges) and sends it to the island as
//!   `helm:changed`. `helm_act` starts, pauses and finishes blocks there.
//! - **Nudges**: a new one plays the chosen sound, again after three minutes if
//!   it's still unread, and keeps the chrome up over a full-screen app or a
//!   manual hide until it's read. They must not be missed; see `shortcuts`.
//! - **The chat**: Helm's own `/panel` in a window of its own. The chat needs
//!   his signed-in session, which a device key can't stand in for, so the page
//!   signs in once and WebView2 keeps the cookie. The page gets no IPC: Tauri
//!   refuses a remote origin without a capability, and none is granted.
//! - **Coding minutes**: while VS Code is in front and he has used the keyboard
//!   or mouse in the last minute (apptime's idle rule, so `sample` is called
//!   from its tick), the workspace VS Code has open is noted once per minute and
//!   sent to `/api/activity` every few minutes.
//!
//! ⚠️ Only the workspace's name leaves the machine: the folder VS Code shows
//! in its title, which is also how Helm names a repo. The rest of the title
//! (the open file) is read in memory and dropped, keeping apptime's rule that
//! window titles are never stored.
//!
//! Connected in Settings → Connections with Helm's address and a key from the
//! Guardian page (Devices → Connect codenotch), kept in Credential Manager. The
//! Claude Code hook's `~/.helm/activity.json` still works for the minutes
//! alone; its key can't read today.

use std::collections::{BTreeSet, HashMap};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use chrono::Local;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use windows::Win32::UI::Shell::{SHQueryUserNotificationState, QUNS_PRESENTATION_MODE};
use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;

use crate::credentials;

/// How often today is read. Helm decides on a nudge every five minutes, so
/// this is how late one can reach the notch; a start or a pause reads at once.
const POLL: Duration = Duration::from_secs(20);
/// How often the noted coding minutes are sent. Helm reads them at the end of
/// the day and the Guardian every five minutes, so sooner buys nothing.
const FLUSH_EVERY: Duration = Duration::from_secs(180);
/// A nudge still unread this long after its sound makes it once more: he may
/// have been looking at the other screen. Once, not on a loop.
const RING_AGAIN: Duration = Duration::from_secs(180);
/// What the activity endpoint takes in one request; while Helm can't be reached
/// the oldest minutes go first.
const MAX_HELD: usize = 2000;
const CHAT: &str = "helm-chat";

/* ── Where Helm is ───────────────────────────────────────────────────── */

#[derive(Clone, Deserialize, Serialize)]
struct Config {
    url: String,
    key: String,
}

/// The connection made in Settings: a key that can read today.
fn connected() -> Option<Config> {
    let text = credentials::read(credentials::HELM).ok()??;
    serde_json::from_str(&text).ok()
}

/// Where coding minutes go: the connection, else the Claude Code hook's file.
fn reporting() -> Option<Config> {
    connected().or_else(|| {
        let path = dirs::home_dir()?.join(".helm").join("activity.json");
        let config: Config = serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()?;
        (!config.url.is_empty() && !config.key.is_empty()).then_some(config)
    })
}

fn http() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .user_agent("codenotch-win-helm/0.1")
            .build()
            .expect("HTTP client")
    })
}

/// Helm's origin from what was typed: https anywhere, plain http only on this
/// machine (a local build), never a path.
fn normalise(url: &str) -> Result<String, String> {
    let parsed = tauri::Url::parse(url.trim()).map_err(|_| "That isn't a web address.".to_string())?;
    let local = matches!(parsed.host_str(), Some("localhost" | "127.0.0.1"));
    if parsed.scheme() != "https" && !(parsed.scheme() == "http" && local) {
        return Err("Helm's address starts with https://.".into());
    }
    Ok(parsed.origin().ascii_serialization())
}

/* ── Today, as Helm sends it ─────────────────────────────────────────── */

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Day {
    pub must_win: Option<String>,
    pub done_looks_like: Option<String>,
    pub first_step: Option<String>,
    pub woke_at: Option<String>,
    pub closed_at: Option<String>,
    pub off: bool,
}

/// Minutes since midnight.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Rhythm {
    pub on: bool,
    pub wake: u32,
    pub start: u32,
    pub close: u32,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Block {
    pub id: i64,
    pub title: String,
    /// planned | running | paused | done | skipped
    pub status: String,
    pub planned_at: Option<String>,
    pub minutes: u32,
    pub started_at: Option<String>,
    pub run_started_at: Option<String>,
    pub finished_at: Option<String>,
    pub elapsed_seconds: i64,
    pub project: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Nudge {
    pub id: i64,
    pub kind: String,
    pub title: Option<String>,
    pub body: String,
    /// Where its action goes in Helm: `/start`, `/morning`, `/end`…
    pub url: Option<String>,
    pub at: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Today {
    pub now: String,
    pub today: String,
    pub day: Option<Day>,
    pub rhythm: Option<Rhythm>,
    pub blocks: Vec<Block>,
    pub nudges: Vec<Nudge>,
    /// The quick replies Helm's own panel offers under a nudge.
    pub replies: Vec<String>,
}

/// What the island draws.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Helm {
    pub connected: bool,
    /// The last good reading. ⚠️ Kept through a failure: a block's timer that
    /// vanished because one request timed out would be a made-up state.
    pub today: Option<Today>,
    /// The last failure, as a sentence.
    pub error: Option<String>,
    /// This clock minus Helm's at the reading, so a running block counts from
    /// when Helm says it started rather than from this machine's idea of it.
    pub skew_ms: i64,
    /// Presenting or sharing the screen: a nudge on the pill keeps its words to
    /// itself until hovered, because the room may be watching.
    pub presenting: bool,
}

#[derive(Default)]
pub struct HelmState(Mutex<Helm>);

fn current(app: &AppHandle) -> Helm {
    app.state::<HelmState>().0.lock().map(|held| held.clone()).unwrap_or_default()
}

fn publish(app: &AppHandle, next: Helm) {
    if let Ok(mut held) = app.state::<HelmState>().0.lock() {
        *held = next.clone();
    }
    let _ = app.emit_to("tasks", "helm:changed", &next);
}

fn presenting() -> bool {
    matches!(unsafe { SHQueryUserNotificationState() }, Ok(state) if state == QUNS_PRESENTATION_MODE)
}

async fn read_today(config: &Config) -> Result<(Today, i64), String> {
    let response = http()
        .get(format!("{}/api/desktop", config.url))
        .bearer_auth(&config.key)
        .send()
        .await
        .map_err(|_| "Can't reach Helm.".to_string())?;
    match response.status().as_u16() {
        200 => {}
        401 => return Err("Helm doesn't know this key. Connect it again in Settings.".into()),
        status => return Err(format!("Helm answered {status}.")),
    }
    let today: Today = response.json().await.map_err(|_| "Helm sent something unexpected.".to_string())?;
    let skew = chrono::DateTime::parse_from_rfc3339(&today.now)
        .map(|server| Local::now().timestamp_millis() - server.timestamp_millis())
        .unwrap_or(0);
    Ok((today, skew))
}

/* ── Nudges that must not be missed ──────────────────────────────────── */

/// Which unread nudges make a sound: a new one at once, and each once more
/// after `RING_AGAIN` while it's still unread. Read ones are forgotten.
#[derive(Default)]
struct Bell {
    /// Nudge id → when it first rang, and whether it has rung again.
    rang: HashMap<i64, (Instant, bool)>,
}

impl Bell {
    fn ring(&mut self, unread: &[i64], now: Instant) -> bool {
        self.rang.retain(|id, _| unread.contains(id));
        let mut ring = false;
        for id in unread {
            match self.rang.get_mut(id) {
                None => {
                    self.rang.insert(*id, (now, false));
                    ring = true;
                }
                Some((at, again)) if !*again && now.duration_since(*at) >= RING_AGAIN => {
                    *again = true;
                    ring = true;
                }
                _ => {}
            }
        }
        ring
    }
}

async fn poll(app: &AppHandle, bell: &mut Bell) {
    let Some(config) = connected() else {
        if current(app).connected {
            publish(app, Helm::default());
            crate::shortcuts::set_nudge_up(app, false, false);
        }
        return;
    };
    let mut next = current(app);
    next.connected = true;
    next.presenting = presenting();
    match read_today(&config).await {
        Ok((today, skew)) => {
            let unread: Vec<i64> = today.nudges.iter().map(|n| n.id).collect();
            let ring = bell.ring(&unread, Instant::now());
            if ring {
                crate::sound::play(&crate::prefs::current(app).helm_sound);
            }
            crate::shortcuts::set_nudge_up(app, !unread.is_empty(), ring);
            next.today = Some(today);
            next.error = None;
            next.skew_ms = skew;
        }
        Err(message) => next.error = Some(message),
    }
    publish(app, next);
}

/// Read again now, after an action or a new connection, rather than in 20 s.
fn poke() -> &'static tokio::sync::Notify {
    static POKE: OnceLock<tokio::sync::Notify> = OnceLock::new();
    POKE.get_or_init(tokio::sync::Notify::new)
}

/* ── Commands ────────────────────────────────────────────────────────── */

#[tauri::command]
pub fn get_helm(app: AppHandle) -> Helm {
    current(&app)
}

/// Whether Helm is connected. ⚠️ A BOOLEAN, never the key, as `binance_connected`.
#[tauri::command]
pub fn helm_connected() -> bool {
    connected().is_some()
}

/// Store the address and key, but only once Helm has answered with them.
///
/// ⚠️ VERIFIED FIRST, as `connect_binance`: a bad key written and then tested
/// fails quietly every 20 s for ever, and this is the moment anybody watches.
#[tauri::command]
pub async fn connect_helm(app: AppHandle, url: String, key: String) -> Result<Helm, String> {
    let config = Config { url: normalise(&url)?, key: key.trim().to_string() };
    if config.key.len() < 32 {
        return Err("That isn't a Helm key. Make one on the Guardian page: Devices → Connect codenotch.".into());
    }
    let (today, skew_ms) = read_today(&config).await?;
    credentials::write(
        credentials::HELM,
        &serde_json::to_string(&config).map_err(|_| "Could not serialise the credential.")?,
    )?;
    ENABLED.store(true, Ordering::Relaxed);
    let helm = Helm { connected: true, today: Some(today), error: None, skew_ms, presenting: presenting() };
    publish(&app, helm.clone());
    poke().notify_one();
    Ok(helm)
}

#[tauri::command]
pub fn disconnect_helm(app: AppHandle) -> Result<(), String> {
    credentials::delete(credentials::HELM)?;
    ENABLED.store(reporting().is_some(), Ordering::Relaxed);
    publish(&app, Helm::default());
    crate::shortcuts::set_nudge_up(&app, false, false);
    if let Some(window) = app.get_webview_window(CHAT) {
        let _ = window.destroy();
    }
    Ok(())
}

/// Start, pause or finish a block, start a new one, or mark nudges read:
/// `{do: "start"|"pause"|"done", block}`, `{do: "new", title, minutes}`,
/// `{do: "read", ids}`. Helm checks it and applies its own rules.
#[tauri::command]
pub async fn helm_act(action: serde_json::Value) -> Result<(), String> {
    let config = connected().ok_or("Helm isn't connected.")?;
    let response = http()
        .post(format!("{}/api/desktop", config.url))
        .bearer_auth(&config.key)
        .json(&action)
        .send()
        .await
        .map_err(|_| "Can't reach Helm.".to_string())?;
    let status = response.status();
    let body: serde_json::Value = response.json().await.unwrap_or_default();
    poke().notify_one();
    if status.is_success() {
        Ok(())
    } else if status.as_u16() == 401 {
        Err("Helm doesn't know this key. Connect it again in Settings.".into())
    } else {
        Err(body["error"].as_str().unwrap_or("Helm said no.").to_string())
    }
}

/// A Helm page in the browser, where he's signed in: the check-in, the end of
/// the day. A path only, so nothing else can be opened through this.
#[tauri::command]
pub fn helm_open(path: String) -> Result<(), String> {
    let config = connected().ok_or("Helm isn't connected.")?;
    if !path.starts_with('/') || path.starts_with("//") || path.contains('\\') {
        return Err("That isn't a page in Helm.".into());
    }
    crate::calendar::open_external(format!("{}{}", config.url, path))
}

/* ── The chat window ─────────────────────────────────────────────────── */

/// A line typed in the notch, waiting for the chat page to be ready for it.
static PENDING_ASK: Mutex<Option<String>> = Mutex::new(None);

/// Pages the chat window may show: the chat and signing in. Anything else in
/// Helm, or anywhere, opens in the browser instead.
fn stays(origin: &str, url: &tauri::Url) -> bool {
    if url.scheme() == "about" {
        return true;
    }
    let same = url.origin().ascii_serialization() == origin;
    let path = url.path();
    if same && (path == "/panel" || path == "/login" || path.starts_with("/auth/")) {
        return true;
    }
    if matches!(url.scheme(), "http" | "https") {
        let _ = crate::calendar::open_external(url.to_string());
    }
    false
}

/// Hand the waiting line to the page. ⚠️ Retries for a while: `helmAsk` is set
/// by React after hydration, which is later than the page's load event.
fn deliver(window: &WebviewWindow) {
    let ask = PENDING_ASK.lock().ok().and_then(|mut pending| pending.take());
    let script = match ask {
        Some(text) => format!(
            "(function t(n){{if(window.helmAsk)window.helmAsk({});else if(n>0)setTimeout(function(){{t(n-1)}},250)}})(60)",
            serde_json::to_string(&text).unwrap_or_else(|_| "\"\"".into())
        ),
        None => "window.helmReload&&window.helmReload()".into(),
    };
    let _ = window.eval(&script);
}

/// `docked`: full height at the right edge of the island's monitor. `drop`:
/// hanging under the notch, centred.
fn place(app: &AppHandle, window: &WebviewWindow, docked: bool) {
    let Some(island) = app.get_webview_window("tasks") else { return };
    let Some(work) = crate::win::work_area(&island) else { return };
    let scale = island.scale_factor().unwrap_or(1.0);
    let width = (420.0 * scale) as i32;
    if docked {
        // The title bar is outside the inner size; take it off the height so
        // the window ends at the taskbar rather than under it.
        let frame = match (window.outer_size(), window.inner_size()) {
            (Ok(outer), Ok(inner)) => outer.height.saturating_sub(inner.height) as i32,
            _ => 0,
        };
        let _ = window.set_size(tauri::PhysicalSize::new(width as u32, (work.bottom - work.top - frame).max(400) as u32));
        let _ = window.set_position(tauri::PhysicalPosition::new(work.right - width, work.top));
    } else {
        let height = (600.0 * scale) as i32;
        let _ = window.set_size(tauri::PhysicalSize::new(width as u32, height as u32));
        let _ = window.set_position(tauri::PhysicalPosition::new((work.left + work.right - width) / 2, work.top + (64.0 * scale) as i32));
    }
}

/// Open the Guardian's chat, with a line to send if one was typed in the notch.
///
/// ⚠️ Built in an async command: WebView2 construction deadlocks inside a
/// synchronous one on Windows (see `open_task_editor`).
#[tauri::command]
pub async fn open_helm_chat(app: AppHandle, ask: Option<String>) -> Result<(), String> {
    let config = connected().ok_or("Connect Helm in Settings first.")?;
    let docked = crate::prefs::current(&app).helm_chat != "drop";
    if let Ok(mut pending) = PENDING_ASK.lock() {
        *pending = ask.map(|text| text.trim().to_string()).filter(|text| !text.is_empty());
    }

    // A placement changed in Settings since the window was made: make it again.
    if let Some(window) = app.get_webview_window(CHAT) {
        if window.is_decorated().unwrap_or(docked) != docked {
            let _ = window.destroy();
        }
    }
    let window = match app.get_webview_window(CHAT) {
        Some(window) => {
            if window.url().map(|url| url.path() == "/panel").unwrap_or(false) {
                deliver(&window);
            }
            window
        }
        None => {
            let start = tauri::Url::parse(&format!("{}/panel", config.url)).map_err(|_| "Helm's address is malformed.")?;
            let origin = config.url.clone();
            let window = WebviewWindowBuilder::new(&app, CHAT, WebviewUrl::External(start))
                .title("Guardian")
                .inner_size(420.0, 640.0)
                .min_inner_size(340.0, 420.0)
                .visible(false)
                // Docked is an ordinary window he can move and close; under the
                // notch it is chrome, gone when he clicks elsewhere.
                .decorations(docked)
                .always_on_top(!docked)
                .skip_taskbar(!docked)
                .on_navigation(move |url| stays(&origin, url))
                .on_new_window(|url, _| {
                    if matches!(url.scheme(), "http" | "https") {
                        let _ = crate::calendar::open_external(url.to_string());
                    }
                    tauri::webview::NewWindowResponse::Deny
                })
                .on_page_load(|window, payload| {
                    if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) && payload.url().path() == "/panel" {
                        deliver(&window);
                    }
                })
                .build()
                .map_err(|e| e.to_string())?;
            if !docked {
                let handle = window.clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::Focused(false) = event {
                        let _ = handle.hide();
                    }
                });
            }
            window
        }
    };
    place(&app, &window, docked);
    window.show().map_err(|e| e.to_string())?;
    let _ = window.unminimize();
    window.set_focus().map_err(|e| e.to_string())
}

/* ── Coding minutes ──────────────────────────────────────────────────── */

static ENABLED: AtomicBool = AtomicBool::new(false);

/// `(minute, workspace)`, the minute as RFC 3339 with the offset. A set, so a
/// minute is held once however many ticks land in it, and sorted, so the
/// oldest is first to go.
fn held() -> &'static Mutex<BTreeSet<(String, String)>> {
    static HELD: OnceLock<Mutex<BTreeSet<(String, String)>>> = OnceLock::new();
    HELD.get_or_init(Default::default)
}

/// Editors VS Code names in its title when no folder is open, which would
/// otherwise pass for one.
const NOT_FOLDERS: [&str; 6] = ["welcome", "get started", "settings", "keyboard shortcuts", "release notes", "walkthrough"];

/// The workspace in a VS Code title, lowercased.
///
/// The default title is `[●] file - folder - Visual Studio Code`; with no file
/// open it's `folder - Visual Studio Code`, and with no folder `file - Visual
/// Studio Code`, which is why a lone name that looks like a file is skipped.
fn workspace(title: &str) -> Option<String> {
    let title = title.trim().trim_start_matches('●').trim();
    let rest = title
        .strip_suffix(" - Visual Studio Code - Insiders")
        .or_else(|| title.strip_suffix(" - Visual Studio Code"))?;
    let parts: Vec<&str> = rest.split(" - ").collect();
    let last = parts.last()?.trim();
    // "esono [WSL: Ubuntu]", "helm (Workspace)".
    let name = last.split(" [").next()?.trim_end_matches(" (Workspace)").trim().to_lowercase();
    let lone = parts.len() == 1;
    if name.is_empty() || name.len() > 120 || NOT_FOLDERS.contains(&name.as_str()) || name.starts_with("untitled-") || name.contains(':') {
        return None;
    }
    if lone && name.contains('.') {
        return None;
    }
    Some(name)
}

/// One tick of apptime with someone at the keyboard: note the minute if it's VS Code.
pub fn sample(exe: &str) {
    if !ENABLED.load(Ordering::Relaxed) || !matches!(exe.to_ascii_lowercase().as_str(), "code.exe" | "code - insiders.exe") {
        return;
    }
    let window = unsafe { GetForegroundWindow() };
    if window.0.is_null() {
        return;
    }
    let Some(name) = workspace(&crate::win::title_of(window)) else { return };
    let minute = Local::now().format("%Y-%m-%dT%H:%M:00%:z").to_string();
    let mut held = held().lock().unwrap();
    held.insert((minute, name));
    while held.len() > MAX_HELD {
        held.pop_first();
    }
}

/// Send the noted minutes; kept for the next try on any failure, which is noted
/// once rather than every three minutes.
async fn flush(failing: &mut bool) {
    // Read each time, so connecting or removing a key needs no restart.
    let config = reporting();
    ENABLED.store(config.is_some(), Ordering::Relaxed);
    let Some(config) = config else { return };
    let batch: Vec<(String, String)> = held().lock().unwrap().iter().cloned().collect();
    if batch.is_empty() {
        return;
    }
    let points: Vec<_> = batch.iter().map(|(at, folder)| json!({ "folder": folder, "at": at, "source": "codenotch" })).collect();
    let sent = http()
        .post(format!("{}/api/activity", config.url.trim_end_matches('/')))
        .bearer_auth(&config.key)
        .json(&json!({ "points": points }))
        .send()
        .await;
    match sent {
        Ok(response) if response.status().is_success() => {
            let mut held = held().lock().unwrap();
            for point in &batch {
                held.remove(point);
            }
            if *failing {
                crate::log::note("helm: sending coding minutes again");
            }
            *failing = false;
        }
        failed => {
            if !*failing {
                let why = match failed {
                    Ok(response) => format!("HTTP {}", response.status()),
                    Err(e) => e.to_string(),
                };
                crate::log::note(&format!("helm: coding minutes not sent ({why}), holding {}", batch.len()));
            }
            *failing = true;
        }
    }
}

pub fn spawn(app: AppHandle) {
    ENABLED.store(reporting().is_some(), Ordering::Relaxed);
    tauri::async_runtime::spawn(async move {
        let mut bell = Bell::default();
        let mut failing = false;
        let mut flushed = Instant::now();
        loop {
            poll(&app, &mut bell).await;
            if flushed.elapsed() >= FLUSH_EVERY {
                flushed = Instant::now();
                flush(&mut failing).await;
            }
            tokio::select! {
                _ = tokio::time::sleep(POLL) => {}
                _ = poke().notified() => {}
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_workspace_comes_out_of_the_title() {
        assert_eq!(workspace("page.tsx - esono - Visual Studio Code").as_deref(), Some("esono"));
        assert_eq!(workspace("● page.tsx - Sonocars - Visual Studio Code").as_deref(), Some("sonocars"));
        assert_eq!(workspace("helm - Visual Studio Code").as_deref(), Some("helm"));
        assert_eq!(workspace("Claude Code - helm - Visual Studio Code").as_deref(), Some("helm"));
        assert_eq!(workspace("a.ts - esono [WSL: Ubuntu] - Visual Studio Code").as_deref(), Some("esono"));
        assert_eq!(workspace("a.ts - helm (Workspace) - Visual Studio Code - Insiders").as_deref(), Some("helm"));
    }

    #[test]
    fn titles_without_a_folder_say_nothing() {
        assert_eq!(workspace("Welcome - Visual Studio Code"), None);
        assert_eq!(workspace("Untitled-1 - Visual Studio Code"), None);
        assert_eq!(workspace("settings.json - Visual Studio Code"), None);
        assert_eq!(workspace("Extension: Prettier - Visual Studio Code"), None);
        // Not VS Code at all.
        assert_eq!(workspace("Helm - Google Chrome"), None);
    }

    #[test]
    fn a_nudge_rings_when_new_and_once_more_if_left() {
        let mut bell = Bell::default();
        let t0 = Instant::now();
        assert!(bell.ring(&[7], t0), "a new nudge rings");
        assert!(!bell.ring(&[7], t0 + Duration::from_secs(20)), "not on every reading");
        assert!(bell.ring(&[7], t0 + RING_AGAIN), "once more if still unread");
        assert!(!bell.ring(&[7], t0 + RING_AGAIN * 3), "and only once more");
        assert!(bell.ring(&[7, 8], t0 + RING_AGAIN * 3), "another new one rings");
        assert!(!bell.ring(&[], t0 + RING_AGAIN * 4), "read: nothing");
        assert!(bell.rang.is_empty(), "read ones are forgotten");
    }

    #[test]
    fn today_reads_what_helm_sends() {
        let text = r#"{"now":"2026-10-22T13:00:00+00:00","today":"2026-10-22","day":{"mustWin":"Ship it","off":false},
            "rhythm":{"on":true,"wake":465,"start":540,"close":1065},
            "blocks":[{"id":3,"title":"Repricer","status":"running","plannedAt":"09:30","minutes":50,
                       "runStartedAt":"2026-10-22T12:40:00+00:00","elapsedSeconds":120,"project":"Esono Repricer"}],
            "nudges":[{"id":9,"kind":"start","title":"Czas zacząć","body":"…","url":"/start","at":"2026-10-22T07:30:00+00:00"}],
            "replies":["Zaczynam"],"somethingNew":1}"#;
        let today: Today = serde_json::from_str(text).unwrap();
        assert_eq!(today.day.unwrap().must_win.as_deref(), Some("Ship it"));
        assert_eq!(today.blocks[0].status, "running");
        assert_eq!(today.blocks[0].elapsed_seconds, 120);
        assert_eq!(today.nudges[0].url.as_deref(), Some("/start"));
        // A key Helm adds later is ignored, not an error: the deployed Helm and
        // this build move separately.
        let sparse: Today = serde_json::from_str(r#"{"now":"x"}"#).unwrap();
        assert!(sparse.blocks.is_empty() && sparse.day.is_none());
    }

    #[test]
    fn only_helm_addresses_are_kept() {
        assert_eq!(normalise("https://crm.hadastudios.com/").unwrap(), "https://crm.hadastudios.com");
        assert_eq!(normalise(" https://crm.hadastudios.com/guardian ").unwrap(), "https://crm.hadastudios.com");
        assert_eq!(normalise("http://localhost:3300").unwrap(), "http://localhost:3300");
        assert!(normalise("http://crm.hadastudios.com").is_err(), "plain http only on this machine");
        assert!(normalise("crm.hadastudios.com").is_err());
    }
}
