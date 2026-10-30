//! Peek sources about the machine's own devices (batch 13): earbuds coming
//! and going, the microphone being muted, the laptop battery and its charger.
//!
//! Each is a small polling thread that emits one event to the island when
//! something CHANGES — never the state itself on a timer. The island turns them
//! into peeks (`src/peek-sources.ts`); whether a kind is shown at all is the
//! island's question (Settings → Peeks), not this file's.
//!
//! ⚠️ Polling, not callbacks, on purpose. Core Audio's endpoint callback and
//! the WinRT `DeviceWatcher` both need a COM object implemented here and kept
//! alive on the right apartment; a read every second or few is a handful of
//! cheap calls and cannot leak a registration when the default device changes.
//!
//! ⚠️ Every first read SEEDS. What is already connected, muted or unplugged at
//! launch is a fact, not news, and is never announced.

use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use windows::core::w;
use windows::Win32::Devices::Bluetooth::{
    BluetoothFindDeviceClose, BluetoothFindFirstDevice, BluetoothFindNextDevice,
    BLUETOOTH_DEVICE_INFO, BLUETOOTH_DEVICE_SEARCH_PARAMS,
};
use windows::Win32::Devices::DeviceAndDriverInstallation::{
    SetupDiDestroyDeviceInfoList, SetupDiEnumDeviceInfo, SetupDiGetClassDevsW,
    SetupDiGetDevicePropertyW, DIGCF_ALLCLASSES, DIGCF_PRESENT, SP_DEVINFO_DATA,
};
use windows::Win32::Devices::Properties::{DEVPKEY_Device_FriendlyName, DEVPROPTYPE};
use windows::Win32::Foundation::DEVPROPKEY;
use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
use windows::Win32::Media::Audio::{eCapture, eConsole, eRender, EDataFlow, IMMDeviceEnumerator, MMDeviceEnumerator};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoTaskMemFree, CLSCTX_ALL, COINIT_MULTITHREADED};
use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};

/* ── Earbuds ─────────────────────────────────────────────────────────── */

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BudsEvent {
    pub name: String,
    pub connected: bool,
    /// 0..100 when Windows exposes it (Settings → Bluetooth shows the same
    /// figure); `None` otherwise.
    pub battery: Option<u8>,
}

/// Major device class "Audio/Video" in a Bluetooth class-of-device word.
/// Headphones, earbuds, speakers — not mice, keyboards or phones.
pub fn is_audio_class(class_of_device: u32) -> bool {
    (class_of_device >> 8) & 0x1f == 0x04
}

/// Connected audio devices, by name.
fn connected_audio() -> Vec<String> {
    let mut found = Vec::new();
    unsafe {
        let params = BLUETOOTH_DEVICE_SEARCH_PARAMS {
            dwSize: std::mem::size_of::<BLUETOOTH_DEVICE_SEARCH_PARAMS>() as u32,
            fReturnAuthenticated: true.into(),
            fReturnRemembered: true.into(),
            fReturnConnected: true.into(),
            fReturnUnknown: false.into(),
            fIssueInquiry: false.into(), // never scan, as system.rs
            cTimeoutMultiplier: 0,
            ..Default::default()
        };
        let mut info = BLUETOOTH_DEVICE_INFO { dwSize: std::mem::size_of::<BLUETOOTH_DEVICE_INFO>() as u32, ..Default::default() };
        let Ok(search) = BluetoothFindFirstDevice(&params, &mut info) else { return found };
        loop {
            let name = String::from_utf16_lossy(&info.szName).trim_end_matches('\0').trim().to_string();
            if !name.is_empty() && info.fConnected.as_bool() && is_audio_class(info.ulClassofDevice) {
                found.push(name);
            }
            info = BLUETOOTH_DEVICE_INFO { dwSize: std::mem::size_of::<BLUETOOTH_DEVICE_INFO>() as u32, ..Default::default() };
            if BluetoothFindNextDevice(search, &mut info).is_err() {
                break;
            }
        }
        let _ = BluetoothFindDeviceClose(search);
    }
    found.sort();
    found.dedup();
    found
}

/// `DEVPKEY_Bluetooth_Battery`: undocumented in the SDK headers but the key
/// Settings itself reads — a BYTE percentage on the device's hands-free node.
const BATTERY_KEY: DEVPROPKEY = DEVPROPKEY {
    fmtid: windows::core::GUID::from_u128(0x104ea319_6ee2_4701_bd47_8ddbf425bbe5),
    pid: 2,
};

/// The battery a device's own nodes report, matched by name.
///
/// ⚠️ A pair of earbuds is several device nodes (A2DP, hands-free, the radio
/// link), named "Buds3 Pro", "Buds3 Pro Hands-Free" and so on, and only some
/// of them carry the figure. The best match is any node whose friendly name
/// starts with the device's own name; the highest figure wins, since a node
/// that has not been refreshed yet reports less, never more.
pub fn battery_for(name: &str, nodes: &[(String, u8)]) -> Option<u8> {
    let wanted = name.trim().to_lowercase();
    if wanted.is_empty() {
        return None;
    }
    nodes
        .iter()
        .filter(|(friendly, level)| *level <= 100 && friendly.trim().to_lowercase().starts_with(&wanted))
        .map(|(_, level)| *level)
        .max()
}

/// Every present Bluetooth node that carries a battery figure.
fn battery_nodes() -> Vec<(String, u8)> {
    let mut out = Vec::new();
    for enumerator in [w!("BTHENUM"), w!("BTHLE")] {
        unsafe {
            let Ok(set) = SetupDiGetClassDevsW(None, enumerator, None, DIGCF_ALLCLASSES | DIGCF_PRESENT) else { continue };
            let mut index = 0;
            loop {
                let mut data = SP_DEVINFO_DATA { cbSize: std::mem::size_of::<SP_DEVINFO_DATA>() as u32, ..Default::default() };
                if SetupDiEnumDeviceInfo(set, index, &mut data).is_err() {
                    break;
                }
                index += 1;
                let mut kind = DEVPROPTYPE::default();
                let mut level = [0u8; 1];
                if SetupDiGetDevicePropertyW(set, &data, &BATTERY_KEY, &mut kind, Some(&mut level), None, 0).is_err() {
                    continue;
                }
                let mut name = [0u8; 512];
                let mut size = 0u32;
                if SetupDiGetDevicePropertyW(set, &data, &DEVPKEY_Device_FriendlyName, &mut kind, Some(&mut name), Some(&mut size), 0).is_err() {
                    continue;
                }
                let units: Vec<u16> = name[..(size as usize).min(name.len())]
                    .chunks_exact(2)
                    .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
                    .take_while(|unit| *unit != 0)
                    .collect();
                out.push((String::from_utf16_lossy(&units), level[0]));
            }
            let _ = SetupDiDestroyDeviceInfoList(set);
        }
    }
    out
}

/// What changed between two connected lists: arrivals first, then departures.
pub fn buds_changes(before: &[String], after: &[String]) -> (Vec<String>, Vec<String>) {
    let arrived = after.iter().filter(|n| !before.contains(n)).cloned().collect();
    let left = before.iter().filter(|n| !after.contains(n)).cloned().collect();
    (arrived, left)
}

fn spawn_buds(app: AppHandle) {
    crate::guard::spawn("buds watch", move || {
        let mut known = connected_audio();
        loop {
            std::thread::sleep(Duration::from_secs(3));
            let now = connected_audio();
            let (arrived, left) = buds_changes(&known, &now);
            known = now;
            for name in left {
                let _ = app.emit_to("tasks", "peek:buds", BudsEvent { name, connected: false, battery: None });
            }
            for name in arrived {
                /* ⚠️ The figure lands a moment after the link does — the
                 * hands-free profile reports it once it is up. Ask twice. */
                let mut battery = battery_for(&name, &battery_nodes());
                if battery.is_none() {
                    std::thread::sleep(Duration::from_secs(4));
                    battery = battery_for(&name, &battery_nodes());
                }
                let _ = app.emit_to("tasks", "peek:buds", BudsEvent { name, connected: true, battery });
            }
        }
    });
}

/* ── Microphone ──────────────────────────────────────────────────────── */

/// The default capture endpoint: its id and whether it is muted.
fn capture_state(enumerator: &IMMDeviceEnumerator) -> Option<(String, bool)> {
    endpoint_state(enumerator, eCapture).map(|(id, muted, _)| (id, muted))
}

/// A default endpoint's id, mute and level (0..100).
fn endpoint_state(enumerator: &IMMDeviceEnumerator, flow: EDataFlow) -> Option<(String, bool, u8)> {
    unsafe {
        let device = enumerator.GetDefaultAudioEndpoint(flow, eConsole).ok()?;
        let raw = device.GetId().ok()?;
        let id = raw.to_string().unwrap_or_default();
        CoTaskMemFree(Some(raw.0 as _));
        let volume = device.Activate::<IAudioEndpointVolume>(CLSCTX_ALL, None).ok()?;
        let muted = volume.GetMute().ok()?.as_bool();
        let level = (volume.GetMasterVolumeLevelScalar().ok()? * 100.0).round().clamp(0.0, 100.0) as u8;
        Some((id, muted, level))
    }
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct VolumeEvent {
    pub level: u8,
    pub muted: bool,
}

/// The output's level or mute changed on the same device (batch 13, `volume`
/// was left to S): what the keyboard's volume keys, the tray flyout or the
/// island's own slider did.
pub fn volume_change(before: &Option<(String, bool, u8)>, after: &Option<(String, bool, u8)>) -> Option<VolumeEvent> {
    match (before, after) {
        (Some((a, m0, l0)), Some((b, m1, l1))) if a == b && (m0 != m1 || l0 != l1) => Some(VolumeEvent { level: *l1, muted: *m1 }),
        _ => None,
    }
}

/// A mute change worth saying: same device, different state. A change of
/// DEVICE (headset plugged in, the default moved) says nothing.
pub fn mic_change(before: &Option<(String, bool)>, after: &Option<(String, bool)>) -> Option<bool> {
    match (before, after) {
        (Some((a, was)), Some((b, now))) if a == b && was != now => Some(*now),
        _ => None,
    }
}

fn spawn_mic(app: AppHandle) {
    crate::guard::spawn("mic watch", move || {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
        let Ok(enumerator) = (unsafe { CoCreateInstance::<_, IMMDeviceEnumerator>(&MMDeviceEnumerator, None, CLSCTX_ALL) }) else {
            return;
        };
        let mut last = capture_state(&enumerator);
        let mut out = endpoint_state(&enumerator, eRender);
        let mut tick = 0u32;
        loop {
            /* 0.4 s for the output (a volume key held down should read as it
             * moves), every other tick for the mic. */
            std::thread::sleep(Duration::from_millis(400));
            let now_out = endpoint_state(&enumerator, eRender);
            if let Some(change) = volume_change(&out, &now_out) {
                let _ = app.emit_to("tasks", "peek:volume", change);
            }
            out = now_out;
            tick = tick.wrapping_add(1);
            if tick % 2 == 0 {
                let now = capture_state(&enumerator);
                if let Some(muted) = mic_change(&last, &now) {
                    let _ = app.emit_to("tasks", "peek:mic", muted);
                }
                last = now;
            }
        }
    });
}

/* ── Battery and charger ─────────────────────────────────────────────── */

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Power {
    /// 0..100.
    pub percent: u8,
    pub plugged: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", tag = "what")]
pub enum PowerEvent {
    /// The charger went in or out.
    Charger { plugged: bool, percent: u8 },
    /// Running on battery and it crossed 15 % (or 5 %, urgent).
    Low { percent: u8, urgent: bool },
}

/// `None` on a machine with no battery, or one Windows cannot read.
fn read_power() -> Option<Power> {
    let mut status = SYSTEM_POWER_STATUS::default();
    unsafe { GetSystemPowerStatus(&mut status).ok()? };
    // 128 = no system battery, 255 = unknown; the percent is 255 when unknown.
    if status.BatteryFlag == 128 || status.BatteryFlag == 255 || status.BatteryLifePercent > 100 {
        return None;
    }
    Some(Power { percent: status.BatteryLifePercent, plugged: status.ACLineStatus == 1 })
}

/// The low-battery stage already said: 0 none, 1 at 15 %, 2 at 5 %.
pub fn power_events(before: Power, after: Power, said: &mut u8) -> Vec<PowerEvent> {
    let mut out = Vec::new();
    if before.plugged != after.plugged {
        out.push(PowerEvent::Charger { plugged: after.plugged, percent: after.percent });
    }
    // Charging, or back above 20 %: the warnings may come again later.
    if after.plugged || after.percent > 20 {
        *said = 0;
        return out;
    }
    let stage = if after.percent <= 5 { 2 } else if after.percent <= 15 { 1 } else { 0 };
    if stage > *said {
        *said = stage;
        out.push(PowerEvent::Low { percent: after.percent, urgent: stage == 2 });
    }
    out
}

fn spawn_power(app: AppHandle) {
    crate::guard::spawn("power watch", move || {
        // A desktop: nothing to watch, ever. Quietly done.
        let Some(mut last) = read_power() else { return };
        // Already low at launch counts as said; only crossing further is news.
        let mut said = if last.plugged { 0 } else if last.percent <= 5 { 2 } else if last.percent <= 15 { 1 } else { 0 };
        loop {
            std::thread::sleep(Duration::from_secs(3));
            let Some(now) = read_power() else { continue };
            for event in power_events(last, now, &mut said) {
                let _ = app.emit_to("tasks", "peek:power", event);
            }
            last = now;
        }
    });
}

pub fn spawn(app: AppHandle) {
    spawn_buds(app.clone());
    spawn_mic(app.clone());
    spawn_power(app);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_audio_devices_count() {
        assert!(is_audio_class(0x240404)); // wearable headset
        assert!(is_audio_class(0x240418)); // headphones
        assert!(!is_audio_class(0x002580)); // mouse
        assert!(!is_audio_class(0x5a020c)); // phone
    }

    #[test]
    fn battery_is_matched_by_name_and_the_highest_wins() {
        let nodes = vec![
            ("Mateusz's Buds3 Pro".to_string(), 70),
            ("Mateusz's Buds3 Pro Hands-Free".to_string(), 80),
            ("Logi Z207".to_string(), 40),
            ("Broken".to_string(), 255),
        ];
        assert_eq!(battery_for("Mateusz's Buds3 Pro", &nodes), Some(80));
        assert_eq!(battery_for("logi z207", &nodes), Some(40));
        assert_eq!(battery_for("Broken", &nodes), None);
        assert_eq!(battery_for("", &nodes), None);
    }

    #[test]
    fn arrivals_and_departures() {
        let a = vec!["Buds".to_string()];
        let b = vec!["Speaker".to_string()];
        assert_eq!(buds_changes(&a, &b), (vec!["Speaker".to_string()], vec!["Buds".to_string()]));
        assert_eq!(buds_changes(&a, &a), (vec![], vec![]));
    }

    #[test]
    fn a_new_device_is_not_a_mute() {
        let a = Some(("one".to_string(), false));
        assert_eq!(mic_change(&a, &Some(("one".to_string(), true))), Some(true));
        assert_eq!(mic_change(&a, &Some(("two".to_string(), true))), None);
        assert_eq!(mic_change(&None, &a), None);
    }

    #[test]
    fn volume_moves_on_one_device() {
        let a = Some(("out".to_string(), false, 40));
        assert_eq!(volume_change(&a, &Some(("out".to_string(), false, 42))), Some(VolumeEvent { level: 42, muted: false }));
        assert_eq!(volume_change(&a, &Some(("out".to_string(), true, 40))), Some(VolumeEvent { level: 40, muted: true }));
        assert_eq!(volume_change(&a, &Some(("hdmi".to_string(), false, 80))), None);
        assert_eq!(volume_change(&a, &a), None);
    }

    #[test]
    fn low_battery_is_said_once_per_stage() {
        let p = |percent, plugged| Power { percent, plugged };
        let mut said = 0;
        assert_eq!(power_events(p(17, false), p(16, false), &mut said), vec![]);
        assert_eq!(power_events(p(16, false), p(15, false), &mut said), vec![PowerEvent::Low { percent: 15, urgent: false }]);
        assert_eq!(power_events(p(15, false), p(12, false), &mut said), vec![]);
        assert_eq!(power_events(p(6, false), p(5, false), &mut said), vec![PowerEvent::Low { percent: 5, urgent: true }]);
        assert_eq!(power_events(p(5, false), p(5, true), &mut said), vec![PowerEvent::Charger { plugged: true, percent: 5 }]);
        assert_eq!(said, 0);
        assert_eq!(power_events(p(5, true), p(5, false), &mut said).len(), 2); // unplugged at 5 %: both
    }

    /// Run by hand: `cargo test --lib devices::tests::reads_the_real_machine -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn reads_the_real_machine() {
        unsafe { let _ = CoInitializeEx(None, COINIT_MULTITHREADED); }
        println!("connected audio: {:?}", connected_audio());
        println!("battery nodes: {:?}", battery_nodes());
        println!("power: {:?}", read_power());
        let enumerator: IMMDeviceEnumerator = unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).unwrap() };
        println!("capture: {:?}", capture_state(&enumerator));
    }
}
