/* Hold to talk: the microphone, recorded in the webview, for Helm to turn
 * into words (`/api/transcribe`).
 *
 * Not the Web Speech API Helm's own composer uses: WebView2 does not ship a
 * recognition service, so here the audio is recorded (MediaRecorder, opus in
 * webm) and sent; Helm answers with the text, which goes into the composer
 * for him to read before it is sent. Never sent by itself.
 *
 * ⚠️ The microphone needs two permissions, and they fail differently:
 * - WebView2's own. Asked as a prompt the island cannot show (it is a
 *   transparent, non-activating window), so the page would wait for ever on a
 *   dialog nobody can see. `mic.rs` answers it for this app's own pages.
 * - Windows' ("Let desktop apps access your microphone"). Off, getUserMedia
 *   rejects with NotAllowedError or NotReadableError — said in words below,
 *   because "nothing happened" is the other way that looks.
 *
 * ⚠️⚠️ A microphone is slow to open and can stop by itself, and both used to
 * wedge this for good (AGENTS 851). His is a pair of Bluetooth earbuds:
 * opening it switches them to the hands-free profile, which takes a second or
 * more, and the switch can end the track mid-recording. So a press while the
 * last start is still opening ADOPTS it, an open that never answers is given
 * up on, and `finish` never waits for a `stop` event that has already fired.
 */

/** The longest recording Helm takes (`/api/transcribe`: ≤ 5 min). ⚠️ And
 *  the deployed Helm refuses a body over 4.5 MB (Vercel), which is why the
 *  recording is opus at 32 kbit/s — about 1.2 MB for the five minutes. */
export const MAX_SECONDS = 300;
/** Shorter than this was a tap, not something said. */
export const MIN_SECONDS = 0.45;
/** How long the microphone may take to open before it is given up on. A
 *  Bluetooth headset switching profile takes one to three seconds. */
export const OPEN_SECONDS = 8;
/** How long `finish` waits for the recorder to hand over its last data. */
const STOP_GRACE_MS = 1500;

export interface Recording {
  blob: Blob;
  mime: string;
  seconds: number;
}

/** The type to record in: opus in webm where the webview has it (WebView2
 *  and Chrome do), ogg next, whatever it offers last. */
export function pickMime(supported: (mime: string) => boolean): string {
  for (const mime of ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/webm"]) {
    if (supported(mime)) return mime;
  }
  return "";
}

/** Why the microphone would not open, in words. */
export function voiceProblem(error: unknown): string {
  const name = (error as { name?: string })?.name ?? "";
  if (name === "TimeoutError") return "The microphone didn't start in time";
  if (name === "NotAllowedError" || name === "SecurityError") return "The microphone is off for apps — Windows Settings › Privacy › Microphone";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No microphone found";
  if (name === "NotReadableError" || name === "AbortError") return "The microphone is busy in another app";
  return "The microphone didn't start";
}

/** The webview's id for the microphone Settings picked (`wakeMicName`), by
 *  its NAME: the webview's ids are its own hashes, but its labels are
 *  Windows' names, a USB one with " (vid:pid)" after. `null` when it is not
 *  plugged in; `undefined` when the labels are hidden (no microphone
 *  permission yet in this profile) and nothing can be told apart.
 *  ⚠️ "default" and "communications" are the same device again under a
 *  prefix, never a match. */
export function pickMic(devices: { deviceId: string; label: string; kind: string }[], name: string): string | null | undefined {
  const want = name.trim().toLowerCase();
  const inputs = devices.filter(d => d.kind === "audioinput" && d.deviceId !== "default" && d.deviceId !== "communications");
  if (!want) return undefined;
  if (inputs.length && inputs.every(d => !d.label)) return undefined;
  const found = inputs.find(d => d.label.trim().toLowerCase() === want)
    ?? inputs.find(d => d.label.trim().toLowerCase().startsWith(`${want} (`));
  return found ? found.deviceId : null;
}

export class Recorder {
  state: "idle" | "starting" | "recording" = "idle";
  /** 0..1, smoothed, while recording. */
  level = 0;
  startedAt = 0;
  /** How long the last start took to open the microphone, in ms (for the log). */
  openedIn = 0;
  /** The microphone stopped by itself during this recording. */
  lost = false;
  /** The microphone to record from, by name (Settings → Voice); empty is the
   *  webview's default, as before. Read on each start. */
  preferMic = "";
  /** Which microphone the last start used: the chosen one, the default
   *  because none is chosen, or the default because the chosen one is not
   *  plugged in / its name could not be read. For the log and the pill. */
  usedMic: "chosen" | "default" | "missing" | "hidden" = "default";
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private context: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private frame = 0;
  private cap = 0;
  /** Let go while the microphone was still opening: that was a tap, and the
   *  stream is closed the moment it arrives — unless another start adopts it. */
  private released = false;
  /** The open in flight, for a second start to wait on rather than skip. */
  private opening: Promise<void> | null = null;
  /** Settles once the MediaRecorder has stopped, however it stopped. */
  private stopped: Promise<void> = Promise.resolve();
  onLevel: ((level: number) => void) | null = null;
  /** Ran out of time (five minutes): finished on its own. */
  onLimit: (() => void) | null = null;
  /** The microphone went away mid-recording (a headset switching profile,
   *  another app taking the device): what was recorded is all there is. */
  onLost: (() => void) | null = null;

  get seconds(): number { return this.state === "recording" ? (performance.now() - this.startedAt) / 1000 : 0; }

  async start(): Promise<void> {
    /* ⚠️⚠️ A start while the last one is still opening ADOPTS it. It used to
     * return at once, and the open it skipped then saw the tap's `released`
     * and closed itself — so a press within a second of a tap (stopping the
     * voice, then answering) recorded nothing, with the listening glance up
     * the whole time (AGENTS 851). */
    if (this.state === "starting") {
      this.released = false;
      return this.opening ?? undefined;
    }
    if (this.state !== "idle") return;
    this.state = "starting";
    this.released = false;
    this.lost = false;
    this.opening = this.open();
    try {
      await this.opening;
    } finally {
      this.opening = null;
    }
  }

  private async open() {
    const asked = performance.now();
    let stream: MediaStream;
    try {
      /* ⚠️ With no microphone chosen getUserMedia is still asked in this same
       * tick, as before: a press that adopts this start counts on it. */
      this.usedMic = "default";
      const asking = this.preferMic.trim()
        ? this.constraints().then(audio => navigator.mediaDevices.getUserMedia({ audio }))
        : navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      stream = await deadline(asking,
        OPEN_SECONDS * 1000, late => { for (const track of late.getTracks()) track.stop(); });
    } catch (error) {
      this.state = "idle";
      throw error;
    }
    this.openedIn = Math.round(performance.now() - asked);
    this.stream = stream;
    if (this.released) return this.teardown();
    const mime = pickMime(type => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(type));
    const recorder = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 32_000 } : undefined);
    this.recorder = recorder;
    this.chunks = [];
    recorder.ondataavailable = event => { if (event.data.size) this.chunks.push(event.data); };
    /* ⚠️ Listened for from the START, not from `finish`: a recorder whose
     * track ends stops by itself and fires its `stop` then — and `stop()` on
     * an inactive recorder fires nothing at all, so a listener set later
     * waited for ever and the turn sat in "transcribing" for good. */
    this.stopped = new Promise(done => { recorder.onstop = () => done(); });
    for (const track of stream.getAudioTracks()) {
      track.onended = () => {
        if (this.recorder !== recorder || this.lost) return;
        this.lost = true;
        this.onLost?.();
      };
    }
    recorder.start(250);
    this.startedAt = performance.now();
    this.state = "recording";
    this.meter();
    this.cap = window.setTimeout(() => { this.onLimit?.(); }, MAX_SECONDS * 1000);
  }

  /** The chosen microphone by its webview id, or the default when none is
   *  chosen. ⚠️ A chosen one that is unplugged falls back to the default and
   *  says so (`usedMic`): a turn that refuses to record is worse than one on
   *  the other microphone. */
  private async constraints(): Promise<MediaTrackConstraints> {
    const base: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true };
    this.usedMic = "default";
    if (!this.preferMic.trim() || !navigator.mediaDevices?.enumerateDevices) return base;
    const devices = await navigator.mediaDevices.enumerateDevices().catch(() => [] as MediaDeviceInfo[]);
    const id = pickMic(devices, this.preferMic);
    this.usedMic = id ? "chosen" : id === null ? "missing" : "hidden";
    return id ? { ...base, deviceId: { exact: id } } : base;
  }

  /** The level, from an analyser on the same stream. ⚠️ Optional: a webview
   *  that refuses an AudioContext still records, the bars just stay still. */
  private meter() {
    try {
      this.context = new AudioContext();
      const source = this.context.createMediaStreamSource(this.stream!);
      this.analyser = this.context.createAnalyser();
      this.analyser.fftSize = 512;
      source.connect(this.analyser);
      const data = new Uint8Array(this.analyser.fftSize);
      const loop = () => {
        if (!this.analyser) return;
        this.analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (const v of data) sum += ((v - 128) / 128) ** 2;
        const rms = Math.sqrt(sum / data.length);
        // Speech sits around .02–.2 RMS; lift it so a normal voice fills the meter.
        const target = Math.min(1, rms * 5.5);
        this.level += (target - this.level) * (target > this.level ? 0.55 : 0.18);
        this.onLevel?.(this.level);
        this.frame = requestAnimationFrame(loop);
      };
      this.frame = requestAnimationFrame(loop);
    } catch {
      this.context = null;
    }
  }

  /** Let go: what was said, or null for a tap or nothing heard. */
  async finish(): Promise<Recording | null> {
    if (this.state === "starting") { this.released = true; return null; }
    if (this.state !== "recording" || !this.recorder) return null;
    const seconds = this.seconds;
    const recorder = this.recorder;
    const mime = (recorder.mimeType || "audio/webm").split(";")[0];
    if (recorder.state !== "inactive") {
      try { recorder.stop(); } catch { /* stopped by itself in between */ }
    }
    // ⚠️ Bounded too: a recorder that never says it stopped must not hold the turn.
    await Promise.race([this.stopped, new Promise(done => window.setTimeout(done, STOP_GRACE_MS))]);
    if (this.recorder !== recorder) return null;
    const blob = new Blob(this.chunks, { type: mime });
    this.teardown();
    return seconds >= MIN_SECONDS && blob.size > 0 ? { blob, mime, seconds } : null;
  }

  cancel() {
    if (this.state === "starting") { this.released = true; return; }
    if (this.recorder && this.recorder.state !== "inactive") {
      try { this.recorder.stop(); } catch { /* already */ }
    }
    this.teardown();
  }

  private teardown() {
    window.clearTimeout(this.cap);
    cancelAnimationFrame(this.frame);
    this.analyser = null;
    void this.context?.close().catch(() => {});
    this.context = null;
    for (const track of this.stream?.getTracks() ?? []) {
      track.onended = null;
      track.stop();
    }
    this.stream = null;
    this.recorder = null;
    this.chunks = [];
    this.level = 0;
    this.state = "idle";
  }
}

/** `work`, or a TimeoutError after `ms`; what `work` brings after that is
 *  handed to `late` to be let go (a microphone opened after the give-up). */
function deadline<T>(work: Promise<T>, ms: number, late: (value: T) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    let over = false;
    const timer = window.setTimeout(() => {
      over = true;
      reject(Object.assign(new Error("The microphone didn't start in time"), { name: "TimeoutError" }));
    }, ms);
    work.then(
      value => { if (over) late(value); else { window.clearTimeout(timer); resolve(value); } },
      error => { if (!over) { window.clearTimeout(timer); reject(error); } },
    );
  });
}

/** A blob as base64, for the bridge to Rust (which sends it to Helm). */
export async function base64Of(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}
