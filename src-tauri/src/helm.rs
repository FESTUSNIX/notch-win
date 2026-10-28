//! Helm, in the notch.
//!
//! Helm is Mateusz's work OS (crm.hadastudios.com). Its Guardian nudges him
//! through the day and keeps the day's focus blocks; this module is the PC's
//! side of that:
//!
//! - **Today**: every 20 s it reads `/api/desktop` (the blocks, the Guardian's
//!   unread nudges) and sends it to the island as `helm:changed`. `helm_act`
//!   starts, pauses and finishes blocks there.
//! - **The queue** (27 Oct: the day is one ordered list of next actions, no
//!   must-win): every minute, and at once after anything he does, it reads
//!   `/api/queue` as him; `helm_queue` marks an item done, not today, pinned,
//!   started, or adds one.
//! - **Nudges**: a new one plays the chosen sound and drops the island open
//!   (`helm:nudge`); it plays again after three minutes if still unread, and
//!   keeps the chrome up over a full-screen app or a manual hide until it's
//!   read. They must not be missed; see `shortcuts`.
//! - **The chat**, drawn natively by the island: `helm_thread`, `helm_send`
//!   (the reply streams in as `helm:chat`), `helm_undo`, `helm_read`. It runs
//!   as him: the chat's tools go through Helm's row-level security as the
//!   signed-in owner, which a device key can't stand in for, so codenotch keeps
//!   his own session — the refresh token in Credential Manager, the access
//!   token in memory only.
//! - **The cockpit** (28 Oct): with the queue, `/api/notch` — his clock and the
//!   agents' for today, what needs him, and each project's folder with its open
//!   requests, which is what links a Claude Code session to the Helm request it
//!   is on. `helm_request` marks one doing or done (done answers with the time
//!   to log), `helm_log` logs it, `helm_start_claude` opens a terminal running
//!   Claude Code on one, and `helm_logo` fetches a project's logo.
//!
//! ⚠️ The deployed Helm may not have `/api/notch` yet — codenotch and Helm
//! ship separately. A 404 there is a normal answer, not an error: the reading
//! is simply absent, everything built on it stays hidden, and it all appears on
//! the next minute's read once Helm answers. Nothing about it is ever said on
//! the pill.
//!
//! - **Round 2** (28 Oct, later): the chat takes `focus`, `command` and
//!   `mentions` (`chat_body`); the thread can be read for another day and
//!   searched (`helm_thread(day)`, `helm_history(q)`); `/api/notch/projects`
//!   feeds the composer's `@` picker; `/api/transcribe` turns a held mic into
//!   words (`helm_transcribe`, the audio as multipart built here); and a
//!   reminder or a renewal can be acted on from a Guardian card. ⚠️ Every new
//!   path may answer 404 (not deployed) or 503 (not set up) — those come back
//!   as `None` / `{unavailable: true}` so the island hides the part quietly.
//!
//! Coding time is NOT measured here any more (28 Oct). It used to be read off
//! VS Code's window title, which named whatever workspace was open — and that
//! is how time came to be filed under "personal" and "nxm". A VS Code
//! extension now reports the active file's repo to Helm itself, which is the
//! fact the title was only ever guessing at.
//!
//! Connected in Settings → Connections → Helm: the address, his email, then
//! the code Helm emails him. That one sign-in gives both the session and the
//! device key; nothing is copied by hand.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use base64::Engine;
use chrono::Local;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};
use windows::Win32::UI::Shell::{SHQueryUserNotificationState, QUNS_PRESENTATION_MODE};

use crate::credentials;

/// How often today is read. Helm decides on a nudge every five minutes, so
/// this is how late one can reach the notch; a start or a pause reads at once.
const POLL: Duration = Duration::from_secs(20);
/// A nudge still unread this long after its sound makes it once more: he may
/// have been looking at the other screen. Once, not on a loop.
const RING_AGAIN: Duration = Duration::from_secs(180);
/// How often the queue is read. It's built from every project at once, so it
/// costs Helm more than today, and it changes when he acts (which reads it at
/// once) more than on its own. `/api/notch` rides on the same beat.
const QUEUE_EVERY: Duration = Duration::from_secs(60);
/// An access token with less than this left is refreshed before it's used.
const REFRESH_BEFORE: i64 = 300;
/// The largest logo kept. Helm stores them as data URLs; anything bigger than
/// this is not a logo meant for a 22px tile.
const MAX_LOGO: usize = 600 * 1024;

/* ── Where Helm is ───────────────────────────────────────────────────── */

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(default)]
struct Config {
    url: String,
    /// The device key: reads today and runs blocks.
    key: String,
    /// His session's refresh token, for the chat. ⚠️ Rotated on every use:
    /// the new one is saved before the old one is forgotten.
    refresh: Option<String>,
    email: Option<String>,
}

/// The connection made in Settings.
fn connected() -> Option<Config> {
    let text = credentials::read(credentials::HELM).ok()??;
    let config: Config = serde_json::from_str(&text).ok()?;
    (!config.url.is_empty() && !config.key.is_empty()).then_some(config)
}

fn save(config: &Config) -> Result<(), String> {
    credentials::write(credentials::HELM, &serde_json::to_string(config).map_err(|_| "Could not serialise the credential.")?)
}

fn http() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .user_agent("codenotch-win-helm/0.2")
            .build()
            .expect("HTTP client")
    })
}

/// ⚠️ Its own client: reqwest's timeout covers the whole BODY, and a reply
/// that thinks and uses tools streams for up to two minutes (Helm's limit).
fn chat_http() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(180))
            .user_agent("codenotch-win-helm/0.2")
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

/// The sentence Helm sent with a refusal, or a plain one of our own.
async fn refusal(response: reqwest::Response, fallback: &str) -> String {
    let body: serde_json::Value = response.json().await.unwrap_or_default();
    body["error"].as_str().unwrap_or(fallback).to_string()
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
    /// A session to chat with. Without one, today still works on the key.
    pub signed_in: bool,
    /// The last good reading. ⚠️ Kept through a failure: a block's timer that
    /// vanished because one request timed out would be a made-up state.
    pub today: Option<Today>,
    /// The last failure, as a sentence.
    pub error: Option<String>,
    /// Today's queue from `/api/queue`, passed through as Helm sends it (the
    /// island types it). Read as him, so only while signed in; kept through a
    /// failure, as `today` is.
    pub queue: Option<serde_json::Value>,
    pub queue_error: Option<String>,
    /// `/api/notch` as Helm sends it (the island types it): his clock, what
    /// needs him, the projects' folders and their requests. ⚠️ `None` is
    /// "this Helm doesn't have it yet" as much as "not read yet", and the
    /// island treats both the same: whatever is built on it stays hidden.
    /// Kept through a transient failure, like the queue.
    pub notch: Option<serde_json::Value>,
    /// This clock minus Helm's at the reading, so a running block counts from
    /// when Helm says it started rather than from this machine's idea of it.
    pub skew_ms: i64,
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

async fn read_today(url: &str, key: &str) -> Result<(Today, i64), String> {
    let response = http()
        .get(format!("{url}/api/desktop"))
        .bearer_auth(key)
        .send()
        .await
        .map_err(|_| "Can't reach Helm.".to_string())?;
    match response.status().as_u16() {
        200 => {}
        401 => return Err("Helm doesn't know this device any more. Sign in again in Settings.".into()),
        status => return Err(format!("Helm answered {status}.")),
    }
    let today: Today = response.json().await.map_err(|_| "Helm sent something unexpected.".to_string())?;
    let skew = chrono::DateTime::parse_from_rfc3339(&today.now)
        .map(|server| Local::now().timestamp_millis() - server.timestamp_millis())
        .unwrap_or(0);
    Ok((today, skew))
}

/* ── Nudges that must not be missed ──────────────────────────────────── */

/// What a reading of the unread nudges calls for.
#[derive(Debug, PartialEq)]
enum Ring {
    Quiet,
    /// One still unread after `RING_AGAIN`: the sound again, nothing else.
    Again,
    /// A new one: the sound, and the island drops open on it.
    New(i64),
}

/// Which unread nudges make a sound: a new one at once, and each once more
/// after `RING_AGAIN` while it's still unread. Read ones are forgotten.
#[derive(Default)]
struct Bell {
    /// Nudge id → when it first rang, and whether it has rung again.
    rang: HashMap<i64, (Instant, bool)>,
}

impl Bell {
    fn ring(&mut self, unread: &[i64], now: Instant) -> Ring {
        self.rang.retain(|id, _| unread.contains(id));
        let mut ring = Ring::Quiet;
        for id in unread {
            match self.rang.get_mut(id) {
                None => {
                    self.rang.insert(*id, (now, false));
                    ring = Ring::New(*id);
                }
                Some((at, again)) if !*again && now.duration_since(*at) >= RING_AGAIN => {
                    *again = true;
                    if ring == Ring::Quiet {
                        ring = Ring::Again;
                    }
                }
                _ => {}
            }
        }
        ring
    }
}

async fn read_queue() -> Result<serde_json::Value, String> {
    let response = as_him(http(), reqwest::Method::GET, "/api/queue", None).await?;
    if !response.status().is_success() {
        return Err(refusal(response, "Couldn't read the queue.").await);
    }
    response.json().await.map_err(|_| "Helm sent something unexpected.".to_string())
}

/// What `/api/notch` answered: a reading, or `None` for a Helm that doesn't
/// have the endpoint yet.
///
/// ⚠️ 404 is an ANSWER here, not a failure — see the module note. It is the
/// one status that clears the reading; anything else is a transient fault and
/// the caller keeps what it had.
async fn read_notch() -> Result<Option<serde_json::Value>, String> {
    let response = as_him(http(), reqwest::Method::GET, "/api/notch", None).await?;
    match response.status().as_u16() {
        200 => {}
        404 => return Ok(None),
        status => return Err(format!("Helm answered {status}.")),
    }
    notch_reading(response.json().await.map_err(|_| "Helm sent something unexpected.".to_string())?)
}

/// A body from `/api/notch`, checked for the one thing everything built on it
/// needs: an object. ⚠️ A catch-all page answering 200 with something else
/// would otherwise be passed to the island as a reading.
fn notch_reading(body: serde_json::Value) -> Result<Option<serde_json::Value>, String> {
    if body.is_object() {
        Ok(Some(body))
    } else {
        Err("Helm sent something unexpected.".into())
    }
}

async fn poll(app: &AppHandle, bell: &mut Bell, queue_due: bool, notch_failing: &mut bool) {
    let Some(config) = connected() else {
        if current(app).connected {
            publish(app, Helm::default());
            crate::shortcuts::set_nudge_up(app, false, false);
        }
        return;
    };
    let mut next = current(app);
    next.connected = true;
    next.signed_in = config.refresh.is_some();
    match read_today(&config.url, &config.key).await {
        Ok((today, skew)) => {
            let unread: Vec<i64> = today.nudges.iter().map(|n| n.id).collect();
            let ring = bell.ring(&unread, Instant::now());
            if ring != Ring::Quiet {
                crate::sound::play(&crate::prefs::current(app).helm_sound);
            }
            crate::shortcuts::set_nudge_up(app, !unread.is_empty(), ring != Ring::Quiet);
            next.today = Some(today);
            next.error = None;
            next.skew_ms = skew;
            publish(app, next);
            /* ⚠️ After the reading is published, so the island opens onto the
             * nudge rather than onto the thread as it was. While presenting,
             * the pill and the sound say it; opening the island over a shared
             * screen would show the room what the Guardian said. */
            if let Ring::New(id) = ring {
                if !presenting() {
                    let _ = app.emit_to("tasks", "helm:nudge", id);
                }
            }
        }
        Err(message) => {
            next.error = Some(message);
            publish(app, next);
        }
    }
    /* After today is out, so the timer and the nudges never wait on the
     * heavier read. */
    if queue_due && config.refresh.is_some() {
        let read = read_queue().await;
        let mut next = current(app);
        match read {
            Ok(queue) => {
                next.queue = Some(queue);
                next.queue_error = None;
            }
            Err(message) => next.queue_error = Some(message),
        }
        publish(app, next);

        /* The cockpit's reading, on the queue's beat. ⚠️ Its failures are
         * written to the log and nowhere else, once per run of them: this is
         * read every minute whether or not he is looking, and a Helm that
         * hasn't shipped the endpoint must not put a sentence on the pill. */
        let read = read_notch().await;
        let mut next = current(app);
        match read {
            Ok(notch) => {
                next.notch = notch;
                *notch_failing = false;
            }
            Err(message) => {
                if !*notch_failing {
                    crate::log::note(&format!("helm: /api/notch not read ({message}), keeping the last reading"));
                }
                *notch_failing = true;
            }
        }
        publish(app, next);
    }
}

/// Read again now, after an action or a new connection, rather than in 20 s.
fn poke() -> &'static tokio::sync::Notify {
    static POKE: OnceLock<tokio::sync::Notify> = OnceLock::new();
    POKE.get_or_init(tokio::sync::Notify::new)
}

/* ── His session ─────────────────────────────────────────────────────── */

/// The access token and when it runs out (Unix seconds). In memory only.
static ACCESS: Mutex<Option<(String, i64)>> = Mutex::new(None);

/// Whether a token running out at `expires_at` should be refreshed `now`.
fn stale(expires_at: i64, now: i64) -> bool {
    expires_at - now < REFRESH_BEFORE
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Tokens {
    access_token: String,
    refresh_token: String,
    expires_at: i64,
}

/// One refresh at a time. ⚠️ Rotation makes a refresh token single-use, so
/// two requests refreshing at once would leave one of them signed out.
fn refreshing() -> &'static tokio::sync::Mutex<()> {
    static GATE: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    GATE.get_or_init(|| tokio::sync::Mutex::new(()))
}

/// A fresh access token, refreshing first when it's about to run out (or
/// `force`, after a 401).
async fn access(force: bool) -> Result<(Config, String), String> {
    let _gate = refreshing().lock().await;
    let mut config = connected().ok_or("Helm isn't connected.")?;
    if !force {
        if let Some((token, expires_at)) = ACCESS.lock().ok().and_then(|held| held.clone()) {
            if !stale(expires_at, chrono::Utc::now().timestamp()) {
                return Ok((config, token));
            }
        }
    }
    let refresh = config.refresh.clone().ok_or("Sign in to Helm in Settings to talk to the Guardian.")?;
    let response = http()
        .post(format!("{}/api/desktop/refresh", config.url))
        .json(&json!({ "refreshToken": refresh }))
        .send()
        .await
        .map_err(|_| "Can't reach Helm.".to_string())?;
    if response.status().as_u16() == 401 {
        // The session is over (signed out everywhere, or too long unused).
        config.refresh = None;
        let _ = save(&config);
        return Err("Sign in to Helm again in Settings to talk to the Guardian.".into());
    }
    if !response.status().is_success() {
        return Err(format!("Helm answered {}.", response.status()));
    }
    let tokens: Tokens = response.json().await.map_err(|_| "Helm sent something unexpected.".to_string())?;
    // Saved before anything else: the old refresh token no longer works.
    config.refresh = Some(tokens.refresh_token);
    save(&config)?;
    if let Ok(mut held) = ACCESS.lock() {
        *held = Some((tokens.access_token.clone(), tokens.expires_at));
    }
    Ok((config, tokens.access_token))
}

/// A request as him, retried once with a fresh token if Helm says the token is
/// no good (revoked, or the clock here ran fast).
async fn as_him(
    client: &reqwest::Client,
    method: reqwest::Method,
    path: &str,
    body: Option<serde_json::Value>,
) -> Result<reqwest::Response, String> {
    let mut force = false;
    loop {
        let (config, token) = access(force).await?;
        let mut request = client.request(method.clone(), format!("{}{path}", config.url)).bearer_auth(&token);
        if let Some(body) = &body {
            request = request.json(body);
        }
        let response = request.send().await.map_err(|_| "Can't reach Helm.".to_string())?;
        if response.status().as_u16() == 401 && !force {
            force = true;
            continue;
        }
        return Ok(response);
    }
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

/// Where a sign-in is up to: the code was sent to this address.
static SIGNING_IN: Mutex<Option<(String, String)>> = Mutex::new(None);

/// Sign-in, step one: Helm emails him a code. Only his own address gets one.
#[tauri::command]
pub async fn helm_send_code(url: String, email: String) -> Result<(), String> {
    let url = normalise(&url)?;
    let email = email.trim().to_lowercase();
    if !email.contains('@') {
        return Err("That doesn't look like an email address.".into());
    }
    let response = http()
        .post(format!("{url}/api/desktop/signin"))
        .json(&json!({ "email": email }))
        .send()
        .await
        .map_err(|_| "Can't reach Helm at that address.".to_string())?;
    if !response.status().is_success() {
        return Err(refusal(response, "Helm wouldn't send a code.").await);
    }
    if let Ok(mut held) = SIGNING_IN.lock() {
        *held = Some((url, email));
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SignedIn {
    access_token: String,
    refresh_token: String,
    expires_at: i64,
    key: String,
}

/// Sign-in, step two: the code becomes his session and this PC's device key,
/// both kept in Credential Manager.
#[tauri::command]
pub async fn helm_sign_in(app: AppHandle, code: String) -> Result<Helm, String> {
    let (url, email) = SIGNING_IN.lock().ok().and_then(|held| held.clone()).ok_or("Send the code first.")?;
    let code: String = code.chars().filter(char::is_ascii_digit).collect();
    let response = http()
        .post(format!("{url}/api/desktop/verify"))
        .json(&json!({ "email": email, "code": code }))
        .send()
        .await
        .map_err(|_| "Can't reach Helm.".to_string())?;
    if !response.status().is_success() {
        return Err(refusal(response, "That code didn't work.").await);
    }
    let signed: SignedIn = response.json().await.map_err(|_| "Helm sent something unexpected.".to_string())?;
    let config = Config { url, key: signed.key, refresh: Some(signed.refresh_token), email: Some(email) };
    save(&config)?;
    if let Ok(mut held) = ACCESS.lock() {
        *held = Some((signed.access_token, signed.expires_at));
    }
    if let Ok(mut held) = SIGNING_IN.lock() {
        *held = None;
    }
    let (today, skew_ms) = read_today(&config.url, &config.key).await.map(|(t, s)| (Some(t), s)).unwrap_or((None, 0));
    // The poke reads the queue next, as him.
    let helm = Helm { connected: true, signed_in: true, today, error: None, skew_ms, ..Helm::default() };
    publish(&app, helm.clone());
    poke().notify_one();
    Ok(helm)
}

#[tauri::command]
pub fn disconnect_helm(app: AppHandle) -> Result<(), String> {
    credentials::delete(credentials::HELM)?;
    if let Ok(mut held) = ACCESS.lock() {
        *held = None;
    }
    if let Ok(mut held) = logos().lock() {
        held.clear();
    }
    publish(&app, Helm::default());
    crate::shortcuts::set_nudge_up(&app, false, false);
    Ok(())
}

/// Start, pause or finish a block, add or start a new one, or mark nudges
/// read: `{do: "start"|"pause"|"done", block}`, `{do: "new"|"add", title,
/// minutes}`, `{do: "read", ids}`. Helm checks it and applies its own rules.
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
    poke().notify_one();
    if response.status().is_success() {
        Ok(())
    } else if response.status().as_u16() == 401 {
        Err("Helm doesn't know this device any more. Sign in again in Settings.".into())
    } else {
        Err(refusal(response, "Helm said no.").await)
    }
}

/// Done, not today, pin, start or add on a queue item, as him: the body
/// Helm's `/api/queue` takes (`{act: "done", key, minutes?}`, `{act: "snooze",
/// key}`, `{act: "start", key, title, minutes, projectId…}`, `{act: "add",
/// title}`…). Helm checks it; today and the queue are read again at once.
#[tauri::command]
pub async fn helm_queue(action: serde_json::Value) -> Result<(), String> {
    let response = as_him(http(), reqwest::Method::POST, "/api/queue", Some(action)).await?;
    poke().notify_one();
    if response.status().is_success() {
        Ok(())
    } else {
        Err(refusal(response, "Helm said no.").await)
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

/* ── The Guardian's chat ─────────────────────────────────────────────── */

/// The thread's last week and today's strictness, as Helm's panel gets it —
/// or one day's messages, with `day`.
#[tauri::command]
pub async fn helm_thread(day: Option<String>) -> Result<serde_json::Value, String> {
    let path = thread_path(day.as_deref())?;
    let response = as_him(http(), reqwest::Method::GET, &path, None).await?;
    if !response.status().is_success() {
        return Err(refusal(response, "Couldn't load the thread.").await);
    }
    response.json().await.map_err(|_| "Helm sent something unexpected.".to_string())
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Picture {
    media_type: String,
    data: String,
}

/// Complete lines out of what has arrived so far; the unfinished tail stays.
///
/// ⚠️ On BYTES, not text. A chunk can end inside a Polish letter (two bytes
/// in UTF-8), and decoding each chunk on its own turned "ż" at a seam into two
/// replacement characters. A line is only decoded once its newline is here.
fn take_lines(buffer: &mut Vec<u8>) -> Vec<String> {
    let mut lines = Vec::new();
    while let Some(at) = buffer.iter().position(|b| *b == b'\n') {
        let line: Vec<u8> = buffer.drain(..=at).collect();
        let text = String::from_utf8_lossy(&line[..line.len() - 1]).trim().to_string();
        if !text.is_empty() {
            lines.push(text);
        }
    }
    lines
}

/// Say something to the Guardian. The reply streams to the island as
/// `helm:chat`, one event per line of Helm's NDJSON (`start`, `status`,
/// `text`, `receipt`, `card`, `done`, `error`); this returns once it's over.
///
/// `capture` is quick capture's one line (the global shortcut): Helm files it
/// rather than chatting about it. ⚠️ A Helm that predates the flag ignores
/// it and answers as it would any message — which is a longer reply, not a
/// failure, so nothing here depends on it being understood.
#[tauri::command]
pub async fn helm_send(
    app: AppHandle,
    text: String,
    images: Vec<Picture>,
    capture: Option<bool>,
    focus: Option<i64>,
    command: Option<String>,
    mentions: Option<Vec<i64>>,
) -> Result<(), String> {
    let body = chat_body(&text, &images, capture == Some(true), focus, command.as_deref(), mentions.as_deref().unwrap_or(&[]));
    let mut response = as_him(chat_http(), reqwest::Method::POST, "/api/guardian/chat", Some(body)).await?;
    if !response.status().is_success() {
        return Err(refusal(response, "The Guardian didn't answer.").await);
    }
    let mut buffer = Vec::new();
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) => {
                buffer.extend_from_slice(&chunk);
                for line in take_lines(&mut buffer) {
                    if let Ok(event) = serde_json::from_str::<serde_json::Value>(&line) {
                        let _ = app.emit_to("tasks", "helm:chat", event);
                    }
                }
            }
            Ok(None) => break,
            Err(_) => {
                let _ = app.emit_to("tasks", "helm:chat", json!({ "t": "error", "message": "The connection to Helm dropped." }));
                break;
            }
        }
    }
    // A turn may have changed today (a block planned, started): read it now.
    poke().notify_one();
    Ok(())
}

/// Take back one thing a reply changed.
#[tauri::command]
pub async fn helm_undo(message_id: i64, index: u32) -> Result<(), String> {
    let response = as_him(http(), reqwest::Method::POST, "/api/guardian/undo", Some(json!({ "messageId": message_id, "index": index }))).await?;
    poke().notify_one();
    if response.status().is_success() {
        Ok(())
    } else {
        Err(refusal(response, "Couldn't undo it.").await)
    }
}

/// Everything the Guardian said is read: he opened the thread.
#[tauri::command]
pub async fn helm_read() -> Result<(), String> {
    let response = as_him(http(), reqwest::Method::POST, "/api/guardian/read", None).await?;
    poke().notify_one();
    if response.status().is_success() {
        Ok(())
    } else {
        Err(refusal(response, "Couldn't mark it read.").await)
    }
}

/* ── The cockpit: requests, the time they took, Claude on them ─────── */

/// A path segment for a request: its id, as a number and nothing else.
fn request_path(id: i64, rest: &str) -> Result<String, String> {
    if id <= 0 {
        return Err("That isn't a request in Helm.".into());
    }
    Ok(format!("/api/notch/requests/{id}{rest}"))
}

/// Mark a request doing or done, as him. Done answers with the time Helm
/// suggests logging for it (`{ok, suggestion}`), passed through for the island.
#[tauri::command]
pub async fn helm_request(id: i64, status: String) -> Result<serde_json::Value, String> {
    if !matches!(status.as_str(), "doing" | "done") {
        return Err("A request is doing or done.".into());
    }
    let response = as_him(http(), reqwest::Method::POST, &request_path(id, "")?, Some(json!({ "status": status }))).await?;
    poke().notify_one();
    if !response.status().is_success() {
        return Err(refusal(response, "Helm said no.").await);
    }
    Ok(response.json().await.unwrap_or_else(|_| json!({ "ok": true, "suggestion": null })))
}

/// Log time on a request, as him.
#[tauri::command]
pub async fn helm_log(id: i64, minutes: u32) -> Result<(), String> {
    if minutes == 0 || minutes > 24 * 60 {
        return Err("That isn't an amount of time to log.".into());
    }
    let response = as_him(http(), reqwest::Method::POST, &request_path(id, "/log")?, Some(json!({ "minutes": minutes }))).await?;
    poke().notify_one();
    if response.status().is_success() {
        Ok(())
    } else {
        Err(refusal(response, "Couldn't log it.").await)
    }
}

#[derive(Deserialize)]
struct Prompt {
    #[serde(default)]
    prompt: String,
    #[serde(default)]
    path: Option<String>,
}

/// Start Claude Code on a request: the prompt and the folder from Helm, the
/// request marked doing, and a terminal in that folder running Claude on it.
/// Says where it went.
///
/// ⚠️ The prompt is read FIRST, and the request is only marked doing once
/// there is somewhere to start it. Marking first would leave a request "on
/// it" with nothing running every time a project's folder isn't known yet —
/// and that state is exactly what links a session to a request on the Agents
/// screen, so it would be a lie the island then repeats.
#[tauri::command]
pub async fn helm_start_claude(id: i64) -> Result<String, String> {
    let response = as_him(http(), reqwest::Method::GET, &request_path(id, "/prompt")?, None).await?;
    if response.status().as_u16() == 404 {
        return Err("This Helm can't start requests yet.".into());
    }
    if !response.status().is_success() {
        return Err(refusal(response, "Helm wouldn't give the prompt.").await);
    }
    let brief: Prompt = response.json().await.map_err(|_| "Helm sent something unexpected.".to_string())?;
    let folder = brief.path.map(|p| p.trim().replace('/', "\\")).filter(|p| !p.is_empty())
        .ok_or("Helm doesn't know this project's folder yet.")?;
    if brief.prompt.trim().is_empty() {
        return Err("Helm sent an empty prompt.".into());
    }
    let folder = std::path::PathBuf::from(folder);
    if !folder.is_dir() {
        return Err(format!("{} isn't a folder on this PC.", folder.display()));
    }
    helm_request(id, "doing".into()).await?;
    let place = crate::terminal::open(&folder, brief.prompt.trim())?;
    let leaf = folder.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    Ok(format!("{leaf} · {place}"))
}

/* ── Round 2: the chat's new fields, history, projects, speech, cards ── */

/// The body `/api/guardian/chat` takes. ⚠️ Only what Helm's contract names,
/// checked here: a command it does not know, a non-positive project id or a
/// flood of mentions is dropped rather than sent — the chat must not fail
/// because a draft carried something odd.
fn chat_body(text: &str, images: &[Picture], capture: bool, focus: Option<i64>, command: Option<&str>, mentions: &[i64]) -> serde_json::Value {
    let mut body = json!({ "text": text, "images": images, "page": null });
    if capture {
        body["capture"] = json!(true);
    }
    if let Some(id) = focus.filter(|id| *id > 0) {
        body["focus"] = json!({ "projectId": id });
    }
    if let Some(command) = command.filter(|c| matches!(*c, "request" | "note" | "log" | "todo")) {
        body["command"] = json!(command);
    }
    let mut seen = Vec::new();
    for id in mentions.iter().copied().filter(|id| *id > 0) {
        if !seen.contains(&id) && seen.len() < 10 {
            seen.push(id);
        }
    }
    if !seen.is_empty() {
        body["mentions"] = json!(seen.iter().map(|id| json!({ "projectId": id })).collect::<Vec<_>>());
    }
    body
}

/// `/api/guardian/thread`, for today or one day (`YYYY-MM-DD`, checked).
fn thread_path(day: Option<&str>) -> Result<String, String> {
    match day.map(str::trim).filter(|d| !d.is_empty()) {
        None => Ok("/api/guardian/thread".into()),
        Some(day) if chrono::NaiveDate::parse_from_str(day, "%Y-%m-%d").is_ok() && day.len() == 10 => Ok(format!("/api/guardian/thread?day={day}")),
        Some(_) => Err("That isn't a day.".into()),
    }
}

/// `/api/guardian/history`, with the query encoded when there is one.
fn history_path(q: Option<&str>) -> String {
    match q.map(str::trim).filter(|q| !q.is_empty()) {
        None => "/api/guardian/history".into(),
        Some(q) => {
            let q: String = q.chars().take(200).collect();
            let mut url = tauri::Url::parse("http://helm/api/guardian/history").expect("a fixed URL");
            url.query_pairs_mut().append_pair("q", &q);
            format!("{}?{}", url.path(), url.query().unwrap_or(""))
        }
    }
}

/// An id Helm put in a card, as a path segment: letters, digits and `-_:.`
/// only. ⚠️ The card is Helm's to shape; anything else is refused rather than
/// pasted into a URL.
fn segment(id: &str) -> Result<String, String> {
    let id = id.trim();
    if id.is_empty() || id.len() > 64 || !id.chars().all(|c| c.is_ascii_alphanumeric() || "-_:.".contains(c)) || id.starts_with('.') {
        return Err("That isn't something Helm can act on.".into());
    }
    Ok(id.to_string())
}

/// A GET that answers `None` for a Helm without the endpoint (404) or with it
/// switched off (503), the body otherwise.
async fn optional(path: &str) -> Result<Option<serde_json::Value>, String> {
    let response = as_him(http(), reqwest::Method::GET, path, None).await?;
    match response.status().as_u16() {
        404 | 503 => Ok(None),
        status if (200..300).contains(&status) => {
            let body: serde_json::Value = response.json().await.map_err(|_| "Helm sent something unexpected.".to_string())?;
            Ok(body.is_object().then_some(body))
        }
        _ => Err(refusal(response, "Helm didn't answer.").await),
    }
}

/// The days of the Guardian's thread (`{days}`), or what a search found
/// (`{results}`). `None` for a Helm that keeps no history yet.
#[tauri::command]
pub async fn helm_history(q: Option<String>) -> Result<Option<serde_json::Value>, String> {
    optional(&history_path(q.as_deref())).await
}

/// Every project, for the `@` picker and the focus. `None` for a Helm without
/// `/api/notch/projects` — the island then uses the cockpit's folders.
#[tauri::command]
pub async fn helm_projects() -> Result<Option<serde_json::Value>, String> {
    optional("/api/notch/projects").await
}

/// The most audio Helm takes. ⚠️ Not the route's own 15 MB: the deployed Helm
/// sits behind Vercel, which refuses any request body over 4.5 MB before the
/// route sees it. Opus at 32 kbit/s is about 1.2 MB for the five minutes the
/// route allows, so the island records that; WAV would only fit ~2 min 20 s.
const MAX_AUDIO: usize = 4_500_000 - 1024;

/// The file name and type a recording goes to Helm as.
fn audio_kind(mime: &str) -> Option<(&'static str, &'static str)> {
    match mime.split(';').next().unwrap_or("").trim().to_ascii_lowercase().as_str() {
        "audio/webm" | "video/webm" => Some(("speech.webm", "audio/webm")),
        "audio/ogg" => Some(("speech.ogg", "audio/ogg")),
        "audio/wav" | "audio/x-wav" | "audio/wave" => Some(("speech.wav", "audio/wav")),
        _ => None,
    }
}

/// A `multipart/form-data` body: the audio, and the language when there is one.
///
/// ⚠️ Built here rather than through reqwest's `multipart` feature, which is
/// off in this tree and would pull two crates in for twenty lines. The
/// boundary is checked against the audio, so a recording can never contain
/// its own separator.
fn multipart(boundary: &str, audio: &[u8], file: &str, mime: &str, lang: Option<&str>) -> Vec<u8> {
    let mut body = Vec::with_capacity(audio.len() + 512);
    body.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"audio\"; filename=\"{file}\"\r\nContent-Type: {mime}\r\n\r\n").as_bytes());
    body.extend_from_slice(audio);
    body.extend_from_slice(b"\r\n");
    if let Some(lang) = lang.filter(|l| !l.is_empty() && l.len() <= 8 && l.chars().all(|c| c.is_ascii_alphabetic() || c == '-')) {
        body.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"lang\"\r\n\r\n{lang}\r\n").as_bytes());
    }
    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    body
}

/// A boundary that does not occur in the audio.
fn boundary_for(audio: &[u8]) -> String {
    let mut seed: u64 = chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0) as u64 ^ audio.len() as u64;
    loop {
        seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        let candidate = format!("codenotch-{seed:016x}");
        if !audio.windows(candidate.len()).any(|w| w == candidate.as_bytes()) {
            return candidate;
        }
    }
}

/// Hold to talk: the recording (base64) to Helm's `/api/transcribe`, its words
/// back. `{text}` when heard, `{unavailable: true}` when this Helm has no speech
/// (404, or 503 "Speech isn't set up") — the island hides the mic then.
#[tauri::command]
pub async fn helm_transcribe(audio: String, mime: String, lang: Option<String>) -> Result<serde_json::Value, String> {
    let (file, kind) = audio_kind(&mime).ok_or("That recording isn't a kind Helm reads.")?;
    let bytes = base64::engine::general_purpose::STANDARD.decode(audio.trim()).map_err(|_| "The recording didn't come through.".to_string())?;
    if bytes.is_empty() {
        return Err("Nothing was recorded.".into());
    }
    if bytes.len() > MAX_AUDIO {
        return Err("That recording is too big for Helm.".into());
    }
    let boundary = boundary_for(&bytes);
    let body = multipart(&boundary, &bytes, file, kind, lang.as_deref());
    let mut force = false;
    let response = loop {
        let (config, token) = access(force).await?;
        let response = chat_http()
            .post(format!("{}/api/transcribe", config.url))
            .bearer_auth(&token)
            .header(reqwest::header::CONTENT_TYPE, format!("multipart/form-data; boundary={boundary}"))
            .body(body.clone())
            .send()
            .await
            .map_err(|_| "Can't reach Helm.".to_string())?;
        if response.status().as_u16() == 401 && !force {
            force = true;
            continue;
        }
        break response;
    };
    match response.status().as_u16() {
        404 | 503 => Ok(json!({ "unavailable": true })),
        413 => Err("That's longer than Helm takes (5 min).".into()),
        415 => Err("That recording isn't a kind Helm reads.".into()),
        400 => Err(refusal(response, "Helm didn't get the recording.").await),
        502 => Err("Helm couldn't make out the words.".into()),
        status if (200..300).contains(&status) => {
            let answer: serde_json::Value = response.json().await.map_err(|_| "Helm sent something unexpected.".to_string())?;
            Ok(json!({ "text": answer["text"].as_str().unwrap_or("") }))
        }
        _ => Err(refusal(response, "Helm couldn't transcribe that.").await),
    }
}

/// Whether this Helm has `/api/transcribe` at all, asked once per session.
/// ⚠️ With a GET, which the route does not serve: a route that exists answers
/// 405, one that does not 404 — nothing is recorded or sent to find out.
#[tauri::command]
pub async fn helm_transcribe_ready() -> Result<bool, String> {
    let response = as_him(http(), reqwest::Method::GET, "/api/transcribe", None).await?;
    Ok(!matches!(response.status().as_u16(), 404 | 503))
}

/// What an action on a card answered: Helm's own `{ok, …}` passed through, or
/// `{ok: false, error}` in words for a refusal.
async fn card_answer(response: reqwest::Response, missing: &str) -> serde_json::Value {
    let status = response.status().as_u16();
    if status == 404 {
        return json!({ "ok": false, "error": missing });
    }
    let body: serde_json::Value = response.json().await.unwrap_or_default();
    if (200..300).contains(&status) && body.is_object() {
        return body;
    }
    /* ⚠️ The status goes with it: a reminder at a level already sent is a
     * 409, and the card shows that as SENT (with Helm's sentence) rather than
     * as a failure to be pressed again. */
    json!({ "ok": false, "status": status, "error": body["error"].as_str().unwrap_or("Helm said no.") })
}

/// Send a payment reminder (`level`: friendly | firm | final; `to`: another address).
#[tauri::command]
pub async fn helm_remind(payment_id: String, level: Option<String>, to: Option<String>) -> Result<serde_json::Value, String> {
    let id = segment(&payment_id)?;
    let mut body = json!({});
    if let Some(level) = level.filter(|l| matches!(l.as_str(), "friendly" | "firm" | "final")) {
        body["level"] = json!(level);
    }
    if let Some(to) = to.map(|t| t.trim().to_string()).filter(|t| t.contains('@') && t.len() <= 200) {
        body["to"] = json!(to);
    }
    let response = as_him(http(), reqwest::Method::POST, &format!("/api/notch/reminders/{id}"), Some(body)).await?;
    poke().notify_one();
    Ok(card_answer(response, "This Helm can't send reminders yet.").await)
}

/// Bill a renewal or remind about it (`action`: bill | remind), for the card's
/// cycle (`period`) when it has one.
#[tauri::command]
pub async fn helm_renewal(id: String, action: String, send: bool, period: Option<String>) -> Result<serde_json::Value, String> {
    let id = segment(&id)?;
    if !matches!(action.as_str(), "bill" | "remind") {
        return Err("A renewal is billed or reminded.".into());
    }
    let mut body = json!({ "action": action, "send": send });
    if let Some(period) = period.map(|p| p.trim().to_string()).filter(|p| !p.is_empty() && p.chars().count() <= 40) {
        body["period"] = json!(period);
    }
    let response = as_him(http(), reqwest::Method::POST, &format!("/api/notch/renewals/{id}"), Some(body)).await?;
    poke().notify_one();
    Ok(card_answer(response, "This Helm can't act on renewals yet.").await)
}

/// Logos already fetched, by `id:version`. ⚠️ `None` is remembered too: a
/// project without a logo answers 404 every time, and the island asks on every
/// render that shows one.
fn logos() -> &'static Mutex<HashMap<String, Option<String>>> {
    static LOGOS: OnceLock<Mutex<HashMap<String, Option<String>>>> = OnceLock::new();
    LOGOS.get_or_init(Default::default)
}

/// The image types a logo may be. ⚠️ An SVG is fine as an `<img>` (it cannot
/// run anything there), and anything that is not an image is not drawn at all.
fn logo_type(content_type: &str) -> Option<&'static str> {
    let bare = content_type.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    ["image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml", "image/x-icon", "image/vnd.microsoft.icon", "image/avif"]
        .into_iter()
        .find(|known| *known == bare)
}

/// A project's logo as a data URL, or `None` when it has none.
///
/// ⚠️ Fetched HERE, with his token, and handed over as data. The route needs
/// the Bearer token, and the token never reaches a WebView (see
/// `credentials.rs`) — so the page cannot simply point an `<img>` at Helm.
#[tauri::command]
pub async fn helm_logo(id: i64, version: String) -> Result<Option<String>, String> {
    if id <= 0 || version.len() > 64 || !version.chars().all(|c| c.is_ascii_alphanumeric() || "._:-".contains(c)) {
        return Ok(None);
    }
    let key = format!("{id}:{version}");
    if let Some(held) = logos().lock().ok().and_then(|held| held.get(&key).cloned()) {
        return Ok(held);
    }
    let response = as_him(http(), reqwest::Method::GET, &format!("/projects/{id}/logo?v={version}"), None).await?;
    let picture = if response.status().is_success() {
        let kind = response.headers().get(reqwest::header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).and_then(logo_type);
        match (kind, response.bytes().await) {
            (Some(kind), Ok(bytes)) if !bytes.is_empty() && bytes.len() <= MAX_LOGO => {
                Some(format!("data:{kind};base64,{}", base64::engine::general_purpose::STANDARD.encode(&bytes)))
            }
            _ => None,
        }
    } else if response.status().as_u16() == 404 {
        None
    } else {
        // Not remembered: a 500 now is no reason to draw a monogram for ever.
        return Ok(None);
    };
    if let Ok(mut held) = logos().lock() {
        held.insert(key, picture.clone());
    }
    Ok(picture)
}

pub fn spawn(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut bell = Bell::default();
        let mut queued: Option<Instant> = None;
        let mut poked = true;
        let mut notch_failing = false;
        loop {
            let queue_due = poked || queued.is_none_or(|at| at.elapsed() >= QUEUE_EVERY);
            if queue_due {
                queued = Some(Instant::now());
            }
            poll(&app, &mut bell, queue_due, &mut notch_failing).await;
            poked = tokio::select! {
                _ = tokio::time::sleep(POLL) => false,
                _ = poke().notified() => true,
            };
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_cockpit_reading_is_an_object_or_nothing() {
        let body = json!({"day":"2026-10-28","clock":{"you":190,"agents":85},"needs":[],"folders":[]});
        assert_eq!(notch_reading(body.clone()).unwrap(), Some(body));
        // A catch-all page answering 200 with something else is not a reading.
        assert!(notch_reading(json!("<html>")).is_err());
        assert!(notch_reading(json!([1, 2])).is_err());
        // And a Helm without the endpoint (404) is `Ok(None)` in `read_notch`,
        // which the island reads as "hide everything built on it".
        let helm = Helm::default();
        assert!(helm.notch.is_none(), "absent until Helm answers");
    }

    #[test]
    fn the_chat_body_carries_only_what_the_contract_names() {
        let plain = chat_body("hej", &[], false, None, None, &[]);
        assert_eq!(plain, json!({ "text": "hej", "images": [], "page": null }));
        let full = chat_body("napraw koszyk", &[], true, Some(3), Some("request"), &[3, 5, 3, -1, 0]);
        assert_eq!(full["capture"], json!(true));
        assert_eq!(full["focus"], json!({ "projectId": 3 }));
        assert_eq!(full["command"], json!("request"));
        assert_eq!(full["mentions"], json!([{ "projectId": 3 }, { "projectId": 5 }]), "deduped, positive ids only");
        // A command Helm does not know, or a non-id focus, is not sent at all.
        let odd = chat_body("x", &[], false, Some(0), Some("delete"), &[]);
        assert!(odd.get("focus").is_none() && odd.get("command").is_none() && odd.get("mentions").is_none());
    }

    #[test]
    fn a_day_and_a_search_make_safe_paths() {
        assert_eq!(thread_path(None).unwrap(), "/api/guardian/thread");
        assert_eq!(thread_path(Some("")).unwrap(), "/api/guardian/thread");
        assert_eq!(thread_path(Some("2026-10-27")).unwrap(), "/api/guardian/thread?day=2026-10-27");
        assert!(thread_path(Some("2026-13-40")).is_err());
        assert!(thread_path(Some("2026-10-27&x=1")).is_err());
        assert_eq!(history_path(None), "/api/guardian/history");
        assert_eq!(history_path(Some("  ")), "/api/guardian/history");
        assert_eq!(history_path(Some("faktura Ubrania")), "/api/guardian/history?q=faktura+Ubrania");
        assert_eq!(history_path(Some("a&b=c")), "/api/guardian/history?q=a%26b%3Dc", "the query cannot add a parameter");
        assert!(history_path(Some("ż")).contains("%C5%BC"), "Polish letters are encoded");
    }

    #[test]
    fn a_cards_id_is_a_segment_and_nothing_more() {
        assert_eq!(segment("12").unwrap(), "12");
        assert_eq!(segment(" sub:7 ").unwrap(), "sub:7");
        assert!(segment("../12").is_err());
        assert!(segment("12/log").is_err());
        assert!(segment("12?x=1").is_err());
        assert!(segment("").is_err());
        assert!(segment(".hidden").is_err());
    }

    #[test]
    fn a_recording_goes_as_multipart_with_its_kind() {
        assert_eq!(audio_kind("audio/webm;codecs=opus"), Some(("speech.webm", "audio/webm")));
        assert_eq!(audio_kind("audio/ogg"), Some(("speech.ogg", "audio/ogg")));
        assert_eq!(audio_kind("audio/x-wav"), Some(("speech.wav", "audio/wav")));
        assert_eq!(audio_kind("audio/mpeg"), None, "not a kind the contract lists");
        let audio = b"\x1aE\xdf\xa3 not really webm";
        let boundary = boundary_for(audio);
        let body = multipart(&boundary, audio, "speech.webm", "audio/webm", Some("pl"));
        let text = String::from_utf8_lossy(&body);
        assert!(text.starts_with(&format!("--{boundary}\r\nContent-Disposition: form-data; name=\"audio\"; filename=\"speech.webm\"\r\nContent-Type: audio/webm\r\n\r\n")));
        assert!(text.contains(&format!("--{boundary}\r\nContent-Disposition: form-data; name=\"lang\"\r\n\r\npl\r\n")));
        assert!(text.ends_with(&format!("--{boundary}--\r\n")));
        assert!(body.windows(audio.len()).any(|w| w == audio), "the audio is there byte for byte");
        // A language that is not a language is left out rather than sent.
        let quiet = multipart(&boundary, audio, "speech.webm", "audio/webm", Some("pl\r\nX: 1"));
        assert!(!String::from_utf8_lossy(&quiet).contains("name=\"lang\""));
    }

    #[test]
    fn the_boundary_never_occurs_in_the_audio() {
        let audio = vec![0u8; 4096];
        let boundary = boundary_for(&audio);
        assert!(boundary.starts_with("codenotch-"));
        assert!(!audio.windows(boundary.len()).any(|w| w == boundary.as_bytes()));
    }

    #[test]
    fn a_request_is_addressed_by_its_number_alone() {
        assert_eq!(request_path(12, "/log").unwrap(), "/api/notch/requests/12/log");
        assert!(request_path(0, "").is_err());
        assert!(request_path(-3, "").is_err());
    }

    #[test]
    fn only_images_are_kept_as_logos() {
        assert_eq!(logo_type("image/png"), Some("image/png"));
        assert_eq!(logo_type("image/SVG+xml; charset=utf-8"), Some("image/svg+xml"));
        assert_eq!(logo_type("text/html"), None);
        assert_eq!(logo_type("application/octet-stream"), None);
    }

    #[test]
    fn a_nudge_rings_when_new_and_once_more_if_left() {
        let mut bell = Bell::default();
        let t0 = Instant::now();
        assert_eq!(bell.ring(&[7], t0), Ring::New(7), "a new nudge rings and opens");
        assert_eq!(bell.ring(&[7], t0 + Duration::from_secs(20)), Ring::Quiet, "not on every reading");
        assert_eq!(bell.ring(&[7], t0 + RING_AGAIN), Ring::Again, "once more if still unread, without opening");
        assert_eq!(bell.ring(&[7], t0 + RING_AGAIN * 3), Ring::Quiet, "and only once more");
        assert_eq!(bell.ring(&[7, 8], t0 + RING_AGAIN * 3), Ring::New(8), "another new one opens");
        assert_eq!(bell.ring(&[], t0 + RING_AGAIN * 4), Ring::Quiet, "read: nothing");
        assert!(bell.rang.is_empty(), "read ones are forgotten");
    }

    #[test]
    fn lines_survive_a_chunk_cut_through_a_letter() {
        let line = "{\"t\":\"text\",\"d\":\"Zażółć\"}\n";
        let bytes = line.as_bytes();
        // Cut inside "ż", whose UTF-8 is two bytes.
        let cut = line.find('ż').unwrap() + 1;
        let mut buffer = Vec::new();
        buffer.extend_from_slice(&bytes[..cut]);
        assert!(take_lines(&mut buffer).is_empty(), "no line until its newline arrives");
        buffer.extend_from_slice(&bytes[cut..]);
        buffer.extend_from_slice(b"{\"t\":\"done\"");
        let lines = take_lines(&mut buffer);
        assert_eq!(lines, vec![line.trim().to_string()], "decoded whole, with the letter intact");
        assert_eq!(buffer, b"{\"t\":\"done\"", "the unfinished tail waits");
    }

    #[test]
    fn a_token_is_refreshed_before_it_runs_out() {
        assert!(!stale(10_000, 10_000 - 3600), "an hour left: used as is");
        assert!(stale(10_000, 10_000 - 120), "two minutes left: refreshed first");
        assert!(stale(10_000, 10_100), "already out");
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
    fn an_older_credential_still_reads() {
        // Written by the first version: an address and a key, no session yet.
        let old: Config = serde_json::from_str(r#"{"url":"https://crm.hadastudios.com","key":"abc"}"#).unwrap();
        assert_eq!(old.key, "abc");
        assert!(old.refresh.is_none(), "connected, not signed in: today works, the chat asks to sign in");
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
