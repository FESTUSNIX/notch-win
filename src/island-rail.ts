/* Where you are, and how you get somewhere else — under the middle of the
 * island, between the two arcs.
 *
 * ⚠️ It was nine icons in a row in the header, and only the one you were
 * already on carried a word. That caption tells you where you are, which you
 * know, and nothing about where you could go — so eight of the nine were
 * glyphs you had to have learnt. It could not be fixed in place either: the
 * narrowest screen leaves about sixty pixels of header spare, and nine labels
 * need six hundred.
 *
 * So it came out of the header. Down here it has the island's whole width to
 * itself, the current screen is CENTRED and named, and its neighbours fade and
 * blur away either side — which is the part that does the work. A row of equal
 * icons makes you read all nine; a row with a middle makes you read one and
 * step.
 *
 * ⚠️ The same visual language as the arcs — a black shape a clearance below the
 * island's edge, holding controls — but straight, because it is a line of
 * places rather than a fan of actions. Curving it would mean the screen you are
 * on sits at a different height from the ones either side, and this is the one
 * control on the surface you look at rather than point at.
 */
import { FRAME, cpx, isVertical, type Edge } from "./layout";
import { Spring } from "./motion";
import { still } from "./motion-pref";
import { element } from "./dom";
import { paintIcon, type TaskIcon } from "./task-icons";

export interface RailStop {
  name: string;
  icon: TaskIcon;
  label: string;
  /** A screen with something waiting on it wears a dot, as the tabs did. */
  live?: boolean;
  /** Present but not reachable — the player with nothing playing. */
  hidden?: boolean;
}

/** What the rail needs to know about the island this frame. */
export interface RailFrame {
  x: number;
  y: number;
  width: number;
  height: number;
  corner: number;
  edge: Edge;
  fold: number;
  open: boolean;
  moving: boolean;
}

export interface RailPrefs {
  /** How many stops are on screen at once. The rest are blurred away. */
  visible: number;
  /** Whether the stops show without being asked for. */
  always: boolean;
}

export class IslandRail {
  private host = element("div", "island-rail");
  private track = element("div", "rail-track");
  /** Which stop is under the middle. Fractional while a drag is in progress,
   *  and sprung the rest of the time, which is what makes a flick coast. */
  private at = new Spring(0, 0.34, 0.74);
  private stops: RailStop[] = [];
  private cells: HTMLElement[] = [];
  private prefs: RailPrefs = { visible: 5, always: true };
  private opened = false;
  private closing = 0;
  private moving = false;
  /* ── The name on the stop you settle on ────────────────────────────────────
   * ⚠️ DEBOUNCED, and that is the whole of it. A caption is wider than an
   * icon, so showing one moves every stop beside it — harmless once, and a
   * layout thrashing back and forth if it happens on every stop a drag passes.
   * It waits for the rail to stop, and goes the instant it moves again. */
  private named = new Spring(0, 0.3, 0.92);
  private naming = 0;
  /** The widest caption, so every stop displaces its neighbours by the same
   *  amount. ⚠️ One width for all of them: per-caption, the row either side
   *  would shift by a different distance for each screen, and stepping along
   *  the rail would make the whole thing breathe. */
  /** The room a name opens into, as a FIXED slot rather than a measured one.
   *
   * ⚠️ Measuring it was three traps and no better answer. The rail is
   * `hidden` until its first paint and a hidden element measures zero; the
   * caption is held at `max-width: 0`, and both `scrollWidth` and `offsetWidth`
   * report zero on a box already clamped to nothing; and a per-caption width
   * would shift the stops either side by a different distance for every screen,
   * so stepping along the rail would make the whole row breathe. A slot every
   * name fits has none of that, and anything that outgrows it ellipsises. */
  private capWide = cpx(FRAME.railSayRoom);

  /* ── The drag ─────────────────────────────────────────────────────────
   * Held here rather than read back off the DOM: a drag is a stream of
   * positions and the only thing that matters is the difference between two of
   * them. */
  private grabbed = false;
  private grabX = 0;
  private grabAt = 0;
  /** Set once the pointer has moved far enough to mean it. ⚠️ Until then a
   *  press is still a press — without this every click on a stop is also a
   *  one-pixel drag, and the snap fights the click. */
  private dragging = false;
  /** Pixels a second, for the flick. */
  private speed = 0;
  /** The stop the shell has been told about. ⚠️ Held so a drag can change
   *  screens as it passes them without saying the same one twice — `show()`
   *  re-runs a screen's entrance when it is handed the screen already on, so a
   *  drag that wobbles over one stop makes it flash. */
  private told = "";
  /** When the shell was last told, so a fast drag does not render every screen
   *  it passes over. */
  private toldAt = 0;
  private lastX = 0;
  private lastT = 0;

  constructor(
    private wake: () => void,
    private choose: (name: string, live: boolean) => void,
    /** Says the pointer is on the rail. ⚠️ Load-bearing for the same reason it
     *  is on the arcs: the rail is a SIBLING of the island, so reaching for it
     *  reads as leaving, and the island folds under your hand. */
    private reach: (on: boolean) => void,
    /** How far the content should be dragged along, 0 at rest. The island
     *  itself moves with the rail — see `tasks.ts`. */
    private carry: (offset: number, settled: boolean) => void,
  ) {
    this.host.id = "island-rail";
    this.host.hidden = true;
    this.host.setAttribute("role", "tablist");
    this.host.setAttribute("aria-label", "Island screens");
    this.host.append(this.track);
    /* ⚠️ The default has to reach the ELEMENT, not just the field. The rule
     * that hides the stops is keyed on a class, so a rail whose preferences
     * have not arrived yet is an empty black pill — which looks like a shape
     * that failed to fill rather than one waiting to be hovered. */
    this.host.classList.toggle("is-always", this.prefs.always);

    this.host.addEventListener("pointerenter", () => this.setOpen(true));
    this.host.addEventListener("pointerleave", () => this.leave());
    this.host.addEventListener("focusin", () => this.setOpen(true));
    this.host.addEventListener("focusout", () => this.leave());

    this.host.addEventListener("pointerdown", e => this.down(e));
    this.host.addEventListener("pointermove", e => this.move(e));
    for (const kind of ["pointerup", "pointercancel"] as const) {
      this.host.addEventListener(kind, e => this.up(e));
    }
    /* ⚠️ A wheel on the rail steps it, and it does NOT reach the panel. The
     * island already turns a wheel into a screen change; two handlers for one
     * gesture means a single notch moves two screens. */
    this.host.addEventListener("wheel", e => {
      e.preventDefault();
      e.stopPropagation();
      this.nudge(Math.sign(e.deltaX || e.deltaY));
    }, { passive: false });
  }

  mount(into: HTMLElement) { into.append(this.host); }

  get element(): HTMLElement { return this.host; }
  get hidden(): boolean { return this.host.hidden; }
  get settled(): boolean {
    return this.at.settled && this.named.settled && !this.grabbed;
  }
  step(dt: number) { this.at.step(dt); this.named.step(dt); }

  setPrefs(prefs: RailPrefs) {
    this.prefs = prefs;
    this.host.classList.toggle("is-always", prefs.always);
    this.paintCells();
  }

  /** The stops, and which one is showing. */
  setStops(stops: RailStop[], current: string) {
    const same = stops.length === this.stops.length
      && stops.every((s, i) => s.name === this.stops[i].name
        && s.live === this.stops[i].live && s.hidden === this.stops[i].hidden);
    this.stops = stops;
    if (!same) this.paintCells();
    const want = this.live().findIndex(s => s.name === current);
    if (want < 0) return;
    this.told = current;
    /* ⚠️ Snapped while the rail is not showing, sprung while it is. A screen
     * changed from the palette with the island shut must not spend its travel
     * behind a collapsed pill and arrive somewhere arbitrary. */
    if (!this.host.hidden && !still()) this.at.setTarget(want);
    else this.at.snap(want);
    this.wake();
  }

  /** The stops that can actually be reached. ⚠️ A hidden stop is not merely
   *  invisible: it must not take a place in the order either, or stepping past
   *  the player with nothing playing lands on a blank screen. */
  private live(): RailStop[] { return this.stops.filter(s => !s.hidden); }

  private paintCells() {
    this.track.replaceChildren();
    this.cells = [];
    for (const stop of this.live()) {
      const cell = element("button", `rail-stop${stop.live ? " is-live" : ""}`);
      (cell as HTMLButtonElement).type = "button";
      cell.dataset.tab = stop.name;
      cell.setAttribute("role", "tab");
      cell.setAttribute("aria-label", stop.label);
      cell.title = stop.label;
      paintIcon(cell, stop.icon);
      cell.append(element("span", "rail-say", stop.label));
      /* ⚠️ `click`, not `pointerup`. A drag that ends on a stop must not also
       * select it, and `dragging` is what tells them apart — but the browser
       * suppresses a click after a real drag anyway, so this is belt and
       * braces for the case where the pointer barely moved. */
      cell.onclick = () => {
        if (this.dragging) return;
        const index = this.live().findIndex(one => one.name === stop.name);
        if (index >= 0) this.settleOn(index);
      };
      this.track.append(cell);
      this.cells.push(cell);
    }
  }

  /* ── Reaching for it ──────────────────────────────────────────────── */

  private setOpen(on: boolean) {
    if (on) clearTimeout(this.closing);
    if (this.opened === on) return;
    this.opened = on;
    this.host.classList.toggle("is-open", on);
    this.reach(on);
    this.wake();
  }

  private leave() {
    clearTimeout(this.closing);
    this.closing = window.setTimeout(() => {
      if (this.host.matches(":hover") || this.grabbed) return;
      if (this.host.contains(document.activeElement)) return;
      // ⚠️ Not while the island is still travelling — see `island-arc.ts`.
      if (this.moving) { this.leave(); return; }
      this.setOpen(false);
    }, 160);
  }

  /* ── Dragging through the screens ─────────────────────────────────── */

  /** How far apart two stops sit, along whichever way the rail runs.
   *
   * ⚠️ Different per axis, and not for tidiness. Across the island a stop is
   * a pill wide enough for the centred one's caption; down its side the stops
   * are stacked and the pitch is a row's height, which is a third of that. One
   * number for both makes the vertical rail four screens tall. */
  private pitch(): number {
    return cpx(this.upright ? FRAME.railStepDown : FRAME.railStep);
  }

  /** Whether the rail runs down the island's side rather than across its end. */
  private upright = false;

  private down(event: PointerEvent) {
    if (event.button !== 0) return;
    this.grabbed = true;
    this.dragging = false;
    this.grabX = this.upright ? event.clientY : event.clientX;
    this.grabAt = this.at.value;
    this.lastX = this.upright ? event.clientY : event.clientX;
    this.lastT = event.timeStamp;
    this.speed = 0;
    /* ⚠️ The pointer is NOT captured yet. Capture retargets everything that
     * follows to the capturing element — `click` included — so capturing on the
     * press means the `click` on a stop is delivered to the rail instead, and
     * pressing a screen silently does nothing at all. It is taken in `move`,
     * once there is a drag to capture. */
    this.wake();
  }

  private move(event: PointerEvent) {
    if (!this.grabbed) return;
    const dx = (this.upright ? event.clientY : event.clientX) - this.grabX;
    /* ⚠️ Four pixels of slop before it counts. Without it every press is a
     * one-pixel drag, the rail snaps back under the finger, and the click that
     * was meant to select a screen never lands. */
    if (!this.dragging && Math.abs(dx) < 4) return;
    if (!this.dragging) {
      this.dragging = true;
      this.host.classList.add("is-dragging");
      // Now there is a gesture worth following off the edge of the rail.
      this.host.setPointerCapture(event.pointerId);
    }

    const dt = Math.max(1, event.timeStamp - this.lastT);
    const now = this.upright ? event.clientY : event.clientX;
    this.speed = (now - this.lastX) / dt * 1000;
    this.lastX = now;
    this.lastT = event.timeStamp;

    /* ⚠️ Rubber-banded past the ends rather than stopped dead. A list that
     * simply refuses to move reads as a broken drag; one that resists says
     * "this is the end" without a word. */
    const last = Math.max(0, this.live().length - 1);
    let want = this.grabAt - dx / this.pitch();
    if (want < 0) want = want / 3;
    else if (want > last) want = last + (want - last) / 3;
    this.at.snap(want);
    this.renaming(false);
    this.lay();
    this.carry(this.offset(), false);
    /* ⚠️ The screen changes as the rail passes it, not when the drag is let
     * go. Waiting for the release means walking three screens is three drags;
     * and it means the panel spends the whole gesture showing something the
     * rail has already left, which is what made the drag read as broken. */
    this.arrive(Math.round(this.at.value), true);
  }

  private up(event: PointerEvent) {
    if (!this.grabbed) return;
    this.grabbed = false;
    this.host.classList.remove("is-dragging");
    if (this.host.hasPointerCapture(event.pointerId)) {
      this.host.releasePointerCapture(event.pointerId);
    }
    if (!this.dragging) return;

    /* A flick carries past the nearest stop. ⚠️ Capped at one: this is a list
     * of nine places with names, not a scroll wheel, and coasting four screens
     * past the one you meant is worse than not coasting at all. */
    const carry = Math.max(-1, Math.min(1, Math.round(-this.speed / 900)));
    const last = Math.max(0, this.live().length - 1);
    const want = Math.max(0, Math.min(last, Math.round(this.at.value) + carry));
    this.settleOn(want);
    /* ⚠️ Cleared on the NEXT frame, not here. `click` fires after `pointerup`,
     * and a drag that ends on a stop would otherwise select whatever it
     * happened to finish over. */
    requestAnimationFrame(() => { this.dragging = false; });
  }

  private nudge(direction: number) {
    const last = Math.max(0, this.live().length - 1);
    this.settleOn(Math.max(0, Math.min(last, Math.round(this.at.value) + direction)));
  }

  private settleOn(index: number) {
    this.renaming(false);
    if (still()) this.at.snap(index);
    else this.at.setTarget(index);
    this.wake();
    this.arrive(index, false);
  }

  /** Tell the shell where the rail is, at most once per screen.
   *
   * @param live whether this is mid-drag, so the screen swaps without playing
   *             its entrance — the panel is already being carried by the
   *             gesture, and two motions at once is the flicker. */
  private arrive(index: number, live: boolean) {
    const stop = this.live()[index];
    if (!stop || stop.name === this.told) return;
    /* ⚠️ Rate-limited while the drag is in the hand. A screen change is a
     * full render of the panel, and a quick flick across the rail passes six
     * of them in half a second — rendering all six is work nobody sees and it
     * makes the drag itself stutter. The rail keeps moving smoothly; the panel
     * simply shows some of what it goes past.
     *
     * ⚠️ The RELEASE is never rate-limited, so whatever it lands on is always
     * what ends up on screen. */
    const now = performance.now();
    if (live && now - this.toldAt < 150) return;
    this.toldAt = now;
    this.told = stop.name;
    this.choose(stop.name, live);
  }

  /** Take the name away now; put it back when the rail has been still for a
   *  moment. ⚠️ Called from everywhere that moves the rail, including the
   *  frame loop — there is no single place a carousel "stops". */
  private renaming(quiet: boolean) {
    if (!quiet) {
      clearTimeout(this.naming);
      this.naming = 0;
      this.named.setTarget(0);
      return;
    }
    /* ⚠️ Only START the count — never restart one already running. This is
     * called from the frame loop, and the loop is woken by things that have
     * nothing to do with the rail: the clock ticking the pill over, a session
     * changing, the panel measuring itself. Re-arming on each of those starves
     * the timer forever, and the name simply never appears. */
    if (this.naming) return;
    this.naming = window.setTimeout(() => {
      this.naming = 0;
      this.named.setTarget(1);
      this.wake();
    }, 260);
  }

  /** How far the rail is from its resting stop, in cells. The island's content
   *  rides this, which is what makes the two read as one movement. */
  private offset(): number {
    /* ⚠️ Measured from the CLAMPED position. Past the first or last stop the
     * rail rubber-bands — which is right, it says "this is the end" — but there
     * is no screen out there for the panel to be carried towards, so carrying
     * it anyway slides the content off and then snaps it back when the band
     * returns. At the ends this is simply zero. */
    const last = Math.max(0, this.live().length - 1);
    const bounded = Math.max(0, Math.min(last, this.at.value));
    return bounded - Math.round(bounded);
  }

  /* ── Drawing ──────────────────────────────────────────────────────── */

  paint(frame: RailFrame) {
    this.moving = frame.moving;
    /* ⚠️ All four edges. It ran across the island's end only at first, and
     * that left a left- or right-edge island with NO screen switcher at all
     * — the header strip had already gone. Down the side it is the same
     * control with the axes swapped; what changes is the pitch, because
     * stacked stops are a row tall rather than a caption wide. */
    this.upright = isVertical(frame.edge);
    const show = frame.open && this.live().length > 1;
    this.host.hidden = !show;
    if (!show) return;
    this.host.classList.toggle("is-upright", this.upright);
    this.host.style.setProperty("--rail-hint", `${cpx(FRAME.railHint)}px`);
    this.host.style.setProperty("--rail-thick", `${cpx(FRAME.islandArcStroke)}px`);

    const runs = Math.min(
      (this.upright ? frame.height : frame.width) - 2 * frame.corner,
      this.prefs.visible * this.pitch());
    const depth = cpx(FRAME.railDepth);
    const gap = cpx(FRAME.islandArcClear);
    /** Just off the island's free edge — the side away from the bezel. */
    const off = frame.edge === "top" ? frame.y + frame.height + gap
      : frame.edge === "bottom" ? frame.y - depth - gap
      : frame.edge === "left" ? frame.x + frame.width + gap
      : frame.x - depth - gap;
    Object.assign(this.host.style, {
      left: `${this.upright ? off : frame.x + (frame.width - runs) / 2}px`,
      top: `${this.upright ? frame.y + (frame.height - runs) / 2 : off}px`,
      width: `${this.upright ? depth : runs}px`,
      height: `${this.upright ? runs : depth}px`,
      opacity: String(Math.max(0, Math.min(1, frame.fold * 1.6 - 0.6))),
    });
    this.lay();
    if (this.at.settled && !this.grabbed) {
      this.carry(0, true);
      /* Nothing has moved this frame; start counting towards the name.
       *
       * ⚠️ `settled`, not `value === 0`. A spring asymptotes — it arrives at
       * 0.004 and stays there — so an equality test against zero is never true
       * after the first drag, and the name goes away once and never returns. */
      if (this.named.settled) this.renaming(true);
    }
  }

  /** Where each stop sits, and how much of it you can see.
   *
   * ⚠️ The blur and the fade are computed per cell from its distance to the
   * middle, not set by a class on the neighbours. Half the point of the shape
   * is that it moves continuously under a drag, and a class can only be on or
   * off — stepped opacity over a smooth translate is the thing that reads as a
   * cheap carousel. */
  private lay() {
    const centre = this.at.value;
    /* ⚠️ Which stop you are ON is read from the CLAMPED position, while where
     * each one sits is read from the real one. Pulling past the first or last
     * stop rubber-bands the rail out beyond it, and judged on that the nearest
     * stop is more than half a slot away — so nothing is marked as current,
     * the caption goes, and the rail reads as having lost its place because
     * you leaned on the end of it. */
    const last = Math.max(0, this.live().length - 1);
    const anchor = Math.max(0, Math.min(last, centre));
    const edge = (this.prefs.visible - 1) / 2;
    /* How much room the caption is taking. ⚠️ Its neighbours are pushed out by
     * HALF of it each, not the whole: the pill grows from its middle, so each
     * side only has to yield half the extra. Pushing by the full width leaves a
     * visible hole beside the name. */
    const grown = this.named.value * this.capWide;
    /* ⚠️ The neighbours yield HALF the extra each, plus a gap. Half, because
     * the pill grows from its middle and each side only has to give way by
     * half of it; the gap, because half exactly is half exactly — the pill's
     * edge lands on its neighbour's and the name reads as crowded into it. */
    const push = (grown + cpx(FRAME.railSayGap)) / 2;
    for (const [index, cell] of this.cells.entries()) {
      const away = index - centre;
      /* ⚠️ RAMPED, not `Math.sign`. The centred stop's `away` is zero give or
       * take floating-point noise, and `Math.sign(1e-15)` is 1 — so the stop
       * the name belongs to shoved ITSELF a full step sideways and sat off
       * centre by half the name's width, which every other measurement here
       * still called correct. It also means a stop crossing the middle slides
       * through the displacement instead of snapping across it. */
      const lean = Math.max(-1, Math.min(1, away / 0.5));
      const along = away * this.pitch() + lean * push;
      cell.style.translate = this.upright ? `0 ${along}px` : `${along}px 0`;
      const far = Math.abs(away);
      /* Full size in the middle, and away from it they shrink, fade and blur
       * out — so the one you are on is the one you read. */
      const near = Math.max(0, 1 - far / Math.max(0.001, edge + 0.5));
      cell.style.scale = `${0.74 + 0.26 * near}`;
      cell.style.opacity = `${Math.max(0, Math.min(1, 0.12 + 0.88 * near))}`;
      cell.style.filter = far < 0.5 ? "none" : `blur(${Math.min(3.2, (far - 0.5) * 2.2)}px)`;
      const here = Math.abs(index - anchor) < 0.5;
      cell.classList.toggle("is-here", here);
      cell.setAttribute("aria-selected", String(here));
      /* ⚠️ Kept out of the tab order when it is not the one showing. Nine
       * screens on a rail is nine tab stops between the panel and its own
       * controls otherwise. */
      (cell as HTMLButtonElement).tabIndex = here ? 0 : -1;
      /* ⚠️ Written as a LENGTH, from the same number that moves the
       * neighbours. A CSS transition on the caption and a spring on the row
       * either side are two clocks for one movement, and they drift. */
      const say = cell.querySelector(".rail-say") as HTMLElement | null;
      if (!say) continue;
      const showing = here;
      say.style.maxWidth = showing ? `${grown}px` : "0px";
      /* ⚠️ The padding grows WITH it. `box-sizing: border-box` means padding
       * is the floor of a border box, not something `max-width: 0` can squeeze
       * out — so a caption held at zero still took its own padding's width, and
       * every stop on the rail carried eleven pixels of nothing. */
      say.style.paddingRight = showing
        ? `${this.named.value * cpx(FRAME.railSayGap)}px` : "0px";
    }
  }
}
