/* One note, welded to the edge of the screen.
 *
 * ⚠️ This is the one window in the app that is MEANT to take focus. The island
 * is `WS_EX_NOACTIVATE` so that glancing at it never steals the caret, and
 * every field on it pays for that in plumbing; a note you cannot click into and
 * type in is not a note.
 *
 * ⚠️ **It is the island's own arrangement, not a second invention.** The window
 * never resizes: it is the size of the OPEN drawer at all times, transparent,
 * and click-through everywhere it is not painted — `watch_pin` in notes.rs
 * keeps that true, the way `hover.rs` does for the island. What animates is the
 * SHAPE inside it, drawn with the island's own `notchPath` and driven by the
 * island's own `Spring`. A window that grows on hover can only ever jump:
 * there is no way to resize one at sixty frames a second across a process
 * boundary, and every attempt reads as a snap with an animation after it.
 *
 * ⚠️ So the drawer has the island's silhouette, flares and all — rounded on the
 * inward side and flaring back OUT to the screen edge at each end, so it reads
 * as part of the edge rather than as a rounded box parked against it.
 *
 * ⚠️ It reads and writes through the same commands the island does, so a note
 * changed here is changed there on the next `notch:notes` and vice versa.
 * There is one store; this is a second window onto it, not a second copy.
 */
import { currentMonitor, getCurrentWindow, primaryMonitor } from "@tauri-apps/api/window";
import { call, native } from "./task-client";
import { element } from "./dom";
import { paintIcon } from "./task-icons";
import { Spring } from "./motion";
import { notchPath, notchTransform } from "./layout";
import { editable, markersOf } from "./note-live";
import { noteTitle, noteWhen, tintOf, type Note } from "./notes";
import "./tasks.css";

document.body.className = "drawer-page";

declare global {
  interface Window {
    __noteDock?: (at: { id: string; edge: string; y: number; dragging: boolean }) => void;
    __noteList?: (all: Note[]) => void;
    __noteHover?: (at: { hover: boolean; y: number }) => void;
    __noteFreeze?: (on: boolean) => void;
  }
}

const id = new URLSearchParams(location.search).get("id") ?? "";
const host = document.getElementById("drawer")!;
const win = native ? getCurrentWindow() : null;

/* ── The two shapes ───────────────────────────────────────────────────────
 * ⚠️ The sliver is 22 wide and that is a floor, not a taste: it is the whole
 * hover target, and anything thinner is a line you have to aim at rather than
 * a thing you move the pointer towards.
 *
 * ⚠️ The open size is smaller than the WINDOW on purpose. The spring
 * overshoots past its target — that is what makes it feel like a spring — and
 * the overshoot needs somewhere to go, or the shape is sliced off square at
 * the moment it is moving fastest. */
const BAR_W = 22;
const BAR_H = 136;
const PANEL_W = 330;
const PANEL_H = 340;
/** The flare where the shape meets the screen edge, and the radius on the side
 *  that does not. ⚠️ Both are clamped by `notchPath` when the shape is too
 *  small to hold them, which is a good part of why it is reused. */
const FLARE = 16;
const CORNER = 18;

let note: Note | null = null;
let edge: "left" | "right" = "right";
/** Pinned open by a press on the sliver, rather than by the pointer being on it. */
let locked = false;
let hovering = false;
/** Held here rather than read back off the field: a redraw replaces it. */
let draft = "";
/** The middle of the sliver, in physical pixels down the docked monitor. */
let barMiddle = 0;
/** True while the sliver is being dragged along the edge. */
let sliding = false;
/** Shut by hand, and staying shut until the pointer leaves.
 *
 * ⚠️ Without this, minimising does nothing you can see: the press that shut
 * the drawer happened ON the drawer, so the pointer is still on it, and the
 * next thing `settle` reads is "hovering" — it would spring straight back
 * open under the finger that just closed it. */
let dismissed = false;
/** True while ANY note is being dragged. ⚠️ Every docked drawer shuts for the
 *  duration: one opening under the pointer covers the ghost the drag is
 *  showing you, which is the one thing on screen at that moment. */
let frozen = false;

/* ⚠️ The island's own spring, at the island's own numbers. The whole point of
 * this rewrite is that a docked note moves like the rest of the app rather
 * than like a window being resized. */
const fold = new Spring(0, 0.46, 0.62);
let frame = 0;
let last = 0;

/* ── The parts ───────────────────────────────────────────────────────── */

const clip = document.getElementById("drawer-clip-path") as unknown as SVGPathElement;
const shape = element("div", "drawer-shape");
const sliver = element("div", "drawer-sliver");
const panel = element("section", "drawer-panel");
/* ⚠️ The open drawer needs a handle of its own. Moving it means grabbing the
 * sliver — and the sliver is under the note the moment the pointer arrives,
 * because arriving is what opens it. So there was no way to reposition a
 * drawer you could see: the only grab area was the one that disappears when
 * you reach for it. This strip runs down the bezel edge, where the sliver
 * was. */
const grip = element("div", "drawer-grip");
for (let i = 0; i < 3; i++) grip.append(element("span", "drawer-grip-dot"));
shape.append(sliver, panel, grip);
host.append(shape);

/** The window's own size in CSS pixels.
 *
 * ⚠️ Read rather than assumed. Rust builds the window and is the only place
 * that knows how big it made it; a constant here would be a second opinion,
 * and the two disagreeing means a shape drawn outside its own window. */
function room() {
  return {
    w: document.documentElement.clientWidth,
    h: document.documentElement.clientHeight,
  };
}

/* ── Where the window sits ───────────────────────────────────────────── */

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

/** Put the window against its edge, centred on the sliver.
 *
 * ⚠️ Position only. The size is Rust's and never changes — see the note at the
 * top of this file. */
/** ⚠️ One placement in flight at a time. These are driven by an event stream
 *  at sixty a second; without the guard two moves overlap and the window can
 *  land on the older of the two. */
let placing = false;

async function place() {
  if (!win || placing) return;
  placing = true;
  try { await put(); } finally { placing = false; }
}

async function put() {
  if (!win) return;
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(room().w * dpr);
  const h = Math.round(room().h * dpr);
  const x = edge === "right" ? field.x + field.w - w : field.x;
  const top = Math.min(Math.max(Math.round(barMiddle - h / 2), field.y),
    field.y + field.h - h);
  try { await call("move_pin", { id, x, y: top, w, h }); } catch { /* still there */ }
}

/* ── What is clickable ───────────────────────────────────────────────────
 *
 * ⚠️ The window is a HOLE everywhere outside these rects — that is what makes
 * 330 by 340 of transparent window at the edge of the screen liveable — so a
 * shape drawn outside them is visible, unhoverable and unclickable. Reported
 * whenever the shape settles, and eagerly on the way open so the pointer never
 * falls out of a drawer that is still growing. */
function report() {
  if (!native) return;
  const size = room();
  const box = shape.getBoundingClientRect();
  /* A little slack, like the island's: a folding drawer must not drop the
   * pointer mid-animation and re-collapse under the cursor. */
  const pad = 6;
  const rects = sliding
    ? [{ x: 0, y: 0, width: size.w, height: size.h }]
    : [{
      x: box.x - pad, y: box.y - pad,
      width: box.width + 2 * pad, height: box.height + 2 * pad,
    }];
  void call("set_interactive_rects", { rects }).catch(() => {});
}

/* ── The shape ───────────────────────────────────────────────────────── */

function paint() {
  const t = Math.max(0, fold.value);
  const { w: winW, h: winH } = room();
  /* ⚠️ Clamped to the window. The spring overshoots, and a shape wider than
   * the window it is drawn in is a shape with a straight edge sliced through
   * it — which is the one thing the flares exist to avoid. */
  const depth = Math.min(winW, BAR_W + (PANEL_W - BAR_W) * t);
  const length = Math.min(winH, BAR_H + (PANEL_H - BAR_H) * t);

  shape.style.width = `${depth}px`;
  shape.style.height = `${length}px`;
  shape.style.top = `${(winH - length) / 2}px`;
  shape.style.left = edge === "left" ? "0px" : `${winW - depth}px`;

  /* The island's shape, by the island's own hand. ⚠️ Reusing `notchPath`
   * rather than re-deriving it: the arc sweep flags and the corner and flare
   * clamping are exactly the parts that are easy to get subtly wrong, and they
   * are already right and already tested there. */
  clip.setAttribute("d", notchPath(depth, length, FLARE, CORNER));
  clip.setAttribute("transform", notchTransform(edge, depth));

  /* Cross-fade, like the island's two layers: the sliver is gone before the
   * note arrives, so the two are never both legible at once. */
  const shown = Math.min(1, t);
  sliver.style.opacity = `${Math.max(0, 1 - shown * 2.4)}`;
  panel.style.opacity = `${Math.max(0, (shown - 0.45) / 0.55)}`;
  /* ⚠️ Whichever layer is legible is the one that takes the pointer. They
   * sit on top of each other, so without this the invisible one is still the
   * hit target for half the animation — and a press on a sliver that is no
   * longer there lands on a note that is not there yet. */
  /* ⚠️ The note SLIDES out of the edge rather than fading in on the spot.
   * Revealed in place, the content is at its final position from the first
   * frame and only the shape moves — which reads as a window opening over the
   * sliver rather than as the sliver becoming the window. Eighteen pixels of
   * travel is enough to tie the two together, and it is a transform, so
   * nothing inside re-wraps while it runs. */
  const slide = (1 - shown) * 18 * (edge === "right" ? 1 : -1);
  panel.style.translate = `${slide}px -50%`;
  grip.style.opacity = panel.style.opacity;
  /* ⚠️ Whichever layer is legible is the one that takes the pointer. They sit
   * on top of each other, so without this the invisible one is still the hit
   * target for half the animation — and a press on a sliver that is no longer
   * there lands on a note that is not there yet.
   *
   * ⚠️ Except mid-drag. A pointer capture outranks hit testing, but taking the
   * events away from the element holding one is not worth finding out about
   * halfway through a gesture. */
  panel.style.pointerEvents = shown > 0.55 ? "auto" : "none";
  /* ⚠️ Whichever handle is being DRAGGED keeps the pointer whatever the fade
   * says. A drag shuts the drawer, and a grip that stopped accepting the
   * pointer halfway through the gesture it is driving is a grip that drops
   * the note in the middle of the screen. */
  grip.style.pointerEvents = sliding || shown > 0.55 ? "auto" : "none";
  sliver.style.pointerEvents = sliding || shown <= 0.55 ? "auto" : "none";
}

function tick(at: number) {
  const dt = Math.min(0.05, (at - last) / 1000);
  last = at;
  fold.step(dt);
  paint();
  if (!fold.settled) {
    frame = requestAnimationFrame(tick);
    return;
  }
  frame = 0;
  fold.snap(fold.value > 0.5 ? 1 : 0);
  paint();
  report();
}

function run() {
  if (frame) return;
  last = performance.now();
  frame = requestAnimationFrame(tick);
}

/** Whether the caret is in the note. */
function typing(): boolean {
  return !!live && document.activeElement === live;
}

/** Open or shut the drawer, from whatever is true right now. */
function settle() {
  /* ⚠️ A drag shuts it and holds it shut. Sliding a drawer along an edge is
   * not a statement about whether it should be open, and one that opened
   * under the pointer would cover the ghost being dragged. */
  const open = !frozen && !sliding && !dismissed && (locked || hovering || typing());
  fold.setTarget(open ? 1 : 0);
  /* ⚠️ On the way IN the whole window is reported as chrome before the shape
   * has grown into it, so the pointer cannot fall out of a drawer that is
   * still opening. On the way out `tick` reports the real shape once it has
   * arrived. */
  if (open && native) {
    const size = room();
    void call("set_interactive_rects", {
      rects: [{ x: 0, y: 0, width: size.w, height: size.h }],
    }).catch(() => {});
  }
  run();
}

/* ── Writing in it ──────────────────────────────────────────────────────
 *
 * ⚠️ There is no "edit mode". The note IS the field: the pointer arrives, the
 * drawer opens, you put the caret in a word and type. */

/** The editor, while the panel is built. */
let live: HTMLElement | null = null;
/** How long after the last keystroke the note writes itself down. */
const SAVE_AFTER = 650;
let saving = 0;
/** Set when a change arrived while the caret was in the note, so the panel can
 *  be redrawn once it leaves. */
let repaint = false;

function later() {
  clearTimeout(saving);
  saving = window.setTimeout(() => { void save(); }, SAVE_AFTER);
}

async function save() {
  clearTimeout(saving);
  const body = draft.trim();
  if (!note || body === note.body.trim()) return;
  try {
    const all = await call<Note[]>("save_note", { id, body });
    note = all.find(one => one.id === id) ?? null;
    /* An emptied note deletes itself, and the window has nothing left to show.
     * ⚠️ Closed from here rather than left as an empty sliver: `remove_note`
     * closes the window, but clearing the field goes through `save_note`. */
    if (!note) { await win?.close(); return; }
  } catch { /* the words are still in `draft`; the next save tries again */ }
  /* ⚠️ No redraw. This runs with the caret in the note — that is what an
   * autosave IS — and a redraw here takes the caret, the selection and the
   * undo stack with it. */
  const when = host.querySelector<HTMLElement>(".drawer-title");
  if (when && note) when.textContent = noteWhen(note.written, Date.now());
  const name = host.querySelector<HTMLElement>(".drawer-sliver-name");
  if (name && note) name.textContent = noteTitle(note.body, 28);
}

/* ── Drawing the contents ────────────────────────────────────────────── */

function render() {
  host.dataset.edge = edge;
  host.dataset.tint = tintOf(note);
  host.classList.toggle("is-locked", locked);
  live = null;

  /* The sliver: a coloured dot and the note's first words turned on their
   * side. ⚠️ It is a LAYER inside the shape, not a shape of its own — the
   * outline round it is the drawer's, once, which is what stopped it reading
   * as a little box inside another little box. */
  sliver.replaceChildren();
  sliver.setAttribute("role", "button");
  sliver.setAttribute("tabindex", "0");
  sliver.setAttribute("aria-label", locked ? "Let the note close" : "Keep the note open");
  sliver.append(element("span", "drawer-sliver-mark"));
  sliver.append(element("span", "drawer-sliver-name", noteTitle(note?.body ?? "", 28)));

  panel.replaceChildren();
  const head = element("div", "drawer-head");
  /* ⚠️ WHEN, not what. The sliver beside it already carries the first line
   * and the paper below it opens with the same words — a title here was the
   * same sentence three times, on a panel 300px wide. */
  head.append(element("span", "drawer-title",
    note ? noteWhen(note.written, Date.now()) : ""));
  const tools = element("div", "drawer-tools");
  /* ⚠️ MINIMISE and CLOSE are different things, and one button cannot be
   * both. Shutting the drawer back to its sliver is what you want ten times a
   * day; taking the note off the edge is what you want once. An X that did the
   * second read as the first, so it did the wrong one every time. */
  for (const [icon, label, on, run] of [
    ["pin", locked ? "Let it close" : "Keep it open", locked,
      () => { locked = !locked; freshen(); settle(); }],
    ["copy", "Copy", false,
      () => { void call("copy_text", { text: note?.body ?? "" }).catch(() => {}); }],
    ["back", "Collapse", false,
      () => { locked = false; dismissed = true; freshen(); settle(); }],
    /* ⚠️ And this one takes the note off the edge. The note itself is on the
     * wall, where it has been all along. */
    ["close", "Close", false,
      () => { void call("pin_note", { id, pinned: false }).catch(() => {}); }],
  ] as const) {
    const button = element("button", `drawer-do drawer-${icon}${on ? " is-on" : ""}`);
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
    return;
  }

  const box = element("div", "drawer-live note-body");
  box.setAttribute("aria-label", "Note");
  editable(box, note.body, () => {
    draft = markersOf(box);
    later();
  });
  box.addEventListener("focus", () => { repaint = false; settle(); });
  box.addEventListener("blur", () => {
    draft = markersOf(box);
    void save().then(() => { if (repaint) { render(); paint(); } });
    settle();
  });
  box.addEventListener("keydown", event => {
    /* ⚠️ Escape lets go of the note rather than discarding it — there is
     * nothing to discard any more, because it has been saving all along. It
     * shuts the drawer, which is what Escape means everywhere else here. */
    if (event.key === "Escape") {
      event.preventDefault();
      box.blur();
      locked = false;
      settle();
    }
  });
  panel.append(box);
  live = box;
}

/** The few things that change without the note changing. ⚠️ Written into the
 *  elements, never rendered: the caret is in the note. */
function freshen() {
  host.classList.toggle("is-locked", locked);
  const pin = host.querySelector<HTMLElement>(".drawer-pin");
  if (!pin) return;
  pin.classList.toggle("is-on", locked);
  const said = locked ? "Let it close" : "Keep it open";
  pin.dataset.tip = said;
  pin.setAttribute("aria-label", said);
}

/* ── Moving it along the edge ────────────────────────────────────────────
 *
 * ⚠️ The SAME gesture as dragging a note out of the island, and for the same
 * reason: where the pointer is on a desk with three monitors is a question
 * only Rust can answer. This page knows `screenX` in its own window's CSS
 * pixels and its own monitor's scale — so working out which half of which
 * screen the pointer is in meant multiplying by a scale factor that belongs to
 * a different display, and the drawer flipped edges the moment it was dragged
 * on a secondary monitor.
 *
 * So the page starts a drag session and stops it. The ghost, the zones, the
 * edge and the position all come back as `notch:note-dock` events, exactly as
 * they do when the note is dragged out of the wall — one gesture, one answer,
 * written once. */
function grab(tab: HTMLElement, tap = true) {
  let from: { x: number; y: number } | null = null;
  let moved = false;

  tab.addEventListener("pointerdown", event => {
    if (event.button !== 0) return;
    from = { x: event.screenX, y: event.screenY };
    moved = false;
    tab.setPointerCapture(event.pointerId);
  });

  tab.addEventListener("pointermove", event => {
    if (!from || moved) return;
    if (Math.abs(event.screenY - from.y) < 4 && Math.abs(event.screenX - from.x) < 4) return;
    moved = true;
    /* ⚠️ The whole window counts as chrome for the duration. The drawer is
     * click-through outside its shape, and a drag that wandered a few pixels
     * off it would have the pointer taken away mid-gesture. */
    sliding = true;
    report();
    /* ⚠️ `moving`, because this note is already on an edge. Sliding it along
     * that same edge shows no drop zones: a zone lighting up where the note
     * already lives, telling you to dock it where it is docked, is a question
     * nobody asked — and it is drawn over the note being moved. */
    void call("note_drag_start", { id, moving: true }).catch(() => {});
    /* ⚠️ The window hears the release too — see the same guard on the island's
     * cards. A drawer that is redrawn mid-drag loses the element holding the
     * capture, and with it the only `pointerup` anybody was waiting for. */
    window.addEventListener("pointerup", drop);
    window.addEventListener("pointercancel", drop);
  });

  const drop = (event: PointerEvent) => {
    window.removeEventListener("pointerup", drop);
    window.removeEventListener("pointercancel", drop);
    if (!from) return;
    from = null;
    tab.releasePointerCapture?.(event.pointerId);
    if (!moved) {
      // A press that went nowhere is a press: keep the note open, or let go.
      // ⚠️ On the sliver only. The grip sits on the open note, where a stray
      // click that pinned it open would be a control nobody asked for.
      if (tap) {
        locked = !locked;
        freshen();
        settle();
      }
      return;
    }
    moved = false;
    sliding = false;
    void call("note_drag_end").catch(() => {});
    report();
  };
  tab.addEventListener("pointerup", drop);
  tab.addEventListener("pointercancel", event => {
    if (!from) return;
    from = null;
    tab.releasePointerCapture?.(event.pointerId);
    if (!moved) return;
    moved = false;
    sliding = false;
    void call("note_drag_end").catch(() => {});
    report();
  });
  tab.addEventListener("keydown", event => {
    if (!tap || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    locked = !locked;
    freshen();
    settle();
  });
}
grab(sliver);
grab(grip, false);

/* ── The pointer ─────────────────────────────────────────────────────────
 *
 * ⚠️ From RUST, not from the page. The window ignores cursor events wherever
 * it is not painted, and a window that ignores them receives none at all — so
 * the page cannot see the pointer arrive in the first place. `watch_pin` polls
 * the cursor against the rects `report` sends and says when it is on the
 * shape. The page's own enter and leave still run, and are what keep the
 * drawer open while the pointer moves about inside it. */
document.documentElement.addEventListener("pointerenter", () => {
  hovering = true;
  settle();
});
document.documentElement.addEventListener("pointerleave", () => {
  /* ⚠️ Never shuts while the caret is in it — `settle` asks. Taking the words
   * off screen mid-sentence because the pointer wandered is the one thing a
   * note that is also a window must not do. */
  hovering = false;
  // Minimising lasts until you walk away; after that the drawer is a drawer.
  dismissed = false;
  settle();
});


/* ── What Rust hands to this page ────────────────────────────────────────
 *
 * ⚠️ Installed at MODULE SCOPE, before anything is awaited, and that is the
 * whole of a bug that took two builds to find. These lived at the end of
 * `boot`, behind four awaits — reading the notes, measuring the monitor,
 * placing the window, showing it — so anything slow or throwing in that chain
 * left the drawer on screen with nothing listening. It logged that it was up
 * and then never logged one of the sixty dock messages a second aimed at it.
 * A page's contract with whoever drives it is not something to set up after
 * the page has finished getting ready.
 *
 * ⚠️ And they are FUNCTIONS, not event listeners: events do not arrive at a
 * window this app made at runtime. See `push` in notes.rs. */

/** The whole list, whenever it changes. */
window.__noteList = all => {
  const next = all.find(one => one.id === id) ?? null;
  /* Not while it is being typed into: the arriving list is what was saved
   * before this edit started, and painting it would take the words away. The
   * repaint is owed until the caret leaves. */
  if (typing()) { note = next; repaint = true; return; }
  note = next;
  /* ⚠️ The edge is re-read from the note as well. It is stored on the note, so
   * any list that arrives is also the answer to "which side am I on" — and a
   * page that only learns that from the drag messages is a page that stays
   * mirrored the wrong way if it ever misses one. */
  edge = next?.edge === "left" ? "left" : "right";
  host.dataset.edge = edge;
  render();
  paint();
};

/** Which edge, and how far down — sixty times a second while a note is being
 *  dragged, and once when it lands. */
let moves = 0;
window.__noteDock = at => {
  if (at.id !== id) return;
  moves += 1;
  if (moves % 45 === 1) {
    void call("log_line", {
      line: `dock #${moves} ${at.edge} y=${at.y} dragging=${at.dragging}`,
    }).catch(() => {});
  }
  edge = at.edge === "left" ? "left" : "right";
  barMiddle = at.y;
  host.dataset.edge = edge;
  /* ⚠️ REPAINTED here rather than left to `settle`. Which way the notch faces
   * is decided in `paint`, and `settle` can decline to do anything at all —
   * so the window moved to the other side of the screen and the shape stayed
   * mirrored for the side it started on. */
  paint();
  /* ⚠️ The page does NOT move the window while the drag is running.
   * `slide_pin` does, from the same poll that decides the edge. On the LAST
   * message the page takes the window back, which is also what puts it right
   * if the drag ended on another monitor. */
  if (!at.dragging) void measure().then(() => { void place(); });
  settle();
};

/** Shut, and stay shut, while any note is being dragged.
 *
 * ⚠️ Every docked note, not just the one being dragged. A drawer that opens
 * under the pointer mid-drag covers the very thing the drag is showing you —
 * and an open drawer is a 330px panel arriving over a 224px ghost. */
window.__noteFreeze = on => {
  frozen = on;
  if (on) locked = false;
  settle();
};

/** Whether the pointer is on the shape, from the watcher in Rust. */
window.__noteHover = at => {
  hovering = at.hover;
  settle();
};

/* ── Boot ────────────────────────────────────────────────────────────── */

async function boot() {
  try {
    const all = await call<Note[]>("get_notes");
    note = all.find(one => one.id === id) ?? null;
  } catch { /* the window says so */ }
  edge = note?.edge === "left" ? "left" : "right";
  draft = note?.body ?? "";
  render();
  paint();

  if (!native) return;
  await measure();
  /* Never docked before: halfway down, where the pointer already goes. */
  barMiddle = note?.y && note.y > 0 ? note.y : Math.round(field.y + field.h / 2);
  void call("log_line", { line: `drawer up for ${id}` }).catch(() => {});
  try {
    await place();
    report();
  } finally {
    /* ⚠️ Shown here and nowhere else — the window is built hidden so it is
     * never seen in the wrong corner. In a `finally` because a window that
     * stays hidden because a placement failed is a pin that silently did
     * nothing. */
    await win?.show();
  }

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
    paint();
  })();
} else {
  void boot();
}

if (native) {
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && !typing()) { locked = false; settle(); }
  });
}

export {};
