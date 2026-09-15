//! Google Calendar, read-only.
//!
//! Chosen over a secret ICS link because the island shows a countdown to the
//! next thing: Google caches its private iCal feed for hours, which is fine for
//! "today's agenda" and useless for "starts in 5 minutes".
//!
//! The flow is the installed-app one — authorization code with PKCE and a
//! loopback redirect on an ephemeral port. ⚠️ Google still requires
//! `client_secret` for a Desktop client even with PKCE; its own docs say that
//! secret is not treated as confidential for installed apps. It goes in Windows
//! Credential Manager with the refresh token and is never returned to a WebView.

use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::Engine;
use chrono::{Datelike, Utc};
use rand::Rng;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};
use windows::core::{w, HSTRING, PCWSTR};
use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};
use windows::Win32::UI::Shell::ShellExecuteW;
use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

use crate::credentials;

const SCOPE: &str = "https://www.googleapis.com/auth/calendar.readonly";
const AUTH: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN: &str = "https://oauth2.googleapis.com/token";
const API: &str = "https://www.googleapis.com/calendar/v3";
/// More than a week of agenda is not glanceable, and the request is per calendar.
/// ⚠️ 45, not 7. A month grid has to be able to mark a busy day, and the
/// agenda beside it runs past the end of the week. Six weeks is the most a
/// month grid can show, and this covers the current one plus the next.
const HORIZON_DAYS: i64 = 45;
/// Calendars past this are almost always subscriptions — holidays, birthdays,
/// someone else's availability — and each one costs a request.
const MAX_CALENDARS: usize = 8;

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Stored {
    client_id: String,
    client_secret: String,
    refresh_token: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub id: String,
    pub title: String,
    /// RFC 3339 for timed events; `YYYY-MM-DD` for all-day ones. The frontend
    /// needs the distinction to avoid printing "00:00" against a whole day.
    pub start: String,
    pub end: String,
    pub all_day: bool,
    pub location: String,
    /// Meet/Zoom/Teams link if the event has one, so the island can offer Join.
    pub meeting_url: String,
    pub calendar: String,
    pub color: String,
    /// "accepted" | "declined" | "tentative" | "needsAction" | "" for the user.
    pub response: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Calendar {
    pub connected: bool,
    pub events: Vec<Event>,
    pub updated_at: Option<String>,
    pub error: Option<String>,
}

#[derive(Default)]
pub struct CalendarState {
    view: Mutex<Calendar>,
    access: Mutex<Option<(String, Instant)>>,
    gate: tokio::sync::Mutex<()>,
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .user_agent("codenotch-win-calendar/0.1")
        .build()
        .expect("HTTP client")
}

fn url_safe(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn encode(value: &str) -> String {
    // Percent-encoding for the few characters that actually appear in the
    // values assembled below (URLs, scopes, base64url). Pulling a whole
    // dependency in for this would be the larger risk.
    value
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                (b as char).to_string()
            }
            other => format!("%{other:02X}"),
        })
        .collect()
}

fn stored() -> Result<Option<Stored>, String> {
    match credentials::read(credentials::GOOGLE)? {
        Some(raw) => serde_json::from_str(&raw)
            .map(Some)
            .map_err(|_| "The saved Google credential is unreadable. Reconnect it.".to_string()),
        None => Ok(None),
    }
}

/// Open a URL in the user's real browser.
///
/// ⚠️ **Never `cmd /C start`.** `cmd` treats `&` as a command separator, and an
/// OAuth URL is nothing but `&`-separated parameters — the browser received
/// everything up to the first one and Google answered
/// "Required parameter is missing: response_type". Quoting does not reliably
/// save it either; `start`'s own argument parsing is a law unto itself.
/// `ShellExecuteW` hands the string to the shell API directly, with no command
/// line to be re-parsed.
///
/// Deliberately the real browser and not a WebView: Google blocks sign-in from
/// embedded browsers, and it is the wrong thing to ask of someone anyway.
pub(crate) fn open_browser(url: &str) -> Result<(), String> {
    // ShellExecuteW may delegate to a Shell extension, which needs COM. Already
    // initialised on this thread is fine — the error is ignored on purpose.
    let result = unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let target = HSTRING::from(url);
        ShellExecuteW(
            None,
            w!("open"),
            PCWSTR(target.as_ptr()),
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        )
    };
    // The legacy contract: anything at or below 32 is an error code, not a
    // handle. Worth checking — a browser that never opened otherwise looks like
    // three minutes of waiting for a redirect that was never coming.
    if result.0 as isize > 32 {
        Ok(())
    } else {
        Err("Windows could not open your browser. Check that a default browser is set.".into())
    }
}

/// Serve exactly one request: the redirect Google sends the browser back to.
fn await_code(listener: TcpListener) -> Result<String, String> {
    listener
        .set_nonblocking(false)
        .map_err(|_| "Could not listen for the Google redirect.".to_string())?;
    let deadline = Instant::now() + Duration::from_secs(180);
    for stream in listener.incoming() {
        if Instant::now() > deadline {
            return Err("Timed out waiting for Google. Try connecting again.".into());
        }
        let Ok(mut stream) = stream else { continue };
        let mut line = String::new();
        if BufReader::new(&stream).read_line(&mut line).is_err() {
            continue;
        }
        // "GET /?code=…&scope=… HTTP/1.1"
        let target = line.split_whitespace().nth(1).unwrap_or("");
        let query = target.split_once('?').map(|(_, q)| q).unwrap_or("");
        let mut code = None;
        let mut error = None;
        for pair in query.split('&') {
            match pair.split_once('=') {
                Some(("code", value)) => code = Some(value.to_string()),
                Some(("error", value)) => error = Some(value.to_string()),
                _ => {}
            }
        }
        let done = code.is_some() || error.is_some();
        let body = if code.is_some() {
            "<h2>Codenotch is connected.</h2><p>You can close this tab.</p>"
        } else {
            "<h2>Google did not grant access.</h2><p>Close this tab and try again.</p>"
        };
        let _ = stream.write_all(
            format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
            .as_bytes(),
        );
        let _ = stream.flush();
        if let Some(error) = error {
            return Err(format!("Google returned \"{error}\"."));
        }
        if let Some(code) = code {
            return Ok(code);
        }
        if done {
            break;
        }
        // Anything else is the browser asking for a favicon; keep listening.
    }
    Err("The Google redirect never arrived.".into())
}

async fn exchange(
    http: &reqwest::Client,
    form: &[(&str, &str)],
) -> Result<serde_json::Map<String, Value>, String> {
    let response = http
        .post(TOKEN)
        .form(form)
        .send()
        .await
        .map_err(|_| "Could not reach Google to exchange the token.".to_string())?;
    let status = response.status();
    let body: Value = response
        .json()
        .await
        .map_err(|_| "Google's token response was not JSON.".to_string())?;
    if !status.is_success() {
        // Google puts the useful part in error_description; the bare code
        // ("invalid_client") on its own sends people hunting in the wrong place.
        let detail = body
            .get("error_description")
            .and_then(Value::as_str)
            .or_else(|| body.get("error").and_then(Value::as_str))
            .unwrap_or("no detail");
        return Err(format!("Google rejected the sign-in: {detail}"));
    }
    body.as_object()
        .cloned()
        .ok_or_else(|| "Google's token response was not an object.".to_string())
}

/// The consent URL.
///
/// `access_type=offline` + `prompt=consent` are not optional: without both,
/// Google omits the refresh token on a repeat authorisation and the connection
/// silently lasts one hour.
fn auth_url(client_id: &str, redirect: &str, challenge: &str) -> String {
    format!(
        "{AUTH}?client_id={}&redirect_uri={}&response_type=code&scope={}&code_challenge={}&code_challenge_method=S256&access_type=offline&prompt=consent",
        encode(client_id),
        encode(redirect),
        encode(SCOPE),
        encode(challenge)
    )
}

#[tauri::command]
pub async fn connect_google(
    app: AppHandle,
    window: tauri::WebviewWindow,
    client_id: String,
    client_secret: String,
) -> Result<(), String> {
    // Editor-only: the notch never handles secrets.
    if window.label() != "task-editor" {
        return Err("Connect Google Calendar from the task editor.".into());
    }
    let client_id = client_id.trim().to_string();
    let client_secret = client_secret.trim().to_string();
    if client_id.is_empty() || client_secret.is_empty() {
        return Err("Paste both the client ID and the client secret.".into());
    }

    let verifier = url_safe(&rand::rng().random::<[u8; 48]>());
    let challenge = url_safe(&Sha256::digest(verifier.as_bytes()));
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|_| "Could not open a local port for the Google redirect.".to_string())?;
    let port = listener
        .local_addr()
        .map_err(|_| "Could not read the local redirect port.".to_string())?
        .port();
    let redirect = format!("http://127.0.0.1:{port}");

    open_browser(&auth_url(&client_id, &redirect, &challenge))?;

    // The listener blocks, so it cannot run on the async runtime.
    let code = tauri::async_runtime::spawn_blocking(move || await_code(listener))
        .await
        .map_err(|_| "The sign-in listener stopped unexpectedly.".to_string())??;

    let http = client();
    let body = exchange(
        &http,
        &[
            ("code", code.as_str()),
            ("client_id", client_id.as_str()),
            ("client_secret", client_secret.as_str()),
            ("code_verifier", verifier.as_str()),
            ("grant_type", "authorization_code"),
            ("redirect_uri", redirect.as_str()),
        ],
    )
    .await?;

    let refresh_token = body
        .get("refresh_token")
        .and_then(Value::as_str)
        // Without access_type=offline + prompt=consent Google omits this on a
        // repeat authorisation, and the connection silently lasts one hour.
        .ok_or("Google did not return a refresh token. Remove Codenotch at myaccount.google.com/permissions and connect again.")?
        .to_string();

    let record = Stored { client_id, client_secret, refresh_token };
    credentials::write(
        credentials::GOOGLE,
        &serde_json::to_string(&record).map_err(|_| "Could not serialise the credential.")?,
    )?;
    if let Some(access) = body.get("access_token").and_then(Value::as_str) {
        let state = app.state::<CalendarState>();
        *state.access.lock().unwrap() =
            Some((access.to_string(), Instant::now() + Duration::from_secs(3000)));
    }
    refresh_calendar(app, window).await
}

#[tauri::command]
pub async fn disconnect_google(app: AppHandle, window: tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != "task-editor" {
        return Err("Disconnect Google Calendar from the task editor.".into());
    }
    credentials::delete(credentials::GOOGLE)?;
    let state = app.state::<CalendarState>();
    *state.access.lock().unwrap() = None;
    publish(&app, &state, Calendar::default());
    Ok(())
}

fn publish(app: &AppHandle, state: &CalendarState, next: Calendar) {
    *state.view.lock().unwrap() = next.clone();
    for label in ["tasks", "task-editor"] {
        let _ = app.emit_to(label, "calendar:changed", &next);
    }
}

/// A valid access token, refreshed if the cached one is close to expiry.
async fn access_token(
    http: &reqwest::Client,
    state: &CalendarState,
    record: &Stored,
) -> Result<String, String> {
    if let Some((token, expiry)) = state.access.lock().unwrap().clone() {
        if Instant::now() < expiry {
            return Ok(token);
        }
    }
    let body = exchange(
        http,
        &[
            ("client_id", record.client_id.as_str()),
            ("client_secret", record.client_secret.as_str()),
            ("refresh_token", record.refresh_token.as_str()),
            ("grant_type", "refresh_token"),
        ],
    )
    .await?;
    let token = body
        .get("access_token")
        .and_then(Value::as_str)
        .ok_or("Google did not return an access token.")?
        .to_string();
    // Refresh a minute early rather than discovering expiry as a 401.
    let ttl = body.get("expires_in").and_then(Value::as_u64).unwrap_or(3600);
    *state.access.lock().unwrap() =
        Some((token.clone(), Instant::now() + Duration::from_secs(ttl.saturating_sub(60))));
    Ok(token)
}

async fn get_json(http: &reqwest::Client, token: &str, url: &str) -> Result<Value, String> {
    let response = http
        .get(url)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|_| "Could not reach Google Calendar.".to_string())?;
    let status = response.status();
    let body: Value = response
        .json()
        .await
        .map_err(|_| "Google Calendar returned something that was not JSON.".to_string())?;
    if !status.is_success() {
        let detail = body
            .pointer("/error/message")
            .and_then(Value::as_str)
            .unwrap_or("no detail");
        return Err(format!("Google Calendar refused the request: {detail}"));
    }
    Ok(body)
}

fn text(value: &Value, key: &str) -> String {
    value.get(key).and_then(Value::as_str).unwrap_or_default().to_string()
}

/// The conference link, wherever this event happens to carry it.
///
/// `hangoutLink` covers Meet. Everything else (Zoom, Teams) arrives as a
/// conferenceData entry point, and plenty of invitations only have it in the
/// location field, which is why that is the last resort.
fn meeting_url(event: &Value) -> String {
    if let Some(link) = event.get("hangoutLink").and_then(Value::as_str) {
        return link.to_string();
    }
    if let Some(points) = event
        .pointer("/conferenceData/entryPoints")
        .and_then(Value::as_array)
    {
        for point in points {
            if point.get("entryPointType").and_then(Value::as_str) == Some("video") {
                if let Some(uri) = point.get("uri").and_then(Value::as_str) {
                    return uri.to_string();
                }
            }
        }
    }
    let location = text(event, "location");
    if location.starts_with("http://") || location.starts_with("https://") {
        return location;
    }
    String::new()
}

fn parse_events(body: &Value, calendar: &str, color: &str) -> Vec<Event> {
    let Some(items) = body.get("items").and_then(Value::as_array) else {
        return Vec::new();
    };
    items
        .iter()
        .filter(|event| {
            // Cancelled occurrences of a recurring series still come back.
            text(event, "status") != "cancelled"
        })
        .map(|event| {
            let all_day = event.pointer("/start/date").is_some();
            let start = event
                .pointer("/start/dateTime")
                .or_else(|| event.pointer("/start/date"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let end = event
                .pointer("/end/dateTime")
                .or_else(|| event.pointer("/end/date"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let response = event
                .get("attendees")
                .and_then(Value::as_array)
                .and_then(|list| {
                    list.iter()
                        .find(|a| a.get("self").and_then(Value::as_bool) == Some(true))
                })
                .map(|a| text(a, "responseStatus"))
                .unwrap_or_default();
            Event {
                id: text(event, "id"),
                title: {
                    let summary = text(event, "summary");
                    if summary.is_empty() { "(no title)".into() } else { summary }
                },
                start,
                end,
                all_day,
                location: text(event, "location"),
                meeting_url: meeting_url(event),
                calendar: calendar.to_string(),
                color: color.to_string(),
                response,
            }
        })
        .filter(|event| !event.start.is_empty())
        .collect()
}

async fn collect(http: &reqwest::Client, token: &str) -> Result<Vec<Event>, String> {
    let list = get_json(http, token, &format!("{API}/users/me/calendarList?minAccessRole=reader")).await?;
    let calendars: Vec<(String, String, String)> = list
        .get("items")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                // `selected` absent means shown; only an explicit false hides it.
                .filter(|c| c.get("selected").and_then(Value::as_bool) != Some(false))
                .filter(|c| c.get("deleted").and_then(Value::as_bool) != Some(true))
                .take(MAX_CALENDARS)
                .map(|c| {
                    (
                        text(c, "id"),
                        text(c, "summaryOverride")
                            .is_empty()
                            .then(|| text(c, "summary"))
                            .unwrap_or_else(|| text(c, "summaryOverride")),
                        text(c, "backgroundColor"),
                    )
                })
                .collect()
        })
        .unwrap_or_default();

    let now = Utc::now();
    /* ⚠️ Back to the start of the month, not twelve hours. The grid draws the
     * whole month including the days already gone, and a dot missing from the
     * 3rd because the fetch started on the 14th is a calendar that looks wrong
     * rather than one that looks empty. */
    let min = (now - chrono::Duration::days(i64::from(now.day()) + 6)).max(now - chrono::Duration::days(38));
    let max = now + chrono::Duration::days(HORIZON_DAYS);
    let mut events = Vec::new();
    for (id, name, color) in calendars {
        let url = format!(
            "{API}/calendars/{}/events?timeMin={}&timeMax={}&singleEvents=true&orderBy=startTime&maxResults=250",
            encode(&id),
            encode(&min.to_rfc3339()),
            encode(&max.to_rfc3339())
        );
        // One unreadable calendar must not empty the whole agenda.
        if let Ok(body) = get_json(http, token, &url).await {
            events.extend(parse_events(&body, &name, &color));
        }
    }
    events.sort_by(|a, b| a.start.cmp(&b.start));
    Ok(events)
}

#[tauri::command]
pub async fn refresh_calendar(app: AppHandle, window: tauri::WebviewWindow) -> Result<(), String> {
    if !matches!(window.label(), "tasks" | "task-editor") {
        return Err("This command belongs to the task windows.".into());
    }
    let state = app.state::<CalendarState>();
    let _guard = state.gate.lock().await;
    poll(&app, &state).await
}

async fn poll(app: &AppHandle, state: &CalendarState) -> Result<(), String> {
    let Some(record) = stored()? else {
        publish(app, state, Calendar::default());
        return Ok(());
    };
    let http = client();
    let result = async {
        let token = access_token(&http, state, &record).await?;
        collect(&http, &token).await
    }
    .await;
    match result {
        Ok(events) => {
            publish(
                app,
                state,
                Calendar {
                    connected: true,
                    events,
                    updated_at: Some(Utc::now().to_rfc3339()),
                    error: None,
                },
            );
            Ok(())
        }
        Err(message) => {
            // Keep the last good agenda on screen; a stale meeting list beats
            // an empty one, exactly as the usage cells keep their last reading.
            let mut snapshot = state.view.lock().unwrap().clone();
            snapshot.connected = true;
            snapshot.error = Some(message.clone());
            publish(app, state, snapshot);
            Err(message)
        }
    }
}

pub fn spawn(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            {
                let state = app.state::<CalendarState>();
                let _guard = state.gate.lock().await;
                let _ = poll(&app, &state).await;
            }
            tokio::time::sleep(Duration::from_secs(300)).await;
        }
    });
}

#[tauri::command]
pub fn get_calendar(app: AppHandle) -> Calendar {
    app.state::<CalendarState>().view.lock().unwrap().clone()
}

/// Whether a Google client is configured, so the editor can show the right
/// state without ever receiving the secret itself.
#[tauri::command]
pub fn google_status() -> Result<bool, String> {
    Ok(stored()?.is_some())
}

/// Hand a link to the user's browser.
///
/// ⚠️ Scheme-checked, and not because the calendar is hostile: the URL comes
/// from an event body that anyone who can put a meeting in your calendar can
/// write. `cmd /c start` would happily take `file:` or a UNC path.
#[tauri::command]
pub fn open_external(url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("Only web links can be opened from here.".into());
    }
    // A quote would end the argument and hand the rest to the shell.
    if url.contains('"') || url.chars().any(char::is_control) {
        return Err("That link is malformed.".into());
    }
    open_browser(&url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_consent_url_carries_every_parameter_google_requires() {
        let url = auth_url("abc.apps.googleusercontent.com", "http://127.0.0.1:5731", "chal-1_~");
        // The bug this guards: the URL reached the browser truncated at its
        // first `&`, and Google answered "missing response_type".
        for required in [
            "response_type=code",
            "code_challenge_method=S256",
            "access_type=offline",
            "prompt=consent",
            "client_id=abc.apps.googleusercontent.com",
            "redirect_uri=http%3A%2F%2F127.0.0.1%3A5731",
            "code_challenge=chal-1_~",
        ] {
            assert!(url.contains(required), "missing {required} in {url}");
        }
        assert!(url.starts_with(AUTH));
        assert!(!url.contains(' '), "a space would break the shell call");
        assert!(url.contains("scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fcalendar.readonly"));
    }

    #[test]
    fn percent_encoding_covers_what_the_urls_carry() {
        assert_eq!(encode("a b"), "a%20b");
        assert_eq!(encode("https://x/y"), "https%3A%2F%2Fx%2Fy");
        assert_eq!(encode("aB0-._~"), "aB0-._~");
    }

    #[test]
    fn all_day_and_timed_events_keep_their_shape() {
        let body = serde_json::json!({"items":[
            {"id":"1","summary":"Standup","start":{"dateTime":"2026-09-08T09:00:00+02:00"},"end":{"dateTime":"2026-09-08T09:15:00+02:00"},
             "attendees":[{"self":true,"responseStatus":"accepted"}],"hangoutLink":"https://meet.google.com/x"},
            {"id":"2","summary":"Holiday","start":{"date":"2026-09-09"},"end":{"date":"2026-09-10"}},
            {"id":"3","summary":"Gone","status":"cancelled","start":{"date":"2026-09-09"}}
        ]});
        let events = parse_events(&body, "Work", "#123456");
        assert_eq!(events.len(), 2, "cancelled occurrences are dropped");
        assert!(!events[0].all_day);
        assert_eq!(events[0].meeting_url, "https://meet.google.com/x");
        assert_eq!(events[0].response, "accepted");
        assert!(events[1].all_day);
        assert_eq!(events[1].start, "2026-09-09");
    }

    #[test]
    fn a_zoom_link_is_found_wherever_the_invitation_put_it() {
        let entry = serde_json::json!({"conferenceData":{"entryPoints":[
            {"entryPointType":"phone","uri":"tel:+1"},
            {"entryPointType":"video","uri":"https://zoom.us/j/1"}]}});
        assert_eq!(meeting_url(&entry), "https://zoom.us/j/1");
        let located = serde_json::json!({"location":"https://teams.microsoft.com/l/1"});
        assert_eq!(meeting_url(&located), "https://teams.microsoft.com/l/1");
        let room = serde_json::json!({"location":"Meeting room 3"});
        assert_eq!(meeting_url(&room), "");
    }

    #[test]
    fn an_untitled_event_still_reads_as_something() {
        let body = serde_json::json!({"items":[{"id":"1","start":{"date":"2026-09-09"},"end":{"date":"2026-09-10"}}]});
        assert_eq!(parse_events(&body, "", "")[0].title, "(no title)");
    }
}

/// Open a file or folder with whatever the shell says owns it.
///
/// The same `ShellExecuteW` contract as `open_browser`, and the same reason for
/// checking the return: a shell that refused otherwise looks identical to a
/// click that did nothing.
pub fn open_path(target: &str) -> Result<(), String> {
    let result = unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let wide = HSTRING::from(target);
        ShellExecuteW(
            None,
            w!("open"),
            PCWSTR(wide.as_ptr()),
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        )
    };
    if result.0 as isize > 32 {
        Ok(())
    } else {
        Err("Windows would not open it.".into())
    }
}

/// Show a file in Explorer with the file itself selected.
///
/// ⚠️ `explorer.exe /select,<path>` is one argument, comma and all — there is
/// no space after the comma and the path is not a separate parameter. Written
/// any other way Explorer silently opens the user's Documents folder instead.
pub fn explore(path: &str) -> Result<(), String> {
    let result = unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let args = HSTRING::from(format!("/select,\"{path}\""));
        ShellExecuteW(
            None,
            w!("open"),
            w!("explorer.exe"),
            PCWSTR(args.as_ptr()),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        )
    };
    if result.0 as isize > 32 {
        Ok(())
    } else {
        Err("Windows would not open Explorer.".into())
    }
}
