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
import { element } from "./task-list";
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
  error = "";

  constructor(private host: HTMLElement, private changed: () => void) {}

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

  private row(item: ShelfItem): HTMLElement {
    const row = element("div", `shelf-row${item.missing ? " is-missing" : ""}`);
    if (!item.missing && item.path) row.classList.add("can-drag");
    const mark = element("span", "shelf-mark");
    paintIcon(mark, ICONS[item.kind] ?? "file");

    const copy = element("div", "shelf-copy");
    copy.append(element("span", "shelf-name", item.name));
    const note = item.missing
      ? "moved or deleted"
      : item.kind === "file"
        ? fileSize(item.size)
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
      button.title = label;
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
    for (const item of this.items) this.host.append(this.row(item));

    if (this.error) this.host.append(element("p", "screen-error", this.error));
  }
}
