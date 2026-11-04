//! Gabi in the notch (4 Nov): what she sends, read every ten seconds, and the
//! layer her reactions play on.
//!
//! The island decides what each note looks like (`gabi-feed.ts`); this only
//! fetches, and owns the one window the island cannot be: a full-screen,
//! transparent, click-through overlay, since a page cannot paint past its own
//! window and "hearts across the monitor" is the whole point of a reaction.
//!
//! ⚠️ **Its own beat, not Helm's minute.** `/api/notch` is a heavy read on a
//! sixty-second beat; a heart a minute late is a heart nobody connects to
//! anything. `/api/notch/gabi` is one query, so it can afford ten seconds.
//!
//! ⚠️ **A photo is never written down.** It comes back from `gabi_photo` as a
//! data URL and lives in the page's memory until it's answered or closed. Helm
//! deletes them after 24 hours and answers `no-store`; a copy here would be the
//! exact thing he said must not happen ("we don't store them for eternity").
//!
//! ⚠️ **Click-through, always, and never activated.** Same rule as the drop
//! zones (`notes.rs`): this covers the whole monitor, so one moment of it taking
//! the pointer or the focus is every click and keystroke going nowhere.
//!
//! ⚠️ **Made once, then hidden.** The first webview costs a few hundred
//! milliseconds; the page says when it has loaded (`gabi_fun_ready`) and only
//! then is the window shown, so the first reaction can't flash an empty window.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use base64::Engine;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder};

const EVERY: Duration = Duration::from_secs(10);
/// A Helm without the route (not deployed yet): ask again, but rarely.
const WITHOUT_ROUTE: Duration = Duration::from_secs(300);
/// Nobody at the PC: hold her things until someone is. He comes back to them.
const IDLE_SECS: u64 = 120;
/// The longest a reaction plays, and then some. The page says when it's done;
/// this is for a page that never does.
const LIMIT: Duration = Duration::from_secs(9);

pub const LABEL: &str = "fun";
const FUNS: [&str; 5] = ["hearts", "confetti", "hug", "stars", "coffee"];

static READY: AtomicBool = AtomicBool::new(false);
static SERIAL: AtomicU64 = AtomicU64::new(0);
static PENDING: Mutex<Option<Play>> = Mutex::new(None);

/// One reaction. `x`/`y`: where the notch is, in the overlay's CSS pixels.
#[derive(Clone, Debug, serde::Serialize)]
pub struct Play {
    fun: String,
    count: u32,
    x: f64,
    y: f64,
    edge: String,
    serial: u64,
}

pub fn spawn(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut failing = false;
        loop {
            let mut wait = EVERY;
            if crate::helm::signed_in() {
                match crate::helm::optional("/api/notch/gabi").await {
                    Ok(Some(body)) => {
                        failing = false;
                        let _ = app.emit_to("tasks", "gabi:notes", body);
                    }
                    Ok(None) => wait = WITHOUT_ROUTE,
                    Err(message) => {
                        if !failing {
                            crate::log::note(&format!("gabi: not read ({message})"));
                        }
                        failing = true;
                    }
                }
            }
            tokio::time::sleep(wait).await;
        }
    });
}

/// Why her things wait right now, or nothing: a client could see the screen, or
/// nobody's there to see them.
#[tauri::command]
pub fn gabi_hold(app: AppHandle) -> Option<String> {
    crate::voice::island_quiet(app.clone()).or_else(|| {
        (crate::apptime::idle_seconds() >= IDLE_SECS).then(|| "idle".to_string())
    })
}

/// One of the day's photos, as a data URL. `None` once it has expired.
#[tauri::command]
pub async fn gabi_photo(id: i64) -> Result<Option<String>, String> {
    if id <= 0 {
        return Ok(None);
    }
    let Some((kind, bytes)) = crate::helm::read_image(&format!("/api/gabi/photo/{id}")).await? else {
        return Ok(None);
    };
    Ok(Some(format!("data:{kind};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes))))
}

/// The screen's reading: their thread, the day's photos, the fund, her lock. `None`
/// while Helm isn't connected or is too old to have it.
#[tauri::command]
pub async fn gabi_thread() -> Result<Option<serde_json::Value>, String> {
    if !crate::helm::signed_in() {
        return Ok(None);
    }
    crate::helm::optional("/api/notch/gabi/thread").await
}

/// From the screen: a note or a surprise to her, or what he has now seen. Helm checks it.
#[tauri::command]
pub async fn gabi_send(body: serde_json::Value) -> Result<(), String> {
    crate::helm::post_quietly("/api/notch/gabi/thread", body).await
}

/// A note seen or answered. `reply` goes back to her phone; `photo` is the
/// picture it came with. ⚠️ Not `helm_notch_post`: that wakes the whole poll,
/// and five hearts in a row don't need the queue read five times.
#[tauri::command]
pub async fn gabi_answer(id: i64, reply: Option<String>, photo: Option<i64>) -> Result<(), String> {
    if id <= 0 {
        return Err("Which note?".into());
    }
    let mut body = serde_json::Map::new();
    if let Some(reply) = reply.as_deref().map(str::trim).filter(|r| !r.is_empty()) {
        body.insert("reply".into(), reply.into());
    }
    if let Some(photo) = photo {
        body.insert("photo".into(), photo.into());
    }
    crate::helm::post_quietly(&format!("/api/notch/gabi/{id}"), serde_json::Value::Object(body)).await
}

/// Build the overlay if it isn't there yet. Hidden until there's something to show.
fn ensure(app: &AppHandle) -> Result<tauri::WebviewWindow, String> {
    if let Some(found) = app.get_webview_window(LABEL) {
        return Ok(found);
    }
    WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("fun.html".into()))
        .title("Codenotch reactions")
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .focused(false)
        .visible(false)
        .build()
        .map_err(|e| e.to_string())
}

/// The overlay's place: the monitor the island is on. Answers the scale.
fn place(app: &AppHandle, overlay: &tauri::WebviewWindow) -> Result<(f64, f64, f64), String> {
    let island = app.get_webview_window("tasks").ok_or("No island.")?;
    let monitor = island.current_monitor().map_err(|e| e.to_string())?.ok_or("No monitor.")?;
    let at = monitor.position();
    let _ = overlay.set_position(PhysicalPosition::new(at.x, at.y));
    let _ = overlay.set_size(*monitor.size());
    /* ⚠️ In this order: `set_ignore_cursor_events` rewrites the extended style,
     * and `harden` is what puts NOACTIVATE back. See win.rs. */
    let _ = overlay.set_ignore_cursor_events(true);
    crate::win::harden(overlay);
    let from = island.outer_position().map_err(|e| e.to_string())?;
    let scale = monitor.scale_factor();
    Ok(((from.x - at.x) as f64, (from.y - at.y) as f64, scale))
}

/// Where the notch is, from the island's CSS pixels to the overlay's.
fn over(window_px: (f64, f64), css: (f64, f64), scale: f64) -> (f64, f64) {
    ((window_px.0 + css.0 * scale) / scale, (window_px.1 + css.1 * scale) / scale)
}

/// Play one. `x`/`y` are where the notch is in the island's own CSS pixels.
#[tauri::command]
pub async fn gabi_fun(app: AppHandle, fun: String, count: u32, x: f64, y: f64, edge: String) -> Result<(), String> {
    if !FUNS.contains(&fun.as_str()) {
        return Err("Not one of hers.".into());
    }
    let overlay = ensure(&app)?;
    let (left, top, scale) = place(&app, &overlay)?;
    let (x, y) = over((left, top), (x, y), scale);
    let serial = SERIAL.fetch_add(1, Ordering::SeqCst) + 1;
    let play = Play { fun, count: count.clamp(1, 20), x, y, edge, serial };
    if READY.load(Ordering::SeqCst) {
        let _ = overlay.show();
        crate::win::harden(&overlay);
        let _ = app.emit_to(LABEL, "fun:play", play);
    } else {
        *PENDING.lock().unwrap() = Some(play);
    }
    let later = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(LIMIT).await;
        if SERIAL.load(Ordering::SeqCst) == serial {
            if let Some(window) = later.get_webview_window(LABEL) {
                let _ = window.hide();
            }
        }
    });
    Ok(())
}

/// The page has loaded: what it should play first, if anything.
#[tauri::command]
pub fn gabi_fun_ready(app: AppHandle) -> Option<Play> {
    READY.store(true, Ordering::SeqCst);
    let play = PENDING.lock().unwrap().take();
    if play.is_some() {
        if let Some(window) = app.get_webview_window(LABEL) {
            let _ = window.show();
            crate::win::harden(&window);
        }
    }
    play
}

/// The page has finished `serial`. ⚠️ Only the newest puts it away: a second
/// reaction that started while the first was ending is still in the air.
#[tauri::command]
pub fn gabi_fun_done(app: AppHandle, serial: u64) {
    if SERIAL.load(Ordering::SeqCst) == serial {
        if let Some(window) = app.get_webview_window(LABEL) {
            let _ = window.hide();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_notch_lands_where_it_is_on_the_monitor() {
        // At 150%: the island's window starts 300 physical px in, the notch is 200 CSS px across it.
        assert_eq!(over((300.0, 0.0), (200.0, 10.0), 1.5), (400.0, 10.0));
        assert_eq!(over((0.0, 0.0), (640.0, 20.0), 1.0), (640.0, 20.0));
    }
}
