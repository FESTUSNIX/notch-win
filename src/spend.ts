/* What the agents cost, and which project spent it.
 *
 * The usage notch says the window is 60% gone. Nothing on the machine said what
 * ate it — which is the question you actually have when you look at that ring,
 * and the one thing this app is uniquely placed to answer: it is already
 * reading every transcript and already counting tokens per run.
 *
 * ⚠️ Pure, and tested without a DOM. The arithmetic is the whole feature: a
 * total that is merely *plausible* still renders, so nothing about the screen
 * would look wrong if it were double-counting.
 */
import type { Run } from "./screen-review";

export interface Spend {
  project: string;
  /** Everything the model read, cache included — what the limit is spent on. */
  input: number;
  output: number;
  runs: number;
  seconds: number;
}

/** Input plus output. ⚠️ The figure a limit is actually spent against is the
 *  input side (cache reads included), but a "cost" that ignored output would
 *  read as wrong to anyone who has seen a bill. Both, and the split is shown. */
export function total(row: Spend): number {
  return row.input + row.output;
}

/**
 * Per project, biggest spender first.
 *
 * ⚠️ Projects that spent NOTHING are dropped. A run recorded before tokens were
 * counted carries zeros, and two weeks of those at the top of the list — named,
 * ordered, and all reading `0` — looks like the feature is broken rather than
 * like the history predates it.
 */
export function byProject(runs: Run[]): Spend[] {
  const totals = new Map<string, Spend>();
  for (const run of runs) {
    const row = totals.get(run.project)
      ?? { project: run.project, input: 0, output: 0, runs: 0, seconds: 0 };
    row.input += run.input ?? 0;
    row.output += run.output ?? 0;
    row.runs += 1;
    row.seconds += run.seconds;
    totals.set(run.project, row);
  }
  return [...totals.values()]
    .filter(row => total(row) > 0)
    .sort((a, b) => total(b) - total(a));
}

/** The whole day, or whatever range was passed. */
export function sum(rows: Spend[]): Spend {
  return rows.reduce((all, row) => ({
    project: "",
    input: all.input + row.input,
    output: all.output + row.output,
    runs: all.runs + row.runs,
    seconds: all.seconds + row.seconds,
  }), { project: "", input: 0, output: 0, runs: 0, seconds: 0 });
}

/** A project's share of the total, 0–1. Zero when nothing was spent, rather
 *  than NaN — a bar whose width is `NaN%` silently renders at full width. */
export function share(row: Spend, whole: Spend): number {
  const all = total(whole);
  return all > 0 ? total(row) / all : 0;
}

/**
 * `1.3M`, `48k`, `900`. The same scale the agents rows and the usage notch use,
 * so one number means one thing across the app.
 *
 * ⚠️ Not `toLocaleString`. At a glance the question is "is that a lot", and
 * `1,284,000` answers it more slowly than `1.3M` does.
 */
export function short(count: number): string {
  if (count >= 10_000_000) return `${Math.round(count / 1_000_000)}M`;
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${Math.round(count / 1_000)}k`;
  return String(count);
}
