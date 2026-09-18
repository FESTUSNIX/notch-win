/* What the agents have cost, sliced the ways the question gets asked.
 *
 * The buckets come from `usage.rs` already grouped by day, agent, model and
 * project — one row per combination per day rather than one per run — so
 * everything here is a fold over a list that is already small.
 *
 * ⚠️ Pure, and tested without a DOM, for the same reason `spend.ts` is: the
 * arithmetic IS the feature. A total that is merely plausible still renders,
 * and nothing about the panel would look wrong if it were double-counting.
 */

export interface Bucket {
  day: string;
  provider: string;
  /** As the provider names it. Empty where the transcript never said. */
  model: string;
  project: string;
  input: number;
  output: number;
  runs: number;
  seconds: number;
}

/** One row of a breakdown, whatever it was cut by. */
export interface Slice {
  /** What it was cut by — a provider, a model id, a project name. */
  key: string;
  input: number;
  output: number;
  runs: number;
  seconds: number;
  /** For an agent row: the model it spent the most on. ⚠️ The *biggest*, not
   *  the newest — a row that named whichever model answered last would change
   *  under you for a single cheap question. */
  top?: string;
}

export function spent(row: { input: number; output: number }): number {
  return row.input + row.output;
}

function fold(buckets: Bucket[], key: (bucket: Bucket) => string): Map<string, Slice> {
  const out = new Map<string, Slice>();
  for (const bucket of buckets) {
    const id = key(bucket);
    const row = out.get(id) ?? { key: id, input: 0, output: 0, runs: 0, seconds: 0 };
    row.input += bucket.input;
    row.output += bucket.output;
    row.runs += bucket.runs;
    row.seconds += bucket.seconds;
    out.set(id, row);
  }
  return out;
}

const bigger = (a: Slice, b: Slice) => spent(b) - spent(a);

/** Per agent, biggest spender first, each naming the model it spent most on. */
export function byAgent(buckets: Bucket[]): Slice[] {
  const rows = fold(buckets, bucket => bucket.provider);
  for (const [provider, row] of rows) {
    const models = fold(
      buckets.filter(bucket => bucket.provider === provider && bucket.model),
      bucket => bucket.model,
    );
    row.top = [...models.values()].sort(bigger)[0]?.key;
  }
  return [...rows.values()].filter(row => spent(row) > 0).sort(bigger);
}

/** Per model, biggest first. ⚠️ Buckets with no model are dropped rather than
 *  gathered under a blank row: "" is not a model, it is a session this app
 *  started watching mid-run, and a nameless row at the top of a list about
 *  which model costs what says nothing anybody can act on. */
export function byModel(buckets: Bucket[]): Slice[] {
  const rows = fold(buckets.filter(bucket => bucket.model), bucket => bucket.model);
  return [...rows.values()].filter(row => spent(row) > 0).sort(bigger);
}

/** Per project, biggest first. */
export function byProject(buckets: Bucket[]): Slice[] {
  const rows = fold(buckets, bucket => bucket.project);
  return [...rows.values()].filter(row => spent(row) > 0).sort(bigger);
}

/** `2026-09-18` minus n days, in the same format. */
export function dayBefore(day: string, back: number): string {
  const [year, month, date] = day.split("-").map(Number);
  /* ⚠️ UTC, deliberately, though these are LOCAL days. The arithmetic is
   * "subtract 24 hours n times", and in local time that is wrong twice a year:
   * the day the clocks go back has 25 hours in it, so a local-midnight Date
   * walks onto the same calendar day twice and the chart grows a duplicate
   * column. The strings are already local days; only the counting is UTC. */
  const at = Date.UTC(year, month - 1, date) - back * 86_400_000;
  return new Date(at).toISOString().slice(0, 10);
}

/** The last `days` days ending today, oldest first, zeros included.
 *
 * ⚠️ Every day, not only the ones with a bucket. A chart built from the days
 * that have data has no gaps in it — so a week with three days off looks like
 * three days of work in a row, which is the opposite of what it says.
 */
export function byDay(buckets: Bucket[], today: string, days: number): Slice[] {
  const rows = fold(buckets, bucket => bucket.day);
  const out: Slice[] = [];
  for (let back = days - 1; back >= 0; back--) {
    const day = dayBefore(today, back);
    out.push(rows.get(day) ?? { key: day, input: 0, output: 0, runs: 0, seconds: 0 });
  }
  return out;
}

/** The whole lot, however it was cut. */
export function all(rows: Slice[]): Slice {
  return rows.reduce(
    (sum, row) => ({
      key: "",
      input: sum.input + row.input,
      output: sum.output + row.output,
      runs: sum.runs + row.runs,
      seconds: sum.seconds + row.seconds,
    }),
    { key: "", input: 0, output: 0, runs: 0, seconds: 0 },
  );
}
