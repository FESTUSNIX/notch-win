/* The Eyes (2 Nov, his pick for the Guardian's face): two glowing rounded
 * shapes that do all of it — taller when listening, flat under a lid when
 * focused, drooping when worried, happy curves when pleased, hearts when a
 * client pays, X when something failed, thin lines when sleepy, bobbing with
 * closed happy eyes when music plays beside him.
 *
 * On top of the mood, a REACTION for a moment (a poke, a screenshot's flash,
 * the earbuds going on) and where he LOOKS (the cursor near him, new text).
 * Every size eases on a spring with a little overshoot, so a change POPS;
 * each new mood starts with a quick squash, like a blink as it turns. `draw`
 * reports whether anything is still moving, so the face stops redrawing a
 * still face (face.ts).
 */
import type { Mood } from "./face-mood";

/** Something that happens TO him for a moment, over whatever mood he's in. */
export type Reaction = "startle" | "giggle" | "grumpy" | "flash" | "nod" | "wide" | "phones" | "tired";

/** How long each reaction plays (s). */
export const REACTION_S: Record<Reaction, number> = { startle: 0.6, giggle: 1.1, grumpy: 3, flash: 0.5, nod: 0.9, wide: 1.3, phones: 4, tired: 4 };

/** His habits and reactions as the face hands them over: when each is on until (seconds, the clock `draw` gets). */
export interface Habits {
  glance: number;
  wink: number;
  tilt: number;
  /** The voice's level while he listens, 0..1 (a wobble of its own when unknown). */
  level: number | null;
  /** Where he looks, -1..1 each way (the cursor near him), or null. */
  look: { x: number; y: number } | null;
  /** A reaction playing: which, and since when. */
  react: { kind: Reaction; at: number } | null;
}

const TINT: Record<Mood, string> = {
  idle: "#ffffff", listen: "#a6ecff", think: "#e2dcff", speak: "#ffffff", happy: "#a8ffcf",
  love: "#ff8db4", focus: "#ffcfa3", alert: "#ffd877", oops: "#ffa3a3", sleep: "#8c92d8", vibe: "#d9ccff",
};
const hex = (c: string) => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16));

/** What a mood asks of the eyes, in fractions of the canvas. */
type Shape = { w: number; h: number; r: number; dx: number; y: number; lx: number; ly: number; top: number; tilt: number; bottom: number; sR: number; rot: number };

const blinkAt = (t: number) => t % 3.7 > 3.55;
const wobble = (t: number) => Math.abs(Math.sin(t * 9.3) * Math.sin(t * 3.1 + 1)) * 0.8 + 0.2;
const talk = (t: number) => { const s = Math.sin(t * 13) * Math.sin(t * 5.3 + 0.7); return s > 0.12 ? (s > 0.5 ? 2 : 1) : 0; };
const hop = (t: number) => Math.max(0, Math.sin(((t * 1.6) % 1) * Math.PI));
/** About 120 beats a minute: a song's bob without hearing the song. */
const beat = (t: number) => Math.sin(t * Math.PI * 4);
const NO_BLINK: ReadonlySet<Mood> = new Set<Mood>(["sleep", "happy", "love", "oops", "vibe"]);
const clamp = (v: number) => Math.max(-1, Math.min(1, v));

function shapeOf(m: Mood, t: number, life: Habits, still: boolean): Shape {
  const s: Shape = { w: 0.23, h: 0.33, r: 0.085, dx: 0.19, y: 0, lx: 0, ly: 0, top: 0, tilt: 0, bottom: 0, sR: 1, rot: 0 };
  if (m === "idle") {
    if (t < life.glance) { s.lx = 0.07; s.ly = 0.02; }
    if (t < life.tilt) s.rot = 0.12;
  }
  if (m === "listen") { s.h = 0.4 + (still ? 0.5 : life.level ?? wobble(t)) * 0.05; s.w = 0.25; s.lx = 0.02; }
  if (m === "think") { s.lx = 0.06; s.ly = -0.06; s.sR = 0.78; s.top = 0.12; s.rot = 0.08; }
  if (m === "speak") { const o = still ? 0 : talk(t); s.h = 0.31 + o * 0.03; s.y = -o * 0.012; }
  if (m === "happy") { s.bottom = 0.55; s.y = -0.03 - (still ? 0 : hop(t)) * 0.04; }
  if (m === "love") s.y = -(still ? 0 : hop(t)) * 0.03;
  if (m === "focus") { s.h = 0.2; s.top = 0.38; s.tilt = -1; s.w = 0.25; }
  if (m === "alert") { s.h = 0.37; s.top = 0.3; s.tilt = 1; }
  if (m === "oops") s.rot = -0.06;
  if (m === "sleep") { s.h = 0.05; s.r = 0.025; s.y = 0.06; }
  if (m === "vibe") { s.bottom = 0.5; s.y = still ? 0 : Math.abs(beat(t)) * -0.045; s.rot = still ? 0 : beat(t / 2) * 0.09; }
  // He looks where the cursor is, a little (not when asleep, talking or in a state of his own).
  if (life.look && !["sleep", "speak", "love", "oops"].includes(m)) {
    s.lx += clamp(life.look.x) * 0.075;
    s.ly += clamp(life.look.y) * 0.05;
  }
  // A reaction over the mood.
  const r = life.react;
  if (r && t - r.at < REACTION_S[r.kind]) {
    const k = t - r.at;
    if (r.kind === "startle") { s.h *= 1.35; s.w *= 1.08; s.y -= Math.sin(Math.min(1, k / REACTION_S.startle) * Math.PI) * 0.09; s.bottom = 0; s.top = 0; }
    if (r.kind === "giggle") { s.bottom = 0.55; s.top = 0; s.rot = Math.sin(k * 30) * 0.07; s.y -= 0.02; }
    if (r.kind === "grumpy") { s.top = 0.4; s.tilt = -1; s.h = Math.min(s.h, 0.3); s.bottom = 0; }
    if (r.kind === "nod") s.y += Math.max(0, Math.sin(k * 14)) * 0.05;
    if (r.kind === "wide") { s.h *= 1.32; s.w *= 1.1; s.top = 0; }
    if (r.kind === "tired") { s.top = 0.48; s.tilt = 0; s.y += 0.02; s.bottom = 0; }
  }
  return s;
}

function heart(ctx: CanvasRenderingContext2D, x: number, y: number, s: number) {
  ctx.beginPath();
  ctx.moveTo(x, y + s * 0.38);
  ctx.bezierCurveTo(x - s * 0.55, y + s * 0.02, x - s * 0.5, y - s * 0.48, x, y - s * 0.2);
  ctx.bezierCurveTo(x + s * 0.5, y - s * 0.48, x + s * 0.55, y + s * 0.02, x, y + s * 0.38);
  ctx.fill();
}

function rrect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, Math.max(0, Math.min(r, w / 2, h / 2)));
}

export class Eyes {
  private x: Partial<Record<keyof Shape, number>> = {};
  private v: Partial<Record<keyof Shape, number>> = {};
  private col: number[] | null = null;
  private mood: Mood | null = null;
  private turned = -9;

  /**
   * One frame. `still`: reduced motion (moods, no springs, no hops). `zoom`: how much of the
   * canvas the eyes fill (1 leaves room around them, as on a big stage; the pill wants them as
   * tall as its clock). Returns whether it's still moving.
   */
  draw(ctx: CanvasRenderingContext2D, S: number, t: number, m: Mood, dt: number, life: Habits, still: boolean, zoom = 1): boolean {
    if (m !== this.mood) { this.mood = m; this.turned = t; }
    const target = shapeOf(m, t, life, still);
    let moving = false;
    const p = {} as Shape;
    for (const k of Object.keys(target) as (keyof Shape)[]) {
      const goal = target[k];
      if (still || this.x[k] === undefined) { this.x[k] = goal; this.v[k] = 0; }
      else {
        // A spring with a little overshoot.
        const a = (goal - this.x[k]!) * 260 - this.v[k]! * 20;
        this.v[k] = this.v[k]! + a * dt;
        this.x[k] = this.x[k]! + this.v[k]! * dt;
        if (Math.abs(goal - this.x[k]!) > 0.0015 || Math.abs(this.v[k]!) > 0.01) moving = true;
      }
      p[k] = this.x[k]!;
    }
    const react = life.react && t - life.react.at < REACTION_S[life.react.kind] ? life.react : null;
    if (react) moving = true;
    const tint = react?.kind === "grumpy" ? "#ff9c9c" : react?.kind === "flash" ? "#ffffff" : TINT[m];
    const goalCol = hex(tint);
    this.col = !this.col || still ? goalCol : this.col.map((c, i) => c + (goalCol[i] - c) * (1 - Math.exp(-dt * 10)));
    if (this.col.some((c, i) => Math.abs(c - goalCol[i]) > 1)) moving = true;
    const col = `rgb(${this.col.map(Math.round).join(",")})`;

    const since = t - this.turned;
    const squash = !still && since < 0.14 ? 0.12 : 1;
    if (since < 0.14) moving = true;
    const blink = !still && blinkAt(t) && !NO_BLINK.has(m);
    const wink = !still && t < life.wink && (m === "idle" || m === "happy");
    // A screenshot: two quick shut-eyed flinches.
    const flinch = react?.kind === "flash" && (t - react.at < 0.12 || (t - react.at > 0.24 && t - react.at < 0.36));
    const shake = (m === "alert" || m === "oops") && !still ? Math.sin(t * 24) * S * 0.006 : 0;

    ctx.clearRect(0, 0, S, S);
    ctx.save();
    ctx.translate(S / 2 + shake, S / 2);
    ctx.scale(zoom, zoom);
    ctx.rotate(p.rot);
    for (const side of [-1, 1]) {
      const k = side === 1 ? p.sR : 1;
      const w = p.w * S * k;
      const shut = blink || flinch || (wink && side === 1);
      const h = (shut ? 0.04 : p.h * squash) * S * k;
      const ex = side * p.dx * S + p.lx * S, ey = (p.y + p.ly) * S;
      const x = ex - w / 2, y = ey - h / 2;
      ctx.save();
      ctx.shadowColor = col;
      ctx.shadowBlur = S * (react?.kind === "flash" ? 0.12 : 0.05);
      ctx.fillStyle = col;
      ctx.strokeStyle = col;
      if (m === "love" && !shut) heart(ctx, ex, ey + S * 0.01, S * 0.27 * (still ? 1 : 1 + 0.08 * Math.max(0, Math.sin(t * 7))));
      else if (m === "oops" && !shut) {
        ctx.lineCap = "round";
        ctx.lineWidth = S * 0.06;
        const a = S * 0.075;
        ctx.beginPath(); ctx.moveTo(ex - a, ey - a); ctx.lineTo(ex + a, ey + a); ctx.moveTo(ex + a, ey - a); ctx.lineTo(ex - a, ey + a); ctx.stroke();
      } else { rrect(ctx, x, y, w, h, p.r * S * k); ctx.fill(); }
      ctx.restore();
      // Lids and the happy curve are cut out of the eye.
      if (!shut && m !== "love" && m !== "oops") {
        ctx.save();
        ctx.globalCompositeOperation = "destination-out";
        if (p.top > 0.01) {
          const inner = side === -1 ? x + w : x, outer = side === -1 ? x : x + w;
          const yIn = y + h * p.top * (1 - p.tilt * 0.9), yOut = y + h * p.top * (1 + p.tilt * 0.9);
          ctx.beginPath(); ctx.moveTo(outer, y - 2); ctx.lineTo(inner, y - 2); ctx.lineTo(inner, yIn); ctx.lineTo(outer, yOut); ctx.closePath(); ctx.fill();
        }
        if (p.bottom > 0.01) { ctx.beginPath(); ctx.ellipse(ex, y + h + h * 0.18, w * 0.78, h * p.bottom, 0, 0, Math.PI * 2); ctx.fill(); }
        ctx.restore();
      }
    }
    // Blush when pleased, paid or giggling.
    if (m === "happy" || m === "love" || react?.kind === "giggle") {
      ctx.fillStyle = "rgba(255,120,160,.35)";
      for (const side of [-1, 1]) { ctx.beginPath(); ctx.ellipse(side * S * 0.3, S * 0.17, S * 0.06, S * 0.03, 0, 0, Math.PI * 2); ctx.fill(); }
    }
    // The earbuds went on: a little pair of headphones over him.
    if (react?.kind === "phones") {
      ctx.strokeStyle = "rgba(255,255,255,.85)";
      ctx.fillStyle = "rgba(255,255,255,.9)";
      ctx.lineWidth = S * 0.035;
      ctx.beginPath(); ctx.arc(0, S * 0.05, S * 0.36, Math.PI * 1.08, Math.PI * 1.92); ctx.stroke();
      for (const side of [-1, 1]) { rrect(ctx, side * S * 0.36 - S * 0.045, -S * 0.04, S * 0.09, S * 0.16, S * 0.04); ctx.fill(); }
    }
    ctx.restore();
    // Around him: thinking dots, a z, a sweat drop, a music note.
    if (m === "think") for (let i = 0; i < 3; i++) {
      if (!still && Math.floor(t * 3) % 3 < i) continue;
      ctx.fillStyle = "#cfc6ff";
      ctx.beginPath(); ctx.arc(S * (0.74 + i * 0.07), S * (0.2 - i * 0.04), S * 0.03, 0, Math.PI * 2); ctx.fill();
    }
    if (m === "sleep" && !still) {
      const q = (t * 0.4) % 1;
      ctx.globalAlpha = (1 - q) * 0.9;
      ctx.fillStyle = "#c9cbff";
      ctx.font = `700 ${S * 0.2}px "Instrument Sans", system-ui, sans-serif`;
      ctx.fillText("z", S * (0.76 + q * 0.06), S * (0.32 - q * 0.12));
      ctx.globalAlpha = 1;
    }
    if (m === "alert") { ctx.fillStyle = "#86d8ff"; ctx.beginPath(); ctx.ellipse(S * 0.82, S * 0.26, S * 0.035, S * 0.05, -0.4, 0, Math.PI * 2); ctx.fill(); }
    return moving;
  }
}
