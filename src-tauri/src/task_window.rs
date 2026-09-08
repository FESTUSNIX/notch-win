use crate::{
    config,
    drag::Settings,
    win::{self, Edge},
};
use tauri::{AppHandle, Emitter, Manager};
use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};

static INPUT_ACTIVE: AtomicBool = AtomicBool::new(false);
static PREVIOUS_WINDOW: AtomicIsize = AtomicIsize::new(0);

pub fn input_active() -> bool { INPUT_ACTIVE.load(Ordering::SeqCst) }

#[tauri::command]
pub async fn set_task_input(window: tauri::WebviewWindow, active: bool) -> Result<(), String> {
    if window.label() != "tasks" { return Err("Inline entry belongs to the task notch.".into()); }
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, IsWindow, SetForegroundWindow};
    let previous = INPUT_ACTIVE.swap(active, Ordering::SeqCst);
    if active && !previous {
        let foreground = unsafe { GetForegroundWindow() };
        PREVIOUS_WINDOW.store(foreground.0 as isize, Ordering::SeqCst);
    }
    // The hover loop also uses harden, so its next cursor toggle preserves
    // this explicit, temporary keyboard-entry mode.
    win::harden(&window);
    if active {
        if let Err(error) = window.set_focus() {
            INPUT_ACTIVE.store(false, Ordering::SeqCst);
            win::harden(&window);
            return Err(error.to_string());
        }
    } else if previous {
        let previous = HWND(PREVIOUS_WINDOW.swap(0, Ordering::SeqCst) as *mut std::ffi::c_void);
        // Restore only if we still own focus. An outside click has already
        // chosen another app and must never be overridden by the blur handler.
        unsafe {
            if win::hwnd_of(&window) == Some(GetForegroundWindow()) && IsWindow(Some(previous)).as_bool() {
                let _ = SetForegroundWindow(previous);
            }
        }
    }
    Ok(())
}

#[derive(Clone, serde::Serialize)]
pub struct Placement {
    edge: Edge,
    visible: bool,
}

#[tauri::command]
pub fn get_task_placement(app: AppHandle) -> Placement {
    let state = app.state::<Settings>();
    let c = state.0.lock().unwrap();
    Placement {
        edge: c.task_edge,
        visible: c.task_visible,
    }
}

#[tauri::command]
pub fn set_task_placement(
    app: AppHandle,
    edge: Edge,
    visible: bool,
    reset: bool,
) -> Result<(), String> {
    let along = {
        let state = app.state::<Settings>();
        let mut c = state.0.lock().unwrap();
        c.task_edge = edge;
        c.task_visible = visible;
        if reset {
            c.task_along = 0.5;
        }
        config::save(&c);
        c.task_along
    };
    if let Some(window) = app.get_webview_window("tasks") {
        win::place(&window, edge, along);
        if visible {
            window.show()
        } else {
            window.hide()
        }
        .map_err(|e| e.to_string())?;
        win::harden(&window);
    }
    app.emit("tasks:placement", get_task_placement(app.clone()))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn open_task_editor(app: AppHandle) -> Result<(), String> {
    // WebView2 construction deadlocks inside synchronous commands on Windows.
    // Forms live in a focusable window; the glanceable notch keeps NOACTIVATE.
    let window = if let Some(w) = app.get_webview_window("task-editor") {
        w
    } else {
        tauri::WebviewWindowBuilder::new(
            &app,
            "task-editor",
            tauri::WebviewUrl::App("task-editor.html".into()),
        )
        .title("Codenotch · Tasks")
        .inner_size(460.0, 690.0)
        .min_inner_size(380.0, 480.0)
        .center()
        .build()
        .map_err(|e| e.to_string())?
    };
    window.show().map_err(|e| e.to_string())?;
    window.unminimize().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())
}

pub fn setup(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let window = app
        .get_webview_window("tasks")
        .expect("tasks declared in config");
    let (edge, along) = crate::drag::current_for(app, "tasks");
    win::place(&window, edge, along);
    window.set_ignore_cursor_events(true)?;
    if get_task_placement(app.clone()).visible {
        window.show()?;
    }
    win::harden(&window);
    Ok(())
}

/// Release-mode regression probe. Available only with explicit sample mode;
/// it exposes geometry/styles, never task data or credentials.
#[tauri::command]
pub fn task_window_diagnostics(app: AppHandle) -> Result<serde_json::Value, String> {
    if !crate::fixtures::enabled() {
        return Err("Window diagnostics require CODENOTCH_DEMO=1.".into());
    }
    use windows::Win32::UI::WindowsAndMessaging::{GetWindowLongPtrW, GWL_EXSTYLE};
    let mut result = serde_json::Map::new();
    for label in ["notch", "tasks", "task-editor"] {
        if let Some(window) = app.get_webview_window(label) {
            let hwnd = win::hwnd_of(&window).ok_or("No native window handle")?;
            let style = unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) } as u32;
            let rect_count = app
                .state::<crate::hover::InteractiveRects>()
                .0
                .lock()
                .unwrap()
                .get(label)
                .map_or(0, Vec::len);
            result.insert(
                label.into(),
                serde_json::json!({
                    "style":style, "rectCount":rect_count,
                    "focused":window.is_focused().unwrap_or(false),
                    "visible":window.is_visible().unwrap_or(false),
                    "position":window.outer_position().ok(), "size":window.outer_size().ok()
                }),
            );
        }
    }
    Ok(serde_json::Value::Object(result))
}
