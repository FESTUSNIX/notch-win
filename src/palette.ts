/* One surface over everything.
 *
 * The island had grown eight tabs and five shortcuts, and every action cost the
 * same four steps: reach the strip, wait for it to open, find the tab, click.
 * A palette collapses that to one gesture and one thing to learn, and it is
 * what makes eight tabs stop mattering — you rarely navigate by hand.
 *
 * ⚠️ It does NOT try to be Flow Launcher. Flow is a general launcher and is
 * better at that job; duplicating it badly would be worse than having both.
 * What this can do that Flow cannot is search the island's own world — the
 * shelf, the live agent sessions, today's tasks, what is snoozed — and act on
 * it in place. Complementary, not competing.
 *
 * Providers are plain functions returning actions, so a new screen adds its
 * commands by exporting a list rather than by touching this file.
 */
import { element } from "./task-list";
import { paintIcon, type TaskIcon } from "./task-icons";
import { search, type Match } from "./palette-match";
import { FRAME, cpx } from "./layout";
import type { IslandSurface } from "./island-surface";

export interface Action {
  /** Stable across a re-query, so the selection survives typing. */
  id: string;
  title: string;
  /** Searched as well as the title, at half weight. */
  keywords?: string;
  /** The quiet line under the title. */
  note?: string;
  /** ⚠️ No longer drawn: the right edge carries the Alt-number instead, which
   *  is worth more than a label naming the provider. Kept on the type because
   *  every provider sets it and it reads as documentation at the call site. */
  hint?: string;
  icon: TaskIcon;
  run: () => void | Promise<void>;
}

export type Provider = (query: string) => Action[];

/** How many rows fit before the list starts scrolling rather than growing. */
const SHOWN = 8;

export class Palette {
  private host: HTMLElement;
  private field: HTMLInputElement;
  private list: HTMLElement;
  private providers: Provider[] = [];
  private shown: { action: Action; match: Match }[] = [];
  private at = 0;
  /** Installed on the document while the palette is up, and removed with it. */
  private keys = (event: KeyboardEvent) => this.key(event);
  private away = (event: PointerEvent) => this.outside(event);
  open = false;

  constructor(private surface: IslandSurface, private onClose: () => void) {
    this.host = element("div", "palette");
    this.host.hidden = true;

    const bar = element("div", "palette-bar");
    const mark = element("span", "palette-mark");
    paintIcon(mark, "search");
    this.field = element("input", "palette-field") as HTMLInputElement;
    this.field.type = "text";
    this.field.autocomplete = "off";
    this.field.spellcheck = false;
    this.field.placeholder = "Search the island…";
    this.field.setAttribute("aria-label", "Search the island");
    bar.append(mark, this.field);

    this.list = element("div", "palette-list");
    this.list.setAttribute("role", "listbox");
    this.host.append(bar, this.list);

    this.field.addEventListener("input", () => this.query());
  }

  element(): HTMLElement { return this.host; }

  add(provider: Provider) { this.providers.push(provider); }

  /* ── Opening ──────────────────────────────────────────────────────────── */

  async show() {
    if (this.open) {
      // Pressing the shortcut again is "I meant the other thing" — start over
      // rather than toggling shut, which loses what was typed for no reason.
      this.field.select();
      return;
    }
    /* ⚠️ The pin is NOT touched, and three earlier versions all touched it.
     * `surface.pin()` is a TOGGLE that latches a user-facing control, and the
     * palette had three callers pinning around it — the shortcut listener, the
     * header button and this method — so opening it pinned twice, `wasPinned`
     * read back `true`, and closing restored a pin the user never set. The
     * island was then stuck open until it was unpinned by hand.
     *
     * Nothing here needs the pin anyway: `input(true)` sets `editing`, which
     * blocks folding outright. `pinFor` only covers the gap before that lands,
     * which is the same thing quick capture does. */
    this.surface.pinFor(6000);
    this.open = true;
    this.host.hidden = false;
    this.field.value = "";
    /* Narrow while the palette is up. The panel is ~910px across, which is
     * right for eight screens of content and much too wide for a list of
     * one-line results — it reads as a window rather than as a bar. */
    this.surface.capBody(cpx(FRAME.islandPaletteLong));
    this.query();
    document.addEventListener("keydown", this.keys, true);
    document.addEventListener("pointerdown", this.away, true);
    /* ⚠️ The same lift the composer uses. The island is WS_EX_NOACTIVATE so
     * that glancing at it never steals focus from what you were doing; a field
     * you type into needs that off for exactly as long as it has the caret.
     * See task_window::set_task_input. */
    await this.surface.input(true).catch(() => {});
    await this.grab();
    this.surface.measure();
  }

  /** Keep asking for the caret until it arrives.
   *
   * ⚠️ One `focus()` is not enough. The lift is a round trip through
   * `set_task_input`, which clears `WS_EX_NOACTIVATE`, raises the window and
   * moves focus into the WebView — and the DOM can get its turn before the
   * native side has finished, in which case the call succeeds, `activeElement`
   * is the field, and the keystrokes still go to the app that was in front.
   *
   * ⚠️ `preventScroll`, always. A plain `focus()` scrolls every scrollable
   * ancestor to reveal the field, and the island was one of those until it
   * became `overflow: clip` — which is what slid the collapsed pill 59px out of
   * its own shape. */
  private async grab() {
    for (let tries = 0; tries < 15; tries++) {
      this.field.focus({ preventScroll: true });
      if (document.activeElement === this.field && document.hasFocus()) return;
      await new Promise(frame => requestAnimationFrame(frame));
    }
  }

  /** Anywhere but the palette closes it — including the island's own header,
   *  because clicking a tab is already a decision to be somewhere else. */
  private outside(event: PointerEvent) {
    if (!this.open) return;
    if (event.target instanceof Node && this.host.contains(event.target)) return;
    void this.hide();
  }

  async hide() {
    if (!this.open) return;
    this.open = false;
    this.host.hidden = true;
    this.field.value = "";
    document.removeEventListener("keydown", this.keys, true);
    document.removeEventListener("pointerdown", this.away, true);
    this.surface.capBody(0);
    await this.surface.input(false).catch(() => {});
    this.surface.measure();
    this.onClose();
  }

  /* ── Choosing ─────────────────────────────────────────────────────────── */

  /* ⚠️ On the DOCUMENT, in the capture phase, not on the field.
   *
   * Bound to the field, every key here was dead until the caret had actually
   * arrived — so on the one occasion it mattered, opening from a global
   * shortcut with the window not yet foreground, Escape did not close the
   * palette and the arrows did not move the selection. The only way out was to
   * run something. Bound to the document it works whatever has focus, and
   * capture is what puts it ahead of the island's own Escape handler. */
  private key(event: KeyboardEvent) {
    if (!this.open) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      void this.hide();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!this.shown.length) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      // Wraps, because a list you can run off the end of makes you look.
      this.at = (this.at + step + this.shown.length) % this.shown.length;
      this.paint();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      void this.pick(this.at);
      return;
    }
    /* Alt and a digit runs that row outright.
     *
     * ⚠️ Alt, not Ctrl+Alt. `Ctrl+Alt` IS `AltGr`, which types letters on a
     * Polish layout — the same trap that had two of this app's global
     * shortcuts quietly eating `ń` and `ś`. Digits are not AltGr-mapped, so
     * plain Alt is both safe and shorter. */
    if (event.altKey && !event.ctrlKey && event.code.startsWith("Digit")) {
      const index = Number(event.code.slice(5)) - 1;
      if (index >= 0 && index < Math.min(9, this.shown.length)) {
        event.preventDefault();
        void this.pick(index);
      }
      return;
    }
    /* A character typed before the caret landed belongs in the field. Focusing
     * during `keydown` is early enough that the key itself still arrives. */
    if (document.activeElement !== this.field && event.key.length === 1
      && !event.ctrlKey && !event.metaKey && !event.altKey) {
      this.field.focus({ preventScroll: true });
    }
  }

  private async pick(index: number) {
    const chosen = this.shown[index];
    if (!chosen) return;
    // ⚠️ Closed BEFORE the action runs. Half of these open a screen, move a
    // window or raise a terminal, and a palette still sitting over the result
    // is something you have to dismiss to see what you asked for.
    await this.hide();
    try {
      await chosen.action.run();
    } catch { /* the action reports its own trouble on its own screen */ }
  }

  private query() {
    const text = this.field.value.trim();
    const all = this.providers.flatMap(provider => {
      try {
        return provider(text);
      } catch {
        // One provider throwing must not empty the palette.
        return [];
      }
    });
    this.shown = search(all, text, SHOWN * 3)
      .slice(0, SHOWN * 2)
      .map(hit => ({ action: hit.item, match: hit.match }));
    this.at = 0;
    this.paint();
  }

  /** The title with the matched characters lit. */
  private title(action: Action, match: Match): HTMLElement {
    const wrap = element("span", "palette-title");
    if (!match.hits.length) {
      wrap.textContent = action.title;
      return wrap;
    }
    const hits = new Set(match.hits);
    let run = "";
    let lit = false;
    const flush = () => {
      if (!run) return;
      wrap.append(lit ? element("b", "", run) : document.createTextNode(run));
      run = "";
    };
    [...action.title].forEach((char, index) => {
      const on = hits.has(index);
      if (on !== lit) { flush(); lit = on; }
      run += char;
    });
    flush();
    return wrap;
  }

  private paint() {
    this.list.replaceChildren();
    if (!this.shown.length) {
      this.list.append(element("p", "palette-empty", "Nothing matches."));
      this.surface.measure();
      return;
    }
    this.shown.forEach(({ action, match }, index) => {
      const row = element("button", `palette-row${index === this.at ? " is-at" : ""}`);
      (row as HTMLButtonElement).type = "button";
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(index === this.at));
      const mark = element("span", "palette-icon");
      paintIcon(mark, action.icon);
      const copy = element("div", "palette-copy");
      copy.append(this.title(action, match));
      if (action.note) copy.append(element("span", "palette-note", action.note));
      row.append(mark, copy);
      /* A number you can actually press, rather than a label saying which
       * provider answered. The group was decoration: the icon already says
       * what kind of thing this is, and the right edge is better spent on the
       * one piece of information that does something. */
      if (index < 9) {
        const key = element("span", "palette-key");
        key.append(element("b", "", "Alt"), document.createTextNode(String(index + 1)));
        row.append(key);
      }
      // Pointer, not click: the row has to win the selection before it runs,
      // so a mis-aimed click is visible rather than surprising.
      row.addEventListener("pointerenter", () => {
        if (this.at === index) return;
        this.at = index;
        this.paint();
      });
      row.onclick = () => { void this.pick(index); };
      this.list.append(row);
    });
    this.list.children[this.at]?.scrollIntoView({ block: "nearest" });
    this.surface.measure();
  }
}
