//! What is playing NEXT.
//!
//! ⚠️ This is not a second player, and adding one would be a mistake. Windows'
//! own `GlobalSystemMediaTransportControls` (see `media.rs`) already gives the
//! title, the artist, the artwork, the position and every transport control —
//! for Spotify, a browser tab, VLC, anything that answers the media keys. It is
//! the right source precisely because it does not care which app is playing.
//!
//! What it cannot give is the QUEUE. There is no such concept in the Windows
//! transport API, and there is no way to derive one. So this module exists for
//! exactly one endpoint — `/v1/me/player/queue` — and everything else the media
//! screen shows still comes from the system session. If Spotify is not
//! connected the screen loses its "Playing Next" list and nothing else.
//!
//! ⚠️ **PKCE, no client secret.** A desktop app cannot keep a secret, and
//! Spotify's own guidance for installed apps is the PKCE flow. It also means
//! the user pastes ONE value instead of two.
//!
//! ⚠️ **A FIXED redirect port, unlike Google.** Google accepts any loopback
//! port; Spotify matches the redirect URI character for character against what
//! is registered in the dashboard, port included. A random port is rejected
//! with `INVALID_CLIENT: Invalid redirect URI` — which reads like a bad client
//! id and sends you looking in the wrong place entirely.

use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::time::{Duration, Instant};

use base64::Engine;
use rand::Rng;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::AppHandle;

use crate::credentials;

const AUTH: &str = "https://accounts.spotify.com/authorize";
const TOKEN: &str = "https://accounts.spotify.com/api/token";
const QUEUE: &str = "https://api.spotify.com/v1/me/player/queue";

/// ⚠️ Read-only, and only the one thing that is needed. `user-read-playback-state`
/// is what `/me/player/queue` requires; nothing here modifies playback, which is
/// still the system transport's job.
const SCOPE: &str = "user-read-playback-state";

/// ⚠️ Registered in the Spotify dashboard EXACTLY, port and path included. See
/// the module note: Spotify does not accept an arbitrary loopback port.
const PORT: u16 = 5733;
const REDIRECT: &str = "http://127.0.0.1:5733/callback";

/// The redirect URI the user has to paste into the Spotify dashboard, so the
/// settings window can print the one string that has to match.
#[tauri::command]
pub fn spotify_redirect() -> &'static str {
    REDIRECT
}

#[derive(Serialize, Deserialize)]
struct Stored {
    client_id: String,
    refresh_token: String,
}

fn stored() -> Result<Option<Stored>, String> {
    let Some(raw) = credentials::read(credentials::SPOTIFY)? else {
        return Ok(None);
    };
    Ok(serde_json::from_str(&raw).ok())
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .unwrap_or_default()
}

fn url_safe(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// Percent-encoding for the handful of characters the values below can contain.
/// ⚠️ Deliberately not a whole crate: the inputs are a client id, a fixed URL
/// and a base64url digest, and a dependency for that is a dependency to keep
/// current for ever.
fn encode(value: &str) -> String {
    value
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            other => format!("%{other:02X}"),
        })
        .collect()
}

fn auth_url(client_id: &str, challenge: &str) -> String {
    format!(
        "{AUTH}?client_id={}&response_type=code&redirect_uri={}&scope={}&code_challenge_method=S256&code_challenge={}",
        encode(client_id),
        encode(REDIRECT),
        encode(SCOPE),
        encode(challenge)
    )
}

/// Serve exactly one request: the redirect Spotify sends the browser back to.
///
/// ⚠️ A near-copy of `calendar.rs`'s. It is not shared, and that is deliberate
/// for now: the two differ in the copy they serve and in which query parameters
/// they care about, and folding them together would mean a helper that takes
/// four strings to say what it is listening for.
fn await_code(listener: TcpListener) -> Result<String, String> {
    listener
        .set_nonblocking(false)
        .map_err(|_| "Could not listen for the Spotify redirect.".to_string())?;
    let deadline = Instant::now() + Duration::from_secs(180);
    for stream in listener.incoming() {
        if Instant::now() > deadline {
            return Err("Timed out waiting for Spotify. Try connecting again.".into());
        }
        let Ok(mut stream) = stream else { continue };
        let mut line = String::new();
        if BufReader::new(&stream).read_line(&mut line).is_err() {
            continue;
        }
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
        let body = if code.is_some() {
            "<h2>Codenotch is connected to Spotify.</h2><p>You can close this tab.</p>"
        } else {
            "<h2>Spotify did not grant access.</h2><p>Close this tab and try again.</p>"
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
            return Err(format!("Spotify returned \"{error}\"."));
        }
        if let Some(code) = code {
            return Ok(code);
        }
        // Anything else is the browser asking for a favicon; keep listening.
    }
    Err("The Spotify redirect never arrived.".into())
}

async fn post_token(
    http: &reqwest::Client,
    form: &[(&str, &str)],
) -> Result<serde_json::Map<String, Value>, String> {
    let response = http
        .post(TOKEN)
        .form(form)
        .send()
        .await
        .map_err(|_| "Could not reach Spotify to exchange the token.".to_string())?;
    let status = response.status();
    let body: Value = response
        .json()
        .await
        .map_err(|_| "Spotify's token response was not JSON.".to_string())?;
    if !status.is_success() {
        // `error_description` carries the part worth reading; the bare code
        // ("invalid_grant") on its own sends people hunting in the wrong place.
        let detail = body
            .get("error_description")
            .and_then(Value::as_str)
            .or_else(|| body.get("error").and_then(Value::as_str))
            .unwrap_or("no detail");
        return Err(format!("Spotify rejected the sign-in: {detail}"));
    }
    body.as_object()
        .cloned()
        .ok_or_else(|| "Spotify's token response was not an object.".to_string())
}

#[tauri::command]
pub async fn connect_spotify(
    window: tauri::WebviewWindow,
    client_id: String,
) -> Result<(), String> {
    // ⚠️ Settings-window only. The island is `WS_EX_NOACTIVATE` and never
    // handles a credential; the same guard `connect_google` carries.
    if window.label() != "task-editor" {
        return Err("Connect Spotify from the settings window.".into());
    }
    let client_id = client_id.trim().to_string();
    if client_id.is_empty() {
        return Err("Paste the client ID from your Spotify app.".into());
    }

    let verifier = url_safe(&rand::rng().random::<[u8; 48]>());
    let challenge = url_safe(&Sha256::digest(verifier.as_bytes()));

    /* ⚠️ Bound BEFORE the browser opens, and the failure is worth naming. The
     * port is fixed (see the module note), so anything else already holding it
     * — a second Codenotch, a dev server — makes the redirect unreachable, and
     * the symptom without this message is three minutes of a browser tab that
     * never comes back. */
    let listener = TcpListener::bind(("127.0.0.1", PORT)).map_err(|_| {
        format!(
            "Port {PORT} is already in use, so Spotify cannot redirect back. \
             Close whatever is using it and try again."
        )
    })?;

    crate::calendar::open_browser(&auth_url(&client_id, &challenge))?;

    // The listener blocks, so it cannot run on the async runtime.
    let code = tauri::async_runtime::spawn_blocking(move || await_code(listener))
        .await
        .map_err(|_| "The sign-in listener stopped unexpectedly.".to_string())??;

    let http = client();
    let body = post_token(
        &http,
        &[
            ("grant_type", "authorization_code"),
            ("code", code.as_str()),
            ("redirect_uri", REDIRECT),
            ("client_id", client_id.as_str()),
            ("code_verifier", verifier.as_str()),
        ],
    )
    .await?;

    let refresh_token = body
        .get("refresh_token")
        .and_then(Value::as_str)
        .ok_or_else(|| "Spotify did not return a refresh token.".to_string())?
        .to_string();

    let record = Stored { client_id, refresh_token };
    credentials::write(
        credentials::SPOTIFY,
        &serde_json::to_string(&record).map_err(|_| "Could not store the Spotify token.")?,
    )?;
    crate::log::note("spotify: connected");
    Ok(())
}

#[tauri::command]
pub fn disconnect_spotify() -> Result<(), String> {
    credentials::delete(credentials::SPOTIFY)?;
    crate::log::note("spotify: disconnected");
    Ok(())
}

/// ⚠️ A bare boolean. The client id and the refresh token never leave this
/// process — the settings window needs to know whether to say "connected", not
/// what it is connected with.
#[tauri::command]
pub fn spotify_status() -> bool {
    matches!(stored(), Ok(Some(_)))
}

async fn access_token(http: &reqwest::Client) -> Result<Option<String>, String> {
    let Some(record) = stored()? else {
        return Ok(None);
    };
    let body = post_token(
        http,
        &[
            ("grant_type", "refresh_token"),
            ("refresh_token", record.refresh_token.as_str()),
            ("client_id", record.client_id.as_str()),
        ],
    )
    .await?;

    /* ⚠️ Spotify rotates the refresh token on some responses and omits it on
     * others. Keeping the old one when a new one arrives is how a connection
     * works for weeks and then stops for no visible reason. */
    if let Some(fresh) = body.get("refresh_token").and_then(Value::as_str) {
        if fresh != record.refresh_token {
            let updated = Stored {
                client_id: record.client_id.clone(),
                refresh_token: fresh.to_string(),
            };
            if let Ok(json) = serde_json::to_string(&updated) {
                let _ = credentials::write(credentials::SPOTIFY, &json);
            }
        }
    }

    Ok(body
        .get("access_token")
        .and_then(Value::as_str)
        .map(str::to_string))
}

/// One track in the queue, flattened to what the island actually draws.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueTrack {
    pub id: String,
    pub title: String,
    pub artist: String,
    pub artwork: String,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Queue {
    /// False when Spotify is not connected at all, so the screen can offer the
    /// connection rather than an empty list.
    pub connected: bool,
    pub tracks: Vec<QueueTrack>,
    /// Said out loud rather than logged. ⚠️ "Nothing came back" and "Spotify is
    /// not playing on any device" look identical from the island, and only one
    /// of them is something the user can do anything about.
    pub note: String,
}

fn track(value: &Value) -> Option<QueueTrack> {
    let title = value.get("name")?.as_str()?.to_string();
    let artist = value
        .get("artists")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|a| a.get("name").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join(", ")
        })
        .unwrap_or_default();
    /* The SMALLEST image that is still worth looking at. Spotify lists them
     * largest first, so the last one is the 64px thumbnail — a queue of twenty
     * 640px covers is several megabytes fetched to draw them at 34px. */
    let artwork = value
        .get("album")
        .and_then(|album| album.get("images"))
        .and_then(Value::as_array)
        .and_then(|images| images.last())
        .and_then(|image| image.get("url"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    Some(QueueTrack {
        id: value
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or(&title)
            .to_string(),
        title,
        artist,
        artwork,
    })
}

/// What is playing next, or why it cannot be said.
///
/// ⚠️ Never an `Err` for the ordinary cases. A rejected promise in the island
/// becomes a red banner across the screen, and "Spotify is not playing on any
/// device" is not an error — it is the normal state of an app that is not open.
#[tauri::command]
pub async fn spotify_queue() -> Result<Queue, String> {
    let http = client();
    let Some(token) = access_token(&http).await.unwrap_or(None) else {
        return Ok(Queue {
            connected: spotify_status(),
            tracks: Vec::new(),
            note: if spotify_status() {
                "Could not refresh the Spotify session. Reconnect it in Settings.".into()
            } else {
                String::new()
            },
        });
    };

    let response = http
        .get(QUEUE)
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|_| "Could not reach Spotify.".to_string())?;

    /* ⚠️ 204 means "nothing is playing" and has NO BODY. Parsing it as JSON
     * fails, which turned a perfectly ordinary paused Spotify into an error on
     * the screen. */
    if response.status() == reqwest::StatusCode::NO_CONTENT {
        return Ok(Queue {
            connected: true,
            tracks: Vec::new(),
            note: "Spotify is not playing on any device.".into(),
        });
    }
    if response.status() == reqwest::StatusCode::FORBIDDEN {
        return Ok(Queue {
            connected: true,
            tracks: Vec::new(),
            note: "Spotify will not share the queue for this account.".into(),
        });
    }
    if !response.status().is_success() {
        return Ok(Queue {
            connected: true,
            tracks: Vec::new(),
            note: format!("Spotify answered {}.", response.status().as_u16()),
        });
    }

    let body: Value = response
        .json()
        .await
        .map_err(|_| "Spotify's queue was not JSON.".to_string())?;
    let tracks: Vec<QueueTrack> = body
        .get("queue")
        .and_then(Value::as_array)
        .map(|list| list.iter().filter_map(track).collect())
        .unwrap_or_default();

    Ok(Queue {
        connected: true,
        note: if tracks.is_empty() {
            "Nothing queued after this track.".into()
        } else {
            String::new()
        },
        tracks,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// ⚠️ The redirect URI is matched character for character by Spotify, so
    /// the string the settings window tells the user to register and the string
    /// the auth URL asks for have to be the same one. They were two constants
    /// for about ten minutes.
    #[test]
    fn the_redirect_is_one_string_and_it_carries_the_port() {
        assert!(REDIRECT.contains(&PORT.to_string()));
        assert_eq!(spotify_redirect(), REDIRECT);
        let url = auth_url("abc123", "chal");
        assert!(url.contains(&encode(REDIRECT)));
        // 127.0.0.1, never "localhost": Spotify rejects the hostname form.
        assert!(REDIRECT.starts_with("http://127.0.0.1:"));
    }

    #[test]
    fn a_queue_entry_takes_the_smallest_cover_and_joins_its_artists() {
        let value: Value = serde_json::from_str(
            r#"{"id":"t1","name":"Roulette","artists":[{"name":"Bilal Wahib"},{"name":"Boef"}],
                "album":{"images":[{"url":"big"},{"url":"mid"},{"url":"small"}]}}"#,
        )
        .unwrap();
        let out = track(&value).unwrap();
        assert_eq!(out.title, "Roulette");
        assert_eq!(out.artist, "Bilal Wahib, Boef");
        // Largest first, so the LAST is the thumbnail — a queue of twenty
        // 640px covers is megabytes fetched to draw at 34px.
        assert_eq!(out.artwork, "small");
    }

    /// A track with no album art at all must still be a row.
    #[test]
    fn a_track_without_a_cover_is_still_a_track() {
        let value: Value = serde_json::from_str(r#"{"name":"Habiba"}"#).unwrap();
        let out = track(&value).unwrap();
        assert_eq!(out.title, "Habiba");
        assert_eq!(out.artwork, "");
        // No id: the title stands in, so the row still has a key.
        assert_eq!(out.id, "Habiba");
        // And something that is not a track at all is dropped rather than drawn.
        assert!(track(&serde_json::json!({"nope": 1})).is_none());
    }
}
