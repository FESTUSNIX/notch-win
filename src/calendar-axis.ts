/* The hour axis of the week grid, when not every hour is the same height.
 *
 * ⚠️ The grid used to map an hour to a PERCENTAGE of a fixed span, which is
 * only right while every hour is worth the same. Quiet hours collapse now, so
 * the axis is piecewise: a run of hours at full height, a band of folded-away
 * ones, another run. A percentage cannot say that, and the two places that need to
 * agree about it — the renderer laying blocks out and the gesture layer
 * turning a pointer into a time — would have to each carry their own copy of
 * the arithmetic.
 *
 * ⚠️ PURE, and no DOM in it. Everything here is numbers, which is the half of
 * a calendar that can be checked without a browser — see `tests/calendar-axis`.
 */

/** The finest slice a drag can land on, in hours. ⚠️ Quarter of an hour,
 *  because that is what meetings are made of. */
export const SNAP = 0.25;

export interface AxisRow {
  /** Hour of the day, 0..23. */
  hour: number;
  /** How tall this hour is drawn, in px. */
  px: number;
  /** Whether it is at full height. */
  open: boolean;
  /** Distance from the top of the axis to the top of this hour, in px. */
  top: number;
}

export interface Axis {
  rows: AxisRow[];
  /** The whole axis, in px. */
  height: number;
  openPx: number;
  shutPx: number;
  /** Where an hour-of-day sits, in px from the top. */
  yOf(hour: number): number;
  /** What hour-of-day a point is over, snapped. */
  hourAt(y: number): number;
  /** Runs of collapsed hours, for the bands that offer to open them. */
  bands(): { from: number; to: number; top: number; px: number }[];
}

/** The least a run of collapsed hours may come to, in px.
 *
 * ⚠️ A floor on the RUN, not on the hour, and the two are different in the
 * case that matters. Per-hour, a seven-hour night at a clickable size is a
 * 90px slab — which is not collapsed in any useful sense — while a size small
 * enough to make that night thin leaves a single collapsed hour as a 6px line
 * nobody can hit. A run stays thin and still gets a target. */
const MIN_BAND = 24;

/**
 * @param open   whether an hour is drawn at full height
 * @param openPx height of an open hour
 * @param shutPx height of a collapsed one
 */
export function buildAxis(open: (hour: number) => boolean, openPx: number, shutPx: number): Axis {
  /* ⚠️ Heights first, positions second. A run's hours can be grown to reach
   * `MIN_BAND`, which moves everything after them — so nothing can be given a
   * `top` until every height is settled. The version that assigned both in one
   * pass had the bands in the right place and every hour after them wrong. */
  const heights = Array.from({ length: 24 }, (_, hour) => open(hour) ? openPx : shutPx);
  for (let hour = 0; hour < 24; hour++) {
    if (open(hour)) continue;
    let last = hour;
    while (last + 1 < 24 && !open(last + 1)) last++;
    const count = last - hour + 1;
    if (count * shutPx < MIN_BAND) {
      const each = Math.ceil(MIN_BAND / count);
      for (let at = hour; at <= last; at++) heights[at] = each;
    }
    hour = last;
  }

  const rows: AxisRow[] = [];
  let top = 0;
  for (let hour = 0; hour < 24; hour++) {
    rows.push({ hour, px: heights[hour], open: open(hour), top });
    top += heights[hour];
  }
  const height = top;

  const yOf = (hour: number): number => {
    if (hour <= 0) return 0;
    if (hour >= 24) return height;
    const whole = Math.floor(hour);
    const row = rows[whole];
    /* ⚠️ A fraction inside a COLLAPSED hour resolves to the top of it, not to
     * a proportion of its few pixels. Half past three in a collapsed band is not a
     * position anybody can see or aim at, and pretending otherwise puts two
     * different events on the same pixel and calls them different times. */
    if (!row.open) return row.top;
    return row.top + (hour - whole) * row.px;
  };

  const hourAt = (y: number): number => {
    if (y <= 0) return 0;
    if (y >= height) return 24;
    /* Linear scan: 24 rows, and it runs once per pointermove. A binary search
     * here would be a cleverness nobody can check against the drawing. */
    for (const row of rows) {
      if (y >= row.top + row.px) continue;
      if (!row.open) return row.hour;
      const part = (y - row.top) / row.px;
      return Math.round((row.hour + part) / SNAP) * SNAP;
    }
    return 24;
  };

  const bands = () => {
    const out: { from: number; to: number; top: number; px: number }[] = [];
    let run: { from: number; to: number; top: number; px: number } | null = null;
    for (const row of rows) {
      if (row.open) { if (run) { out.push(run); run = null; } continue; }
      if (run) { run.to = row.hour + 1; run.px += row.px; }
      else run = { from: row.hour, to: row.hour + 1, top: row.top, px: row.px };
    }
    if (run) out.push(run);
    return out;
  };

  return { rows, height, openPx, shutPx, yOf, hourAt, bands };
}

/** The hours this app treats as quiet, before anybody opens them.
 *
 * ⚠️ Before 07:00 and from 20:00, which is the shape of a day rather than a
 * measurement of one. The point is not to be right about when somebody sleeps
 * — it is that a grid opening on all 24 hours spends two thirds of its height
 * on hours nothing ever happens in, and the working day comes out too small to
 * aim at. Anything actually booked overrides it; see `quietHours`. */
export const QUIET_BEFORE = 7;
export const QUIET_FROM = 20;

/**
 * Which hours to collapse.
 *
 * ⚠️ An hour holding an event is NEVER collapsed, whatever the defaults or the
 * preference say. Collapsing is a way to spend less height on nothing; the
 * moment it hides something it has stopped doing that and started lying about
 * the week. A 06:30 run and a 21:00 dinner keep their own hours open, and the
 * band closes around them.
 *
 * @param busy    hours that have something in them
 * @param opened  runs the user has opened by hand: "early", "late"
 */
export function quietHours(busy: Set<number>, opened: Set<string>): (hour: number) => boolean {
  return (hour: number) => {
    if (busy.has(hour)) return true;
    if (hour < QUIET_BEFORE) return opened.has("early");
    if (hour >= QUIET_FROM) return opened.has("late");
    return true;
  };
}

/** Every hour an event touches, so those hours stay open. */
export function busyHours(spans: { start: number; end: number }[]): Set<number> {
  const out = new Set<number>();
  for (const { start, end } of spans) {
    const first = Math.max(0, Math.floor(start));
    /* ⚠️ The end is EXCLUSIVE at the hour boundary. A 09:00–10:00 meeting
     * occupies 9 and not 10 — without the check, every one-hour meeting would
     * hold an extra empty hour open and a 19:00 call would open the whole
     * evening band. */
    const last = Math.min(23, Math.ceil(end) - 1);
    for (let hour = first; hour <= last; hour++) out.add(hour);
  }
  return out;
}
