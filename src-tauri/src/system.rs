//! The machine's own controls: volume, screen brightness, Bluetooth.
//!
//! Everything here except brightness is documented Win32. Brightness goes over
//! DDC/CI to whatever the monitor will accept, which plenty of desktop monitors
//! refuse outright — so it is offered only when a monitor actually answers, and
//! never faked.
//!
//! ⚠️ Same threading rules as media.rs and audio.rs: COM per thread, blocking
//! calls, so commands hop onto their own thread.

use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use windows::Win32::Devices::Bluetooth::{
    BluetoothFindDeviceClose, BluetoothFindFirstDevice, BluetoothFindNextDevice,
    BLUETOOTH_DEVICE_INFO, BLUETOOTH_DEVICE_SEARCH_PARAMS,
};
use windows::Win32::Devices::Display::{
    DestroyPhysicalMonitors, GetMonitorBrightness, GetNumberOfPhysicalMonitorsFromHMONITOR,
    GetPhysicalMonitorsFromHMONITOR, SetMonitorBrightness, PHYSICAL_MONITOR,
};
use windows::Win32::Foundation::POINT;
use windows::Win32::Graphics::Gdi::{MonitorFromPoint, MONITOR_DEFAULTTOPRIMARY};
use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
use windows::Win32::Media::Audio::{eConsole, eRender, IMMDeviceEnumerator, MMDeviceEnumerator};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED};
use windows::core::w;
use windows::Win32::Foundation::{ERROR_BUFFER_OVERFLOW, FILETIME};
use windows::Win32::NetworkManagement::IpHelper::{
    GetAdaptersAddresses, GAA_FLAG_SKIP_ANYCAST, GAA_FLAG_SKIP_DNS_SERVER,
    GAA_FLAG_SKIP_MULTICAST, GAA_FLAG_SKIP_UNICAST, IP_ADAPTER_ADDRESSES_LH,
};
use windows::Win32::NetworkManagement::Ndis::IfOperStatusUp;
use windows::Win32::Networking::WinSock::AF_UNSPEC;
use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
use windows::Win32::System::Shutdown::LockWorkStation;
use windows::Win32::System::SystemInformation::{
    GetTickCount64, GlobalMemoryStatusEx, MEMORYSTATUSEX,
};
use windows::Win32::System::Threading::GetSystemTimes;

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BluetoothDevice {
    pub name: String,
    pub connected: bool,
    /// Windows keeps pairings forever; the list is worth showing anyway, so
    /// this separates "paired but off" from "not there".
    pub paired: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemState {
    /// 0..100, or -1 when there is no endpoint to ask.
    pub volume: i32,
    pub muted: bool,
    /// 0..100, or -1 when no monitor answered over DDC/CI.
    pub brightness: i32,
    pub bluetooth: Vec<BluetoothDevice>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Machine {
    /// Percentages, or -1 where the figure could not be taken.
    pub cpu: i32,
    pub memory: i32,
    pub disk_used: i32,
    pub disk_free: u64,
    /// The friendly name of whichever adapter is actually up.
    pub network: String,
    pub uptime: u64,
}

#[derive(Default)]
pub struct Watched(Mutex<Vec<String>>);

fn enter_apartment() {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
}

fn endpoint_volume() -> Result<IAudioEndpointVolume, String> {
    unsafe {
        let enumerator: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
            .map_err(|_| "Windows would not start the audio device service.".to_string())?;
        let device = enumerator
            .GetDefaultAudioEndpoint(eRender, eConsole)
            .map_err(|_| "There is no audio output to control.".to_string())?;
        device
            .Activate::<IAudioEndpointVolume>(CLSCTX_ALL, None)
            .map_err(|_| "Windows refused the volume control.".to_string())
    }
}

fn read_volume() -> (i32, bool) {
    match endpoint_volume() {
        Ok(volume) => unsafe {
            let level = volume.GetMasterVolumeLevelScalar().unwrap_or(0.0);
            let muted = volume.GetMute().map(|m| m.as_bool()).unwrap_or(false);
            ((level * 100.0).round() as i32, muted)
        },
        Err(_) => (-1, false),
    }
}

/// Brightness of the primary monitor over DDC/CI.
///
/// ⚠️ Each call talks to the monitor over the display cable and can take tens
/// of milliseconds, or hang for a second on a panel that half-implements the
/// protocol. It is read once when the screen is opened, never polled.
fn primary_monitors() -> Vec<PHYSICAL_MONITOR> {
    unsafe {
        let monitor = MonitorFromPoint(POINT { x: 0, y: 0 }, MONITOR_DEFAULTTOPRIMARY);
        let mut count = 0u32;
        if GetNumberOfPhysicalMonitorsFromHMONITOR(monitor, &mut count).is_err() || count == 0 {
            return Vec::new();
        }
        let mut monitors = vec![PHYSICAL_MONITOR::default(); count as usize];
        if GetPhysicalMonitorsFromHMONITOR(monitor, &mut monitors).is_err() {
            return Vec::new();
        }
        monitors
    }
}

fn read_brightness() -> i32 {
    let monitors = primary_monitors();
    if monitors.is_empty() {
        return -1;
    }
    let mut result = -1;
    unsafe {
        let (mut min, mut current, mut max) = (0u32, 0u32, 0u32);
        // ⚠️ These two return a raw BOOL, not a Result like most of the crate.
        if GetMonitorBrightness(monitors[0].hPhysicalMonitor, &mut min, &mut current, &mut max) != 0
            && max > min
        {
            result = (((current - min) as f64 / (max - min) as f64) * 100.0).round() as i32;
        }
        let _ = DestroyPhysicalMonitors(&monitors);
    }
    result
}

fn read_bluetooth() -> Vec<BluetoothDevice> {
    let mut devices = Vec::new();
    unsafe {
        let params = BLUETOOTH_DEVICE_SEARCH_PARAMS {
            dwSize: std::mem::size_of::<BLUETOOTH_DEVICE_SEARCH_PARAMS>() as u32,
            fReturnAuthenticated: true.into(),
            fReturnRemembered: true.into(),
            fReturnConnected: true.into(),
            fReturnUnknown: false.into(),
            fIssueInquiry: false.into(),   // never scan: it takes seconds and lights up the radio
            cTimeoutMultiplier: 0,
            ..Default::default()
        };
        let mut info = BLUETOOTH_DEVICE_INFO {
            dwSize: std::mem::size_of::<BLUETOOTH_DEVICE_INFO>() as u32,
            ..Default::default()
        };
        let Ok(search) = BluetoothFindFirstDevice(&params, &mut info) else {
            return devices;
        };
        loop {
            let name = String::from_utf16_lossy(&info.szName)
                .trim_end_matches('\0')
                .trim()
                .to_string();
            if !name.is_empty() {
                devices.push(BluetoothDevice {
                    name,
                    connected: info.fConnected.as_bool(),
                    paired: info.fAuthenticated.as_bool(),
                });
            }
            info = BLUETOOTH_DEVICE_INFO {
                dwSize: std::mem::size_of::<BLUETOOTH_DEVICE_INFO>() as u32,
                ..Default::default()
            };
            if BluetoothFindNextDevice(search, &mut info).is_err() {
                break;
            }
        }
        let _ = BluetoothFindDeviceClose(search);
    }
    // Connected first, then by name: the list exists to answer "what is on".
    devices.sort_by(|a, b| b.connected.cmp(&a.connected).then_with(|| a.name.cmp(&b.name)));
    devices
}

fn read_all(with_brightness: bool) -> SystemState {
    let (volume, muted) = read_volume();
    SystemState {
        volume,
        muted,
        brightness: if with_brightness { read_brightness() } else { -1 },
        bluetooth: read_bluetooth(),
    }
}

fn on_thread<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> tokio::sync::oneshot::Receiver<T> {
    let (send, receive) = tokio::sync::oneshot::channel();
    std::thread::spawn(move || {
        enter_apartment();
        let _ = send.send(work());
    });
    receive
}

#[tauri::command]
pub async fn get_system() -> Result<SystemState, String> {
    on_thread(|| read_all(true))
        .await
        .map_err(|_| "The system thread stopped.".to_string())
}

#[tauri::command]
pub async fn set_volume(level: i32, muted: Option<bool>) -> Result<(), String> {
    let level = level.clamp(0, 100);
    on_thread(move || -> Result<(), String> {
        let volume = endpoint_volume()?;
        unsafe {
            if let Some(muted) = muted {
                volume
                    .SetMute(muted, std::ptr::null())
                    .map_err(|_| "Windows refused the mute.".to_string())?;
            }
            volume
                .SetMasterVolumeLevelScalar(level as f32 / 100.0, std::ptr::null())
                .map_err(|_| "Windows refused the volume change.".to_string())
        }
    })
    .await
    .map_err(|_| "The system thread stopped.".to_string())?
}

#[tauri::command]
pub async fn set_brightness(level: i32) -> Result<(), String> {
    let level = level.clamp(0, 100) as u32;
    on_thread(move || -> Result<(), String> {
        let monitors = primary_monitors();
        if monitors.is_empty() {
            return Err("No monitor is reachable over DDC/CI.".into());
        }
        unsafe {
            let (mut min, mut current, mut max) = (0u32, 0u32, 0u32);
            let ok = GetMonitorBrightness(monitors[0].hPhysicalMonitor, &mut min, &mut current, &mut max);
            let result = if ok != 0 && max > min {
                let target = min + ((max - min) as f64 * (level as f64 / 100.0)).round() as u32;
                if SetMonitorBrightness(monitors[0].hPhysicalMonitor, target) != 0 {
                    Ok(())
                } else {
                    Err("This monitor will not take a brightness change.".to_string())
                }
            } else {
                Err("This monitor does not report brightness over DDC/CI.".into())
            };
            let _ = DestroyPhysicalMonitors(&monitors);
            result
        }
    })
    .await
    .map_err(|_| "The system thread stopped.".to_string())?
}

/// Watch for something connecting, so the island can say so.
///
/// ⚠️ Brightness is deliberately not read here. It is a DDC/CI round trip to
/// the panel; doing that every few seconds forever would be rude to the monitor
/// and is the sort of thing that shows up as a stutter nobody can explain.
pub fn spawn(app: AppHandle) {
    std::thread::spawn(move || {
        enter_apartment();
        // Seed from the first read so everything already connected at launch is
        // not announced as if it had just arrived.
        {
            let state = app.state::<Watched>();
            *state.0.lock().unwrap() = read_bluetooth()
                .into_iter()
                .filter(|d| d.connected)
                .map(|d| d.name)
                .collect();
        }
        loop {
            std::thread::sleep(Duration::from_secs(4));
            let connected: Vec<String> = read_bluetooth()
                .into_iter()
                .filter(|d| d.connected)
                .map(|d| d.name)
                .collect();
            let state = app.state::<Watched>();
            let arrived: Vec<String> = {
                let mut previous = state.0.lock().unwrap();
                let new: Vec<String> = connected
                    .iter()
                    .filter(|name| !previous.contains(name))
                    .cloned()
                    .collect();
                *previous = connected;
                new
            };
            for name in arrived {
                let _ = app.emit_to("tasks", "system:connected", &name);
            }
        }
    });
}

/* ── The machine itself ───────────────────────────────────────────────────
 * CPU, memory, disk, network, uptime. All documented Win32, all cheap enough
 * to read on demand — the expensive things on this screen are brightness and
 * Bluetooth, and neither of them is here.
 */

/// Previous CPU sample, so a percentage can be a delta rather than an average
/// since boot. ⚠️ `GetSystemTimes` returns cumulative totals: reading it once
/// and dividing gives the machine's lifetime average, which barely moves and
/// looks broken.
static LAST_CPU: Mutex<Option<(u64, u64, u64)>> = Mutex::new(None);

fn filetime(value: FILETIME) -> u64 {
    ((value.dwHighDateTime as u64) << 32) | value.dwLowDateTime as u64
}

fn cpu_percent() -> i32 {
    let (mut idle, mut kernel, mut user) = (FILETIME::default(), FILETIME::default(), FILETIME::default());
    unsafe {
        if GetSystemTimes(Some(&mut idle), Some(&mut kernel), Some(&mut user)).is_err() {
            return -1;
        }
    }
    let (idle, kernel, user) = (filetime(idle), filetime(kernel), filetime(user));
    let mut last = LAST_CPU.lock().unwrap();
    let previous = last.replace((idle, kernel, user));
    let Some((p_idle, p_kernel, p_user)) = previous else {
        // Nothing to compare against yet; the next read will have one.
        return -1;
    };
    // Kernel time already includes idle, so the total is kernel + user.
    let total = (kernel.saturating_sub(p_kernel)) + (user.saturating_sub(p_user));
    if total == 0 {
        return -1;
    }
    let busy = total.saturating_sub(idle.saturating_sub(p_idle));
    ((busy as f64 / total as f64) * 100.0).round() as i32
}

fn memory_percent() -> i32 {
    let mut status = MEMORYSTATUSEX {
        dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32,
        ..Default::default()
    };
    unsafe {
        if GlobalMemoryStatusEx(&mut status).is_err() {
            return -1;
        }
    }
    status.dwMemoryLoad as i32
}

/// Free space on the system drive, as a percentage and in bytes.
fn disk() -> (i32, u64) {
    let mut free = 0u64;
    let mut total = 0u64;
    unsafe {
        if GetDiskFreeSpaceExW(w!("C:\\"), None, Some(&mut total), Some(&mut free)).is_err()
            || total == 0
        {
            return (-1, 0);
        }
    }
    (((total - free) as f64 / total as f64 * 100.0).round() as i32, free)
}

/// The first adapter that is actually up and is not a loopback or tunnel.
///
/// ⚠️ Two calls on purpose: the first asks how much room the list needs, the
/// second fills it. Guessing a buffer size here is how this function ends up
/// silently truncating on a machine with a lot of virtual adapters — and a
/// developer's machine has Hyper-V, WSL and a VPN on it.
fn network() -> String {
    unsafe {
        let flags = GAA_FLAG_SKIP_UNICAST | GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST
            | GAA_FLAG_SKIP_DNS_SERVER;
        let mut size = 0u32;
        if GetAdaptersAddresses(AF_UNSPEC.0 as u32, flags, None, None, &mut size)
            != ERROR_BUFFER_OVERFLOW.0
        {
            return String::new();
        }
        let mut buffer = vec![0u8; size as usize];
        let head = buffer.as_mut_ptr() as *mut IP_ADAPTER_ADDRESSES_LH;
        if GetAdaptersAddresses(AF_UNSPEC.0 as u32, flags, None, Some(head), &mut size) != 0 {
            return String::new();
        }
        let mut adapter = head;
        while !adapter.is_null() {
            let entry = &*adapter;
            let kind = entry.IfType;
            let up = entry.OperStatus == IfOperStatusUp;
            // 24 is loopback, 131 a tunnel; neither is "the network you are on".
            if up && kind != 24 && kind != 131 && !entry.FriendlyName.is_null() {
                let name = entry.FriendlyName.to_string().unwrap_or_default();
                if !name.is_empty() {
                    return name;
                }
            }
            adapter = entry.Next;
        }
    }
    String::new()
}

fn uptime_seconds() -> u64 {
    unsafe { GetTickCount64() / 1000 }
}

#[tauri::command]
pub async fn get_machine() -> Result<Machine, String> {
    on_thread(|| Machine {
        cpu: cpu_percent(),
        memory: memory_percent(),
        disk_used: disk().0,
        disk_free: disk().1,
        network: network(),
        uptime: uptime_seconds(),
    })
    .await
    .map_err(|_| "The system thread stopped.".to_string())
}

/// Lock the session. One call, and the only destructive-looking thing on this
/// screen — which is why it is a button that says so rather than a pip.
#[tauri::command]
pub fn lock_workstation() -> Result<(), String> {
    unsafe { LockWorkStation() }.map_err(|_| "Windows would not lock the session.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore]
    fn reads_the_machine_itself() {
        // Twice: the first CPU read has nothing to compare against.
        let _ = cpu_percent();
        std::thread::sleep(Duration::from_millis(300));
        println!(
            "cpu {}%  memory {}%  disk {}% used, {:.1} GB free
network {:?}  uptime {}h",
            cpu_percent(), memory_percent(), disk().0,
            disk().1 as f64 / 1e9, network(), uptime_seconds() / 3600
        );
    }

    /// A probe against this machine, not a unit test.
    /// `cargo test --lib system -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn reads_the_real_machine() {
        enter_apartment();
        let state = read_all(true);
        println!("volume {} muted {} brightness {}", state.volume, state.muted, state.brightness);
        for device in state.bluetooth {
            println!("  {} {}", if device.connected { "[on ]" } else { "[off]" }, device.name);
        }
    }
}
