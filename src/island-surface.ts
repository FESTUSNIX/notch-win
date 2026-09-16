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
import { FRAME, cpx, isVertical, notchCorner, notchPath, notchTransform, type Edge } from "./layout";
import { IslandArc, type ArcAction } from "./island-arc";
import { IslandRail, type RailPrefs, type RailStop } from "./island-rail";
import { Spring } from "./motion";
import { still, onSystemMotionChange } from "./motion-pref";
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
  /* The pill becoming a panel, and the one gesture the whole app is judged by.
   *
   * ⚠️ Tuned against Droppy's own, which is
   * `transform 460ms cubic-bezier(0.3, 1.6, 0.4, 1)`. A spring is not a bezier,
   * so the numbers are not transferable — what carries across is the SHAPE:
   * about half a second, and a control point of 1.6 is a pronounced overshoot.
   * `response` is the period, so 0.46 is that duration; `damping` below ~0.7 is
   * what lets it past its target and back. */
  private fold = new Spring(0, 0.46, 0.62);
  /* ⚠️ The panel's own size is sprung as well as its opening. `depth` and
   * `body` are recomputed whenever the screen changes, and writing them
   * straight into the geometry made the island SNAP to the new screen's height
   * while its contents were still fading in — the one motion on the surface
   * that had no easing at all.
   *
   * ⚠️ TWO sets of parameters, chosen by WHY the size changed — and this is
   * the distinction the old single damping of 0.9 was standing in for.
   *
   *   * A size change you ASKED FOR — you pressed a tab, the screen behind it
   *     is a different shape — can bounce. The content is changing at the same
   *     time; movement is the point, and a panel that merely slides to the new
   *     size reads as sluggish beside the tab pill that just sprang.
   *   * A size change under a STILL POINTER — a list gained a row, a device
   *     list opened, the day ticked over — must not. You are reading; overshoot
   *     there is a wobble, and the row you were about to press moves out from
   *     under you.
   *
   * The old comment was right about the second case and paid for it in the
   * first. `sizing()` picks. */
  private grow = new Spring(cpx(FRAME.islandMinDepth), 0.34, 0.9);
  private widen = new Spring(cpx(FRAME.islandBodyLong), 0.34, 0.9);
  /** Set for one measure by `resize()`: the next size change was asked for. */
  private deliberate = false;
  /** The full body along the edge, in CSS px. ⚠️ Not `cpx(FRAME.islandBodyLong)`
   *  inline any more: the width is a preference, and a constant read at three
   *  call sites is a preference that can only be changed in two of them. */
  private full = cpx(FRAME.islandBodyLong);
  /** How long the panel waits after the pointer leaves. */
  private foldDelay = 450;
  /** Whether pointing at the pill opens it at all. */
  private openOnHover = true;
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
  /* ── The two arcs ─────────────────────────────────────────────
   * What the open screen can do, off the far corner; what the island can do,
   * off the near one. ⚠️ SIBLINGS of the island, never children: `#island` is
   * `overflow: clip` with a clip path on it, so anything inside it that reaches
   * past the shape is simply erased. */
  private tools = new IslandArc("island-tools", "far",
    () => this.wake(), on => this.reachedFor(on));
  private global = new IslandArc("island-global", "near",
    () => this.wake(), on => this.reachedFor(on));
  /* ── The rail ───────────────────────────────────────────────────────
   * Where you are, under the middle, between the two arcs. Another sibling. */
  private rail = new IslandRail(
    () => this.wake(),
    (name, live) => this.onChoose?.(name, live),
    on => this.reachedFor(on),
    (offset, settled) => this.carried(offset, settled),
  );
  private onChoose?: (name: string, live: boolean) => void;
  private masks: { x: number; y: number; width: number; height: number }[] = [];

  constructor(private onFold?: (open: boolean) => void) {
    // ⚠️ On the SHELL, beside the island rather than inside it.
    this.tools.mount(this.shell);
    this.global.mount(this.shell);
    this.rail.mount(this.shell);
    document.documentElement.style.setProperty("--task-indent", `${cpx(FRAME.taskIndent)}px`);
    document.documentElement.style.setProperty("--row-height", `${cpx(FRAME.taskRowHeight)}px`);
    window.addEventListener("resize", () => this.measure());
    onSystemMotionChange(() => {
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
    /* ⚠️ Room for the arc BEYOND the island, not taken out of it. The window
     * was exactly the island's full size, so a line struck outside its corner
     * was cut off at the window's edge — which looks like a rendering fault
     * rather than a missing window. The margin costs nothing: the window is
     * click-through everywhere outside the reported masks.
     *
     * ⚠️ Twice over along the edge, once across it. `paint` centres the
     * island in the window along its own axis, so room added on one side only
     * would move the island rather than make space beside it. */
    const reach = cpx(FRAME.islandArcReach);
    const length = this.body + 2 * cpx(FRAME.islandCurl) + 2 * reach;
    const depth = cpx(FRAME.islandBodyDepth) + reach;
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
        /* ⚠️ A child that CLIPS its own content contributes the content, not
         * the box. Home's three cards are stretched to one another's height by
         * the grid, so the tallest one's list can overflow it by a row — and
         * the union of the boxes then measures the panel eight pixels short,
         * which is a clipped last row rather than a visible one. */
        const boxes = [...kids, ...el.querySelectorAll<HTMLElement>(".sheet")]
          .map(child => {
            const box = child.getBoundingClientRect();
            const hidden = Math.max(0, child.scrollHeight - child.clientHeight);
            return { height: box.height, width: box.width, bottom: box.bottom + hidden };
          })
          /* ⚠️ Zero WIDTH counts as not on screen, and that is not pedantry: a
           * column clipped to nothing still reports its content's height, and
           * the rule above then adds every hidden pixel of it back in. The
           * player's queue is exactly that — closed, it is a 0px track holding
           * three rows, and without this the closed panel measured as tall as
           * the open one. */
          .filter(box => box.height > 0 && box.width > 0);
        if (!boxes.length) return parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
        const bottom = Math.max(...boxes.map(box => box.bottom));
        // `bottom - base.top` already carries the top padding.
        return bottom - base.top + parseFloat(style.paddingBottom);
      }
      /* ⚠️ Children's heights PLUS their margins, plus the scroller's own
       * padding. `offsetHeight` alone misses every gap between rows — the
       * agents, shelf and calendar lists all space themselves with
       * `.row + .row { margin-top }`, so a five-row list was measured about
       * thirty pixels short and opened already scrolled. A list that arrives
       * scrolled reads as cut off rather than as long.
       *
       * ⚠️ Adjacent margins collapse, so counting both sides over-measures
       * where both are set. Nothing here sets both, and erring tall is the
       * harmless direction: a few spare pixels beat a scrollbar. */
      if (el.classList.contains("scrolls")) {
        const style = getComputedStyle(el);
        const inner = kids.reduce((n, kid) => {
          const box = getComputedStyle(kid);
          return n + kid.offsetHeight
            + parseFloat(box.marginTop || "0") + parseFloat(box.marginBottom || "0");
        }, 0);
        return inner + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
      }
      return el.offsetHeight;
    };
    this.body = this.cap && !isVertical(this.edge)
      ? Math.min(this.full, this.cap)
      : this.full;
    const screen = this.expanded.querySelector<HTMLElement>(".screen.active");
    const content = screen ? [...screen.children].reduce((n, el) => n + natural(el as HTMLElement), 0) : 0;
    const available = isVertical(this.edge) ? this.shell.clientWidth : this.shell.clientHeight;
    this.depth = Math.min(
      available,
      cpx(FRAME.islandBodyDepth),
      /* ⚠️ No `cardPadding` any more. `natural()` counts the scroller's own
       * padding now, so adding a card's worth on top of it spent that gap
       * twice — ~30px under the last row of every screen, which is what made
       * the bottom look nothing like the sides. */
      Math.max(cpx(FRAME.islandMinDepth), chrome + content),
    );
    /* Layers are sized to the BODY, never the element: the flare at each end is
     * shape, not room, and content laid into it would be clipped by the curve.
     *
     * ⚠️ Set to the TARGET here because that is the size the content has to be
     * measured at — and then overwritten by `paint()` on every animated frame.
     * The two are not in conflict: this one is the question ("how tall is this
     * screen at its real width?"), that one is the answer arriving. */
    const vertical = isVertical(this.edge);
    this.expanded.style.width = `${vertical ? this.depth : this.body}px`;
    this.expanded.style.height = `${vertical ? this.body : this.depth}px`;
    /* ⚠️ Snapped while closed, sprung while open. A size change the island is
     * not showing must not animate: the spring would spend its travel behind a
     * collapsed pill and the panel would then open at whatever size it had got
     * to, which is a different wrong size every time. */
    if (this.open && !still()) {
      const [response, damping] = this.sizing();
      this.grow.retune(response, damping);
      this.widen.retune(response, damping);
      this.grow.setTarget(this.depth);
      this.widen.setTarget(this.body);
      if (!this.frame) { this.last = 0; this.frame = requestAnimationFrame(t => this.tick(t)); }
    } else {
      this.grow.snap(this.depth);
      this.widen.snap(this.body);
    }
    this.collapsed.style.width = `${vertical ? cpx(FRAME.islandPillThin) : cpx(FRAME.islandPillLong)}px`;
    this.collapsed.style.height = `${vertical ? cpx(FRAME.islandPillLong) : cpx(FRAME.islandPillThin)}px`;
    this.deliberate = false;
    this.paint();
  }

  /** Whether pointing at the pill is what opens it. */
  get opensOnHover(): boolean { return this.openOnHover; }

  /** Whether the whole chrome is slid off the screen. */
  get isHidden(): boolean { return this.hidden; }

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
      /* ⚠️ In CLICK MODE, leaving does not fold. That is the whole of the
       * mode, and it was only half implemented: `openOnHover` stopped the
       * panel opening under the pointer but the timer was armed on every
       * leave, so the panel still shut the moment the pointer wandered off —
       * which is exactly what somebody turning hover off is trying to stop.
       *
       * What ends it instead: a click outside (`island:dismiss`, seen
       * natively — see hover.rs), Escape, the collapse button, the shortcut,
       * or clicking the pill again. */
      if (this.openOnHover) this.timer = window.setTimeout(() => this.show(false), this.foldDelay);
    } else if (!this.suppressed && this.openOnHover) {
      this.show(true);
    }
  }

  /** A click somewhere else on the screen.
   *
   * ⚠️ Honours the pin and nothing else. The pin is the one control whose
   * entire meaning is "stay open"; `editing` is not — a caret in the composer
   * and a click on another window is somebody who has finished here, so the
   * field is released rather than used as a reason to stay. */
  async dismiss() {
    if (!this.open || this.pinned) return;
    this.suppressed = true;
    await this.input(false).catch(() => {});
    clearTimeout(this.timer);
    this.show(false);
  }

  /* ── What the settings window can change ─────────────────────────────
   * ⚠️ Applied live, never at boot only. The settings window is a different
   * window: a preference the island picked up on its next restart would be a
   * settings screen that looks broken. */

  /** The panel's width along its edge, in CSS px. 0 restores the default. */
  setBodyLong(px: number) {
    const next = px > 0 ? px : cpx(FRAME.islandBodyLong);
    if (next === this.full) return;
    this.full = next;
    this.measure();
  }

  /** How long the panel waits after the pointer leaves, in ms. */
  setFoldDelay(ms: number) { this.foldDelay = ms; }

  /** Whether pointing at the pill opens the panel.
   *
   * ⚠️ Only the OPENING. Leaving still folds it, and the pointer still holds
   * it open while it is over it — an island that ignored the pointer entirely
   * would fold under the cursor mid-read. */
  setOpenOnHover(value: boolean) { this.openOnHover = value; }

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
    if (still()) {
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

  /** The NEXT measure was asked for, so its size springs may bounce.
   *
   * ⚠️ A flag rather than a parameter on `measure()`, because the measure that
   * matters is not the one the caller makes — a screen switch caps the body,
   * re-renders, and only the measure at the END of the render sees the real
   * content. The flag rides across the two.
   *
   * ⚠️ Cleared inside `measure()`, so a stray measure in between consumes it
   * rather than leaving a bounce armed for whatever happens next. */
  deliberately() { this.deliberate = true; }

  /** Response and damping for the size springs, by why they are moving. */
  private sizing(): [number, number] {
    /* ⚠️ Droppy's is `width/height/border-radius 560ms
     * cubic-bezier(0.32, 1.22, 0.36, 1)` — slower than its transform and with a
     * smaller overshoot, which is exactly the distinction below: a size change
     * you asked for may overshoot, and it is allowed to take longer than the
     * fold because you are watching the CONTENT arrive, not the shape.
     *
     * The second pair is unchanged and is not Droppy's: a list that gained a
     * row under a still pointer must not move the row you were about to press. */
    return this.deliberate ? [0.56, 0.68] : [0.34, 0.92];
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
    this.tools.step(dt);
    this.global.step(dt);
    this.rail.step(dt);
    this.last = now;
    this.paint();
    // ⚠️ All three, not just the fold: a size change can outlast the opening,
    // and stopping on the fold alone leaves the panel frozen mid-resize.
    if (!this.fold.settled || !this.grow.settled || !this.widen.settled
      || !this.tools.settled || !this.global.settled || !this.rail.settled) {
      this.frame = requestAnimationFrame(t => this.tick(t));
    } else {
      /* ⚠️ The mask follows the tab to its SHRUNK size only once it has got
       * there. On the way out it is reported early and the pointer can fall
       * out of the window mid-animation; on the way in it is reported early on
       * purpose — see `report`. */
      this.report();
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
    /* ⚠️ The expanded layer is SIZED here, from the sprung values — not left
     * at the target size `measure()` gave it.
     *
     * `measure()` has to set the target size, because that is the width the
     * content must be measured at. But leaving it there means the panel's
     * contents are at their final width and final offset on the very first
     * frame, while the shape is still growing around them — so everything
     * inside SNAPS into place and only the black shape animates. That is the
     * jump: not the queue, the whole panel.
     *
     * Sized every frame instead, the container travels with the shape. The
     * player inside it is a fixed track (see `.media-body`), so nothing in it
     * re-lays out; it simply rides the container's left edge outwards as the
     * island grows from its centre. */
    const lw = vertical ? this.depth : g.body;
    const lh = vertical ? g.body : this.depth;
    this.expanded.style.width = `${lw}px`;
    this.expanded.style.height = `${lh}px`;
    place(this.expanded, lw, lh);

    this.paintArcs(g, x, y);

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

  /** Both arcs, from one measurement of the island.
   *
   * ⚠️ The corner the island ACTUALLY ended up with, not `FRAME.cornerRadius`.
   * `clampCorners` shrinks it to fit the depth and the flares, so a line struck
   * at the nominal 78.8 sits visibly inside a shallow island's edge — which
   * reads as a mistake rather than as a smaller gap. */
  private paintArcs(g: ReturnType<IslandSurface["geometry"]>, x: number, y: number) {
    const frame = {
      x, y, width: g.width, height: g.height,
      curl: g.curl,
      corner: notchCorner(g.depth, g.length, g.curl, cpx(FRAME.cornerRadius)),
      edge: this.edge,
      fold: this.fold.value,
      open: this.open && !this.hidden,
      moving: !this.fold.settled || !this.grow.settled || !this.widen.settled,
    };
    this.tools.paint(frame);
    this.global.paint(frame);
    this.rail.paint(frame);
  }

  /** Which screens the rail offers, and which one is showing. */
  setStops(stops: RailStop[], current: string) {
    this.rail.setStops(stops, current);
    this.report();
  }

  /** How many stops the rail shows, and whether it shows them unasked. */
  setRailPrefs(prefs: RailPrefs) { this.rail.setPrefs(prefs); }

  /** Told when a stop is chosen — by a press, a drag or a flick. `live` means
   *  the drag is still in the hand, so the screen should swap without playing
   *  its entrance. */
  onStop(run: (name: string, live: boolean) => void) { this.onChoose = run; }

  /** The panel rides the rail. ⚠️ `translate` and `filter`, never
   *  `transform`: the island spends `transform` on its own press, and a
   *  transformed ancestor would also become the containing block for the two
   *  arcs, which are positioned against the window. */
  private carried(offset: number, settled: boolean) {
    const reach = cpx(FRAME.railCarry);
    this.expanded.style.translate = settled ? "" : `${-offset * reach}px 0`;
    this.expanded.style.filter = settled || Math.abs(offset) < 0.02
      ? "" : `blur(${Math.min(5, Math.abs(offset) * 7)}px)`;
    this.expanded.classList.toggle("is-carried", !settled);
  }

  /** Asks for animation frames on an arc's behalf — the loop lives here. */
  private wake() {
    if (!this.frame) { this.last = 0; this.frame = requestAnimationFrame(t => this.tick(t)); }
  }

  /** The pointer is on one of the arcs.
   *
   * ⚠️ An arc is a SIBLING of the island, so reaching for one reads as
   * leaving — and the island folds while you are on your way to its own close
   * button. The masks do cover the arcs, but they are recomputed on a settle
   * and the pointer can arrive before that; this says so directly instead.
   *
   * ⚠️ Only ever opens. Letting go of an arc must NOT fold the island: the
   * pointer is usually still on the panel, and the ordinary hover path already
   * knows where it is. */
  private reachedFor(on: boolean) {
    if (on) this.hover(true);
    this.report();
  }

  /** Whether the island is being held open, so the pin can say which way it
   *  is set when its arc is rebuilt. */
  get isPinned(): boolean { return this.pinned; }

  /** What the open screen can do. */
  setTools(actions: ArcAction[]) {
    this.tools.setActions(actions, "What this screen can do");
    this.paint();
    this.report();
  }

  /** And what the island can do, which is the same on every screen. */
  setGlobal(actions: ArcAction[]) {
    this.global.setActions(actions, "Island controls");
    this.paint();
    this.report();
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
    /* ⚠️ The tab is its OWN mask. The window is click-through everywhere
     * outside these rects, so a shape drawn past the island's box would be
     * visible, unhoverable, and unclickable — and the island would fold the
     * moment the pointer reached for it. */
    /* ⚠️ Each arc is its OWN mask, and it is the whole quadrant rather than
     * a band around the line. The window is click-through outside these rects,
     * so a line drawn past the island's box would be visible, unhoverable and
     * unclickable — and the island would fold the moment the pointer reached
     * for it. The quadrant is fixed whether the line is in or out, so nothing
     * has to be re-reported mid-swing. */
    for (const arc of [this.tools, this.global]) {
      if (!arc.hidden) this.masks.push(box(arc.element));
    }
    if (!this.rail.hidden) this.masks.push(box(this.rail.element));
    const origin = box(this.shell);
    if (native) {
      void call("set_interactive_rects", {
        rects: this.masks.map(m => ({ ...m, x: m.x - origin.x, y: m.y - origin.y })),
      }).catch(() => {});
    }
  }
}
