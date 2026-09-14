/* What the resting pill says beside the time.
 *
 * The pill at rest is three slots — the date, the clock, and this one — and
 * this is the only one that changes. Each module answers one question about
 * right now and returns `null` the rest of the time, so the slot is empty on a
 * quiet afternoon and busy when something is actually happening.
 *
 * ⚠️ **An icon and one token, never a sentence.** `⛁ 95%`, not
 * `Disk 95% · 14 GB free`. The strip is on screen all day: after a week you
 * are reading the glyph and the colour, not the words, and the words are only
 * costing width. Everything a module summarises is on its own screen one hover
 * away, which is where the sentence belongs.
 *
 * ⚠️ Two behaviours, not one, and the difference is the whole design:
 *
 *   * **News HOLDS the slot.** Something that has just become true owns it,
 *     rather than taking its turn behind the weather.
 *   * **Everything else ROTATES**, a few seconds each.
 *
 * …and the hinge between them is *time*, not severity — see `decay`.
 *
 * This is the same contest `claims()` runs one layer up, at a smaller scale:
 * the winner there decides whether the pill is a clock at all, and the winner
 * here decides what the clock has beside it.
 */
import type { TaskIcon } from "./task-icons";
import type { TaskView } from "./task-model";

/** At or above this a reading owns the slot and nothing rotates past it. */
const HOLD = 50;
/** How long news stays news. Long enough to be seen several times if you are
 *  at the desk, short enough that a standing condition rejoins the rotation
 *  while you are still in the same sitting. */
export const HOLD_MS = 120_000;
/** How much worse a standing reading has to get to count as news again. One
 *  point is the disk creeping; five is something happening. */
const REARM_STEP = 5;
/** How long each rotating reading gets. Long enough to read a glyph and a
 *  number twice without staring, short enough not to feel stuck. */
export const DWELL_MS = 6000;

export interface ModuleReading {
  /** Which module said it, so the slot can tell a change of subject from a
   *  change of wording and only animate the first. */
  id: string;
  /** 0..100. At or above `HOLD` this reading holds the slot alone. */
  urgency: number;
  icon: TaskIcon;
  /** One token. An icon carries what it is; this carries how much. */
  text: string;
  /** Paints the icon and the text: a warning should not look like the weather. */
  tone?: "warn" | "hot";
  /** The number `decay` watches to decide whether a standing reading has got
   *  materially worse. Only meaningful on readings that can hold. */
  level?: number;
}

export interface ModuleContext {
  now: Date;
  /** The machine, polled by the shell. -1 anywhere means "not read yet". */
  machine: { cpu: number; memory: number; diskUsed: number; diskFree: number } | null;
  weather: { place: string; celsius: number; summary: string; icon: string } | null;
  /** Minutes until the next event and its title, or null. */
  nextEvent: { minutes: number; title: string } | null;
  tasks: { done: number; total: number; reliable: boolean; view: TaskView };
  /** Live Claude Code sessions writing right now. */
  agents: number;
}

type Module = (ctx: ModuleContext) => ModuleReading | null;

/* ── The modules ──────────────────────────────────────────────────────────
 * Ordered by how loudly they can shout, not by how often they speak. */

/** ⚠️ Only past 30 minutes out. Inside that the calendar screen claims the
 *  *whole* pill at priority 25/50, so a module covering the same window would
 *  never be seen — and on the rare frame it was, the pill would say the same
 *  thing in two places. This is the hand-off, not a duplicate. */
const event: Module = ({ nextEvent }) => {
  if (!nextEvent || nextEvent.minutes <= 30 || nextEvent.minutes > 180) return null;
  const hours = Math.floor(nextEvent.minutes / 60);
  const minutes = Math.round(nextEvent.minutes % 60);
  return {
    id: "event",
    // Ambient: it is an hour away. The screen takes over when it stops being.
    urgency: 20,
    icon: "calendar",
    text: hours ? `${hours}h` : `${minutes}m`,
  };
};

const disk: Module = ({ machine }) => {
  if (!machine || machine.diskUsed < 92) return null;
  return {
    id: "disk",
    urgency: 85,
    icon: "disk",
    text: `${machine.diskUsed}%`,
    tone: "hot",
    level: machine.diskUsed,
  };
};

/** ⚠️ 90, not 80. A developer's machine sits at 80% memory with an editor and
 *  a browser open and is perfectly well; a pill that says so all day is a pill
 *  that gets ignored on the day it matters. The System screen's meters go amber
 *  at 80 because a meter you went to look at can afford to be informative. */
const cpu: Module = ({ machine }) => {
  if (!machine || machine.cpu < 90) return null;
  return { id: "cpu", urgency: 60, icon: "chip", text: `${machine.cpu}%`, tone: "warn", level: machine.cpu };
};

const memory: Module = ({ machine }) => {
  if (!machine || machine.memory < 90) return null;
  return { id: "memory", urgency: 55, icon: "memory", text: `${machine.memory}%`, tone: "warn", level: machine.memory };
};

/** Ambient on purpose. That something is running is worth knowing; it is not
 *  worth a warning, and the usage notch carries the finish. */
const agents: Module = ({ agents: running }) => {
  if (running < 1) return null;
  return { id: "agents", urgency: 25, icon: "agent", text: String(running) };
};

const tasks: Module = ({ tasks: day }) => {
  if (!day.reliable || day.total === 0) return null;
  const left = day.total - day.done;
  return { id: "tasks", urgency: 15, icon: "today", text: left === 0 ? "✓" : String(left) };
};

const weather: Module = ({ weather: reading }) => {
  if (!reading || !reading.place) return null;
  return {
    id: "weather",
    // The floor. Anything with something to say outranks the forecast.
    urgency: 5,
    icon: reading.icon as TaskIcon,
    text: `${reading.celsius}°`,
  };
};

const MODULES: Module[] = [disk, cpu, memory, agents, event, tasks, weather];

/** Everything with something to say, loudest first. */
export function readings(ctx: ModuleContext): ModuleReading[] {
  return MODULES
    .map(module => module(ctx))
    .filter((r): r is ModuleReading => r !== null)
    .sort((a, b) => b.urgency - a.urgency);
}

/** When each holding reading last became news, and how bad it was then. */
export type HoldState = Record<string, { since: number; level: number }>;

/**
 * Let a standing condition rejoin the rotation.
 *
 * ⚠️ **This is the rule that stops the hold becoming the thing it was meant to
 * prevent.** A disk sitting at 95% until someone buys a new one is not an
 * alert, it is a fact about the machine — and a permanent red warning is
 * exactly the warning you stop seeing. So severity decides *whether* a reading
 * can hold the slot, and **time decides how long**: news owns the strip for
 * `HOLD_MS`, then decays to just under `HOLD` and takes its turn like
 * everything else. It still sorts above every ambient module, so it leads the
 * cycle and is seen every time round rather than every time you look.
 *
 * It re-arms when the reading gets materially worse — 95% to 97% is the disk
 * creeping, 92% to 99% is something you want to know now.
 *
 * Pure: returns the next state rather than writing to the one it was given, so
 * the rule can be tested a tick at a time with no clock and no DOM.
 */
export function decay(
  all: ModuleReading[],
  held: HoldState,
  now: number,
): { readings: ModuleReading[]; held: HoldState } {
  const next: HoldState = {};
  const out = all.map(reading => {
    if (reading.urgency < HOLD) return reading;
    const previous = held[reading.id];
    const level = reading.level ?? 0;
    const rearmed = !previous || level >= previous.level + REARM_STEP;
    const since = rearmed ? now : previous.since;
    next[reading.id] = {
      since,
      // The high-water mark, so a figure that dips and climbs back does not
      // re-arm on the way up for ground it has already covered.
      level: rearmed ? level : Math.max(previous.level, level),
    };
    if (now - since < HOLD_MS) return reading;
    return { ...reading, urgency: HOLD - 1 };
  });
  // Readings that fell silent lose their arming, so coming back is news again.
  return { readings: out.sort((a, b) => b.urgency - a.urgency), held: next };
}

/** Which reading the slot should be showing at `elapsed` ms into the rotation.
 *
 * Pure, so the rule is testable without a clock or a DOM: given the same
 * readings and the same elapsed time it always answers the same thing.
 */
export function choose(all: ModuleReading[], elapsed: number): ModuleReading | null {
  if (!all.length) return null;
  // Urgent: the loudest holds it, and the rotation is suspended entirely
  // rather than cycling among the urgent ones — two warnings taking turns is
  // worse than one warning and a tab dot.
  if (all[0].urgency >= HOLD) return all[0];
  const step = Math.floor(Math.max(0, elapsed) / DWELL_MS);
  return all[step % all.length];
}
