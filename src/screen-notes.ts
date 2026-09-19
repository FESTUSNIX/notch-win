/* Notes: somewhere to put a thought without deciding where it goes.
 *
 * ⚠️ **Not tasks.** A task is something you have committed to doing, and
 * filing one costs a list, a day and a place in a hierarchy. Most of what you
 * want to write down is none of those — a licence key, a name you will need in
 * an hour, the shape of an idea — and putting that in a task list means making
 * a decision about it at the one moment you had no time to. See notes.rs.
 *
 * ⚠️ **Two screens, not one.** The wall is the index: colour, first words,
 * when. Pressing one opens THE NOTE — a full sheet you read and write in the
 * same place, with no separate "edit" mode to be in or out of. The version
 * before this had a two-row composer at the top and the notes themselves as
 * thumbnails underneath, so the one thing on screen you could type into was
 * the smallest thing on it, and opening a note meant watching its words jump
 * out of the card and into a box somewhere else.
 */
import { call, native } from "./task-client";
import { element } from "./dom";
import { paintIcon } from "./task-icons";
import { listen } from "@tauri-apps/api/event";
import {
  highlight, noteTitle, noteWhen, searchNotes, TINTS, tintOf, type Note,
} from "./notes";
import { plain } from "./note-format";
import { caretToEnd, editable, mark as markUp, markersOf, render } from "./note-live";
import type { Activity } from "./island-activity";

export interface NotesDeps {
  /** ⚠️ Lift `WS_EX_NOACTIVATE`, or the field cannot be typed into. The island
   *  never takes focus; a `focus()` on its own puts the caret in the DOM and
   *  leaves the keystrokes going to whatever is actually in front. */
  focus: (active: boolean) => Promise<void>;
  say: (what: string, why: string) => void;
}

/** How long after the last keystroke the sheet writes itself down.
 *
 * ⚠️ There is no save button on the sheet, and this is what replaces it. Short
 * enough that closing the island a second after typing keeps the words, long
 * enough that a sentence is one write rather than forty. Every path that can
 * take the sheet off screen also flushes, so this is the ceiling on how much
 * can be lost, not the mechanism. */
const SAVE_AFTER = 650;

export class NotesScreen {
  readonly name = "notes" as const;
  notes: Note[] = [];
  /** The note on screen, "" for a new unsaved one, or `null` for the wall. */
  private open: string | null = null;
  private query = "";
  /** Held here rather than read off the field at save time: the screen can be
   *  rebuilt under it and the field is a new element when it is. */
  private draft = "";
  private busy = false;
  private saving = 0;
  /** True while a card is being dragged out to the screen edge. */
  private dragging = false;
  /** The live editor, while a sheet is open. ⚠️ Not a textarea: the note is
   *  drawn as itself and typed into in place — see note-live.ts. */
  private field: HTMLElement | null = null;
  /** The delete button, once it has been pressed once. */
  private armed = 0;

  constructor(private host: HTMLElement, private deps: NotesDeps, private changed: () => void) {}

  async boot() {
    if (native) {
      await listen<Note[]>("notch:notes", e => {
        this.notes = e.payload;
        /* ⚠️ No redraw while a sheet is open. Every save round-trips through
         * Rust and comes back as this event, and a redraw replaces the
         * textarea — so autosaving would take the caret, the selection and the
         * undo stack away mid-sentence, roughly twice a line. The sheet is
         * already showing what was sent; the wall behind it is rebuilt when it
         * comes back. */
        if (this.open !== null) return;
        this.changed();
      });
    }
    try { this.notes = await call<Note[]>("get_notes"); } catch { /* none yet */ }
    this.changed();
  }

  /** ⚠️ Notes never claim the pill. Nothing about a note is time-sensitive —
   *  that is the entire difference between a note and a task — so there is
   *  never a moment when one of them is the most live thing on the machine. */
  activity(): Activity | null { return null; }

  title$() { return this.open === null ? "Notes" : "Note"; }

  tools() {
    /* On the sheet the plus would open a second one over the first, and the
     * one control that screen needs is the way out — which is the island's
     * arrow, already beside the name. */
    if (this.open !== null) return { tools: [] };
    return {
      tools: [{
        icon: "plus" as const,
        label: "New note",
        run: () => { void this.compose(""); },
      }],
    };
  }

  /** Whether one note is on screen rather than the wall. The island's header
   *  reads this to decide what its arrow means — see `paintBack`. */
  isDetailed(): boolean { return this.open !== null; }

  /** Back to the wall, keeping whatever was typed. */
  showList() {
    if (this.open === null) return;
    this.leave();
    this.changed();
  }

  /** The screen is being left — for the wall, or for another screen.
   *
   * ⚠️ Walking away WRITES. The sheet is the editor, so leaving it with
   * words in it is the commonest way anything here gets written down, and the
   * autosave's timer is only a ceiling on what a crash could cost.
   *
   * ⚠️ And it does not redraw: `show()` calls this on its way to another
   * screen and renders once at the end, so a redraw here is a second render of
   * a screen that is about to be hidden. */
  leave() {
    if (this.open === null) return;
    /* ⚠️ Started BEFORE the sheet is forgotten and finished after. `flush`
     * reads which note it is writing on its first line, so the id is already
     * captured — and the wall behind is drawn from a list that only arrives
     * when the write comes back, so it is redrawn then rather than left a
     * note short until something else happens to render. */
    const writing = this.flush();
    this.open = null;
    this.draft = "";
    this.field = null;
    void writing.then(() => this.changed()).catch(() => {});
  }

  /** Open a note, or a blank one. */
  async compose(id: string) {
    if (this.open !== null && this.open !== id) await this.flush();
    this.open = id;
    this.draft = this.notes.find(note => note.id === id)?.body ?? "";
    this.field = null;
    this.changed();
    try {
      await this.deps.focus(true);
      /* ⚠️ Read through a method, not off the property. `changed()` renders
       * the sheet and the render is what puts the editor there — but the
       * assignment three lines up is the last thing TypeScript can see, so it
       * narrows the property to `null` and every use below becomes `never`. A
       * call it cannot see through is the honest way to say "this changed". */
      const field = this.editor();
      if (!field) return;
      field.focus();
      // The caret at the END of what is there, not selecting it: opening a note
      // to add a line is far commoner than opening one to replace it.
      caretToEnd(field);
    } catch { /* the sheet is still there; it just has no caret yet */ }
  }

  /** The live editor, if a sheet is open. See `compose`. */
  private editor(): HTMLElement | null { return this.field; }

  /** Bold, italic or a list, on whatever is selected.
   *
   * ⚠️ The editor is left to do it. The old version rewrote the whole body
   * as a string and put the caret back by index, which is the right shape for a
   * textarea and the wrong one for a surface where the text is already drawn:
   * the browser knows where the selection is inside the marks it made. */
  private format(what: "bold" | "italic" | "list") {
    const field = this.field;
    if (!field) return;
    markUp(field, what);
    this.draft = markersOf(field);
    this.later();
  }

  /** Write it down shortly, unless something happens first. */
  private later() {
    clearTimeout(this.saving);
    this.mark("…");
    this.saving = window.setTimeout(() => { void this.flush(); }, SAVE_AFTER);
  }

  /** Write it down now.
   *
   * ⚠️ Never calls `changed()`. This runs while the caret is in the field —
   * that is the whole point of an autosaving sheet — and a redraw here is a
   * lost caret every time a sentence pauses. What it does instead is keep the
   * id, so the second save edits the note the first one created rather than
   * writing a new one. */
  private async flush() {
    clearTimeout(this.saving);
    if (this.open === null || this.busy) return;
    const body = this.draft.trim();
    const id = this.open;
    const before = this.notes.find(note => note.id === id)?.body ?? "";
    // Nothing to say, and nothing said before: a blank new note is not a note.
    if (body === before.trim() || (!body && !id)) { this.mark(""); return; }
    this.busy = true;
    try {
      this.notes = await call<Note[]>("save_note", { id, body });
      /* ⚠️ Newest first, so a note that has just been created is the head of
       * the list that comes back. Without this the sheet would still be on ""
       * and the next keystroke would write a second note.
       *
       * ⚠️ And the host is re-stamped with it. `render` decides whether the
       * open sheet may be left alone by comparing the two, so an id that
       * changed here and nowhere else means the very next render rebuilds the
       * sheet — taking the caret out of it one save into writing. */
      if (!id && body && this.open === id) {
        this.open = this.notes[0]?.id ?? "";
        this.host.dataset.note = this.open;
      }
      this.mark("Saved");
    } catch (error) {
      this.mark("Not saved");
      this.deps.say("Could not save", String(error).replace(/^invoke error: /i, ""));
    } finally {
      this.busy = false;
    }
  }

  /** The one word in the corner of the sheet that says where the words are.
   *  ⚠️ Written into the element rather than rendered: see `flush`. */
  private mark(said: string) {
    const state = this.host.querySelector<HTMLElement>(".note-state");
    if (state) state.textContent = said;
  }

  /** Stick it to the edge of the screen, or take it off again.
   *
   * ⚠️ The whole list comes back, because pinning is stored ON the note — so
   * this is the same round trip a save is, not a separate flag to keep in
   * step. */
  private async pin(id: string, pinned: boolean, where?: { edge: string; y: number }) {
    try {
      this.notes = await call<Note[]>("pin_note", { id, pinned, ...(where ?? {}) });
    } catch (error) {
      this.deps.say(pinned ? "Could not pin" : "Could not unpin",
        String(error).replace(/^invoke error: /i, ""));
    }
    this.changed();
  }

  /** Delete, on the second press.
   *
   * ⚠️ A note is the only thing this app stores that is not a cache of
   * something else, and the button that throws one away sits 30px from the one
   * that copies it. So the first press ARMS it — the button turns red and says
   * so — and only the second does anything. It disarms itself after four
   * seconds, because a control left cocked is a worse trap than the one this
   * is fixing.
   *
   * ⚠️ Not a dialog. A dialog on the island would have to be a second
   * surface over a panel that is already small, and it would be dismissed by
   * the same click that opened it half the time. */
  private askFirst(button: HTMLElement) {
    const one = this.here();
    if (!one) { this.showList(); return; }
    if (button.classList.contains("is-armed")) {
      clearTimeout(this.armed);
      void this.remove(one.id);
      return;
    }
    button.classList.add("is-armed");
    button.setAttribute("aria-label", "Delete this note — press again");
    button.dataset.tip = "Press again to delete";
    clearTimeout(this.armed);
    this.armed = window.setTimeout(() => {
      button.classList.remove("is-armed");
      button.setAttribute("aria-label", "Delete");
      button.dataset.tip = "Delete";
    }, 4000);
  }

  private async remove(id: string) {
    clearTimeout(this.saving);
    try { this.notes = await call<Note[]>("remove_note", { id }); }
    catch (error) { this.deps.say("Could not delete", String(error)); }
    if (this.open === id) { this.open = null; this.draft = ""; this.field = null; }
    this.changed();
  }

  render() {
    /* ⚠️ Nothing is redrawn mid-drag. A drag out of the island is held by
     * pointer capture on the CARD, and a redraw replaces that card — which
     * releases the capture, cancels the gesture and leaves the note halfway to
     * the edge. Pinning writes to the store and the store answers with a list,
     * so without this the gesture kills itself on its own first frame. */
    if (this.dragging) return;
    /* ⚠️ The open sheet is built ONCE and then left alone. This screen is
     * redrawn by the island's own render, which runs on a clock and on every
     * unrelated thing that changes — and every one of those redraws would
     * replace the textarea the user is typing into. Nothing on the sheet
     * changes by itself; what does (the saved mark, the colour, the pin) is
     * written into the element it belongs to. */
    if (this.open !== null && this.host.dataset.note === this.open
        && this.field?.isConnected) {
      this.freshen();
      return;
    }
    this.host.replaceChildren();
    this.host.dataset.note = this.open ?? "";
    if (this.open !== null) { this.sheet(); return; }
    this.wall();
  }

  /** The note being shown, once it exists. */
  private here(): Note | null {
    return this.notes.find(one => one.id === this.open) ?? null;
  }

  /** The handful of things on an open sheet that change without the sheet
   *  changing — written into the elements rather than rebuilt, because the
   *  caret is in the middle of it. See `render`. */
  private freshen() {
    const note = this.here();
    const sheet = this.host.querySelector<HTMLElement>(".note-sheet");
    if (!sheet) return;
    const tint = tintOf(note);
    sheet.dataset.tint = tint;
    for (const swatch of sheet.querySelectorAll<HTMLElement>(".note-tint")) {
      swatch.setAttribute("aria-pressed", String((swatch.dataset.tint ?? "") === tint));
    }
    const pin = sheet.querySelector<HTMLElement>(".note-sheet-pin");
    if (!pin) return;
    const pinned = !!note?.pinned;
    pin.classList.toggle("is-on", pinned);
    const said = pinned ? "Undock" : "Dock to the screen edge";
    pin.dataset.tip = said;
    pin.setAttribute("aria-label", said);
  }

  /* ── One note, full size ──────────────────────────────────────────── */

  private sheet() {
    const id = this.open ?? "";
    const note = this.notes.find(one => one.id === id) ?? null;
    const sheet = element("div", "note-sheet");
    sheet.dataset.tint = tintOf(note);
    /* Pointer down on the sheet is what lifts NOACTIVATE. ⚠️ Not `focus`: the
     * focus event arrives after the click has already been given to whatever
     * was in front, which is the whole trap. */
    sheet.addEventListener("pointerdown", () => {
      void this.deps.focus(true).catch(() => {});
    });

    /* ── Colour, and what can be done to the whole note ─────────────── */
    const head = element("div", "note-sheet-head");
    const tints = element("div", "note-tints");
    tints.setAttribute("role", "group");
    tints.setAttribute("aria-label", "Colour");
    for (const { key, label } of TINTS) {
      const swatch = element("button", "note-tint");
      (swatch as HTMLButtonElement).type = "button";
      swatch.dataset.tint = key;
      swatch.dataset.tip = label;
      swatch.setAttribute("aria-label", label);
      swatch.setAttribute("aria-pressed", String(tintOf(note) === key));
      swatch.onclick = () => {
        /* ⚠️ Painted here as well as through the note, because a new note has
         * no id yet — its colour has to survive the first save rather than be
         * thrown away when the id arrives. */
        sheet.dataset.tint = key;
        for (const other of tints.querySelectorAll<HTMLElement>(".note-tint")) {
          other.setAttribute("aria-pressed", String(other.dataset.tint === key));
        }
        void (async () => {
          await this.flush();
          const saved = this.open;
          if (saved) await this.paintQuietly(saved, key);
        })();
      };
      tints.append(swatch);
    }
    head.append(tints);

    /* ⚠️ Every one of these reads `this.open` when it is PRESSED, never the
     * note this render closed over. A sheet opened on a blank note has no note
     * until the first autosave lands — and that save deliberately does not
     * redraw, so a button holding the id from build time would stay dead on
     * the one note you were most likely to want to dock. */
    const tools = element("div", "note-sheet-tools");
    const pinned = !!note?.pinned;
    for (const [icon, label, run] of [
      ["pin", pinned ? "Undock" : "Dock to the screen edge",
        (_button: HTMLElement) => {
          const one = this.here();
          if (one) void this.pin(one.id, !one.pinned);
        }],
      ["copy", "Copy",
        (_button: HTMLElement) => {
          void call("copy_text", { text: this.draft }).catch(() => {});
        }],
      ["close", "Delete",
        (button: HTMLElement) => this.askFirst(button)],
    ] as const) {
      const button = element("button",
        `note-sheet-do note-sheet-${icon}${icon === "pin" && pinned ? " is-on" : ""}`);
      (button as HTMLButtonElement).type = "button";
      button.dataset.tip = label;
      button.setAttribute("aria-label", label);
      paintIcon(button, icon);
      button.onclick = () => run(button);
      tools.append(button);
    }
    head.append(tools);
    sheet.append(head);

    /* ── The words ─────────────────────────────────────
     * ⚠️ The note DRAWN, and typed into where it is drawn. Bold is bold while
     * you write it and a list has bullets — the markers are what gets stored,
     * not what gets shown. A textarea showed everybody the source of their own
     * note, which is a thing only the person who wrote the parser wants. */
    const field = element("div", "note-sheet-live note-body");
    field.setAttribute("aria-label", "Note");
    field.dataset.placeholder = "Write something down…";
    editable(field, this.draft, () => {
      this.draft = markersOf(field);
      field.dataset.empty = this.draft ? "" : "yes";
      this.later();
    });
    field.dataset.empty = this.draft ? "" : "yes";
    field.addEventListener("keydown", event => {
      /* ⚠️ Enter is a NEWLINE here, where on the old two-row composer it
       * saved. This is the note itself at full size — the shape you write a
       * list in — and a sheet whose Enter throws you back to the wall is one
       * you cannot write a second line in. Saving happens on its own. */
      if (event.key === "Escape") {
        event.preventDefault();
        this.showList();
      }
    });
    field.addEventListener("blur", () => {
      this.draft = markersOf(field);
      void this.flush();
    });
    sheet.append(field);
    this.field = field;

    /* ── The markers, and where the words are ───────────────────────── */
    const foot = element("div", "note-sheet-foot");
    const marks = element("div", "note-marks");
    for (const [label, title, run] of [
      ["B", "Bold", () => this.format("bold")],
      ["I", "Italic", () => this.format("italic")],
      ["•", "List", () => this.format("list")],
    ] as const) {
      const button = element("button", `note-mark note-mark-${title.toLowerCase()}`, label);
      (button as HTMLButtonElement).type = "button";
      button.setAttribute("aria-label", title);
      button.dataset.tip = title;
      /* ⚠️ `pointerdown` + preventDefault, not `click`. A click on a button
       * takes focus off the textarea first, and the selection is gone by the
       * time the handler runs — so bold would wrap nothing, every time. */
      button.addEventListener("pointerdown", event => { event.preventDefault(); run(); });
      marks.append(button);
    }
    foot.append(marks);
    foot.append(element("span", "note-state", note ? noteWhen(note.edited, Date.now()) : ""));
    sheet.append(foot);
    this.host.append(sheet);
  }

  /** Colour a note without redrawing the sheet the caret is in. */
  private async paintQuietly(id: string, tint: string) {
    try { this.notes = await call<Note[]>("tint_note", { id, tint }); }
    catch { /* the swatch is already lit; the colour will come back on reload */ }
  }

  /* ── The pile ─────────────────────────────────────────────────────── */

  private wall() {
    /* ⚠️ Searched on the PLAIN text. On the raw body, `**every**` is found by
     * typing `**every**` and not by typing `every` — which is the one query
     * anybody would use. */
    const found = searchNotes(
      this.notes.map(note => ({ ...note, body: plain(note.body) })), this.query)
      .map(found => this.notes.find(note => note.id === found.id)!);
    /* ⚠️ The search appears once there is a pile to search. One note and a
     * search box is a control that cannot do anything, sitting where the note
     * should be. */
    if (this.notes.length > 4 || this.query) {
      const search = element("div", "note-search");
      const input = document.createElement("input");
      input.type = "search";
      input.className = "note-search-field";
      input.placeholder = `Search ${this.notes.length} notes…`;
      input.setAttribute("aria-label", "Search notes");
      input.value = this.query;
      input.oninput = () => {
        this.query = input.value;
        this.changed();
        // The list redrew under it; put the caret back where it was.
        requestAnimationFrame(() => {
          const next = this.host.querySelector<HTMLInputElement>(".note-search-field");
          if (next && next !== document.activeElement) {
            next.focus();
            next.setSelectionRange(next.value.length, next.value.length);
          }
        });
      };
      input.addEventListener("pointerdown", () => { void this.deps.focus(true).catch(() => {}); });
      search.append(input);
      if (this.query) {
        search.append(element("span", "note-count",
          `${found.length} of ${this.notes.length}`));
      }
      this.host.append(search);
    }

    if (!this.notes.length) {
      const empty = element("div", "day-empty");
      empty.append(element("h3", "", "Nothing written down"),
        element("p", "", "Anything you type here stays on this PC."));
      this.host.append(empty);
      return;
    }
    if (!found.length) {
      this.host.append(element("p", "note-none", "No note has all of those words."));
      return;
    }

    /* ⚠️ NOT a scroller of its own. `.screen-body` above it already is one,
     * and two nested scrollers meant the panel measured the wall's full
     * content height, capped itself at the island's maximum, and then clipped
     * the bottom row — which reads as a broken layout rather than as a list
     * that scrolls. One scroller per screen. */
    const list = element("div", "note-wall");
    const now = Date.now();
    for (const note of found) {
      /* ⚠️ The card is the BUTTON, not a card with a button inside it. It
       * does one thing — open the note — and a square of paper you can press
       * anywhere is what a note on a board is; a card holding an invisible
       * hit area that covers most but not all of it is the shape that makes
       * people press twice. */
      const card = element("button", `note-card${note.pinned ? " is-pinned" : ""}`);
      (card as HTMLButtonElement).type = "button";
      card.dataset.tint = tintOf(note);
      card.dataset.note = note.id;
      card.setAttribute("aria-label", `Open ${noteTitle(plain(note.body), 40) || "empty note"}`);
      card.append(this.paper(note.body));

      const foot = element("div", "note-foot");
      foot.append(element("span", "note-when", noteWhen(note.written, now)));
      if (note.pinned) {
        const mark = element("span", "note-docked");
        mark.dataset.tip = "On the screen edge";
        paintIcon(mark, "pin");
        foot.append(mark);
      }
      card.append(foot);

      card.onclick = () => { void this.compose(note.id); };
      this.dragOut(card, note);
      list.append(card);
    }
    this.host.append(list);
  }

  /* ── Dragging a note out of the island ────────────────────────────────
   *
   * ⚠️ Pointer CAPTURE, and that is the only reason this can work at all. The
   * gesture ends outside the window it started in — that is what "out" means —
   * and without capture the island stops hearing about the pointer the moment
   * it crosses its own edge, so every drag would look like a press that
   * wandered off.
   *
   * ⚠️ And the note DOCKS as you drag, rather than on release. A drag with no
   * preview is a drag of nothing: the card cannot leave the island's window,
   * so there is nothing under the pointer and nothing to say where it will
   * land. Docking live makes the real drawer the preview — it slides out of
   * the edge you are heading for, holding the note, and follows the pointer up
   * and down until you let go. Dropping it back on the island puts it away
   * again. */
  private dragOut(card: HTMLElement, note: Note) {
    let from: { x: number; y: number } | null = null;
    let frame = 0;
    let at = { edge: "right", y: 0 };

    /** Which side of the screen the pointer is on, and how far down.
     *
     * ⚠️ `screen.width` is the primary monitor in CSS pixels, which is what
     * `screenX` is measured in too — so these are comparable without knowing
     * the scale factor. `y` is physical, because that is what a window
     * position is. */
    const aimAt = (event: PointerEvent) => ({
      edge: event.screenX > window.screen.width / 2 ? "right" : "left",
      y: Math.round(event.screenY * (window.devicePixelRatio || 1)),
    });

    card.addEventListener("pointerdown", event => {
      if (event.button !== 0) return;
      from = { x: event.screenX, y: event.screenY };
      card.setPointerCapture(event.pointerId);
    });

    card.addEventListener("pointermove", event => {
      if (!from) return;
      const far = Math.hypot(event.screenX - from.x, event.screenY - from.y);
      /* ⚠️ A threshold, not any movement at all. A press always moves a pixel
       * or two, and a card that flies out on one of them is a card you cannot
       * click. */
      if (!this.dragging && far < 14) return;
      at = aimAt(event);
      if (!this.dragging) {
        this.dragging = true;
        card.classList.add("is-dragging");
        // The drawer appears, docked and open: the preview is the real thing.
        void this.pin(note.id, true, at);
        return;
      }
      /* ⚠️ One message per frame. A pointer reports faster than a window can
       * move, and every one of these crosses a process boundary. */
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        void call("drag_pin", { id: note.id, edge: at.edge, y: at.y }).catch(() => {});
      });
    });

    const drop = (event: PointerEvent) => {
      if (!from) return;
      from = null;
      card.releasePointerCapture?.(event.pointerId);
      if (!this.dragging) return;
      this.dragging = false;
      card.classList.remove("is-dragging");
      /* Let go over the island itself and the note is put away — the same
       * gesture backwards, which is how it reads whether the drag was a
       * mistake or a decision to take the note off the edge.
       *
       * ⚠️ The island's own BOX, not the window's. The window is bigger than
       * what is drawn in it, and a drag that ended on the transparent part
       * beside the panel would read as "never left" — which is the one place
       * it obviously did. */
      const box = document.getElementById("island")?.getBoundingClientRect();
      const home = !!box && event.clientX >= box.left && event.clientX <= box.right
        && event.clientY >= box.top && event.clientY <= box.bottom;
      if (home) {
        void this.pin(note.id, false);
        return;
      }
      void call("dock_note", { id: note.id, edge: at.edge, y: at.y }).catch(() => {});
      this.changed();
      // The click that would otherwise follow the release would open the note.
      const swallow = (click: Event) => { click.stopPropagation(); click.preventDefault(); };
      card.addEventListener("click", swallow, { capture: true, once: true });
    };
    card.addEventListener("pointerup", drop);
    card.addEventListener("pointercancel", event => {
      from = null;
      this.dragging = false;
      card.classList.remove("is-dragging");
      card.releasePointerCapture?.(event.pointerId);
    });
  }

  /** A note, as it was written — lists as lists, bold as bold.
   *
   * ⚠️ The same renderer the sheet and the docked drawer use — see
   * note-live.ts. Three copies of this walk meant a note could legitimately
   * look like three different notes. */
  private paper(body: string): HTMLElement {
    const sheet = element("div", "note-body");
    render(sheet, body, text => {
      const out: Node[] = [];
      for (const [index, part] of highlight(text, this.query).entries()) {
        if (!part) continue;
        out.push(index % 2
          ? element("b", "note-hit", part)
          : document.createTextNode(part));
      }
      return out;
    });
    return sheet;
  }
}
