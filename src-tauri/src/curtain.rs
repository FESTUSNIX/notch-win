//! The curtain: the screen dims when a locked site is in front anyway.
//!
//! Guardian stage 3 (28 Oct). Helm's site blocker is a browser extension, and
//! an extension is one click from being switched off — which is how he beat it.
//! So Helm tells codenotch what is locked right now (`helm.rs` reads
//! `/api/desktop/blocker` with the device key), and while a browser in FRONT
//! shows one of those sites this covers the monitor it is on with a calm dim
//! (`curtain.html`): the Guardian's line, what his hours have earned, and the ways
//! on — back to work, earned minutes to spend, five minutes for a price.
//!
//! Built the way ambient mode is (`ambient.rs`): its own borderless window, NOT
//! click-through, taking focus so Escape reaches it, made once and then only
//! hidden, and `OPEN` holding `win::harden` back from lifting the island over it.
//!
//! ⚠️ **A window title is all there is to go on.** codenotch cannot see a URL.
//! Helm sends each locked domain with the words its pages put in their titles
//! ("… - YouTube"), and a title matches only when one of its PARTS — split on
//! " - ", " | ", " / " and the like — is exactly that word. "YouTube is locked",
//! the extension's own page, has no such part, so a working extension and the
//! curtain never fight over the same tab. Whole domains only: paths stay the
//! extension's.
//!
//! ⚠️ **It must never trap him.** Escape always closes it, a plain way out shows
//! after a few seconds, the hide key takes it down too, and it lifts by itself the
//! moment anything else comes to the front (he went back to work), a call starts,
//! a meeting on his calendar is under way, the screen is being presented, the site
//! stops being locked (time spent or bought, the rule over), Helm's answer goes
//! stale (offline is not a reason to cover a screen), or the page never says it
//! drew itself (a broken webview must not be a black wall). After he closes it,
//! it stays down for `QUIET`.
//!
//! Quitting codenotch removes it, and that was the owner's call (27 Oct): the
//! curtain backs the extension up, it is not a lock.

use std::collections::HashMap;
use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, AtomicIsize, AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use windows::Win32::Foundation::{HWND, RECT};

pub const LABEL: &str = "curtain";

/// Whether the curtain is up. Read by `win::harden` and the hide key.
pub static OPEN: AtomicBool = AtomicBool::new(false);
static SERIAL: AtomicU64 = AtomicU64::new(0);
/// The curtain's own window, so the watch can tell it from "something else".
static CURTAIN: AtomicIsize = AtomicIsize::new(0);
static APP: OnceLock<AppHandle> = OnceLock::new();

/// How often the window in front is looked at. Cheap: a handle, a title and a
/// cached executable name.
const TICK: Duration = Duration::from_secs(1);
/// A locked site has to stay in front this long. Alt-Tabbing past one is not
/// watching it, and a curtain that flashes on the way past is a punishment.
const DWELL: Duration = Duration::from_secs(3);
/// Closed by him: this long before it may come back.
const QUIET: Duration = Duration::from_secs(90);
/// Helm's answer is read every 20 s; one older than this is not trusted to put a
/// curtain up or to keep one there.
const STALE: Duration = Duration::from_secs(150);
/// The page has to say it drew itself within this, or the window is put away.
const READY_WITHIN: Duration = Duration::from_secs(6);
/// The page's fade out, before the window is hidden — see `lift`.
const FADE: Duration = Duration::from_millis(340);

/// A locked domain as Helm sends it.
#[derive(Clone, Debug, Default, PartialEq, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Site {
    pub domain: String,
    pub name: String,
    /// The words its pages carry in their window titles.
    pub tokens: Vec<String>,
    /// Locked by earn rules alone, so earned or bought minutes open it.
    pub earn: bool,
}

/// What the page draws.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Showing {
    /// ⚠️ Counted, so a page that asks for the pending showing on load and ALSO
    /// hears the event does not play the same opening twice (ambient's rule).
    pub serial: u64,
    /// Helm's answer, as it came: the line, the earned time, the ways on.
    pub reading: serde_json::Value,
    /// The site in front.
    pub site: Site,
    /// The browser it is in, as people call it ("Brave").
    pub browser: String,
}

struct Reading {
    body: serde_json::Value,
    sites: Vec<Site>,
    at: Instant,
}

struct Up {
    /// The browser window under the curtain.
    hwnd: isize,
    since: Instant,
    ready: bool,
    /// Whether opening paused the browser's video, so time bought can play it on.
    paused: bool,
    showing: Showing,
}

struct Watch {
    reading: Option<Reading>,
    up: Option<Up>,
    /// A locked site in front, and since when: `DWELL` runs from here.
    seen: Option<(isize, String, Instant)>,
    quiet_until: Option<Instant>,
}

static WATCH: Mutex<Watch> = Mutex::new(Watch { reading: None, up: None, seen: None, quiet_until: None });

/// ⚠️ A panic elsewhere must not leave the watch locked for good: a poisoned
/// lock here would mean a curtain that can never be taken down.
fn watch() -> MutexGuard<'static, Watch> {
    WATCH.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Why it came down.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Lift {
    /// Something else came to the front.
    MovedOn,
    /// Presenting, a call, a meeting, ambient mode.
    Held,
    /// Helm's answer is too old to stand on.
    Stale,
    /// The page never said it drew itself.
    Broken,
    /// The window it covered went away.
    Gone,
    /// The site isn't locked any more (time spent or bought, the rule ended).
    Open,
    /// He closed it: back to work, Escape, the way out, the hide key.
    Closed,
}

impl Lift {
    /// Whether it may come straight back. Closing it is a decision and gets its
    /// quiet; a broken or stale one must not flap.
    fn quiet(self) -> bool {
        matches!(self, Lift::Closed | Lift::Stale | Lift::Broken)
    }
}

/* ── Helm's answer ─────────────────────────────────────────────────────── */

/// A reading from `/api/desktop/blocker`, or `None` (not connected, or a Helm
/// without the route). Called by `helm.rs` on each poll.
pub fn receive(body: Option<serde_json::Value>) {
    let fresh = {
        let mut watch = watch();
        watch.reading = body.map(|body| Reading { sites: sites_of(&body), body, at: Instant::now() });
        let reading = watch.reading.as_ref().map(|r| r.body.clone());
        match (watch.up.as_mut(), reading) {
            (Some(up), Some(reading)) => {
                up.showing.reading = reading;
                Some(up.showing.clone())
            }
            _ => None,
        }
    };
    // The page that is up keeps its numbers and its ways on true.
    if let (Some(showing), Some(app)) = (fresh, APP.get()) {
        let _ = app.emit_to(LABEL, "curtain:reading", &showing);
    }
}

fn sites_of(body: &serde_json::Value) -> Vec<Site> {
    serde_json::from_value::<Vec<Site>>(body["sites"].clone())
        .unwrap_or_default()
        .into_iter()
        .filter(|site| site.tokens.iter().any(|t| !t.trim().is_empty()))
        .collect()
}

/* ── Titles ────────────────────────────────────────────────────────────── */

/// What sites and browsers put between the parts of a title.
const SEPARATORS: [&str; 8] = [" - ", " – ", " — ", " | ", " / ", " · ", " • ", " : "];

/// A window title in its parts: "(3) Some video - YouTube - Brave" is
/// `["Some video", "YouTube", "Brave"]`.
///
/// ⚠️ Edge writes "Microsoft\u{200b} Edge" with a zero-width space, and sites put
/// an unread count in front — "(3) Home / X". Both are taken off, or the part
/// that names the site never equals its word.
pub fn title_parts(title: &str) -> Vec<String> {
    let mut text: String = title.chars().filter(|c| !matches!(c, '\u{200b}' | '\u{200c}' | '\u{200e}' | '\u{200f}' | '\u{feff}')).collect();
    for separator in SEPARATORS {
        text = text.replace(separator, "\u{1}");
    }
    text.split('\u{1}').map(|part| without_count(part.trim()).to_string()).filter(|part| !part.is_empty()).collect()
}

/// "(3) Home" → "Home".
fn without_count(part: &str) -> &str {
    if let Some(rest) = part.strip_prefix('(') {
        if let Some(close) = rest.find(')') {
            let inside = &rest[..close];
            if !inside.is_empty() && inside.chars().all(|c| c.is_ascii_digit() || c == '+') {
                return rest[close + 1..].trim_start();
            }
        }
    }
    part
}

/// Which locked site a browser's title shows: one whose word is a whole part of
/// it. ⚠️ A whole part, never a substring — "YouTube is locked" is the
/// extension doing its job, and "Why I quit X - Medium" is not X.
pub fn site_in(title: &str, sites: &[Site]) -> Option<usize> {
    let parts = title_parts(title);
    sites.iter().position(|site| {
        site.tokens.iter().map(|t| t.trim()).filter(|t| !t.is_empty()).any(|token| {
            parts.iter().any(|part| part.to_lowercase() == token.to_lowercase())
        })
    })
}

/// The browsers, by executable, as people call them. Anything else in front is
/// not a browser and is never covered.
pub fn browser_name(exe: &str) -> Option<&'static str> {
    let file = exe.rsplit(['\\', '/']).next().unwrap_or(exe).to_ascii_lowercase();
    let stem = file.strip_suffix(".exe").unwrap_or(&file);
    Some(match stem {
        "chrome" => "Chrome",
        "msedge" => "Edge",
        "brave" => "Brave",
        "firefox" => "Firefox",
        "opera" | "opera_gx" => "Opera",
        "vivaldi" => "Vivaldi",
        "arc" => "Arc",
        "zen" => "Zen",
        "librewolf" => "LibreWolf",
        "waterfox" => "Waterfox",
        "floorp" => "Floorp",
        "chromium" => "Chromium",
        "thorium" => "Thorium",
        _ => return None,
    })
}

/// A meeting under way on his calendar: a timed event he hasn't declined that
/// has started and not ended — Helm's own rule for holding a nudge. Helm's own
/// calendar is focus blocks, not meetings.
pub fn meeting_now(events: &[crate::calendar::Event], now: chrono::DateTime<chrono::Utc>) -> bool {
    events.iter().any(|event| {
        if event.all_day || event.response == "declined" || event.calendar.eq_ignore_ascii_case("helm") {
            return false;
        }
        match (chrono::DateTime::parse_from_rfc3339(&event.start), chrono::DateTime::parse_from_rfc3339(&event.end)) {
            (Ok(start), Ok(end)) => start.with_timezone(&chrono::Utc) <= now && now < end.with_timezone(&chrono::Utc),
            _ => false,
        }
    })
}

/* ── The decision ──────────────────────────────────────────────────────── */

/// One look at the machine.
struct Sense<'a> {
    /// The window in front, whatever it is.
    front: Option<isize>,
    /// Its title, when it is a browser.
    browser: Option<&'a str>,
    /// The curtain's own window.
    curtain: Option<isize>,
    /// The covered window's title now; `None` when it has gone.
    covered: Option<&'a str>,
    /// Presenting, in a call, in a meeting, ambient mode.
    held: bool,
}

#[derive(Debug, PartialEq)]
enum Step {
    Stay,
    /// The site at this index, in this window.
    Show(usize, isize),
    Lift(Lift),
}

fn step(watch: &mut Watch, sense: &Sense, now: Instant) -> Step {
    let fresh = watch.reading.as_ref().filter(|r| now.duration_since(r.at) <= STALE);
    if let Some(up) = &watch.up {
        if sense.held {
            return Step::Lift(Lift::Held);
        }
        let Some(reading) = fresh else { return Step::Lift(Lift::Stale) };
        if !up.ready && now.duration_since(up.since) > READY_WITHIN {
            return Step::Lift(Lift::Broken);
        }
        /* ⚠️ Nothing in front is NOT "moved on": the foreground is briefly
         * nobody's while it changes hands, and lifting on that would drop the
         * curtain the moment it took the focus. */
        if let Some(front) = sense.front {
            if Some(front) != sense.curtain && front != up.hwnd {
                return Step::Lift(Lift::MovedOn);
            }
        }
        return match sense.covered {
            None => Step::Lift(Lift::Gone),
            Some(title) if site_in(title, &reading.sites).is_none() => Step::Lift(Lift::Open),
            Some(_) => Step::Stay,
        };
    }
    let quiet = watch.quiet_until.is_some_and(|until| now < until);
    let found = match (fresh, sense.front, sense.browser) {
        (Some(reading), Some(front), Some(title)) if !sense.held && !quiet => {
            site_in(title, &reading.sites).map(|index| (index, front, reading.sites[index].domain.clone()))
        }
        _ => None,
    };
    let Some((index, front, domain)) = found else {
        watch.seen = None;
        return Step::Stay;
    };
    match &watch.seen {
        Some((hwnd, seen, since)) if *hwnd == front && *seen == domain => {
            if now.duration_since(*since) >= DWELL {
                Step::Show(index, front)
            } else {
                Step::Stay
            }
        }
        _ => {
            watch.seen = Some((front, domain, now));
            Step::Stay
        }
    }
}

/* ── The machine ───────────────────────────────────────────────────────── */

fn hwnd(raw: isize) -> HWND {
    HWND(raw as *mut c_void)
}

fn foreground() -> Option<(isize, u32)> {
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};
    unsafe {
        let window = GetForegroundWindow();
        if window.0.is_null() {
            return None;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(window, Some(&mut pid));
        Some((window.0 as isize, pid))
    }
}

/// The title of a window still there, or `None` once it has gone.
fn title_if_alive(raw: isize) -> Option<String> {
    use windows::Win32::UI::WindowsAndMessaging::IsWindow;
    unsafe { IsWindow(Some(hwnd(raw))).as_bool() }.then(|| crate::win::title_of(hwnd(raw)))
}

fn monitor_of(raw: isize) -> Option<RECT> {
    use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST};
    unsafe {
        let monitor = MonitorFromWindow(hwnd(raw), MONITOR_DEFAULTTONEAREST);
        let mut info = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
        GetMonitorInfoW(monitor, &mut info).as_bool().then_some(info.rcMonitor)
    }
}

/// Presenting, in a call, a meeting under way, or ambient mode up: never then.
///
/// ⚠️ The call is `call.rs`'s microphone reading, which only runs with in-call
/// mode on. With it off, the calendar is what says he's in a meeting.
fn held(app: &AppHandle) -> bool {
    crate::helm::presenting()
        || crate::ambient::OPEN.load(Ordering::SeqCst)
        || app.try_state::<crate::call::CallState>().is_some_and(|state| state.snapshot().active)
        || meeting_now(&crate::calendar::get_calendar(app.clone()).events, chrono::Utc::now())
}

/// Whether the player Windows reports is this browser's and playing.
fn browser_playing(app: &AppHandle, exe: &str) -> bool {
    let Some(state) = app.try_state::<crate::media::MediaState>() else { return false };
    let media = state.snapshot();
    media.active && media.playing && !exe.is_empty() && media.source.to_ascii_lowercase().contains(exe)
}

pub fn spawn(app: AppHandle) {
    let _ = APP.set(app.clone());
    crate::guard::spawn("curtain watch", move || {
        // Executable stems by process id: asked once per process, not every second.
        let mut exes: HashMap<u32, String> = HashMap::new();
        loop {
            std::thread::sleep(TICK);
            if exes.len() > 256 {
                exes.clear();
            }
            tick(&app, &mut exes);
        }
    });
}

fn tick(app: &AppHandle, exes: &mut HashMap<u32, String>) {
    let front = foreground();
    let exe = front
        .map(|(_, pid)| {
            exes.entry(pid)
                .or_insert_with(|| {
                    let path = crate::call::exe_of(pid);
                    let file = path.rsplit(['\\', '/']).next().unwrap_or("").to_ascii_lowercase();
                    file.strip_suffix(".exe").unwrap_or(&file).to_string()
                })
                .clone()
        })
        .unwrap_or_default();
    let browser = browser_name(&exe);
    let title = match (front, browser) {
        (Some((window, _)), Some(_)) => Some(crate::win::title_of(hwnd(window))),
        _ => None,
    };
    let covered_window = watch().up.as_ref().map(|up| up.hwnd);
    let covered = covered_window.and_then(title_if_alive);
    let curtain = CURTAIN.load(Ordering::SeqCst);
    let sense = Sense {
        front: front.map(|(window, _)| window),
        browser: title.as_deref(),
        curtain: (curtain != 0).then_some(curtain),
        covered: covered.as_deref(),
        held: held(app),
    };

    let decided = {
        let mut watch = watch();
        let now = Instant::now();
        match step(&mut watch, &sense, now) {
            Step::Show(index, window) => {
                let reading = watch.reading.as_ref().expect("a show needs a reading");
                let showing = Showing {
                    serial: SERIAL.fetch_add(1, Ordering::SeqCst) + 1,
                    reading: reading.body.clone(),
                    site: reading.sites[index].clone(),
                    browser: browser.unwrap_or("").to_string(),
                };
                let paused = browser_playing(app, &exe);
                watch.seen = None;
                watch.up = Some(Up { hwnd: window, since: now, ready: false, paused, showing: showing.clone() });
                Some(Ok((window, showing, paused)))
            }
            Step::Lift(why) => Some(Err(why)),
            Step::Stay => None,
        }
    };
    match decided {
        Some(Ok((window, showing, paused))) => {
            crate::log::note(&format!("curtain: over {} in {}", showing.site.domain, showing.browser));
            /* Calm means quiet too: a video playing on behind a dim screen is
             * the thing the curtain is about, still talking. Paused, never
             * stopped — five minutes bought plays it on. */
            if paused {
                tauri::async_runtime::spawn(crate::media::media_command("playpause".into()));
            }
            show(app, window, showing);
        }
        Some(Err(why)) => lift(app, why),
        None => {}
    }
}

/* ── The window ────────────────────────────────────────────────────────── */

fn ensure(app: &AppHandle) -> Result<WebviewWindow, String> {
    if let Some(found) = app.get_webview_window(LABEL) {
        return Ok(found);
    }
    WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("curtain.html".into()))
        .title("Codenotch — curtain")
        .decorations(false)
        /* ⚠️ Transparent, because the dim fades IN over what he was looking
         * at: an opaque window would be a black frame first. */
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .focused(true)
        .visible(false)
        .build()
        .map_err(|error| format!("Could not open the curtain: {error}"))
}

/// Over the monitor the browser is on, at the top of the topmost band, with
/// the keyboard — Escape has to reach it.
///
/// ⚠️ `set_focus` alone is `SetForegroundWindow`, which Windows refuses
/// silently to a process that doesn't own the foreground — and the browser
/// does. `force_foreground` is the way past it (`win.rs`).
fn show(app: &AppHandle, window: isize, showing: Showing) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let curtain = match ensure(&app) {
            Ok(curtain) => curtain,
            Err(message) => {
                crate::log::note(&format!("curtain: {message}"));
                let _ = watch().up.take();
                return;
            }
        };
        if let Some(handle) = crate::win::hwnd_of(&curtain) {
            CURTAIN.store(handle.0 as isize, Ordering::SeqCst);
        }
        if let Some(rect) = monitor_of(window) {
            let _ = curtain.set_position(PhysicalPosition::new(rect.left, rect.top));
            let _ = curtain.set_size(PhysicalSize::new((rect.right - rect.left).max(1) as u32, (rect.bottom - rect.top).max(1) as u32));
        }
        OPEN.store(true, Ordering::SeqCst);
        let _ = curtain.show();
        let _ = curtain.set_focus();
        crate::win::to_top(&curtain);
        if let Some(handle) = crate::win::hwnd_of(&curtain) {
            crate::win::force_foreground(handle);
        }
        let _ = app.emit_to(LABEL, "curtain:show", &showing);
    });
}

/// Take it down. The page fades first and the window is hidden after, so the
/// next opening doesn't show this one's last frame (AGENTS 763) — except when the
/// page is the one closing (it has faded already) or never drew (nothing to fade).
pub fn lift(app: &AppHandle, why: Lift) {
    let taken = {
        let mut watch = watch();
        let up = watch.up.take();
        if up.is_some() && why.quiet() {
            watch.quiet_until = Some(Instant::now() + QUIET);
        }
        watch.seen = None;
        up
    };
    let Some(up) = taken else { return };
    crate::log::note(&format!("curtain: lifted ({why:?})"));
    if why == Lift::Open && up.paused {
        tauri::async_runtime::spawn(crate::media::media_command("playpause".into()));
    }
    if why == Lift::Closed || !up.ready {
        hide(app);
        return;
    }
    let _ = app.emit_to(LABEL, "curtain:lift", up.showing.serial);
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(FADE);
        // Not if it went up again meanwhile.
        if watch().up.is_none() {
            hide(&app);
        }
    });
}

fn hide(app: &AppHandle) {
    OPEN.store(false, Ordering::SeqCst);
    let hand = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(window) = hand.get_webview_window(LABEL) {
            let _ = window.hide();
        }
    });
}

/* ── Commands ──────────────────────────────────────────────────────────── */

/// The showing the page hasn't drawn yet, for a page that loaded after the
/// event was sent — which is every first opening.
#[tauri::command]
pub fn curtain_pending() -> Option<Showing> {
    watch().up.as_ref().map(|up| up.showing.clone())
}

/// The page drew this showing: from now on it is the page's to fade.
#[tauri::command]
pub fn curtain_ready(serial: u64) {
    if let Some(up) = watch().up.as_mut().filter(|up| up.showing.serial == serial) {
        up.ready = true;
    }
}

/// The page closed it: back to work, Escape or the way out (`opened: false`,
/// then it stays down for `QUIET`), or time spent or bought (`opened: true`).
#[tauri::command]
pub fn curtain_close(app: AppHandle, window: WebviewWindow, serial: u64, opened: bool) -> Result<(), String> {
    if window.label() != LABEL {
        return Err("Only the curtain closes the curtain.".into());
    }
    let current = watch().up.as_ref().map(|up| up.showing.serial);
    if current == Some(serial) {
        lift(&app, if opened { Lift::Open } else { Lift::Closed });
    } else if current.is_none() {
        // Already lifted by the watch: only the window is left to put away.
        hide(&app);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sites() -> Vec<Site> {
        sites_of(&json!({ "sites": [
            { "domain": "youtube.com", "name": "YouTube", "tokens": ["YouTube"], "earn": true },
            { "domain": "x.com", "name": "X", "tokens": ["X", "Twitter"], "earn": true },
            { "domain": "reddit.com", "name": "Reddit", "tokens": ["Reddit"], "earn": false },
            { "domain": "nothing.example", "name": "Nothing", "tokens": [" "], "earn": true },
        ]}))
    }

    #[test]
    fn a_title_matches_by_a_whole_part() {
        let s = sites();
        assert_eq!(s.len(), 3, "a site without a word is dropped: it could never match");
        assert_eq!(site_in("Building a notch in Tauri - YouTube - Brave", &s), Some(0));
        assert_eq!(site_in("(3) Home / X - Google Chrome", &s), Some(1), "the unread count comes off");
        assert_eq!(site_in("Video — YouTube — Mozilla Firefox", &s), Some(0));
        assert_eq!(site_in("Video - YouTube - Personal - Microsoft\u{200b} Edge", &s), Some(0));
        assert_eq!(site_in("Reddit - Dive into anything", &s), Some(2));
        assert_eq!(site_in("YouTube", &s), Some(0), "a home page titled with the name alone");
        // ⚠️ The extension's own page, and words that only contain a token.
        assert_eq!(site_in("YouTube is locked - Brave", &s), None);
        assert_eq!(site_in("Why I quit X - Medium", &s), None);
        assert_eq!(site_in("YouTube Music - Brave", &s), None);
        assert_eq!(site_in("Untitled - Brave", &s), None);
    }

    #[test]
    fn a_title_falls_into_its_parts() {
        assert_eq!(title_parts("(12) Some video - YouTube - Brave"), vec!["Some video", "YouTube", "Brave"]);
        assert_eq!(title_parts("A | B / C : D"), vec!["A", "B", "C", "D"]);
        assert_eq!(title_parts("(beta) notes - Brave"), vec!["(beta) notes", "Brave"], "only a count comes off, not any brackets");
        assert!(title_parts("").is_empty());
    }

    #[test]
    fn only_browsers_are_covered() {
        assert_eq!(browser_name("C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe"), Some("Brave"));
        assert_eq!(browser_name("chrome.exe"), Some("Chrome"));
        assert_eq!(browser_name("MSEDGE.EXE"), Some("Edge"));
        assert_eq!(browser_name("firefox"), Some("Firefox"));
        assert_eq!(browser_name("C:\\Users\\m\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe"), None);
        assert_eq!(browser_name(""), None);
    }

    #[test]
    fn a_meeting_is_timed_under_way_and_not_declined() {
        let now = chrono::DateTime::parse_from_rfc3339("2026-10-28T13:10:00Z").unwrap().with_timezone(&chrono::Utc);
        let event = |start: &str, end: &str| crate::calendar::Event { start: start.into(), end: end.into(), calendar: "Work".into(), ..Default::default() };
        assert!(meeting_now(&[event("2026-10-28T14:00:00+01:00", "2026-10-28T14:30:00+01:00")], now));
        assert!(!meeting_now(&[event("2026-10-28T14:15:00+01:00", "2026-10-28T15:00:00+01:00")], now), "not started");
        assert!(!meeting_now(&[event("2026-10-28T13:00:00+01:00", "2026-10-28T14:10:00+01:00")], now), "ended on the minute");
        assert!(!meeting_now(&[crate::calendar::Event { response: "declined".into(), ..event("2026-10-28T14:00:00+01:00", "2026-10-28T14:30:00+01:00") }], now));
        assert!(!meeting_now(&[crate::calendar::Event { calendar: "Helm".into(), ..event("2026-10-28T14:00:00+01:00", "2026-10-28T14:30:00+01:00") }], now), "a focus block");
        assert!(!meeting_now(&[crate::calendar::Event { all_day: true, start: "2026-10-28".into(), end: "2026-10-29".into(), ..Default::default() }], now));
    }

    fn reading(at: Instant) -> Option<Reading> {
        let body = json!({ "sites": [{ "domain": "youtube.com", "name": "YouTube", "tokens": ["YouTube"], "earn": true }] });
        Some(Reading { sites: sites_of(&body), body, at })
    }

    fn fresh(t0: Instant) -> Watch {
        Watch { reading: reading(t0), up: None, seen: None, quiet_until: None }
    }

    const YT: &str = "Some video - YouTube - Brave";

    fn front(window: isize, title: Option<&str>) -> Sense<'_> {
        Sense { front: Some(window), browser: title, curtain: Some(99), covered: None, held: false }
    }

    #[test]
    fn it_comes_after_the_site_stays_in_front() {
        let t0 = Instant::now();
        let mut w = fresh(t0);
        assert_eq!(step(&mut w, &front(7, Some(YT)), t0), Step::Stay, "first seen");
        assert_eq!(step(&mut w, &front(7, Some(YT)), t0 + Duration::from_secs(2)), Step::Stay);
        assert_eq!(step(&mut w, &front(7, Some(YT)), t0 + DWELL), Step::Show(0, 7));
        // Alt-Tabbing past starts the wait over.
        let mut w = fresh(t0);
        step(&mut w, &front(7, Some(YT)), t0);
        assert_eq!(step(&mut w, &front(8, None), t0 + Duration::from_secs(1)), Step::Stay);
        assert_eq!(step(&mut w, &front(7, Some(YT)), t0 + DWELL), Step::Stay, "the wait begins again");
        // A browser on something else is nothing.
        let mut w = fresh(t0);
        step(&mut w, &front(7, Some("Docs - Brave")), t0);
        assert_eq!(step(&mut w, &front(7, Some("Docs - Brave")), t0 + DWELL * 2), Step::Stay);
    }

    #[test]
    fn never_on_a_stale_answer_while_held_or_in_its_quiet() {
        let t0 = Instant::now();
        let mut stale = Watch { reading: reading(t0), ..fresh(t0) };
        let later = t0 + STALE + Duration::from_secs(1);
        step(&mut stale, &front(7, Some(YT)), later);
        assert_eq!(step(&mut stale, &front(7, Some(YT)), later + DWELL), Step::Stay, "Helm's answer is too old");

        let mut held = fresh(t0);
        let sense = Sense { held: true, ..front(7, Some(YT)) };
        step(&mut held, &sense, t0);
        assert_eq!(step(&mut held, &sense, t0 + DWELL), Step::Stay, "a call, a meeting, presenting");

        let mut quiet = Watch { quiet_until: Some(t0 + QUIET), ..fresh(t0) };
        step(&mut quiet, &front(7, Some(YT)), t0);
        assert_eq!(step(&mut quiet, &front(7, Some(YT)), t0 + DWELL), Step::Stay, "closed a moment ago");
        let mut quiet = Watch { quiet_until: Some(t0), ..fresh(t0) };
        step(&mut quiet, &front(7, Some(YT)), t0 + Duration::from_secs(1));
        assert_eq!(step(&mut quiet, &front(7, Some(YT)), t0 + Duration::from_secs(1) + DWELL), Step::Show(0, 7), "and back after it");

        let mut none = Watch { reading: None, ..fresh(t0) };
        step(&mut none, &front(7, Some(YT)), t0);
        assert_eq!(step(&mut none, &front(7, Some(YT)), t0 + DWELL), Step::Stay, "no Helm, no curtain");
    }

    fn up(t0: Instant, ready: bool) -> Watch {
        let showing = Showing { serial: 1, reading: json!({}), site: Site::default(), browser: "Brave".into() };
        Watch { up: Some(Up { hwnd: 7, since: t0, ready, paused: false, showing }), ..fresh(t0) }
    }

    fn over(front: Option<isize>, covered: Option<&str>) -> Sense<'_> {
        Sense { front, browser: None, curtain: Some(99), covered, held: false }
    }

    #[test]
    fn up_it_stays_only_while_the_site_is_still_there() {
        let t0 = Instant::now();
        let t = t0 + Duration::from_secs(5);
        assert_eq!(step(&mut up(t0, true), &over(Some(99), Some(YT)), t), Step::Stay, "the curtain has the focus");
        assert_eq!(step(&mut up(t0, true), &over(Some(7), Some(YT)), t), Step::Stay, "the browser behind it took the focus back");
        assert_eq!(step(&mut up(t0, true), &over(None, Some(YT)), t), Step::Stay, "nobody in front, briefly");
        assert_eq!(step(&mut up(t0, true), &over(Some(42), Some(YT)), t), Step::Lift(Lift::MovedOn), "he went to another window");
        assert_eq!(step(&mut up(t0, true), &over(Some(99), Some("Docs - Brave")), t), Step::Lift(Lift::Open), "the tab is something else now");
        assert_eq!(step(&mut up(t0, true), &over(Some(99), None), t), Step::Lift(Lift::Gone));
        let held = Sense { held: true, ..over(Some(99), Some(YT)) };
        assert_eq!(step(&mut up(t0, true), &held, t), Step::Lift(Lift::Held), "a call started");
    }

    #[test]
    fn up_it_never_outlives_helm_or_a_page_that_did_not_draw() {
        let t0 = Instant::now();
        assert_eq!(step(&mut up(t0, false), &over(Some(99), Some(YT)), t0 + READY_WITHIN), Step::Stay, "still loading");
        assert_eq!(step(&mut up(t0, false), &over(Some(99), Some(YT)), t0 + READY_WITHIN + Duration::from_secs(1)), Step::Lift(Lift::Broken));
        assert_eq!(step(&mut up(t0, true), &over(Some(99), Some(YT)), t0 + STALE + Duration::from_secs(1)), Step::Lift(Lift::Stale));
        let mut gone = up(t0, true);
        gone.reading = None;
        assert_eq!(step(&mut gone, &over(Some(99), Some(YT)), t0 + Duration::from_secs(1)), Step::Lift(Lift::Stale), "disconnected");
    }

    #[test]
    fn only_a_decision_is_quiet_afterwards() {
        assert!(Lift::Closed.quiet() && Lift::Stale.quiet() && Lift::Broken.quiet());
        for lift in [Lift::MovedOn, Lift::Held, Lift::Gone, Lift::Open] {
            assert!(!lift.quiet(), "{lift:?}");
        }
    }
}
