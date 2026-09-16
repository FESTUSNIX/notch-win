//! A small picture of a file, from the shell's own thumbnail cache.
//!
//! ⚠️ The WebView is never given the file. It asks for a shelf item by id and
//! gets a PNG back; it has no path, no filesystem capability, and no way to ask
//! for anything that is not on the shelf. The alternative — Tauri's asset
//! protocol — grants the page "read any file matching this glob", and the
//! shelf holds files from wherever they were dropped, so the glob would have to
//! be the disk. This app renders a lot of text it did not write (task titles,
//! event titles, filenames, transcript snippets); handing that page a
//! filesystem is a bigger promise than a thumbnail is worth.
//!
//! ⚠️ And it is the SHELL's thumbnail, not one decoded here. Windows already
//! has a cached, correctly-oriented, correctly-scaled preview for images, PDFs,
//! videos and Office documents, and it is the same picture Explorer shows —
//! which is the one the eye is expecting. Decoding a 40 MP JPEG to draw it at
//! 128px would be slower, larger, and wrong more often.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use base64::Engine;

/// How big a preview is asked for, in pixels. ⚠️ The card draws it at about
/// 120 CSS px on a 2× display, so 256 is the honest size and anything larger is
/// bytes crossing the bridge to be thrown away.
const SIZE: u32 = 256;

/// Remembered by path and the file's own modified time, so a shelf of twenty
/// files costs twenty shell calls once rather than on every render.
///
/// ⚠️ Keyed on the TIME as well as the path: a file that is edited in place
/// keeps its name, and a preview that never notices is a picture of something
/// that is no longer there.
fn cache() -> &'static Mutex<HashMap<(String, u64), Option<String>>> {
    static HELD: OnceLock<Mutex<HashMap<(String, u64), Option<String>>>> = OnceLock::new();
    HELD.get_or_init(|| Mutex::new(HashMap::new()))
}

/// A `data:image/png;base64,…` preview of this file, or `None` when the shell
/// has nothing to show for it.
pub fn of(path: &str) -> Option<String> {
    let stamp = std::fs::metadata(path)
        .ok()
        .and_then(|meta| meta.modified().ok())
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|since| since.as_secs())
        .unwrap_or(0);
    let key = (path.to_string(), stamp);
    if let Some(found) = cache().lock().ok().and_then(|held| held.get(&key).cloned()) {
        return found;
    }
    let made = draw(path);
    if let Ok(mut held) = cache().lock() {
        /* ⚠️ Bounded. The shelf is small, but nothing stops somebody parking a
         * thousand things over a month, and a map of base64 PNGs that only ever
         * grows is a leak with a picture on it. */
        if held.len() > 200 {
            held.clear();
        }
        held.insert(key, made.clone());
    }
    made
}

#[cfg(windows)]
fn draw(path: &str) -> Option<String> {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::SIZE;
    use windows::Win32::Graphics::Gdi::{
        DeleteObject, GetDIBits, GetObjectW, BITMAP, BITMAPINFO, BITMAPINFOHEADER, BI_RGB,
        CreateCompatibleDC, DeleteDC, DIB_RGB_COLORS, HDC,
    };
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};
    use windows::Win32::UI::Shell::{
        IShellItemImageFactory, SHCreateItemFromParsingName, SIIGBF_BIGGERSIZEOK,
        SIIGBF_RESIZETOFIT,
    };

    let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe {
        /* ⚠️ Apartment-threaded, and the result is ignored on purpose. The
         * command runs on Tauri's pool, so which thread this is varies and it
         * may well already be initialised — `RPC_E_CHANGED_MODE` is a fact
         * about the thread, not a failure of this call. */
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);

        let item: IShellItemImageFactory =
            SHCreateItemFromParsingName(PCWSTR(wide.as_ptr()), None).ok()?;
        let want = SIZE as i32;
        /* `RESIZETOFIT` keeps the aspect ratio; `BIGGERSIZEOK` lets the shell
         * hand back a cached larger one rather than rescaling for us. */
        let bitmap = item
            .GetImage(SIZE { cx: want, cy: want }, SIIGBF_RESIZETOFIT | SIIGBF_BIGGERSIZEOK)
            .ok()?;
        if bitmap.is_invalid() {
            return None;
        }

        let mut shape = BITMAP::default();
        let read = GetObjectW(
            bitmap.into(),
            std::mem::size_of::<BITMAP>() as i32,
            Some(&mut shape as *mut BITMAP as *mut std::ffi::c_void),
        );
        let mut out = None;
        if read != 0 && shape.bmWidth > 0 && shape.bmHeight > 0 {
            let width = shape.bmWidth as u32;
            let height = shape.bmHeight as u32;
            let dc: HDC = CreateCompatibleDC(None);
            if !dc.is_invalid() {
                let mut header = BITMAPINFO::default();
                header.bmiHeader = BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: shape.bmWidth,
                    /* ⚠️ NEGATIVE, for the same reason `apps.rs` says: a DIB is
                     * bottom-up by default, and a positive height hands back a
                     * picture that is upside down. */
                    biHeight: -shape.bmHeight,
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    ..Default::default()
                };
                let mut bytes = vec![0u8; (width * height * 4) as usize];
                let lines = GetDIBits(
                    dc,
                    bitmap,
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
                    /* ⚠️ A photograph's thumbnail is opaque, and the shell
                     * hands it back with every alpha byte at zero rather than
                     * 255 — so written straight out it is a correctly sized,
                     * correctly coloured, completely invisible PNG. */
                    if bytes.chunks_exact(4).all(|pixel| pixel[3] == 0) {
                        for pixel in bytes.chunks_exact_mut(4) {
                            pixel[3] = 255;
                        }
                    }
                    out = png_uri(width, height, &bytes);
                }
                let _ = DeleteDC(dc);
            }
        }
        let _ = DeleteObject(bitmap.into());
        out
    }
}

#[cfg(not(windows))]
fn draw(_path: &str) -> Option<String> {
    None
}

fn png_uri(width: u32, height: u32, rgba: &[u8]) -> Option<String> {
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
