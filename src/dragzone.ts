/* What you are dragging, and where it can go.
 *
 * ⚠️ A window of its own, covering the whole screen, because the island cannot
 * paint past its own edge. A drag OUT of the island ends somewhere the island
 * is not, so the card stayed behind and the gesture was a pointer moving over
 * the desktop with nothing under it — "I drag air".
 *
 * ⚠️ Click-through, always. It covers the entire screen; one moment of it
 * taking the pointer is every click on the desktop going nowhere. Which also
 * means it cannot see the pointer at all: `watch_drag` in notes.rs reads the
 * cursor and sends it here, sixty times a second, for the length of one drag.
 *
 * ⚠️ And it is told where the EDGES are as well as where the pointer is. The
 * same poll decides both, so the zone that lights up and the zone that docks
 * the note can never disagree — which they would the moment two sides worked
 * out "near the edge" from two different rectangles.
 */
import { listen } from "@tauri-apps/api/event";
import { call, native } from "./task-client";
import { element } from "./dom";
import { noteTitle, notePreview, tintOf, type Note } from "./notes";
import { plain } from "./note-format";
import "./tasks.css";

document.body.className = "dragzone-page";

/* ⚠️ The note comes from the EVENT, not from the URL. This window is made
 * once and reused for every drag after it, so a page that read its own `?id`
 * showed the first note ever dragged for the rest of the session. The query is
 * only what the preview stages from. */
let showing = "";
const host = document.getElementById("zones")!;

const left = element("div", "dropzone dropzone-left");
const right = element("div", "dropzone dropzone-right");
for (const zone of [left, right]) {
  zone.append(element("span", "dropzone-line"));
  zone.append(element("span", "dropzone-say", "Dock here"));
}
/* What is being dragged, under the pointer. ⚠️ A PIECE of the note, not the
 * whole card: at the size a card wants to be it covers what you are aiming
 * at, and the thing you need to see while dragging is the edge, not the
 * note. */
const ghost = element("div", "drag-ghost");
const ghostTitle = element("span", "drag-ghost-title");
const ghostRest = element("span", "drag-ghost-rest");
ghost.append(ghostTitle, ghostRest);
host.append(left, right, ghost);

/** The note being dragged, so the ghost is that note rather than a rectangle. */
async function stage(which: string) {
  try {
    const all = await call<Note[]>("get_notes");
    const note = all.find(one => one.id === which) ?? null;
    if (!note) return;
    const text = plain(note.body);
    ghost.dataset.tint = tintOf(note);
    ghostTitle.textContent = noteTitle(text, 34) || "Empty note";
    ghostRest.textContent = notePreview(text, 60);
  } catch { /* a ghost with no words is still a ghost */ }
}

/* ⚠️ The ghost is moved with a TRANSFORM and nothing else. This runs on every
 * pointer sample for as long as the drag lasts; writing `left`/`top` would lay
 * the page out sixty times a second on a window the size of the screen. */
function at(x: number, y: number) {
  ghost.style.transform = `translate3d(${x}px, ${y}px, 0)`;
}

/** A line in the app's log. ⚠️ `console.log` in a window nobody can open
 *  devtools on is a message to nobody, and this one is invisible by design. */
function say(what: string) {
  if (native) void call("log_line", { line: what }).catch(() => {});
}

if (native) {
  say(`up, ${window.innerWidth}x${window.innerHeight}`);
  let seen = 0;
  void listen<{ id: string; x: number; y: number; edge: string; done: boolean }>(
    "note:drag", event => {
      const { id, x, y, edge, done } = event.payload;
      if (done) {
        /* The drag is over and this window is about to be hidden. ⚠️ Reset,
         * because hiding keeps whatever was on screen — and the next drag
         * would open with the last one's ghost already in place. */
        seen = 0;
        showing = "";
        host.dataset.ready = "";
        left.classList.remove("is-near");
        right.classList.remove("is-near");
        return;
      }
      if (seen === 0) say(`first pointer at ${Math.round(x)},${Math.round(y)} edge=${edge}`);
      seen += 1;
      if (id !== showing) { showing = id; void stage(id); }
      at(x, y);
      host.dataset.ready = "yes";
      left.classList.toggle("is-near", edge === "left");
      right.classList.toggle("is-near", edge === "right");
    });
} else {
  /* The preview has no drag to follow, so it stages one: the zones as they
   * look when the pointer is in the left one, which is the state worth
   * looking at. */
  void (async () => {
    const all = await call<Note[]>("get_notes");
    const asked = new URLSearchParams(location.search).get("id") ?? "";
    await stage(asked || (all[0]?.id ?? ""));
    host.dataset.ready = "yes";
    left.classList.add("is-near");
    at(120, 260);
  })();
}

export {};
