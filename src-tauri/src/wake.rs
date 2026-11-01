//! The wake word (30 Oct): say "Jarvis" and a hands-free turn with the
//! Guardian starts, exactly as a tap of the talk key does. This is the native
//! half: the microphone, the detector, and when to listen at all.
//!
//! - **Two engines, one loop** (`Detector`). The default is **sherpa-onnx**
//!   (k2-fsa, Apache-2.0) keyword spotting with the English gigaspeech 3.3M
//!   zipformer (int8), fully offline, no account: its C API DLL and
//!   onnxruntime are bundled in `resources/wake/sherpa/` and loaded at run
//!   time, and the phrase (default "Jarvis", "hey …" accepted too) is spelled
//!   into the model's tokens here (`Vocab`, the unigram vocabulary exported
//!   once from its `bpe.model`). The other is Picovoice **Porcupine** with its
//!   built-in `jarvis` keyword (`resources/wake/`), kept for when Picovoice
//!   approve commercial use: Picovoice yanked every Rust crate in August 2025,
//!   so its C API is loaded the same way. ⚠️ Porcupine needs his AccessKey
//!   (Picovoice Console), kept in Windows Credential Manager, and checks it
//!   with Picovoice when it starts. Neither sends audio anywhere — a frame
//!   goes into the library and a yes or no comes out.
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

/// The rate both engines listen at (checked against Porcupine when it loads).
pub const RATE: u32 = 16_000;
/// Porcupine's files in `resources/wake/`.
const LIBRARY: &str = "libpv_porcupine.dll";
const MODEL: &str = "porcupine_params.pv";
const KEYWORD: &str = "jarvis_windows.ppn";
/// sherpa-onnx's, in `resources/wake/sherpa/`: the C API (it imports
/// `onnxruntime.dll` beside it), the keyword spotter's three int8 models,
/// its tokens and the vocabulary that spells a phrase into them.
const SHERPA_DIR: &str = "sherpa";
const SHERPA_LIBRARY: &str = "sherpa-onnx-c-api.dll";
const SHERPA_FILES: [&str; 6] = [SHERPA_LIBRARY, "encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt", "bpe.vocab"];
/// sherpa takes any length; 50 ms at a time keeps a detection prompt.
const SHERPA_FRAME: usize = (RATE / 20) as usize;
/// The phrase when none is set, or the one set is not one.
pub const DEFAULT_PHRASE: &str = "Jarvis";
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

/// The engine pref as one of the two; anything else is sherpa, the default.
pub fn engine_of(pref: &str) -> &'static str {
    if pref == "porcupine" { "porcupine" } else { "sherpa" }
}

/// Only Picovoice needs an AccessKey; sherpa-onnx has no account at all.
pub fn needs_key(engine: &str) -> bool {
    engine == "porcupine"
}

/// Settings' three steps for sherpa: (keywords score, keywords threshold).
/// The threshold is how sure it must be (larger is stricter), sherpa's default
/// 0.25 at Normal. ⚠️ The score (the boost to the phrase's path) stays at
/// sherpa's 1.0: measured on Windows' voice saying "Jarvis" at twelve offsets,
/// a boost of 1.5–2.0 MISSED more (10–11 of 12) than 1.0 (12 of 12).
pub fn sherpa_tuning(level: &str) -> (f32, f32) {
    match level {
        "low" => (1.0, 0.35),
        "high" => (1.0, 0.15),
        _ => (1.0, 0.25),
    }
}

/// The wake phrase as he typed it, cleaned, or `None` if it is not one:
/// ASCII letters (the model's alphabet) and single spaces, one to three words,
/// at most 40 characters. Mirrors `wakePhrase` in wake-rules.ts.
pub fn phrase_ok(phrase: &str) -> Option<String> {
    let words: Vec<&str> = phrase.split_whitespace().collect();
    if words.is_empty() || words.len() > 3 || !words.iter().all(|w| w.chars().all(|c| c.is_ascii_alphabetic())) {
        return None;
    }
    let joined = words.join(" ");
    (joined.len() <= 40).then_some(joined)
}

/// The model's unigram vocabulary (`bpe.vocab`: a piece and its log
/// probability a line), to spell a phrase into the tokens it was trained on.
/// ⚠️ icefall's "bpe" models are sentencepiece UNIGRAM models: the best split
/// is the one whose pieces' scores sum highest (Viterbi), not greedy merges —
/// greedy gets "▁W OR L D" where the model's own keywords.txt has "▁WORLD".
pub struct Vocab {
    pieces: std::collections::HashMap<String, f32>,
    longest: usize,
}

impl Vocab {
    pub fn parse(text: &str) -> Vocab {
        let mut pieces = std::collections::HashMap::new();
        let mut longest = 1;
        for line in text.lines() {
            let mut parts = line.split('\t');
            let (Some(piece), Some(score)) = (parts.next(), parts.next()) else { continue };
            let Ok(score) = score.trim().parse::<f32>() else { continue };
            if piece.is_empty() || piece.starts_with('<') {
                continue;
            }
            longest = longest.max(piece.chars().count());
            pieces.insert(piece.to_string(), score);
        }
        Vocab { pieces, longest }
    }

    /// The phrase as the model's tokens, space-separated ("Jarvis" → "▁JA R VI S"),
    /// or `None` when some letter has no piece.
    pub fn spell(&self, phrase: &str) -> Option<String> {
        let mut out = Vec::new();
        for word in phrase.to_ascii_uppercase().split_whitespace() {
            let chars: Vec<char> = std::iter::once('\u{2581}').chain(word.chars()).collect();
            let n = chars.len();
            // best[end] = (the best total score up to here, where its last piece starts)
            let mut best: Vec<Option<(f32, usize)>> = vec![None; n + 1];
            best[0] = Some((0.0, 0));
            for end in 1..=n {
                for start in end.saturating_sub(self.longest)..end {
                    let Some((before, _)) = best[start] else { continue };
                    let piece: String = chars[start..end].iter().collect();
                    if let Some(score) = self.pieces.get(&piece) {
                        let total = before + score;
                        if best[end].is_none_or(|(held, _)| total > held) {
                            best[end] = Some((total, start));
                        }
                    }
                }
            }
            let mut pieces = Vec::new();
            let mut end = n;
            while end > 0 {
                let (_, start) = best[end]?;
                pieces.push(chars[start..end].iter().collect::<String>());
                end = start;
            }
            out.extend(pieces.into_iter().rev());
        }
        (!out.is_empty()).then(|| out.join(" "))
    }
}

/// sherpa's keywords, one a line: the phrase, and "hey …" before it unless it
/// already starts so (or is three words already). `@` names what was heard.
pub fn keyword_lines(vocab: &Vocab, phrase: &str) -> Option<String> {
    let phrase = phrase_ok(phrase)?;
    let mut lines = vec![format!("{} @{}", vocab.spell(&phrase)?, phrase.replace(' ', "_"))];
    if !phrase.to_ascii_lowercase().starts_with("hey ") && phrase.split(' ').count() < 3 {
        let hey = format!("hey {phrase}");
        lines.push(format!("{} @{}", vocab.spell(&hey)?, hey.replace(' ', "_")));
    }
    Some(lines.join("\n"))
}

/// What the running detector was built from; a change rebuilds it.
#[derive(Clone, Debug, PartialEq)]
pub struct Spec {
    pub engine: &'static str,
    pub sensitivity: String,
    /// Only sherpa's; Porcupine's keyword is fixed.
    pub phrase: String,
}

impl Spec {
    pub fn of(engine: &str, sensitivity: &str, phrase: &str) -> Spec {
        let engine = engine_of(engine);
        let sensitivity = match sensitivity { "low" | "high" => sensitivity, _ => "normal" }.to_string();
        let phrase = if engine == "sherpa" { phrase_ok(phrase).unwrap_or_else(|| DEFAULT_PHRASE.into()) } else { DEFAULT_PHRASE.into() };
        Spec { engine, sensitivity, phrase }
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
pub struct Porcupine {
    module: HMODULE,
    object: *mut c_void,
    delete: DeleteFn,
    process: ProcessFn,
    pub frame: usize,
}

/// An engine's library and the files it reads, where the bundle put them —
/// or, under `tauri dev`, still in the source tree. Porcupine's are in
/// `wake/`, sherpa's in `wake/sherpa/`.
pub fn files_dir(app: &AppHandle, engine: &str) -> Option<PathBuf> {
    let mut places = Vec::new();
    if let Ok(dir) = app.path().resource_dir() {
        places.push(dir.join("resources").join("wake"));
        places.push(dir.join("wake"));
    }
    places.push(Path::new(env!("CARGO_MANIFEST_DIR")).join("resources").join("wake"));
    places.into_iter().map(|dir| if engine == "sherpa" { dir.join(SHERPA_DIR) } else { dir }).find(|dir| has_files(dir, engine))
}

fn has_files(dir: &Path, engine: &str) -> bool {
    if engine == "sherpa" {
        SHERPA_FILES.iter().all(|name| dir.join(name).is_file())
    } else {
        [LIBRARY, MODEL, KEYWORD].iter().all(|name| dir.join(name).is_file())
    }
}

fn c_path(path: &Path) -> Result<CString, &'static str> {
    CString::new(path.to_string_lossy().as_bytes()).map_err(|_| "could not read its files")
}

/// ⚠️ ALTERED search path: the library pulls in `pv_ypu_impl_cuda.dll` beside
/// it, and a plain `LoadLibraryW` looks for that next to codenotch.exe instead.
unsafe fn open_library(dir: &Path) -> windows::core::Result<HMODULE> {
    open_dll(&dir.join(LIBRARY))
}

/// ⚠️ The same rule for sherpa: `sherpa-onnx-c-api.dll` imports `onnxruntime.dll`,
/// which must be the one beside it, not System32's (Windows ML ships an older one).
unsafe fn open_dll(path: &Path) -> windows::core::Result<HMODULE> {
    LoadLibraryExW(&HSTRING::from(path.as_os_str()), None, LOAD_WITH_ALTERED_SEARCH_PATH)
}

impl Porcupine {
    /// Load the library and start Porcupine with the AccessKey.
    /// ⚠️ The error is words for the log and the settings mark, never the key.
    pub fn load(dir: &Path, access_key: &str, sensitivity: f32) -> Result<Porcupine, &'static str> {
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
            Ok(Porcupine { module, object, delete, process, frame: frame() as usize })
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

impl Drop for Porcupine {
    fn drop(&mut self) {
        unsafe {
            (self.delete)(self.object);
            let _ = FreeLibrary(self.module);
        }
    }
}

/* sherpa-onnx's C API (v2.0.1 `c-api.h`), the structs exactly as declared. */

#[repr(C)]
struct FeatureConfig {
    sample_rate: i32,
    feature_dim: i32,
}

/// `SherpaOnnxOnlineModelConfig` with its sub-structs flattened (each is only pointers).
#[repr(C)]
struct OnlineModelConfig {
    encoder: *const c_char,
    decoder: *const c_char,
    joiner: *const c_char,
    paraformer_encoder: *const c_char,
    paraformer_decoder: *const c_char,
    zipformer2_ctc: *const c_char,
    tokens: *const c_char,
    num_threads: i32,
    provider: *const c_char,
    debug: i32,
    model_type: *const c_char,
    modeling_unit: *const c_char,
    bpe_vocab: *const c_char,
    tokens_buf: *const c_char,
    tokens_buf_size: i32,
    nemo_ctc: *const c_char,
    t_one_ctc: *const c_char,
}

#[repr(C)]
struct KeywordSpotterConfig {
    feat_config: FeatureConfig,
    model_config: OnlineModelConfig,
    max_active_paths: i32,
    num_trailing_blanks: i32,
    keywords_score: f32,
    keywords_threshold: f32,
    keywords_file: *const c_char,
    keywords_buf: *const c_char,
    keywords_buf_size: i32,
}

/// Only the first field is read; the rest belongs to the library.
#[repr(C)]
struct KeywordResult {
    keyword: *const c_char,
}

type CreateSpotterFn = unsafe extern "C" fn(*const KeywordSpotterConfig) -> *const c_void;
type DestroySpotterFn = unsafe extern "C" fn(*const c_void);
type CreateStreamFn = unsafe extern "C" fn(*const c_void) -> *const c_void;
type DestroyStreamFn = unsafe extern "C" fn(*const c_void);
type AcceptFn = unsafe extern "C" fn(*const c_void, i32, *const f32, i32);
type SpotterStreamFn = unsafe extern "C" fn(*const c_void, *const c_void) -> i32;
type SpotterStreamVoidFn = unsafe extern "C" fn(*const c_void, *const c_void);
type ResultFn = unsafe extern "C" fn(*const c_void, *const c_void) -> *const KeywordResult;
type DestroyResultFn = unsafe extern "C" fn(*const KeywordResult);

/// sherpa-onnx's keyword spotter with one stream, loaded from its DLL.
/// ⚠️ One per thread, like Porcupine.
pub struct Sherpa {
    module: HMODULE,
    spotter: *const c_void,
    stream: *const c_void,
    destroy_spotter: DestroySpotterFn,
    create_stream: CreateStreamFn,
    destroy_stream: DestroyStreamFn,
    accept: AcceptFn,
    ready: SpotterStreamFn,
    decode: SpotterStreamVoidFn,
    reset: SpotterStreamVoidFn,
    result: ResultFn,
    destroy_result: DestroyResultFn,
    floats: Vec<f32>,
    /// What was heard last, for the log ("Jarvis", "hey_Jarvis").
    pub last: String,
}

impl Sherpa {
    /// Load the library and the model, with the phrase spelled into its tokens.
    pub fn load(dir: &Path, phrase: &str, level: &str) -> Result<Sherpa, &'static str> {
        let vocab = std::fs::read_to_string(dir.join("bpe.vocab")).map_err(|_| "could not read its files")?;
        let keywords = keyword_lines(&Vocab::parse(&vocab), phrase).ok_or("the wake phrase can't be spelled for the engine")?;
        let (score, threshold) = sherpa_tuning(level);
        let paths = ["encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"].map(|name| c_path(&dir.join(name)));
        let [Ok(encoder), Ok(decoder), Ok(joiner), Ok(tokens)] = paths else {
            return Err("could not read its files");
        };
        let provider = CString::new("cpu").unwrap();
        let keywords = CString::new(keywords).map_err(|_| "the wake phrase can't be spelled for the engine")?;
        unsafe {
            let module = open_dll(&dir.join(SHERPA_LIBRARY)).map_err(|_| "the engine's library would not load")?;
            let find = |name: windows::core::PCSTR| GetProcAddress(module, name);
            let (Some(create), Some(destroy), Some(create_stream), Some(destroy_stream), Some(accept), Some(ready), Some(decode), Some(reset), Some(result), Some(destroy_result)) = (
                find(s!("SherpaOnnxCreateKeywordSpotter")),
                find(s!("SherpaOnnxDestroyKeywordSpotter")),
                find(s!("SherpaOnnxCreateKeywordStream")),
                find(s!("SherpaOnnxDestroyOnlineStream")),
                find(s!("SherpaOnnxOnlineStreamAcceptWaveform")),
                find(s!("SherpaOnnxIsKeywordStreamReady")),
                find(s!("SherpaOnnxDecodeKeywordStream")),
                find(s!("SherpaOnnxResetKeywordStream")),
                find(s!("SherpaOnnxGetKeywordResult")),
                find(s!("SherpaOnnxDestroyKeywordResult")),
            ) else {
                let _ = FreeLibrary(module);
                return Err("the engine's library is not the one expected");
            };
            let create: CreateSpotterFn = std::mem::transmute(create);
            let destroy: DestroySpotterFn = std::mem::transmute(destroy);
            let create_stream: CreateStreamFn = std::mem::transmute(create_stream);
            let null = std::ptr::null();
            let config = KeywordSpotterConfig {
                feat_config: FeatureConfig { sample_rate: RATE as i32, feature_dim: 80 },
                model_config: OnlineModelConfig {
                    encoder: encoder.as_ptr(),
                    decoder: decoder.as_ptr(),
                    joiner: joiner.as_ptr(),
                    paraformer_encoder: null,
                    paraformer_decoder: null,
                    zipformer2_ctc: null,
                    tokens: tokens.as_ptr(),
                    // One thread: the rest of the machine is his.
                    num_threads: 1,
                    provider: provider.as_ptr(),
                    debug: 0,
                    model_type: null,
                    modeling_unit: null,
                    bpe_vocab: null,
                    tokens_buf: null,
                    tokens_buf_size: 0,
                    nemo_ctc: null,
                    t_one_ctc: null,
                },
                max_active_paths: 4,
                num_trailing_blanks: 1,
                keywords_score: score,
                keywords_threshold: threshold,
                keywords_file: null,
                keywords_buf: keywords.as_ptr(),
                keywords_buf_size: keywords.as_bytes().len() as i32,
            };
            let spotter = create(&config);
            if spotter.is_null() {
                crate::log::note("wake: sherpa-onnx refused its model or keywords");
                let _ = FreeLibrary(module);
                return Err("the keyword spotter would not start");
            }
            let stream = create_stream(spotter);
            if stream.is_null() {
                destroy(spotter);
                let _ = FreeLibrary(module);
                return Err("the keyword spotter would not start");
            }
            Ok(Sherpa {
                module,
                spotter,
                stream,
                destroy_spotter: destroy,
                create_stream,
                destroy_stream: std::mem::transmute::<_, DestroyStreamFn>(destroy_stream),
                accept: std::mem::transmute::<_, AcceptFn>(accept),
                ready: std::mem::transmute::<_, SpotterStreamFn>(ready),
                decode: std::mem::transmute::<_, SpotterStreamVoidFn>(decode),
                reset: std::mem::transmute::<_, SpotterStreamVoidFn>(reset),
                result: std::mem::transmute::<_, ResultFn>(result),
                destroy_result: std::mem::transmute::<_, DestroyResultFn>(destroy_result),
                floats: Vec::with_capacity(SHERPA_FRAME),
                last: String::new(),
            })
        }
    }

    /// Any number of samples: whether the phrase was spotted in them.
    pub fn heard(&mut self, samples: &[i16]) -> bool {
        self.floats.clear();
        self.floats.extend(samples.iter().map(|&s| s as f32 / 32768.0));
        let mut heard = false;
        unsafe {
            (self.accept)(self.stream, RATE as i32, self.floats.as_ptr(), self.floats.len() as i32);
            while (self.ready)(self.spotter, self.stream) == 1 {
                (self.decode)(self.spotter, self.stream);
                let result = (self.result)(self.spotter, self.stream);
                if !result.is_null() {
                    let keyword = (*result).keyword;
                    if !keyword.is_null() && *keyword != 0 {
                        self.last = CStr::from_ptr(keyword).to_string_lossy().chars().take(60).collect();
                        heard = true;
                        (self.reset)(self.spotter, self.stream);
                    }
                    (self.destroy_result)(result);
                }
            }
        }
        heard
    }

    /// A fresh stream, so audio from before a pause is not half of a word after it.
    pub fn fresh(&mut self) {
        unsafe {
            let next = (self.create_stream)(self.spotter);
            if !next.is_null() {
                (self.destroy_stream)(self.stream);
                self.stream = next;
            }
        }
    }
}

impl Drop for Sherpa {
    fn drop(&mut self) {
        unsafe {
            (self.destroy_stream)(self.stream);
            (self.destroy_spotter)(self.spotter);
            let _ = FreeLibrary(self.module);
        }
    }
}

/// Whichever engine Settings picked, behind one face for the loop.
pub enum Detector {
    Porcupine(Porcupine),
    Sherpa(Sherpa),
}

impl Detector {
    /// Build the engine `spec` names. `key` is only Porcupine's.
    pub fn load(dir: &Path, spec: &Spec, key: &str) -> Result<Detector, &'static str> {
        match spec.engine {
            "porcupine" => Porcupine::load(dir, key, sensitivity(&spec.sensitivity)).map(Detector::Porcupine),
            _ => Sherpa::load(dir, &spec.phrase, &spec.sensitivity).map(Detector::Sherpa),
        }
    }

    /// The samples it takes at a time.
    pub fn frame(&self) -> usize {
        match self {
            Detector::Porcupine(engine) => engine.frame,
            Detector::Sherpa(_) => SHERPA_FRAME,
        }
    }

    /// One frame: whether the word ended in it. `Err` is Porcupine's status.
    pub fn heard(&mut self, frame: &[i16]) -> Result<bool, i32> {
        match self {
            Detector::Porcupine(engine) => engine.heard(frame),
            Detector::Sherpa(engine) => Ok(engine.heard(frame)),
        }
    }

    /// The microphone just (re)opened.
    pub fn fresh(&mut self) {
        if let Detector::Sherpa(engine) = self {
            engine.fresh();
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
    let mut engine: Option<(Spec, Detector)> = None;
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
            let wanted = Spec::of(&prefs.wake_engine, &prefs.wake_sensitivity, &prefs.wake_phrase);
            let key = if prefs.wake_word && needs_key(wanted.engine) { key() } else { None };
            let gate = Gate {
                enabled: prefs.wake_word,
                key: !needs_key(wanted.engine) || key.is_some(),
                mic: !prefs.wake_mic.is_empty(),
                snoozed: SNOOZE_UNTIL.load(Ordering::SeqCst) > epoch_ms(),
                presenting: crate::helm::presenting(),
                call: app.try_state::<crate::call::CallState>().is_some_and(|state| state.snapshot().active),
                turn: TURN_UNTIL.load(Ordering::SeqCst) > now,
                speaking: crate::voice::sounding_lately(now, SPEECH_TAIL_MS),
            };
            let mut reason = why_paused(&gate);

            // Off or no key: the engine goes too. Any other pause keeps it, so a call
            // ending does not cost another check of the key with Picovoice. Another
            // engine, sensitivity or phrase: rebuilt (the phrase spelled again).
            let respec = engine.as_ref().is_some_and(|(spec, _)| *spec != wanted);
            if matches!(reason, Some("off") | Some("key")) || RELOAD.load(Ordering::SeqCst) || respec {
                if respec {
                    engine_retry = None;
                    problem = None;
                    capture = None;
                }
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
                    match files_dir(app, wanted.engine) {
                        None => {
                            problem = Some("the engine's files are missing");
                            engine_retry = Some(Instant::now());
                        }
                        Some(dir) => match Detector::load(&dir, &wanted, key.as_deref().unwrap_or("")) {
                            Ok(loaded) => {
                                crate::log::note(&format!("wake: {} ready ({} samples a frame)", wanted.engine, loaded.frame()));
                                framer = Framer::new(loaded.frame());
                                engine = Some((wanted.clone(), loaded));
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
                                if let Some((_, detector)) = engine.as_mut() {
                                    detector.fresh();
                                }
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

        let (Some((_, open)), Some((_, detector))) = (capture.as_mut(), engine.as_mut()) else { continue };
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
            match engine.as_ref() {
                Some((_, Detector::Sherpa(spotter))) => crate::log::note(&format!("wake: heard ({})", spotter.last)),
                _ => crate::log::note("wake: heard"),
            }
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

    fn bundled_vocab() -> Vocab {
        Vocab::parse(&std::fs::read_to_string(sherpa_dir().join("bpe.vocab")).expect("bpe.vocab is bundled"))
    }

    fn sherpa_dir() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("resources").join("wake").join(SHERPA_DIR)
    }

    #[test]
    fn sherpa_is_the_default_and_only_picovoice_needs_a_key() {
        assert_eq!(engine_of("sherpa"), "sherpa");
        assert_eq!(engine_of("porcupine"), "porcupine");
        assert_eq!(engine_of(""), "sherpa", "an old prefs file, before there was a choice");
        assert_eq!(engine_of("Porcupine"), "sherpa", "exactly the word, or the default");
        assert!(needs_key("porcupine") && !needs_key("sherpa"));
        // Picovoice chosen with no key stays closed, as before; sherpa never asks for one.
        let gate = |engine: &str, has_key: bool| Gate { enabled: true, key: !needs_key(engine) || has_key, mic: true, ..Gate::default() };
        assert_eq!(why_paused(&gate("porcupine", false)), Some("key"));
        assert_eq!(why_paused(&gate("porcupine", true)), None);
        assert_eq!(why_paused(&gate("sherpa", false)), None);
    }

    #[test]
    fn a_new_engine_sensitivity_or_phrase_is_a_new_detector() {
        let now = Spec::of("sherpa", "normal", "Jarvis");
        assert_eq!(now, Spec::of("sherpa", "", "  Jarvis "), "cleaned the same way is the same");
        assert_ne!(now, Spec::of("porcupine", "normal", "Jarvis"));
        assert_ne!(now, Spec::of("sherpa", "high", "Jarvis"));
        assert_ne!(now, Spec::of("sherpa", "normal", "Computer"));
        // Porcupine only knows "Jarvis": its phrase never rebuilds it.
        assert_eq!(Spec::of("porcupine", "low", "Computer"), Spec::of("porcupine", "low", "Friday"));
        assert_eq!(Spec::of("sherpa", "normal", "no digits 4 u").phrase, DEFAULT_PHRASE);
    }

    #[test]
    fn sherpas_sensitivity_asks_less_as_it_goes_up() {
        let (low, normal, high) = (sherpa_tuning("low"), sherpa_tuning("normal"), sherpa_tuning("high"));
        assert!(low.1 > normal.1 && normal.1 > high.1, "keywords threshold falls (larger is stricter)");
        assert!(low.0 == 1.0 && normal.0 == 1.0 && high.0 == 1.0, "the boost stays at sherpa's own: more missed more");
        assert_eq!(sherpa_tuning("nonsense"), normal);
        assert_eq!(normal, (1.0, 0.25), "sherpa's defaults at Normal");
    }

    #[test]
    fn a_phrase_is_one_to_three_words_of_letters() {
        assert_eq!(phrase_ok("Jarvis").as_deref(), Some("Jarvis"));
        assert_eq!(phrase_ok("  hey   Jarvis ").as_deref(), Some("hey Jarvis"));
        assert_eq!(phrase_ok("ok there computer").as_deref(), Some("ok there computer"));
        assert_eq!(phrase_ok("one two three four"), None);
        assert_eq!(phrase_ok(""), None);
        assert_eq!(phrase_ok("   "), None);
        assert_eq!(phrase_ok("R2D2"), None);
        assert_eq!(phrase_ok("Jarvis!"), None);
        assert_eq!(phrase_ok("Żaneta"), None, "the model's alphabet is A to Z");
        assert_eq!(phrase_ok(&"a".repeat(41)), None);
    }

    /// The tokenizer reproduces the model's own `keywords.txt` (made by sherpa's
    /// `text2token`) and its test keywords, word for word.
    #[test]
    fn the_phrase_is_spelled_as_sherpas_text2token_spells_it() {
        let vocab = bundled_vocab();
        for (raw, tokens) in [
            ("HELLO WORLD", "▁HE LL O ▁WORLD"),
            ("HI GOOGLE", "▁HI ▁GO O G LE"),
            ("HEY SIRI", "▁HE Y ▁S I RI"),
            ("ALEXA", "▁A LE X A"),
            ("LOVE AND PEACE", "▁LOVE ▁AND ▁P E A CE"),
            ("PLAY MUSIC", "▁PLAY ▁MU S IC"),
            ("GO HOME", "▁GO ▁HOME"),
            ("HAPPY NEW YEAR", "▁HA PP Y ▁NEW ▁YEAR"),
            ("MERRY CHRISTMAS", "▁ME R RY ▁ CH R IST MA S"),
            ("LIGHT UP", "▁ L IGHT ▁UP"),
            ("LOVELY CHILD", "▁LOVE LY ▁CHI L D"),
            ("FOREVER", "▁FOR E VER"),
        ] {
            assert_eq!(vocab.spell(raw).as_deref(), Some(tokens), "{raw}");
        }
        assert_eq!(vocab.spell("jarvis").as_deref(), Some("▁JA R VI S"), "case does not matter");
        assert_eq!(
            keyword_lines(&vocab, "Jarvis").as_deref(),
            Some("▁JA R VI S @Jarvis\n▁HE Y ▁JA R VI S @hey_Jarvis"),
            "the phrase, and \"hey\" before it"
        );
        assert_eq!(keyword_lines(&vocab, "hey Jarvis").as_deref(), Some("▁HE Y ▁JA R VI S @hey_Jarvis"));
        assert_eq!(keyword_lines(&vocab, "ok there computer").map(|k| k.lines().count()), Some(1), "four words is too many to add hey");
        assert_eq!(keyword_lines(&vocab, "R2D2"), None);
        // Every token it spells is one the model has.
        let tokens = std::fs::read_to_string(sherpa_dir().join("tokens.txt")).unwrap();
        let known: std::collections::HashSet<&str> = tokens.lines().filter_map(|l| l.split(' ').next()).collect();
        for word in ["Jarvis", "computer", "Friday", "hey Mateusz", "quiz"] {
            for token in vocab.spell(word).unwrap().split(' ') {
                assert!(known.contains(token), "{token} in {word}");
            }
        }
    }

    /// 16-bit mono PCM out of a WAV file (System.Speech writes a plain RIFF).
    fn wav_samples(path: &Path) -> Vec<i16> {
        let bytes = std::fs::read(path).expect("the wav");
        let mut at = 12;
        while at + 8 <= bytes.len() {
            let size = u32::from_le_bytes([bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]]) as usize;
            if &bytes[at..at + 4] == b"data" {
                return samples_of(&bytes[at + 8..(at + 8 + size).min(bytes.len())]);
            }
            at += 8 + size + (size & 1);
        }
        panic!("no data chunk");
    }

    /// The phrase in Windows' own voice, at 16 kHz mono, or `None` without System.Speech.
    fn spoken(text: &str, dir: &Path) -> Option<Vec<i16>> {
        let path = dir.join(format!("{}.wav", text.replace(' ', "-")));
        let script = format!(
            "Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; \
             $f = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono); \
             $s.SetOutputToWaveFile('{}', $f); $s.Speak('{text}'); $s.Dispose()",
            path.display()
        );
        let ok = std::process::Command::new("powershell").args(["-NoProfile", "-Command", &script]).status().ok()?.success();
        ok.then(|| wav_samples(&path))
    }

    /// A quiet room: a little noise, never digital zero.
    fn room(seconds: f32, seed: &mut u32) -> Vec<i16> {
        (0..(seconds * RATE as f32) as usize)
            .map(|_| {
                *seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                ((*seed >> 16) as i16 % 24) - 12
            })
            .collect()
    }

    fn run_through(spotter: &mut Detector, samples: &[i16]) -> usize {
        let mut framer = Framer::new(spotter.frame());
        let mut heard = 0;
        framer.push(samples, |frame| heard += spotter.heard(frame).unwrap() as usize);
        heard
    }

    /// The bundled sherpa-onnx DLL and model load, hear nothing in seconds of a
    /// quiet room, and hear "Jarvis" / "hey Jarvis" in Windows' own voice.
    /// `cargo test --lib wake::tests::the_bundled_sherpa_spots_jarvis -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn the_bundled_sherpa_spots_jarvis() {
        let mut spotter = Detector::load(&sherpa_dir(), &Spec::of("sherpa", "normal", "Jarvis"), "").expect("sherpa loads");
        let mut seed = 7;
        let quiet = room(5.0, &mut seed);
        assert_eq!(run_through(&mut spotter, &quiet), 0, "five seconds of a quiet room is not the word");
        let dir = std::env::temp_dir().join("codenotch-wake-test");
        std::fs::create_dir_all(&dir).unwrap();
        for text in ["Jarvis", "hey Jarvis", "the weather is nice today"] {
            let Some(voice) = spoken(text, &dir) else {
                println!("no System.Speech here: skipped the spoken check");
                return;
            };
            // Four offsets: where the word falls in the model's 16-frame chunks matters a little.
            let mut times = 0;
            for lead in [0.3, 0.55, 0.8, 1.05] {
                spotter.fresh();
                let mut audio = room(lead, &mut seed);
                audio.extend(&voice);
                audio.extend(room(1.5, &mut seed));
                times += (run_through(&mut spotter, &audio) > 0) as usize;
            }
            let last = if let Detector::Sherpa(s) = &spotter { s.last.clone() } else { String::new() };
            println!("{text:?} ({:.2} s): heard at {times} of 4 offsets ({last})", voice.len() as f32 / RATE as f32);
            if text.contains("Jarvis") {
                assert!(times >= 3, "{text:?} is heard");
            } else {
                assert_eq!(times, 0, "{text:?} is not the word");
            }
        }
    }

    /// Roughly what it costs to listen: a minute of a quiet room through the
    /// spotter, CPU time of the whole process over audio time.
    /// `cargo test --release --lib wake::tests::sherpa_idle_cpu -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn sherpa_idle_cpu() {
        use windows::Win32::Foundation::FILETIME;
        use windows::Win32::System::Threading::{GetCurrentProcess, GetProcessTimes};
        let cpu = || unsafe {
            let (mut a, mut b, mut kernel, mut user) = (FILETIME::default(), FILETIME::default(), FILETIME::default(), FILETIME::default());
            GetProcessTimes(GetCurrentProcess(), &mut a, &mut b, &mut kernel, &mut user).unwrap();
            let ticks = |t: FILETIME| ((t.dwHighDateTime as u64) << 32 | t.dwLowDateTime as u64) as f64 / 1e7;
            ticks(kernel) + ticks(user)
        };
        let mut spotter = Detector::load(&sherpa_dir(), &Spec::of("sherpa", "normal", "Jarvis"), "").expect("sherpa loads");
        let mut seed = 11;
        let minute = room(60.0, &mut seed);
        let (start, wall) = (cpu(), Instant::now());
        let heard = run_through(&mut spotter, &minute);
        let spent = cpu() - start;
        println!("60 s of audio: {spent:.2} s CPU ({:.1}% of one core), {:.2} s wall, heard {heard}", spent / 60.0 * 100.0, wall.elapsed().as_secs_f64());
        assert_eq!(heard, 0);
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
        let refused = Porcupine::load(&dir, "not-a-key", 0.5).err();
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

