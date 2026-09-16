//! Whatever is playing, from the system rather than from a service.
//!
//! Windows' `GlobalSystemMediaTransportControls` is the same thing the media
//! keys and the volume-flyout overlay talk to, so it covers Spotify, a YouTube
//! tab, VLC and anything else that registers a session — with no account, no
//! OAuth and no premium tier. A Spotify-specific integration could add seeking
//! and playlists later; it could never cover the browser tab.
//!
//! ⚠️ Everything here is WinRT and blocking. `IAsyncOperation::get()` parks the
//! calling thread, so this owns a plain OS thread and commands hop onto it
//! rather than running on Tauri's async runtime. The thread also has to enter a
//! COM apartment first: without `CoInitializeEx` the very first WinRT activation
//! fails with `CO_E_NOTINITIALIZED` and every reading comes back empty.

use std::sync::Mutex;
use std::time::Duration;

use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use windows::core::RuntimeType;
use windows_future::{AsyncStatus, IAsyncOperation};
use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSession as Session,
    GlobalSystemMediaTransportControlsSessionManager as SessionManager,
    GlobalSystemMediaTransportControlsSessionMediaProperties as Properties,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus as PlaybackStatus,
};
use windows::Storage::Streams::DataReader;
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Media {
    /// False when nothing on the machine owns a transport-controls session.
    pub active: bool,
    pub playing: bool,
    pub title: String,
    pub artist: String,
    pub album: String,
    /// The owning app's AUMID, e.g. `Spotify.exe`. Shown as the source label.
    pub source: String,
    /// Seconds. Zero when the player does not report a timeline, which is
    /// common for browsers — the UI must not draw a scrubber from this alone.
    pub position: f64,
    pub duration: f64,
    /// Album art as a `data:` URI, or empty. Re-read only when the track
    /// changes: it is a few hundred KB and it crosses the IPC boundary.
    pub artwork: String,
    pub can_next: bool,
    pub can_previous: bool,
    pub can_play_pause: bool,
    /// Whether the player accepts a position change. Plenty do not, and the
    /// waveform must not offer to scrub something that will ignore it.
    pub can_seek: bool,
}

#[derive(Default)]
pub struct MediaState {
    view: Mutex<Media>,
}

impl MediaState {
    pub fn snapshot(&self) -> Media {
        self.view.lock().unwrap().clone()
    }
}

/// Wait for a WinRT async operation on this thread.
///
/// ⚠️ `windows` 0.62 dropped `IAsyncOperation::get()`; the crate now offers only
/// `IntoFuture`. Awaiting would mean standing a Tokio runtime up inside a COM
/// apartment for what is a local, sub-millisecond call, so this spins on the
/// status the interface still exposes. The deadline is the point: a player that
/// never completes must not wedge the media thread for the life of the app.
pub(crate) fn block<T: RuntimeType + 'static>(op: IAsyncOperation<T>) -> windows::core::Result<T> {
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    loop {
        match op.Status() {
            Ok(AsyncStatus::Started) if std::time::Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(2));
            }
            // Completed, Error, Canceled and the timeout all resolve here:
            // GetResults carries the failure for everything but Completed.
            _ => return op.GetResults(),
        }
    }
}

fn text(value: windows::core::Result<windows::core::HSTRING>) -> String {
    value.map(|v| v.to_string()).unwrap_or_default()
}

/// Album art, base64'd into a data URI.
///
/// The thumbnail is an `IRandomAccessStreamReference`, so it has to be opened
/// and drained before it is anything. Players hand back PNG or JPEG without
/// saying which, so the type is sniffed from the magic bytes rather than
/// guessed — a wrong `data:` prefix renders nothing and reports no error.
fn artwork(props: &Properties) -> String {
    let Ok(reference) = props.Thumbnail() else { return String::new() };
    let Ok(stream) = reference.OpenReadAsync().and_then(block) else { return String::new() };
    let Ok(size) = stream.Size() else { return String::new() };
    // A cover that big is not a cover; refuse it rather than pump it over IPC.
    if size == 0 || size > 4 * 1024 * 1024 {
        return String::new();
    }
    let Ok(input) = stream.GetInputStreamAt(0) else { return String::new() };
    let Ok(reader) = DataReader::CreateDataReader(&input) else { return String::new() };
    if reader.LoadAsync(size as u32).and_then(block).is_err() {
        return String::new();
    }
    let mut bytes = vec![0u8; size as usize];
    if reader.ReadBytes(&mut bytes).is_err() {
        return String::new();
    }
    let mime = if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        "image/png"
    } else if bytes.starts_with(&[0xFF, 0xD8]) {
        "image/jpeg"
    } else {
        return String::new();
    };
    format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(&bytes))
}

fn read(session: &Session, previous: &Media) -> Media {
    let props = session.TryGetMediaPropertiesAsync().and_then(block);
    let info = session.GetPlaybackInfo();
    let source = session.SourceAppUserModelId().map(|v| v.to_string()).unwrap_or_default();

    let (title, artist, album, art) = match &props {
        Ok(p) => {
            let title = text(p.Title());
            let artist = text(p.Artist());
            // Art is the expensive read, so only pay for it when the track
            // actually changed. Polling would otherwise decode a JPEG a second.
            let art = if previous.title == title && previous.artist == artist && !previous.artwork.is_empty() {
                previous.artwork.clone()
            } else {
                artwork(p)
            };
            (title, artist, text(p.AlbumTitle()), art)
        }
        Err(_) => (String::new(), String::new(), String::new(), String::new()),
    };

    let (playing, can_next, can_previous, can_play_pause, can_seek) = match &info {
        Ok(i) => (
            matches!(i.PlaybackStatus(), Ok(PlaybackStatus::Playing)),
            i.Controls().and_then(|c| c.IsNextEnabled()).unwrap_or(false),
            i.Controls().and_then(|c| c.IsPreviousEnabled()).unwrap_or(false),
            i.Controls()
                .map(|c| {
                    c.IsPlayEnabled().unwrap_or(false)
                        || c.IsPauseEnabled().unwrap_or(false)
                        || c.IsPlayPauseToggleEnabled().unwrap_or(false)
                })
                .unwrap_or(false),
            i.Controls().and_then(|c| c.IsPlaybackPositionEnabled()).unwrap_or(false),
        ),
        Err(_) => (false, false, false, false, false),
    };

    // TimeSpan is in 100ns ticks. Browsers frequently report all zeroes.
    let timeline = session.GetTimelineProperties();
    let (position, duration) = match &timeline {
        Ok(t) => (
            t.Position().map(|v| v.Duration as f64 / 1e7).unwrap_or(0.0),
            t.EndTime().map(|v| v.Duration as f64 / 1e7).unwrap_or(0.0),
        ),
        Err(_) => (0.0, 0.0),
    };

    Media {
        active: !title.is_empty() || !artist.is_empty(),
        playing,
        title,
        artist,
        album,
        source,
        position,
        duration: if duration > position { duration } else { 0.0 },
        artwork: art,
        can_next,
        can_previous,
        can_play_pause,
        can_seek,
    }
}

/// Enter the apartment once per thread. See the module note — skipping this
/// makes every WinRT activation below fail, silently, forever.
fn enter_apartment() {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
}

fn current(manager: &SessionManager) -> Option<Session> {
    manager.GetCurrentSession().ok()
}

/// Poll rather than subscribe.
///
/// SMTC does raise `MediaPropertiesChanged` and friends, but the handlers have
/// to be attached per session and torn down when the current session changes,
/// and the position still has to be sampled. One second of polling is a couple
/// of local COM calls and is far less to get wrong.
pub fn spawn(app: AppHandle) {
    crate::guard::spawn("media poll", move || {
        enter_apartment();
        let manager = match SessionManager::RequestAsync().and_then(block) {
            Ok(manager) => manager,
            // No transport-control service: leave the screen in its empty state
            // rather than retrying a capability the machine does not have.
            Err(_) => return,
        };
        let mut last = Media::default();
        loop {
            let next = match current(&manager) {
                Some(session) => read(&session, &last),
                None => Media::default(),
            };
            if next != last {
                last = next.clone();
                if let Some(state) = app.try_state::<MediaState>() {
                    *state.view.lock().unwrap() = next.clone();
                }
                let _ = app.emit_to("tasks", "media:changed", &next);
            }
            std::thread::sleep(Duration::from_secs(1));
        }
    });
}

#[tauri::command]
pub fn get_media(app: AppHandle) -> Media {
    app.state::<MediaState>().snapshot()
}

/// Move the playhead. Seconds in, 100ns ticks out.
///
/// ⚠️ Same threading rules as `media_command` — this blocks. A player that
/// reports `can_seek` false is not asked at all; several answer the call and
/// silently do nothing.
#[tauri::command]
pub async fn media_seek(seconds: f64) -> Result<(), String> {
    if !seconds.is_finite() || seconds < 0.0 {
        return Err("That is not a position.".into());
    }
    let ticks = (seconds * 1e7) as i64;
    let (send, receive) = tokio::sync::oneshot::channel();
    std::thread::spawn(move || {
        enter_apartment();
        let result = (|| -> Result<(), String> {
            let manager = SessionManager::RequestAsync()
                .and_then(block)
                .map_err(|_| "Windows is not reporting any media sessions.".to_string())?;
            let session = manager
                .GetCurrentSession()
                .map_err(|_| "Nothing is playing right now.".to_string())?;
            let ok = session
                .TryChangePlaybackPositionAsync(ticks)
                .and_then(block)
                .map_err(|_| "The player refused that position.".to_string())?;
            if ok { Ok(()) } else { Err("This player does not allow seeking.".into()) }
        })();
        let _ = send.send(result);
    });
    receive.await.unwrap_or_else(|_| Err("The media thread stopped.".into()))
}

/// ⚠️ Runs on a fresh thread with its own apartment, not on Tauri's runtime:
/// these calls block, and a blocked runtime worker stalls every other command.
#[tauri::command]
pub async fn media_command(action: String) -> Result<(), String> {
    let (send, receive) = tokio::sync::oneshot::channel();
    std::thread::spawn(move || {
        enter_apartment();
        let result = (|| -> Result<(), String> {
            let manager = SessionManager::RequestAsync()
                .and_then(block)
                .map_err(|_| "Windows is not reporting any media sessions.".to_string())?;
            let session = manager
                .GetCurrentSession()
                .map_err(|_| "Nothing is playing right now.".to_string())?;
            let ok = match action.as_str() {
                "playpause" => session.TryTogglePlayPauseAsync().and_then(block),
                "next" => session.TrySkipNextAsync().and_then(block),
                "previous" => session.TrySkipPreviousAsync().and_then(block),
                _ => return Err("Unknown media action.".into()),
            }
            .map_err(|_| "The player refused that.".to_string())?;
            // The call can succeed and still report that it did nothing, which
            // is what a player that has disabled the control looks like.
            if ok {
                Ok(())
            } else {
                Err("The player does not allow that right now.".into())
            }
        })();
        let _ = send.send(result);
    });
    receive.await.unwrap_or_else(|_| Err("The media thread stopped.".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Not a unit test — a probe against whatever is playing on this machine.
    /// `cargo test --lib media -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn reads_the_live_session() {
        enter_apartment();
        let manager = SessionManager::RequestAsync()
            .and_then(block)
            .expect("session manager");
        match current(&manager) {
            Some(session) => {
                let media = read(&session, &Media::default());
                println!(
                    "source={:?}\nplaying={} title={:?} artist={:?}\npos={:.1}/{:.1}s art={} bytes\ncontrols: play/pause={} next={} prev={}",
                    media.source, media.playing, media.title, media.artist,
                    media.position, media.duration, media.artwork.len(),
                    media.can_play_pause, media.can_next, media.can_previous
                );
                assert!(media.active, "a session exists but reported no metadata");
            }
            None => println!("No media session is active right now."),
        }
    }
}
