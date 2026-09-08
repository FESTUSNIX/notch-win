//! A separate Windows credential, never the other Codenotch port's files.
use windows::core::{w, PWSTR};
use windows::Win32::Foundation::ERROR_NOT_FOUND;
use windows::Win32::Security::Credentials::{
    CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE,
    CRED_TYPE_GENERIC,
};

pub fn read() -> Result<Option<String>, String> {
    let mut ptr = std::ptr::null_mut();
    unsafe {
        if let Err(e) = CredReadW(
            w!("codenotch-win/ticktick"),
            CRED_TYPE_GENERIC,
            None,
            &mut ptr,
        ) {
            if e.code() == windows::core::HRESULT::from_win32(ERROR_NOT_FOUND.0) {
                return Ok(None);
            }
            return Err(
                "Could not read TickTick credentials from Windows Credential Manager.".into(),
            );
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
        let result = String::from_utf8(bytes.to_vec())
            .map_err(|_| "The saved TickTick token is invalid. Reconnect TickTick.".to_string());
        CredFree(ptr.cast());
        result.map(Some)
    }
}

pub fn write(token: &str) -> Result<(), String> {
    let mut target: Vec<u16> = "codenotch-win/ticktick\0".encode_utf16().collect();
    let mut user: Vec<u16> = "TickTick\0".encode_utf16().collect();
    let mut bytes = token.as_bytes().to_vec();
    let c = CREDENTIALW {
        Type: CRED_TYPE_GENERIC,
        TargetName: PWSTR(target.as_mut_ptr()),
        UserName: PWSTR(user.as_mut_ptr()),
        Persist: CRED_PERSIST_LOCAL_MACHINE,
        CredentialBlobSize: bytes.len() as u32,
        CredentialBlob: bytes.as_mut_ptr(),
        ..Default::default()
    };
    let result = unsafe { CredWriteW(&c, 0) }.map_err(|_| {
        "Could not save the TickTick token in Windows Credential Manager.".to_string()
    });
    bytes.fill(0);
    result
}

pub fn delete() -> Result<(), String> {
    match unsafe { CredDeleteW(w!("codenotch-win/ticktick"), CRED_TYPE_GENERIC, None) } {
        Ok(()) => Ok(()),
        Err(e) if e.code() == windows::core::HRESULT::from_win32(ERROR_NOT_FOUND.0) => Ok(()),
        Err(_) => Err("Could not remove the TickTick credential.".into()),
    }
}
