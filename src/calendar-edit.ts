/* Direct manipulation on the week grid: drawing an event, moving one, and
 * changing how long it is.
 *
 * ⚠️ A SEPARATE file from `screen-calendar.ts`, the way `board-edit.ts` sits
 * beside `screen-board.ts`. The screen renders; this reaches into what it
 * rendered and moves it.
 *
 * ⚠️ **Nothing here re-renders mid-gesture.** The screen repaints wholesale on
 * `changed()`, so a drag that called it would destroy the element under the
 * pointer on the first move and the gesture would end on a node that is no
 * longer in the document. Everything between `pointerdown` and `pointerup` is
 * inline style on one block; `changed()` is for after.
 *
 * ⚠️ Positions are PIXELS off the shared `Axis`, never percentages. The axis
 * is piecewise — quiet hours collapse — so "40% down the column" does not name
 * an hour, and the renderer and this file have to agree about which pixel is
 * which time or a block jumps the moment it is picked up.
 */
import { element } from "./dom.ts";
import { SNAP, type Axis } from "./calendar-axis.ts";

/** One thing laid on the grid, as far as a gesture is concerned.
 *
 * ⚠️ `ref` is OPAQUE on purpose. The grid carries Google events and TickTick
 * tasks now, and they are written back through completely different commands —
 * but a drag does not care which it is holding, only where it ended up. The
 * screen puts a ref in and gets the same ref back; this file never looks
 * inside one, which is why adding tasks needed no gesture code at all. */
export interface Placed {
  id: string;
  ref: unknown;
  /** What to say when it cannot be moved. Empty means it can. */
  locked: string;
  start: number;
  end: number;
  column: number;
}

/** What a click with no drag in it means, in hours. ⚠️ A click has no
 *  duration, so one has to be invented; half an hour is the shortest thing
 *  anybody schedules and the easiest to lengthen afterwards. */
const CLICK_SPAN = 0.5;

/** How far the pointer must move before a press becomes a drag.
 *
 * ⚠️ Without this every click on a block is a one-pixel move, which is a write
 * to Google, a refresh, and an event that ends up seven minutes off because a
 * hand moved. The press only becomes a gesture once it has clearly left. */
const SLOP = 4;

/** How close to the bottom edge counts as "resize" rather than "move". */
const GRIP = 7;

/** The shortest a block may be drawn, in px. Matches the screen's own floor. */
const MIN_PX = 22;

export interface EditHooks {
  /** Draw a new event. Times are local-wall-clock, as a Date. */
  create: (start: Date, end: Date) => void;
  /** Move or resize something already on the grid. */
  move: (ref: unknown, start: Date, end: Date) => void;
  /** Say why a gesture was refused, or clear it with "". */
  say: (message: string) => void;
}

/** A local Date from a `YYYY-MM-DD` and an hour with a fraction.
 *
 * ⚠️ Built field by field rather than by parsing a string. `new Date("…T09:30")`
 * is parsed as local by every engine that matters and as UTC by some older
 * ones, and the failure mode is a meeting an hour out twice a year. */
export function atHour(day: string, hour: number): Date {
  const [y, m, d] = day.split("-").map(Number);
  const whole = Math.floor(hour);
  return new Date(y, (m || 1) - 1, d || 1, whole, Math.round((hour - whole) * 60), 0, 0);
}

/** Hour-of-day at a point inside a column.
 *
 * ⚠️ Through the AXIS, which knows where the collapsed bands are. Dividing the
 * column's height by a span would place every hour after a band on the wrong
 * line. */
export function hourAtPoint(clientY: number, box: { top: number }, axis: Axis): number {
  return axis.hourAt(clientY - box.top);
}

/** Where a block sits, in the axis's own pixels. */
function place(block: HTMLElement, start: number, end: number, axis: Axis) {
  const top = axis.yOf(start);
  block.style.top = `${top}px`;
  block.style.height = `${Math.max(MIN_PX, axis.yOf(end) - top)}px`;
}

/** Wire one rendered week body for editing.
 *
 * `columns` must be in the same order as `days`. Returns nothing: the
 * listeners live as long as the elements do, and the screen throws the whole
 * body away on every render.
 */
export function wireWeekEditing(
  body: HTMLElement,
  columns: HTMLElement[],
  axis: Axis,
  days: string[],
  hooks: EditHooks,
) {
  /* ── Drawing a new event ───────────────────────────────────────────── */
  for (const [index, column] of columns.entries()) {
    column.addEventListener("pointerdown", event => {
      /* ⚠️ Only a press on the column ITSELF or on one of its hour lines. A
       * press that started on a block is that block's gesture, and without
       * this check drawing a new event on top of an existing one was the
       * easiest thing on the grid to do by accident.
       *
       * ⚠️ The hour lines have to be allowed explicitly: they tile the whole
       * column, so almost every press on "empty" space actually lands on one.
       * Testing only for the column itself made the gesture work on the few
       * pixels between them and nowhere else. */
      const on = event.target as HTMLElement;
      if (on !== column && !on.classList.contains("cal-wkline")) return;
      /* ⚠️ And never inside a collapsed hour. 13px cannot hold an event, and a
       * drag that started there would draw one nobody can see. The band over
       * it is a button that opens those hours instead. */
      if (on.classList.contains("is-shut")) return;
      if (event.button !== 0) return;
      const day = days[index];
      if (!day) return;
      event.preventDefault();
      hooks.say("");

      const box = column.getBoundingClientRect();
      const anchor = hourAtPoint(event.clientY, box, axis);
      const ghost = element("div", "cal-block cal-ghost");
      ghost.append(element("span", "cal-block-title", "New event"));
      place(ghost, anchor, anchor + CLICK_SPAN, axis);
      column.append(ghost);
      column.setPointerCapture(event.pointerId);

      let lo = anchor;
      let hi = anchor + CLICK_SPAN;
      let moved = false;
      const onMove = (step: PointerEvent) => {
        if (Math.abs(step.clientY - event.clientY) > SLOP) moved = true;
        const now = hourAtPoint(step.clientY, box, axis);
        /* ⚠️ Dragging UPWARD is a real gesture and has to mean the same thing.
         * Sorting the two ends is the whole of it, and leaving it out makes an
         * upward drag produce a negative height, which CSS clamps to the floor
         * — so it looks like the grid ignores you. */
        lo = Math.min(anchor, now);
        hi = Math.max(anchor, now);
        if (!moved || hi - lo < SNAP) { lo = anchor; hi = anchor + CLICK_SPAN; }
        place(ghost, lo, hi, axis);
      };
      const done = (step: PointerEvent) => {
        column.releasePointerCapture(step.pointerId);
        column.removeEventListener("pointermove", onMove);
        column.removeEventListener("pointerup", done);
        column.removeEventListener("pointercancel", cancel);
        ghost.remove();
        hooks.create(atHour(day, lo), atHour(day, Math.min(24, hi)));
      };
      const cancel = () => {
        column.removeEventListener("pointermove", onMove);
        column.removeEventListener("pointerup", done);
        column.removeEventListener("pointercancel", cancel);
        ghost.remove();
      };
      column.addEventListener("pointermove", onMove);
      column.addEventListener("pointerup", done);
      column.addEventListener("pointercancel", cancel);
    });
  }

  /* ── Moving and resizing what is already there ─────────────────────── */
  for (const block of body.querySelectorAll<HTMLElement>(".cal-block[data-cal-id]")) {
    const id = block.dataset.calId!;
    const source = blocks.get(id);
    if (!source) continue;
    if (source.locked) {
      /* ⚠️ Marked rather than silently inert. A block that cannot move should
       * say so on approach — the alternative is a drag that does nothing,
       * which reads as the app being broken rather than as the calendar being
       * somebody else's. */
      block.classList.add("is-locked");
      block.dataset.tip = source.locked;
      continue;
    }
    block.classList.add("is-live");

    block.addEventListener("pointerdown", event => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      hooks.say("");

      const box = block.getBoundingClientRect();
      const resizing = event.clientY >= box.bottom - GRIP;
      const startHour = source.start;
      const endHour = source.end;
      /* ⚠️ Every column's box is measured ONCE, at the start. Reading them per
       * pointermove is a forced layout on every frame of a drag, and the boxes
       * cannot move anyway — the grid is not scrolling while a pointer is
       * captured on it. */
      const boxes = columns.map(one => one.getBoundingClientRect());
      const grabbed = hourAtPoint(event.clientY, boxes[source.column], axis);
      let column$ = source.column;
      let lo = startHour;
      let hi = endHour;
      let moved = false;

      block.setPointerCapture(event.pointerId);
      block.classList.add("is-dragging");

      const onMove = (step: PointerEvent) => {
        if (Math.abs(step.clientY - event.clientY) > SLOP
          || Math.abs(step.clientX - event.clientX) > SLOP) moved = true;
        if (!moved) return;
        const over = hourAtPoint(step.clientY, boxes[column$], axis);
        if (resizing) {
          /* ⚠️ The END only, and never above the start. A resize that can
           * cross its own beginning is a drag that silently turns into a move
           * halfway through. */
          hi = Math.max(lo + SNAP, over);
        } else {
          const drift = over - grabbed;
          const length = endHour - startHour;
          lo = Math.min(24 - length, Math.max(0, startHour + drift));
          hi = lo + length;
          /* Which day the pointer is over, so a block can cross columns. */
          const found = boxes.findIndex(one => step.clientX >= one.left && step.clientX <= one.right);
          if (found >= 0 && found !== column$) {
            column$ = found;
            columns[found].append(block);
          }
        }
        place(block, lo, hi, axis);
      };
      const finish = (step: PointerEvent) => {
        block.releasePointerCapture(step.pointerId);
        block.removeEventListener("pointermove", onMove);
        block.removeEventListener("pointerup", finish);
        block.removeEventListener("pointercancel", abort);
        block.classList.remove("is-dragging");
        /* ⚠️ A press that never became a drag is left ALONE, so the block's own
         * click opens the detail panel exactly as it always did. Calling
         * `click()` here instead would fire it twice — `preventDefault` on
         * `pointerdown` suppresses selection and focus, not the click — and
         * the panel would open and immediately close again. */
        if (!moved) return;
        /* ⚠️ And a press that DID become a drag has to have its click eaten.
         * The browser still sends one after the gesture, and without this every
         * move ends by opening the panel for the event just dropped. */
        block.addEventListener("click", stop => {
          stop.preventDefault();
          stop.stopPropagation();
        }, { capture: true, once: true });
        const day = days[column$];
        if (!day) return;
        hooks.move(source.ref, atHour(day, lo), atHour(day, hi));
      };
      const abort = () => {
        block.removeEventListener("pointermove", onMove);
        block.removeEventListener("pointerup", finish);
        block.removeEventListener("pointercancel", abort);
        block.classList.remove("is-dragging");
        place(block, startHour, endHour, axis);
      };
      block.addEventListener("pointermove", onMove);
      block.addEventListener("pointerup", finish);
      block.addEventListener("pointercancel", abort);
    });
  }
}

/** Where each rendered block came from.
 *
 * ⚠️ A module-level map filled by the screen as it draws, rather than data
 * attributes read back off the DOM. The gesture needs the event DROP — its
 * calendar id, whether it is writable — and round-tripping that through
 * `dataset` means serialising and re-parsing it on every render for the one
 * gesture in a hundred renders that uses it.
 */
const blocks = new Map<string, Placed>();

/** Called by the screen before it wires a freshly drawn week. */
export function rememberBlocks(entries: Placed[]) {
  blocks.clear();
  for (const one of entries) blocks.set(one.id, one);
}

/* ── Dragging a task in from the list ─────────────────────────────────────
 * ⚠️ A POINTER drag, not HTML5 drag-and-drop. The island is a transparent,
 * non-activating window: the native drag image is a screenshot the compositor
 * takes of an element that has no opaque background, and `dragover` does not
 * fire reliably across it. Everything else in this app that drags — the board's
 * arrange, the shelf's drop — is pointer-based for the same reason.
 */
export interface DropHooks {
  /** Where the pointer is, as a column index and an hour, or null if it is
   *  not over the grid. */
  at: (clientX: number, clientY: number) => { column: number; hour: number } | null;
  /** Land it. */
  drop: (ref: unknown, column: number, hour: number) => void;
  /** How long a dropped thing should be, in hours. */
  span: number;
}

/** Make one row of the task list draggable onto the grid. */
export function wireTaskDrag(row: HTMLElement, ref: unknown, label: string, hooks: DropHooks) {
  row.addEventListener("pointerdown", event => {
    if (event.button !== 0) return;
    /* ⚠️ Not on the checkbox. It is a control inside the drag handle, and
     * without this every tick started a drag that ate the click. */
    if ((event.target as HTMLElement).closest("[data-no-drag]")) return;
    event.preventDefault();

    let ghost: HTMLElement | null = null;
    let over: { column: number; hour: number } | null = null;
    const onMove = (step: PointerEvent) => {
      if (!ghost) {
        if (Math.abs(step.clientX - event.clientX) < SLOP
          && Math.abs(step.clientY - event.clientY) < SLOP) return;
        ghost = element("div", "cal-tdrag");
        ghost.append(element("span", "", label));
        document.body.append(ghost);
        row.classList.add("is-lifting");
      }
      /* ⚠️ `position: fixed` and placed from the CLIENT coordinates, so the
       * ghost is right wherever the island happens to be on the screen —
       * offsets relative to any container would be wrong the moment the notch
       * moved along its edge. */
      ghost.style.left = `${step.clientX + 12}px`;
      ghost.style.top = `${step.clientY + 10}px`;
      over = hooks.at(step.clientX, step.clientY);
      ghost.classList.toggle("is-over", !!over);
    };
    const done = (step: PointerEvent) => {
      row.releasePointerCapture(step.pointerId);
      row.removeEventListener("pointermove", onMove);
      row.removeEventListener("pointerup", done);
      row.removeEventListener("pointercancel", cancel);
      row.classList.remove("is-lifting");
      ghost?.remove();
      /* ⚠️ No ghost means the pointer never left, so this was a click and the
       * row's own handler owns it. */
      if (!ghost) return;
      /* And a drag that ends anywhere but the grid is a drag that was thought
       * better of — not an error, and not a reason to schedule anything. */
      if (over) hooks.drop(ref, over.column, over.hour);
    };
    const cancel = () => {
      row.removeEventListener("pointermove", onMove);
      row.removeEventListener("pointerup", done);
      row.removeEventListener("pointercancel", cancel);
      row.classList.remove("is-lifting");
      ghost?.remove();
    };
    row.setPointerCapture(event.pointerId);
    row.addEventListener("pointermove", onMove);
    row.addEventListener("pointerup", done);
    row.addEventListener("pointercancel", cancel);
  });
}

/** Which column and hour a screen point is over, or null.
 *
 * ⚠️ Measured FRESH on every call rather than cached like the move gesture's
 * boxes. A task drag can scroll the grid under itself — the pointer is
 * captured on the list, not on the columns — so a cached rect would land the
 * drop at the hour that was there when the drag started. */
export function pointOver(columns: HTMLElement[], axis: Axis, clientX: number, clientY: number) {
  for (const [index, column] of columns.entries()) {
    const box = column.getBoundingClientRect();
    if (clientX < box.left || clientX > box.right) continue;
    if (clientY < box.top || clientY > box.bottom) return null;
    return { column: index, hour: axis.hourAt(clientY - box.top) };
  }
  return null;
}
