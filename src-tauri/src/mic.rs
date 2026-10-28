//! The microphone, for hold to talk in the island's composers.
//!
//! The island records with the webview's own `MediaRecorder` and hands the
//! audio to Helm (`helm::helm_transcribe`). Recording needs WebView2's
//! permission for the microphone, and WebView2 asks for it with a PROMPT.
//!
//! ⚠️ That prompt cannot be answered here, and nothing says so. The island is
//! a transparent, click-through, `WS_EX_NOACTIVATE` window whose page is cut to
//! a notch by a clip path; WebView2 draws its permission flyout as browser UI
//! over the page, where it is either clipped away or under a part of the window
//! that does not take the pointer. `getUserMedia` then waits on a dialog nobody
//! can see, and the mic button simply never starts. wry only answers the
//! clipboard's request (`webview2/mod.rs`, `PermissionRequested`) and leaves
//! every other kind at its default — the prompt.
//!
//! So the tasks window answers the microphone's request itself, for this app's
//! OWN pages only (`ours`): a page navigated anywhere else asks as usual. Every
//! other permission kind is left alone.
//!
//! What this cannot do is Windows' own switch (Settings › Privacy › Microphone
//! › "Let desktop apps access your microphone"). Off, the page's
//! `getUserMedia` rejects with `NotAllowedError`, and the island says so in
//! words (`voice.ts`, `voiceProblem`).

use tauri::{AppHandle, Manager};

/// Whether a page asking for the microphone is one of this app's own.
///
/// ⚠️ The ORIGIN, not a prefix of the string: `http://tauri.localhost.evil`
/// starts with `http://tauri.localhost`. Production pages are served from
/// `http://tauri.localhost` (Tauri 2 on Windows; `https://` with the HTTPS
/// scheme option), a dev build from the vite server at `localhost:1420`.
pub fn ours(uri: &str) -> bool {
    let Ok(url) = tauri::Url::parse(uri) else { return false };
    let host = url.host_str().unwrap_or("");
    match url.scheme() {
        "http" | "https" if host == "tauri.localhost" => url.port().is_none(),
        "tauri" => host == "localhost",
        "http" if host == "localhost" || host == "127.0.0.1" => url.port() == Some(1420),
        _ => false,
    }
}

/// Answer the microphone's permission request on the island's webview.
/// Logged either way: a mic that never starts is otherwise silent.
pub fn allow(app: &AppHandle) {
    let Some(window) = app.get_webview_window("tasks") else {
        crate::log::note("mic: no tasks window to allow the microphone on");
        return;
    };
    let result = window.with_webview(|webview| {
        use webview2_com::Microsoft::Web::WebView2::Win32::{
            COREWEBVIEW2_PERMISSION_KIND, COREWEBVIEW2_PERMISSION_KIND_MICROPHONE, COREWEBVIEW2_PERMISSION_STATE_ALLOW,
        };
        use webview2_com::PermissionRequestedEventHandler;
        unsafe {
            let Ok(core) = webview.controller().CoreWebView2() else {
                crate::log::note("mic: the webview has no core yet");
                return;
            };
            let handler = PermissionRequestedEventHandler::create(Box::new(|_, args| {
                let Some(args) = args else { return Ok(()) };
                let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
                args.PermissionKind(&mut kind)?;
                if kind != COREWEBVIEW2_PERMISSION_KIND_MICROPHONE {
                    return Ok(());
                }
                let mut uri = Default::default();
                args.Uri(&mut uri)?;
                let page = webview2_com::take_pwstr(uri);
                if ours(&page) {
                    args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW)?;
                } else {
                    crate::log::note("mic: a page that is not ours asked for the microphone; left to the prompt");
                }
                Ok(())
            }));
            let mut token = 0i64;
            if core.add_PermissionRequested(&handler, &mut token).is_err() {
                crate::log::note("mic: could not listen for the microphone's permission request");
            }
        }
    });
    if result.is_err() {
        crate::log::note("mic: could not reach the island's webview");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_this_apps_own_pages_get_the_microphone() {
        assert!(ours("http://tauri.localhost/tasks.html"));
        assert!(ours("https://tauri.localhost/tasks.html?helm"));
        assert!(ours("tauri://localhost/tasks.html"));
        assert!(ours("http://localhost:1420/tasks.html"), "a dev build, from vite");
        // Look-alikes are not ours.
        assert!(!ours("http://tauri.localhost.evil.com/tasks.html"));
        assert!(!ours("https://evil.com/?http://tauri.localhost"));
        assert!(!ours("http://localhost:3000/"), "another local server is not the island");
        assert!(!ours("https://crm.hadastudios.com/guardian"));
        assert!(!ours("not a url"));
        assert!(!ours(""));
    }
}
