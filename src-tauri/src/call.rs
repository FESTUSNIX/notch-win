//! In-call mode: what meeting you are in, and the two controls worth reaching.
//!
//! ⚠️ **The microphone is the signal, not the window.** Every other way of
//! knowing you are in a call is a guess about a title bar: Teams is called
//! "Microsoft Teams" whether or not anybody is talking, and a browser sitting
//! on a Meet lobby page is titled exactly like a browser in a Meet call. What
//! is not a guess is Core Audio — an app with an ACTIVE capture session is
//! recording you right now, which is the same fact Windows itself draws the
//! microphone glyph in the taskbar for. So the mic decides whether there is a
//! call, and the window only decides what it is called.
//!
//! ⚠️ **Detection walks UP the process tree**, because the process holding the
//! microphone is usually not the one with your meeting in it. New Teams runs
//! its call inside `msedgewebview2.exe`, and a Meet tab captures through
//! Chrome's audio service — both children of the app you would name. Matching
//! the capturing pid against a list of executables finds neither. Same trap
//! `win::raise_process` is built around, arrived at from the other end.
//!
//! ⚠️ **Controls are KEYSTROKES, and there is no other way.** None of these
//! apps exposes an automation surface for mute or hang up. `PostMessage` of a
//! synthetic key does not reach a Chromium or WebView2 window at all — which
//! is Teams, Meet and WhatsApp — so the only mechanism left is `SendInput`,
//! and `SendInput` goes to whatever owns the foreground. The call window is
//! therefore raised, sent the key, and the previous window put back; the
//! flicker is the honest cost of the only thing that works.
//!
//! ⚠️ Same threading rules as `media.rs` and `audio.rs`: a COM apartment per
//! thread, blocking calls, so the poll owns a plain OS thread and commands hop
//! onto their own.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use windows::core::Interface;
use windows::Win32::Foundation::HWND;
use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
use windows::Win32::Media::Audio::{
    eCapture, AudioSessionStateActive, IAudioSessionControl2, IAudioSessionManager2, IMMDevice,
    IMMDeviceEnumerator, MMDeviceEnumerator, DEVICE_STATE_ACTIVE,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP,
    VIRTUAL_KEY, VK_A, VK_CONTROL, VK_D, VK_E, VK_H, VK_K, VK_M, VK_MENU, VK_O, VK_Q, VK_S,
    VK_SHIFT, VK_V, VK_Y,
};

/// How often the microphone is asked who is holding it.
///
/// ⚠️ A second and a half, not a second: everything here is free until a call
/// starts, and the expensive half — the process snapshot and the window sweep —
/// only runs while one is live. What it costs is how long the pill takes to
/// notice you joined, and joining a call is not a race.
const POLL: Duration = Duration::from_millis(1500);

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Call {
    /// False when nothing on the machine is holding the microphone for a call.
    pub active: bool,
    /// Which app, as an id the front end can key off: `zoom`, `teams`, `meet`,
    /// `whatsapp`, `discord`, `slack`.
    pub app: String,
    /// What to call it on screen — "Zoom", "Microsoft Teams".
    pub app_name: String,
    /// The meeting's own name, or the app's when the window will not say.
    pub title: String,
    /// The app's icon as a `data:` URI, taken off its own executable.
    pub icon: String,
    /// Unix milliseconds, when this call was first seen. ⚠️ Carried across
    /// polls, or the elapsed clock restarts every 1.5 seconds.
    pub since: u64,
    /// Whether the microphone ENDPOINT is muted — see `set_mic`. The only mute
    /// anything here can read back; the app's own is invisible from outside.
    pub muted: bool,
    /// Which controls this app actually answers to: `mute`, `video`, `hand`,
    /// `share`, `leave`, `open`. ⚠️ Derived from the table below rather than
    /// assumed — a button that does nothing is worse than no button.
    pub can: Vec<String>,
    /// The process the call is in, so its window can be found again.
    pub pid: u32,
}

#[derive(Default)]
pub struct CallState(Mutex<Call>);

impl CallState {
    pub fn snapshot(&self) -> Call {
        self.0.lock().unwrap().clone()
    }
}

/* ── The apps ─────────────────────────────────────────────────────────────
 *
 * One row per app, and every control it offers is a key combination its own
 * documentation publishes. ⚠️ An EMPTY combination means the app has no
 * shortcut for that control — not that nobody has looked it up yet. Google
 * Meet genuinely cannot leave a call from the keyboard, and WhatsApp publishes
 * no in-call shortcuts at all, so neither is offered those buttons. Inventing
 * one would fire a keystroke into a meeting and hope.
 */
type Keys = &'static [VIRTUAL_KEY];

struct Known {
    id: &'static str,
    name: &'static str,
    /// Executable names, lowercase, of the app or of anything it runs a call
    /// inside.
    exe: &'static [&'static str],
    /// Words marking one of this app's windows as the CALL window rather than
    /// its inbox. Empty means any window of its will do.
    call_words: &'static [&'static str],
    /// ⚠️ When set, a window has to SAY it is a call before this counts as one
    /// at all. It is what separates a Meet call from a browser recording a
    /// voice message: the executable is the same one.
    by_window: bool,
    /// Text stripped off a window title to leave the meeting's own name.
    strip: &'static [&'static str],
    mute: Keys,
    video: Keys,
    hand: Keys,
    share: Keys,
    leave: Keys,
}

/// ⚠️ Any browser can be hosting a Meet call, so the row is keyed on all of
/// them and gated on the window instead.
const BROWSERS: &[&str] = &[
    "chrome.exe", "msedge.exe", "brave.exe", "vivaldi.exe", "opera.exe", "firefox.exe",
    "arc.exe", "zen.exe",
];

const KNOWN: &[Known] = &[
    Known {
        id: "zoom",
        name: "Zoom",
        exe: &["zoom.exe"],
        call_words: &["zoom meeting", "meeting"],
        by_window: false,
        strip: &["Zoom Meeting", "Zoom Workplace", "Zoom"],
        mute: &[VK_MENU, VK_A],
        video: &[VK_MENU, VK_V],
        hand: &[VK_MENU, VK_Y],
        share: &[VK_MENU, VK_S],
        /* ⚠️ Alt+Q raises Zoom's own "leave meeting?" prompt rather than
         * leaving outright, and that is precisely why it is the one sent:
         * hanging up is the single press here that cannot be taken back. */
        leave: &[VK_MENU, VK_Q],
    },
    Known {
        id: "teams",
        name: "Microsoft Teams",
        exe: &["ms-teams.exe", "teams.exe"],
        call_words: &["meeting", "call", "| microsoft teams"],
        by_window: false,
        strip: &["| Microsoft Teams", "Microsoft Teams", "| Teams"],
        mute: &[VK_CONTROL, VK_SHIFT, VK_M],
        video: &[VK_CONTROL, VK_SHIFT, VK_O],
        hand: &[VK_CONTROL, VK_SHIFT, VK_K],
        share: &[VK_CONTROL, VK_SHIFT, VK_E],
        leave: &[VK_CONTROL, VK_SHIFT, VK_H],
    },
    Known {
        id: "meet",
        name: "Google Meet",
        exe: BROWSERS,
        call_words: &["meet.google.com", "meet -", "meet \u{2013}", "meet \u{2014}", "meet |"],
        by_window: true,
        strip: &[
            "- Google Chrome", "\u{2014} Google Chrome", "- Brave", "- Microsoft Edge",
            "\u{2014} Mozilla Firefox", "- Vivaldi", "- Opera", "Meet -", "Meet \u{2013}",
            "Meet \u{2014}", "Google Meet",
        ],
        mute: &[VK_CONTROL, VK_D],
        video: &[VK_CONTROL, VK_E],
        hand: &[VK_CONTROL, VK_MENU, VK_H],
        // Meet's own shortcut list has nothing for either of these.
        share: &[],
        leave: &[],
    },
    Known {
        id: "whatsapp",
        name: "WhatsApp",
        exe: &["whatsapp.exe"],
        call_words: &["call", "po\u{142}\u{105}czenie"],
        by_window: false,
        strip: &["- WhatsApp", "| WhatsApp", "WhatsApp"],
        // Publishes no in-call shortcuts. The microphone is still ours to cut.
        mute: &[],
        video: &[],
        hand: &[],
        share: &[],
        leave: &[],
    },
    /* Neither was asked for; both come free with the table, and a voice call
     * in either is exactly the thing this is for. */
    Known {
        id: "discord",
        name: "Discord",
        exe: &["discord.exe", "discordptb.exe", "discordcanary.exe"],
        call_words: &[],
        by_window: false,
        strip: &["- Discord", "Discord"],
        mute: &[],
        video: &[],
        hand: &[],
        share: &[],
        leave: &[],
    },
    Known {
        id: "slack",
        name: "Slack",
        exe: &["slack.exe"],
        call_words: &["huddle", "call"],
        by_window: false,
        strip: &["- Slack", "Slack"],
        mute: &[],
        video: &[],
        hand: &[],
        share: &[],
        leave: &[],
    },
];

fn known_by_exe(exe: &str) -> Option<&'static Known> {
    let lower = exe.to_ascii_lowercase();
    KNOWN.iter().find(|known| known.exe.iter().any(|name| *name == lower))
}

fn known_by_id(id: &str) -> Option<&'static Known> {
    KNOWN.iter().find(|known| known.id == id)
}

fn keys_for(known: &Known, action: &str) -> Keys {
    match action {
        "mute" | "unmute" => known.mute,
        "video" => known.video,
        "hand" => known.hand,
        "share" => known.share,
        "leave" => known.leave,
        _ => &[],
    }
}

/// What this app can be asked to do. `mute` is always on the list: the
/// microphone endpoint is ours whatever the app supports.
fn controls(known: &Known, has_window: bool) -> Vec<String> {
    let mut out = vec!["mute".to_string()];
    for action in ["video", "hand", "share", "leave"] {
        if has_window && !keys_for(known, action).is_empty() {
            out.push(action.to_string());
        }
    }
    if has_window {
        out.push("open".to_string());
    }
    out
}

/// The meeting's own name, dug out of a window title.
///
/// ⚠️ Pure, and tested, because every one of these apps writes its title
/// differently and half of them change it mid-call. A title that reduces to
/// nothing is not an error — it is Zoom, which calls every meeting "Zoom
/// Meeting" — so the app's name stands in rather than an empty pill.
fn name_call(raw: &str, known: &Known) -> String {
    let mut text = raw.trim().to_string();
    /* A browser puts the unread count in front of the title and it changes
     * every time somebody types. Animating a call's name on that is a pill
     * that never holds still. */
    if text.starts_with('(') {
        if let Some(close) = text.find(')') {
            if !text[1..close].is_empty() && text[1..close].chars().all(|c| c.is_ascii_digit()) {
                text = text[close + 1..].trim().to_string();
            }
        }
    }
    for cut in known.strip {
        // Case-insensitively: "Microsoft teams" happens.
        while let Some(at) = text.to_lowercase().find(&cut.to_lowercase()) {
            text.replace_range(at..at + cut.len(), "");
            text = text.trim().to_string();
        }
    }
    // Whatever separator the removal left stranded at either end.
    let text = text.trim_matches(|c: char| {
        c.is_whitespace() || c == '-' || c == '\u{2013}' || c == '\u{2014}' || c == '|' || c == '\u{b7}'
    });
    if text.chars().count() < 2 {
        return known.name.to_string();
    }
    text.to_string()
}

/* ── Who is holding the microphone ────────────────────────────────────────── */

fn enter_apartment() {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
}

/// Every process with an ACTIVE capture session, and the endpoint it is on.
///
/// ⚠️ Every capture endpoint, not the default one. An app records from
/// whichever microphone it was told to, and a headset that is not the system
/// default is the normal case for somebody in a call — so asking only the
/// default device reports no call at all for the person most likely in one.
fn capturing() -> Vec<(u32, IMMDevice)> {
    sessions(true).into_iter().map(|(pid, device, _)| (pid, device)).collect()
}

/// Every capture session, with its state.
///
/// ⚠️ `every` exists for the probe at the bottom of this file, and it earns its
/// keep: with nothing recording, "no call" and "the enumeration is broken and
/// always returns nothing" look identical from outside, and the second is the
/// kind of failure that is discovered during a meeting. Asking for every
/// session regardless of state tells the two apart.
#[cfg(test)]
fn capture_devices() -> u32 {
    unsafe {
        CoCreateInstance::<_, IMMDeviceEnumerator>(&MMDeviceEnumerator, None, CLSCTX_ALL)
            .and_then(|enumerator| enumerator.EnumAudioEndpoints(eCapture, DEVICE_STATE_ACTIVE))
            .and_then(|devices| devices.GetCount())
            .unwrap_or(0)
    }
}

fn sessions(active_only: bool) -> Vec<(u32, IMMDevice, i32)> {
    let mut out = Vec::new();
    unsafe {
        let Ok(enumerator) =
            CoCreateInstance::<_, IMMDeviceEnumerator>(&MMDeviceEnumerator, None, CLSCTX_ALL)
        else {
            return out;
        };
        let Ok(devices) = enumerator.EnumAudioEndpoints(eCapture, DEVICE_STATE_ACTIVE) else {
            return out;
        };
        for index in 0..devices.GetCount().unwrap_or(0) {
            let Ok(device) = devices.Item(index) else { continue };
            let Ok(manager) = device.Activate::<IAudioSessionManager2>(CLSCTX_ALL, None) else {
                continue;
            };
            let Ok(sessions) = manager.GetSessionEnumerator() else { continue };
            for slot in 0..sessions.GetCount().unwrap_or(0) {
                let Ok(session) = sessions.GetSession(slot) else { continue };
                /* ⚠️ The STATE is the whole test. A session outlives the
                 * recording that created it — Teams keeps one from the moment
                 * it starts — so "this app has a capture session" is true all
                 * day and means nothing. Active means right now. */
                let state = session.GetState().map(|state| state.0).unwrap_or(-1);
                if active_only && state != AudioSessionStateActive.0 {
                    continue;
                }
                let Ok(detail) = session.cast::<IAudioSessionControl2>() else { continue };
                let Ok(pid) = detail.GetProcessId() else { continue };
                if pid != 0 {
                    out.push((pid, device.clone(), state));
                }
            }
        }
    }
    out
}

/// The full path of a process's executable, or empty if it will not say.
fn exe_of(pid: u32) -> String {
    use windows::core::PWSTR;
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    unsafe {
        /* ⚠️ LIMITED information, not `PROCESS_QUERY_INFORMATION`. The wider
         * right is refused for anything running at a higher integrity level,
         * and the narrower one is all a path needs. */
        let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
            return String::new();
        };
        let mut buffer = [0u16; 520];
        let mut len = buffer.len() as u32;
        let ok =
            QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, PWSTR(buffer.as_mut_ptr()), &mut len)
                .is_ok();
        let _ = CloseHandle(handle);
        if !ok {
            return String::new();
        }
        String::from_utf16_lossy(&buffer[..len as usize])
    }
}

fn file_name(path: &str) -> String {
    path.rsplit(['\\', '/']).next().unwrap_or("").to_ascii_lowercase()
}

/// The app's own icon, remembered by path — it is the same picture every 1.5
/// seconds and extracting it is a shell call.
fn icon_of(path: &str) -> String {
    static HELD: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    let cache = HELD.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(found) = cache.lock().ok().and_then(|held| held.get(path).cloned()) {
        return found;
    }
    let made = crate::apps::icon_of(path).unwrap_or_default();
    if let Ok(mut held) = cache.lock() {
        held.insert(path.to_string(), made.clone());
    }
    made
}

/// The app a capturing process belongs to, walking up the tree until one is
/// recognised. See the module note: the pid holding the microphone is usually
/// a child of the app you would name.
fn app_above(pid: u32, tree: &HashMap<u32, u32>) -> Option<(&'static Known, u32, String)> {
    let mut candidate = pid;
    for _ in 0..8 {
        let path = exe_of(candidate);
        if !path.is_empty() {
            if let Some(known) = known_by_exe(&file_name(&path)) {
                return Some((known, candidate, path));
            }
        }
        match tree.get(&candidate) {
            Some(parent) if *parent != 0 && *parent != candidate => candidate = *parent,
            _ => return None,
        }
    }
    None
}

/// The app's call window, preferred over its inbox, and what it is titled.
fn window_of(known: &Known, pid: u32, windows: &[(HWND, u32)]) -> Option<(HWND, String)> {
    let mut fallback = None;
    for (window, owner) in windows {
        if *owner != pid {
            continue;
        }
        let title = crate::win::title_of(*window);
        if title.is_empty() {
            continue;
        }
        let lower = title.to_lowercase();
        if known.call_words.iter().any(|word| lower.contains(word)) {
            return Some((*window, title));
        }
        if fallback.is_none() {
            fallback = Some((*window, title));
        }
    }
    fallback
}

/// Is the microphone this call is on muted?
fn mic_muted(device: &IMMDevice) -> bool {
    unsafe {
        device
            .Activate::<IAudioEndpointVolume>(CLSCTX_ALL, None)
            .and_then(|volume| volume.GetMute())
            .map(|muted| muted.as_bool())
            .unwrap_or(false)
    }
}

/// Cut or restore the microphone this call is recording through.
///
/// ⚠️ THE endpoint, not the default one — the same argument as `capturing`.
/// Muting the system default while the call records from a headset is a mute
/// button that silences nothing, and it looks exactly like it worked.
fn set_mic(device: &IMMDevice, muted: bool) -> Result<(), String> {
    unsafe {
        let volume = device
            .Activate::<IAudioEndpointVolume>(CLSCTX_ALL, None)
            .map_err(|_| "Windows refused the microphone control.".to_string())?;
        volume
            .SetMute(muted, std::ptr::null())
            .map_err(|_| "Windows refused the mute.".to_string())
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_millis() as u64)
        .unwrap_or(0)
}

/// What is happening right now, given what was happening last time.
fn look(previous: &Call) -> Call {
    let holders = capturing();
    if holders.is_empty() {
        return Call::default();
    }
    let tree = crate::win::parents();
    let windows = crate::win::visible_windows();

    for (pid, device) in holders {
        let Some((known, app_pid, path)) = app_above(pid, &tree) else { continue };
        let found = window_of(known, app_pid, &windows);
        let title = found.as_ref().map(|(_, title)| title.clone()).unwrap_or_default();
        let says_call = known.call_words.iter().any(|word| title.to_lowercase().contains(word));
        let carried = previous.active && previous.app == known.id && previous.pid == app_pid;
        /* ⚠️ A browser has to SAY it is in a call before it counts — and only
         * the first time. A window's title is its ACTIVE TAB's title, so a
         * Meet call still running drops its own evidence the moment you look
         * at another tab; the microphone is what says the call is up, and the
         * name it had is carried forward. Without this every Meet call ends on
         * screen the first time you check your email. */
        if known.by_window && !carried && !says_call {
            continue;
        }
        let named = if carried && !says_call && !previous.title.is_empty() {
            previous.title.clone()
        } else {
            name_call(&title, known)
        };
        return Call {
            active: true,
            app: known.id.to_string(),
            app_name: known.name.to_string(),
            title: named,
            icon: icon_of(&path),
            since: if carried { previous.since } else { now_ms() },
            muted: mic_muted(&device),
            can: controls(known, found.is_some()),
            pid: app_pid,
        };
    }
    Call::default()
}

/* ── Pressing a button in someone else's app ──────────────────────────────── */

/// Send one key combination to a window, and put the foreground back.
///
/// ⚠️ Modifiers down in order, the key, then everything up in REVERSE. Released
/// in the same order they were pressed, the modifier goes first and the app
/// sees a bare `m` — which in Teams is not mute, it is a letter typed into the
/// meeting chat.
fn send_keys(window: HWND, keys: Keys) -> Result<(), String> {
    use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
    if keys.is_empty() {
        return Err("This app has no shortcut for that.".into());
    }
    unsafe {
        let came_from = GetForegroundWindow();
        if !crate::win::force_foreground(window) {
            return Err("Windows would not bring the call to the front.".into());
        }
        let mut input = Vec::with_capacity(keys.len() * 2);
        for key in keys.iter() {
            input.push(key_event(*key, false));
        }
        for key in keys.iter().rev() {
            input.push(key_event(*key, true));
        }
        let sent = SendInput(&input, std::mem::size_of::<INPUT>() as i32);
        /* ⚠️ Put it back even when the send failed. Leaving the call window in
         * front is the one outcome nobody asked for: the point of pressing
         * mute from the island is not having to leave what you were doing. */
        if !came_from.is_invalid() && came_from != window {
            let _ = crate::win::force_foreground(came_from);
        }
        if sent as usize != input.len() {
            return Err("Windows blocked the keystroke.".into());
        }
    }
    Ok(())
}

fn key_event(key: VIRTUAL_KEY, up: bool) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: key,
                wScan: 0,
                dwFlags: if up { KEYEVENTF_KEYUP } else { KEYBD_EVENT_FLAGS(0) },
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

/* ── The loop and the commands ────────────────────────────────────────────── */

pub fn spawn(app: AppHandle) {
    crate::guard::spawn("call watch", move || {
        enter_apartment();
        let mut last = Call::default();
        loop {
            let watching = crate::prefs::current(&app).call_mode;
            let next = if watching { look(&last) } else { Call::default() };
            if next != last {
                last = next.clone();
                if let Some(state) = app.try_state::<CallState>() {
                    *state.0.lock().unwrap() = next.clone();
                }
                let _ = app.emit_to("tasks", "call:changed", &next);
            }
            std::thread::sleep(POLL);
        }
    });
}

#[tauri::command]
pub fn get_call(app: AppHandle) -> Call {
    app.state::<CallState>().snapshot()
}

/// Do something to the call that is happening.
///
/// ⚠️ **Mute cuts the microphone AND sends the app's own shortcut**, and the
/// pairing is the safety argument. The app's mute is what the other people in
/// the meeting can SEE; the endpoint's is the one this app can read back, and
/// the one that still holds when a keystroke does not land. Sending only the
/// shortcut means a failure you can neither see nor hear — you believe you are
/// muted and you are not. Cutting the endpoint as well makes every failure
/// silent in the safe direction.
#[tauri::command]
pub async fn call_action(app: AppHandle, action: String) -> Result<Call, String> {
    let current = app.state::<CallState>().snapshot();
    if !current.active {
        return Err("There is no call to do that to.".into());
    }
    // `unmute` is the same control as `mute`, so it is spelled differently and
    // offered under one name.
    let offered = if action == "unmute" { "mute" } else { action.as_str() };
    if !current.can.iter().any(|one| one == offered) {
        return Err(format!("{} does not offer that.", current.app_name));
    }
    let also_mic = crate::prefs::current(&app).call_mute_mic;
    let (send, receive) = tokio::sync::oneshot::channel();
    let asked = action.clone();
    std::thread::spawn(move || {
        enter_apartment();
        let outcome = act(&current, &asked, also_mic);
        // Read back rather than assumed, so the pill moves at the press rather
        // than at the next poll a second and a half later.
        let _ = send.send(outcome.map(|held| look(&held)));
    });
    let fresh = receive.await.unwrap_or_else(|_| Err("The call thread stopped.".into()))?;
    if let Some(state) = app.try_state::<CallState>() {
        *state.0.lock().unwrap() = fresh.clone();
    }
    let _ = app.emit_to("tasks", "call:changed", &fresh);
    Ok(fresh)
}

fn act(current: &Call, action: &str, also_mic: bool) -> Result<Call, String> {
    let Some(known) = known_by_id(&current.app) else {
        return Err("That app is not one this knows how to drive.".into());
    };
    let window = window_now(known, current.pid);

    if action == "mute" || action == "unmute" {
        let want = action == "mute";
        let mut cut = false;
        if also_mic {
            let device = capturing()
                .into_iter()
                .find(|(pid, _)| *pid == current.pid || from_same_app(*pid, known))
                .map(|(_, device)| device);
            let Some(device) = device else {
                return Err("The microphone is no longer in use.".into());
            };
            set_mic(&device, want)?;
            cut = true;
        }
        /* The app's own mute as well, so the meeting sees the icon. ⚠️ It can
         * legitimately fail — a window that has gone, an app with no shortcut
         * — and that is NOT an error once the endpoint is cut: you are silent
         * either way, which is what the button promised. */
        match window {
            Some(window) if !keys_for(known, action).is_empty() => {
                let result = send_keys(window, keys_for(known, action));
                if !cut {
                    result?;
                }
            }
            _ if !cut => return Err(format!("{} has no mute this can press.", known.name)),
            _ => {}
        }
        return Ok(current.clone());
    }

    let Some(window) = window else {
        return Err("The call's window has gone.".into());
    };
    if action == "open" {
        return if crate::win::force_foreground(window) {
            Ok(current.clone())
        } else {
            Err("Windows would not bring the call to the front.".into())
        };
    }
    /* ⚠️ The guard that stops Ctrl+D bookmarking your browser. Meet's mute is
     * an ordinary browser shortcut and means mute ONLY while the Meet tab is
     * the one in front; sent at a window that has moved to another tab it is
     * "add bookmark", and at a different app entirely it is anything at all.
     * So the window is asked again what it is, and refused if it has moved. */
    if known.by_window {
        let title = crate::win::title_of(window).to_lowercase();
        if !known.call_words.iter().any(|word| title.contains(word)) {
            return Err(format!("Bring the {} tab forward first — the keys only work there.", known.name));
        }
    }
    send_keys(window, keys_for(known, action))?;
    Ok(current.clone())
}

fn from_same_app(pid: u32, known: &Known) -> bool {
    known_by_exe(&file_name(&exe_of(pid))).map(|found| found.id) == Some(known.id)
}

fn window_now(known: &Known, pid: u32) -> Option<HWND> {
    window_of(known, pid, &crate::win::visible_windows()).map(|(window, _)| window)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn app(id: &str) -> &'static Known {
        known_by_id(id).expect("known app")
    }

    /// Every app writes its title differently, and half of them change it
    /// mid-call. What comes out has to be the MEETING's name.
    #[test]
    fn a_window_title_reduces_to_the_meeting() {
        assert_eq!(name_call("Design Sync | Microsoft Teams", app("teams")), "Design Sync");
        assert_eq!(name_call("(3) Design Sync | Microsoft Teams", app("teams")), "Design Sync");
        assert_eq!(name_call("Meet \u{2013} Design Sync - Google Chrome", app("meet")), "Design Sync");
        assert_eq!(name_call("(1) Meet - abc-defg-hij - Brave", app("meet")), "abc-defg-hij");
        assert_eq!(name_call("Standup - WhatsApp", app("whatsapp")), "Standup");
    }

    /// ⚠️ A title that reduces to nothing is the NORMAL case for Zoom — every
    /// meeting there is called "Zoom Meeting" — so the app's own name has to
    /// stand in rather than an empty pill saying nothing at all.
    #[test]
    fn a_title_that_says_nothing_falls_back_to_the_app() {
        assert_eq!(name_call("Zoom Meeting", app("zoom")), "Zoom");
        assert_eq!(name_call("", app("zoom")), "Zoom");
        assert_eq!(name_call("Microsoft Teams", app("teams")), "Microsoft Teams");
        assert_eq!(name_call("  |  ", app("teams")), "Microsoft Teams");
    }

    /// ⚠️ The controls a call offers are the ones the APP really answers to.
    /// Meet cannot hang up from the keyboard and WhatsApp publishes no in-call
    /// shortcuts at all; offering either would be a button that lies.
    #[test]
    fn only_the_controls_an_app_really_has_are_offered() {
        let zoom = controls(app("zoom"), true);
        for wanted in ["mute", "video", "hand", "share", "leave", "open"] {
            assert!(zoom.contains(&wanted.to_string()), "zoom is missing {wanted}");
        }
        let meet = controls(app("meet"), true);
        assert!(meet.contains(&"video".to_string()));
        assert!(!meet.contains(&"leave".to_string()), "Meet cannot hang up from the keyboard");
        assert!(!meet.contains(&"share".to_string()));

        let whats = controls(app("whatsapp"), true);
        assert_eq!(whats, vec!["mute".to_string(), "open".to_string()]);

        /* ⚠️ With no window there is nothing to send a keystroke TO, so the
         * microphone is all that is left — and it is still ours. */
        assert_eq!(controls(app("zoom"), false), vec!["mute".to_string()]);
    }

    /// The executables that stand in for an app, including the ones it runs a
    /// call inside.
    #[test]
    fn an_app_is_found_by_any_of_its_executables() {
        assert_eq!(known_by_exe("ms-teams.exe").map(|k| k.id), Some("teams"));
        assert_eq!(known_by_exe("MS-Teams.EXE").map(|k| k.id), Some("teams"));
        assert_eq!(known_by_exe("chrome.exe").map(|k| k.id), Some("meet"));
        assert_eq!(known_by_exe("notepad.exe").map(|k| k.id), None);
        assert_eq!(file_name("C:\\Program Files\\Zoom\\bin\\Zoom.exe"), "zoom.exe");
        // ⚠️ The browser row is gated on the window; the desktop apps are not.
        assert!(app("meet").by_window);
        assert!(!app("zoom").by_window);
    }

    /// ⚠️ The positive path, proved without a meeting.
    ///
    /// Everything else here can be reasoned about; "does Core Audio actually
    /// report an ACTIVE capture session" cannot, and it is what the whole
    /// feature stands on. So this test opens a capture stream of its own and
    /// checks that `sessions()` sees it — with the microphone's own bytes
    /// never read, never stored and never leaving the function.
    ///
    /// `cargo test --lib holds_the_microphone -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn a_capture_stream_shows_up_as_an_active_session() {
        use windows::Win32::Media::Audio::{
            eCommunications, IAudioClient, AUDCLNT_SHAREMODE_SHARED,
        };
        enter_apartment();
        let me = std::process::id();
        assert!(
            !sessions(true).iter().any(|(pid, _, _)| *pid == me),
            "this process is already recording, which makes the test meaningless"
        );

        unsafe {
            let enumerator: IMMDeviceEnumerator =
                CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).expect("enumerator");
            let device = enumerator
                .GetDefaultAudioEndpoint(eCapture, eCommunications)
                .expect("a microphone");
            let client: IAudioClient = device.Activate(CLSCTX_ALL, None).expect("audio client");
            let format = client.GetMixFormat().expect("mix format");
            client
                .Initialize(AUDCLNT_SHAREMODE_SHARED, Default::default(), 10_000_000, 0, format, None)
                .expect("initialise");
            client.Start().expect("start");

            let mine: Vec<_> = sessions(true).into_iter().filter(|(pid, _, _)| *pid == me).collect();
            let _ = client.Stop();
            println!("{} active session(s) for this process", mine.len());
            assert!(!mine.is_empty(), "a running capture stream was not reported as active");
            for (_, _, state) in &mine {
                assert_eq!(*state, AudioSessionStateActive.0, "state should be Active");
            }
        }

        /* And it is not reported as a CALL: this test's process is not one of
         * the apps in the table, which is the other half of the rule. */
        assert!(!look(&Call::default()).active);
    }

    /// Not a unit test — a probe against whatever this machine is doing.
    /// `cargo test --lib call -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn reads_the_live_call() {
        enter_apartment();
        let devices = capture_devices();
        println!("{devices} capture endpoint(s)");
        let all = sessions(false);
        println!("{} capture session(s) on this machine", all.len());
        for (pid, _, state) in &all {
            // 0 inactive, 1 active, 2 expired — see AudioSessionState.
            println!("  state={state} pid={pid} exe={}", exe_of(*pid));
        }
        /* ⚠️ The enumeration itself has to come back with SOMETHING, or a
         * machine with nothing recording and a machine where this is broken
         * report the same thing — and the second is found out in a meeting. */
        /* ⚠️ The ENDPOINTS are what must exist. Sessions are created when an app
         * opens a stream and do not outlive a reboot, so zero of them is a
         * perfectly ordinary machine that has not used its microphone today —
         * but zero endpoints means nothing here can ever fire, and that is the
         * failure worth telling apart from "no call". */
        assert!(devices > 0, "no capture endpoints at all: is the enumeration working?");

        /* The other half of the pipeline, which a quiet microphone cannot
         * exercise: process -> executable -> app -> window -> name. Whatever
         * of the six is running right now goes through the real functions. */
        let tree = crate::win::parents();
        let windows = crate::win::visible_windows();
        let mut seen = std::collections::BTreeSet::new();
        for (_, pid) in &windows {
            let Some((known, app_pid, path)) = app_above(*pid, &tree) else { continue };
            if !seen.insert(known.id) {
                continue;
            }
            let found = window_of(known, app_pid, &windows);
            println!(
                "{} <- {}
   window: {:?}
   named:  {:?}
   can:    {:?}",
                known.name,
                file_name(&path),
                found.as_ref().map(|(_, title)| title.clone()),
                name_call(&found.as_ref().map(|(_, t)| t.clone()).unwrap_or_default(), known),
                controls(known, found.is_some()),
            );
        }
        if seen.is_empty() {
            println!("(none of the six call apps is running)");
        }
        println!("{:#?}", look(&Call::default()));
    }
}
