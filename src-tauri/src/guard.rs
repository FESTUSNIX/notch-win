//! Making a panic survivable.
//!
//! ⚠️ **A panic in a background thread here is silent and permanent.** Nineteen
//! of them run forever — the hover poll, the session watcher, media, audio, the
//! display watcher, app time — and each one *is* a feature. When one unwinds,
//! Rust prints to a stderr that a windowed release build does not have, the
//! thread ends, and that feature simply stops for the rest of the session with
//! nothing anywhere to say so. The app looks fine. Music stops updating, or the
//! notch stops noticing hover, and the only symptom is "it went weird".
//!
//! Two things, and they answer different halves:
//!
//!   * a **panic hook**, so any panic anywhere — including the main thread —
//!     is written down with its location;
//!   * **`guard::spawn`**, which catches the unwind, says which feature it was,
//!     and restarts the loop a few times before giving up.
//!
//! ⚠️ **OS threads only.** `tasks`, `calendar` and `weather` are tokio tasks,
//! not threads: tokio catches their panics into a `JoinHandle` nobody awaits,
//! which is just as silent. The hook covers them — a panic is written down —
//! but nothing restarts them, and wrapping an async body is a different piece
//! of machinery. If one of those turns out to die in practice, the log will be
//! what says so, and that is the point.
//!
//! ⚠️ The one-shot COM workers in `audio`, `media` and `system` are left alone
//! deliberately. They send a result down a oneshot channel and exit, and the
//! receiving side already turns a dropped sender into "the audio thread
//! stopped" — a panic there is reported to the caller, not lost.
//!
//! ⚠️ Restarting is capped on purpose. A panic that recurs immediately — a bad
//! assumption about a data shape, not a transient Win32 failure — would spin
//! the CPU forever retrying. Three attempts with a widening gap turns a hiccup
//! into a hiccup and leaves a permanent fault permanent, but *logged*.

use std::panic::AssertUnwindSafe;
use std::time::Duration;

/// How many times a background loop is allowed to die before it stays dead.
const ATTEMPTS: u32 = 3;

/// Write every panic to the log, wherever it happens.
///
/// ⚠️ Chained to the default hook rather than replacing it, so `cargo run`
/// still prints the usual message and backtrace to the console.
pub fn install_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let where_ = info
            .location()
            .map(|l| format!("{}:{}", l.file(), l.line()))
            .unwrap_or_else(|| "unknown".into());
        crate::log::note(&format!("PANIC at {where_}: {}", message_of(info.payload())));
        previous(info);
    }));
}

fn message_of(payload: &(dyn std::any::Any + Send)) -> String {
    if let Some(text) = payload.downcast_ref::<&str>() {
        (*text).to_string()
    } else if let Some(text) = payload.downcast_ref::<String>() {
        text.clone()
    } else {
        "no message".to_string()
    }
}

/// Spawn a named background loop that says so when it dies, and tries again.
///
/// The closure is the whole loop, not one iteration: these threads are all
/// `loop { … sleep … }`, so returning normally means the loop chose to stop
/// and is not restarted.
pub fn spawn<F>(name: &'static str, body: F)
where
    F: Fn() + Send + 'static,
{
    std::thread::spawn(move || {
        for attempt in 1..=ATTEMPTS {
            // AssertUnwindSafe: the closure is `Fn`, it owns what it touches,
            // and the alternative is threading UnwindSafe through every
            // AppHandle in the app for no gain.
            match std::panic::catch_unwind(AssertUnwindSafe(&body)) {
                Ok(()) => return,
                Err(payload) => {
                    crate::log::note(&format!(
                        "{name} stopped: {} (attempt {attempt} of {ATTEMPTS})",
                        message_of(&*payload)
                    ));
                }
            }
            if attempt < ATTEMPTS {
                std::thread::sleep(Duration::from_secs(2u64.pow(attempt)));
            }
        }
        crate::log::note(&format!("{name} has given up; that feature is off until restart"));
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    #[test]
    fn a_panicking_loop_is_retried_and_then_left_alone() {
        static RUNS: AtomicU32 = AtomicU32::new(0);
        // ⚠️ The hook is not installed here: the default one prints to stderr
        // during tests, which is noisy but harmless, and installing a global
        // hook from one test would affect every other test in the binary.
        spawn("test-loop", || {
            RUNS.fetch_add(1, Ordering::SeqCst);
            panic!("boom");
        });
        // 2s + 4s of backoff, plus room.
        std::thread::sleep(Duration::from_millis(7_500));
        assert_eq!(RUNS.load(Ordering::SeqCst), ATTEMPTS, "tried, then gave up");
    }

    #[test]
    fn a_loop_that_returns_normally_is_not_restarted() {
        static RUNS: AtomicU32 = AtomicU32::new(0);
        spawn("test-quiet", || {
            RUNS.fetch_add(1, Ordering::SeqCst);
        });
        std::thread::sleep(Duration::from_millis(400));
        assert_eq!(RUNS.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn a_panic_payload_is_readable_whichever_way_it_was_raised() {
        let as_str: Box<dyn std::any::Any + Send> = Box::new("literal");
        let as_string: Box<dyn std::any::Any + Send> = Box::new(String::from("formatted"));
        let as_other: Box<dyn std::any::Any + Send> = Box::new(7u8);
        assert_eq!(message_of(&*as_str), "literal");
        assert_eq!(message_of(&*as_string), "formatted");
        assert_eq!(message_of(&*as_other), "no message");
    }
}
