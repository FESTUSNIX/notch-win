import { hueOf } from "./helm-link.ts";

/* The calendar's reading from Helm (`/api/notch/calendar`), and what the screen
 * makes of it. Helm owns blocks, markers, what's still to plan and prep notes, and
 * holds the one Google login, so with Helm connected this is the calendar's source.
 *
 * No runtime imports, so `node --test` can load it directly (see helm-link.ts).
 */

export interface HelmCalEvent {
  /** `<calendar id>:<event id>`, unique across calendars. */
  id: string;
  googleId: string;
  calendarId: string;
  title: string;
  day: string;
  endDay: string;
  /** Minutes since midnight; absent on an all-day event. */
  start?: number;
  end?: number;
  place?: string;
  meetUrl?: string;
  url?: string;
  note?: string;
  response?: string;
  /** Helm may change it: his own calendar, no other guests. */
  editable: boolean;
}

export interface HelmBlock {
  id: number;
  day: string;
  title: string;
  projectId: number | null;
  workItemId: number | null;
  plannedAt: string | null;
  minutes: number;
  status: "planned" | "running" | "paused" | "done" | "skipped";
  elapsedSeconds: number;
}

export interface HelmMarker {
  key: string;
  kind: "delivery" | "phase" | "payment" | "booking" | "off";
  day: string;
  title: string;
  context: string;
  hue: string;
  href: string;
  amount: number | null;
  late: boolean;
}

export interface HelmPlanItem {
  key: string;
  kind: string;
  title: string;
  context: string | null;
  hue: string;
  minutes: number;
  projectId: number | null;
  workItemId: number | null;
  taskId: number | null;
  dealId: number | null;
  blockId: number | null;
  dueOn: string | null;
  covered: boolean;
}

export interface HelmMeetingMatch {
  clientId: number | null;
  dealId: number | null;
  name: string;
  hue: string;
  projects: { id: number; name: string }[];
  logged: { projectName: string; minutes: number } | null;
}

export interface HelmPrep {
  headline: string;
  status: string[];
  cover: string[];
  ask: string[];
  watch: string[];
}

export interface HelmCalendar {
  status: "ok" | "unconfigured" | "disconnected" | "expired" | "error";
  email: string | null;
  message: string | null;
  canWrite: boolean;
  calendars: { id: string; name: string; hue: string; primary: boolean; writable: boolean }[];
  events: HelmCalEvent[];
  blocks: HelmBlock[];
  markers: HelmMarker[];
  items: HelmPlanItem[];
  marks: { id: number; name: string; hue: string }[];
  meetings: Record<string, HelmMeetingMatch>;
  preps: Record<string, HelmPrep>;
  from: string;
  to: string;
  today: string;
  now: number;
}

/** Whether Helm has lost Google, which only signing in again in Helm can mend. */
export const helmNeedsGoogle = (reading: HelmCalendar | null): boolean =>
  !!reading && (reading.status === "expired" || reading.status === "disconnected");

const pad = (n: number) => String(n).padStart(2, "0");

/** The next day of a `YYYY-MM-DD`. */
export function dayAfter(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const next = new Date(y, m - 1, d + 1);
  return `${next.getFullYear()}-${pad(next.getMonth() + 1)}-${pad(next.getDate())}`;
}

/** The instant for a day and minutes since its midnight (which may reach 24:00). */
export function atMinutes(day: string, minutes: number): Date {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d, 0, minutes, 0, 0);
}

/** Helm's event in the shape every screen and peek reads. */
export function calEventFrom(e: HelmCalEvent, reading: HelmCalendar) {
  const calendar = reading.calendars.find(one => one.id === e.calendarId);
  const allDay = e.start === undefined;
  return {
    id: e.id,
    googleId: e.googleId,
    viaHelm: true,
    title: e.title,
    start: allDay ? e.day : atMinutes(e.day, e.start!).toISOString(),
    // Google's all-day end is exclusive; Helm's `endDay` is the last day.
    end: allDay ? dayAfter(e.endDay) : atMinutes(e.day, e.end!).toISOString(),
    allDay,
    location: e.place ?? "",
    meetingUrl: e.meetUrl ?? "",
    calendar: calendar?.name ?? "",
    calendarId: e.calendarId,
    color: hueOf(calendar?.hue, calendar?.name ?? ""),
    writable: e.editable && reading.canWrite,
    response: e.response ?? "",
    url: e.url,
    note: e.note,
  };
}

/** A block's start in minutes, from its `HH:MM`; null when it has no time yet. */
export function blockStart(block: Pick<HelmBlock, "plannedAt">): number | null {
  if (!block.plannedAt) return null;
  return Number(block.plannedAt.slice(0, 2)) * 60 + Number(block.plannedAt.slice(3, 5));
}

/** The working day free time is counted in, as Helm's `free-time.ts`. */
export const WORK_START = 9 * 60;
export const WORK_END = 17 * 60;

export interface MinuteSpan {
  start: number;
  end: number;
}

/** What's left of a working day, in minutes: from now on today, none on a past day
 *  or a weekend (null, so nothing is drawn). The same rule as Helm's `dayFree`. */
export function freeOn(busy: MinuteSpan[], day: string, today: string, now: number): number | null {
  if (day < today) return null;
  const [y, m, d] = day.split("-").map(Number);
  const weekday = new Date(y, m - 1, d).getDay();
  if (weekday === 0 || weekday === 6) return null;
  const from = day === today ? Math.max(WORK_START, now) : WORK_START;
  if (from >= WORK_END) return 0;
  let free = 0;
  let cursor = from;
  for (const span of [...busy].sort((a, b) => a.start - b.start)) {
    if (span.end <= cursor) continue;
    if (span.start >= WORK_END) break;
    if (span.start > cursor) free += span.start - cursor;
    cursor = Math.max(cursor, span.end);
  }
  if (cursor < WORK_END) free += WORK_END - cursor;
  return free;
}

/** `3h 30`, `45m`, `2h`. */
export function shortLength(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  return minutes % 60 ? `${h}h ${pad(minutes % 60)}` : `${h}h`;
}

/** What a marker says on its chip. */
export function markerLabel(marker: Pick<HelmMarker, "kind" | "title" | "context" | "amount">, money: (n: number) => string): string {
  if (marker.kind === "payment" && marker.amount !== null) return `${money(marker.amount)} ${marker.context}`.trim();
  if (marker.kind === "delivery") return `${marker.title}`;
  return marker.title;
}

/** What's worth a place on the rail: not yet planned in full, soonest due first
 *  within the order Helm already put them in. */
export function railItems(items: HelmPlanItem[]): HelmPlanItem[] {
  return items.filter(item => !item.covered);
}

/** Where a calendar's events sit in a palette, by Helm's hue for it. */
export function calendarHue(reading: HelmCalendar, calendarId: string): string | null {
  return reading.calendars.find(one => one.id === calendarId)?.hue ?? null;
}

/** The calendar a new event goes on: his primary, if he may write to it. */
export function newEventCalendar(reading: HelmCalendar): string | null {
  const writable = reading.calendars.filter(one => one.writable);
  return (writable.find(one => one.primary) ?? writable[0])?.id ?? null;
}
