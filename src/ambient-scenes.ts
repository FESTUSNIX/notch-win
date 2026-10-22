/* The generated scenes behind ambient mode.
 *
 * Two rooms — a cabin looking out on mountains, and a café window onto a city
 * — plus a wash made from the album art. Everything outside the window comes
 * from the `Sky` (`ambient-sky.ts`): the colour of the sky, where the sun or
 * the moon is and how full it is, cloud, fog, rain, snow and lightning. So a
 * scene is the real evening outside unless somebody picks another.
 *
 * ⚠️ TWO canvases, and the split is about focus, not layering for its own
 * sake. `far` is everything through the glass: drawn at a third of the
 * resolution and blurred by CSS, which is both what a view out of a window
 * looks like and what makes it cheap. `near` is the room and the glass itself
 * — the raindrops, the mug, the lamp — at full resolution, because those are
 * the things in focus. The camera's own contribution — bloom, grain, grade,
 * vignette — is `ambient-lens.ts`, over the top of both.
 *
 * ── What makes it read as a photograph rather than a drawing ─────────────
 * Not detail for its own sake; the handful of things a camera always records
 * and an illustration usually leaves out:
 *
 *   · light has a SOURCE and lands somewhere — a pool on the wood under the
 *     candle, the lit side of the mug facing the lamp, dust lit only inside
 *     the lamp's reach;
 *   · materials have texture — grain in the wood, fractal cloud rather than
 *     ellipses, pines on a ridge rather than a smooth curve;
 *   · distance has air in it — far ridges and the back skyline fade toward
 *     the colour of the horizon;
 *   · water on glass is a LENS — each drop holds the view behind it, upside
 *     down, which is the single most recognisable thing about a rainy window;
 *   · glass reflects the room at night.
 *
 * ⚠️ Every scene redraws everything every frame, except the static drops
 * (below), which only need the view behind them.
 */
import { mix, skyColours, type Sky } from "./ambient-sky.ts";

export interface Canvases {
  far: CanvasRenderingContext2D;
  near: CanvasRenderingContext2D;
  /** Near canvas, in its own pixels. */
  W: number;
  H: number;
  /** Far canvas, in its own pixels. */
  FW: number;
  FH: number;
  /** Near pixels per design unit — 1 at a 1000px-wide canvas. */
  S: number;
}

export interface SceneExtras {
  /** The cover's colours, for the artwork wash. */
  palette: number[][];
}

export interface Scene {
  id: string;
  name: string;
  build(c: Canvases): void;
  draw(c: Canvases, sky: Sky, t: number, dt: number, extras: SceneExtras): void;
}

/* Seeded, so every scene is the same room each time it is built. */
function rng(seed: number) {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
const rgb = (c: number[], a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const smooth = (a: number, b: number, v: number) => { const t = clamp01((v - a) / (b - a)); return t * t * (3 - 2 * t); };
const scale = (c: number[], k: number) => c.map(v => Math.round(Math.min(255, v * k)));

function glow(g: CanvasRenderingContext2D, x: number, y: number, r: number, c: string, a: number) {
  if (a <= 0.003 || r <= 0) return;
  const grad = g.createRadialGradient(x, y, 0, x, y, r);
  grad.addColorStop(0, `rgba(${c},${a})`);
  grad.addColorStop(1, `rgba(${c},0)`);
  g.fillStyle = grad;
  g.fillRect(x - r, y - r, r * 2, r * 2);
}

/** Light landing on a flat surface: an ellipse, because the surface is seen
 *  at a glancing angle. Added, not painted over, so the wood shows through. */
function pool(g: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number, c: string, a: number) {
  if (a <= 0.003) return;
  g.save();
  g.globalCompositeOperation = "lighter";
  g.translate(x, y);
  g.scale(1, ry / rx);
  const grad = g.createRadialGradient(0, 0, 0, 0, 0, rx);
  grad.addColorStop(0, `rgba(${c},${a})`);
  grad.addColorStop(0.45, `rgba(${c},${a * 0.35})`);
  grad.addColorStop(1, `rgba(${c},0)`);
  g.fillStyle = grad;
  g.fillRect(-rx, -rx, rx * 2, rx * 2);
  g.restore();
}

/* ── Texture, made once ────────────────────────────────────────────────── */

/** Fractal value noise, 0..1, tiling left to right so the clouds can drift
 *  forever. ⚠️ Rows are NOT wrapped — the band fades out top and bottom. */
function fbm(w: number, h: number, R: () => number, cellsX: number, cellsY: number, octaves = 5): Float32Array {
  const out = new Float32Array(w * h);
  let amp = 1, total = 0;
  for (let o = 0; o < octaves; o++) {
    const gx = cellsX << o, gy = cellsY << o;
    const grid = new Float32Array(gx * (gy + 1));
    for (let i = 0; i < grid.length; i++) grid[i] = R();
    for (let y = 0; y < h; y++) {
      const fy = (y / h) * gy, y0 = Math.floor(fy), ty = fy - y0, sy = ty * ty * (3 - 2 * ty), y1 = Math.min(y0 + 1, gy);
      for (let x = 0; x < w; x++) {
        const fx = (x / w) * gx, x0 = Math.floor(fx) % gx, tx = fx - Math.floor(fx), sx = tx * tx * (3 - 2 * tx), x1 = (x0 + 1) % gx;
        const a = grid[y0 * gx + x0] + (grid[y0 * gx + x1] - grid[y0 * gx + x0]) * sx;
        const b = grid[y1 * gx + x0] + (grid[y1 * gx + x1] - grid[y1 * gx + x0]) * sx;
        out[y * w + x] += (a + (b - a) * sy) * amp;
      }
    }
    total += amp;
    amp *= 0.5;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

/** Wood grain, as semi-transparent light and dark lines over whatever the
 *  surface's own lighting is — so the same texture works lit and unlit. */
function woodTexture(w: number, h: number, S: number, R: () => number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const g = c.getContext("2d")!;
  for (let i = 0; i < 170; i++) {
    const y = R() * h, amp = (1 + R() * 5) * S, f = 0.002 + R() * 0.006, ph = R() * 6;
    const dark = R() < 0.62;
    g.strokeStyle = dark ? `rgba(0,0,0,${0.08 + R() * 0.16})` : `rgba(255,214,170,${0.025 + R() * 0.05})`;
    g.lineWidth = (0.4 + R() * 2.2) * S;
    g.beginPath();
    for (let x = 0; x <= w; x += 8 * S) {
      const yy = y + Math.sin(x * f + ph) * amp + Math.sin(x * f * 3.1 + ph * 2) * amp * 0.3;
      if (x) g.lineTo(x, yy); else g.moveTo(x, yy);
    }
    g.stroke();
  }
  // Knots: a few darker eyes the lines would bend round in real timber.
  for (let i = 0; i < 4; i++) {
    const x = R() * w, y = R() * h, r = (3 + R() * 6) * S;
    g.save(); g.translate(x, y); g.scale(2.6, 1);
    const k = g.createRadialGradient(0, 0, 0, 0, 0, r);
    k.addColorStop(0, "rgba(0,0,0,0.3)"); k.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = k; g.fillRect(-r, -r, r * 2, r * 2);
    g.restore();
  }
  return c;
}

/* ── Through the glass ─────────────────────────────────────────────────── */

interface Weatherish {
  stars: { x: number; y: number; a: number; ph: number }[];
  /** Cloud cover as three masks — scattered, broken, overcast — cross-faded
   *  by the sky's cloud amount rather than re-thresholded per frame. */
  clouds: HTMLCanvasElement[];
  tint: HTMLCanvasElement;
  drift: number;
}

function buildSky(c: Canvases, R: () => number): Weatherish {
  const w = c.FW, h = Math.round(c.FH * 0.56);
  const n = fbm(w, h, R, 5, 3);
  const clouds = [0.58, 0.47, 0.33].map(th => {
    const cv = document.createElement("canvas");
    cv.width = w; cv.height = h;
    const g = cv.getContext("2d")!;
    const img = g.createImageData(w, h);
    for (let y = 0; y < h; y++) {
      // Thin at the zenith, gone at the horizon, where the ridge or skyline is.
      const profile = smooth(0, 0.18, y / h) * (1 - smooth(0.62, 1, y / h));
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
        img.data[i + 3] = Math.round(255 * smooth(th, th + 0.24, n[y * w + x]) * profile);
      }
    }
    g.putImageData(img, 0, 0);
    return cv;
  });
  const tint = document.createElement("canvas");
  tint.width = w; tint.height = h;
  return {
    stars: Array.from({ length: 110 }, () => ({ x: R() * c.FW, y: R() * c.FH * 0.45, a: 0.2 + R() * 0.7, ph: R() * 6 })),
    clouds, tint, drift: c.FW * 0.004,
  };
}

/** The sky, the sun or moon, stars and clouds, down to `horizon` (0..1). */
function drawSky(c: Canvases, s: Weatherish, sky: Sky, t: number, horizon: number) {
  const g = c.far, { FW, FH } = c;
  const col = skyColours(sky);
  const grad = g.createLinearGradient(0, 0, 0, FH * horizon);
  grad.addColorStop(0, rgb(col.top));
  grad.addColorStop(0.6, rgb(col.mid));
  grad.addColorStop(1, rgb(col.horizon));
  g.fillStyle = grad;
  g.fillRect(0, 0, FW, FH);

  // Stars, only where it is dark and clear.
  const starry = (1 - sky.light / 0.35) * (1 - sky.cloud);
  if (starry > 0.02) {
    for (const st of s.stars) {
      g.fillStyle = `rgba(255,248,235,${Math.max(0, starry * st.a * (0.65 + 0.35 * Math.sin(t * 0.8 + st.ph)))})`;
      g.fillRect(st.x, st.y, 0.9, 0.9);
    }
  }

  /* The sun or the moon, on its own arc. ⚠️ An arc that rises from the
   * horizon at the ends of the day, not a straight line — a sun that slides
   * sideways at a fixed height reads as a lamp. Hidden in proportion to the
   * cloud, and gone entirely behind fog. */
  const veil = Math.max(0, 1 - sky.cloud * 0.9 - sky.fog * 0.8);
  const x = FW * (0.16 + 0.68 * sky.share);
  const y = FH * horizon - Math.sin(Math.PI * sky.share) * FH * horizon * 0.72;
  if (sky.part !== "night") {
    const warm = sky.warmth;
    const core = mix([255, 250, 236], [255, 196, 130], warm);
    glow(g, x, y, FH * 0.5, `${mix([255, 240, 210], [255, 150, 90], warm)}`, 0.22 * veil + 0.05);
    glow(g, x, y, FH * 0.07, `${core}`, 0.95 * veil);
  } else if (veil > 0.05) {
    const r = FH * 0.032;
    glow(g, x, y, r * 7, "226,232,255", 0.16 * veil);
    g.save();
    g.globalAlpha = 0.92 * veil;
    /* ⚠️ CLIPPED to the moon's own disc before the shadow is laid on. The
     * first version filled two overlapping discs even-odd, which for a
     * gibbous moon also painted the part of the shadow disc hanging OUTSIDE
     * the moon — a sliver of moonlight floating in the sky beside it. */
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.clip();
    // Maria: the moon is not a flat disc, and two soft greys are enough to say so.
    g.fillStyle = "#f3ecd8";
    g.fillRect(x - r, y - r, r * 2, r * 2);
    glow(g, x - r * 0.3, y - r * 0.2, r * 0.45, "180,176,168", 0.35);
    glow(g, x + r * 0.25, y + r * 0.3, r * 0.35, "186,182,172", 0.3);
    /* The phase as a shadow disc sliding across: new at 0, full at 0.5.
     * Waxing lit on the right, waning on the left — the northern hemisphere's
     * view. The shadow is the sky's own colour, a touch lighter: earthshine,
     * which is what the dark part of a real crescent looks like. */
    const lit = sky.moon <= 0.5 ? sky.moon / 0.5 : (1 - sky.moon) / 0.5;
    if (lit < 0.97) {
      const side = sky.moon <= 0.5 ? -1 : 1;
      g.fillStyle = rgb(mix(col.top, [70, 76, 100], 0.25));
      g.beginPath();
      g.arc(x + side * r * 2 * lit, y, r * 1.02, 0, Math.PI * 2);
      g.fill();
    }
    g.restore();
  }

  /* Clouds: fractal, lit from above, shaded underneath. ⚠️ Drawn twice from
   * one mask — the shadow colour a little lower, the lit colour over it — so
   * each cloud has a bright top and a dark belly, which is what gives it
   * volume; one flat tint reads as smoke. */
  const lit = mix(mix([40, 44, 62], [238, 240, 246], sky.light), [255, 168, 128], sky.warmth * 0.55);
  const belly = mix(lit, mix([16, 18, 30], [96, 104, 122], sky.light), 0.55);
  const cover = clamp01(sky.cloud);
  const level = cover * 2, lo = Math.min(1, Math.floor(level)), f = level - lo;
  const tg = s.tint.getContext("2d")!, cw = s.tint.width, ch = s.tint.height;
  const paint = (colour: number[]) => {
    tg.globalCompositeOperation = "source-over";
    tg.clearRect(0, 0, cw, ch);
    tg.globalAlpha = 1 - f; tg.drawImage(s.clouds[lo], 0, 0);
    tg.globalAlpha = f; tg.drawImage(s.clouds[lo + 1], 0, 0);
    tg.globalAlpha = 1;
    tg.globalCompositeOperation = "source-in";
    tg.fillStyle = rgb(colour);
    tg.fillRect(0, 0, cw, ch);
  };
  const off = (t * s.drift) % cw;
  const place = (dy: number, a: number) => {
    g.globalAlpha = a;
    g.drawImage(s.tint, -off, dy);
    g.drawImage(s.tint, cw - off, dy);
    g.globalAlpha = 1;
  };
  const a = 0.12 + 0.88 * cover;
  paint(belly); place(FH * 0.012, a * 0.9);
  paint(lit); place(0, a * 0.85);
}

/** Fog lying in bands, drifting. */
function drawFog(c: Canvases, sky: Sky, t: number, bands: number[]) {
  if (sky.fog < 0.02) return;
  const g = c.far, { FW, FH } = c;
  const tint = mix([60, 64, 84], [214, 218, 226], sky.light);
  bands.forEach((y, i) => {
    for (let k = 0; k < 4; k++) {
      const cx = ((k * FW * 0.34 + t * FW * (0.004 + i * 0.002)) % (FW * 1.4)) - FW * 0.2;
      const cy = FH * y + FH * 0.02 * Math.sin(t * 0.2 + k + i);
      g.save();
      g.translate(cx, cy);
      g.scale(1, 0.18);
      const grad = g.createRadialGradient(0, 0, 0, 0, 0, FW * 0.3);
      grad.addColorStop(0, rgb(tint, 0.22 * sky.fog));
      grad.addColorStop(1, rgb(tint, 0));
      g.fillStyle = grad;
      g.beginPath();
      g.arc(0, 0, FW * 0.3, 0, Math.PI * 2);
      g.fill();
      g.restore();
    }
  });
  // And a general haze over the lot.
  g.fillStyle = rgb(tint, 0.25 * sky.fog);
  g.fillRect(0, 0, FW, FH);
}

/* ── On the glass ──────────────────────────────────────────────────────── */

interface Drop { x: number; y: number; r: number }
interface Precip {
  streaks: { x: number; y: number; l: number; v: number }[];
  flakes: { x: number; y: number; r: number; v: number; ph: number }[];
  statics: Drop[];
  drops: HTMLCanvasElement;
  dropsAge: number;
  sliders: { x: number; y: number; r: number; v: number; hold: number; trail: [number, number][] }[];
  flash: number;
  nextFlash: number;
}

function buildPrecip(c: Canvases, R: () => number, glass: boolean): Precip {
  const { W, H, S } = c;
  const drops = document.createElement("canvas");
  drops.width = W;
  drops.height = H;
  return {
    streaks: Array.from({ length: 140 }, () => ({ x: R() * W, y: R() * H, l: (12 + R() * 26) * S, v: (600 + R() * 500) * S })),
    flakes: Array.from({ length: 160 }, () => ({ x: R() * W, y: R() * H, r: (0.8 + R() * 2.2) * S, v: (26 + R() * 50) * S, ph: R() * 6 })),
    // Mostly small, a few big — the size spread of real water on glass.
    /* ⚠️ Big enough to hold a picture. At 1–5 units every drop was a dot and
     * the lens — the whole reason a rainy window looks like one — was too
     * small to see. */
    statics: glass ? Array.from({ length: 210 }, () => ({ x: R() * W, y: R() * H * 0.8, r: (0.9 + Math.pow(R(), 2.2) * 7.5) * S })) : [],
    drops,
    dropsAge: 99,
    sliders: glass
      ? Array.from({ length: 16 }, () => ({ x: R() * W, y: -R() * H * 0.5, r: (4 + R() * 4) * S, v: 0, hold: R() * 2, trail: [] }))
      : [],
    flash: 0,
    nextFlash: 6 + R() * 10,
  };
}

/** One drop of water on the glass: a tiny lens holding the view behind it,
 *  upside down and shrunk, with a dark rim, a caustic at the bottom and a
 *  highlight at the top.
 *
 * ⚠️ The view is sampled from the FAR canvas, which is the unblurred view at
 * a third of the size — exactly what a drop, focused much closer than the
 * street, would show anyway. */
function lensDrop(g: CanvasRenderingContext2D, far: HTMLCanvasElement, k: number, x: number, y: number, r: number, S: number) {
  if (r < 1.3 * S) {
    // Too small to hold an image: a bead of light and a shadow.
    g.fillStyle = "rgba(0,0,0,0.16)";
    g.beginPath(); g.arc(x, y + r * 0.2, r, 0, Math.PI * 2); g.fill();
    g.fillStyle = "rgba(235,242,255,0.28)";
    g.beginPath(); g.arc(x - r * 0.2, y - r * 0.25, r * 0.55, 0, Math.PI * 2); g.fill();
    return;
  }
  const rx = r * 0.9;
  g.save();
  g.beginPath(); g.ellipse(x, y, rx, r, 0, 0, Math.PI * 2); g.clip();
  const span = r * 7;
  g.translate(x, y); g.scale(1, -1);
  g.drawImage(far, (x - span) * k, (y - span) * k, span * 2 * k, span * 2 * k, -rx * 1.15, -r * 1.15, rx * 2.3, r * 2.3);
  g.setTransform(1, 0, 0, 1, 0, 0);
  // The rim: water thickens toward the edge and bends the light away.
  const rim = g.createRadialGradient(x, y - r * 0.15, r * 0.3, x, y, r * 1.05);
  rim.addColorStop(0, "rgba(0,0,0,0)");
  rim.addColorStop(0.7, "rgba(0,0,0,0.08)");
  rim.addColorStop(1, "rgba(0,0,0,0.45)");
  g.fillStyle = rim;
  g.fillRect(x - r * 1.1, y - r * 1.1, r * 2.2, r * 2.2);
  // Caustic: the light the drop gathers, pooled at its lower edge.
  g.fillStyle = "rgba(255,248,236,0.22)";
  g.beginPath(); g.ellipse(x, y + r * 0.55, rx * 0.55, r * 0.22, 0, 0, Math.PI * 2); g.fill();
  g.restore();
  // The highlight: the one sharp thing on the glass.
  g.fillStyle = "rgba(255,255,255,0.7)";
  g.beginPath(); g.ellipse(x - rx * 0.35, y - r * 0.45, rx * 0.2, r * 0.13, -0.5, 0, Math.PI * 2); g.fill();
}

function drawPrecip(c: Canvases, p: Precip, sky: Sky, dt: number) {
  const g = c.near, { W, H, S } = c;
  const far = c.far.canvas, k = c.FW / W;
  // Rain, beyond the glass.
  const falling = Math.round(p.streaks.length * sky.rain);
  if (falling) {
    g.strokeStyle = `rgba(200,215,240,${0.05 + 0.07 * sky.rain})`;
    g.lineWidth = Math.max(1, 0.8 * S);
    g.beginPath();
    for (let i = 0; i < falling; i++) {
      const s = p.streaks[i];
      s.y += s.v * dt;
      if (s.y > H) { s.y = -s.l; s.x = Math.random() * W; }
      g.moveTo(s.x, s.y);
      g.lineTo(s.x - s.l * 0.12, s.y + s.l);
    }
    g.stroke();
  }
  // Snow: slow, and drifting sideways rather than falling straight.
  const snowing = Math.round(p.flakes.length * sky.snow);
  for (let i = 0; i < snowing; i++) {
    const f = p.flakes[i];
    f.y += f.v * dt;
    f.x += Math.sin(f.y * 0.01 + f.ph) * 12 * S * dt;
    if (f.y > H) { f.y = -f.r; f.x = Math.random() * W; }
    g.fillStyle = `rgba(245,248,255,${0.35 + 0.4 * (f.r / (3 * S))})`;
    g.beginPath(); g.arc(f.x, f.y, f.r, 0, Math.PI * 2); g.fill();
  }
  if (!p.statics.length || sky.rain < 0.05) return;

  /* Condensation: the lower glass fogs a little on a wet evening. */
  const mist = g.createLinearGradient(0, H * 0.45, 0, H * 0.82);
  mist.addColorStop(0, "rgba(190,200,215,0)");
  mist.addColorStop(1, `rgba(190,200,215,${0.06 * sky.rain})`);
  g.fillStyle = mist;
  g.fillRect(0, H * 0.45, W, H * 0.37);

  /* The still drops. ⚠️ Re-rendered a few times a second, not every frame:
   * what they hold only changes as fast as the view does, and 240 clipped
   * image draws each frame is the most expensive thing on the page. */
  p.dropsAge += dt;
  if (p.dropsAge > 0.35 || dt === 0) {
    p.dropsAge = 0;
    const d = p.drops.getContext("2d")!;
    d.clearRect(0, 0, W, H);
    for (const drop of p.statics) lensDrop(d, far, k, drop.x, drop.y, drop.r, S);
  }
  g.globalAlpha = Math.min(1, sky.rain * 1.3);
  g.drawImage(p.drops, 0, 0);

  // The ones running down: a trail of wet glass behind, then the drop.
  const live = Math.round(p.sliders.length * sky.rain);
  for (let i = 0; i < live; i++) {
    const d = p.sliders[i];
    d.hold -= dt;
    if (d.hold <= 0) {
      d.v = (70 + Math.random() * 220) * S;
      if (Math.random() < 0.015) { d.hold = 0.4 + Math.random() * 1.8; d.v = 0; }
    }
    d.y += d.v * dt;
    d.x += Math.sin(d.y * 0.04) * 0.08 * S;
    const last = d.trail[d.trail.length - 1];
    if (!last || d.y - last[1] > 3 * S) { d.trail.push([d.x, d.y]); if (d.trail.length > 46) d.trail.shift(); }
    if (d.y > H * 0.8) Object.assign(d, { x: Math.random() * W, y: -Math.random() * H * 0.3, trail: [], v: 0, hold: Math.random() * 2 });
    if (d.trail.length > 1) {
      g.strokeStyle = "rgba(220,232,250,0.07)"; g.lineWidth = d.r * 0.5; g.lineCap = "round";
      g.beginPath(); d.trail.forEach(([x, y], j) => (j ? g.lineTo(x, y) : g.moveTo(x, y))); g.stroke();
    }
    lensDrop(g, far, k, d.x, d.y, d.r, S);
  }
  g.globalAlpha = 1;
}

/** Lightning: a flash over everything, now and then, fading fast.
 *  ⚠️ Rare and short on purpose. This is a room to rest in, not a storm to
 *  watch; a flash every few seconds would be the least ambient thing here. */
function drawFlash(c: Canvases, p: Precip, sky: Sky, dt: number) {
  if (!sky.storm) { p.flash = 0; return; }
  p.nextFlash -= dt;
  if (p.nextFlash <= 0) { p.flash = 1; p.nextFlash = 9 + Math.random() * 16; }
  if (p.flash > 0.01) {
    c.near.fillStyle = `rgba(220,228,255,${p.flash * 0.22})`;
    c.near.fillRect(0, 0, c.W, c.H);
    p.flash *= Math.pow(0.02, dt);
  }
}

/* ── In the room ───────────────────────────────────────────────────────── */

/** A stoneware mug, lit from the left by the room's light and from the
 *  window by whatever the sky is doing.
 *
 * ⚠️ Pale, not black. A black mug on a dark sill is a hole; a pale glaze is
 * what catches the lamp, and a lit curved surface — highlight, core shadow,
 * bounce — is most of what makes an object read as solid. */
function mug(g: CanvasRenderingContext2D, x: number, y: number, w: number, t: number, sky: Sky, warm: number) {
  const h = w * 0.95;
  const glaze = [214, 182, 150];
  const exposure = 0.2 + 0.5 * sky.light + 0.38 * warm;
  const litSide = mix(scale(glaze, exposure * 1.2), [255, 188, 124], 0.5 * warm);
  const base = scale(glaze, exposure * 0.7);
  const core = scale(glaze, exposure * 0.32);
  const bounce = scale(mix(glaze, [120, 140, 170], 0.4), exposure * 0.45);

  // The contact shadow, soft and wider than the base.
  g.save();
  g.translate(x + w * 0.12, y);
  g.scale(1, 0.14);
  const sh = g.createRadialGradient(0, 0, 0, 0, 0, w * 0.85);
  sh.addColorStop(0, "rgba(0,0,0,0.6)"); sh.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = sh; g.fillRect(-w, -w, w * 2, w * 2);
  g.restore();

  // Handle, on the shadow side.
  g.lineWidth = w * 0.1; g.lineCap = "round";
  g.strokeStyle = rgb(core);
  g.beginPath(); g.arc(x + w * 0.5, y - h * 0.5, w * 0.21, -1.3, 1.3); g.stroke();
  g.strokeStyle = rgb(base, 0.6); g.lineWidth = w * 0.03;
  g.beginPath(); g.arc(x + w * 0.5, y - h * 0.5, w * 0.24, -1.1, 0.2); g.stroke();

  // Body.
  const body = g.createLinearGradient(x - w / 2, 0, x + w / 2, 0);
  body.addColorStop(0, rgb(base));
  body.addColorStop(0.16, rgb(litSide));
  body.addColorStop(0.42, rgb(base));
  body.addColorStop(0.78, rgb(core));
  body.addColorStop(1, rgb(bounce));
  g.fillStyle = body;
  g.beginPath();
  if (g.roundRect) g.roundRect(x - w / 2, y - h, w, h, [w * 0.04, w * 0.04, w * 0.18, w * 0.18]);
  else g.rect(x - w / 2, y - h, w, h);
  g.fill();
  // Falls off toward the foot, where the room's light does not reach.
  const foot = g.createLinearGradient(0, y - h, 0, y);
  foot.addColorStop(0.55, "rgba(0,0,0,0)"); foot.addColorStop(1, "rgba(0,0,0,0.38)");
  g.fillStyle = foot; g.fill();
  // The specular streak: glaze is glossy.
  const spec = g.createLinearGradient(x - w * 0.36, 0, x - w * 0.24, 0);
  spec.addColorStop(0, "rgba(255,244,228,0)"); spec.addColorStop(0.5, `rgba(255,244,228,${0.18 + 0.3 * warm})`); spec.addColorStop(1, "rgba(255,244,228,0)");
  g.fillStyle = spec; g.fillRect(x - w * 0.36, y - h * 0.92, w * 0.12, h * 0.7);

  // The rim and the coffee in it.
  g.fillStyle = rgb(scale(litSide, 0.95));
  g.beginPath(); g.ellipse(x, y - h, w / 2, w * 0.09, 0, 0, Math.PI * 2); g.fill();
  const coffee = g.createLinearGradient(x - w / 2, 0, x + w / 2, 0);
  coffee.addColorStop(0, "#2a170c"); coffee.addColorStop(1, "#0c0604");
  g.fillStyle = coffee;
  g.beginPath(); g.ellipse(x, y - h + w * 0.012, w * 0.44, w * 0.068, 0, 0, Math.PI * 2); g.fill();
  g.fillStyle = `rgba(255,200,150,${0.12 + 0.25 * warm})`;
  g.beginPath(); g.ellipse(x - w * 0.14, y - h + w * 0.005, w * 0.1, w * 0.018, 0, 0, Math.PI * 2); g.fill();

  // Steam — the one thing in the room that always moves.
  g.save();
  g.globalCompositeOperation = "lighter";
  g.lineCap = "round";
  for (let k = 0; k < 3; k++) {
    const top = y - h;
    const grad = g.createLinearGradient(0, top, 0, top - w * 1.9);
    grad.addColorStop(0, "rgba(255,244,230,0.09)");
    grad.addColorStop(1, "rgba(255,244,230,0)");
    g.strokeStyle = grad; g.lineWidth = w * 0.13;
    g.shadowColor = "rgba(255,240,220,0.3)"; g.shadowBlur = w * 0.25;
    g.beginPath();
    for (let i = 0; i <= 26; i++) {
      const p = i / 26, yy = top - p * w * 1.9;
      const xx = x + (k - 1) * w * 0.15 + Math.sin(p * 5.2 + t * 0.8 + k * 2.1) * w * 0.16 * p;
      if (i) g.lineTo(xx, yy); else g.moveTo(xx, yy);
    }
    g.stroke();
  }
  g.restore();
}

/** A pillar candle, lit. ⚠️ The wax is brightest at the TOP, just under the
 *  flame, and falls off down the side — wax is translucent, and that inner
 *  glow is what tells the eye it is a candle and not a small beige box. */
function candle(g: CanvasRenderingContext2D, x: number, base: number, w: number, t: number, fl: number) {
  const h = w * 1.25, top = base - h;
  // Shadow on the sill, thrown away from the flame.
  g.save(); g.translate(x + w * 0.4, base); g.scale(1, 0.16);
  const sh = g.createRadialGradient(0, 0, 0, 0, 0, w * 1.1);
  sh.addColorStop(0, "rgba(0,0,0,0.45)"); sh.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = sh; g.fillRect(-w * 1.2, -w * 1.2, w * 2.4, w * 2.4);
  g.restore();
  // The wax: lit from inside at the top, round at the sides.
  const side = g.createLinearGradient(x - w / 2, 0, x + w / 2, 0);
  side.addColorStop(0, "rgba(120,80,50,1)"); side.addColorStop(0.3, "rgba(236,206,168,1)"); side.addColorStop(0.7, "rgba(170,126,90,1)"); side.addColorStop(1, "rgba(90,58,38,1)");
  g.fillStyle = side;
  g.beginPath();
  if (g.roundRect) g.roundRect(x - w / 2, top, w, h, [w * 0.06, w * 0.06, w * 0.1, w * 0.1]); else g.rect(x - w / 2, top, w, h);
  g.fill();
  const inner = g.createLinearGradient(0, top, 0, base);
  inner.addColorStop(0, `rgba(255,196,120,${0.75 * fl})`); inner.addColorStop(0.45, "rgba(255,170,90,0.12)"); inner.addColorStop(1, "rgba(0,0,0,0.3)");
  g.fillStyle = inner; g.fill();
  g.fillStyle = `rgba(255,226,170,${0.85 * fl})`;
  g.beginPath(); g.ellipse(x, top, w / 2, w * 0.1, 0, 0, Math.PI * 2); g.fill();
  // Wick, then the flame: a teardrop that sways, white at the root.
  const sway = Math.sin(t * 2.3) * Math.sin(t * 5.1) * w * 0.05;
  g.strokeStyle = "rgba(30,20,15,0.9)"; g.lineWidth = Math.max(1, w * 0.035);
  g.beginPath(); g.moveTo(x, top); g.lineTo(x, top - w * 0.12); g.stroke();
  const fh = w * (0.78 + 0.12 * fl), fw = w * 0.17, fy = top - w * 0.08;
  g.save();
  g.globalCompositeOperation = "lighter";
  glow(g, x + sway, fy - fh * 0.45, w * 0.9, "255,170,80", 0.35 * fl);
  const flame = g.createRadialGradient(x, fy - fh * 0.25, 0, x, fy - fh * 0.4, fh * 0.7);
  flame.addColorStop(0, "rgba(255,255,240,1)"); flame.addColorStop(0.35, "rgba(255,214,120,0.95)"); flame.addColorStop(1, "rgba(255,120,30,0)");
  g.fillStyle = flame;
  g.beginPath();
  g.moveTo(x + sway * 1.6, fy - fh);
  g.quadraticCurveTo(x + fw * 1.6, fy - fh * 0.28, x, fy);
  g.quadraticCurveTo(x - fw * 1.6, fy - fh * 0.28, x + sway * 1.6, fy - fh);
  g.fill();
  g.restore();
}

/** How much the room's own light is on. ⚠️ ON after dark and all but off at
 *  noon — a lamp glowing at full strength in a sunlit room is the scene
 *  ignoring its own sky. */
const lampOn = (sky: Sky) => 0.22 + 0.78 * (1 - sky.light);

/** A lamp out of frame, felt rather than seen: the light it throws. */
function lamp(g: CanvasRenderingContext2D, x: number, y: number, r: number, sky: Sky, t: number) {
  const on = lampOn(sky);
  const breathe = 1 + 0.015 * Math.sin(t * 3.1);
  glow(g, x, y, r * 1.6, "255,150,70", 0.16 * on * breathe);
  glow(g, x, y, r, "255,166,90", 0.34 * on * breathe);
  glow(g, x, y, r * 0.22, "255,218,168", 0.6 * on);
}

/** Dust drifting through the lamp's light. ⚠️ Lit only INSIDE its reach —
 *  motes that glowed everywhere would be snow; it is the falloff that says
 *  there is a lamp. */
interface Mote { x: number; y: number; r: number; vx: number; vy: number; ph: number }
function buildMotes(R: () => number, n: number): Mote[] {
  return Array.from({ length: n }, () => ({ x: R(), y: R(), r: 0.5 + Math.pow(R(), 3) * 2.6, vx: (R() - 0.5) * 0.006, vy: (R() - 0.3) * 0.004, ph: R() * 6 }));
}
function drawMotes(g: CanvasRenderingContext2D, motes: Mote[], box: [number, number, number, number], light: [number, number, number], on: number, t: number, dt: number, S: number) {
  if (on < 0.05) return;
  const [bx, by, bw, bh] = box, [lx, ly, lr] = light;
  g.save();
  g.globalCompositeOperation = "lighter";
  for (const m of motes) {
    m.x = (m.x + (m.vx + Math.sin(t * 0.21 + m.ph) * 0.002) * dt + 1) % 1;
    m.y = (m.y + (m.vy + Math.cos(t * 0.17 + m.ph) * 0.0015) * dt + 1) % 1;
    const x = bx + m.x * bw, y = by + m.y * bh;
    const d = Math.hypot(x - lx, y - ly) / lr;
    const a = on * Math.exp(-d * d * 2.2) * (0.5 + 0.5 * Math.sin(t * 0.9 + m.ph * 3));
    if (a < 0.02) continue;
    // The big ones are out of focus: softer and fainter.
    const r = m.r * S;
    glow(g, x, y, r * (m.r > 1.8 ? 2.6 : 1.6), "255,222,180", a * (m.r > 1.8 ? 0.35 : 0.8));
  }
  g.restore();
}

/** A table or sill: the surface's own light, the grain, the light landing on
 *  it, and the lit front edge. `shape` is the outline, in near pixels. */
function surface(g: CanvasRenderingContext2D, shape: [number, number][], top: number, H: number, wood: HTMLCanvasElement, sky: Sky, warm: number) {
  const trace = () => { g.beginPath(); shape.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath(); };
  const fill = g.createLinearGradient(0, top, 0, H);
  fill.addColorStop(0, rgb(mix(mix([46, 30, 19], [96, 72, 52], sky.light), [120, 70, 36], warm * 0.35)));
  fill.addColorStop(0.14, rgb(mix([24, 15, 10], [52, 38, 28], sky.light)));
  fill.addColorStop(1, "#060403");
  g.fillStyle = fill;
  trace(); g.fill();
  g.save(); trace(); g.clip();
  g.drawImage(wood, 0, top);
  g.restore();
}

/* ── The cabin ─────────────────────────────────────────────────────────── */

const cabin: Scene & {
  sky?: Weatherish; precip?: Precip; wood?: HTMLCanvasElement; motes?: Mote[];
  ridges?: { pts: [number, number][]; pines: [number, number, number][]; night: number[]; day: number[]; air: number }[];
  lights?: { x: number; y: number; r: number; ph: number; a: number }[];
} = {
  id: "cabin",
  name: "Cabin",
  build(c) {
    const R = rng(11);
    const ridge = (base: number, amp: number, f: number): [number, number][] => {
      const p = [R() * 6, R() * 6, R() * 6], pts: [number, number][] = [];
      for (let x = 0; x <= c.FW + 4; x += 3) {
        const u = x / c.FW;
        const n = 0.55 * Math.sin(u * f * 6.28 + p[0]) + 0.3 * Math.sin(u * f * 2.3 * 6.28 + p[1]) + 0.15 * Math.sin(u * f * 5.1 * 6.28 + p[2]);
        pts.push([x, c.FH * (base - amp * (0.5 + 0.5 * n))]);
      }
      return pts;
    };
    /* Pines along a ridge's crest: a treeline is what makes a curve read as a
     * forested mountain rather than a hill of felt. Nearer ridges, taller trees. */
    const pines = (pts: [number, number][], tall: number, every: number): [number, number, number][] => {
      const out: [number, number, number][] = [];
      for (let i = 0; i < pts.length; i += 1 + Math.floor(R() * every)) {
        const [x, y] = pts[i];
        out.push([x + R() * 2, y + c.FH * 0.004, c.FH * tall * (0.5 + R() * 0.8)]);
      }
      return out;
    };
    const r0 = ridge(0.5, 0.12, 1.3), r1 = ridge(0.55, 0.12, 1.8), r2 = ridge(0.62, 0.1, 2.4), r3 = ridge(0.7, 0.08, 3.1);
    this.ridges = [
      { pts: r0, pines: [], night: [88, 70, 98], day: [150, 170, 190], air: 0.42 },
      { pts: r1, pines: pines(r1, 0.008, 3), night: [58, 46, 72], day: [100, 128, 138], air: 0.26 },
      { pts: r2, pines: pines(r2, 0.014, 2), night: [33, 28, 46], day: [58, 88, 78], air: 0.12 },
      { pts: r3, pines: pines(r3, 0.022, 2), night: [16, 15, 25], day: [34, 56, 44], air: 0 },
    ];
    this.lights = [];
    for (let i = 0; i < 46; i++) {
      const r = this.ridges[2 + (i % 2)];
      const [lx, ly] = r.pts[Math.floor(R() * r.pts.length)];
      this.lights.push({ x: lx, y: ly + c.FH * (0.01 + R() * 0.06), r: 0.4 + R() * 0.9, ph: R() * 6, a: 0.5 + R() * 0.5 });
    }
    this.sky = buildSky(c, R);
    this.precip = buildPrecip(c, R, false);
    this.wood = woodTexture(c.W, Math.ceil(c.H * 0.27), c.S, R);
    this.motes = buildMotes(R, 46);
  },
  draw(c, sky, t, dt) {
    const g = c.far, { FW, FH, W, H, S } = c;
    drawSky(c, this.sky!, sky, t, 0.52);
    const horizon = skyColours(sky).horizon;
    /* Aerial perspective: each ridge further back is closer to the colour of
     * the air in front of it. Without it, four ridges are four paper cut-outs. */
    for (const r of this.ridges!) {
      const own = mix(mix(r.night, r.day, sky.light), [60, 64, 80], sky.cloud * 0.3);
      const colour = mix(own, horizon, r.air);
      const crest = Math.min(...r.pts.map(p => p[1]));
      const fill = g.createLinearGradient(0, crest, 0, FH);
      fill.addColorStop(0, rgb(mix(colour, horizon, 0.18)));
      fill.addColorStop(0.35, rgb(colour));
      fill.addColorStop(1, rgb(scale(colour, 0.7)));
      g.fillStyle = fill;
      g.beginPath(); g.moveTo(0, FH);
      for (const [x, y] of r.pts) g.lineTo(x, y);
      g.lineTo(FW, FH); g.closePath();
      for (const [x, y, h] of r.pines) { g.moveTo(x - h * 0.28, y); g.lineTo(x, y - h); g.lineTo(x + h * 0.28, y); g.closePath(); }
      g.fill();
    }
    drawFog(c, sky, t, [0.56, 0.62, 0.69]);
    // The village comes on as the light goes.
    const dark = Math.max(0, 1 - sky.light / 0.55);
    if (dark > 0.02) {
      g.save(); g.globalCompositeOperation = "lighter";
      for (const l of this.lights!) glow(g, l.x, l.y, l.r * 3, "255,178,96", dark * l.a * (0.7 + 0.3 * Math.sin(t * 1.4 + l.ph)));
      g.restore();
    }

    const n = c.near;
    const on = lampOn(sky);
    n.clearRect(0, 0, W, H);
    drawPrecip(c, this.precip!, sky, dt);
    // The glass catches the room at night: the lamp, faintly, where it would reflect.
    glow(n, W * 0.3, H * 0.4, W * 0.08, "255,170,100", 0.07 * on * dark);
    const wall = n.createLinearGradient(0, 0, W * 0.24, 0);
    wall.addColorStop(0, "rgba(14,9,7,0.97)"); wall.addColorStop(0.8, "rgba(14,9,7,0.72)"); wall.addColorStop(1, "rgba(14,9,7,0)");
    n.fillStyle = wall; n.fillRect(0, 0, W * 0.26, H);
    lamp(n, 0, H * 0.42, W * 0.24, sky, t);
    // The window's posts, with the lamp's light on their near faces.
    for (const x of [0.445, 0.735]) {
      const post = n.createLinearGradient(W * x, 0, W * (x + 0.017), 0);
      post.addColorStop(0, rgb(mix([10, 9, 12], [70, 44, 28], on * 0.5)));
      post.addColorStop(0.35, "#09080b"); post.addColorStop(1, "#050507");
      n.fillStyle = post; n.fillRect(W * x, 0, W * 0.017, H * 0.78);
    }
    n.fillStyle = "#07070a";
    n.fillRect(W * 0.2, 0, W * 0.8, H * 0.012);
    const top = H * 0.745;
    surface(n, [[W * 0.1, top], [W * 0.72, top], [W * 0.9, H], [0, H], [0, top + H * 0.05]], top, H, this.wood!, sky, on);
    // The lamp's light across the table, strongest nearest it.
    pool(n, W * 0.16, top + H * 0.08, W * 0.34, H * 0.08, "255,160,84", 0.3 * on);
    const edge = n.createLinearGradient(W * 0.1, 0, W * 0.72, 0);
    edge.addColorStop(0, "rgba(255,170,100,0)"); edge.addColorStop(0.3, `rgba(255,170,100,${0.2 + 0.25 * on})`); edge.addColorStop(1, "rgba(255,170,100,0.04)");
    n.strokeStyle = edge; n.lineWidth = Math.max(1, 1.4 * S);
    n.beginPath(); n.moveTo(W * 0.1, top); n.lineTo(W * 0.72, top); n.stroke();
    mug(n, W * 0.475, H * 0.815, W * 0.07, t, sky, on);
    drawMotes(n, this.motes!, [0, H * 0.1, W * 0.42, H * 0.64], [W * 0.04, H * 0.42, W * 0.3], on, t, dt, S);
    drawFlash(c, this.precip!, sky, dt);
  },
};

/* ── The city window ───────────────────────────────────────────────────── */

type Building = { x: number; w: number; top: number; h: number; c: number; wins: [number, number, number][] };
function skyline(c: Canvases, R: () => number, base: number, lo: number, hi: number, lit: number): Building[] {
  const out: Building[] = [];
  let x = c.FW * 0.14;
  while (x < c.FW * 1.02) {
    const w = c.FW * (0.03 + R() * 0.06), h = c.FH * (lo + R() * (hi - lo)), top = c.FH * base - h;
    const wins: [number, number, number][] = [];
    for (let wy = top + 3; wy < c.FH * (base - 0.02); wy += 3.2) {
      for (let wx = x + 2; wx < x + w - 2; wx += 3) if (R() < lit) wins.push([wx, wy, 0.35 + R() * 0.55]);
    }
    out.push({ x, w, top, h, c: R(), wins });
    x += w + c.FW * R() * 0.008;
  }
  return out;
}

const city: Scene & {
  sky?: Weatherish; precip?: Precip; wood?: HTMLCanvasElement; motes?: Mote[];
  back?: Building[]; blds?: Building[];
  lamps?: { x: number; y: number; r: number; ph: number }[];
} = {
  id: "city",
  name: "City window",
  build(c) {
    const R = rng(7);
    // A far skyline behind the near one: depth is what makes it a city.
    this.back = skyline(c, R, 0.585, 0.14, 0.34, 0.16);
    this.blds = skyline(c, R, 0.59, 0.08, 0.28, 0.34);
    this.lamps = Array.from({ length: 16 }, (_, i) => ({ x: c.FW * (0.22 + i * 0.048 + R() * 0.02), y: c.FH * (0.575 + R() * 0.025), r: c.FW * (0.007 + R() * 0.012), ph: R() * 6 }));
    this.sky = buildSky(c, R);
    this.precip = buildPrecip(c, R, true);
    this.wood = woodTexture(c.W, Math.ceil(c.H * 0.22), c.S, R);
    this.motes = buildMotes(R, 40);
  },
  draw(c, sky, t, dt) {
    const g = c.far, { FW, FH, W, H, S } = c;
    drawSky(c, this.sky!, sky, t, 0.6);
    const horizon = skyColours(sky).horizon;
    const dark = Math.max(0, 1 - sky.light / 0.6);
    const tower = (b: Building, air: number, winA: number) => {
      const tone = mix(mix(mix([13, 19, 31], [20, 26, 40], b.c), mix([96, 110, 128], [128, 140, 156], b.c), sky.light), horizon, air);
      // Lit from the sky above: a little brighter at the roof than the street.
      const fill = g.createLinearGradient(0, b.top, 0, b.top + b.h);
      fill.addColorStop(0, rgb(mix(tone, horizon, 0.12)));
      fill.addColorStop(1, rgb(scale(tone, 0.78)));
      g.fillStyle = fill;
      g.fillRect(b.x, b.top, b.w, b.h + 2);
      if (dark > 0.02) for (const [wx, wy, a] of b.wins) { g.fillStyle = `rgba(255,205,130,${a * winA * (0.25 + 0.75 * dark)})`; g.fillRect(wx, wy, 1.4, 1.6); }
    };
    for (const b of this.back!) tower(b, 0.45, 0.6);
    // A domed building, so the skyline reads as a city rather than as boxes.
    const dx = FW * 0.66, dw = FW * 0.07, dt0 = FH * 0.23;
    g.fillStyle = rgb(mix(mix([22, 31, 51], [110, 124, 142], sky.light), horizon, 0.2));
    g.fillRect(dx - dw / 2, dt0, dw, FH * 0.36);
    g.beginPath(); g.arc(dx, dt0, dw * 0.42, Math.PI, 0); g.fill();
    for (const b of this.blds!) tower(b, 0, 1);
    // Water, and the city upside down in it, broken by ripples.
    const water = Math.round(FH * 0.61);
    const wg = g.createLinearGradient(0, water, 0, FH);
    wg.addColorStop(0, rgb(mix([14, 21, 36], [74, 92, 110], sky.light)));
    wg.addColorStop(1, rgb(mix([6, 10, 18], [40, 52, 64], sky.light)));
    g.fillStyle = wg; g.fillRect(0, water, FW, FH - water);
    /* ⚠️ Drawn from this same canvas, in strips: `drawImage` of a canvas onto
     * itself is defined to copy first, and the rows it reads are all above
     * the waterline, which the strips never touch. */
    const strip = 3, rows = Math.ceil((FH - water) / strip);
    for (let k = 0; k < rows; k++) {
      const jit = Math.sin(t * 1.6 + k * 0.7) * (0.6 + k * 0.05);
      g.globalAlpha = 0.34 * (1 - k / rows);
      g.drawImage(g.canvas, 0, water - (k + 1) * strip, FW, strip, jit, water + k * strip, FW, strip);
    }
    g.globalAlpha = 1;
    drawFog(c, sky, t, [0.5, 0.58]);
    g.save(); g.globalCompositeOperation = "lighter";
    for (const l of this.lamps!) {
      const f = (0.2 + 0.8 * dark) * (0.8 + 0.2 * Math.sin(t * 1.2 + l.ph));
      glow(g, l.x, l.y, l.r * 3.2, "255,190,110", 0.55 * f);
      for (let k = 0; k < 12; k++) {
        const y = water + k * FH * 0.028, jit = Math.sin(t * 2.2 + k * 1.3 + l.ph) * FW * 0.004;
        g.fillStyle = `rgba(255,180,100,${Math.max(0, (0.34 - k * 0.025) * f)})`;
        g.fillRect(l.x - l.r * 0.8 + jit, y, l.r * 1.6, FH * 0.009);
      }
    }
    g.restore();

    const n = c.near;
    const on = lampOn(sky);
    n.clearRect(0, 0, W, H);
    drawPrecip(c, this.precip!, sky, dt);
    const top = H * 0.8;
    const cx = W * 0.2, cy = top - H * 0.012, fl = 0.85 + 0.15 * Math.sin(t * 9) * Math.sin(t * 3.7);
    // The room in the glass at night: the candle and the lamp, ghosted.
    glow(n, cx + W * 0.05, cy - H * 0.2, W * 0.03, "255,190,120", 0.1 * fl * dark);
    glow(n, W * 0.34, H * 0.18, W * 0.07, "255,170,100", 0.06 * on * dark);
    const wall = n.createLinearGradient(0, 0, W * 0.22, 0);
    wall.addColorStop(0, "rgba(16,10,7,0.97)"); wall.addColorStop(0.75, "rgba(16,10,7,0.76)"); wall.addColorStop(1, "rgba(16,10,7,0)");
    n.fillStyle = wall; n.fillRect(0, 0, W * 0.24, H);
    lamp(n, W * 0.06, H * 0.16, W * 0.18, sky, t);
    surface(n, [[0, top], [W, top], [W, H], [0, H]], top, H, this.wood!, sky, on);
    // Light landing on the sill: the candle's own pool, and the lamp's wash.
    pool(n, cx, top + H * 0.035, W * 0.16, H * 0.04, "255,150,64", 0.42 * fl * (0.4 + 0.6 * dark));
    pool(n, W * 0.1, top + H * 0.03, W * 0.3, H * 0.05, "255,170,100", 0.16 * on);
    n.strokeStyle = `rgba(255,175,105,${0.18 + 0.2 * on})`; n.lineWidth = Math.max(1, 1.3 * S);
    n.beginPath(); n.moveTo(0, top); n.lineTo(W, top); n.stroke();
    glow(n, cx, cy - H * 0.07, W * 0.12, "255,150,60", 0.3 * fl * (0.4 + 0.6 * dark));
    candle(n, cx, cy + H * 0.012, W * 0.032, t, fl);
    mug(n, W * 0.31, top + H * 0.01, W * 0.075, t, sky, Math.max(on, 0.6 * dark));
    drawMotes(n, this.motes!, [0, H * 0.02, W * 0.4, H * 0.76], [W * 0.1, H * 0.25, W * 0.3], on, t, dt, S);
    drawFlash(c, this.precip!, sky, dt);
  },
};

/* ── The cover's own colours ───────────────────────────────────────────── */

const BLOBS = [
  { px: 0.22, py: 0.3, ax: 0.18, ay: 0.14, sx: 0.031, sy: 0.023, r: 0.62 },
  { px: 0.76, py: 0.28, ax: 0.16, ay: 0.18, sx: 0.019, sy: 0.029, r: 0.58 },
  { px: 0.55, py: 0.72, ax: 0.22, ay: 0.12, sx: 0.026, sy: 0.017, r: 0.66 },
  { px: 0.18, py: 0.8, ax: 0.14, ay: 0.16, sx: 0.021, sy: 0.033, r: 0.5 },
  { px: 0.86, py: 0.78, ax: 0.12, ay: 0.14, sx: 0.035, sy: 0.02, r: 0.46 },
];

const artwork: Scene = {
  id: "artwork",
  name: "Colour wash",
  build() {},
  draw(c, _sky, t, _dt, extras) {
    const g = c.far, { FW, FH } = c;
    const p = extras.palette.length ? extras.palette : [[20, 24, 40], [60, 70, 110], [140, 100, 120], [50, 40, 70], [90, 80, 120]];
    g.fillStyle = rgb(p[0].map(v => Math.round(v * 0.55)));
    g.fillRect(0, 0, FW, FH);
    BLOBS.forEach((b, i) => {
      const col = p[(i + 1) % p.length];
      const x = (b.px + Math.sin(t * b.sx * 6.283) * b.ax) * FW;
      const y = (b.py + Math.cos(t * b.sy * 6.283) * b.ay) * FH;
      const r = b.r * FW;
      const grad = g.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, rgb(col, 0.9));
      grad.addColorStop(1, rgb(col, 0));
      g.fillStyle = grad;
      g.fillRect(0, 0, FW, FH);
    });
    c.near.clearRect(0, 0, c.W, c.H);
  },
};

export const SCENES: Record<string, Scene> = { city, cabin, artwork };
export const SCENE_ORDER = ["city", "cabin", "artwork"];

/** Five colours out of a cover, for the wash.
 *
 * ⚠️ Sampled from a tiny copy and ranked by how much of the cover a colour
 * covers AND how saturated it is. By count alone, the wash of a cover with a
 * white border is mostly white; by saturation alone, a speck of red in one
 * corner becomes the whole screen. */
export function paletteOf(img: HTMLImageElement): number[][] {
  const size = 24;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const g = canvas.getContext("2d", { willReadFrequently: true });
  if (!g) return [];
  try {
    g.drawImage(img, 0, 0, size, size);
    const data = g.getImageData(0, 0, size, size).data;
    const buckets = new Map<string, { c: number[]; n: number; sat: number }>();
    for (let i = 0; i < data.length; i += 4) {
      const c = [data[i], data[i + 1], data[i + 2]];
      const key = c.map(v => v >> 5).join(",");
      const max = Math.max(...c), min = Math.min(...c);
      const sat = max ? (max - min) / max : 0;
      const b = buckets.get(key);
      if (b) { b.n++; b.c = b.c.map((v, j) => v + (c[j] - v) / b.n); } else buckets.set(key, { c, n: 1, sat });
    }
    return [...buckets.values()]
      .sort((a, b) => b.n * (0.4 + b.sat) - a.n * (0.4 + a.sat))
      .slice(0, 5)
      .map(b => b.c.map(v => Math.round(v)));
  } catch {
    return [];
  }
}
