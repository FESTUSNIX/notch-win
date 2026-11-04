/* Direct manipulation on the time grid: drawing an event, moving one across
 * days, and changing how long it is from either edge. Helm's grid is the model
 * (`components/calendar/use-grid-gestures.ts`).
 *
 * One gesture at a time, followed on the WINDOW. Once a press becomes a drag the
 * scroller holds the pointer, because the block itself moves between columns and
 * an element that is re-appended loses its capture: that was a fast drag across
 * days ending stuck and unsaved.
 *
 * The screen does not redraw during a gesture (`busy`), so the elements under the
 * pointer stay in the document. A cancelled gesture is put back by the redraw
 * that follows it, not by undoing each change here.
 *
 * Positions are pixels off the shared `Axis`, because quiet hours collapse and a
 * percentage down the column names no hour.
 */
import { element } from "./dom.ts";
import { SNAP, type Axis } from "./calendar-axis.ts";

/** One thing laid on the grid, as far as a gesture is concerned. `ref` is opaque:
 *  the screen puts an event or a task in and gets the same one back. */
export interface Placed {
  id: string;
  ref: unknown;
  /** What to say when it cannot be moved. Empty means it can. */
  locked: string;
  start: number;
  end: number;
  column: number;
  /** The longest it may be, in hours: Helm's blocks stop at three. */
  maxHours?: number;
}

export type GestureKind = "move" | "resize-start" | "resize-end" | "create";

export interface Span {
  column: number;
  start: number;
  end: number;
}

/** What a click on empty time proposes, in hours. */
const CLICK_SPAN = 0.5;
/** How far the pointer must move before a press becomes a drag: a click stays a
 *  click, and a shaky hand doesn't move a meeting. */
const SLOP = 4;
/** How close to an edge counts as resizing rather than moving. */
const GRIP = 7;
/** The shortest a block is drawn, in px. Matches the screen's own floor. */
const MIN_PX = 22;
/** How near the top or bottom the grid starts scrolling, and its fastest step. */
const EDGE = 40;
const MAX_SCROLL = 14;
/** How often Escape is asked after while a drag runs in the real window. */
const ESCAPE_POLL_MS = 90;

export interface EditHooks {
  /** A new range, drawn or clicked. Times are local wall clock. */
  create: (start: Date, end: Date) => void;
  /** Something on the grid has a new time. */
  move: (ref: unknown, start: Date, end: Date) => void;
  /** Hold redraws and keep the island up while a press is live. */
  busy: (on: boolean) => void;
  /** A drag began: whatever is open about the grid steps aside. */
  started: () => void;
  /** Something is open, so a click on empty time only closes it. */
  dismissing: () => boolean;
  /** That click: close what is open. */
  dismiss: () => void;
  /** Draw what is true again, after a gesture that changed nothing. */
  repaint: () => void;
  /** Whether Escape is down. The island doesn't hold the keyboard while a block
   *  is dragged, so in the real window the page never hears the key. */
  escapeDown?: () => Promise<boolean>;
}

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
const snapped = (hour: number) => Math.round(hour / SNAP) * SNAP;

/** Where a gesture puts things for the pointer's position. Pure, and the half of
 *  this file that is tested without a browser.
 *
 * @param grab `move`: hours between the pointer and the start when pressed.
 *             `create`: the hour pressed. Unused by a resize. */
export function gestureSpan(
  kind: GestureKind,
  origin: Span,
  grab: number,
  over: { column: number; hour: number },
  maxHours = 24,
): Span {
  if (kind === "move") {
    const length = origin.end - origin.start;
    const start = clamp(snapped(over.hour - grab), 0, 24 - length);
    return { column: over.column, start, end: start + length };
  }
  if (kind === "resize-end") {
    return { ...origin, end: clamp(snapped(over.hour), origin.start + SNAP, Math.min(24, origin.start + maxHours)) };
  }
  if (kind === "resize-start") {
    return { ...origin, start: clamp(snapped(over.hour), Math.max(0, origin.end - maxHours), origin.end - SNAP) };
  }
  // Drawing, upward as well as down, and at least a quarter of an hour.
  const anchor = Math.floor(grab / SNAP) * SNAP;
  const to = clamp(snapped(over.hour), 0, 24);
  const start = Math.min(anchor, to);
  const end = to > anchor ? to : anchor + SNAP;
  return { column: origin.column, start: Math.min(start, 24 - SNAP), end: Math.min(end, 24) };
}

/** A local Date from a `YYYY-MM-DD` and an hour with a fraction, built field by
 *  field so no engine reads it as UTC. */
export function atHour(day: string, hour: number): Date {
  const [y, m, d] = day.split("-").map(Number);
  const whole = Math.floor(hour);
  return new Date(y, (m || 1) - 1, d || 1, whole, Math.round((hour - whole) * 60), 0, 0);
}

/** Hour-of-day at a point inside a column, through the axis and its bands. */
export function hourAtPoint(clientY: number, box: { top: number }, axis: Axis): number {
  return axis.hourAt(clientY - box.top);
}

/** An event's start and end as hours of the day it starts on. Ending at the next
 *  midnight is 24, not 0, and `crosses` says it runs on beyond that. */
export function hoursWithin(begin: Date, finish: Date): { start: number; end: number; crosses: boolean } {
  const start = begin.getHours() + begin.getMinutes() / 60;
  const nextDay = new Date(begin.getFullYear(), begin.getMonth(), begin.getDate() + 1);
  if (finish.getTime() > nextDay.getTime()) return { start, end: 24, crosses: true };
  if (finish.getTime() === nextDay.getTime()) return { start, end: 24, crosses: false };
  return { start, end: Math.max(start + SNAP, finish.getHours() + finish.getMinutes() / 60), crosses: false };
}

/** Which of the columns an x falls in; off either side counts as the nearest. */
export function columnAt(boxes: { left: number; right: number }[], x: number): number {
  const inside = boxes.findIndex(box => x >= box.left && x <= box.right);
  if (inside >= 0) return inside;
  // In a gap between two columns, or off either side: whichever is closest.
  let best = 0;
  let distance = Infinity;
  for (const [index, box] of boxes.entries()) {
    const away = Math.min(Math.abs(x - box.left), Math.abs(x - box.right));
    if (away < distance) { distance = away; best = index; }
  }
  return best;
}

/** How far to scroll for a pointer at `y`: faster the nearer the edge. */
export function edgeStep(y: number, top: number, bottom: number): number {
  if (y < top + EDGE) return -MAX_SCROLL * Math.min(1, (top + EDGE - y) / EDGE);
  if (y > bottom - EDGE) return MAX_SCROLL * Math.min(1, (y - (bottom - EDGE)) / EDGE);
  return 0;
}

const clock = (hour: number) => {
  const whole = Math.floor(hour) % 24;
  return `${String(whole).padStart(2, "0")}:${String(Math.round((hour - Math.floor(hour)) * 60)).padStart(2, "0")}`;
};

/** Where a block sits, in the axis's own pixels. */
function place(block: HTMLElement, start: number, end: number, axis: Axis) {
  const top = axis.yOf(start);
  block.style.top = `${top}px`;
  block.style.height = `${Math.max(MIN_PX, axis.yOf(end) - top)}px`;
}

/** The click a finished drag produces goes nowhere. */
function swallowNextClick() {
  const swallow = (event: MouseEvent) => {
    event.stopPropagation();
    event.preventDefault();
  };
  window.addEventListener("click", swallow, { capture: true, once: true });
  // The click, if one comes, arrives with the pointerup, before any timer.
  setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
}

/** Wire one drawn grid. `columns` is in the order of `days`, and the listeners
 *  live as long as `body`, which the screen replaces on every draw. */
export function wireWeekEditing(
  scroller: HTMLElement,
  body: HTMLElement,
  columns: HTMLElement[],
  axis: Axis,
  days: string[],
  hooks: EditHooks,
) {
  for (const block of body.querySelectorAll<HTMLElement>(".cal-block[data-cal-id]")) {
    const source = blocks.get(block.dataset.calId!);
    if (!source) continue;
    if (source.locked) {
      block.classList.add("is-locked");
      block.dataset.tip = source.locked;
    } else {
      block.classList.add("is-live");
    }
  }

  const stuckBottom = () => scroller.querySelector(".cal-wkstick")?.getBoundingClientRect().bottom;

  body.addEventListener("pointerdown", press => {
    if (press.button !== 0) return;
    const on = press.target as HTMLElement;
    if (on.closest(".cal-panel, .cal-draft, .cal-wkband, .cal-wkaxis, [data-no-drag]")) return;

    const element$ = on.closest<HTMLElement>(".cal-block[data-cal-id]");
    const source = element$ ? blocks.get(element$.dataset.calId!) ?? null : null;
    if (element$ && (!source || source.locked)) return;
    if (!element$ && on.closest(".cal-block")) return;
    if (!element$ && on.classList.contains("is-shut")) return;
    const pressed = on.closest<HTMLElement>(".cal-wkcol");
    if (!pressed) return;
    const pressedColumn = columns.indexOf(pressed);
    if (pressedColumn < 0 || !days[pressedColumn]) return;

    press.preventDefault();
    const hourNow = (y: number) => axis.hourAt(y - columns[0].getBoundingClientRect().top);

    let kind: GestureKind = "create";
    if (element$) {
      const box = element$.getBoundingClientRect();
      const zone = Math.min(GRIP, box.height / 3);
      kind = press.clientY <= box.top + zone ? "resize-start"
        : press.clientY >= box.bottom - zone ? "resize-end" : "move";
    }
    const pressHour = hourNow(press.clientY);
    const origin: Span = source
      ? { column: source.column, start: source.start, end: source.end }
      : { column: pressedColumn, start: pressHour, end: pressHour + CLICK_SPAN };
    const grab = source ? pressHour - source.start : pressHour;
    const dismissing = !source && hooks.dismissing();

    hooks.busy(true);
    /* `preventDefault` kept focus from moving, so a field in the panel or a draft
     * has to be told it's over. It keeps what was typed. */
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && focused.closest(".cal-panel, .cal-draft, .cal-quick")) focused.blur();
    let armed = false;
    let span = origin;
    let pointer = { x: press.clientX, y: press.clientY };
    let frame = 0;
    let escapeTimer = 0;
    let ghost: HTMLElement | null = null;
    const stamp = element$ ? element$.querySelector<HTMLElement>(".cal-block-time") : null;

    /** Put the block or the ghost where the pointer says. */
    const update = () => {
      const boxes = columns.map(one => one.getBoundingClientRect());
      const over = { column: columnAt(boxes, pointer.x), hour: axis.hourAt(pointer.y - boxes[0].top) };
      const next = gestureSpan(kind, origin, grab, over, source?.maxHours);
      span = next;
      const target = ghost ?? element$!;
      if (target.parentElement !== columns[next.column]) columns[next.column].append(target);
      place(target, next.start, next.end, axis);
      const label = `${clock(next.start)} – ${clock(next.end)}`;
      if (ghost) ghost.querySelector<HTMLElement>(".cal-block-time")!.textContent = label;
      else {
        const shown = stamp ?? element$!.querySelector<HTMLElement>(".cal-block-time");
        if (shown) shown.textContent = label;
        else element$!.append(element("span", "cal-block-time", label));
      }
    };

    const tick = () => {
      const box = scroller.getBoundingClientRect();
      const step = edgeStep(pointer.y, stuckBottom() ?? box.top, box.bottom);
      if (step) {
        scroller.scrollBy({ top: step });
        update();
      }
      frame = requestAnimationFrame(tick);
    };

    const arm = () => {
      armed = true;
      /* From here the scroller owns the pointer, wherever it goes. */
      try { scroller.setPointerCapture(press.pointerId); } catch { /* already gone */ }
      scroller.addEventListener("lostpointercapture", lost);
      document.body.dataset.calGesture = kind;
      hooks.started();
      if (source) {
        element$!.classList.add("is-dragging");
        // Full width while it travels; the lanes are for what stays put.
        element$!.style.removeProperty("left");
        element$!.style.removeProperty("width");
        element$!.style.removeProperty("right");
      } else {
        ghost = element("div", "cal-block cal-ghost");
        ghost.append(element("span", "cal-block-title", "New event"), element("span", "cal-block-time"));
        columns[pressedColumn].append(ghost);
      }
      frame = requestAnimationFrame(tick);
      if (hooks.escapeDown) {
        const ask = hooks.escapeDown;
        escapeTimer = window.setInterval(() => {
          void ask().then(down => { if (down) finish(false); }).catch(() => {});
        }, ESCAPE_POLL_MS);
      }
      update();
    };

    let finished = false;
    /** A drag ended, by a release (`commit`) or by being called off. */
    function finish(commit: boolean) {
      if (finished) return;
      finished = true;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKey, true);
      scroller.removeEventListener("lostpointercapture", lost);
      cancelAnimationFrame(frame);
      clearInterval(escapeTimer);
      delete document.body.dataset.calGesture;
      ghost?.remove();
      try { scroller.releasePointerCapture(press.pointerId); } catch { /* not held */ }
      hooks.busy(false);

      const day = days[span.column];
      if (!armed) {
        // A plain click on empty time proposes a slot, unless it's closing something.
        if (commit && kind === "create" && dismissing) hooks.dismiss();
        else if (commit && kind === "create" && days[pressedColumn]) {
          const from = clamp(Math.floor(pressHour / SNAP) * SNAP, 0, 24 - CLICK_SPAN);
          hooks.create(atHour(days[pressedColumn], from), atHour(days[pressedColumn], from + CLICK_SPAN));
        }
        return;
      }
      swallowNextClick();
      const changed = kind === "create"
        || span.column !== origin.column || span.start !== origin.start || span.end !== origin.end;
      if (!commit || !changed || !day) {
        hooks.repaint();
        return;
      }
      if (kind === "create") hooks.create(atHour(day, span.start), atHour(day, span.end));
      else hooks.move(source!.ref, atHour(day, span.start), atHour(day, span.end));
    }

    function onMove(step: PointerEvent) {
      if (step.pointerId !== press.pointerId) return;
      // The button came up somewhere nobody heard about.
      if (step.pointerType === "mouse" && step.buttons === 0) { finish(false); return; }
      pointer = { x: step.clientX, y: step.clientY };
      if (!armed) {
        if (Math.hypot(step.clientX - press.clientX, step.clientY - press.clientY) < SLOP) return;
        arm();
        return;
      }
      step.preventDefault();
      update();
    }
    function onUp(step: PointerEvent) {
      if (step.pointerId === press.pointerId) finish(true);
    }
    function onCancel(step: PointerEvent) {
      if (step.pointerId === press.pointerId) finish(false);
    }
    function lost() { finish(false); }
    function onKey(key: KeyboardEvent) {
      if (key.key !== "Escape" || !armed) return;
      key.preventDefault();
      key.stopPropagation();
      finish(false);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey, true);
  });
}

export interface MonthHooks {
  /** Dropped on another day, keeping its time. */
  move: (ref: unknown, start: Date, end: Date) => void;
  busy: (on: boolean) => void;
  started: () => void;
  repaint: () => void;
  escapeDown?: () => Promise<boolean>;
}

/** Timed things on the month grid can be dragged to another day. */
export function wireMonthDrag(scroller: HTMLElement, grid: HTMLElement, hooks: MonthHooks) {
  for (const chip of grid.querySelectorAll<HTMLElement>(".cal-mchip[data-cal-id]")) {
    const source = blocks.get(chip.dataset.calId!);
    if (source && !source.locked) chip.classList.add("is-live");
    else if (source) chip.dataset.tip = source.locked;
  }
  grid.addEventListener("pointerdown", press => {
    if (press.button !== 0) return;
    const chip = (press.target as HTMLElement).closest<HTMLElement>(".cal-mchip[data-cal-id]");
    const source = chip ? blocks.get(chip.dataset.calId!) : null;
    if (!chip || !source || source.locked) return;
    press.preventDefault();
    hooks.busy(true);
    const from = chip.closest<HTMLElement>(".cal-mcell")?.dataset.day ?? "";
    let armed = false;
    let over: HTMLElement | null = null;
    let ghost: HTMLElement | null = null;
    let escapeTimer = 0;
    const mark = (cell: HTMLElement | null) => {
      if (cell === over) return;
      over?.classList.remove("is-drop");
      cell?.classList.add("is-drop");
      over = cell;
    };
    function finish(commit: boolean) {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKey, true);
      scroller.removeEventListener("lostpointercapture", onLost);
      clearInterval(escapeTimer);
      delete document.body.dataset.calGesture;
      ghost?.remove();
      chip!.classList.remove("is-lifted");
      const day = over?.dataset.day;
      mark(null);
      try { scroller.releasePointerCapture(press.pointerId); } catch { /* not held */ }
      hooks.busy(false);
      if (!armed) return;
      swallowNextClick();
      if (!commit || !day || day === from) { hooks.repaint(); return; }
      hooks.move(source!.ref, atHour(day, source!.start), atHour(day, source!.end));
    }
    function onMove(step: PointerEvent) {
      if (step.pointerId !== press.pointerId) return;
      if (step.pointerType === "mouse" && step.buttons === 0) { finish(false); return; }
      if (!armed) {
        if (Math.hypot(step.clientX - press.clientX, step.clientY - press.clientY) < SLOP) return;
        armed = true;
        try { scroller.setPointerCapture(press.pointerId); } catch { /* already gone */ }
        scroller.addEventListener("lostpointercapture", onLost);
        document.body.dataset.calGesture = "move";
        chip!.classList.add("is-lifted");
        hooks.started();
        ghost = element("div", "cal-tdrag is-over");
        ghost.append(element("span", "", chip!.querySelector(".cal-mchip-title")?.textContent ?? ""));
        document.body.append(ghost);
        if (hooks.escapeDown) {
          const ask = hooks.escapeDown;
          escapeTimer = window.setInterval(() => {
            void ask().then(down => { if (down) finish(false); }).catch(() => {});
          }, ESCAPE_POLL_MS);
        }
      }
      step.preventDefault();
      ghost!.style.left = `${step.clientX + 12}px`;
      ghost!.style.top = `${step.clientY + 10}px`;
      const under = document.elementFromPoint(step.clientX, step.clientY);
      mark(under ? under.closest<HTMLElement>(".cal-mcell") : null);
    }
    function onUp(step: PointerEvent) { if (step.pointerId === press.pointerId) finish(true); }
    function onCancel(step: PointerEvent) { if (step.pointerId === press.pointerId) finish(false); }
    function onLost() { finish(false); }
    function onKey(key: KeyboardEvent) {
      if (key.key !== "Escape" || !armed) return;
      key.preventDefault();
      key.stopPropagation();
      finish(false);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey, true);
  });
}

/** Where each rendered block came from: filled by the screen as it draws, so a
 *  gesture has the event itself rather than what survives a data attribute. */
const blocks = new Map<string, Placed>();

/** Called by the screen before it wires a freshly drawn grid. */
export function rememberBlocks(entries: Placed[]) {
  blocks.clear();
  for (const one of entries) blocks.set(one.id, one);
}

/* ── Dragging a task in from the list ─────────────────────────────────────
 * A pointer drag, not HTML5 drag-and-drop: the island is a transparent,
 * non-activating window, and native drag images and `dragover` don't hold up on it.
 */
export interface DropHooks {
  /** Where the pointer is, as a column index and an hour, or null off the grid. */
  at: (clientX: number, clientY: number) => { column: number; hour: number } | null;
  /** Land it. */
  drop: (ref: unknown, column: number, hour: number) => void;
  /** How long a dropped thing should be, in hours. */
  span: number;
  /** Hold redraws while the row is in the air. */
  busy?: (on: boolean) => void;
}

/** Make one row of the task list draggable onto the grid. */
export function wireTaskDrag(row: HTMLElement, ref: unknown, label: string, hooks: DropHooks) {
  row.addEventListener("pointerdown", event => {
    if (event.button !== 0) return;
    /* Not on the checkbox: it's a control inside the drag handle. */
    if ((event.target as HTMLElement).closest("[data-no-drag]")) return;
    event.preventDefault();

    let ghost: HTMLElement | null = null;
    let over: { column: number; hour: number } | null = null;
    hooks.busy?.(true);
    const stop = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", done);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", onKey, true);
      try { row.releasePointerCapture(event.pointerId); } catch { /* not held */ }
      row.classList.remove("is-lifting");
      ghost?.remove();
      hooks.busy?.(false);
    };
    function onMove(step: PointerEvent) {
      if (!ghost) {
        if (Math.abs(step.clientX - event.clientX) < SLOP
          && Math.abs(step.clientY - event.clientY) < SLOP) return;
        ghost = element("div", "cal-tdrag");
        ghost.append(element("span", "", label));
        document.body.append(ghost);
        row.classList.add("is-lifting");
      }
      /* `position: fixed`, from client coordinates: right wherever the island is. */
      ghost.style.left = `${step.clientX + 12}px`;
      ghost.style.top = `${step.clientY + 10}px`;
      over = hooks.at(step.clientX, step.clientY);
      ghost.classList.toggle("is-over", !!over);
    }
    function done() {
      const flew = !!ghost;
      stop();
      // No ghost: a click, which the row's own handler owns. Off the grid: thought better of.
      if (flew && over) hooks.drop(ref, over.column, over.hour);
    }
    function cancel() { stop(); }
    function onKey(key: KeyboardEvent) {
      if (key.key !== "Escape" || !ghost) return;
      key.preventDefault();
      key.stopPropagation();
      stop();
    }
    row.setPointerCapture(event.pointerId);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", done);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", onKey, true);
  });
}

/** Which column and hour a screen point is over, or null. Measured fresh: the
 *  grid can scroll under a task drag. */
export function pointOver(columns: HTMLElement[], axis: Axis, clientX: number, clientY: number) {
  const boxes = columns.map(one => one.getBoundingClientRect());
  if (!boxes.length || clientX < boxes[0].left || clientX > boxes[boxes.length - 1].right) return null;
  // The gaps between days count as the nearest day, or a drop there is silently lost.
  const index = columnAt(boxes, clientX);
  const box = boxes[index];
  if (clientY < box.top || clientY > box.bottom) return null;
  return { column: index, hour: axis.hourAt(clientY - box.top) };
}

/* ── Overlaps ─────────────────────────────────────────────────────────────── */

export interface LaneItem {
  top: number;
  bottom: number;
}

/** Side by side, in lanes, instead of on top of each other. Works on drawn pixels,
 *  because two short meetings can touch on screen without overlapping in time.
 *  Everything that overlaps, even indirectly, shares a lane count, so widths in a
 *  cluster match. Returns one entry per item, in the order given. */
export function layoutLanes(items: LaneItem[]): { lane: number; lanes: number }[] {
  const order = items.map((_, index) => index)
    .sort((a, b) => items[a].top - items[b].top || items[b].bottom - items[a].bottom);
  const out = items.map(() => ({ lane: 0, lanes: 1 }));
  let cluster: number[] = [];
  let ends: number[] = [];
  let reach = -Infinity;
  const close = () => {
    for (const index of cluster) out[index].lanes = ends.length;
    cluster = [];
    ends = [];
  };
  for (const index of order) {
    const item = items[index];
    if (item.top >= reach) { close(); reach = -Infinity; }
    let lane = ends.findIndex(end => end <= item.top);
    if (lane < 0) { lane = ends.length; ends.push(item.bottom); } else ends[lane] = item.bottom;
    out[index].lane = lane;
    cluster.push(index);
    reach = Math.max(reach, item.bottom);
  }
  close();
  return out;
}
