/* The lens: what a camera does to a room, laid over whichever room is showing.
 *
 * Four passes, and each is the difference between "an illustration of a
 * window" and "a photograph of one":
 *
 *   bloom    bright things bleed light into what is round them — a lamp, a lit
 *            window, the moon. A quarter-size copy of the frame, thresholded,
 *            blurred by CSS and SCREENED over the top.
 *   grain    film grain, moving. It is also what kills the banding a smooth
 *            8-bit gradient shows on a dark sky, which reads as "rendered".
 *   grade    warm where the room's light falls, cool out in the night, in
 *            proportion to how dark it is. `soft-light`, so it tints without
 *            greying.
 *   vignette the corners fall off, as they do through any real lens.
 *
 * ⚠️ The bloom's threshold is a CUBE, made by multiplying the frame by itself.
 * 2D canvas has no threshold filter, and `x³` is the cheap stand-in: a lamp at
 * 1.0 stays 1.0, a wall at 0.3 becomes 0.03 — so only the bright things glow.
 * It also warms the glow (a colour's weaker channels fall away faster), which
 * is what film halation looks like anyway.
 *
 * ⚠️ Drawn every OTHER frame. Bloom is a blur of the whole scene; a glow a
 * frame behind the light it comes from is not something anyone can see, and
 * it halves the one full-frame copy this adds.
 */
import type { Sky } from "./ambient-sky.ts";

export class Lens {
  private g: CanvasRenderingContext2D;
  private tmp = document.createElement("canvas");
  private t: CanvasRenderingContext2D;
  private odd = false;
  private grainAt = 0;

  constructor(private bloom: HTMLCanvasElement, private grain: HTMLElement, private host: HTMLElement) {
    this.g = bloom.getContext("2d")!;
    this.t = this.tmp.getContext("2d")!;
    grain.style.backgroundImage = `url(${grainTile()})`;
  }

  /** Match the frame's size, at a quarter — it is about to be blurred anyway. */
  size(W: number, H: number) {
    this.bloom.width = this.tmp.width = Math.max(64, Math.round(W / 4));
    this.bloom.height = this.tmp.height = Math.max(36, Math.round(H / 4));
  }

  /** How much of each pass, from how dark it is. Once a second is plenty. */
  mood(sky: Sky, own: boolean) {
    const dark = 1 - sky.light;
    const s = this.host.style;
    /* ⚠️ Less bloom by day. Everything in a daylit frame is bright, and a
     * bloom tuned for a lamp at night turns noon into a haze. */
    s.setProperty("--bloom", (own ? 0.22 : 0.3 + 0.38 * dark).toFixed(3));
    s.setProperty("--grade-warm", (0.12 + 0.3 * dark * (1 - sky.cloud * 0.4)).toFixed(3));
    s.setProperty("--grade-cool", (0.06 + 0.22 * dark).toFixed(3));
    // Grain shows more in the dark, as it does on a real sensor.
    s.setProperty("--grain", (0.05 + 0.05 * dark).toFixed(3));
  }

  /** One frame. `sources` are drawn in order — the scene's layers, or your own video. */
  frame(sources: CanvasImageSource[], now: number, moving: boolean) {
    if (moving && now - this.grainAt > 42) {
      // 24 frames a second, like film. Faster reads as TV static.
      this.grainAt = now;
      this.grain.style.backgroundPosition = `${Math.floor(Math.random() * 200)}px ${Math.floor(Math.random() * 200)}px`;
    }
    this.odd = !this.odd;
    if (moving && this.odd) return;
    const { g, t } = this, w = this.bloom.width, h = this.bloom.height;
    g.globalCompositeOperation = "source-over";
    g.clearRect(0, 0, w, h);
    g.fillStyle = "#000";
    g.fillRect(0, 0, w, h);
    for (const s of sources) {
      try { g.drawImage(s, 0, 0, w, h); } catch { /* a video between frames */ }
    }
    // x → x² → x³: keep what is bright, drop what is not.
    t.clearRect(0, 0, w, h);
    t.drawImage(this.bloom, 0, 0);
    g.globalCompositeOperation = "multiply";
    g.drawImage(this.tmp, 0, 0);
    g.drawImage(this.tmp, 0, 0);
    g.globalCompositeOperation = "source-over";
  }
}

/** A tile of monochrome grain, made once. Specks of both black and white at
 *  low alpha, so it shows on a dark sky and a lit wall alike — `overlay` would
 *  vanish in exactly the shadows where grain is most visible. */
function grainTile(): string {
  const n = 200;
  const c = document.createElement("canvas");
  c.width = c.height = n;
  const g = c.getContext("2d")!;
  const img = g.createImageData(n, n);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = Math.random();
    const light = Math.random() < 0.5;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = light ? 255 : 0;
    // Mostly faint, now and then a stronger speck — grain is not uniform.
    img.data[i + 3] = Math.round(255 * (v < 0.92 ? v * 0.35 : 0.5 + v * 0.3));
  }
  g.putImageData(img, 0, 0);
  return c.toDataURL();
}
