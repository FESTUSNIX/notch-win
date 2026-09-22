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
 * the things in focus.
 *
 * ⚠️ Every scene redraws everything every frame. Nothing here is expensive
 * enough to cache per layer, and a cache is one more place for the weather
 * changing to be missed.
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

function glow(g: CanvasRenderingContext2D, x: number, y: number, r: number, c: string, a: number) {
  if (a <= 0.003 || r <= 0) return;
  const grad = g.createRadialGradient(x, y, 0, x, y, r);
  grad.addColorStop(0, `rgba(${c},${a})`);
  grad.addColorStop(1, `rgba(${c},0)`);
  g.fillStyle = grad;
  g.fillRect(x - r, y - r, r * 2, r * 2);
}

/* ── Through the glass ─────────────────────────────────────────────────── */

interface Weatherish {
  stars: { x: number; y: number; a: number; ph: number }[];
  clouds: { x: number; y: number; w: number; h: number; v: number; a: number }[];
}

function buildSky(c: Canvases, R: () => number): Weatherish {
  return {
    stars: Array.from({ length: 80 }, () => ({ x: R() * c.FW, y: R() * c.FH * 0.4, a: 0.2 + R() * 0.7, ph: R() * 6 })),
    clouds: Array.from({ length: 14 }, () => ({
      x: R() * c.FW, y: c.FH * (0.08 + R() * 0.36), w: c.FW * (0.18 + R() * 0.34),
      h: c.FH * (0.02 + R() * 0.04), v: c.FW * (0.0025 + R() * 0.005), a: 0.4 + R() * 0.6,
    })),
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
    glow(g, x, y, FH * 0.36, `${mix([255, 240, 210], [255, 150, 90], warm)}`, 0.28 * veil + 0.06);
    glow(g, x, y, FH * 0.07, `${core}`, 0.95 * veil);
  } else if (veil > 0.05) {
    const r = FH * 0.032;
    glow(g, x, y, r * 6, "226,232,255", 0.14 * veil);
    g.save();
    g.globalAlpha = 0.92 * veil;
    /* ⚠️ CLIPPED to the moon's own disc before the shadow is laid on. The
     * first version filled two overlapping discs even-odd, which for a
     * gibbous moon also painted the part of the shadow disc hanging OUTSIDE
     * the moon — a sliver of moonlight floating in the sky beside it. */
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.clip();
    g.fillStyle = "#f3ecd8";
    g.fillRect(x - r, y - r, r * 2, r * 2);
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

  // Clouds, lit by whatever light there is.
  const lit = mix([40, 44, 62], [238, 240, 246], sky.light);
  const underside = mix(lit, [236, 140, 110], sky.warmth * 0.7);
  const count = Math.round(s.clouds.length * (0.2 + sky.cloud * 0.8));
  for (let i = 0; i < count; i++) {
    const cl = s.clouds[i];
    const cx = ((cl.x + t * cl.v) % (FW + cl.w)) - cl.w / 2;
    const h = cl.h * (1 + sky.cloud * 1.6);
    g.save();
    g.translate(cx, cl.y);
    g.scale(1, h / (cl.w / 2));
    const grad2 = g.createRadialGradient(0, 0, 0, 0, 0, cl.w / 2);
    const a = cl.a * (0.18 + sky.cloud * 0.5);
    grad2.addColorStop(0, rgb(i % 3 ? lit : underside, a));
    grad2.addColorStop(1, rgb(lit, 0));
    g.fillStyle = grad2;
    g.beginPath();
    g.arc(0, 0, cl.w / 2, 0, Math.PI * 2);
    g.fill();
    g.restore();
  }
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

/* ── On the glass, and in the room ─────────────────────────────────────── */

interface Precip {
  streaks: { x: number; y: number; l: number; v: number }[];
  flakes: { x: number; y: number; r: number; v: number; ph: number }[];
  drops: HTMLCanvasElement;
  sliders: { x: number; y: number; r: number; v: number; hold: number; trail: [number, number][] }[];
  flash: number;
  nextFlash: number;
}

function buildPrecip(c: Canvases, R: () => number, glass: boolean): Precip {
  const { W, H, S } = c;
  const drops = document.createElement("canvas");
  drops.width = W;
  drops.height = H;
  if (glass) {
    const d = drops.getContext("2d")!;
    for (let i = 0; i < 280; i++) {
      const px = R() * W, py = R() * H * 0.8, r = (0.6 + R() * 2.3) * S;
      d.fillStyle = "rgba(210,225,245,0.07)";
      d.beginPath(); d.arc(px, py, r, 0, Math.PI * 2); d.fill();
      d.strokeStyle = "rgba(255,255,255,0.16)"; d.lineWidth = 0.7 * S; d.stroke();
      d.fillStyle = "rgba(255,255,255,0.45)";
      d.beginPath(); d.arc(px - r * 0.35, py - r * 0.35, r * 0.28, 0, Math.PI * 2); d.fill();
    }
  }
  return {
    streaks: Array.from({ length: 140 }, () => ({ x: R() * W, y: R() * H, l: (12 + R() * 26) * S, v: (600 + R() * 500) * S })),
    flakes: Array.from({ length: 160 }, () => ({ x: R() * W, y: R() * H, r: (0.8 + R() * 2.2) * S, v: (26 + R() * 50) * S, ph: R() * 6 })),
    drops,
    sliders: glass
      ? Array.from({ length: 16 }, () => ({ x: R() * W, y: -R() * H * 0.5, r: (2 + R() * 2.6) * S, v: 0, hold: R() * 2, trail: [] }))
      : [],
    flash: 0,
    nextFlash: 6 + R() * 10,
  };
}

function drawPrecip(c: Canvases, p: Precip, sky: Sky, dt: number) {
  const g = c.near, { W, H, S } = c;
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
  // Water on the glass, in proportion to the rain.
  if (p.sliders.length && sky.rain > 0.05) {
    g.globalAlpha = Math.min(1, sky.rain * 1.3);
    g.drawImage(p.drops, 0, 0);
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
        g.strokeStyle = "rgba(220,232,250,0.10)"; g.lineWidth = d.r * 0.55; g.lineCap = "round";
        g.beginPath(); d.trail.forEach(([x, y], k) => (k ? g.lineTo(x, y) : g.moveTo(x, y))); g.stroke();
      }
      g.fillStyle = "rgba(210,225,245,0.18)";
      g.beginPath(); g.ellipse(d.x, d.y, d.r * 0.85, d.r, 0, 0, Math.PI * 2); g.fill();
      g.strokeStyle = "rgba(255,255,255,0.28)"; g.lineWidth = 0.8 * S; g.stroke();
      g.fillStyle = "rgba(255,255,255,0.6)";
      g.beginPath(); g.arc(d.x - d.r * 0.3, d.y - d.r * 0.4, d.r * 0.25, 0, Math.PI * 2); g.fill();
    }
    g.globalAlpha = 1;
  }
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

function mug(g: CanvasRenderingContext2D, x: number, y: number, w: number, t: number, light: number) {
  const h = w * 0.92;
  g.fillStyle = "rgba(0,0,0,0.5)";
  g.beginPath(); g.ellipse(x + w * 0.1, y + w * 0.02, w * 0.8, w * 0.1, 0, 0, Math.PI * 2); g.fill();
  g.strokeStyle = "#0b0807"; g.lineWidth = w * 0.1;
  g.beginPath(); g.arc(x + w * 0.5, y - h * 0.52, w * 0.2, -1.25, 1.25); g.stroke();
  const body = g.createLinearGradient(x - w / 2, 0, x + w / 2, 0);
  const rim = mix([42, 28, 22], [80, 70, 64], light);
  body.addColorStop(0, rgb(rim)); body.addColorStop(0.3, "#120d0b"); body.addColorStop(1, "#060505");
  g.fillStyle = body;
  g.beginPath();
  if (g.roundRect) g.roundRect(x - w / 2, y - h, w, h, [w * 0.03, w * 0.03, w * 0.16, w * 0.16]);
  else g.rect(x - w / 2, y - h, w, h);
  g.fill();
  g.fillStyle = "#040303";
  g.beginPath(); g.ellipse(x, y - h, w / 2, w * 0.085, 0, 0, Math.PI * 2); g.fill();
  g.strokeStyle = "rgba(255,190,140,0.18)"; g.lineWidth = Math.max(1, w * 0.018); g.stroke();
  // Steam — the one thing in the room that always moves.
  g.save();
  g.globalCompositeOperation = "lighter";
  g.lineCap = "round";
  for (let k = 0; k < 3; k++) {
    const top = y - h;
    const grad = g.createLinearGradient(0, top, 0, top - w * 1.9);
    grad.addColorStop(0, "rgba(255,255,255,0.10)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    g.strokeStyle = grad; g.lineWidth = w * 0.13;
    g.shadowColor = "rgba(255,255,255,0.35)"; g.shadowBlur = w * 0.25;
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

/** The room's own light. ⚠️ The lamp is ON after dark and all but off at
 *  noon — a lamp glowing at full strength in a sunlit room is the scene
 *  ignoring its own sky. */
function lamp(g: CanvasRenderingContext2D, x: number, y: number, r: number, sky: Sky, t: number) {
  const on = 0.25 + 0.75 * (1 - sky.light);
  glow(g, x, y, r, "255,160,82", 0.38 * on + 0.02 * Math.sin(t * 3.1));
  glow(g, x, y, r * 0.22, "255,214,160", 0.6 * on);
}

/* ── The cabin ─────────────────────────────────────────────────────────── */

const cabin: Scene & {
  sky?: Weatherish; precip?: Precip;
  ridges?: { pts: [number, number][]; night: number[]; day: number[] }[];
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
    this.ridges = [
      { pts: ridge(0.5, 0.12, 1.3), night: [88, 70, 98], day: [150, 170, 190] },
      { pts: ridge(0.55, 0.12, 1.8), night: [58, 46, 72], day: [100, 128, 138] },
      { pts: ridge(0.62, 0.1, 2.4), night: [33, 28, 46], day: [58, 88, 78] },
      { pts: ridge(0.7, 0.08, 3.1), night: [16, 15, 25], day: [34, 56, 44] },
    ];
    this.lights = [];
    for (let i = 0; i < 46; i++) {
      const r = this.ridges[2 + (i % 2)];
      const [lx, ly] = r.pts[Math.floor(R() * r.pts.length)];
      this.lights.push({ x: lx, y: ly + c.FH * (0.01 + R() * 0.06), r: 0.4 + R() * 0.9, ph: R() * 6, a: 0.5 + R() * 0.5 });
    }
    this.sky = buildSky(c, R);
    this.precip = buildPrecip(c, R, false);
  },
  draw(c, sky, t, dt) {
    const g = c.far, { FW, FH, W, H, S } = c;
    drawSky(c, this.sky!, sky, t, 0.52);
    for (const r of this.ridges!) {
      g.fillStyle = rgb(mix(mix(r.night, r.day, sky.light), [60, 64, 80], sky.cloud * 0.3));
      g.beginPath(); g.moveTo(0, FH);
      for (const [x, y] of r.pts) g.lineTo(x, y);
      g.lineTo(FW, FH); g.fill();
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
    n.clearRect(0, 0, W, H);
    drawPrecip(c, this.precip!, sky, dt);
    const wall = n.createLinearGradient(0, 0, W * 0.24, 0);
    wall.addColorStop(0, "rgba(10,7,6,0.96)"); wall.addColorStop(0.8, "rgba(10,7,6,0.7)"); wall.addColorStop(1, "rgba(10,7,6,0)");
    n.fillStyle = wall; n.fillRect(0, 0, W * 0.26, H);
    lamp(n, 0, H * 0.42, W * 0.22, sky, t);
    n.fillStyle = "#07070a";
    for (const x of [0.445, 0.735]) n.fillRect(W * x, 0, W * 0.017, H * 0.78);
    n.fillRect(W * 0.2, 0, W * 0.8, H * 0.012);
    const top = H * 0.745;
    const table = n.createLinearGradient(0, top, 0, H);
    table.addColorStop(0, rgb(mix([35, 23, 15], [70, 52, 38], sky.light)));
    table.addColorStop(0.12, "#120c08"); table.addColorStop(1, "#050303");
    n.fillStyle = table;
    n.beginPath(); n.moveTo(W * 0.1, top); n.lineTo(W * 0.72, top); n.lineTo(W * 0.9, H); n.lineTo(0, H); n.lineTo(0, top + H * 0.05); n.closePath(); n.fill();
    const edge = n.createLinearGradient(W * 0.1, 0, W * 0.72, 0);
    edge.addColorStop(0, "rgba(255,170,100,0)"); edge.addColorStop(0.35, "rgba(255,170,100,0.3)"); edge.addColorStop(1, "rgba(255,170,100,0.04)");
    n.strokeStyle = edge; n.lineWidth = Math.max(1, 1.4 * S);
    n.beginPath(); n.moveTo(W * 0.1, top); n.lineTo(W * 0.72, top); n.stroke();
    mug(n, W * 0.475, H * 0.815, W * 0.07, t, sky.light);
    drawFlash(c, this.precip!, sky, dt);
  },
};

/* ── The city window ───────────────────────────────────────────────────── */

const city: Scene & {
  sky?: Weatherish; precip?: Precip;
  blds?: { x: number; w: number; top: number; h: number; c: number; wins: [number, number, number][] }[];
  lamps?: { x: number; y: number; r: number; ph: number }[];
} = {
  id: "city",
  name: "City window",
  build(c) {
    const R = rng(7);
    this.blds = [];
    let x = c.FW * 0.16;
    while (x < c.FW * 1.02) {
      const w = c.FW * (0.03 + R() * 0.06), h = c.FH * (0.1 + R() * 0.3), top = c.FH * 0.59 - h;
      const wins: [number, number, number][] = [];
      for (let wy = top + 3; wy < c.FH * 0.57; wy += 3.2) {
        for (let wx = x + 2; wx < x + w - 2; wx += 3) if (R() < 0.34) wins.push([wx, wy, 0.35 + R() * 0.55]);
      }
      this.blds.push({ x, w, top, h, c: R(), wins });
      x += w + c.FW * R() * 0.008;
    }
    this.lamps = Array.from({ length: 16 }, (_, i) => ({ x: c.FW * (0.22 + i * 0.048 + R() * 0.02), y: c.FH * (0.575 + R() * 0.025), r: c.FW * (0.007 + R() * 0.012), ph: R() * 6 }));
    this.sky = buildSky(c, R);
    this.precip = buildPrecip(c, R, true);
  },
  draw(c, sky, t, dt) {
    const g = c.far, { FW, FH, W, H, S } = c;
    drawSky(c, this.sky!, sky, t, 0.6);
    const dark = Math.max(0, 1 - sky.light / 0.6);
    for (const b of this.blds!) {
      const tone = mix(mix([13, 19, 31], [20, 26, 40], b.c), mix([96, 110, 128], [128, 140, 156], b.c), sky.light);
      g.fillStyle = rgb(tone);
      g.fillRect(b.x, b.top, b.w, b.h + 2);
      if (dark > 0.02) for (const [wx, wy, a] of b.wins) { g.fillStyle = `rgba(255,205,130,${a * (0.25 + 0.75 * dark)})`; g.fillRect(wx, wy, 1.4, 1.6); }
    }
    // A domed building, so the skyline reads as a city rather than as boxes.
    const dx = FW * 0.66, dw = FW * 0.07, dt0 = FH * 0.23;
    g.fillStyle = rgb(mix([22, 31, 51], [110, 124, 142], sky.light));
    g.fillRect(dx - dw / 2, dt0, dw, FH * 0.36);
    g.beginPath(); g.arc(dx, dt0, dw * 0.42, Math.PI, 0); g.fill();
    // Water.
    const water = FH * 0.61;
    const wg = g.createLinearGradient(0, water, 0, FH);
    wg.addColorStop(0, rgb(mix([14, 21, 36], [74, 92, 110], sky.light)));
    wg.addColorStop(1, rgb(mix([6, 10, 18], [40, 52, 64], sky.light)));
    g.fillStyle = wg; g.fillRect(0, water, FW, FH - water);
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
    n.clearRect(0, 0, W, H);
    drawPrecip(c, this.precip!, sky, dt);
    const wall = n.createLinearGradient(0, 0, W * 0.22, 0);
    wall.addColorStop(0, "rgba(12,8,6,0.97)"); wall.addColorStop(0.75, "rgba(12,8,6,0.75)"); wall.addColorStop(1, "rgba(12,8,6,0)");
    n.fillStyle = wall; n.fillRect(0, 0, W * 0.24, H);
    lamp(n, W * 0.06, H * 0.16, W * 0.16, sky, t);
    const top = H * 0.8;
    const sill = n.createLinearGradient(0, top, 0, H);
    sill.addColorStop(0, rgb(mix([42, 26, 16], [80, 60, 44], sky.light)));
    sill.addColorStop(0.1, "#130c08"); sill.addColorStop(1, "#050303");
    n.fillStyle = sill; n.fillRect(0, top, W, H - top);
    n.strokeStyle = "rgba(255,175,105,0.28)"; n.lineWidth = Math.max(1, 1.3 * S);
    n.beginPath(); n.moveTo(0, top); n.lineTo(W, top); n.stroke();
    const cx = W * 0.2, cy = top - H * 0.012, fl = 0.85 + 0.15 * Math.sin(t * 9) * Math.sin(t * 3.7);
    glow(n, cx, cy - H * 0.05, W * 0.1, "255,160,70", 0.4 * fl * (0.4 + 0.6 * dark));
    n.fillStyle = "rgba(255,235,200,0.12)"; n.fillRect(cx - W * 0.018, cy - H * 0.06, W * 0.036, H * 0.06);
    glow(n, cx, cy - H * 0.065, W * 0.012, "255,225,150", 0.95 * fl);
    mug(n, W * 0.31, top + H * 0.01, W * 0.075, t, sky.light);
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
