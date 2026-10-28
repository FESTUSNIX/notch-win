/* A floating list: the composer's `@` and `/` pickers, the Blocks menu, a
 * message's actions. One look and one set of keys wherever it opens.
 *
 * ⚠️ The menu is a SIBLING of whatever opens it, never its child. A menu
 * hung off a `<button>` puts every option inside a button — invalid HTML, and
 * the live consequence is a press on an option bubbling to the opener and
 * opening the menu it was just chosen from (AGENTS 223).
 *
 * ⚠️ Opaque, not frosted: `backdrop-filter` on anything inside the island
 * samples the island's own black, not the desktop (AGENTS 199).
 */
import { element } from "../dom";
import { paintIcon, type TaskIcon } from "../task-icons";
import { logoTile, type Face } from "../helm-parts";

export interface MenuItem {
  id: string;
  label: string;
  /** A second, quieter word at the end: a client, a key. */
  detail?: string;
  icon?: TaskIcon;
  /** A project's face instead of a glyph. */
  face?: Face | null;
  /** Characters of the label that matched what was typed. */
  hits?: number[];
  /** A switch's state, for a menu of toggles. */
  checked?: boolean;
  disabled?: boolean;
}

export class Menu {
  readonly el: HTMLElement;
  items: MenuItem[] = [];
  active = 0;
  /** The highlight was moved by hand (arrows, the pointer) since it opened. */
  private moved = false;
  private list: HTMLElement;
  private pick: (item: MenuItem) => void;
  /** Keep the menu open after a pick — a menu of switches. */
  private sticky: boolean;

  constructor(options: { label: string; className?: string; pick: (item: MenuItem) => void; sticky?: boolean }) {
    this.pick = options.pick;
    this.sticky = !!options.sticky;
    this.el = element("div", `k-menu ${options.className ?? ""}`.trim());
    this.el.hidden = true;
    this.list = element("div", "k-menu-list");
    this.list.setAttribute("role", "listbox");
    this.list.setAttribute("aria-label", options.label);
    this.el.append(this.list);
    // ⚠️ The press must not take the caret out of the field the menu serves.
    this.el.addEventListener("mousedown", event => event.preventDefault());
  }

  get open(): boolean { return !this.el.hidden; }

  show(items: MenuItem[], keep = false) {
    const was = this.items[this.active]?.id;
    this.items = items;
    /* ⚠️ The highlight is held by ID across a refill, only when it was moved
     * on purpose — a list re-ranked under a resting highlight runs the wrong
     * thing on Enter (AGENTS 183). */
    const at = keep && this.moved && was ? items.findIndex(one => one.id === was) : -1;
    this.active = at >= 0 ? at : Math.max(0, items.findIndex(one => !one.disabled));
    this.paint();
    if (this.el.hidden) {
      this.el.hidden = false;
      this.el.classList.remove("is-in");
      void this.el.offsetWidth;
      this.el.classList.add("is-in");
    }
  }

  hide() {
    this.el.hidden = true;
    this.items = [];
    this.moved = false;
  }

  /** The keys while it is open. Returns true when the key was the menu's. */
  key(event: KeyboardEvent): boolean {
    if (!this.open || !this.items.length) return false;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      for (let i = 1; i <= this.items.length; i++) {
        const next = (this.active + step * i + this.items.length * 4) % this.items.length;
        if (!this.items[next].disabled) { this.active = next; break; }
      }
      this.moved = true;
      this.paint();
      return true;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      const item = this.items[this.active];
      if (!item || item.disabled) return false;
      event.preventDefault();
      this.choose(item);
      return true;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      this.hide();
      return true;
    }
    return false;
  }

  private choose(item: MenuItem) {
    if (!this.sticky) this.hide();
    this.pick(item);
  }

  private paint() {
    this.list.replaceChildren();
    this.items.forEach((item, index) => {
      const row = element("button", `k-menu-item${index === this.active ? " is-active" : ""}${item.checked !== undefined ? " is-switch" : ""}`) as HTMLButtonElement;
      row.type = "button";
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(index === this.active));
      row.dataset.id = item.id;
      row.disabled = !!item.disabled;
      if (item.face !== undefined) row.append(logoTile(item.face, "sm"));
      else if (item.icon) {
        const mark = element("span", "k-menu-mark");
        paintIcon(mark, item.icon);
        row.append(mark);
      }
      const label = element("span", "k-menu-label");
      if (item.hits?.length) {
        const hits = new Set(item.hits);
        let run = "";
        let lit = false;
        const flush = () => {
          if (!run) return;
          label.append(lit ? element("b", "", run) : document.createTextNode(run));
          run = "";
        };
        [...item.label].forEach((char, i) => {
          const on = hits.has(i);
          if (on !== lit) { flush(); lit = on; }
          run += char;
        });
        flush();
      } else label.textContent = item.label;
      row.append(label);
      if (item.detail) row.append(element("span", "k-menu-detail", item.detail));
      if (item.checked !== undefined) {
        row.setAttribute("aria-checked", String(item.checked));
        row.append(element("span", `k-switch${item.checked ? " is-on" : ""}`));
      }
      row.addEventListener("pointermove", () => {
        if (this.active === index || item.disabled) return;
        this.active = index;
        this.moved = true;
        for (const [i, one] of [...this.list.children].entries()) {
          one.classList.toggle("is-active", i === index);
          one.setAttribute("aria-selected", String(i === index));
        }
      });
      row.onclick = event => {
        event.stopPropagation();
        if (!item.disabled) this.choose(item);
      };
      this.list.append(row);
    });
  }
}

/** A menu opened from a button: placed under it, closed by a press anywhere
 *  else — which is TESTED, not assumed (AGENTS 224: a blanket listener tears
 *  the option down before its own click can land). */
export class Dropdown {
  readonly menu: Menu;
  private anchor: HTMLElement;
  private away = (event: PointerEvent) => {
    const target = event.target as Node | null;
    if (target && (this.menu.el.contains(target) || this.anchor.contains(target))) return;
    this.close();
  };
  private keys = (event: KeyboardEvent) => {
    if (this.menu.key(event)) {
      if (!this.menu.open) this.close();
      event.stopPropagation();
    }
  };
  private items: () => MenuItem[];

  constructor(anchor: HTMLElement, host: HTMLElement, options: { label: string; items: () => MenuItem[]; pick: (item: MenuItem) => void; sticky?: boolean; className?: string }) {
    this.anchor = anchor;
    this.items = options.items;
    this.menu = new Menu({
      label: options.label,
      className: `k-dropdown ${options.className ?? ""}`,
      sticky: options.sticky,
      pick: item => { options.pick(item); if (options.sticky) this.menu.show(this.items(), true); else this.close(); },
    });
    host.append(this.menu.el);
    anchor.setAttribute("aria-haspopup", "true");
    anchor.setAttribute("aria-expanded", "false");
    anchor.addEventListener("click", event => {
      event.stopPropagation();
      if (this.menu.open) this.close();
      else this.openMenu();
    });
  }

  get open(): boolean { return this.menu.open; }

  openMenu() {
    this.menu.show(this.items());
    this.anchor.setAttribute("aria-expanded", "true");
    this.anchor.classList.add("is-open");
    document.addEventListener("pointerdown", this.away, true);
    document.addEventListener("keydown", this.keys, true);
  }

  refresh() { if (this.menu.open) this.menu.show(this.items(), true); }

  close() {
    this.menu.hide();
    this.anchor.setAttribute("aria-expanded", "false");
    this.anchor.classList.remove("is-open");
    document.removeEventListener("pointerdown", this.away, true);
    document.removeEventListener("keydown", this.keys, true);
  }
}
