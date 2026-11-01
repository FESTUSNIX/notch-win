//! JARVIS's eyes (2 Nov, stage 2): what the Guardian asks back mid-reply —
//! his screen, files found, a file's contents, the clipboard. It arrives as a
//! `pc` event with an `ask` (the request's id in Helm), is answered here, and
//! the answer goes to `/api/guardian/pc/<ask>`, where the reply is waiting.
//!
//! ⚠️ Only ever on his word: Helm's prompt keeps the screen to "spójrz", "co
//! to za błąd". Nothing is kept on either side — the picture or the text goes
//! to Claude for that one reply.
//!
//! ⚠️ Vercel takes 4.5 MB a request, base64 makes things a third bigger: a
//! picture or a PDF over ~3 MB is refused here, said as it is.

use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Value};
use std::io::Read;
use std::path::Path;
use std::time::Duration;
use tauri::{AppHandle, Manager};

#[derive(Debug, Deserialize)]
#[serde(tag = "do", rename_all = "lowercase")]
enum Ask {
    Look { ask: String },
    Find { ask: String, query: String, kind: String, newest: bool },
    Read { ask: String, path: String },
    Clipboard { ask: String },
}

/// The longer side of the screen picture: 1080p goes as it is, bigger is scaled down.
const LONGEST: i32 = 1920;
/// Raw bytes that still fit one request after base64.
const MOST_BYTES: u64 = 3_200_000;
/// Text sent back, in characters (a long log, a big file: the start).
const MOST_TEXT: usize = 100_000;

/// Answer one `pc` event that asks for something back, in the background.
pub fn answer(app: AppHandle, action: &Value) {
    let Ok(ask) = serde_json::from_value::<Ask>(action.clone()) else { return };
    tauri::async_runtime::spawn(async move {
        let (id, answer) = match ask {
            Ask::Look { ask } => (ask, look(&app).await),
            Ask::Find { ask, query, kind, newest } => (ask, blocking(move || find(&query, &kind, newest)).await),
            Ask::Read { ask, path } => (ask, blocking(move || read(&path)).await),
            Ask::Clipboard { ask } => (ask, blocking(clipboard).await),
        };
        let answer = answer.unwrap_or_else(|why| json!({ "error": why }));
        let _ = crate::helm::answer_pc(&id, answer).await;
    });
}

async fn blocking(work: impl FnOnce() -> Result<Value, String> + Send + 'static) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(work).await.map_err(|_| "Nie udało się.".to_string())?
}

/* ── The screen ───────────────────────────────────────────────────────── */

/// The monitor he's working on, as a JPEG, without the island: its windows
/// are kept out of capture for the moment it takes (`WDA_EXCLUDEFROMCAPTURE`
/// — on the monitor they stay as they are).
async fn look(app: &AppHandle) -> Result<Value, String> {
    let ours: Vec<isize> = app.webview_windows().values().filter_map(|w| crate::win::hwnd_of(w)).map(|h| h.0 as isize).collect();
    let before = hide_from_capture(&ours);
    // The compositor needs a frame to leave them out.
    tokio::time::sleep(Duration::from_millis(120)).await;
    let shot = blocking(capture).await;
    restore_capture(&before);
    shot
}

#[cfg(windows)]
fn hide_from_capture(windows: &[isize]) -> Vec<(isize, u32)> {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{GetWindowDisplayAffinity, SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE};
    let mut before = Vec::new();
    for &raw in windows {
        let hwnd = HWND(raw as *mut std::ffi::c_void);
        let mut was = 0u32;
        unsafe {
            if GetWindowDisplayAffinity(hwnd, &mut was).is_ok() && SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE).is_ok() {
                before.push((raw, was));
            }
        }
    }
    before
}

#[cfg(windows)]
fn restore_capture(before: &[(isize, u32)]) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{SetWindowDisplayAffinity, WINDOW_DISPLAY_AFFINITY};
    for &(raw, was) in before {
        unsafe {
            let _ = SetWindowDisplayAffinity(HWND(raw as *mut std::ffi::c_void), WINDOW_DISPLAY_AFFINITY(was));
        }
    }
}

/// The window he's working in: the one in front, or — when that's the island
/// (he typed to the Guardian) — the one he came from.
#[cfg(windows)]
fn working_window() -> windows::Win32::Foundation::HWND {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId, IsWindow};
    unsafe {
        let front = GetForegroundWindow();
        let mut pid = 0u32;
        GetWindowThreadProcessId(front, Some(&mut pid));
        if pid == std::process::id() {
            let previous = HWND(crate::task_window::previous_window() as *mut std::ffi::c_void);
            if !previous.is_invalid() && IsWindow(Some(previous)).as_bool() {
                return previous;
            }
        }
        front
    }
}

#[cfg(windows)]
fn title_of(hwnd: windows::Win32::Foundation::HWND) -> String {
    use windows::Win32::UI::WindowsAndMessaging::GetWindowTextW;
    let mut buffer = [0u16; 400];
    let n = unsafe { GetWindowTextW(hwnd, &mut buffer) } as usize;
    String::from_utf16_lossy(&buffer[..n.min(buffer.len())])
}

#[cfg(windows)]
fn capture() -> Result<Value, String> {
    use windows::Win32::Graphics::Gdi::{
        CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits, GetMonitorInfoW, MonitorFromWindow, ReleaseDC, SelectObject,
        SetBrushOrgEx, SetStretchBltMode, StretchBlt, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, CAPTUREBLT, DIB_RGB_COLORS, HALFTONE, MONITORINFO,
        MONITOR_DEFAULTTONEAREST, SRCCOPY,
    };
    let window = working_window();
    let title = title_of(window);
    let (width, height, pixels) = unsafe {
        let monitor = MonitorFromWindow(window, MONITOR_DEFAULTTONEAREST);
        let mut info = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
        if !GetMonitorInfoW(monitor, &mut info).as_bool() {
            return Err("Nie widzę monitora.".into());
        }
        let r = info.rcMonitor;
        let (w, h) = (r.right - r.left, r.bottom - r.top);
        if w <= 0 || h <= 0 {
            return Err("Nie widzę monitora.".into());
        }
        let scale = (LONGEST as f64 / w.max(h) as f64).min(1.0);
        let (tw, th) = (((w as f64) * scale).round() as i32, ((h as f64) * scale).round() as i32);
        let screen = GetDC(None);
        let memory = CreateCompatibleDC(Some(screen));
        let bitmap = CreateCompatibleBitmap(screen, tw, th);
        let old = SelectObject(memory, bitmap.into());
        // HALFTONE averages when it scales down, so small text stays legible.
        SetStretchBltMode(memory, HALFTONE);
        let _ = SetBrushOrgEx(memory, 0, 0, None);
        let copied = StretchBlt(memory, 0, 0, tw, th, Some(screen), r.left, r.top, w, h, SRCCOPY | CAPTUREBLT).as_bool();
        // ⚠️ Out of the DC before GetDIBits: a bitmap selected into a DC can't be read.
        SelectObject(memory, old);
        let mut header = BITMAPINFO::default();
        header.bmiHeader = BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: tw,
            // Negative: top-down rows (see thumbs.rs).
            biHeight: -th,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        };
        let mut pixels = vec![0u8; (tw * th * 4) as usize];
        let lines = GetDIBits(memory, bitmap, 0, th as u32, Some(pixels.as_mut_ptr() as *mut std::ffi::c_void), &mut header, DIB_RGB_COLORS);
        let _ = DeleteObject(bitmap.into());
        let _ = DeleteDC(memory);
        ReleaseDC(None, screen);
        if !copied || lines == 0 {
            return Err("Nie udało się zrobić zrzutu ekranu.".into());
        }
        (tw as u16, th as u16, pixels)
    };
    let mut jpeg = Vec::new();
    jpeg_encoder::Encoder::new(&mut jpeg, 82)
        .encode(&pixels, width, height, jpeg_encoder::ColorType::Bgra)
        .map_err(|_| "Nie udało się zapisać zrzutu.".to_string())?;
    Ok(json!({ "title": title, "image": { "mediaType": "image/jpeg", "data": b64(&jpeg) } }))
}

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/* ── Files ────────────────────────────────────────────────────────────── */

/// Everything's hits with their size and when they were changed. `newest`:
/// Everything sorts them itself (its QUERY2); an older Everything answers
/// that with nothing, and then the first 200 by name are sorted here.
fn find(query: &str, kind: &str, newest: bool) -> Result<Value, String> {
    if !crate::everything::running() {
        return Err("Wyszukiwanie plików (Everything) nie działa.".into());
    }
    // Asking for folders or files only: "folder:" / "file:" are Everything's own filters.
    let query = match kind {
        "file" => format!("file: {query}"),
        "folder" => format!("folder: {query}"),
        _ => query.to_string(),
    };
    type Found = (String, bool, Option<u64>, Option<chrono::DateTime<chrono::Utc>>);
    let sorted: Vec<Found> = if newest {
        crate::everything::search_newest(&query, 25)
            .into_iter()
            .map(|d| (d.hit.full, d.hit.folder, d.size, d.modified.and_then(|s| chrono::DateTime::from_timestamp(s, 0))))
            .collect()
    } else {
        Vec::new()
    };
    let mut found: Vec<Found> = if !sorted.is_empty() {
        sorted
    } else {
        crate::everything::search(&query, if newest { 200 } else { 25 })
            .into_iter()
            .map(|h| {
                let meta = std::fs::metadata(&h.full).ok();
                let size = meta.as_ref().filter(|m| m.is_file()).map(|m| m.len());
                let modified = meta.and_then(|m| m.modified().ok()).map(chrono::DateTime::<chrono::Utc>::from);
                (h.full, h.folder, size, modified)
            })
            .collect()
    };
    if newest {
        found.sort_by(|a, b| b.3.cmp(&a.3));
    }
    found.truncate(25);
    Ok(json!({ "hits": found.into_iter().map(|(path, folder, size, modified)| json!({ "path": path, "folder": folder, "size": size, "modified": modified.map(|m| m.to_rfc3339()) })).collect::<Vec<_>>() }))
}

/// Keys, passwords and the like are never read, whoever asks: a screen or a
/// document could tell the Guardian to go looking for them.
fn secret(path: &Path) -> bool {
    let lower = |s: &std::ffi::OsStr| s.to_string_lossy().to_lowercase();
    if path.components().any(|c| matches!(lower(c.as_os_str()).as_str(), ".ssh" | ".gnupg" | ".aws" | ".azure" | ".kube" | ".docker")) {
        return true;
    }
    let name = path.file_name().map(lower).unwrap_or_default();
    let ext = path.extension().map(lower).unwrap_or_default();
    name.starts_with(".env")
        || name.starts_with("id_rsa")
        || name.starts_with("id_ed25519")
        || matches!(name.as_str(), ".npmrc" | ".netrc" | ".git-credentials" | "credentials" | "credentials.json" | "login data" | "cookies" | "local state")
        || matches!(ext.as_str(), "pem" | "key" | "pfx" | "p12" | "ppk" | "kdbx" | "keystore" | "jks" | "asc" | "gpg")
}

fn read(path: &str) -> Result<Value, String> {
    let path = Path::new(path.trim());
    if !path.is_absolute() {
        return Err("Potrzebuję pełnej ścieżki (pc_find ją poda).".into());
    }
    if secret(path) {
        return Err("To klucze albo hasła — tego nie czytam.".into());
    }
    let meta = std::fs::metadata(path).map_err(|_| "Nie ma takiego pliku.".to_string())?;
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    if meta.is_dir() {
        return Ok(json!({ "title": name, "text": listing(path)? }));
    }
    let ext = path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    let too_big = || format!("„{name}” jest za duży, żeby go przesłać (ponad 3 MB).");
    match ext.as_str() {
        "pdf" => {
            if meta.len() > MOST_BYTES {
                return Err(too_big());
            }
            let bytes = std::fs::read(path).map_err(|_| "Nie mogę otworzyć tego pliku.".to_string())?;
            Ok(json!({ "title": name, "pdf": b64(&bytes) }))
        }
        "jpg" | "jpeg" | "png" | "gif" | "webp" => {
            if meta.len() > MOST_BYTES {
                return Err(too_big());
            }
            let bytes = std::fs::read(path).map_err(|_| "Nie mogę otworzyć tego pliku.".to_string())?;
            let kind = match ext.as_str() {
                "jpg" | "jpeg" => "image/jpeg",
                "png" => "image/png",
                "gif" => "image/gif",
                _ => "image/webp",
            };
            Ok(json!({ "title": name, "image": { "mediaType": kind, "data": b64(&bytes) } }))
        }
        "docx" => {
            if meta.len() > 40_000_000 {
                return Err(too_big());
            }
            let bytes = std::fs::read(path).map_err(|_| "Nie mogę otworzyć tego pliku.".to_string())?;
            let text = docx_text(&bytes).ok_or_else(|| format!("Nie umiem przeczytać „{name}”."))?;
            let (text, truncated) = cut(text);
            Ok(json!({ "title": name, "text": text, "truncated": truncated }))
        }
        _ => {
            // The start is enough to tell, and to read a long log.
            let mut bytes = Vec::new();
            std::fs::File::open(path)
                .and_then(|f| f.take(1_200_000).read_to_end(&mut bytes))
                .map_err(|_| "Nie mogę otworzyć tego pliku.".to_string())?;
            let text = decode(&bytes).ok_or_else(|| format!("„{name}” to nie tekst — tego nie przeczytam (czytam tekst, kod, PDF, .docx i obrazy)."))?;
            let (text, truncated) = cut(text);
            Ok(json!({ "title": name, "text": text, "truncated": truncated || meta.len() > bytes.len() as u64 }))
        }
    }
}

/// What a folder holds, newest first: one line each.
fn listing(folder: &Path) -> Result<String, String> {
    let mut entries: Vec<(String, bool, Option<u64>, Option<std::time::SystemTime>)> = std::fs::read_dir(folder)
        .map_err(|_| "Nie mogę otworzyć tego folderu.".to_string())?
        .filter_map(Result::ok)
        .map(|e| {
            let meta = e.metadata().ok();
            let dir = meta.as_ref().is_some_and(|m| m.is_dir());
            (e.file_name().to_string_lossy().into_owned(), dir, meta.as_ref().filter(|m| m.is_file()).map(|m| m.len()), meta.and_then(|m| m.modified().ok()))
        })
        .collect();
    entries.sort_by(|a, b| b.3.cmp(&a.3));
    let total = entries.len();
    let lines: Vec<String> = entries
        .into_iter()
        .take(200)
        .map(|(name, dir, size, modified)| {
            let when = modified.map(|m| chrono::DateTime::<chrono::Local>::from(m).format("%Y-%m-%d %H:%M").to_string()).unwrap_or_default();
            match (dir, size) {
                (true, _) => format!("{name}\\  ({when})"),
                (false, Some(size)) => format!("{name}  ({} kB, {when})", (size / 1024).max(1)),
                _ => format!("{name}  ({when})"),
            }
        })
        .collect();
    Ok(format!("{} ({total} items, newest first):\n{}", folder.display(), lines.join("\n")))
}

/// Text from bytes: UTF-8 (or UTF-16 with its mark); `None` for a binary file.
fn decode(bytes: &[u8]) -> Option<String> {
    if let Some(rest) = bytes.strip_prefix(&[0xFF, 0xFE]) {
        let units: Vec<u16> = rest.chunks_exact(2).map(|p| u16::from_le_bytes([p[0], p[1]])).collect();
        return Some(String::from_utf16_lossy(&units));
    }
    let head = &bytes[..bytes.len().min(8000)];
    if head.contains(&0) {
        return None;
    }
    let text = String::from_utf8_lossy(bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes)).into_owned();
    // Mostly replacement characters: some other binary format.
    let bad = text.chars().take(4000).filter(|&c| c == '\u{FFFD}').count();
    (bad < 40).then_some(text)
}

fn cut(text: String) -> (String, bool) {
    match text.char_indices().nth(MOST_TEXT) {
        Some((at, _)) => (text[..at].to_string(), true),
        None => (text, false),
    }
}

/// A Word document's text: `word/document.xml` out of the zip (found through
/// its central directory, which is right even when the local headers leave
/// the sizes out), paragraphs as lines.
fn docx_text(zip: &[u8]) -> Option<String> {
    let u16_at = |at: usize| zip.get(at..at + 2).map(|b| u16::from_le_bytes([b[0], b[1]]) as usize);
    let u32_at = |at: usize| zip.get(at..at + 4).map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]) as usize);
    // The end record is in the last 64 kB (its comment is at most that long).
    let from = zip.len().saturating_sub(22 + 65_535);
    let end = (from..zip.len().saturating_sub(21)).rev().find(|&at| u32_at(at) == Some(0x0605_4b50))?;
    let (count, mut at) = (u16_at(end + 10)?, u32_at(end + 16)?);
    for _ in 0..count {
        if u32_at(at)? != 0x0201_4b50 {
            return None;
        }
        let (method, packed, name_len, extra_len, comment_len, local) =
            (u16_at(at + 10)?, u32_at(at + 20)?, u16_at(at + 28)?, u16_at(at + 30)?, u16_at(at + 32)?, u32_at(at + 42)?);
        let name = zip.get(at + 46..at + 46 + name_len)?;
        if name == b"word/document.xml" {
            let start = local + 30 + u16_at(local + 26)? + u16_at(local + 28)?;
            let data = zip.get(start..start + packed)?;
            let xml = match method {
                0 => String::from_utf8_lossy(data).into_owned(),
                8 => {
                    let mut out = String::new();
                    flate2::read::DeflateDecoder::new(data).take(30_000_000).read_to_string(&mut out).ok()?;
                    out
                }
                _ => return None,
            };
            return Some(word_xml_text(&xml));
        }
        at += 46 + name_len + extra_len + comment_len;
    }
    None
}

/// WordprocessingML to plain text: paragraphs and breaks as new lines, tabs
/// kept, every other tag dropped, entities read.
fn word_xml_text(xml: &str) -> String {
    let mut out = String::with_capacity(xml.len() / 4);
    let mut rest = xml;
    while let Some(open) = rest.find('<') {
        out.push_str(&unescape(&rest[..open]));
        let Some(close) = rest[open..].find('>') else { break };
        let tag = &rest[open + 1..open + close];
        match tag.split(|c: char| c.is_whitespace() || c == '/').next().unwrap_or("") {
            "" if tag.trim_end() == "/w:p" => out.push('\n'),
            "w:br" | "w:cr" => out.push('\n'),
            "w:tab" => out.push('\t'),
            _ => {}
        }
        rest = &rest[open + close + 1..];
    }
    out.lines().map(str::trim_end).collect::<Vec<_>>().join("\n").trim().to_string()
}

fn unescape(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    s.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'").replace("&amp;", "&")
}

/* ── The clipboard ────────────────────────────────────────────────────── */

fn clipboard() -> Result<Value, String> {
    let files = crate::shelf::clipboard::get_files();
    if !files.is_empty() {
        return Ok(json!({ "files": files.into_iter().take(60).collect::<Vec<_>>() }));
    }
    match crate::shelf::clipboard::get_text() {
        Some(text) if !text.trim().is_empty() => {
            let (text, truncated) = cut(text);
            Ok(json!({ "text": text, "truncated": truncated }))
        }
        _ => Ok(json!({ "text": null })),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// On a real desktop: `EYES_OUT=<folder> cargo test --lib live_eyes -- --ignored --nocapture`
    /// writes the screen picture there and prints a search and a read.
    #[test]
    #[ignore]
    fn live_eyes() {
        let out = std::path::PathBuf::from(std::env::var("EYES_OUT").expect("EYES_OUT"));
        let shot = capture().expect("a screenshot");
        let data = base64::engine::general_purpose::STANDARD.decode(shot["image"]["data"].as_str().unwrap()).unwrap();
        std::fs::write(out.join("eyes-screen.jpg"), &data).unwrap();
        println!("screen: {} kB, window: {}", data.len() / 1024, shot["title"]);
        let found = find("ext:pdf", "file", true).expect("a search");
        println!("newest pdfs: {}", serde_json::to_string_pretty(&found["hits"].as_array().unwrap()[..3.min(found["hits"].as_array().unwrap().len())]).unwrap());
        if let Some(docx) = find("ext:docx", "file", true).ok().and_then(|f| f["hits"][0]["path"].as_str().map(String::from)) {
            let read = read(&docx).expect("a docx read");
            println!("{docx}: {}", read["text"].as_str().unwrap_or("").chars().take(300).collect::<String>());
        }
        println!("folder: {}", read(out.to_str().unwrap()).unwrap()["text"].as_str().unwrap().chars().take(300).collect::<String>());
        println!("secret: {:?}", read("C:\\Users\\matko\\CODE\\_personal\\helm\\.env.local").err());
    }

    #[test]
    fn the_asks_parse() {
        let parse = |v: Value| serde_json::from_value::<Ask>(v).is_ok();
        assert!(parse(json!({ "do": "look", "ask": "a1" })));
        assert!(parse(json!({ "do": "find", "ask": "a1", "query": "faktura ext:pdf", "kind": "file", "newest": true })));
        assert!(parse(json!({ "do": "read", "ask": "a1", "path": "C:\\x.txt" })));
        assert!(!parse(json!({ "do": "look" })), "an ask without its id has nowhere to go");
    }

    #[test]
    fn secrets_are_not_read() {
        for path in ["C:\\Users\\m\\.ssh\\config", "C:\\code\\helm\\.env.local", "D:\\certs\\site.pfx", "C:\\Users\\m\\id_ed25519.pub", "C:\\vault\\hasla.kdbx"] {
            assert!(secret(Path::new(path)), "{path}");
        }
        for path in ["C:\\Faktury\\orlen.pdf", "C:\\code\\helm\\src\\env.ts", "C:\\notes\\keyboard.md"] {
            assert!(!secret(Path::new(path)), "{path}");
        }
    }

    #[test]
    fn text_is_told_from_binary() {
        assert_eq!(decode("zażółć".as_bytes()).as_deref(), Some("zażółć"));
        assert_eq!(decode(&[0xEF, 0xBB, 0xBF, b'h', b'i']).as_deref(), Some("hi"));
        assert_eq!(decode(&[0xFF, 0xFE, b'h', 0, b'i', 0]).as_deref(), Some("hi"));
        assert!(decode(&[0x89, b'P', b'N', b'G', 0, 0, 1]).is_none());
    }

    #[test]
    fn long_text_is_cut_at_a_letter() {
        let (text, cut_off) = cut("ż".repeat(MOST_TEXT + 5));
        assert!(cut_off);
        assert_eq!(text.chars().count(), MOST_TEXT);
    }

    #[test]
    fn word_paragraphs_become_lines() {
        let xml = r#"<w:document><w:body><w:p><w:r><w:t>Umowa &amp; aneks</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">Kwota:</w:t><w:tab/><w:t>1 200 zł</w:t></w:r></w:p></w:body></w:document>"#;
        assert_eq!(word_xml_text(xml), "Umowa & aneks\nKwota:\t1 200 zł");
    }

    #[test]
    fn a_docx_is_read_through_its_directory() {
        // A stored (uncompressed) one-entry zip, built by hand.
        let body = b"<w:p><w:t>Hej</w:t></w:p>";
        let name = b"word/document.xml";
        let mut zip = Vec::new();
        let le16 = |v: usize| (v as u16).to_le_bytes();
        let le32 = |v: usize| (v as u32).to_le_bytes();
        zip.extend_from_slice(&le32(0x0403_4b50));
        zip.extend_from_slice(&[0; 14]);
        zip.extend_from_slice(&le32(body.len()));
        zip.extend_from_slice(&le32(body.len()));
        zip.extend_from_slice(&le16(name.len()));
        zip.extend_from_slice(&le16(0));
        zip.extend_from_slice(name);
        zip.extend_from_slice(body);
        let directory = zip.len();
        zip.extend_from_slice(&le32(0x0201_4b50));
        zip.extend_from_slice(&[0; 6]);
        zip.extend_from_slice(&le16(0)); // method: stored
        zip.extend_from_slice(&[0; 8]);
        zip.extend_from_slice(&le32(body.len()));
        zip.extend_from_slice(&le32(body.len()));
        zip.extend_from_slice(&le16(name.len()));
        zip.extend_from_slice(&[0; 12]);
        zip.extend_from_slice(&le32(0)); // the local header's offset
        zip.extend_from_slice(name);
        let size = zip.len() - directory;
        zip.extend_from_slice(&le32(0x0605_4b50));
        zip.extend_from_slice(&[0; 6]);
        zip.extend_from_slice(&le16(1));
        zip.extend_from_slice(&le32(size));
        zip.extend_from_slice(&le32(directory));
        zip.extend_from_slice(&le16(0));
        assert_eq!(docx_text(&zip).as_deref(), Some("Hej"));
    }
}
