//! A noise when a countdown runs out.
//!
//! ⚠️ **Windows already owns every sound this needs, so nothing is shipped.**
//! `C:\Windows\media` holds the notification and alarm sounds the machine
//! already uses, registered under `AppEvents` as aliases like
//! `Notification.Reminder`. Using those rather than a WAV of our own means no
//! asset, no licence question, and — the part that matters — a sound the person
//! at the keyboard already recognises as "the computer wants me".
//!
//! ⚠️ **Played DIRECTLY, not through the toast.** A toast carries a sound of
//! its own, and it would have been less code — but a toast is suppressed by
//! Focus Assist, and Focus Assist is exactly what somebody running a pomodoro
//! has switched on. A timer you started yourself must still be able to tell you
//! it has finished.

use windows::core::PCWSTR;
use windows::Win32::Media::Audio::{PlaySoundW, SND_ASYNC, SND_FILENAME, SND_NODEFAULT};

/// The sounds offered, as `(id, what it is called on screen)`.
///
/// ⚠️ A short list on purpose. Windows registers about forty aliases and most
/// of them are ringtones; what a timer wants is one of three noises, and a
/// settings row with forty entries is a row nobody reads to the end of.
pub const CHOICES: [(&str, &str); 4] = [
    ("", "None"),
    ("Notification.Default", "Chime"),
    ("Notification.Reminder", "Calendar"),
    ("Notification.Looping.Alarm", "Alarm"),
];

pub fn is_known(alias: &str) -> bool {
    CHOICES.iter().any(|(id, _)| *id == alias)
}

/// The file an alias currently points at.
///
/// ⚠️ Resolved through the registry rather than handed to `PlaySound` as an
/// `SND_ALIAS`: the alias form only looks in a fixed set of system events, and
/// a name it does not know plays the DEFAULT sound instead of nothing — which
/// is a wrong noise rather than a silent failure, and much harder to notice.
/// Reading `.Current` also picks up whatever the user's chosen sound scheme
/// has put there, which is the point of using their sounds at all.
fn file_for(alias: &str) -> Option<String> {
    let key = windows_registry::CURRENT_USER
        .open(format!("AppEvents\\Schemes\\Apps\\.Default\\{alias}\\.Current"))
        .ok()?;
    let path = key.get_string("").ok()?;
    if path.trim().is_empty() {
        return None;
    }
    Some(expand(&path))
}

/// Put the environment back into a path that carries it.
///
/// ⚠️ These values are `REG_EXPAND_SZ`, and the registry hands them over
/// RAW: the alarm sounds come back as `%SystemRoot%\\media\\Alarm01.wav`,
/// which `PlaySound` cannot open. With `SND_NODEFAULT` that is silence and no
/// error — the setting offers a sound and pressing it does nothing at all.
/// The three notification sounds happen to be stored expanded, which is why
/// two of the four worked and the interesting one did not.
fn expand(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    let mut rest = path;
    while let Some(open) = rest.find('%') {
        out.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        match after.find('%') {
            Some(close) => {
                let name = &after[..close];
                match std::env::var(name) {
                    Ok(value) => out.push_str(&value),
                    // Unknown: put it back as it was rather than eat it.
                    Err(_) => {
                        out.push('%');
                        out.push_str(name);
                        out.push('%');
                    }
                }
                rest = &after[close + 1..];
            }
            // An odd number of percent signs is not a variable.
            None => {
                out.push('%');
                out.push_str(after);
                return out;
            }
        }
    }
    out.push_str(rest);
    out
}

/// Make the noise. Silent, rather than wrong, when the alias is unknown.
pub fn play(alias: &str) {
    if alias.is_empty() || !is_known(alias) {
        return;
    }
    let Some(path) = file_for(alias) else { return };
    let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe {
        /* ⚠️ `SND_NODEFAULT`, or a missing file plays the system default ding
         * — the same wrong-noise-instead-of-silence trap as the alias form.
         * `SND_ASYNC` because this is called from a command and a two-second
         * alarm must not hold the thread that answered it. */
        let _ = PlaySoundW(PCWSTR(wide.as_ptr()), None, SND_FILENAME | SND_ASYNC | SND_NODEFAULT);
    }
}

#[tauri::command]
pub fn play_sound(alias: String) {
    play(&alias);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// ⚠️ The registry hands these over RAW, and two of the four carry an
    /// environment variable. Unexpanded, `PlaySound` opens nothing and says
    /// nothing — a setting that offers a sound and makes no noise.
    #[test]
    fn a_path_from_the_registry_gets_its_environment_back() {
        let root = std::env::var("SystemRoot").expect("every Windows has one");
        assert_eq!(
            expand("%SystemRoot%\\media\\Alarm01.wav"),
            format!("{root}\\media\\Alarm01.wav"),
        );
        // Already expanded, and left alone.
        assert_eq!(expand("C:\\Windows\\media\\x.wav"), "C:\\Windows\\media\\x.wav");
        // A name nothing knows is put back rather than eaten, so the failure
        // is a path you can read rather than a truncated one.
        assert_eq!(expand("%NOPE_NOT_SET%\\x.wav"), "%NOPE_NOT_SET%\\x.wav");
        // An odd percent sign is not a variable.
        assert_eq!(expand("100% done.wav"), "100% done.wav");
        assert_eq!(expand(""), "");
    }

    #[test]
    fn only_the_four_offered_are_accepted() {
        assert!(is_known("Notification.Reminder"));
        assert!(is_known(""));
        // ⚠️ Anything else is silence, never the system default ding.
        assert!(!is_known("Notification.Looping.Call7"));
        assert!(!is_known("../../../etc/passwd"));
    }

    /// Every alias offered has to resolve on a real machine, or the setting
    /// offers a sound that does nothing.
    /// `cargo test --lib every_offered_sound -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn every_offered_sound_exists_on_this_machine() {
        for (id, name) in CHOICES.iter().skip(1) {
            let path = file_for(id);
            println!("{name} ({id}) -> {path:?}");
            assert!(path.is_some(), "{id} resolves to nothing");
            assert!(
                std::path::Path::new(&path.unwrap()).exists(),
                "{id} points at a file that is not there",
            );
        }
    }

    /// Not a test — it makes a noise. `cargo test --lib makes_a_noise --
    /// --ignored --nocapture`
    #[test]
    #[ignore]
    fn makes_a_noise() {
        play("Notification.Reminder");
        std::thread::sleep(std::time::Duration::from_millis(1500));
    }
}
