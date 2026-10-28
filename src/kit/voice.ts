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
 */

/** The longest recording Helm takes (`/api/transcribe`: ≤ 5 min). ⚠️ And
 *  the deployed Helm refuses a body over 4.5 MB (Vercel), which is why the
 *  recording is opus at 32 kbit/s — about 1.2 MB for the five minutes. */
export const MAX_SECONDS = 300;
/** Shorter than this was a tap, not something said. */
export const MIN_SECONDS = 0.45;

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
  if (name === "NotAllowedError" || name === "SecurityError") return "The microphone is off for apps — Windows Settings › Privacy › Microphone";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No microphone found";
  if (name === "NotReadableError" || name === "AbortError") return "The microphone is busy in another app";
  return "The microphone didn't start";
}

export class Recorder {
  state: "idle" | "starting" | "recording" = "idle";
  /** 0..1, smoothed, while recording. */
  level = 0;
  startedAt = 0;
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private context: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private frame = 0;
  private cap = 0;
  /** Let go while the microphone was still opening: that was a tap, and the
   *  stream is closed the moment it arrives. */
  private released = false;
  onLevel: ((level: number) => void) | null = null;
  /** Ran out of time (five minutes): finished on its own. */
  onLimit: (() => void) | null = null;

  get seconds(): number { return this.state === "recording" ? (performance.now() - this.startedAt) / 1000 : 0; }

  async start(): Promise<void> {
    if (this.state !== "idle") return;
    this.state = "starting";
    this.released = false;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (error) {
      this.state = "idle";
      throw error;
    }
    if (this.released) return this.teardown();
    const mime = pickMime(type => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(type));
    this.recorder = new MediaRecorder(this.stream, mime ? { mimeType: mime, audioBitsPerSecond: 32_000 } : undefined);
    this.chunks = [];
    this.recorder.ondataavailable = event => { if (event.data.size) this.chunks.push(event.data); };
    this.recorder.start(250);
    this.startedAt = performance.now();
    this.state = "recording";
    this.meter();
    this.cap = window.setTimeout(() => { this.onLimit?.(); }, MAX_SECONDS * 1000);
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
  finish(): Promise<Recording | null> {
    if (this.state === "starting") { this.released = true; return Promise.resolve(null); }
    if (this.state !== "recording" || !this.recorder) return Promise.resolve(null);
    const seconds = this.seconds;
    const recorder = this.recorder;
    const mime = recorder.mimeType || "audio/webm";
    return new Promise(resolve => {
      recorder.onstop = () => {
        const blob = new Blob(this.chunks, { type: mime.split(";")[0] });
        this.teardown();
        const recording = seconds >= MIN_SECONDS && blob.size > 0 ? { blob, mime: mime.split(";")[0], seconds } : null;
        resolve(recording);
      };
      try { recorder.stop(); } catch { this.teardown(); resolve(null); }
    });
  }

  cancel() {
    if (this.state === "starting") { this.released = true; return; }
    if (this.recorder) {
      this.recorder.onstop = null;
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
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
    this.recorder = null;
    this.chunks = [];
    this.level = 0;
    this.state = "idle";
  }
}

/** A blob as base64, for the bridge to Rust (which sends it to Helm). */
export async function base64Of(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}
