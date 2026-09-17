//! Lyrics for whatever is playing, from LRCLIB.
//!
//! ⚠️ **LRCLIB and not one of the others** because it needs no key, no account
//! and no attribution header: the alternatives all want a token, which would
//! mean a seventh thing in Credential Manager and a seventh row in Settings to
//! put it there. It is also the one that serves *synced* lyrics as the normal
//! case rather than as a paid tier.
//!
//! ⚠️ **The query is a fingerprint, not a search.** `/api/get` wants the
//! artist, the track, the album AND the duration, and answers 404 unless all
//! four line up — which is the behaviour to want: a near miss returns nothing
//! instead of another recording's words scrolling against this one's clock.
//! `/api/search` exists and is deliberately not used for the same reason.
//!
//! ⚠️ **Cached by fingerprint for the session.** A track is asked about once;
//! the player polls its position every second, and a request per second
//! against somebody's free service for a file that cannot have changed is not
//! a thing to ship.

use std::collections::HashMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

/// What the island gets back.
#[derive(Clone, Debug, Default, Serialize)]
pub struct Lyrics {
    /// The LRC file itself, timestamps and all. Empty when there are none.
    pub synced: String,
    /// Plain words, when that is all anybody uploaded. ⚠️ Shown as a block
    /// rather than followed: a wall of text that does not move is honest,
    /// whereas guessing a line's time from its index is an invention.
    pub plain: String,
    /// Whether the lookup has actually happened. False is "not asked yet";
    /// `synced` and `plain` both empty with this true is "there are none".
    pub known: bool,
}

#[derive(Deserialize)]
struct Reply {
    #[serde(rename = "syncedLyrics")]
    synced: Option<String>,
    #[serde(rename = "plainLyrics")]
    plain: Option<String>,
}

#[derive(Default)]
pub struct Cache(pub Mutex<HashMap<String, Lyrics>>);

/// ⚠️ The same key on both sides of the cache, built in one place. Two
/// spellings of "artist — title — 213" is a cache that never hits and a
/// request per second, which is the failure this exists to prevent.
fn key(artist: &str, track: &str, seconds: u32) -> String {
    format!(
        "{}\u{1}{}\u{1}{}",
        artist.trim().to_lowercase(),
        track.trim().to_lowercase(),
        seconds
    )
}

fn encode(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            b' ' => out.push_str("%20"),
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

/// Fetch, or hand back what was fetched before.
///
/// ⚠️ Never an error to the caller. A song with no lyrics, a network that is
/// down and a service that is having a bad day are the same thing to the
/// island — nothing to show — and a red line across the player is not what
/// anybody wants from a nice-to-have.
#[tauri::command]
pub async fn get_lyrics(
    app: tauri::AppHandle,
    artist: String,
    track: String,
    album: String,
    seconds: u32,
) -> Lyrics {
    use tauri::Manager;
    if artist.trim().is_empty() || track.trim().is_empty() {
        return Lyrics::default();
    }
    let id = key(&artist, &track, seconds);
    /* ⚠️ The guard is dropped before the await below. A `MutexGuard` held
     * across an await point makes the future non-Send, which Tauri's command
     * machinery will not take — and the state handle itself has to go out of
     * scope before the guard does, or the borrow outlives what it borrows. */
    let cached = {
        let cache = app.state::<Cache>();
        let found = cache.0.lock().ok().and_then(|held| held.get(&id).cloned());
        found
    };
    if let Some(found) = cached {
        return found;
    }

    let url = format!(
        "https://lrclib.net/api/get?artist_name={}&track_name={}&album_name={}&duration={}",
        encode(artist.trim()),
        encode(track.trim()),
        encode(album.trim()),
        seconds
    );
    /* ⚠️ A User-Agent with a way to reach us. LRCLIB asks for one in its
     * documentation, and a service that is free because people are decent
     * about it is one to be decent about. */
    let found = match reqwest::Client::new()
        .get(&url)
        .header("User-Agent", "Codenotch (https://github.com/FESTUSNIX)")
        .send()
        .await
    {
        Ok(reply) if reply.status().is_success() => reply.json::<Reply>().await.ok(),
        // 404 is the ordinary answer for "nobody has uploaded these".
        _ => None,
    };

    let lyrics = Lyrics {
        synced: found.as_ref().and_then(|r| r.synced.clone()).unwrap_or_default(),
        plain: found.as_ref().and_then(|r| r.plain.clone()).unwrap_or_default(),
        known: true,
    };
    if let Ok(mut held) = app.state::<Cache>().0.lock() {
        /* A day of listening is a few hundred tracks; a bound stops a machine
         * left running for a week holding every one of them. */
        if held.len() > 400 {
            held.clear();
        }
        held.insert(id, lyrics.clone());
    }
    lyrics
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_key_ignores_case_and_edge_whitespace() {
        assert_eq!(key(" Boards of Canada ", "Roygbiv", 133), key("boards of canada", "roygbiv", 133));
        // The duration is part of it: a remaster is a different recording.
        assert_ne!(key("a", "b", 133), key("a", "b", 134));
    }

    #[test]
    fn encoding_survives_what_track_titles_actually_contain() {
        assert_eq!(encode("Roygbiv"), "Roygbiv");
        assert_eq!(encode("a b"), "a%20b");
        assert_eq!(encode("Sigur Rós"), "Sigur%20R%C3%B3s");
        assert_eq!(encode("?&=#"), "%3F%26%3D%23");
    }
}
