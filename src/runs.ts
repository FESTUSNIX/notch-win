/* Every countdown and stopwatch there is, and which one you are looking at.
 *
 * ⚠️ **A COLLECTION, where there used to be exactly two.** The app had one
 * pomodoro and one timer, each with its own storage key, because one shared
 * state meant starting a timer threw away a pomodoro four rounds in. That
 * reasoning was right and the answer was too small: what people actually want
 * is several — a pomodoro for the work, a timer for the oven, a stopwatch for
 * how long this has taken — and the moment there can be two of one kind, "two
 * instances" stops being a model and becomes a special case.
 *
 * ⚠️ **The countdown ENGINE is untouched.** `timer.ts` still owns what a
 * countdown is, what comes after a phase, and how it survives the app being
 * closed mid-count — all of which is tested. This file owns the LIST: what
 * exists, which one is active, and how they are stored. A run that counts down
 * holds a `Countdown` from there; a stopwatch holds the two numbers a
 * stopwatch needs.
 *
 * ⚠️ **A stopwatch is not a countdown with the sign flipped.** It has no
 * target, so it cannot end, cannot have a phase and cannot be "done" — and
 * every function in `timer.ts` is about a thing that ends. They are two shapes
 * in one list, and the code that draws them asks which.
 */
/* ⚠️ The EXTENSION is deliberate. `node --test` strips types and then resolves
 * what is left, and Node's resolver does not add extensions the way Vite does
 * — without it every test of this file fails to load, naming a path in
 * `timer.ts` rather than anything about runs. See AGENTS 645. */
import {
  DEFAULT_LENGTHS, ROUNDS, done, minutesOf, next, remaining,
} from "./timer.ts";
import type { Countdown, Lengths } from "./timer";

export type RunKind = "pomodoro" | "timer" | "stopwatch";

export interface Run {
  /** Stable for the life of the run, and never reused. */
  id: string;
  kind: RunKind;
  /** What the person called it. Empty is normal and reads as the kind. */
  title: string;
  /** The countdown, for a pomodoro or a timer. Null before it is started.
   *
   * ⚠️ Always null on a stopwatch, and the two below are always zero on a
   * countdown. One shape with both sets of fields beats a union here: the list
   * is stored as JSON and read back by a build that may not have the same
   * kinds, and a shape that is the same whatever the kind cannot be misparsed
   * into one. */
  count: Countdown | null;
  /** Stopwatch: milliseconds banked before the current leg. */
  elapsed: number;
  /** Stopwatch: when the current leg started, or null while paused. */
  startedAt: number | null;
  /** What a timer is set to, in minutes. Meaningless for the other two. */
  minutes: number;
}

/** Where the list lives. ⚠️ ONE key for the lot: the old pair of keys is what
 *  made "two instances" the model, and reading it is the migration below. */
const KEY = "codenotch.runs.v1";

/** How late a phase's end may be and still count as having been watched.
 *  ⚠️ Generous: the shell ticks once a second, and a machine that has been
 *  busy can miss a few. Anything past this is a catch-up after the window was
 *  shut, and must make no noise. */
const SEEN = 5000;
/** The two keys the old one-each world used, read once and then left alone. */
const OLD: Record<string, "pomodoro" | "timer"> = {
  "codenotch.timer.pomodoro": "pomodoro",
  "codenotch.timer.plain": "timer",
};

/** What a stopwatch has counted, in milliseconds. */
export function counted(run: Run, now = Date.now()): number {
  if (run.kind !== "stopwatch") return 0;
  return run.elapsed + (run.startedAt === null ? 0 : Math.max(0, now - run.startedAt));
}

/** Whether this run is counting right now.
 *
 * ⚠️ The two kinds answer it differently and both answers are "is there a
 * start time": a countdown that is paused has no `endsAt`, and a stopwatch
 * that is paused has no `startedAt`. */
export function running(run: Run): boolean {
  return run.kind === "stopwatch"
    ? run.startedAt !== null
    : !!run.count && run.count.endsAt !== null;
}

/** Whether it has been started at all — a run that has never been begun reads
 *  as its full length rather than as paused. */
export function begun(run: Run): boolean {
  return run.kind === "stopwatch" ? run.elapsed > 0 || run.startedAt !== null : !!run.count;
}

/** The figure on the face, in milliseconds.
 *
 * ⚠️ A countdown that has not been started shows what it IS, not zero. An
 * unstarted timer reading 00:00 is a timer that looks finished, which is the
 * one thing it must not look like before it has begun. */
export function figureMs(run: Run, lengths: Lengths, now = Date.now()): number {
  if (run.kind === "stopwatch") return counted(run, now);
  if (run.count) return remaining(run.count, now);
  return run.kind === "timer"
    ? run.minutes * 60_000
    : lengths.work * 60_000;
}

/** How far through the current leg, 0 to 1.
 *
 * ⚠️ A stopwatch returns 0 and that is the honest answer, not a gap: it has no
 * target, so there is no "through" to be. The ring draws it as a full circle
 * rather than an arc for exactly that reason. */
export function through(run: Run, lengths: Lengths, now = Date.now()): number {
  if (run.kind === "stopwatch" || !run.count) return 0;
  const whole = run.count.whole ?? minutesOf(lengths.work);
  return whole <= 0 ? 0 : 1 - remaining(run.count, now) / whole;
}

/** What to call a run with no title of its own. */
export function runName(run: Run): string {
  if (run.title) return run.title;
  return run.kind === "pomodoro" ? "Pomodoro"
    : run.kind === "timer" ? "Timer" : "Stopwatch";
}

let seq = 0;
function freshId(): string {
  seq += 1;
  return `r${Date.now().toString(36)}${seq.toString(36)}`;
}

/** A run of this kind, not yet started. */
export function blankRun(kind: RunKind, minutes = 25): Run {
  return {
    id: freshId(), kind, title: "",
    count: null, elapsed: 0, startedAt: null,
    minutes: kind === "timer" ? minutes : 0,
  };
}

export class Runs {
  list: Run[] = [];
  /** Which one the screen is showing. ⚠️ An ID rather than an index: the list
   *  is reordered by nothing today and by a drag tomorrow, and an index would
   *  quietly start pointing at a different run. */
  active = "";

  private changed: () => void;
  private lengths: () => Lengths;
  private ended: (run: Run, finished: Countdown) => void;

  /**
   * @param changed redraw
   * @param lengths read fresh each time, so changing them in settings applies
   *                to the next phase rather than needing a restart
   * @param ended   called once when a countdown runs out, with what it was
   */
  constructor(
    changed: () => void,
    lengths: () => Lengths,
    ended: (run: Run, finished: Countdown) => void,
  ) {
    this.changed = changed;
    this.lengths = lengths;
    this.ended = ended;
    this.load();
  }

  /** The run being shown, or nothing at all when the list is empty. */
  get current(): Run | null {
    return this.list.find(one => one.id === this.active) ?? this.list[0] ?? null;
  }

  /** The runs of one kind, in the order they were made. */
  of(kind: RunKind): Run[] {
    return this.list.filter(one => one.kind === kind);
  }

  /** Anything counting right now, for the pill and the widgets. */
  live(): Run[] {
    return this.list.filter(running);
  }

  add(kind: RunKind): Run {
    const run = blankRun(kind, this.lengths().work);
    this.list.push(run);
    this.active = run.id;
    this.save();
    return run;
  }

  remove(id: string) {
    const at = this.list.findIndex(one => one.id === id);
    if (at < 0) return;
    this.list.splice(at, 1);
    /* ⚠️ The neighbour, not the first. Removing the run you are looking at
     * should leave you next to where you were, not at the top of a list you
     * may have scrolled a long way down. */
    if (this.active === id) this.active = (this.list[at] ?? this.list[at - 1])?.id ?? "";
    this.save();
  }

  clear() {
    this.list = [];
    this.active = "";
    this.save();
  }

  pick(id: string) {
    if (!this.list.some(one => one.id === id)) return;
    this.active = id;
    this.save();
  }

  rename(id: string, title: string) {
    const run = this.list.find(one => one.id === id);
    if (!run) return;
    run.title = title.trim().slice(0, 60);
    this.save();
  }

  /** What a timer is set to. ⚠️ Only while it is not counting: changing the
   *  length of a countdown that is already running is a different thing from
   *  setting one, and there is no control for it because nobody means it. */
  setMinutes(id: string, minutes: number) {
    const run = this.list.find(one => one.id === id);
    if (!run || run.kind !== "timer" || running(run)) return;
    run.minutes = Math.max(1, Math.min(600, Math.round(minutes)));
    // A set length replaces an unfinished countdown rather than fighting it.
    if (run.count && run.count.endsAt === null) run.count = null;
    this.save();
  }

  /** Start it, pause it, or pick it up again — whichever it needs. */
  toggle(id: string) {
    const run = this.list.find(one => one.id === id);
    if (!run) return;
    const now = Date.now();

    if (run.kind === "stopwatch") {
      if (run.startedAt === null) run.startedAt = now;
      else {
        run.elapsed += Math.max(0, now - run.startedAt);
        run.startedAt = null;
      }
      this.save();
      return;
    }

    if (!run.count) {
      // Never started: begin the first phase.
      const lengths = this.lengths();
      const span = minutesOf(run.kind === "timer" ? run.minutes : lengths.work);
      run.count = {
        phase: run.kind === "timer" ? "plain" : "work",
        endsAt: now + span,
        left: 0,
        round: 0,
        whole: span,
      };
      this.save();
      return;
    }
    if (run.count.endsAt === null) {
      run.count.endsAt = now + Math.max(0, run.count.left);
      delete run.count.ready;
    } else {
      run.count.left = remaining(run.count, now);
      run.count.endsAt = null;
    }
    this.save();
  }

  /** End this phase now and take whatever comes after it.
   *
   * ⚠️ Cutting a break short is the commonest thing anybody wants mid-cycle.
   * Skipping WORK counts the round — you decided it was finished. */
  skip(id: string) {
    const run = this.list.find(one => one.id === id);
    if (!run || run.kind === "stopwatch" || !run.count) return;
    const was = run.count;
    run.count = next({ ...was, endsAt: Date.now() }, this.lengths());
    if (run.count && was.name) run.count.name = was.name;
    this.save();
  }

  /** Back to the beginning, without throwing the run away. */
  reset(id: string) {
    const run = this.list.find(one => one.id === id);
    if (!run) return;
    run.count = null;
    run.elapsed = 0;
    run.startedAt = null;
    this.save();
  }

  /** Called every second by the shell. Returns whether anything changed.
   *
   * ⚠️ This is also the CATCH-UP for whatever ran out while the app was shut,
   * which is why the loop below is a loop rather than one step. */
  tick(now = Date.now()): boolean {
    let moved = false;
    for (const run of this.list) {
      if (run.kind === "stopwatch" || !run.count) continue;
      /* ⚠️ Advanced from when the phase ENDED, never from `now`. Live those are
       * the same second; after the window has been shut they are not, and from
       * `now` a six-hour absence handed back a fresh five-minute break instead
       * of the round that was actually waiting.
       *
       * ⚠️ BOUNDED. `next` parks the following work round READY rather than
       * running — a pomodoro app that has already begun your next twenty-five
       * minutes is one you end up fighting — and a ready phase is not "done",
       * so this stops in two steps however long the window was closed. The
       * bound is for a stored phase malformed enough to keep reporting itself
       * done, which must not spin the shell's tick. */
      for (let step = 0; run.count && done(run.count, now) && step < 4; step++) {
        const was = run.count;
        run.count = next(was, this.lengths(), was.endsAt ?? now);
        moved = true;
        /* ⚠️ Only a phase that ran out WHILE SOMEBODY WAS WATCHING is
         * announced. Nothing must ever go off at the wrong time — the same rule
         * `migrate` states — and without this a window opened after lunch fired
         * a toast for every phase the catch-up walked through. */
        if (now - (was.endsAt ?? now) < SEEN) this.ended(run, was);
      }
    }
    if (moved) this.save();
    return moved;
  }

  /* ── Storage ─────────────────────────────────────────────────────────── */

  private save() {
    try {
      localStorage.setItem(KEY, JSON.stringify({ active: this.active, list: this.list }));
    } catch { /* a full or blocked store is not worth a message */ }
    this.changed();
  }

  private load() {
    try {
      const held = JSON.parse(localStorage.getItem(KEY) || "null") as
        { active?: unknown; list?: unknown } | null;
      if (held && Array.isArray(held.list)) {
        this.list = held.list.map(one => sane(one)).filter((one): one is Run => !!one);
        this.active = typeof held.active === "string" ? held.active : "";
        this.settle();
        return;
      }
    } catch { /* an unreadable key is an absent one */ }
    this.migrate();
    this.settle();
  }

  /** The two runs the old one-each world could hold.
   *
   * ⚠️ Read ONCE and never written back: the old keys are left where they are
   * rather than deleted, so a build that is rolled back still finds them. What
   * it would lose is whatever was started since, which is the right way round.
   */
  private migrate() {
    for (const [key, kind] of Object.entries(OLD)) {
      try {
        const held = JSON.parse(localStorage.getItem(key) || "null") as Countdown | null;
        if (!held || typeof held.round !== "number" || typeof held.left !== "number") continue;
        /* ⚠️ A countdown that ran out while the app was closed is DROPPED, not
         * carried over — the same rule the old engine had. Nothing must ever go
         * off at the wrong time. */
        if (done(held)) continue;
        const run = blankRun(kind, DEFAULT_LENGTHS.work);
        run.count = held;
        if (held.name) run.title = held.name;
        this.list.push(run);
      } catch { /* an unreadable key is an absent one */ }
    }
  }

  /** Whatever is left after loading has to be usable.
   *
   * ⚠️ A list is allowed to be empty, but the SCREEN is not: it would be a
   * page of controls with nothing to control. One pomodoro is what the app has
   * always opened with. */
  private settle() {
    /* ⚠️ A phase that ran out while the window was shut is LEFT ALONE here,
     * neither discarded nor advanced — `tick` catches it up a second later.
     *
     * Nulling it, which is what this did, threw the run away on the one path
     * where it matters most: close the window during a focus round, come back
     * after the break would have ended, and the rounds already worked were
     * forgotten. Advancing it here instead is the obvious fix and is WORSE: it
     * needs `this.lengths()`, this runs inside the constructor, and the closure
     * tasks.ts passes reads a `const` declared on the NEXT line — so the app
     * died on boot with "Cannot access 'lengths' before initialization", but
     * only for someone whose phase happened to have finished. The catch-up
     * belongs where the lengths are actually known. */
    if (!this.list.length) this.list.push(blankRun("pomodoro", DEFAULT_LENGTHS.work));
    if (!this.list.some(one => one.id === this.active)) this.active = this.list[0].id;
  }
}

/** One stored entry, made safe to use.
 *
 * ⚠️ Every field is checked and a bad one is replaced, never rejected wholesale
 * — this is JSON in a browser store that a person can edit and an older build
 * can have written. Dropping the list to fix one field is somebody's afternoon
 * of runs gone. */
function sane(raw: unknown): Run | null {
  if (!raw || typeof raw !== "object") return null;
  const one = raw as Partial<Run>;
  const kind: RunKind = one.kind === "timer" || one.kind === "stopwatch" || one.kind === "pomodoro"
    ? one.kind : "timer";
  const count = one.count && typeof one.count === "object"
    && typeof (one.count as Countdown).round === "number"
    && typeof (one.count as Countdown).left === "number"
    ? one.count as Countdown : null;
  return {
    id: typeof one.id === "string" && one.id ? one.id : freshId(),
    kind,
    title: typeof one.title === "string" ? one.title.slice(0, 60) : "",
    count: kind === "stopwatch" ? null : count,
    elapsed: num(one.elapsed),
    startedAt: typeof one.startedAt === "number" && Number.isFinite(one.startedAt)
      ? one.startedAt : null,
    minutes: Math.max(1, Math.min(600, num(one.minutes) || 25)),
  };
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** The rounds a pomodoro ring is drawn as. Re-exported so the screen and the
 *  widget draw the same number of segments without importing the engine. */
export { ROUNDS };
