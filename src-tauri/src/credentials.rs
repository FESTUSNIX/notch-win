//! Separate Windows credentials, never the other Codenotch port's files.
//!
//! Two secrets live here now — the TickTick token and the Google OAuth blob —
//! so the target name is a parameter. ⚠️ Every target must stay under the
//! `codenotch-win/` prefix: `codenotch/…` belongs to Im-Midi/codenotch-windows,
//! and both apps can be installed at once.
use windows::core::PWSTR;
use windows::Win32::Foundation::ERROR_NOT_FOUND;
use windows::Win32::Security::Credentials::{
    CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE,
    CRED_TYPE_GENERIC,
};

pub const TICKTICK: &str = "codenotch-win/ticktick";
pub const GOOGLE: &str = "codenotch-win/google-oauth";
pub const SPOTIFY: &str = "codenotch-win/spotify-oauth";

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

/// A human name for the credential, used only in error copy.
fn label(target: &str) -> &'static str {
    match target {
        GOOGLE => "Google Calendar",
        SPOTIFY => "Spotify",
        _ => "TickTick",
    }
}

pub fn read(target: &str) -> Result<Option<String>, String> {
    let mut name = wide(target);
    let mut ptr = std::ptr::null_mut();
    unsafe {
        if let Err(e) = CredReadW(
            PWSTR(name.as_mut_ptr()),
            CRED_TYPE_GENERIC,
            None,
            &mut ptr,
        ) {
            if e.code() == windows::core::HRESULT::from_win32(ERROR_NOT_FOUND.0) {
                return Ok(None);
            }
            return Err(format!(
                "Could not read {} credentials from Windows Credential Manager.",
                label(target)
            ));
        }
        let credential = &*ptr;
        let bytes = if credential.CredentialBlobSize == 0 {
            &[][..]
        } else {
            std::slice::from_raw_parts(
                credential.CredentialBlob,
                credential.CredentialBlobSize as usize,
            )
        };
        let result = String::from_utf8(bytes.to_vec()).map_err(|_| {
            format!(
                "The saved {} credential is invalid. Reconnect it.",
                label(target)
            )
        });
        CredFree(ptr.cast());
        result.map(Some)
    }
}

pub fn write(target: &str, secret: &str) -> Result<(), String> {
    let mut name = wide(target);
    let mut user = wide(label(target));
    let mut bytes = secret.as_bytes().to_vec();
    let c = CREDENTIALW {
        Type: CRED_TYPE_GENERIC,
        TargetName: PWSTR(name.as_mut_ptr()),
        UserName: PWSTR(user.as_mut_ptr()),
        Persist: CRED_PERSIST_LOCAL_MACHINE,
        CredentialBlobSize: bytes.len() as u32,
        CredentialBlob: bytes.as_mut_ptr(),
        ..Default::default()
    };
    let result = unsafe { CredWriteW(&c, 0) }.map_err(|_| {
        format!(
            "Could not save the {} credential in Windows Credential Manager.",
            label(target)
        )
    });
    bytes.fill(0);
    result
}

pub fn delete(target: &str) -> Result<(), String> {
    let mut name = wide(target);
    match unsafe { CredDeleteW(PWSTR(name.as_mut_ptr()), CRED_TYPE_GENERIC, None) } {
        Ok(()) => Ok(()),
        Err(e) if e.code() == windows::core::HRESULT::from_win32(ERROR_NOT_FOUND.0) => Ok(()),
        Err(_) => Err(format!("Could not remove the {} credential.", label(target))),
    }
}
