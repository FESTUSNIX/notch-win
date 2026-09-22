/* What each widget draws.
 *
 * The other half of `widgets.ts` — see the note at the top of it on why this
 * is a second file. A body is handed a wrapper that is already a block, with
 * its spacing, its tone and, where the widget says so, its whole-block press;
 * everything here is contents.
 *
 * None of these holds state. Every one reads the screen that owns the thing
 * and calls back into it, which is why there is exactly one optimistic task
 * layer, one media session and one agenda in the app however many boards are
 * built out of them.
 *
 * ⚠️ Every block has the same three parts in the same places: a LEAD (a small
 * uppercase word saying what this is), a FIGURE (the one thing you came to
 * read, set large and light) and then whatever detail the widget owes you.
 * That is what lets the blocks sit on a bare row with no panels around them
 * and still read as separate things — the alignment does the work the borders
 * used to.
 */
import { element } from "./dom";
import { coinMarkUrl } from "./coin-icon";
import { paintIcon, taskIcon, type TaskIcon } from "./task-icons";
import { localDay, overdueDays, weekStart } from "./task-model";
import { sourceName, type MediaSource } from "./screen-media";
import {
  countdown, dayHeading, endOf, nextEvent, startOf, timeLabel,
  type CalendarScreen,
} from "./screen-calendar";
import { noteTitle, notePreview, tintOf, type Note } from "./notes";
import { timerText } from "./focus-timer";
import {
  clockMinutes, coinChange, coinPrice, dayArc, moonName, moonPhase, sparkIndex,
  sparkPath, sparkPoint, tempTone, until, type DayPart,
} from "./widgets";
import { phaseName } from "./timer";
import type { Lengths } from "./timer";
import {
  counted, figureMs, running as runGoing, runName, through as runThrough,
  type Run, type RunKind,
} from "./runs";
import { buildRing, paintRing } from "./run-ring";
import type { Runs } from "./runs";
import { mediaLayout, weatherParts } from "./widgets";
import type { BlockShape, WidgetKind } from "./widgets";
import type { TodayScreen } from "./screen-today";
import type { SessionView } from "./screen-agents";
import type { ShelfItem } from "./screen-shelf";
import type { ScreenName } from "./island-activity";

/** Days either side of today in the date strip. */
/* ⚠️ A WEEK, not a window. It used to be the two days behind today and the
 * four ahead, which is seven cells that are never the same seven twice — the
 * strip shifted under you every midnight and the column a date sat in meant
 * nothing. It is Monday to Sunday now (or Sunday to Saturday; see prefs), so
 * the position of a day is information. */
const STRIP_DAYS = 7;

/** What the weather module reads, which is all there is of it. ⚠️ No hourly
 *  row: `weather.rs` reports one observation, and a strip of invented hours
 *  would be a forecast the app does not have. */
export interface WeatherReading {
  place: string;
  celsius: number;
  summary: string;
  icon: string;
  /* ── Everything `weather.rs` fetches for the blocks ───────────────────
   * ⚠️ All optional. The pill has shown one line for a year and must keep
   * working when a reply arrives without these, so the widgets that want a
   * forecast check for one — which is a state they have to handle on the
   * first poll after a cold start anyway. */
  isDay?: boolean;
  high?: number | null;
  low?: number | null;
  sunrise?: string;
  sunset?: string;
  hours?: { at: string; celsius: number; icon: string }[];
  days?: { date: string; icon: string; high: number; low: number }[];
}

/** One coin, as `crypto.rs` reports it.
 *
 * ⚠️ A PRICE, not a balance. Reading a wallet needs an API key and a signature
 * over every request — a secret this app would then be holding — and its
 * credentials go in Windows Credential Manager through the native editor, never
 * through a WebView. See the note at the top of `crypto.rs`. */
export interface CoinReading {
  symbol: string;
  name: string;
  quote: string;
  price: number;
  changePct: number;
  high: number;
  low: number;
  /** Daily closes, oldest first. ⚠️ May be EMPTY: the price is the point and
   *  the line is decoration, so a failed klines call still leaves a reading. */
  spark: number[];
  readAtMs: number;
}

/** What the account holds, as `crypto.rs` reports it.
 *
 * ⚠️ There is no key in here and there never will be. The secret goes into
 * Windows Credential Manager on the way in and is read back only inside Rust to
 * sign a request — no command returns it and no event carries it, because this
 * side of the app runs in a WebView. */
export interface WalletReading {
  connected: boolean;
  total: number;
  quote: string;
  holdings: { asset: string; amount: number; value: number }[];
  /** What it has been worth, oldest first, in the DISPLAY currency.
   *
   * ⚠️ Recorded by the app, not fetched: Binance hands out a snapshot and no
   * history. Which means it STARTS EMPTY — a block that assumed points would
   * be there draws nothing on the first run, which is everybody's first run. */
  history: { at: number; value: number }[];
  changePct: number;
  spanMs: number;
  readAtMs: number;
}

/** What the machine is doing, as the pill's modules read it. */
export interface MachineReading {
  cpu: number;
  memory: number;
  diskUsed: number;
  diskFree: number;
}

/** Everything a widget can read. One bag for all of them rather than one per
 *  kind: a board builds widgets it was told about by name, so it cannot know
 *  which subset any of them wants. */
export interface WidgetDeps {
  today: TodayScreen;
  media: MediaSource;
  calendar: CalendarScreen;
  /** The pomodoro's lengths, read fresh. */
  lengths: () => Lengths;
  /** Every countdown and stopwatch there is. ⚠️ The LIST, not two engines:
   *  a board can be looking at whichever one is live, and a widget that held a
   *  reference to one of two would show a timer nobody is running while three
   *  others count down behind it. */
  runs: Runs;
  open: (screen: ScreenName) => void;
  /** ⚠️ Functions, not values. Deps are built once at boot and a preference
   *  or a poll can change under them; reading through a call means a board
   *  never holds a stale copy of one. */
  mondayFirst: () => boolean;
  clock24: () => boolean;
  fahrenheit: () => boolean;
  weather: () => WeatherReading | null;
  crypto: () => CoinReading | null;
  wallet: () => WalletReading | null;
  machine: () => MachineReading | null;
  agents: () => SessionView[];
  notes: () => Note[];
  shelf: () => ShelfItem[];
  /** Redraw. ⚠️ A widget that changes something has to say so — the shell's
   *  own beat is a second wide, and a transport button that takes a second to
   *  look pressed reads as one that missed. */
  changed: () => void;
}

/** What a body is told about the block it is drawing into. ⚠️ Passed rather
 *  than measured: a block knows its shape in CELLS before it has a box, and a
 *  body that read its own width would be laying out against last frame's. */
export type WidgetBody = (host: HTMLElement, deps: WidgetDeps, at: BlockShape) => void;

/* ── The parts every block is made of ───────────────────────────────────── */

/** A line of context at the top of a block, where one is genuinely needed.
 *
 * ⚠️ USED SPARINGLY, and it is not uppercase any more. Every block carried a
 * tracked, capitalised eyebrow — NOW PLAYING over a song, WEATHER over a
 * temperature, SHELF over a list of shelved files — which is a label telling
 * you what you are already looking at, ten times over, in the style every
 * generated interface reaches for. It survives only where the content is
 * genuinely ambiguous without it: a date over a month grid, the place a
 * temperature is for, what a countdown is counting.
 *
 * ⚠️ And it is sentence case. The tracked uppercase was doing the work of six
 * different headings and was the loudest thing on a board of quiet ones. */
function lead(text: string, icon?: TaskIcon): HTMLElement {
  const row = element("div", "w-lead");
  if (icon) {
    const mark = element("span", "w-lead-mark");
    mark.append(taskIcon(icon));
    row.append(mark);
  }
  row.append(element("span", "", text));
  return row;
}

/** The one number you came to read. */
function figure(text: string, small?: string): HTMLElement {
  const wrap = element("div", "w-figure");
  wrap.append(element("span", "w-figure-big", text));
  if (small) wrap.append(element("span", "w-figure-unit", small));
  return wrap;
}

/** One round control. ⚠️ The SAME control on every widget, so a board of ten
 *  blocks is not ten ideas of what a button is — and `data-tip` rather than
 *  `title`, which is the app's own tooltip and does not wait a second. */
function key(icon: TaskIcon, label: string, run: () => void, cls = ""): HTMLElement {
  const button = element("button", `home-key${cls ? " " + cls : ""}`);
  (button as HTMLButtonElement).type = "button";
  button.setAttribute("aria-label", label);
  button.dataset.tip = label;
  paintIcon(button, icon);
  button.onclick = event => { event.stopPropagation(); run(); };
  return button;
}

/** Nothing to show, said in the block's own voice.
 *
 * ⚠️ TWO lines, and the second one is the point: "No tasks" is a fact and
 * reads as a failure to load. "Nothing to do — everything is clear" is the
 * same fact and reads as good news, which on an empty day it is. */
function quiet(host: HTMLElement, said: string, why = ""): void {
  const wrap = element("div", "w-quiet");
  wrap.append(element("span", "w-quiet-say", said));
  if (why) wrap.append(element("span", "w-quiet-why", why));
  host.append(wrap);
}

/* ── Media ─────────────────────────────────────────────────────────────────
 * Art, the words beside it, the scrubber and the transport under both. */
/* ── Media ─────────────────────────────────────────────────────────────────
 * Art, the words beside it, the scrubber and the transport under both. */
/* ── Media ─────────────────────────────────────────────────────────────────
 * One track, three arrangements of it: a row, a column, or the cover with the
 * words laid over it. */
const mediaBody: WidgetBody = (wrap, deps, at) => {
  const media = deps.media.media;
  const how = mediaLayout(at.variant, at.w, at.h);
  wrap.dataset.layout = how;

  if (!media.active) {
    quiet(wrap, "Nothing playing", how === "cover" ? "" : "Start something and it lands here.");
    return;
  }

  const art = element("div", "home-art");
  if (media.artwork) {
    const image = element("img") as HTMLImageElement;
    image.src = media.artwork;
    image.alt = "";
    /* ⚠️ Nominal, and CSS decides the real box. The attributes are what stop
     * the block reflowing when the cover arrives — and what theme-check asks
     * for — but a column wants a much bigger one than a row. */
    image.width = 300;
    image.height = 300;
    art.append(image);
  } else {
    art.classList.add("blank");
    paintIcon(art, "media");
  }

  const copy = element("div", "home-media-copy");
  copy.append(element("span", "home-track-title", media.title || "Unknown track"));
  copy.append(element("span", "home-track-artist",
    [media.artist, sourceName(media.source)].filter(Boolean).join(" · ")));

  /* ── The cover ───────────────────────────────────────────────────────────
   * ⚠️ The artwork IS the block, and the words and the transport sit over it
   * on a scrim. At one cell there is room for the cover or for the words, not
   * both side by side — and a square of album art with the title across the
   * foot is the one arrangement that is still legible when it is the size of
   * an app icon. The controls arrive on hover, because a permanent transport
   * over a 130px square is more button than picture. */
  if (how === "cover") {
    wrap.append(art);
    const over = element("div", "home-cover-over");
    /* ⚠️ The transport is CENTRED in the block and the words sit under it, at
     * the foot. Stacked title-then-buttons the pair floated in the middle of
     * the square with the artwork showing above and below, which reads as a
     * caption that has come loose; a centred transport over a picture is the
     * arrangement every player has used since the cassette. */
    over.append(transport(media, deps, false), copy);
    wrap.append(over);
    return;
  }

  if (how === "stack") {
    /* ⚠️ The art takes the SLACK. A column layout in a tall block used to put
     * a fixed square at the top and leave the rest of the block empty; giving
     * the cover `flex: 1` means a taller block is simply a bigger cover, which
     * is what anybody making one taller was asking for. */
    wrap.append(art, copy);
  } else {
    const head = element("div", "home-media-head");
    head.append(art, copy);
    wrap.append(head);
  }

  /* ── Where you are in it ────────────────────────────────────────────────
   * ⚠️ A real scrubber, not a progress bar. The whole block is a CONTROL —
   * shrunk, not stripped — and the one thing anybody does to a track that is
   * already playing is move about inside it. Dragging as well as pressing,
   * because a 4px-tall rail is not a target you can hit by tapping.
   *
   * ⚠️ `position()` rather than `media.position`, which is only as fresh as
   * the last event. The player screen does the same. */
  const now = deps.media.position();
  const seekable = media.canSeek && media.duration > 0;
  wrap.classList.toggle("home-scrub", true);
  wrap.classList.toggle("can-seek", seekable);
  const rail = element("div", "home-rail");
  const fill = element("i");
  fill.style.width = `${(media.duration > 0
    ? Math.max(0, Math.min(1, now / media.duration)) : 0) * 100}%`;
  rail.append(fill);
  if (seekable) {
    /* ⚠️ Pointer capture, and the seek is sent on RELEASE. Seeking on every
     * move means a command per frame to a player across a process boundary,
     * and the ones that arrive out of order leave the track somewhere nobody
     * asked for. The fill follows the finger meanwhile, so it still reads as
     * live. */
    const to = (x: number) => {
      const box = rail.getBoundingClientRect();
      return Math.max(0, Math.min(1, (x - box.left) / box.width));
    };
    let held = false;
    rail.addEventListener("pointerdown", event => {
      event.stopPropagation();
      held = true;
      rail.setPointerCapture(event.pointerId);
      fill.style.width = `${to(event.clientX) * 100}%`;
    });
    rail.addEventListener("pointermove", event => {
      if (held) fill.style.width = `${to(event.clientX) * 100}%`;
    });
    for (const done of ["pointerup", "pointercancel"] as const) {
      rail.addEventListener(done, event => {
        if (!held) return;
        held = false;
        deps.media.seek(to(event.clientX));
      });
    }
  }
  wrap.append(rail);

  /* ⚠️ Remaining, written as a negative — not the total. The total is the
   * same number every time you look at it; how much is left is the one you
   * were actually asking for. Same rule as the player screen. */
  const under = element("div", "home-under");
  under.append(element("span", "home-time", media.duration > 0 ? clockText(now) : ""));
  under.append(transport(media, deps, at.w >= 3 || how === "stack"));
  under.append(element("span", "home-time is-right", media.duration > 0
    ? `-${clockText(Math.max(0, media.duration - now))}` : ""));
  wrap.append(under);
};

/** The transport row.
 *
 * ⚠️ Shuffle only where there is room for a fifth control. It is the one
 * button here that is a preference rather than a move, so it is the first to
 * go when the block is narrow. */
function transport(
  media: MediaSource["media"], deps: WidgetDeps, roomy: boolean,
): HTMLElement {
  const keys = element("div", "home-controls");
  if (roomy) {
    /* ⚠️ DRAWN, not wired. Windows' media session exposes no shuffle command
     * — `media.rs` has nothing to send — so this is a disabled control that
     * says what the row is for rather than a button that silently does
     * nothing. It comes back the day the transport gains one. */
    const mark = key("shuffle", "Shuffle is not available here", () => {});
    (mark as HTMLButtonElement).disabled = true;
    keys.append(mark);
  }
  for (const [icon, label, action, enabled] of [
    ["previous", "Previous track", "previous", media.canPrevious],
    [media.playing ? "pause" : "play", media.playing ? "Pause" : "Play", "playpause", media.canPlayPause],
    ["next", "Next track", "next", media.canNext],
  ] as const) {
    const button = key(icon, label, () => deps.media.control(action),
      action === "playpause" ? "is-main" : "");
    (button as HTMLButtonElement).disabled = !enabled;
    keys.append(button);
  }
  return keys;
}

/** m:ss, or h:mm:ss past an hour. ⚠️ Local rather than `media-format`'s
 *  `clock`, which this used to import — one import of that module pulled the
 *  whole player's formatting into every board. */
function clockText(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  return h
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

/* ── Calendar ───────────────────────────────────────────────────────────────
 * Three views of one agenda: the week you are in, the shape of the month, or
 * what is actually coming up. ⚠️ Which of those you want has nothing to do
 * with how much room the block has, which is why they are variants and not
 * rungs on the size ladder. */
const calendarBody: WidgetBody = (wrap, deps, at) => {
  const feed = deps.calendar.feed;
  const today = localDay();
  /* Every day with something on it, as `YYYY-MM-DD`. ⚠️ Built once for all
   * three views: a month grid asks about thirty-five days and a `some()` over
   * the events for each would be thirty-five passes of the same list. */
  const busy = new Set(feed.events.map(e => (e.allDay ? e.start.slice(0, 10) : localDay(startOf(e)))));
  const now = new Date();

  if (at.variant === "month") {
    wrap.append(lead(now.toLocaleDateString(undefined, { month: "long", year: "numeric" }), "calendar"));
    wrap.append(monthGrid(now, today, busy, deps.mondayFirst()));
    if (!at.tall) return;
    nextLine(wrap, feed, today, now);
    return;
  }

  if (at.variant === "next") {
    /* ── One thing, big, and the rest as a rail ────────────────────────────
     * ⚠️ NO LEAD. The block's subject is the event's own name at heading size;
     * a grey "What is next" over it would be a caption on the one line that
     * needs no caption. This is the variant that answers "am I late" from
     * across the room, which the list beside it cannot. */
    if (!feed.connected) {
      wrap.append(lead("What is next", "agenda"));
      quiet(wrap, "Calendar not connected", "Connect one in Settings.");
      return;
    }
    /* ⚠️ Anything that has not ENDED, not anything that has not started. An
     * event you are in the middle of is the most relevant thing there is. */
    const coming = feed.events
      .filter(one => endOf(one) > now)
      .sort((a, b) => startOf(a).getTime() - startOf(b).getTime());
    if (!coming.length) {
      wrap.append(lead("What is next", "agenda"));
      quiet(wrap, "Nothing coming up", "The rest of the day is yours.");
      return;
    }

    const [first, ...rest] = coming;
    const began = startOf(first) <= now;
    const tone = first.color || "#5ac8fa";
    wrap.style.setProperty("--cal", tone);

    const head = element("div", "up-head");
    /* ⚠️ The COUNTDOWN is the headline, in the calendar's own colour — "in 18
     * min" is the thing you are actually asking, and the title is what it is
     * about. An event already running says so instead of counting up. */
    head.append(element("div", "up-when",
      began ? "Now" : until(startOf(first).getTime() - now.getTime())));
    if (!first.allDay) {
      head.append(element("div", "up-clock", timeLabel(first)));
    }
    wrap.append(head);
    wrap.append(element("div", "up-title", first.title));

    /* The rest of the day as a rail. ⚠️ Only two or three of them: this block
     * is about the next thing, and a list long enough to scroll is the
     * `agenda` variant standing beside it. */
    const more = rest.slice(0, at.tall ? 4 : 2);
    if (!more.length) return;
    const rail = element("div", "up-rail");
    for (const one of more) {
      const row = element("div", "up-row");
      const dot = element("span", "up-dot");
      dot.style.setProperty("--cal", one.color || "#5ac8fa");
      row.append(dot, element("span", "up-row-title", one.title));
      row.append(element("span", "up-row-when",
        one.allDay ? "All day" : until(startOf(one).getTime() - now.getTime())));
      rail.append(row);
    }
    wrap.append(rail);
    return;
  }

  if (at.variant === "agenda") {
    wrap.append(lead("What is next", "agenda"));
    if (!feed.connected) {
      quiet(wrap, "Calendar not connected", "Connect one in Settings.");
      return;
    }
    /* ⚠️ Anything that has not ENDED, not anything that has not started. An
     * event you are in the middle of is the most relevant thing on this list,
     * and `nextEvent` deliberately skips it. */
    const coming = feed.events
      .filter(one => endOf(one) > now)
      .sort((a, b) => startOf(a).getTime() - startOf(b).getTime())
      .slice(0, at.tall ? 6 : 3);
    if (!coming.length) {
      quiet(wrap, "Nothing coming up", "The rest of the day is yours.");
      return;
    }
    const list = element("div", "home-agenda");
    for (const one of coming) {
      const row = element("div", "home-agenda-row");
      const when = element("span", "home-agenda-when",
        one.allDay ? "All day" : timeLabel(one));
      when.style.setProperty("--cal", one.color || "#5ac8fa");
      row.append(when, element("span", "home-agenda-title", one.title));
      const day = one.allDay ? one.start.slice(0, 10) : localDay(startOf(one));
      if (day !== today) row.append(element("span", "home-agenda-day", dayHeading(day)));
      list.append(row);
    }
    wrap.append(list);
    return;
  }

  /* ── The week ────────────────────────────────────────────────────────── */
  wrap.append(lead(now.toLocaleDateString(undefined, { month: "long" }), "calendar"));
  wrap.append(weekStrip(now, today, busy, deps.mondayFirst()));
  if (!feed.connected) {
    quiet(wrap, "Calendar not connected", "Connect one in Settings.");
    return;
  }
  nextLine(wrap, feed, today, now);
};

/** The seven days you are in. */
function weekStrip(now: Date, today: string, busy: Set<string>, mondayFirst: boolean): HTMLElement {
  const days = element("div", "home-days");
  const first = weekStart(now, mondayFirst);
  for (let offset = 0; offset < STRIP_DAYS; offset++) {
    const date = new Date(first);
    date.setDate(first.getDate() + offset);
    days.append(dayCell(date, today, busy));
  }
  return days;
}

/** The whole month, as a grid.
 *
 * ⚠️ It starts on the same weekday the week strip does, and pads to whole
 * weeks — a month grid whose first row is short by three cells is a grid where
 * the columns have stopped meaning a weekday, which is the only thing a month
 * view is for. */
function monthGrid(now: Date, today: string, busy: Set<string>, mondayFirst: boolean): HTMLElement {
  const grid = element("div", "home-month");
  const first = new Date(now.getFullYear(), now.getMonth(), 1);
  const from = weekStart(first, mondayFirst);
  /* Six weeks always, not "as many as this month needs". ⚠️ A grid that is
   * five rows in November and six in December changes the block's height when
   * the month turns, which on a board is every other widget moving. */
  for (let cell = 0; cell < 42; cell++) {
    const date = new Date(from);
    date.setDate(from.getDate() + cell);
    const out = date.getMonth() !== now.getMonth();
    const one = dayCell(date, today, busy, true);
    if (out) one.classList.add("is-away");
    grid.append(one);
  }
  return grid;
}

/** One day, in either grid. */
function dayCell(date: Date, today: string, busy: Set<string>, terse = false): HTMLElement {
  const key = localDay(date);
  const weekend = date.getDay() === 0 || date.getDay() === 6;
  const cell = element("div",
    `home-day${key === today ? " is-today" : ""}${busy.has(key) ? " busy" : ""}${weekend ? " weekend" : ""}`);
  if (!terse) {
    cell.append(element("span", "home-day-name",
      date.toLocaleDateString(undefined, { weekday: "narrow" })));
  }
  cell.append(
    element("span", "home-day-num", String(date.getDate())),
    element("span", "home-day-dot"),
  );
  return cell;
}

/** One line saying what the very next thing is.
 *
 * ⚠️ The strip's dots already say which days are busy; this says what. Two
 * lists of the same events would be the block arguing with itself. */
function nextLine(wrap: HTMLElement, feed: CalendarScreen["feed"], today: string, now: Date) {
  const next = nextEvent(feed.events, now) || feed.events.filter(e => endOf(e) > now)[0];
  if (!next) {
    quiet(wrap, "Nothing else today", "The rest of the day is yours.");
    return;
  }
  const line = element("div", "home-next");
  const day = next.allDay ? next.start.slice(0, 10) : localDay(startOf(next));
  const chip = element("span", "home-next-when",
    next.allDay ? "All day" : countdown(now, startOf(next)));
  chip.style.setProperty("--cal", next.color || "#5ac8fa");
  line.append(chip, element("span", "home-next-title", next.title));
  if (day !== today) line.append(element("span", "home-next-day", dayHeading(day)));
  wrap.append(line);
}

/* ── Today ──────────────────────────────────────────────────────────────── */
const todayBody: WidgetBody = (wrap, deps) => {
  const { total, done, reliable } = deps.today.tally();
  const next = deps.today.upNext(3);
  const left = Math.max(0, total - done);

  /* ⚠️ The weekday, which is the one thing a list of tasks does not say about
   * itself. "TODAY" over a list of today's tasks was the label this block was
   * carrying before, and it told you nothing the content did not. */
  wrap.append(lead(new Date().toLocaleDateString(undefined, { weekday: "long" })));

  if (!reliable || !total) {
    quiet(wrap, "Nothing scheduled", "Add something and it shows up here.");
    addRow(wrap, deps);
    return;
  }
  if (!next.length) {
    wrap.append(figure(String(done), done === 1 ? "done" : "done"));
    quiet(wrap, "All clear", "Everything for today is finished.");
    return;
  }

  wrap.append(figure(String(left), left === 1 ? "to do" : "to do"));

  const ns = "http://www.w3.org/2000/svg";
  const list = element("div", "home-tasks");
  for (const task of next) {
    // A finished task lingers for the settle window, so the tick and the
    // strike are seen before the row leaves. Same beat as the day screen.
    const finished = task.status === 2;
    const row = element("div", `home-task${finished ? " is-done" : ""}`);
    const check = element("label", "check");
    // Same list colour as the day screen: the ring is how a task says which
    // list it is on, here as much as there.
    check.style.setProperty("--list", deps.today.colorOf(task));
    const input = element("input") as HTMLInputElement;
    input.type = "checkbox";
    input.checked = finished;
    input.disabled = !deps.today.writeable || finished;
    input.setAttribute("aria-label", `Complete ${task.title}`);
    input.onchange = () => { input.checked = finished; deps.today.finish(task); };
    const mark = document.createElementNS(ns, "svg");
    mark.setAttribute("viewBox", "0 0 24 24");
    mark.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", "M6.2 12.6 L10 16.4 L17.8 7.6");
    mark.append(path);
    check.append(input, element("span", "disc"), element("span", "fill"), mark, element("span", "pulse"));
    row.append(check, element("span", "home-task-title strike", task.title));
    // The one piece of context worth the width: how late it already is.
    const late = overdueDays(task);
    if (late && !finished) {
      row.append(element("span", "home-late", late > 99 ? "99+d" : `${late}d`));
    }
    list.append(row);
  }
  wrap.append(list);
  addRow(wrap, deps);
};

/** ⚠️ One line, and it opens the DAY rather than composing here. A second
 *  composer on a board would be a second place a task can be half-typed and a
 *  second set of rules for where it lands — and the screen it opens has the
 *  field already focused, so the cost is the same keystroke either way. */
function addRow(wrap: HTMLElement, deps: WidgetDeps) {
  const add = element("button", "home-add");
  (add as HTMLButtonElement).type = "button";
  add.disabled = !deps.today.writeable;
  const plus = element("span", "home-add-mark");
  paintIcon(plus, "plus");
  add.append(plus, element("span", "", "Add a task"));
  add.onclick = () => deps.open("today");
  wrap.append(add);
}

/* ── The clock ──────────────────────────────────────────────────────────────
 * The one widget that reads nothing. ⚠️ It does not tick itself: the shell
 * already renders every screen on its own beat, and a second interval for one
 * block would be a second clock to keep in step with the pill's. */
const clockBody: WidgetBody = (wrap, deps) => {
  const now = new Date();
  wrap.append(figure(now.toLocaleTimeString(undefined, {
    hour: "2-digit", minute: "2-digit", hour12: !deps.clock24(),
  })));
  /* ⚠️ The DATE under the time, not a label over it. A clock block needs no
   * heading saying "clock"; what it can usefully add is the day. */
  wrap.append(element("p", "w-line", now.toLocaleDateString(undefined, {
    weekday: "long", day: "numeric", month: "long",
  })));
};

/* ── The countdown ──────────────────────────────────────────────────────────
 * Whichever of the two engines is running, and the controls for it.
 *
 * ⚠️ The POMODORO wins when both are live. It is the one with a shape to be
 * partway through — round 2 of 4 means something a plain countdown cannot say
 * — and a block that showed whichever started last would change what it is
 * about without being touched.
 *
 * ⚠️ It STARTS one when nothing is running, rather than printing "nothing
 * counting down". A block whose whole content is a sentence about its own
 * emptiness is a block that never earns the space — and the pomodoro is one
 * press away either side of this.
 *
 * Three faces for the same countdown: a ring, the bare numbers, or the
 * screen's own dial. ⚠️ The DIAL is the only one you can set a timer with,
 * which is why it is here at all — the other two can start a pomodoro and stop
 * whatever is running, and neither can say "eleven minutes". */
/* ── The wallet ───────────────────────────────────────────────────────────
 * What the account is worth, and what it is in.
 *
 * ⚠️ A SEPARATE block from the coin. One is a price anybody can look up and the
 * other is your balance — they answer different questions, they need different
 * permissions, and folding the second into the first would mean a block that is
 * sometimes about the market and sometimes about you. */
const walletBody: WidgetBody = (wrap, deps, at) => {
  const held = deps.wallet();
  if (!held?.connected) {
    wrap.append(lead("Wallet", "chip"));
    /* ⚠️ Says what to DO. "Not connected" is a fault report; what a blank block
     * needs is the sentence that makes it not blank. */
    wrap.append(element("p", "w-line", "Connect Binance in Settings"));
    return;
  }

  const up = held.changePct >= 0;
  wrap.dataset.way = up ? "up" : "down";
  const sign = quoteSign(held.quote);
  const money = (value: number) => {
    const said = coinPrice(value);
    return sign ? `${sign}${said.whole}${said.rest}` : `${said.whole}${said.rest} ${held.quote}`;
  };

  /* ── Who, and over what ────────────────────────────────────────────── */
  const head = element("div", "coin-b-head");
  head.append(coinMonogram("BAL"));
  const who = element("div", "coin-who");
  who.append(element("span", "coin-name", "Balance"));
  who.append(element("span", "coin-pair", `${held.holdings.length} assets`));
  head.append(who);
  /* ⚠️ How long the line actually covers, said plainly. A sparkline with no
   * span is a shape you cannot read — and this one starts the day the app
   * does, so implying a month would be a lie for the first month. */
  head.append(element("span", "coin-span", spanOf(held.spanMs)));
  wrap.append(head);

  /* ── The number ─────────────────────────────────────────────────────── */
  const total = coinPrice(held.total);
  const figure$ = element("div", "coin-price");
  if (sign) figure$.append(element("span", "coin-quote", sign));
  const whole = element("span", "coin-whole", total.whole);
  const rest = element("span", "coin-rest", total.rest);
  figure$.append(whole, rest);
  if (!sign) figure$.append(element("span", "coin-quote", ` ${held.quote}`));

  const chip = element("span", "coin-chip");
  chip.append(taskIcon("down"));
  const pct = element("span", "", coinChange(held.changePct));
  chip.append(pct);
  const row = element("div", "coin-row");
  row.append(figure$, chip);
  wrap.append(row);

  /* ── The line ────────────────────────────────────────────────────────
   * ⚠️ It is OURS, recorded a point at a time — Binance hands out a snapshot,
   * not a history. Which means it starts empty, and a block that drew an empty
   * chart would look broken rather than new. */
  const points = held.history.map(one => one.value);
  if (points.length > 1) {
    const NS = "http://www.w3.org/2000/svg";
    const box = element("div", "wal-chart");
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 100 30");
    svg.setAttribute("preserveAspectRatio", "none");
    svg.setAttribute("aria-hidden", "true");
    const shape = sparkPath(points);
    const area = document.createElementNS(NS, "path");
    area.setAttribute("class", "coin-area");
    area.setAttribute("d", `${shape} L100 30 L0 30 Z`);
    const line = document.createElementNS(NS, "path");
    line.setAttribute("class", "coin-line");
    line.setAttribute("d", shape);
    line.setAttribute("vector-effect", "non-scaling-stroke");
    svg.append(area, line);
    const guide = element("i", "coin-guide");
    const dot = element("i", "coin-dot");
    const peek = element("div", "coin-peek");
    box.append(svg, guide, dot, peek);
    wrap.append(box);

    /* ⚠️ The readout is a PILL on the line, not the head — unlike the coin
     * block, where the head is the only number. Here the head is the balance
     * now, which is the thing you came for; a scrub that overwrote it would
     * take away the number while you were comparing against it. */
    const show = (index: number) => {
      const spot = sparkPoint(points, index);
      guide.style.left = `${spot.x}%`;
      dot.style.left = `${spot.x}%`;
      dot.style.top = `${(spot.y / 30) * 100}%`;
      const when = new Date(held.history[index].at);
      peek.replaceChildren(
        element("span", "wal-peek-money", money(points[index])),
        element("span", "wal-peek-when",
          when.toLocaleDateString(undefined, { day: "2-digit", month: "short" })),
      );
      peek.style.left = `${spot.x}%`;
      peek.dataset.edge = index === 0 ? "start"
        : index === points.length - 1 ? "end" : "";
      box.dataset.peek = "";
    };
    box.addEventListener("pointermove", event => {
      const rect = box.getBoundingClientRect();
      if (rect.width <= 0) return;
      show(sparkIndex(points.length, (event.clientX - rect.left) / rect.width));
    });
    box.addEventListener("pointerleave", () => { delete box.dataset.peek; });
  } else {
    /* ⚠️ Says what is happening rather than drawing a flat line. One reading is
     * not a shape, and a straight line across the block would read as a balance
     * that has not moved rather than as one nobody has watched yet. */
    wrap.append(element("p", "wal-waiting", "Watching — the line starts filling in now"));
  }

  if (!held.holdings.length) {
    wrap.append(element("p", "w-line", "Nothing held"));
    return;
  }

  /* ── What it is in ─────────────────────────────────────────────────────
   * ⚠️ UNDER the chart, and a bar plus rows rather than rows alone. "How much
   * of this is one coin" is a proportion, and a proportion is a length. */
  const most = at.h >= 2 ? 5 : 2;
  const shown = held.holdings.slice(0, most);
  const bar = element("div", "wal-bar");
  for (const [index, one] of held.holdings.entries()) {
    const part = element("i");
    part.style.width = `${(one.value / Math.max(1, held.total)) * 100}%`;
    part.style.setProperty("--slice", `var(--${SLICE[index % SLICE.length]})`);
    bar.append(part);
  }
  wrap.append(bar);

  const list = element("div", "wal-list");
  for (const [index, one] of shown.entries()) {
    const line = element("div", "wal-row");
    /* ⚠️ The coin's own mark where the colour dot was, RINGED in the slice
     * colour rather than replacing it. The dot's job was to say which band of
     * the bar above this row is — which is a job the logo cannot do, because
     * the bar is every holding and the list is the top two or five. So the
     * mark says what the coin is and the ring says where it is, and the row
     * still answers both questions in one 18px circle.
     *
     * ⚠️ Falls back to the bare dot, not to a monogram. Three letters at this
     * size sit right next to the ticker they abbreviate, which reads as the
     * same word printed twice. */
    const url = coinMarkUrl(one.asset);
    const dot = element("span", url ? "wal-dot is-real" : "wal-dot");
    dot.style.setProperty("--slice", `var(--${SLICE[index % SLICE.length]})`);
    if (url) {
      const img = element("img");
      img.src = url;
      img.alt = "";
      img.decoding = "async";
      img.addEventListener("error", () => { dot.replaceChildren(); dot.className = "wal-dot"; }, { once: true });
      dot.append(img);
    }
    line.append(dot, element("span", "wal-asset", one.asset));
    /* ⚠️ An asset with no value is one Binance does not quote against USDT, not
     * one worth nothing — and "0.00" for it would be a number somebody might
     * believe. A dash is the honest answer. */
    const said = element("span", "wal-worth", one.value > 0 ? money(one.value) : "—");
    if (one.value <= 0) said.dataset.tip = `No ${held.quote} pair to value ${one.asset} with`;
    line.append(said);
    line.append(element("span", "wal-amount", trim(one.amount)));
    list.append(line);
  }
  wrap.append(list);
};

/** How long a run of readings covers, in the words somebody would use.
 *
 * ⚠️ Rounded DOWN and never flattering. This history begins when the app first
 * ran, so "6 hours" has to mean six hours — a block that said "30 days" over a
 * line an afternoon long would be the one number on it nobody could check. */
function spanOf(ms: number): string {
  if (!Number.isFinite(ms) || ms < 60_000) return "new";
  const hours = Math.floor(ms / 3600_000);
  if (hours < 1) return `${Math.floor(ms / 60_000)}m`;
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}D`;
}

/** The colours a wallet's slices take, in order. ⚠️ The app's own tones, so a
 *  theme that changes one changes the chart with it. */
const SLICE = ["accent", "cool", "warn", "good", "calm", "hot"] as const;

/** An asset amount, without a tail of zeros. ⚠️ Four places, not two: a
 *  holding of 0.0031 BTC is a real position and "0.00" is not. */
function trim(amount: number): string {
  if (!Number.isFinite(amount)) return "—";
  return amount >= 1000 ? Math.round(amount).toLocaleString()
    : amount.toFixed(amount >= 1 ? 2 : 4).replace(/\.?0+$/, "");
}

/* ── One coin ─────────────────────────────────────────────────────────────
 * ⚠️ The PRICE is the block. Everything else on it — the name, the change, the
 * line — is context for one number, so the number is the only thing at heading
 * size and the rest sits around it.
 *
 * ⚠️ Colour is the MESSAGE here, not decoration: up is `good`, down is `hot`,
 * and the block carries no tone of its own underneath them. A third colour
 * would be a block that is always saying something. */
const coinBody: WidgetBody = (wrap, deps, at) => {
  const coin = deps.crypto();
  if (!coin || !coin.symbol) {
    wrap.append(lead("Crypto"));
    /* ⚠️ Says what to DO, not that something is missing. "No reading" is a
     * fault report; the thing a blank block needs is the one sentence that
     * makes it not blank. */
    wrap.append(element("p", "w-line", "Name a symbol in Settings"));
    return;
  }

  const up = coin.changePct >= 0;
  wrap.dataset.way = up ? "up" : "down";
  if (at.variant === "bold") { coinBold(wrap, coin, at); return; }

  /* ── Who and when ───────────────────────────────────────────────────── */
  const head = element("div", "coin-head");
  const mark = coinMark(coin.name);
  const who = element("div", "coin-who");
  who.append(element("span", "coin-name", coin.name));
  /* ⚠️ The PAIR under the name, small. Which quote a price is in is the sort
   * of thing you check once and then never look at again — but you do have to
   * be able to check it, and "$" alone does not say USDT. */
  who.append(element("span", "coin-pair", `${coin.name}/${coin.quote}`));
  head.append(mark, who);
  head.append(element("span", "coin-span", "30D"));
  wrap.append(head);

  /* ── The number, and what the day did to it ──────────────────────────── */
  const price = coinPrice(coin.price);
  const figure$ = element("div", "coin-price");
  figure$.append(element("span", "coin-quote", quoteSign(coin.quote)));
  const whole = element("span", "coin-whole", price.whole);
  figure$.append(whole);
  const rest = element("span", "coin-rest", price.rest);
  if (price.rest) figure$.append(rest);

  const news = element("div", "coin-news");
  const chip = element("span", "coin-chip");
  /* ⚠️ ONE glyph, turned over for the other direction. The set has `down` and
   * no `up` — and an arrow that is literally the same shape rotated is also the
   * clearest possible pair, which is why nobody draws two. */
  chip.append(taskIcon("down"));
  chip.append(element("span", "", coinChange(coin.changePct)));
  /* The day in money as well as in percent. ⚠️ Both, because neither answers
   * the other's question: 2% of a coin you hold is a number you feel, and
   * $0.43 of a coin you are watching is not. */
  const moved = coin.price - coin.price / (1 + coin.changePct / 100);
  const money = coinPrice(Math.abs(moved));
  news.append(chip);
  news.append(element("span", "coin-moved",
    `${up ? "+" : "-"}${quoteSign(coin.quote)}${money.whole}${money.rest}`));

  const row = element("div", "coin-row");
  row.append(figure$, news);
  wrap.append(row);

  /* ── The month, and where your pointer is on it ──────────────────────── */
  if (at.variant === "plain" || coin.spark.length < 2 || (at.w < 2 && at.h < 2)) return;

  const NS = "http://www.w3.org/2000/svg";
  const box = element("div", "coin-spark");
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 100 30");
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("aria-hidden", "true");

  /* ⚠️ The AREA is a second path, closed to the floor — not the line with a
   * fill, which would close it across the chord between its ends and shade the
   * wrong half whenever the series finishes lower than it started. */
  const shape = sparkPath(coin.spark);
  const area = document.createElementNS(NS, "path");
  area.setAttribute("class", "coin-area");
  area.setAttribute("d", `${shape} L100 30 L0 30 Z`);
  const line = document.createElementNS(NS, "path");
  line.setAttribute("class", "coin-line");
  line.setAttribute("d", shape);
  /* ⚠️ `non-scaling-stroke`, because the box is stretched to the block: without
   * it a wide short block draws a hairline that thickens as the line climbs. */
  line.setAttribute("vector-effect", "non-scaling-stroke");
  svg.append(area, line);
  box.append(svg);

  /* The guide, the dot and the readout. ⚠️ Positioned ELEMENTS over the svg
   * rather than shapes inside it: the box is stretched, so a circle drawn in
   * those coordinates would be an ellipse — the same reason Daylight's sun
   * sits outside its own arc. */
  const guide = element("i", "coin-guide");
  const dot = element("i", "coin-dot");
  const peek = element("div", "coin-peek");
  box.append(guide, dot, peek);
  wrap.append(box);

  const points = coin.spark;
  const show = (at$: number) => {
    const spot = sparkPoint(points, at$);
    guide.style.left = `${spot.x}%`;
    dot.style.left = `${spot.x}%`;
    dot.style.top = `${(spot.y / 30) * 100}%`;
    const said = coinPrice(points[at$]);
    peek.textContent = `${quoteSign(coin.quote)}${said.whole}${said.rest}`;
    peek.style.left = `${spot.x}%`;
    /* ⚠️ The readout is CLAMPED to the box rather than centred on the dot at
     * the ends: at the first and last point half of it would hang outside the
     * block, and a widget that paints past its own edge is one the grid has to
     * clip. */
    const edge = at$ === 0 ? "start" : at$ === points.length - 1 ? "end" : "";
    peek.dataset.edge = edge;
    box.dataset.peek = "";
  };
  box.addEventListener("pointermove", event => {
    const rect = box.getBoundingClientRect();
    if (rect.width <= 0) return;
    show(sparkIndex(points.length, (event.clientX - rect.left) / rect.width));
  });
  box.addEventListener("pointerleave", () => { delete box.dataset.peek; });
};

/* ── The coin, full bleed ─────────────────────────────────────────────────
 * The chart IS the block, with the price laid over it and a scrub you drag —
 * where `line` is a price with a chart under it. Two different ideas of what a
 * coin block is for, so both are offered.
 */
function coinBold(wrap: HTMLElement, coin: CoinReading, at: BlockShape) {
  wrap.dataset.layout = "bold";
  const points = coin.spark;
  const sign = quoteSign(coin.quote);

  const head = element("div", "coin-b-head");
  head.append(coinMark(coin.name));
  const who = element("div", "coin-who");
  who.append(element("span", "coin-name", coin.name));
  who.append(element("span", "coin-pair", `${coin.name}/${coin.quote}`));
  head.append(who);
  const chip = element("span", "coin-chip");
  chip.append(taskIcon("down"));
  const pct = element("span", "", coinChange(coin.changePct));
  chip.append(pct);
  head.append(chip);
  wrap.append(head);

  const price = coinPrice(coin.price);
  const figure$ = element("div", "coin-price");
  figure$.append(element("span", "coin-quote", sign));
  const whole = element("span", "coin-whole", price.whole);
  const rest = element("span", "coin-rest", price.rest);
  figure$.append(whole, rest);
  /* ⚠️ The DATE sits under the price and is empty at rest. It is the one thing
   * scrubbing adds that the price cannot say by itself — "which day was that" —
   * and a block that printed "today" all the time would be spending a line on a
   * word nobody reads. */
  const when = element("div", "coin-b-when", "");
  wrap.append(figure$, when);

  if (points.length < 2) return;

  const NS = "http://www.w3.org/2000/svg";
  const box = element("div", "coin-b-chart");
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 100 30");
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("aria-hidden", "true");
  const shape = sparkPath(points);
  const area = document.createElementNS(NS, "path");
  area.setAttribute("class", "coin-area");
  area.setAttribute("d", `${shape} L100 30 L0 30 Z`);
  const line = document.createElementNS(NS, "path");
  line.setAttribute("class", "coin-line");
  line.setAttribute("d", shape);
  line.setAttribute("vector-effect", "non-scaling-stroke");
  svg.append(area, line);
  const guide = element("i", "coin-guide");
  const dot = element("i", "coin-dot");
  box.append(svg, guide, dot);
  wrap.append(box);

  /* ── Scrubbing ─────────────────────────────────────────────────────────
   * ⚠️ The HEAD changes, not a floating pill. A readout hovering over the line
   * is a second number on a block whose whole job is one number — and it covers
   * the very chart it is reading from. Dragging moves the price, the percentage
   * and the date, so the block answers "what was it worth, and what would that
   * have been" in the place you were already looking.
   *
   * ⚠️ The percentage is recomputed FROM THE SCRUBBED DAY to now, which is the
   * question somebody dragging is asking. Showing the fixed 24h figure while
   * the price moved under it would be two facts about two different days
   * presented as one. */
  const live = () => {
    whole.textContent = price.whole;
    rest.textContent = price.rest;
    pct.textContent = coinChange(coin.changePct);
    when.textContent = "";
    wrap.dataset.way = coin.changePct >= 0 ? "up" : "down";
    delete box.dataset.peek;
  };
  const show = (index: number) => {
    const value = points[index];
    const said = coinPrice(value);
    whole.textContent = said.whole;
    rest.textContent = said.rest;
    const since = value > 0 ? ((coin.price - value) / value) * 100 : 0;
    pct.textContent = coinChange(since);
    wrap.dataset.way = since >= 0 ? "up" : "down";
    const ago = points.length - 1 - index;
    when.textContent = ago === 0 ? "today" : ago === 1 ? "yesterday" : `${ago} days ago`;
    const spot = sparkPoint(points, index);
    guide.style.left = `${spot.x}%`;
    dot.style.left = `${spot.x}%`;
    dot.style.top = `${(spot.y / 30) * 100}%`;
    box.dataset.peek = "";
  };
  const at$ = (clientX: number) => {
    const rect = box.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    return sparkIndex(points.length, (clientX - rect.left) / rect.width);
  };
  box.addEventListener("pointermove", event => show(at$(event.clientX)));
  box.addEventListener("pointerleave", live);
  /* ⚠️ Capture on press, so a drag that leaves the block keeps scrubbing. A
   * chart you have to stay inside is one you fight at both ends, which is where
   * the interesting days are. */
  box.addEventListener("pointerdown", event => {
    box.setPointerCapture(event.pointerId);
    show(at$(event.clientX));
  });
  box.addEventListener("pointerup", event => {
    box.releasePointerCapture(event.pointerId);
    live();
  });
  if (at.h < 2) box.classList.add("is-short");
}

/** A coin's own mark.
 *
 * ⚠️ The REAL logo now, from a set, where this used to be seven glyphs drawn
 * by hand in this file. The note this replaced said shipping marks were a
 * licence question and a maintenance job that grows with the market, and both
 * halves of that turned out to be answerable: @web3icons/core is MIT, and a
 * generator pointed at it (`tools/generate-coin-marks.mjs`) is how it grows.
 * Seven coins drawn from memory covered seven coins; the generated set is the
 * top 250 by market cap plus a floor of majors and quote currencies, which is
 * the difference between a feature and a demo.
 *
 * ⚠️ An `<img>` to a FILE, not inline markup. A board paints between one and
 * six marks out of 200, so the webview fetches what is on screen and caches it
 * — where a bundled module would carry every one of them in `tasks.js` to
 * draw a 26px disc.
 *
 * ⚠️ The plate is the icon's OWN, and the ring around it is ours. Several of
 * these marks are black — ether's and XRP's both are — and on this board a
 * black disc on a dark panel is a hole rather than a coin.
 */
function coinMark(asset: string): HTMLElement {
  const url = coinMarkUrl(asset);
  if (!url) return coinMonogram(asset);
  const mark = element("span", "coin-mark is-real");
  const img = element("img");
  img.src = url;
  img.alt = "";
  /* ⚠️ `decoding` and no `loading`: these are on screen the moment the block
   * is, so deferring the fetch would cost a frame to save nothing. */
  img.decoding = "async";
  /* ⚠️ A mark that will not load falls back HERE rather than leaving an empty
   * disc. The generated set is the same list the files came from, so this
   * should never fire — but "should never" is how the blank square in the
   * corner of somebody's board gets there. */
  img.addEventListener("error", () => { mark.replaceWith(coinMonogram(asset)); }, { once: true });
  mark.append(img);
  return mark;
}

/** Three letters in a disc — what every exchange falls back to when it has no
 *  mark, and what this app does for a token the set has never heard of.
 *
 * ⚠️ Called DIRECTLY where the text is not a coin. The wallet's head says
 * "BAL" for balance, and `BAL` is Balancer — going through `coinMark` there
 * would put a real token's logo on somebody's total. */
function coinMonogram(text: string): HTMLElement {
  const mark = element("span", "coin-mark");
  mark.textContent = text.slice(0, 3);
  return mark;
}

/** What to put in front of the price. ⚠️ Only for the quotes that HAVE a sign
 *  — `BTC` and `ETH` are quotes too, and "₿67432" is not a thing anybody
 *  writes. Anything unknown gets nothing rather than a guess. */
function quoteSign(quote: string): string {
  switch (quote) {
    case "USDT": case "USDC": case "BUSD": case "TUSD": case "FDUSD": case "USD":
      return "$";
    case "EUR": return "€";
    case "GBP": return "£";
    case "JPY": return "¥";
    default: return "";
  }
}

/* ── The day, as a shape ──────────────────────────────────────────────────
 * Where the sun is between sunrise and sunset, or where the moon is between
 * sunset and sunrise, on an arc that is the sky.
 *
 * ⚠️ TWO arcs, not one. Daylight and darkness are different lengths and each
 * body crosses its own — a single fraction of the 24 hours would put the sun at
 * the top of its arc at noon only on the equinox, and nowhere near it in
 * December, which is the one time of year anybody looks at this.
 *
 * ⚠️ No API. Sunrise and sunset are already in the weather reading, and the
 * moon's phase is arithmetic — see `moonPhase`. A widget that needed a second
 * network call to draw a circle would be offline half the time.
 */
const skyBody: WidgetBody = (wrap, deps, at) => {
  const now = deps.weather();
  const when = new Date();
  const riseMin = clockMinutes(now?.sunrise);
  const setMin = clockMinutes(now?.sunset);
  const arc = dayArc(when.getHours() * 60 + when.getMinutes(), riseMin, setMin);
  const night = arc.part === "night";
  const phase = moonPhase(when);

  /* ⚠️ On the BLOCK, not on an inner div: the wash is the widget and it has to
   * reach the block's own rounded edges. `screen-board.ts` lifts it up for
   * exactly this — see `data-layout` on the media block. */
  wrap.dataset.part = arc.part;

  /* ── What it says ────────────────────────────────────────────────────
   * ⚠️ The part of day is the HEADLINE, at heading size, and the second line
   * is what is interesting about it — the moon's phase after dark, the sky
   * otherwise. The old version led with a small grey label and gave the whole
   * block to the arc, which is a picture with a caption rather than a thing
   * that tells you something. */
  const head = element("div", "home-sky-head");
  const said = element("div", "home-sky-said");
  said.append(element("div", "home-sky-part", PART_NAME[arc.part]));
  said.append(element("div", "home-sky-note",
    night ? moonName(phase) : now?.summary || PART_NOTE[arc.part]));
  head.append(said);
  /* The temperature, where a weather card puts it. ⚠️ Only when there is one:
   * this widget is about the sun, and a degree sign with nothing before it is
   * worse than no temperature at all. */
  if (typeof now?.celsius === "number") {
    head.append(element("div", "home-sky-temp", `${Math.round(now.celsius)}°`));
  }
  wrap.append(head);

  /* ── The arc ────────────────────────────────────────────────────────────
   * ⚠️ `preserveAspectRatio="none"`, so the curve is STRETCHED to the block
   * rather than cropped to it. `slice` was the obvious choice and it is wrong
   * here: a block three cells wide and one tall shows only the top third of a
   * uniformly scaled viewBox, so the sun was outside the frame for the whole
   * of the first and last hours of daylight — which is precisely when anybody
   * would look at this. Stretched, the arc always spans the block, and the ends
   * still run past both sides because the path does.
   *
   * ⚠️ Which means the BODY cannot live inside the svg: non-uniform scaling
   * would draw the sun as an ellipse. It is a positioned element over the top,
   * placed from the same path's own geometry. */
  const NS = "http://www.w3.org/2000/svg";
  const sky = element("div", "home-sky-arc");
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 100 60");
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("aria-hidden", "true");

  const PATH = "M -8 58 A 60 44 0 0 1 108 58";
  /* Two strokes on one path: a soft wide one that is the arc's own light, and
   * the line itself over it. ⚠️ Drawn the same after dark — the shape of the
   * sky does not change at night, and redrawing it differently would say that
   * it does. */
  for (const cls of ["home-sky-glow", "home-sky-line"]) {
    const line = document.createElementNS(NS, "path");
    line.setAttribute("class", cls);
    line.setAttribute("d", PATH);
    svg.append(line);
  }
  const line = svg.querySelector(".home-sky-line") as SVGPathElement;
  sky.append(svg);
  wrap.append(sky);

  /* Where along it. ⚠️ `getPointAtLength` on the very path that is drawn, so
   * the body sits ON the arc rather than on a sine curve that happens to look
   * like it — and the numbers come back in viewBox units, which map straight
   * to percentages of the block because the svg is stretched to fill it.
   *
   * ⚠️ Mapped onto the MIDDLE of the path rather than all of it. The ends run
   * off both sides on purpose — that is what makes it a horizon rather than a
   * diagram — so a body at 0 or 1 of its length is off the block. */
  const share = Math.max(0, Math.min(1, arc.share));
  const along = line.getTotalLength();
  /* ⚠️ The band of the path that is actually INSIDE the block, found by
   * SAMPLING rather than guessed at. The path runs from x -8 to 108 so that it
   * bleeds off both sides — which means a body at 0 or 1 of its length is off
   * the block entirely, and the sun simply vanished for the half hour either
   * side of sunrise and sunset. Guessing a fraction got it wrong twice: arc
   * length is not linear in angle, so "92% along" is 106 units across, not 96.
   * Sixty-four samples is nothing and it cannot be wrong. */
  let lo = -1;
  let hi = 1;
  for (let step = 0; step <= 64; step++) {
    const t = step / 64;
    const on = line.getPointAtLength(along * t);
    if (on.x < 8 || on.x > 92 || on.y < 6 || on.y > 52) continue;
    if (lo < 0) lo = t;
    hi = t;
  }
  if (lo < 0) { lo = 0; hi = 1; }
  const spot = line.getPointAtLength(along * (lo + share * (hi - lo)));
  const mark = element("div", `home-sky-body${night ? " is-moon" : ""}`);
  mark.style.left = `${spot.x}%`;
  mark.style.top = `${(spot.y / 60) * 100}%`;
  if (night) {
    /* The moon, with its terminator. ⚠️ Its own SQUARE viewBox, so the phase
     * is drawn round however the arc behind it has been stretched.
     *
     * ⚠️ Two arcs rather than a circle with a disc laid over it: the shadow has
     * to be TRANSPARENT so the sky shows through, and a disc painted in the
     * background colour is a hole that goes the wrong colour the moment the
     * wash behind it changes — which here it does four times a day. */
    const face = document.createElementNS(NS, "svg");
    face.setAttribute("viewBox", "-10 -10 20 20");
    face.setAttribute("aria-hidden", "true");
    const lit = document.createElementNS(NS, "path");
    lit.setAttribute("class", "home-sky-moon");
    lit.setAttribute("d", moonPath(8, phase));
    const rim = document.createElementNS(NS, "circle");
    for (const [k, v] of Object.entries({ cx: "0", cy: "0", r: "8", class: "home-sky-rim" })) {
      rim.setAttribute(k, v);
    }
    face.append(lit, rim);
    mark.append(face);
  }
  wrap.append(mark);

  /* ── The two times, on approach ────────────────────────────────────────
   * ⚠️ On HOVER. The arc and the headline are what this is for; the exact
   * minute the sun rose is what you look for once you have decided you care,
   * and printing it always is the third row of text on a block whose subject
   * is a picture. */
  if (now?.sunrise || now?.sunset) {
    const feet = element("div", "home-sky-feet");
    feet.append(skyFoot("sun", "Sunrise", now?.sunrise ?? "—"));
    feet.append(skyFoot("wxCloud", "Sunset", now?.sunset ?? "—"));
    wrap.append(feet);
  }
};

/** What is interesting about the part of day, when the sky has nothing to add.
 *  ⚠️ Only ever a fallback: a real summary from the reading beats a word this
 *  file guessed from the clock. */
const PART_NOTE: Record<DayPart, string> = {
  dawn: "First light", day: "The sun is up", dusk: "Golden hour", night: "After dark",
};

const PART_NAME: Record<DayPart, string> = {
  dawn: "Sunrise", day: "Daylight", dusk: "Sunset", night: "Night",
};

function skyFoot(icon: TaskIcon, said: string, when: string): HTMLElement {
  const one = element("div", "home-sky-foot");
  const mark = element("span", "home-sky-foot-mark");
  mark.append(taskIcon(icon));
  one.append(mark, element("span", "home-sky-foot-when", when));
  one.setAttribute("aria-label", `${said} ${when}`);
  return one;
}

/** The lit part of the moon, as one closed path centred on 0,0.
 *
 * ⚠️ A half circle plus a half ELLIPSE, whose width is the cosine of the
 * phase. That is the whole of it: at a quarter the ellipse is flat and the
 * shape is a half moon; past it the ellipse bulges the other way and the shape
 * is gibbous. Drawing a crescent as two overlapping circles is the usual
 * shortcut and it is wrong — the terminator is an ellipse, so a circle gives a
 * crescent with points that are too fat and a gibbous that bulges off centre. */
export function moonPath(r: number, phase: number): string {
  const turn = ((phase % 1) + 1) % 1;
  // 0 new, 0.5 full. The lit limb is on the right while waxing.
  const waxing = turn < 0.5;
  const k = Math.cos(2 * Math.PI * turn) * r;
  const outer = waxing ? 1 : 0;
  const inner = k > 0 === waxing ? 0 : 1;
  return `M 0 ${-r} A ${r} ${r} 0 0 ${outer} 0 ${r} `
    + `A ${Math.abs(k).toFixed(3)} ${r} 0 0 ${inner} 0 ${-r} Z`;
}

/* ── What moves once a second ─────────────────────────────────────────────
 * ⚠️ IN PLACE, never a rebuild — the rule the timer screen and the player both
 * follow. The shell's full render runs on the MINUTE, so a countdown on a board
 * sat on the same number for up to sixty seconds while the same run ticked on
 * the screen beside it; and rebuilding the board every second instead would
 * throw away a caret in Today's composer and restart every transition on it.
 *
 * ⚠️ Keyed on the body element and REPLACED by each render, so a block that has
 * been redrawn ticks its new elements and a block that has gone is collected
 * with its closure. */
const ticking = new WeakMap<HTMLElement, () => void>();

/** Move everything on this host that has a second hand. */
export function tickBodies(host: HTMLElement) {
  host.querySelectorAll<HTMLElement>(".home-body").forEach(body => ticking.get(body)?.());
}

/** One block per kind of run.
 *
 * ⚠️ A block is about its OWN KIND and stays about it. The one block this
 * replaced showed whichever run was liveliest, which meant a pomodoro started
 * on the screen quietly took over the timer you had been watching — and two of
 * them on one board showed the same run twice. Which run inside the kind is
 * still a choice, and it is the same one the screen's chip makes: whatever is
 * counting, then whatever is paused, then whatever exists.
 *
 * ⚠️ The RING comes from `run-ring.ts`, which the screen draws from too. The
 * widget had a ring of its own — one plain arc whatever the kind — so a
 * pomodoro on a board looked like a timer while the same pomodoro on the
 * screen was eight segments. */
function runBody(kind: RunKind): WidgetBody {
  return (wrap, deps, at) => {
    const lengths = deps.lengths();
    const run = pickRun(deps, kind);
    const live = run ? runGoing(run) : false;

    /* ⚠️ This lead EARNS its place: a countdown that says 12:41 and nothing
     * else does not say whether it is a focus block, a break or a timer
     * somebody set — which is the only thing you would look at it to find out.
     * On a pomodoro it is the phase and the round, which the figure cannot say
     * at all. */
    /* ⚠️ SHORT, and never the round. "Focus · round 1 of 4" is a sentence
     * over a circle that already draws four rounds with one of them lit — the
     * label was saying the same thing in more words, and it was the longest
     * thing on the block. What the circle cannot say is which PHASE you are in,
     * because the segments look the same either way. */
    wrap.append(lead(run
      ? (run.title || (kind === "pomodoro" && run.count
        ? phaseName(run.count)
        : runName(run)))
      : KIND_NAME[kind]));

    if (!run) {
      /* ⚠️ Nothing of this kind exists yet, so the block is one button that
       * makes one. A dead transport over 00:00 is three controls that do
       * nothing and no way to begin. */
      /* ⚠️ Short. The lead above already says which kind this block is, so
       * repeating it here spends the one line a 1×1 block has on a word that
       * is directly above it — and at that width it ellipsised anyway. */
      wrap.append(element("p", "w-line", "Not started"));
      wrap.append(timerKeys(deps, null, false, at, kind));
      return;
    }

    const left = Math.round(figureMs(run, lengths) / 1000);
    if (at.variant === "ring") {
      /* ⚠️ The ring and its controls sit SIDE BY SIDE only where there is room
       * for both. At one cell the block is about 130px and the ring alone is
       * most of them — laid across, the transport ran straight out of the
       * block and the whole widget read as broken. Narrow, it stacks. */
      /* ⚠️ The transport is INSIDE the circle and only on approach. Beside it
       * the buttons were as big as the ring and twice as loud — a block whose
       * most prominent thing was a control nobody presses while glancing at a
       * board. In the middle, over the figure, there is one object on the block
       * and it is the circle; the buttons are what the circle turns into when
       * you reach for it. */
      const face = element("div", "w-ring");
      const dial = element("div", `w-ring-face${live ? "" : " is-held"}`);
      const ring = buildRing(run, lengths);
      paintRing(ring, run, lengths, live);
      const said = element("span", "w-ring-said", timerText(left));
      const keys = timerKeys(deps, run, live, at, kind);
      keys.classList.add("w-ring-keys");
      dial.append(ring.el, said, keys);
      face.append(dial);
      wrap.append(face);
      /* ⚠️ The figure and the arc only. Anything whose SHAPE changes — the
       * word on the button, the phase in the lead — is left to the next render:
       * a tick that rebuilt those would be the rebuild this exists to avoid,
       * and `Runs.tick` already redraws the shell when a phase ends. */
      ticking.set(wrap, () => {
        const at$ = deps.runs.list.find(one => one.id === run.id);
        if (!at$) return;
        const going = runGoing(at$);
        said.textContent = timerText(Math.round(figureMs(at$, deps.lengths()) / 1000));
        dial.classList.toggle("is-held", !going);
        paintRing(ring, at$, deps.lengths(), going);
      });
      return;
    }

    let bar: HTMLElement | null = null;
    const figure$ = figure(timerText(left));
    figure$.classList.toggle("is-held", !live);
    wrap.append(figure$);
    /* How far through, as a line under the time. ⚠️ A bar rather than a ring:
     * this face is wider than it is tall, and a ring big enough to read would
     * be most of its height — which is what the `ring` variant is for.
     * ⚠️ A stopwatch gets none: it has no target, so a bar creeping across
     * would be claiming a finish line it does not have. */
    if (kind !== "stopwatch") {
      const track = element("div", "home-track");
      bar = element("i");
      bar.style.width = `${Math.max(0, Math.min(1, runThrough(run, lengths))) * 100}%`;
      track.append(bar);
      wrap.append(track);
    }
    ticking.set(wrap, () => {
      const at$ = deps.runs.list.find(one => one.id === run.id);
      if (!at$) return;
      const going = runGoing(at$);
      const big = figure$.querySelector(".w-figure-big");
      if (big) big.textContent = timerText(Math.round(figureMs(at$, deps.lengths()) / 1000));
      figure$.classList.toggle("is-held", !going);
      if (bar) bar.style.width = `${Math.max(0, Math.min(1, runThrough(at$, deps.lengths()))) * 100}%`;
    });
    wrap.append(timerKeys(deps, run, live, at, kind));
  };
}

/** What a kind is called where there is nothing to name. ⚠️ Not `runName`,
 *  which answers for a RUN and falls back to the same words — this is asked
 *  when there is no run at all. */
const KIND_NAME: Record<RunKind, string> = {
  pomodoro: "Pomodoro", timer: "Timer", stopwatch: "Stopwatch",
};

/** Which run of a kind a block is about.
 *
 * ⚠️ Counting first, then paused, then anything of that kind at all. A block
 * that showed whichever was made last would change what it is about without
 * being touched. */
function pickRun(deps: WidgetDeps, kind: RunKind): Run | null {
  const mine = deps.runs.list.filter(one => one.kind === kind);
  return mine.find(runGoing)
    ?? mine.find(one => one.count || counted(one) > 0)
    ?? mine[0] ?? null;
}

/** The transport, whatever face is drawn above it. */
function timerKeys(
  deps: WidgetDeps, run: Run | null, live: boolean, at: BlockShape, kind: RunKind,
): HTMLElement {
  const controls = element("div", "home-controls");
  if (!run) {
    controls.append(key("play", `Start a ${KIND_NAME[kind].toLowerCase()}`, () => {
      const made = deps.runs.add(kind);
      deps.runs.toggle(made.id);
      deps.changed();
    }, "is-main"));
    return controls;
  }
  controls.append(
    key(live ? "pause" : "play", live ? "Pause" : "Start",
      () => { deps.runs.toggle(run.id); deps.changed(); }, "is-main"),
  );
  /* ⚠️ ONE key at a single cell. Three of them are 89px in a block about 72px
   * wide, and the row used to answer that by wrapping into a column — which is
   * not a smaller transport, it is a broken one. The press everybody makes is
   * start and pause; the other two are on the screen. */
  if (at.w < 2) return controls;
  /* ⚠️ Skip only where there is something to skip TO. A stopwatch has no next
   * phase and a timer has one phase; offering it on either is a button that
   * does nothing, which is worse than one that is not there. */
  if (run.kind === "pomodoro") {
    controls.append(key("next", "Skip to the next phase",
      () => { deps.runs.skip(run.id); deps.changed(); }));
  }
  controls.append(key("close", "Reset",
    () => { deps.runs.reset(run.id); deps.changed(); }));
  return controls;
}

/* ⚠️ The DIAL is gone from the widget. Setting a timer needs a ruler you can
 * read, a place to type a name and somewhere to put the result — which is a
 * screen, and the screen has one. A board block that could set a timer but not
 * see the list it went into was a second, worse copy of the same control.
 */

/* ── The weather ────────────────────────────────────────────────────────────
 * ⚠️ The one widget with NO controls, and that is the honest answer rather
 * than a gap: there is nothing to do to the weather. It earns its place by
 * being the thing you would otherwise open a browser tab for.
 *
 * ⚠️ It reads the same module the pill does, so the place is the one set in
 * Settings and there is no second request, no second cache and no second
 * answer to disagree with.
 *
 * Three variants, and the SIZE decides how much of each one fits: `now` is the
 * temperature and the sky, `forecast` is the hours or the days, and `both` is
 * as much of each as the block can hold. */
const weatherBody: WidgetBody = (wrap, deps, at) => {
  const now = deps.weather();
  if (!now?.place) {
    wrap.append(lead("Weather", "wxCloud"));
    quiet(wrap, "No place set", "Name one in Settings.");
    return;
  }
  /* ⚠️ The block is tinted by the SKY and by the time of day, not just by its
   * tone. A clear noon and an overcast midnight are the two things this widget
   * is ever about, and a card that looks identical for both has thrown away
   * the one fact you can read without reading. */
  wrap.dataset.sky = now.icon;
  wrap.dataset.when = now.isDay === false ? "night" : "day";

  wrap.append(lead(now.place, (now.icon in ICONS_KNOWN ? now.icon : "wxCloud") as TaskIcon));

  const hours = now.hours ?? [];
  const days = now.days ?? [];
  /* ⚠️ The decision is in `weatherParts`, which is pure and tested. What is
   * left here is appending elements, which is the part a screenshot can check
   * and a test cannot. */
  /* ── The hours as a chart ──────────────────────────────────────────────
   * ⚠️ A SHAPE, not six numbers. The temperature is the height and the colour
   * of a bar, so "warming up until four and then cold" is one glance rather
   * than six readings compared in your head — which is the whole difference
   * between a chart and a table.
   *
   * ⚠️ Falls back to the ordinary head where there are no hours to draw. A
   * variant that can come up empty is a variant somebody picked once and never
   * went back to. */
  if (at.variant === "graph" && hours.length > 1 && at.w >= 2) {
    wrap.append(weatherHead(now, deps, at));
    wrap.append(hourGraph(hours.slice(0, Math.max(6, Math.min(12, at.w * 3))), deps));
    return;
  }

  const parts = weatherParts(at.variant === "graph" ? "now" : at.variant, at.w, at.h,
    { hours: hours.length > 0, days: days.length > 1 });

  if (parts.head) wrap.append(weatherHead(now, deps, at));
  if (parts.hours) {
    wrap.append(hourStrip(hours, Math.max(3, Math.min(6, at.w * 2)), deps));
  }
  if (parts.days) {
    /* ⚠️ From index 1: day zero is today, and today's high and low are already
     * beside the summary. A list that opens with the day you are standing in
     * is a list whose first row says nothing new.
     *
     * ⚠️ How MANY depends on what else is in the block, not only on its height.
     * Asked for on its own a single row holds four days comfortably; with the
     * head above it there is room for two, and at two rows for everything the
     * forecast has. Showing three in a block sized for four is the empty space
     * this had at the bottom. */
    const most = at.h >= 2 ? 5 : (parts.head || parts.hours ? 2 : 4);
    wrap.append(dayList(days.slice(1, most + 1), deps));
  }
};

/** The next few hours, as bars.
 *
 * ⚠️ Every bar is a HEIGHT and a COLOUR saying the same thing, on purpose. The
 * height is the comparison — this hour against the others — and the colour is
 * the absolute, so a flat afternoon at 30° and a flat one at 4° do not draw the
 * identical picture. Colour alone would also be a chart nobody colour-blind can
 * read; height alone is a chart with no scale. */
function hourGraph(hours: NonNullable<WeatherReading["hours"]>, deps: WidgetDeps): HTMLElement {
  const box = element("div", "wx-graph");
  const values = hours.map(one => one.celsius);
  const low = Math.min(...values);
  const high = Math.max(...values);
  const span = Math.max(1, high - low);

  for (const [at, one] of hours.entries()) {
    const col = element("div", "wx-bar");
    const { tone, weight } = tempTone(one.celsius);
    col.style.setProperty("--bar", `var(--${tone})`);
    col.style.setProperty("--bar-weight", `${Math.round(weight * 100)}%`);
    /* ⚠️ A floor under the height. The coldest hour of a flat day would
     * otherwise be a bar of zero — which reads as no reading rather than as the
     * bottom of a narrow range. */
    const share = 0.22 + ((one.celsius - low) / span) * 0.78;
    const fill = element("i");
    fill.style.height = `${Math.round(share * 100)}%`;
    col.append(fill);
    col.append(element("span", "wx-bar-deg", `${degrees(one.celsius, deps)}°`));
    /* ⚠️ Not every hour gets a label. Twelve of them at 10px is a grey band
     * under the chart; every third is a scale. */
    col.append(element("span", "wx-bar-at", at % 3 === 0 ? one.at : ""));
    if (at === 0) col.classList.add("is-now");
    box.append(col);
  }
  return box;
}

/** Place, temperature, sky and today's range. */
function weatherHead(now: WeatherReading, deps: WidgetDeps, at: BlockShape): HTMLElement {
  const row = element("div", "home-wx-row");
  const left = element("div", "home-wx-left");
  left.append(figure(`${degrees(now.celsius, deps)}°`));
  /* ⚠️ The high and low go with the SUMMARY, not under the temperature. They
   * are the same kind of fact as "Overcast" — what today is like — where the
   * figure is what it is like right now. */
  const said = element("div", "home-wx-said-col");
  said.append(element("span", "home-wx-say", now.summary));
  if (now.high != null && now.low != null) {
    said.append(element("span", "home-wx-range",
      `H:${degrees(now.high, deps)}° L:${degrees(now.low, deps)}°`));
  } else if (now.sunset && at.w >= 2) {
    // ⚠️ Only where there is room: it is the third-best thing to say here.
    said.append(element("span", "home-wx-range", `Sunset ${now.sunset}`));
  }
  left.append(said);

  const mark = element("div", "home-wx-mark");
  paintIcon(mark, (now.icon in ICONS_KNOWN ? now.icon : "wxCloud") as TaskIcon);
  row.append(left, mark);
  return row;
}

/** The next few hours, as a strip. */
function hourStrip(
  hours: NonNullable<WeatherReading["hours"]>, most: number, deps: WidgetDeps,
): HTMLElement {
  const strip = element("div", "home-wx-hours");
  for (const hour of hours.slice(0, most)) {
    const cell = element("div", "home-wx-hour");
    cell.append(element("span", "home-wx-at", hour.at));
    const mark = element("span", "home-wx-tiny");
    paintIcon(mark, (hour.icon in ICONS_KNOWN ? hour.icon : "wxCloud") as TaskIcon);
    cell.append(mark, element("span", "home-wx-deg", `${degrees(hour.celsius, deps)}°`));
    strip.append(cell);
  }
  return strip;
}

/** The next few days, each with a bar for its range.
 *
 * ⚠️ The bar is scaled across ALL the days shown, not per row. A row-relative
 * bar would make every day look like the same amount of weather — which is the
 * opposite of what a week of temperatures is for. */
function dayList(
  days: NonNullable<WeatherReading["days"]>, deps: WidgetDeps,
): HTMLElement {
  const list = element("div", "home-wx-days");
  if (!days.length) return list;
  const floor = Math.min(...days.map(one => one.low));
  const ceiling = Math.max(...days.map(one => one.high));
  const span = Math.max(1, ceiling - floor);
  for (const day of days) {
    const row = element("div", "home-wx-day");
    row.append(element("span", "home-wx-dow", dayName(day.date)));
    const mark = element("span", "home-wx-tiny");
    paintIcon(mark, (day.icon in ICONS_KNOWN ? day.icon : "wxCloud") as TaskIcon);
    row.append(mark, element("span", "home-wx-lo", `${degrees(day.low, deps)}°`));
    const rail = element("div", "home-wx-rail");
    const bar = element("i");
    bar.style.marginLeft = `${((day.low - floor) / span) * 100}%`;
    bar.style.width = `${((day.high - day.low) / span) * 100}%`;
    rail.append(bar);
    row.append(rail, element("span", "home-wx-hi", `${degrees(day.high, deps)}°`));
    list.append(row);
  }
  return list;
}

/** `Tue`, in whatever language the machine is set to.
 *
 * ⚠️ Parsed as a LOCAL date, not with `new Date(iso)` — a bare `YYYY-MM-DD`
 * is read as UTC midnight, which west of Greenwich is the evening before and
 * names the wrong day. */
function dayName(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  if (!year || !month || !day) return "";
  return new Date(year, month - 1, day)
    .toLocaleDateString(undefined, { weekday: "short" });
}

/** Celsius, or what the preference asks for. */
function degrees(celsius: number, deps: WidgetDeps): number {
  return deps.fahrenheit() ? Math.round(celsius * 9 / 5 + 32) : Math.round(celsius);
}

/* ── Agents ─────────────────────────────────────────────────────────────────
 * How many are running, and what the one that wants you is doing.
 *
 * ⚠️ WAITING outranks working, which outranks the count. A session that has
 * asked you a question is the only state on this block that needs a person,
 * and burying it under "3 running" is how it gets missed. */
const agentsBody: WidgetBody = (wrap, deps) => {
  const all = deps.agents();
  if (!all.length) {
    wrap.append(lead("Agents", "agent"));
    quiet(wrap, "None running", "Sessions show up here as they start.");
    return;
  }
  const waiting = all.filter(one => one.state === "waiting");
  const working = all.filter(one => one.state === "working");
  const lead$ = waiting[0] ?? working[0] ?? all[0];

  const face = figure(String(waiting.length || working.length || all.length),
    waiting.length ? "waiting" : working.length ? "working" : "idle");
  face.classList.toggle("is-warn", waiting.length > 0);
  wrap.append(face);

  const row = element("div", "home-agent-row");
  const mark = element("span", "home-agent-mark");
  mark.append(taskIcon(lead$.provider === "codex" ? "codex" : "claude"));
  row.append(mark, element("span", "home-agent-name", lead$.project || "Session"));
  wrap.append(row);
  /* What it is doing, if it said. ⚠️ Only Codex reports this; Claude's has to
   * be inferred, and an inferred sentence on a block this size is a guess
   * printed as a fact. */
  if (lead$.doing) wrap.append(element("p", "w-line", lead$.doing));
  else wrap.append(element("p", "w-line", `${all.length} session${all.length === 1 ? "" : "s"} open`));
};

/* ── Notes ──────────────────────────────────────────────────────────────────
 * The last thing you wrote down. ⚠️ The LAST one, not a list: three previews
 * at this size are three lines of six words each, which is a list of things
 * you cannot read rather than a note you can. */
const notesBody: WidgetBody = (wrap, deps) => {
  const all = deps.notes();
  if (!all.length) {
    wrap.append(lead("Notes", "note"));
    quiet(wrap, "Nothing written yet", "Press to start one.");
    return;
  }
  const newest = [...all].sort((a, b) => (b.edited ?? b.written) - (a.edited ?? a.written))[0];
  const card = element("div", "home-note");
  const band = element("span", "home-note-band");
  band.style.setProperty("--note", tintOf(newest));
  card.append(band);
  const copy = element("div", "home-note-copy");
  copy.append(element("span", "home-note-title", noteTitle(newest.body, 44)));
  copy.append(element("span", "home-note-body", notePreview(newest.body, 110)));
  card.append(copy);
  wrap.append(card);
  wrap.append(element("p", "w-line",
    `${all.length} note${all.length === 1 ? "" : "s"}`));
};

/* ── The shelf ──────────────────────────────────────────────────────────────
 * What you put down last, and how much is on it. */
const shelfBody: WidgetBody = (wrap, deps) => {
  const all = deps.shelf();
  if (!all.length) {
    wrap.append(lead("Shelf", "shelf"));
    quiet(wrap, "Nothing shelved", "Drop a file on the island.");
    return;
  }
  const newest = [...all].sort((a, b) => b.addedMs - a.addedMs)[0];
  wrap.append(figure(String(all.length), all.length === 1 ? "item" : "items"));
  const row = element("div", "home-shelf-row");
  const mark = element("span", "home-shelf-mark");
  paintIcon(mark, newest.kind === "link" ? "link" : newest.kind === "text" ? "note" : "file");
  row.append(mark, element("span", "home-shelf-name", newest.name));
  wrap.append(row);
};

/* ── The machine ────────────────────────────────────────────────────────────
 * ⚠️ Three readings, not one. The pill picks whichever is worth speaking up
 * about and says only that; a block has room for all three, and the useful
 * thing about them is how they compare. */
const systemBody: WidgetBody = (wrap, deps) => {
  const now = deps.machine();
  if (!now || now.cpu < 0) {
    wrap.append(lead("Machine", "system"));
    quiet(wrap, "Not read yet", "The first reading is a moment away.");
    return;
  }
  const disk = now.diskUsed >= 0 ? now.diskUsed : 0;
  const rows: [string, number][] = [
    ["Processor", now.cpu], ["Memory", now.memory], ["Disk", disk],
  ];
  const worst = Math.max(...rows.map(([, value]) => value));
  const face = figure(`${Math.round(worst)}`, "%");
  /* ⚠️ Lit only when something is actually high. A figure that is always the
   * alarm colour is a figure nobody reads twice. */
  face.classList.toggle("is-warn", worst >= 90);
  wrap.append(face);

  const list = element("div", "home-sys-rows");
  for (const [name, value] of rows) {
    const row = element("div", "home-sys-row");
    row.append(element("span", "home-sys-name", name));
    const track = element("div", "home-track");
    const fill = element("i");
    fill.style.width = `${Math.max(0, Math.min(100, value))}%`;
    if (value >= 90) track.classList.add("is-warn");
    track.append(fill);
    row.append(track, element("span", "home-sys-value", `${Math.round(value)}%`));
    list.append(row);
  }
  wrap.append(list);
};

/** The weather glyphs `weather.rs` may name.
 *
 * ⚠️ Listed, not trusted. These strings cross the IPC boundary as DATA, so
 * a value that is not here draws a cloud rather than falling through the icon
 * lookup to whatever the dispatcher's default happens to be. */
const ICONS_KNOWN: Record<string, true> = {
  wxClear: true, wxPartly: true, wxCloud: true, wxFog: true, wxDrizzle: true,
  wxRain: true, wxHeavyRain: true, wxSnow: true, wxStorm: true,
};

/** One body per widget.
 *
 * ⚠️ Typed as EVERY kind, so a widget added to `WIDGETS` without a body here
 * fails to compile. That is the whole reason the two files can be two files. */
export const BODIES: Record<WidgetKind, WidgetBody> = {
  media: mediaBody,
  calendar: calendarBody,
  today: todayBody,
  clock: clockBody,
  pomodoro: runBody("pomodoro"),
  timer: runBody("timer"),
  stopwatch: runBody("stopwatch"),
  daylight: skyBody,
  crypto: coinBody,
  wallet: walletBody,
  weather: weatherBody,
  agents: agentsBody,
  notes: notesBody,
  shelf: shelfBody,
  system: systemBody,
};
