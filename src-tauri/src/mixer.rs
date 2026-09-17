//! The volume mixer: one level per app, the way Windows' own does it.
//!
//! ⚠️ **`eRender`, not `eCapture`.** `call.rs` walks the same session tree for
//! the opposite reason — an app with an active CAPTURE session is in a call —
//! and the two must not be merged into one helper: the capture walk wants
//! `active_only`, because a capture session outlives the recording that made
//! it, and the mixer wants the opposite. A session that has gone quiet still
//! has a volume worth setting before the next sound comes out of it.
//!
//! ⚠️ **Per session, keyed by process.** Windows gives a level to each
//! *session*, and a browser opens several — one per renderer. They are folded
//! by pid here and a write goes to all of that process's sessions, which is
//! what the Windows mixer does and what anybody dragging a slider labelled
//! "Brave" expects.
//!
//! ⚠️ **Nothing is polled.** Levels are read when the screen is opened and
//! after a write, never on a timer: this is a COM walk of every endpoint and
//! every session on the machine, and a mixer nobody is looking at should cost
//! nothing.

use serde::Serialize;
use windows::core::Interface;
use windows::Win32::Media::Audio::{
    eMultimedia, eRender, IAudioSessionControl2, IAudioSessionManager2, IMMDeviceEnumerator,
    ISimpleAudioVolume, MMDeviceEnumerator, AudioSessionStateExpired,
};
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_ALL};

#[derive(Clone, Debug, Serialize)]
pub struct AppVolume {
    pub pid: u32,
    /// What to call it on screen — the executable without its path or suffix,
    /// title-cased. ⚠️ Not the session's own display name: apps mostly leave
    /// that empty, and the ones that fill it write things like
    /// "@%SystemRoot%\System32\AudioSrv.Dll,-202".
    pub name: String,
    /// The executable's full path.
    pub path: String,
    /// The app's own icon as a data URI, or empty. ⚠️ The SHELL's, taken from
    /// the executable — the same call `apps.rs` makes for the palette and
    /// `call.rs` for the strip, so there is one leaky-handle path rather than
    /// three. A name is a word to read; an icon is the thing you recognise
    /// without reading, which is what a list of sliders wants.
    pub icon: String,
    /// 0..1.
    pub volume: f32,
    pub muted: bool,
    /// Whether it is making a sound right now, rather than merely holding a
    /// session. The screen sorts by this: what you can hear is what you came
    /// to turn down.
    pub active: bool,
}

/// The default playback endpoint's sessions, folded by process.
fn walk() -> Vec<(u32, ISimpleAudioVolume, bool)> {
    let mut out = Vec::new();
    unsafe {
        let Ok(enumerator) =
            CoCreateInstance::<_, IMMDeviceEnumerator>(&MMDeviceEnumerator, None, CLSCTX_ALL)
        else {
            return out;
        };
        /* ⚠️ The DEFAULT endpoint only. Walking every active one lists the
         * same app once per device it could play through, and a row per
         * headset somebody unplugged last week is not a mixer. */
        let Ok(device) = enumerator.GetDefaultAudioEndpoint(eRender, eMultimedia) else {
            return out;
        };
        let Ok(manager) = device.Activate::<IAudioSessionManager2>(CLSCTX_ALL, None) else {
            return out;
        };
        let Ok(sessions) = manager.GetSessionEnumerator() else {
            return out;
        };
        for slot in 0..sessions.GetCount().unwrap_or(0) {
            let Ok(session) = sessions.GetSession(slot) else { continue };
            let state = session.GetState().map(|state| state.0).unwrap_or(-1);
            // Expired is a session whose process has gone; the rest are real.
            if state == AudioSessionStateExpired.0 {
                continue;
            }
            let Ok(detail) = session.cast::<IAudioSessionControl2>() else { continue };
            let Ok(pid) = detail.GetProcessId() else { continue };
            /* ⚠️ Pid 0 is the SYSTEM session \u2014 Windows' own beeps and the
             * "system sounds" row. It has no process to name and no icon, and
             * a row that cannot say what it is is a slider nobody dares move. */
            if pid == 0 {
                continue;
            }
            let Ok(volume) = session.cast::<ISimpleAudioVolume>() else { continue };
            let active = state == windows::Win32::Media::Audio::AudioSessionStateActive.0;
            out.push((pid, volume, active));
        }
    }
    out
}

/// Title-case the executable's stem: `brave.exe` -> `Brave`.
fn named(path: &str) -> String {
    let stem = path
        .rsplit(['\\', '/'])
        .next()
        .unwrap_or(path)
        .trim_end_matches(".exe")
        .trim_end_matches(".EXE");
    let mut chars = stem.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

#[tauri::command]
pub fn get_mixer() -> Vec<AppVolume> {
    let mut out: Vec<AppVolume> = Vec::new();
    for (pid, volume, active) in walk() {
        if let Some(found) = out.iter_mut().find(|one| one.pid == pid) {
            // Several sessions for one app: it counts as making a sound if any
            // of them is, and the level shown is the first one read.
            found.active |= active;
            continue;
        }
        let path = crate::call::exe_of(pid);
        let name = named(&path);
        if name.is_empty() {
            continue;
        }
        unsafe {
            out.push(AppVolume {
                pid,
                name,
                icon: crate::apps::icon_of(&path).unwrap_or_default(),
                path,
                volume: volume.GetMasterVolume().unwrap_or(1.0),
                muted: volume.GetMute().map(|m| m.as_bool()).unwrap_or(false),
                active,
            });
        }
    }
    /* What you can hear first, then by name. ⚠️ Not by pid, which is the order
     * Windows hands them over in and changes every time anything restarts \u2014 a
     * list of sliders that reorders itself under the hand is unusable. */
    out.sort_by(|a, b| b.active.cmp(&a.active).then_with(|| a.name.cmp(&b.name)));
    out
}

/// ⚠️ Every session belonging to that process, not the first one found. A
/// browser has one per renderer, and setting only the one the enumerator
/// happened to return leaves the tab that is actually playing at full volume.
#[tauri::command]
pub fn set_app_volume(pid: u32, volume: f32) -> Result<(), String> {
    let level = volume.clamp(0.0, 1.0);
    let mut touched = false;
    for (found, control, _) in walk() {
        if found != pid {
            continue;
        }
        unsafe {
            let _ = control.SetMasterVolume(level, std::ptr::null());
        }
        touched = true;
    }
    if touched {
        Ok(())
    } else {
        Err("That app is no longer playing anything.".into())
    }
}

#[tauri::command]
pub fn set_app_mute(pid: u32, muted: bool) -> Result<(), String> {
    let mut touched = false;
    for (found, control, _) in walk() {
        if found != pid {
            continue;
        }
        unsafe {
            let _ = control.SetMute(muted, std::ptr::null());
        }
        touched = true;
    }
    if touched {
        Ok(())
    } else {
        Err("That app is no longer playing anything.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_path_becomes_a_name() {
        assert_eq!(named(r"C:\Program Files\BraveSoftware\brave.exe"), "Brave");
        assert_eq!(named("spotify.exe"), "Spotify");
        // Already capitalised, and not mangled by it.
        assert_eq!(named(r"C:\Windows\System32\Taskmgr.exe"), "Taskmgr");
        assert_eq!(named(""), "");
    }

    /// ⚠️ `#[ignore]`d: it walks the real machine's audio sessions, so it says
    /// nothing on a build agent and everything on a desk with music playing.
    #[test]
    #[ignore]
    fn what_is_actually_playing_here() {
        // COM, on this thread. The app enters an apartment at startup; a test
        // thread has to do it for itself or every call returns nothing.
        unsafe {
            let _ = windows::Win32::System::Com::CoInitializeEx(
                None,
                windows::Win32::System::Com::COINIT_APARTMENTTHREADED,
            );
        }
        let all = get_mixer();
        println!("{} apps on the default endpoint", all.len());
        for app in all {
            println!(
                "{:<20} pid {:<7} {:>4}%{} {}",
                app.name,
                app.pid,
                (app.volume * 100.0).round(),
                if app.muted { " muted" } else { "" },
                if app.active { "playing" } else { "" },
            );
        }
    }
}
