/* The agenda, from Google Calendar.
 *
 * Read-only and deliberately short: a week ahead, grouped by day, with the
 * next thing given a countdown. The island's job is "what is about to happen
 * to me", not calendar management.
 */
import { listen } from "@tauri-apps/api/event";
import { element } from "./task-list";
import { paintIcon, taskIcon } from "./task-icons";
import { call, native } from "./task-client";
import { localDay } from "./task-model";
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

  /** Seven columns from today. Not a Monday-aligned week: the island is a
   *  glance forward, and half a grid of days already gone is half a grid. */
  private renderWeek(now: Date) {
    const grid = element("div", "cal-week");
    for (let offset = 0; offset < 7; offset++) {
      const date = new Date(now);
      date.setDate(date.getDate() + offset);
      const key = localDay(date);
      const column = element("div", `cal-wcol${offset === 0 ? " is-today" : ""}`);
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
      const row = element("div", `cal-row${event.response === "declined" ? " declined" : ""}`);
      row.style.setProperty("--cal", event.color || "#5ac8fa");
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
    if (this.error || this.feed.error) {
      this.host.append(element("p", "screen-error", this.error || this.feed.error || ""));
    }
  }
}
