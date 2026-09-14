//! "Not now."
//!
//! Everything in this app that asks for attention had, until now, exactly one
//! way to stop asking: stop being true. That is right for a disk at 97% — which
//! decays into the rotation instead — and wrong for a Claude session you are
//! deliberately leaving until after lunch, which claims the pill and turns the
//! notch amber every time you glance at it.
//!
//! One keyed store, so anything that can shout can be told to wait: an agent
//! (`agent:<sessionId>`), a pill module (`module:disk`), anything later.
//!
//! ⚠️ **Nothing is silenced for ever.** Every snooze has an end, the island's
//! settings say how many things are currently quiet, and one press clears them
//! all — because the failure mode of a mute button is forgetting you pressed
//! it, and then wondering for a week why the app stopped telling you things.

use std::collections::HashMap;
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager};

const FILE: &str = "snooze.json";

/// key -> unix milliseconds at which it starts mattering again.
#[derive(Default)]
pub struct Store(pub Mutex<HashMap<String, i64>>);

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// ⚠️ Pruned on every read rather than on a timer. An expired entry left in the
/// map is a thing that has come back but still reports itself as quiet, and
/// there is no cheaper moment to notice than the moment someone asks.
fn live(map: &mut HashMap<String, i64>) -> bool {
    let now = now_ms();
    let before = map.len();
    map.retain(|_, until| *until > now);
    map.len() != before
}

pub fn load(app: &AppHandle) {
    let stored: HashMap<String, i64> = crate::config::load_beside(FILE).unwrap_or_default();
    if let Ok(mut map) = app.state::<Store>().0.lock() {
        *map = stored;
        live(&mut map);
    }
}

fn publish(app: &AppHandle, map: &HashMap<String, i64>) {
    crate::config::save_beside(FILE, map);
    let _ = app.emit("notch:snoozed", map.clone());
}

/// Everything currently quiet, expired entries already dropped.
#[tauri::command]
pub fn get_snoozed(app: AppHandle) -> HashMap<String, i64> {
    let state = app.state::<Store>();
    let Ok(mut map) = state.0.lock() else {
        return HashMap::new();
    };
    if live(&mut map) {
        crate::config::save_beside(FILE, &*map);
    }
    map.clone()
}

/// Quiet for `minutes`. Returns when it comes back.
#[tauri::command]
pub fn snooze(app: AppHandle, key: String, minutes: i64) -> i64 {
    let until = now_ms() + minutes.clamp(1, 60 * 24) * 60_000;
    let snapshot = {
        let state = app.state::<Store>();
        let Ok(mut map) = state.0.lock() else { return 0 };
        live(&mut map);
        map.insert(key, until);
        map.clone()
    };
    publish(&app, &snapshot);
    until
}

/// Bring one thing back, or — with an empty key — everything.
#[tauri::command]
pub fn unsnooze(app: AppHandle, key: String) {
    let snapshot = {
        let state = app.state::<Store>();
        let Ok(mut map) = state.0.lock() else { return };
        if key.is_empty() {
            map.clear();
        } else {
            map.remove(&key);
        }
        map.clone()
    };
    publish(&app, &snapshot);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expired_entries_are_dropped_on_read() {
        let mut map = HashMap::new();
        map.insert("agent:a".to_string(), now_ms() - 1);
        map.insert("agent:b".to_string(), now_ms() + 60_000);
        assert!(live(&mut map), "something was pruned");
        assert_eq!(map.len(), 1);
        assert!(map.contains_key("agent:b"));
        // Nothing to prune the second time, so nothing is rewritten.
        assert!(!live(&mut map));
    }
}
