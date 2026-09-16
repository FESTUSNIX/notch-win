/* The applications, so three letters open one.
 *
 * This is the one thing Flow Launcher was genuinely still being opened for:
 * type `bra`, get Brave. Everything else the palette already did better,
 * because it can see the island's own world — but nothing here could launch an
 * app, so the launcher stayed on the machine for that alone.
 *
 * ⚠️ The Start Menu IS the index. Windows has no API that says "the installed
 * applications"; what it has is two folders of shortcuts that every installer
 * writes to, which is what the Start Menu itself lists. Registry uninstall keys
 * are a different set (they include things with no UI), and the Store's apps
 * live somewhere else again. Two `read_dir` walks get the list a person would
 * recognise, with no dependency and nothing to keep in sync.
 *
 * ⚠️ Scanned ONCE, in the background, and cached for the life of the process.
 * Icon extraction is a shell call per app and there are a couple of hundred of
 * them; doing it per keystroke would put a second of shell work behind every
 * letter. Apps do not appear while you are typing.
 */
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use base64::Engine;

/// How deep into the Start Menu's folders to look. Vendors nest one or two
/// levels ("JetBrains/Toolbox"); nothing legitimate is five down.
const DEPTH: usize = 4;
/// Enough for any real machine, and a ceiling on a pathological one.
const MOST: usize = 600;

/// ⚠️ What the Start Menu is full of besides applications. Every vendor ships
/// "Uninstall X", "X Website", "X Help" beside the thing you wanted, so without
/// this, typing `bra` offers to uninstall Brave as readily as to open it.
const NOISE: [&str; 11] = [
    "uninstall", "readme", "read me", "help", "website", "web site",
    "documentation", "release notes", "changelog", "license", "manual",
];

#[derive(Clone, serde::Serialize)]
pub struct App {
    pub name: String,
    pub path: String,
    /// A `data:image/png;base64,…` of the shortcut's own icon, or `None` when
    /// the shell would not give one up. The palette falls back to a glyph.
    pub icon: Option<String>,
}

/* ── Finding them ────────────────────────────────────────────────────────── */

fn roots() -> Vec<PathBuf> {
    let mut out = Vec::new();
    // The user's own Start Menu, then the machine-wide one.
    if let Some(data) = dirs::data_dir() {
        out.push(data.join("Microsoft").join("Windows").join("Start Menu").join("Programs"));
    }
    if let Ok(program_data) = std::env::var("ProgramData") {
        out.push(
            Path::new(&program_data)
                .join("Microsoft")
                .join("Windows")
                .join("Start Menu")
                .join("Programs"),
        );
    }
    out
}

fn worth_offering(name: &str) -> bool {
    let lower = name.to_lowercase();
    !NOISE.iter().any(|junk| lower.contains(junk))
}

fn walk(dir: &Path, depth: usize, found: &mut Vec<(String, PathBuf)>) {
    if depth > DEPTH || found.len() >= MOST {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            walk(&path, depth + 1, found);
            continue;
        }
        let extension = path
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        if extension != "lnk" && extension != "url" {
            continue;
        }
        let Some(name) = path.file_stem().map(|s| s.to_string_lossy().into_owned()) else {
            continue;
        };
        if !worth_offering(&name) {
            continue;
        }
        found.push((name, path));
    }
}

/* ── Their icons ─────────────────────────────────────────────────────────── */

mod art {
    use windows::core::PCWSTR;
    use windows::Win32::Graphics::Gdi::{
        CreateCompatibleDC, DeleteDC, DeleteObject, GetDIBits, GetObjectW, BITMAP, BITMAPINFO,
        BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HBITMAP, HDC,
    };
    use windows::Win32::UI::Shell::{SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON, SHGFI_LARGEICON};
    use windows::Win32::UI::WindowsAndMessaging::{DestroyIcon, GetIconInfo, HICON, ICONINFO};

    /// RGBA and its size, or `None` when the shell had nothing to give.
    ///
    /// ⚠️ Every handle here leaks if an early return skips its cleanup, and a
    /// leaked GDI bitmap is not visible until the process has been up for hours
    /// and stops being able to draw. Hence the single cleanup path.
    pub fn pixels_of(path: &str) -> Option<(u32, u32, Vec<u8>)> {
        let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
        let mut info = SHFILEINFOW::default();
        let got = unsafe {
            SHGetFileInfoW(
                PCWSTR(wide.as_ptr()),
                Default::default(),
                Some(&mut info),
                std::mem::size_of::<SHFILEINFOW>() as u32,
                SHGFI_ICON | SHGFI_LARGEICON,
            )
        };
        if got == 0 || info.hIcon.is_invalid() {
            return None;
        }
        let out = unsafe { rgba_of(info.hIcon) };
        unsafe { let _ = DestroyIcon(info.hIcon); }
        out
    }

    unsafe fn rgba_of(icon: HICON) -> Option<(u32, u32, Vec<u8>)> {
        let mut parts = ICONINFO::default();
        GetIconInfo(icon, &mut parts).ok()?;
        let colour: HBITMAP = parts.hbmColor;
        let mask: HBITMAP = parts.hbmMask;

        let mut out = None;
        let mut shape = BITMAP::default();
        let read = GetObjectW(
            colour.into(),
            std::mem::size_of::<BITMAP>() as i32,
            Some(&mut shape as *mut BITMAP as *mut std::ffi::c_void),
        );
        if read != 0 && shape.bmWidth > 0 && shape.bmHeight > 0 {
            let width = shape.bmWidth as u32;
            let height = shape.bmHeight as u32;
            let dc: HDC = CreateCompatibleDC(None);
            if !dc.is_invalid() {
                let mut header = BITMAPINFO::default();
                header.bmiHeader = BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: shape.bmWidth,
                    // ⚠️ NEGATIVE. A DIB is bottom-up by default, so a positive
                    // height hands back an icon that is upside down — and it
                    // looks like a rendering bug three files away.
                    biHeight: -shape.bmHeight,
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    ..Default::default()
                };
                let mut bytes = vec![0u8; (width * height * 4) as usize];
                let lines = GetDIBits(
                    dc,
                    colour,
                    0,
                    height,
                    Some(bytes.as_mut_ptr() as *mut std::ffi::c_void),
                    &mut header,
                    DIB_RGB_COLORS,
                );
                if lines != 0 {
                    // GDI hands back BGRA; PNG wants RGBA.
                    for pixel in bytes.chunks_exact_mut(4) {
                        pixel.swap(0, 2);
                    }
                    if bytes.chunks_exact(4).all(|pixel| pixel[3] == 0) {
                        // ⚠️ A 32-bit DIB from an OLD icon carries no alpha at
                        // all, so every pixel reads as fully transparent and
                        // the row draws blank. The AND mask is what says which
                        // pixels are there: 1 means transparent.
                        alpha_from(dc, mask, width, height, &mut bytes);
                    }
                    out = Some((width, height, bytes));
                }
                let _ = DeleteDC(dc);
            }
        }
        let _ = DeleteObject(colour.into());
        let _ = DeleteObject(mask.into());
        out
    }

    unsafe fn alpha_from(dc: HDC, mask: HBITMAP, width: u32, height: u32, bytes: &mut [u8]) {
        let mut header = BITMAPINFO::default();
        header.bmiHeader = BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width as i32,
            biHeight: -(height as i32),
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        };
        let mut shape = vec![0u8; (width * height * 4) as usize];
        let lines = GetDIBits(
            dc,
            mask,
            0,
            height,
            Some(shape.as_mut_ptr() as *mut std::ffi::c_void),
            &mut header,
            DIB_RGB_COLORS,
        );
        if lines == 0 {
            // Nothing better to say than "all of it is there".
            for pixel in bytes.chunks_exact_mut(4) {
                pixel[3] = 255;
            }
            return;
        }
        for (pixel, flag) in bytes.chunks_exact_mut(4).zip(shape.chunks_exact(4)) {
            pixel[3] = if flag[0] == 0 { 255 } else { 0 };
        }
    }
}

/// PNG, base64, as a data URI. ⚠️ PNG rather than raw pixels because the
/// difference is about sevenfold over two hundred icons, and it arrives as an
/// `<img src>` rather than as something the WebView has to decode by hand.
fn data_uri(width: u32, height: u32, rgba: &[u8]) -> Option<String> {
    let mut out = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut out, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().ok()?;
        writer.write_image_data(rgba).ok()?;
    }
    Some(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(&out)
    ))
}

/// The icon of one file, as a data URI. ⚠️ Shared with `call.rs`, which
/// wants the picture of a running app's executable rather than of a Start Menu
/// shortcut — the shell call is the same one and the handle leaks are the same
/// ones, so there is no second copy of it.
pub fn icon_of(path: &str) -> Option<String> {
    let (width, height, rgba) = art::pixels_of(path)?;
    data_uri(width, height, &rgba)
}

/* ── The index ───────────────────────────────────────────────────────────── */

fn cache() -> &'static Mutex<Option<Vec<App>>> {
    static HELD: OnceLock<Mutex<Option<Vec<App>>>> = OnceLock::new();
    HELD.get_or_init(|| Mutex::new(None))
}

/// ⚠️ Blocking, and it talks to the shell — never on the UI thread.
pub fn scan() -> Vec<App> {
    let mut found = Vec::new();
    for root in roots() {
        walk(&root, 0, &mut found);
    }
    /* One row per application. ⚠️ Both Start Menus carry the same shortcut for
     * anything installed for all users, so without this every such app is
     * offered twice and the two rows are indistinguishable. */
    found.sort_by_key(|(name, path)| (name.to_lowercase(), path.as_os_str().len()));
    found.dedup_by(|a, b| a.0.to_lowercase() == b.0.to_lowercase());

    found
        .into_iter()
        .map(|(name, path)| {
            let full = path.to_string_lossy().into_owned();
            let icon = art::pixels_of(&full)
                .and_then(|(width, height, rgba)| data_uri(width, height, &rgba));
            App { name, path: full, icon }
        })
        .collect()
}

/// Build it if it is not built, and hand back what there is.
pub fn warm() {
    let apps = scan();
    if let Ok(mut held) = cache().lock() {
        *held = Some(apps);
    }
}

#[tauri::command]
pub async fn list_apps() -> Result<Vec<App>, String> {
    if let Ok(held) = cache().lock() {
        if let Some(apps) = held.as_ref() {
            return Ok(apps.clone());
        }
    }
    // Not warmed yet — the palette was opened in the first second of the run.
    tauri::async_runtime::spawn_blocking(|| {
        warm();
        cache().lock().ok().and_then(|held| held.clone()).unwrap_or_default()
    })
    .await
    .map_err(|_| "The application list did not finish building.".to_string())
}

/// ⚠️ The same helper the shelf and the file hits open with, rather than a
/// third `ShellExecute` written slightly differently.
#[tauri::command]
pub fn launch_app(path: String) -> Result<(), String> {
    crate::calendar::open_path(&path)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// ⚠️ The Start Menu is mostly not applications. Every vendor ships
    /// "Uninstall X" and "X Website" beside the thing you wanted, so without
    /// this, typing `bra` offers to uninstall Brave as readily as to open it.
    #[test]
    fn the_shortcuts_nobody_means_are_left_out() {
        for junk in [
            "Uninstall Brave", "Brave Website", "Read Me First",
            "Visual Studio Code Documentation", "Release Notes", "License Agreement",
        ] {
            assert!(!worth_offering(junk), "{junk}");
        }
        for real in ["Brave", "Visual Studio Code", "Notion", "Spotify", "Steam"] {
            assert!(worth_offering(real), "{real}");
        }
    }

    /// A data URI has to be something an `<img>` will actually take.
    #[test]
    fn an_icon_arrives_as_a_png_data_uri() {
        let rgba = vec![0u8; 4 * 4 * 4];
        let uri = data_uri(4, 4, &rgba).expect("4x4 should encode");
        assert!(uri.starts_with("data:image/png;base64,"));
        let body = uri.trim_start_matches("data:image/png;base64,");
        let bytes = base64::engine::general_purpose::STANDARD.decode(body).unwrap();
        // The PNG signature, so a truncated or mis-encoded blob fails here
        // rather than as a broken image in the palette.
        assert_eq!(&bytes[..8], &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]);
        // Wrong-sized pixel data is refused rather than written short.
        assert!(data_uri(4, 4, &[0u8; 3]).is_none());
    }

    /// The real Start Menu. `#[ignore]`d like the other tests here that touch
    /// the machine, and the only thing that proves the walk and the shell call.
    #[test]
    #[ignore]
    fn reads_this_machine_s_start_menu() {
        let apps = scan();
        assert!(apps.len() > 5, "only found {}", apps.len());
        /* Measured on this machine: 152 apps, every one with an icon, 287 KB of
         * data URIs, 1.7s to build. That is the whole argument for warming it
         * once in the background and fetching it once at boot rather than
         * asking per keystroke. */
        assert!(apps.iter().any(|app| app.icon.is_some()), "no icons at all");
        for app in &apps {
            assert!(!app.name.is_empty());
            assert!(worth_offering(&app.name));
        }
        let names: Vec<String> = apps.iter().map(|app| app.name.to_lowercase()).collect();
        let mut sorted = names.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(names.len(), sorted.len(), "the same app is offered twice");
    }
}
