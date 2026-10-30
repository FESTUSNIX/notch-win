//! Talking with the Guardian on the PC (29 Oct): hold a key in any app and
//! speak; the Guardian (Helm's chat, Claude with its tools) acts, and answers
//! out loud through OpenAI's voice with the text in the island too. Hold it
//! again to answer back. This is the native half; `voice-talk.ts` is the turn.
//!
//! - **The hold.** `pressed` runs from the shortcut handler. The key going UP
//!   is watched here with `GetAsyncKeyState`, for the ring's reason: the
//!   plugin's `Released` never arrives on this machine (shortcuts.rs). The
//!   island hears `voice:down`, `voice:level` while it is held, then
//!   `voice:up {ms}`. Whether that was a tap (under half a second) is the
//!   page's to decide; the microphone opened on the press, so the first word
//!   is never cut.
//! - **The level** while he speaks is the microphone's own peak meter (Core
//!   Audio), not the page's analyser. ⚠️ An AudioContext the page makes without
//!   a gesture is born suspended, and a key pressed in another app is no
//!   gesture in the island: its meter would lie flat on exactly this path.
//! - **The voice.** `voice_say` asks Helm's `/api/speak` (as him,
//!   `helm::speak`) for one sentence as PCM and the player plays it as it
//!   streams in, through `waveOut`. ⚠️ Native for the same reason as the
//!   level: an `<audio>` started from a page that was never clicked is refused
//!   (`click.ts`). Sentences play in order (turn, then seq) however their
//!   commands land, and the next one is fetched while this one plays.
//! - **Never out loud** while presenting, in a call (in-call mode) or in a
//!   meeting on his calendar, or with Spoken replies off (`quiet`): the reply
//!   is text only. Checked before each sentence and every half second while
//!   one plays, so a call starting mid-sentence silences it.
//! - **Escape** stops everything from whatever app has the keyboard, so it is
//!   registered globally while the voice glance is up and let go after
//!   (`voice_keys`); **Enter** too, only while hands-free listening is live
//!   (a tap of the key, 29 Oct round 2), because there Enter sends. Both have
//!   a watchdog, so a page that never says "done" cannot keep either.
//! - **The output lets go when the key goes down.** His microphone and his
//!   speakers are the same Bluetooth earbuds, and opening the microphone
//!   switches them to the hands-free profile; a stereo stream still open on
//!   them is a stream on an endpoint that is about to stop answering. Reopened
//!   for the next sentence, it lands on whatever is current.

use std::collections::{BTreeMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender, TryRecvError};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::GlobalShortcutExt;
use windows::core::PSTR;
use windows::Win32::Media::Audio::Endpoints::IAudioMeterInformation;
use windows::Win32::Media::Audio::{
    eCapture, eConsole, waveOutClose, waveOutGetPosition, waveOutOpen, waveOutPrepareHeader, waveOutReset,
    waveOutUnprepareHeader, waveOutWrite, IMMDeviceEnumerator, MMDeviceEnumerator, CALLBACK_NULL, HWAVEOUT,
    WAVEFORMATEX, WAVEHDR, WAVERR_STILLPLAYING, WAVE_FORMAT_PCM, WAVE_MAPPER,
};
use windows::Win32::Media::{MMSYSERR_NOERROR, MMTIME, TIME_BYTES, TIME_MS, TIME_SAMPLES};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED};

/// OpenAI's PCM: 24 kHz, 16-bit signed little-endian, one channel.
pub const RATE: u32 = 24_000;
const BYTES_PER_SECOND: u64 = RATE as u64 * 2;
/// The keys the voice glance takes for itself (shortcuts.rs hands them here).
pub const ESCAPE: &str = "Escape";
pub const ENTER: &str = "Enter";
/// Helm takes five minutes of recording; a hold past that is a key that stuck.
const LONGEST_HOLD_MS: u64 = 5 * 60_000 + 5_000;
/// How often the level is read while he holds the key, and sent while it speaks.
const LEVEL_EVERY: Duration = Duration::from_millis(33);
/// Audio gathered before a sentence starts, so a slow first chunk is not a stutter.
const PREBUFFER: usize = (BYTES_PER_SECOND / 5) as usize;
/// The smallest piece handed to the device once a sentence is playing.
const BLOCK: usize = (BYTES_PER_SECOND / 10) as usize;
/// One reading of the speaking level covers this much audio (25 ms).
const LEVEL_WINDOW: usize = (BYTES_PER_SECOND / 40) as usize;
/// A sentence waits this long for the one before it, whose command may have landed second.
const GAP_WAIT: Duration = Duration::from_millis(400);
/// The device is let go after this long with nothing to say.
const CLOSE_AFTER: Duration = Duration::from_secs(4);
/// One sentence at most this long (Helm's own cap is 1000).
const MAX_SAY: usize = 1000;
/// The keys are held at most this long past the last time the page asked for
/// them. ⚠️ Short, because one of them is ENTER: the page asks again every ten
/// seconds while it wants them, so a page that died gives them back in half a
/// minute rather than leaving him unable to press Enter anywhere.
const KEYS_FOR_MS: u64 = 30_000;

/* ── The hold ─────────────────────────────────────────────────────────── */

/// When the key went down (ms since start, `shortcuts::now_ms`); zero when up.
static TALK_DOWN: AtomicU64 = AtomicU64::new(0);

/// Whether a press starts a hold, given when the last one went down (zero:
/// it came up). ⚠️ Windows repeats a held key, and every repeat is another
/// press: only the first starts a hold. The flag is trusted only while it is
/// young, for the ring's reason (a lost release must not leave the key dead
/// for the rest of the session). Pure, so turn after turn is under test.
fn starts_hold(down: u64, now: u64) -> bool {
    down == 0 || now.saturating_sub(down) >= LONGEST_HOLD_MS
}

/// The talk key was pressed.
pub fn pressed(app: &AppHandle, shortcut: &str) {
    let now = crate::shortcuts::now_ms();
    if !starts_hold(TALK_DOWN.load(Ordering::SeqCst), now) {
        return;
    }
    let keys = crate::shortcuts::keys_of(shortcut);
    if keys.is_empty() {
        crate::log::note(&format!("voice: {shortcut} has no keys to watch; nothing to hold"));
        return;
    }
    TALK_DOWN.store(now.max(1), Ordering::SeqCst);
    // The Alt of Alt+Q must not open the menu bar of the app in front when it comes up alone.
    crate::shortcuts::mask_menu_key(shortcut);
    // A turn on an island slid off the screen is a key that does nothing (shortcuts.rs, `capture`).
    if crate::config::load().chrome_hidden {
        crate::shortcuts::set_chrome_hidden(app, false);
    }
    // The microphone is about to open: the speakers let go if nothing is being said (module note).
    if let Some(player) = PLAYER.get() {
        let _ = player.send(Command::Free);
    }
    crate::log::note("voice: key down");
    let _ = app.emit_to("tasks", "voice:down", ());
    let app = app.clone();
    std::thread::spawn(move || {
        let meter = Meter::open();
        let held = loop {
            std::thread::sleep(LEVEL_EVERY);
            let held = crate::shortcuts::now_ms().saturating_sub(now);
            if !crate::shortcuts::all_down(&keys) || held > LONGEST_HOLD_MS {
                break held;
            }
            if let Some(level) = meter.as_ref().and_then(Meter::peak) {
                let _ = app.emit_to("tasks", "voice:level", level);
            }
        };
        TALK_DOWN.store(0, Ordering::SeqCst);
        crate::log::note(&format!("voice: key up after {held} ms{}", if meter.is_none() { " (no level meter)" } else { "" }));
        let _ = app.emit_to("tasks", "voice:up", json!({ "ms": held }));
    });
}

/// The default microphone's peak meter. It reads zero until something records
/// from it, which the page does from `voice:down` on.
struct Meter(IAudioMeterInformation);

impl Meter {
    fn open() -> Option<Self> {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            let enumerator: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).ok()?;
            let device = enumerator.GetDefaultAudioEndpoint(eCapture, eConsole).ok()?;
            device.Activate::<IAudioMeterInformation>(CLSCTX_ALL, None).ok().map(Meter)
        }
    }

    fn peak(&self) -> Option<f32> {
        unsafe { self.0.GetPeakValue().ok() }
    }
}

/* ── Quiet ────────────────────────────────────────────────────────────── */

/// Why a reply must not be said out loud, in order of what wins: the switch,
/// then presenting, a call, a meeting. Pure, so the order is under test.
pub fn why_quiet(spoken: bool, presenting: bool, call: bool, meeting: bool) -> Option<&'static str> {
    if !spoken {
        Some("off")
    } else if presenting {
        Some("presenting")
    } else if call {
        Some("call")
    } else if meeting {
        Some("meeting")
    } else {
        None
    }
}

/// ⚠️ The call is `call.rs`'s microphone reading, which only runs with in-call
/// mode on; with it off the calendar is what says he is in a meeting — the
/// curtain's rule (AGENTS 835), and the same meeting test.
pub fn quiet(app: &AppHandle) -> Option<&'static str> {
    why_quiet(
        crate::prefs::current(app).spoken_replies,
        crate::helm::presenting(),
        app.try_state::<crate::call::CallState>().is_some_and(|state| state.snapshot().active),
        crate::curtain::meeting_now(&crate::calendar::get_calendar(app.clone()).events, chrono::Utc::now()),
    )
}

/* ── Escape and Enter, while the voice glance is up ───────────────────── */

/// The keys taken from every app: Escape while the glance is up, Enter only
/// while hands-free listening is live.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Keys {
    pub escape: bool,
    pub enter: bool,
}

/// What to register and what to let go of, to get from `held` to `want`. Pure.
fn plan(held: Keys, want: Keys) -> (Vec<&'static str>, Vec<&'static str>) {
    let mut take = Vec::new();
    let mut give = Vec::new();
    for (key, had, wants) in [(ESCAPE, held.escape, want.escape), (ENTER, held.enter, want.enter)] {
        if wants && !had {
            take.push(key);
        } else if had && !wants {
            give.push(key);
        }
    }
    (take, give)
}

/// Held past the last ask by more than the watchdog allows. Pure.
fn overdue(held: Keys, until: u64, now: u64) -> bool {
    held != Keys::default() && now > until
}

static HELD: std::sync::Mutex<Keys> = std::sync::Mutex::new(Keys { escape: false, enter: false });
static KEYS_UNTIL: AtomicU64 = AtomicU64::new(0);
/// A key another app holds was already said in the log, for this glance.
static REFUSED: AtomicBool = AtomicBool::new(false);

/// `set_shortcuts` let every key go, these with them.
pub fn forget_keys() {
    *HELD.lock().unwrap() = Keys::default();
}

/// Take or give back each key to match `want`. ⚠️ Another app holding one is
/// not an error: that key then works inside the island only.
fn grab(app: &AppHandle, want: Keys) {
    let mut held = HELD.lock().unwrap();
    let before = *held;
    let (take, give) = plan(before, want);
    for &key in &give {
        let _ = app.global_shortcut().unregister(key);
        if key == ESCAPE { held.escape = false } else { held.enter = false }
    }
    for &key in &take {
        if app.global_shortcut().register(key).is_ok() {
            if key == ESCAPE { held.escape = true } else { held.enter = true }
        } else if !REFUSED.swap(true, Ordering::SeqCst) {
            // Said once, not on every renewal ten seconds apart.
            crate::log::note(&format!("voice: {key} is taken by another app; it works inside the island only"));
        }
    }
    if want == Keys::default() {
        REFUSED.store(false, Ordering::SeqCst);
    }
    if *held != before {
        crate::log::note(&format!("voice: keys escape={} enter={}", held.escape, held.enter));
    }
}

/* ── The player ───────────────────────────────────────────────────────── */

enum Piece {
    Audio(Vec<u8>),
    End,
    Failed(String),
}

#[derive(Debug)]
enum Outcome {
    Played,
    Hushed,
    Failed(String),
}

struct Slot {
    pieces: Receiver<Piece>,
    done: Option<tokio::sync::oneshot::Sender<Outcome>>,
    since: Instant,
}

impl Slot {
    fn finish(&mut self, outcome: Outcome) {
        if let Some(done) = self.done.take() {
            let _ = done.send(outcome);
        }
    }
}

enum Command {
    Queue((u64, u32), Slot),
    Hush,
    /// The talk key went down: let the speakers go if nothing is being said.
    Free,
}

static PLAYER: OnceLock<Sender<Command>> = OnceLock::new();
/// Bumped by every hush, so a sentence still downloading stops.
static HUSHES: AtomicU64 = AtomicU64::new(0);

/// Which waiting sentence plays next: the first in order, unless it skips one
/// of its own turn that has not arrived yet — two commands sent back to back
/// can land the other way round — which it waits for briefly. Pure.
fn pick(waiting: &[((u64, u32), Duration)], last: Option<(u64, u32)>) -> Option<(u64, u32)> {
    let &((turn, seq), age) = waiting.first()?;
    let follows = seq == 0 || last == Some((turn, seq - 1)) || last.is_some_and(|(t, s)| t == turn && s >= seq);
    (follows || age >= GAP_WAIT).then_some((turn, seq))
}

/// How loud each 25 ms of 16-bit PCM is, 0..1, keyed by where it ends in the
/// device's stream (`start` is where this piece begins). Pure.
fn levels(data: &[u8], start: u64) -> Vec<(u64, f32)> {
    data.chunks(LEVEL_WINDOW)
        .scan(start, |at, window| {
            *at += window.len() as u64;
            let samples = window.len() / 2;
            if samples == 0 {
                return Some((*at, 0.0));
            }
            let sum: f64 = window.chunks_exact(2).map(|s| {
                let v = i16::from_le_bytes([s[0], s[1]]) as f64 / 32768.0;
                v * v
            }).sum();
            // Speech sits around .05–.3 RMS: lifted so a normal voice fills the bars.
            Some((*at, ((sum / samples as f64).sqrt() * 3.2).min(1.0) as f32))
        })
        .collect()
}

/// The whole samples out of what has arrived; an odd byte waits for its other half. Pure.
fn whole_samples(pending: &mut Vec<u8>) -> Vec<u8> {
    let even = pending.len() & !1;
    pending.drain(..even).collect()
}

/// A `waveOut` position in bytes, whatever unit the driver chose to answer in. Pure.
fn bytes_of(kind: u32, value: u32) -> u64 {
    match kind {
        TIME_BYTES => value as u64,
        TIME_SAMPLES => value as u64 * 2,
        TIME_MS => value as u64 * BYTES_PER_SECOND / 1000,
        _ => 0,
    }
}

/// The output device, and what has been handed to it. ⚠️ Every buffer stays
/// alive (and prepared) until the device is done with it: `waveOutUnprepareHeader`
/// answers STILLPLAYING until then, which is how "done" is told without a
/// callback. The header is boxed and the data's heap buffer never moves, so
/// the pointers handed over stay good while the deque shuffles.
struct Out {
    handle: HWAVEOUT,
    blocks: VecDeque<(Box<WAVEHDR>, Vec<u8>)>,
    /// Bytes handed over since the device was opened or reset.
    written: u64,
}

impl Out {
    fn open() -> Option<Self> {
        let format = WAVEFORMATEX {
            wFormatTag: WAVE_FORMAT_PCM as u16,
            nChannels: 1,
            nSamplesPerSec: RATE,
            nAvgBytesPerSec: RATE * 2,
            nBlockAlign: 2,
            wBitsPerSample: 16,
            cbSize: 0,
        };
        let mut handle = HWAVEOUT(std::ptr::null_mut());
        let result = unsafe { waveOutOpen(Some(&mut handle as *mut HWAVEOUT), WAVE_MAPPER, &format, None, None, CALLBACK_NULL) };
        if result != MMSYSERR_NOERROR {
            crate::log::note(&format!("voice: no output device ({result})"));
            return None;
        }
        Some(Self { handle, blocks: VecDeque::new(), written: 0 })
    }

    fn write(&mut self, mut data: Vec<u8>) -> bool {
        if data.is_empty() {
            return true;
        }
        let size = std::mem::size_of::<WAVEHDR>() as u32;
        let mut header = Box::new(WAVEHDR::default());
        header.lpData = PSTR(data.as_mut_ptr());
        header.dwBufferLength = data.len() as u32;
        unsafe {
            if waveOutPrepareHeader(self.handle, &mut *header, size) != MMSYSERR_NOERROR {
                return false;
            }
            if waveOutWrite(self.handle, &mut *header, size) != MMSYSERR_NOERROR {
                let _ = waveOutUnprepareHeader(self.handle, &mut *header, size);
                return false;
            }
        }
        self.written += data.len() as u64;
        self.blocks.push_back((header, data));
        true
    }

    /// Let go of what has played.
    fn reap(&mut self) {
        let size = std::mem::size_of::<WAVEHDR>() as u32;
        while let Some((header, _)) = self.blocks.front_mut() {
            if unsafe { waveOutUnprepareHeader(self.handle, &mut **header, size) } == WAVERR_STILLPLAYING {
                break;
            }
            self.blocks.pop_front();
        }
    }

    fn busy(&self) -> bool {
        !self.blocks.is_empty()
    }

    /// How far playback has got, in bytes since the device was opened or reset.
    fn played(&self) -> u64 {
        let mut time = MMTIME { wType: TIME_BYTES, ..Default::default() };
        if unsafe { waveOutGetPosition(self.handle, &mut time, std::mem::size_of::<MMTIME>() as u32) } != MMSYSERR_NOERROR {
            return 0;
        }
        let kind = time.wType;
        bytes_of(kind, unsafe { time.u.cb })
    }

    /// Stop now. Everything queued is marked done by the reset, so it all comes back.
    fn reset(&mut self) {
        unsafe {
            let _ = waveOutReset(self.handle);
        }
        self.reap();
        self.blocks.clear();
        self.written = 0;
    }
}

impl Drop for Out {
    fn drop(&mut self) {
        self.reset();
        unsafe {
            let _ = waveOutClose(self.handle);
        }
    }
}

/// The sentence being played.
struct Playing {
    key: (u64, u32),
    slot: Slot,
    pending: Vec<u8>,
    /// None while it is still arriving; `Some(None)` all here; `Some(Some(_))` it failed.
    ended: Option<Option<String>>,
    started: bool,
}

pub fn spawn(app: AppHandle) {
    let (sender, commands) = mpsc::channel::<Command>();
    if PLAYER.set(sender).is_err() {
        return;
    }
    crate::guard::spawn("voice player", move || run(&app, &commands));
}

fn run(app: &AppHandle, commands: &Receiver<Command>) {
    let mut out: Option<Out> = None;
    let mut waiting: BTreeMap<(u64, u32), Slot> = BTreeMap::new();
    let mut playing: Option<Playing> = None;
    let mut last: Option<(u64, u32)> = None;
    let mut loudness: VecDeque<(u64, f32)> = VecDeque::new();
    let mut idle = Instant::now();
    let mut sent_level = Instant::now();
    let mut checked = Instant::now();

    let hush = |out: &mut Option<Out>, waiting: &mut BTreeMap<(u64, u32), Slot>, playing: &mut Option<Playing>, loudness: &mut VecDeque<(u64, f32)>| {
        /* Stopped, and let go: a hush is a barge-in or Escape, and a barge-in
         * opens the microphone (the module note on Bluetooth). Dropping the
         * device resets it first, so every buffer comes back. */
        *out = None;
        if let Some(mut now) = playing.take() {
            now.slot.finish(Outcome::Hushed);
        }
        for (_, mut slot) in std::mem::take(waiting) {
            slot.finish(Outcome::Hushed);
        }
        loudness.clear();
        let _ = app.emit_to("tasks", "voice:out", 0.0);
    };

    loop {
        let busy = playing.is_some() || !waiting.is_empty() || out.as_ref().is_some_and(Out::busy);
        let first = commands.recv_timeout(if busy { Duration::from_millis(15) } else { Duration::from_millis(500) });
        let mut next = match first {
            Ok(command) => Some(command),
            Err(RecvTimeoutError::Timeout) => None,
            Err(RecvTimeoutError::Disconnected) => return,
        };
        while let Some(command) = next.take() {
            match command {
                Command::Queue(key, slot) => {
                    waiting.insert(key, slot);
                }
                Command::Hush => {
                    hush(&mut out, &mut waiting, &mut playing, &mut loudness);
                    last = None;
                }
                Command::Free => {
                    if playing.is_none() && waiting.is_empty() {
                        out = None;
                    }
                }
            }
            next = commands.try_recv().ok();
        }

        /* Escape and Enter, held past their time by a page that never let them
         * go. ⚠️ Given back ON THE MAIN THREAD, never from here: `grab` holds
         * the keys' lock while the plugin's `unregister` waits for the main
         * thread, and a `voice_keys` running there at that moment would wait
         * for the lock — the whole app frozen. Pushed out first, so the next
         * pass does not post it again. */
        if overdue(*HELD.lock().unwrap(), KEYS_UNTIL.load(Ordering::SeqCst), crate::shortcuts::now_ms()) {
            KEYS_UNTIL.store(u64::MAX, Ordering::SeqCst);
            crate::log::note("voice: the page stopped asking for the keys; giving them back");
            let hand = app.clone();
            let _ = app.run_on_main_thread(move || grab(&hand, Keys::default()));
        }

        // A call, a meeting or presenting began mid-sentence: silent at once, and the page is told why.
        if (playing.is_some() || !waiting.is_empty()) && checked.elapsed() >= Duration::from_millis(500) {
            checked = Instant::now();
            if let Some(why) = quiet(app) {
                hush(&mut out, &mut waiting, &mut playing, &mut loudness);
                let _ = app.emit_to("tasks", "voice:muted", why);
                continue;
            }
        }

        if playing.is_none() {
            let ages: Vec<((u64, u32), Duration)> = waiting.iter().map(|(key, slot)| (*key, slot.since.elapsed())).collect();
            if let Some(key) = pick(&ages, last) {
                if let Some(slot) = waiting.remove(&key) {
                    playing = Some(Playing { key, slot, pending: Vec::new(), ended: None, started: false });
                }
            }
        }

        if let Some(now) = playing.as_mut() {
            loop {
                match now.slot.pieces.try_recv() {
                    Ok(Piece::Audio(bytes)) => now.pending.extend_from_slice(&bytes),
                    Ok(Piece::End) => now.ended = Some(None),
                    Ok(Piece::Failed(why)) => now.ended = Some(Some(why)),
                    Err(TryRecvError::Empty) => break,
                    Err(TryRecvError::Disconnected) => {
                        if now.ended.is_none() {
                            now.ended = Some(None);
                        }
                        break;
                    }
                }
            }
            let ready = if now.started { now.pending.len() >= BLOCK } else { now.pending.len() >= PREBUFFER };
            if (ready || now.ended.is_some()) && now.pending.len() >= 2 {
                if out.is_none() {
                    out = Out::open();
                }
                let data = whole_samples(&mut now.pending);
                match out.as_mut() {
                    Some(device) => {
                        loudness.extend(levels(&data, device.written));
                        if device.write(data) {
                            now.started = true;
                        } else {
                            now.ended = Some(Some("The speakers wouldn't play it.".into()));
                            now.pending.clear();
                        }
                    }
                    None => {
                        now.ended = Some(Some("No speakers to play it on.".into()));
                        now.pending.clear();
                    }
                }
            }
        }

        if let Some(device) = out.as_mut() {
            device.reap();
        }

        // Done: all of it arrived and the device has played the last of it.
        let finished = playing.as_ref().is_some_and(|now| now.ended.is_some() && now.pending.len() < 2 && !out.as_ref().is_some_and(Out::busy));
        if finished {
            let mut now = playing.take().expect("checked above");
            last = Some(now.key);
            let outcome = match now.ended.take().flatten() {
                Some(why) => Outcome::Failed(why),
                None => Outcome::Played,
            };
            now.slot.finish(outcome);
            if waiting.is_empty() {
                loudness.clear();
                let _ = app.emit_to("tasks", "voice:out", 0.0);
            }
        }

        // The speaking level, in step with what is being heard rather than what was written.
        if let Some(device) = out.as_ref() {
            if !loudness.is_empty() && sent_level.elapsed() >= LEVEL_EVERY {
                sent_level = Instant::now();
                let heard = device.played();
                while loudness.len() > 1 && loudness.front().is_some_and(|(end, _)| *end <= heard) {
                    loudness.pop_front();
                }
                let level = loudness.front().map(|(_, level)| *level).unwrap_or(0.0);
                let _ = app.emit_to("tasks", "voice:out", level);
            }
        }

        let busy = playing.is_some() || !waiting.is_empty() || out.as_ref().is_some_and(Out::busy);
        if busy {
            idle = Instant::now();
        } else if out.is_some() && idle.elapsed() >= CLOSE_AFTER {
            // Nothing to say for a while: the device goes back (it shows in the volume mixer while open).
            out = None;
        }
    }
}

/* ── Commands ─────────────────────────────────────────────────────────── */

/// Why a reply would be text only right now (`off`, `presenting`, `call`,
/// `meeting`), or null — so the island can say so before the reply comes.
#[tauri::command]
pub fn voice_quiet(app: AppHandle) -> Option<String> {
    quiet(&app).map(str::to_string)
}

/// Say one sentence of the Guardian's reply, after the ones before it (`seq`,
/// from 0, within `turn`). Answers once it has been heard: `{played: true}`,
/// `{hushed: true}` (Escape, barge-in, a call starting), `{muted: why}` without
/// a sound (`quiet`), or `{unavailable: true}` from a Helm without `/api/speak`
/// (404) or without OpenAI (503). A failure is a sentence.
#[tauri::command]
pub async fn voice_say(app: AppHandle, text: String, turn: u64, seq: u32) -> Result<serde_json::Value, String> {
    let text: String = text.trim().chars().take(MAX_SAY).collect();
    if text.is_empty() {
        return Ok(json!({ "played": false }));
    }
    if let Some(why) = quiet(&app) {
        return Ok(json!({ "muted": why }));
    }
    let player = PLAYER.get().ok_or("The voice isn't running.")?;
    let hushes = HUSHES.load(Ordering::SeqCst);
    let (pieces, arriving) = mpsc::channel();
    let (done, heard) = tokio::sync::oneshot::channel();
    player
        .send(Command::Queue((turn, seq), Slot { pieces: arriving, done: Some(done), since: Instant::now() }))
        .map_err(|_| "The voice isn't running.".to_string())?;

    let mut response = match crate::helm::speak(&text).await {
        Ok(response) => response,
        Err(why) => {
            crate::log::note(&format!("voice: sentence {turn}/{seq} not fetched: {why}"));
            let _ = pieces.send(Piece::Failed(why.clone()));
            return Err(why);
        }
    };
    match response.status().as_u16() {
        404 | 503 => {
            let _ = pieces.send(Piece::Failed("unavailable".into()));
            return Ok(json!({ "unavailable": true }));
        }
        status if !(200..300).contains(&status) => {
            let body: serde_json::Value = response.json().await.unwrap_or_default();
            let why = body["error"].as_str().unwrap_or("Helm couldn't say that.").to_string();
            let _ = pieces.send(Piece::Failed(why.clone()));
            return Err(why);
        }
        _ => {}
    }
    loop {
        // Hushed while it was still coming: stop downloading what nobody will hear.
        if HUSHES.load(Ordering::SeqCst) != hushes {
            break;
        }
        match response.chunk().await {
            Ok(Some(chunk)) => {
                if pieces.send(Piece::Audio(chunk.to_vec())).is_err() {
                    break;
                }
            }
            Ok(None) => {
                let _ = pieces.send(Piece::End);
                break;
            }
            Err(_) => {
                let _ = pieces.send(Piece::Failed("The voice dropped mid-sentence.".into()));
                break;
            }
        }
    }
    drop(pieces);
    match heard.await {
        Ok(Outcome::Played) => Ok(json!({ "played": true })),
        Ok(Outcome::Hushed) | Err(_) => Ok(json!({ "hushed": true })),
        Ok(Outcome::Failed(why)) => Err(why),
    }
}

/// Stop speaking now, and drop every sentence still to come.
#[tauri::command]
pub fn voice_hush() {
    HUSHES.fetch_add(1, Ordering::SeqCst);
    if let Some(player) = PLAYER.get() {
        let _ = player.send(Command::Hush);
    }
}

/// Take Escape (the glance is up) and Enter (hands-free listening) from every
/// app, or give them back: the whole set each time, so a lost call cannot
/// leave one held. ⚠️ Held for `KEYS_FOR_MS` past the last ask at most; the
/// page asks again on every step and every ten seconds between.
#[tauri::command]
pub fn voice_keys(app: AppHandle, escape: bool, enter: bool) {
    KEYS_UNTIL.store(crate::shortcuts::now_ms() + KEYS_FOR_MS, Ordering::SeqCst);
    grab(&app, Keys { escape, enter });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_switch_wins_then_presenting_a_call_and_a_meeting() {
        assert_eq!(why_quiet(true, false, false, false), None);
        assert_eq!(why_quiet(false, true, true, true), Some("off"));
        assert_eq!(why_quiet(true, true, true, true), Some("presenting"));
        assert_eq!(why_quiet(true, false, true, true), Some("call"));
        assert_eq!(why_quiet(true, false, false, true), Some("meeting"));
    }

    /// ⚠️ Two `voice_say`s sent back to back are two tasks on the runtime, and
    /// the second can reach the player first. A sentence never jumps the one
    /// before it — unless that one is not coming.
    #[test]
    fn sentences_play_in_order_whatever_order_they_land_in() {
        let fresh = Duration::from_millis(10);
        assert_eq!(pick(&[], None), None);
        assert_eq!(pick(&[((1, 0), fresh)], None), Some((1, 0)));
        // Seq 1 landed before seq 0: it waits.
        assert_eq!(pick(&[((1, 1), fresh)], None), None);
        assert_eq!(pick(&[((1, 1), fresh)], Some((1, 0))), Some((1, 1)), "its predecessor has played");
        assert_eq!(pick(&[((1, 1), GAP_WAIT)], None), Some((1, 1)), "the missing one isn't coming");
        // A new turn starts at 0 whatever the last turn played.
        assert_eq!(pick(&[((2, 0), fresh)], Some((1, 4))), Some((2, 0)));
        assert_eq!(pick(&[((2, 0), fresh), ((2, 1), fresh)], None), Some((2, 0)), "lowest first");
    }

    #[test]
    fn the_level_follows_the_samples_in_quarter_tenths() {
        let silent = vec![0u8; LEVEL_WINDOW * 2];
        let got = levels(&silent, 100);
        assert_eq!(got.len(), 2);
        assert_eq!(got[0], (100 + LEVEL_WINDOW as u64, 0.0));
        assert_eq!(got[1].0, 100 + 2 * LEVEL_WINDOW as u64, "keyed by where each window ENDS in the stream");
        // A full-scale square wave is as loud as it gets.
        let loud: Vec<u8> = (0..LEVEL_WINDOW / 2).flat_map(|i| if i % 2 == 0 { i16::MAX.to_le_bytes() } else { i16::MIN.to_le_bytes() }).collect();
        assert_eq!(levels(&loud, 0)[0].1, 1.0);
        // A quiet voice is lifted, not lost.
        let soft: Vec<u8> = (0..LEVEL_WINDOW / 2).flat_map(|i| (if i % 2 == 0 { 3000i16 } else { -3000 }).to_le_bytes()).collect();
        let level = levels(&soft, 0)[0].1;
        assert!(level > 0.2 && level < 0.5, "{level}");
    }

    #[test]
    fn an_odd_byte_waits_for_its_other_half() {
        let mut pending = vec![1, 2, 3, 4, 5];
        assert_eq!(whole_samples(&mut pending), vec![1, 2, 3, 4]);
        assert_eq!(pending, vec![5]);
        pending.push(6);
        assert_eq!(whole_samples(&mut pending), vec![5, 6]);
        assert!(pending.is_empty());
    }

    #[test]
    fn a_position_is_bytes_whatever_the_driver_answers_in() {
        assert_eq!(bytes_of(TIME_BYTES, 4800), 4800);
        assert_eq!(bytes_of(TIME_SAMPLES, 2400), 4800);
        assert_eq!(bytes_of(TIME_MS, 100), 4800);
        assert_eq!(bytes_of(0x40, 7), 0, "a unit it can't read is no progress, not a guess");
    }

    /// ⚠️ The regression for "it recorded the first time and then never
    /// again": turn after turn — hold, the reply, hold again, a barge-in, a
    /// hold Escape ended, a hold again — every press that comes after a
    /// release starts a hold, and only a repeat of a key still down does not.
    #[test]
    fn every_press_after_a_release_starts_a_hold_turn_after_turn() {
        let mut down = 0u64;
        let mut holds = 0;
        // (when, pressed or released) for five turns, with the key's own repeats in the first.
        let script = [
            (1_000, true), (1_030, true), (1_060, true), (3_400, false), // hold, speak, let go
            (9_000, true), (11_200, false),                            // hold again after the reply
            (12_500, true), (14_000, false),                           // barge-in while it speaks
            (20_000, true), (20_900, false),                           // a hold Escape ended
            (24_000, true), (24_150, false),                           // a tap: hands-free
            (31_000, true), (31_100, false),                           // the tap that sends
            (40_000, true), (43_000, false),                           // and a hold again
        ];
        for (now, pressed) in script {
            if pressed {
                if starts_hold(down, now) {
                    holds += 1;
                    down = now;
                }
            } else {
                down = 0;
            }
        }
        assert_eq!(holds, 7, "the two repeats of the first hold are not holds; every other press is");
        // A release that never came still leaves the key alive once the longest hold has passed.
        assert!(!starts_hold(1_000, 1_000 + LONGEST_HOLD_MS - 1));
        assert!(starts_hold(1_000, 1_000 + LONGEST_HOLD_MS));
    }

    /// The keys across the same turns, as the page asks for them: Escape for
    /// as long as the glance is up, Enter only while hands-free listens, and
    /// both given back at the end — every turn, not just the first.
    #[test]
    fn escape_and_enter_are_taken_and_given_back_turn_after_turn() {
        let none = Keys::default();
        let esc = Keys { escape: true, enter: false };
        let free = Keys { escape: true, enter: true };
        let mut held = none;
        let mut taken = Vec::new();
        let mut given = Vec::new();
        for want in [esc, esc, none, esc, none, esc, esc, none, free, esc, none, esc, none] {
            let (take, give) = plan(held, want);
            taken.extend(take);
            given.extend(give);
            held = want;
        }
        assert_eq!(held, none, "nothing is kept after the last turn");
        assert_eq!(taken.iter().filter(|k| **k == ESCAPE).count(), 5, "Escape once per turn, not once per ask");
        assert_eq!(taken.iter().filter(|k| **k == ENTER).count(), 1, "Enter only for the hands-free turn");
        assert_eq!(taken.len(), given.len(), "everything taken is given back");
        assert_eq!(plan(free, esc), (vec![], vec![ENTER]), "sent: Enter goes back, Escape stays for the reply");
        // The watchdog: held keys past their time go back; nothing held is never overdue.
        assert!(overdue(esc, 10_000, 10_001));
        assert!(!overdue(esc, 10_000, 9_000));
        assert!(!overdue(none, 10_000, 99_000));
    }

    /// A barge-in hushes and the next turn's sentences still play in order.
    #[test]
    fn a_second_turn_plays_from_its_first_sentence() {
        let fresh = Duration::from_millis(10);
        // Turn 1 played seq 0 and 1, then a hush (last forgotten): turn 2 starts at 0.
        assert_eq!(pick(&[((2, 0), fresh)], None), Some((2, 0)));
        assert_eq!(pick(&[((2, 1), fresh)], Some((2, 0))), Some((2, 1)));
        // And a third turn after that, whatever the second left as `last`.
        assert_eq!(pick(&[((3, 0), fresh), ((3, 1), fresh)], Some((2, 4))), Some((3, 0)));
        assert_eq!(pick(&[((3, 1), fresh)], Some((3, 0))), Some((3, 1)));
    }

    #[test]
    fn the_buffers_are_sized_in_whole_samples() {
        for size in [PREBUFFER, BLOCK, LEVEL_WINDOW] {
            assert_eq!(size % 2, 0, "{size}");
        }
        assert_eq!(BLOCK, 4800, "a tenth of a second at 24 kHz");
    }
}
