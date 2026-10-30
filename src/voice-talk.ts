/* Talking with the Guardian from anywhere (29 Oct): hold the talk key (Alt+Q
 * by default) in any app and speak; let go and the Guardian acts and answers
 * out loud, in the same thread as its screen. The state machine is
 * `voice-turn.ts`; this carries out what it says. The look is the voice
 * glance (`voice-glance.ts`), which replaced the strip over the Guardian's
 * composer the same day (round 2): the island opens to its glance, not to
 * the Guardian's screen.
 *
 * - The key is native (`voice.rs`): `voice:down`, `voice:level` while held,
 *   `voice:up {ms}`. The microphone opens on the press (the kit's recorder, the
 *   composer's own); the glance comes up once it has been held half a second.
 * - A TAP when nothing is being said is hands-free: it keeps listening until
 *   Enter or another tap sends, or Escape drops it (round 2, his call). Enter
 *   and Escape are taken from every app only while that lasts (`voice_keys`).
 * - The words go through Helm's `/api/transcribe` (OpenAI), then to the
 *   Guardian's chat with `voice: true`, which makes the reply short and
 *   speakable. Its tools, receipts and cards are the chat's as ever.
 * - The reply is said sentence by sentence as it streams (`voice_say`, played
 *   natively from Helm's `/api/speak`) and written into the glance word by
 *   word at about the voice's pace.
 * - When it is over the glance stays a few seconds to read (longer when it
 *   was not heard), as long as the pointer is on it, and folds on its own. A
 *   click opens the Guardian; Escape folds it at once.
 *
 * ⚠️ The level while he holds comes from Rust (Core Audio's meter) as well as
 * the recorder's analyser, and the louder of the two wins: an AudioContext the
 * page makes from a key pressed in another app is born suspended (no gesture),
 * so the analyser alone would leave the bars flat on exactly this path.
 *
 * ⚠️ One chat turn at a time (AGENTS 794): a barge-in during a reply still
 * streaming waits for it to finish before the new words go.
 *
 * ⚠️⚠️ Nothing here may wait for ever (AGENTS 851): every phase has a limit
 * (`LIMITS`), after which the turn ends and says so. The first build had none,
 * and a microphone that stopped by itself left the turn in "transcribing"
 * with every later press ignored — "it recorded the first time and now it
 * doesn't". Each step is written to the app's log too (no words, only sizes).
 */
import "./voice.css";
import { listen } from "@tauri-apps/api/event";
import { call, native, previewBus } from "./task-client";
import { Recorder, base64Of, voiceProblem, MAX_SECONDS } from "./kit/voice";
import { HOLD_MS, idle, step, type Effect, type Phase, type TurnEvent, type TurnState } from "./voice-turn";
import { VoiceGlance, emptyReply, type GlanceReply } from "./voice-glance";
import type { ChatEvent, Extra, GuardianChat } from "./screen-guardian";
import type { HelmSource } from "./screen-helm";
import type { IslandSurface } from "./island-surface";

export interface TalkHooks {
  /** Clear the way for the glance: the palette and capture closed, an open panel folded. */
  prepare: () => void;
  /** Grow the island into the Guardian's screen, with the thread. */
  openGuardian: () => void;
  /** Settings → Spoken replies. */
  spoken: () => boolean;
}

/** How long the glance stays up after a turn, to read it: longer when it was not heard. */
const READ_MS = 6000;
const READ_QUIET_MS = 14_000;
/** After the pointer leaves a glance it was holding up. */
const READ_AFTER_HOVER_MS = 2500;
/** A turn that ended with nothing to read folds this soon. */
const NOTHING_MS = 350;
/** How often the keys are asked for again while held (voice.rs drops them 30 s after the last ask). */
const KEYS_EVERY = 10_000;
/** The longest each phase may last with nothing happening, in ms: past it the
 *  turn is over and says so. Listening is the recording's own five minutes
 *  (the recorder ends it first), Helm answers a transcription inside 90 s and
 *  a chat turn inside 120 s, and no sentence takes a minute and a half. */
const LIMITS: Partial<Record<Phase, number>> = {
  pressed: (MAX_SECONDS + 20) * 1000,
  listening: (MAX_SECONDS + 20) * 1000,
  transcribing: 100_000,
  thinking: 130_000,
  speaking: 90_000,
};

const clean = (error: unknown) => String((error as Error)?.message ?? error).replace(/^(invoke error|error): /i, "").slice(0, 120);
const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));

interface SayAnswer { played?: boolean; hushed?: boolean; muted?: string; unavailable?: boolean }

export class VoiceTalk {
  private state: TurnState = idle();
  private recorder = new Recorder();
  private glance: VoiceGlance;
  private heldTimer = 0;
  private tickTimer = 0;
  private watchTimer = 0;
  private keysTimer = 0;
  private foldTimer = 0;
  /** The chat turn in flight is this voice turn's: the machine reads its events. */
  private ours = false;
  /** The glance is following the chat turn in flight — still after a barge-in hushed it. */
  private reading = false;
  private reply: GlanceReply = emptyReply();
  /** Pressed while it can't work (not signed in): said on the pill if held, and nothing else. */
  private refused: string | null = null;
  /** His level while he holds, the Guardian's while it speaks; both 0..1. */
  private mic = 0;
  private out = 0;
  private startedAt = 0;
  /** A failed sentence is said once per turn, not once per sentence. */
  private toldTurn = -1;
  /** The keys the turn wants (the machine's), and what was last asked of Rust. */
  private turnKeys = { escape: false, enter: false };
  private askedKeys = "";
  /** The glance is up: during a turn, and for a moment after it to read. */
  private raised = false;
  /** The turn is over and the glance is up only to be read. */
  private lingering = false;
  /** Why this turn's reply was text only, kept for the glance after the turn is over. */
  private quiet: string | null = null;
  /** What the next send carries besides the words: a moment's wrap-up (`command`,
   *  `meeting`) or its chat line's command (batch 12). Cleared once sent or dropped. */
  private extra: Pick<Extra, "command" | "meeting"> | null = null;
  /** This turn was a line written for him (a moment's chat action), not said: shown, never spoken. */
  private typed = false;

  constructor(private chat: GuardianChat, private helm: HelmSource, private surface: IslandSurface, private hooks: TalkHooks) {
    const host = document.getElementById("island-voice")!;
    this.glance = new VoiceGlance(host, {
      open: () => this.openGuardian(),
      undo: (id, index) => this.undo(id, index),
      measured: depth => surface.setVoiceDepth(depth),
    });
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
    await on<null>("voice:escape", () => this.escape());
    await on<null>("voice:enter", () => this.feed({ t: "enter" }));
    await on<string>("voice:muted", why => this.feed({ t: "muted", why: String(why) }));
    /* Escape and Enter in the island itself, when it has the keyboard. ⚠️
     * Captured, so it is the turn that stops rather than the island folding
     * under it — and only while the glance is up, or a hands-free turn sends. */
    document.addEventListener("keydown", event => {
      if (event.key === "Escape" && (this.live || this.raised)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        this.escape();
      } else if (event.key === "Enter" && this.state.phase === "listening" && this.state.free) {
        event.preventDefault();
        event.stopImmediatePropagation();
        this.feed({ t: "enter" });
      }
    }, true);
    this.surface.onVoiceHover = on => this.hovered(on);
  }

  /** Whether a turn is under way. */
  get live(): boolean { return this.state.phase !== "idle"; }

  /** A hands-free turn started FOR him — a moment's Opowiedz (batch 12): just as
   *  a tap of Alt+Q, and what he says goes with `extra` (`command: "wrap"`,
   *  `meeting`). False when a turn is already live or Helm isn't signed in. */
  talk(extra: Pick<Extra, "command" | "meeting">): boolean {
    if (this.live || !this.helm.signedIn) return false;
    this.extra = extra;
    this.typed = false;
    this.down();
    this.up(60);
    return true;
  }

  /** A line to the Guardian from a moment's chat button: the turn runs on the
   *  glance like a spoken one, its answer read there, never said aloud. */
  ask(text: string, command?: string): boolean {
    if (this.live || this.chat.pending || !this.helm.signedIn || !text.trim()) return false;
    const known = ["request", "note", "log", "todo", "wrap"];
    this.extra = command && known.includes(command) ? { command: command as Extra["command"] } : null;
    this.typed = true;
    this.fresh();
    this.state = { ...idle(this.state.turn), phase: "transcribing" };
    this.raise();
    this.reply = emptyReply(text.trim());
    this.feed({ t: "heard", text });
    return true;
  }

  /** A click somewhere else: a glance up only to be read has been read. */
  dismiss(): boolean {
    if (!this.lingering) return false;
    this.fold();
    return true;
  }

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

  private escape() {
    if (this.live) this.feed({ t: "escape" });
    // Escape folds the glance at once: there is nothing to read in a turn he stopped.
    if (this.raised) this.fold();
  }

  /* ── The machine ─────────────────────────────────────────────────────── */

  private feed(event: TurnEvent) {
    const before = this.state;
    const [next, effects] = step(before, event);
    this.state = next;
    for (const effect of effects) this.run(effect, before);
    if (next.phase !== before.phase || next.muted !== before.muted || next.free !== before.free) {
      this.log(`${before.phase} → ${next.phase}${next.free ? " (hands-free)" : ""}${next.muted ? ` (text only: ${next.muted})` : ""}`);
      this.paint();
    }
    if (next.phase !== before.phase || event.t === "text" || event.t === "said") this.watch();
  }

  private run(effect: Effect, before: TurnState) {
    switch (effect.do) {
      case "record":
        this.mic = 0;
        this.recorder.onLevel = level => { this.mic = Math.max(this.mic, level); };
        this.recorder.onLimit = () => { this.log("five minutes: sent"); this.feed({ t: "stop" }); };
        this.recorder.onLost = () => {
          this.log("the microphone stopped by itself");
          this.helm.tell("Microphone", "The microphone stopped — what it caught is sent");
          this.feed({ t: "stop" });
        };
        this.startedAt = performance.now();
        // A new turn on a glance still up: what it showed goes, unless this is maybe only a tap to stop the voice.
        if (before.phase === "idle") this.fresh();
        void this.recorder.start().then(
          () => { if (this.recorder.state === "recording") this.log(`microphone open in ${this.recorder.openedIn} ms`); },
          error => {
            this.log(`microphone failed: ${(error as Error)?.name || "error"}`);
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
         * it has finished streaming. The glance goes on showing it, as text. */
        this.ours = false;
        this.out = 0;
        this.glance.speaking = false;
        void call("voice_hush").catch(() => {});
        return;
      case "open":
        // A barge-in that became a hold: the old answer gives way to his voice.
        if (before.barge) this.fresh();
        this.raise();
        return;
      case "keys":
        this.turnKeys = { escape: effect.escape, enter: effect.enter };
        this.keys();
        return;
      case "send":
        void this.send(effect.text);
        return;
      case "say":
        this.glance.speaking = true;
        void this.say(effect.text, effect.turn, effect.seq);
        return;
      case "end":
        // A turn dropped before it was sent takes its wrap-up with it.
        this.extra = null;
        this.typed = false;
        this.linger(before);
        return;
    }
  }

  private async transcribe() {
    const held = (performance.now() - this.startedAt) / 1000;
    const opening = this.recorder.state === "starting";
    const recording = await this.recorder.finish();
    if (!recording) {
      /* ⚠️ Said, not swallowed. A real hold that came back with nothing is the
       * failure this whole file is now written around, and the old answer to
       * it was an island that quietly folded. */
      this.log(`nothing recorded after ${held.toFixed(1)} s (${opening ? "the microphone was still opening" : "no audio"})`);
      if (held >= 1) this.helm.tell("Microphone", opening ? "The microphone took too long to start" : "Nothing was recorded");
      this.feed({ t: "heard", text: "" });
      return;
    }
    this.log(`recorded ${recording.seconds.toFixed(1)} s, ${Math.round(recording.blob.size / 1024)} kB${this.recorder.lost ? ", cut short" : ""}`);
    try {
      const text = await this.helm.voice.transcribe(await base64Of(recording.blob), recording.mime);
      this.log(text.trim() ? `heard ${text.trim().length} characters` : "heard nothing");
      if (!text.trim()) this.helm.tell("Speech", "Didn't catch that");
      // His words on the glance at once, before the Guardian has said anything.
      if (text.trim()) this.reply = emptyReply(text.trim());
      this.feed({ t: "heard", text });
    } catch (error) {
      this.log(`transcription failed: ${clean(error)}`);
      this.helm.tell("Speech", clean(error));
      this.feed({ t: "failed" });
    }
  }

  private async send(text: string) {
    const turn = this.state.turn;
    // A reply from before a barge-in may still be streaming: the chat takes one turn at a time.
    const waited = performance.now();
    for (let i = 0; this.chat.pending && i < 480; i++) await sleep(250);
    if (this.state.phase !== "thinking" || this.state.turn !== turn) return;
    if (this.chat.pending) {
      this.log("the chat stayed busy for two minutes");
      this.helm.tell("Guardian", "Still answering the last message");
      this.feed({ t: "failed" });
      return;
    }
    if (performance.now() - waited > 500) this.log(`waited ${Math.round(performance.now() - waited)} ms for the last reply`);
    // Text only, said before the reply comes: the switch here, presenting, a call, a meeting (voice.rs).
    // A written line (`ask`) is read, not heard: muted with no reason to show.
    if (this.typed) this.feed({ t: "muted", why: "typed" });
    else if (!this.hooks.spoken()) this.feed({ t: "muted", why: "off" });
    else void call<string | null>("voice_quiet").then(why => { if (why && this.state.turn === turn) this.feed({ t: "muted", why }); }).catch(() => {});
    this.ours = true;
    this.reading = true;
    this.reply = emptyReply(text);
    this.paint();
    const extra = this.extra ?? {};
    this.extra = null;
    this.typed = false;
    const started = await this.chat.send(text, [], { focus: this.helm.focus, voice: true, ...extra });
    if (!started) {
      this.ours = false;
      this.reading = false;
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
    if (this.reading) this.follow(event);
    if (!this.ours) return;
    if (event.t === "text") this.feed({ t: "text", d: event.d });
    // An error is followed by `done` from Helm, but a dropped connection sends only the error.
    if (event.t === "done" || event.t === "error") {
      if (event.t === "done") this.ours = false;
      this.feed({ t: "done" });
    }
  }

  /** The reply on the glance, event by event. */
  private follow(event: ChatEvent) {
    const reply = this.reply;
    switch (event.t) {
      case "status": reply.status = event.text; break;
      case "text": reply.status = null; reply.text += event.d; break;
      case "receipt": reply.receipts.push(event.receipt); break;
      case "card": reply.cards++; break;
      case "error": reply.status = null; reply.error = event.message; reply.done = true; break;
      case "done":
        reply.done = true;
        reply.id = event.id;
        this.reading = false;
        this.log(`reply done: ${reply.text.length} characters, ${reply.receipts.length} receipts, ${reply.cards} cards`);
        // A turn already over (stopped by a tap) was waiting for this to start its reading time.
        if (this.lingering) this.linger(this.state);
        break;
      default: return;
    }
    this.glance.paintReply(reply);
  }

  private async undo(id: number, index: number): Promise<boolean> {
    await this.chat.undo(id, index);
    const message = this.chat.thread?.messages.find(m => m.id === id);
    return !!message?.receipts[index]?.undoneAt;
  }

  /* ── The glance ──────────────────────────────────────────────────────── */

  /** Up, for this turn. */
  private raise() {
    window.clearTimeout(this.foldTimer);
    this.lingering = false;
    if (!this.raised) this.hooks.prepare();
    this.raised = true;
    this.surface.setVoice(true);
    this.keys();
    this.paint();
  }

  /** A new turn: the last one's words off the glance. */
  private fresh() {
    this.reading = false;
    this.quiet = null;
    this.reply = emptyReply();
    this.glance.reset();
  }

  /** The turn is over: up a moment to read it, longer when it went unheard, then folded. */
  private linger(before: TurnState) {
    window.clearTimeout(this.foldTimer);
    if (!this.raised) return;
    const something = !!(this.reply.heard && (this.reply.text || this.reply.receipts.length || this.reply.error));
    if (!something && !this.reading) {
      // A tap that stopped nothing, a turn nothing was heard in, a failure: nothing to read.
      this.foldTimer = window.setTimeout(() => this.fold(), NOTHING_MS);
      this.lingering = true;
      return;
    }
    this.lingering = true;
    this.paint();
    // ⚠️ Counted from when the reply has FINISHED: a tap stops the voice, not the words still coming.
    if (this.reading || this.surface.pointed) return;
    this.foldTimer = window.setTimeout(() => this.fold(), this.quiet || before.muted ? READ_QUIET_MS : READ_MS);
  }

  private hovered(on: boolean) {
    if (!this.lingering) return;
    window.clearTimeout(this.foldTimer);
    if (!on && !this.reading) this.foldTimer = window.setTimeout(() => this.fold(), READ_AFTER_HOVER_MS);
  }

  /** Down to the pill. */
  private fold() {
    window.clearTimeout(this.foldTimer);
    if (!this.raised) return;
    this.raised = false;
    this.lingering = false;
    this.glance.flush();
    this.surface.setVoice(false);
    this.keys();
    this.paint();
  }

  /** The glance's open key, a click on it: the Guardian, with the thread. */
  private openGuardian() {
    this.glance.flush();
    this.hooks.openGuardian();
    // Read there from now on; a turn still live comes back to the glance when the panel folds.
    if (!this.live) {
      this.raised = false;
      this.lingering = false;
      window.clearTimeout(this.foldTimer);
      this.surface.setVoice(false);
      this.keys();
    }
  }

  private paint() {
    const { phase, free, barge, muted } = this.state;
    // ⚠️ The machine forgets why at the end of the turn; the glance still says it while he reads.
    if (muted) this.quiet = muted;
    this.glance.speaking = this.ours && !muted && (phase === "speaking" || phase === "thinking");
    this.glance.turn({ phase: phase === "idle" ? "done" : phase, free, barge, muted: muted ?? this.quiet }, this.reply.heard ? this.reply : null);
    window.clearInterval(this.tickTimer);
    this.tickTimer = 0;
    if (this.raised) this.tickTimer = window.setInterval(() => this.tick(), 50);
  }

  /** The bars, the time and the voice's level, twenty times a second. */
  private tick() {
    const phase = this.state.phase;
    const level = phase === "listening" || phase === "pressed" ? this.mic : 0;
    // Gone in a few frames when the voice stops, rather than frozen at its last peak.
    this.mic *= 0.55;
    const seconds = phase === "listening" || phase === "pressed" ? (performance.now() - this.startedAt) / 1000 : 0;
    this.glance.tick(level, seconds, phase === "speaking" ? this.out : 0);
  }

  /* ── Keeping it honest ───────────────────────────────────────────────── */

  /** Escape while the glance is up, Enter while hands-free listens — asked
   *  again every ten seconds, because voice.rs lets go of both half a minute
   *  after the last ask (a page that died must not keep Enter). */
  private keys() {
    const want = { escape: this.turnKeys.escape || this.raised, enter: this.turnKeys.enter };
    const key = JSON.stringify(want);
    if (key !== this.askedKeys) {
      this.askedKeys = key;
      void call("voice_keys", want).catch(() => {});
    }
    window.clearInterval(this.keysTimer);
    this.keysTimer = 0;
    if (want.escape || want.enter) this.keysTimer = window.setInterval(() => { void call("voice_keys", want).catch(() => {}); }, KEYS_EVERY);
  }

  /** The phase's limit, re-armed whenever something happens in it. */
  private watch() {
    window.clearTimeout(this.watchTimer);
    const phase = this.state.phase;
    const limit = LIMITS[phase];
    if (!limit) return;
    this.watchTimer = window.setTimeout(() => {
      if (this.state.phase !== phase) return;
      this.log(`${phase} for ${Math.round(limit / 1000)} s with nothing happening: ending the turn`);
      if (phase === "listening" || phase === "pressed") { this.feed({ t: "stop" }); return; }
      this.helm.tell(phase === "transcribing" ? "Speech" : "Guardian", phase === "transcribing" ? "Helm didn't answer" : "The answer stopped coming");
      this.ours = false;
      this.feed({ t: "failed" });
    }, limit);
  }

  /** One line in the app's log. ⚠️ Never his words or the Guardian's: sizes and states. */
  private log(line: string) {
    if (native) void call("log_line", { line: `voice: ${line}` }).catch(() => {});
  }
}
