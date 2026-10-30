/* Drag to reorder a list of Helm's Today: Today's entries, the small things.
 *
 * ⚠️ Pointer events, never HTML5 drag and drop: Tauri takes the window's drag
 * events and the page never sees them (AGENTS 400). The row follows the
 * pointer and its neighbours step aside by its height; nothing is moved in the
 * DOM until it is let go, and then only the screen's own render moves it (from
 * the order the source now holds), so a drop is the same as a fresh reading.
 *
 * ⚠️ A press that never travels 5 px is a click and is left alone, and the
 * click that ends a real drag is swallowed — a row whose title opens or ticks
 * something must not do it at the end of being dragged.
 */

export interface SortHooks {
  /** The siblings that move, in order, each carrying `data-key`. */
  rows: () => HTMLElement[];
  /** Let go somewhere new: every key, in the new order. */
  dropped: (keys: string[]) => void;
  /** On while a row is up, so the screen holds its render (a rebuilt list would drop the row). */
  moving: (on: boolean) => void;
}

export function sortable(row: HTMLElement, hooks: SortHooks) {
  row.addEventListener("pointerdown", event => {
    if (event.button !== 0) return;
    if ((event.target as HTMLElement).closest("button, a, input, label, textarea")) return;
    const startY = event.clientY;
    let rows: HTMLElement[] = [];
    let boxes: DOMRect[] = [];
    let from = -1;
    let to = -1;
    let lifted = false;

    const move = (e: PointerEvent) => {
      const dy = e.clientY - startY;
      if (!lifted) {
        if (Math.abs(dy) < 5) return;
        rows = hooks.rows();
        from = rows.indexOf(row);
        if (from < 0 || rows.length < 2) return end(false);
        lifted = true;
        to = from;
        boxes = rows.map(one => one.getBoundingClientRect());
        row.classList.add("is-lifting");
        rows.forEach(one => one.classList.add("is-sorting"));
        hooks.moving(true);
      }
      e.preventDefault();
      // Held inside the list: a row dragged past the ends stops at them.
      const top = boxes[0].top - boxes[from].top;
      const bottom = boxes[boxes.length - 1].bottom - boxes[from].bottom;
      const at = Math.max(top, Math.min(bottom, dy));
      row.style.translate = `0 ${at}px`;
      const mid = boxes[from].top + boxes[from].height / 2 + at;
      to = from;
      for (let i = 0; i < from; i++) if (mid <= boxes[i].top + boxes[i].height / 2) { to = i; break; }
      for (let i = rows.length - 1; i > from; i--) if (mid >= boxes[i].top + boxes[i].height / 2) { to = i; break; }
      const step = boxes[from].height;
      rows.forEach((one, i) => {
        if (i === from) return;
        const shift = from < to && i > from && i <= to ? -step : to < from && i >= to && i < from ? step : 0;
        one.style.translate = shift ? `0 ${shift}px` : "";
      });
    };

    const end = (drop: boolean) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      if (!lifted) return;
      for (const one of rows) {
        one.style.translate = "";
        one.classList.remove("is-lifting", "is-sorting");
      }
      hooks.moving(false);
      // The click this press ends in belongs to the drag, not to whatever is under it.
      window.addEventListener("click", swallow, { capture: true, once: true });
      window.setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
      if (drop && to !== from) {
        const keys = rows.map(one => one.dataset.key ?? "");
        const [moved] = keys.splice(from, 1);
        keys.splice(to, 0, moved);
        hooks.dropped(keys);
      }
    };
    const up = () => end(true);
    const cancel = () => end(false);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
  });
}

function swallow(event: Event) {
  event.stopPropagation();
  event.preventDefault();
}
