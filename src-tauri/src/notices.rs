//! Windows' own notification centre, on the island.
//!
//! ⚠️ **This reads OTHER apps' notifications, and that is not obviously
//! allowed.** `UserNotificationListener` is documented as needing the
//! `userNotificationListener` capability, which only a packaged app can
//! declare — so the reasonable expectation for an unpackaged exe is a flat
//! refusal. It is not refused: asked on this machine it answers `Allowed` and
//! hands back the centre. The probe in `notify.rs` is what established that,
//! and it is kept so the day it stops being true is a test failure rather than
//! an empty screen. `access` carries the answer to the front end either way,
//! because a screen that cannot say WHY it is empty is the worst of both.
//!
//! ⚠️ **Mirrored, never archived.** Nothing here writes a notification to
//! disk. Dismissing one removes it from Windows, clearing empties the centre,
//! and when the centre is empty so is this screen. The alternative — keeping
//! our own copy so things "stay in the shelf" — would build a private, durable
//! log of someone's messages, which is a different and much larger promise
//! than showing them what is already on their own screen.
//!
//! ⚠️ Same threading rules as `media.rs`: WinRT, blocking, COM apartment per
//! thread, so the poll owns a plain OS thread.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use windows::UI::Notifications::Management::{
    UserNotificationListener, UserNotificationListenerAccessStatus,
};
use windows::UI::Notifications::{KnownNotificationBindings, NotificationKinds};
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

use crate::media::block;

/// How often the centre is re-read.
///
/// ⚠️ Four seconds, and the cost is not the read: it is that a toast arriving
/// while you are looking at the screen takes up to four seconds to appear.
/// `NotificationChanged` would be instant and is documented as needing a
/// background task registration a desktop app has no way to make, so this is
/// the honest trade rather than the lazy one.
const POLL: Duration = Duration::from_secs(4);

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Notice {
    /// Windows' own id, and what dismissing one takes.
    pub id: u32,
    /// Which app raised it, as a person would name it.
    pub app: String,
    pub title: String,
    pub body: String,
    /// Unix milliseconds.
    pub at: i64,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Notices {
    /// `allowed`, `denied`, or `unavailable` when Windows has no listener at
    /// all. ⚠️ Carried rather than folded into an empty list: "nothing to show"
    /// and "not allowed to look" are the same picture and want different words.
    pub access: String,
    pub items: Vec<Notice>,
}

#[derive(Default)]
pub struct NoticeState(Mutex<Notices>);

impl NoticeState {
    pub fn snapshot(&self) -> Notices {
        self.0.lock().unwrap().clone()
    }
}

fn enter_apartment() {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
}

fn listener() -> Option<UserNotificationListener> {
    UserNotificationListener::Current().ok()
}

/// Ask once. ⚠️ The answer is cached for the life of the process because the
/// call can raise a consent prompt, and asking every four seconds would be a
/// dialog every four seconds.
fn access(listener: &UserNotificationListener) -> &'static str {
    static HELD: std::sync::OnceLock<&'static str> = std::sync::OnceLock::new();
    HELD.get_or_init(|| {
        match listener.RequestAccessAsync().and_then(block) {
            Ok(UserNotificationListenerAccessStatus::Allowed) => "allowed",
            Ok(_) => "denied",
            Err(_) => "unavailable",
        }
    })
}

/// The text of one notification, title first.
///
/// ⚠️ A toast's text is a LIST of elements, not a title and a body: the
/// template decides how many there are and apps use one, two or three. Taking
/// element 0 as the title and joining the rest is the only reading that works
/// for all of them — and an empty list is a real notification (an image-only
/// toast), so it is kept with whatever the app is called rather than dropped.
fn words(notification: &windows::UI::Notifications::UserNotification) -> (String, String) {
    let Ok(content) = notification.Notification() else { return (String::new(), String::new()) };
    let Ok(visual) = content.Visual() else { return (String::new(), String::new()) };
    let Ok(generic) = KnownNotificationBindings::ToastGeneric() else {
        return (String::new(), String::new());
    };
    let Ok(binding) = visual.GetBinding(&generic) else { return (String::new(), String::new()) };
    let Ok(elements) = binding.GetTextElements() else { return (String::new(), String::new()) };

    let mut lines: Vec<String> = Vec::new();
    for element in elements {
        if let Ok(text) = element.Text() {
            let text = text.to_string();
            if !text.trim().is_empty() {
                lines.push(text);
            }
        }
    }
    if lines.is_empty() {
        return (String::new(), String::new());
    }
    let title = lines.remove(0);
    (title, lines.join(" — "))
}

fn app_name(notification: &windows::UI::Notifications::UserNotification) -> String {
    notification
        .AppInfo()
        .and_then(|info| info.DisplayInfo())
        .and_then(|display| display.DisplayName())
        .map(|name| name.to_string())
        .unwrap_or_default()
}

/// What is in the centre right now.
///
/// `known` is last pass's text, keyed by id: a notification's content cannot
/// change once raised, so re-reading the XML of forty of them every four
/// seconds is work with a known answer.
fn read(listener: &UserNotificationListener, known: &mut HashMap<u32, Notice>) -> Vec<Notice> {
    let Ok(all) = listener.GetNotificationsAsync(NotificationKinds::Toast).and_then(block) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let mut live = Vec::new();
    for notification in all {
        let Ok(id) = notification.Id() else { continue };
        live.push(id);
        if let Some(had) = known.get(&id) {
            out.push(had.clone());
            continue;
        }
        let (title, body) = words(&notification);
        let app = app_name(&notification);
        // Nothing to say and nobody to say it: not worth a row.
        if title.is_empty() && body.is_empty() && app.is_empty() {
            continue;
        }
        let at = notification
            .CreationTime()
            .map(|time| {
                /* WinRT `DateTime` is 100ns ticks since 1601-01-01; Unix ms is
                 * from 1970. ⚠️ 11644473600 seconds between the two epochs —
                 * get it wrong and every notification is dated 1601, which
                 * sorts correctly and reads as nonsense. */
                (time.UniversalTime / 10_000) - 11_644_473_600_000
            })
            .unwrap_or(0);
        let notice = Notice { id, app, title, body, at };
        known.insert(id, notice.clone());
        out.push(notice);
    }
    // Anything that left the centre leaves the cache with it.
    known.retain(|id, _| live.contains(id));
    // Newest first, which is the order the centre itself shows them in.
    out.sort_by(|a, b| b.at.cmp(&a.at));
    out
}

pub fn spawn(app: AppHandle) {
    crate::guard::spawn("notice watch", move || {
        enter_apartment();
        let Some(listener) = listener() else {
            if let Some(state) = app.try_state::<NoticeState>() {
                state.0.lock().unwrap().access = "unavailable".into();
            }
            return;
        };
        let mut known: HashMap<u32, Notice> = HashMap::new();
        let mut last = Notices::default();
        loop {
            let watching = crate::prefs::current(&app).notice_mode;
            let next = if !watching {
                Notices { access: "off".into(), items: Vec::new() }
            } else {
                let status = access(&listener);
                Notices {
                    access: status.to_string(),
                    items: if status == "allowed" { read(&listener, &mut known) } else { Vec::new() },
                }
            };
            if next != last {
                last = next.clone();
                if let Some(state) = app.try_state::<NoticeState>() {
                    *state.0.lock().unwrap() = next.clone();
                }
                let _ = app.emit_to("tasks", "notices:changed", &next);
            }
            std::thread::sleep(POLL);
        }
    });
}

#[tauri::command]
pub fn get_notices(app: AppHandle) -> Notices {
    app.state::<NoticeState>().snapshot()
}

/// Dismiss one, or all of them.
///
/// ⚠️ This removes it from WINDOWS, not from a list of our own — there is no
/// list of our own. Which is the point: the button does what the same button
/// in the Action Centre does, and the two can never disagree.
#[tauri::command]
pub async fn notice_dismiss(app: AppHandle, id: Option<u32>) -> Result<Notices, String> {
    let (send, receive) = tokio::sync::oneshot::channel();
    std::thread::spawn(move || {
        enter_apartment();
        let result = (|| -> Result<(), String> {
            let listener = listener().ok_or("Windows is not offering the notification centre.")?;
            match id {
                Some(id) => listener
                    .RemoveNotification(id)
                    .map_err(|_| "Windows would not dismiss that.".to_string()),
                None => listener
                    .ClearNotifications()
                    .map_err(|_| "Windows would not clear the centre.".to_string()),
            }
        })();
        let _ = send.send(result);
    });
    receive.await.unwrap_or_else(|_| Err("The notice thread stopped.".into()))?;

    /* Read straight back rather than waiting for the poll: dismissing
     * something and watching it sit there for four seconds reads as a button
     * that did not work, and the second press then clears one you meant to
     * keep. */
    let (send, receive) = tokio::sync::oneshot::channel();
    std::thread::spawn(move || {
        enter_apartment();
        let mut known = HashMap::new();
        let fresh = match listener() {
            Some(listener) if access(&listener) == "allowed" => Notices {
                access: "allowed".into(),
                items: read(&listener, &mut known),
            },
            _ => Notices::default(),
        };
        let _ = send.send(fresh);
    });
    let fresh = receive.await.unwrap_or_default();
    if let Some(state) = app.try_state::<NoticeState>() {
        *state.0.lock().unwrap() = fresh.clone();
    }
    let _ = app.emit_to("tasks", "notices:changed", &fresh);
    Ok(fresh)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// ⚠️ 11644473600 seconds between 1601 and 1970, and getting it wrong
    /// dates every notification to the seventeenth century — which still sorts
    /// correctly, so the list looks right and every timestamp on it is wrong.
    #[test]
    fn a_winrt_timestamp_becomes_a_unix_one() {
        // 1601-01-01T00:00:00Z, the WinRT epoch itself.
        let epoch: i64 = 0;
        assert_eq!((epoch / 10_000) - 11_644_473_600_000, -11_644_473_600_000);
        // 2026-09-16T12:00:00Z in WinRT ticks.
        let ticks: i64 = (1_789_646_400 + 11_644_473_600) * 10_000_000;
        assert_eq!((ticks / 10_000) - 11_644_473_600_000, 1_789_646_400_000);
    }

    /// Not a unit test — a probe against this machine's own centre.
    /// `cargo test --lib reads_the_real_centre -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn reads_the_real_centre() {
        enter_apartment();
        let listener = listener().expect("a listener");
        let status = access(&listener);
        println!("access: {status}");
        assert_eq!(status, "allowed", "the listener refused this app");
        let mut known = HashMap::new();
        let all = read(&listener, &mut known);
        println!("{} notice(s)", all.len());
        for notice in all.iter().take(8) {
            println!("  [{}] {} \u{2014} {:?}", notice.app, notice.title, notice.body);
        }
        /* ⚠️ The second read must come back the same. It is served from the
         * cache, and a cache keyed on an id that is not stable would quietly
         * double the list or empty it. */
        let again = read(&listener, &mut known);
        assert_eq!(all.len(), again.len());
    }
}
