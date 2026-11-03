/* Hoot and Sir (2 Nov, his picks beside the Eyes): the Guardian as a chunky
 * 16 × 16 pixel friend. Same contract as the Eyes (face-eyes.ts) — one frame
 * for a mood, his habits and a reaction, saying whether it still moves — so
 * every view, mood and reaction works whoever he is.
 *
 * Hoot, an owl: big eyes in pale discs, ear tufts that lift when he listens
 * or is startled and flatten when he's sleepy, a beak that opens to talk.
 * Sir, a knight's helmet: the eyes glow through the visor slit, the plume
 * takes the mood's colour. Drawn from the studies he chose them on
 * (claude.ai/artifact/2r5e27mDM29xxFP1aySWPk).
 *
 * ⚠️ No runtime imports (`node --test` loads this, AGENTS 437): a reaction
 * is handed over only while it plays (face.ts), so no timing table here.
 *
 * ⚠️ Pixels land on whole device pixels (`P` rounds each edge), or a 16-grid
 * on a 52-pixel canvas smears into blur.
 */
import type { Habits, Reaction } from "./face-eyes";
import type { Mood } from "./face-mood";

export type Friend = "hoot" | "sir";

const G = 16;
const INK = "#140f2e", WHITE = "#ffffff", PINK = "rgba(255,143,168,.85)", HEART = "#ff4f86";
const MOODCOL: Record<Mood, string> = {
  idle: "#b7adff", listen: "#7fe3ff", think: "#e2dcff", speak: "#b7adff", happy: "#8dffbf", love: "#ff6fa8",
  focus: "#ffc28a", alert: "#ffb020", oops: "#ff6b6b", sleep: "#5a5fa8", vibe: "#d9ccff",
};
const PAL: Record<Friend, string[]> = {
  hoot: ["#3b2414", "#7a4e2c", "#a06a3e", "#d39a62"],
  sir: ["#2a2e38", "#6b7385", "#9aa3b6", "#d6dce8"],
};

type Paint = (x: number, y: number, c: string, w?: number, h?: number) => void;

const blinkAt = (t: number) => t % 3.7 > 3.55;
const talk = (t: number) => { const s = Math.sin(t * 13) * Math.sin(t * 5.3 + 0.7); return s > 0.12 ? (s > 0.5 ? 2 : 1) : 0; };
const hop = (t: number) => Math.max(0, Math.sin(((t * 1.6) % 1) * Math.PI));
const NO_BLINK: ReadonlySet<Mood> = new Set<Mood>(["sleep", "happy", "love", "oops", "vibe"]);

/** A round body lit from the top left, with a dark rim. */
function blob(P: Paint, cx: number, cy: number, rx: number, ry: number, pal: string[]) {
  for (let y = 0; y < G; y++) for (let x = 0; x < G; x++) {
    const ox = (x + 0.5 - cx) / rx, oy = (y + 0.5 - cy) / ry, d = Math.hypot(ox, oy);
    if (d > 1) continue;
    const lit = -ox * 0.6 - oy * 0.8;
    P(x, y, d > 1 - 1.1 / Math.min(rx, ry) ? pal[0] : lit > 0.45 ? pal[3] : lit > -0.25 ? pal[2] : pal[1]);
  }
}

function line(P: Paint, x0: number, y0: number, x1: number, y1: number, c: string) {
  const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
  for (let i = 0; i <= n; i++) P(x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n, c);
}

/** What a reaction looks like as a mood, for a face this small. */
function asMood(m: Mood, react: Reaction | null): Mood {
  if (react === "startle" || react === "wide") return "alert";
  if (react === "giggle") return "happy";
  if (react === "grumpy") return "focus";
  if (react === "tired") return "sleep";
  return m === "vibe" ? "happy" : m;
}

/** Hoot's eyes, three pixels wide, with brows; `look` moves the pupils. */
function eyes(P: Paint, m: Mood, t: number, lx: number, rx: number, ey: number, look: number, shut: boolean, browInk: string, grumpy: boolean) {
  for (const [i, x] of [[0, lx], [1, rx]] as const) {
    const at = grumpy ? (i === 0 ? [-1, 0] : [0, -1])
      : ({ listen: [-1, -1], alert: i === 0 ? [0, -1] : [-1, 0], focus: i === 0 ? [-1, 0] : [0, -1], think: i === 1 ? [-1, -1] : [0, 0], happy: [-1, -1], love: [-1, -1], oops: i === 0 ? [0, -1] : [-1, 0] } as Partial<Record<Mood, number[]>>)[m] ?? [0, 0];
    if (m !== "sleep") line(P, x, ey - 2 + at[0], x + 2, ey - 2 + at[1], browInk);
    if (m === "love") { P(x, ey, HEART); P(x + 2, ey, HEART); P(x, ey + 1, HEART, 3, 1); P(x + 1, ey + 2, HEART); continue; }
    if (m === "oops") { P(x, ey, INK); P(x + 2, ey, INK); P(x + 1, ey + 1, INK); P(x, ey + 2, INK); P(x + 2, ey + 2, INK); continue; }
    if (m === "sleep" || shut) { P(x, ey + 2, INK, 3, 1); continue; }
    if (m === "happy") { P(x, ey + 1, INK); P(x + 1, ey, INK); P(x + 2, ey + 1, INK); continue; }
    if (m === "focus") { P(x, ey + 1, WHITE, 3, 2); P(x + 1 + look, ey + 2, INK); continue; }
    const tall = m === "listen" || m === "alert";
    const top = tall ? ey - 1 : ey, h = tall ? 4 : 3;
    P(x, top, WHITE, 3, h);
    P(x + 1 + look, top + h - 2 - (m === "think" ? 1 : 0), INK, 1, 2);
  }
}

/** What floats around him: thinking dots, a heart, a z, a sweat drop, a note. */
function around(P: Paint, m: Mood, t: number, X: number, cy: number, r: number, still: boolean) {
  if (m === "think") for (let i = 0; i < 3; i++) if (still || Math.floor(t * 3) % 3 >= i) P(X + r + i - 1, cy - r - i + 1, "#e2dcff");
  if (m === "love") { const q = still ? 0 : (t * 0.6) % 1; const hx = X + r - 2, hy = cy - r - Math.round(q * 3); const c = `rgba(255,79,134,${0.45 + 0.55 * (1 - q)})`; P(hx, hy, c); P(hx + 2, hy, c); P(hx, hy + 1, c, 3, 1); P(hx + 1, hy + 2, c); }
  if (m === "sleep" && !still) { const q = (t * 0.5) % 1; const zx = X + r - 2 + Math.round(q * 2), zy = cy - r - Math.round(q * 3); const c = `rgba(201,203,255,${1 - q})`; P(zx, zy, c, 2, 1); P(zx + 1, zy + 1, c); P(zx, zy + 2, c, 2, 1); }
  if (m === "alert") P(X + r - 1, cy - r + 2, "#7fd8ff", 1, 2);
}

export class Sprite {
  private mood: Mood | null = null;
  private turned = -9;

  readonly who: Friend;
  // ⚠️ A plain field, not a parameter property: `node --test` strips types only (AGENTS 437).
  constructor(who: Friend) { this.who = who; }

  /** One frame (see `Eyes.draw`). `zoom` is the Eyes' and ignored: a sprite fills its square. */
  draw(ctx: CanvasRenderingContext2D, S: number, t: number, mood: Mood, _dt: number, life: Habits, still: boolean): boolean {
    if (mood !== this.mood) { this.mood = mood; this.turned = t; }
    const react = life.react;
    const m = asMood(mood, react?.kind ?? null);
    const k = S / G;
    ctx.clearRect(0, 0, S, S);
    const P: Paint = (x, y, c, w = 1, h = 1) => {
      const x0 = Math.round(Math.round(x) * k), y0 = Math.round(Math.round(y) * k);
      ctx.fillStyle = c;
      ctx.fillRect(x0, y0, Math.round((Math.round(x) + w) * k) - x0, Math.round((Math.round(y) + h) * k) - y0);
    };
    const shake = (m === "alert" || m === "oops") && !still ? Math.round(Math.sin(t * 22) * 0.6) : 0;
    const vibe = mood === "vibe" && !still ? Math.round(Math.abs(Math.sin(t * Math.PI * 4))) : 0;
    const nod = react?.kind === "nod" && !still ? Math.round(Math.max(0, Math.sin((t - react.at) * 14))) : 0;
    const bob = (m === "happy" || m === "love") && !still ? -Math.round(hop(t)) : 0;
    const startle = react?.kind === "startle" && !still ? -1 : 0;
    const X = 8 + shake + (mood === "vibe" && !still ? Math.round(Math.sin(t * Math.PI * 2) * 0.6) : 0);
    const cy = 9 + bob - vibe + nod + startle;
    // He looks where he's told: the cursor near him, or new text beside him.
    const look = life.look ? Math.max(-1, Math.min(1, Math.round(life.look.x * 1.5))) : t < life.glance ? 1 : 0;
    const shut = (!still && blinkAt(t) && !NO_BLINK.has(m)) || (react?.kind === "flash" && t - react.at < 0.36)
      || (!still && t < life.wink && m === "idle");
    const grumpy = react?.kind === "grumpy";

    if (this.who === "hoot") this.hoot(P, m, t, X, cy, look, shut, grumpy, still);
    else this.sir(P, m, t, X, cy, look, shut, grumpy, still);
    if (m === "happy" || m === "love" || react?.kind === "giggle") { P(X - 7, cy + 1, PINK); P(X + 6, cy + 1, PINK); }
    // The earbuds went on: headphones over him.
    if (react?.kind === "phones") {
      const c = "rgba(255,255,255,.92)";
      line(P, X - 6, cy - 5, X - 3, cy - 8, c); P(X - 3, cy - 8, c, 6, 1); line(P, X + 3, cy - 8, X + 5, cy - 5, c);
      P(X - 8, cy - 4, c, 2, 4); P(X + 6, cy - 4, c, 2, 4);
    }
    // Grumpy: a little cross mark by his head.
    if (grumpy) { P(X + 5, cy - 7, "#ff6b6b", 3, 1); P(X + 6, cy - 8, "#ff6b6b", 1, 3); }
    around(P, m, t, X, cy, 7, still);
    // Moving while a mood moves by nature, a reaction plays, or he just turned.
    return !still && (!!react || t - this.turned < 0.3 || bob !== 0 || mood === "vibe");
  }

  private hoot(P: Paint, m: Mood, t: number, X: number, cy: number, look: number, shut: boolean, grumpy: boolean, still: boolean) {
    const pal = PAL.hoot;
    blob(P, X, cy, 7, 6.6, pal);
    // Tufts: up when listening or surprised, flat when sleepy.
    const up = m === "listen" || m === "alert" || m === "oops" ? 1 : m === "sleep" ? -1 : 0;
    P(X - 6, cy - 6 - up, pal[1], 2, 2 + up); P(X - 5, cy - 7 - up, pal[1]); P(X + 4, cy - 6 - up, pal[1], 2, 2 + up); P(X + 4, cy - 7 - up, pal[1]);
    // Pale face discs and a lighter belly.
    for (const dx of [-3, 3]) for (let y = -2; y <= 2; y++) for (let x = -2; x <= 2; x++) if (x * x + y * y <= 5) P(X + dx + x - (dx > 0 ? 1 : 0), cy - 2 + y, "#f3dcb8");
    P(X - 2, cy + 4, "#e8c9a0", 4, 2); P(X - 1, cy + 4, "#c99a68"); P(X + 1, cy + 5, "#c99a68");
    eyes(P, m, t, X - 5, X + 1, cy - 3, look, shut, pal[0], grumpy);
    // The beak, open when he talks or gasps.
    const open = m === "speak" ? (still ? 1 : talk(t)) : m === "alert" || m === "oops" ? 1 : 0;
    P(X - 1, cy, "#ffb020", 2, 1); P(X - 1, cy + 1, open ? "#a85a00" : "#ffb020", 2, 1);
    if (open > 1) P(X - 1, cy + 2, "#ffb020", 2, 1);
    P(X - 3, cy + 7, "#ffb020", 2, 1); P(X + 1, cy + 7, "#ffb020", 2, 1);
  }

  private sir(P: Paint, m: Mood, t: number, X: number, cy: number, look: number, shut: boolean, grumpy: boolean, still: boolean) {
    const pal = PAL.sir;
    // The plume, swaying, in the mood's colour.
    const sw = still ? 0 : Math.round(Math.sin(t * 2) * 0.7);
    const plume = grumpy ? MOODCOL.oops : MOODCOL[m];
    P(X - 1 + sw, cy - 9, plume, 3, 2); P(X + sw, cy - 10, plume, 2, 1); P(X, cy - 7, plume, 1, 1);
    blob(P, X, cy, 6.8, 6.8, pal);
    P(X, cy - 6, pal[3], 1, 4);
    // The visor: a dark slit with the eyes glowing in it.
    P(X - 5, cy - 1, "#0b0d14", 11, 3);
    const glow = m === "sleep" ? "#6a70c0" : m === "listen" ? MOODCOL.listen : WHITE;
    for (const ex of [X - 4 + look, X + 1 + look]) {
      if (m === "love") { P(ex, cy - 1, HEART); P(ex + 2, cy - 1, HEART); P(ex, cy, HEART, 3, 1); P(ex + 1, cy + 1, HEART); }
      else if (m === "oops") { P(ex, cy - 1, "#ff6b6b"); P(ex + 2, cy - 1, "#ff6b6b"); P(ex + 1, cy, "#ff6b6b"); P(ex, cy + 1, "#ff6b6b"); P(ex + 2, cy + 1, "#ff6b6b"); }
      else if (m === "happy") { P(ex, cy, glow); P(ex + 1, cy - 1, glow); P(ex + 2, cy, glow); }
      else if (m === "sleep" || shut) P(ex, cy + 1, glow, 3, 1);
      else if (m === "focus") P(ex, cy, grumpy ? "#ff6b6b" : MOODCOL.focus, 3, 1);
      else if (m === "alert") P(ex + 1, cy - 1, MOODCOL.alert, 1, 3);
      else if (m === "think") P(ex + 1, cy - 1, glow, 2, 1);
      else P(ex, cy - 1, glow, 3, 2);
    }
    // Breathing holes, and a grille that moves when he talks.
    const o = m === "speak" ? (still ? 1 : talk(t)) : 0;
    P(X - 2, cy + 3, "#1b1f29"); P(X, cy + 3 + (o ? 1 : 0), "#1b1f29"); P(X + 2, cy + 3, "#1b1f29");
  }
}
