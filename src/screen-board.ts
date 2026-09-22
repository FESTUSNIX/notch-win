/* A board: blocks laid on a grid.
 *
 * Home is the first of these and the reason the island is a wide bar rather
 * than a panel. Each block is a stripped view of another screen — a board owns
 * no data, so there is exactly one optimistic task layer, one media session and
 * one agenda in the app however many boards are built out of them.
 *
 * ⚠️ The BLOCK is drawn here and its CONTENTS are the widget's — see the note
 * at the top of `widgets.ts`. Everything that makes a block a block lives in
 * `card()`: the spacing, the tone, the chevron and the whole-block press.
 *
 * ⚠️ A GRID of four columns, not a wrapping row. Blocks can be resized, and a
 * size only means something against cells: "two across, one down" is the same
 * shape on every board, where "320 pixels" is the same shape only until the
 * panel changes width.
 */
import { element } from "./dom";
import { taskIcon } from "./task-icons";
import { BoardEdit, ghostChip } from "./board-edit";
import {
  BOARD_COLUMNS, defaultSize, nearestSize, variantsOf, widgetsOf, widgetDef,
  WIDGETS, type Placed, WIDGET_STYLES } from "./widgets";
import { BODIES, type WidgetDeps, tickBodies } from "./widget-bodies";
import type { Board, BoardWidget } from "./boards";
import type { Activity } from "./island-activity";

export interface BoardHooks {
  /** Write this board's widgets. The shell holds the boards, not the screen. */
  arrange: (widgets: BoardWidget[]) => void;
  /** Leave edit mode: `keep` false puts the board back as it was found. */
  done: (keep: boolean) => void;
  /** The tray's panel opened or closed, and it is a different width from the
   *  widget list. ⚠️ The screen cannot re-cap the island itself: how wide a
   *  screen wants to be is a fact `tasks.ts` owns, in one table, for all. */
  tuned: () => void;
}

export class BoardScreen {
  /** The grid holding the blocks. Held rather than looked up: the drag reads
   *  it on every pointer move. */
  private row = element("div", "board-row");
  private editing = false;
  /** Which block's settings the tray is showing, if any. ⚠️ Held HERE rather
   *  than in the board data: it is a fact about this screen right now, not
   *  something to write to disk and find still open a week later. */
  private tuning = "";

  /** Whether the tray is showing a panel rather than the widget list — read by
   *  `widthOf`, because the panel is wider and the island has to be capped to
   *  hold it. */
  get tuned(): boolean { return !!this.tuning; }
  private edit: BoardEdit;

  constructor(
    private host: HTMLElement,
    private board: Board,
    private deps: WidgetDeps,
    private hooks: BoardHooks,
  ) {
    this.edit = new BoardEdit({
      row: () => this.row,
      kinds: () => this.board.widgets,
      set: widgets => this.hooks.arrange(widgets),
      size: kind => {
        const def = widgetDef(kind);
        return def ? defaultSize(def) : ([1, 1] as const);
      },
      nearest: (kind, w, h) => {
        const def = widgetDef(kind);
        return def ? nearestSize(def, w, h) : ([1, 1] as const);
      },
      ghost: kind => {
        const def = widgetDef(kind);
        return ghostChip(def ? taskIcon(def.icon) : null, def?.label ?? kind);
      },
    });
  }

  /** The board this screen shows. Replaced rather than mutated, so a board
   *  edited elsewhere redraws from the new object instead of from whatever the
   *  array held when the screen was built. */
  setBoard(board: Board) { this.board = board; }

  /** Whether the board is being arranged. ⚠️ The screen does not decide this
   *  — the shell does, because the arc's action and the panel's width both
   *  change with it and neither is the screen's to reach. */
  setEditing(on: boolean) {
    if (this.editing === on) return;
    this.editing = on;
    /* ⚠️ Leaving arrange mode closes the panel. Coming back to a board still
     * showing the settings of whichever block you were last on is a mode that
     * remembers something nobody asked it to. */
    if (!on) this.tuning = "";
    this.edit.stop();
  }

  /** True while a block is in the hand. ⚠️ The shell asks before redrawing:
   *  every block is live, and rebuilding them mid-drag restarts every one and
   *  drops the pointer capture besides. */
  get arranging(): boolean { return this.edit.busy; }

  /** A board never claims the pill. It is a view of other screens, and a claim
   *  from here would compete with the screen that actually owns the thing. */
  activity(): Activity | null { return null; }

  /** One block. No heading: the content says what it is, and a row of uppercase
   *  labels across a strip this size is most of what made the first version
   *  read as clutter. */
  private card(placed: Placed): HTMLElement {
    const def = placed.def;
    const wrap = element("section",
      `home-sec ${def.cls} is-${def.surface}`
      + `${def.opens && !this.editing ? " can-open" : ""}`
      + `${this.editing ? " is-editing" : ""}`);
    wrap.dataset.widget = def.kind;
    wrap.dataset.size = `${placed.w}x${placed.h}`;
    /* ⚠️ An attribute rather than a class, so one rule per ground can match it
     * and a ground this build has never heard of simply matches nothing —
     * `styleOf` has already folded an unknown one to `none`. */
    wrap.dataset.ground = placed.style;
    /* ⚠️ A TOKEN NAME, resolved in CSS — never a colour. `--w-tone` is set to
     * `var(--cool)` or `var(--warn)`, so the six things a widget can speak in
     * are the six the app already had and a theme that changes one changes it
     * here too. A block that carried a hex value would be the one thing on the
     * surface a scheme could not reach. */
    wrap.style.setProperty("--w-tone", `var(--${def.tone === "accent" ? "accent" : def.tone})`);
    /* ⚠️ Cells, written inline. What a block is worth is the widget's answer
     * and the board's grid is what it is worth it IN — see `BOARD_COLUMNS`. */
    wrap.style.gridColumn = `span ${Math.min(BOARD_COLUMNS, placed.w)}`;
    wrap.style.gridRow = `span ${placed.h}`;

    if (def.opens && !this.editing) {
      /* ⚠️ The WHOLE block opens the screen, not just the chevron. A block that
       * lit up under the pointer and then did nothing when pressed is a promise
       * the screen does not keep — and it was making that promise on every
       * pixel except one 15px arrow in the corner.
       *
       * ⚠️ Anything that is itself a control keeps its own press. The
       * transport, the checkboxes and the add row all live inside these blocks,
       * and one that swallowed their clicks would be worse than one that did
       * nothing. */
      const opens = def.opens;
      wrap.onclick = event => {
        if (event.target instanceof HTMLElement
          && event.target.closest("button, input, label, a")) return;
        this.deps.open(opens);
      };
      const go = element("button", "home-go", "›");
      (go as HTMLButtonElement).type = "button";
      go.setAttribute("aria-label", `Open ${def.label}`);
      go.dataset.tip = def.label;
      go.onclick = () => this.deps.open(opens);
      wrap.append(go);
    }

    /* ── The contents ────────────────────────────────────────────────────
     * ⚠️ Drawn while arranging too, and still LIVE. A block reduced to its name
     * and glyph the moment you start rearranging is a block you are placing
     * blind — the whole reason to arrange these by hand rather than in a list
     * is to see what you are arranging. What it loses is its INTERACTION, one
     * wrapper up, so a drag across the grid cannot press a transport button it
     * happens to pass over. */
    const body = element("div", "home-body");
    /* ⚠️ The SHAPE is handed to the body, not measured by it. A block knows
     * how many cells it is before it has a box, and a body that read its own
     * width would be laying itself out against last frame's. `wide` and `tall`
     * are the two questions every one of them actually asks. */
    BODIES[def.kind](body, this.deps, {
      w: placed.w, h: placed.h, variant: placed.variant,
      wide: placed.w >= 3, tall: placed.h >= 2,
    });
    /* ⚠️ A layout a body chose is lifted onto the BLOCK. Bodies are handed the
     * `.home-body` wrapper, so an attribute one writes lands there — and some
     * of what a layout needs is the block's own: Now playing's `cover` drops
     * the padding and clips to the block's radius, because the artwork IS the
     * block. Writing it on the wrapper left every such rule matching nothing,
     * silently. The body still decides; this only carries the answer up. */
    /* ⚠️ ONE LIST, because this has now caught three widgets. Bodies are handed
     * the `.home-body` wrapper, so an attribute one writes lands there — and
     * what these say is about the BLOCK: Now playing's `cover` drops the
     * padding and clips to the block's radius, Daylight's wash has to reach the
     * block's rounded edges, and the coin's direction sets the colour every
     * part of it is drawn in. Written on the wrapper, every such rule matched
     * nothing, silently — the coin came up green on a falling day, which is the
     * worst possible way for this to fail. The body still decides; this only
     * carries the answer up. */
    for (const key of ["layout", "part", "way"] as const) {
      const said = body.dataset[key];
      if (said) wrap.dataset[key] = said;
    }
    wrap.append(body);

    if (this.editing) this.editable(wrap, placed);
    return wrap;
  }

  /** What a block gains while the board is being arranged: a way off it, a way
   *  to pick it up, and a corner to resize it by. */
  private editable(wrap: HTMLElement, placed: Placed) {
    const def = placed.def;

    const off = element("button", "board-off");
    (off as HTMLButtonElement).type = "button";
    off.setAttribute("aria-label", `Remove ${def.label}`);
    off.dataset.tip = `Remove ${def.label}`;
    off.onclick = event => {
      event.stopPropagation();
      this.hooks.arrange(this.board.widgets.filter(one => one.kind !== def.kind));
    };
    wrap.append(off);

    /* ⚠️ Only where there is more than one size to be. A grip that cannot
     * change anything is a control that lies, and some of these widgets have
     * exactly one shape that works. */
    if (def.sizes.length > 1) {
      const grip = element("div", "board-grip");
      grip.setAttribute("aria-hidden", "true");
      grip.dataset.tip = `Resize ${def.label}`;
      wrap.append(grip);
      grip.addEventListener("pointerdown", event => {
        if (event.button !== 0) return;
        event.stopPropagation();
        this.edit.resize(wrap, def.kind, placed.w, placed.h, event);
      });
    }

    /* ── The way in to everything else about this block ──────────────────
     * ⚠️ A BADGE, not a row of pills inside the block. The pills were content
     * — they sat in the block's own flow, pushed the widget down, changed its
     * layout while you were choosing that layout, and could only ever offer the
     * one setting that fitted. A block has a view, a ground and a size; three
     * rows of pills inside a 130px card is not a settings panel, it is a card
     * with no room left for the widget. This opens the tray's own panel, which
     * has the room and is not on top of anything. */
    const tune = element("button", "board-tune");
    (tune as HTMLButtonElement).type = "button";
    tune.setAttribute("aria-label", `Settings for ${def.label}`);
    tune.dataset.tip = `${def.label} settings`;
    tune.append(taskIcon("settings"));
    tune.onclick = event => {
      event.stopPropagation();
      this.tuning = this.tuning === def.kind ? "" : def.kind;
      this.render();
      /* ⚠️ The PANEL is wider than the list, so the island has to be re-capped
       * — `tasks.ts` owns how wide a screen is, in one table, for all of them.
       * Without this the panel opened inside the list's own column and every
       * row in it wrapped. */
      this.hooks.tuned();
    };
    wrap.append(tune);
    if (this.tuning === def.kind) wrap.classList.add("is-tuning");

    /* ⚠️ Not from the − badge, the grip or the gear. A press on any of them
     * that wandered a pixel would start a drag instead of doing its own job,
     * which is most presses on a 22px target. */
    wrap.addEventListener("pointerdown", event => {
      if (event.button !== 0) return;
      if ((event.target as HTMLElement).closest(".board-off, .board-grip, .board-tune")) return;
      this.edit.fromCard(wrap, def.kind, event);
    });
  }

  /* ── The tray ───────────────────────────────────────────────────────────
   * Every widget there is, as a tile you can drag onto the grid. ⚠️ INSIDE
   * the panel rather than floating beside it: the island is welded to a bezel
   * and paints nothing past its own edge, so a tray outside would be a second
   * window placed against a moving shape. The panel grows to hold it, which is
   * what the panel does for everything else on it. */
  private tray(): HTMLElement {
    const tray = element("div", "board-tray");
    if (this.tuning) tray.classList.add("is-tuning");

    /* ⚠️ The panel REPLACES the list rather than floating over the board. A
     * popover here would cover the very block it is about — and this is a panel
     * you use while watching what it changes. */
    const placed = this.tuning
      ? widgetsOf(this.board.widgets).find(one => one.def.kind === this.tuning)
      : undefined;
    if (placed) {
      tray.append(this.settings(placed), this.answers());
      return tray;
    }
    this.tuning = "";

    const tiles = element("div", "board-tiles");
    for (const def of WIDGETS) {
      const on = this.board.widgets.some(one => one.kind === def.kind);
      const tile = element("button", `board-tile${on ? " is-on" : ""}`);
      (tile as HTMLButtonElement).type = "button";
      tile.dataset.kind = def.kind;
      tile.dataset.tip = def.about;
      tile.setAttribute("aria-label", on ? `Remove ${def.label}` : `Add ${def.label}`);
      tile.setAttribute("aria-pressed", String(on));

      const mark = element("span", "board-tile-mark");
      mark.append(taskIcon(def.icon));
      if (on) {
        /* The tick: this one is already on the board. ⚠️ A badge rather than
         * hiding the tile — a tray whose contents come and go as you arrange is
         * a tray you cannot learn the shape of. */
        const badge = element("span", "board-tile-badge");
        badge.append(taskIcon("check"));
        mark.append(badge);
      }
      tile.append(mark, element("span", "board-tile-name", def.label));

      /* Press adds or removes; drag places it exactly. ⚠️ Both, because a
       * press is what you reach for when you do not care where it lands and a
       * drag is what you reach for when you do. Offering only the drag makes
       * adding three widgets three journeys across the panel. */
      tile.onclick = () => {
        if (on) {
          this.hooks.arrange(this.board.widgets.filter(one => one.kind !== def.kind));
        } else {
          const [w, h] = defaultSize(def);
          this.hooks.arrange([...this.board.widgets, { kind: def.kind, w, h }]);
        }
      };
      tile.addEventListener("pointerdown", event => {
        if (event.button !== 0 || on) return;
        this.edit.fromTray(def.kind, event);
      });
      tiles.append(tile);
    }

    tray.append(tiles, this.answers());
    return tray;
  }

  /* ⚠️ The two answers sit at the FAR end, away from the tiles. They end the
   * mode; everything above them changes what is in it, and a press that means
   * "stop" among ten that mean "add" is the one that gets hit by accident. */
  private answers(): HTMLElement {
    const answers = element("div", "board-answers");
    const drop = element("button", "board-answer");
    (drop as HTMLButtonElement).type = "button";
    drop.setAttribute("aria-label", "Discard the changes");
    drop.dataset.tip = "Discard";
    drop.append(taskIcon("close"));
    drop.onclick = () => this.hooks.done(false);

    const keep = element("button", "board-answer is-keep");
    (keep as HTMLButtonElement).type = "button";
    keep.setAttribute("aria-label", "Done arranging");
    keep.dataset.tip = "Done";
    keep.append(taskIcon("check"));
    keep.onclick = () => this.hooks.done(true);

    answers.append(drop, keep);
    return answers;
  }

  /* ── One block's settings ────────────────────────────────────────────────
   * Everything about a block that is not its position: what it draws, and what
   * it is drawn on. ⚠️ Not its SIZE — that is the corner you pull, and a list
   * of sizes here would be a second control for a thing you can already do by
   * looking at it. */
  private settings(placed: Placed): HTMLElement {
    const def = placed.def;
    const panel = element("div", "board-set");

    const head = element("div", "board-set-head");
    const back = element("button", "board-set-back");
    (back as HTMLButtonElement).type = "button";
    back.setAttribute("aria-label", "Back to the widgets");
    back.dataset.tip = "All widgets";
    back.append(taskIcon("back"));
    back.onclick = () => { this.tuning = ""; this.render(); this.hooks.tuned(); };
    const mark = element("span", "board-set-mark");
    mark.append(taskIcon(def.icon));
    head.append(back, mark, element("span", "board-set-name", def.label));
    panel.append(head);

    const body = element("div", "board-set-body");
    /* ⚠️ Only where there is more than one. A group of one is a label with a
     * tick on it, which is the picker telling you it had nothing to ask. */
    const variants = variantsOf(def);
    if (variants.length > 1) {
      body.append(this.choices("View", variants.map(one => ({
        id: one.id, label: one.label, on: one.id === placed.variant,
        pick: () => this.write(def.kind, { variant: one.id }),
      }))));
    }
    body.append(this.choices("Background", WIDGET_STYLES.map(one => ({
      id: one.id, label: one.label, on: one.id === placed.style,
      pick: () => this.write(def.kind, { style: one.id }),
    }))));
    panel.append(body);
    return panel;
  }

  /** One group of mutually exclusive rows. ⚠️ ROWS, not pills: a pill row is
   *  read left to right and truncates the moment a label is long, and these are
   *  in a column 240px wide where a list is the natural shape. */
  private choices(
    said: string,
    rows: { id: string; label: string; on: boolean; pick: () => void }[],
  ): HTMLElement {
    const group = element("div", "board-set-group");
    group.setAttribute("role", "group");
    group.setAttribute("aria-label", said);
    group.append(element("p", "board-set-label", said));
    const list = element("div", "board-set-rows");
    for (const row of rows) {
      const one = element("button", `board-set-row${row.on ? " is-on" : ""}`);
      (one as HTMLButtonElement).type = "button";
      one.setAttribute("aria-pressed", String(row.on));
      one.append(element("span", "board-set-row-name", row.label));
      const tick = element("span", "board-set-tick");
      tick.append(taskIcon("check"));
      one.append(tick);
      one.onclick = row.pick;
      list.append(one);
    }
    group.append(list);
    return group;
  }

  /** Change one thing about one block, keeping everything else. */
  private write(kind: string, change: Partial<BoardWidget>) {
    this.hooks.arrange(this.board.widgets.map(held =>
      (held.kind === kind ? { ...held, ...change } : held)));
  }

  /** Move what has a second hand on it, without redrawing anything.
   *
   * ⚠️ The board is rebuilt by the shell's own render, which runs on the
   * MINUTE — so a countdown on a board sat on one number for up to sixty
   * seconds while the same run ticked on the timer screen beside it. Rebuilding
   * the board every second instead would throw away a caret in Today's composer
   * and restart every transition on it; `tickBodies` writes in place, which is
   * the rule the timer screen and the player already follow. */
  tick() {
    if (this.editing) return;
    tickBodies(this.host);
  }

  render() {
    /* ⚠️ Never mid-drag. The grid is animated with transforms measured at the
     * start of the gesture; rebuilding it under the pointer throws those away,
     * restarts every live block and drops the capture. */
    if (this.edit.busy) return;
    const widgets = widgetsOf(this.board.widgets);
    this.row.replaceChildren();
    this.row.classList.toggle("is-editing", this.editing);

    if (!widgets.length) {
      /* ⚠️ Says how to fix itself, and says it differently while you are
       * arranging — "add widgets in Settings" is wrong advice to give somebody
       * who is standing in the tray that adds them. */
      const empty = element("div", "board-empty");
      empty.append(element("p", "", this.editing
        ? "Drag a widget up here, or press one."
        : "Nothing on this board yet."));
      if (!this.editing) {
        empty.append(element("p", "board-empty-how",
          "Press the grid on the island's arc to arrange it."));
      }
      this.row.append(empty);
    } else {
      for (const placed of widgets) this.row.append(this.card(placed));
    }

    /* ⚠️ The grid gets a SCROLLER of its own, and the tray is its sibling —
     * a column beside the board rather than a bar over it. The tray used to be
     * stuck to the bottom of one shared scroller, which meant it lay across the
     * last row of blocks: you dropped things underneath it and the controls it
     * carried were unclickable on most of the board. Beside it, the panel grows
     * sideways to make room and nothing is ever covered.
     *
     * ⚠️ No transition on its width. The island is sized from its content and
     * measures once per render, so a panel easing itself open would be measured
     * at the start of the ease; the tray snaps and the island's own width
     * spring is the animation. Same bargain `.media-lyrics` makes. */
    const scroll = element("div", "board-scroll");
    scroll.append(this.row);
    this.host.replaceChildren(scroll);
    this.host.classList.toggle("is-arranging", this.editing);
    if (this.editing) this.host.append(this.tray());
  }
}
