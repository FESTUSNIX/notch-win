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
import { element } from "./dom";
import { paintIcon, type TaskIcon } from "./task-icons";
import { search, type Match } from "./palette-match";
import { Recent } from "./palette-recent";
import * as stars from "./palette-stars";
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
  /** What to write down if this row is starred. Absent means it cannot be
   *  starred — the arithmetic line, and the rows inside a Tab menu, which are
   *  verbs rather than things. */
  keep?: stars.Star;
  /** Never learned from. Set on rows whose id is a one-off — the arithmetic
   *  line is a different id for every expression, and recording them would
   *  evict forty real entries in an afternoon. */
  volatile?: boolean;
}

/** Which band a row sits in — a PREFERENCE, not a rule.
 *
 * ⚠️ This was a hard sort key once, and it was wrong in a way you could
 * see: typing `hero` put "Hide the chrome" above a folder actually called
 * `hero`, because the island band outranked the file band and nothing about
 * match quality could get past it. A band now adds points, and the quality
 * signals in palette-match (EXACT 400, PREFIX 150, INITIALS 110) are large
 * enough to cross one. So an app wins against a file that matched about as
 * well, and loses to a file you named outright — which is the whole
 * distinction.
 *
 * The order still tracks how expensive it is to be wrong: launching the wrong
 * app costs a window you close; opening the wrong file costs nothing; failing
 * to find the app you type five times a day costs the feature. */
export const TIER = {
  /** An answer, not a match — the arithmetic line. Sits above all of it,
   *  through `pinned` rather than through this number. */
  answer: 90,
  /** Installed applications. What a launcher is opened for. */
  app: 55,
  /** Everything the island itself owns: screens, commands, tasks, sessions,
   *  the shelf. The default, so a provider that says nothing lands here. */
  island: 30,
  /** Files and folders off the disk. There are millions of them. */
  file: 0,
  /** Not a match at all — a thing you can do with the text you typed, offered
   *  when nothing better turns up.
   *
   * ⚠️ It has to SINK, and the reason is not obvious. `Add task "agt"`
   * contains the query verbatim, so it collects RUNON (+80) on every query it
   * ever appears for — which is how it came to outrank Agents for `agt` the
   * moment match quality started counting for anything. A row built out of the
   * query cannot be ranked against the query. */
  offer: -150,
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

/* A typed prefix narrows the palette to one band.
 *
 * ⚠️ This is the honest answer to "sometimes I want a strict filter": make it
 * something you ask for on one query, rather than a rule that applies to every
 * query whether or not you meant it. The bands are a preference now (see TIER);
 * this is how you overrule them deliberately.
 *
 * ⚠️ `f ` and `a ` need the SPACE, and `>` does not. Without it every word
 * beginning with f or a would be a scope, and the palette would stop being able
 * to search for anything called "files" or "agents".
 *
 * ⚠️ The numbers are TIER's, written out. Referring to TIER here would be a
 * use-before-definition at module scope. */
const SCOPES: { match: RegExp; label: string; tier: number }[] = [
  { match: /^>\s*/, label: "The island", tier: 30 },
  { match: /^a\s+/i, label: "Apps", tier: 55 },
  { match: /^f\s+/i, label: "Files", tier: 0 },
];

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
  /** The band a typed prefix narrowed to, if any. */
  private scope: { label: string; tier: number } | null = null;
  private recent = new Recent(storage());
  private shown: { action: Action; match: Match }[] = [];
  private at = 0;
  /** Whether the highlight was put where it is on purpose. */
  private moved = false;
  /** Installed on the document while the palette is up, and removed with it. */
  private keys = (event: KeyboardEvent) => this.key(event);
  private away = (event: PointerEvent) => this.outside(event);
  open = false;

  constructor(
    private surface: IslandSurface,
    private onClose: () => void,
    /* ⚠️ Every action used to swallow its own failure with
     * `.catch(() => {})`, so a shortcut that would not register, a file that
     * had moved or an app whose shortcut was stale did precisely nothing and
     * said precisely nothing. The palette closes before the action runs, so
     * there is nowhere left to show it — which is why this is handed in. */
    private onTrouble: (what: string, why: string) => void = () => {},
  ) {
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

  /* ── Opening and closing ───────────────────────────────────────
   *
   * ⚠️ **One at a time, in order.** Both halves await a round trip to Rust —
   * `set_task_input` lifts and restores `WS_EX_NOACTIVATE` — and `grab()` can
   * spend fifteen frames asking for the caret. That is a quarter of a second in
   * which a second press, a click outside or a fold can all arrive, and with
   * the two halves running over each other the LAST thing to finish decided
   * what the native side believed:
   *
   *   * open then close, closing first → `input(true)` lands after
   *     `input(false)`, so the island is left in editing mode with no palette
   *     on screen — and `editing` blocks folding, so the panel is stuck open;
   *   * close then open → the keydown and pointerdown listeners are removed
   *     after the re-open added them, and the palette stops answering Escape.
   *
   * Every entry point queues on the same chain, so a second press waits for the
   * first to finish and then does the opposite of it. */
  private queue: Promise<unknown> = Promise.resolve();

  private chain<T>(job: () => Promise<T>): Promise<T> {
    const next = this.queue.then(job, job);
    // ⚠️ The chain must not stay rejected, or every later press is dropped.
    this.queue = next.catch(() => {});
    return next;
  }

  show() { return this.chain(() => this.opening()); }
  hide() { return this.chain(() => this.closing()); }

  /** What the shortcut does: the key that opens it closes it.
   *
   * ⚠️ The state is read INSIDE the chained job, not when `toggle()` is
   * called — two presses in the same frame would otherwise both see
   * `open === false` and both open. */
  toggle() { return this.chain(() => (this.open ? this.closing() : this.opening())); }

  private async opening() {
    if (this.open) {
      /* Already up and asked for again by something that is not the toggle —
       * the header button, a screen. Give the caret back and select what is
       * there, rather than closing what was just asked for. */
      await this.grab();
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
    /* ⚠️ The panel behind it is taken out of sight, not just covered over.
     * Covered, it still answers the pointer at the edges and the tab rail still
     * answers a wheel — and any translucency at all puts it back on screen,
     * which is what made the search look like two surfaces stacked. */
    this.host.parentElement?.classList.add("is-searching");
    /* ⚠️ And the furniture outside the panel, which that class cannot reach.
     * The arcs and the rail are siblings of the island — left up, they hang off
     * a shape that is now a search bar, offering the actions and the screens of
     * whatever happens to be underneath it. */
    this.surface.setSearching(true);
    this.field.value = "";
    this.inside = null;
    this.scope = null;
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
    // Asked for, so the narrowing springs rather than slides.
    this.surface.deliberately();
    this.surface.measure();
  }

  /** Whether the palette is on screen, for callers deciding what a key means. */
  get showing(): boolean { return this.open; }

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

  private async closing() {
    if (!this.open) return;
    this.open = false;
    this.host.hidden = true;
    this.host.parentElement?.classList.remove("is-searching");
    this.surface.setSearching(false);
    this.field.value = "";
    this.inside = null;
    this.scope = null;
    this.pool = [];
    this.late = [];
    this.gen++;
    document.removeEventListener("keydown", this.keys, true);
    document.removeEventListener("pointerdown", this.away, true);
    /* ⚠️ The width is handed BACK to the screen, not zeroed. `capBody(0)`
     * means "the full body", which was right when every screen WAS the full
     * body — now each asks for its own, and closing the palette over Today
     * would snap the panel out to 909px and leave it there. `onClose` restores
     * it, which is also why the measure that matters is the one after it. */
    /* ⚠️ The panel is NOT handed back if it is only going to fold.
     * `input(false)` releases the caret, which lets the fold timer arm — and
     * the timer is most of half a second, so closing the palette with the
     * pointer away from the island showed the whole expanded panel, in the
     * screen's own colours, and then folded it. It reads as the island opening
     * by mistake. Told to fold now, it goes straight from the search bar to
     * the pill, which is where it was going anyway. */
    await this.surface.input(false).catch(() => {});
    this.surface.deliberately();
    this.onClose();
    this.surface.measure();
    this.surface.foldIfDone();
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
    /* Backspace on an empty field sheds one level — the sub-menu, then the
     * scope. ⚠️ It has to test BOTH: with only `inside` here, a scope chip
     * could be backspaced at for ever and nothing happened. */
    if ((event.key === "Tab" && event.shiftKey)
      || (event.key === "Backspace" && !this.field.value && (this.inside || this.scope))) {
      event.preventDefault();
      this.leave();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!this.shown.length) return;
      this.moved = true;
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
    } catch (trouble) {
      this.onTrouble(chosen.action.title, String((trouble as Error)?.message ?? trouble));
    }
  }

  /** The Tab menu for a row: whatever it offers, plus the star.
   *
   * ⚠️ The star is added HERE rather than by each provider. It applies to
   * every row that can be starred, so writing it six times would be six places
   * to forget it — and it is what gives a row with no verbs of its own (a
   * screen, a command) a Tab menu at all. */
  private menu(action: Action): Action[] {
    const rows = this.safely(() => action.more?.() ?? []);
    if (!action.keep) return rows;
    const on = stars.has(action.id);
    rows.push({
      id: `star:${action.id}`,
      title: on ? "Remove the star" : "Star this",
      note: on ? "it will stop coming first" : "keeps it near the top, and in the empty list",
      keywords: "favourite favorite keep pin bookmark",
      icon: "star",
      run: async () => { await stars.toggle(action.id, action.keep!); },
    });
    return rows;
  }

  private starrable(action: Action): boolean {
    return !!action.more || !!action.keep;
  }

  /** Into the highlighted row's own actions. */
  private enter(index: number) {
    const chosen = this.shown[index]?.action;
    if (!chosen || !this.starrable(chosen)) return;
    this.inside = chosen;
    this.field.value = "";
    this.paintCrumb();
    this.query();
  }

  /** Back out one level. Returns whether there was anything to back out of, so
   *  Escape can fall through to closing the palette.
   *
   *  A scope is shallower than a sub-menu, so it is shed second. */
  private leave(): boolean {
    const was = this.inside;
    if (!was) {
      if (!this.scope) return false;
      this.scope = null;
      this.paintCrumb();
      this.query();
      return true;
    }
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
    const label = this.inside?.title ?? this.scope?.label ?? "";
    this.crumb.hidden = !label;
    this.crumb.textContent = label;
    this.field.placeholder = this.inside ? "Do what with it…"
      : this.scope ? `Search ${this.scope.label.toLowerCase()}…`
      : "Search the island…";
  }

  /** A typed prefix becomes a chip and leaves the field.
   *
   * ⚠️ Taken OUT of the text rather than merely ignored in it. Left in, the
   * matcher would have to know to skip it, every provider would see it, and
   * backspacing over it would silently change what the results mean with
   * nothing on screen having moved. */
  private takeScope() {
    if (this.inside || this.scope) return;
    for (const scope of SCOPES) {
      const found = this.field.value.match(scope.match);
      if (!found) continue;
      this.scope = { label: scope.label, tier: scope.tier };
      this.field.value = this.field.value.slice(found[0].length);
      this.paintCrumb();
      return;
    }
  }

  private safely(ask: () => Action[]): Action[] {
    // One provider throwing must not empty the palette.
    try { return ask(); } catch { return []; }
  }

  private query() {
    this.takeScope();
    this.text = this.field.value.trim();
    this.moved = false;
    const gen = ++this.gen;
    this.late = [];
    const raw = this.inside
      ? this.menu(this.inside)
      : this.providers.flatMap(provider => this.safely(() => provider(this.text)));
    /* ⚠️ One row per id, first one wins. The starred provider is registered
     * last and re-emits things the live providers may already have offered —
     * without this you get two Brave rows, and the stored one is the staler of
     * the two. */
    const seen = new Set<string>();
    /* ⚠️ The scope narrows the TOP-LEVEL search and nothing else. Applied
     * inside a sub-menu it filtered out every row in it — the verbs for one
     * thing carry no band of their own, so they all defaulted to `island` and
     * an `a ` scope emptied the menu it had just opened. */
    const band = this.inside ? undefined : this.scope?.tier;
    this.pool = raw.filter(action =>
      (band === undefined || (action.tier ?? TIER.island) === band)
      && !seen.has(action.id) && seen.add(action.id));
    this.rank(false);
    // No late answers inside a sub-menu, and none at all once the scope has
    // said this query is not about files.
    if (this.inside || (this.scope && this.scope.tier !== TIER.file)) return;
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

  /** Everything that is true about a row regardless of what was typed: its
   *  band, whether you kept it, and how recently you used it. */
  private weight(action: Action): number {
    return (action.tier ?? TIER.island)
      + (stars.has(action.id) ? stars.STAR : 0)
      + this.recent.boost(action.id);
  }

  /** Sort what there is and draw it.
   *
   * `keep` holds the highlight on whatever row it was on, by id, which matters
   * only for the late pass: results appearing under the cursor while you are
   * about to press Enter is how a palette runs the wrong thing. On a keystroke
   * the best match is the right selection, so the highlight goes back to the
   * top.
   *
   * ⚠️ And only if the highlight was put there ON PURPOSE. Held
   * unconditionally, a late file hit that ranks first leaves the selection on
   * whatever the synchronous pass happened to put at the top — so `hero` is
   * drawn first and Enter runs "Hide the chrome". That is the same class of
   * wrongness the bands had, arriving by a different route. */
  private rank(keep: boolean) {
    const held = keep && this.moved ? this.shown[this.at]?.action.id : undefined;
    const all = [...this.pool, ...this.late];
    const pinned = all.filter(action => action.pinned);
    const rest = all.filter(action => !action.pinned);
    const ranked = search(rest, this.text, SHOWN * 2, action => this.weight(action));
    this.shown = [
      ...pinned.map(action => ({ action, match: { score: 0, hits: [] as number[] } })),
      ...ranked.map(hit => ({ action: hit.item, match: hit.match })),
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
      if (stars.has(action.id)) {
        const mark = element("span", "palette-star");
        paintIcon(mark, "star");
        row.append(mark);
      }
      if (this.starrable(action)) {
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
        this.moved = true;
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
