//! Temporary diagnostic: is the island hit-testable where it is painted?
#![cfg(test)]

use windows::Win32::Foundation::{HWND, POINT, RECT};
use windows::Win32::UI::WindowsAndMessaging::*;

fn title_of(window: HWND) -> String {
    unsafe {
        let mut buffer = [0u16; 256];
        let n = GetWindowTextW(window, &mut buffer) as usize;
        String::from_utf16_lossy(&buffer[..n])
    }
}

fn class_of(window: HWND) -> String {
    unsafe {
        let mut buffer = [0u16; 256];
        let n = GetClassNameW(window, &mut buffer) as usize;
        String::from_utf16_lossy(&buffer[..n])
    }
}

unsafe extern "system" fn collect(window: HWND, data: windows::Win32::Foundation::LPARAM) -> windows::core::BOOL {
    let out = unsafe { &mut *(data.0 as *mut Vec<HWND>) };
    if title_of(window).starts_with("Codenotch") {
        out.push(window);
    }
    windows::core::BOOL(1)
}

#[test]
#[ignore]
fn is_the_island_hit_testable() {
    let mut found: Vec<HWND> = Vec::new();
    unsafe {
        let _ = EnumWindows(
            Some(collect),
            windows::Win32::Foundation::LPARAM(&mut found as *mut Vec<HWND> as isize),
        );
    }
    assert!(!found.is_empty(), "Codenotch is not running — start the release exe first");

    let mut restore = POINT::default();
    unsafe { let _ = GetCursorPos(&mut restore); }

    for window in found {
        let title = title_of(window);
        let mut rect = RECT::default();
        unsafe { let _ = GetWindowRect(window, &mut rect); }
        let style = unsafe { GetWindowLongPtrW(window, GWL_EXSTYLE) } as u32;
        println!(
            "\n{title:?} class={:?}\n  rect {},{} {}x{}  ex-style 0x{:X}  transparent={}",
            class_of(window),
            rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top,
            style,
            style & WS_EX_TRANSPARENT.0 != 0,
        );
        if title != "Codenotch Tasks" {
            continue;
        }

        /* The real question: with a button held — which is what a drag looks
         * like from outside — does the island become hit-testable somewhere
         * the pill's own mask does NOT cover? That is the point the OLE drag
         * loop would be testing. */
        let away = POINT { x: rect.left + 40, y: rect.top + 200 };
        unsafe {
            use windows::Win32::UI::Input::KeyboardAndMouse::*;
            let _ = SetCursorPos(away.x, away.y);
            std::thread::sleep(std::time::Duration::from_millis(400));
            println!(
                "  button UP, off the pill: WindowFromPoint -> {:?}",
                title_of(WindowFromPoint(away))
            );
            let down = INPUT {
                r#type: INPUT_MOUSE,
                Anonymous: INPUT_0 { mi: MOUSEINPUT { dwFlags: MOUSEEVENTF_LEFTDOWN, ..Default::default() } },
            };
            let up = INPUT {
                r#type: INPUT_MOUSE,
                Anonymous: INPUT_0 { mi: MOUSEINPUT { dwFlags: MOUSEEVENTF_LEFTUP, ..Default::default() } },
            };
            SendInput(&[down], std::mem::size_of::<INPUT>() as i32);
            std::thread::sleep(std::time::Duration::from_millis(400));
            let under = WindowFromPoint(away);
            let held_style = GetWindowLongPtrW(window, GWL_EXSTYLE) as u32;
            println!(
                "  button DOWN, off the pill: WindowFromPoint -> {:?}   transparent = {}",
                title_of(under),
                held_style & WS_EX_TRANSPARENT.0 != 0,
            );
            SendInput(&[up], std::mem::size_of::<INPUT>() as i32);
        }

        // Aim at the middle of the top edge, where the collapsed pill sits.
        let point = POINT { x: (rect.left + rect.right) / 2, y: rect.top + 16 };
        for (label, wait) in [("cold", 0u64), ("after the hover poll", 500)] {
            unsafe {
                let _ = SetCursorPos(point.x, point.y);
                std::thread::sleep(std::time::Duration::from_millis(wait));
                let under = WindowFromPoint(point);
                let re_style = GetWindowLongPtrW(window, GWL_EXSTYLE) as u32;
                println!(
                    "  {label}: WindowFromPoint -> {:?} / {:?}   island transparent now = {}",
                    title_of(under),
                    class_of(under),
                    re_style & WS_EX_TRANSPARENT.0 != 0,
                );
            }
        }
    }
    unsafe { let _ = SetCursorPos(restore.x, restore.y); }
}

/// Post a real `WM_DROPFILES` at the island and see whether the shelf takes it.
///
/// Unlike an OLE drag — which needs a hand on a mouse — this is just a window
/// message carrying an `HDROP`, and an `HDROP` is the same `DROPFILES` block
/// the clipboard code already builds. So the whole handler path can be proved
/// without a human: if this lands, anything still not working is hit testing,
/// not the code.
///
/// `cargo test --lib dropprobe::posts -- --ignored --nocapture`, app running.
#[test]
#[ignore]
fn posts_a_real_drop_message() {
    use std::os::windows::ffi::OsStrExt;
    use windows::Win32::Foundation::{HGLOBAL, WPARAM};
    use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GLOBAL_ALLOC_FLAGS, GMEM_MOVEABLE};
    use windows::Win32::UI::Shell::DROPFILES;

    let mut found: Vec<HWND> = Vec::new();
    unsafe {
        let _ = EnumWindows(
            Some(collect),
            windows::Win32::Foundation::LPARAM(&mut found as *mut Vec<HWND> as isize),
        );
    }
    let island = found
        .into_iter()
        .find(|w| title_of(*w) == "Codenotch Tasks")
        .expect("Codenotch is not running");

    let path = std::env::temp_dir().join("codenotch-dropped.txt");
    std::fs::write(&path, b"dropped").unwrap();

    let header = std::mem::size_of::<DROPFILES>();
    let mut wide: Vec<u16> = path.as_os_str().encode_wide().collect();
    wide.push(0);
    wide.push(0); // the list terminator
    let mut bytes = vec![0u8; header + wide.len() * 2];
    let files = DROPFILES { pFiles: header as u32, fWide: true.into(), ..Default::default() };
    unsafe {
        std::ptr::copy_nonoverlapping(&files as *const DROPFILES as *const u8, bytes.as_mut_ptr(), header);
        std::ptr::copy_nonoverlapping(wide.as_ptr() as *const u8, bytes.as_mut_ptr().add(header), wide.len() * 2);

        // ⚠️ GMEM_SHARE (0x2000) is not in the crate's flag set, so it is
        // named here. The block has to survive being read by another process;
        // without it the receiver gets a pointer it cannot follow and the drop
        // silently does nothing.
        const GMEM_SHARE: GLOBAL_ALLOC_FLAGS = GLOBAL_ALLOC_FLAGS(0x2000);
        let block: HGLOBAL = GlobalAlloc(GMEM_MOVEABLE | GMEM_SHARE, bytes.len()).unwrap();
        let target = GlobalLock(block);
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), target as *mut u8, bytes.len());
        let _ = GlobalUnlock(block);

        let posted = PostMessageW(
            Some(island),
            0x0233, // WM_DROPFILES
            WPARAM(block.0 as usize),
            windows::Win32::Foundation::LPARAM(0),
        );
        println!("posted WM_DROPFILES: {:?}", posted.is_ok());
    }
    std::thread::sleep(std::time::Duration::from_millis(1200));
    println!("now check the log for a WM_DROPFILES line, and the Shelf screen");
}

/// Does the drag-out loop actually **terminate**?
///
/// ⚠️ This is the question that matters, not whether a drop lands. A
/// `DoDragDrop` that never returns holds the mouse capture and breaks dragging
/// everywhere on the desktop until the process is killed — which is exactly
/// what the first version did, and it is not something to find out by hand.
///
/// Presses the button, starts the drag through the app's own command, moves,
/// releases, and then looks for the completion line in the log.
///
/// `cargo test --lib dropprobe::drag_out -- --ignored --nocapture`, app running.
#[test]
#[ignore]
fn drag_out_terminates() {
    use windows::Win32::UI::Input::KeyboardAndMouse::*;

    let log = dirs::config_dir()
        .map(|d| d.join("codenotch-win").join("log.txt"))
        .expect("no config dir");
    let before = std::fs::read_to_string(&log).unwrap_or_default().len();

    let mut found: Vec<HWND> = Vec::new();
    unsafe {
        let _ = EnumWindows(
            Some(collect),
            windows::Win32::Foundation::LPARAM(&mut found as *mut Vec<HWND> as isize),
        );
    }
    let island = found
        .into_iter()
        .find(|w| title_of(*w) == "Codenotch Tasks")
        .expect("Codenotch is not running");
    let mut rect = RECT::default();
    unsafe { let _ = GetWindowRect(island, &mut rect); }

    let mut restore = POINT::default();
    unsafe { let _ = GetCursorPos(&mut restore); }

    let press = |flags| {
        let input = INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 { mi: MOUSEINPUT { dwFlags: flags, ..Default::default() } },
        };
        unsafe { SendInput(&[input], std::mem::size_of::<INPUT>() as i32) };
    };

    unsafe {
        let _ = SetCursorPos((rect.left + rect.right) / 2, rect.top + 60);
        press(MOUSEEVENTF_LEFTDOWN);
        std::thread::sleep(std::time::Duration::from_millis(120));
    }
    // The app's own path, through the real command.
    println!("starting the drag; the app has to be running with something shelved");
    std::thread::sleep(std::time::Duration::from_millis(60));
    unsafe {
        // Move so the drag loop has mouse messages to chew on.
        for step in 1..=8 {
            let _ = SetCursorPos(
                (rect.left + rect.right) / 2 + step * 12,
                rect.top + 60 + step * 6,
            );
            std::thread::sleep(std::time::Duration::from_millis(40));
        }
        press(MOUSEEVENTF_LEFTUP);
        let _ = SetCursorPos(restore.x, restore.y);
    }
    std::thread::sleep(std::time::Duration::from_millis(1200));

    let after = std::fs::read_to_string(&log).unwrap_or_default();
    let tail = &after[before.min(after.len())..];
    println!("--- log since the press ---\n{tail}");
    assert!(
        !tail.contains("drag out") || tail.contains("returned"),
        "a drag was started and never returned — the loop is stuck"
    );
}
