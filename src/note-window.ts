/* One note, stuck to the desktop.
 *
 * ⚠️ This is the one window in the app that is MEANT to take focus. The island
 * is `WS_EX_NOACTIVATE` so that glancing at it never steals the caret, and
 * every field on it pays for that in plumbing; a sticky note you cannot click
 * into and type in is not a sticky note. It is an ordinary focusable window
 * that happens to be undecorated, always on top and off the taskbar.
 *
 * ⚠️ It reads and writes through the same commands the island does, so a note
 * changed here is changed there on the next `notch:notes` and vice versa.
 * There is one store; this is a second window onto it, not a second copy.
 */
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { call, native } from "./task-client";
import { element } from "./dom";
import { paintIcon } from "./task-icons";
import { blocks } from "./note-format";
import type { Note } from "./notes";
import "./tasks.css";

document.body.className = "sticky-page";

const id = new URLSearchParams(location.search).get("id") ?? "";
const host = document.getElementById("sticky")!;
const win = native ? getCurrentWindow() : null;

let note: Note | null = null;
let editing = false;
/** Held here rather than read back off the field: a redraw replaces it. */
let draft = "";

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

/* ── The window ──────────────────────────────────────────────────────── */

async function save() {
  const body = draft.trim();
  editing = false;
  try {
    const all = await call<Note[]>("save_note", { id, body });
    note = all.find(one => one.id === id) ?? null;
    /* An emptied note deletes itself, and the window has nothing left to show.
     * ⚠️ Closed from here rather than left as an empty square: `remove_note`
     * closes the window, but clearing the field goes through `save_note`. */
    if (!note) { await win?.close(); return; }
  } catch { /* the words are still in `draft`; the next save tries again */ }
  render();
}

function render() {
  host.replaceChildren();

  /* ⚠️ A drag STRIP, not the whole window. `data-tauri-drag-region` on the body
   * would make every press a drag, and the body is the thing you click to
   * edit — the note would be unwritable and it would look like the click doing
   * nothing. */
  const bar = element("div", "sticky-bar");
  bar.setAttribute("data-tauri-drag-region", "");
  const grip = element("span", "sticky-grip");
  grip.setAttribute("data-tauri-drag-region", "");
  bar.append(grip);

  const tools = element("div", "sticky-tools");
  for (const [icon, label, run] of [
    ["copy", "Copy", () => { void call("copy_text", { text: note?.body ?? "" }).catch(() => {}); }],
    ["close", "Unpin", () => { void call("pin_note", { id, pinned: false }).catch(() => {}); }],
  ] as const) {
    const button = element("button", "sticky-do");
    (button as HTMLButtonElement).type = "button";
    button.setAttribute("aria-label", label);
    button.title = label;
    paintIcon(button, icon);
    button.onclick = run;
    tools.append(button);
  }
  bar.append(tools);
  host.append(bar);

  if (!note) {
    host.append(element("p", "sticky-gone", "This note is gone."));
    return;
  }

  if (editing) {
    const field = document.createElement("textarea");
    field.className = "sticky-field";
    field.value = draft;
    field.maxLength = 20_000;
    field.setAttribute("aria-label", "Note");
    field.onkeydown = event => {
      // ⚠️ Ctrl+Enter here, not Enter. A sticky note is where a list goes, and
      // the island's composer is the one-line case; making Enter save would
      // mean Shift+Enter for every line of the thing this is mostly used for.
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        draft = field.value;
        void save();
      }
      /* ⚠️ The blur handler goes FIRST. Escape re-renders, the re-render
       * removes the textarea, removing it fires `blur` — and `blur` saves. So
       * "discard" saved the very words it was discarding, every time. */
      if (event.key === "Escape") {
        field.onblur = null;
        editing = false;
        draft = note?.body ?? "";
        render();
      }
    };
    field.oninput = () => { draft = field.value; };
    field.onblur = () => { draft = field.value; void save(); };
    host.append(field);
    field.focus();
    field.setSelectionRange(draft.length, draft.length);
    return;
  }

  const open = element("button", "sticky-open");
  (open as HTMLButtonElement).type = "button";
  open.setAttribute("aria-label", "Edit this note");
  open.append(paper(note.body));
  open.onclick = () => { editing = true; draft = note?.body ?? ""; render(); };
  host.append(open);
}

/* ── Where it was left ───────────────────────────────────────────────── */

/** ⚠️ DEBOUNCED, and that is the whole of it. Tauri reports a move for every
 *  pixel of a drag, so writing on the event itself is four hundred writes to
 *  disk for one gesture. This fires once, a third of a second after the note
 *  stops moving — and the drag is over by then, so the position it reads is
 *  the one it was let go at. */
let settling = 0;
function rememberSoon() {
  clearTimeout(settling);
  settling = window.setTimeout(() => { void remember(); }, 350);
}

async function remember() {
  if (!win) return;
  try {
    const at = await win.outerPosition();
    const size = await win.innerSize();
    await call("place_note", { id, x: at.x, y: at.y, w: size.width, h: size.height });
  } catch { /* a position that did not save is a shrug, not an error */ }
}

async function boot() {
  try {
    const all = await call<Note[]>("get_notes");
    note = all.find(one => one.id === id) ?? null;
  } catch { /* the window says so */ }
  render();

  if (!native) return;
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

  /* ⚠️ The window's own events, not the page's. A drag started on
   * `data-tauri-drag-region` is handled by the OS from the mouse-down onwards,
   * and the WebView never sees the move or the release — so a `pointerup`
   * listener here fires for clicks and never for drags, which is exactly
   * backwards. */
  await win?.onResized(() => rememberSoon());
  await win?.onMoved(() => rememberSoon());
}

/* The preview has no Tauri, so it stages a note from the demo store instead of
 * failing to open a window. */
if (!native) {
  void (async () => {
    const all = await call<Note[]>("get_notes");
    note = all[0] ?? null;
    render();
  })();
} else {
  void boot();
}

if (native) {
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && !editing) void win?.close();
  });
}

export {};
