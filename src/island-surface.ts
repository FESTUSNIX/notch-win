/* The island: one rectangle that grows.
 *
 * Replaces the pill-plus-detached-card surface. There, a folded pill was an SVG
 * notch path and the panel was a separate box floating at a gap from it, which
 * meant two shapes to keep in step, two rects to report as interactive, and a
 * fold that read as a card appearing beside a pill rather than as one thing
 * opening. Here there is a single element whose width, height and corner radius
 * are driven by one spring, with the two content layers cross-fading inside it
 * while `overflow: hidden` clips them. That is the whole trick.
 *
 * ⚠️ Both layers are laid out at a FIXED size — the collapsed layer at the pill's
 * size, the expanded layer at the panel's. They are clipped during the morph,
 * never reflowed by it. Sizing a layer to the animating container instead
 * re-wraps every line of text on every frame: expensive, and it looks like the
 * text is being squeezed rather than revealed.
 */
import { listen } from "@tauri-apps/api/event";
import { FRAME, cpx, isVertical, notchPath, notchTransform, type Edge } from "./layout";
import { Spring } from "./motion";
import { call, native } from "./task-client";

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const box = (el: HTMLElement) => {
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
};

export class IslandSurface {
  edge: Edge = "top";
  open = false;
  pinned = false;
  editing = false;
  private hovering = false;
  /** Slid out of the way — by the shortcut, or because something is fullscreen. */
  private hidden = false;
  /** Hidden, but the pointer is on the reveal strip, so it is showing anyway. */
  private peeking = false;
  private suppressed = false;
  private timer = 0;
  private frame = 0;
  private last = 0;
  private fold = new Spring(0, 0.42, 0.78);
  /* ⚠️ The panel's own size is sprung as well as its opening. `depth` and
   * `body` are recomputed whenever the screen changes, and writing them
   * straight into the geometry made the island SNAP to the new screen's height
   * while its contents were still fading in — the one motion on the surface
   * that had no easing at all.
   *
   * ⚠️ Damped harder than the fold (0.9 vs 0.78). The fold is a panel arriving
   * and can afford a little overshoot; this is a panel already on screen
   * changing size under your cursor, and overshoot there reads as a wobble. */
  private grow = new Spring(cpx(FRAME.islandMinDepth), 0.34, 0.9);
  private widen = new Spring(cpx(FRAME.islandBodyLong), 0.34, 0.9);
  private reduced = matchMedia("(prefers-reduced-motion: reduce)");
  private shell = document.getElementById("notch-shell")!;
  private island = document.getElementById("island")!;
  private collapsed = document.getElementById("island-collapsed")!;
  private expanded = document.getElementById("island-expanded")!;
  /** The straight body the content sits in; the flare is added on top. */
  private body = cpx(FRAME.islandBodyLong);
  /** A narrower body something has asked for, or 0 for the full one. */
  private cap = 0;
  private depth = cpx(FRAME.islandMinDepth);
  private clip = document.getElementById("island-clip-path") as unknown as SVGPathElement;
  private masks: { x: number; y: number; width: number; height: number }[] = [];

  constructor(private onFold?: (open: boolean) => void) {
    document.documentElement.style.setProperty("--task-indent", `${cpx(FRAME.taskIndent)}px`);
    document.documentElement.style.setProperty("--row-height", `${cpx(FRAME.taskRowHeight)}px`);
    window.addEventListener("resize", () => this.measure());
    this.reduced.addEventListener("change", () => {
      this.fold.snap(this.open ? 1 : 0);
      this.grow.snap(this.depth);
      this.widen.snap(this.body);
      this.paint();
    });
  }

  async boot() {
    if (native) {
      await listen<{ hover: boolean }>("tasks:hover", e => this.hover(e.payload.hover));
      await listen<{ edge: Edge }>("tasks:placement", e => { void this.place(e.payload.edge); });
      await listen("island:toggle", () => this.toggle());
      await listen<boolean>("chrome:hidden", e => this.setHidden(e.payload));
    } else {
      document.body.classList.add("preview");
      document.addEventListener("pointermove", e =>
        this.hover(this.masks.some(r =>
          e.clientX >= r.x && e.clientX < r.x + r.width && e.clientY >= r.y && e.clientY < r.y + r.height)));
      document.documentElement.addEventListener("pointerleave", () => this.hover(false));
    }
    await this.place((await call<{ edge: Edge }>("get_task_placement")).edge);
  }

  /** Every dimension at fold position `t`, in CSS pixels.
   *
   * `body` is the straight part the content lives in; `length` is that plus a
   * flare at each end, which is what the element actually measures along its
   * edge. The same relationship `shapeLength()` describes for the usage notch. */
  private geometry(t: number) {
    const curl = lerp(cpx(FRAME.islandPillThin) / 2, cpx(FRAME.islandCurl), t);
    const body = lerp(cpx(FRAME.islandPillLong), this.widen.value, t);
    const depth = lerp(cpx(FRAME.islandPillThin), this.grow.value, t);
    const length = body + 2 * curl;
    const vertical = isVertical(this.edge);
    return {
      curl, body, depth, length,
      width: vertical ? depth : length,
      height: vertical ? length : depth,
    };
  }

  /** What the window has to be to hold the island at full size. */
  private windowSize() {
    const length = this.body + 2 * cpx(FRAME.islandCurl);
    const depth = cpx(FRAME.islandBodyDepth);
    return isVertical(this.edge)
      ? { width: depth, height: length }
      : { width: length, height: depth };
  }

  async place(edge: Edge) {
    this.edge = edge;
    this.shell.dataset.edge = edge;
    this.island.dataset.edge = edge;
    document.querySelectorAll<HTMLElement>("[data-task-edge]")
      .forEach(b => b.setAttribute("aria-pressed", String(b.dataset.taskEdge === edge)));

    const size = this.windowSize();
    this.shell.style.width = `${size.width}px`;
    this.shell.style.height = `${size.height}px`;
    if (native) {
      await call("set_notch_size", size);
      this.shell.style.height = `${window.innerHeight}px`;
    }
    this.measure();
  }

  /** Fit the expanded box to what the active screen actually needs. */
  measure() {
    if (native) this.shell.style.height = `${window.innerHeight}px`;
    const chrome = [...this.expanded.children]
      .filter(el => !el.classList.contains("screens"))
      .reduce((n, el) => n + (el as HTMLElement).offsetHeight, 0);
    /* A screen is a flex column whose scrolling part must contribute what it
     * *wants*, not what it currently gets. ⚠️ Not `scrollHeight`: a flex:1
     * scroller whose content is shorter than its box reports the box, so the
     * measurement feeds the panel's own height back into itself and a one-task
     * day stays as tall as a full one. Its children's natural heights do not. */
    const natural = (el: HTMLElement) => {
      const kids = [...el.children] as HTMLElement[];
      /* ⚠️ `spans` is for a GRID, and neither the sum of its children nor the
       * tallest one is its height. Summing asks for three stacked columns'
       * worth of panel; the tallest clips a second row; and grouping by row
       * over-counts the moment a tile spans two of them — which is what a bento
       * is made of. The union of the boxes is the only answer that survives all
       * three, measured in viewport space so an absolutely positioned sheet
       * counts too: opening a device list should GROW the island rather than be
       * clipped by it. */
      if (el.classList.contains("spans")) {
        const style = getComputedStyle(el);
        const base = el.getBoundingClientRect();
        const boxes = [...kids, ...el.querySelectorAll<HTMLElement>(".sheet")]
          .map(child => child.getBoundingClientRect())
          .filter(box => box.height > 0);
        if (!boxes.length) return parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
        const bottom = Math.max(...boxes.map(box => box.bottom));
        // `bottom - base.top` already carries the top padding.
        return bottom - base.top + parseFloat(style.paddingBottom);
      }
      if (el.classList.contains("scrolls")) return kids.reduce((n, c) => n + c.offsetHeight, 0);
      return el.offsetHeight;
    };
    this.body = this.cap && !isVertical(this.edge)
      ? Math.min(cpx(FRAME.islandBodyLong), this.cap)
      : cpx(FRAME.islandBodyLong);
    const screen = this.expanded.querySelector<HTMLElement>(".screen.active");
    const content = screen ? [...screen.children].reduce((n, el) => n + natural(el as HTMLElement), 0) : 0;
    const available = isVertical(this.edge) ? this.shell.clientWidth : this.shell.clientHeight;
    this.depth = Math.min(
      available,
      cpx(FRAME.islandBodyDepth),
      Math.max(cpx(FRAME.islandMinDepth), chrome + content + cpx(FRAME.cardPadding)),
    );
    // Layers are sized to the BODY, never the element: the flare at each end is
    // shape, not room, and content laid into it would be clipped by the curve.
    const vertical = isVertical(this.edge);
    this.expanded.style.width = `${vertical ? this.depth : this.body}px`;
    this.expanded.style.height = `${vertical ? this.body : this.depth}px`;
    /* ⚠️ Snapped while closed, sprung while open. A size change the island is
     * not showing must not animate: the spring would spend its travel behind a
     * collapsed pill and the panel would then open at whatever size it had got
     * to, which is a different wrong size every time. */
    if (this.open && !this.reduced.matches) {
      this.grow.setTarget(this.depth);
      this.widen.setTarget(this.body);
      if (!this.frame) { this.last = 0; this.frame = requestAnimationFrame(t => this.tick(t)); }
    } else {
      this.grow.snap(this.depth);
      this.widen.snap(this.body);
    }
    this.collapsed.style.width = `${vertical ? cpx(FRAME.islandPillThin) : cpx(FRAME.islandPillLong)}px`;
    this.collapsed.style.height = `${vertical ? cpx(FRAME.islandPillLong) : cpx(FRAME.islandPillThin)}px`;
    this.paint();
  }

  /** Slid away, or back. */
  setHidden(hidden: boolean) {
    this.hidden = hidden;
    this.peeking = false;
    if (hidden) this.show(false);
    this.applyHidden();
  }

  private applyHidden() {
    document.documentElement.classList.toggle("chrome-hidden", this.hidden && !this.peeking);
    this.report();
  }

  hover(value: boolean) {
    this.hovering = value;
    /* While hidden the pointer is on the reveal strip, so hovering means "come
     * back for a moment" rather than "open". Leaving slides it away again — the
     * same bargain an auto-hiding taskbar makes. */
    if (this.hidden) {
      this.peeking = value;
      this.applyHidden();
      if (!value) this.show(false);
      return;
    }
    clearTimeout(this.timer);
    if (!value) {
      this.suppressed = false;
      this.timer = window.setTimeout(() => this.show(false), 450);
    } else if (!this.suppressed) {
      this.show(true);
    }
  }

  toggle() {
    if (this.open) void this.collapse();
    else { this.suppressed = false; this.show(true); }
  }

  show(value: boolean) {
    if (!value && (this.pinned || this.editing)) return;
    if (this.open === value) return;
    this.open = value;
    this.expanded.inert = !value;
    this.shell.classList.toggle("is-open", value);
    this.island.setAttribute("aria-expanded", String(value));
    this.onFold?.(value);
    this.fold.setTarget(value ? 1 : 0);
    if (this.reduced.matches) {
      this.fold.snap(value ? 1 : 0);
      this.paint();
      return;
    }
    if (!this.frame) { this.last = 0; this.frame = requestAnimationFrame(t => this.tick(t)); }
    this.report();
  }

  /** Hold the island open for a moment without latching the pin.
   *
   * The capture shortcut fires with the pointer nowhere near the island, so the
   * ordinary hover timer would fold it away mid-keystroke. Typing extends it —
   * `input(true)` sets `editing`, which blocks folding entirely — so this only
   * has to cover the gap before the first key lands. */
  pinFor(ms: number) {
    this.suppressed = false;
    this.show(true);
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.show(false), ms);
  }

  pin() {
    this.pinned = !this.pinned;
    document.getElementById("pin")!.setAttribute("aria-pressed", String(this.pinned));
    if (this.pinned) this.show(true);
    else if (!this.hovering) this.show(false);
  }

  /** Narrow the panel while something needs it narrow — the palette — or 0
   *  to give the width back.
   *
   * ⚠️ Horizontal edges only. On a left or right edge the body is the
   * panel's HEIGHT, and capping that would cut the list short rather than make
   * it narrower; the width there is the depth, which is already the shell's. */
  capBody(px: number) {
    if (this.cap === px) return;
    this.cap = px;
    this.measure();
  }

  async input(active: boolean) {
    await call("set_task_input", { active });
    this.editing = active;
    if (active) this.show(true);
    else if (!this.hovering) this.hover(false);
  }

  async collapse() {
    await this.input(false);
    this.pinned = false;
    document.getElementById("pin")!.setAttribute("aria-pressed", "false");
    this.suppressed = true;
    this.show(false);
  }

  private tick(now: number) {
    const dt = this.last ? Math.min((now - this.last) / 1000, 0.05) : 0.016;
    this.fold.step(dt);
    this.grow.step(dt);
    this.widen.step(dt);
    this.last = now;
    this.paint();
    // ⚠️ All three, not just the fold: a size change can outlast the opening,
    // and stopping on the fold alone leaves the panel frozen mid-resize.
    if (!this.fold.settled || !this.grow.settled || !this.widen.settled) {
      this.frame = requestAnimationFrame(t => this.tick(t));
    } else {
      this.fold.snap(this.open ? 1 : 0);
      this.frame = 0;
      this.paint();
    }
  }

  private paint() {
    // The spring overshoots past 1; the shape may follow it but opacity may not.
    const t = Math.max(0, this.fold.value);
    const shown = Math.min(1, t);
    const g = this.geometry(t);
    const sw = this.shell.clientWidth;
    const sh = this.shell.clientHeight;

    // Anchored to its edge: the island grows away from the bezel, never across it.
    const x = isVertical(this.edge) ? (this.edge === "left" ? 0 : sw - g.width) : (sw - g.width) / 2;
    const y = isVertical(this.edge) ? (sh - g.height) / 2 : (this.edge === "top" ? 0 : sh - g.height);
    Object.assign(this.island.style, {
      left: `${x}px`, top: `${y}px`, width: `${g.width}px`, height: `${g.height}px`,
    });

    /* The shape is the usage notch's own: rounded on the far side and flaring
     * *back out* to the bezel at each end, so it reads as part of the edge
     * rather than a rounded box parked against it. Reusing `notchPath` rather
     * than re-deriving it — the arc sweep flags and the corner/flare clamping
     * are exactly the parts that are easy to get subtly wrong, and they are
     * already right and already tested there.
     *
     * ⚠️ Generated in CSS pixels, so the corner radius has to be passed in:
     * FRAME.cornerRadius is a frame measurement and means nothing here. */
    this.clip.setAttribute("d", notchPath(g.depth, g.length, g.curl, cpx(FRAME.cornerRadius)));
    this.clip.setAttribute("transform", notchTransform(this.edge, g.depth));

    /* Both layers are placed in pixels every frame rather than anchored with
     * `left: 50%` and centred by a transform. Two reasons, both bugs that were
     * here: a transform written by paint() replaces the CSS one and the panel
     * lands half its width off to the side; and a layer laid out at `left: 50%`
     * counts as layout overflow of the island whatever the transform does, so
     * `scrollWidth` reports the island as overflowing when nothing is visibly
     * out of place. */
    const place = (layer: HTMLElement, lw: number, lh: number) => {
      const lx = isVertical(this.edge) ? (this.edge === "left" ? 0 : g.width - lw) : (g.width - lw) / 2;
      const ly = isVertical(this.edge) ? (g.height - lh) / 2 : (this.edge === "top" ? 0 : g.height - lh);
      layer.style.left = `${lx}px`;
      layer.style.top = `${ly}px`;
    };
    const vertical = isVertical(this.edge);
    place(this.collapsed,
      vertical ? cpx(FRAME.islandPillThin) : cpx(FRAME.islandPillLong),
      vertical ? cpx(FRAME.islandPillLong) : cpx(FRAME.islandPillThin));
    place(this.expanded, vertical ? this.depth : this.body, vertical ? this.body : this.depth);

    // Cross-fade. The collapsed layer is gone before the expanded one arrives,
    // so the two are never legible at once over each other.
    this.collapsed.style.opacity = String(Math.max(0, 1 - shown / 0.38));
    this.collapsed.style.visibility = shown < 0.38 ? "visible" : "hidden";
    const reveal = Math.max(0, (shown - 0.42) / 0.58);
    this.expanded.style.opacity = String(reveal);
    this.expanded.style.visibility = reveal > 0 ? "visible" : "hidden";
    // The reveal nudge travels along the axis the island grows on.
    const back = (1 - reveal) * -6;
    const nudge = {
      top: `translateY(${back}px)`,
      bottom: `translateY(${-back}px)`,
      left: `translateX(${back}px)`,
      right: `translateX(${-back}px)`,
    }[this.edge];
    this.expanded.style.transform = nudge;
    this.report();
  }

  /** The sliver left behind when the island is away.
   *
   * Deliberately small — 3px along the very bezel, no wider than the pill. It
   * makes the window non-click-through where it sits, so anything larger would
   * quietly swallow clicks at the top of the screen for a surface that is not
   * even visible. */
  private revealStrip() {
    const origin = box(this.shell);
    const depth = 3;
    const long = cpx(FRAME.islandPillLong);
    if (isVertical(this.edge)) {
      return {
        x: this.edge === "left" ? origin.x : origin.x + origin.width - depth,
        y: origin.y + (origin.height - long) / 2,
        width: depth,
        height: long,
      };
    }
    return {
      x: origin.x + (origin.width - long) / 2,
      y: this.edge === "top" ? origin.y : origin.y + origin.height - depth,
      width: long,
      height: depth,
    };
  }

  private report() {
    if (this.hidden && !this.peeking) {
      this.masks = [this.revealStrip()];
      const origin = box(this.shell);
      if (native) {
        void call("set_interactive_rects", {
          rects: this.masks.map(m => ({ ...m, x: m.x - origin.x, y: m.y - origin.y })),
        }).catch(() => {});
      }
      return;
    }
    const r = box(this.island);
    // A little slack around the shape: a folding island must not drop the
    // pointer mid-animation and re-collapse under the cursor.
    const pad = cpx(FRAME.tailGap) / 2;
    this.masks = [{ x: r.x - pad, y: r.y - pad, width: r.width + 2 * pad, height: r.height + 2 * pad }];
    const origin = box(this.shell);
    if (native) {
      void call("set_interactive_rects", {
        rects: this.masks.map(m => ({ ...m, x: m.x - origin.x, y: m.y - origin.y })),
      }).catch(() => {});
    }
  }
}
