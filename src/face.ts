/* The Guardian's face in the notch (2 Nov): one character, one mood, drawn
 * into a few VIEWS — the pill (at rest, and in his own peeks), the pill's edge
 * (vibing to music, or peeking out), the voice glance, a moment's tile, a
 * cameo. Each view has its own canvas and springs; they share the mood, and a
 * view may ask for its own (the edge vibes, a warning moment is worried).
 *
 * ⚠️ His rule (his words: "make sure it isn't just clutter, that we don't just
 * force our way into components that already have enough elements"): a view
 * only ever takes a slot that's already there — the date's, the second-place
 * mark's, a glyph's — never a new one.
 *
 * What he's told — a voice turn's phase, a flash of news, a warning up, a
 * session running — becomes the mood (face-mood.ts); a REACTION plays over it
 * for a moment (a poke, the earbuds going on, the volume maxed); he LOOKS at
 * the cursor when it comes near; the character draws it all (face-eyes.ts).
 * His face in the pill is his own spot: a click pokes him, a double click
 * opens the Guardian (his OK, 2 Nov).
 *
 * ⚠️ It must cost nothing while nothing moves: this is on screen all day. A
 * frame is drawn every display frame only while something moves (a spring
 * settling, a blink, a reaction, a mood that moves by nature); the long moods
 * (a session, the night) get a few frames a second; a still face sleeps until
 * its next blink, habit or flash ends. Hidden, nothing is drawn. Reduced
 * motion keeps the moods and drops the springs, hops, habits and cameos.
 *
 * Who he is (Settings → Character, 2 Nov): the Eyes, Hoot or Sir — each view
 * draws with whichever painter that is (face-eyes.ts, face-friends.ts), same
 * moods, same reactions. Cameos and the PC reactions each have a switch.
 *
 * Staged in the preview: `?mood=<mood>` holds one mood, `?face=off|hoot|sir`
 * takes the face away (the date comes back) or picks a friend, `?night=0|1` says whether it's night
 * whatever the clock says; `window.__face` is this, for the tests.
 */
import { Eyes, REACTION_S, type Habits, type Reaction } from "./face-eyes";
import { Sprite } from "./face-friends";
import { isNight, LIVELY, moodOf, nextHabit, pokeReaction, POKE_WINDOW_MS, STEADY, withFlash, type Mood, type MoodInputs, type VoicePhase } from "./face-mood";
import { still } from "./motion-pref";
import { native } from "./task-client";

/** The pill's face, in CSS pixels (each canvas is drawn at the display's density). */
export const FACE_PX = 26;
/** In the pill the eyes fill their square, as tall as the clock beside them. */
export const PILL_ZOOM = 1.55;
/** How long he looks at new text beside him, and how long a wink and a tilt last (s). */
const GLANCE_S = 1.2, WINK_S = 0.35, TILT_S = 2.5;
/** The cursor counts as near for this long after it last moved near him (s). */
const LOOK_S = 1.4;
/** The blink's rhythm, as face-eyes.ts draws it. */
const BLINK_EVERY = 3.7, BLINK_AT = 3.55;
/** Frames a second for the long moods. */
const STEADY_FPS = 15;
/** A cameo at most this often, and how often it's considered (ms). */
const CAMEO_EVERY_MS = 60 * 60_000, CAMEO_CHECK_MS = 5 * 60_000;

export type ViewName = "pill" | "edge" | "glance" | "moment" | "cameo";
export interface ViewOpts {
  /** Its size on screen, CSS pixels. */
  px?: number;
  zoom?: number;
  /** A mood of its own (the edge vibing, a warning moment worried); null follows the face. */
  mood?: () => Mood | null;
}
/** Who draws him. */
export type Character = "eyes" | "hoot" | "sir";
interface Painter { draw(ctx: CanvasRenderingContext2D, S: number, t: number, m: Mood, dt: number, life: Habits, still: boolean, zoom: number): boolean }
const painter = (who: Character): Painter => who === "eyes" ? new Eyes() : new Sprite(who);
/** The reactions that come from the PC (the earbuds, the volume, the battery, a screenshot): Settings switches these off. */
const PC_REACTIONS: ReadonlySet<Reaction> = new Set<Reaction>(["phones", "wide", "tired", "flash"]);
interface View { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; eyes: Painter; px: number; zoom: number; mood?: () => Mood | null }

const preview = !native ? new URLSearchParams(location.search) : null;
const MOODS_OK = new Set(["idle", "listen", "think", "speak", "happy", "love", "focus", "alert", "oops", "sleep", "vibe"]);
const staged = preview?.get("face");

class GuardianFace {
  private views = new Map<ViewName, View>();
  private inputs: Omit<MoodInputs, "night" | "now"> = { voice: null, flashes: [], worried: false, focused: false };
  private close: number | null = null;
  private habits: Habits = { glance: 0, wink: 0, tilt: 0, level: null, look: null, react: null };
  private lookAt: { x: number; y: number; t: number } | null = null;
  private pokes: number[] = [];
  private nextHabitAt = 0;
  private nextHabitKind: "wink" | "tilt" = "wink";
  private timer = 0;
  private raf = 0;
  private last = 0;
  private cameoAt = 0;
  private cameoHook: ((kind: "hello" | "welcome") => boolean) | null = null;
  /** Off: no face anywhere, the date is back in the pill. */
  enabled = staged !== "off";
  /** Who he is. */
  character: Character = staged === "hoot" || staged === "sir" ? staged : "eyes";
  /** Lively (the default): glances, a rare wink or tilt, cameos. Calm: blinks and moods only. */
  lively = true;
  /** Now and then he takes the resting pill for a moment. */
  cameos = true;
  /** He reacts to the PC: the earbuds, the volume, the battery. */
  reactions = true;
  private listeners = new Set<() => void>();
  private night: boolean | null = preview?.has("night") ? preview.get("night") === "1" : null;
  private forced: Mood | null = preview && MOODS_OK.has(preview.get("mood") ?? "") ? (preview.get("mood") as Mood) : null;

  constructor() {
    this.planHabit(performance.now() / 1000);
    this.cameoAt = Date.now();
    document.addEventListener("visibilitychange", () => this.wake());
    window.setInterval(() => this.considerCameo(), CAMEO_CHECK_MS);
    if (preview) (window as unknown as { __face: GuardianFace }).__face = this;
  }

  /** The mood now, shown or not (for the tests, and anything that wants to match it). */
  get mood(): Mood { return this.moodNow(); }
  /** The reaction playing now, if any (for the tests). */
  get reaction(): Reaction | null {
    const r = this.habits.react;
    return r && performance.now() / 1000 - r.at < REACTION_S[r.kind] ? r.kind : null;
  }

  private view(name: ViewName): View {
    let v = this.views.get(name);
    if (!v) {
      const canvas = document.createElement("canvas");
      canvas.className = `face-canvas face-${name}`;
      canvas.setAttribute("aria-hidden", "true");
      v = { canvas, ctx: canvas.getContext("2d")!, eyes: painter(this.character), px: FACE_PX, zoom: PILL_ZOOM };
      /* His spot in the pill and at its edge: a click pokes him, a double
       * click opens the Guardian. ⚠️ Not while he's telling a peek: there the
       * click is the peek's (open the mail, open Helm). */
      if (name === "pill" || name === "edge") {
        const his = () => !canvas.closest(".pill-lead");
        canvas.addEventListener("click", e => { if (!his()) return; e.stopPropagation(); this.poke(); });
        canvas.addEventListener("dblclick", e => { if (!his()) return; e.stopPropagation(); window.dispatchEvent(new CustomEvent("face:guardian")); });
      }
      this.views.set(name, v);
    }
    return v;
  }

  /** Into a slot: the same view's canvas moves, so its springs carry on. */
  mount(slot: HTMLElement, name: ViewName = "pill", opts: ViewOpts = {}) {
    const v = this.view(name);
    v.px = opts.px ?? (name === "pill" ? FACE_PX : v.px);
    v.zoom = opts.zoom ?? PILL_ZOOM;
    v.mood = opts.mood;
    if (v.canvas.parentElement !== slot) slot.append(v.canvas);
    this.wake();
  }
  /** Out of wherever it is. */
  unmount(name: ViewName) { this.views.get(name)?.canvas.remove(); }

  /** Settings → Character, from the prefs. Says so to whoever draws a slot for him (the pill brings the date back when he's off). */
  configure(next: { character: Character | "off"; lively: boolean; cameos: boolean; reactions: boolean }) {
    const enabled = next.character !== "off";
    const who: Character = next.character === "off" ? this.character : next.character;
    const changed = enabled !== this.enabled || who !== this.character;
    this.lively = next.lively;
    this.cameos = next.cameos;
    this.reactions = next.reactions;
    if (who !== this.character) {
      this.character = who;
      for (const v of this.views.values()) v.eyes = painter(who);
    }
    this.enabled = enabled;
    if (!enabled) for (const v of this.views.values()) v.canvas.remove();
    if (changed) for (const fn of this.listeners) fn();
    this.wake();
  }
  /** Told when he's switched on or off, or becomes someone else. */
  onChange(fn: () => void) { this.listeners.add(fn); }

  /** A voice turn's phase (voice-talk.ts). */
  voice(phase: VoicePhase) { this.set({ voice: phase === "idle" ? null : phase }); }
  /** The voice's level while he listens, 0..1, or null for none. */
  level(value: number | null) { this.habits.level = value; }
  /** Good or bad news, for a few seconds. */
  flash(mood: "happy" | "love" | "oops") { this.set({ flashes: withFlash(this.inputs.flashes, mood, Date.now()) }); }
  set(patch: Partial<Omit<MoodInputs, "night" | "now">>) {
    const next = { ...this.inputs, ...patch };
    if (JSON.stringify(next) === JSON.stringify(this.inputs)) return;
    this.inputs = next;
    this.wake();
  }
  /** His close time, minutes since midnight: the night starts there. */
  setClose(minutes: number | null) { this.close = minutes; this.wake(); }
  /** Something happens to him for a moment. */
  react(kind: Reaction) {
    if (still() || (!this.reactions && PC_REACTIONS.has(kind))) return;
    this.habits.react = { kind, at: performance.now() / 1000 };
    this.wake();
  }
  /** New text beside him: he looks at it. */
  glance() {
    if (!this.lively || still()) return;
    this.habits.glance = performance.now() / 1000 + GLANCE_S;
    this.wake();
  }
  /** Poked: a start, then a giggle, then grumpy. */
  poke() {
    const now = Date.now();
    this.pokes = [...this.pokes.filter(at => now - at < POKE_WINDOW_MS), now];
    this.react(pokeReaction(this.pokes.length));
  }
  /** The cursor, in the window's CSS pixels, near him: he looks at it. */
  look(x: number, y: number) {
    if (!this.lively || still()) return;
    this.lookAt = { x, y, t: performance.now() / 1000 };
    this.wake();
  }
  /** Back at the PC after a while away: a welcome cameo, if he may. */
  back() {
    if (!this.mayCameo()) return;
    if (this.cameoHook?.("welcome")) this.cameoAt = Date.now();
  }
  /** The island's cameo: plays one and says whether it could. */
  setCameo(hook: (kind: "hello" | "welcome") => boolean) { this.cameoHook = hook; }

  private mayCameo(): boolean {
    return this.enabled && this.lively && this.cameos && !still() && !document.hidden && !this.forced && this.moodNow() === "idle";
  }
  private considerCameo() {
    if (!this.mayCameo() || Date.now() - this.cameoAt < CAMEO_EVERY_MS) return;
    if (this.cameoHook?.("hello")) this.cameoAt = Date.now();
  }

  /** Something changed: draw now, and let the frame decide when to draw next. */
  wake() {
    window.clearTimeout(this.timer);
    if (this.raf) return;
    this.raf = requestAnimationFrame(now => this.frame(now));
  }

  private moodNow(): Mood {
    if (this.forced) return this.forced;
    const at = new Date();
    return moodOf({ ...this.inputs, night: this.night ?? isNight(at.getHours() * 60 + at.getMinutes(), this.close), now: Date.now() });
  }

  private planHabit(t: number) {
    const next = nextHabit(Math.random());
    this.nextHabitAt = t + next.inMs / 1000;
    this.nextHabitKind = next.kind;
  }

  private frame(now: number) {
    this.raf = 0;
    if (!this.enabled || document.hidden) return;
    const live = [...this.views.values()].filter(v => v.canvas.isConnected && v.canvas.offsetParent !== null);
    if (!live.length) return;
    const t = now / 1000;
    const dt = Math.min(0.05, this.last ? t - this.last : 0.016);
    this.last = t;
    const calm = still();
    const mood = this.moodNow();
    if (this.lively && !calm && t >= this.nextHabitAt) {
      if (mood === "idle") {
        if (this.nextHabitKind === "wink") this.habits.wink = t + WINK_S;
        else this.habits.tilt = t + TILT_S;
      }
      this.planHabit(t);
    }
    const looking = this.lookAt && t - this.lookAt.t < LOOK_S ? this.lookAt : null;
    let moving = false, lively = LIVELY.has(mood), steady = STEADY.has(mood);
    for (const v of live) {
      const size = Math.max(v.px * 2, Math.round(v.px * (window.devicePixelRatio || 1)));
      if (v.canvas.width !== size) { v.canvas.width = size; v.canvas.height = size; }
      const own = v.mood?.() ?? null;
      const m = own ?? mood;
      if (own) { lively ||= LIVELY.has(own); steady ||= STEADY.has(own); }
      // Where the cursor is, from this view's own middle.
      let look: Habits["look"] = null;
      if (looking && !v.canvas.closest(".v-disc, .v-shield, .m-tile")) {
        const box = v.canvas.getBoundingClientRect();
        look = { x: (looking.x - (box.left + box.width / 2)) / 140, y: (looking.y - (box.top + box.height / 2)) / 60 };
      }
      // A reaction only while it plays (the friends have no clock of their own for it).
      if (v.eyes.draw(v.ctx, size, t, m, dt, { ...this.habits, look, react: this.reaction ? this.habits.react : null }, calm, v.zoom)) moving = true;
    }

    // When to draw next.
    const habitOn = t < this.habits.glance || t < this.habits.wink || t < this.habits.tilt || !!looking || !!this.reaction;
    const blinking = !calm && t % BLINK_EVERY > BLINK_AT;
    if ((moving || habitOn || blinking || lively) && !calm) {
      this.raf = requestAnimationFrame(n => this.frame(n));
      return;
    }
    if (steady && !calm) {
      this.timer = window.setTimeout(() => this.wake(), 1000 / STEADY_FPS);
      return;
    }
    // Asleep until the next blink, a habit, a flash ending, or a minute (the night comes by the clock).
    const flashEnd = this.inputs.flashes.reduce((soon, f) => Math.min(soon, f.until - Date.now()), Infinity);
    const untilBlink = calm ? Infinity : (BLINK_AT - (t % BLINK_EVERY)) * 1000;
    const untilHabit = this.lively && !calm ? (this.nextHabitAt - t) * 1000 : Infinity;
    const wait = Math.max(16, Math.min(untilBlink, untilHabit, flashEnd > 0 ? flashEnd + 20 : Infinity, 60_000));
    this.timer = window.setTimeout(() => this.wake(), wait);
  }
}

/** The one face. */
export const face = new GuardianFace();
