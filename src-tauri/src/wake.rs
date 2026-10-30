//! The wake word (30 Oct): say "Jarvis" and a hands-free turn with the
//! Guardian starts, exactly as a tap of the talk key does. This is the native
//! half: the microphone, the detector, and when to listen at all.
//!
//! - **The engine** is Picovoice Porcupine with its built-in `jarvis` keyword,
//!   run on this machine. Its C library, model and keyword are bundled
//!   (`resources/wake/`) and loaded at run time (`LoadLibraryW`), not through
//!   a crate: Picovoice yanked every one of their Rust crates in August 2025,
//!   and the C API is five functions. ⚠️ It needs his AccessKey (Picovoice
//!   Console, free), kept in Windows Credential Manager. The engine checks the
//!   key with Picovoice when it starts; no audio ever leaves the machine — a
//!   frame goes into the library and a yes or no comes out.
//! - **The microphone is the one he picked, and only that one.** His earbuds
//!   are his only other microphone, and an always-open microphone on them
//!   keeps them in the hands-free profile (music sounds like a phone call).
//!   So nothing is chosen for him: no mic picked is no listening, and a picked
//!   mic that is unplugged is no listening either, never the default.
//!   Opened with `waveIn` at 16 kHz mono 16-bit — the audio engine converts
//!   whatever the device runs at — and found by its Core Audio endpoint id
//!   (`DRV_QUERYFUNCTIONINSTANCEID`), since waveIn's own names are cut at 31
//!   characters.
//! - **Paused** (the microphone CLOSED, not just ignored): switched off, no
//!   key, no mic, silenced for an hour, presenting, in a call, a voice turn
//!   under way (the page says so, `wake_turn`), and while the Guardian speaks
//!   and a moment after (`voice::sounding_lately`), so it never hears itself.
//!   `why_paused` is the order, under test.
//! - **Heard** → `wake:heard` to the island, which starts the turn, and to
//!   every window (Settings lights its test mark). The detector then counts
//!   the turn as live for a few seconds before the page has said so, so one
//!   "Jarvis" is one turn.

use std::ffi::{c_char, c_void, CStr, CString};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use windows::core::{s, HSTRING, PSTR};
use windows::Win32::Foundation::{FreeLibrary, HMODULE};
use windows::Win32::Media::Audio::{
    waveInAddBuffer, waveInClose, waveInGetNumDevs, waveInMessage, waveInOpen, waveInPrepareHeader,
    waveInReset, waveInStart, waveInUnprepareHeader, CALLBACK_NULL, HWAVEIN, WAVEFORMATEX, WAVEHDR,
    WAVERR_STILLPLAYING, WAVE_FORMAT_PCM,
};
use windows::Win32::Media::MMSYSERR_NOERROR;
use windows::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryExW, LOAD_WITH_ALTERED_SEARCH_PATH};

/// The rate Porcupine listens at (checked against the library when it loads).
pub const RATE: u32 = 16_000;
/// The files in `resources/wake/`.
const LIBRARY: &str = "libpv_porcupine.dll";
const MODEL: &str = "porcupine_params.pv";
const KEYWORD: &str = "jarvis_windows.ppn";
/// `DRV_QUERYFUNCTIONINSTANCEIDSIZE` / `…ID` (mmddk.h): a waveIn device's endpoint id.
const QUERY_ID_SIZE: u32 = 2066;
const QUERY_ID: u32 = 2065;
/// After a detection the turn counts as live this long, before the page has said so.
const HEARD_HOLD_MS: u64 = 8_000;
/// A live turn the page stopped renewing is over after this (the longest turn: five minutes
/// listening, then transcribing, thinking and speaking — every phase bounded in voice-talk.ts).
const TURN_FOR_MS: u64 = 11 * 60_000;
/// After the Guardian stops speaking: the room's echo, and a sentence that comes next.
pub const SPEECH_TAIL_MS: u64 = 1_500;
/// A key that was refused, or a library that would not start, is tried again after this.
const RETRY_ENGINE: Duration = Duration::from_secs(60);
/// A microphone that would not open (unplugged), tried again after this.
const RETRY_MIC: Duration = Duration::from_secs(5);
/// One waveIn buffer: 100 ms.
const BUFFER_SAMPLES: usize = (RATE / 10) as usize;
const BUFFERS: usize = 4;

/* ── Pure: what the loop decides, under test ──────────────────────────── */

/// Everything that decides whether the detector may listen right now.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Gate {
    pub enabled: bool,
    pub key: bool,
    pub mic: bool,
    pub snoozed: bool,
    pub presenting: bool,
    pub call: bool,
    pub turn: bool,
    pub speaking: bool,
}

/// Why the detector is not listening, in order of what wins; `None` listens.
/// ⚠️ "off", "key" and "mic" are things to fix in Settings; the rest pass.
pub fn why_paused(gate: &Gate) -> Option<&'static str> {
    if !gate.enabled {
        Some("off")
    } else if !gate.key {
        Some("key")
    } else if !gate.mic {
        Some("mic")
    } else if gate.snoozed {
        Some("snoozed")
    } else if gate.presenting {
        Some("presenting")
    } else if gate.call {
        Some("call")
    } else if gate.turn {
        Some("turn")
    } else if gate.speaking {
        Some("speaking")
    } else {
        None
    }
}

/// Settings' three steps as Porcupine's 0..1. Higher misses less and wakes
/// on more things that are not the word.
pub fn sensitivity(level: &str) -> f32 {
    match level {
        "low" => 0.35,
        "high" => 0.75,
        _ => 0.55,
    }
}

/// A Bluetooth hands-free endpoint: opening it puts the earbuds in call quality.
/// `BTHHFENUM` is the hands-free enumerator (audio.rs); the name is the fallback.
pub fn is_hands_free(name: &str, enumerator: &str) -> bool {
    let name = name.to_ascii_lowercase();
    enumerator.eq_ignore_ascii_case("BTHHFENUM") || name.contains("hands-free") || name.contains("hands free")
}

/// Samples in, whole frames out: the device hands over 100 ms at a time,
/// Porcupine takes exactly `frame` samples per call, and what is left waits.
pub struct Framer {
    frame: usize,
    held: Vec<i16>,
}

impl Framer {
    pub fn new(frame: usize) -> Self {
        Self { frame: frame.max(1), held: Vec::with_capacity(frame * 2) }
    }

    pub fn push(&mut self, samples: &[i16], mut each: impl FnMut(&[i16])) {
        self.held.extend_from_slice(samples);
        let whole = self.held.len() / self.frame * self.frame;
        for frame in self.held[..whole].chunks_exact(self.frame) {
            each(frame);
        }
        self.held.drain(..whole);
    }

    pub fn clear(&mut self) {
        self.held.clear();
    }
}

/// Little-endian 16-bit bytes as samples; an odd last byte is dropped (never
/// happens with a 2-byte block align, but a driver is not a contract).
pub fn samples_of(bytes: &[u8]) -> Vec<i16> {
    bytes.chunks_exact(2).map(|pair| i16::from_le_bytes([pair[0], pair[1]])).collect()
}

/// Whether a detection counts: once per `HEARD_HOLD_MS`, whatever the engine says.
pub fn counts(last_heard: u64, now: u64) -> bool {
    last_heard == 0 || now.saturating_sub(last_heard) >= HEARD_HOLD_MS
}

/// Porcupine's status in words for the log and the settings mark.
/// ⚠️ 8..11 are the AccessKey's: wrong, out of devices, throttled, refused.
pub fn status_words(code: i32) -> &'static str {
    match code {
        1 => "out of memory",
        2 => "could not read its files",
        3 => "the AccessKey looks wrong",
        8 => "the AccessKey could not be checked (offline?)",
        9 => "the AccessKey is on too many devices",
        10 => "Picovoice is throttling this key",
        11 => "Picovoice refused the AccessKey",
        _ => "the engine failed",
    }
}

/* ── What the loop shares with the commands ───────────────────────────── */

/// A turn is live until this (ms, `shortcuts::now_ms`); zero when none.
static TURN_UNTIL: AtomicU64 = AtomicU64::new(0);
/// Silenced until this (ms since the epoch, so it means the same after a restart of the loop).
static SNOOZE_UNTIL: AtomicU64 = AtomicU64::new(0);
/// The key or the sensitivity changed: rebuild the engine.
static RELOAD: AtomicBool = AtomicBool::new(true);
/// The AccessKey, read from Credential Manager once and then kept here.
static KEY: Mutex<Option<String>> = Mutex::new(None);
static KEY_READ: AtomicBool = AtomicBool::new(false);
static STATUS: Mutex<Status> = Mutex::new(Status { listening: false, reason: None, heard_at: 0, problem: None });
static TRAY: OnceLock<tauri::menu::MenuItem<tauri::Wry>> = OnceLock::new();

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub listening: bool,
    /// `why_paused`'s word, or `engine` / `unplugged` from the loop itself.
    pub reason: Option<&'static str>,
    /// The last time the word was heard, ms since the epoch.
    pub heard_at: u64,
    /// What went wrong starting the engine, in words. Never the key.
    pub problem: Option<&'static str>,
}

fn epoch_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_millis() as u64)
        .unwrap_or(0)
}

fn key() -> Option<String> {
    if !KEY_READ.swap(true, Ordering::SeqCst) {
        let read = crate::credentials::read(crate::credentials::PICOVOICE).ok().flatten();
        *KEY.lock().unwrap() = read;
    }
    KEY.lock().unwrap().clone().filter(|key| !key.trim().is_empty())
}

/* ── The engine ───────────────────────────────────────────────────────── */

type InitFn = unsafe extern "C" fn(*const c_char, *const c_char, *const c_char, i32, *const *const c_char, *const f32, *mut *mut c_void) -> i32;
type DeleteFn = unsafe extern "C" fn(*mut c_void);
type ProcessFn = unsafe extern "C" fn(*mut c_void, *const i16, *mut i32) -> i32;
type IntFn = unsafe extern "C" fn() -> i32;
type StackFn = unsafe extern "C" fn(*mut *mut *mut c_char, *mut i32) -> i32;
type FreeStackFn = unsafe extern "C" fn(*mut *mut c_char);

/// Porcupine, loaded from its DLL. ⚠️ One per thread: the object is not shared.
pub struct Engine {
    module: HMODULE,
    object: *mut c_void,
    delete: DeleteFn,
    process: ProcessFn,
    pub frame: usize,
    pub sensitivity: f32,
}

/// The library and the two files it reads, where the bundle put them — or,
/// under `tauri dev`, still in the source tree.
pub fn files_dir(app: &AppHandle) -> Option<PathBuf> {
    let mut places = Vec::new();
    if let Ok(dir) = app.path().resource_dir() {
        places.push(dir.join("resources").join("wake"));
        places.push(dir.join("wake"));
    }
    places.push(Path::new(env!("CARGO_MANIFEST_DIR")).join("resources").join("wake"));
    places.into_iter().find(|dir| dir.join(LIBRARY).is_file() && dir.join(MODEL).is_file() && dir.join(KEYWORD).is_file())
}

fn c_path(path: &Path) -> Result<CString, &'static str> {
    CString::new(path.to_string_lossy().as_bytes()).map_err(|_| "could not read its files")
}

/// ⚠️ ALTERED search path: the library pulls in `pv_ypu_impl_cuda.dll` beside
/// it, and a plain `LoadLibraryW` looks for that next to codenotch.exe instead.
unsafe fn open_library(dir: &Path) -> windows::core::Result<HMODULE> {
    LoadLibraryExW(&HSTRING::from(dir.join(LIBRARY).as_os_str()), None, LOAD_WITH_ALTERED_SEARCH_PATH)
}

impl Engine {
    /// Load the library and start Porcupine with the AccessKey.
    /// ⚠️ The error is words for the log and the settings mark, never the key.
    pub fn load(dir: &Path, access_key: &str, sensitivity: f32) -> Result<Engine, &'static str> {
        unsafe {
            let module = open_library(dir).map_err(|_| "the engine's library would not load")?;
            let find = |name: windows::core::PCSTR| GetProcAddress(module, name);
            let (Some(init), Some(delete), Some(process), Some(frame), Some(rate)) = (
                find(s!("pv_porcupine_init")),
                find(s!("pv_porcupine_delete")),
                find(s!("pv_porcupine_process")),
                find(s!("pv_porcupine_frame_length")),
                find(s!("pv_sample_rate")),
            ) else {
                let _ = FreeLibrary(module);
                return Err("the engine's library is not the one expected");
            };
            let init: InitFn = std::mem::transmute(init);
            let delete: DeleteFn = std::mem::transmute(delete);
            let process: ProcessFn = std::mem::transmute(process);
            let frame: IntFn = std::mem::transmute(frame);
            let rate: IntFn = std::mem::transmute(rate);
            if rate() != RATE as i32 || frame() <= 0 {
                let _ = FreeLibrary(module);
                return Err("the engine wants audio this app does not send");
            }
            let key = CString::new(access_key.trim()).map_err(|_| "the AccessKey looks wrong")?;
            let model = c_path(&dir.join(MODEL))?;
            let keyword = c_path(&dir.join(KEYWORD))?;
            // One CPU thread: it is a few percent of one core either way, and the rest are his.
            let device = CString::new("cpu:1").unwrap();
            let keywords = [keyword.as_ptr()];
            let sensitivities = [sensitivity];
            let mut object = std::ptr::null_mut();
            let status = init(key.as_ptr(), model.as_ptr(), device.as_ptr(), 1, keywords.as_ptr(), sensitivities.as_ptr(), &mut object);
            if status != 0 || object.is_null() {
                // ⚠️ The library's own message quotes the key back ("Failed to parse AccessKey `…`").
                crate::log::note(&format!("wake: engine refused to start ({status}): {}", redact(&error_stack(module), access_key)));
                let _ = FreeLibrary(module);
                return Err(status_words(status));
            }
            Ok(Engine { module, object, delete, process, frame: frame() as usize, sensitivity })
        }
    }

    /// One frame of `self.frame` samples: whether the word ended in it.
    pub fn heard(&mut self, frame: &[i16]) -> Result<bool, i32> {
        if frame.len() != self.frame {
            return Ok(false);
        }
        let mut index = -1i32;
        let status = unsafe { (self.process)(self.object, frame.as_ptr(), &mut index) };
        if status != 0 {
            return Err(status);
        }
        Ok(index >= 0)
    }
}

impl Drop for Engine {
    fn drop(&mut self) {
        unsafe {
            (self.delete)(self.object);
            let _ = FreeLibrary(self.module);
        }
    }
}

/// The library's own account of a failure, for the log (it never repeats the key).
unsafe fn error_stack(module: HMODULE) -> String {
    let (Some(get), Some(free)) = (GetProcAddress(module, s!("pv_get_error_stack")), GetProcAddress(module, s!("pv_free_error_stack"))) else {
        return String::new();
    };
    let get: StackFn = std::mem::transmute(get);
    let free: FreeStackFn = std::mem::transmute(free);
    let mut stack: *mut *mut c_char = std::ptr::null_mut();
    let mut depth = 0i32;
    if get(&mut stack, &mut depth) != 0 || stack.is_null() {
        return String::new();
    }
    let mut lines = Vec::new();
    for at in 0..depth.clamp(0, 8) as usize {
        let line = *stack.add(at);
        if !line.is_null() {
            lines.push(CStr::from_ptr(line).to_string_lossy().chars().take(160).collect::<String>());
        }
    }
    free(stack);
    lines.join(" | ")
}

/// The log line without the key: the key itself, and anything in backticks.
pub fn redact(line: &str, key: &str) -> String {
    let key = key.trim();
    let mut out = if key.len() >= 4 { line.replace(key, "…") } else { line.to_string() };
    while let Some(start) = out.find('`') {
        let Some(len) = out[start + 1..].find('`') else { break };
        out.replace_range(start..start + len + 2, "…");
    }
    out
}

/* ── The microphone ───────────────────────────────────────────────────── */

/// The waveIn device whose Core Audio endpoint is `endpoint`, if it is plugged in.
fn wave_index(endpoint: &str) -> Option<u32> {
    let count = unsafe { waveInGetNumDevs() };
    for index in 0..count {
        let handle = HWAVEIN(index as usize as *mut c_void);
        let mut size = 0u32;
        let ok = unsafe { waveInMessage(Some(handle), QUERY_ID_SIZE, Some(&mut size as *mut u32 as usize), None) };
        if ok != MMSYSERR_NOERROR || size < 2 || size > 4096 {
            continue;
        }
        let mut wide = vec![0u16; (size as usize).div_ceil(2)];
        let ok = unsafe { waveInMessage(Some(handle), QUERY_ID, Some(wide.as_mut_ptr() as usize), Some(size as usize)) };
        if ok != MMSYSERR_NOERROR {
            continue;
        }
        let end = wide.iter().position(|&c| c == 0).unwrap_or(wide.len());
        if String::from_utf16_lossy(&wide[..end]).eq_ignore_ascii_case(endpoint) {
            return Some(index);
        }
    }
    None
}

/// The chosen microphone, open at 16 kHz mono. ⚠️ Buffers are handed back by
/// the device when `waveInUnprepareHeader` stops answering STILLPLAYING — the
/// same no-callback rule as the voice's `Out`; the header is boxed and its
/// data never moves while the device holds it.
struct Capture {
    handle: HWAVEIN,
    blocks: std::collections::VecDeque<(Box<WAVEHDR>, Vec<u8>)>,
}

impl Capture {
    fn open(endpoint: &str) -> Result<Capture, &'static str> {
        let index = wave_index(endpoint).ok_or("unplugged")?;
        let format = WAVEFORMATEX {
            wFormatTag: WAVE_FORMAT_PCM as u16,
            nChannels: 1,
            nSamplesPerSec: RATE,
            nAvgBytesPerSec: RATE * 2,
            nBlockAlign: 2,
            wBitsPerSample: 16,
            cbSize: 0,
        };
        let mut handle = HWAVEIN(std::ptr::null_mut());
        let result = unsafe { waveInOpen(Some(&mut handle as *mut HWAVEIN), index, &format, None, None, CALLBACK_NULL) };
        if result != MMSYSERR_NOERROR {
            crate::log::note(&format!("wake: the microphone would not open ({result})"));
            return Err("busy");
        }
        let mut capture = Capture { handle, blocks: std::collections::VecDeque::with_capacity(BUFFERS) };
        for _ in 0..BUFFERS {
            let mut data = vec![0u8; BUFFER_SAMPLES * 2];
            let mut header = Box::new(WAVEHDR::default());
            header.lpData = PSTR(data.as_mut_ptr());
            header.dwBufferLength = data.len() as u32;
            if !capture.queue(&mut header) {
                return Err("busy");
            }
            capture.blocks.push_back((header, data));
        }
        if unsafe { waveInStart(capture.handle) } != MMSYSERR_NOERROR {
            return Err("busy");
        }
        Ok(capture)
    }

    fn queue(&self, header: &mut WAVEHDR) -> bool {
        let size = std::mem::size_of::<WAVEHDR>() as u32;
        unsafe {
            header.dwFlags = 0;
            header.dwBytesRecorded = 0;
            if waveInPrepareHeader(self.handle, header, size) != MMSYSERR_NOERROR {
                return false;
            }
            if waveInAddBuffer(self.handle, header, size) != MMSYSERR_NOERROR {
                let _ = waveInUnprepareHeader(self.handle, header, size);
                return false;
            }
        }
        true
    }

    /// What has been recorded since the last call, oldest first; each buffer
    /// handed back goes straight back in, at the END of the queue — the device
    /// fills them in the order they were added, so the front is always the oldest.
    /// `None` once the device is gone.
    fn take(&mut self) -> Option<Vec<i16>> {
        let size = std::mem::size_of::<WAVEHDR>() as u32;
        let mut out = Vec::new();
        for _ in 0..self.blocks.len() {
            let Some((header, _)) = self.blocks.front_mut() else { break };
            let result = unsafe { waveInUnprepareHeader(self.handle, &mut **header, size) };
            if result == WAVERR_STILLPLAYING {
                break;
            }
            if result != MMSYSERR_NOERROR {
                return None;
            }
            let (mut header, data) = self.blocks.pop_front()?;
            let recorded = { header.dwBytesRecorded } as usize;
            out.extend(samples_of(&data[..recorded.min(data.len())]));
            if !self.queue(&mut header) {
                return None;
            }
            self.blocks.push_back((header, data));
        }
        Some(out)
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        let size = std::mem::size_of::<WAVEHDR>() as u32;
        unsafe {
            let _ = waveInReset(self.handle);
            for (header, _) in self.blocks.iter_mut() {
                let _ = waveInUnprepareHeader(self.handle, &mut **header, size);
            }
            let _ = waveInClose(self.handle);
        }
    }
}

/* ── The loop ─────────────────────────────────────────────────────────── */

pub fn spawn(app: AppHandle) {
    crate::guard::spawn("wake word", move || run(&app));
}

fn publish(app: &AppHandle, next: Status) {
    let changed = {
        let mut held = STATUS.lock().unwrap();
        let changed = *held != next;
        *held = next.clone();
        changed
    };
    if changed {
        let _ = app.emit("wake:state", next);
    }
}

fn run(app: &AppHandle) {
    let mut engine: Option<Engine> = None;
    let mut capture: Option<(String, Capture)> = None;
    let mut framer = Framer::new(512);
    let mut engine_retry: Option<Instant> = None;
    let mut mic_retry: Option<Instant> = None;
    let mut problem: Option<&'static str> = None;
    let mut checked = Instant::now() - Duration::from_secs(1);

    loop {
        std::thread::sleep(if capture.is_some() { Duration::from_millis(30) } else { Duration::from_millis(250) });

        if checked.elapsed() >= Duration::from_millis(250) {
            checked = Instant::now();
            let prefs = crate::prefs::current(app);
            let now = crate::shortcuts::now_ms();
            let key = if prefs.wake_word { key() } else { None };
            let gate = Gate {
                enabled: prefs.wake_word,
                key: key.is_some(),
                mic: !prefs.wake_mic.is_empty(),
                snoozed: SNOOZE_UNTIL.load(Ordering::SeqCst) > epoch_ms(),
                presenting: crate::helm::presenting(),
                call: app.try_state::<crate::call::CallState>().is_some_and(|state| state.snapshot().active),
                turn: TURN_UNTIL.load(Ordering::SeqCst) > now,
                speaking: crate::voice::sounding_lately(now, SPEECH_TAIL_MS),
            };
            let mut reason = why_paused(&gate);
            let wanted_sensitivity = sensitivity(&prefs.wake_sensitivity);

            // Off or no key: the engine goes too. Any other pause keeps it, so a call
            // ending does not cost another check of the key with Picovoice.
            if matches!(reason, Some("off") | Some("key")) || RELOAD.load(Ordering::SeqCst)
                || engine.as_ref().is_some_and(|e| e.sensitivity != wanted_sensitivity)
            {
                if RELOAD.swap(false, Ordering::SeqCst) {
                    engine_retry = None;
                    problem = None;
                }
                engine = None;
            }
            if reason.is_some() {
                if capture.take().is_some() {
                    crate::log::note(&format!("wake: paused ({})", reason.unwrap_or("")));
                }
                framer.clear();
            } else {
                if engine.is_none() && engine_retry.is_none_or(|at| at.elapsed() >= RETRY_ENGINE) {
                    match files_dir(app) {
                        None => {
                            problem = Some("the engine's files are missing");
                            engine_retry = Some(Instant::now());
                        }
                        Some(dir) => match Engine::load(&dir, key.as_deref().unwrap_or(""), wanted_sensitivity) {
                            Ok(loaded) => {
                                crate::log::note(&format!("wake: engine ready ({} samples a frame)", loaded.frame));
                                framer = Framer::new(loaded.frame);
                                engine = Some(loaded);
                                problem = None;
                                engine_retry = None;
                            }
                            Err(words) => {
                                problem = Some(words);
                                engine_retry = Some(Instant::now());
                            }
                        },
                    }
                }
                if engine.is_none() {
                    reason = Some("engine");
                    capture = None;
                } else {
                    // A different mic picked: close the old one first.
                    if capture.as_ref().is_some_and(|(id, _)| *id != prefs.wake_mic) {
                        capture = None;
                    }
                    if capture.is_none() && mic_retry.is_none_or(|at| at.elapsed() >= RETRY_MIC) {
                        match Capture::open(&prefs.wake_mic) {
                            Ok(open) => {
                                crate::log::note("wake: listening");
                                capture = Some((prefs.wake_mic.clone(), open));
                                mic_retry = None;
                                framer.clear();
                            }
                            Err(_) => mic_retry = Some(Instant::now()),
                        }
                    }
                    if capture.is_none() {
                        reason = Some("unplugged");
                    }
                }
            }
            let heard_at = STATUS.lock().unwrap().heard_at;
            publish(app, Status { listening: reason.is_none() && capture.is_some(), reason, heard_at, problem });
        }

        let (Some((_, open)), Some(detector)) = (capture.as_mut(), engine.as_mut()) else { continue };
        let Some(samples) = open.take() else {
            crate::log::note("wake: the microphone went away");
            capture = None;
            mic_retry = Some(Instant::now());
            continue;
        };
        let mut heard = false;
        let mut failed = None;
        framer.push(&samples, |frame| match detector.heard(frame) {
            Ok(true) => heard = true,
            Ok(false) => {}
            Err(code) => failed = Some(code),
        });
        if let Some(code) = failed {
            crate::log::note(&format!("wake: the engine stopped ({code})"));
            engine = None;
            capture = None;
            problem = Some(status_words(code));
            engine_retry = Some(Instant::now());
            continue;
        }
        let at = epoch_ms();
        if heard && counts(STATUS.lock().unwrap().heard_at, at) {
            crate::log::note("wake: heard");
            // The turn starts before the page has said so: one word, one turn.
            TURN_UNTIL.store(crate::shortcuts::now_ms() + HEARD_HOLD_MS, Ordering::SeqCst);
            let mut status = STATUS.lock().unwrap().clone();
            status.heard_at = at;
            *STATUS.lock().unwrap() = status.clone();
            let _ = app.emit("wake:heard", at);
            let _ = app.emit("wake:state", status);
            capture = None;
            framer.clear();
            checked = Instant::now() - Duration::from_secs(1);
        }
    }
}

/* ── Commands ─────────────────────────────────────────────────────────── */

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WakeMic {
    pub id: String,
    pub name: String,
    pub is_default: bool,
    pub hands_free: bool,
}

/// Every microphone plugged in, the hands-free ones marked.
#[tauri::command]
pub async fn wake_mics() -> Result<Vec<WakeMic>, String> {
    let list = crate::audio::capture_devices().await?;
    Ok(list
        .into_iter()
        .map(|(device, enumerator)| WakeMic {
            hands_free: is_hands_free(&device.name, &enumerator),
            id: device.id,
            name: device.name,
            is_default: device.is_default,
        })
        .collect())
}

/// Save the AccessKey (empty removes it). Answers whether one is kept now.
/// ⚠️ Never read back to the page: `wake_status` only says whether there is one.
#[tauri::command]
pub fn wake_key(key: String) -> Result<bool, String> {
    let key = key.trim().to_string();
    if key.len() > 512 {
        return Err("That is not a Picovoice AccessKey.".into());
    }
    if key.is_empty() {
        crate::credentials::delete(crate::credentials::PICOVOICE)?;
    } else {
        crate::credentials::write(crate::credentials::PICOVOICE, &key)?;
    }
    *KEY.lock().unwrap() = (!key.is_empty()).then_some(key.clone());
    KEY_READ.store(true, Ordering::SeqCst);
    RELOAD.store(true, Ordering::SeqCst);
    Ok(!key.is_empty())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WakeStatus {
    #[serde(flatten)]
    pub status: Status,
    pub has_key: bool,
    pub snoozed_until: u64,
}

#[tauri::command]
pub fn wake_status() -> WakeStatus {
    WakeStatus {
        status: STATUS.lock().unwrap().clone(),
        has_key: key().is_some(),
        snoozed_until: SNOOZE_UNTIL.load(Ordering::SeqCst),
    }
}

/// The page says a voice turn is (or is no longer) under way.
#[tauri::command]
pub fn wake_turn(live: bool) {
    TURN_UNTIL.store(if live { crate::shortcuts::now_ms() + TURN_FOR_MS } else { 0 }, Ordering::SeqCst);
}

/// Silence it for `minutes` (0 listens again). Answers until when, ms since the epoch.
#[tauri::command]
pub fn wake_snooze(app: AppHandle, minutes: u32) -> u64 {
    snooze(&app, minutes)
}

pub fn snooze(app: &AppHandle, minutes: u32) -> u64 {
    let until = if minutes == 0 { 0 } else { epoch_ms() + minutes.min(24 * 60) as u64 * 60_000 };
    SNOOZE_UNTIL.store(until, Ordering::SeqCst);
    if let Some(item) = TRAY.get() {
        let _ = item.set_text(if until > 0 { "Słuchaj słowa znowu" } else { "Wycisz słowo na godzinę" });
    }
    let _ = app.emit("wake:snooze", until);
    until
}

/// The tray's item: an hour of quiet, or back on.
pub fn tray_item(app: &AppHandle) -> tauri::Result<tauri::menu::MenuItem<tauri::Wry>> {
    let item = tauri::menu::MenuItem::with_id(app, "wake-snooze", "Wycisz słowo na godzinę", true, None::<&str>)?;
    let _ = TRAY.set(item.clone());
    Ok(item)
}

pub fn tray_toggle(app: &AppHandle) {
    let snoozed = SNOOZE_UNTIL.load(Ordering::SeqCst) > epoch_ms();
    snooze(app, if snoozed { 0 } else { 60 });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn open() -> Gate {
        Gate { enabled: true, key: true, mic: true, ..Gate::default() }
    }

    #[test]
    fn it_listens_only_with_everything_set_and_nothing_in_the_way() {
        assert_eq!(why_paused(&open()), None);
        assert_eq!(why_paused(&Gate::default()), Some("off"));
        assert_eq!(why_paused(&Gate { key: false, ..open() }), Some("key"));
        // ⚠️ No mic picked is no listening — never the default (his earbuds).
        assert_eq!(why_paused(&Gate { mic: false, ..open() }), Some("mic"));
        assert_eq!(why_paused(&Gate { snoozed: true, ..open() }), Some("snoozed"));
        assert_eq!(why_paused(&Gate { presenting: true, ..open() }), Some("presenting"));
        assert_eq!(why_paused(&Gate { call: true, ..open() }), Some("call"));
        assert_eq!(why_paused(&Gate { turn: true, ..open() }), Some("turn"));
        assert_eq!(why_paused(&Gate { speaking: true, ..open() }), Some("speaking"));
        // What is fixed in Settings wins over what passes by itself.
        let everything = Gate { enabled: false, key: false, mic: false, snoozed: true, presenting: true, call: true, turn: true, speaking: true };
        assert_eq!(why_paused(&everything), Some("off"));
        assert_eq!(why_paused(&Gate { enabled: true, ..everything }), Some("key"));
        assert_eq!(why_paused(&Gate { call: true, turn: true, ..open() }), Some("call"));
    }

    #[test]
    fn samples_go_out_in_whole_frames_and_the_rest_waits() {
        let mut framer = Framer::new(512);
        let mut frames = Vec::new();
        // 100 ms from the device is 1600 samples: three frames and 64 over.
        let block: Vec<i16> = (0..1600).map(|i| i as i16).collect();
        framer.push(&block, |frame| frames.push(frame.to_vec()));
        assert_eq!(frames.len(), 3);
        assert!(frames.iter().all(|f| f.len() == 512));
        assert_eq!(frames[1][0], 512, "in order, nothing skipped");
        // The 64 left over start the next frame.
        frames.clear();
        framer.push(&block, |frame| frames.push(frame.to_vec()));
        assert_eq!(frames.len(), 3, "64 + 1600 = 3 frames and 128 over");
        assert_eq!(frames[0][0], 1536);
        assert_eq!(frames[0][64], 0, "the new block follows the old one's tail");
        // Small pieces add up.
        let mut framer = Framer::new(4);
        let mut count = 0;
        for _ in 0..7 {
            framer.push(&[1, 2, 3], |_| count += 1);
        }
        assert_eq!(count, 5, "21 samples is five frames of four");
        framer.clear();
        framer.push(&[1, 2, 3], |_| count += 1);
        assert_eq!(count, 5, "cleared: the old tail is gone");
    }

    #[test]
    fn bytes_are_little_endian_samples() {
        assert_eq!(samples_of(&[0x01, 0x00, 0xff, 0xff, 0x00, 0x80]), vec![1, -1, i16::MIN]);
        assert_eq!(samples_of(&[0x01, 0x00, 0x07]), vec![1], "an odd byte is dropped");
        assert!(samples_of(&[]).is_empty());
    }

    #[test]
    fn one_word_is_one_turn() {
        assert!(counts(0, 5_000));
        assert!(!counts(10_000, 12_000));
        assert!(counts(10_000, 10_000 + HEARD_HOLD_MS));
    }

    #[test]
    fn sensitivity_steps_and_hands_free_devices() {
        assert!(sensitivity("low") < sensitivity("normal") && sensitivity("normal") < sensitivity("high"));
        assert_eq!(sensitivity("nonsense"), sensitivity("normal"));
        assert!(is_hands_free("Headset (Mateusz's Buds3 Pro Hands-Free)", "BTHHFENUM"));
        assert!(is_hands_free("Headset (Mateusz's Buds3 Pro Hands-Free)", ""), "by name when the enumerator is not read");
        assert!(!is_hands_free("Microphone (USB Audio Device)", "USB"));
        assert!(!is_hands_free("Microphone (DroidCam Audio)", "ROOT"));
    }

    #[test]
    fn the_key_never_reaches_the_log() {
        let line = "Picovoice Error. | Failed to parse AccessKey `abcd1234==`. | ee6ef30";
        assert_eq!(redact(line, "abcd1234=="), "Picovoice Error. | Failed to parse AccessKey …. | ee6ef30");
        assert!(!redact("key abcd1234== was refused", "abcd1234==").contains("abcd1234"));
        assert_eq!(redact("a `b` c `d", "zz"), "a … c `d", "an unclosed backtick stays");
    }

    #[test]
    fn the_keys_errors_are_words() {
        assert_eq!(status_words(11), "Picovoice refused the AccessKey");
        assert_eq!(status_words(3), "the AccessKey looks wrong");
        assert_eq!(status_words(99), "the engine failed");
    }

    /// The bundled library loads and wants 16 kHz in 512-sample frames — no key
    /// needed for that much. `cargo test --lib wake::tests::the_bundled_engine_loads -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn the_bundled_engine_loads() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources").join("wake");
        unsafe {
            let module = open_library(&dir).expect("the DLL loads");
            let frame: IntFn = std::mem::transmute(GetProcAddress(module, s!("pv_porcupine_frame_length")).expect("frame length"));
            let rate: IntFn = std::mem::transmute(GetProcAddress(module, s!("pv_sample_rate")).expect("sample rate"));
            println!("frame {} at {} Hz", frame(), rate());
            assert_eq!(rate(), RATE as i32);
            assert_eq!(frame(), 512);
            let _ = FreeLibrary(module);
        }
        // A made-up key is refused with words, not a crash.
        let refused = Engine::load(&dir, "not-a-key", 0.5).err();
        println!("a made-up key: {refused:?}");
        assert!(refused.is_some());
    }

    /// Opens one microphone that is NOT a hands-free one (never his earbuds) for
    /// half a second at 16 kHz and counts what came back. On the real machine:
    /// `cargo test --lib wake::tests::a_chosen_microphone_records -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn a_chosen_microphone_records() {
        crate::audio::enter_apartment();
        let mics = crate::audio::endpoints(windows::Win32::Media::Audio::eCapture).expect("the endpoints list");
        for (device, enumerator) in &mics {
            println!("{} | {} | hands-free {}", device.name, enumerator, is_hands_free(&device.name, enumerator));
        }
        let Some((device, _)) = mics.iter().find(|(d, e)| !is_hands_free(&d.name, e)) else {
            println!("no microphone that is safe to open");
            return;
        };
        let mut capture = Capture::open(&device.id).expect("it opens by endpoint id");
        let mut total = 0;
        let started = Instant::now();
        while started.elapsed() < Duration::from_millis(600) {
            std::thread::sleep(Duration::from_millis(30));
            total += capture.take().expect("still there").len();
        }
        println!("{}: {total} samples in 0.6 s", device.name);
        assert!(total >= 6_400, "at least 0.4 s of 16 kHz came back");
    }

    /// Lists the waveIn devices with their endpoint ids, on the real machine.
    #[test]
    #[ignore]
    fn every_microphone_has_an_endpoint() {
        let count = unsafe { waveInGetNumDevs() };
        println!("{count} waveIn devices");
        assert!(count == 0 || (0..count).any(|i| {
            let handle = HWAVEIN(i as usize as *mut c_void);
            let mut size = 0u32;
            unsafe { waveInMessage(Some(handle), QUERY_ID_SIZE, Some(&mut size as *mut u32 as usize), None) == MMSYSERR_NOERROR && size > 2 }
        }));
    }
}
