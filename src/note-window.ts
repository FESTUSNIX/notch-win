/* One note, welded to the edge of the screen.
 *
 * ⚠️ This is the one window in the app that is MEANT to take focus. The island
 * is `WS_EX_NOACTIVATE` so that glancing at it never steals the caret, and
 * every field on it pays for that in plumbing; a note you cannot click into and
 * type in is not a note. It is an ordinary focusable window that happens to be
 * undecorated, always on top and off the taskbar.
 *
 * ⚠️ **A drawer, not a sticky square.** What was here before was a little
 * window you dragged somewhere and then lost behind something — which is what
 * happens to every desktop sticky note ever written. This one docks: a sliver
 * at the side of the screen that says the note is there, and the whole note
 * when the pointer arrives. The same move the island makes, on the other axis.
 *
 * ⚠️ **The geometry lives here and only here.** Rust builds the window hidden
 * at a guess and this page places it, because the edge, the monitor, the two
 * sizes and the hover expansion are one problem — split across two languages it
 * is four numbers that have to agree and do not.
 *
 * ⚠️ It reads and writes through the same commands the island does, so a note
 * changed here is changed there on the next `notch:notes` and vice versa.
 * There is one store; this is a second window onto it, not a second copy.
 */
import { currentMonitor, getCurrentWindow, primaryMonitor } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { call, native } from "./task-client";
import { element } from "./dom";
import { paintIcon } from "./task-icons";
import { blocks } from "./note-format";
import { noteTitle, noteWhen, tintOf, type Note } from "./notes";
import "./tasks.css";

document.body.className = "drawer-page";

const id = new URLSearchParams(location.search).get("id") ?? "";
const host = document.getElementById("drawer")!;
const win = native ? getCurrentWindow() : null;

/* ── The two sizes, in logical pixels ─────────────────────────────────────
 * ⚠️ The bar is 22 wide and that is a floor, not a taste: it is the whole
 * hover target, and anything thinner is a line you have to aim at rather than
 * a thing you move the pointer towards. */
const BAR_W = 22;
const BAR_H = 136;
const PANEL_W = 330;
const PANEL_H = 340;
/** How long the panel takes to come out, and therefore how long the window
 *  must stay big enough to hold it on the way back in. ⚠️ Must match the
 *  transition in `tasks.css`; shrink the window first and the panel vanishes
 *  instead of sliding. */
const SLIDE = 260;

let note: Note | null = null;
let edge: "left" | "right" = "right";
let open = false;
/** Pinned open by a click on the bar, rather than by the pointer being there. */
let locked = false;
let editing = false;
/** Held here rather than read back off the field: a redraw replaces it. */
let draft = "";
/** The top of the COLLAPSED bar, in physical pixels on the docked monitor. */
let barTop = 0;

/* ── Where the window goes ───────────────────────────────────────────── */

interface Area { x: number; y: number; w: number; h: number }

/** The monitor the drawer is docked to, in physical pixels.
 *
 * ⚠️ The WORK area when the platform reports one — the strip along the bottom
 * of the screen belongs to the taskbar, and a drawer whose lower half is behind
 * it is a note you can read the top of. */
let field: Area = { x: 0, y: 0, w: 1920, h: 1080 };

async function measure() {
  try {
    const mon = (await currentMonitor()) ?? (await primaryMonitor());
    if (mon) {
      const work = (mon as unknown as { workArea?: { position: { x: number; y: number };
        size: { width: number; height: number } } }).workArea;
      const at = work?.position ?? mon.position;
      const size = work?.size ?? mon.size;
      field = { x: at.x, y: at.y, w: size.width, h: size.height };
      return;
    }
  } catch { /* the fallback below is a monitor-shaped guess, which is enough */ }
  const dpr = window.devicePixelRatio || 1;
  field = { x: 0, y: 0, w: Math.round(screen.width * dpr), h: Math.round(screen.height * dpr) };
}

/** Put the window where the current state says it should be.
 *
 * ⚠️ ONE call for the move and the resize — see `move_pin` in notes.rs. Sent
 * as two the drawer is briefly the new width at the old x, which on the
 * right-hand edge is a window hanging off the side of the screen. */
async function place() {
  if (!win) return;
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round((open ? PANEL_W : BAR_W) * dpr);
  const h = Math.round((open ? PANEL_H : BAR_H) * dpr);
  const bar = Math.round(BAR_H * dpr);
  const x = edge === "right" ? field.x + field.w - w : field.x;
  /* The bar's middle stays put while the panel grows around it, so the note
   * opens where you were pointing rather than jumping to a corner. */
  const middle = barTop + bar / 2;
  const top = Math.min(Math.max(Math.round(middle - h / 2), field.y),
    field.y + field.h - h);
  try { await call("move_pin", { id, x, y: top, w, h }); } catch { /* still there */ }
}

/** Open or shut the drawer, window and all.
 *
 * ⚠️ The order is the whole of it. Opening: make the window big FIRST, then
 * let the panel slide into the room that now exists. Shutting: let it slide
 * out and only then take the room away, or the panel is clipped out of
 * existence on the first frame and there is no animation to see. */
async function swing(next: boolean) {
  if (next === open) return;
  open = next;
  if (next) {
    await place();
    // A frame, so the transition has a start to run from rather than arriving
    // already finished.
    requestAnimationFrame(() => host.classList.add("is-open"));
    return;
  }
  host.classList.remove("is-open");
  window.setTimeout(() => { if (!open) void place(); }, SLIDE);
}

let waiting = 0;
function want(next: boolean, delay: number) {
  clearTimeout(waiting);
  waiting = window.setTimeout(() => { void swing(next); }, delay);
}

/* ── What is on the paper ────────────────────────────────────────────── */

function paper(body: string): HTMLElement {
  const sheet = element("div", "note-body");
  let list: HTMLElement | null = null;
  for (const block of blocks(body)) {
    if (block.kind === "bullet" || block.kind === "number") {
      const wanted = block.kind === "bullet" ? "ul" : "ol";
      if (!list || list.tagName.toLowerCase() !== wanted) {
        list = element(wanted as "ul", "note-list-block");
        if (block.kind === "number" && block.index && block.index !== 1) {
          (list as HTMLOListElement).start = block.index;
        }
        sheet.append(list);
      }
      const item = element("li", "");
      runs(item, block.spans);
      list.append(item);
      continue;
    }
    list = null;
    const tag = block.kind === "head" ? "h4" : block.kind === "code" ? "pre" : "p";
    const line = element(tag as "p", `note-${block.kind}`);
    runs(line, block.spans);
    sheet.append(line);
  }
  return sheet;
}

/** ⚠️ Text nodes, never `innerHTML`. A note is arbitrary text the user pasted
 *  from somewhere, and the one thing you must not do with that is hand it to
 *  something that builds elements. */
function runs(target: HTMLElement, spans: { text: string; bold?: boolean; italic?: boolean; code?: boolean; strike?: boolean }[]) {
  for (const span of spans) {
    const tag = span.code ? "code" : span.bold ? "strong"
      : span.italic ? "em" : span.strike ? "s" : "span";
    const run = element(tag as "span", "");
    run.append(document.createTextNode(span.text));
    target.append(run);
  }
}

/* ── Writing in it ───────────────────────────────────────────────────── */

async function save() {
  const body = draft.trim();
  editing = false;
  try {
    const all = await call<Note[]>("save_note", { id, body });
    note = all.find(one => one.id === id) ?? null;
    /* An emptied note deletes itself, and the window has nothing left to show.
     * ⚠️ Closed from here rather than left as an empty sliver: `remove_note`
     * closes the window, but clearing the field goes through `save_note`. */
    if (!note) { await win?.close(); return; }
  } catch { /* the words are still in `draft`; the next save tries again */ }
  render();
}

function render() {
  host.replaceChildren();
  host.dataset.edge = edge;
  host.dataset.tint = tintOf(note);
  host.classList.toggle("is-locked", locked);

  /* ── The sliver ───────────────────────────────────────────────────
   * What is on screen when nobody is looking at it: a coloured edge and, if
   * there is room, the note's first words turned on their side. */
  const tab = element("div", "drawer-tab");
  tab.setAttribute("role", "button");
  tab.setAttribute("tabindex", "0");
  tab.setAttribute("aria-label", locked ? "Let the note close" : "Keep the note open");
  tab.append(element("span", "drawer-tab-mark"));
  tab.append(element("span", "drawer-tab-name", noteTitle(note?.body ?? "", 28)));
  grab(tab);
  host.append(tab);

  /* ── The note ─────────────────────────────────────────────────────── */
  const panel = element("section", "drawer-panel");
  const head = element("div", "drawer-head");
  /* ⚠️ WHEN, not what. The sliver beside it already carries the first line
   * and the paper below it opens with the same words — a title here was the
   * same sentence three times, on a panel 308px wide. */
  head.append(element("span", "drawer-title",
    note ? noteWhen(note.written, Date.now()) : ""));
  const tools = element("div", "drawer-tools");
  for (const [icon, label, on, run] of [
    ["pin", locked ? "Let it close" : "Keep it open", locked,
      () => { locked = !locked; render(); if (!locked) want(false, 120); }],
    ["copy", "Copy", false,
      () => { void call("copy_text", { text: note?.body ?? "" }).catch(() => {}); }],
    ["close", "Undock", false,
      () => { void call("pin_note", { id, pinned: false }).catch(() => {}); }],
  ] as const) {
    const button = element("button", `drawer-do${on ? " is-on" : ""}`);
    (button as HTMLButtonElement).type = "button";
    button.setAttribute("aria-label", label);
    button.dataset.tip = label;
    paintIcon(button, icon);
    button.onclick = run;
    tools.append(button);
  }
  head.append(tools);
  panel.append(head);

  if (!note) {
    panel.append(element("p", "drawer-gone", "This note is gone."));
    host.append(panel);
    return;
  }

  if (editing) {
    const box = document.createElement("textarea");
    box.className = "drawer-field";
    box.value = draft;
    box.maxLength = 20_000;
    box.setAttribute("aria-label", "Note");
    box.onkeydown = event => {
      // ⚠️ Ctrl+Enter, not Enter. A docked note is where a list goes, and the
      // island's sheet is the same: Enter has to be a newline or the thing
      // this is mostly used for takes a modifier on every line.
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        draft = box.value;
        void save();
      }
      /* ⚠️ The blur handler goes FIRST. Escape re-renders, the re-render
       * removes the textarea, removing it fires `blur` — and `blur` saves. So
       * "discard" saved the very words it was discarding, every time. */
      if (event.key === "Escape") {
        event.preventDefault();
        box.onblur = null;
        editing = false;
        draft = note?.body ?? "";
        render();
      }
    };
    box.oninput = () => { draft = box.value; };
    box.onblur = () => { draft = box.value; void save(); };
    panel.append(box);
    host.append(panel);
    box.focus();
    box.setSelectionRange(draft.length, draft.length);
    return;
  }

  const read = element("button", "drawer-open");
  (read as HTMLButtonElement).type = "button";
  read.setAttribute("aria-label", "Edit this note");
  read.append(paper(note.body));
  read.onclick = () => { editing = true; draft = note?.body ?? ""; render(); };
  panel.append(read);
  host.append(panel);
}

/* ── Sliding it along the edge ────────────────────────────────────────
 *
 * ⚠️ Our own drag, not `data-tauri-drag-region`. That one hands the gesture to
 * Windows, which moves the window wherever the pointer goes — and a drawer that
 * can be dropped in the middle of the screen is a sticky note again. This one
 * only ever changes how far DOWN the bar sits, and which side it is on. */
function grab(tab: HTMLElement) {
  let from: { x: number; y: number; top: number } | null = null;
  let moved = false;
  let frame = 0;

  tab.addEventListener("pointerdown", event => {
    if (event.button !== 0) return;
    from = { x: event.screenX, y: event.screenY, top: barTop };
    moved = false;
    tab.setPointerCapture(event.pointerId);
    void measure();
  });

  tab.addEventListener("pointermove", event => {
    if (!from) return;
    const dpr = window.devicePixelRatio || 1;
    if (!moved && Math.abs(event.screenY - from.y) < 4
      && Math.abs(event.screenX - from.x) < 4) return;
    moved = true;
    barTop = Math.round(from.top + (event.screenY - from.y) * dpr);
    /* Which half of the screen the pointer is in, so the drawer changes sides
     * by being dragged across rather than by a setting nobody would find. */
    edge = event.screenX * dpr > field.x + field.w / 2 ? "right" : "left";
    host.dataset.edge = edge;
    // ⚠️ One placement per frame. A pointer reports faster than the window can
    // move, and every one of those is a window message.
    if (frame) return;
    frame = requestAnimationFrame(() => { frame = 0; void place(); });
  });

  const drop = (event: PointerEvent) => {
    if (!from) return;
    from = null;
    tab.releasePointerCapture?.(event.pointerId);
    if (!moved) {
      // A press that went nowhere is a press: keep the note open, or let go.
      locked = !locked;
      render();
      void swing(locked ? true : false);
      return;
    }
    moved = false;
    void call("dock_note", { id, edge, y: barTop }).catch(() => {});
  };
  tab.addEventListener("pointerup", drop);
  tab.addEventListener("pointercancel", () => { from = null; moved = false; });
  tab.addEventListener("keydown", event => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    locked = !locked;
    render();
    void swing(locked);
  });
}

/* ── The pointer ─────────────────────────────────────────────────────── */

document.documentElement.addEventListener("pointerenter", () => { want(true, 80); });
document.documentElement.addEventListener("pointerleave", () => {
  if (locked || editing) return;
  /* ⚠️ A pause before it shuts, and a longer one than the pause before it
   * opens. A drawer that closes the instant the pointer clips its corner is
   * one you have to chase, and the cost of being wrong in this direction is a
   * quarter of a second of a note being visible. */
  want(false, 240);
});

/* ── Boot ────────────────────────────────────────────────────────────── */

async function boot() {
  try {
    const all = await call<Note[]>("get_notes");
    note = all.find(one => one.id === id) ?? null;
  } catch { /* the window says so */ }
  edge = note?.edge === "left" ? "left" : "right";
  draft = note?.body ?? "";
  render();

  if (!native) return;
  await measure();
  const dpr = window.devicePixelRatio || 1;
  /* Never docked before: halfway down, where the pointer already goes. */
  barTop = note?.y && note.y > 0
    ? note.y
    : Math.round(field.y + field.h / 2 - (BAR_H * dpr) / 2);
  try {
    await place();
  } finally {
    /* ⚠️ Shown here and nowhere else — the window is built hidden so it is
     * never seen in the wrong corner. In a `finally` because a window that
     * stays hidden because a placement failed is a pin that silently did
     * nothing. */
    await win?.show();
  }

  /* One store, two windows. ⚠️ The island and this both write through
   * `save_note`, so this listener is what stops the two drifting apart. */
  await listen<Note[]>("notch:notes", event => {
    const next = event.payload.find(one => one.id === id) ?? null;
    // Not while it is being typed into: the arriving list is what was saved
    // before this edit started, and painting it would take the words away.
    if (editing) { note = next; return; }
    note = next;
    render();
  });

  /* The screen itself can change under a docked window — a monitor unplugged,
   * a resolution changed, the taskbar moved. */
  await win?.onScaleChanged(() => { void measure().then(place); });
}

/* The preview has no Tauri, so it stages a note from the demo store instead of
 * failing to open a window. */
if (!native) {
  void (async () => {
    const all = await call<Note[]>("get_notes");
    note = all.find(one => one.id === id) ?? all[0] ?? null;
    edge = note?.edge === "left" ? "left" : "right";
    draft = note?.body ?? "";
    render();
  })();
} else {
  void boot();
}

if (native) {
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && !editing) { locked = false; void swing(false); }
  });
}

export {};
