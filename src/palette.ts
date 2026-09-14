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
import { Recent } from "./palette-recent";
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
  /** A real image to draw instead of the glyph — an application's own icon,
   *  as a data URI. ⚠️ `icon` is still required and still used as the
   *  fallback: the shell does not always give one up. */
  art?: string;
  run: () => void | Promise<void>;
  /** The other things you can do to this one thing. `Tab` opens them.
   *
   * ⚠️ `run` stays the OBVIOUS verb — copy a shelf item, raise a session,
   * finish a task — and this is the rest. A row whose Enter did nothing until
   * you had gone a level deeper would be slower than the screen it replaced. */
  more?: () => Action[];
  /** Which band this sits in. Defaults to `TIER.island`. */
  tier?: number;
  /** Not searched, and always first.
   *
   * ⚠️ For a row that IS the answer rather than a thing that matches it —
   * the arithmetic line. Ranking one of those is nonsense: `1900 * 56/117` has
   * to subsequence-match `= 909.401709402`, which it does not, so the answer
   * was filtered out of its own query and "Add task" took the top row. */
  pinned?: boolean;
  /** Never learned from. Set on rows whose id is a one-off — the arithmetic
   *  line is a different id for every expression, and recording them would
   *  evict forty real entries in an afternoon. */
  volatile?: boolean;
}

/** Which band a row sits in. Bands are sorted before scores, so a band is a
 *  promise about position rather than a nudge.
 *
 * ⚠️ This is a HARD order, and that is what was asked for: an app always
 * outranks a file however well the file matched. The cost is real — a
 * brilliantly-matching file can sit under a mediocre app — and it is worth it
 * because the bands are ordered by how expensive it is to be wrong. Launching
 * the wrong app costs a window you close; opening the wrong file costs nothing;
 * failing to find the app you type five times a day costs the feature.
 *
 * ⚠️ Apps and files answer nothing on an empty query, so with the field
 * blank the bands do not apply at all and the order is plain recency. */
export const TIER = {
  /** An answer, not a match — the arithmetic line. Always first. */
  answer: 0,
  /** Installed applications. What a launcher is opened for. */
  app: 1,
  /** Everything the island itself owns: screens, commands, tasks, sessions,
   *  the shelf. The default, so a provider that says nothing lands here. */
  island: 2,
  /** Files and folders off the disk. Last: there are millions of them, and
   *  they are the least likely thing to have been meant. */
  file: 3,
} as const;

export type Provider = (query: string) => Action[];
/** Answers late. Everything's IPC is one, and it is the reason `rank` can run
 *  again after the list is already on screen. */
export type LiveProvider = (query: string) => Promise<Action[]>;

/** ⚠️ Guarded: `localStorage` does not merely come back empty when site data
 *  is blocked, the accessor itself throws. */
function storage() {
  try { return window.localStorage; } catch { return undefined; }
}

/** How many rows fit before the list starts scrolling rather than growing. */
const SHOWN = 8;

export class Palette {
  private host: HTMLElement;
  private field: HTMLInputElement;
  private list: HTMLElement;
  private crumb: HTMLElement;
  private providers: Provider[] = [];
  private live: LiveProvider[] = [];
  /** What the synchronous providers answered for the current text. */
  private pool: Action[] = [];
  /** What the late ones have answered so far, for the same text. */
  private late: Action[] = [];
  /** Bumped on every keystroke; a late answer carrying an old one is dropped.
   *  Without it a slow reply for "no" lands on top of the results for "notes". */
  private gen = 0;
  private text = "";
  /** The row whose own actions are being shown, if any. */
  private inside: Action | null = null;
  private recent = new Recent(storage());
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
    this.crumb = element("span", "palette-crumb");
    this.crumb.hidden = true;
    bar.append(mark, this.crumb, this.field);

    this.list = element("div", "palette-list");
    this.list.setAttribute("role", "listbox");
    this.host.append(bar, this.list);

    this.field.addEventListener("input", () => this.query());
  }

  element(): HTMLElement { return this.host; }

  add(provider: Provider) { this.providers.push(provider); }

  /** ⚠️ A late provider is asked ONLY at the top level. A sub-menu is the
   *  fixed set of verbs for one thing; a file search arriving into the middle
   *  of it would be results for a question nobody asked. */
  addLive(provider: LiveProvider) { this.live.push(provider); }

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
    this.inside = null;
    this.paintCrumb();
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
    this.inside = null;
    this.pool = [];
    this.late = [];
    this.gen++;
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
      // One level at a time: inside a row's actions, Escape is "back".
      if (!this.leave()) void this.hide();
      return;
    }
    /* Tab goes INTO the highlighted row's own actions.
     *
     * ⚠️ Tab, not ArrowRight. The right arrow has a job already — it moves
     * the caret — and a key that sometimes edits your text and sometimes
     * navigates is a key you stop trusting. Tab has nothing to move to here:
     * the palette is one field and a list. */
    if (event.key === "Tab" && !event.shiftKey) {
      event.preventDefault();
      this.enter(this.at);
      return;
    }
    if ((event.key === "Tab" && event.shiftKey)
      || (event.key === "Backspace" && !this.field.value && this.inside)) {
      event.preventDefault();
      this.leave();
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
    if (!chosen.action.volatile) this.recent.record(chosen.action.id);
    // ⚠️ Closed BEFORE the action runs. Half of these open a screen, move a
    // window or raise a terminal, and a palette still sitting over the result
    // is something you have to dismiss to see what you asked for.
    await this.hide();
    try {
      await chosen.action.run();
    } catch { /* the action reports its own trouble on its own screen */ }
  }

  /** Into the highlighted row's own actions. */
  private enter(index: number) {
    const chosen = this.shown[index]?.action;
    if (!chosen?.more) return;
    this.inside = chosen;
    this.field.value = "";
    this.paintCrumb();
    this.query();
  }

  /** Back out of them. Returns whether there was anything to back out of, so
   *  Escape can fall through to closing the palette. */
  private leave(): boolean {
    const was = this.inside;
    if (!was) return false;
    this.inside = null;
    this.field.value = "";
    this.paintCrumb();
    this.query();
    /* Put the highlight back on the row you came from. Landing on row one
     * after backing out means the way out of a sub-menu opened by mistake
     * also loses your place in the list. */
    const back = this.shown.findIndex(row => row.action.id === was.id);
    if (back > 0) { this.at = back; this.paint(); }
    return true;
  }

  private paintCrumb() {
    this.crumb.hidden = !this.inside;
    this.crumb.textContent = this.inside?.title ?? "";
    this.field.placeholder = this.inside ? "Do what with it…" : "Search the island…";
  }

  private safely(ask: () => Action[]): Action[] {
    // One provider throwing must not empty the palette.
    try { return ask(); } catch { return []; }
  }

  private query() {
    this.text = this.field.value.trim();
    const gen = ++this.gen;
    this.late = [];
    this.pool = this.inside
      ? this.safely(() => this.inside!.more!())
      : this.providers.flatMap(provider => this.safely(() => provider(this.text)));
    this.rank(false);
    if (this.inside) return;
    for (const ask of this.live) {
      ask(this.text)
        .then(actions => {
          // ⚠️ The generation check is the whole safety of this: a reply for
          // "no" arriving after "notes" was typed must be dropped, not merged.
          if (gen !== this.gen || !actions.length) return;
          this.late.push(...actions);
          this.rank(true);
        })
        .catch(() => { /* a search that did not answer shows nothing */ });
    }
  }

  /** Sort what there is and draw it.
   *
   * `keep` holds the highlight on whatever row it was on, by id, which matters
   * only for the late pass: results appearing under the cursor while you are
   * about to press Enter is how a palette runs the wrong thing. On a keystroke
   * the best match is the right selection, so the highlight goes back to the
   * top. */
  private rank(keep: boolean) {
    const held = keep ? this.shown[this.at]?.action.id : undefined;
    const all = [...this.pool, ...this.late];
    const pinned = all.filter(action => action.pinned);
    const rest = all.filter(action => !action.pinned);
    /* ⚠️ Ranked WIDE, then banded, then cut. Cutting to the visible eight
     * before the band sort would let a page of file hits push every app off
     * the end, and the band would then be sorting a list the files had already
     * won. */
    const ranked = search(rest, this.text, SHOWN * 8, action => this.recent.boost(action.id));
    // Stable, so score order survives inside a band.
    ranked.sort((a, b) => (a.item.tier ?? TIER.island) - (b.item.tier ?? TIER.island));
    this.shown = [
      ...pinned.map(action => ({ action, match: { score: 0, hits: [] as number[] } })),
      ...ranked.slice(0, SHOWN * 2).map(hit => ({ action: hit.item, match: hit.match })),
    ];
    const again = held ? this.shown.findIndex(row => row.action.id === held) : -1;
    this.at = again >= 0 ? again : 0;
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
      if (action.art) {
        const picture = element("img", "palette-art") as HTMLImageElement;
        picture.src = action.art;
        picture.alt = "";
        /* ⚠️ If the data URI is bad the row must not show a broken-image
         * glyph, which is worse than no icon at all. */
        picture.onerror = () => { picture.remove(); paintIcon(mark, action.icon); };
        mark.append(picture);
      } else {
        paintIcon(mark, action.icon);
      }
      const copy = element("div", "palette-copy");
      copy.append(this.title(action, match));
      if (action.note) copy.append(element("span", "palette-note", action.note));
      row.append(mark, copy);
      /* ⚠️ A static mark, not only a keystroke to know. Tab is invisible
       * until someone tells you about it, and a feature nobody can see is one
       * nobody uses. */
      if (action.more) {
        const deeper = element("span", "palette-more");
        deeper.append(element("b", "", "Tab"));
        // "down", turned a quarter: the set has no chevron of its own.
        paintIcon(deeper, "down");
        row.append(deeper);
      }
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
