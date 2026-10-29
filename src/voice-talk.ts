/* Talking with the Guardian from anywhere (29 Oct): hold the talk key (Alt+Q
 * by default) in any app and speak; let go and the Guardian acts and answers
 * out loud, in the same thread as its screen. The state machine is
 * `voice-turn.ts`; this carries out what it says, and draws the strip.
 *
 * - The key is native (`voice.rs`): `voice:down`, `voice:level` while held,
 *   `voice:up {ms}`. The microphone opens on the press (the kit's recorder, the
 *   composer's own); the island comes up only once it has been held half a
 *   second, so a tap does nothing at all.
 * - The words go through Helm's `/api/transcribe` (OpenAI), then to the
 *   Guardian's chat with `voice: true`, which makes the reply short and
 *   speakable. Its tools, receipts and cards are the chat's as ever.
 * - The reply is said sentence by sentence as it streams (`voice_say`, played
 *   natively from Helm's `/api/speak`): the first is heard while the rest is
 *   still being written.
 * - The strip sits over the composer in the Guardian's foot: a disc for what is
 *   happening (listening hot, the Guardian's own accent for the rest), the
 *   voice as bars — his while he holds, the Guardian's while it speaks — and a
 *   mark when the reply is text only (a call, a meeting, presenting, switched
 *   off).
 *
 * ⚠️ The level while he holds comes from Rust (Core Audio's meter) as well as
 * the recorder's analyser, and the louder of the two wins: an AudioContext the
 * page makes from a key pressed in another app is born suspended (no gesture),
 * so the analyser alone would leave the bars flat on exactly this path.
 *
 * ⚠️ One chat turn at a time (AGENTS 794): a barge-in during a reply still
 * streaming waits for it to finish before the new words go.
 */
import "./voice.css";
import { listen } from "@tauri-apps/api/event";
import { element } from "./dom";
import { paintIcon, type TaskIcon } from "./task-icons";
import { call, native, previewBus } from "./task-client";
import { iconButton } from "./kit/parts";
import { Recorder, base64Of, voiceProblem } from "./kit/voice";
import { clockOf } from "./kit/words";
import { HOLD_MS, idle, step, type Effect, type TurnEvent, type TurnState } from "./voice-turn";
import type { ChatEvent, GuardianChat } from "./screen-guardian";
import type { HelmSource } from "./screen-helm";
import type { IslandSurface } from "./island-surface";

export interface TalkHooks {
  /** Put the island on the Guardian's screen, open (the palette and capture out of the way). */
  open: () => void;
  /** The Guardian's foot, where the strip goes over the composer. */
  foot: () => HTMLElement | null;
  /** Settings → Spoken replies. */
  spoken: () => boolean;
}

/** Why a reply is text only, as a glyph and its tooltip. */
const QUIET: Record<string, { icon: TaskIcon; tip: string }> = {
  off: { icon: "volumeOff", tip: "Text only: spoken replies are off" },
  call: { icon: "join", tip: "Text only: you're in a call" },
  meeting: { icon: "calendar", tip: "Text only: a meeting is on" },
  presenting: { icon: "share", tip: "Text only: you're presenting" },
  unavailable: { icon: "volumeOff", tip: "Text only: Helm can't speak yet (OPENAI_API_KEY)" },
};
const PHASE_ICON: Partial<Record<TurnState["phase"], TaskIcon>> = { listening: "mic", transcribing: "mic", thinking: "guardian", speaking: "volume" };
/** How long the island stays up after a turn, to read it: longer when it was not heard. */
const READ_MS = 6000;
const READ_QUIET_MS = 14_000;
const BARS = 44;

const clean = (error: unknown) => String((error as Error)?.message ?? error).replace(/^(invoke error|error): /i, "").slice(0, 120);
const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));

interface SayAnswer { played?: boolean; hushed?: boolean; muted?: string; unavailable?: boolean }

export class VoiceTalk {
  readonly el: HTMLElement;
  private state: TurnState = idle();
  private recorder = new Recorder();
  private heldTimer = 0;
  private barTimer = 0;
  /** The chat turn in flight is this voice turn's: its events are read. */
  private ours = false;
  /** Pressed while it can't work (not signed in): said on the pill if held, and nothing else. */
  private refused: string | null = null;
  /** His level while he holds, the Guardian's while it speaks; both 0..1. */
  private mic = 0;
  private out = 0;
  private startedAt = 0;
  /** A failed sentence is said once per turn, not once per sentence. */
  private toldTurn = -1;
  private bars: HTMLElement[] = [];
  private disc: HTMLElement;
  private time: HTMLElement;
  private quiet: HTMLElement;

  constructor(private chat: GuardianChat, private helm: HelmSource, private surface: IslandSurface, private hooks: TalkHooks) {
    this.el = element("div", "v-strip");
    this.el.hidden = true;
    this.el.setAttribute("role", "status");
    this.el.setAttribute("aria-live", "polite");
    this.disc = element("span", "v-disc");
    const wave = element("span", "v-wave");
    for (let i = 0; i < BARS; i++) {
      const bar = element("i");
      bar.style.setProperty("--i", String(i));
      wave.append(bar);
      this.bars.push(bar);
    }
    this.time = element("span", "v-time");
    this.quiet = element("span", "v-quiet");
    const stop = iconButton("close", "Stop · Esc", "v-stop", () => this.feed({ t: "escape" }));
    this.el.append(this.disc, wave, this.time, this.quiet, stop);
  }

  async boot() {
    this.chat.watch = event => this.chatEvent(event);
    const on = <T>(name: string, run: (payload: T) => void) => native
      ? listen<T>(name, event => run(event.payload)).then(() => {})
      : Promise.resolve(previewBus.addEventListener(name, event => run((event as CustomEvent<T>).detail)));
    await on<null>("voice:down", () => this.down());
    await on<{ ms: number }>("voice:up", payload => this.up(Number(payload?.ms) || 0));
    await on<number>("voice:level", level => { this.mic = Math.max(this.mic, Math.min(1, Number(level) * 2.4)); });
    await on<number>("voice:out", level => { this.out = Math.min(1, Number(level) || 0); });
    await on<null>("voice:escape", () => this.feed({ t: "escape" }));
    await on<string>("voice:muted", why => this.feed({ t: "muted", why: String(why) }));
    /* Escape in the island itself, when it has the keyboard. ⚠️ Captured, so it
     * is the turn that stops rather than the island folding under it. */
    document.addEventListener("keydown", event => {
      if (event.key !== "Escape" || this.state.phase === "idle") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      this.feed({ t: "escape" });
    }, true);
  }

  /** Whether a turn is under way. */
  get live(): boolean { return this.state.phase !== "idle"; }

  /* ── The key ─────────────────────────────────────────────────────────── */

  down() {
    if (this.state.phase === "idle" && !this.helm.signedIn) {
      this.refused = "Sign in to Helm in Settings to talk to the Guardian";
      window.clearTimeout(this.heldTimer);
      this.heldTimer = window.setTimeout(() => { if (this.refused) this.helm.tell("Guardian", this.refused); }, HOLD_MS);
      return;
    }
    this.feed({ t: "down" });
    if (this.state.phase === "pressed") {
      window.clearTimeout(this.heldTimer);
      this.heldTimer = window.setTimeout(() => this.feed({ t: "held" }), HOLD_MS);
    }
  }

  up(ms: number) {
    window.clearTimeout(this.heldTimer);
    if (this.refused) { this.refused = null; return; }
    this.feed({ t: "up", ms });
  }

  /* ── The machine ─────────────────────────────────────────────────────── */

  private feed(event: TurnEvent) {
    const before = this.state;
    const [next, effects] = step(before, event);
    this.state = next;
    for (const effect of effects) this.run(effect, before);
    if (next.phase !== before.phase || next.muted !== before.muted) this.paint();
  }

  private run(effect: Effect, before: TurnState) {
    switch (effect.do) {
      case "record":
        this.mic = 0;
        this.recorder.onLevel = level => { this.mic = Math.max(this.mic, level); };
        this.recorder.onLimit = () => this.feed({ t: "up", ms: 5 * 60_000 });
        this.startedAt = performance.now();
        void this.recorder.start().catch(error => {
          this.helm.tell("Microphone", voiceProblem(error));
          this.feed({ t: "failed" });
        });
        return;
      case "cancel":
        this.recorder.cancel();
        return;
      case "finish":
        void this.transcribe();
        return;
      case "hush":
        /* ⚠️ The reply in flight is no longer this turn's: what is left of it
         * must not be read into the NEXT turn, whose words may be heard before
         * it has finished streaming. */
        this.ours = false;
        this.out = 0;
        void call("voice_hush").catch(() => {});
        return;
      case "open":
        this.hooks.open();
        this.surface.held = true;
        return;
      case "escape":
        void call("voice_escape", { on: effect.on }).catch(() => {});
        return;
      case "send":
        void this.send(effect.text);
        return;
      case "say":
        void this.say(effect.text, effect.turn, effect.seq);
        return;
      case "end":
        this.surface.held = false;
        // Up a moment longer to read, and longer still when it went unheard.
        if (this.surface.open) this.surface.pinFor(before.muted ? READ_QUIET_MS : READ_MS);
        return;
    }
  }

  private async transcribe() {
    const recording = await this.recorder.finish();
    if (!recording) { this.feed({ t: "heard", text: "" }); return; }
    try {
      this.feed({ t: "heard", text: await this.helm.voice.transcribe(await base64Of(recording.blob), recording.mime) });
    } catch (error) {
      this.helm.tell("Speech", clean(error));
      this.feed({ t: "failed" });
    }
  }

  private async send(text: string) {
    const turn = this.state.turn;
    // A reply from before a barge-in may still be streaming: the chat takes one turn at a time.
    for (let i = 0; this.chat.pending && i < 480; i++) await sleep(250);
    if (this.state.phase !== "thinking" || this.state.turn !== turn) return;
    // Text only, said before the reply comes: the switch here, presenting, a call, a meeting (voice.rs).
    if (!this.hooks.spoken()) this.feed({ t: "muted", why: "off" });
    else void call<string | null>("voice_quiet").then(why => { if (why && this.state.turn === turn) this.feed({ t: "muted", why }); }).catch(() => {});
    this.ours = true;
    const started = await this.chat.send(text, [], { focus: this.helm.focus, voice: true });
    if (!started) {
      this.ours = false;
      this.feed({ t: "failed" });
    }
  }

  private async say(text: string, turn: number, seq: number) {
    try {
      const answer = await call<SayAnswer | null>("voice_say", { text, turn, seq });
      if (answer?.muted) this.feed({ t: "muted", why: answer.muted });
      else if (answer?.unavailable) this.feed({ t: "muted", why: "unavailable" });
    } catch (error) {
      if (this.toldTurn !== turn) { this.toldTurn = turn; this.helm.tell("Voice", clean(error)); }
    } finally {
      this.feed({ t: "said", turn });
    }
  }

  private chatEvent(event: ChatEvent) {
    if (!this.ours) return;
    if (event.t === "text") this.feed({ t: "text", d: event.d });
    // An error is followed by `done` from Helm, but a dropped connection sends only the error.
    if (event.t === "done" || event.t === "error") {
      if (event.t === "done") this.ours = false;
      this.feed({ t: "done" });
    }
  }

  /* ── The strip ───────────────────────────────────────────────────────── */

  private paint() {
    const { phase, muted } = this.state;
    const shown = phase !== "idle" && phase !== "pressed";
    this.el.hidden = !shown;
    this.el.dataset.phase = phase;
    this.hooks.foot()?.classList.toggle("is-talking", shown);
    const icon = PHASE_ICON[phase];
    if (icon) paintIcon(this.disc, phase === "speaking" && muted ? "volumeOff" : icon);
    const why = muted ? QUIET[muted] : null;
    this.quiet.hidden = !why || phase === "listening";
    this.quiet.replaceChildren();
    if (why) {
      paintIcon(this.quiet, why.icon);
      this.quiet.dataset.tip = why.tip;
      this.quiet.setAttribute("aria-label", why.tip);
    }
    this.time.hidden = phase !== "listening";
    window.clearInterval(this.barTimer);
    if (shown) this.barTimer = window.setInterval(() => this.paintBars(), 50);
    else for (const bar of this.bars) bar.style.removeProperty("--h");
    this.paintBars();
    this.surface.measure();
  }

  /** The voice as a moving wave, the newest on the right: his while he holds, the Guardian's while it speaks. */
  private paintBars() {
    const phase = this.state.phase;
    if (phase === "listening") this.time.textContent = clockOf((performance.now() - this.startedAt) / 1000);
    const level = phase === "listening" ? this.mic : phase === "speaking" ? this.out : 0;
    // Gone in a few frames when the voice stops, rather than frozen at its last peak.
    this.mic *= 0.55;
    const bars = this.bars;
    for (let i = 0; i < bars.length - 1; i++) bars[i].style.setProperty("--h", bars[i + 1].style.getPropertyValue("--h") || "0.06");
    bars[bars.length - 1].style.setProperty("--h", String(Math.max(0.06, Math.min(1, level))));
  }
}
