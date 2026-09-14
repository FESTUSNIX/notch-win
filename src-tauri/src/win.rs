//! The Win32 half of the notch window.
//!
//! Three things AppKit gave the macOS panel for free, which have to be asked
//! for by hand here:
//!
//!   * `.nonactivatingPanel` -> `WS_EX_NOACTIVATE`. Glancing at your usage must
//!     never take focus off what you were doing.
//!   * a panel that is not an app -> `WS_EX_TOOLWINDOW`, which also keeps it
//!     out of Alt-Tab.
//!   * `level = .statusBar` -> `HWND_TOPMOST`.
//!
//! And one that is a direct analogue rather than a workaround: `visibleFrame`,
//! the usable area that excludes the Dock, is `MONITORINFO.rcWork`, which
//! excludes the taskbar and tracks it when it auto-hides or moves.

use std::ffi::c_void;

use tauri::{PhysicalPosition, WebviewWindow};
use windows::core::{BOOL, PCWSTR};
use windows::Win32::Foundation::{HWND, LPARAM, RECT, TRUE};
use windows::Win32::Graphics::Gdi::{
    EnumDisplayDevicesW, EnumDisplayMonitors, GetMonitorInfoW, MonitorFromWindow, DISPLAY_DEVICEW,
    HDC, HMONITOR, MONITORINFO, MONITORINFOEXW, MONITOR_DEFAULTTONEAREST,
};
// ⚠️ Not in `Graphics::Gdi` with the functions that take them — both of these
// live under `UI::WindowsAndMessaging`, which is not where anyone looks first.
use windows::Win32::UI::WindowsAndMessaging::{
    EDD_GET_DEVICE_INTERFACE_NAME, MONITORINFOF_PRIMARY,
};
// ⚠️ In `System::Threading`, not beside the other input functions.
use windows::Win32::System::Threading::AttachThreadInput;
use windows::Win32::UI::WindowsAndMessaging::{
    GetWindowLongPtrW, SetWindowLongPtrW, SetWindowPos, GWL_EXSTYLE, HWND_TOPMOST, SWP_NOACTIVATE,
    SWP_NOMOVE, SWP_NOSIZE, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Edge {
    Top,
    Bottom,
    Left,
    #[default]
    Right,
}

impl Edge {
    pub fn is_vertical(self) -> bool {
        matches!(self, Edge::Left | Edge::Right)
    }
}

/// Tauri and this crate may not agree on a `windows` version, and `HWND` has
/// changed shape between them. The raw handle is the one thing both spell the
/// same, so round-trip through it rather than through the type.
pub fn hwnd_of(window: &WebviewWindow) -> Option<HWND> {
    window.hwnd().ok().map(|h| HWND(h.0 as *mut c_void))
}

/// Extended styles AppKit would have implied.
///
/// ⚠️ **Must be re-applied after every `set_ignore_cursor_events` call**, which
/// is not belt-and-braces: tao implements click-through by rewriting the whole
/// extended-style word, so a toggle silently drops any bit set behind its back.
/// Measured — after one toggle the window read back `0xC0138`: topmost and
/// layered survived because tao sets those itself, while `WS_EX_NOACTIVATE` and
/// `WS_EX_TOOLWINDOW` were gone. The notch then steals focus on click and
/// reappears in Alt-Tab, with nothing in any log to say why.
pub fn harden(window: &WebviewWindow) {
    let Some(hwnd) = hwnd_of(window) else { return };

    unsafe {
        let current = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
        let next = if window.label() == "tasks" && crate::task_window::input_active() {
            (current | WS_EX_TOOLWINDOW.0) & !WS_EX_NOACTIVATE.0
        } else {
            current | WS_EX_NOACTIVATE.0 | WS_EX_TOOLWINDOW.0
        };
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, next as isize);

        // Topmost is set through SetWindowPos rather than the style bit —
        // the bit alone does not re-order an existing window.
        let _ = SetWindowPos(
            hwnd,
            Some(HWND_TOPMOST),
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        );
    }
}

/// The usable rectangle of the monitor the window is on, in physical pixels.
/// This is `NSScreen.visibleFrame`'s counterpart: it already excludes the
/// taskbar, and it changes when the taskbar hides, moves or resizes.
pub fn work_area(window: &WebviewWindow) -> Option<RECT> {
    let hwnd = hwnd_of(window)?;

    unsafe {
        let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if GetMonitorInfoW(monitor, &mut info).as_bool() {
            Some(info.rcWork)
        } else {
            None
        }
    }
}

/// Pin the window to one edge of the usable area, `along` of the way down (or
/// across) it. 0.5 is centred; a drag writes the ratio back to the config.
///
/// The window is always its *expanded* size — folding is drawn inside it, so
/// the OS window never resizes mid-animation. That is the same bargain the
/// AppKit panel makes, and it is why mouse events are masked per-rect instead.
/// Every placement goes through here, so no caller can pin a window to the
/// right edge of the wrong screen.
///
/// ⚠️ An unknown id falls back to the display the window is already on rather
/// than to the primary, and **never rewrites the setting**. A monitor that is
/// asleep, switched to another input, or behind a KVM is *absent*, not gone —
/// clearing the choice would move the notch home for good the first time the
/// screen blanked, and there would be nothing to say why.
pub fn place_on(window: &WebviewWindow, edge: Edge, along: f64, monitor: Option<&str>) {
    let work = monitor
        .and_then(|id| screens().into_iter().find(|s| s.id == id))
        .map(|s| s.work)
        .or_else(|| work_area(window));
    let Some(work) = work else { return };
    let Ok(size) = window.outer_size() else { return };

    let (w, h) = (size.width as i32, size.height as i32);
    let work_w = work.right - work.left;
    let work_h = work.bottom - work.top;
    let along = along.clamp(0.0, 1.0);

    // The ratio positions the window's *centre*, so a notch dragged to the top
    // ends flush with the work area rather than half off it.
    let slide = |span: i32, size: i32| -> i32 {
        let travel = (span - size).max(0);
        ((travel as f64) * along).round() as i32
    };

    let (x, y) = match edge {
        Edge::Top => (work.left + slide(work_w, w), work.top),
        Edge::Bottom => (work.left + slide(work_w, w), work.bottom - h),
        Edge::Left => (work.left, work.top + slide(work_h, h)),
        Edge::Right => (work.right - w, work.top + slide(work_h, h)),
    };

    let _ = window.set_position(PhysicalPosition::new(x, y));
}

/// Where the window currently sits along its edge, as the ratio `place` takes.
/// Inverting the same maths rather than a second formula, so a drag round-trips
/// to exactly the position it was dropped at.
pub fn along_ratio(window: &WebviewWindow, edge: Edge) -> Option<f64> {
    let work = work_area(window)?;
    let size = window.outer_size().ok()?;
    let position = window.outer_position().ok()?;

    let (span, extent, offset) = if edge.is_vertical() {
        (
            work.bottom - work.top,
            size.height as i32,
            position.y - work.top,
        )
    } else {
        (
            work.right - work.left,
            size.width as i32,
            position.x - work.left,
        )
    };

    let travel = (span - extent).max(0);
    if travel == 0 {
        return Some(0.5);
    }
    Some((offset as f64 / travel as f64).clamp(0.0, 1.0))
}

/* ── Which display ────────────────────────────────────────────────────────
 *
 * `MonitorFromWindow(MONITOR_DEFAULTTONEAREST)` answers "where is this window
 * now", which is the wrong question for a notch: the window is only ever where
 * it was last put, so on two monitors it lands on whichever one Windows chose
 * at launch and stays there. Placement needs a display named in the config, and
 * naming one needs an identifier that survives a reboot.
 */

/// Windows' path separator.
const SEP: char = '\\';

/// One attached display.
#[derive(Clone, Debug, serde::Serialize)]
pub struct Screen {
    /// ⚠️ **Not `\.\DISPLAY1`.** That is a slot on the adapter, not a panel:
    /// unplugging one monitor renumbers the rest, so a saved position would
    /// silently reappear on the wrong screen. This is the monitor's device
    /// *interface* path, which carries the panel's own hardware id.
    pub id: String,
    /// What the menu shows: the panel's own name out of its EDID where the
    /// driver publishes one, and something honest where it does not.
    pub name: String,
    /// The display's origin on the virtual desktop. Negative on a screen to the
    /// left of the primary one, which is why placement never assumes 0,0.
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    pub primary: bool,
    #[serde(skip)]
    pub work: RECT,
}

/// A fixed-width, NUL-padded Win32 string field.
fn from_wide(field: &[u16]) -> String {
    let end = field.iter().position(|&c| c == 0).unwrap_or(field.len());
    String::from_utf16_lossy(&field[..end])
}

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

/// `EnumDisplayDevicesW` on an adapter output, once for each of the two things
/// it can be asked for: the driver's own description, and — with the interface
/// flag — the panel's stable device path.
fn display_device(adapter: &str, interface: bool) -> Option<DISPLAY_DEVICEW> {
    let mut device = DISPLAY_DEVICEW {
        cb: std::mem::size_of::<DISPLAY_DEVICEW>() as u32,
        ..Default::default()
    };
    let name = wide(adapter);
    let flags = if interface {
        EDD_GET_DEVICE_INTERFACE_NAME
    } else {
        0
    };
    let ok = unsafe { EnumDisplayDevicesW(PCWSTR(name.as_ptr()), 0, &mut device, flags) };
    ok.as_bool().then_some(device)
}

/// The panel's model name, out of the EDID the driver cached in the registry.
///
/// ⚠️ Windows itself will not tell you this. `EnumDisplayDevicesW` reports the
/// *driver's* description, which on every ordinary monitor is the string
/// "Generic PnP Monitor" — three displays would all be called the same thing,
/// which is useless in a menu whose whole job is telling them apart. The name
/// the user reads on the box is only in the EDID blob.
///
/// The device path `\?\DISPLAY#DELA1CE#5&1c1e1b1a&0&UID4353#{guid}` is the
/// registry key `…\Enum\DISPLAY\DELA1CE\5&1c1e1b1a&0&UID4353` with `#` for `\`,
/// which is where that blob is kept.
fn panel_name(device_path: &str) -> Option<String> {
    let value = windows_registry::LOCAL_MACHINE
        .open(&registry_key(device_path)?)
        .ok()?
        .get_value("EDID")
        .ok()?;
    edid_name(&value)
}

/// Where the driver cached this display's EDID.
///
/// ⚠️ **Do not write this as "strip the prefix".** The obvious spelling
/// -- trimming the literal device-interface prefix off the front -- left the
/// prefix embedded in the middle of the key, `RegOpenKeyEx` answered "file not
/// found", and the `.ok()?` swallowed it: every monitor fell through to the
/// driver's own description, which on most panels is the string "Generic PnP
/// Monitor". It looked right on the one display whose driver happened to
/// publish a real name, which is exactly why it went unnoticed.
///
/// The last path segment of the first field is the enumerator whatever the
/// prefix looks like, so nothing here depends on its spelling.
fn registry_key(device_path: &str) -> Option<String> {
    let parts: Vec<&str> = device_path.split('#').collect();
    if parts.len() < 3 {
        return None;
    }
    let enumerator = parts[0].rsplit(['/', SEP]).next().filter(|s| !s.is_empty())?;
    Some(format!(
        "SYSTEM{S}CurrentControlSet{S}Enum{S}{enumerator}{S}{}{S}{}{S}Device Parameters",
        parts[1],
        parts[2],
        S = SEP,
    ))
}

/// The monitor-name descriptor out of a raw EDID block.
///
/// The four 18-byte descriptors start at 54; one tagged `0xFC` holds the name,
/// padded with `0x0A` and spaces. Kept separate from the registry read so it
/// can be tested without a monitor attached.
pub fn edid_name(edid: &[u8]) -> Option<String> {
    for base in [54usize, 72, 90, 108] {
        let Some(block) = edid.get(base..base + 18) else {
            continue;
        };
        if block[0..3] != [0, 0, 0] || block[3] != 0xFC {
            continue;
        }
        let text: String = block[5..18]
            .iter()
            .take_while(|&&byte| byte != 0x0A && byte != 0)
            .map(|&byte| byte as char)
            .collect();
        let text = text.trim().to_string();
        if !text.is_empty() {
            return Some(text);
        }
    }
    None
}

unsafe extern "system" fn push_screen(
    monitor: HMONITOR,
    _dc: HDC,
    _clip: *mut RECT,
    data: LPARAM,
) -> BOOL {
    let out = unsafe { &mut *(data.0 as *mut Vec<Screen>) };
    let mut info = MONITORINFOEXW {
        monitorInfo: MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFOEXW>() as u32,
            ..Default::default()
        },
        ..Default::default()
    };
    let ok = unsafe {
        GetMonitorInfoW(
            monitor,
            &mut info as *mut MONITORINFOEXW as *mut MONITORINFO,
        )
    };
    if !ok.as_bool() {
        return TRUE;
    }

    let adapter = from_wide(&info.szDevice);
    let path = display_device(&adapter, true)
        .map(|d| from_wide(&d.DeviceID))
        .filter(|id| !id.is_empty());
    let described = display_device(&adapter, false)
        .map(|d| from_wide(&d.DeviceString))
        .filter(|name| !name.is_empty() && name != "Generic PnP Monitor");
    let bounds = info.monitorInfo.rcMonitor;

    out.push(Screen {
        name: path
            .as_deref()
            .and_then(panel_name)
            .or(described)
            .unwrap_or_default(),
        // The adapter slot is the last resort rather than the first choice, so
        // a display with no readable EDID is still addressable.
        id: path.unwrap_or(adapter),
        x: bounds.left,
        y: bounds.top,
        width: bounds.right - bounds.left,
        height: bounds.bottom - bounds.top,
        primary: info.monitorInfo.dwFlags & MONITORINFOF_PRIMARY != 0,
        work: info.monitorInfo.rcWork,
    });
    TRUE
}

/// Every attached display, left to right — the order the desktop is laid out
/// in, so "the next display" means what someone looking at their desk means.
pub fn screens() -> Vec<Screen> {
    let mut out: Vec<Screen> = Vec::new();
    unsafe {
        let _ = EnumDisplayMonitors(
            None,
            None,
            Some(push_screen),
            LPARAM(&mut out as *mut Vec<Screen> as isize),
        );
    }
    out.sort_by_key(|screen| screen.work.left);
    for (index, screen) in out.iter_mut().enumerate() {
        if screen.name.is_empty() {
            screen.name = format!("Display {}", index + 1);
        }
    }
    out
}

/// The display a window is sitting on right now, matched back to the list by
/// its work area — which is unique per monitor and needs no second Win32 call.
pub fn screen_of(window: &WebviewWindow) -> Option<Screen> {
    let work = work_area(window)?;
    screens().into_iter().find(|screen| screen.work == work)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A real EDID from a DELL U2724D, cut to the descriptor blocks. Only the
    /// tag and the padding matter, so the rest is zeroed.
    fn edid_with_name(name: &[u8]) -> Vec<u8> {
        let mut edid = vec![0u8; 128];
        // Block one is the preferred timing on a real panel; the name is in a
        // later block, which is why all four have to be walked.
        edid[54] = 0x2f;
        edid[72..75].copy_from_slice(&[0, 0, 0]);
        edid[75] = 0xFC;
        for (i, byte) in name.iter().enumerate() {
            edid[77 + i] = *byte;
        }
        edid
    }

    #[test]
    fn reads_the_panel_name_out_of_a_later_descriptor() {
        let edid = edid_with_name(b"DELL U2724D\x0a ");
        assert_eq!(edid_name(&edid).as_deref(), Some("DELL U2724D"));
    }

    #[test]
    fn a_truncated_blob_is_none_rather_than_a_panic() {
        // Some drivers cache a short or empty EDID. Indexing it blind is a
        // panic in a background thread, which takes the display watcher with it.
        assert_eq!(edid_name(&[]), None);
        assert_eq!(edid_name(&[0u8; 60]), None);
        assert_eq!(edid_name(&[0u8; 128]), None);
    }

    /// Run with `cargo test --lib win -- --ignored --nocapture` to see what
    /// this machine actually reports. There is nothing to assert: the answer
    /// depends on which monitors are plugged in.
    #[test]
    #[ignore]
    fn lists_this_machine_s_displays() {
        for screen in screens() {
            println!(
                "{:<20} {}x{} primary={} id={}",
                screen.name, screen.width, screen.height, screen.primary, screen.id
            );
        }
    }
}

#[cfg(test)]
mod key_tests {
    use super::*;

    #[test]
    fn derives_the_edid_key_from_a_real_device_path() {
        assert_eq!(
            registry_key(r"\\?\DISPLAY#DEL42D3#5&243220e9&0&UID28932#{e6f07b5f-ee97-4a90-b076-33f57bf4eaa7}").as_deref(),
            Some(r"SYSTEM\CurrentControlSet\Enum\DISPLAY\DEL42D3\5&243220e9&0&UID28932\Device Parameters")
        );
    }

    #[test]
    fn too_few_fields_is_none_rather_than_a_key_that_cannot_open() {
        assert_eq!(registry_key("MONITOR"), None);
        assert_eq!(registry_key("DISPLAY#DEL42D3"), None);
    }
}

/* ── Raising the window a process is running in ───────────────────────────
 *
 * For "this session is waiting for you" to be worth anything, it has to be
 * possible to get *to* it. Two Win32 problems stand between a pid and a raised
 * window, and both of them fail quietly.
 */

/// The parent of every process on the machine, in one pass.
fn parents() -> std::collections::HashMap<u32, u32> {
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    let mut out = std::collections::HashMap::new();
    unsafe {
        let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
            return out;
        };
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        if Process32FirstW(snapshot, &mut entry).is_ok() {
            loop {
                out.insert(entry.th32ProcessID, entry.th32ParentProcessID);
                if Process32NextW(snapshot, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = windows::Win32::Foundation::CloseHandle(snapshot);
    }
    out
}

unsafe extern "system" fn push_window(window: HWND, data: LPARAM) -> BOOL {
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowTextLengthW, GetWindowThreadProcessId, IsWindowVisible,
    };
    let out = unsafe { &mut *(data.0 as *mut Vec<(HWND, u32)>) };
    unsafe {
        // A titleless or hidden top-level window is a message sink, a tray
        // host or a tooltip — raising one puts nothing on screen.
        if !IsWindowVisible(window).as_bool() || GetWindowTextLengthW(window) == 0 {
            return TRUE;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(window, Some(&mut pid));
        if pid != 0 {
            out.push((window, pid));
        }
    }
    TRUE
}

fn visible_windows() -> Vec<(HWND, u32)> {
    use windows::Win32::UI::WindowsAndMessaging::EnumWindows;
    let mut out: Vec<(HWND, u32)> = Vec::new();
    unsafe {
        let _ = EnumWindows(Some(push_window), LPARAM(&mut out as *mut Vec<(HWND, u32)> as isize));
    }
    out
}

/// Bring the window a process is running in to the front.
///
/// ⚠️ **The pid owns no window.** Claude Code is a console program: its node
/// process draws nothing, and the window is its terminal's — Windows Terminal,
/// VS Code, conhost — which is an *ancestor*, not the process itself.
/// `GetWindowThreadProcessId` on that window answers with the terminal's pid,
/// so matching the session's own pid against window owners finds nothing at
/// all. The process tree is walked upward until an ancestor is found that does
/// own a visible window.
///
/// ⚠️ **And `SetForegroundWindow` refuses silently.** It returns `FALSE`, with
/// no error, for a process that does not already own the foreground — and this
/// one never does: the notch is `WS_EX_NOACTIVATE` precisely so that it cannot.
/// Attaching this thread's input queue to the current foreground thread for the
/// duration of the call is the documented way around it.
///
/// Honest limitation: this raises the *window*, not the tab. One Windows
/// Terminal window hosts many sessions and there is no supported way to select
/// one of its tabs from outside.
pub fn raise_process(pid: u32) -> bool {

    let windows = visible_windows();
    let tree = parents();

    // Up the tree, but not for ever: a cycle in the parent map, or a pid whose
    // parent has been recycled into one of its own descendants, would loop.
    let mut candidate = pid;
    let mut target = None;
    for _ in 0..8 {
        if let Some((window, _)) = windows.iter().find(|(_, owner)| *owner == candidate) {
            target = Some(*window);
            break;
        }
        match tree.get(&candidate) {
            Some(parent) if *parent != 0 && *parent != candidate => candidate = *parent,
            _ => break,
        }
    }
    let Some(window) = target else { return false };

    force_foreground(window)
}

/// Bring a window to the front and give it the keyboard, past the rule that
/// normally forbids it.
///
/// ⚠️ **`SetForegroundWindow` refuses silently.** It returns `FALSE`, with no
/// error, for a process that does not already own the foreground — and this one
/// never does: both windows are `WS_EX_NOACTIVATE` precisely so that glancing
/// at them cannot steal focus. Attaching this thread's input queue to the
/// current foreground thread for the duration of the call is the documented way
/// around it.
///
/// This is why the palette could not be typed into. `WebviewWindow::set_focus`
/// is `SetForegroundWindow` underneath, so opening the palette from a **global
/// shortcut** — the one case where another app owns the foreground — quietly
/// did nothing, while opening it by clicking the header worked. Two paths to
/// the same surface, one of them broken, and no error on either.
pub fn force_foreground(window: HWND) -> bool {
    use windows::Win32::System::Threading::GetCurrentThreadId;
    use windows::Win32::UI::Input::KeyboardAndMouse::SetFocus;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowThreadProcessId, IsIconic, SetForegroundWindow, ShowWindow,
        SW_RESTORE,
    };
    unsafe {
        if IsIconic(window).as_bool() {
            let _ = ShowWindow(window, SW_RESTORE);
        }
        let foreground = GetForegroundWindow();
        if foreground == window {
            let _ = SetFocus(Some(window));
            return true;
        }
        let mine = GetCurrentThreadId();
        let theirs = GetWindowThreadProcessId(foreground, None);
        let attached = theirs != 0
            && theirs != mine
            && AttachThreadInput(mine, theirs, true).as_bool();
        let raised = SetForegroundWindow(window).as_bool();
        if raised {
            let _ = SetFocus(Some(window));
        }
        if attached {
            let _ = AttachThreadInput(mine, theirs, false);
        }
        raised
    }
}
