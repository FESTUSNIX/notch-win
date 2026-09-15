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
import { highlight, noteTitle, notePreview, noteWhen, searchNotes, type Note } from "./notes";
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

    const actions = element("div", "note-actions");
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
    const found = searchNotes(this.notes, this.query);
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

    const list = element("div", "note-list scrolls");
    const now = Date.now();
    for (const note of found) {
      const row = element("div", `note-row${note.id === this.editing ? " is-editing" : ""}`);

      const open = element("button", "note-open");
      (open as HTMLButtonElement).type = "button";
      open.setAttribute("aria-label", `Edit ${noteTitle(note.body, 40)}`);
      const copy = element("div", "note-copy");
      copy.append(this.marked(noteTitle(note.body), "note-title"));
      const rest = notePreview(note.body);
      if (rest) copy.append(this.marked(rest, "note-preview"));
      open.append(copy);
      open.onclick = () => { void this.compose(note.id); };
      row.append(open);

      const side = element("div", "note-side");
      side.append(element("span", "note-when", noteWhen(note.written, now)));
      for (const [icon, label, run] of [
        ["copy", "Copy", () => { void call("copy_text", { text: note.body }).catch(() => {}); }],
        ["close", "Delete", () => { void this.remove(note.id); }],
      ] as const) {
        const button = element("button", "note-do");
        (button as HTMLButtonElement).type = "button";
        button.setAttribute("aria-label", `${label} note`);
        button.title = label;
        paintIcon(button, icon);
        button.onclick = run;
        side.append(button);
      }
      row.append(side);
      list.append(row);
    }
    this.host.append(list);
  }

  /** One line of a row, with the matched words lit.
   *
   * ⚠️ Built from text nodes, never `innerHTML`. A note is arbitrary text the
   * user pasted from somewhere, and the one thing you must not do with that is
   * hand it to a parser. */
  private marked(text: string, className: string): HTMLElement {
    const line = element("span", className);
    const parts = highlight(text, this.query);
    parts.forEach((part, index) => {
      if (!part) return;
      line.append(index % 2 ? element("b", "note-hit", part) : document.createTextNode(part));
    });
    return line;
  }
}
