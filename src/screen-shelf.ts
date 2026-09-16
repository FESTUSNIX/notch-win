/* A place to put a thing down.
 *
 * Drop a file on the island, or press the shelf shortcut and whatever is on
 * the clipboard lands here. Later you take it out again — into Explorer, a
 * message, an upload field — wherever you were going with it.
 *
 * Two ways out, because they suit different destinations. **Drag a row** and
 * it becomes a real OLE drag carrying a `CF_HDROP` — see `dragout.rs`, and note
 * that a page cannot do this itself, which is why it starts in Rust. **Copy**
 * puts the same `CF_HDROP` on the clipboard, which is easier to aim at an
 * upload field or a chat box than a drag from a strip welded to the bezel.
 */
import { listen } from "@tauri-apps/api/event";
import { element } from "./dom";
import { paintIcon, type TaskIcon } from "./task-icons";
import { call, native } from "./task-client";
import type { Activity } from "./island-activity";

export interface ShelfItem {
  id: string;
  kind: "file" | "text" | "link";
  name: string;
  path: string | null;
  text: string | null;
  addedMs: number;
  missing: boolean;
  size: number;
}

/** The card's smallest comfortable width, the gap between cards, and the
 *  screen body's own padding — all in CSS pixels, all matching `tasks.css`.
 *  ⚠️ Here because the column count is arithmetic, and arithmetic cannot read
 *  a stylesheet. Change one and change the other. */
const CARD_MIN = 128;
const GRID_GAP = 9;
const SCREEN_PAD = 15;

const ICONS: Record<ShelfItem["kind"], TaskIcon> = {
  file: "file",
  text: "note",
  link: "link",
};

/** `4.2 MB`. Nothing on a shelf row needs more precision than that. */
export function fileSize(bytes: number): string {
  if (!bytes) return "";
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(bytes < 1e7 ? 1 : 0)} MB`;
  if (bytes >= 1000) return `${Math.round(bytes / 1000)} KB`;
  return `${bytes} B`;
}

export class ShelfScreen {
  readonly name = "shelf" as const;
  items: ShelfItem[] = [];
  /** Set for a moment after a copy, so the row can say it worked. */
  private copied = "";
  /** id -> its preview, or `null` for "asked, and there is none". ⚠️ The
   *  null matters: without it a file the shell cannot preview is asked about
   *  again on every single render, forever. */
  private art = new Map<string, string | null>();
  error = "";

  /**
   * @param wide how wide the panel will BE, in CSS pixels. ⚠️ Not how wide it
   *             is: the panel's width is sprung, so at the moment this screen
   *             is first laid out it is still whatever the last one asked for.
   *             An `auto-fill` grid measured against that wraps to two rows,
   *             the island opens to twice the height it needs, and then drops
   *             — see `render`.
   */
  constructor(
    private host: HTMLElement,
    private changed: () => void,
    private wide: () => number,
  ) {}

  async boot() {
    try {
      this.items = await call<ShelfItem[]>("get_shelf");
    } catch { /* nothing shelved yet */ }
    if (native) {
      await listen<ShelfItem[]>("notch:shelf", event => {
        this.items = event.payload;
        this.changed();
      });
    }
  }

  /** ⚠️ Never claims the pill. A shelf is a place you put things, not a thing
   *  that happens — it has no news and nothing that expires. What a capture
   *  does raise is the shell's own transient notice, which says what landed
   *  and gets out of the way. */
  activity(): Activity | null { return null; }

  /** Take a path list from a native drop. */
  async dropped(paths: string[]) {
    try {
      await call("shelf_add_paths", { paths });
    } catch (error) {
      this.error = String(error);
      this.changed();
    }
  }

  private async act(item: ShelfItem, command: string) {
    try {
      await call(command, { id: item.id });
      this.error = "";
      if (command === "shelf_copy") {
        this.copied = item.id;
        this.changed();
        window.setTimeout(() => {
          if (this.copied !== item.id) return;
          this.copied = "";
          this.changed();
        }, 1600);
        return;
      }
    } catch (error) {
      this.error = String(error);
    }
    this.changed();
  }

  /* ── Dragging one back out ──────────────────────────────────────────────
   *
   * ⚠️ A native OLE drag, started from Rust — see `dragout.rs`. It cannot be
   * an HTML5 drag: a page can offer text or a URL, and Explorer wants a
   * `CF_HDROP`.
   *
   * ⚠️ And it must start from a pointer that has already MOVED. `DoDragDrop`
   * takes over the mouse the instant it is called, so starting it on
   * `pointerdown` would turn every click on a row — including the ones aimed
   * at the buttons beside it — into a drag nobody asked for. Six pixels is the
   * usual threshold and it is what separates the two gestures. */
  private armDrag(row: HTMLElement, item: ShelfItem) {
    if (item.missing || !item.path) return;
    let from: { x: number; y: number } | null = null;
    row.addEventListener("pointerdown", event => {
      // Not from the buttons: those have their own jobs.
      if ((event.target as HTMLElement).closest(".shelf-do")) return;
      if (event.button === 0) from = { x: event.screenX, y: event.screenY };
    });
    row.addEventListener("pointermove", event => {
      if (!from) return;
      if (Math.hypot(event.screenX - from.x, event.screenY - from.y) < 6) return;
      from = null;
      row.classList.add("is-leaving");
      window.setTimeout(() => row.classList.remove("is-leaving"), 600);
      void call("shelf_drag", { id: item.id }).catch((error: unknown) => {
        this.error = String(error);
        this.changed();
      });
    });
    for (const done of ["pointerup", "pointercancel"] as const) {
      row.addEventListener(done, () => { from = null; });
    }
  }

  /** What the card calls this thing's format: the extension for a file, the
   *  kind for anything else.
   *
   * ⚠️ Taken off the NAME, not the path. A shelved link or a scrap of text
   * has no path at all, and a file whose path is gone still has the name it
   * was parked under — which is the one thing about it that survives the file
   * being moved. */
  private format(item: ShelfItem): string {
    if (item.kind !== "file") return item.kind === "link" ? "LINK" : "TEXT";
    const dot = item.name.lastIndexOf(".");
    /* A leading dot is a dotfile, not an extension — `.gitignore` is not a
     * GITIGNORE. And anything past a handful of characters is a sentence that
     * happens to contain a full stop. */
    if (dot <= 0 || dot === item.name.length - 1) return "FILE";
    const ext = item.name.slice(dot + 1);
    return ext.length <= 5 ? ext.toUpperCase() : "FILE";
  }

  /** Ask the shell for a picture of this file, and put it on the plinth.
   *
   * ⚠️ The glyph is drawn FIRST and replaced if a picture arrives. Waiting
   * for the answer before drawing anything gives a shelf of empty squares for
   * as long as the thumbnails take, and most files have no preview at all — a
   * `.zip` is a glyph however long you wait for it.
   *
   * ⚠️ Remembered across renders. The shelf re-renders on every screen
   * change, and asking the shell again each time is a round trip per card for a
   * picture that has not changed. `thumbs.rs` caches on its side too; this is
   * about not making the call. */
  private picture(plinth: HTMLElement, item: ShelfItem) {
    const had = this.art.get(item.id);
    if (had === null) return;
    if (had) return void this.hang(plinth, had);
    void call<string | null>("shelf_thumb", { id: item.id })
      .then(uri => {
        this.art.set(item.id, uri ?? null);
        /* ⚠️ The plinth may be gone by now — a render replaced it while the
         * shell was thinking. `isConnected` is what says so; writing to a
         * detached node is silent and draws nothing. */
        if (uri && plinth.isConnected) this.hang(plinth, uri);
      })
      .catch(() => { this.art.set(item.id, null); });
  }

  private hang(plinth: HTMLElement, uri: string) {
    if (plinth.querySelector(".shelf-shot")) return;
    const shot = document.createElement("img");
    shot.className = "shelf-shot";
    shot.src = uri;
    shot.alt = "";
    /* ⚠️ `decoding="async"` and no width/height. The shell's previews are
     * whatever aspect the file is, and the plinth is a fixed 4:3 box — the
     * picture is fitted by CSS, not by attributes that would claim a size it
     * does not have. */
    shot.decoding = "async";
    plinth.append(shot);
  }

  private row(item: ShelfItem): HTMLElement {
    const row = element("div", `shelf-card${item.missing ? " is-missing" : ""}`);
    if (!item.missing && item.path) row.classList.add("can-drag");

    /* ⚠️ A PLINTH, not a thumbnail — yet. Drawing the real picture means
     * letting the WebView read the file, which is Tauri's asset protocol and a
     * scope decision, not a styling one. Until that is taken deliberately this
     * is a large glyph on a tinted ground, which is the same shape on the
     * screen and says the same three things about the item. */
    const mark = element("div", "shelf-plinth");
    mark.dataset.kind = item.kind;
    paintIcon(mark, ICONS[item.kind] ?? "file");
    if (item.kind === "file" && !item.missing) {
      mark.append(element("span", "shelf-ext", this.format(item)));
      this.picture(mark, item);
    }

    const copy = element("div", "shelf-copy");
    copy.append(element("span", "shelf-name", item.name));
    /* ⚠️ Format AND size, on one line, because a card has room for both and
     * a row never did. A missing file says so instead: neither number means
     * anything once the thing behind them is gone. */
    const note = item.missing
      ? "moved or deleted"
      : item.kind === "file"
        ? `${this.format(item)} · ${fileSize(item.size)}`
        : item.kind === "link"
          ? "link"
          : "note";
    if (note) copy.append(element("span", "shelf-note", note));

    const actions = element("div", "shelf-actions");
    /* Copy first and widest: it is what the shelf is for, and the other two
     * are conveniences. A missing file offers only removal — a button that
     * cannot work is worse than no button. */
    const buttons: [string, string, TaskIcon, boolean][] = item.missing
      ? [["shelf_remove", "Remove", "close", true]]
      : [
          ["shelf_copy", this.copied === item.id ? "Copied" : "Copy", this.copied === item.id ? "check" : "copy", true],
          ["shelf_open", "Open", "open", true],
          ["shelf_reveal", "Show in folder", "folder", item.kind === "file"],
          ["shelf_remove", "Remove", "close", true],
        ];
    for (const [command, label, icon, shown] of buttons) {
      if (!shown) continue;
      const button = element("button", `shelf-do${command === "shelf_copy" ? " lead" : ""}`);
      (button as HTMLButtonElement).type = "button";
      button.setAttribute("aria-label", `${label} ${item.name}`);
      button.dataset.tip = label;
      paintIcon(button, icon);
      button.onclick = () => { void this.act(item, command); };
      actions.append(button);
    }
    row.append(mark, copy, actions);
    this.armDrag(row, item);
    return row;
  }

  /** ⚠️ "Clear all" is a BUTTON, not a row at the foot of the list. It was a
   *  whole band of the screen for one destructive action nobody uses daily —
   *  and the sentence above it explained a gesture you want told once. */
  tools() {
    return {
      tools: this.items.length
        ? [{ icon: "close" as const, label: `Clear the shelf (${this.items.length})`,
             run: () => { void call("shelf_remove", { id: "" }).catch(() => {}); } }]
        : [],
    };
  }

  render() {
    this.host.replaceChildren();
    if (!this.items.length) {
      const empty = element("div", "shelf-empty");
      empty.append(
        element("p", "home-empty", "Nothing on the shelf."),
        element("p", "shelf-hint", "Drop a file on the island, or press the shelf shortcut to park whatever is on the clipboard."),
      );
      this.host.append(empty);
      return;
    }
    /* ⚠️ A GRID of its own, not the screen body. The body is a flex column
     * shared by every screen, and cards laid straight into it come out one per
     * row at full width — which is the list this replaced, with bigger
     * pictures. */
    const grid = element("div", "shelf-grid");
    /* ⚠️ The column count is COMPUTED, not left to `auto-fill`. `auto-fill`
     * asks the element how wide it is, and the answer while the panel is still
     * springing to this screen's width is the previous screen's — so the cards
     * wrapped to two rows, the island measured itself against that, opened at
     * twice the height it needed, and settled down a moment later. Worked out
     * from the width the panel is travelling TO, the first measurement is the
     * right one. */
    const room = this.wide() - 2 * SCREEN_PAD;
    const columns = Math.max(1, Math.floor((room + GRID_GAP) / (CARD_MIN + GRID_GAP)));
    grid.style.gridTemplateColumns = `repeat(${columns}, minmax(0, 1fr))`;
    for (const item of this.items) grid.append(this.row(item));
    this.host.append(grid);

    if (this.error) this.host.append(element("p", "screen-error", this.error));
  }
}
