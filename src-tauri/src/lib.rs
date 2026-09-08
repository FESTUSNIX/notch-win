mod autostart;
mod config;
mod drag;
mod fixtures;
mod hover;
mod model;
mod providers;
mod sessions;
mod win;

use std::sync::Mutex;
use std::time::Duration;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager};

use drag::Settings;
use hover::{CssRect, InteractiveRects};
use model::{Snapshot, Status};

/// How often to ask, when nothing is wrong. The macOS app drops to 5 minutes
/// when no session is running; that needs the session monitor, which is a
/// later step, so this is the plain cadence for now.
const POLL_INTERVAL: Duration = Duration::from_secs(60);

/// The web layer measures its own chrome and reports it here every time the
/// layout changes. Nothing else decides what is clickable.
#[tauri::command]
fn set_interactive_rects(rects: Vec<CssRect>, state: tauri::State<InteractiveRects>) {
    if let Ok(mut held) = state.0.lock() {
        *held = rects;
    }
}

/// The most recent round of readings.
///
/// ⚠️ Emitting alone is not enough. The web layer registers its listener during
/// boot, which lands *after* the first poll answers — so a single emit is
/// missed and the notch sits on its placeholder until the next tick, a full
/// minute later. The page asks for this on boot; the event then keeps it live.
#[derive(Default)]
pub struct Latest(pub Mutex<Vec<Snapshot>>);

/// The last reading that actually came back, per provider, so a failed
/// round can carry it forward instead of blanking the ring.
/// Woken by `refresh_now`, so an explicit request does not wait out the
/// remainder of a sixty-second sleep.
#[derive(Default)]
pub struct Wake(pub tokio::sync::Notify);

#[derive(Default)]
pub struct History(pub Mutex<std::collections::HashMap<String, Snapshot>>);

#[tauri::command]
fn get_readings(state: tauri::State<Latest>) -> Vec<Snapshot> {
    state.0.lock().map(|held| held.clone()).unwrap_or_default()
}

/// Open the settings panel, creating it the first time it is asked for.
///
/// A second window rather than a surface inside the notch: the notch is a
/// click-through hole most of the time, it is only as tall as its own readings,
/// and anything typed into it would be typed into something that cannot take
/// focus — `WS_EX_NOACTIVATE` is on the notch for good reason and would have to
/// come off for a form.
#[tauri::command]
fn open_settings(app: AppHandle) {
    if let Some(window) = app.get_webview_window("settings") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        return;
    }
    let built = tauri::WebviewWindowBuilder::new(
        &app,
        "settings",
        tauri::WebviewUrl::App("settings.html".into()),
    )
    .title("Codenotch")
    .inner_size(360.0, 470.0)
    .resizable(false)
    .decorations(false)
    .transparent(false)
    .center()
    .build();
    if let Ok(window) = built {
        let _ = window.set_focus();
    }
}

#[tauri::command]
fn get_edge(app: AppHandle) -> win::Edge {
    drag::current(&app).0
}

/// Move the notch to another edge. Persisted, and applied at once — the web
/// layer turns the stack from the same value, so both halves stay in step.
#[tauri::command]
fn set_edge(app: AppHandle, edge: win::Edge) {
    let Some(window) = app.get_webview_window("notch") else {
        return;
    };
    let along = {
        let settings = app.state::<Settings>();
        let Ok(mut config) = settings.0.lock() else {
            return;
        };
        config.edge = edge;
        config::save(&config);
        config.along
    };
    let _ = app.emit("notch:edge", edge);
    win::place(&window, edge, along);
}

/// Ask every provider again, now.
///
/// Clears the persisted rate-limit deadline too: this is an explicit request
/// from the person sitting there, and refusing it because of a back-off the app
/// set itself would be the app arguing with its user.
#[tauri::command]
fn refresh_now(app: AppHandle) {
    if let Ok(mut config) = app.state::<Settings>().0.lock() {
        if config.claude_backoff_until_ms.take().is_some() {
            config::save(&config);
        }
    }
    app.state::<Wake>().0.notify_one();
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

/// Debug channel for the web layer. Dev builds only.
#[tauri::command]
fn debug_note(note: String) {
    if cfg!(debug_assertions) {
        println!("[notch] {note}");
    }
}

/// The window is always its *expanded* size — folding is drawn inside it, so
/// the OS window never resizes mid-animation, the same bargain the AppKit panel
/// makes. What does change it is the number of providers, and the room the
/// tooltip needs beside them; the web layer knows both, so it asks.
#[tauri::command]
fn set_notch_size(app: AppHandle, width: f64, height: f64) {
    let Some(window) = app.get_webview_window("notch") else {
        return;
    };
    let current = window.outer_size().ok();
    let scale = window.scale_factor().unwrap_or(1.0);
    let wanted = tauri::PhysicalSize::new(
        (width * scale).round() as u32,
        (height * scale).round() as u32,
    );
    if current == Some(wanted) {
        return;
    }
    let _ = window.set_size(wanted);
    // Re-pin: growing a window on a screen edge would otherwise push it off,
    // and the drag ratio has to be honoured on every resize, not just at boot.
    let (edge, along) = drag::current(&app);
    win::place(&window, edge, along);
}

/// Fold this round's reading into what is already known, and remember it.
fn keep(app: &AppHandle, snapshot: Snapshot) -> Snapshot {
    let history = app.state::<History>();
    let Ok(mut held) = history.0.lock() else {
        return snapshot;
    };
    let previous = held.get(&snapshot.id).cloned();
    let merged = snapshot.or_stale(previous.as_ref());
    if !merged.windows.is_empty() {
        held.insert(merged.id.clone(), merged.clone());
        // Cheap and rare — a couple of providers, once a minute — and it is
        // what lets a rate-limited launch open on a real figure.
        config::save_readings(&*held);
    }
    merged
}

/// One round of readings from every provider that is actually installed.
///
/// **A provider that is not installed simply does not get a cell.** Not a cell
/// reading "not signed in" — nothing at all. The notch is glanceable, and a row
/// of empty rings for tools this machine has never had is noise in the one
/// place there is no room for any.
async fn collect(
    app: &AppHandle,
    client: &reqwest::Client,
    rate_limits: &mut u32,
) -> (Vec<Snapshot>, Duration) {
    let mut snapshots = Vec::new();
    let mut wait = POLL_INTERVAL;
    let now_ms = chrono::Utc::now().timestamp_millis();

    if let Some(dir) = providers::claude::default_config_dir() {
        if providers::claude::credentials_path(&dir).exists() {
            // A penalty picked up where the last run left it, so relaunching
            // waits rather than spending an attempt on extending it.
            let held_until = app
                .state::<Settings>()
                .0
                .lock()
                .ok()
                .and_then(|c| c.claude_backoff_until_ms);

            if let Some(until) = held_until.filter(|until| *until > now_ms) {
                let remaining = (until - now_ms) as f64 / 1000.0;
                println!("[notch] claude backing off, {remaining:.0}s left");
                wait = wait.min(Duration::from_secs_f64(remaining.max(1.0)));

                // ⚠️ Still emit the cell. Dropping it while waiting makes the
                // ring vanish and come back every couple of minutes, which
                // reads as the app being broken rather than as the endpoint
                // being unavailable — and the last figure is still worth
                // showing, dimmed, with its age.
                snapshots.push(keep(
                    app,
                    providers::claude::pending(Status::RateLimited {
                        retry_after_secs: remaining,
                    }),
                ));
            } else {
                let snapshot = providers::claude::snapshot(client, &dir).await;

                // The back-off is the one piece of policy that lives out here:
                // a poll that keeps firing into a rate limit is how you stay
                // rate limited, and this endpoint answers `Retry-After: 0`, so
                // the wait has to come from the client.
                if let Status::RateLimited { retry_after_secs } = &snapshot.status {
                    *rate_limits += 1;
                    let seconds =
                        providers::claude::backoff_secs(*rate_limits, Some(*retry_after_secs));
                    println!("[notch] claude rate limited, next attempt in {seconds:.0}s");
                    wait = wait.max(Duration::from_secs_f64(seconds));
                    if let Ok(mut config) = app.state::<Settings>().0.lock() {
                        config.claude_backoff_until_ms =
                            Some(now_ms + (seconds * 1000.0) as i64);
                        config::save(&config);
                    }
                } else {
                    *rate_limits = 0;
                    if let Ok(mut config) = app.state::<Settings>().0.lock() {
                        if config.claude_backoff_until_ms.take().is_some() {
                            config::save(&config);
                        }
                    }
                }
                snapshots.push(keep(app, snapshot));
            }
        }
    }

    if let Some(home) = providers::codex::default_home() {
        if providers::codex::present(&home) {
            let snapshot = providers::codex::snapshot(client, &home).await;
            snapshots.push(keep(app, snapshot));
        }
    }

    (snapshots, wait)
}

fn spawn_polling(app: AppHandle) {
    if fixtures::enabled() {
        println!("[notch] CODENOTCH_DEMO=1 — showing the design frame's fixtures");
        // Cached as well as emitted, so a hot reload in dev picks them back up
        // from `get_readings` rather than waiting for an event that has already
        // been and gone.
        let snapshots = fixtures::snapshots();
        if let Ok(mut held) = app.state::<Latest>().0.lock() {
            *held = snapshots.clone();
        }
        let _ = app.emit("notch:readings", snapshots);
        return;
    }

    tauri::async_runtime::spawn(async move {
        let client = reqwest::Client::builder()
            .user_agent(concat!("codenotch/", env!("CARGO_PKG_VERSION"), " (Windows)"))
            .build()
            .unwrap_or_default();
        let mut rate_limits: u32 = 0;

        loop {
            let (snapshots, wait) = collect(&app, &client, &mut rate_limits).await;

            if cfg!(debug_assertions) {
                for snapshot in &snapshots {
                    println!(
                        "[notch] {}: {:?}, {} window(s), headline {:?}",
                        snapshot.id,
                        snapshot.status,
                        snapshot.windows.len(),
                        snapshot.headline_percent()
                    );
                }
            }

            if let Ok(mut held) = app.state::<Latest>().0.lock() {
                *held = snapshots.clone();
            }
            let _ = app.emit("notch:readings", snapshots);

            // Either the cadence elapses or somebody asks for it sooner.
            let wake = app.state::<Wake>();
            tokio::select! {
                _ = tokio::time::sleep(wait) => {}
                _ = wake.0.notified() => {}
            }
        }
    });
}

pub fn run() {
    let settings = config::load();
    let (edge, along) = (settings.edge, settings.along);
    let remembered: std::collections::HashMap<String, Snapshot> =
        config::load_readings().unwrap_or_default();

    tauri::Builder::default()
        .manage(InteractiveRects::default())
        .manage(Latest::default())
        .manage(History(Mutex::new(remembered)))
        .manage(Wake::default())
        .manage(sessions::Latest::default())
        .manage(Settings(Mutex::new(settings)))
        .invoke_handler(tauri::generate_handler![
            set_interactive_rects,
            set_notch_size,
            get_readings,
            sessions::get_activity,
            open_settings,
            autostart::get_autostart,
            autostart::set_autostart,
            refresh_now,
            get_edge,
            set_edge,
            quit_app,
            drag::drag_begin,
            drag::reset_position,
            debug_note
        ])
        .setup(move |app| {
            let window = app
                .get_webview_window("notch")
                .expect("the notch window is declared in tauri.conf.json");

            // Order matters twice over. Position before the first paint, or the
            // window is briefly visible in the middle of the screen — and
            // harden *after* set_ignore_cursor_events, which rewrites the whole
            // extended-style word and drops anything set before it.
            win::place(&window, edge, along);
            let _ = window.set_ignore_cursor_events(true);
            window.show()?;
            win::harden(&window);

            // A click-through, always-on-top window that is not in the taskbar
            // or Alt-Tab has no other way to be reached.
            let refresh = MenuItem::with_id(app, "refresh", "Refresh now", true, None::<&str>)?;
            let settings_item =
                MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
            let reset = MenuItem::with_id(app, "reset", "Reset position", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Codenotch", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&refresh, &settings_item, &reset, &quit])?;
            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .tooltip("Codenotch")
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "refresh" => refresh_now(app.clone()),
                    "settings" => open_settings(app.clone()),
                    "reset" => drag::reset_position(app.clone()),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            hover::spawn(app.handle().clone());
            sessions::spawn(app.handle().clone());
            spawn_polling(app.handle().clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Codenotch");
}
