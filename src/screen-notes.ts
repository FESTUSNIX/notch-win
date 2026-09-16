/* Notes: somewhere to put a thought without deciding where it goes.
 *
 * ⚠️ **Not tasks.** A task is something you have committed to doing, and
 * filing one costs a list, a day and a place in a hierarchy. Most of what you
 * want to write down is none of those — a licence key, a name you will need in
 * an hour, the shape of an idea — and putting that in a task list means making
 * a decision about it at the one moment you had no time to. See notes.rs.
 *
 * The screen is a field, a search, and the pile. Writing is one key; everything
 * else here is about finding the thing again a fortnight later.
 */
import { call, native } from "./task-client";
import { element } from "./dom";
import { paintIcon } from "./task-icons";
import { listen } from "@tauri-apps/api/event";
import { highlight, noteWhen, searchNotes, type Note } from "./notes";
import { blocks, plain, toggleList, toggleMark, type Block } from "./note-format";
import type { Activity } from "./island-activity";

export interface NotesDeps {
  /** ⚠️ Lift `WS_EX_NOACTIVATE`, or the field cannot be typed into. The island
   *  never takes focus; a `focus()` on its own puts the caret in the DOM and
   *  leaves the keystrokes going to whatever is actually in front. */
  focus: (active: boolean) => Promise<void>;
  say: (what: string, why: string) => void;
}

export class NotesScreen {
  readonly name = "notes" as const;
  notes: Note[] = [];
  /** The note being edited, or "" for a new one. */
  private editing = "";
  private query = "";
  /** Held here rather than read off the field at save time: the screen
   *  re-renders on every keystroke and the field is a new element each time. */
  private draft = "";
  private busy = false;

  private body!: HTMLTextAreaElement;

  constructor(private host: HTMLElement, private deps: NotesDeps, private changed: () => void) {}

  async boot() {
    if (native) await listen<Note[]>("notch:notes", e => { this.notes = e.payload; this.changed(); });
    try { this.notes = await call<Note[]>("get_notes"); } catch { /* none yet */ }
    this.changed();
  }

  /** ⚠️ Notes never claim the pill. Nothing about a note is time-sensitive —
   *  that is the entire difference between a note and a task — so there is
   *  never a moment when one of them is the most live thing on the machine. */
  activity(): Activity | null { return null; }

  title$() { return "Notes"; }

  tools() {
    return {
      tools: [{
        icon: "plus" as const,
        label: "New note",
        run: () => { void this.compose(""); },
      }],
    };
  }

  /** Open the composer on a note, or on a blank one. */
  async compose(id: string) {
    this.editing = id;
    this.draft = this.notes.find(note => note.id === id)?.body ?? "";
    this.changed();
    try {
      await this.deps.focus(true);
      this.body.focus();
      // The caret at the END of what is there, not selecting it: opening a note
      // to add a line is far commoner than opening one to replace it.
      this.body.setSelectionRange(this.draft.length, this.draft.length);
    } catch { /* the field is still there; it just has no caret yet */ }
  }

  /** Put a marker round the selection, and the caret back where it was.
   *
   * ⚠️ The field is written directly rather than through `changed()`. A
   * re-render replaces the textarea and takes the selection with it, which is
   * the one thing a formatting button must not do. */
  private wrap(field: HTMLTextAreaElement, marker: string) {
    const from = field.selectionStart ?? 0;
    const to = field.selectionEnd ?? from;
    const next = marker
      ? toggleMark(field.value, from, to, marker)
      : toggleList(field.value, from, to);
    field.value = next.body;
    this.draft = next.body;
    field.focus();
    field.setSelectionRange(next.from, next.to);
  }

  private async save() {
    if (this.busy) return;
    const body = this.draft.trim();
    const id = this.editing;
    /* Cleared and rendered BEFORE the write. The list arrives from Rust, and
     * leaving the words in the field until it does means a second Enter saves
     * them twice. */
    this.draft = "";
    this.editing = "";
    this.busy = true;
    this.changed();
    try {
      this.notes = await call<Note[]>("save_note", { id, body });
    } catch (error) {
      this.deps.say("Could not save", String(error).replace(/^invoke error: /i, ""));
      // Hand the words back rather than losing them to a failed write.
      this.draft = body;
      this.editing = id;
    } finally {
      this.busy = false;
      this.changed();
    }
  }

  /** Stick it to the desktop, or take it off again.
   *
   * ⚠️ The whole list comes back, because pinning is stored ON the note — so
   * this is the same round trip a save is, not a separate flag to keep in
   * step. */
  private async pin(id: string, pinned: boolean) {
    try { this.notes = await call<Note[]>("pin_note", { id, pinned }); }
    catch (error) {
      this.deps.say(pinned ? "Could not pin" : "Could not unpin",
        String(error).replace(/^invoke error: /i, ""));
    }
    this.changed();
  }

  private async remove(id: string) {
    try { this.notes = await call<Note[]>("remove_note", { id }); }
    catch (error) { this.deps.say("Could not delete", String(error)); }
    if (this.editing === id) { this.editing = ""; this.draft = ""; }
    this.changed();
  }

  render() {
    this.host.replaceChildren();

    /* ── Writing one ──────────────────────────────────────────────────── */
    const composer = element("div", `note-composer${this.editing ? " is-editing" : ""}`);
    const field = document.createElement("textarea");
    field.className = "note-field";
    field.rows = 2;
    field.maxLength = 20_000;
    field.placeholder = this.editing ? "Change the note…" : "Write something down…";
    field.setAttribute("aria-label", "Note");
    field.value = this.draft;
    field.oninput = () => {
      this.draft = field.value;
      /* ⚠️ No `changed()` here. The screen redraws on a keystroke and a redraw
       * replaces the textarea, which loses the caret, the selection and the
       * undo stack. The draft is kept in the field and read on save. */
      field.style.height = "auto";
      field.style.height = `${Math.min(160, field.scrollHeight)}px`;
    };
    field.onkeydown = event => {
      /* ⚠️ Enter SAVES, Shift+Enter is a newline. A quick note is one key or it
       * is not quick — and a textarea whose Enter does nothing is the shape
       * every "notes" box has, which is why nobody uses them for one line. */
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        this.draft = field.value;
        void this.save();
        return;
      }
      if (event.key === "Escape" && this.editing) {
        event.preventDefault();
        this.editing = "";
        this.draft = "";
        this.changed();
      }
    };
    /* Pointer down on the field is what lifts NOACTIVATE. ⚠️ Not `focus`: the
     * focus event arrives after the click has already been given to whatever
     * was in front, which is the whole trap. */
    composer.addEventListener("pointerdown", () => {
      if (!this.busy) void this.deps.focus(true).catch(() => {});
    });
    composer.append(field);

    /* ── The formatting, such as it is ────────────────────────────────
     * ⚠️ The buttons write MARKERS into the text; they do not switch the
     * field into a rich editor. The note stays the characters you typed, so it
     * is greppable, it survives being pasted somewhere else, and the worst a
     * bug in the parser can do is make a note look wrong rather than lose a
     * word of it. See note-format.ts. */
    const actions = element("div", "note-actions");
    const marks = element("div", "note-marks");
    for (const [label, title, run] of [
      ["B", "Bold", () => this.wrap(field, "**")],
      ["I", "Italic", () => this.wrap(field, "*")],
      ["•", "List", () => this.wrap(field, "")],
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
    actions.append(marks);
    if (this.editing) {
      const cancel = element("button", "note-cancel", "Cancel");
      (cancel as HTMLButtonElement).type = "button";
      cancel.onclick = () => { this.editing = ""; this.draft = ""; this.changed(); };
      actions.append(cancel);
    }
    const save = element("button", "note-save", this.editing ? "Save" : "Add note");
    (save as HTMLButtonElement).type = "button";
    (save as HTMLButtonElement).disabled = this.busy;
    save.onclick = () => { this.draft = field.value; void this.save(); };
    actions.append(save);
    composer.append(actions);
    this.host.append(composer);
    this.body = field;

    /* ── Finding one ──────────────────────────────────────────────────── */
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

    /* ── The pile ─────────────────────────────────────────────────────── */
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
      const card = element("article", `note-card${note.id === this.editing ? " is-editing" : ""}`
        + (note.pinned ? " is-pinned" : ""));

      const open = element("button", "note-open");
      (open as HTMLButtonElement).type = "button";
      open.setAttribute("aria-label", `Edit ${plain(note.body).slice(0, 40)}`);
      open.append(this.paper(note.body));
      open.onclick = () => { void this.compose(note.id); };
      card.append(open);

      const foot = element("div", "note-foot");
      foot.append(element("span", "note-when", noteWhen(note.written, now)));
      const doing = element("div", "note-doing");
      for (const [icon, label, run] of [
        /* ⚠️ Pin is FIRST and stays visible while it is on. The other two are
         * revealed by the pointer; a pinned note has to say so at rest, or the
         * only way to know which of nine notes is on your desktop is to go and
         * look at the desktop. */
        ["pin", note.pinned ? "Unpin" : "Pin to the desktop",
          () => { void this.pin(note.id, !note.pinned); }],
        ["copy", "Copy", () => { void call("copy_text", { text: note.body }).catch(() => {}); }],
        ["close", "Delete", () => { void this.remove(note.id); }],
      ] as const) {
        const button = element("button",
          `note-do${icon === "pin" ? " note-pin" : ""}${icon === "pin" && note.pinned ? " is-on" : ""}`);
        (button as HTMLButtonElement).type = "button";
        button.setAttribute("aria-label", icon === "pin" ? label : `${label} note`);
        button.dataset.tip = label;
        paintIcon(button, icon);
        button.onclick = run;
        doing.append(button);
      }
      foot.append(doing);
      card.append(foot);
      list.append(card);
    }
    this.host.append(list);
  }

  /** A note, as it was written — lists as lists, bold as bold.
   *
   * ⚠️ Built from the parsed structure with text nodes, never `innerHTML`.
   * A note is arbitrary text pasted from somewhere, and the one thing you must
   * not do with that is hand it to something that builds elements. */
  private paper(body: string): HTMLElement {
    const sheet = element("div", "note-body");
    const parsed = blocks(body);
    let list: HTMLElement | null = null;

    for (const block of parsed) {
      /* Consecutive bullets share one list, so the marker column lines up and
       * a gap between two of them is a gap rather than two lists. */
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
        this.runs(item, block);
        list.append(item);
        continue;
      }
      list = null;
      const tag = block.kind === "head" ? "h4" : block.kind === "code" ? "pre" : "p";
      const line = element(tag as "p", `note-${block.kind}`);
      this.runs(line, block);
      sheet.append(line);
    }
    if (!parsed.length) sheet.append(element("p", "note-para", ""));
    return sheet;
  }

  /** One block's runs, with the search hits lit inside them. */
  private runs(host: HTMLElement, block: Block) {
    for (const span of block.spans) {
      const tag = span.code ? "code" : span.bold ? "strong"
        : span.italic ? "em" : span.strike ? "s" : "span";
      const run = element(tag as "span", "");
      /* ⚠️ The highlight is applied INSIDE a run, not over the line. Applied
       * over the line it would have to slice through the formatting and every
       * mark would have to be re-opened on the other side of a hit. */
      for (const [index, part] of highlight(span.text, this.query).entries()) {
        if (!part) continue;
        run.append(index % 2 ? element("b", "note-hit", part) : document.createTextNode(part));
      }
      host.append(run);
    }
  }


}
