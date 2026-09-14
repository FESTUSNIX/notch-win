//! Windows toast notifications, for the one thing worth interrupting you: a
//! run that has finished while you were looking at something else.
//!
//! ⚠️ **An unpackaged exe cannot simply raise a toast.** `CreateToastNotifier`
//! resolves the AppUserModelID against the shell, and an id the shell has never
//! heard of fails with `ELEMENT_NOT_FOUND` — which arrives as an `Err` nobody
//! is looking at, so the notification is silently never shown. The two
//! documented ways to register one are a Start Menu shortcut carrying
//! `System.AppUserModel.ID`, and a key under `HKCU\Software\Classes\
//! AppUserModelId`. The registry key is used here: it needs no COM, and it does
//! not put a shortcut in someone's Start Menu that they did not ask for.
//!
//! Written by hand against the `windows` crate already in the tree rather than
//! through `tauri-plugin-notification`, which would pull a second major version
//! of `windows` in behind it for four lines of XML.

use windows::core::HSTRING;
use windows::Data::Xml::Dom::XmlDocument;
use windows::UI::Notifications::{ToastNotification, ToastNotificationManager};

/// Must match `identifier` in tauri.conf.json — the shell keys the registration
/// on this string and nothing checks that the two agree.
const AUMID: &str = "com.vinz.codenotch";
const CLASSES: &str = r"Software\Classes\AppUserModelId\com.vinz.codenotch";

/// XML text nodes are parsed, so a track title with an `&` in it would make the
/// whole toast fail to load — again with no error the user ever sees.
fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// Teach the shell this app's id, once. Cheap enough to call on every launch,
/// and doing so repairs a profile where the key was cleaned away.
pub fn register() {
    let Ok(key) = windows_registry::CURRENT_USER.create(CLASSES) else {
        return;
    };
    let _ = key.set_string("DisplayName", "Codenotch");
    if let Ok(exe) = std::env::current_exe() {
        // The icon is read off the executable itself, so it keeps working when
        // the app is moved.
        let _ = key.set_string("IconUri", &exe.display().to_string());
    }
}

/// Raise a toast. Returns whether the shell accepted it — the caller has a
/// visible indicator of its own to fall back on, so a refusal is worth knowing
/// about but is never worth failing over.
pub fn toast(title: &str, body: &str) -> bool {
    let xml = format!(
        r#"<toast activationType="protocol"><visual><binding template="ToastGeneric">
             <text>{}</text><text>{}</text>
           </binding></visual></toast>"#,
        escape(title),
        escape(body)
    );

    let show = || -> windows::core::Result<()> {
        let document = XmlDocument::new()?;
        document.LoadXml(&HSTRING::from(xml.as_str()))?;
        let notification = ToastNotification::CreateToastNotification(&document)?;
        ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(AUMID))?
            .Show(&notification)
    };

    match show() {
        Ok(()) => true,
        Err(error) => {
            // Not a panic and not a user-facing error: a machine with toasts
            // switched off is a normal machine, and the pill still says so.
            if cfg!(debug_assertions) {
                println!("[notch] toast refused: {error}");
            }
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_what_would_break_the_parse() {
        assert_eq!(escape("Tom & Jerry <b>"), "Tom &amp; Jerry &lt;b&gt;");
    }

    /// Run with `cargo test --lib notify -- --ignored --nocapture` and watch for
    /// a toast in the corner. There is no way to assert this from a test.
    #[test]
    #[ignore]
    fn shows_a_real_toast() {
        register();
        assert!(toast("Codenotch", "akcesfonia · finished in 4m 12s"));
    }
}
