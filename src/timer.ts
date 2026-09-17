/* A countdown in the island's header: a pomodoro, or just a timer.
 *
 * ⚠️ **One engine, two INSTANCES.** A pomodoro is a countdown that knows
 * what comes after it; a timer is a countdown that does not. They share the
 * engine — one set of bugs about what happens when the app is closed
 * mid-count — and they do NOT share the state: one state meant starting a
 * timer silently threw away a pomodoro that was four rounds in, with no
 * warning and nothing to undo it. They run side by side now, each with its own
 * storage key, and the collapsed island has room for both: the pomodoro takes
 * the strip and the timer is the circle beside it.
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

export type Kind = "pomodoro" | "plain";

export interface Countdown {
  phase: Phase;
  /** Epoch ms when it ends, or null while it is paused. */
  endsAt: number | null;
  /** Milliseconds left, meaningful only while paused. */
  left: number;
  /** Work rounds finished so far in this run. */
  round: number;
  /** What this run is FOR, in the user's own words. Optional, and the pill
   *  shows it instead of the phase when it is there — "Ship the call screen"
   *  is what you need to see at a glance; "Focus" you already knew. */
  name?: string;
  /** How long this phase was asked for, in ms. ⚠️ Stored rather than derived:
   *  a plain timer has no declared length anywhere else, so the ring and the
   *  dial had nothing to measure against and the ring sat at zero. */
  whole?: number;
  /** Waiting to be started, rather than paused part-way through.
   *
   * ⚠️ The two look identical in the state — both are `endsAt: null` — and
   * they are not the same thing to a reader: "paused" means you stopped it,
   * "ready" means the app is holding the door open for the next round. They
   * also want different words on the same button.
   */
  ready?: boolean;
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
 * ⚠️ A finished work round rolls straight into its break, and a finished
 * break hands back the next round READY but not running. Resting is the half
 * people skip, so it starts itself; working is the half that should be a
 * decision, and a pomodoro app that has already started your next twenty-five
 * minutes for you is one you end up fighting.
 *
 * ⚠️ But "a decision" is not "throw the run away", which is what this used
 * to do: a finished break returned NOTHING, so the state went null, the track
 * emptied, the rounds you had done were forgotten and the whole thing looked
 * like it had reset itself while you were away from the desk. The run is kept
 * and the next round waits on its start button. A plain timer simply ends.
 */
export function next(state: Countdown, lengths: Lengths, now = Date.now()): Shape {
  if (state.phase === "plain") return null;
  if (state.phase !== "work") {
    const span = minutes(lengths.work);
    return {
      phase: "work",
      endsAt: null,
      left: span,
      // Already counted when the work round that earned this break finished.
      round: state.round,
      name: state.name,
      whole: span,
      ready: true,
    };
  }
  const round = state.round + 1;
  const long = round % ROUNDS === 0;
  const span = minutes(long ? lengths.long : lengths.rest);
  return {
    phase: long ? "long" : "rest",
    endsAt: now + span,
    left: 0,
    round,
    // What the run is for carries across its own breaks.
    name: state.name,
    whole: span,
  };
}

/** Which round of the cycle this is, one-based — "3" of four. */
export function roundOf(state: Countdown): number {
  return (state.round % ROUNDS) + 1;
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
  /* ⚠️ Names the round that is WAITING. "Start the next one when you are
   * ready" was true and useless: it did not say the run had been kept, and
   * the screen behind it had gone blank, so it read as a run that had ended. */
  return {
    title: "Break over",
    body: `Round ${(state.round % ROUNDS) + 1} of ${ROUNDS} is ready when you are.`,
  };
}

/** One segment of a pomodoro cycle, for the track that shows where you are. */
export interface Session {
  phase: Phase;
  minutes: number;
  /** `done` is behind you, `now` is running, `todo` is still to come. */
  state: "done" | "now" | "todo";
}

/** The whole cycle laid out, so it can be SEEN rather than counted.
 *
 * ⚠️ Four work rounds and their breaks, always the same shape, so the track
 * does not change length as you move along it. A row of segments that grows
 * under you is one you cannot use to tell where you are, which is its only job.
 */
export function cycle(lengths: Lengths, state: Shape): Session[] {
  const out: Session[] = [];
  /* `round` counts FINISHED work rounds. ⚠️ Which is not the same as the
   * position in the track, and conflating the two is how the first version put
   * three segments behind you the moment you skipped one: after finishing work
   * round 1 you are on the break that FOLLOWS index 0, not on index 1. */
  const finished = state?.round ?? 0;
  const resting = !!state && (state.phase === "rest" || state.phase === "long");
  /* Where we are within this cycle of four, so a long run keeps the same
   * track rather than growing one. ⚠️ The long break is the exception: after
   * the fourth round `finished % 4` is 0, which would empty the whole track
   * while the long break it earned is still running. */
  const within = resting && finished > 0 && finished % ROUNDS === 0
    ? ROUNDS
    : finished % ROUNDS;

  for (let index = 0; index < ROUNDS; index++) {
    const last = index === ROUNDS - 1;
    out.push({
      phase: "work",
      minutes: lengths.work,
      state: index < within ? "done"
        : index === within && !resting && !!state ? "now"
        : "todo",
    });
    out.push({
      phase: last ? "long" : "rest",
      minutes: last ? lengths.long : lengths.rest,
      /* The break that follows work round `n` is at index `n - 1`: it is
       * running while you are resting after that round, and behind you once
       * the next round has started. */
      state: index < within - 1 ? "done"
        : index === within - 1 ? (resting ? "now" : "done")
        : "todo",
    });
  }
  return out;
}

/** ⚠️ The pomodoro keeps the ORIGINAL key. A plain countdown left in it by
 *  an older build is dropped by the phase check below rather than loaded as a
 *  pomodoro, which would have shown a fifteen-minute timer as round one. */
const KEYS: Record<Kind, string> = {
  pomodoro: "codenotch.timer.v1",
  plain: "codenotch.countdown.v1",
};

/** The header's countdown, persisted so a reload does not lose it. */
export class Timer {
  state: Shape = null;
  readonly kind: Kind;

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
    kind: Kind,
    changed: () => void,
    ended: (finished: Countdown) => void,
    lengths: () => Lengths,
  ) {
    this.kind = kind;
    this.changed = changed;
    this.ended = ended;
    this.lengths = lengths;
    try {
      const held = JSON.parse(localStorage.getItem(KEYS[kind]) || "null") as Countdown | null;
      // ⚠️ Each instance holds its OWN shape of countdown and drops the other's.
      if (held && (held.phase === "plain") !== (kind === "plain")) {
        /* nothing: a state from the other kind, left by an older build */
      } else if (held && typeof held.round === "number" && typeof held.left === "number") {
        /* ⚠️ A stored countdown that ran out while the app was closed is
         * DROPPED, not fired. Otherwise every launch after lunch announces a
         * pomodoro that ended an hour ago — and the one thing a timer must
         * never do is go off at the wrong time. */
        this.state = done(held) ? null : held;
      }
    } catch { /* an unreadable key is an absent one */ }
  }

  /** Start a pomodoro, or a plain countdown of `mins` minutes. */
  start(mins?: number, name?: string) {
    const lengths = this.lengths();
    const span = minutes(mins ?? lengths.work);
    this.state = {
      // The INSTANCE decides what it is, not the argument. See `Kind`.
      phase: this.kind === "plain" ? "plain" : "work",
      endsAt: Date.now() + span,
      left: 0,
      round: 0,
      name: name?.trim() || undefined,
      whole: span,
    };
    this.save();
  }

  /** Rename the run without disturbing it. */
  rename(name: string) {
    if (!this.state) return;
    this.state = { ...this.state, name: name.trim() || undefined };
    this.save();
  }

  /** End this phase now and take whatever comes after it.
   *
   * ⚠️ Cutting a break short is the commonest thing anybody wants mid-cycle
   * and there was no way to do it: stopping threw the whole run away, and
   * waiting out five minutes you did not need is how a pomodoro app gets
   * closed. Skipping WORK counts the round — you decided it was finished. */
  skip() {
    const state = this.state;
    if (!state) return;
    this.state = next({ ...state, endsAt: Date.now() }, this.lengths());
    if (this.state && state.name) this.state.name = state.name;
    this.save();
  }

  /** Pause, or pick up where it left off. */
  toggle() {
    const state = this.state;
    if (!state) return;
    if (state.endsAt === null) {
      state.endsAt = Date.now() + Math.max(0, state.left);
      // Started is no longer waiting. See `ready`.
      delete state.ready;
    } else {
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
    /* ⚠️ The length this phase was ASKED FOR, carried on the state itself.
     * It used to be re-derived from the preferences, which works for a
     * pomodoro and not at all for a plain timer — a timer has no declared
     * length anywhere else, so the ring was measured against what was left of
     * it and sat at zero for the whole count. */
    const total = state.whole ?? minutes(this.lengths().work);
    return total <= 0 ? 0 : 1 - remaining(state, now) / total;
  }

  /** How long this phase was asked for, in seconds — what the dial reads. */
  span(): number {
    return Math.round((this.state?.whole ?? 0) / 1000);
  }

  private save() {
    try {
      const key = KEYS[this.kind];
      if (this.state) localStorage.setItem(key, JSON.stringify(this.state));
      else localStorage.removeItem(key);
    } catch { /* private mode, a full disk — the timer still runs */ }
    this.changed();
  }
}
