mod apptime;
mod audio;
mod autostart;
mod calendar;
mod call;
mod codex;
mod config;
mod credentials;
mod drag;
mod lyrics;
mod mixer;
mod apps;
mod everything;
mod fixtures;
mod hover;
mod media;
mod dragout;
mod guard;
mod dropprobe;
mod log;
mod model;
mod money;
mod notes;
mod notices;
mod notify;
mod spotify;
mod ring;
mod runlog;
mod usage;
mod shelf;
mod thumbs;
mod snooze;
mod sound;
mod prefs;
mod stars;
mod workspaces;
mod transcript;
mod weather;
mod providers;
mod sessions;
mod system;
mod shortcuts;
mod task_window;
mod tasks;
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
fn set_interactive_rects(
    window: tauri::WebviewWindow,
    rects: Vec<CssRect>,
    state: tauri::State<InteractiveRects>,
) {
    if !matches!(window.label(), "notch" | "tasks") {
        return;
    }
    if let Ok(mut held) = state.0.lock() {
        held.insert(window.label().to_string(), rects);
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

/// The two tray items that only mean something on more than one display.
///
/// Held so the display watcher can enable them when a monitor is plugged in.
/// Computing `enabled` once at setup would leave them greyed out until the next
/// restart, with nothing on screen to say why — and a permanently grey menu
/// item reads as a broken feature rather than an inapplicable one.
#[derive(Default)]
pub struct DisplayItems(pub Mutex<Vec<tauri::menu::MenuItem<tauri::Wry>>>);

/// Match the two items to the number of attached displays.
pub fn sync_display_items(app: &AppHandle) {
    let several = win::screens().len() > 1;
    if let Ok(items) = app.state::<DisplayItems>().0.lock() {
        for item in items.iter() {
            let _ = item.set_enabled(several);
        }
    }
}

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
///
/// There is ONE settings window, and this is a second door to it.
///
/// ⚠️ It used to be a window of its own — `settings.html`, 360×470, edge and
/// autostart and a button that opened the *other* settings window. Two windows
/// of preferences is how a setting ends up in neither: it was in whichever one
/// the person who added it happened to have open.
///
/// ⚠️ Spawned rather than awaited. Building a WebView2 inside a synchronous
/// command deadlocks on Windows, which is the whole reason `open_task_editor`
/// is async in the first place.
#[tauri::command]
fn open_settings(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let _ = task_window::open_task_editor(app).await;
    });
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
    {
        let settings = app.state::<Settings>();
        let Ok(mut config) = settings.0.lock() else {
            return;
        };
        config.edge = edge;
        config::save(&config);
    }
    let _ = app.emit("notch:edge", edge);
    drag::place_now(&app, &window);
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

/// Every attached display, with the one each window is welded to.
#[tauri::command]
fn get_displays(app: AppHandle) -> serde_json::Value {
    serde_json::json!({
        "screens": win::screens(),
        "notch": drag::monitor_for(&app, "notch"),
        "tasks": drag::monitor_for(&app, "tasks"),
    })
}

/// Weld a window to a display. `None` gives back "wherever it already is",
/// which is what a single-monitor machine should keep.
#[tauri::command]
fn set_display(app: AppHandle, label: String, monitor: Option<String>) {
    if !matches!(label.as_str(), "notch" | "tasks") {
        return;
    }
    {
        let settings = app.state::<Settings>();
        let Ok(mut config) = settings.0.lock() else {
            return;
        };
        if label == "tasks" {
            config.task_monitor = monitor;
        } else {
            config.monitor = monitor;
        }
        config::save(&config);
    }
    if let Some(window) = app.get_webview_window(&label) {
        drag::place_now(&app, &window);
    }
    let _ = app.emit("notch:displays", get_displays(app.clone()));
}

/// Send a window to the next display along. What the tray item and the
/// shortcut both call.
#[tauri::command]
fn next_display(app: AppHandle, label: String) -> Option<String> {
    if !matches!(label.as_str(), "notch" | "tasks") {
        return None;
    }
    let moved = drag::next_display(&app, &label);
    if moved.is_some() {
        let _ = app.emit("notch:displays", get_displays(app.clone()));
    }
    moved
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

/// Debug channel for the web layer.
///
/// ⚠️ Used to be dev-builds-only, which made it useless: the release build has
/// no console (`windows_subsystem = "windows"`), so a `println!` there goes
/// nowhere — and a release build is the only kind anyone is running when
/// something is actually wrong.
#[tauri::command]
fn debug_note(note: String) {
    log::note(&note);
}

/// The window is always its *expanded* size — folding is drawn inside it, so
/// the OS window never resizes mid-animation, the same bargain the AppKit panel
/// makes. What does change it is the number of providers, and the room the
/// tooltip needs beside them; the web layer knows both, so it asks.
#[tauri::command]
fn set_notch_size(app: AppHandle, window: tauri::WebviewWindow, width: f64, height: f64) {
    if !matches!(window.label(), "notch" | "tasks")
        || !width.is_finite()
        || !height.is_finite()
        || width < 1.0
        || height < 1.0
        || width > 2000.0
        || height > 2000.0
    {
        return;
    }
    let current = window.outer_size().ok();
    let scale = window.scale_factor().unwrap_or(1.0);
    let height = if window.label() == "tasks" {
        win::work_area(&window)
            .map(|r| height.min((r.bottom - r.top) as f64 / scale))
            .unwrap_or(height)
    } else {
        height
    };
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
    drag::place_now(&app, &window);
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
                        config.claude_backoff_until_ms = Some(now_ms + (seconds * 1000.0) as i64);
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

    /* ⚠️ The application list is built ONCE, here, off the UI thread. It is a
     * shell call per shortcut — 152 of them and 1.7s on this machine — so the
     * palette has to find it already made rather than ask for it. */
    tauri::async_runtime::spawn_blocking(apps::warm);

    tauri::async_runtime::spawn(async move {
        let client = reqwest::Client::builder()
            .user_agent(concat!(
                "codenotch/",
                env!("CARGO_PKG_VERSION"),
                " (Windows)"
            ))
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
    let remembered: std::collections::HashMap<String, Snapshot> =
        config::load_readings().unwrap_or_default();

    tauri::Builder::default()
        /* ⚠️ One instance, and this is not housekeeping.
         *
         * Two copies put two always-on-top islands at the same coordinates,
         * each with its own 100ms hover poll rewriting its own window's
         * extended styles, and each with its own in-memory copy of the shelf,
         * the snooze list and the session watcher. Everything still *works*,
         * which is what makes it so confusing: a file dropped on the island
         * lands on whichever window is on top and is written to shelf.json,
         * while the island you are actually looking at belongs to the other
         * process and never hears about it. It reads exactly like drag and
         * drop being broken.
         *
         * A second launch hands its arguments to the first and exits; the
         * first brings its chrome back, in case it was hidden and the second
         * launch was someone trying to find it. */
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            shortcuts::set_chrome_hidden(app, false);
        }))
        .manage(InteractiveRects::default())
        .manage(DisplayItems::default())
        .manage(weather::Latest::default())
        .manage(lyrics::Cache::default())
        .manage(sessions::Sessions::default())
        .manage(snooze::Store::default())
        .manage(notes::Store::default())
        .manage(stars::Store::default())
        .manage(prefs::Store::default())
        .manage(workspaces::Store::default())
        .manage(shelf::Store::default())
        .manage(runlog::Store::default())
        .manage(money::Store::default())
        .manage(usage::Store::default())
        .manage(Latest::default())
        .manage(History(Mutex::new(remembered)))
        .manage(Wake::default())
        .manage(tasks::TaskState::new())
        .manage(sessions::Latest::default())
        .manage(media::MediaState::default())
        .manage(call::CallState::default())
        .manage(notices::NoticeState::default())
        .manage(calendar::CalendarState::default())
        .manage(shortcuts::ShortcutState_::default())
        .manage(apptime::AppTimeState::default())
        .manage(system::Watched::default())
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
            debug_note,
            tasks::get_tasks,
            tasks::refresh_tasks,
            tasks::connect_ticktick,
            tasks::disconnect_ticktick,
            tasks::complete_task,
            tasks::set_checklist_item,
            tasks::create_task,
            tasks::rename_task,
            task_window::open_task_editor,
            task_window::get_task_placement,
            task_window::set_task_input,
            task_window::set_task_placement,
            task_window::task_window_diagnostics,
            task_window::set_clock_format,
            runlog::get_runs,
            money::get_rates,
            usage::get_usage,
            shelf::get_shelf,
            shelf::shelf_add_paths,
            shelf::shelf_add_text,
            shelf::shelf_add_bytes,
            dragout::shelf_drag,
            shelf::shelf_remove,
            shelf::shelf_thumb,
            shelf::shelf_copy,
            shelf::copy_text,
            shelf::shelf_open,
            shelf::shelf_reveal,
            shelf::shelf_capture,
            log::open_log,
            hover::set_drop_zone,
            snooze::get_snoozed,
            prefs::get_prefs,
            prefs::set_prefs,
            notes::get_notes,
            notes::save_note,
            notes::remove_note,
            notes::pin_note,
            notes::dock_note,
            notes::drag_pin,
            notes::move_pin,
            notes::tint_note,
            stars::get_stars,
            stars::set_star,
            workspaces::get_workspaces,
            workspaces::save_workspace,
            workspaces::remove_workspace,
            workspaces::add_to_workspace,
            workspaces::open_workspace,
            snooze::snooze,
            snooze::unsnooze,
            sessions::get_sessions,
            sessions::focus_session,
            weather::get_weather,
            lyrics::get_lyrics,
            mixer::get_mixer,
            mixer::set_app_volume,
            mixer::set_app_mute,
            weather::set_weather_place,
            media::get_media,
            media::media_command,
            call::get_call,
            call::call_action,
            ring::ring_pick,
            ring::ring_aim,
            ring::ring_close,
            notices::get_notices,
            notices::notice_dismiss,
            notices::notice_open,
            notify::notify_now,
            sound::play_sound,
            media::media_seek,
            audio::get_audio_devices,
            audio::set_audio_device,
            apptime::get_app_time,
            system::get_system,
            system::set_volume,
            system::set_brightness,
            system::get_machine,
            system::lock_workstation,
            calendar::get_calendar,
            calendar::refresh_calendar,
            calendar::connect_google,
            calendar::disconnect_google,
            calendar::google_status,
            calendar::open_external,
            calendar::calendar_days,
            spotify::connect_spotify,
            spotify::disconnect_spotify,
            spotify::spotify_status,
            spotify::spotify_queue,
            spotify::spotify_redirect,
            spotify::spotify_search,
            spotify::spotify_enqueue,
            shortcuts::get_shortcuts,
            shortcuts::set_shortcuts,
            apps::list_apps,
            apps::launch_app,
            everything::everything_search,
            everything::everything_running,
            everything::found_open,
            everything::found_reveal,
            shortcuts::get_chrome_hidden,
            shortcuts::toggle_chrome,
            shortcuts::show_chrome,
            get_displays,
            set_display,
            next_display
        ])
        .setup(move |app| {
            let window = app
                .get_webview_window("notch")
                .expect("the notch window is declared in tauri.conf.json");

            // Order matters twice over. Position before the first paint, or the
            // window is briefly visible in the middle of the screen — and
            // harden *after* set_ignore_cursor_events, which rewrites the whole
            // extended-style word and drops anything set before it.
            drag::place_now(app.handle(), &window);
            let _ = window.set_ignore_cursor_events(true);
            window.show()?;
            win::harden(&window);

            // A click-through, always-on-top window that is not in the taskbar
            // or Alt-Tab has no other way to be reached.
            let refresh = MenuItem::with_id(app, "refresh", "Refresh now", true, None::<&str>)?;
            let settings_item =
                MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
            // ⚠️ No second "Tasks & TickTick…" item: it opened the same window
            // this one does. Two menu entries for one window is the tray's
            // version of the two-settings-windows problem above.
            let reset = MenuItem::with_id(app, "reset", "Reset position", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Codenotch", true, None::<&str>)?;
            let log_item = MenuItem::with_id(app, "log", "Open log", true, None::<&str>)?;
            // Enabled only where there is somewhere to move to: on one monitor
            // these do nothing, and a menu item that does nothing is worse than
            // one that is not there.
            let several = win::screens().len() > 1;
            let move_island = MenuItem::with_id(
                app,
                "next-display-tasks",
                "Move island to next display",
                several,
                None::<&str>,
            )?;
            let move_notch = MenuItem::with_id(
                app,
                "next-display-notch",
                "Move usage notch to next display",
                several,
                None::<&str>,
            )?;
            if let Ok(mut items) = app.state::<DisplayItems>().0.lock() {
                items.push(move_island.clone());
                items.push(move_notch.clone());
            }
            let menu = Menu::with_items(
                app,
                &[
                    &refresh,
                    &move_island,
                    &move_notch,
                    &settings_item,
                    &log_item,
                    &reset,
                    &quit,
                ],
            )?;
            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .tooltip("Codenotch")
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "refresh" => refresh_now(app.clone()),
                    "settings" => open_settings(app.clone()),
                    "next-display-tasks" => {
                        next_display(app.clone(), "tasks".into());
                    }
                    "next-display-notch" => {
                        next_display(app.clone(), "notch".into());
                    }
                    "log" => {
                        let _ = log::open_log();
                    }
                    "reset" => drag::reset_position(app.clone()),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            task_window::setup(app.handle())?;
            hover::spawn(app.handle().clone(), "notch");
            hover::spawn(app.handle().clone(), "tasks");
            tasks::spawn(app.handle().clone());
            media::spawn(app.handle().clone());
            call::spawn(app.handle().clone());
            notices::spawn(app.handle().clone());
            ring::spawn(app.handle().clone());
            calendar::spawn(app.handle().clone());
            apptime::spawn(app.handle().clone());
            system::spawn(app.handle().clone());
            // Last, so a stolen key combination cannot stop the rest of setup.
            if let Err(message) = shortcuts::setup(app.handle()) {
                eprintln!("global shortcuts: {message}");
            }
            guard::install_hook();
            log::note(&format!("--- codenotch {} starting ---", env!("CARGO_PKG_VERSION")));
            snooze::load(app.handle());
            prefs::load(app.handle());
            stars::load(app.handle());
            notes::load(app.handle());
            notes::restore(app.handle());
            workspaces::load(app.handle());
            shelf::load(app.handle());
            runlog::load(app.handle());
            money::load(app.handle());
            usage::load(app.handle());
            sessions::spawn(app.handle().clone());
            drag::watch_displays(app.handle().clone());
            weather::spawn(app.handle().clone());
            spawn_polling(app.handle().clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Codenotch");
}
