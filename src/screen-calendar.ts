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
import { isoWeek, localDay, weekStart } from "./task-model";
import { still } from "./motion-pref";
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
  color: string;
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

/** How tall one hour of the week grid is.
 *
 * ⚠️ Must match `.cal-wkbody`'s `calc(var(--cal-hours) * 22px)` in tasks.css.
 * It is here because the code has to know how many PIXELS a meeting comes to
 * before deciding whether a second line of type fits in it — a decision made
 * in hours puts two lines into a block that cannot hold one. */
const HOUR_PX = 22;

export class CalendarScreen {
  feed: CalendarFeed = emptyCalendar();
  error = "";
  /** Agenda answers "what is next"; week answers "how is the week shaped".
   *  Both off the same seven-day fetch — no second request, no second model. */
  view: CalendarView = "month";
  /** Whether the week runs Monday to Sunday. ⚠️ A preference, pushed in by
   *  the shell rather than read here: `prefs` lives in tasks.ts, and a screen
   *  that fetched its own would need the event listener as well. */
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
      create: (title: string, day: string) => void;
      /** ⚠️ Lift `WS_EX_NOACTIVATE`, or a field here cannot be typed into.
       *  The island never takes focus — that is the whole point of it — so a
       *  `focus()` on its own puts the caret in the DOM and leaves the
       *  keystrokes going to whatever application is actually in front. It is
       *  the same round trip Today's composer makes; see `set_task_input`. */
      focus: (active: boolean) => Promise<void>;
    } = { create: () => {}, focus: async () => {} },
  ) {}

  async boot() {
    if (native) await listen<CalendarFeed>("calendar:changed", e => { this.feed = e.payload; this.changed(); });
    try { this.feed = await call<CalendarFeed>("get_calendar"); } catch { /* not connected */ }
    this.changed();
  }

  activity(): Activity | null {
    const next = nextEvent(this.feed.events);
    if (!next) return null;
    const now = new Date();
    const minutes = (startOf(next).getTime() - now.getTime()) / 60000;
    // Only claim the pill when it is imminent. A meeting at four o'clock is
    // not news at nine, and it would sit on top of the day's progress all day.
    if (minutes > 30) return null;
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

  private viewSwitch(): HTMLElement {
    const bar = element("div", "cal-views");
    for (const [name, icon, label] of [["month", "calendar", "Month"], ["week", "grid", "Week"]] as const) {
      const button = element("button", "cal-view", label);
      (button as HTMLButtonElement).type = "button";
      button.setAttribute("aria-pressed", String(this.view === name));
      button.prepend(taskIcon(icon));
      button.onclick = () => { this.view = name; this.changed(); };
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

  private shownMonth(now: Date): Date {
    return new Date(now.getFullYear(), now.getMonth() + this.monthOffset, 1);
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

    /* ── The head: the month, a way to add, and the pager ─────────────── */
    const head = element("div", "cal-month-head");
    const name = element("b", "cal-month-name",
      first.toLocaleDateString(undefined, { month: "long" }).toUpperCase());
    const add = element("button", `cal-add${this.composing ? " is-on" : ""}`);
    (add as HTMLButtonElement).type = "button";
    add.setAttribute("aria-label", "New task");
    add.setAttribute("aria-expanded", String(this.composing));
    add.title = "New task";
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
      button.title = label;
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
    const busy = new Map<string, number>();
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
      // Hand the keyboard back, or the island stays unfoldable and the next
      // thing you type still goes to it.
      void this.deps.focus(false).catch(() => {});
      this.changed();
    };
    const commit = () => {
      const value = field.value.trim();
      if (!value) return;
      this.deps.create(value, this.chosenDay || localDay(now));
      close();
    };
    add.onclick = commit;
    field.onkeydown = event => {
      if (event.key === "Enter") { event.preventDefault(); commit(); }
      if (event.key === "Escape") close();
    };
    row.append(when, field, add);
    sheet.append(row);
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
      join.title = "Join";
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
    const days: { key: string; date: Date; events: CalEvent[] }[] = [];
    for (let offset = 0; offset < 7; offset++) {
      const date = new Date(first);
      date.setDate(first.getDate() + offset);
      const key = localDay(date);
      days.push({
        key,
        date,
        events: this.feed.events.filter(e =>
          (e.allDay ? e.start.slice(0, 10) : localDay(startOf(e))) === key),
      });
    }

    const timed = days.flatMap(d => d.events.filter(e => !e.allDay));
    const hours = timed.flatMap(e => [startOf(e).getHours(), endOf(e).getHours() + 1]);
    /* 8 to 19 with nothing on, which is the shape of a working day — and it
     * widens to whatever is actually booked rather than the other way round. */
    const from = Math.max(0, Math.min(8, ...hours));
    const to = Math.min(24, Math.max(19, ...hours));
    const span = Math.max(1, to - from);

    const week = element("div", "cal-weekgrid");
    week.style.setProperty("--cal-hours", String(span));

    /* ── The head: one column per day, plus the axis gutter ───────────── */
    const head = element("div", "cal-wkhead");
    head.append(element("span", "cal-wkaxis-top",
      `WK. ${isoWeek(first)}`));
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
    week.append(head);

    /* ── All-day events, above the axis ────────────────────────────────
     * ⚠️ A band of their own. An all-day event has no start time, so laying it
     * on an hour axis means inventing one — and a birthday drawn across
     * 00:00–23:59 swamps every meeting in the column. */
    const allDay = days.some(d => d.events.some(e => e.allDay));
    if (allDay) {
      const band = element("div", "cal-wkall");
      band.append(element("span", "cal-wkall-label", "All day"));
      for (const day of days) {
        const cell = element("div", "cal-wkall-cell");
        for (const event of day.events.filter(e => e.allDay)) {
          const chip = element("span", "cal-chip");
          chip.style.setProperty("--cal", event.color || "var(--cool)");
          chip.append(element("span", "cal-chip-title", event.title));
          chip.title = event.title;
          band.append(cell);
          cell.append(chip);
        }
        if (!cell.parentElement) band.append(cell);
      }
      week.append(band);
    }

    /* ── The body: an hour axis and seven columns over it ─────────────── */
    const body = element("div", "cal-wkbody");
    const axis = element("div", "cal-wkaxis");
    for (let h = from; h < to; h++) {
      axis.append(element("span", "", `${String(h).padStart(2, "0")}`));
    }
    body.append(axis);

    for (const day of days) {
      const column = element("div", "cal-wkcol"
        + (day.key === today ? " is-today" : "")
        + (day.key < today ? " is-past" : ""));
      for (let h = from; h < to; h++) column.append(element("i", "cal-wkline"));

      for (const event of day.events.filter(e => !e.allDay)) {
        const begin = startOf(event);
        const end = endOf(event);
        const startHour = begin.getHours() + begin.getMinutes() / 60;
        const endHour = Math.max(startHour + 0.25, end.getHours() + end.getMinutes() / 60);
        const block = element("button", `cal-block${event.response === "declined" ? " declined" : ""}`
          + (this.chosen === event.id ? " is-open" : ""));
        (block as HTMLButtonElement).type = "button";
        block.style.setProperty("--cal", event.color || "var(--cool)");
        block.style.top = `${((startHour - from) / span) * 100}%`;
        /* ⚠️ A floor on the height, not just on the maths. A fifteen-minute
         * stand-up is 2% of a twelve-hour axis — four pixels, with no room for
         * a title and nothing to press. */
        block.style.height = `max(${HOUR_PX}px, ${((endHour - startHour) / span) * 100}%)`;
        block.title = `${timeLabel(event)} · ${event.title}`;
        block.append(element("span", "cal-block-title", event.title));
        /* ⚠️ Gated on PIXELS, not on hours. An hour is 22px here, and two lines
         * of type need about 34 — so "an hour is long enough for a time" put a
         * second line into a block that could not hold the first, and the title
         * was clipped away leaving a block labelled only with its start time. */
        if ((endHour - startHour) * HOUR_PX >= 34) {
          block.append(element("span", "cal-block-time", timeLabel(event)));
        }
        block.onclick = () => {
          this.chosen = this.chosen === event.id ? null : event.id;
          this.changed();
        };
        column.append(block);
      }

      /* Now, as a line across today's column. ⚠️ Only when it is inside the
       * axis: at seven in the morning it would otherwise be pinned to the top
       * of the grid, claiming eight o'clock. */
      const nowHour = now.getHours() + now.getMinutes() / 60;
      if (day.key === today && nowHour >= from && nowHour <= to) {
        const mark = element("i", "cal-wknow");
        mark.style.top = `${((nowHour - from) / span) * 100}%`;
        column.append(mark);
      }
      body.append(column);
    }
    week.append(body);
    this.host.append(week);
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

    if (this.error || this.feed.error) {
      this.host.append(element("p", "screen-error", this.error || this.feed.error || ""));
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
