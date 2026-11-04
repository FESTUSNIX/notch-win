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

/** A time as he types it: 15:30, 15.30, 1530, 15. Null when it isn't one. */
export function parseClock(text: string): number | null {
  const clean = text.trim();
  const parts = /^(\d{1,2})(?:[:.](\d{1,2}))?$/.exec(clean) ?? /^(\d{2})(\d{2})$/.exec(clean);
  if (!parts) return null;
  const hour = Number(parts[1]);
  const minute = Number(parts[2] ?? 0);
  if (hour > 24 || minute > 59 || (hour === 24 && minute > 0)) return null;
  return hour + minute / 60;
}

/** A month's grid: from the start of the week holding the 1st to the end of the week
 *  holding the last, so five rows or six as the month needs. */
export function monthCells(year: number, month: number, mondayFirst: boolean): Date[] {
  const first = new Date(year, month, 1);
  const back = (first.getDay() - (mondayFirst ? 1 : 0) + 7) % 7;
  const last = new Date(year, month + 1, 0).getDate();
  const count = Math.ceil((back + last) / 7) * 7;
  return Array.from({ length: count }, (_, at) => new Date(year, month, 1 - back + at));
}

/** One line in a month's day. */
export interface MonthEntry {
  id: string;
  title: string;
  /** Hours of the day; null on an all-day thing. */
  start: number | null;
  end: number | null;
  color: string;
  /** Which project a block is for, so several fold into one line. */
  project: { id: number; name: string } | null;
  isBlock: boolean;
  done: boolean;
}

/** Several blocks for one project, as one line with their time. */
export interface MonthFold {
  project: { id: number; name: string };
  color: string;
  minutes: number;
  ids: string[];
  allDone: boolean;
}

/** All-day first, then by time, with two or more blocks for a project folded where the first starts. */
export function monthLines(entries: MonthEntry[]): (MonthEntry | MonthFold)[] {
  const sorted = [...entries].sort((a, b) => (a.start ?? -1) - (b.start ?? -1));
  const counts = new Map<number, MonthEntry[]>();
  for (const one of sorted) {
    if (!one.isBlock || !one.project) continue;
    counts.set(one.project.id, [...(counts.get(one.project.id) ?? []), one]);
  }
  const placed = new Set<number>();
  return sorted.flatMap((one): (MonthEntry | MonthFold)[] => {
    const group = one.isBlock && one.project ? counts.get(one.project.id) : undefined;
    if (!group || group.length < 2) return [one];
    if (placed.has(one.project!.id)) return [];
    placed.add(one.project!.id);
    return [{
      project: one.project!,
      color: one.color,
      minutes: group.reduce((total, block) => total + Math.round(((block.end ?? 0) - (block.start ?? 0)) * 60), 0),
      ids: group.map(block => block.id),
      allDone: group.every(block => block.done),
    }];
  });
}

/** How many lines fit in a day of this height: the date takes a row of its own. */
export function linesThatFit(rowPx: number): number {
  return Math.max(1, Math.floor((rowPx - 26) / 19));
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
