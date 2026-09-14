//! Which speakers the sound is coming out of, and switching them.
//!
//! Reading the endpoints is ordinary Core Audio. **Changing the default one is
//! not**: Windows has never shipped a public API for it, and every app that
//! does it — EarTrumpet, SoundSwitch, the old Control Panel — goes through
//! `IPolicyConfig`, an undocumented COM interface. That is what the vtable at
//! the bottom of this file is. It is stable enough that a decade of shipping
//! software depends on it, but it is not contract, so every call is guarded and
//! a failure is reported rather than assumed away.
//!
//! ⚠️ Same threading rules as media.rs: COM apartment per thread, and these
//! calls block, so commands hop onto their own thread.

use std::ffi::c_void;

use serde::{Deserialize, Serialize};
use windows::core::{GUID, HRESULT, HSTRING, Interface, PCWSTR};
use windows::Win32::Devices::FunctionDiscovery::{
    PKEY_DeviceInterface_FriendlyName, PKEY_Device_DeviceDesc, PKEY_Device_EnumeratorName,
    PKEY_Device_FriendlyName,
};
use windows::Win32::Media::Audio::{
    eConsole, eMultimedia, eRender, ERole, IMMDeviceEnumerator, MMDeviceEnumerator,
    DEVICE_STATE_ACTIVE,
};
use windows::Win32::Foundation::PROPERTYKEY;
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED, STGM_READ,
};
use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub id: String,
    pub name: String,
    pub is_default: bool,
    /// True for anything behind the Bluetooth enumerators. The form factor does
    /// not say — a Bluetooth headset reports "Headset" like a USB one — so this
    /// reads `PKEY_Device_EnumeratorName`, which is `BTHENUM` for the A2DP
    /// endpoint and `BTHHFENUM` for the hands-free one.
    pub is_bluetooth: bool,
}

fn enter_apartment() {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
}

/// A string property, or empty if the device does not carry it.
fn property(store: &IPropertyStore, key: &PROPERTYKEY) -> String {
    unsafe { store.GetValue(key).map(|value| value.to_string()).unwrap_or_default() }
}

fn collect() -> Result<Vec<Device>, String> {
    unsafe {
        let enumerator: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
            .map_err(|_| "Windows would not start the audio device service.".to_string())?;

        // The default may legitimately not exist — a machine with no output.
        let default_id = enumerator
            .GetDefaultAudioEndpoint(eRender, eConsole)
            .ok()
            .and_then(|device| device.GetId().ok())
            .map(|id| id.to_string().unwrap_or_default())
            .unwrap_or_default();

        let collection = enumerator
            .EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE)
            .map_err(|_| "Could not list the audio outputs.".to_string())?;
        let count = collection.GetCount().unwrap_or(0);

        let mut devices = Vec::new();
        for index in 0..count {
            let Ok(device) = collection.Item(index) else { continue };
            let Ok(id) = device.GetId() else { continue };
            let id = id.to_string().unwrap_or_default();
            if id.is_empty() {
                continue;
            }
            let Ok(store) = device.OpenPropertyStore(STGM_READ) else { continue };
            // FriendlyName is "Speakers (Realtek…)"; the interface name is the
            // device itself. Fall back through both rather than showing an id.
            let mut name = property(&store, &PKEY_Device_FriendlyName);
            if name.is_empty() {
                name = property(&store, &PKEY_DeviceInterface_FriendlyName);
            }
            if name.is_empty() {
                name = property(&store, &PKEY_Device_DeviceDesc);
            }
            if name.is_empty() {
                name = "Unknown output".into();
            }
            let enumerator_name = property(&store, &PKEY_Device_EnumeratorName);
            devices.push(Device {
                is_default: id == default_id,
                is_bluetooth: enumerator_name.to_ascii_uppercase().starts_with("BTH"),
                id,
                name,
            });
        }
        // Default first, then alphabetical: the one in use is the one being
        // looked for, and the rest are a list to scan.
        devices.sort_by(|a, b| b.is_default.cmp(&a.is_default).then_with(|| a.name.cmp(&b.name)));
        Ok(devices)
    }
}

#[tauri::command]
pub async fn get_audio_devices() -> Result<Vec<Device>, String> {
    let (send, receive) = tokio::sync::oneshot::channel();
    std::thread::spawn(move || {
        enter_apartment();
        let _ = send.send(collect());
    });
    receive.await.unwrap_or_else(|_| Err("The audio thread stopped.".into()))
}

#[tauri::command]
pub async fn set_audio_device(id: String) -> Result<(), String> {
    if id.is_empty() {
        return Err("No device was named.".into());
    }
    let (send, receive) = tokio::sync::oneshot::channel();
    std::thread::spawn(move || {
        enter_apartment();
        let _ = send.send(unsafe { set_default(&id) });
    });
    receive.await.unwrap_or_else(|_| Err("The audio thread stopped.".into()))
}

/* ── IPolicyConfig ─────────────────────────────────────────────────────────
 * Undocumented, and declared by hand because there is no header to import.
 *
 * ⚠️ The vtable layout is the whole thing. `SetDefaultEndpoint` is the
 * eleventh method after IUnknown's three, and the ten before it exist here only
 * to put it at the right offset — their signatures are irrelevant, their
 * *count* is not. Add or remove one and this silently calls
 * `SetPropertyValue` with a device id, which is not a crash, just wrong.
 */
const CLSID_POLICY_CONFIG: GUID = GUID::from_u128(0x870af99c_171d_4f9e_af0d_e63df40c2bc9);
const IID_POLICY_CONFIG: GUID = GUID::from_u128(0xf8679f50_850a_41cf_9c72_430f290290c8);

#[repr(C)]
struct PolicyConfigVtbl {
    query_interface: unsafe extern "system" fn(*mut c_void, *const GUID, *mut *mut c_void) -> HRESULT,
    add_ref: unsafe extern "system" fn(*mut c_void) -> u32,
    release: unsafe extern "system" fn(*mut c_void) -> u32,
    /// GetMixFormat, GetDeviceFormat, ResetDeviceFormat, SetDeviceFormat,
    /// GetProcessingPeriod, SetProcessingPeriod, GetShareMode, SetShareMode,
    /// GetPropertyValue, SetPropertyValue — never called, only counted.
    _reserved: [*const c_void; 10],
    set_default_endpoint: unsafe extern "system" fn(*mut c_void, PCWSTR, ERole) -> HRESULT,
}

#[repr(C)]
struct PolicyConfig {
    vtable: *const PolicyConfigVtbl,
}

unsafe fn set_default(id: &str) -> Result<(), String> {
    let unknown: windows::core::IUnknown =
        CoCreateInstance(&CLSID_POLICY_CONFIG, None, CLSCTX_ALL)
            .map_err(|_| "This build of Windows will not let Codenotch switch the output.".to_string())?;

    let mut raw: *mut c_void = std::ptr::null_mut();
    unknown
        .query(&IID_POLICY_CONFIG, &mut raw)
        .ok()
        .map_err(|_| "Windows refused the audio policy interface.".to_string())?;
    if raw.is_null() {
        return Err("Windows refused the audio policy interface.".into());
    }

    let policy = raw as *mut PolicyConfig;
    let vtable = (*policy).vtable;
    let wide = HSTRING::from(id);
    // Both roles, the way every other switcher does it: setting only eConsole
    // leaves communication apps (Teams, Discord) on the previous device, which
    // looks exactly like the switch not having worked.
    let mut result = Ok(());
    for role in [eConsole, eMultimedia] {
        let hr = ((*vtable).set_default_endpoint)(raw, PCWSTR(wide.as_ptr()), role);
        if hr.is_err() && result.is_ok() {
            result = Err("Windows would not move the default output.".to_string());
        }
    }
    ((*vtable).release)(raw);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Not a unit test — a probe against this machine's real endpoints.
    /// `cargo test --lib audio -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn lists_the_real_outputs() {
        enter_apartment();
        for device in collect().expect("endpoints") {
            println!(
                "{}{} {}",
                if device.is_default { "* " } else { "  " },
                if device.is_bluetooth { "[BT]" } else { "    " },
                device.name
            );
        }
    }
}
