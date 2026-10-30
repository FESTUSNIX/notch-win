/* Helm's day, as the island's Today.
 *
 * Helm is Mateusz's work OS. Since 27 Oct his day is Today and the
 * suggestions: Today is what he committed to, in his order (the first is Now);
 * the suggestions are the rest of his next actions across the projects, in
 * the Guardian's order. One project's tasks due together are one entry, and
 * the small admin (money, logging, follow-ups) is one more. `helm.rs` reads
 * `/api/desktop` every 20 s (the blocks and their timers, the Guardian's
 * nudges) and `/api/queue` every minute, and sends both as `helm:changed`.
 * While Helm is connected this screen IS Today (the TickTick one steps aside —
 * his call): Now as the hero (the session running, else Today's first, with
 * the Guardian's line on why), the rest of Today as rows, the suggestions
 * folded under them with `+`, and "Add to today" pinned at the foot. Start,
 * Done, Not today, `+` and Add go back through `helm_queue`; pause and resume
 * through `helm_act`. Helm applies its own rules (one session at a time; a
 * finished one pays the reward and logs the time).
 *
 * ── The cockpit (28 Oct) ────────────────────────────────────────────────
 * codenotch is where he RUNS the work; Helm's web is where he manages it.
 * `/api/notch` (read with the queue, every minute) adds what running it needs:
 * his clock and the agents' in the header, what needs him as a strip under
 * it, each project's logo on its rows, and the requests a Claude Code session
 * is on — which is what lets the Agents screen ask "done?" when a run ends and
 * lets a request be started with Claude in a terminal of its own.
 *
 * ⚠️ A Helm without `/api/notch` answers 404 and that is NORMAL (the two ship
 * separately): `notch` is null, every part built on it is simply not drawn,
 * nothing is said on the pill, and it all appears on the next read once Helm
 * has the endpoint. `?helm&notch=off` stages exactly that.
 *
 * ⚠️ Drawn in Today's own language on purpose — the same rows, check, hero and
 * composer — so the screen reads as the island's Today and not as a web page
 * dropped into it. See AGENTS on rows, the one accent and cards in the panel.
 *
 * The source here also owns the Guardian's nudges on the pill: a nudge claims
 * it at 80 until it is answered (here, in the Guardian screen, or in Helm),
 * and a NEW one drops the island open on the Guardian (`onNudge`).
 */
import { element } from "./dom";
import { paintIcon, taskIcon, type TaskIcon } from "./task-icons";
import { call, native, previewBus, previewFinished } from "./task-client";
import { listen } from "@tauri-apps/api/event";
import { timerText } from "./focus-timer";
import { control } from "./task-day";
import { HelmClose } from "./helm-close";
import { localDay } from "./task-model";
import {
  chipFor, doingRequest, folderFor, folderOfRequest, needSide, projectById, readNotch, requestIdOf, spoken, zloty,
  type NotchMoment,
  type Notch, type NotchFolder, type NotchNeed, type NotchProject, type NotchRequest, type Suggestion,
} from "./helm-link";
import { agentMark, chip, faceOf, logoTile, wordButton, type Face } from "./helm-parts";
import { sortable } from "./helm-drag";
import { parseQuick } from "./helm-quick";
import { endOf, startOf, type CalEvent } from "./screen-calendar";
import { Composer, type Sent, type Voice } from "./kit/composer";
import { Dropdown } from "./kit/menu";
import { Block, SidePanel } from "./kit/parts";
import { projectPanel } from "./project-panel";
import { AGENT_PANEL_W } from "./screen-agents";
import { isVertical } from "./layout";
import { load, save } from "./kit/store";
import type { MentionProject } from "./kit/words";
import type { Activity } from "./island-activity";
import type { IslandSurface } from "./island-surface";

export interface HelmBlock {
  id: number;
  title: string;
  /** planned | running | paused | done | skipped */
  status: string;
  plannedAt: string | null;
  minutes: number;
  runStartedAt: string | null;
  elapsedSeconds: number;
  project: string | null;
}

export interface HelmNudge {
  id: number;
  kind: string;
  title: string | null;
  body: string;
  /** Where its action goes in Helm: `/` (Today), `/morning`, `/guardian`… */
  url: string | null;
  at: string;
}

export interface HelmToday {
  now: string;
  day: { firstStep: string | null; closedAt: string | null; off: boolean } | null;
  /** His working day in minutes since midnight, where Helm has it: the day strip's ends. */
  rhythm?: { on?: boolean; start: number; close: number } | null;
  blocks: HelmBlock[];
  nudges: HelmNudge[];
  replies: string[];
}

/** One next action, as Helm's `/api/queue` sends it. */
export interface HelmQueueItem {
  /** `request:12`, `todo:7`, `followup:3@2026-10-27`, `log:5@2026-10-26`… */
  key: string;
  kind: string;
  title: string;
  /** The project, client or company it's for. */
  context: string | null;
  /** Helm's hue for that project or client, where it has one. */
  hue?: string | null;
  projectId: number | null;
  workItemId: number | null;
  taskId: number | null;
  dealId: number | null;
  blockId: number | null;
  dueOn: string | null;
  /** How long a session on it runs. */
  minutes: number;
  /** What Done does. Money is settled in Helm, where it's recorded properly. */
  done: { kind: "own" | "mark" | "mark-paid" | "confirm" | "log" | "remind"; minutes?: number };
  doneLabel: string | null;
  href: string | null;
}

/** A line of Today or the suggestions: an item, a project's group of them, or the small things. */
export interface HelmEntry {
  /** An item's key, `group:<project>:<kind>@<due>`, or `small`. */
  key: string;
  type: "item" | "group" | "small";
  title: string;
  context: string | null;
  projectId: number | null;
  dueOn: string | null;
  minutes: number;
  /** The Guardian's line on why, in Polish. */
  why: string | null;
  items: HelmQueueItem[];
  by: "me" | "guardian" | null;
  carried: boolean;
}

export interface HelmQueue {
  today: HelmEntry[];
  suggested: HelmEntry[];
  /** Statuses waiting on other people. */
  waiting: HelmQueueItem[];
  /** Moved to tomorrow. */
  snoozed: number;
  doneToday: number;
  workedMinutes: number;
  /** Running or paused sessions (block id) → the entry each is for. */
  sessions: Record<string, string>;
  /** What is left of the day outside meetings, by Helm's rhythm; null where it can't say. */
  freeMinutes?: number | null;
}

export interface Helm {
  connected: boolean;
  /** A session to chat with and to read the queue; the blocks work on the device key without one. */
  signedIn: boolean;
  today: HelmToday | null;
  error: string | null;
  queue: HelmQueue | null;
  queueError: string | null;
  /** `/api/notch`, raw: null until read, and null for a Helm that doesn't have it. */
  notch?: unknown;
  /** This clock minus Helm's at the reading. */
  skewMs: number;
}

export const emptyHelm = (): Helm => ({ connected: false, signedIn: false, today: null, error: null, queue: null, queueError: null, notch: null, skewMs: 0 });

/** Seconds a block has run, counted from when HELM says it started. */
export function blockSeconds(block: HelmBlock, skewMs: number, now = Date.now()): number {
  const running = block.status === "running" && block.runStartedAt
    ? Math.max(0, (now - skewMs - Date.parse(block.runStartedAt)) / 1000)
    : 0;
  return Math.floor(block.elapsedSeconds + running);
}

/** The block the hero and the strip speak for: the running one, else one left paused. */
export function liveBlock(blocks: HelmBlock[]): HelmBlock | null {
  return blocks.find(b => b.status === "running") ?? blocks.find(b => b.status === "paused") ?? null;
}

/** A sort by a held order; keys it doesn't know keep their place at the end. */
const byOrder = <T,>(order: string[], key: (one: T) => string) => (a: T, b: T) => {
  const at = (one: T) => { const i = order.indexOf(key(one)); return i < 0 ? order.length : i; };
  return at(a) - at(b);
};

/** Whether Done here would settle money, which only Helm does. */
const isMoney = (item: HelmQueueItem) => item.done.kind === "mark-paid" || item.done.kind === "confirm" || item.done.kind === "remind";
/** Money and logging are done without a session; everything else can be started. */
export const hasSession = (e: HelmEntry) => !(e.type === "item" && (e.items[0].kind === "money" || e.items[0].kind === "log"));

/** What Start sends for an entry, as Helm's `sessionFor`: an item with its own links, or a session
 *  on the group's project (or the small things) under the entry's title. */
export function sessionFor(e: HelmEntry) {
  const one = e.type === "item" ? e.items[0] : null;
  return {
    act: "start", key: e.key, title: e.title.slice(0, 120),
    minutes: Math.min(180, Math.max(e.type === "small" ? 10 : 15, e.minutes)),
    projectId: e.projectId, workItemId: one?.workItemId ?? null, taskId: one?.taskId ?? null, dealId: one?.dealId ?? null,
  };
}

export type NudgeAction =
  | { label: string; icon: TaskIcon; start: number }
  | { label: string; icon: TaskIcon; entry: HelmEntry }
  | { label: string; icon: TaskIcon; open: string };

/** What a nudge's own button does, from where Helm points it.
 *
 * ⚠️ "Start" STARTS the work, here, rather than opening Helm: the nudge exists
 * to get it going, and a button that opens a page about starting is one more
 * step between him and it. A paused session first, then Today's first (else
 * the first suggestion); with neither, it opens Today in Helm. */
export function nudgeAction(nudge: HelmNudge, blocks: HelmBlock[], entries: HelmEntry[]): NudgeAction {
  const path = nudge.url ?? "/guardian";
  if (path === "/" || path.startsWith("/start")) {
    const paused = blocks.find(b => b.status === "paused");
    if (paused) return { label: "Resume", icon: "play", start: paused.id };
    const top = entries.find(hasSession);
    return top ? { label: "Start", icon: "play", entry: top } : { label: "Open Today", icon: "open", open: "/" };
  }
  // The check-in is the printed code in the kitchen (since 27 Oct); /morning is that code's page.
  if (path.startsWith("/morning")) return { label: "Morning code", icon: "sun", open: "/morning" };
  if (path.startsWith("/end")) return { label: "Close the day", icon: "check", open: "/end" };
  return { label: "Open Helm", icon: "open", open: path };
}

/** How long ago, in one unit, as the notices and agents say it. */
export function ago(iso: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

const shortDay = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const weekday = new Intl.DateTimeFormat("en-GB", { weekday: "short", timeZone: "UTC" });

/** When it's due, as a word, and whether that's late: "2 days late", "Today", "Thu", "4 Nov". */
export function dueLabel(dueOn: string | null, today = localDay()): { label: string; late: boolean } | null {
  if (!dueOn) return null;
  const days = Math.round((Date.parse(`${dueOn}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86_400_000);
  const date = new Date(`${dueOn}T12:00:00Z`);
  if (days < 0) return { label: days === -1 ? "1 day late" : `${-days} days late`, late: true };
  if (days === 0) return { label: "Today", late: false };
  if (days === 1) return { label: "Tomorrow", late: false };
  return { label: days < 7 ? weekday.format(date) : shortDay.format(date), late: false };
}

/** "1 h 20 min", "45 min". */
export function length(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return h ? (m ? `${h} h ${m} min` : `${h} h`) : `${m} min`;
}

/** A run that just ended, as `notch:finished` carries it. */
export interface Finish {
  session?: string;
  project: string;
  folder?: string | null;
}

/** The question a finished run raises on its session's card: is the request done?
 *
 * ⚠️ Held HERE, not on the Agents screen: the same question is on the card,
 * on the session's detail and on the collapsed pill, and three copies of
 * "where is this up to" would disagree the moment one of them was answered. */
export interface Ask {
  session: string;
  requestId: number;
  title: string;
  project: NotchProject;
  /** When the run ended; the pill lets go of the question after a while. */
  at: number;
  stage: "ask" | "busy" | "suggest" | "logging" | "done";
  suggestion: Suggestion | null;
  minutes: number;
  /** What happened, for a moment, once it is answered. */
  said: string | null;
}

/** How long the pill carries a finished run's question. The card keeps it until
 *  it is answered or the session runs again; the strip is for the moment. */
const ASK_ON_PILL_MS = 20 * 60_000;

export class HelmSource {
  helm: Helm = emptyHelm();
  /** Nudges answered here, hidden until the next reading agrees. */
  private answered = new Set<number>();
  /** Items or entries done or moved here, hidden until the next reading agrees. */
  private gone = new Set<string>();
  /** Entries put into Today here, shown there until the next reading agrees. */
  private into = new Set<string>();
  /** Entries sent back to the suggestions here, the same way. */
  private out = new Set<string>();
  /** Today's keys and the small things' item keys as he dragged them, until the next reading. */
  private order: string[] | null = null;
  private smallOrder: string[] | null = null;
  /** Order calls on their way: a reading taken before Helm applied one must not undo the drag. */
  private ordering = 0;
  /** A block or entry action on its way, so its buttons do not take a second press. */
  pending: number | string | null = null;
  /** Set by the shell: a NEW nudge arrived. */
  onNudge: ((id: number) => void) | null = null;
  /** Finished runs waiting for "done?", by session id. */
  private asks = new Map<string, Ask>();
  /** Requests being started with Claude, so the button does not take a second press. */
  starting = new Set<number>();
  /** Logos by `id:version`: a data URL, or null for "has none". */
  private logos = new Map<string, string | null>();
  private askedLogo = new Set<string>();
  /** Bumped when a logo arrives, so keyed renders know to draw again. */
  logoTick = 0;
  private parsed: { raw: unknown; notch: Notch | null } = { raw: null, notch: null };

  private changed: () => void;
  private say: (what: string, why: string) => void;

  constructor(changed: () => void, say: (what: string, why: string) => void) {
    this.changed = changed;
    this.say = say;
  }

  async boot() {
    const finished = (run: Finish) => this.finished(run);
    if (native) {
      await listen<Helm>("helm:changed", event => {
        this.helm = event.payload;
        // A reading that no longer has them confirms them; keep only the rest.
        const unread = new Set(this.helm.today?.nudges.map(n => n.id) ?? []);
        for (const id of this.answered) if (!unread.has(id)) this.answered.delete(id);
        const q = this.helm.queue;
        const present = new Set([...(q?.today ?? []), ...(q?.suggested ?? [])].flatMap(e => [e.key, ...e.items.map(i => i.key)]));
        for (const key of this.gone) if (!present.has(key)) this.gone.delete(key);
        const inToday = new Set(q?.today.map(e => e.key) ?? []);
        for (const key of this.into) if (inToday.has(key)) this.into.delete(key);
        for (const key of this.out) if (!inToday.has(key)) this.out.delete(key);
        if (!this.ordering) { this.order = null; this.smallOrder = null; }
        if (!this.extending) this.extra.clear();
        this.flip.clear();
        this.pending = null;
        this.changed();
      });
      await listen<number>("helm:nudge", event => this.onNudge?.(event.payload));
      /* A run ended. ⚠️ Listened for HERE and not on the Agents screen: the
       * question it raises is Helm's (is the request done?) and it has to be
       * asked whether or not that screen has ever been opened. */
      await listen<Finish>("notch:finished", event => finished(event.payload));
    } else {
      previewBus.addEventListener("notch:finished", event => finished((event as CustomEvent<Finish>).detail));
      // The preview's staged readings (`?peek=done`, task-client.ts).
      previewBus.addEventListener("helm:changed", event => { this.helm = (event as CustomEvent<Helm>).detail; this.changed(); });
    }
    /* ⚠️ Asked for once at boot: the first reading may have been emitted
     * before this page was listening. See AGENTS on events. */
    try { this.helm = (await call<Helm>("get_helm")) ?? emptyHelm(); } catch { /* not yet */ }
    // The preview's staged finish (`?agents&finished`), once there is a reading to join it to.
    const staged = previewFinished();
    if (staged) this.finished(staged);
    this.changed();
  }

  get connected(): boolean { return this.helm.connected; }
  get signedIn(): boolean { return this.helm.signedIn; }
  /** Minutes added here with +5 min, by block, until the next reading has them. */
  private extra = new Map<number, number>();
  private extending = 0;

  /** Pause or resume pressed here, by block, until the next reading has it: the
   *  hero and the pill turn at once (AGENTS 878). Cleared on every reading and on a failure. */
  private flip = new Map<number, Partial<HelmBlock>>();

  get blocks(): HelmBlock[] {
    const blocks = this.helm.today?.blocks ?? [];
    if (!this.extra.size && !this.flip.size) return blocks;
    return blocks.map(b => {
      let out = this.flip.has(b.id) ? { ...b, ...this.flip.get(b.id) } : b;
      if (this.extra.has(b.id)) out = { ...out, minutes: Math.min(180, out.minutes + this.extra.get(b.id)!) };
      return out;
    });
  }

  /** +5 min on a session run past its length (`/api/queue` `extend`; Helm caps it at 180). */
  extend(block: number, minutes = 5) {
    this.extra.set(block, (this.extra.get(block) ?? 0) + minutes);
    this.extending++;
    this.changed();
    void this.queueCall({ act: "extend", block, minutes })
      .catch(error => this.fail(error, () => {
        const left = (this.extra.get(block) ?? 0) - minutes;
        if (left > 0) this.extra.set(block, left);
        else this.extra.delete(block);
      }))
      .finally(() => { this.extending--; });
  }
  get replies(): string[] { return this.helm.today?.replies ?? []; }

  /** The cockpit's reading, or null — absent, not read yet, or a Helm without it. */
  get notch(): Notch | null {
    const raw = this.helm.signedIn ? this.helm.notch ?? null : null;
    if (raw !== this.parsed.raw) this.parsed = { raw, notch: readNotch(raw) };
    return this.parsed.notch;
  }

  /** An entry as it stands with what was done here: its items minus the ticked ones, the small
   *  things in the order he dragged them. */
  private live(e: HelmEntry): HelmEntry | null {
    if (this.gone.has(e.key)) return null;
    const items = e.items.filter(i => !this.gone.has(i.key));
    if (e.type === "small" && this.smallOrder) items.sort(byOrder(this.smallOrder, i => i.key));
    return items.length ? { ...e, items } : null;
  }

  /** Today, with what was put in here at the end, without what was sent back, in his order. */
  get today(): HelmEntry[] {
    const q = this.helm.queue;
    const moved = (q?.suggested ?? []).filter(e => this.into.has(e.key));
    const list = [...(q?.today ?? []).filter(e => !this.out.has(e.key)), ...moved].map(e => this.live(e)).filter((e): e is HelmEntry => !!e);
    return this.order ? list.sort(byOrder(this.order, e => e.key)) : list;
  }

  get suggested(): HelmEntry[] {
    const q = this.helm.queue;
    const back = (q?.today ?? []).filter(e => this.out.has(e.key));
    return [...back, ...(q?.suggested ?? []).filter(e => !this.into.has(e.key))].map(e => this.live(e)).filter((e): e is HelmEntry => !!e);
  }

  /** The projects waiting on somebody else, by id: what the "Waiting" chip is for. */
  get waitingProjects(): Set<number> {
    return new Set((this.helm.queue?.waiting ?? []).map(i => i.projectId).filter((id): id is number => id != null));
  }

  /** The entry a session is for, when it was started from Today or the suggestions. */
  entryOf(block: HelmBlock | null): HelmEntry | null {
    if (!block) return null;
    const key = this.helm.queue?.sessions[String(block.id)];
    const all = [...this.today, ...this.suggested];
    /* ⚠️ The last fallback is the title with its counts taken out: Helm names a
     * small-things or group session after the entry's title at the start ("12
     * small things"), finds it again by that title, and an item added or ticked
     * since makes it "13 small things" — no `sessions` key, no title match, and
     * Now and Today both showed it. */
    const loose = (title: string) => title.replace(/\d+/g, "#").trim().toLowerCase();
    return (key ? all.find(e => e.key === key) : undefined) ?? all.find(e => e.title === block.title)
      ?? all.find(e => e.type !== "item" && loose(e.title) === loose(block.title)) ?? null;
  }

  /** Unread, oldest first. */
  get nudges(): HelmNudge[] {
    return (this.helm.today?.nudges ?? []).filter(n => !this.answered.has(n.id));
  }

  private fail(error: unknown, undo?: () => void) {
    this.pending = null;
    this.flip.clear();
    undo?.();
    this.say("Helm", String(error).replace(/^(invoke error|error): /i, "").slice(0, 120));
    this.changed();
  }

  private act(action: Record<string, unknown>, block: number | null = null) {
    this.pending = block;
    this.changed();
    void call("helm_act", { action }).catch(error => this.fail(error));
  }

  private queueCall(action: Record<string, unknown>) {
    return call("helm_queue", { action });
  }

  /** The Guardian's moments in the cockpit's reading (batch 12); none without it. */
  get moments(): NotchMoment[] { return this.notch?.moments ?? []; }

  /** A queue act as Helm sent it on a moment's button. +N min goes through
   *  `extend`, so the hero and the pill grow on the press (and shrink back on
   *  a failure); anything else is sent as it is. */
  queueAct(act: Record<string, unknown>): Promise<void> {
    if (act.act === "extend" && Number(act.block) > 0) {
      this.extend(Number(act.block), Math.max(1, Math.min(60, Number(act.minutes) || 5)));
      return Promise.resolve();
    }
    return this.queueCall(act).then(() => undefined);
  }

  /* Optimistic: the block turns here at once, and the reading confirms it. */
  start(block: number) {
    const one = this.blocks.find(b => b.id === block);
    if (one && one.status === "paused") this.flip.set(block, { status: "running", runStartedAt: new Date(Date.now() - this.helm.skewMs).toISOString() });
    this.act({ do: "start", block }, block);
  }
  pause(block: number) {
    const one = this.blocks.find(b => b.id === block);
    if (one && one.status === "running") this.flip.set(block, { status: "paused", runStartedAt: null, elapsedSeconds: blockSeconds(one, this.helm.skewMs) });
    this.act({ do: "pause", block }, block);
  }
  /** The pill's button: pause the live session, or resume it. */
  toggleLive() {
    const live = liveBlock(this.blocks);
    if (!live) return;
    if (live.status === "running") this.pause(live.id);
    else this.start(live.id);
  }
  /** Focus on a task from TickTick's Today: a Helm block of its own, started at once. */
  startNew(title: string) { this.act({ do: "new", title: title.slice(0, 120), minutes: 50 }); }

  /** A session on the entry; one started from the suggestions goes into Today first. */
  startEntry(entry: HelmEntry) {
    this.pending = entry.key;
    const fromSuggested = !this.today.some(e => e.key === entry.key);
    if (fromSuggested) this.into.add(entry.key);
    this.changed();
    void (async () => {
      if (fromSuggested) await this.queueCall({ act: "today", key: entry.key, on: true });
      await this.queueCall(sessionFor(entry));
    })().catch(error => this.fail(error, () => this.into.delete(entry.key)));
  }

  /** `+`: into Today, at the end. */
  toToday(entry: HelmEntry) {
    this.into.add(entry.key);
    this.pending = entry.key;
    this.changed();
    void this.queueCall({ act: "today", key: entry.key, on: true }).catch(error => this.fail(error, () => this.into.delete(entry.key)));
  }

  /** Done on one item. Money opens Helm instead, where paying is recorded; an item whose session
   *  runs ends that first, so its time is logged. */
  doneItem(item: HelmQueueItem) {
    if (isMoney(item)) return this.open(item.href ?? "/");
    const live = liveBlock(this.blocks);
    const entry = this.entryOf(live);
    const running = live && entry?.type === "item" && entry.items[0].key === item.key ? live : null;
    this.pending = item.key;
    this.gone.add(item.key);
    this.changed();
    void (async () => {
      if (running) await call("helm_act", { action: { do: "done", block: running.id } });
      await this.queueCall({ act: "done", key: item.key, minutes: item.done.kind === "log" ? item.done.minutes : undefined });
    })().catch(error => this.fail(error, () => this.gone.delete(item.key)));
  }

  /** Done with the session alone: a group's or the small things', or one not from the queue. */
  doneBlock(block: number) { this.act({ do: "done", block }, block); }

  /** Not today: the entry (a group or the small things with all their items) back tomorrow. */
  later(entry: HelmEntry) {
    this.pending = entry.key;
    this.gone.add(entry.key);
    this.changed();
    void this.queueCall({ act: "snooze", key: entry.key, keys: entry.type === "item" ? undefined : entry.items.map(i => i.key) })
      .catch(error => this.fail(error, () => this.gone.delete(entry.key)));
  }

  /** One of his own into Today: a title, and a project, a length and a day when the line had them. */
  add(title: string, more: { projectId?: number; minutes?: number; dueOn?: string } = {}) {
    void this.queueCall({ act: "add", title: title.slice(0, 280), ...more }).catch(error => this.fail(error));
  }

  /** Not today on one item of a group or the small things: that item back tomorrow. */
  laterItem(item: HelmQueueItem) {
    this.pending = item.key;
    this.gone.add(item.key);
    this.changed();
    void this.queueCall({ act: "snooze", key: item.key }).catch(error => this.fail(error, () => this.gone.delete(item.key)));
  }

  /** Out of Today, back among the suggestions. */
  toSuggested(entry: HelmEntry) {
    this.pending = entry.key;
    this.into.delete(entry.key);
    this.out.add(entry.key);
    this.changed();
    void this.queueCall({ act: "today", key: entry.key, on: false }).catch(error => this.fail(error, () => this.out.delete(entry.key)));
  }

  /** Today in this order (Now's key first when Now is in Today, as Helm's board sends it). */
  reorder(keys: string[]) { this.sendOrder("order", keys, () => this.order, value => { this.order = value; }); }

  /** The small things in this order: every item's key. */
  reorderSmall(keys: string[]) { this.sendOrder("order_small", keys, () => this.smallOrder, value => { this.smallOrder = value; }); }

  private sendOrder(act: string, keys: string[], held: () => string[] | null, hold: (keys: string[] | null) => void) {
    const before = held();
    hold(keys);
    this.ordering++;
    this.changed();
    void this.queueCall({ act, keys })
      .catch(error => this.fail(error, () => hold(before)))
      .finally(() => { this.ordering--; });
  }

  /** Time on a project, logged now ("log 1h @Esono poprawki"). */
  logProject(projectId: number, minutes: number, note?: string, day?: string) {
    void this.queueCall({ act: "log_time", projectId, minutes, ...(note ? { note } : {}), ...(day ? { day } : {}) })
      .then(() => this.say("Logged", `${spoken(minutes)}${note ? ` · ${note.slice(0, 40)}` : ""}`))
      .catch(error => this.fail(error));
  }

  /** Answered: off the pill now, and read in Helm. */
  read(ids: number[]) {
    if (!ids.length) return;
    for (const id of ids) this.answered.add(id);
    this.changed();
    void call("helm_act", { action: { do: "read", ids } }).catch(error => this.fail(error));
  }

  /** A page of Helm in the browser, where he's signed in. */
  open(path: string) {
    void call("helm_open", { path }).catch(error => this.fail(error));
  }

  /* ── The cockpit ───────────────────────────────────────────────────── */

  /** A project's logo, once fetched; asks for it the first time it is wanted.
   *
   * ⚠️ Fetched through Rust, which holds the token (see `helm_logo`), and
   * remembered for the life of the page including "has none" — a project
   * without a logo would otherwise be asked about on every render. */
  logo(project: NotchProject | null): string | null {
    if (!project || project.logoVersion == null || project.logoVersion === "") return null;
    const key = `${project.id}:${project.logoVersion}`;
    if (this.logos.has(key)) return this.logos.get(key) ?? null;
    if (!this.askedLogo.has(key)) {
      this.askedLogo.add(key);
      void call<string | null>("helm_logo", { id: project.id, version: String(project.logoVersion) })
        .then(url => { this.logos.set(key, url ?? null); if (url) { this.logoTick++; this.changed(); } })
        .catch(() => { this.logos.set(key, null); });
    }
    return null;
  }

  /** Who an entry is for, as a tile: its Helm project when the cockpit knows it. */
  faceOf(entry: HelmEntry): Face | null {
    if (entry.type === "small") return { name: "small", icon: "list" };
    const project = projectById(entry.projectId, this.notch);
    const first = entry.items[0];
    if (!project && !entry.context) return first?.kind === "todo" ? { name: "you", icon: "you" } : null;
    return faceOf(project, this.logo(project), { name: entry.context ?? "", hue: first?.hue ?? null });
  }

  /** The request an item is, when the cockpit can act on it: a request Helm
   *  has a folder for. Without the cockpit, nothing — Start with Claude hides. */
  requestOf(entry: HelmEntry): { id: number; folder: NotchFolder | null } | null {
    if (entry.type !== "item" || !this.notch) return null;
    const id = requestIdOf(entry.items[0]);
    return id ? { id, folder: folderOfRequest(id, this.notch) } : null;
  }

  /** The Helm folder a Claude Code session is in, and the request it is on. */
  linkOf(session: { project: string; folder?: string | null }): { folder: NotchFolder; request: NotchRequest | null } | null {
    const folder = folderFor(session, this.notch);
    return folder ? { folder, request: doingRequest(folder) } : null;
  }

  /** Start Claude Code on a request: Helm marks it doing and hands over the
   *  prompt and the folder; Rust opens the terminal. */
  startWithClaude(requestId: number, title: string) {
    if (this.starting.has(requestId)) return;
    this.starting.add(requestId);
    this.changed();
    void call<string>("helm_start_claude", { id: requestId })
      .then(where => this.say("Claude is on it", `${title.slice(0, 48)} · ${where}`))
      .catch(error => this.say("Start with Claude", String(error).replace(/^(invoke error|error): /i, "").slice(0, 120)))
      .finally(() => { this.starting.delete(requestId); this.changed(); });
  }

  /** A run ended: if its session is on a request, ask whether it is done. */
  finished(run: Finish) {
    const link = this.linkOf({ project: run.project, folder: run.folder });
    const request = link?.request;
    if (!link || !request || !run.session) return;
    this.asks.set(run.session, {
      session: run.session, requestId: request.id, title: request.title, project: link.folder.project,
      at: Date.now(), stage: "ask", suggestion: null, minutes: request.estimate ?? 30, said: null,
    });
    this.changed();
  }

  askFor(session: string): Ask | null { return this.asks.get(session) ?? null; }

  /** Requests a run has just finished on, still asking "done?": the
   *  Guardian's chips offer to mark them done (sent to Helm as `finished`). */
  get finishedRequests(): number[] {
    return [...this.asks.values()].filter(ask => ask.stage === "ask").map(ask => ask.requestId);
  }

  /** Sessions as they stand now. ⚠️ A question about a run is dropped when the
   *  session runs AGAIN (he carried on — the run did not end the work) or goes
   *  away; one being answered is left to finish. */
  sessionsAre(sessions: { id: string; state: string }[]) {
    let dropped = false;
    for (const [id, ask] of this.asks) {
      const session = sessions.find(one => one.id === id);
      if (ask.stage === "ask" && (!session || session.state === "working")) {
        this.asks.delete(id);
        dropped = true;
      }
    }
    if (dropped) this.changed();
  }

  /** "Done?" answered. Not yet just puts the question away (the request stays
   *  doing); Done marks it done in Helm and shows the time it suggests logging. */
  answer(session: string, done: boolean) {
    const ask = this.asks.get(session);
    if (!ask || ask.stage !== "ask") return;
    if (!done) {
      this.asks.delete(session);
      this.changed();
      return;
    }
    ask.stage = "busy";
    this.changed();
    void call<{ ok?: boolean; suggestion?: Suggestion | null }>("helm_request", { id: ask.requestId, status: "done" })
      .then(answer => {
        const suggestion = answer?.suggestion ?? null;
        if (suggestion && suggestion.minutes > 0) {
          ask.suggestion = suggestion;
          ask.minutes = Math.round(suggestion.minutes);
          ask.stage = "suggest";
        } else {
          this.settle(ask, "Done");
        }
        this.changed();
      })
      .catch(error => {
        ask.stage = "ask";
        this.fail(error);
      });
  }

  setMinutes(session: string, minutes: number) {
    const ask = this.asks.get(session);
    if (!ask) return;
    ask.minutes = minutes;
    this.changed();
  }

  logAsk(session: string) {
    const ask = this.asks.get(session);
    if (!ask || ask.stage !== "suggest") return;
    ask.stage = "logging";
    this.changed();
    void call("helm_log", { id: ask.requestId, minutes: ask.minutes })
      .then(() => { this.settle(ask, `Logged ${spoken(ask.minutes)}`); this.changed(); })
      .catch(error => { ask.stage = "suggest"; this.fail(error); });
  }

  skipAsk(session: string) {
    if (this.asks.delete(session)) this.changed();
  }

  /** The answer stays on the card for a moment, then the card is itself again. */
  private settle(ask: Ask, said: string) {
    ask.stage = "done";
    ask.said = said;
    window.setTimeout(() => {
      if (this.asks.get(ask.session) === ask) {
        this.asks.delete(ask.session);
        this.changed();
      }
    }, 4000);
  }

  /** Log time on a request from somewhere other than a finished run — a
   *  Guardian card. Says how it went on the pill. */
  logTime(requestId: number, minutes: number): Promise<void> {
    return call("helm_log", { id: requestId, minutes })
      .then(() => this.say("Logged", spoken(minutes)))
      .catch(error => { this.fail(error); throw error; });
  }

  /* ── Round 2: projects, the focus, speech, and the cards' actions ───── */

  /** Say something on the pill, for the screens that have no `say` of their own. */
  tell(what: string, why: string) { this.say(what, why); }

  /** `/api/notch/projects`: every project, for the `@` picker and the focus.
   *  null until read, and null for a Helm without it — then the cockpit's
   *  folders stand in, so the picker still knows the projects on this PC. */
  private allProjects: MentionProject[] | null = null;
  private askedProjects = false;

  get projects(): MentionProject[] {
    if (!this.askedProjects && this.signedIn) {
      this.askedProjects = true;
      void call<{ projects?: MentionProject[] } | null>("helm_projects")
        .then(answer => {
          const list = Array.isArray(answer?.projects) ? answer!.projects.filter(p => p && typeof p.id === "number" && typeof p.name === "string") : null;
          this.allProjects = list;
          if (list) this.changed();
        })
        // ⚠️ Asked again a minute later, not on the next render — this getter
        // runs on every one, and a failing Helm would be asked forty times.
        .catch(() => { window.setTimeout(() => { this.askedProjects = false; }, 60_000); });
    }
    if (this.allProjects?.length) return this.allProjects;
    const seen = new Set<number>();
    return (this.notch?.folders ?? []).map(f => f.project).filter(p => !seen.has(p.id) && !!seen.add(p.id))
      .map(p => ({ id: p.id, name: p.name, client: p.client, hue: p.hue, logoVersion: p.logoVersion, personal: p.personal, live: (this.notch?.folders.find(f => f.project.id === p.id)?.requests ?? []).some(r => r.status === "doing") }));
  }

  /** A project's face, with its logo once fetched. */
  faceOfProject(project: MentionProject): Face | null {
    const known = { id: project.id, name: project.name, logoVersion: project.logoVersion ?? null, hue: project.hue ?? null, client: project.client ?? null, personal: !!project.personal } as NotchProject;
    return faceOf(known, this.logo(known), null);
  }

  /** The Guardian's project focus, sent with every message (`focus`). Kept
   *  across a restart: it is what he is working on, not a passing filter. */
  focus: number | null = load<number | null>("helm-focus", null);

  setFocus(id: number | null) {
    this.focus = id;
    save("helm-focus", id);
    this.changed();
  }

  get focusProject(): MentionProject | null {
    return this.focus === null ? null : this.projects.find(p => p.id === this.focus) ?? null;
  }

  /** The agents' minutes today on a project — set by the shell, which has the
   *  Agents screen's own count of what ran where. */
  agentMinutes: ((folders: string[]) => number) | null = null;

  /** A project's time today: his (Helm's blocks for it) and the agents'
   *  (this machine's runs in its folders). Both real readings; neither is a
   *  guess at a share of the day's total. */
  timeToday(project: MentionProject): { you: number; agents: number } {
    const you = this.blocks.filter(b => b.project === project.name && (b.status !== "planned"))
      .reduce((total, b) => total + blockSeconds(b, this.helm.skewMs) / 60, 0);
    const folders = (this.notch?.folders ?? []).filter(f => f.project.id === project.id).map(f => f.folder);
    const agents = folders.length && this.agentMinutes ? this.agentMinutes(folders) : 0;
    return { you: Math.round(you), agents: Math.round(agents) };
  }

  /** Requests marked done here, hidden from lists until the next reading agrees. */
  doneHere = new Set<number>();

  /** Done on a request from a card or the project panel. */
  async requestDone(id: number): Promise<boolean> {
    try {
      const answer = await call<{ ok?: boolean; suggestion?: Suggestion | null }>("helm_request", { id, status: "done" });
      this.doneHere.add(id);
      const minutes = answer?.suggestion?.minutes;
      this.say("Done", minutes ? `Helm suggests logging ${spoken(minutes)}` : "Marked done in Helm");
      this.changed();
      return true;
    } catch (error) {
      this.fail(error);
      return false;
    }
  }

  /** Send a payment reminder at a level. Answers what Helm said; `already`
   *  when that level was sent before (Helm's 409). */
  async remind(paymentId: number | string, level: string): Promise<{ ok: boolean; sentTo?: string; error?: string; already?: boolean }> {
    try {
      const answer = await call<{ ok?: boolean; sentTo?: string; error?: string; status?: number } | null>("helm_remind", { paymentId: String(paymentId), level });
      return answer?.ok ? { ok: true, sentTo: answer.sentTo } : { ok: false, error: answer?.error ?? "Helm didn't send it.", already: answer?.status === 409 };
    } catch (error) {
      return { ok: false, error: String(error).replace(/^(invoke error|error): /i, "").slice(0, 120) };
    }
  }

  /** Bill or remind a renewal. */
  async renewal(id: number | string, action: "bill" | "remind", period: string | null = null): Promise<{ ok: boolean; error?: string }> {
    try {
      const answer = await call<{ ok?: boolean; error?: string } | null>("helm_renewal", { id: String(id), action, send: true, period });
      return answer?.ok ? { ok: true } : { ok: false, error: answer?.error ?? "Helm said no." };
    } catch (error) {
      return { ok: false, error: String(error).replace(/^(invoke error|error): /i, "").slice(0, 120) };
    }
  }

  /** Hold to talk, through Helm's `/api/transcribe`.
   *
   * ⚠️ "unknown" until asked, and asked once: a Helm without the endpoint
   * (404) or without speech set up (503) hides the mic for the session — a
   * button that can only fail is worse than none (AGENTS 101). It comes back
   * after a reconnect. */
  private speech: "unknown" | "asking" | "yes" | "no" = "unknown";

  readonly voice: Voice = {
    available: () => {
      if (!this.signedIn) return false;
      if (this.speech === "unknown") {
        this.speech = "asking";
        void call<boolean>("helm_transcribe_ready")
          .then(ready => { this.speech = ready ? "yes" : "no"; this.changed(); })
          .catch(() => { window.setTimeout(() => { this.speech = "unknown"; }, 60_000); });
      }
      return this.speech === "yes";
    },
    // No `lang`: Helm hears Polish or English and writes each down as it was said.
    transcribe: async (audio: string, mime: string) => {
      const answer = await call<{ text?: string; unavailable?: boolean } | null>("helm_transcribe", { audio, mime });
      if (answer?.unavailable) {
        this.speech = "no";
        this.changed();
        throw new Error("Speech isn't set up in Helm");
      }
      return String(answer?.text ?? "");
    },
  };

  /** The question on the strip, for a while after the run ended. */
  askClaim(): Activity | null {
    const fresh = [...this.asks.values()].filter(ask => ask.stage === "ask" && Date.now() - ask.at < ASK_ON_PILL_MS);
    const newest = fresh.sort((a, b) => b.at - a.at)[0];
    if (!newest) return null;
    return {
      /* 56: over an agent waiting (55) — it is the same session, and this is
       * the more specific thing to say about it — and under a nudge and a call. */
      priority: 56,
      screen: "agents",
      kind: "event",
      icon: "check",
      label: `${newest.title} done?`,
      value: newest.project.name,
    };
  }

  /** The session the strip's question is about, so opening the island lands on it. */
  askedSession(): string | null {
    const fresh = [...this.asks.values()].filter(ask => ask.stage === "ask").sort((a, b) => b.at - a.at)[0];
    return fresh?.session ?? null;
  }

  /** The newest unread nudge, on the strip. ⚠️ Its ACTION and its age, never
   *  its words: the strip is on screen all day, shared screens included, and
   *  the sentence is one look away in the Guardian. */
  nudgeClaim(): Activity | null {
    const newest = this.nudges.at(-1);
    if (!newest) return null;
    return {
      priority: 80,
      screen: "guardian",
      kind: "day",
      icon: "guardian",
      label: nudgeAction(newest, this.blocks, [...this.today, ...this.suggested]).label,
      value: ago(newest.at),
    };
  }

  /** The running (or paused) session, on the strip where the focus session was:
   *  45, over music, under a meeting about to start.
   *  ⚠️ No ticking digits (his call, 30 Oct: a number changing every second on
   *  screen all day). The ring is the progress; the far slot is Pause or Resume,
   *  the hero's own action; the coarse time is the tooltip (AGENTS 878). */
  blockClaim(): Activity | null {
    const block = liveBlock(this.blocks);
    if (!block) return null;
    const seconds = blockSeconds(block, this.helm.skewMs);
    const held = block.status !== "running";
    return {
      priority: 45,
      screen: "helm",
      kind: "focus",
      icon: "target",
      phase: "work",
      label: block.title,
      value: held ? "Paused" : block.project ?? "",
      held,
      progress: Math.min(1, seconds / Math.max(60, block.minutes * 60)),
      controls: [held
        ? { action: "helm:start", icon: "play", label: "Resume" }
        : { action: "helm:pause", icon: "pause", label: "Pause" }],
      tip: `${spoken(Math.floor(seconds / 60))} of ${spoken(block.minutes)}`,
    };
  }
}

/* ── The screen ───────────────────────────────────────────────────────────
 *
 * ⚠️ Four levels, in Helm's order of weight (its DESIGN.md): the hero (Now),
 * what is next (Today's rows), what needs a decision (Needs you), and the
 * passive readings (the clock in the header). Everything else is quieter than
 * the one above it — the header's figures are the smallest thing with a colour,
 * the rows carry one chip at most, and the only filled accent is Start (or Done
 * while a session runs).
 *
 * ── Blocks (round 2) ────────────────────────────────────────────────────
 * Now, Needs you, Agents, Today and Suggested are BLOCKS: each folds from its
 * header (remembered), and the Blocks menu in the header hides or shows each
 * (remembered). All of them live in the one scroller (AGENTS 323, 751), with
 * the composer pinned under it — never over it: the foot is opaque, and the
 * list fades only where there is more to scroll to.
 */
type BlockId = "now" | "needs" | "agents" | "today" | "suggested";
/* ── The rail (30 Oct, his call: "a long list with little to no hierarchy") ──
 * Two columns in the ONE scroller: the main column is Now (the hero) and Today;
 * the rail beside it — a hairline, not a card (AGENTS 698) — holds what is
 * read rather than worked: the day at a glance, Needs you, Suggested, Agents.
 * The header's toggle shows or hides it (remembered, `today-rail`). Shown, it
 * is room ADDED to the panel (`extraWidth`, AGENTS 687), so Now keeps its
 * width. ⚠️ One scroller holding a flex row, so `measure()` sums one child
 * whose height is the taller column (AGENTS 789). */
export const RAIL_W = 228;

const BLOCKS: { id: BlockId; title: string; icon: TaskIcon }[] = [
  { id: "now", title: "Now", icon: "target" },
  { id: "needs", title: "Needs you", icon: "bell" },
  { id: "agents", title: "Agents", icon: "agent" },
  { id: "today", title: "Today", icon: "today" },
  { id: "suggested", title: "Suggested", icon: "guardian" },
];

const HTML = `
  <div class="helm-shell leads"><div class="helm-main lead">
  <div class="helm-top">
  <div class="day-head helm-head">
    <div class="helm-must"><span class="helm-must-mark" aria-hidden="true"></span><span class="helm-must-text"></span></div>
    <div class="helm-figures">
      <span class="helm-load" hidden><span class="helm-load-text"></span><span class="helm-load-bar" aria-hidden="true"><i></i></span></span>
      <span class="helm-fig is-done" hidden><span class="helm-fig-mark" aria-hidden="true"></span><b class="helm-fig-value"></b><span class="helm-fig-word">done</span></span>
      <span class="helm-fig is-you" hidden><span class="helm-fig-mark" aria-hidden="true"></span><b class="helm-fig-value"></b><span class="helm-fig-word">you</span></span>
      <span class="helm-fig is-agents" hidden><span class="helm-fig-mark" aria-hidden="true"></span><b class="helm-fig-value"></b><span class="helm-fig-word">Claude</span></span>
    </div>
    <div class="helm-blocks-anchor"></div>
    <button type="button" class="k-icon helm-close-day" aria-label="Zamknij dzień" data-tip="Zamknij dzień"></button>
    <button type="button" class="k-icon helm-rail-toggle" aria-label="Show the side" data-tip="Show the side"><span class="helm-rail-toggle-mark" aria-hidden="true"></span><b class="helm-rail-count" hidden></b></button>
  </div>
  <div class="day-rail"><i class="helm-rail-fill"></i></div>
  </div>
  <div class="task-list scrolls helm-list"><div class="helm-cols"><div class="helm-col"></div><aside class="helm-side" aria-label="The day"><section class="helm-glance"></section></aside></div></div>
  <div class="helm-foot"></div>
  </div></div>
`;
/* Now: the face and the title, the Guardian's why, then the focus scale — the
 * reading, the segments with the clock at both ends, the actions — and a
 * group's or the small things' items right under it. */
const HERO = `
  <section class="helm-hero">
    <div class="helm-now-head">
      <span class="helm-now-face"></span>
      <div class="helm-now-text">
        <div class="helm-now-line"><span class="helm-hero-title"></span><span class="helm-now-marks"></span></div>
        <div class="helm-hero-sub"></div>
      </div>
    </div>
    <p class="helm-why" hidden><span class="helm-why-mark" aria-hidden="true"></span><span class="helm-why-text"></span></p>
    <div class="helm-now-bar" role="timer">
      <div class="helm-read"><time class="helm-left"></time><span class="helm-state"><span class="helm-state-mark" aria-hidden="true"></span><span class="helm-state-word"></span></span></div>
      <div class="helm-scale" aria-hidden="true"><div class="helm-segs"></div><div class="helm-ends"><span class="helm-from"></span><span class="helm-to"></span></div></div>
      <div class="helm-now-acts">
        <button type="button" class="helm-claude" aria-label="Start with Claude" data-tip="Start with Claude" hidden></button>
        <button type="button" class="helm-later" aria-label="Not today" data-tip="Not today"></button>
        <button type="button" class="helm-finish" aria-label="Done" data-tip="Done"></button>
        <button type="button" class="helm-more" aria-label="Add 5 minutes" data-tip="Add 5 minutes" hidden>+5 min</button>
        <button type="button" class="helm-toggle"><span class="hp-btn-mark helm-toggle-mark" aria-hidden="true"></span><span class="helm-toggle-word"></span></button>
      </div>
    </div>
    <div class="helm-now-items" role="list"></div>
  </section>`;

/** "24:05", "1:04:05" — the focus scale's reading, as Helm's FocusScale writes it. */
export function reading(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(h ? 2 : 1, "0");
  return `${h ? `${h}:` : ""}${mm}:${String(s % 60).padStart(2, "0")}`;
}

/** Minutes per segment, Helm's: one a minute up to half an hour, so a session is 15 to 30 of them. */
export const perSegment = (minutes: number) => (minutes <= 30 ? 1 : minutes <= 60 ? 2 : minutes <= 120 ? 4 : 6);

/** "15:40" for minutes since midnight. */
const clockAt = (minutes: number) => {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};
const minutesOf = (at: Date) => at.getHours() * 60 + at.getMinutes() + at.getSeconds() / 60;

/** When the work committed to Today is done if he goes at it from now, around the
 *  meetings: the day strip's projection. Minutes since midnight. */
export function finishAt(now: number, committed: number, meetings: { from: number; to: number }[]): number {
  let at = now;
  let left = committed;
  for (const m of [...meetings].sort((a, b) => a.from - b.from)) {
    if (m.to <= at) continue;
    if (m.from > at) {
      const room = m.from - at;
      if (left <= room) return at + left;
      left -= room;
    }
    at = Math.max(at, m.to);
  }
  return at + left;
}

/** The minutes an entry runs for, when that is worth a figure on its row. */
function rowMinutes(entry: HelmEntry): string {
  const single = entry.type === "item" ? entry.items[0] : null;
  if (single && (isMoney(single) || single.kind === "log")) return "";
  return spoken(entry.minutes);
}

/** A live agent session, as Today's Agents block shows it. */
export interface BriefSession {
  id: string;
  project: string;
  provider?: string;
  state: "working" | "waiting" | "idle";
  doing?: string | null;
  thinking?: string | null;
  folder?: string | null;
}

export interface TodayHooks {
  /** The live sessions, from the Agents screen. */
  sessions: () => BriefSession[];
  /** Open one on the Agents screen. */
  openSession: (id: string) => void;
  /** The project panel opened or shut: the shell re-applies the width cap (AGENTS 759). */
  width: () => void;
  /** A line with a `/command` goes to the Guardian to file. */
  file: (sent: Sent) => boolean;
  /** Today's calendar, from the Calendar screen's feed (none while it isn't connected). */
  events?: () => CalEvent[];
  /** The day was closed in the close view (batch 12). */
  closed?: (first: string | null) => void;
}

export class HelmTodayScreen {
  private host: HTMLElement;
  private source: HelmSource;
  private surface: IslandSurface;
  private changed: () => void;
  private hooks: TodayHooks;
  private drawn = "";
  /** Groups opened to their items. */
  private open = new Set<string>();
  /** Set for ONE render: the Suggested block was just opened, so bring its rows into view. */
  private reveal = false;
  private blocks = new Map<BlockId, Block>();
  /** On while a row is being dragged: the render waits, or the rebuilt list would drop it. */
  private dragging = false;
  /** The day at a glance, between Now and the rest — a strip, not a block. */
  private day = element("div", "helm-day");
  private dayDrawn = "";
  /** The segments drawn for this length, so `tick` only moves their fill. */
  private segsFor = "";
  /** Blocks switched off in the Blocks menu. ⚠️ Stored as what is HIDDEN, so
   *  an empty list means "all of them" for an older file (AGENTS 246). */
  private hidden = new Set<BlockId>(load<BlockId[]>("today-hidden", []).filter(id => BLOCKS.some(b => b.id === id)));
  private menu: Dropdown;
  readonly composer: Composer;
  /** The selected session's project, beside the screen. */
  readonly side = new SidePanel({ id: "today-agent", side: "right", label: "Project", className: "agent-side today-side" });
  /** Which live session the panel is about. */
  private picked: string | null = null;
  /** The screen's own width in CSS px, without the panel — set by the shell. */
  mainCss = 680;
  /** The rail beside Today, shown (remembered). */
  private railOn = load<boolean>("today-rail", true);
  /** Closing the day (batch 12): a focused view in place of Today's list. */
  readonly close: HelmClose;

  constructor(host: HTMLElement, source: HelmSource, surface: IslandSurface, changed: () => void, hooks: TodayHooks) {
    this.host = host;
    this.source = source;
    this.surface = surface;
    this.changed = changed;
    this.hooks = hooks;
    host.innerHTML = HTML;
    this.close = new HelmClose(source, {
      back: () => this.closeDay(false),
      // ⚠️ Through the shell, so the island measures again (AGENTS 788).
      changed: () => { this.surface.deliberately(); this.changed(); },
      input: on => { void surface.input(on).catch(() => {}); },
      closed: first => hooks.closed?.(first),
    });
    this.get(".helm-main").insertBefore(this.close.el, this.get(".helm-foot"));
    const closeDay = this.get<HTMLButtonElement>(".helm-close-day");
    paintIcon(closeDay, "moon");
    closeDay.onclick = () => this.closeDay(true);
    this.side.el.style.setProperty("--side-w", `${AGENT_PANEL_W}px`);
    this.get(".helm-shell").append(this.side.el);
    const list = this.get(".helm-list");
    list.addEventListener("scroll", () => this.edges(), { passive: true });
    const col = this.get(".helm-col");
    const rail = this.get(".helm-side");
    for (const def of BLOCKS) {
      const block = new Block({
        id: `today-${def.id}`, title: def.title, icon: def.icon, open: true,
        className: `helm-block is-${def.id}`,
        toggled: () => {
          if (def.id === "suggested") this.reveal = block.open;
          this.drawn = "";
          // ⚠️ Through the SHELL, so the island measures again (AGENTS 788).
          this.surface.deliberately();
          this.changed();
        },
      });
      this.blocks.set(def.id, block);
    }
    // Main: Now, then Today. The rail: the day at a glance, Needs you, Suggested, Agents.
    col.append(this.blocks.get("now")!.el, this.blocks.get("today")!.el);
    rail.append(this.blocks.get("needs")!.el, this.blocks.get("suggested")!.el, this.blocks.get("agents")!.el);
    this.blocks.get("now")!.body.innerHTML = HERO;
    this.get(".helm-glance").append(this.get(".helm-load"), this.day);
    const railToggle = this.get<HTMLButtonElement>(".helm-rail-toggle");
    paintIcon(this.get(".helm-rail-toggle-mark"), "sideRight");
    railToggle.onclick = () => {
      this.railOn = !this.railOn;
      save("today-rail", this.railOn);
      this.drawn = "";
      // ⚠️ Through the shell: the width and the height both change (AGENTS 788).
      this.surface.deliberately();
      this.hooks.width();
      this.changed();
    };
    this.blocks.get("needs")!.body.append(element("div", "helm-needs"));
    this.blocks.get("agents")!.body.append(element("div", "helm-agents"));
    this.blocks.get("today")!.body.append(element("div", "helm-rows"));
    this.blocks.get("suggested")!.body.append(element("div", "helm-sugg"));
    this.get(".helm-needs").setAttribute("role", "list");
    this.get(".helm-needs").setAttribute("aria-label", "Needs you");

    // The Blocks menu: one switch per block.
    const anchor = this.get(".helm-blocks-anchor");
    const button = element("button", "k-icon helm-blocks-button") as HTMLButtonElement;
    button.type = "button";
    paintIcon(button, "blocks");
    button.setAttribute("aria-label", "Blocks");
    button.dataset.tip = "Blocks";
    anchor.append(button);
    this.menu = new Dropdown(button, anchor, {
      label: "Blocks", sticky: true, className: "helm-blocks-menu",
      items: () => BLOCKS.map(def => ({ id: def.id, label: def.title, icon: def.icon, checked: !this.hidden.has(def.id) })),
      pick: item => {
        const id = item.id as BlockId;
        if (this.hidden.has(id)) this.hidden.delete(id);
        else this.hidden.add(id);
        save("today-hidden", [...this.hidden]);
        this.drawn = "";
        this.surface.deliberately();
        this.changed();
      },
    });

    this.composer = new Composer({
      id: "today",
      label: "Add to today",
      placeholder: "Add to today",
      maxLength: 280,
      lines: 4,
      lift: on => surface.input(on),
      editing: () => surface.editing,
      /* A command is something for the Guardian to file. Anything else is read
       * here (`helm-quick`): "log 1h @Esono poprawki" logs time on the project,
       * any other line goes into Today with its project, length and day. */
      send: sent => {
        if (sent.command) return this.hooks.file(sent);
        const quick = parseQuick(sent.text, { projects: source.projects, mentioned: sent.mentions.map(m => m.projectId), today: localDay() });
        if ("error" in quick) { source.tell("Today", quick.error); return false; }
        if (quick.act === "log_time") source.logProject(quick.projectId, quick.minutes, quick.note, quick.day);
        else {
          const { title, act: _act, ...more } = quick;
          source.add(title, more);
        }
        return true;
      },
      voice: source.voice,
      projects: () => source.projects,
      face: project => source.faceOfProject(project),
      commands: true,
      resized: () => surface.measure(),
      closed: () => { this.composer.field.blur(); void surface.input(false).catch(() => {}); },
      say: (what, why) => source.tell(what, why),
      className: "helm-composer",
    });
    this.get(".helm-foot").append(this.composer.el);

    paintIcon(this.get(".helm-must-mark"), "today");
    paintIcon(this.get(".helm-why-mark"), "guardian");
    paintIcon(this.get(".helm-finish"), "check");
    paintIcon(this.get(".helm-later"), "later");
    paintIcon(this.get(".helm-claude"), "claude");
    paintIcon(this.get(".is-done .helm-fig-mark"), "check");
    paintIcon(this.get(".is-you .helm-fig-mark"), "you");
    paintIcon(this.get(".is-agents .helm-fig-mark"), "claude");
    this.wire();
  }

  private get<T extends HTMLElement = HTMLElement>(selector: string): T {
    return this.host.querySelector<T>(selector)!;
  }

  /** What the hero speaks for: the live session (and its entry), else Today's first. */
  private now(): { live: HelmBlock | null; entry: HelmEntry | null } {
    const live = liveBlock(this.source.blocks);
    return { live, entry: live ? this.source.entryOf(live) : this.source.today[0] ?? null };
  }

  private wire() {
    this.get(".helm-toggle").onclick = () => {
      const { live, entry } = this.now();
      if (live) {
        if (live.status === "running") this.source.pause(live.id);
        else this.source.start(live.id);
      } else if (entry) this.source.startEntry(entry);
    };
    this.get(".helm-later").onclick = () => {
      const { live, entry } = this.now();
      if (!live && entry) this.source.later(entry);
    };
    this.get(".helm-finish").onclick = () => {
      const { live, entry } = this.now();
      if (entry?.type === "item") this.source.doneItem(entry.items[0]);
      else if (live) this.source.doneBlock(live.id);
    };
    this.get(".helm-more").onclick = () => {
      const { live } = this.now();
      if (live) this.source.extend(live.id);
    };
    this.get(".helm-claude").onclick = () => {
      const { entry } = this.now();
      const request = entry ? this.source.requestOf(entry) : null;
      if (entry && request) this.source.startWithClaude(request.id, entry.title);
    };
  }

  /** Closing the day, in place of Today's list (true), or back to Today. */
  closeDay(on: boolean) {
    if (on === this.close.open) return;
    if (on) this.close.show();
    else {
      this.close.hide();
      void this.surface.input(false).catch(() => {});
    }
    for (const sel of [".helm-top", ".helm-list", ".helm-foot"]) this.get(sel).classList.toggle("is-closing", on);
    this.drawn = "";
    this.surface.deliberately();
    this.changed();
  }

  /** Escape while the composer holds the caret: its own Escape first (a
   *  picker, a recording, the words), then the caret is released. Closing
   *  the day: Escape goes back to Today. */
  escape(): boolean {
    if (this.close.open) { this.closeDay(false); return true; }
    if (this.menu.open) { this.menu.close(); return true; }
    if (document.activeElement !== this.composer.field) return false;
    if (this.composer.escape()) return true;
    this.composer.field.blur();
    void this.surface.input(false).catch(() => {});
    return true;
  }

  render() {
    // ⚠️ Not mid-drag: the rows are the drag, and a rebuilt list would drop the one in hand.
    if (this.dragging) return;
    const { helm, pending } = this.source;
    const today = this.source.today;
    const suggested = this.source.suggested;
    const notch = this.source.notch;
    const { live, entry } = this.now();
    const sessions = this.hooks.sessions().filter(one => one.state !== "idle");
    this.composer.refresh();
    /* ⚠️ Keyed: `render()` runs every second with the shell, and rebuilding
     * the rows each time throws away the hover. The clock moves in `tick`. */
    const shape = (e: HelmEntry) => [e.key, e.title, e.dueOn, e.minutes, e.why, e.items.map(i => i.key).join()];
    const key = JSON.stringify([helm.connected, helm.signedIn, helm.error, helm.queueError, pending, [...this.open], [...this.hidden],
      [...this.blocks].map(([id, b]) => [id, b.open]),
      live && [live.id, live.status, live.title, live.minutes, live.project], helm.queue?.doneToday, helm.queue?.snoozed, helm.queue?.workedMinutes, helm.queue?.freeMinutes,
      today.map(shape), suggested.map(shape), notch, this.source.logoTick, [...this.source.starting],
      sessions.map(s => [s.id, s.state, s.doing, s.thinking, s.project]), this.side.open, this.picked, [...this.source.doneHere],
      this.railShown, this.surface.edge]);
    if (key === this.drawn) return;
    this.drawn = key;

    const ready = helm.connected && helm.signedIn;
    this.get(".helm-foot").hidden = !ready;
    this.get(".helm-top").hidden = !ready;
    const list = this.get(".helm-list");
    list.querySelector(".day-empty")?.remove();
    if (!ready) {
      for (const block of this.blocks.values()) block.el.hidden = true;
      list.append(helm.connected
        ? this.empty("Sign in to Helm again", "Today is read as you, so it needs your session. Settings → Connections → Helm.", true)
        : this.empty("Helm isn't connected", "Sign in to Helm and Today, the sessions and the Guardian live here.", true));
      return;
    }

    this.paintHead(today, notch);
    this.paintRail(notch?.needs.length ?? 0);

    // ── Now
    const now = this.blocks.get("now")!;
    now.el.hidden = this.hidden.has("now") || (!live && !entry);
    this.paintNow(live, entry, pending);
    now.summary(entry?.title ?? live?.title ?? "");

    // ── Needs you
    const needs = notch?.needs ?? [];
    const needsBlock = this.blocks.get("needs")!;
    needsBlock.el.hidden = this.hidden.has("needs") || !needs.length;
    needsBlock.count(needs.length);
    this.paintNeeds(needs);

    // ── Agents: the live sessions in brief
    const agents = this.blocks.get("agents")!;
    agents.el.hidden = this.hidden.has("agents") || !sessions.length;
    agents.count(sessions.length);
    this.paintAgents(sessions);
    this.paintSide();

    /* ── Today: everything but Now, in his order, each dragged to reorder.
     * ⚠️ Now is left out by KEY (`entryOf` found it by the session's key, or
     * by its title with the counts taken out), so the entry running is never
     * listed twice. Each entry is one box with its items, so an open group
     * moves as one. */
    const todayBlock = this.blocks.get("today")!;
    const rows = this.get(".helm-rows");
    rows.replaceChildren();
    const rest = today.filter(e => e.key !== entry?.key);
    if (!rest.length && !live && !entry) rows.append(this.empty("Today is empty", "Take one from the suggestions below, or add your own.", false));
    const nowInToday = !!entry && today.some(e => e.key === entry.key);
    for (const e of rest) {
      const box = element("div", "helm-entry");
      box.dataset.key = e.key;
      box.append(this.entryRow(e, false));
      if (e.type !== "item" && this.open.has(e.key)) box.append(this.itemList(e));
      sortable(box, {
        rows: () => [...rows.querySelectorAll<HTMLElement>(":scope > .helm-entry")],
        moving: on => { this.dragging = on; },
        dropped: keys => this.source.reorder(nowInToday && entry ? [entry.key, ...keys] : keys),
      });
      rows.append(box);
    }
    const error = helm.queueError ?? helm.error;
    if (error) rows.append(element("p", "helm-error", error));
    todayBlock.el.hidden = this.hidden.has("today") || (!rows.childElementCount);
    todayBlock.summary(rest.length ? rest.map(e => e.title).slice(0, 2).join(", ") : "");

    // ── Suggested
    const sugg = this.blocks.get("suggested")!;
    const snoozed = helm.queue?.snoozed ?? 0;
    sugg.el.hidden = this.hidden.has("suggested") || (!suggested.length && !snoozed);
    sugg.count(suggested.length);
    sugg.end.replaceChildren();
    if (snoozed) {
      const later = element("span", "helm-tomorrow");
      const mark = element("span", "helm-tomorrow-mark");
      paintIcon(mark, "later");
      later.append(mark, element("b", "", String(snoozed)));
      const said = `${snoozed} moved to tomorrow`;
      later.dataset.tip = said;
      later.setAttribute("aria-label", said);
      sugg.end.append(later);
    }
    /* ⚠️ Drawn only while the block is open: rows held hidden in the DOM are
     * rows a screen reader, a search and a test all still find. */
    const suggRows = this.get(".helm-sugg");
    suggRows.replaceChildren(...(sugg.open ? suggested.map(e => this.entryRow(e, true)) : []));

    this.menu.refresh();
    this.dayDrawn = "";
    this.tick();
    requestAnimationFrame(() => this.edges());

    /* The Suggested block was just opened: bring what it revealed into view.
     * ⚠️ After the measure, on the next frame, or its rows land below the
     * visible part of the list with nothing scrolling to them (AGENTS 788). */
    if (this.reveal) {
      this.reveal = false;
      requestAnimationFrame(() => {
        const block = sugg.el;
        const top = block.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop - 4;
        list.scrollTo({ top, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
      });
    }
  }

  /** The rail shown or hidden, and its toggle. Hidden, the toggle carries what
   *  needs him as a count, so a decision waiting is not hidden with it. */
  private paintRail(needs: number) {
    const shown = this.railShown;
    this.get(".helm-side").hidden = !shown;
    this.get(".helm-cols").classList.toggle("has-rail", shown);
    const toggle = this.get(".helm-rail-toggle");
    toggle.hidden = isVertical(this.surface.edge);
    toggle.classList.toggle("is-on", shown);
    toggle.setAttribute("aria-pressed", String(shown));
    const tip = shown ? "Hide the side" : needs ? `Show the side · ${needs} need you` : "Show the side";
    toggle.dataset.tip = tip;
    toggle.setAttribute("aria-label", tip);
    const count = this.get(".helm-rail-count");
    count.hidden = shown || !needs;
    count.textContent = String(needs);
  }

  /** Fade the list's edges where there is more to scroll to (AGENTS 790). */
  edges() {
    const list = this.get(".helm-list");
    const more = list.scrollHeight - list.clientHeight;
    list.classList.toggle("is-above", more > 1 && list.scrollTop > 1);
    list.classList.toggle("is-below", more > 1 && list.scrollTop < more - 1);
  }

  /** The work committed to Today, less what the running session has already done of its own. */
  private committed(today: HelmEntry[]): number {
    const { live, entry } = this.now();
    const ran = live && entry ? Math.min(entry.minutes, blockSeconds(live, this.source.helm.skewMs) / 60) : 0;
    return Math.max(0, today.reduce((total, e) => total + e.minutes, 0) - (entry && today.some(e => e.key === entry.key) ? ran : 0));
  }

  /** The header: how much is in Today, its load against the free time left (amber over), and the
   *  day's figures — done, his own time, Claude's — each a mark, a figure and its word.
   *  ⚠️ The word is the figure's name, not an explanation: a bare "1 h 25" beside a mark
   *  he had to guess at was the complaint. */
  private paintHead(today: HelmEntry[], notch: Notch | null) {
    const helm = this.source.helm;
    const count = today.length;
    this.get(".helm-must-text").textContent = count ? `${count} in Today` : helm.queue ? "Today is empty" : "Reading Today…";
    this.get(".helm-must").classList.toggle("is-empty", !count);
    const done = helm.queue?.doneToday ?? 0;
    const total = done + count;
    this.get(".helm-rail-fill").style.width = total ? `${(done / total) * 100}%` : "0";

    const free = helm.queue?.freeMinutes;
    const load = this.get(".helm-load");
    load.hidden = free == null || !count;
    if (free != null) {
      const committed = this.committed(today);
      const over = committed > free;
      const said = `${spoken(Math.round(committed / 5) * 5)} of ${free ? `~${spoken(Math.round(free / 15) * 15)}` : "0 min"} free`;
      this.get(".helm-load-text").textContent = said;
      this.get<HTMLElement>(".helm-load-bar i").style.width = `${free ? Math.min(1, committed / free) * 100 : 100}%`;
      load.classList.toggle("is-over", over);
      const tip = over ? `Today holds ${spoken(committed - free)} more than the free time left` : `Today's work against the free time left`;
      load.dataset.tip = tip;
      load.setAttribute("aria-label", `${said}. ${tip}`);
    }

    const figure = (cls: string, show: boolean, value: string, tip: string) => {
      const fig = this.get(`.helm-fig.${cls}`);
      fig.hidden = !show;
      fig.querySelector(".helm-fig-value")!.textContent = value;
      fig.dataset.tip = tip;
      fig.setAttribute("aria-label", tip);
    };
    figure("is-done", done > 0, String(done), `${done} done today`);
    const you = notch ? notch.clock.you : helm.queue?.workedMinutes ?? 0;
    figure("is-you", you > 0, spoken(you), `Your time today: ${spoken(you)}`);
    const agents = notch?.clock.agents ?? 0;
    figure("is-agents", agents > 0, spoken(agents), `Claude's time today: ${spoken(agents)}`);
  }

  /** The day at a glance: today's meetings on a line from his day's start to its close, now on
   *  it, the committed work projected from now around the meetings (amber past the close), and
   *  the money due today. ⚠️ One line, under Now: a reading, not a block — it has no fold.
   *  Painted from `tick` once a minute; the line moves with the clock. */
  private paintDay() {
    const strip = this.day;
    const events = (this.hooks.events?.() ?? []).filter(e => !e.allDay && e.response !== "declined");
    const today = localDay();
    const at = new Date();
    const meetings = events
      .filter(e => localDay(startOf(e)) === today)
      .map(e => ({ title: e.title, from: minutesOf(startOf(e)), to: Math.max(minutesOf(startOf(e)) + 5, localDay(endOf(e)) === today ? minutesOf(endOf(e)) : 1440), color: e.color }));
    const money = this.moneyToday();
    const committed = this.committed(this.source.today);
    const key = JSON.stringify([Math.floor(at.getTime() / 60_000), meetings, money.map(m => m.title), committed, this.hidden.has("now")]);
    if (key === this.dayDrawn) return;
    this.dayDrawn = key;
    strip.replaceChildren();
    strip.hidden = !meetings.length && !money.length && !committed;
    if (strip.hidden) return;

    const now = minutesOf(at);
    const rhythm = this.source.helm.today?.rhythm;
    const from = Math.min(rhythm?.start ?? 8 * 60, ...meetings.map(m => m.from), now);
    const close = rhythm?.close ?? 18 * 60;
    const until = Math.max(close, ...meetings.map(m => m.to), now + 30);
    const span = Math.max(60, until - from);
    const x = (minutes: number) => `${((Math.min(until, Math.max(from, minutes)) - from) / span) * 100}%`;

    // The next meeting, said; the rest are on the line with their names in the tooltip.
    const next = meetings.filter(m => m.to > now).sort((a, b) => a.from - b.from)[0];
    if (next) {
      const lead = element("span", "helm-day-next");
      const mark = element("span", "helm-day-mark");
      paintIcon(mark, "calendar");
      lead.append(mark, element("b", "", clockAt(next.from)), element("span", "helm-day-next-title", next.title));
      lead.classList.toggle("is-now", next.from <= now);
      lead.dataset.tip = `${clockAt(next.from)}–${clockAt(next.to)} ${next.title}`;
      strip.append(lead);
    }

    /* The line, ONLY with meetings to put on it (his call: with none it was an
     * empty bar from 09:15 to 17:45 saying nothing). The projection is said as
     * a figure under it either way. */
    const end = finishAt(now, committed, meetings);
    if (meetings.length) {
      const line = element("div", "helm-day-line");
      const track = element("div", "helm-day-track");
      const past = element("i", "helm-day-past");
      past.style.width = x(now);
      track.append(past);
      if (committed) {
        const work = element("i", `helm-day-work${end > close ? " is-over" : ""}`);
        work.style.left = x(now);
        work.style.width = `calc(${x(end)} - ${x(now)})`;
        track.append(work);
        if (end > close) {
          const spill = element("i", "helm-day-spill");
          spill.style.left = x(close);
          spill.style.width = `calc(${x(end)} - ${x(close)})`;
          track.append(spill);
        }
      }
      for (const m of meetings) {
        const block = element("i", `helm-day-meet${m.to <= now ? " is-past" : ""}`);
        block.style.left = x(m.from);
        block.style.width = `max(4px, calc(${x(m.to)} - ${x(m.from)}))`;
        block.dataset.tip = `${clockAt(m.from)}–${clockAt(m.to)} ${m.title}`;
        track.append(block);
      }
      const pin = element("i", "helm-day-now");
      pin.style.left = x(now);
      track.append(pin);
      line.append(track);
      const ends = element("div", "helm-day-ends");
      ends.append(element("span", "", clockAt(from)), element("span", "", clockAt(until)));
      line.append(ends);
      line.dataset.tip = `${meetings.length} ${meetings.length === 1 ? "meeting" : "meetings"} today`;
      strip.append(line);
    }
    const figures = element("div", "helm-day-figs");
    if (committed) {
      const over = end > close;
      const fin = element("span", `helm-day-end${over ? " is-over" : ""}`);
      const mark = element("span", "helm-day-mark");
      paintIcon(mark, "clock");
      fin.append(mark, element("b", "", `~${clockAt(end)}`));
      const tip = over ? `Today's work runs to about ${clockAt(end)}, past ${clockAt(close)}` : `Today's work done about ${clockAt(end)}`;
      fin.dataset.tip = tip;
      fin.setAttribute("aria-label", tip);
      figures.append(fin);
    }
    strip.append(figures);

    if (money.length) {
      const sum = money.reduce((total, m) => total + (m.amount ?? 0), 0);
      const late = money.some(m => m.late);
      const box = element("button", `helm-day-money${late ? " is-late" : ""}`) as HTMLButtonElement;
      box.type = "button";
      const mark = element("span", "helm-day-mark");
      paintIcon(mark, "money");
      box.append(mark, element("b", "", sum ? zloty(sum) : String(money.length)));
      const tip = money.map(m => `${m.title}${m.amount ? ` · ${zloty(m.amount)}` : ""}${m.late ? " (late)" : ""}`).join("\n");
      box.dataset.tip = tip;
      box.setAttribute("aria-label", `Money due today: ${tip.replaceAll("\n", ", ")}`);
      box.onclick = () => this.source.open("/money");
      figures.append(box);
    }
  }

  /** Money due today or late: the cockpit's reminders and renewals, and the queue's money items. */
  private moneyToday(): { title: string; amount: number | null; late: boolean }[] {
    const today = localDay();
    const seen = new Set<string>();
    const out: { title: string; amount: number | null; late: boolean }[] = [];
    for (const need of this.source.notch?.needs ?? []) {
      if ((need.kind !== "reminder" && need.kind !== "renewal") || !need.at) continue;
      const day = need.at.slice(0, 10);
      if (day > today) continue;
      seen.add(need.title);
      out.push({ title: need.title, amount: need.amount, late: day < today });
    }
    for (const e of [...this.source.today, ...this.source.suggested]) for (const item of e.items) {
      if (item.kind !== "money" || !item.dueOn || item.dueOn > today || seen.has(item.title)) continue;
      seen.add(item.title);
      out.push({ title: item.title, amount: null, late: item.dueOn < today });
    }
    return out;
  }

  /** What needs him: a strip of objects, each opening itself in Helm. */
  private paintNeeds(needs: NotchNeed[]) {
    const strip = this.get(".helm-needs");
    strip.replaceChildren();
    for (const need of needs) strip.append(this.need(need));
    requestAnimationFrame(() => strip.classList.toggle("is-overflowing", strip.scrollWidth > strip.clientWidth + 1));
  }

  private need(need: NotchNeed): HTMLElement {
    const icons: Record<string, TaskIcon> = { reminder: "bell", renewal: "repeat", request: "request", meeting: "calendar" };
    const side = needSide(need, localDay());
    const box = element("div", `helm-need is-${need.kind}${side?.late ? " is-late" : ""}`);
    box.setAttribute("role", "listitem");
    const main = element("button", "helm-need-main") as HTMLButtonElement;
    main.type = "button";
    const mark = element("span", "helm-need-mark");
    paintIcon(mark, icons[need.kind] ?? "bell");
    main.append(mark, element("span", "helm-need-title", need.title));
    if (side) main.append(element("span", "helm-need-side", side.text));
    const tip = [need.title, need.context].filter(Boolean).join(" — ");
    main.dataset.tip = tip;
    main.setAttribute("aria-label", tip);
    main.disabled = !need.href;
    main.onclick = () => { if (need.href) this.source.open(need.href); };
    box.append(main);
    if (need.kind === "meeting" && need.join) {
      const join = wordButton("join", "Join", "helm-need-join", () => {
        void call("open_external", { url: need.join }).catch(() => {});
      });
      join.setAttribute("aria-label", `Join ${need.title}`);
      box.append(join);
    }
    return box;
  }

  /** Width the panel adds while it is open and has something to show. */
  get extraWidth(): number {
    return (this.side.open && this.sideFor() ? AGENT_PANEL_W : 0) + (this.railShown ? RAIL_W : 0);
  }

  /** The rail is drawn: on, connected, and not on a side edge (too narrow there). */
  private get railShown(): boolean {
    const helm = this.source.helm;
    return this.railOn && helm.connected && helm.signedIn && !isVertical(this.surface.edge);
  }

  private sideFor(): { session: BriefSession; folder: NotchFolder } | null {
    const session = this.hooks.sessions().find(one => one.id === this.picked);
    const link = session ? this.source.linkOf({ project: session.project, folder: session.folder }) : null;
    return session && link ? { session, folder: link.folder } : null;
  }

  private toggleSide(open: boolean) {
    this.side.toggle(open);
    this.drawn = "";
    this.surface.deliberately();
    this.hooks.width();
    this.changed();
  }

  private paintSide() {
    const found = this.sideFor();
    const shell = this.get(".helm-shell");
    const on = this.side.open && !!found;
    shell.classList.toggle("has-side", on && !isVertical(this.surface.edge));
    shell.style.setProperty("--h-main-w", `${Math.round(this.mainCss + (this.railShown ? RAIL_W : 0))}px`);
    shell.dataset.floor = on ? "340" : "";
    this.side.el.hidden = !found;
    if (!found || !this.side.open) { this.side.inner.replaceChildren(); return; }
    projectPanel(this.side.inner, {
      helm: this.source, session: found.session, folder: found.folder,
      close: () => this.toggleSide(false),
      open: () => this.hooks.openSession(found.session.id),
    });
  }

  /** The live sessions, one line each: whose, where, what it is doing. */
  private paintAgents(sessions: BriefSession[]) {
    const box = this.get(".helm-agents");
    box.replaceChildren(...sessions.slice(0, 4).map(session => {
      const row = element("button", `helm-agent is-${session.state}`) as HTMLButtonElement;
      row.type = "button";
      const mark = element("span", "helm-agent-mark");
      mark.dataset.agent = session.provider ?? "";
      paintIcon(mark, session.provider === "codex" ? "codex" : session.provider === "claude" ? "claude" : "agent");
      const link = this.source.linkOf({ project: session.project, folder: session.folder });
      const name = element("span", "helm-agent-name", link?.folder.project.name ?? session.project);
      const doing = session.state === "waiting" ? "Waiting for you" : session.doing || session.thinking || "Working";
      const text = element("span", "helm-agent-doing", link?.request ? link.request.title : doing);
      const state = element("span", "helm-agent-state");
      state.append(element("i", "agent-pip"), element("span", "", session.state === "waiting" ? "Waiting" : session.thinking && !session.doing ? "Thinking" : "Working"));
      row.append(mark, name, text, state);
      row.setAttribute("aria-label", `${session.project}, ${doing}`);
      row.dataset.tip = doing;
      row.classList.toggle("is-on", this.side.open && this.picked === session.id);
      row.setAttribute("aria-pressed", String(this.side.open && this.picked === session.id));
      /* Its project opens beside the screen — or, for a session Helm knows no
       * project of, the session itself on the Agents screen. */
      row.onclick = () => {
        if (!link) { this.hooks.openSession(session.id); return; }
        const again = this.side.open && this.picked === session.id;
        this.picked = session.id;
        this.toggleSide(!again);
      };
      return row;
    }));
  }

  /** Now: the face, the title with its chip, the project, the Guardian's why, the focus scale
   *  holding the time and the actions, and a group's or the small things' items under it. */
  private paintNow(live: HelmBlock | null, entry: HelmEntry | null, pending: number | string | null) {
    const hero = this.get(".helm-hero");
    if (!live && !entry) return;
    const single = entry?.type === "item" ? entry.items[0] : null;
    this.get(".helm-hero-title").textContent = entry?.title ?? live!.title;
    const face = this.get(".helm-now-face");
    face.replaceChildren(logoTile(entry ? this.source.faceOf(entry) : live!.project ? { name: live!.project } : null, "lg"));

    const marks = this.get(".helm-now-marks");
    marks.replaceChildren();
    const chipNow = entry ? chipFor({ dueOn: entry.dueOn, kinds: entry.items.map(i => i.kind), projectId: entry.projectId, type: entry.type }, localDay(), this.source.waitingProjects) : null;
    if (chipNow) marks.append(chip(chipNow.tone, chipNow.label));
    const request = entry ? this.source.requestOf(entry) : null;
    if (request?.folder && doingRequest(request.folder)?.id === request.id) marks.append(agentMark("Claude is on it"));

    /* The project, and a due date the chip did not already say. ⚠️ Not "3
     * things" for the small things: they are listed right under the scale. */
    const due = dueLabel(entry?.dueOn ?? null);
    const context = entry ? (entry.type === "small" ? null : entry.context) : live!.project;
    const sub = [context, due && !chipNow ? `Due ${due.label === "Tomorrow" ? "tomorrow" : due.label}` : null].filter(Boolean);
    const subLine = this.get(".helm-hero-sub");
    subLine.textContent = sub.join("   ");
    subLine.hidden = !sub.length;

    const why = entry?.why ?? null;
    this.get(".helm-why").hidden = !why || !!live;
    this.get(".helm-why-text").textContent = why ?? "";

    const running = live?.status === "running";
    const busy = pending !== null && (pending === live?.id || pending === entry?.key);
    const toggle = this.get<HTMLButtonElement>(".helm-toggle");
    const label = live ? (running ? "Pause" : "Resume") : "Start";
    paintIcon(this.get(".helm-toggle-mark"), running ? "pause" : "play");
    this.get(".helm-toggle-word").textContent = label;
    toggle.setAttribute("aria-label", label);
    toggle.dataset.tip = label;
    toggle.hidden = !live && !!entry && !hasSession(entry);
    toggle.disabled = busy;
    /* ⚠️ ONE filled accent on the screen: Start before a session, Resume while
     * paused — and while it runs, Done. */
    toggle.classList.toggle("is-primary", !running);
    const finish = this.get<HTMLButtonElement>(".helm-finish");
    finish.disabled = busy;
    finish.hidden = !live && !single;
    const finishTip = single && isMoney(single) ? "Settle in Helm" : single ? "Done" : "End the session";
    finish.dataset.tip = finishTip;
    finish.setAttribute("aria-label", finishTip);
    finish.classList.toggle("is-primary", running);
    const later = this.get<HTMLButtonElement>(".helm-later");
    later.hidden = !!live;
    later.disabled = busy;
    /* ⚠️ Not while an agent is already on it: two Claudes on one checkout. */
    const claude = this.get<HTMLButtonElement>(".helm-claude");
    const doing = !!request?.folder && doingRequest(request.folder)?.id === request.id;
    claude.hidden = !request || !!live || doing;
    claude.disabled = !!request && this.source.starting.has(request.id);
    hero.classList.toggle("is-paused", !running);
    hero.classList.toggle("is-idle", !live);

    // A group's or the small things' items, right under the scale: what Now is made of.
    const items = this.get(".helm-now-items");
    items.replaceChildren();
    if (entry && entry.type !== "item") for (const item of entry.items) items.append(this.itemRow(item, entry.type === "small"));
    items.hidden = !items.childElementCount;
    hero.classList.toggle("has-items", !items.hidden);
    if (entry?.type === "small") this.sortItems(items);
  }

  private empty(title: string, why: string, connect: boolean): HTMLElement {
    const box = element("div", "day-empty");
    box.append(element("h3", "", title), element("p", "", why));
    if (connect) {
      const button = element("button", "day-connect", "Sign in to Helm");
      button.type = "button";
      button.onclick = () => { void call("open_task_editor").catch(() => {}); };
      box.append(button);
    }
    return box;
  }

  private button(icon: TaskIcon, tip: string, title: string, busy: boolean, run: () => void): HTMLButtonElement {
    const b = element("button", "task-focus") as HTMLButtonElement;
    b.type = "button";
    b.append(taskIcon(icon));
    b.dataset.tip = tip;
    b.setAttribute("aria-label", `${tip}: ${title}`);
    b.disabled = busy;
    b.onclick = run;
    return b;
  }

  /** An entry of Today (tick or open) or of the suggestions (`+`).
   *
   * ⚠️ One line: the face, the title, then at the end the chip and the
   * minutes — which the row's actions REPLACE under the pointer. A Today row
   * is dragged by any part that is not a button. */
  private entryRow(entry: HelmEntry, suggested: boolean): HTMLElement {
    const slot = element("div", "slot");
    const inner = element("div", "slot-inner");
    slot.append(inner);
    const row = element("div", `day-row helm-row${suggested ? " is-suggested" : " is-sortable"}`);
    row.style.setProperty("--list", "var(--accent)");
    const busy = this.source.pending === entry.key;
    const single = entry.type === "item" ? entry.items[0] : null;
    if (suggested) {
      const add = this.button("plus", "Add to Today", entry.title, busy, () => this.source.toToday(entry));
      add.classList.add("helm-add");
      row.append(add);
    } else if (single) {
      row.append(control("var(--accent)", false, isMoney(single) ? `Settle in Helm: ${entry.title}` : `Done: ${entry.title}`, busy, () => this.source.doneItem(single)));
    } else {
      const opened = this.open.has(entry.key);
      const fold = this.button("down", opened ? "Fold" : "Open", entry.title, false, () => {
        if (opened) this.open.delete(entry.key);
        else this.open.add(entry.key);
        this.surface.deliberately();
        this.changed();
      });
      fold.classList.add("helm-open");
      fold.classList.toggle("is-open", opened);
      fold.setAttribute("aria-expanded", String(opened));
      row.append(fold);
    }

    const face = this.source.faceOf(entry);
    const tile = logoTile(face, "sm");
    if (face && !face.icon) tile.dataset.tip = face.name;
    row.append(tile);

    const main = element("div", "helm-row-main");
    const title = element("span", "task-title", entry.title);
    // The rail truncates a suggestion's title; the whole of it is in the hover.
    if (suggested) title.dataset.tip = entry.title;
    main.append(title);
    const request = this.source.requestOf(entry);
    const doing = !!request?.folder && doingRequest(request.folder)?.id === request.id;
    if (doing) main.append(agentMark("Claude is on it"));
    if (entry.by === "guardian") {
      const pick = element("span", "helm-row-pick");
      paintIcon(pick, "guardian");
      pick.dataset.tip = entry.why ? `The Guardian's pick: ${entry.why}` : "The Guardian's pick";
      main.append(pick);
    }
    // In the rail, a suggestion says why under its title: it is what the Guardian is arguing.
    if (suggested && entry.why) main.append(element("span", "helm-row-why", entry.why));
    row.append(main);

    const end = element("div", "helm-row-end");
    const meta = element("div", "helm-row-meta");
    const tone = chipFor({ dueOn: entry.dueOn, kinds: entry.items.map(i => i.kind), projectId: entry.projectId, type: entry.type }, localDay(), this.source.waitingProjects);
    if (tone) meta.append(chip(tone.tone, tone.label));
    else {
      const due = dueLabel(entry.dueOn);
      if (due) meta.append(element("span", "helm-row-due", due.label));
    }
    const minutes = rowMinutes(entry);
    if (minutes) meta.append(element("span", "helm-row-minutes", minutes));
    const acts = element("div", "helm-row-acts");
    if (request && this.source.notch && !doing) {
      const claude = this.button("claude", "Start with Claude", entry.title, this.source.starting.has(request.id), () => this.source.startWithClaude(request.id, entry.title));
      claude.classList.add("helm-row-claude");
      acts.append(claude);
    }
    if (hasSession(entry)) acts.append(this.button("play", "Start", entry.title, busy, () => this.source.startEntry(entry)));
    acts.append(this.button("later", "Not today", entry.title, busy, () => this.source.later(entry)));
    if (!suggested) acts.append(this.button("undo", "Back to suggestions", entry.title, busy, () => this.source.toSuggested(entry)));
    end.append(meta, acts);
    row.append(end);
    inner.append(row);
    return slot;
  }

  /** A group's or the small things' items, each its own row; the small things' drag to reorder. */
  private itemList(entry: HelmEntry): HTMLElement {
    const box = element("div", "helm-items");
    for (const item of entry.items) box.append(this.itemRow(item, entry.type === "small"));
    if (entry.type === "small") this.sortItems(box);
    return box;
  }

  /** The small things' rows in `box` drag among themselves; the drop sends every item's key. */
  private sortItems(box: HTMLElement) {
    const rows = () => [...box.querySelectorAll<HTMLElement>(":scope > .slot[data-key]")];
    for (const row of rows()) {
      if (row.dataset.sorts) continue;
      row.dataset.sorts = "1";
      sortable(row, { rows, moving: on => { this.dragging = on; }, dropped: keys => this.source.reorderSmall(keys) });
    }
  }

  /** One of a group's or the small things' items: its own tick, and Not today on hover. */
  private itemRow(item: HelmQueueItem, sorts = false): HTMLElement {
    const slot = element("div", "slot");
    slot.dataset.key = item.key;
    slot.setAttribute("role", "listitem");
    const inner = element("div", "slot-inner");
    slot.append(inner);
    const row = element("div", `day-row helm-row nested${sorts ? " is-sortable" : ""}`);
    row.style.setProperty("--list", "var(--accent)");
    const busy = this.source.pending === item.key;
    row.append(control("var(--accent)", false, isMoney(item) ? `Settle in Helm: ${item.title}` : `Done: ${item.title}`, busy, () => this.source.doneItem(item)));
    const main = element("div", "helm-row-main");
    main.append(element("span", "task-title", item.title));
    row.append(main);
    const end = element("div", "helm-row-end");
    const meta = element("div", "helm-row-meta");
    const due = dueLabel(item.dueOn);
    if (due?.late) meta.append(chip("late", due.label));
    else if (item.context) meta.append(element("span", "helm-row-due", item.context));
    const acts = element("div", "helm-row-acts");
    acts.append(this.button("later", "Not today", item.title, busy, () => this.source.laterItem(item)));
    end.append(meta, acts);
    row.append(end);
    inner.append(row);
    return slot;
  }

  /** The hero's focus scale and the day strip, in place — the rows themselves are keyed.
   *  While nothing runs the scale is empty and its ends say when Start would end. */
  tick() {
    const helm = this.source.helm;
    if (!helm.connected || !helm.signedIn) { this.day.hidden = true; return; }
    this.paintDay();
    const { live, entry } = this.now();
    const bar = this.get(".helm-now-bar");
    const now = this.blocks.get("now")!;
    const runs = live ? live.minutes : entry && hasSession(entry) ? sessionFor(entry).minutes : 0;
    bar.hidden = !runs;
    if (!runs) return;
    const total = Math.max(60, runs * 60);
    const seconds = live ? blockSeconds(live, helm.skewMs) : 0;
    const over = !!live && seconds > total;
    const phase = !live ? "idle" : over ? "over" : live.status === "running" ? "running" : "paused";
    bar.dataset.phase = phase;
    // +5 min once the session has run past its length, as Helm's Today offers it.
    this.get(".helm-more").hidden = !over;

    // The segments: one per `perSegment` minutes, grouped in fives like a ruler.
    const per = perSegment(runs);
    const count = Math.max(1, Math.ceil(runs / per));
    const segs = this.get(".helm-segs");
    if (this.segsFor !== `${count}`) {
      this.segsFor = `${count}`;
      segs.replaceChildren(...Array.from({ length: count }, (_, i) => {
        const seg = element("span", `helm-seg${i > 0 && i % 5 === 0 ? " is-major" : ""}`);
        seg.append(element("i"));
        return seg;
      }));
    }
    [...segs.children].forEach((seg, i) => {
      const from = i * per * 60;
      const lit = over ? 1 : Math.min(1, Math.max(0, (seconds - from) / (per * 60)));
      (seg.firstElementChild as HTMLElement).style.width = `${lit * 100}%`;
      seg.classList.toggle("is-current", phase === "running" && lit > 0 && lit < 1);
    });

    const left = this.get(".helm-left");
    const clockNow = minutesOf(new Date());
    const startAt = clockNow - seconds / 60;
    left.textContent = !live ? spoken(runs) : over ? `+${reading(seconds - total)}` : reading(total - seconds);
    const state = phase === "idle" ? { icon: "play" as TaskIcon, word: "session" }
      : phase === "paused" ? { icon: "pause" as TaskIcon, word: "Paused" }
      : phase === "over" ? { icon: "timer" as TaskIcon, word: "Over time" }
      : { icon: "clock" as TaskIcon, word: `Until ${clockAt(startAt + runs)}` };
    paintIcon(this.get(".helm-state-mark"), state.icon);
    this.get(".helm-state-word").textContent = state.word;
    this.get(".helm-from").textContent = clockAt(startAt);
    this.get(".helm-to").textContent = clockAt(startAt + runs);
    bar.setAttribute("aria-label", !live ? `${spoken(runs)} session` : over ? `${reading(seconds - total)} over` : `${reading(total - seconds)} left`);
    bar.dataset.tip = live ? `${timerText(seconds)} of ${spoken(live.minutes)}` : `Start runs ${clockAt(startAt)}–${clockAt(startAt + runs)}`;
    // Folded, the header still says what is running and for how long.
    if (live) now.summary(`${live.title}   ${timerText(seconds)}`);
  }
}
