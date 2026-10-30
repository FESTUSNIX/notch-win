/* Moments (30 Oct): the island's notifications. One state between the pill
 * and the panel — the island grows just enough to say one thing (a tile, a
 * title, a line, a few buttons) and folds back by itself, or waits for him
 * when it needs him. His words: "the only thing that interests me is that it
 * finished work, it asked me a question, or it's running low on usage."
 *
 * ⚠️ Pure, and node-tested (tests/moments.test.mjs): the queue, the
 * priorities, the timing and what counts as an agent finishing are the
 * feature. The glance that draws one is moment-glance.ts; the wiring is in
 * tasks.ts (`momentsOf…`).
 *
 * - ONE at a time, by priority; a higher one arriving puts the current one
 *   back in the queue (it comes back after), never on the floor.
 * - NON-STICKY ones fold after `FOLD_MS`; the pointer on it holds it, and
 *   leaving gives it `LEAVE_MS` more.
 * - STICKY ones (a question, a nudge, a block about to start, an agent
 *   done) stay until acted on or dismissed — or until they stop being true
 *   (`until`, `drop`).
 * - FINISHED agents FOLD INTO ONE: a second finishing while the first is up
 *   (or waiting) joins it — "2 done", their projects — rather than queueing a
 *   second sticky moment behind it (`joinFinished`).
 * - BLOCKED (the voice glance is up, the panel is open, presenting, a call,
 *   ambient, the island hidden): nothing shows; the one up goes back to the
 *   front of the queue and comes back, timer restarted, once it is clear.
 */
import type { TaskIcon } from "./task-icons";
import type { NotchAction, NotchMoment } from "./helm-link";

/** `helm`: one of the Guardian's own moments from `/api/notch` (batch 12). */
export type MomentKind = "finished" | "question" | "usage" | "nudge" | "block" | "meeting" | "helm";

export interface MomentButton {
  /** What the shell runs for it. */
  id: string;
  label: string;
  icon?: TaskIcon;
  /** The one filled accent on the surface (AGENTS 815). */
  primary?: boolean;
  /** A quick reply: a quiet chip rather than a button. */
  chip?: boolean;
}

export interface Moment {
  /** One per thing: pushing the same key again replaces it in place. */
  key: string;
  kind: MomentKind;
  icon: TaskIcon;
  /** Whose agent, for its own mark colour (`data-agent`). */
  agent?: string;
  title: string;
  line: string;
  /** A short word over the title: "Za 2 min", "Done", "92%". */
  kicker?: string;
  buttons: MomentButton[];
  sticky: boolean;
  /** When it arrived, ms. */
  at: number;
  /** After this it is no longer true (a meeting that has started), ms. */
  until?: number;
  /** A colour of its own (a calendar's), as a CSS colour. */
  accent?: string;
  /** FINISHED only: every agent this moment says is done, first = the one Open
   *  jumps to. One unless several finished while it was up (`joinFinished`). */
  done?: AgentDone[];
  /** Its own place in the queue, over its kind's (Helm sends one per moment). */
  priority?: number;
  /** What its colour means: the Guardian's own, a warning, good news (`data-tone`). */
  tone?: "guardian" | "warn" | "good";
  /** Labelled lines under the line ("Zapytaj", "Uważaj"), at most three. */
  detail?: { label: string; text: string }[];
  /** HELM only: the moment as Helm sent it, for its actions and its id. */
  helm?: NotchMoment;
}

/** One agent in a finished moment. */
export interface AgentDone {
  /** Its session id, for the jump. */
  id: string;
  project: string;
  line: string;
  agent?: string;
}

/** The finished moment for these agents (first first): one says its project and
 *  last line; several say "2 done" and their projects, Open on the first. */
export function finishedMoment(done: AgentDone[], key: string, at: number, icon: TaskIcon): Moment {
  const one = done.length === 1;
  const first = done[0];
  // Whose colour: one agent's mark, or the shared one when every one is the same agent.
  const agent = done.every(d => d.agent === first.agent) ? first.agent ?? "" : "";
  return {
    key, kind: "finished", icon, agent, sticky: true, at, done,
    kicker: one ? "Done" : `${done.length} done`,
    title: one ? first.project : done.map(d => d.project).join(", "),
    line: one ? first.line : `${first.project}: ${first.line}`.trim().replace(/:$/, ""),
    buttons: [{ id: "jump", label: one ? "Open" : `Open ${first.project}`, icon: "open", primary: true }],
  };
}

/** A newly finished agent joining the finished moment already there: the same
 *  agent again replaces its own entry, a new one goes to the end. */
export function joinFinished(existing: Moment, incoming: Moment): Moment {
  const have = existing.done ?? [];
  const add = incoming.done ?? [];
  const done = [...have.filter(d => !add.some(a => a.id === d.id)), ...add];
  return finishedMoment(done, existing.key, existing.at, existing.icon === incoming.icon ? existing.icon : "agent");
}

/** Open pressed on a finished moment: the first is seen; what is left (if any). */
export function restAfterOpen(moment: Moment): Moment | null {
  const rest = (moment.done ?? []).slice(1);
  return rest.length ? finishedMoment(rest, moment.key, moment.at, moment.icon) : null;
}

/** Highest first. ⚠️ The deadlines over the asks over the news: a meeting in
 *  five minutes cannot wait behind a question, a question can wait behind it. */
export const PRIORITY: Record<MomentKind, number> = {
  meeting: 90,
  block: 85,
  helm: 60,
  nudge: 80,
  question: 70,
  usage: 50,
  finished: 40,
};

/** Where a moment stands in the queue: its own priority, else its kind's. */
export const rank = (m: Moment) => m.priority ?? PRIORITY[m.kind];

/** How long a non-sticky moment stays up. */
export const FOLD_MS = 6000;
/** How long one stays after the pointer leaves it. */
export const LEAVE_MS = 2500;
/** A non-sticky moment that waited this long in the queue is old news. */
export const STALE_MS = 10 * 60_000;

export interface StepContext {
  /** Something else owns the island right now (voice, the panel, a call…). */
  blocked: boolean;
  hovering: boolean;
}

export class MomentQueue {
  private waiting: Moment[] = [];
  current: Moment | null = null;
  /** When the current one went up (or was last let go of by the pointer). */
  private since = 0;
  private leftAt = 0;
  private wasHovering = false;

  get size() { return this.waiting.length + (this.current ? 1 : 0); }
  queued(): readonly Moment[] { return this.waiting; }

  has(key: string) { return this.current?.key === key || this.waiting.some(m => m.key === key); }

  push(moment: Moment) {
    // A finished agent joins the finished moment already there (up or waiting).
    if (moment.kind === "finished" && moment.done) {
      const there = this.current?.kind === "finished" && this.current.done ? this.current
        : this.waiting.find(m => m.kind === "finished" && m.done);
      if (there && there.key !== moment.key) {
        const joined = joinFinished(there, moment);
        if (there === this.current) this.current = joined;
        else this.waiting[this.waiting.indexOf(there)] = joined;
        return;
      }
    }
    if (this.current?.key === moment.key) { this.current = moment; return; }
    const at = this.waiting.findIndex(m => m.key === moment.key);
    if (at >= 0) this.waiting[at] = moment;
    else this.waiting.push(moment);
  }

  /** Gone: answered, dismissed, or no longer true. */
  drop(key: string) {
    this.waiting = this.waiting.filter(m => m.key !== key);
    if (this.current?.key === key) this.current = null;
  }

  /** Every one whose key starts so (all of an agent's, say). */
  dropWhere(test: (m: Moment) => boolean) {
    this.waiting = this.waiting.filter(m => !test(m));
    if (this.current && test(this.current)) this.current = null;
  }

  /** The best waiting one: priority, then oldest. */
  private best(): Moment | null {
    let pick: Moment | null = null;
    for (const m of this.waiting) {
      if (!pick || rank(m) > rank(pick) || (rank(m) === rank(pick) && m.at < pick.at)) pick = m;
    }
    return pick;
  }

  /** Back to the queue, to come back later with a fresh timer. */
  private requeue() {
    if (!this.current) return;
    this.waiting.unshift(this.current);
    this.current = null;
  }

  /** Advance to `now`: what should be up. */
  step(now: number, ctx: StepContext): Moment | null {
    // What stopped being true goes, wherever it is.
    const live = (m: Moment) => (m.until === undefined || now < m.until) && (m.sticky || now - m.at < STALE_MS || m === this.current);
    this.waiting = this.waiting.filter(live);
    if (this.current && this.current.until !== undefined && now >= this.current.until) this.current = null;

    if (ctx.blocked) {
      this.requeue();
      this.wasHovering = false;
      return null;
    }
    if (this.current) {
      if (ctx.hovering) this.wasHovering = true;
      else if (this.wasHovering) { this.wasHovering = false; this.leftAt = now; }
      if (!this.current.sticky && !ctx.hovering) {
        const end = Math.max(this.since + FOLD_MS, this.leftAt ? this.leftAt + LEAVE_MS : 0);
        if (now >= end) this.current = null;
      }
    }
    const next = this.best();
    if (next && (!this.current || rank(next) > rank(this.current))) {
      this.requeue();
      this.waiting = this.waiting.filter(m => m !== next);
      this.current = next;
      this.since = now;
      this.leftAt = 0;
      this.wasHovering = false;
    }
    return this.current;
  }
}

/* ── Agents ──────────────────────────────────────────────────────────────── */

/** What the watch needs of a session (SessionView's own fields). */
export interface AgentSeen {
  id: string;
  provider?: string;
  project: string;
  state: "working" | "waiting" | "idle";
  /** Seconds in the current state. */
  forSecs: number;
  say?: string | null;
}

/** Worked at least this long before going quiet: a "finished" worth saying. */
export const FINISHED_MIN_MS = 60_000;

export interface AgentNews {
  finished: AgentSeen[];
  asked: AgentSeen[];
  /** Sessions no longer waiting (answered, or gone): their question folds. */
  settled: string[];
}

/** Watches successive session lists for the two moments an agent has.
 *
 * ⚠️ The FIRST reading only learns: an agent idle when the app starts did
 * not just finish, and one already waiting asked before we were looking —
 * the pill's waiting claim says that one. */
export class AgentWatch {
  private seen = new Map<string, { state: AgentSeen["state"]; workingSince: number }>();
  private primed = false;

  update(sessions: AgentSeen[], now: number): AgentNews {
    const news: AgentNews = { finished: [], asked: [], settled: [] };
    const next = new Map<string, { state: AgentSeen["state"]; workingSince: number }>();
    for (const s of sessions) {
      const was = this.seen.get(s.id);
      const enteredAt = now - Math.max(0, s.forSecs) * 1000;
      let workingSince = was?.state === "working" ? was.workingSince : enteredAt;
      if (s.state === "working" && was?.state !== "working") workingSince = enteredAt;
      next.set(s.id, { state: s.state, workingSince });
      if (!this.primed || !was || was.state === s.state) continue;
      if (was.state === "waiting") news.settled.push(s.id);
      if (s.state === "waiting") news.asked.push(s);
      else if (s.state === "idle" && was.state === "working" && now - was.workingSince >= FINISHED_MIN_MS) news.finished.push(s);
    }
    for (const [id, was] of this.seen) if (!next.has(id) && was.state === "waiting") news.settled.push(id);
    this.seen = next;
    this.primed = true;
    return news;
  }
}

/* ── Usage ───────────────────────────────────────────────────────────────── */

/** One limit window as the providers report it (model.rs `LimitWindow`). */
export interface LimitReading {
  id: string;
  label: string;
  used_fraction: number;
  resets_at: string;
}
export interface ProviderReading {
  id: string;
  displayName: string;
  windows: LimitReading[];
  stale?: boolean;
}

/** Near the limit: what is left is a tenth or less. */
export const LOW_USED = 0.9;

/** The windows that are near their limit, each once per window (its reset is
 *  part of the key, so the next window can say it again). ⚠️ The five-hour
 *  and the weekly ones only — `session`/`primary` and `weekly_all`/`secondary`.
 *  A per-model weekly cap is a detail of the weekly one. */
export function lowWindows(readings: ProviderReading[], now: number): { key: string; provider: string; reading: ProviderReading; window: LimitReading; week: boolean }[] {
  const out = [];
  for (const r of readings) {
    if (r.stale) continue;
    for (const w of r.windows) {
      const week = w.id === "weekly_all" || w.id === "secondary";
      if (!week && w.id !== "session" && w.id !== "primary") continue;
      const resets = Date.parse(w.resets_at);
      if (!Number.isFinite(resets) || resets <= now) continue;
      if (w.used_fraction < LOW_USED) continue;
      out.push({ key: `usage:${r.id}:${w.id}:${w.resets_at}`, provider: r.id, reading: r, window: w, week });
    }
  }
  return out;
}

/** "in 1 h 20 min", "in 40 min", "Thu 14:00" — when it comes back. */
export function resetsIn(resetsAt: string, now: number, clock24 = true): string {
  const at = Date.parse(resetsAt);
  const minutes = Math.max(1, Math.round((at - now) / 60_000));
  if (minutes < 60) return `in ${minutes} min`;
  if (minutes < 24 * 60) {
    const h = Math.floor(minutes / 60), m = minutes % 60;
    return m ? `in ${h} h ${m} min` : `in ${h} h`;
  }
  return new Date(at).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit", hour12: !clock24 });
}

/* ── Helm's planned blocks ───────────────────────────────────────────────── */

/** A planned block's start today, from Helm's "09:30" (local), ms; null if none. */
export function plannedStart(plannedAt: string | null, now: number): number | null {
  const m = plannedAt ? /^(\d{1,2}):(\d{2})/.exec(plannedAt) : null;
  if (!m) {
    const at = plannedAt ? Date.parse(plannedAt) : NaN;
    return Number.isFinite(at) ? at : null;
  }
  const d = new Date(now);
  d.setHours(Number(m[1]), Number(m[2]), 0, 0);
  return d.getTime();
}

/** How far ahead a block and a meeting are announced. */
export const BLOCK_LEAD_MS = 2 * 60_000;
export const MEETING_LEAD_MS = 5 * 60_000;

/** "Za 2 min", "Za 1 min", "Teraz". */
export function inMinutes(start: number, now: number): string {
  const minutes = Math.ceil((start - now) / 60_000);
  return minutes <= 0 ? "Teraz" : `Za ${minutes} min`;
}

/* ── The Guardian's own moments (batch 12) ───────────────────────────────── */

/** The badge on the Guardian's tile: what kind of thing it is saying. */
const HELM_BADGE: Record<NotchMoment["kind"], TaskIcon> = {
  prep: "calendar", wrap: "mic", drift: "timer", remind: "money", request: "request", close: "moon",
};
export const helmBadge = (kind: NotchMoment["kind"]): TaskIcon => HELM_BADGE[kind];

/** The icon an action's button wears. */
export function actionIcon(action: NotchAction): TaskIcon {
  switch (action.do) {
    case "open_url": return /meet\.google|zoom\.us|teams\.microsoft/.test(action.url) ? "join" : "open";
    case "queue": {
      const act = String(action.act.act);
      return act === "extend" ? "plus" : act === "done" ? "check" : act === "snooze" ? "later" : act === "pause" ? "pause" : "guardian";
    }
    case "chat": return "guardian";
    case "talk": return "mic";
    case "post": return "send";
    case "close": return "moon";
  }
}

/** The key a Helm moment has in the queue. */
export const helmKey = (id: string) => `helm:${id}`;

/** Helm's moment as the island draws it: the Guardian's tile, Helm's title and
 *  body, the detail lines, its actions (the first filled), its own priority. */
export function helmMoment(n: NotchMoment, at: number): Moment {
  return {
    key: helmKey(n.id), kind: "helm", icon: "guardian", title: n.title, line: n.body, sticky: n.sticky, at,
    priority: n.priority, tone: n.tone, detail: n.detail, helm: n,
    buttons: n.actions.map((a, i) => ({ id: `h:${i}`, label: a.label, icon: actionIcon(a), primary: i === 0 })),
  };
}

/** Ids already shown or dismissed, kept across launches: once means once.
 *  ⚠️ A NON-sticky one counts as seen once shown; a STICKY one only once acted
 *  on or dismissed — it "stays until acted on", across a restart too. */
export function remember(seen: string[], id: string, keep = 60): string[] {
  return [...seen.filter(one => one !== id), id].slice(-keep);
}
