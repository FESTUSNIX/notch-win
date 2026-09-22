/* Boards: a screen made of widgets, and the list of them.
 *
 * A board is a row of cards and a name. Home is board number one — not a
 * screen that happens to look like a board, the actual first entry in the
 * list, with the same three widgets it always had and the same freedom to be
 * rearranged as any board somebody builds.
 *
 * ⚠️ Home keeps the SCREEN NAME `home`, and `screenOf` is the one place that
 * exception lives. It is where the island opens, where a vanished screen sends
 * you, what `railOrder` and `railHidden` call it in every preferences file
 * already written, and what the palette and the ring have on disk. Renaming it
 * to `board:home` would be a rename of saved user data to gain tidiness in one
 * function.
 */
/* ⚠️ TYPES ONLY, and it has to stay that way. `node --test` strips types and
 * then resolves what is left, and Node's resolver does not add extensions the
 * way Vite does — one runtime import of a sibling here and every test of this
 * file fails to load. It is also why `isBoard` lives below rather than beside
 * the type it narrows to. */
import type { BoardName, ScreenName } from "./island-activity";
import type { TaskIcon } from "./task-icons";

/** One widget on a board, and how much of the grid it takes.
 *
 * ⚠️ `w` and `h` are GRID CELLS, not pixels. What a cell is worth depends on
 * how wide the panel is; what a widget is allowed to be is its own list of
 * sizes. Storing pixels would mean a board arranged on one monitor laid out
 * wrong on another. */
export interface BoardWidget {
  kind: string;
  w: number;
  h: number;
  /** Which of the widget's variants to draw, where it has any.
   *
   * ⚠️ Optional, and an empty string is the same as absent: most widgets have
   * one shape and storing `""` for every one of them would be a field that is
   * noise in nine entries out of ten. */
  variant?: string;
  /** What the block is drawn ON — see `WIDGET_STYLES`. Optional for the same
   *  reason, and absent means `none`, which is what the board defaults to. */
  style?: string;
}

export interface Board {
  /** Stable, and never reused. `home` is taken. */
  id: string;
  name: string;
  icon: TaskIcon;
  /** The widgets on it, in reading order.
   *
   * ⚠️ This was a list of bare NAMES until widgets learned to be resized, and
   * `normalise` still reads that form — a preferences file written before this
   * is a list of strings, and every one of them means "this widget at whatever
   * size it asks for by default". */
  widgets: BoardWidget[];
}

/** What a board may be drawn as, in the order the picker offers them.
 *
 * ⚠️ A SHORTLIST, not every icon there is. The set has eighty glyphs and most
 * of them mean something already — `pause`, `wxRain`, `pdf` — so offering all
 * of them is a grid you have to read rather than a row you can point at. These
 * are the ones that say "a place", which is what a board is.
 *
 * ⚠️ `home` leads, because it is what a new board starts as and what Home
 * keeps; a picker whose first entry is not the current value on first open
 * reads as having changed something. */
export const BOARD_ICONS = [
  "home", "grid", "star", "focus", "target", "today", "agenda", "review",
  "code", "media", "chip", "note", "shelf", "sun", "coffee", "words",
] as const satisfies readonly TaskIcon[];

/** The board the app ships with. ⚠️ Never handed out — read it through
 *  `defaults()`, which copies. */
export const DEFAULT_BOARDS: Board[] = [
  {
    id: "home", name: "Home", icon: "home",
    /* ⚠️ Two cells each, which on a six-column grid is exactly one row. Home
     * has been a BAR since the island had screens, and a default board that
     * wrapped to a second row would change what the island is on first run. */
    widgets: [
      { kind: "media", w: 2, h: 1 },
      { kind: "calendar", w: 2, h: 1 },
      { kind: "today", w: 2, h: 1 },
    ],
  },
];

/** A fresh copy of the built-in boards.
 *
 * ⚠️ DEEP, and the depth is the whole point. A spread copies the board but
 * shares its `widgets` ARRAY, so the first board built out of the default and
 * then edited rewrote the default itself — every later read came back with
 * somebody's changes already on it, and nothing anywhere would have said so. */
export function defaults(): Board[] {
  return DEFAULT_BOARDS.map(one => ({
    ...one, widgets: one.widgets.map(w => ({ ...w })),
  }));
}

/** How many boards there may be, when the preferences do not say.
 *
 * ⚠️ A NUMBER that is read, never a constant that is compared against. It is
 * in `prefs.rs` so that a build, a licence or a plan could set it without any
 * of the code below learning a second rule. */
export const DEFAULT_BOARD_CAP = 4;

/** Whether a screen name belongs to a board.
 *
 * ⚠️ Here rather than in `island-activity.ts`, beside `screenOf` — the two are
 * one fact read in both directions, and a prefix written down in two files is
 * a prefix that can be changed in one. */
export function isBoard(name: string): name is BoardName {
  return name.startsWith("board:");
}

/** The screen a board sits on. See the note at the top about `home`. */
export function screenOf(board: Board): ScreenName {
  return board.id === "home" ? "home" : (`board:${board.id}` as BoardName);
}

/** The board a screen name belongs to, or nothing if it is not a board. */
export function boardOf(boards: Board[], name: string): Board | undefined {
  if (name === "home") return boards.find(one => one.id === "home");
  if (!isBoard(name)) return undefined;
  const id = name.slice("board:".length);
  return boards.find(one => one.id === id);
}

/** An id nothing else is using. */
export function freshId(boards: Board[]): string {
  for (let n = 2; ; n++) {
    const id = `b${n}`;
    if (!boards.some(one => one.id === id)) return id;
  }
}

/** What came off disk, made safe to render.
 *
 * ⚠️ Every field is checked and every bad one is replaced, never rejected. A
 * preferences file is hand-editable and is read at boot on the path that draws
 * the first frame; throwing here is a black island, and dropping the whole
 * list to fix one bad name is somebody's four boards gone. */
export function normalise(raw: unknown): Board[] {
  if (!Array.isArray(raw) || !raw.length) return defaults();
  const seen = new Set<string>();
  const out: Board[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const one = entry as Partial<Board> & { widgets?: unknown };
    const id = typeof one.id === "string" && one.id.trim() ? one.id.trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    /* ⚠️ Reads the BARE NAME as well as the object. A preferences file written
     * before widgets could be resized is a list of strings, and every one of
     * them means "this widget, at whatever size it asks for" — which is a zero
     * here and filled in by `sized()` where the sizes are known. Numbers are
     * clamped rather than rejected: this file is hand-editable, and a `w` of
     * 400 should be a wide widget, not a board that fails to draw. */
    const widgets: BoardWidget[] = Array.isArray(one.widgets)
      ? one.widgets.flatMap(entry => {
        if (typeof entry === "string") return entry ? [{ kind: entry, w: 0, h: 0 }] : [];
        if (!entry || typeof entry !== "object") return [];
        const held = entry as {
          kind?: unknown; w?: unknown; h?: unknown; variant?: unknown; style?: unknown;
        };
        if (typeof held.kind !== "string" || !held.kind) return [];
        const cell = (value: unknown) =>
          (typeof value === "number" && Number.isFinite(value)
            ? Math.max(0, Math.min(6, Math.round(value))) : 0);
        const one: BoardWidget = { kind: held.kind, w: cell(held.w), h: cell(held.h) };
        /* ⚠️ Kept as it was WRITTEN, not checked against the widget's list:
         * this file does not know what variants exist, and `variantOf` is what
         * decides at draw time. Dropping an unrecognised one here would throw
         * away the setting of a widget whose variants are merely being renamed
         * in the build the user is about to install. */
        if (typeof held.variant === "string" && held.variant) one.variant = held.variant;
        // Same rule for the ground: `styleOf` decides at draw time.
        if (typeof held.style === "string" && held.style) one.style = held.style;
        return [one];
      })
      : [];
    out.push({
      id,
      name: typeof one.name === "string" && one.name.trim() ? one.name.trim() : "Board",
      icon: (typeof one.icon === "string" ? one.icon : "home") as TaskIcon,
      widgets,
    });
  }
  /* ⚠️ Home is put back if it is missing. It is the landing screen; a
   * preferences file without it is an island that opens onto nothing. */
  if (!out.some(one => one.id === "home")) out.unshift(defaults()[0]);
  return out;
}
