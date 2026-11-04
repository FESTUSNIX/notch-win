/* The agenda, from Google Calendar.
 *
 * Read-only and deliberately short: a week ahead, grouped by day, with the
 * next thing given a countdown. The island's job is "what is about to happen
 * to me", not calendar management.
 */
import { listen } from "@tauri-apps/api/event";
import { element } from "./dom";
import { paintIcon, taskIcon, type TaskIcon } from "./task-icons";
import { call, native, previewBus } from "./task-client";
import { isQuiet } from "./snooze";
import { isoWeek, localDay, weekStart } from "./task-model";
import { still } from "./motion-pref";
import { atHour, hoursWithin, layoutLanes, pointOver, rememberBlocks, wireMonthDrag, wireTaskDrag, wireWeekEditing, type Placed } from "./calendar-edit";
import type { Task } from "./task-model";
import { buildAxis, busyHours, quietHours, QUIET_BEFORE } from "./calendar-axis.ts";
import {
  WORK_END, WORK_START, atMinutes, blockStart, calEventFrom, freeOn, helmNeedsGoogle, linesThatFit, markerLabel, monthCells, monthLines, newEventCalendar, parseClock, railItems, shortLength,
  type HelmBlock, type HelmCalendar, type HelmMarker, type HelmPlanItem, type MinuteSpan, type MonthEntry, type MonthFold,
} from "./calendar-helm";
import { hueOf, zloty } from "./helm-link";
import { cpx } from "./layout";
import type { Activity } from "./island-activity";

export interface CalEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  location: string;
  meetingUrl: string;
  calendar: string;
  /** The calendar's id, which is what a write is addressed to. */
  calendarId: string;
  color: string;
  /** Whether this app may move or delete it — see `Event::writable` in Rust.
   *  A subscribed calendar (holidays, a shared diary) answers a write with a
   *  403, so the grid refuses the drag rather than letting it snap back. */
  writable: boolean;
  response: string;
  /** From Helm, which is who a change to it goes through. */
  viaHelm?: boolean;
  /** Google's own id, when `id` is Helm's `<calendar>:<event>`. */
  googleId?: string;
  /** Where it opens in Google, when Helm knows. */
  url?: string;
  note?: string;
}

export interface CalendarFeed {
  connected: boolean;
  events: CalEvent[];
  updatedAt: string | null;
  error: string | null;
  /** Google stopped accepting the saved sign-in; the client is still saved. */
  needsSignIn?: boolean;
}

export const emptyCalendar = (): CalendarFeed => ({ connected: false, events: [], updatedAt: null, error: null });

/** All-day events carry `YYYY-MM-DD`, timed ones RFC 3339. `new Date()` reads a
 *  bare date as UTC midnight, which lands on the previous day west of Greenwich
 *  — so the date form is parsed as local by hand. */
export function startOf(event: CalEvent): Date {
  if (event.allDay) {
    const [y, m, d] = event.start.split("-").map(Number);
    return new Date(y, (m || 1) - 1, d || 1);
  }
  return new Date(event.start);
}

export function endOf(event: CalEvent): Date {
  if (!event.end) return startOf(event);
  if (event.allDay) {
    const [y, m, d] = event.end.split("-").map(Number);
    // Google's all-day end date is exclusive.
    return new Date(y, (m || 1) - 1, (d || 1));
  }
  return new Date(event.end);
}

/** `Today, 09:30` — the day and the start, for a panel that may be showing an
 *  event three days out. */
export function whenLabel(event: CalEvent, today = localDay()): string {
  const day = event.allDay ? event.start.slice(0, 10) : localDay(startOf(event));
  const heading = dayHeading(day, today);
  return event.allDay ? heading : `${heading} · ${timeLabel(event)}`;
}

/** `09:30 – 10:15 · 45 min`. ⚠️ The duration spelled out: two clock times
 *  are a subtraction, and the question is almost always how long it takes. */
export function spanLabel(event: CalEvent): string {
  if (event.allDay) return "All day";
  const from = startOf(event);
  const to = endOf(event);
  const mins = Math.max(0, Math.round((to.getTime() - from.getTime()) / 60000));
  const clock = (when: Date) =>
    when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  return `${clock(from)} – ${clock(to)} · ${lengthLabel(mins)}`;
}

function lengthLabel(mins: number): string {
  return mins >= 60 ? `${Math.floor(mins / 60)}h${mins % 60 ? ` ${mins % 60}m` : ""}` : `${mins} min`;
}

/** An hour with a fraction as `HH:MM`, midnight at the end of the day included. */
function hhmm(hour: number): string {
  const whole = Math.floor(hour) % 24;
  return `${String(whole).padStart(2, "0")}:${String(Math.round((hour - Math.floor(hour)) * 60)).padStart(2, "0")}`;
}

export function timeLabel(event: CalEvent): string {
  if (event.allDay) return "All day";
  const start = startOf(event);
  return start.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
}

/** "in 5 min", "in 2 h", "now" — the only thing the pill has room to say. */
export function countdown(from: Date, to: Date): string {
  const minutes = Math.round((to.getTime() - from.getTime()) / 60000);
  if (minutes <= 0) return "now";
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `in ${hours} h`;
  return `in ${Math.round(hours / 24)} d`;
}

export function dayHeading(day: string, today = localDay()): string {
  if (day === today) return "Today";
  const [y, m, d] = day.split("-").map(Number);
  const date = new Date(y, (m || 1) - 1, d || 1);
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (day === localDay(tomorrow)) return "Tomorrow";
  return date.toLocaleDateString([], { weekday: "long", day: "numeric", month: "short" });
}

/** The next thing that has not finished yet, declined events excluded — a
 *  meeting you said no to is not what is about to happen to you. */
export function nextEvent(events: CalEvent[], now = new Date()): CalEvent | null {
  return events
    .filter(e => e.response !== "declined" && !e.allDay && endOf(e) > now)
    .sort((a, b) => startOf(a).getTime() - startOf(b).getTime())[0] || null;
}

/** ⚠️ No standalone `agenda` any more — the month view IS the agenda, with a
 *  grid beside it saying which days are worth scrolling to. Two views that
 *  differ only in whether there is a grid is one view and a toggle. */
export type CalendarView = "month" | "week" | "day" | "agenda";

/** How tall an hour the week grid actually shows is.
 *
 * ⚠️ Taller than the old 22, and not for looks. At 22 a quarter-hour block is
 * five pixels — there is nothing there to grab, and the 7px resize grip would
 * cover the whole of it. 40 gives a half-hour meeting 20px, which is a target.
 *
 * ⚠️ Nothing in CSS needs to match this any more. The axis is piecewise, so
 * every hour, line and block is positioned in pixels the code worked out —
 * where the old grid split a percentage between CSS and TypeScript and the two
 * had to be kept in step by hand. */
const WEEK_HOUR_PX = 40;

/** How tall a COLLAPSED hour is.
 *
 * ⚠️ Small, because a run of seven of them is the whole point — the night has
 * to come to a strip rather than to a slab. `buildAxis` grows a SHORT run back
 * up to a clickable band, so this can be as thin as it needs to be without
 * leaving a lone collapsed hour unhittable.
 *
 * ⚠️ Not zero: a band still has to read as "there is time here that is folded
 * away" rather than as a gap where the grid stops. */
const SHUT_HOUR_PX = 6;

/** The shortest a block may be drawn. ⚠️ A floor on the pixels, not on the
 *  maths: a fifteen-minute stand-up is 10px of a 40px hour, with no room for a
 *  title and nothing to press. */
const MIN_BLOCK_PX = 22;

/* ── How wide this screen asks the island to be ──────────────────────────
 * ⚠️ These four live HERE, together, because they are one set: the island's
 * body is the week plus the screen's padding, and with the list open it is
 * that plus the panel and its gap. `tasks.ts` imports them for its width
 * table rather than keeping its own copy, which is how they got out of step
 * the first time.
 */

/** The island's body in DESIGN px with the list shut. */
export const CALENDAR_WEEK_DPX = 2083;
/** ...and with it open. ⚠️ `islandBodyMax` exactly — the hard ceiling, and
 *  there is no more to ask for. A cap above it is silently the same as the cap
 *  at it, which from a test looks exactly like the width not changing. */
export const CALENDAR_WEEK_TASKS_DPX = 2480;
/** The task panel, in CSS px, and the gap before it. */
export const TASK_PANEL_W = 180;
export const TASK_PANEL_GAP = 10;

/** How long a task is when it lands on the grid, in hours.
 *
 * ⚠️ Half an hour, and it is a guess this app has to make: a task has no
 * duration in TickTick, only a moment. The alternative is asking, and a dialog
 * in the middle of a drag is worse than a length somebody can change by
 * dragging the block's edge — which is the gesture they are already using. */
const DROP_SPAN = 0.5;

/** The screen body's own padding, one side. ⚠️ Must match `--screen-pad` in
 *  tasks.css — the week's width is measured off the island's body, and the
 *  padding is the part of it the content never gets. */
const SCREEN_PAD = 15;

/** Where the grid opens, the first time. ⚠️ Not 00:00 — the quiet hours are
 *  collapsed, so the top of the axis is the middle of the night folded into a
 *  band, and starting there means scrolling past it every time. */
const START_AT_HOUR = 8;

/** How far the pager goes: what Rust's feed holds (`collect` in calendar.rs). */
const FEED_AHEAD_DAYS = 45;
const FEED_BACK_DAYS = 30;

/** How often the calendar is read from Helm, and how old a reading may be on opening it.
 *  Each read asks Google for every calendar, so not every minute like the cockpit. */
const HELM_POLL_MS = 180_000;
const HELM_FRESH_MS = 45_000;

/** Helm refuses a focus block over three hours. */
const BLOCK_MAX_HOURS = 3;

/** How tall the month's days are altogether, so five or six weeks fill the same room. */
const MONTH_GRID_PX = 396;

/** Lines on a day's all-day row before the rest go behind a press: it sits over the hours. */
const BAND_LINES = 3;

/** What a block on the grid stands for.
 *
 * ⚠️ A UNION, because the week now carries two completely unrelated things
 * that look alike on it: a Google event and a TickTick task. The gesture layer
 * passes one of these back untouched — it never looks inside — so the only
 * place that has to know the difference is the hook that writes the change.
 */
type GridRef = { kind: "event"; event: CalEvent } | { kind: "task"; task: Task } | { kind: "block"; block: HelmBlock };

export class CalendarScreen {
  feed: CalendarFeed = emptyCalendar();
  error = "";
  /** Month and week are the two he reads most; the agenda answers "what is next". */
  view: CalendarView = "week";
  /** Whether the week runs Monday to Sunday. ⚠️ A preference, pushed in by
   *  the shell rather than read here: `prefs` lives in tasks.ts, and a screen
   *  that fetched its own would need the event listener as well. */
  /** An event being drawn, before it has a name.
   *
   * ⚠️ Held on the SCREEN rather than as a loose element, so the five-minute
   * poll landing mid-compose redraws the composer instead of throwing away
   * what somebody was in the middle of typing. */
  private draft: { day: string; start: number; end: number; kind: "event" | "block" } | null = null;

  /** New events on their way to Google, drawn until the feed that answers them. */
  private creating: { key: number; title: string; day: string; start: number; end: number; kind?: "event" | "block" }[] = [];
  private creatingKey = 0;

  /** Title and location edits Google hasn't confirmed, laid over the feed like `settling`. */
  private patched = new Map<string, { title?: string; location?: string }>();

  /** Which day the week or day view is on; "" is today. */
  private anchorDay = "";

  /** A press is live on the grid: a redraw would take the elements from under it. */
  private holding = false;
  /** A redraw was asked for while one couldn't happen. */
  private owed = false;

  /** Writes Google has not confirmed yet, laid over the feed at render time.
   *
   * ⚠️ Optimistic, because a write is a round trip PLUS a full re-read, and a
   * block that sits still for a second after being dropped reads as a drag
   * that did not take. Cleared wholesale when a feed arrives — that feed is
   * the answer to the write, and an entry outliving it would pin a block to a
   * time the server has already disagreed with. */
  private settling = new Map<string, { start: string; end: string }>();

  /** What went wrong with the last gesture, if anything. */
  private actionError = "";

  /** Deleted here, not yet gone from Google. ⚠️ Separate from `settling`
   *  because it is a different shape of lie: one says "this is somewhere
   *  else", the other says "this is not there at all". */
  private removing = new Set<string>();

  /** Whether the task list is beside the grid.
   *
   * ⚠️ The ONE thing on this screen still behind a button. The grid itself is
   * always editable now — a week view with an hour axis is a thing you point
   * at, and putting that behind a toggle meant the answer to "why can I not
   * move this" was a control somebody had to know about. The list is
   * different: it makes the island a third wider, which is a cost worth
   * paying only while you are actually planning. */
  tasksOpen = false;

  /** Which runs of quiet hours the user has opened: "early", "late".
   *
   * ⚠️ Held here rather than persisted. Opening the small hours is something
   * somebody does to look at one thing, and a grid that remembered it a week
   * later would be a grid that had quietly got taller with no explanation. */
  private opened = new Set<string>();

  /** Where the week grid is scrolled to, in px.
   *
   * ⚠️ The whole reason the mode was unusable. The shell redraws the screen on
   * any of a dozen events — a media tick, a poll, a machine reading — and each
   * redraw builds a fresh scroller, which starts at the top. Without this the
   * grid snapped back to midnight every few seconds whatever anybody was
   * doing. */
  private scrollAt = 0;

  /** Whether the host's scroll listener is on. ⚠️ The host element survives
   *  every render — only its children are replaced — so the listener must be
   *  attached once rather than per draw. */
  private watchingScroll = false;

  private mondayFirst = true;

  setWeekStart(mondayFirst: boolean) {
    if (this.mondayFirst === mondayFirst) return;
    this.mondayFirst = mondayFirst;
    this.changed();
  }

  /** ⚠️ The calendar does not create tasks itself. Today owns the optimistic
   *  layer, the outbox and the list the composer files into; a second creation
   *  path here would be a task that appears on one screen and not the other
   *  until TickTick answers. */
  constructor(
    private host: HTMLElement,
    private changed: () => void,
    private deps: {
      create: (title: string, day: string, list: string) => void;
      /** The lists a task can go into, and which one Today is filing to. */
      lists: () => { id: string; name: string; chosen: boolean }[];
      /* ── The task side ──────────────────────────────────────────────────
       * ⚠️ Read THROUGH Today, never from a second snapshot of its own. Today
       * owns the optimistic layer — the settle window, the completion that is
       * held on screen for a moment before it leaves — and a calendar holding
       * its own copy would show a task Today had already ticked. The same
       * reason the composer files through `create` rather than calling
       * `create_task` itself. */
      tasks: () => Task[];
      taskColor: (task: Task) => string;
      finishTask: (task: Task) => void;
      /** Re-apply the island's width cap.
       *
       * ⚠️ Called whenever something on this screen changes how wide it wants
       * to be. `render()` measures but does not re-cap, so without this the
       * list opens into a body that never grew and is clipped by it. */
      width: () => void;
      /** ⚠️ Lift `WS_EX_NOACTIVATE`, or a field here cannot be typed into.
       *  The island never takes focus — that is the whole point of it — so a
       *  `focus()` on its own puts the caret in the DOM and leaves the
       *  keystrokes going to whatever application is actually in front. It is
       *  the same round trip Today's composer makes; see `set_task_input`. */
      focus: (active: boolean) => Promise<void>;
      /** Keep the island up while a drag runs, wherever the pointer goes. */
      hold: (on: boolean) => void;
    } = {
      create: () => {}, lists: () => [], focus: async () => {},
      tasks: () => [], taskColor: () => "", finishTask: () => {}, width: () => {}, hold: () => {},
    },
  ) {}

  async boot() {
    /* ⚠️ EVERY optimistic change drops here, not just one that matches. A write
     * triggers a full re-read, so this feed is the answer to it. */
    const arrived = (feed: CalendarFeed) => {
      this.own = feed;
      // With Helm as the source, the app's own Google poll is only the fallback.
      if (this.viaHelm) return;
      this.feed = feed;
      this.settled();
      this.changed();
    };
    if (native) await listen<CalendarFeed>("calendar:changed", e => arrived(e.payload));
    else previewBus.addEventListener("calendar:changed", event => arrived((event as CustomEvent<CalendarFeed>).detail));
    try {
      this.own = await call<CalendarFeed>("get_calendar");
      if (!this.viaHelm) this.feed = this.own;
    } catch { /* not connected */ }
    this.changed();
    void this.readHelm();
    setInterval(() => void this.readHelm(), HELM_POLL_MS);
  }

  /* ── Helm, when connected ──────────────────────────────────────────────
   * The calendar's source: blocks, markers and prep notes live there, and so does
   * the one Google login. Without Helm, or while Helm has lost Google, the app's
   * own connection carries on. */
  private own: CalendarFeed = emptyCalendar();
  private helm: HelmCalendar | null = null;
  /** The latest read: a write bumps it, so a read already under way can't undo it on screen. */
  private helmTurn = 0;
  private helmReadAt = 0;
  /** Items dropped on the grid, off the rail until the reading that answers them. */
  private planning = new Set<string>();
  /** Meetings whose prep note Claude is writing. */
  private prepping = new Set<string>();
  private watchingGoogle = 0;
  private quickBusy = false;
  private quickSaid = "";

  private get viaHelm(): boolean {
    return this.helm?.status === "ok";
  }

  private settled() {
    this.settling.clear();
    this.removing.clear();
    this.patched.clear();
    this.creating = [];
    this.planning.clear();
  }

  /** Back on the calendar: what it shows may be a few minutes behind. */
  cameBack() {
    if (Date.now() - this.helmReadAt > HELM_FRESH_MS) void this.readHelm();
  }

  private async readHelm() {
    const turn = ++this.helmTurn;
    /* The weeks around today and around wherever the grid has been paged to. */
    const day = 86_400_000;
    const today = Date.now();
    const anchor = this.anchorDay ? atHour(this.anchorDay, 0).getTime() : today;
    const from = localDay(new Date(Math.min(today, anchor) - 35 * day));
    const to = localDay(new Date(Math.max(today, anchor) + 77 * day));
    let reading: HelmCalendar | null | undefined;
    try {
      reading = await call<HelmCalendar | null>("helm_calendar", { from, to });
    } catch {
      return; // Unreachable for now: the last reading stands.
    }
    if (turn !== this.helmTurn) return;
    this.helmReadAt = Date.now();
    this.helm = reading ?? null;
    if (this.viaHelm) {
      const shown = this.helm!;
      this.feed = {
        connected: true,
        events: shown.events.map(one => calEventFrom(one, shown)),
        updatedAt: new Date().toISOString(),
        error: null,
      };
    } else {
      this.feed = this.own;
    }
    this.settled();
    if (this.viaHelm && this.watchingGoogle) { clearInterval(this.watchingGoogle); this.watchingGoogle = 0; this.waitingForGoogle = false; }
    this.changed();
  }

  /** One write through Helm, read back after; `undo` puts the screen right if it's refused. */
  private act(action: Record<string, unknown>, undo: () => void = () => {}): Promise<{ ok?: boolean } & Record<string, unknown>> {
    this.helmTurn++;
    return call<{ ok?: boolean } & Record<string, unknown>>("helm_calendar_act", { action }).then(answer => {
      void this.readHelm();
      return answer ?? {};
    }).catch(problem => {
      undo();
      this.actionError = String(problem);
      this.changed();
      return { ok: false };
    });
  }

  /** Helm lost Google: signing in happens there, in the browser, and the grid watches for it. */
  private signInToHelm() {
    this.waitingForGoogle = true;
    this.actionError = "";
    void call("helm_open", { path: "/api/google/connect" }).catch(problem => {
      this.waitingForGoogle = false;
      this.actionError = String(problem);
      this.changed();
    });
    clearInterval(this.watchingGoogle);
    const until = Date.now() + 3 * 60_000;
    this.watchingGoogle = window.setInterval(() => {
      if (Date.now() > until) {
        clearInterval(this.watchingGoogle);
        this.watchingGoogle = 0;
        this.waitingForGoogle = false;
        this.changed();
        return;
      }
      void this.readHelm();
    }, 5000);
    this.changed();
  }

  /** How long before it starts this is worth the whole strip. ⚠️ Fifteen,
   *  not thirty: the strip has ONE slot and a claim holds it outright, so
   *  thirty minutes of "Design review in 24m" is half an hour of a notch that
   *  can say nothing else. From fifteen to three hours out the pill's own
   *  `event` MODULE covers it, and that one takes its turn in a rotation
   *  instead of owning the strip. */
  static readonly IMMINENT = 15;

  activity(): Activity | null {
    const next = nextEvent(this.feed.events);
    if (!next) return null;
    const now = new Date();
    const minutes = (startOf(next).getTime() - now.getTime()) / 60000;

    /* ⚠️ Gone once it has STARTED. `nextEvent` keeps an event until it ENDS
     * — correctly, because the calendar screen still wants to show the one you
     * are in — so this claimed all the way through the meeting, counting
     * DOWN past zero. A reminder for something that began twenty minutes ago
     * is not a reminder, and if it is a real meeting the call detector is
     * already saying so at a priority this could never reach. */
    if (minutes < 0) return null;
    if (minutes > CalendarScreen.IMMINENT) return null;
    /* ⚠️ And gone when you have said so. Until this there was no way at all
     * to dismiss it: the strip is not clickable while hovering opens the
     * panel, so the one thing on the island that could not be answered was
     * the one thing with a deadline. */
    if (isQuiet(`event:${next.id}`)) return null;

    return {
      /* Five minutes out it outranks everything — it is the only claim with a
       * deadline attached. Before that it sits under a focus session and under
       * music, because it is information rather than something happening. */
      priority: minutes <= 5 ? 50 : 25,
      screen: "calendar",
      kind: "event",
      icon: "calendar",
      label: next.title,
      value: countdown(now, startOf(next)),
      accent: next.color || undefined,
    };
  }

  /** The event that is claiming the strip, if one is — so the palette can
   *  offer to quieten exactly that one. */
  claiming(): CalEvent | null {
    const next = nextEvent(this.feed.events);
    if (!next) return null;
    const minutes = (startOf(next).getTime() - Date.now()) / 60000;
    return minutes >= 0 && minutes <= CalendarScreen.IMMINENT ? next : null;
  }

  /** Which sign-in is the latest, so one abandoned in the browser can't speak over it. */
  private signingIn = 0;
  private waitingForGoogle = false;

  /** Over the calendar, whose last good events stay on screen below it. */
  private signInBar(): HTMLElement {
    const bar = element("div", "cal-signin");
    const mark = element("span", "cal-signin-mark");
    paintIcon(mark, "calendar");
    const go = element("button", "day-connect", this.waitingForGoogle ? "Open Google again" : "Sign in again") as HTMLButtonElement;
    go.type = "button";
    const helm = helmNeedsGoogle(this.helm);
    go.onclick = () => { if (helm) this.signInToHelm(); else void this.signIn(); };
    bar.append(mark, element("span", "cal-signin-text", this.waitingForGoogle ? "Waiting for Google in your browser"
      : helm ? "Google signed Helm's calendar out" : "Google signed the calendar out"), go);
    return bar;
  }

  private async signIn() {
    const attempt = ++this.signingIn;
    this.waitingForGoogle = true;
    this.actionError = "";
    this.changed();
    try {
      await call("reconnect_google");
      if (attempt !== this.signingIn) return;
      this.waitingForGoogle = false;
    } catch (problem) {
      if (attempt !== this.signingIn) return;
      this.waitingForGoogle = false;
      this.actionError = String(problem);
    }
    this.changed();
  }

  /** The event whose panel is open, by id. */
  private chosen: string | null = null;

  /** Sent here about one event: its panel opens. One this calendar doesn't have
   *  (Helm knew it first, or it has gone) just leaves the list showing. */
  choose(id: string) {
    // Helm writes `<calendar>:<event>`; here it's the event alone (as `prepCovers`).
    const found = this.feed.events.find(event => id === event.id || id.endsWith(`:${event.id}`) || event.id.endsWith(`:${id}`));
    if (!found) return;
    this.chosen = found.id;
    // In the week or day view, go to where it is.
    if (this.view !== "agenda") this.anchorDay = found.allDay ? found.start.slice(0, 10) : localDay(startOf(found));
  }

  /** Escape: the open thing on this screen closes first, and the island after. */
  escape(): boolean {
    if (this.draft) { this.cancelDraft(); return true; }
    if (this.chosen) { this.chosen = null; this.changed(); return true; }
    return false;
  }

  /** An event with whatever hasn't been confirmed laid over it. */
  private edited(event: CalEvent): CalEvent {
    const times = this.settling.get(event.id);
    const words = this.patched.get(event.id);
    return times || words ? { ...event, ...times, ...words } : event;
  }

  /** The redraw after a write from a field: not until focus has landed, so tabbing
   *  to the next field isn't undone by the one just left. */
  private soon() {
    setTimeout(() => this.changed(), 0);
  }

  /** One editable line of the panel: Enter keeps it, Escape puts it back. */
  private panelField(sheet: HTMLElement, value: string, label: string, className: string, type: string, save: (next: string) => boolean | void): HTMLInputElement {
    const field = document.createElement("input");
    field.type = type;
    field.className = `cal-panel-field ${className}`;
    field.value = value;
    field.maxLength = 300;
    field.setAttribute("aria-label", label);
    let kept = value;
    field.onfocus = () => { void this.deps.focus(true).catch(() => {}); };
    field.onkeydown = key => {
      if (key.key === "Enter") { key.preventDefault(); field.blur(); }
      if (key.key === "Escape") {
        key.preventDefault();
        key.stopPropagation();
        field.value = kept;
        field.blur();
      }
    };
    field.onblur = blur => {
      if (!sheet.contains(blur.relatedTarget as Node | null)) void this.deps.focus(false).catch(() => {});
      const next = field.value.trim();
      if (next !== kept) {
        if (save(next) === false) field.value = kept; else kept = next;
      }
      this.soon();
    };
    return field;
  }

  /** The panel's element, kept while nothing about it has changed: a redraw then
   *  leaves a half-pressed button, and an animation that has played, alone. */
  private sheet: HTMLElement | null = null;
  private sheetKey = "";
  private sheetFor = "";

  private panelFor(id: string): HTMLElement | null {
    if (id.startsWith("day:")) {
      const day = id.slice(4);
      const key = JSON.stringify(["day", day, this.lineSignature(day)]);
      if (!this.sheet || this.sheetKey !== key) {
        this.sheet = this.dayPanel(day);
        this.sheetKey = key;
      }
      this.sheet.classList.toggle("is-entering", this.sheetFor !== id);
      this.sheetFor = id;
      return this.sheet;
    }
    const block = this.blockOf(id);
    const event = block ? null : this.feed.events.find(one => one.id === id);
    if (!block && !event) return null;
    const shown = event ? this.edited(event) : null;
    const key = JSON.stringify(block
      ? [block, this.settling.get(id), this.view]
      : [shown, this.view, this.helm?.meetings[id], this.helm?.preps[id], this.prepping.has(id)]);
    if (!this.sheet || this.sheetKey !== key) {
      this.sheet = block ? this.blockPanel(block) : this.panel(shown!);
      this.sheetKey = key;
    }
    this.sheet.classList.toggle("is-entering", this.sheetFor !== id);
    this.sheetFor = id;
    return this.sheet;
  }

  private blockOf(id: string): HelmBlock | null {
    if (!id.startsWith("block:")) return null;
    return this.helm?.blocks.find(one => `block:${one.id}` === id) ?? null;
  }

  /** A focus block: its name and time in place, and what can be done about it. */
  private blockPanel(block: HelmBlock): HTMLElement {
    const id = `block:${block.id}`;
    const mark = this.helm?.marks.find(one => one.id === block.projectId);
    const times = this.settling.get(id);
    const startMin = blockStart(block) ?? 0;
    const from = times ? new Date(times.start) : atMinutes(block.day, startMin);
    const to = times ? new Date(times.end) : atMinutes(block.day, startMin + block.minutes);
    const span = hoursWithin(from, to);
    const day = localDay(from);

    const sheet = element("div", "cal-panel");
    sheet.style.setProperty("--cal", hueOf(mark?.hue, mark?.name ?? block.title));
    const head = element("div", "cal-panel-head");
    head.append(element("span", "cal-panel-when", dayHeading(day)));
    const close = element("button", "cal-panel-close small-icon");
    (close as HTMLButtonElement).type = "button";
    close.setAttribute("aria-label", "Close block");
    paintIcon(close, "close");
    close.onclick = () => { this.chosen = null; this.changed(); };
    head.append(close);
    sheet.append(head);

    const open = block.status !== "done" && block.status !== "skipped";
    if (open) {
      sheet.append(this.panelField(sheet, block.title, "Block name", "cal-panel-name", "text", next => {
        if (!next) return false;
        const before = block.title;
        block.title = next;
        void this.act({ action: "renameBlock", blockId: block.id, title: next }, () => { block.title = before; });
      }));
    } else {
      sheet.append(element("h4", "cal-panel-title", block.title));
    }

    const facts = element("div", "cal-panel-facts");
    const fact = (icon: TaskIcon, text: string) => {
      const row = element("div", "cal-fact");
      const dot = element("span", "cal-fact-mark");
      paintIcon(dot, icon);
      row.append(dot, element("span", "", text));
      facts.append(row);
    };
    if (open && block.status !== "running") {
      const row = element("div", "cal-fact cal-fact-times");
      const dot = element("span", "cal-fact-mark");
      paintIcon(dot, "clock");
      const begins = this.panelField(sheet, hhmm(span.start), "Starts at", "cal-panel-time", "text", next => {
        const hour = parseClock(next);
        if (hour === null) return false;
        const end = Math.min(24, hour + (span.end - span.start));
        this.commitBlock(block, atHour(day, hour), atHour(day, end));
      });
      const ends = this.panelField(sheet, hhmm(span.end), "Ends at", "cal-panel-time", "text", next => {
        const hour = parseClock(next);
        if (hour === null || hour <= span.start || hour - span.start > BLOCK_MAX_HOURS) return false;
        this.commitBlock(block, atHour(day, span.start), atHour(day, hour));
      });
      row.append(dot, begins, element("span", "cal-fact-to", "–"), ends,
        element("span", "cal-fact-length", lengthLabel(Math.round((span.end - span.start) * 60))));
      facts.append(row);
    } else {
      fact("clock", `${hhmm(span.start)} – ${hhmm(span.end)}`);
    }
    if (mark) fact("target", mark.name);
    if (block.elapsedSeconds >= 60) fact("history", `${shortLength(Math.round(block.elapsedSeconds / 60))} logged`);
    if (facts.childElementCount) sheet.append(facts);

    const actions = element("div", "cal-panel-actions");
    if ((block.status === "planned" || block.status === "paused") && day === localDay()) {
      const start = element("button", "cal-panel-join");
      (start as HTMLButtonElement).type = "button";
      paintIcon(start, "target");
      start.append(element("span", "", block.status === "paused" ? "Resume" : "Start"));
      start.onclick = () => {
        void call("helm_act", { action: { do: "start", block: block.id } })
          .then(() => this.readHelm())
          .catch(problem => { this.actionError = String(problem); this.changed(); });
      };
      actions.append(start);
    }
    if (block.status === "planned") {
      const back = element("button", "cal-panel-open");
      (back as HTMLButtonElement).type = "button";
      back.append(element("span", "", "Back to To plan"));
      back.onclick = () => {
        this.chosen = null;
        this.removing.add(id);
        this.changed();
        void this.act({ action: "unscheduleBlock", blockId: block.id, day }, () => this.removing.delete(id));
      };
      actions.append(back);
    }
    if (open && block.status !== "running") {
      const drop = element("button", "cal-panel-drop");
      (drop as HTMLButtonElement).type = "button";
      paintIcon(drop, "close");
      drop.append(element("span", "", "Delete"));
      drop.onclick = () => {
        this.chosen = null;
        this.removing.add(id);
        this.changed();
        void this.act({ action: "deleteBlock", blockId: block.id }, () => this.removing.delete(id));
      };
      actions.append(drop);
    }
    if (actions.childElementCount) sheet.append(actions);
    return sheet;
  }

  /** In the week or day view the panel sits beside its event, in the grid, so the
   *  week stays visible and it scrolls along. */
  private placeBeside(sheet: HTMLElement, id: string) {
    const body = this.host.querySelector<HTMLElement>(".cal-wkbody, .cal-mgrid");
    if (!body) { this.host.append(sheet); return; }
    sheet.classList.add("is-beside");
    body.append(sheet);
    const name = CSS.escape(id);
    const anchor = body.querySelector<HTMLElement>(`.cal-block[data-cal-id="${name}"], .cal-mchip[data-cal-id="${name}"]`)
      ?? this.host.querySelector<HTMLElement>(`.cal-chip[data-chip-id="${name}"]`)
      ?? (id.startsWith("day:") ? this.host.querySelector<HTMLElement>(`[data-day="${CSS.escape(id.slice(4))}"]`) : null);
    const home = body.getBoundingClientRect();
    const view = this.host.getBoundingClientRect();
    const stuck = this.host.querySelector(".cal-wkstick")?.getBoundingClientRect().bottom ?? view.top;
    sheet.style.maxHeight = `${Math.max(180, view.bottom - stuck - 12)}px`;
    const width = sheet.offsetWidth;
    const height = sheet.offsetHeight;
    const low = stuck - home.top + 4;
    const high = Math.max(low, view.bottom - home.top - height - 8);
    if (!anchor) {
      sheet.style.left = `${Math.max(0, home.width - width)}px`;
      sheet.style.top = `${low}px`;
      return;
    }
    const spot = anchor.getBoundingClientRect();
    const right = spot.right - home.left + 6;
    const left = spot.left - home.left - width - 6;
    sheet.style.left = `${right + width <= home.width ? right : left >= 0 ? left : Math.max(0, home.width - width)}px`;
    sheet.style.top = `${Math.min(high, Math.max(low, spot.top - home.top))}px`;
  }

  /** Everything about one event, over the list rather than inside it.
   *
   * ⚠️ A PANEL, not an expanding row. The detail is four or five lines — time,
   * duration, calendar, location, a join button — and growing a row by that
   * much pushes every event under it down the screen, so the thing you were
   * looking at moves while you read it. Over the list, nothing moves.
   */
  private panel(event: CalEvent): HTMLElement {
    const sheet = element("div", "cal-panel");
    sheet.style.setProperty("--cal", event.color || "var(--cool)");

    const head = element("div", "cal-panel-head");
    head.append(element("span", "cal-panel-when", whenLabel(event)));
    const close = element("button", "cal-panel-close small-icon");
    (close as HTMLButtonElement).type = "button";
    close.setAttribute("aria-label", "Close event");
    paintIcon(close, "close");
    close.onclick = () => { this.chosen = null; this.changed(); };
    head.append(close);
    sheet.append(head);
    if (event.writable) {
      sheet.append(this.panelField(sheet, event.title, "Event name", "cal-panel-name", "text", next => {
        if (!next) return false;
        this.commitEdit(event, { title: next });
      }));
    } else {
      sheet.append(element("h4", "cal-panel-title", event.title));
    }

    const facts = element("div", "cal-panel-facts");
    const fact = (icon: TaskIcon, text: string) => {
      const row = element("div", "cal-fact");
      const mark = element("span", "cal-fact-mark");
      paintIcon(mark, icon);
      row.append(mark, element("span", "", text));
      facts.append(row);
    };
    if (!event.allDay) {
      const from = startOf(event);
      const to = endOf(event);
      const span = hoursWithin(from, to);
      if (event.writable && !span.crosses) {
        const day = localDay(from);
        const row = element("div", "cal-fact cal-fact-times");
        const mark = element("span", "cal-fact-mark");
        paintIcon(mark, "clock");
        const begins = this.panelField(sheet, hhmm(span.start), "Starts at", "cal-panel-time", "text", next => {
          const hour = parseClock(next);
          if (hour === null) return false;
          // A new start moves the event; its length stays.
          const length = span.end - span.start;
          const end = Math.min(24, hour + length);
          this.commitMove(event, atHour(day, hour), atHour(day, end));
        });
        const ends = this.panelField(sheet, hhmm(span.end), "Ends at", "cal-panel-time", "text", next => {
          const typed = parseClock(next);
          if (typed === null) return false;
          const hour = typed === 0 ? 24 : typed;
          if (hour <= span.start) return false;
          this.commitMove(event, atHour(day, span.start), atHour(day, hour));
        });
        row.append(mark, begins, element("span", "cal-fact-to", "–"), ends,
          element("span", "cal-fact-length", lengthLabel(Math.round((to.getTime() - from.getTime()) / 60000))));
        facts.append(row);
      } else {
        fact("clock", spanLabel(event));
      }
    }
    if (event.calendar) fact("calendar", event.calendar);
    if (event.writable) {
      const row = element("div", "cal-fact");
      const mark = element("span", "cal-fact-mark");
      paintIcon(mark, "system");
      const place = this.panelField(sheet, event.location, "Location", "cal-panel-place", "text", next => {
        this.commitEdit(event, { location: next });
      });
      place.placeholder = "Add a location";
      row.append(mark, place);
      facts.append(row);
    } else if (event.location) {
      fact("system", event.location);
    }
    if (event.response === "declined") fact("close", "You declined this");
    const match = this.helm?.meetings[event.id];
    if (match) fact("you", match.name);
    if (match?.logged) fact("history", `${shortLength(match.logged.minutes)} logged on ${match.logged.projectName}`);
    if (facts.childElementCount) sheet.append(facts);

    const prep = this.helm?.preps[event.id];
    if (prep) sheet.append(this.prepNote(prep));

    const actions = element("div", "cal-panel-actions");
    if (event.meetingUrl) {
      const join = element("button", "cal-panel-join");
      (join as HTMLButtonElement).type = "button";
      paintIcon(join, "join");
      join.append(element("span", "", "Join"));
      join.onclick = () => this.open(event.meetingUrl);
      actions.append(join);
    }
    /* ⚠️ Only in work mode, and only where Google would accept it. A Delete
     * that is always on the panel is one press away from removing a meeting
     * somebody is reading the details of. */
    if (this.view !== "agenda" && event.writable && !event.allDay) {
      const drop = element("button", "cal-panel-drop");
      (drop as HTMLButtonElement).type = "button";
      paintIcon(drop, "close");
      drop.append(element("span", "", "Delete"));
      drop.onclick = () => this.commitDelete(event);
      actions.append(drop);
    }
    const eventDay = event.allDay ? event.start.slice(0, 10) : localDay(startOf(event));
    if (match && !prep && !event.allDay && eventDay >= localDay()) {
      const write = element("button", "cal-panel-open") as HTMLButtonElement;
      write.type = "button";
      const busy = this.prepping.has(event.id);
      write.disabled = busy;
      write.append(element("span", "", busy ? "Writing the prep note…" : "Prep note"));
      write.onclick = () => {
        this.prepping.add(event.id);
        this.changed();
        void this.act({ action: "prep", eventId: event.id, day: eventDay }).finally(() => {
          this.prepping.delete(event.id);
          this.changed();
        });
      };
      actions.append(write);
    }
    /* Its time, once it has started, on the client's first project. */
    const project = match?.projects[0];
    if (match && !match.logged && project && !event.allDay && startOf(event).getTime() <= Date.now()) {
      const minutes = Math.round((endOf(event).getTime() - startOf(event).getTime()) / 60000);
      const log = element("button", "cal-panel-open") as HTMLButtonElement;
      log.type = "button";
      log.append(element("span", "", `Log ${shortLength(minutes)} on ${project.name}`));
      log.onclick = () => { void this.act({ action: "logMeeting", eventId: event.id, day: eventDay }); };
      actions.append(log);
    }
    const inGoogle = element("button", "cal-panel-open");
    (inGoogle as HTMLButtonElement).type = "button";
    inGoogle.append(element("span", "", "Open in Google Calendar"));
    inGoogle.onclick = () => this.open(event.url || "https://calendar.google.com/calendar/r/day/"
      + eventDay.replace(/-/g, "/"));
    actions.append(inGoogle);
    sheet.append(actions);
    return sheet;
  }

  /** Claude's note for a meeting: where things stand, what to raise, what to ask. */
  private prepNote(prep: { headline: string; status: string[]; cover: string[]; ask: string[]; watch: string[] }): HTMLElement {
    const note = element("div", "cal-prep");
    note.append(element("p", "cal-prep-head", prep.headline));
    for (const [title, lines] of [["Where it stands", prep.status], ["Raise", prep.cover], ["Ask", prep.ask], ["Careful", prep.watch]] as const) {
      if (!lines.length) continue;
      note.append(element("b", "cal-prep-title", title));
      const list = element("ul", "cal-prep-list");
      for (const line of lines) list.append(element("li", "", line));
      note.append(list);
    }
    return note;
  }

  private open(url: string) {
    // The island never navigates itself: it is a transparent, non-activating
    // window and a meeting link belongs in the browser.
    void call("open_external", { url }).catch(e => { this.error = String(e); this.changed(); });
  }

  /** What this screen can do, in the tab under the island.
   *
   * ⚠️ Both of these were reachable only by knowing they existed — a refresh
   * that happened on a five-minute timer and nothing else, and a link into
   * Google that was buried inside an event's panel. */
  tools() {
    return {
      tools: [
        { icon: "list" as const,
          label: this.tasksOpen ? "Hide To plan" : "Show To plan",
          /* ⚠️ Turning the list on switches to the week. There is nowhere to
           * drop a task on a month grid, so a list beside one would be a
           * drag that can only ever fail. */
          run: () => {
            this.tasksOpen = !this.tasksOpen;
            if (this.tasksOpen && (this.view === "month" || this.view === "agenda")) this.view = "week";
            this.deps.width();
            this.changed();
          } },
        { icon: "clock" as const, label: "Refresh the calendar",
          run: () => { void this.readHelm(); if (!this.viaHelm) void call("refresh_calendar").catch(() => {}); } },
        { icon: "open" as const, label: "Open Google Calendar",
          run: () => this.open("https://calendar.google.com/calendar/r") },
      ],
    };
  }

  /** Turn work mode on or off.
   *
   * ⚠️ Leaving it CLEARS the draft. A half-typed event left behind would come
   * back the next time somebody opened the mode, hours later, with no memory
   * of having started it — and the block it is holding would be sitting on a
   * week that has since moved on. */
  /** ⚠️ There is no longer a "work mode". Editing IS the week view: a grid
   *  with an hour axis is a grid you can point at, and putting that behind a
   *  toggle meant the answer to "why can I not move this" was a button
   *  somebody had to know about. The month view stays a reader because a
   *  month cell has no time axis — there is nowhere for a drag to land. */
  private leaveWeek() {
    this.draft = null;
    this.actionError = "";
    /* ⚠️ The list goes with it. A month grid has nowhere to drop a task, so a
     * list left open beside one is a panel whose only affordance cannot work —
     * and the tool would be offering to "hide" something not on screen. */
    this.tasksOpen = false;
  }

  /** Today's tasks that have no time yet, ready to be dropped on one.
   *
   * ⚠️ Only the ones WITHOUT a time. A task already on the grid is on the
   * grid; listing it here as well would be the same task in two places, and
   * dragging the copy would look like scheduling a second one. */
  private taskList(waiting: Task[]): HTMLElement {
    const box = element("aside", "cal-tasks");
    /* ⚠️ Hidden from the accessibility tree AND from tabbing while shut. The
     * panel is still in the DOM at full width behind a zero-width column —
     * that is what makes the reveal an animation — and without this a screen
     * reader would read a list that is not on screen, and Tab would land in
     * it. */
    box.inert = !this.tasksOpen;
    /* ⚠️ The INNER box is the one with a width. The animating thing is the
     * grid track outside it; this stays 180px so nothing in it re-wraps while
     * the column travels. See `.media-queue-in`. */
    const panel = element("div", "cal-tasks-in");
    /* The inner box keeps its full width whatever the track is doing. */
    panel.style.width = `${TASK_PANEL_W}px`;
    box.append(panel);
    const toPlan = this.viaHelm ? railItems(this.helm!.items).filter(item => !this.planning.has(item.key)) : [];
    if (this.viaHelm) {
      const head = element("div", "cal-tasks-head");
      head.append(element("span", "cal-tasks-title", "To plan"), element("span", "cal-tasks-count", String(toPlan.length)));
      panel.append(head);
      if (toPlan.length) {
        const list = element("div", "cal-tasks-list cal-plan-list");
        for (const item of toPlan) {
          const row = element("div", "cal-task cal-plan");
          row.dataset.planRow = item.key;
          row.style.setProperty("--cal", hueOf(item.hue, item.context ?? item.title));
          const text = element("span", "cal-plan-text");
          text.append(element("span", "cal-task-title", item.title));
          if (item.context) text.append(element("span", "cal-plan-for", item.context));
          row.append(element("span", "cal-plan-dot"), text, element("span", "cal-plan-long", shortLength(item.minutes)));
          row.dataset.tip = `${item.title} — drag onto the grid`;
          list.append(row);
        }
        panel.append(list);
      } else {
        panel.append(element("p", "cal-tasks-none", "Everything is planned."));
      }
    }
    const head = element("div", "cal-tasks-head");
    head.append(element("span", "cal-tasks-title", "Today"));
    head.append(element("span", "cal-tasks-count", String(waiting.length)));
    panel.append(head);

    if (!waiting.length) {
      /* ⚠️ Says what it means rather than "No tasks". An empty list here is
       * either a day with nothing on it or a day already planned, and those
       * are opposite things to be told. */
      panel.append(element("p", "cal-tasks-none",
        this.deps.tasks().length ? "Everything today has a time." : "Nothing due today."));
    } else {
      const list = element("div", "cal-tasks-list");
      for (const task of waiting) {
        const row = element("div", "cal-task");
        row.dataset.taskRow = task.id;
        row.style.setProperty("--cal", this.deps.taskColor(task) || "var(--good)");
        const tick = element("button", "cal-tick");
        (tick as HTMLButtonElement).type = "button";
        tick.dataset.noDrag = "";
        tick.setAttribute("aria-label", `Mark "${task.title}" done`);
        tick.onclick = () => this.deps.finishTask(task);
        row.append(tick, element("span", "cal-task-title", task.title));
        row.dataset.tip = `${task.title} — drag onto the week`;
        list.append(row);
      }
      panel.append(list);
      /* ⚠️ Says how to use it, once, under the list. Dragging between two
       * regions of a panel is not a thing anybody guesses at. */
      panel.append(element("p", "cal-tasks-hint", "Drag onto the week to schedule"));
    }

    /* ── Adding one ────────────────────────────────────────────────────────
     * ⚠️ Files through `deps.create`, which is Today's optimistic layer — the
     * same door the month view's composer uses. A second creation path would
     * be a task that appears on one screen and not the other until TickTick
     * answers, which is the note on the constructor.
     *
     * ⚠️ Dated TODAY rather than left undated. This list is the day's work;
     * something typed into it that arrived with no date would file itself into
     * the inbox and never appear here again. */
    const add = element("div", "cal-tasks-add");
    const field = document.createElement("input");
    field.type = "text";
    field.className = "cal-tasks-field k-field";
    field.placeholder = "Add a task";
    field.maxLength = 1000;
    /* ⚠️ Not "New task name" — the month view's composer already answers to
     * that and both can be in the DOM at once. */
    field.setAttribute("aria-label", "Add a task for today");
    const commit = () => {
      const value = field.value.trim();
      if (!value) return;
      this.deps.create(value, localDay(new Date()), this.intoList);
      field.value = "";
      /* ⚠️ The caret STAYS, and the field is not closed. Planning a day is
       * typing several things in a row, and a composer that shuts after each
       * one turns four tasks into four round trips through the keyboard. */
    };
    field.onkeydown = key => {
      if (key.key === "Enter") { key.preventDefault(); commit(); }
      if (key.key === "Escape") {
        key.preventDefault();
        field.value = "";
        field.blur();
        void this.deps.focus(false).catch(() => {});
      }
    };
    /* ⚠️ The island never takes focus, so the keystrokes go to whatever is in
     * front until this round trip lifts `WS_EX_NOACTIVATE`. The same one
     * Today's composer and the draft field make. */
    field.onfocus = () => { void this.deps.focus(true).catch(() => {}); };
    field.onblur = () => { void this.deps.focus(false).catch(() => {}); };
    add.append(field);
    panel.append(add);
    return box;
  }

  /** When an event actually is, once anything optimistic is laid over it. */
  private timesOf(event: CalEvent): { begin: Date; finish: Date } {
    const pending = this.settling.get(event.id);
    if (pending) return { begin: new Date(pending.start), finish: new Date(pending.end) };
    return { begin: startOf(event), finish: endOf(event) };
  }

  /* ── Writing ───────────────────────────────────────────────────────────
   * ⚠️ Every one of these shows the change FIRST and sends it second. The
   * write is a round trip plus a full re-read of every calendar, and a block
   * that waits for that before moving reads as a drag that did not take. The
   * feed that comes back is what clears the optimism — see `boot`.
   *
   * ⚠️ And every one of them puts the change BACK on failure. An optimistic
   * update that is not undone is worse than no optimism at all: the grid would
   * show a meeting at a time Google never agreed to, and keep showing it until
   * the next poll five minutes later.
   */

  /** Commit the event being drawn. */
  private commitDraft(title: string) {
    const draft = this.draft;
    if (!draft) return;
    this.draft = null;
    (this.host.querySelector(".cal-draft-field") as HTMLElement | null)?.blur();
    void this.deps.focus(false);
    const start = atHour(draft.day, draft.start);
    const end = atHour(draft.day, draft.end);
    const name = title.trim() || "(no title)";
    const key = ++this.creatingKey;
    this.creating.push({ key, title: name, ...draft });
    this.soon();
    const gone = () => { this.creating = this.creating.filter(one => one.key !== key); };
    if (this.viaHelm) {
      const minutes = { day: draft.day, start: Math.round(draft.start * 60), end: Math.round(draft.end * 60) };
      const calendarId = newEventCalendar(this.helm!);
      if (draft.kind === "block" || !calendarId) {
        void this.act({ action: "scheduleBlock", title: name, ...minutes, end: Math.min(minutes.end, minutes.start + BLOCK_MAX_HOURS * 60) }, gone);
      } else {
        void this.act({ action: "createEvent", calendarId, title: name, ...minutes }, gone);
      }
      return;
    }
    void call("create_event", {
      title: name,
      start: start.toISOString(),
      end: end.toISOString(),
    }).catch(problem => {
      gone();
      this.actionError = String(problem);
      this.changed();
    });
  }

  private cancelDraft() {
    this.draft = null;
    (this.host.querySelector(".cal-draft-field") as HTMLElement | null)?.blur();
    void this.deps.focus(false);
    this.soon();
  }

  /** Move or resize one event. */
  private commitMove(event: CalEvent, start: Date, end: Date) {
    const before = this.settling.get(event.id);
    this.settling.set(event.id, { start: start.toISOString(), end: end.toISOString() });
    this.actionError = "";
    this.soon();
    if (event.viaHelm) {
      const span = hoursWithin(start, end);
      void this.act({
        action: "moveEvent", calendarId: event.calendarId, eventId: event.googleId,
        day: localDay(start), start: Math.round(span.start * 60), end: Math.round(span.end * 60),
      }, () => { if (before) this.settling.set(event.id, before); else this.settling.delete(event.id); });
      return;
    }
    void call("move_event", {
      calendarId: event.calendarId,
      eventId: event.id,
      start: start.toISOString(),
      end: end.toISOString(),
    }).catch(problem => {
      /* ⚠️ Restores what was there rather than clearing, because a failed move
       * of an event that was ALREADY settling from an earlier one must fall
       * back to that, not all the way to the server's copy. */
      if (before) this.settling.set(event.id, before); else this.settling.delete(event.id);
      this.actionError = String(problem);
      this.changed();
    });
  }

  /** A new name or place, shown at once and put back if Google says no. */
  private commitEdit(event: CalEvent, change: { title?: string; location?: string }) {
    const before = this.patched.get(event.id);
    this.patched.set(event.id, { ...before, ...change });
    this.actionError = "";
    this.soon();
    if (event.viaHelm) {
      void this.act({
        action: "updateEvent", calendarId: event.calendarId, eventId: event.googleId, title: change.title ?? event.title,
        ...(change.location !== undefined ? { place: change.location } : {}),
      }, () => { if (before) this.patched.set(event.id, before); else this.patched.delete(event.id); });
      return;
    }
    void call("update_event", { calendarId: event.calendarId, eventId: event.id, ...change }).catch(problem => {
      if (before) this.patched.set(event.id, before); else this.patched.delete(event.id);
      this.actionError = String(problem);
      this.changed();
    });
  }

  /** Move or resize one of Helm's blocks. */
  private commitBlock(block: HelmBlock, start: Date, end: Date) {
    const id = `block:${block.id}`;
    const before = this.settling.get(id);
    this.settling.set(id, { start: start.toISOString(), end: end.toISOString() });
    this.actionError = "";
    this.soon();
    const span = hoursWithin(start, end);
    void this.act({
      action: "moveBlock", blockId: block.id, day: localDay(start), start: Math.round(span.start * 60), end: Math.round(span.end * 60),
    }, () => { if (before) this.settling.set(id, before); else this.settling.delete(id); });
  }

  /** Something off the rail, landed on the grid. */
  private planItem(item: HelmPlanItem, day: string, hour: number) {
    const length = Math.min(BLOCK_MAX_HOURS, item.minutes / 60);
    const start = Math.min(24 - length, hour);
    const minutes = { day, start: Math.round(start * 60), end: Math.round((start + length) * 60) };
    const key = ++this.creatingKey;
    this.creating.push({ key, title: item.title, day, start, end: start + length, kind: "block" });
    this.planning.add(item.key);
    this.actionError = "";
    this.soon();
    const undo = () => {
      this.creating = this.creating.filter(one => one.key !== key);
      this.planning.delete(item.key);
    };
    if (item.blockId) void this.act({ action: "moveBlock", blockId: item.blockId, ...minutes }, undo);
    else {
      void this.act({
        action: "scheduleBlock", title: item.title, projectId: item.projectId, workItemId: item.workItemId,
        taskId: item.taskId, dealId: item.dealId, ...minutes,
      }, undo);
    }
  }

  /** Put a task at a time — a drop from the list, or a drag of one already
   *  on the grid.
   *
   * ⚠️ Written through TickTick, not Google. A task on this grid is still a
   * task; what a drop changes is its `startDate` and `dueDate`. The two kinds
   * of block look alike on purpose and are stored nowhere near each other.
   *
   * ⚠️ No optimistic layer here, unlike an event. Today owns the one this app
   * has, and a second one in the calendar would be two places deciding what a
   * task looks like before the server answers — which is exactly the problem
   * the comment on `deps.tasks` describes. TickTick's own refresh is quick
   * and the block lands on the next snapshot. */
  private scheduleTask(task: Task, start: Date, end: Date) {
    this.actionError = "";
    this.changed();
    void call("schedule_task", {
      projectId: task.projectId,
      taskId: task.id,
      start: start.toISOString(),
      end: end.toISOString(),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }).catch(problem => {
      this.actionError = String(problem);
      this.changed();
    });
  }

  /** Tasks that are on the grid, and tasks that are waiting to be.
   *
   * ⚠️ Split on whether the task has a REAL time, which is not the same as
   * having a date. Everything Today shows has a due date — that is what makes
   * it today's — and an all-day task has 00:00 in its `startDate` with
   * `isAllDay` set. Laying those on an hour axis would stack the whole list
   * at midnight and call it a schedule. */
  private splitTasks(): { placed: Task[]; waiting: Task[] } {
    const placed: Task[] = [];
    const waiting: Task[] = [];
    for (const task of this.deps.tasks()) {
      if (task.startDate && !task.isAllDay) placed.push(task); else waiting.push(task);
    }
    return { placed, waiting };
  }

  private commitDelete(event: CalEvent) {
    this.removing.add(event.id);
    this.chosen = null;
    this.actionError = "";
    this.changed();
    if (event.viaHelm) {
      void this.act({ action: "deleteEvent", calendarId: event.calendarId, eventId: event.googleId }, () => this.removing.delete(event.id));
      return;
    }
    void call("delete_event", { calendarId: event.calendarId, eventId: event.id })
      .catch(problem => {
        this.removing.delete(event.id);
        this.actionError = String(problem);
        this.changed();
      });
  }

  /** The day the week or day view is built around. */
  private anchorDate(now: Date): Date {
    if (!this.anchorDay) return new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return atHour(this.anchorDay, 0);
  }

  /** The days on screen: one, or a week from its first day. */
  private shownDays(now: Date): Date[] {
    const anchor = this.anchorDate(now);
    if (this.view === "day") return [anchor];
    const first = weekStart(anchor, this.mondayFirst);
    return Array.from({ length: 7 }, (_, offset) => {
      const date = new Date(first);
      date.setDate(first.getDate() + offset);
      return date;
    });
  }

  private setView(name: CalendarView) {
    /* The list only sits beside a time grid. */
    if (name === "month" || name === "agenda") this.leaveWeek();
    /* The views scroll different things, so a position carried over means nothing. */
    const grid = (one: CalendarView) => one === "week" || one === "day";
    if (grid(name) !== grid(this.view)) this.scrollAt = 0;
    if (name !== this.view) this.chosen = null;
    this.view = name;
    this.deps.width();
    this.changed();
  }

  /** The bar over every view: where you are and how to page, adding, and the views. */
  private viewSwitch(now: Date): HTMLElement {
    const bar = element("div", "cal-bar");
    if (this.view !== "agenda") bar.append(this.pager(now));
    if (this.viaHelm) bar.append(this.quickAdd(now));
    const views = element("div", "cal-views");
    for (const [name, icon, label] of [["month", "grid", "Month"], ["week", "calendar", "Week"], ["day", "clock", "Day"], ["agenda", "list", "Agenda"]] as const) {
      const button = element("button", "cal-view", label);
      (button as HTMLButtonElement).type = "button";
      button.setAttribute("aria-pressed", String(this.view === name));
      button.prepend(taskIcon(icon));
      button.onclick = () => this.setView(name);
      views.append(button);
    }
    bar.append(views);
    return bar;
  }

  /** What's on screen, back and forward, and back to today. */
  private pager(now: Date): HTMLElement {
    const nav = element("div", "cal-nav");
    const anchor = this.anchorDate(now);
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const dayMs = 86_400_000;
    const stepped = (direction: -1 | 1) => {
      if (this.view === "month") return new Date(anchor.getFullYear(), anchor.getMonth() + direction, 1);
      const to = new Date(anchor);
      to.setDate(to.getDate() + direction * (this.view === "day" ? 1 : 7));
      return to;
    };
    const noun = this.view === "month" ? "month" : this.view === "day" ? "day" : "week";
    const page = (direction: -1 | 1, label: string, glyph: string) => {
      const button = element("button", "cal-page", glyph) as HTMLButtonElement;
      button.type = "button";
      button.setAttribute("aria-label", label);
      const to = stepped(direction);
      // Helm can read any weeks; the app's own feed holds a fixed window.
      const away = (to.getTime() - today.getTime()) / dayMs;
      button.disabled = !this.viaHelm && (away > FEED_AHEAD_DAYS || away < -FEED_BACK_DAYS);
      button.onclick = () => {
        this.anchorDay = localDay(to);
        this.chosen = null;
        this.changed();
        const held = this.helm;
        if (held && (localDay(new Date(to.getTime() - 7 * dayMs)) < held.from || localDay(new Date(to.getTime() + 42 * dayMs)) > held.to)) void this.readHelm();
      };
      return button;
    };
    const shown = this.view === "month" ? [anchor] : this.shownDays(now);
    const first = shown[0];
    const last = shown[shown.length - 1];
    const monthYear = (date: Date) => date.toLocaleDateString(undefined, { month: "long", year: "numeric" });
    const title = this.view === "day"
      ? first.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })
      : first.getMonth() === last.getMonth()
        ? monthYear(first)
        : `${first.toLocaleDateString(undefined, { month: "short" })} – ${last.toLocaleDateString(undefined, { month: "short", year: "numeric" })}`;
    nav.append(element("b", "cal-nav-label", title));
    const onToday = this.view === "month"
      ? anchor.getFullYear() === now.getFullYear() && anchor.getMonth() === now.getMonth()
      : shown.some(date => localDay(date) === localDay(now));
    const back = element("button", "cal-today", "Today") as HTMLButtonElement;
    back.type = "button";
    back.disabled = onToday;
    back.onclick = () => { this.anchorDay = ""; this.chosen = null; this.changed(); };
    const pages = element("div", "cal-pages");
    pages.append(page(-1, `Previous ${noun}`, "‹"), back, page(1, `Next ${noun}`, "›"));
    nav.append(pages);
    return nav;
  }

  /** One line in plain words ("gym at 18", "call z Esono czw 15"), read by Claude in
   *  Helm and added straight away. */
  private quickAdd(now: Date): HTMLElement {
    const box = element("label", "cal-quick");
    const mark = element("span", "cal-quick-mark");
    paintIcon(mark, "plus");
    const field = document.createElement("input");
    field.type = "text";
    field.className = "cal-quick-field";
    field.maxLength = 300;
    field.disabled = this.quickBusy;
    field.placeholder = this.quickBusy ? "Adding…" : this.quickSaid || "Add: gym at 18";
    field.setAttribute("aria-label", "Add to the calendar in plain words");
    field.onfocus = () => { this.quickSaid = ""; void this.deps.focus(true).catch(() => {}); };
    field.onblur = () => { void this.deps.focus(false).catch(() => {}); this.soon(); };
    field.onkeydown = key => {
      if (key.key === "Escape") {
        key.preventDefault();
        key.stopPropagation();
        field.value = "";
        field.blur();
      }
      if (key.key !== "Enter" || !field.value.trim()) return;
      key.preventDefault();
      const text = field.value.trim();
      this.quickBusy = true;
      field.value = "";
      field.blur();
      this.actionError = "";
      void this.act({ action: "quickAdd", text, day: this.anchorDay || localDay(now) }).then(answer => {
        this.quickBusy = false;
        if (answer.ok && typeof answer.title === "string" && typeof answer.day === "string") {
          const at = typeof answer.start === "number" ? ` · ${hhmm(answer.start / 60)}` : "";
          this.quickSaid = `Added ${answer.title} · ${dayHeading(answer.day)}${at}`;
          if (this.view !== "agenda") this.anchorDay = answer.day;
        }
        this.changed();
      });
    };
    box.append(mark, field);
    return box;
  }

  /* ── The month ─────────────────────────────────────────────────────────
   * A grid on the left, the agenda scrolling beside it. ⚠️ The two are one
   * view, not two: the grid says which days have something on them and the
   * agenda says what — and a grid on its own answers neither question.
   */

  /** Which month is on screen, as an offset from the one today is in.
   *  ⚠️ An offset rather than a Date, so "today" moving over midnight cannot
   *  strand the view on a month nobody chose. */
  private monthOffset = 0;
  /** The day the grid has ringed, or "" for today. */
  private chosenDay = "";
  /** Set for exactly one render: the day the agenda should jump to. ⚠️ Not
   *  `chosenDay` itself, or every unrelated redraw — a minute ticking over, a
   *  task completing — would drag the agenda back to it while you were reading
   *  something else. */
  private scrollTo = "";
  /** Whether the New Task popover is up, and what is in it. */
  private composing = false;
  /** The list the popover will file into, or "" to follow Today's. */
  private intoList = "";
  private listMenu = false;

  private shownMonth(now: Date): Date {
    return new Date(now.getFullYear(), now.getMonth() + this.monthOffset, 1);
  }

  /** Busy-day counts for months the main feed does not reach.
   *
   * ⚠️ The feed is 45 days. Paging the grid past that drew a correct month
   * with no marks at all — which is not an empty month, it is a month nobody
   * asked about, and the two look identical.
   *
   * ⚠️ Cached by month and asked for ONCE. A `render()` runs on every tick of
   * the clock, so a fetch driven straight off "the shown month has no entry"
   * would ask Google for the same month every second until the answer landed. */
  private months = new Map<string, Record<string, number>>();
  private asking = new Set<string>();

  private monthKey(first: Date): string {
    return `${first.getFullYear()}-${String(first.getMonth() + 1).padStart(2, "0")}`;
  }

  private wantMonth(first: Date) {
    const key = this.monthKey(first);
    if (this.months.has(key) || this.asking.has(key)) return;
    this.asking.add(key);
    /* The whole grid, not the month: the six rows run into the months either
     * side and those cells carry dots too. */
    const from = weekStart(first, this.mondayFirst);
    const to = new Date(from);
    to.setDate(from.getDate() + 42);
    void call<Record<string, number>>("calendar_days", {
      from: from.toISOString(), to: to.toISOString(),
    }).then(days => {
      this.months.set(key, days);
      this.changed();
    }).catch(() => {
      // An empty month is the honest answer; the grid draws the same either way.
      this.months.set(key, {});
    }).finally(() => this.asking.delete(key));
  }

  private renderMonth(now: Date) {
    const wrap = element("div", "cal-split");
    wrap.append(this.monthGrid(now), this.agenda(now));
    this.host.append(wrap);
  }

  private monthGrid(now: Date): HTMLElement {
    const panel = element("div", "cal-month");
    const first = this.shownMonth(now);
    const today = localDay(now);
    /* ⚠️ Only for months the feed does not cover. Asking for the current one
     * would be a second request for events we already have, every time the
     * screen is opened. */
    if (Math.abs(this.monthOffset) > 0) this.wantMonth(first);

    /* ── The head: the month, a way to add, and the pager ─────────────── */
    const head = element("div", "cal-month-head");
    const name = element("b", "cal-month-name",
      first.toLocaleDateString(undefined, { month: "long" }).toUpperCase());
    const add = element("button", `cal-add${this.composing ? " is-on" : ""}`);
    (add as HTMLButtonElement).type = "button";
    add.setAttribute("aria-label", "New task");
    add.setAttribute("aria-expanded", String(this.composing));
    add.dataset.tip = "New task";
    paintIcon(add, "plus");
    add.onclick = () => {
      this.composing = !this.composing;
      this.changed();
      /* ⚠️ The lift FIRST, then the caret — and both awaited. Focusing before
       * the window can take focus is what made this popover a field you could
       * see, click, and not type into: the caret was in the island and every
       * keystroke went to the window behind it. */
      if (this.composing) {
        void this.deps.focus(true).then(() => {
          this.host.querySelector<HTMLInputElement>(".cal-new input")?.focus();
        }).catch(() => {});
      } else {
        void this.deps.focus(false).catch(() => {});
      }
    };
    const pager = element("div", "cal-pager");
    for (const [step, label, glyph] of [[-1, "Previous month", "‹"], [1, "Next month", "›"]] as const) {
      const button = element("button", "cal-page", glyph);
      (button as HTMLButtonElement).type = "button";
      button.setAttribute("aria-label", label);
      button.dataset.tip = label;
      button.onclick = () => { this.monthOffset += step; this.chosenDay = ""; this.changed(); };
      pager.append(button);
    }
    head.append(name, add, pager);
    panel.append(head);
    if (this.composing) panel.append(this.newTask(now));

    /* ── The weekday row, in the order the grid is drawn ──────────────── */
    const dow = element("div", "cal-dow");
    const firstShown = weekStart(first, this.mondayFirst);
    for (let i = 0; i < 7; i++) {
      const day = new Date(firstShown);
      day.setDate(firstShown.getDate() + i);
      /* ⚠️ `narrow`, and the duplicates are the point: M T W T F S S is how a
       * calendar has always been headed, and widening it to "Mon" to tell the
       * two T's apart costs the grid a third of its width for information the
       * column position already carries. */
      dow.append(element("span", "", day.toLocaleDateString(undefined, { weekday: "narrow" })));
    }
    panel.append(dow);

    /* ── Six weeks, always ─────────────────────────────────────────────
     * ⚠️ Six, not "as many as this month needs". A grid that is five rows in
     * November and six in December changes the panel's height every time you
     * page, and the agenda beside it jumps with it. */
    /* ⚠️ The feed first, then the fetched month on top of it. The feed is
     * what the agenda beside the grid is drawn from and is always the more
     * current of the two — a month cached ten minutes ago must not overwrite a
     * day the live feed has just changed. */
    const busy = new Map<string, number>();
    for (const [day, count] of Object.entries(this.months.get(this.monthKey(first)) ?? {})) {
      busy.set(day, count);
    }
    for (const event of this.feed.events) {
      const key = event.allDay ? event.start.slice(0, 10) : localDay(startOf(event));
      busy.set(key, (busy.get(key) ?? 0) + 1);
    }
    const grid = element("div", "cal-grid");
    for (let i = 0; i < 42; i++) {
      const date = new Date(firstShown);
      date.setDate(firstShown.getDate() + i);
      const key = localDay(date);
      const other = date.getMonth() !== first.getMonth();
      const cell = element("button", "cal-cell"
        + (other ? " is-other" : "")
        + (key === today ? " is-today" : "")
        + (key === (this.chosenDay || today) ? " is-chosen" : ""));
      (cell as HTMLButtonElement).type = "button";
      cell.setAttribute("aria-label", date.toLocaleDateString(undefined,
        { weekday: "long", day: "numeric", month: "long" }));
      cell.append(element("span", "cal-cell-num", String(date.getDate())));
      const count = busy.get(key) ?? 0;
      if (count) {
        const dots = element("span", "cal-dots");
        // Three at most: past that the number stops being readable and the
        // row of dots is just a texture.
        for (let d = 0; d < Math.min(3, count); d++) dots.append(element("i"));
        cell.append(dots);
      }
      /* Choosing a day scrolls the agenda to it rather than filtering to it.
       * ⚠️ The agenda is continuous on purpose: "what is next" does not stop
       * at midnight, and a day with nothing on it would otherwise answer with
       * an empty panel rather than with the next thing that is. */
      cell.onclick = () => {
        this.chosenDay = key;
        this.scrollTo = key;
        this.changed();
      };
      grid.append(cell);
    }
    panel.append(grid);
    return panel;
  }

  /** The New Task popover.
   *
   * ⚠️ It writes through the Today screen rather than calling `create_task`
   * itself. Today owns the optimistic layer, the outbox and the list the
   * composer files into; a second creation path here would be a task that
   * appears on one screen and not the other until TickTick answers.
   */
  private newTask(now: Date): HTMLElement {
    const sheet = element("div", "cal-new");
    sheet.append(element("span", "cal-new-head", "New Task"));
    const row = element("div", "cal-new-row");
    const field = document.createElement("input");
    field.type = "text";
    field.placeholder = "What needs doing?";
    field.className = "k-field";
    field.maxLength = 1000;
    /* ⚠️ Not "Task name". Today's composer already carries that label and both
     * are in the DOM at once — two fields answering to one name is ambiguous
     * for a screen reader and for anything driving the page. */
    field.setAttribute("aria-label", "New task name");
    const when = element("span", "cal-new-day",
      dayHeading(this.chosenDay || localDay(now), localDay(now)));
    const add = element("button", "cal-new-add", "Add");
    (add as HTMLButtonElement).type = "button";
    const close = () => {
      this.composing = false;
      this.listMenu = false;
      // Hand the keyboard back, or the island stays unfoldable and the next
      // thing you type still goes to it.
      void this.deps.focus(false).catch(() => {});
      this.changed();
    };
    const commit = () => {
      const value = field.value.trim();
      if (!value) return;
      this.deps.create(value, this.chosenDay || localDay(now), this.intoList);
      close();
    };
    add.onclick = commit;
    field.onkeydown = event => {
      if (event.key === "Enter") { event.preventDefault(); commit(); }
      if (event.key === "Escape") close();
    };
    row.append(when, field, add);
    sheet.append(row);

    /* Which list it goes into. ⚠️ It defaults to Today's composer rather than
     * to the first list: filing from here and filing from there should land in
     * the same place unless you say otherwise, or the two screens quietly
     * disagree about where your tasks go. */
    const lists = this.deps.lists();
    if (lists.length > 1) {
      const chosen = lists.find(l => l.id === this.intoList)
        ?? lists.find(l => l.chosen) ?? lists[0];
      const pick = element("button", `cal-new-list${this.listMenu ? " is-on" : ""}`);
      (pick as HTMLButtonElement).type = "button";
      pick.setAttribute("aria-haspopup", "listbox");
      pick.setAttribute("aria-expanded", String(this.listMenu));
      pick.setAttribute("aria-label", `List: ${chosen.name}`);
      pick.append(element("span", "chip-dot"), element("span", "", chosen.name));
      pick.onclick = event => {
        event.stopPropagation();
        this.listMenu = !this.listMenu;
        this.changed();
      };
      sheet.append(pick);

      if (this.listMenu) {
        const menu = element("div", "cal-list-menu");
        for (const list of lists) {
          const option = element("button",
            `chip-option${list.id === chosen.id ? " is-on" : ""}`);
          (option as HTMLButtonElement).type = "button";
          option.append(element("span", "", list.name));
          option.onclick = event => {
            event.stopPropagation();
            this.intoList = list.id;
            this.listMenu = false;
            this.changed();
            /* ⚠️ The caret goes back to the field. Choosing a list is a detour
             * in the middle of typing a task, and leaving focus on the menu
             * means the next keystroke is lost. */
            requestAnimationFrame(() =>
              this.host.querySelector<HTMLInputElement>(".cal-new input")?.focus());
          };
          menu.append(option);
        }
        sheet.append(menu);
      }
    }
    return sheet;
  }

  /** The agenda beside the grid: continuous, grouped by day, week number and
   *  all. */
  private agenda(now: Date): HTMLElement {
    const panel = element("div", "cal-agenda scrolls");
    const today = localDay(now);
    /* ⚠️ Always from TODAY, never from the chosen day. Choosing a day scrolls
     * the agenda to it; it does not cut the list down to it. Filtering looks
     * identical the moment you click a day with something on it and is wrong
     * every other time — a day with nothing on it would answer with an empty
     * panel rather than with the next thing that is, and there would be no way
     * back to the rest of the week except pressing today again.
     *
     * ⚠️ `endOf`, not `startOf`: a meeting that began twenty minutes ago has
     * not finished, and dropping it while you are in it is the one moment the
     * agenda is actually being looked at. */
    const shown = this.feed.events.filter(e =>
      (e.allDay ? e.start.slice(0, 10) : localDay(endOf(e))) >= today);

    if (!shown.length) {
      const empty = element("div", "day-empty");
      empty.append(element("h3", "", "Nothing ahead"),
        element("p", "", "No events in the next few weeks."));
      panel.append(empty);
      return panel;
    }

    let day = "";
    for (const event of shown) {
      const eventDay = event.allDay ? event.start.slice(0, 10) : localDay(startOf(event));
      if (eventDay !== day) {
        day = eventDay;
        const heading = element("h4", "cal-day");
        heading.dataset.day = day;
        const [y, m, d] = day.split("-").map(Number);
        heading.append(
          element("span", "", dayHeading(day, today).toUpperCase()),
          element("span", "cal-wk", `WK. ${isoWeek(new Date(y, m - 1, d))}`),
        );
        panel.append(heading);
      }
      panel.append(this.eventCard(event));
    }
    return panel;
  }

  /** ⚠️ A button, and TINTED rather than striped. The 3px left rail was the
   *  one decoration on this surface that said nothing the colour could not say
   *  by itself — and it is the shape every generated calendar has. */
  private eventCard(event: CalEvent): HTMLElement {
    const row = element("button", `cal-row${event.response === "declined" ? " declined" : ""}`
      + (this.chosen === event.id ? " is-open" : ""));
    (row as HTMLButtonElement).type = "button";
    row.style.setProperty("--cal", event.color || "#5ac8fa");
    row.onclick = () => {
      this.chosen = this.chosen === event.id ? null : event.id;
      this.changed();
    };
    const body = element("div", "cal-body");
    body.append(element("span", "cal-title", event.title));
    body.append(element("span", "cal-time", timeLabel(event)));
    row.append(body);
    if (event.meetingUrl) {
      const join = element("button", "cal-join");
      (join as HTMLButtonElement).type = "button";
      join.setAttribute("aria-label", `Join ${event.title}`);
      join.dataset.tip = "Join";
      paintIcon(join, "join");
      join.onclick = event2 => { event2.stopPropagation(); this.open(event.meetingUrl); };
      row.append(join);
    }
    return row;
  }

  /* ── The week ──────────────────────────────────────────────────────────
   * A TIME grid, not seven lists of chips.
   *
   * ⚠️ The old one was a column per day with the events stacked inside it in
   * order, which answers "what is on Thursday" — the agenda answers that
   * better, on one screen, without seven columns. The only question a week
   * view answers that nothing else does is **where the gaps are**, and a list
   * cannot show a gap. Laid against an hour axis, a free afternoon is a free
   * afternoon at a glance.
   *
   * ⚠️ The axis is cropped to the hours that are actually used, never a flat
   * 00:00–24:00. Nine tenths of a full day is empty on any real calendar, and
   * a grid that spends nine tenths of its height on the small hours is a grid
   * you cannot read the middle of. A floor and a ceiling keep it honest when
   * the week is empty.
   */
  private dayData() {
    /* Every event resolved through `timesOf` once: an optimistic move can change
     * which day it is on. */
    const placed = this.feed.events
      .filter(e => !this.removing.has(e.id))
      .map(e => ({ event: this.edited(e), ...this.timesOf(e) }));

    /* Tasks with a real time, on the same axis. One merely due today has 00:00 in
     * its `startDate`, and stays in the list until somebody drops it. */
    const { placed: timedTasks, waiting } = this.splitTasks();
    const tasks = timedTasks.map(task => {
      const begin = new Date(task.startDate!);
      const due = task.dueDate ? new Date(task.dueDate) : begin;
      /* At least half an hour: TickTick's "at 3pm" has no length, and that's nothing to grab. */
      const finish = due.getTime() > begin.getTime() + 60_000
        ? due : new Date(begin.getTime() + 30 * 60_000);
      return { task, begin, finish };
    });

    /* Helm's blocks with a time, wherever a move has just put them. */
    const blocks = (this.helm?.blocks ?? []).flatMap(block => {
      const id = `block:${block.id}`;
      const at = blockStart(block);
      if (at === null || block.status === "skipped" || this.removing.has(id)) return [];
      const pending = this.settling.get(id);
      const begin = pending ? new Date(pending.start) : atMinutes(block.day, at);
      const finish = pending ? new Date(pending.end) : atMinutes(block.day, at + block.minutes);
      return [{ block, begin, finish }];
    });
    const markers = this.helm?.markers ?? [];

    const on = (key: string) => ({
      blocks: blocks.filter(one => localDay(one.begin) === key),
      markers: markers.filter(one => one.day === key),
      events: placed.filter(one => {
        if (!one.event.allDay) return localDay(one.begin) === key;
        // An all-day event shows on every day it covers; Google's end is exclusive.
        const from = one.event.start.slice(0, 10);
        const to = one.event.end ? one.event.end.slice(0, 10) : from;
        return key === from || (key > from && key < to);
      }),
      tasks: tasks.filter(one => localDay(one.begin) === key),
    });
    return { waiting, on };
  }

  /** What's left of a working day, in minutes; null when that isn't worth saying. */
  private freeOf(day: ReturnType<ReturnType<CalendarScreen["dayData"]>["on"]>, key: string, now: Date): number | null {
    const busy: MinuteSpan[] = [
      ...day.events.filter(one => !one.event.allDay).map(one => hoursWithin(one.begin, one.finish)),
      ...day.blocks.map(one => hoursWithin(one.begin, one.finish)),
    ].map(one => ({ start: Math.round(one.start * 60), end: Math.round(one.end * 60) }));
    return freeOn(busy, key, localDay(now), now.getHours() * 60 + now.getMinutes());
  }

  /** One day's things as the month and a day's card list them. */
  private entriesOf(day: ReturnType<ReturnType<CalendarScreen["dayData"]>["on"]>): MonthEntry[] {
    return [
      ...day.events.map(({ event, begin, finish }): MonthEntry => {
        const span = event.allDay ? null : hoursWithin(begin, finish);
        return { id: event.id, title: event.title, start: span?.start ?? null, end: span?.end ?? null, color: event.color || "var(--cool)", project: null, isBlock: false, done: false };
      }),
      ...day.blocks.map(({ block, begin, finish }): MonthEntry => {
        const span = hoursWithin(begin, finish);
        const mark = this.helm?.marks.find(one => one.id === block.projectId);
        return {
          id: `block:${block.id}`, title: block.title, start: span.start, end: span.end,
          color: hueOf(mark?.hue, mark?.name ?? block.title),
          project: mark ? { id: mark.id, name: mark.name } : null, isBlock: true, done: block.status === "done",
        };
      }),
      ...day.tasks.map(({ task, begin, finish }): MonthEntry => {
        const span = hoursWithin(begin, finish);
        return { id: `task:${task.id}`, title: task.title, start: span.start, end: span.end, color: this.deps.taskColor(task) || "var(--good)", project: null, isBlock: false, done: task.status === 2 };
      }),
    ];
  }

  private lineSignature(key: string): string {
    const data = this.dayData().on(key);
    return JSON.stringify([this.entriesOf(data), data.markers.map(one => one.key)]);
  }

  /** The dot, time and title of one thing on a day. */
  private monthLine(entry: MonthEntry, past: boolean): HTMLElement {
    const chip = element("button", `cal-mchip${entry.start === null ? " is-allday" : ""}${entry.isBlock ? " is-focus" : ""}${entry.done ? " is-done" : ""}${past ? " is-past" : ""}`);
    (chip as HTMLButtonElement).type = "button";
    chip.style.setProperty("--cal", entry.color);
    chip.dataset.calId = entry.id;
    if (entry.start !== null) {
      chip.append(element("span", "cal-mchip-dot"), element("span", "cal-mchip-time", hhmm(entry.start)));
    }
    chip.append(element("span", "cal-mchip-title", entry.title));
    chip.dataset.tip = entry.start === null ? entry.title : `${hhmm(entry.start)} – ${hhmm(entry.end!)} · ${entry.title}`;
    chip.onclick = click => {
      click.stopPropagation();
      if (entry.id.startsWith("task:")) return;
      this.chosen = this.chosen === entry.id ? null : entry.id;
      this.changed();
    };
    return chip;
  }

  /** A true month: every day with what's on it, as many lines as fit. */
  private renderMonthGrid(now: Date) {
    const anchor = this.anchorDate(now);
    const today = localDay(now);
    const cells = monthCells(anchor.getFullYear(), anchor.getMonth(), this.mondayFirst);
    const rows = cells.length / 7;
    const rowPx = Math.floor(MONTH_GRID_PX / rows);
    const fits = linesThatFit(rowPx);
    const data = this.dayData();

    const month = element("div", "cal-mv");
    const head = element("div", "cal-mhead");
    for (let i = 0; i < 7; i++) {
      head.append(element("span", i >= 5 ? "is-weekend" : "", cells[i].toLocaleDateString(undefined, { weekday: "short" })));
    }
    const grid = element("div", "cal-mgrid");
    grid.style.gridTemplateRows = `repeat(${rows}, ${rowPx}px)`;
    const drawn: Placed[] = [];
    for (const [index, date] of cells.entries()) {
      const key = localDay(date);
      const inMonth = date.getMonth() === anchor.getMonth();
      const day = data.on(key);
      const weekend = date.getDay() === 0 || date.getDay() === 6;
      const cell = element("div", "cal-mcell"
        + (inMonth ? "" : " is-other")
        + (key === today ? " is-today" : "")
        + (weekend ? " is-weekend" : "")
        + (this.chosen === `day:${key}` ? " is-open" : ""));
      cell.dataset.day = key;

      const top = element("div", "cal-mtop");
      const number = element("button", "cal-mnum", String(date.getDate())) as HTMLButtonElement;
      number.type = "button";
      number.setAttribute("aria-label", `Open ${date.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}`);
      number.onclick = click => {
        click.stopPropagation();
        this.anchorDay = key;
        this.setView("day");
      };
      top.append(number);
      const free = inMonth ? this.freeOf(day, key, now) : null;
      if (free !== null) top.append(element("span", `cal-mfree${free === 0 ? " is-full" : ""}`, free === 0 ? "Full" : shortLength(free)));
      cell.append(top);

      const entries = this.entriesOf(day);
      for (const { event, begin, finish } of day.events.filter(one => !one.event.allDay)) {
        const span = hoursWithin(begin, finish);
        drawn.push({
          id: event.id, ref: { kind: "event", event } as GridRef,
          locked: !event.writable ? `${event.title} · ${event.calendar} can't be changed here` : span.crosses ? `${event.title} runs past midnight` : "",
          start: span.start, end: span.end, column: index,
        });
      }
      for (const { block, begin, finish } of day.blocks) {
        const span = hoursWithin(begin, finish);
        drawn.push({
          id: `block:${block.id}`, ref: { kind: "block", block } as GridRef,
          locked: block.status === "done" ? `${block.title} · already done` : block.status === "running" ? `${block.title} · running now` : "",
          start: span.start, end: span.end, column: index,
        });
      }
      for (const { task, begin, finish } of day.tasks) {
        const span = hoursWithin(begin, finish);
        drawn.push({ id: `task:${task.id}`, ref: { kind: "task", task } as GridRef, locked: task.status === 2 ? `${task.title} · already done` : "", start: span.start, end: span.end, column: index });
      }

      const lines: HTMLElement[] = [];
      for (const marker of day.markers) lines.push(this.monthMarker(marker));
      const isPast = (entry: MonthEntry) => key < today || (key === today && entry.end !== null && entry.end * 60 <= now.getHours() * 60 + now.getMinutes());
      for (const line of monthLines(entries)) {
        if ("ids" in line) lines.push(this.monthFold(line, key < today));
        else lines.push(this.monthLine(line, isPast(line)));
      }
      const shown = lines.slice(0, fits);
      cell.append(...shown);
      // In the date's row, so it doesn't cost a line of the day.
      if (shown.length < lines.length) top.insertBefore(element("span", "cal-mmore", `+${lines.length - shown.length}`), number.nextSibling);
      // Anywhere else on the day: everything on it, in a card.
      cell.onclick = () => {
        const id = `day:${key}`;
        this.chosen = this.chosen === id ? null : id;
        this.changed();
      };
      grid.append(cell);
    }
    month.append(head, grid);
    this.host.append(month);

    rememberBlocks(drawn);
    wireMonthDrag(this.host, grid, {
      move: (ref, start, end) => {
        const what = ref as GridRef;
        if (what.kind === "event") this.commitMove(what.event, start, end);
        else if (what.kind === "block") this.commitBlock(what.block, start, end);
        else this.scheduleTask(what.task, start, end);
      },
      busy: on => this.hold(on),
      started: () => {
        this.actionError = "";
        if (this.chosen) {
          this.chosen = null;
          this.host.querySelector(".cal-panel")?.remove();
        }
      },
      repaint: () => this.changed(),
      escapeDown: native ? () => call<boolean>("escape_down") : undefined,
    });
  }

  private monthMarker(marker: HelmMarker): HTMLElement {
    const chip = element("button", `cal-mchip is-marker${marker.late ? " is-late" : ""}`);
    (chip as HTMLButtonElement).type = "button";
    chip.style.setProperty("--cal", hueOf(marker.hue, marker.context));
    chip.append(element("span", "cal-mchip-dot"), element("span", "cal-mchip-title", markerLabel(marker, zloty)));
    chip.dataset.tip = marker.context && marker.context !== marker.title ? `${marker.title} · ${marker.context}` : marker.title;
    chip.onclick = click => {
      click.stopPropagation();
      void call("helm_open", { path: marker.href }).catch(() => {});
    };
    return chip;
  }

  /** Several blocks for a project: one line, and the day's card lists them. */
  private monthFold(fold: MonthFold, past: boolean): HTMLElement {
    const line = element("div", `cal-mchip is-fold is-focus${fold.allDone ? " is-done" : ""}${past ? " is-past" : ""}`);
    line.style.setProperty("--cal", fold.color);
    line.append(element("span", "cal-mchip-dot"), element("span", "cal-mchip-title", fold.project.name), element("span", "cal-mchip-sum", shortLength(fold.minutes)));
    line.dataset.tip = `${fold.project.name} · ${fold.ids.length} blocks · ${shortLength(fold.minutes)}`;
    return line;
  }

  /** Everything on one day, as Helm's card: each opens, and the date opens the day. */
  private dayPanel(key: string): HTMLElement {
    const data = this.dayData().on(key);
    const sheet = element("div", "cal-panel cal-daycard");
    const head = element("div", "cal-panel-head");
    head.append(element("span", "cal-panel-when", dayHeading(key)));
    const close = element("button", "cal-panel-close small-icon");
    (close as HTMLButtonElement).type = "button";
    close.setAttribute("aria-label", "Close day");
    paintIcon(close, "close");
    close.onclick = () => { this.chosen = null; this.changed(); };
    head.append(close);
    sheet.append(head);

    const entries = [...this.entriesOf(data)].sort((a, b) => (a.start ?? -1) - (b.start ?? -1));
    if (!entries.length && !data.markers.length) sheet.append(element("p", "cal-daycard-none", "Nothing on this day."));
    for (const marker of data.markers) sheet.append(this.monthMarker(marker));
    for (const entry of entries) sheet.append(this.monthLine(entry, false));

    const actions = element("div", "cal-panel-actions");
    const open = element("button", "cal-panel-open");
    (open as HTMLButtonElement).type = "button";
    open.append(element("span", "", "Open the day"));
    open.onclick = () => {
      this.anchorDay = key;
      this.setView("day");
    };
    actions.append(open);
    sheet.append(actions);
    return sheet;
  }

  private renderWeek(now: Date) {
    const today = localDay(now);
    const shownDays = this.shownDays(now);
    const first = shownDays[0];
    const { waiting, on } = this.dayData();
    const days = shownDays.map(date => {
      const key = localDay(date);
      return { key, date, ...on(key) };
    });

    /* ── The axis ──────────────────────────────────────────────────────────
     * ⚠️ All 24 hours, but not all the same height. Cropping the axis to what
     * is booked — which is what this did when it was read-only — means an
     * event cannot be drawn at 07:00 if 07:00 is not on the grid, and the axis
     * would jump under the pointer the moment one was. Collapsing instead
     * keeps every hour reachable and still spends the height on the ones
     * anybody uses.
     *
     * ⚠️ An hour holding an event is never collapsed, whatever the default
     * says — see `quietHours`. Collapsing is a way to spend less room on
     * nothing; the moment it hides a meeting it has started lying. */
    const hoursOf = (one: { begin: Date; finish: Date }) => hoursWithin(one.begin, one.finish);
    /* ⚠️ Tasks count as busy too. A task dropped at 21:00 has to hold its hour
     * open exactly as a meeting does, or the drop would fold the thing that
     * was just dropped into a collapsed band. */
    const spans = [
      ...days.flatMap(d => d.events.filter(one => !one.event.allDay).map(hoursOf)),
      ...days.flatMap(d => d.tasks.map(hoursOf)),
      ...days.flatMap(d => d.blocks.map(hoursOf)),
      ...this.creating.filter(one => days.some(d => d.key === one.day)),
    ];
    const axis = buildAxis(quietHours(busyHours(spans), this.opened), WEEK_HOUR_PX, SHUT_HOUR_PX);

    const week = element("div", "cal-weekgrid is-work");
    week.style.setProperty("--cal-height", `${axis.height}px`);
    week.style.setProperty("--cal-cols", String(days.length));

    /* ── The head: one column per day, plus the axis gutter ───────────── */
    const head = element("div", "cal-wkhead");
    head.append(element("span", "cal-wkaxis-top", `WK. ${isoWeek(first)}`));
    for (const day of days) {
      const cell = element("div", "cal-wkday"
        + (day.key === today ? " is-today" : "")
        + (day.key < today ? " is-past" : ""));
      const label = element("span", "cal-wklabel");
      label.append(
        element("span", "cal-wkname", day.date.toLocaleDateString(undefined, { weekday: "short" })),
        element("span", "cal-wknum", String(day.date.getDate())),
      );
      cell.append(label);
      /* What's left of the working day: a number, and a bar that empties as it fills. */
      const free = this.freeOf(day, day.key, now);
      if (free !== null) {
        cell.append(element("span", `cal-wkfree${free === 0 ? " is-full" : ""}`, free === 0 ? "Full" : shortLength(free)));
        const load = element("i", "cal-wkload");
        const fill = element("b");
        fill.style.width = `${Math.round((free / (WORK_END - WORK_START)) * 100)}%`;
        load.append(fill);
        cell.append(load);
      }
      // A day's heading opens that day, and back.
      cell.onclick = () => {
        this.anchorDay = day.key;
        this.setView(this.view === "day" ? "week" : "day");
      };
      head.append(cell);
    }

    /* ── All-day events, above the axis ────────────────────────────────
     * ⚠️ A band of their own. An all-day event has no start time, so laying it
     * on an hour axis means inventing one — and a birthday drawn across
     * 00:00–23:59 swamps every meeting in the column. */
    let allDayBand: HTMLElement | null = null;
    if (days.some(d => d.markers.length || d.events.some(one => one.event.allDay))) {
      const band = element("div", "cal-wkall");
      band.append(element("span", "cal-wkall-label", "All day"));
      for (const day of days) {
        const cell = element("div", "cal-wkall-cell");
        const allDay = day.events.filter(one => one.event.allDay);
        const extra = allDay.length + day.markers.length - BAND_LINES;
        for (const { event } of extra > 0 ? allDay.slice(0, BAND_LINES - 1) : allDay) {
          const chip = element("button", "cal-chip" + (this.chosen === event.id ? " is-open" : ""));
          (chip as HTMLButtonElement).type = "button";
          chip.style.setProperty("--cal", event.color || "var(--cool)");
          chip.append(element("span", "cal-chip-title", event.title));
          chip.dataset.tip = event.title;
          chip.dataset.chipId = event.id;
          chip.onclick = () => {
            this.chosen = this.chosen === event.id ? null : event.id;
            this.changed();
          };
          cell.append(chip);
        }
        const room = extra > 0 ? Math.max(0, BAND_LINES - 1 - allDay.length) : day.markers.length;
        for (const marker of day.markers.slice(0, room)) cell.append(this.markerChip(marker));
        if (extra > 0) {
          const more = element("button", "cal-chip is-more", `${extra + 1} more`) as HTMLButtonElement;
          more.type = "button";
          more.dataset.day = day.key;
          more.onclick = () => {
            this.chosen = `day:${day.key}`;
            this.changed();
          };
          cell.append(more);
        }
        band.append(cell);
      }
      allDayBand = band;
    }

    /* ── The body: an hour axis and seven columns over it ─────────────── */
    const body = element("div", "cal-wkbody");
    body.style.height = `${axis.height}px`;

    /* ⚠️ The gutter's labels are POSITIONED, not flowed. They used to be flex
     * children sharing the height equally, which only works while every hour
     * is the same size — with a collapsed band in the middle every label after
     * it names the wrong line. */
    const gutter = element("div", "cal-wkaxis");
    for (const row of axis.rows) {
      const mark = element("span", "cal-wkhour" + (row.open ? "" : " is-shut"),
        `${String(row.hour).padStart(2, "0")}:00`);
      mark.style.top = `${row.top}px`;
      /* A collapsed hour has no room for its own number; the band says the
       * range instead. */
      if (!row.open) mark.textContent = "";
      gutter.append(mark);
    }
    if (days.some(day => day.key === today)) {
      const at = now.getHours() + now.getMinutes() / 60;
      const pill = element("span", "cal-wknowpill", hhmm(at));
      pill.style.top = `${axis.yOf(at)}px`;
      gutter.append(pill);
    }
    body.append(gutter);

    const columns: HTMLElement[] = [];
    const drawn: Placed[] = [];
    for (const [index, day] of days.entries()) {
      const column = element("div", "cal-wkcol"
        + (day.key === today ? " is-today" : "")
        + (day.key < today ? " is-past" : ""));
      columns.push(column);
      for (const row of axis.rows) {
        const working = row.hour * 60 >= WORK_START && row.hour * 60 < WORK_END
          && day.date.getDay() !== 0 && day.date.getDay() !== 6;
        const line = element("i", "cal-wkline" + (row.open ? "" : " is-shut") + (working ? " is-work" : ""));
        line.style.top = `${row.top}px`;
        line.style.height = `${row.px}px`;
        column.append(line);
      }

      const inColumn: { block: HTMLElement; top: number; bottom: number }[] = [];
      for (const { event, begin, finish: end } of day.events.filter(one => !one.event.allDay)) {
        const { start: startHour, end: endHour, crosses } = hoursWithin(begin, end);
        drawn.push({
          id: event.id,
          ref: { kind: "event", event } as GridRef,
          /* A drag here would cut an event that runs past midnight down to one day. */
          locked: !event.writable ? `${event.title} · ${event.calendar} is read-only`
            : crosses ? `${event.title} runs past midnight · change it in Google Calendar` : "",
          start: startHour, end: endHour, column: index,
        });
        const block = element("button", `cal-block${event.response === "declined" ? " declined" : ""}`
          + (this.chosen === event.id ? " is-open" : ""));
        (block as HTMLButtonElement).type = "button";
        block.style.setProperty("--cal", event.color || "var(--cool)");
        /* ⚠️ PIXELS off the axis, not a percentage of a span. The axis is
         * piecewise now — a percentage cannot say "34px an hour here and 14
         * there", and an event either side of a collapsed band would be laid
         * out as though the band were full height. */
        const top = axis.yOf(startHour);
        const tall = Math.max(MIN_BLOCK_PX, axis.yOf(endHour) - top);
        block.style.top = `${top}px`;
        block.style.height = `${tall}px`;
        /* ⚠️ The id on the ELEMENT, because the gesture layer finds its blocks
         * by querying the body it was handed — it never sees this loop. */
        block.dataset.calId = event.id;
        if (this.settling.has(event.id)) block.classList.add("is-settling");
        block.dataset.tip = `${hhmm(startHour)}–${hhmm(endHour)} · ${event.title}`;
        block.append(element("span", "cal-block-title", event.title));
        /* ⚠️ Gated on the block's REAL height in pixels. Two lines of type need
         * about 34 — so "an hour is long enough for a time" put a second line
         * into a block that could not hold the first, and the title was
         * clipped away leaving a block labelled only with its start time. */
        if (tall >= 34) block.append(element("span", "cal-block-time", `${hhmm(startHour)}–${hhmm(endHour)}`));
        block.onclick = () => {
          this.chosen = this.chosen === event.id ? null : event.id;
          this.changed();
        };
        column.append(block);
        inColumn.push({ block, top, bottom: top + tall });
      }

      /* ── Tasks, on the same grid and deliberately not identical ────────
       * ⚠️ A checkbox and a flatter surface. They sit on the same axis as the
       * meetings because that is the whole point of dropping one here — but a
       * task is something you will do and a meeting is something that will
       * happen to you, and a grid where the two are indistinguishable is a
       * grid that cannot answer "how much of Thursday is already spoken
       * for". */
      for (const { task, begin, finish } of day.tasks) {
        const { start: startHour, end: endHour } = hoursWithin(begin, finish);
        const done = task.status === 2;
        const block = element("div", "cal-block is-task" + (done ? " is-done" : ""));
        block.style.setProperty("--cal", this.deps.taskColor(task) || "var(--good)");
        const top = axis.yOf(startHour);
        const tall = Math.max(MIN_BLOCK_PX, axis.yOf(endHour) - top);
        block.style.top = `${top}px`;
        block.style.height = `${tall}px`;
        block.dataset.calId = `task:${task.id}`;
        drawn.push({
          id: `task:${task.id}`,
          ref: { kind: "task", task } as GridRef,
          /* A finished task is a record, not a plan. */
          locked: done ? `${task.title} · already done` : "",
          start: startHour, end: endHour, column: index,
        });

        const tick = element("button", "cal-tick");
        (tick as HTMLButtonElement).type = "button";
        tick.dataset.noDrag = "";
        tick.setAttribute("aria-label", done ? "Done" : `Mark "${task.title}" done`);
        tick.setAttribute("aria-pressed", String(done));
        if (done) paintIcon(tick, "check");
        /* ⚠️ The press is stopped from reaching the block. The block is a drag
         * handle; without this, ticking a task picks it up instead. */
        tick.addEventListener("pointerdown", stop => stop.stopPropagation());
        tick.onclick = stop => {
          stop.stopPropagation();
          if (!done) this.deps.finishTask(task);
        };
        const line = element("span", "cal-block-title", task.title);
        block.append(tick, line);
        if (tall >= 34) {
          block.append(element("span", "cal-block-time", `${hhmm(startHour)}–${hhmm(endHour)}`));
        }
        block.dataset.tip = task.title;
        column.append(block);
        inColumn.push({ block, top, bottom: top + tall });
      }

      /* Helm's focus blocks: work he has given a time, in the project's colour. */
      for (const { block: focus, begin, finish } of day.blocks) {
        const { start: startHour, end: endHour } = hoursWithin(begin, finish);
        const id = `block:${focus.id}`;
        const mark = this.helm?.marks.find(one => one.id === focus.projectId);
        const done = focus.status === "done";
        const block = element("button", `cal-block is-focus is-${focus.status}`
          + (this.chosen === id ? " is-open" : "")
          + (this.settling.has(id) ? " is-settling" : ""));
        (block as HTMLButtonElement).type = "button";
        block.style.setProperty("--cal", hueOf(mark?.hue, mark?.name ?? focus.title));
        const top = axis.yOf(startHour);
        const tall = Math.max(MIN_BLOCK_PX, axis.yOf(endHour) - top);
        block.style.top = `${top}px`;
        block.style.height = `${tall}px`;
        block.dataset.calId = id;
        block.dataset.tip = mark ? `${focus.title} · ${mark.name}` : focus.title;
        block.append(element("span", "cal-block-title", focus.title));
        if (tall >= 34) block.append(element("span", "cal-block-time", `${hhmm(startHour)}–${hhmm(endHour)}`));
        drawn.push({
          id,
          ref: { kind: "block", block: focus } as GridRef,
          locked: done ? `${focus.title} · already done` : focus.status === "running" ? `${focus.title} · running now` : "",
          start: startHour, end: endHour, column: index, maxHours: BLOCK_MAX_HOURS,
        });
        block.onclick = () => {
          this.chosen = this.chosen === id ? null : id;
          this.changed();
        };
        column.append(block);
        inColumn.push({ block, top, bottom: top + tall });
      }

      /* New events still on their way to Google. */
      for (const one of this.creating.filter(entry => entry.day === day.key)) {
        const block = element("div", `cal-block is-settling${one.kind === "block" ? " is-focus" : ""}`);
        const top = axis.yOf(one.start);
        const tall = Math.max(MIN_BLOCK_PX, axis.yOf(one.end) - top);
        block.style.top = `${top}px`;
        block.style.height = `${tall}px`;
        block.append(element("span", "cal-block-title", one.title));
        column.append(block);
        inColumn.push({ block, top, bottom: top + tall });
      }

      /* Overlaps side by side, so each stays readable and reachable. */
      const lanes = layoutLanes(inColumn);
      for (const [at, { block }] of inColumn.entries()) {
        const { lane, lanes: count } = lanes[at];
        if (count < 2) continue;
        block.style.left = `calc(${(lane / count) * 100}% + 1px)`;
        block.style.width = `calc(${100 / count}% - 2px)`;
        block.style.right = "auto";
        // Three across is too narrow for a time under the title.
        if (count > 2) block.querySelector(".cal-block-time")?.remove();
      }

      /* Now, as a line across today's column. */
      if (day.key === today) {
        const mark = element("i", "cal-wknow");
        mark.style.top = `${axis.yOf(now.getHours() + now.getMinutes() / 60)}px`;
        column.append(mark);
      }
      body.append(column);
    }

    /* ── The bands that offer their hours back ─────────────────────────────
     * ⚠️ Laid over the whole width INCLUDING the gutter, which is why they are
     * children of the body rather than of a column: a strip that stopped at
     * the first column would read as something belonging to Monday. */
    for (const band of axis.bands()) {
      const strip = element("button", "cal-wkband");
      (strip as HTMLButtonElement).type = "button";
      strip.style.top = `${band.top}px`;
      strip.style.height = `${band.px}px`;
      const run = band.from < QUIET_BEFORE ? "early" : "late";
      strip.append(element("span", "cal-wkband-label",
        `${String(band.from).padStart(2, "0")}:00 – ${String(band.to % 24).padStart(2, "0")}:00`));
      strip.dataset.tip = "Show these hours";
      strip.onclick = () => {
        this.opened.add(run);
        this.changed();
      };
      body.append(strip);
    }

    /* ⚠️ The head goes INSIDE the scroller, stuck to the top, rather than
     * staying a sibling above it. A head outside the scroller is a box that
     * never holds a scrollbar sitting over one that does, so it is some
     * fifteen pixels wider — and seven day names drift off the seven columns
     * they name, by more the further right they are. Inside, the two are the
     * same box and cannot disagree; sticky is what stops it scrolling away. */
    const scroller = element("div", "cal-wkscroll");
    const stuck = element("div", "cal-wkstick");
    // The views and the pager stay reachable however far the hours scroll.
    stuck.append(this.viewSwitch(now), head);
    if (allDayBand) stuck.append(allDayBand);
    /* An opened run can be shut again from the same place it was opened. */
    if (this.opened.size) {
      const shut = element("button", "cal-wkreset");
      (shut as HTMLButtonElement).type = "button";
      shut.append(element("span", "", "Hide quiet hours"));
      shut.onclick = () => { this.opened.clear(); this.changed(); };
      stuck.append(shut);
    }
    scroller.append(stuck, body);
    week.append(scroller);

    /* ── The event being drawn ────────────────────────────────────────────
     * ⚠️ Rendered from screen state like everything else, so a poll landing
     * mid-compose redraws it rather than destroying it. */
    if (this.draft) {
      const at = days.findIndex(d => d.key === this.draft!.day);
      if (at >= 0) {
        const { start, end } = this.draft;
        const box = element("div", "cal-block cal-draft");
        const top = axis.yOf(start);
        box.style.top = `${top}px`;
        box.style.height = `${Math.max(MIN_BLOCK_PX, axis.yOf(end) - top)}px`;
        const field = element("input", "cal-draft-field") as HTMLInputElement;
        field.type = "text";
        field.placeholder = this.draft.kind === "block" ? "New block" : "New event";
        field.maxLength = 200;
        field.onkeydown = key => {
          if (key.key === "Enter") { key.preventDefault(); this.commitDraft(field.value); }
          if (key.key === "Escape") { key.preventDefault(); this.cancelDraft(); }
        };
        /* ⚠️ Blur COMMITS rather than cancelling, and only when something was
         * typed. Clicking away from a half-written event and losing it is the
         * more annoying of the two mistakes; Escape is the one that throws it
         * away, and it says so. */
        field.onblur = () => {
          if (!this.draft) { this.soon(); return; }
          if (field.value.trim()) this.commitDraft(field.value); else this.cancelDraft();
        };
        box.append(field);
        /* Through Helm a new thing is a meeting or a block of work. Pressing this
         * doesn't take the caret out of the field. */
        if (this.viaHelm) {
          const kind = element("button", "cal-draft-kind", this.draft.kind === "block" ? "Block" : "Event") as HTMLButtonElement;
          kind.type = "button";
          kind.onmousedown = down => down.preventDefault();
          kind.onclick = () => {
            const draft = this.draft;
            if (!draft) return;
            draft.kind = draft.kind === "block" ? "event" : "block";
            kind.textContent = draft.kind === "block" ? "Block" : "Event";
            field.placeholder = draft.kind === "block" ? "New block" : "New event";
          };
          box.append(kind);
        }
        columns[at].append(box);
        /* ⚠️ The island never takes focus, so a bare `focus()` puts the caret
         * in the DOM and leaves the keystrokes going to whatever is actually
         * in front. The same round trip Today's composer makes. */
        void this.deps.focus(true).then(() => field.focus());
      }
    }

    /* ── The list beside the grid ─────────────────────────────────────────
     * ⚠️ A SIBLING of the grid in a row, not something floated over it: a
     * panel that covered the week would hide the Thursday somebody is trying
     * to drop onto.
     *
     * ⚠️ ALWAYS in the DOM, at zero width when shut — the same bargain
     * `.media-lyrics` makes, and for the same reason. The island is sized
     * from its content and its width is a spring; a panel that is added on
     * open arrives before the room for it does, which is the appearing this
     * replaces. Held at width zero, the island's own spring is the animation
     * and `overflow: hidden` reveals the panel as the room arrives. */
    const row = element("div", "cal-worktop" + (this.tasksOpen ? " has-tasks" : ""));
    /* ── How wide the week is, and why it is written from here ─────────────
     * ⚠️ A FIXED length, which is what makes the reveal work at all — see
     * `.cal-worktop`. But NOT a number typed into the stylesheet: it has to be
     * the room the island actually has with the list shut, or the panel opens
     * into space that is not there and is clipped by the bezel.
     *
     * ⚠️ Derived from the same constant the width table caps the island to,
     * not sampled from the DOM. `render()` runs BEFORE `measure()`, so the
     * host still has the previous width while this is drawing — reading it
     * here would size the week from whatever the island was a moment ago.
     *
     * ⚠️ The scrollbar, though, IS measured. It is a stable number this code
     * cannot know (it depends on the platform and on `scrollbar-width`), it
     * does not change between renders, and leaving it out of the arithmetic
     * clipped the panel by exactly its width — which shows up only as the task
     * titles sitting slightly too close to the edge. */
    const bar = Math.max(0, this.host.offsetWidth - this.host.clientWidth);
    const weekWide = cpx(CALENDAR_WEEK_DPX) - 2 * SCREEN_PAD - bar;
    row.style.setProperty("--cal-week-w", `${Math.max(420, Math.round(weekWide))}px`);
    row.style.setProperty("--cal-tasks-w", `${TASK_PANEL_W}px`);
    row.style.setProperty("--cal-tasks-gap", `${TASK_PANEL_GAP}px`);
    row.append(week, this.taskList(waiting));
    this.host.append(row);

    /* ── Where the grid is scrolled to ────────────────────────────────────
     * ⚠️ The SCREEN BODY is the scroller, not a box inside it. `.screen-body`
     * is already `overflow-y: auto`, and the island's depth is capped at
     * ~507 CSS px — so a grid with its own 440px scroller inside it always
     * overflowed the screen as well, and the panel came up with **two**
     * scrollbars side by side. One scrolling ancestor, and the day names stay
     * put by sticking to it.
     *
     * ⚠️ RESTORED on every render. The shell redraws the whole screen on any
     * of a dozen events — a media tick, a poll, a machine reading — and
     * `replaceChildren` empties the host, which drops its scroll to zero. The
     * grid snapped back to midnight every few seconds whatever anybody was
     * doing.
     *
     * ⚠️ Set SYNCHRONOUSLY, not in a frame callback. The content is in the
     * document and has its height from the axis, so the host is already
     * scrollable — and a restore a frame later is itself a visible jump. */
    this.host.scrollTop = this.scrollAt || Math.max(0, axis.yOf(START_AT_HOUR) - 8);
    /* ⚠️ Attached ONCE, because the host outlives every render. Wiring it here
     * each time would stack a listener per redraw — dozens a minute. */
    if (!this.watchingScroll) {
      this.watchingScroll = true;
      this.host.addEventListener("scroll",
        () => { this.scrollAt = this.host.scrollTop; }, { passive: true });
    }

    if (this.tasksOpen) {
      /* ⚠️ Only while the list is open. The rows are in the DOM at zero width
       * when it is shut, and a drag started on something nobody can see is a
       * gesture that can only confuse. Also why the panel is `inert`.
       *
       * ⚠️ Rows are wired AFTER the grid exists, because the drop needs the
       * columns to hit-test against. */
      for (const row of this.host.querySelectorAll<HTMLElement>("[data-task-row]")) {
        const task = waiting.find(one => one.id === row.dataset.taskRow);
        if (!task) continue;
        wireTaskDrag(row, task, task.title, {
          at: (x, y) => pointOver(columns, axis, x, y),
          busy: on => this.hold(on),
          span: DROP_SPAN,
          drop: (ref, column, hour) => {
            const day = days[column]?.key;
            if (!day) return;
            /* ⚠️ Clamped so a drop near midnight cannot produce an end past
             * the end of the day, which TickTick stores as the next morning
             * and the grid then draws on tomorrow. */
            const from = Math.min(24 - DROP_SPAN, hour);
            this.scheduleTask(ref as Task, atHour(day, from), atHour(day, from + DROP_SPAN));
          },
        });
      }
    }

    if (this.tasksOpen && this.viaHelm) {
      const reading = this.helm!;
      for (const row of this.host.querySelectorAll<HTMLElement>("[data-plan-row]")) {
        const item = reading.items.find(one => one.key === row.dataset.planRow);
        if (!item) continue;
        wireTaskDrag(row, item, item.title, {
          at: (x, y) => pointOver(columns, axis, x, y),
          busy: on => this.hold(on),
          span: Math.min(BLOCK_MAX_HOURS, item.minutes / 60),
          drop: (ref, column, hour) => {
            const day = days[column]?.key;
            if (day) this.planItem(ref as HelmPlanItem, day, hour);
          },
        });
      }
    }

    rememberBlocks(drawn);
    wireWeekEditing(this.host, body, columns, axis, days.map(d => d.key), {
      create: (start, end) => {
        this.draft = {
          day: localDay(start),
          start: start.getHours() + start.getMinutes() / 60,
          // A range drawn to the very end of the day ends on the next day's midnight.
          end: localDay(end) === localDay(start) ? end.getHours() + end.getMinutes() / 60 : 24,
          kind: "event",
        };
        this.chosen = null;
        this.actionError = "";
        this.changed();
      },
      /* ⚠️ One gesture, two stores. The grid does not care which it is
       * dragging; this is the only place that has to. */
      move: (ref, start, end) => {
        const what = ref as GridRef;
        if (what.kind === "event") this.commitMove(what.event, start, end);
        else if (what.kind === "block") this.commitBlock(what.block, start, end);
        else this.scheduleTask(what.task, start, end);
      },
      busy: on => this.hold(on),
      started: () => {
        this.actionError = "";
        if (this.chosen) {
          this.chosen = null;
          this.host.querySelector(".cal-panel")?.remove();
        }
      },
      dismissing: () => !!this.chosen || !!this.draft,
      dismiss: () => {
        if (!this.chosen) return;
        this.chosen = null;
        this.soon();
      },
      repaint: () => this.changed(),
      escapeDown: native ? () => call<boolean>("escape_down") : undefined,
    });
  }

  /** A delivery, a phase's end, a payment: read here, opened where it lives. */
  private markerChip(marker: HelmMarker): HTMLElement {
    const chip = element("button", `cal-chip is-marker is-${marker.kind}${marker.late ? " is-late" : ""}`);
    (chip as HTMLButtonElement).type = "button";
    chip.style.setProperty("--cal", hueOf(marker.hue, marker.context));
    chip.append(element("span", "cal-chip-title", markerLabel(marker, zloty)));
    chip.dataset.tip = marker.context && marker.context !== marker.title ? `${marker.title} · ${marker.context}` : marker.title;
    chip.onclick = () => { void call("helm_open", { path: marker.href }).catch(() => {}); };
    return chip;
  }

  /** Redraws wait for a press to end, and the island stays up however far it goes. */
  private hold(on: boolean) {
    this.holding = on;
    this.deps.hold(on);
    // A timer, so a plain click still lands on the element it was pressed on.
    if (!on && this.owed) this.soon();
  }

  /** Whether a redraw now would take something out from under the person. */
  private heldStill(): boolean {
    if (this.holding) return true;
    const focused = document.activeElement;
    // A field being typed in, not a button that kept focus after its press.
    return focused instanceof HTMLInputElement && this.host.contains(focused)
      && !!focused.closest(".cal-draft, .cal-panel, .cal-quick");
  }

  render() {
    if (this.heldStill()) { this.owed = true; return; }
    this.owed = false;
    this.host.replaceChildren();
    if (!this.feed.connected && !this.helm?.blocks.length) {
      const empty = element("div", "day-empty");
      const connect = element("button", "day-connect", "Connect Google Calendar");
      (connect as HTMLButtonElement).type = "button";
      connect.onclick = () => { void call("open_task_editor").catch(() => {}); };
      empty.append(
        element("h3", "", "Your day, before it starts"),
        element("p", "", "Connect Google Calendar to see what is next."),
        connect,
      );
      this.host.append(empty);
      return;
    }

    if (helmNeedsGoogle(this.helm) || (!this.viaHelm && this.feed.needsSignIn)) this.host.append(this.signInBar());
    const now = new Date();
    if (this.view === "week" || this.view === "day") this.renderWeek(now);
    else {
      this.host.append(this.viewSwitch(now));
      if (this.view === "month") this.renderMonthGrid(now);
      else this.renderMonth(now);
    }

    // The bar already says what the feed's error would.
    const feedError = this.feed.needsSignIn ? "" : this.feed.error;
    if (this.actionError || this.error || feedError) {
      this.host.append(element("p", "screen-error",
        this.actionError || this.error || feedError || ""));
    }
    if (this.chosen) {
      const sheet = this.panelFor(this.chosen);
      if (!sheet) this.chosen = null;
      else if (this.view === "agenda") this.host.append(sheet);
      else this.placeBeside(sheet, this.chosen);
    }
    if (!this.chosen) this.sheetFor = "";

    if (this.scrollTo) this.scrollAgenda(this.scrollTo);
    this.scrollTo = "";
  }

  /** Put a day's heading at the top of the agenda.
   *
   * ⚠️ The nearest heading AT OR AFTER the day, not the day's own. Most days
   * have nothing on them, so most clicks have no heading to scroll to — and
   * the version that looked one up by date did nothing at all on those days,
   * which is indistinguishable from the click not registering.
   *
   * ⚠️ Scrolled by arithmetic, not `scrollIntoView`. The headings are sticky,
   * so the browser considers one already in view when it is stuck to the top
   * over a completely different day — and then does not move. */
  private scrollAgenda(day: string) {
    const panel = this.host.querySelector<HTMLElement>(".cal-agenda");
    if (!panel) return;
    const heads = [...panel.querySelectorAll<HTMLElement>(".cal-day")];
    const target = heads.find(head => (head.dataset.day ?? "") >= day) ?? heads[heads.length - 1];
    if (!target) return;
    requestAnimationFrame(() => {
      panel.scrollTo({
        top: Math.max(0, target.offsetTop - panel.offsetTop),
        behavior: still() ? "auto" : "smooth",
      });
    });
  }
}
