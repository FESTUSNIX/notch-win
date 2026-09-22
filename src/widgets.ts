/* The widgets, and the one list of them.
 *
 * A widget is a block on a board: a stripped view of something another screen
 * owns in full. This file is what a widget IS — its name, its glyph, the track
 * it takes in a row, the colour it speaks in and the screen it opens. What it
 * DRAWS is in `widget-bodies.ts`.
 *
 * ⚠️ Two files, one list, and the split is not cosmetic: the settings window
 * needs the names to offer them in a picker, and pulling the bodies in with
 * them would drag the media, calendar and task screens into a bundle that
 * draws none of them. Everything imported here is a TYPE, so this file erases
 * to data.
 *
 * ⚠️ And they cannot drift. `WidgetKind` is derived from this array, and
 * `BODIES` is typed as one entry per kind — a widget added here without a body
 * is a compile error rather than a block that renders nothing.
 */
import type { TaskIcon } from "./task-icons";
import type { ScreenName } from "./island-activity";

/** The colour a widget speaks in.
 *
 * ⚠️ A NAME, never a value, and every one of these is a token the app already
 * had — `--cool` was the calendar's, `--calm` the player's, `--warn` and
 * `--hot` the pill's two levels of alarm. The one rule this app has about
 * colour is that nothing invents one, and a board of ten blocks all tinted the
 * user's accent is a board where the accent has stopped meaning anything. */
export type WidgetTone = "accent" | "cool" | "calm" | "warn" | "hot" | "good";

/** How much surface a widget draws under itself.
 *
 * ⚠️ `plain` is the DEFAULT and most widgets use it. A row of identical
 * rounded panels is a row where the panels are the loudest thing on screen;
 * space separates blocks perfectly well, and it leaves the content as the only
 * thing with edges. A tint is for the one or two that are genuinely a surface
 * — the weather is a picture of the sky, not a paragraph about it. */
export type WidgetSurface = "plain" | "tint";

export interface WidgetShape {
  kind: string;
  /** What it is called in the picker, and what the chevron says it opens. */
  label: string;
  icon: TaskIcon;
  /** One line in the picker saying what the block shows. */
  about: string;
  /** Extra class — what the stylesheet hangs the layout on.
   *
   * ⚠️ The class names are still `home-*`. They were written when Home was the
   * only board and there is nothing to gain from renaming eighty CSS rules;
   * the prefix means "a board block", not "the Home screen". */
  cls: string;
  tone: WidgetTone;
  surface: WidgetSurface;
  /** The screen the whole block opens, or null for one that goes nowhere. */
  opens: ScreenName | null;
  /** The sizes this widget may be, in grid cells, smallest first.
   *
   * ⚠️ A LIST, not a range, and that is the whole design. A widget knows what
   * it can usefully be — a clock is a number and reads fine in one cell, a
   * calendar needs two to fit a week, a task list earns its second row and a
   * machine block never does. Free resizing would let anybody make a 1×1
   * calendar with four of its seven days cut off, which is not a smaller
   * version of the widget so much as a broken one.
   *
   * ⚠️ The FIRST is the default — what a widget is when it is dropped on a
   * board and what a preferences file written before sizes existed means. */
  sizes: readonly (readonly [number, number])[];
  /** The things this widget can BE, as distinct from how big it is.
   *
   * ⚠️ A variant is a different QUESTION answered by the same data — a
   * calendar showing the week, the month or what is coming up — where a size
   * is the same answer given more or less room. They are two axes on purpose:
   * a month view is a month view at 2×2 and at 6×2, and cramming the choice
   * into the size ladder would mean "bigger" silently meant "different".
   *
   * ⚠️ The FIRST is the default, and a widget with one variant has none worth
   * offering — the control only appears past two. */
  variants?: readonly { readonly id: string; readonly label: string }[];
}

/** Everything a body needs to know about the block it is drawing into. */
export interface BlockShape {
  /** Cells across and down. */
  w: number;
  h: number;
  /** Which variant to draw. Always a variant the widget offers. */
  variant: string;
  /** Room for a second column of content. */
  wide: boolean;
  /** Room for a second row of content. */
  tall: boolean;
}

/** Every widget there is, in the order the picker offers them.
 *
 * ⚠️ ONE list, and adding to it is most of the job of adding a widget: the
 * board renders what it is told by name, the picker offers what is here, and a
 * board carrying a name this list has never heard of drops it rather than
 * failing to draw — see `widgetsOf`. */
export const WIDGETS = [
  {
    kind: "media", label: "Now playing", icon: "media", cls: "home-media",
    about: "What is playing, with the transport and the scrubber",
    tone: "calm", surface: "plain",
    /* ⚠️ `opens` is null, and Now playing is the one that passes it. Every
     * other block is a summary with a fuller screen behind it; the player's
     * stop only exists while something is playing, so a chevron promising one
     * would be a control that goes nowhere half the time. */
    opens: null,
    /* ⚠️ One cell IS offered now, and only the `cover` layout survives there
     * — see `mediaLayout`. The scrubber is the point of the other two and a
     * 130px rail is a decoration rather than a control. */
    /* ⚠️ TWO first, because the first size listed is the DEFAULT. One cell is
     * offered — the `cover` layout is good there — but a block dropped on a
     * board should arrive as the row it has always been, not as an app icon. */
    sizes: [[2, 1], [1, 1], [3, 1], [2, 2], [3, 2], [4, 1]],
    /* ⚠️ Three LAYOUTS, not three sets of content: the same track, the same
     * transport, arranged for a wide block, a tall one, or a square where the
     * artwork is the whole point. A variant rather than something inferred
     * from the shape, because 2×2 is a genuine choice — the cover can lead, or
     * the words can. */
    variants: [
      { id: "bar", label: "Row" },
      { id: "stack", label: "Column" },
      { id: "cover", label: "Cover" },
    ],
  },
  {
    kind: "calendar", label: "Calendar", icon: "calendar", cls: "home-cal",
    about: "The week, and the next thing on it",
    tone: "cool", surface: "plain",
    opens: "calendar",
    /* ⚠️ Three different QUESTIONS about the same agenda, not three sizes of
     * one. The week says where you are, the month says what the shape of it
     * is, and the agenda says what is actually coming — and which of those you
     * want has nothing to do with how much room the block has. */
    variants: [
      { id: "week", label: "This week" },
      { id: "month", label: "The month" },
      { id: "agenda", label: "What is next" },
      /* ⚠️ A SECOND take on the same question, offered beside the first rather
       * than replacing it. "What is next" is a list; this is one thing, big,
       * with the rest of the day as a rail under it — and which of those is
       * right depends on whether you keep a board open all day or glance at it
       * between meetings. That is a taste question, so it is a setting. */
      { id: "next", label: "Up next" },
    ],
    // ⚠️ Two at least: seven days in one cell is four of them cut off.
    /* ⚠️ `[2, 2]` is here so the ladder has a rung DOWNWARD from the default.
     * Without it the only taller shape was `[3, 2]`, which is a step in both
     * directions at once — and because a tie goes to the smaller size, pulling
     * the corner straight down did nothing at all. Every size a widget offers
     * should be reachable by moving one way. */
    sizes: [[2, 1], [2, 2], [3, 1], [4, 1], [3, 2], [6, 1]],
  },
  {
    kind: "today", label: "Today", icon: "today", cls: "home-today",
    about: "What is left to do, tickable",
    tone: "hot", surface: "plain",
    opens: "today",
    /* ⚠️ Tall by default. The figure and three rows want the second row; at
     * 1×1 this is a count with nothing under it, which the pill already says. */
    sizes: [[2, 1], [2, 2], [3, 2], [1, 2]],
  },
  {
    kind: "weather", label: "Weather", icon: "wxPartly", cls: "home-wx",
    about: "The place set in Settings, now",
    /* ⚠️ The one TINTED block, and the only one that earns it: this is a
     * picture of the sky rather than a paragraph about it, and a wash of the
     * cold blue says more at a glance than the words do. */
    tone: "cool", surface: "tint",
    /* ⚠️ FOUR, because "forecast" was two different answers wearing one
     * name: the next few hours and the next few days are not more or less of
     * each other — one is what to expect this afternoon and the other is what
     * to expect this week. Asking for one and being given whichever happened
     * to fit is the thing a variant exists to stop. */
    variants: [
      { id: "now", label: "Now" },
      { id: "hours", label: "Hourly" },
      { id: "days", label: "Daily" },
      { id: "full", label: "Everything" },
      /* ⚠️ The hours as a CHART rather than a row of numbers — the temperature
       * carried by the height and the colour of a bar, which is a shape you
       * read at a glance where six numbers are six things to read. */
      { id: "graph", label: "Hours, charted" },
    ],
    /* ⚠️ `opens` is null: there is no weather SCREEN to go to. The reading
     * belongs to the pill's modules, and inventing a screen so that a block
     * could have a chevron would be a page with one number on it. */
    opens: null,
    sizes: [[1, 1], [2, 1], [2, 2], [3, 1], [3, 2], [4, 2]],
  },
  /* ── The three kinds of run, one block each ──────────────────────────
   * ⚠️ THREE widgets rather than one "countdown" that shows whichever is
   * liveliest. That block changed what it was about without being touched: a
   * pomodoro started on the screen took over the timer you were watching, and
   * a board holding two of them showed the same run twice. A block says which
   * kind it is and stays about that kind — which is also the only way to have
   * all three on one board.
   *
   * ⚠️ `timer` keeps its name, so a board written before this still draws.
   * What it MEANS has narrowed — a plain timer rather than any countdown —
   * which is what it was called all along.
   *
   * ⚠️ No `dial` on any of them. Setting a timer needs a ruler you can read,
   * somewhere to name it and somewhere to see where it went — which is a
   * screen, and the screen has one. A block that could set a timer but not
   * show the list it joined was a second, worse copy of the same control. */
  {
    kind: "pomodoro", label: "Pomodoro", icon: "target", cls: "home-face",
    about: "A focus cycle, with the round you are on",
    /* ⚠️ The ACCENT, not `warn`. Amber is the app's word for "something wants
     * attention" — a countdown you started yourself is the opposite of that,
     * and a block shouting it sat on the board looking like a problem. The
     * accent is for the thing that matters, and on this block that is the arc
     * saying where you are in the cycle. */
    tone: "accent", surface: "plain",
    opens: "timer",
    variants: [
      { id: "ring", label: "Ring" },
      { id: "face", label: "Numbers" },
    ],
    sizes: [[1, 1], [2, 1], [2, 2]],
  },
  {
    kind: "timer", label: "Timer", icon: "timer", cls: "home-face",
    about: "A countdown you set yourself",
    tone: "hot", surface: "plain",
    opens: "timer",
    variants: [
      { id: "ring", label: "Ring" },
      { id: "face", label: "Numbers" },
    ],
    sizes: [[1, 1], [2, 1], [2, 2]],
  },
  {
    kind: "stopwatch", label: "Stopwatch", icon: "clock", cls: "home-face",
    about: "Time counting up from when you started it",
    tone: "cool", surface: "plain",
    opens: "timer",
    variants: [
      { id: "ring", label: "Ring" },
      { id: "face", label: "Numbers" },
    ],
    sizes: [[1, 1], [2, 1], [2, 2]],
  },
  {
    kind: "daylight", label: "Daylight", icon: "sun", cls: "home-sky",
    about: "Where the sun is in the day, and the moon's phase at night",
    /* ⚠️ TINTED, the second block that is. Like the weather it is a picture of
     * the sky rather than a paragraph about it — and unlike the weather its
     * wash CHANGES through the day, which is most of what it has to say. */
    tone: "cool", surface: "tint",
    opens: null,
    /* ⚠️ Two cells wide at least. The arc is the widget; at one cell it is a
     * bump with no room for the two times that give it a scale. */
    sizes: [[2, 1], [3, 1], [2, 2], [3, 2]],
  },
  {
    kind: "crypto", label: "Crypto", icon: "chip", cls: "home-coin",
    about: "One coin's price, and where the day took it",
    /* ⚠️ No tone of its own: this block is coloured by its own NEWS. Up is
     * `good` and down is `hot`, written per reading, and a third colour
     * underneath them would be a block that is always saying something. */
    tone: "accent", surface: "plain",
    opens: null,
    variants: [
      { id: "line", label: "Chart" },
      { id: "plain", label: "Price" },
      /* ⚠️ The chart as the BLOCK, with the price over it and a scrub you drag
       * — where `line` is a price with a chart under it. Two different ideas of
       * what a coin block is for, so both are offered. */
      { id: "bold", label: "Full bleed" },
    ],
    sizes: [[2, 1], [3, 1], [2, 2], [3, 2], [1, 1]],
  },
  {
    kind: "wallet", label: "Wallet", icon: "chip", cls: "home-wallet",
    about: "What the connected Binance account holds",
    tone: "good", surface: "plain",
    opens: null,
    sizes: [[2, 1], [2, 2], [3, 1], [3, 2]],
  },
  {
    kind: "clock", label: "Clock", icon: "clock", cls: "home-face",
    about: "The time and the date",
    tone: "accent", surface: "plain",
    opens: null,
    sizes: [[1, 1], [2, 1]],
  },
  {
    kind: "agents", label: "Agents", icon: "agent", cls: "home-agents",
    about: "Sessions running, and what they are doing",
    tone: "good", surface: "plain",
    opens: "agents",
    sizes: [[2, 1], [1, 1], [3, 1], [2, 2]],
  },
  {
    kind: "notes", label: "Notes", icon: "note", cls: "home-notes",
    about: "The last thing you wrote down",
    /* ⚠️ Not the accent. Agents is `good` and the accent is green out of the
     * box, so three blocks in a row — agents, notes, shelf — all led in the
     * same green, and a tone that is on everything is a tone that says
     * nothing. */
    tone: "calm", surface: "plain",
    opens: "notes",
    // ⚠️ A note is prose: the second row is where it stops being a headline.
    sizes: [[2, 1], [2, 2], [3, 2], [1, 1]],
  },
  {
    kind: "shelf", label: "Shelf", icon: "shelf", cls: "home-shelf",
    about: "What you put down last",
    tone: "accent", surface: "plain",
    opens: "shelf",
    sizes: [[2, 1], [1, 1], [2, 2]],
  },
  {
    kind: "system", label: "Machine", icon: "system", cls: "home-sys",
    about: "Processor, memory and disk",
    tone: "hot", surface: "plain",
    opens: "system",
    // Three bars and a figure. There is nothing a second row would add.
    sizes: [[2, 1], [1, 1], [3, 1]],
  },
] as const satisfies readonly WidgetShape[];

export type WidgetKind = (typeof WIDGETS)[number]["kind"];
export type WidgetDef = (typeof WIDGETS)[number];

export function widgetDef(kind: string): WidgetDef | undefined {
  return WIDGETS.find(one => one.kind === kind);
}

/** The widgets a board actually has, in order.
 *
 * ⚠️ Unknown kinds are DROPPED rather than drawn as a hole. A board written by
 * a newer build, or one naming a widget that has since gone, is otherwise a
 * block that cannot say what it is — and the failure would be silent either
 * way, so it may as well be silent in the direction that still renders. */
export function widgetsOf(list: readonly PlaceShape[]): Placed[] {
  const seen = new Set<string>();
  const out: Placed[] = [];
  for (const held of list) {
    // ⚠️ One of each. Two Now playings is two sets of transport buttons
    // fighting over one session, and nothing downstream expects a duplicate.
    if (seen.has(held.kind)) continue;
    const def = widgetDef(held.kind);
    if (!def) continue;
    seen.add(held.kind);
    const [w, h] = sizeOf(def, held.w, held.h);
    out.push({
      def, w, h,
      variant: variantOf(def, held.variant),
      style: styleOf(held.style),
    });
  }
  return out;
}

/** What a board stores about one widget. ⚠️ Structural rather than imported
 *  from `boards.ts`: this file is data with no runtime imports at all, and the
 *  two shapes agreeing is what `BoardWidget` is for. */
export interface PlaceShape {
  kind: string; w: number; h: number; variant?: string; style?: string;
}

/** A widget and the shape it is drawn at. */
export interface Placed { def: WidgetDef; w: number; h: number; variant: string; style: WidgetStyle }

/** How many cells across a board's widgets come to, rows and all.
 *
 * ⚠️ Not the SUM of their widths: the grid wraps, so what decides the panel's
 * width is how wide the widest ROW of them ends up — which for a board that
 * fits on one line is the sum, and for one that does not is the grid. */
export function cellsAcross(widgets: readonly Placed[]): number {
  let across = 0;
  let line = 0;
  for (const one of widgets) {
    if (line + one.w > BOARD_COLUMNS) { across = Math.max(across, line); line = 0; }
    line += one.w;
  }
  return Math.max(across, line);
}

/** How wide the board's grid is, in cells.
 *
 * ⚠️ SIX, and it is a constant rather than a measurement: a column count
 * derived from the window would mean a board arranged this morning laid out
 * differently this afternoon.
 *
 * ⚠️ Six rather than four, and the reason is the default board. The three
 * blocks Home ships with are two cells each, which on a four-column grid put
 * the third on a second row — turning the island from a bar into a panel on
 * first run. Six divides by one, two, three and six, so every useful width
 * lands on it, and a cell is ~131 CSS px, which nothing is ever only one of. */
export const BOARD_COLUMNS = 6;

/** The grounds a block can be drawn on, in the order the picker offers them.
 *
 * ⚠️ `none` LEADS and is the default. The board lost its cards on purpose —
 * ten identical rounded rectangles is a wall saying the same nothing — so a
 * ground is something you reach for when one block should stand apart, not the
 * state everything starts in.
 *
 * ⚠️ A widget that paints its own picture (the weather, Daylight) keeps doing
 * so underneath whichever of these is chosen; `none` means "whatever the widget
 * does by itself", not "transparent". */
export const WIDGET_STYLES = [
  { id: "none", label: "None" },
  { id: "flat", label: "Flat" },
  { id: "raised", label: "Raised" },
  { id: "glass", label: "Glass" },
] as const;

export type WidgetStyle = (typeof WIDGET_STYLES)[number]["id"];

/** The ground a placement asks for, or the default. ⚠️ Read through this, never
 *  off the stored string: a board written by a newer build can name one this
 *  one has never heard of, and an unknown ground has to be no ground rather
 *  than a class nothing styles. */
export function styleOf(said: string | undefined): WidgetStyle {
  return WIDGET_STYLES.some(one => one.id === said) ? (said as WidgetStyle) : "none";
}

/** The variant a widget is when nothing has said otherwise. */
export function defaultVariant(def: WidgetDef): string {
  return variantsOf(def)[0]?.id ?? "";
}

/** A widget's variants, as a list that is always there.
 *
 * ⚠️ Read through this rather than off the object: `as const` gives a widget
 * with no `variants` key a type that does not HAVE the property, so every
 * reader would need the same cast. One place has it. */
export function variantsOf(def: WidgetDef): readonly { id: string; label: string }[] {
  return (def as WidgetShape).variants ?? [];
}

/** The variant a stored widget should actually be drawn as.
 *
 * ⚠️ An unknown one falls back to the default rather than drawing nothing. A
 * variant that has been renamed or withdrawn is exactly the kind of thing a
 * preferences file outlives, and a block that renders empty because of it
 * would be a bug nobody could see the cause of. */
export function variantOf(def: WidgetDef, want: string | undefined): string {
  if (want && variantsOf(def).some(one => one.id === want)) return want;
  return defaultVariant(def);
}

/** Which parts of the weather block fit, given what it is and how big it is.
 *
 * ⚠️ A PURE function, and out here rather than inside the body, because this
 * is the one piece of the widget that is genuinely decidable — everything else
 * it does is append elements. The variant says what you WANT and the size says
 * what will FIT, and where the two disagree the size wins: it is the one of
 * them that cannot be argued with. A six-hour strip in one cell is six columns
 * of four pixels, and five day rows in one row's height is five lines of
 * nothing — neither is a smaller version of the forecast, they are both just
 * broken.
 *
 * ⚠️ And nothing is offered that there is no DATA for. A cold start has a
 * temperature and no forecast for the first poll or two, so "forecast" with
 * nothing to forecast falls back to showing the head rather than an empty
 * block that looks like a failure. */
export function weatherParts(
  variant: string, w: number, h: number,
  has: { hours: boolean; days: boolean },
): { head: boolean; hours: boolean; days: boolean } {
  const tall = h >= 2;
  /* Hours need a second column to be a strip rather than a stack. Days need a
   * second ROW only when the head is above them — on their own they are the
   * content, and three rows fit a single-row block perfectly well. */
  const canHours = has.hours && w >= 2;
  const canDays = has.days && w >= 2;

  if (variant === "hours") {
    /* ⚠️ The head goes only when something replaces it. A block asked for the
     * hours whose hours did not fit would otherwise be empty. */
    return canHours
      ? { head: false, hours: true, days: false }
      : { head: true, hours: false, days: false };
  }
  if (variant === "days") {
    return canDays
      ? { head: false, hours: false, days: true }
      : { head: true, hours: false, days: false };
  }
  if (variant === "full") {
    /* Everything there is room for, head first. ⚠️ On a short block that is
     * the HOURS: what the weather is doing this afternoon is the more useful
     * of the two when only one fits, because the days are what height is for. */
    if (!canHours && !canDays) return { head: true, hours: false, days: false };
    return { head: true, hours: canHours, days: canDays && tall };
  }
  // `now`, and anything a preferences file names that no longer exists.
  return { head: true, hours: false, days: false };
}



/** Which layout a Now playing block actually draws.
 *
 * ⚠️ The variant asks and the SIZE answers, the same rule the weather follows.
 * A row needs somewhere to put the words beside the cover and a column needs
 * somewhere to put them under it; one cell has neither, so a single-cell block
 * is the cover whatever was chosen. The reverse never applies — `cover` is a
 * good answer at every size, which is why it is the one thing the fallback
 * falls back TO. */
export function mediaLayout(variant: string, w: number, h: number): "bar" | "stack" | "cover" {
  if (w < 2) return "cover";
  if (variant === "cover") return "cover";
  if (variant === "stack") return h >= 2 ? "stack" : "bar";
  return "bar";
}

/** The size a widget is when nothing has said otherwise. */
export function defaultSize(def: WidgetDef): readonly [number, number] {
  return def.sizes[0];
}

/** The nearest size this widget is allowed to be.
 *
 * ⚠️ NEAREST, not clamped, and the difference matters while a corner is being
 * dragged: a widget offered 1×1, 2×1 and 2×2 must jump from one to the next as
 * the pointer crosses halfway, rather than sticking at whichever bound it last
 * satisfied. Ties go to the smaller, so a drag that has not committed yet does
 * not grow the board under the pointer. */
export function nearestSize(def: WidgetDef, w: number, h: number): readonly [number, number] {
  /* ⚠️ Widened to the pair, not left as the literal tuple the array infers.
   * `as const` gives every entry its own exact type — `readonly [3, 1]` — so
   * `best` took the type of the first one and nothing else could be assigned to
   * it, which is a compile error about a 3 not being a 2 rather than anything
   * about sizes. */
  const sizes: readonly (readonly [number, number])[] = def.sizes;
  let best: readonly [number, number] = sizes[0];
  let score = Infinity;
  for (const size of sizes) {
    const gap = Math.abs(size[0] - w) + Math.abs(size[1] - h);
    if (gap < score || (gap === score && size[0] * size[1] < best[0] * best[1])) {
      best = size;
      score = gap;
    }
  }
  return best;
}

/** The size a stored widget should actually be drawn at.
 *
 * ⚠️ A zero means "whatever it asks for" — that is what a preferences file
 * written before widgets could be resized turns into, and what a widget just
 * dropped on a board carries until somebody resizes it. Anything else is
 * snapped to a size the widget allows, so a hand-edited file or a widget whose
 * sizes have since changed cannot produce a block the grid has no room for. */
export function sizeOf(def: WidgetDef, w: number, h: number): readonly [number, number] {
  if (!w || !h) return defaultSize(def);
  return nearestSize(def, w, h);
}

/** How wide a board wants its panel, in CSS pixels.
 *
 * ⚠️ Derived, and the caller caps it at the full body — past which the row
 * wraps rather than the blocks shrinking. A board of one widget on a panel
 * sized for three is the thing the width table exists to prevent everywhere
 * else. */
export function boardWidthCss(cells: number): number {
  if (cells <= 0) return 420;
  /* One cell is about this wide once the panel's padding and the gaps are
   * taken out of the island's full body. ⚠️ Derived from the grid rather than
   * chosen: the panel is capped at its full width anyway, so this only decides
   * how narrow a board of one or two blocks is allowed to be. */
  const CELL = 131, GAP = 18, PAD = 18;
  const across = Math.min(BOARD_COLUMNS, Math.max(1, cells));
  return across * CELL + (across - 1) * GAP + PAD * 2;
}

/* ── The day, as a fraction of itself ─────────────────────────────────────
 * ⚠️ Here rather than in `widget-bodies.ts` for the reason every decision in
 * this file is: `node --test` can load a module with no runtime imports, and
 * "which minute of the day is it, and is that before sunrise" is exactly the
 * kind of thing that is invisible on screen and obvious in a table. */

/** Minutes past midnight from a `HH:MM` clock, or -1 if it is not one.
 *
 * ⚠️ -1 rather than 0 or null: midnight IS zero, and a caller testing
 * truthiness would have treated a real midnight as a missing reading. */
export function clockMinutes(said: string | undefined | null): number {
  if (!said) return -1;
  const bits = /^(\d{1,2}):(\d{2})/.exec(said.trim());
  if (!bits) return -1;
  const hours = Number(bits[1]);
  const mins = Number(bits[2]);
  if (hours > 23 || mins > 59) return -1;
  return hours * 60 + mins;
}

export type DayPart = "dawn" | "day" | "dusk" | "night";

/** Where in the day it is, and how far through that stretch.
 *
 * ⚠️ `share` is of the CURRENT ARC, not of the 24 hours — daylight and
 * darkness are two arcs and the sun and moon each cross their own. A single
 * fraction of the day would put the sun at the top of its arc at noon only on
 * the equinox, and nowhere near it in December.
 *
 * ⚠️ Dawn and dusk are the half hour either side of the crossing, and they are
 * a LOOK rather than a third position: the sun is still on the day arc through
 * both. They exist because a sky that snaps from night to noon at 06:41 is the
 * one moment this widget is being watched. */
export function dayArc(nowMin: number, riseMin: number, setMin: number): {
  part: DayPart;
  share: number;
} {
  const DUSK = 30;
  // No reading yet, or a nonsense one: an even day from 6 to 18 is a shape
  // that is wrong by an hour rather than a widget that draws nothing.
  const rise = riseMin >= 0 ? riseMin : 6 * 60;
  const set = setMin > riseMin && setMin >= 0 ? setMin : 18 * 60;
  const now = Math.max(0, Math.min(24 * 60, nowMin));

  if (now >= rise && now <= set) {
    const span = Math.max(1, set - rise);
    const share = (now - rise) / span;
    const part: DayPart = now - rise < DUSK ? "dawn" : set - now < DUSK ? "dusk" : "day";
    return { part, share };
  }
  /* The night arc wraps midnight, so it is measured from sunset forward.
   * ⚠️ `+ 24h` on the far side rather than a branch on which side of midnight
   * it is — the same sum then works at 23:50 and at 00:10. */
  const span = Math.max(1, 24 * 60 - set + rise);
  const gone = now > set ? now - set : now + 24 * 60 - set;
  return { part: "night", share: gone / span };
}

/** How far through the lunar month, 0 and 1 being new and 0.5 full.
 *
 * ⚠️ Arithmetic, not an API. The synodic month is 29.530588853 days and a
 * known new moon is enough — this is accurate to a few hours, which is far
 * inside the width of the glyph it decides. */
export function moonPhase(at: Date): number {
  // 2000-01-06 18:14 UTC, a new moon.
  const KNOWN = Date.UTC(2000, 0, 6, 18, 14) / 86400000;
  const SYNODIC = 29.530588853;
  const days = at.getTime() / 86400000 - KNOWN;
  const turn = (days / SYNODIC) % 1;
  return turn < 0 ? turn + 1 : turn;
}

/** What to call it. ⚠️ Eight names, and the quarters are the exact ones: a
 *  moon within a day of half is "first quarter" to anybody looking at it, and
 *  a band of ±0.02 of the cycle is about a day either side. */
export function moonName(phase: number): string {
  const at = phase % 1;
  if (at < 0.02 || at >= 0.98) return "New moon";
  if (Math.abs(at - 0.25) < 0.02) return "First quarter";
  if (Math.abs(at - 0.5) < 0.02) return "Full moon";
  if (Math.abs(at - 0.75) < 0.02) return "Last quarter";
  if (at < 0.25) return "Waxing crescent";
  if (at < 0.5) return "Waxing gibbous";
  if (at < 0.75) return "Waning gibbous";
  return "Waning crescent";
}

/* ── A price, written the way the coin deserves ───────────────────────────
 * ⚠️ Pure and here rather than in `widget-bodies.ts`, the rule every decision
 * in this file follows: "how many decimals does 0.00004321 want" is exactly
 * the sort of thing that is invisible on screen and obvious in a table. */

/** Split a price into the part you read and the part you squint at.
 *
 * ⚠️ TWO pieces, because the block prints them at two sizes — a whole number
 * at 34px with its pennies at 17px is the shape every finance app uses, and it
 * is what lets the eye land on the figure rather than on the decimals.
 *
 * ⚠️ The number of decimals follows the SIZE of the price. 67432.10 wants two
 * and 0.00004321 wants eight; one rule for both prints either "67432.10000000"
 * or "0.00", and the second of those is a price of zero. */
export function coinPrice(value: number): { whole: string; rest: string } {
  if (!Number.isFinite(value)) return { whole: "—", rest: "" };
  const size = Math.abs(value);
  const places = size >= 1000 ? 0 : size >= 1 ? 2 : size >= 0.01 ? 4 : 8;
  const said = value.toFixed(places);
  const dot = said.indexOf(".");
  if (dot < 0) return { whole: group(said), rest: "" };
  return { whole: group(said.slice(0, dot)), rest: said.slice(dot) };
}

/** Thousands separators, thin-spaced. ⚠️ A NARROW NO-BREAK SPACE rather than a
 *  comma: the block already carries a decimal point, and a number with both is
 *  a number whose format you have to work out before you can read it. */
function group(said: string): string {
  const sign = said.startsWith("-") ? "-" : "";
  const digits = sign ? said.slice(1) : said;
  return sign + digits.replace(/\B(?=(\d{3})+(?!\d))/g, "\u202f");
}

/** The change, as a signed percentage with one decimal. ⚠️ Always signed, even
 *  when flat: "0.0%" reads as missing data and "+0.0%" reads as a quiet day. */
export function coinChange(pct: number): string {
  if (!Number.isFinite(pct)) return "—";
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
}

/** The sparkline as an SVG path across a 100x30 box.
 *
 * ⚠️ Scaled to the series' OWN range, not to zero. A coin that moved 2% in a
 * month is a flat line against an axis at zero, which is true and useless; the
 * question the line answers is "what shape was the month", and that needs the
 * month's own high and low.
 *
 * ⚠️ A flat series is drawn down the MIDDLE rather than divided by zero. */
export function sparkPath(values: readonly number[], width = 100, height = 30): string {
  if (values.length < 2) return "";
  const low = Math.min(...values);
  const high = Math.max(...values);
  const span = high - low;
  const step = width / (values.length - 1);
  return values
    .map((value, at) => {
      const x = at * step;
      const y = span > 0 ? height - ((value - low) / span) * height : height / 2;
      return `${at ? "L" : "M"}${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");
}

/** Where one point of the sparkline sits, in the same box `sparkPath` draws in.
 *
 * ⚠️ The SAME scaling, in one place. The chart's marker has to land on the line
 * it is marking, and a second copy of "low, high, span" is a marker that drifts
 * off the curve the first time either is changed. */
export function sparkPoint(
  values: readonly number[], at: number, width = 100, height = 30,
): { x: number; y: number } {
  if (values.length < 2) return { x: 0, y: height / 2 };
  const spot = Math.max(0, Math.min(values.length - 1, Math.round(at)));
  const low = Math.min(...values);
  const high = Math.max(...values);
  const span = high - low;
  return {
    x: (spot * width) / (values.length - 1),
    y: span > 0 ? height - ((values[spot] - low) / span) * height : height / 2,
  };
}

/** Which point of the series a fraction across the chart lands on. */
export function sparkIndex(count: number, across: number): number {
  if (count < 2) return 0;
  return Math.max(0, Math.min(count - 1, Math.round(across * (count - 1))));
}

/* ── Temperature, as a colour ─────────────────────────────────────────────
 * ⚠️ Pure and here for the reason every decision in this file is: "which
 * colour is 14 degrees" is exactly the sort of thing that looks fine on the
 * one day you check it and is wrong for the other nine months.
 */

/** Where a temperature sits on the cold-to-hot run, 0 to 1.
 *
 * ⚠️ Clamped to a HUMAN range, not to the thermometer's. Nobody's board needs
 * to tell -40 from -35; what the scale has to do is spread the twenty degrees
 * a week actually moves through, which is why it runs -10 to 38 rather than
 * over whatever the forecast happens to contain. A range taken from the data
 * would also mean the same 14° was blue on Monday and amber on Thursday. */
export function tempShare(celsius: number): number {
  if (!Number.isFinite(celsius)) return 0.5;
  return Math.max(0, Math.min(1, (celsius + 10) / 48));
}

/** …and that share as one of the app's own tones, with how much of it.
 *
 * ⚠️ TOKENS, never a hex. Every colour on the board comes from the six the app
 * already has, so a theme that changes one changes this too — and a literal
 * `#4aa8ff` here would be the one thing on a board a scheme could not reach.
 *
 * ⚠️ Banded on DEGREES, not on the share. Spread evenly over -10 to 38 the four
 * tones each covered twelve degrees, so a whole temperate day — 12° at dawn to
 * 19° at noon — came out in one colour and the chart said nothing. The bands
 * are where a person would put them: near freezing, cool, mild, hot.
 *
 * ⚠️ The WEIGHT still varies inside each band, so two neighbouring hours in the
 * same tone are not the identical bar. */
export function tempTone(celsius: number): { tone: string; weight: number } {
  const at = Number.isFinite(celsius) ? celsius : 12;
  const band = (low: number, high: number) =>
    0.45 + Math.max(0, Math.min(1, (at - low) / (high - low))) * 0.5;
  if (at < 5) return { tone: "cool", weight: 0.5 + Math.max(0, Math.min(1, (5 - at) / 15)) * 0.45 };
  if (at < 14) return { tone: "calm", weight: band(5, 14) };
  if (at < 23) return { tone: "warn", weight: band(14, 23) };
  return { tone: "hot", weight: band(23, 34) };
}

/** How long until a moment, as the two words anybody would say.
 *
 * ⚠️ "now" has its own answer rather than "in 0 min". A countdown that reads
 * zero is one you check twice to see whether it is broken. */
export function until(ms: number): string {
  if (!Number.isFinite(ms)) return "";
  const mins = Math.round(ms / 60000);
  if (mins <= 0) return "now";
  if (mins < 60) return `${mins} min`;
  const hours = Math.floor(mins / 60);
  const rest = mins % 60;
  if (hours < 24) return rest ? `${hours}h ${rest}m` : `${hours}h`;
  const days = Math.round(hours / 24);
  return days === 1 ? "tomorrow" : `${days} days`;
}
