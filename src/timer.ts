/* A countdown in the island's header: a pomodoro, or just a timer.
 *
 * ⚠️ **One engine, two behaviours.** A pomodoro is a countdown that knows what
 * comes after it; a timer is a countdown that does not. Two separate features
 * would be two chips in a header with room for one, and two sets of the same
 * bug about what happens when the app is closed mid-count.
 *
 * ⚠️ **This is NOT the focus timer.** `focus-timer.ts` is a stopwatch attached
 * to a task — "how long have I been on this" — and it counts up from zero with
 * no end. This counts down to one. They answer different questions and they are
 * deliberately not merged: folding them would mean picking a task before you
 * could start a pomodoro, which is most of the reason people do not.
 *
 * ⚠️ **The state is an END TIME, never a remaining count.** A number ticked
 * down by a timer drifts against the clock, stops while the machine sleeps, and
 * cannot survive the window being reloaded. An absolute instant survives all
 * three, and `remaining()` is arithmetic against `Date.now()`.
 */

/** What a pomodoro cycle is made of, in minutes. From the preferences. */
export interface Lengths {
  work: number;
  rest: number;
  long: number;
}

export const DEFAULT_LENGTHS: Lengths = { work: 25, rest: 5, long: 15 };

/** How many work rounds before the long break. */
export const ROUNDS = 4;

export type Phase = "work" | "rest" | "long" | "plain";

export interface Countdown {
  phase: Phase;
  /** Epoch ms when it ends, or null while it is paused. */
  endsAt: number | null;
  /** Milliseconds left, meaningful only while paused. */
  left: number;
  /** Work rounds finished so far in this run. */
  round: number;
}

export type Shape = Countdown | null;

/** Milliseconds left, now. */
export function remaining(state: Shape, now = Date.now()): number {
  if (!state) return 0;
  if (state.endsAt === null) return Math.max(0, state.left);
  return Math.max(0, state.endsAt - now);
}

/** Has it run out? ⚠️ A PAUSED countdown never has: it is sitting at whatever
 *  was left, and a paused timer that announces itself is a timer you cannot
 *  pause. */
export function done(state: Shape, now = Date.now()): boolean {
  return !!state && state.endsAt !== null && now >= state.endsAt;
}

const minutes = (count: number) => Math.max(1, Math.round(count)) * 60_000;

/** What follows a phase that has just run out.
 *
 * ⚠️ A finished work round rolls straight into its break, and a finished break
 * does NOT roll into the next round. Resting is the half people skip, so it
 * starts itself; working is the half that should be a decision, and a pomodoro
 * app that has already started your next twenty-five minutes for you is one
 * you end up fighting. A plain timer simply ends.
 */
export function next(state: Countdown, lengths: Lengths, now = Date.now()): Shape {
  if (state.phase !== "work") return null;
  const round = state.round + 1;
  const long = round % ROUNDS === 0;
  return {
    phase: long ? "long" : "rest",
    endsAt: now + minutes(long ? lengths.long : lengths.rest),
    left: 0,
    round,
  };
}

/** What to call the phase on screen. */
export function phaseName(state: Shape): string {
  switch (state?.phase) {
    case "work": return "Focus";
    case "rest": return "Break";
    case "long": return "Long break";
    case "plain": return "Timer";
    default: return "Timer";
  }
}

/** What the toast says when one runs out. */
export function spokenEnd(state: Countdown, lengths: Lengths): { title: string; body: string } {
  if (state.phase === "work") {
    const long = (state.round + 1) % ROUNDS === 0;
    return {
      title: "Pomodoro done",
      body: `${state.round + 1} so far — ${long ? lengths.long : lengths.rest} minute break started.`,
    };
  }
  if (state.phase === "plain") return { title: "Timer done", body: "The countdown has run out." };
  return { title: "Break over", body: "Start the next pomodoro when you are ready." };
}

const KEY = "codenotch.timer.v1";

/** The header's countdown, persisted so a reload does not lose it. */
export class Timer {
  state: Shape = null;

  /* ⚠️ Declared and assigned, never `constructor(private changed: ...)`.
   * Node's type stripping refuses a parameter property outright, and the whole
   * point of the engine living in its own file is that `node --test` can
   * import it — the same reason `media-format.ts` exists beside
   * `screen-media.ts`. The shorthand costs three lines and the test suite. */
  private changed: () => void;
  private ended: (finished: Countdown) => void;
  private lengths: () => Lengths;

  /**
   * @param changed redraw
   * @param ended   called once when a countdown runs out, with what it was
   * @param lengths read fresh each time, so changing them in settings applies
   *                to the next phase rather than needing a restart
   */
  constructor(
    changed: () => void,
    ended: (finished: Countdown) => void,
    lengths: () => Lengths,
  ) {
    this.changed = changed;
    this.ended = ended;
    this.lengths = lengths;
    try {
      const held = JSON.parse(localStorage.getItem(KEY) || "null") as Countdown | null;
      if (held && typeof held.round === "number" && typeof held.left === "number") {
        /* ⚠️ A stored countdown that ran out while the app was closed is
         * DROPPED, not fired. Otherwise every launch after lunch announces a
         * pomodoro that ended an hour ago — and the one thing a timer must
         * never do is go off at the wrong time. */
        this.state = done(held) ? null : held;
      }
    } catch { /* an unreadable key is an absent one */ }
  }

  /** Start a pomodoro, or a plain countdown of `mins` minutes. */
  start(mins?: number) {
    const lengths = this.lengths();
    this.state = mins
      ? { phase: "plain", endsAt: Date.now() + minutes(mins), left: 0, round: 0 }
      : { phase: "work", endsAt: Date.now() + minutes(lengths.work), left: 0, round: 0 };
    this.save();
  }

  /** Pause, or pick up where it left off. */
  toggle() {
    const state = this.state;
    if (!state) return;
    if (state.endsAt === null) state.endsAt = Date.now() + Math.max(0, state.left);
    else {
      state.left = remaining(state);
      state.endsAt = null;
    }
    this.save();
  }

  stop() {
    this.state = null;
    this.save();
  }

  /** Called every second by the shell. Returns whether anything changed. */
  tick(now = Date.now()): boolean {
    const state = this.state;
    if (!state || !done(state, now)) return false;
    this.state = next(state, this.lengths(), now);
    this.save();
    this.ended(state);
    return true;
  }

  /** Seconds left, for the chip. */
  seconds(now = Date.now()): number {
    return Math.ceil(remaining(this.state, now) / 1000);
  }

  /** 0..1 through the current phase, for the ring. */
  through(now = Date.now()): number {
    const state = this.state;
    if (!state) return 0;
    const lengths = this.lengths();
    const whole = minutes(
      state.phase === "work" ? lengths.work
        : state.phase === "rest" ? lengths.rest
        : state.phase === "long" ? lengths.long
        : 0,
    );
    /* A plain timer has no declared length to measure against — it is however
     * many minutes you asked for — so the ring is filled from what is left of
     * the longest it has been, which is simply its own start. */
    const total = state.phase === "plain" ? Math.max(remaining(state, now), state.left || 1) : whole;
    return total <= 0 ? 0 : 1 - remaining(state, now) / total;
  }

  private save() {
    try {
      if (this.state) localStorage.setItem(KEY, JSON.stringify(this.state));
      else localStorage.removeItem(KEY);
    } catch { /* private mode, a full disk — the timer still runs */ }
    this.changed();
  }
}
