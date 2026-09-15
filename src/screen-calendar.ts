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
import { localDay, weekStart } from "./task-model";
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

export type CalendarView = "agenda" | "week";

export class CalendarScreen {
  feed: CalendarFeed = emptyCalendar();
  error = "";
  /** Agenda answers "what is next"; week answers "how is the week shaped".
   *  Both off the same seven-day fetch — no second request, no second model. */
  view: CalendarView = "agenda";
  /** Whether the week runs Monday to Sunday. ⚠️ A preference, pushed in by
   *  the shell rather than read here: `prefs` lives in tasks.ts, and a screen
   *  that fetched its own would need the event listener as well. */
  private mondayFirst = true;

  setWeekStart(mondayFirst: boolean) {
    if (this.mondayFirst === mondayFirst) return;
    this.mondayFirst = mondayFirst;
    this.changed();
  }

  constructor(private host: HTMLElement, private changed: () => void) {}

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
    for (const [name, icon, label] of [["agenda", "agenda", "Agenda"], ["week", "grid", "Week"]] as const) {
      const button = element("button", "cal-view", label);
      (button as HTMLButtonElement).type = "button";
      button.setAttribute("aria-pressed", String(this.view === name));
      button.prepend(taskIcon(icon));
      button.onclick = () => { this.view = name; this.changed(); };
      bar.append(button);
    }
    return bar;
  }

  /** The week today falls in, Monday first.
   *
   * ⚠️ This used to be "seven columns FROM today", on the argument that the
   * island is a glance forward and half a grid of days already gone is half a
   * grid. That is a fair argument and it lost to a simpler one: a column whose
   * weekday changes every morning cannot be read at a glance at all, because
   * the thing you are glancing at is where Thursday is. Days already gone are
   * dimmed rather than dropped. */
  private renderWeek(now: Date) {
    const grid = element("div", "cal-week");
    const today = localDay(now);
    const first = weekStart(now, this.mondayFirst);
    for (let offset = 0; offset < 7; offset++) {
      const date = new Date(first);
      date.setDate(first.getDate() + offset);
      const key = localDay(date);
      const column = element("div",
        `cal-wcol${key === today ? " is-today" : ""}${key < today ? " is-past" : ""}`);
      const head = element("div", "cal-whead");
      head.append(
        element("span", "cal-wday", date.toLocaleDateString([], { weekday: "short" })),
        element("span", "cal-wnum", String(date.getDate())),
      );
      column.append(head);
      const events = this.feed.events.filter(e =>
        (e.allDay ? e.start.slice(0, 10) : localDay(startOf(e))) === key);
      if (!events.length) column.append(element("span", "cal-wnone", "—"));
      for (const event of events) {
        const chip = element("div", `cal-chip${event.response === "declined" ? " declined" : ""}`);
        chip.style.setProperty("--cal", event.color || "#5ac8fa");
        chip.title = `${timeLabel(event)} · ${event.title}`;
        if (!event.allDay) chip.append(element("span", "cal-chip-time", timeLabel(event)));
        chip.append(element("span", "cal-chip-title", event.title));
        if (event.meetingUrl) chip.onclick = () => this.open(event.meetingUrl);
        column.append(chip);
      }
      grid.append(column);
    }
    this.host.append(grid);
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
    if (this.view === "week") {
      this.renderWeek(now);
      if (this.error || this.feed.error) {
        this.host.append(element("p", "screen-error", this.error || this.feed.error || ""));
      }
      return;
    }
    const upcoming = this.feed.events.filter(e => endOf(e) > now);
    if (!upcoming.length) {
      const empty = element("div", "day-empty");
      empty.append(element("h3", "", "Nothing ahead"), element("p", "", "No events in the next week."));
      this.host.append(empty);
      if (this.feed.error) this.host.append(element("p", "screen-error", this.feed.error));
      return;
    }

    const next = nextEvent(this.feed.events, now);
    if (next) {
      const banner = element("div", "cal-next");
      banner.append(
        element("span", "cal-next-when", countdown(now, startOf(next))),
        element("span", "cal-next-title", next.title),
      );
      if (next.color) banner.style.setProperty("--cal", next.color);
      this.host.append(banner);
    }

    let day = "";
    for (const event of upcoming) {
      const eventDay = event.allDay ? event.start.slice(0, 10) : localDay(startOf(event));
      if (eventDay !== day) {
        day = eventDay;
        this.host.append(element("h4", "cal-day", dayHeading(day)));
      }
      /* ⚠️ A button, and TINTED rather than striped. The 3px left rail was the
       * one decoration on this surface that said nothing the colour could not
       * say by itself — and it is the shape every generated calendar has. The
       * card carries the calendar's colour as a wash instead. */
      const row = element("button", `cal-row${event.response === "declined" ? " declined" : ""}`
        + (this.chosen === event.id ? " is-open" : ""));
      (row as HTMLButtonElement).type = "button";
      row.style.setProperty("--cal", event.color || "#5ac8fa");
      row.onclick = () => {
        this.chosen = this.chosen === event.id ? null : event.id;
        this.changed();
      };
      row.append(element("span", "cal-time", timeLabel(event)));
      const body = element("div", "cal-body");
      body.append(element("span", "cal-title", event.title));
      const detail = [event.calendar, event.location].filter(Boolean).join(" · ");
      if (detail) body.append(element("span", "cal-detail", detail));
      row.append(body);
      if (event.meetingUrl) {
        const join = element("button", "cal-join");
        (join as HTMLButtonElement).type = "button";
        join.setAttribute("aria-label", `Join ${event.title}`);
        join.title = "Join";
        paintIcon(join, "join");
        join.onclick = () => this.open(event.meetingUrl);
        row.append(join);
      }
      this.host.append(row);
    }
    /* The panel goes LAST so it paints over the list, and is anchored to the
     * screen rather than to the row — a row near the bottom would otherwise
     * open a panel half off the island. */
    const chosen = upcoming.find(event => event.id === this.chosen);
    if (chosen) this.host.append(this.panel(chosen));
    if (this.error || this.feed.error) {
      this.host.append(element("p", "screen-error", this.error || this.feed.error || ""));
    }
  }
}
