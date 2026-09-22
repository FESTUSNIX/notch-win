/* Arranging a board by hand.
 *
 * One gesture does everything: drag a block along the row to reorder it, drag a
 * tile out of the tray into the row to add it, drag a block off the row to take
 * it away. There is no mode inside the mode.
 *
 * ⚠️ POINTER events, not HTML5 drag and drop — Tauri intercepts drag at the
 * window to implement file drop, so `dragstart` never reaches the page. It
 * works perfectly in a browser, which is exactly what makes it the wrong
 * choice: the bug would only exist in the app.
 *
 * ⚠️ The shuffle is FLIP — measure, move in the DOM, measure again, then play
 * the difference backwards. The first version laid the blocks out arithmetically
 * along the x axis, which was fine while a board was one row and wrong the day
 * the row learned to WRAP: seats computed as a running sum put the blocks on a
 * line that no longer existed. FLIP asks the browser where things ended up
 * instead of predicting it, so wrapping, growing and shrinking all come free.
 *
 * ⚠️ And the blocks are never RE-RENDERED during the drag, only moved. They are
 * live — a track is playing, a countdown is counting — and rebuilding them on
 * every index change would restart every one of those and drop the pointer
 * capture besides.
 */
import { element } from "./dom";

/** One widget on a board, as the drag sees it. */
export interface Held {
  kind: string;
  w: number;
  h: number;
}

export interface EditDeps {
  /** The grid holding the blocks. */
  row: () => HTMLElement;
  /** What is on the board now, in order. */
  kinds: () => Held[];
  /** Write a new arrangement. Called ONCE, on drop. */
  set: (widgets: Held[]) => void;
  /** The size a block of this kind is when it arrives from the tray. */
  size: (kind: string) => readonly [number, number];
  /** The nearest size this kind is ALLOWED to be. ⚠️ Asked for rather than
   *  computed here: what a widget may be is the widget's own answer, and a
   *  drag that rounded to arbitrary cells would offer shapes that do not
   *  render. */
  nearest: (kind: string, w: number, h: number) => readonly [number, number];
  /** A small stand-in to carry under the pointer. */
  ghost: (kind: string) => HTMLElement;
}

/** How far the pointer moves before a press becomes a drag. ⚠️ Without it
 *  every press on a block is also a one-pixel drag, and the row twitches under
 *  the finger before anything has been decided. */
const SLOP = 5;
/** How far outside the row counts as taking the block off it. ⚠️ Generous:
 *  a hand aiming along the row wanders, and leaving by ten pixels must not
 *  mean "delete". */
const AWAY = 56;
/** How long the shuffle takes. Must match the transition in `tasks.css`. */
const SHUFFLE_MS = 250;
/** The gap between blocks. ⚠️ Must match `.board-row`'s in `tasks.css`: a
 *  block spanning two cells is two cells plus the gap they were separated by,
 *  and the resize arithmetic cannot work that out without knowing it. */
const GAP = 18;

interface Carrying {
  kind: string;
  /** The size it is being carried at, in cells. */
  w: number;
  h: number;
  /** Where it came from: an index in the row, or -1 for the tray. */
  from: number;
  pointer: number;
  startX: number;
  startY: number;
  going: boolean;
  /** The block being carried, while it came from the row. */
  card: HTMLElement | null;
  ghost: HTMLElement | null;
  /** The gap the block will drop into, moved about the DOM as the pointer
   *  crosses other blocks. ⚠️ A REAL element in the flow, so the browser
   *  wraps the row around it exactly as it will once the block lands. */
  slot: HTMLElement | null;
  /** Where it would land if the pointer stopped here. -1 means off the row. */
  at: number;
}

export class BoardEdit {
  private held: Carrying | null = null;

  constructor(private deps: EditDeps) {}

  /** Whether a drag is in the hand. The screen asks before redrawing itself —
   *  see the note at the top about not re-rendering mid-drag. */
  get busy(): boolean { return !!this.held?.going; }

  /** Start a drag from a block already on the board. */
  fromCard(card: HTMLElement, kind: string, event: PointerEvent) {
    const list = this.deps.kinds();
    const at = list.findIndex(one => one.kind === kind);
    const held = list[at];
    this.begin(kind, at, event, card, held?.w ?? 1, held?.h ?? 1);
  }

  /** Start a drag from a tray tile. */
  fromTray(kind: string, event: PointerEvent) {
    const [w, h] = this.deps.size(kind);
    this.begin(kind, -1, event, null, w, h);
  }

  private begin(
    kind: string, from: number, event: PointerEvent,
    card: HTMLElement | null, w: number, h: number,
  ) {
    this.stop();
    this.held = {
      kind, w, h, from, pointer: event.pointerId,
      startX: event.clientX, startY: event.clientY,
      going: false, card, ghost: null, slot: null, at: from,
    };
    window.addEventListener("pointermove", this.move, { passive: true });
    window.addEventListener("pointerup", this.end);
    window.addEventListener("pointercancel", this.end);
  }

  /* ── Resizing ───────────────────────────────────────────────────────────
   * A corner, dragged. ⚠️ It snaps to the sizes the widget ALLOWS as the
   * pointer crosses each halfway point, rather than following it freely and
   * rounding at the end: a block that resizes continuously and then jumps when
   * you let go has spent the whole gesture showing you something that was never
   * on offer. What you see under the pointer is what you will get.
   *
   * ⚠️ And it writes on RELEASE, not per step. Every step is a save, a redraw
   * and every live block on the board starting over; the block is sized with
   * inline `grid-*` in the meantime, which the next render overwrites anyway. */
  resize(card: HTMLElement, kind: string, w: number, h: number, event: PointerEvent) {
    this.stop();
    const row = this.deps.row();
    const box = card.getBoundingClientRect();
    /* One cell, measured from the block being resized rather than from the
     * grid: `getComputedStyle(row).gridTemplateColumns` reports the tracks, but
     * a block spanning two of them is the only thing that knows what its own
     * span is worth including the gap it swallowed. */
    const cell = {
      x: (box.width + GAP) / Math.max(1, w),
      y: (box.height + GAP) / Math.max(1, h),
    };
    let at: readonly [number, number] = [w, h];
    row.classList.add("is-sizing");
    card.classList.add("is-sizing");

    const move = (step: PointerEvent) => {
      if (step.pointerId !== event.pointerId) return;
      const want = this.deps.nearest(kind,
        Math.max(1, Math.round((box.width + (step.clientX - event.clientX) + GAP) / cell.x)),
        Math.max(1, Math.round((box.height + (step.clientY - event.clientY) + GAP) / cell.y)));
      if (want[0] === at[0] && want[1] === at[1]) return;
      at = want;
      const before = this.snapshot();
      card.style.gridColumn = `span ${want[0]}`;
      card.style.gridRow = `span ${want[1]}`;
      card.dataset.size = `${want[0]}x${want[1]}`;
      this.play(before);
    };
    const done = (step: PointerEvent) => {
      if (step.pointerId !== event.pointerId) return;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", done);
      window.removeEventListener("pointercancel", done);
      row.classList.remove("is-sizing");
      card.classList.remove("is-sizing");
      if (at[0] === w && at[1] === h) return;
      this.deps.set(this.deps.kinds().map(one => (one.kind === kind
        ? { ...one, w: at[0], h: at[1] } : one)));
    };
    window.addEventListener("pointermove", move, { passive: true });
    window.addEventListener("pointerup", done);
    window.addEventListener("pointercancel", done);
  }

  private move = (event: PointerEvent) => {
    const held = this.held;
    if (!held || event.pointerId !== held.pointer) return;
    if (!held.going) {
      if (Math.hypot(event.clientX - held.startX, event.clientY - held.startY) < SLOP) return;
      this.lift(event);
    }
    this.follow(event);
  };

  /** The moment a press becomes a drag: take the block out, put a gap in. */
  private lift(event: PointerEvent) {
    const held = this.held;
    if (!held) return;
    held.going = true;
    const row = this.deps.row();
    row.classList.add("is-arranging");

    /* The gap. ⚠️ It takes the block's OWN measured width when it came off the
     * row, so nothing shifts on the first frame; a block arriving from the tray
     * has no box yet, so it takes what the widget asks for. */
    const slot = element("div", "board-slot");
    const box = held.card?.getBoundingClientRect();
    /* ⚠️ The gap takes the block's OWN CELLS, so the grid wraps around it
     * exactly as it will once the block lands — which is the whole reason the
     * shuffle can be FLIP rather than arithmetic. */
    slot.style.gridColumn = `span ${held.w}`;
    slot.style.gridRow = `span ${held.h}`;
    held.slot = slot;

    const before = this.snapshot();
    if (held.card) {
      held.card.after(slot);
      /* ⚠️ `display: none`, not `visibility: hidden`. The row has to lay itself
       * out as if the block had already gone — that is what the gap and the
       * wrapping are showing you — and a hidden element still takes its space. */
      held.card.style.display = "none";
    } else {
      row.append(slot);
    }
    this.play(before);

    const ghost = this.deps.ghost(held.kind);
    ghost.classList.add("board-ghost");
    document.body.append(ghost);
    held.ghost = ghost;
    /* Placed where it was PICKED UP, so the ghost does not jump on frame one. */
    ghost.style.left = `${box ? box.left + box.width / 2 : event.clientX}px`;
    ghost.style.top = `${box ? box.top + box.height / 2 : event.clientY}px`;
  }

  private follow(event: PointerEvent) {
    const held = this.held;
    if (!held?.going || !held.slot) return;
    const row = this.deps.row();
    const box = row.getBoundingClientRect();

    if (held.ghost) {
      held.ghost.style.translate =
        `${event.clientX - held.startX}px ${event.clientY - held.startY}px`;
    }

    const off = event.clientY < box.top - AWAY || event.clientY > box.bottom + AWAY
      || event.clientX < box.left - AWAY || event.clientX > box.right + AWAY;
    held.ghost?.classList.toggle("is-leaving", off && held.from >= 0);
    held.ghost?.classList.toggle("is-away", off && held.from < 0);

    const at = off ? -1 : this.slotFor(event.clientX, event.clientY);
    if (at === held.at) return;
    held.at = at;

    const before = this.snapshot();
    if (at < 0) {
      /* Off the row: the gap closes and the blocks flow over it, which is what
       * letting go here will actually do. */
      held.slot.style.display = "none";
    } else {
      held.slot.style.display = "";
      const blocks = this.blocks();
      const mark = blocks[at];
      if (mark) row.insertBefore(held.slot, mark);
      else row.append(held.slot);
    }
    this.play(before);
  }

  /** Every block on the row that is still in the layout, in order. */
  private blocks(): HTMLElement[] {
    return [...this.deps.row().querySelectorAll<HTMLElement>(".home-sec")]
      .filter(el => el.style.display !== "none");
  }

  /** Which position the pointer is over.
   *
   * ⚠️ Reading order, not x alone. The row wraps, so a block on the line below
   * is AFTER one on the line above however far left it sits — comparing x on
   * its own put the pointer at position 2 while it hovered over the seventh
   * block. A block counts as passed when the pointer is below its middle, or
   * level with it and past its middle.
   *
   * ⚠️ And it reads `offsetLeft`/`offsetTop`, NOT `getBoundingClientRect`. The
   * blocks are mid-shuffle whenever the pointer crosses two of them quickly,
   * and a rect carries the animating `translate` with it — so the answer was
   * measured against positions the blocks were in the middle of leaving, which
   * makes the next answer depend on the last one. Offsets are layout positions
   * and ignore transforms entirely. */
  private slotFor(clientX: number, clientY: number): number {
    const row = this.deps.row();
    const box = row.getBoundingClientRect();
    const x = clientX - box.left + row.scrollLeft;
    const y = clientY - box.top + row.scrollTop;
    let at = 0;
    for (const block of this.blocks()) {
      const left = block.offsetLeft;
      const top = block.offsetTop;
      const width = block.offsetWidth;
      const height = block.offsetHeight;
      const sameRow = y >= top && y <= top + height;
      if (sameRow ? x > left + width / 2 : y > top + height / 2) at++;
    }
    return at;
  }

  /** Where everything is right now. */
  private snapshot(): Map<HTMLElement, DOMRect> {
    const was = new Map<HTMLElement, DOMRect>();
    for (const block of this.blocks()) was.set(block, block.getBoundingClientRect());
    return was;
  }

  /** Play every block from where it was to where it now is.
   *
   * ⚠️ The translate is written and then cleared on the NEXT frame, never in
   * the same one — set and unset together, the browser coalesces them into no
   * change at all and nothing animates. */
  private play(was: Map<HTMLElement, DOMRect>) {
    const moved: [HTMLElement, number, number][] = [];
    for (const block of this.blocks()) {
      const from = was.get(block);
      if (!from) continue;
      const to = block.getBoundingClientRect();
      const dx = from.left - to.left;
      const dy = from.top - to.top;
      if (!dx && !dy) continue;
      block.style.transition = "none";
      block.style.translate = `${dx}px ${dy}px`;
      moved.push([block, dx, dy]);
    }
    if (!moved.length) return;
    requestAnimationFrame(() => {
      for (const [block] of moved) {
        block.style.transition = "";
        block.style.translate = "";
      }
    });
  }

  private end = (event: PointerEvent) => {
    const held = this.held;
    if (!held || event.pointerId !== held.pointer) return;
    const { kind, from, at, going } = held;
    this.stop();
    if (!going) return;

    const kinds = this.deps.kinds();
    const rest = kinds.filter(one => one.kind !== kind);
    if (at < 0) {
      // Off the grid: taken away if it was on it, and simply not added if not.
      if (from >= 0) this.deps.set(rest);
      return;
    }
    const size = this.deps.size(kind);
    const was = kinds.find(one => one.kind === kind);
    rest.splice(Math.max(0, Math.min(rest.length, at)), 0,
      was ?? { kind, w: size[0], h: size[1] });
    /* ⚠️ Nothing is written when the arrangement has not changed. A press that
     * wandered five pixels and came back would otherwise be a save, a redraw,
     * and every live block on the board starting over. */
    if (rest.length === kinds.length
      && rest.every((one, i) => one.kind === kinds[i].kind)) return;
    this.deps.set(rest);
  };

  /** Put everything back the way it was drawn. ⚠️ Called on drop AND on
   *  teardown, because a board redrawn mid-gesture leaves a hidden block and a
   *  stray gap behind, and nothing else would ever clear them. */
  stop() {
    const held = this.held;
    this.held = null;
    window.removeEventListener("pointermove", this.move);
    window.removeEventListener("pointerup", this.end);
    window.removeEventListener("pointercancel", this.end);
    if (!held) return;
    held.ghost?.remove();
    held.slot?.remove();
    if (held.card) {
      held.card.style.display = "";
      held.card.classList.remove("is-carrying", "is-leaving");
    }
    const row = this.deps.row();
    row.classList.remove("is-arranging");
    for (const block of row.querySelectorAll<HTMLElement>(".home-sec")) {
      block.style.transition = "";
      block.style.translate = "";
    }
  }
}

/** How long the shuffle is given, for anyone who needs to wait for it. */
export const SHUFFLE = SHUFFLE_MS;

/** A small stand-in for the block being carried: its glyph and its name.
 *
 * ⚠️ NOT a clone of the block. A live block holds a playing track and a running
 * countdown; cloning one gives you a second copy of both, frozen, under the
 * pointer — and at full size it covers the row you are trying to aim at. */
export function ghostChip(icon: SVGElement | null, label: string): HTMLElement {
  const chip = element("div", "board-ghost-chip");
  if (icon) {
    const mark = element("span", "board-ghost-mark");
    mark.append(icon);
    chip.append(mark);
  }
  chip.append(element("span", "", label));
  return chip;
}
