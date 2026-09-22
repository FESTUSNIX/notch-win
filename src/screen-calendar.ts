/* The agenda, from Google Calendar.
 *
 * Read-only and deliberately short: a week ahead, grouped by day, with the
 * next thing given a countdown. The island's job is "what is about to happen
 * to me", not calendar management.
 */
import { listen } from "@tauri-apps/api/event";
import { element } from "./dom";
import { paintIcon, taskIcon, type TaskIcon } from "./task-icons";
import { call, native } from "./task-client";
import { isQuiet } from "./snooze";
import { isoWeek, localDay, weekStart } from "./task-model";
import { still } from "./motion-pref";
import { atHour, pointOver, rememberBlocks, wireTaskDrag, wireWeekEditing, type Placed } from "./calendar-edit";
import type { Task } from "./task-model";
import { buildAxis, busyHours, quietHours, QUIET_BEFORE } from "./calendar-axis.ts";
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
}

export interface CalendarFeed {
  connected: boolean;
  events: CalEvent[];
  updatedAt: string | null;
  error: string | null;
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
  const length = mins >= 60
    ? `${Math.floor(mins / 60)}h${mins % 60 ? ` ${mins % 60}m` : ""}`
    : `${mins} min`;
  return `${clock(from)} – ${clock(to)} · ${length}`;
}

export function timeLabel(event: CalEvent): string {
  if (event.allDay) return "All day";
  const start = startOf(event);
  return start.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
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
export type CalendarView = "month" | "week";

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

/** What a block on the grid stands for.
 *
 * ⚠️ A UNION, because the week now carries two completely unrelated things
 * that look alike on it: a Google event and a TickTick task. The gesture layer
 * passes one of these back untouched — it never looks inside — so the only
 * place that has to know the difference is the hook that writes the change.
 */
type GridRef = { kind: "event"; event: CalEvent } | { kind: "task"; task: Task };

export class CalendarScreen {
  feed: CalendarFeed = emptyCalendar();
  error = "";
  /** Agenda answers "what is next"; week answers "how is the week shaped".
   *  Both off the same seven-day fetch — no second request, no second model. */
  view: CalendarView = "month";
  /** Whether the week runs Monday to Sunday. ⚠️ A preference, pushed in by
   *  the shell rather than read here: `prefs` lives in tasks.ts, and a screen
   *  that fetched its own would need the event listener as well. */
  /** An event being drawn, before it has a name.
   *
   * ⚠️ Held on the SCREEN rather than as a loose element, so the five-minute
   * poll landing mid-compose redraws the composer instead of throwing away
   * what somebody was in the middle of typing. */
  private draft: { day: string; start: number; end: number } | null = null;

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
    } = {
      create: () => {}, lists: () => [], focus: async () => {},
      tasks: () => [], taskColor: () => "", finishTask: () => {}, width: () => {},
    },
  ) {}

  async boot() {
    if (native) await listen<CalendarFeed>("calendar:changed", e => {
      this.feed = e.payload;
      /* ⚠️ EVERY optimistic move drops here, not just one that matches. A
       * write triggers a full re-read, so this feed is the answer to it. */
      this.settling.clear();
      this.removing.clear();
      this.changed();
    });
    try { this.feed = await call<CalendarFeed>("get_calendar"); } catch { /* not connected */ }
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

  /** The event whose panel is open, by id. */
  private chosen: string | null = null;

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
    sheet.append(head, element("h4", "cal-panel-title", event.title));

    const facts = element("div", "cal-panel-facts");
    const fact = (icon: TaskIcon, text: string) => {
      const row = element("div", "cal-fact");
      const mark = element("span", "cal-fact-mark");
      paintIcon(mark, icon);
      row.append(mark, element("span", "", text));
      facts.append(row);
    };
    if (!event.allDay) fact("clock", spanLabel(event));
    if (event.calendar) fact("calendar", event.calendar);
    if (event.location) fact("system", event.location);
    if (event.response === "declined") fact("close", "You declined this");
    if (facts.childElementCount) sheet.append(facts);

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
    if (this.view === "week" && event.writable && !event.allDay) {
      const drop = element("button", "cal-panel-drop");
      (drop as HTMLButtonElement).type = "button";
      paintIcon(drop, "close");
      drop.append(element("span", "", "Delete"));
      drop.onclick = () => this.commitDelete(event);
      actions.append(drop);
    }
    const inGoogle = element("button", "cal-panel-open");
    (inGoogle as HTMLButtonElement).type = "button";
    inGoogle.append(element("span", "", "Open in Google Calendar"));
    inGoogle.onclick = () => this.open("https://calendar.google.com/calendar/r/day/"
      + (event.allDay ? event.start.slice(0, 10) : localDay(startOf(event))).replace(/-/g, "/"));
    actions.append(inGoogle);
    sheet.append(actions);
    return sheet;
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
          label: this.tasksOpen ? "Hide today's tasks" : "Show today's tasks",
          /* ⚠️ Turning the list on switches to the week. There is nowhere to
           * drop a task on a month grid, so a list beside one would be a
           * drag that can only ever fail. */
          run: () => {
            this.tasksOpen = !this.tasksOpen;
            if (this.tasksOpen) this.view = "week";
            this.deps.width();
            this.changed();
          } },
        { icon: "clock" as const, label: "Refresh the calendar",
          run: () => { void call("refresh_calendar").catch(() => {}); } },
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
    field.className = "cal-tasks-field";
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
    void this.deps.focus(false);
    const start = atHour(draft.day, draft.start);
    const end = atHour(draft.day, draft.end);
    this.changed();
    void call("create_event", {
      title: title.trim(),
      start: start.toISOString(),
      end: end.toISOString(),
    }).catch(problem => {
      this.actionError = String(problem);
      this.changed();
    });
  }

  private cancelDraft() {
    this.draft = null;
    void this.deps.focus(false);
    this.changed();
  }

  /** Move or resize one event. */
  private commitMove(event: CalEvent, start: Date, end: Date) {
    const before = this.settling.get(event.id);
    this.settling.set(event.id, { start: start.toISOString(), end: end.toISOString() });
    this.actionError = "";
    this.changed();
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
    void call("delete_event", { calendarId: event.calendarId, eventId: event.id })
      .catch(problem => {
        this.removing.delete(event.id);
        this.actionError = String(problem);
        this.changed();
      });
  }

  private viewSwitch(): HTMLElement {
    const bar = element("div", "cal-views");
    for (const [name, icon, label] of [["month", "calendar", "Month"], ["week", "grid", "Week"]] as const) {
      const button = element("button", "cal-view", label);
      (button as HTMLButtonElement).type = "button";
      button.setAttribute("aria-pressed", String(this.view === name));
      button.prepend(taskIcon(icon));
      button.onclick = () => {
        /* ⚠️ The width changes with the view as well — month is the narrow
         * one, and leaving the week also shuts the list. */
        if (name !== "week") this.leaveWeek();
        /* ⚠️ The two views scroll different things — a week of hours and a
         * month of days — so a position carried between them is meaningless
         * and usually lands somewhere arbitrary. */
        if (name !== this.view) this.scrollAt = 0;
        this.view = name;
        this.deps.width();
        this.changed();
      };
      bar.append(button);
    }
    return bar;
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
  private renderWeek(now: Date) {
    const today = localDay(now);
    const first = weekStart(now, this.mondayFirst);

    /* ⚠️ Every event resolved through `timesOf` ONCE, here, and the rest of
     * this method reads the result. An optimistic move can change which DAY an
     * event is on, so bucketing off `startOf` while drawing off the pending
     * time would leave a dragged block in Tuesday's column showing Wednesday's
     * hour. */
    const placed = this.feed.events
      .filter(e => !this.removing.has(e.id))
      .map(e => ({ event: e, ...this.timesOf(e) }));

    /* ⚠️ Tasks with a real TIME, laid on the same axis as the events. A task
     * that is merely due today has 00:00 in its `startDate`, and putting those
     * here would stack the whole list at midnight and call it a schedule —
     * they stay in the list beside the grid until somebody drops one. */
    const { placed: timedTasks, waiting } = this.splitTasks();
    const tasks = timedTasks.map(task => {
      const begin = new Date(task.startDate!);
      const due = task.dueDate ? new Date(task.dueDate) : begin;
      /* ⚠️ A floor of half an hour on a task's length. TickTick is happy with
       * a task whose start and due are the same instant — that is what "at
       * 3pm" means there — and a zero-length block is nothing to see or grab. */
      const finish = due.getTime() > begin.getTime() + 60_000
        ? due : new Date(begin.getTime() + 30 * 60_000);
      return { task, begin, finish };
    });

    const days: { key: string; date: Date; events: typeof placed; tasks: typeof tasks }[] = [];
    for (let offset = 0; offset < 7; offset++) {
      const date = new Date(first);
      date.setDate(first.getDate() + offset);
      const key = localDay(date);
      days.push({
        key,
        date,
        events: placed.filter(one =>
          (one.event.allDay ? one.event.start.slice(0, 10) : localDay(one.begin)) === key),
        tasks: tasks.filter(one => localDay(one.begin) === key),
      });
    }

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
    const hoursOf = (one: { begin: Date; finish: Date }) => ({
      start: one.begin.getHours() + one.begin.getMinutes() / 60,
      end: one.finish.getHours() + one.finish.getMinutes() / 60,
    });
    /* ⚠️ Tasks count as busy too. A task dropped at 21:00 has to hold its hour
     * open exactly as a meeting does, or the drop would fold the thing that
     * was just dropped into a collapsed band. */
    const spans = [
      ...days.flatMap(d => d.events.filter(one => !one.event.allDay).map(hoursOf)),
      ...days.flatMap(d => d.tasks.map(hoursOf)),
    ];
    const axis = buildAxis(quietHours(busyHours(spans), this.opened), WEEK_HOUR_PX, SHUT_HOUR_PX);

    const week = element("div", "cal-weekgrid is-work");
    week.style.setProperty("--cal-height", `${axis.height}px`);

    /* ── The head: one column per day, plus the axis gutter ───────────── */
    const head = element("div", "cal-wkhead");
    head.append(element("span", "cal-wkaxis-top", `WK. ${isoWeek(first)}`));
    for (const day of days) {
      const cell = element("div", "cal-wkday"
        + (day.key === today ? " is-today" : "")
        + (day.key < today ? " is-past" : ""));
      cell.append(
        element("span", "cal-wkname", day.date.toLocaleDateString(undefined, { weekday: "short" })),
        element("span", "cal-wknum", String(day.date.getDate())),
      );
      head.append(cell);
    }

    /* ── All-day events, above the axis ────────────────────────────────
     * ⚠️ A band of their own. An all-day event has no start time, so laying it
     * on an hour axis means inventing one — and a birthday drawn across
     * 00:00–23:59 swamps every meeting in the column. */
    let allDayBand: HTMLElement | null = null;
    if (days.some(d => d.events.some(one => one.event.allDay))) {
      const band = element("div", "cal-wkall");
      band.append(element("span", "cal-wkall-label", "All day"));
      for (const day of days) {
        const cell = element("div", "cal-wkall-cell");
        for (const { event } of day.events.filter(one => one.event.allDay)) {
          const chip = element("span", "cal-chip");
          chip.style.setProperty("--cal", event.color || "var(--cool)");
          chip.append(element("span", "cal-chip-title", event.title));
          chip.dataset.tip = event.title;
          cell.append(chip);
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
        String(row.hour).padStart(2, "0"));
      mark.style.top = `${row.top}px`;
      /* A collapsed hour has no room for its own number; the band says the
       * range instead. */
      if (!row.open) mark.textContent = "";
      gutter.append(mark);
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
        const line = element("i", "cal-wkline" + (row.open ? "" : " is-shut"));
        line.style.top = `${row.top}px`;
        line.style.height = `${row.px}px`;
        column.append(line);
      }

      for (const { event, begin, finish: end } of day.events.filter(one => !one.event.allDay)) {
        const startHour = begin.getHours() + begin.getMinutes() / 60;
        const endHour = Math.max(startHour + 0.25, end.getHours() + end.getMinutes() / 60);
        drawn.push({
          id: event.id,
          ref: { kind: "event", event } as GridRef,
          locked: event.writable ? "" : `${event.title} · ${event.calendar} is read-only`,
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
        block.dataset.tip = `${timeLabel(event)} · ${event.title}`;
        block.append(element("span", "cal-block-title", event.title));
        /* ⚠️ Gated on the block's REAL height in pixels. Two lines of type need
         * about 34 — so "an hour is long enough for a time" put a second line
         * into a block that could not hold the first, and the title was
         * clipped away leaving a block labelled only with its start time. */
        if (tall >= 34) block.append(element("span", "cal-block-time", timeLabel(event)));
        block.onclick = () => {
          this.chosen = this.chosen === event.id ? null : event.id;
          this.changed();
        };
        column.append(block);
      }

      /* ── Tasks, on the same grid and deliberately not identical ────────
       * ⚠️ A checkbox and a flatter surface. They sit on the same axis as the
       * meetings because that is the whole point of dropping one here — but a
       * task is something you will do and a meeting is something that will
       * happen to you, and a grid where the two are indistinguishable is a
       * grid that cannot answer "how much of Thursday is already spoken
       * for". */
      for (const { task, begin, finish } of day.tasks) {
        const startHour = begin.getHours() + begin.getMinutes() / 60;
        const endHour = Math.max(startHour + 0.25, finish.getHours() + finish.getMinutes() / 60);
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
          block.append(element("span", "cal-block-time",
            begin.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })));
        }
        block.dataset.tip = task.title;
        column.append(block);
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
    stuck.append(head);
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
        field.placeholder = "New event";
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
          if (!this.draft) return;
          if (field.value.trim()) this.commitDraft(field.value); else this.cancelDraft();
        };
        box.append(field);
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

    rememberBlocks(drawn);
    wireWeekEditing(body, columns, axis, days.map(d => d.key), {
      create: (start, end) => {
        this.draft = {
          day: localDay(start),
          start: start.getHours() + start.getMinutes() / 60,
          end: end.getHours() + end.getMinutes() / 60,
        };
        this.actionError = "";
        this.changed();
      },
      /* ⚠️ One gesture, two stores. The grid does not care which it is
       * dragging; this is the only place that has to. */
      move: (ref, start, end) => {
        const what = ref as GridRef;
        if (what.kind === "event") this.commitMove(what.event, start, end);
        else this.scheduleTask(what.task, start, end);
      },
      say: message => {
        if (this.actionError === message) return;
        this.actionError = message;
        this.changed();
      },
    });
  }


  render() {
    this.host.replaceChildren();
    if (!this.feed.connected) {
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

    this.host.append(this.viewSwitch());
    const now = new Date();
    if (this.view === "week") this.renderWeek(now);
    else this.renderMonth(now);

    if (this.actionError || this.error || this.feed.error) {
      this.host.append(element("p", "screen-error",
        this.actionError || this.error || this.feed.error || ""));
    }
    if (this.chosen) {
      const open = this.feed.events.find(e => e.id === this.chosen);
      if (open) this.host.append(this.panel(open));
      else this.chosen = null;
    }

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
