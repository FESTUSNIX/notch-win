/* One arc of controls, struck concentric with a corner of the island.
 *
 * There are two. The FAR corner carries what the open screen can do — refresh
 * this, clear that — and the NEAR one carries what the island can do, which is
 * the same four controls on every screen: search, pin, settings, close.
 *
 * ⚠️ Two arcs rather than one row of six, and the split is the whole point.
 * The four global controls used to sit in the header beside the screen tabs,
 * and a control that changes with the screen mixed in among four that never do
 * reads as an orphan wherever it is put. Opposite corners say which is which
 * without a word: this side is the island, that side is what you are looking
 * at.
 *
 * ⚠️ Everything here is positioned from the island's own measured geometry
 * every frame. The arc is a SIBLING of `#island` — that element is
 * `overflow: clip` with a clip path on it, so anything inside it that reaches
 * past the shape is erased — which means nothing in the layout keeps the two
 * together, and the paint loop is what does.
 */
import { FRAME, arcPath, cpx, isVertical, type Edge } from "./layout";
import { Spring } from "./motion";
import { still } from "./motion-pref";
import { element } from "./dom";
import { paintIcon, type TaskIcon } from "./task-icons";

/** Which corner: the far end of the island along its bezel, or the near one. */
export type ArcCorner = "far" | "near";

export interface ArcAction {
  /** ⚠️ Only where something writes to the element between rebuilds — the
   *  pin, whose pressed state the surface sets the moment it is toggled rather
   *  than waiting for the next render. */
  id?: string;
  icon: TaskIcon;
  label: string;
  /** Absent for a readout — something with nothing to do is still worth a name. */
  run?: () => void;
  disabled?: boolean;
  /** Draws attention: the sync tool while a sync is failing. */
  tone?: "warn";
  /** For a toggle, so the control can say which way it is set. */
  pressed?: boolean;
}

/** What the arc needs to know about the island this frame. */
export interface ArcFrame {
  x: number;
  y: number;
  width: number;
  height: number;
  /** The island's own flare, and the corner radius it actually ended up with. */
  curl: number;
  corner: number;
  edge: Edge;
  /** The fold, 0 to 1, so the arc arrives with the shape rather than after it. */
  fold: number;
  /** Whether the island is showing at all. */
  open: boolean;
  /** Whether the island's own size is still travelling. ⚠️ The arc is placed
   *  from that size every frame, so while it is moving the arc slides out from
   *  under a stationary pointer. */
  moving: boolean;
}

/** The outward quadrant, as a pair of directions from the corner's centre.
 *
 * ⚠️ Derived, not tabulated per edge. The island always occupies the INWARD
 * quadrant, so the arc's is that reflected — and writing the eight cases out by
 * hand is eight chances to get one of them backwards on an edge nobody looks
 * at. */
function quadrant(edge: Edge, corner: ArcCorner): { dx: 1 | -1; dy: 1 | -1 } {
  const far = corner === "far";
  switch (edge) {
    case "top": return { dx: far ? 1 : -1, dy: 1 };
    case "bottom": return { dx: far ? 1 : -1, dy: -1 };
    case "left": return { dx: 1, dy: far ? 1 : -1 };
    case "right": return { dx: -1, dy: far ? 1 : -1 };
  }
}

/** Where that quadrant starts, as a fraction of a turn clockwise from three
 *  o'clock with y down. */
function baseTurn(dx: number, dy: number): number {
  if (dx > 0) return dy > 0 ? 0 : 0.75;
  return dy > 0 ? 0.25 : 0.5;
}

export class IslandArc {
  private host = element("div", "island-arc");
  private svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  private line = document.createElementNS("http://www.w3.org/2000/svg", "path");
  private band = document.createElementNS("http://www.w3.org/2000/svg", "path");
  private acts = element("div", "arc-acts");
  /** How far out the line is struck. Sprung, so it swings rather than jumping
   *  to a new radius under the cursor. */
  private swing = new Spring(0, 0.4, 0.68);
  private opened = false;
  private count = 0;
  /** The corner radius last seen, so `span` can answer between frames. */
  private seen = cpx(FRAME.cornerRadius);
  /** Pending close. ⚠️ It does not shut the instant the pointer leaves, and
   *  that is not politeness — it is correctness. The arc is placed from the
   *  island's own measured geometry every frame, so while the panel is still
   *  springing to a new size the whole quadrant slides out from under a
   *  stationary pointer, `pointerleave` fires, and the arc shuts itself while
   *  you are reaching for it. A beat's grace covers that, and covers crossing
   *  the gap between two of the actions as well. */
  private closing = 0;
  /** The island's size is still travelling; see `ArcFrame.moving`. */
  private moving = false;

  /**
   * @param id      so the arc can be found from a test or a stylesheet.
   * @param corner  which end of the island it hangs off.
   * @param wake    asks for animation frames; the surface owns the loop.
   * @param reach   says the pointer is on the arc. ⚠️ Load-bearing: the arc is
   *                a SIBLING of the island, so reaching for it reads as leaving
   *                the island, and the island folds while you are on your way
   *                to its own close button. The surface decides what to do with
   *                that; what it must not do is find out from a mask it has not
   *                recomputed since the arc appeared.
   */
  constructor(
    id: string,
    private corner: ArcCorner,
    private wake: () => void,
    private reach: (on: boolean) => void,
  ) {
    this.host.id = id;
    this.host.hidden = true;
    this.svg.classList.add("arc-svg");
    this.svg.setAttribute("aria-hidden", "true");
    this.line.classList.add("arc-line");
    this.line.setAttribute("fill", "none");
    this.line.setAttribute("stroke-linecap", "round");
    this.band.classList.add("arc-band");
    this.band.setAttribute("fill", "none");
    this.band.setAttribute("stroke", "transparent");
    this.svg.append(this.line, this.band);
    this.acts.setAttribute("role", "toolbar");
    this.host.append(this.svg, this.acts);

    /* ⚠️ `pointerenter`/`pointerleave`, not `mouseover`/`mouseout` — the latter
     * fire again for every button inside, so the arc would shut while the
     * pointer was crossing from one action to the next.
     *
     * ⚠️ And focus as well as the pointer. The actions are `opacity: 0` while
     * it is closed; without this they are focusable and invisible, which is the
     * worst of both. */
    this.host.addEventListener("pointerenter", () => this.setOpen(true));
    this.host.addEventListener("pointerleave", () => this.leave());
    this.host.addEventListener("focusin", () => this.setOpen(true));
    this.host.addEventListener("focusout", () => this.leave());
  }

  /** Put it on the page. A sibling of `#island`, never a child of it. */
  mount(into: HTMLElement) { into.append(this.host); }

  get element(): HTMLElement { return this.host; }
  get hidden(): boolean { return this.host.hidden; }
  get settled(): boolean { return this.swing.settled; }
  step(dt: number) { this.swing.step(dt); }

  /** What is on it. Rebuilt whole: these lists are four items long. */
  setActions(actions: ArcAction[], label: string) {
    this.acts.setAttribute("aria-label", label);
    this.acts.replaceChildren();
    for (const [index, action] of actions.entries()) {
      const button = element("button", `arc-act${action.tone ? ` is-${action.tone}` : ""}`);
      (button as HTMLButtonElement).type = "button";
      if (action.id) button.id = action.id;
      (button as HTMLButtonElement).disabled = !!action.disabled || !action.run;
      button.setAttribute("aria-label", action.label);
      button.title = action.label;
      if (action.pressed !== undefined) {
        button.setAttribute("aria-pressed", String(action.pressed));
      }
      paintIcon(button, action.icon);
      if (action.run) button.onclick = action.run;
      /* The order they arrive in when the arc opens, counted from the island
       * outward: the line swings away from the corner, so the action nearest it
       * is the one the line reaches first. */
      button.style.setProperty("--tool-i", String(index));
      this.acts.append(button);
    }
    /* ⚠️ Snapped, not sprung. The list changes when the SCREEN changes, and two
     * animations on top of each other read as the arc flinching. It springs for
     * the one thing it does on its own: opening. */
    if (this.count !== actions.length && !this.opened) this.swing.snap(this.span(false));
    this.count = actions.length;
  }

  /** ⚠️ Re-tested when the timer fires, not when the pointer left. By then
   *  the shape may have moved back under the pointer — which is exactly the
   *  case this exists for — and `:hover` is the only thing that knows. */
  private leave() {
    clearTimeout(this.closing);
    this.closing = window.setTimeout(() => {
      if (this.host.matches(":hover")) return;
      if (this.host.contains(document.activeElement)) return;
      /* ⚠️ Not while the island is still travelling. The arc is placed from
       * the island's size, so a panel springing to a new height drags the whole
       * quadrant out from under a pointer that has not moved — and the arc
       * shuts itself while you are reaching for its close button. Wait for the
       * shape to stop, then ask `:hover` again, which by then is the truth. */
      if (this.moving) { this.leave(); return; }
      this.setOpen(false);
    }, 160);
  }

  private setOpen(on: boolean) {
    if (on) clearTimeout(this.closing);
    if (this.opened === on) return;
    this.opened = on;
    this.reach(on);
    this.host.classList.toggle("is-open", on);
    if (still()) this.swing.snap(this.span(on));
    else this.swing.setTarget(this.span(on));
    this.wake();
  }

  /** How far out the line is struck: closed, a gap past the corner; open, far
   *  enough that the actions on it do not touch.
   *
   * ⚠️ Measured to whatever is ON the circle, not to its centreline. The
   * clearance is the gap you can see between the island and the thing, and half
   * of an eight-pixel stroke — or half of a 28px disc — lives inside it. So the
   * line and the actions sit on different radii and share the one clearance,
   * which is the invariant that actually matters.
   *
   * ⚠️ Two or three actions need no room at all — they fit on the resting
   * circle — so the line does not move for them and the actions simply arrive.
   * It swings out only when it has to, which is what keeps a two-action screen
   * from flinging a line across the desktop to hold two buttons. */
  private span(open: boolean): number {
    const clear = this.seen + cpx(FRAME.islandArcClear);
    if (!open) return clear + cpx(FRAME.islandArcStroke) / 2;
    const sits = clear + cpx(FRAME.islandArcActSize) / 2;
    const step = (FRAME.islandArcTo - FRAME.islandArcFrom)
      / Math.max(1, this.count) * 2 * Math.PI;
    /* And far enough out that two neighbours do not touch: the chord between
     * them has to clear `islandArcStep`, which on a circle is `2r sin(step/2)`,
     * solved for r. */
    const needed = cpx(FRAME.islandArcStep) / 2 / Math.max(1e-3, Math.sin(step / 2));
    return Math.min(cpx(FRAME.islandArcReach) - 30, Math.max(sits, needed));
  }

  paint(frame: ArcFrame) {
    this.seen = frame.corner;
    this.moving = frame.moving;
    const show = frame.open && this.count > 0;
    this.host.hidden = !show;
    if (!show) return;

    const { dx, dy } = quadrant(frame.edge, this.corner);
    const vertical = isVertical(frame.edge);
    const reach = cpx(FRAME.islandArcReach);
    const radius = Math.max(this.span(false), this.swing.value);

    /* The centre of the corner the line is concentric with.
     *
     * ⚠️ The FLARE comes off the along-axis, and leaving it out is a whole
     * flare of error — about 30px. `notchPath` puts the rounded corners at
     * `curl` in from each end, because the ends are where the shape turns back
     * out to the bezel; only the across-axis runs to the box's own edge. Miss
     * it and the line is concentric with nothing, which reads as it being too
     * far out AND crooked while every radius involved is still correct. */
    const runs = vertical ? frame.height : frame.width;
    const along = this.corner === "far"
      ? runs - frame.curl - frame.corner
      : frame.curl + frame.corner;
    const across = (vertical ? frame.width : frame.height) - frame.corner;
    const cx = frame.x + (vertical
      ? (frame.edge === "left" ? across : frame.corner)
      : along);
    const cy = frame.y + (vertical
      ? along
      : (frame.edge === "bottom" ? frame.corner : across));

    /* The host is the quadrant outside that corner, and nothing else. ⚠️ It is
     * also what the window masks, and the window is DEAD to clicks wherever a
     * mask covers it — a box centred on the corner would make a square of
     * desktop three times this size unclickable for the sake of a quarter
     * circle of line. */
    Object.assign(this.host.style, {
      left: `${dx > 0 ? cx : cx - reach}px`,
      top: `${dy > 0 ? cy : cy - reach}px`,
      width: `${reach}px`,
      height: `${reach}px`,
      // It arrives with the fold rather than after it.
      opacity: String(Math.max(0, Math.min(1, frame.fold * 1.6 - 0.6))),
    });
    this.host.style.setProperty("--tool-size", `${cpx(FRAME.islandArcActSize)}px`);

    /* Everything below is in the host's own coordinates, with the corner's
     * centre at whichever of its corners the quadrant folds around. */
    const ox = dx > 0 ? 0 : reach;
    const oy = dy > 0 ? 0 : reach;
    this.svg.setAttribute("viewBox", `0 0 ${reach.toFixed(2)} ${reach.toFixed(2)}`);

    const base = baseTurn(dx, dy);
    const from = base + FRAME.islandArcFrom;
    const to = base + FRAME.islandArcTo;

    /* ⚠️ The LINE is shorter than the span the actions use. It is a hint that
     * something is here; run out to the actions' own ends it reaches the
     * island's straight edges and reads as a badly drawn continuation of
     * them. */
    const trim = FRAME.islandArcLineTrim;
    this.line.setAttribute("d", arcPath(ox, oy, radius, from + trim, to - trim));
    this.line.setAttribute("stroke-width", `${cpx(FRAME.islandArcStroke)}`);
    /* ⚠️ The line goes as the actions land on it. Both at once is a track with
     * beads on it, which is a different thing and a busier one. */
    this.line.style.opacity = `${1 - this.openness()}`;

    /* ⚠️ A transparent stroke wide enough to hover, and — the part that
     * matters — it does NOT move with the line. A band that followed it
     * oscillates: the pointer opens it, the line swings outward, the band goes
     * with it, the pointer is left over nothing, `pointerleave` fires, it shuts
     * — and the pointer has not moved, so it opens again. */
    const outer = this.span(true) + cpx(FRAME.islandArcHot);
    this.band.setAttribute("d",
      arcPath(ox, oy, (frame.corner + outer) / 2, from - 0.02, to + 0.02));
    this.band.setAttribute("stroke-width", `${Math.max(1, outer - frame.corner)}`);

    /* And the actions, laid ALONG it — which is the whole idea. Each sits at
     * its own angle on the same circle, so the row curves with the island's
     * corner rather than running off it in a straight line.
     *
     * ⚠️ Reversed where the quadrant points left, so both arcs read top to
     * bottom. Laid in sweep order they mirror each other, and the first control
     * on one side ends up facing the last on the other. */
    const list = [...this.acts.children] as HTMLElement[];
    for (const [index, act] of list.entries()) {
      const at = dx > 0 ? index : list.length - 1 - index;
      const turn = from + (to - from) * ((at + 0.5) / list.length);
      const angle = turn * 2 * Math.PI;
      act.style.left = `${ox + radius * Math.cos(angle)}px`;
      act.style.top = `${oy + radius * Math.sin(angle)}px`;
    }
  }

  /** 0 while the line is at rest, 1 once it is all the way out. */
  private openness(): number {
    const shut = this.span(false);
    const open = this.span(true);
    if (open - shut < 0.5) return this.opened ? 1 : 0;
    return Math.max(0, Math.min(1, (this.swing.value - shut) / (open - shut)));
  }
}
