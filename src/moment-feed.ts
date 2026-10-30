/* Moments, fed (30 Oct): what turns the app's readings into moments
 * (moments.ts) and runs their buttons. The shell builds one (tasks.ts) and
 * hands it what it already has — the sessions, Helm, the calendar, the call —
 * so nothing here reads anything twice.
 *
 * - AGENTS: finished (working → idle after a minute of work; Open jumps to
 *   its terminal), asked (→ waiting; sticky until opened, dismissed or
 *   answered). Running says nothing.
 * - USAGE: the five-hour or weekly window at 90 % or more, once per window,
 *   from the providers' own readings (`notch:readings`, model.rs).
 * - GUARDIAN: a NEW nudge (`helm:nudge`) — its action, Helm's quick replies,
 *   Open; sticky. A planned block two minutes out — Start, Later; sticky
 *   until it starts.
 * - CALENDAR: a meeting five minutes out — Join; it folds by itself and the
 *   pill's meeting claim carries on. Skipped when Helm's own PREP moment is
 *   about the same meeting (batch 12: one heads-up, the richer one).
 * - HELM (batch 12): the Guardian's own moments from `/api/notch` — a prep, a
 *   wrap-up, a block drifting, a reminder or a request to send, closing the
 *   day — with Helm's priority, stickiness and actions. × posts the dismissal;
 *   an id shown (or, sticky, acted on) is remembered across launches.
 *
 * Held back (queued, not lost) while the voice glance, the panel, the
 * palette or capture is up, while the island is slid away or ambient is on,
 * and while presenting, in a call or a meeting (`voice_quiet`'s reasons).
 */
import { listen } from "@tauri-apps/api/event";
import { call, native, preview } from "./task-client";
import { MomentGlance } from "./moment-glance";
import { load, save } from "./kit/store";
import {
  AgentWatch, BLOCK_LEAD_MS, MEETING_LEAD_MS, MomentQueue, finishedMoment, helmKey, helmMoment, inMinutes, lowWindows, plannedStart,
  remember, resetsIn, restAfterOpen,
  type AgentSeen, type Moment, type MomentButton, type ProviderReading,
} from "./moments";
import { prepCovers, type NotchMoment } from "./helm-link";
import type { IslandSurface } from "./island-surface";
import type { SessionView } from "./screen-agents";
import type { HelmBlock, HelmEntry, HelmNudge, NudgeAction } from "./screen-helm";
import type { CalEvent } from "./screen-calendar";
import type { TaskIcon } from "./task-icons";

export interface FeedDeps {
  surface: IslandSurface;
  sessions: () => SessionView[];
  helm: {
    nudges: () => HelmNudge[];
    blocks: () => HelmBlock[];
    replies: () => string[];
    action: (nudge: HelmNudge) => NudgeAction;
    start: (block: number) => void;
    startEntry: (entry: HelmEntry) => void;
    open: (path: string) => void;
    read: (ids: number[]) => void;
    reply: (text: string) => void;
    /** Batch 12: the Guardian's moments, and what their buttons do. */
    moments: () => NotchMoment[];
    queue: (act: Record<string, unknown>) => Promise<void>;
    post: (path: string, body?: Record<string, unknown>) => Promise<{ ok?: boolean; error?: string }>;
    /** A line to the Guardian, answered on the voice glance; false while a turn is in flight. */
    chat: (text: string, command?: string) => boolean;
    /** A hands-free voice turn about a meeting (`command: "wrap"`); false when one can't start. */
    talk: (meeting: string) => boolean;
    /** Open closing the day. */
    close: () => void;
  };
  events: () => CalEvent[];
  /** The calendar's own "quiet" for an event (snoozed from the palette). */
  eventQuiet: (id: string) => boolean;
  /** Something else owns the island right now: the palette, capture, a call… */
  busy: () => boolean;
  /** Open the panel on a screen. */
  openScreen: (name: "agents" | "guardian" | "calendar" | "helm") => void;
  agentName: (provider?: string) => string;
  say: (what: string, why: string) => void;
}

const TICK_MS = 500;
/** How often presenting / a call / a meeting is asked of Rust. */
const QUIET_MS = 5000;

const agentIcon = (provider?: string): TaskIcon => provider === "codex" ? "codex" : provider === "claude" ? "claude" : "agent";
const firstLine = (text: string | null | undefined) => (text ?? "").replace(/\s+/g, " ").trim().slice(0, 160);

export class MomentFeed {
  private queue = new MomentQueue();
  private watch = new AgentWatch();
  private glance: MomentGlance;
  private hovering = false;
  private quietWhy: string | null = null;
  private quietAt = 0;
  /** When `voice_quiet` last answered: a moment waits for an answer this fresh. */
  private quietAnswered = -Infinity;
  private readings: ProviderReading[] = [];
  /** Keys already announced, so a reading that keeps being true says it once. */
  private said = new Set<string>();
  private up: Moment | null = null;
  /** Sessions by id, for Open (the pid and the project are what the jump needs). */
  private byId = new Map<string, SessionView>();

  constructor(private deps: FeedDeps) {
    const host = document.getElementById("island-moment")!;
    this.glance = new MomentGlance(host, {
      act: (moment, button) => this.act(moment, button),
      open: moment => this.open(moment),
      dismiss: moment => this.dismiss(moment),
      measured: depth => deps.surface.setMomentDepth(depth),
    });
    deps.surface.onMomentHover = on => { this.hovering = on; };
    host.addEventListener("pointerenter", () => { this.hovering = true; });
    host.addEventListener("pointerleave", () => { this.hovering = false; });
  }

  async boot() {
    try { this.readings = (await call<ProviderReading[]>("get_readings")) ?? []; } catch { /* none yet */ }
    if (native) await listen<ProviderReading[]>("notch:readings", event => { this.readings = event.payload ?? []; });
    // ⚠️ Primed with what is true at launch: an agent that was already idle did not just finish.
    this.watch.update(this.agentsSeen(), Date.now());
    window.setInterval(() => this.tick(), TICK_MS);
    if (preview) this.stage();
  }

  /** A NEW nudge from Helm (`helm:nudge`): a moment, sticky. */
  nudge(id: number) {
    const nudge = this.deps.helm.nudges().find(n => n.id === id) ?? this.deps.helm.nudges().at(-1);
    if (!nudge) return;
    const action = this.deps.helm.action(nudge);
    const buttons: MomentButton[] = [
      ...this.deps.helm.replies().slice(0, 3).map((reply, i) => ({ id: `reply:${i}`, label: reply, chip: true })),
      { id: "go", label: action.label, icon: action.icon, primary: true },
      { id: "open", label: "Open", icon: "guardian" },
    ];
    this.push({
      key: `nudge:${nudge.id}`, kind: "nudge", icon: "guardian",
      title: nudge.title || "Guardian", line: firstLine(nudge.body), buttons, sticky: true, at: Date.now(),
    });
  }

  /** Escape: away with what is up, sticky or not — its × (AGENTS 879). Only
   *  while the panel is shut: open, Escape is the panel's. */
  escape(): boolean {
    const up = this.queue.current;
    if (!up || !this.up || this.deps.surface.open) return false;
    this.dismiss(up);
    return true;
  }

  /** Dismiss what is up, if it is only up to be read (a click elsewhere). */
  dismissShown(): boolean {
    const up = this.queue.current;
    if (!up || up.sticky) return false;
    this.queue.drop(up.key);
    this.sync();
    return true;
  }

  private push(moment: Moment) {
    if (this.said.has(moment.key) && !this.queue.has(moment.key)) return;
    this.said.add(moment.key);
    this.queue.push(moment);
    this.sync();
  }

  private agentsSeen(): AgentSeen[] {
    const list = this.deps.sessions();
    this.byId = new Map(list.map(s => [s.id, s]));
    return list;
  }

  /* ── The readings, every half second ─────────────────────────────────── */

  private tick() {
    const now = Date.now();
    this.agents(now);
    this.usage(now);
    this.blocks(now);
    this.meetings(now);
    this.helmMoments(now);
    this.answered();
    /* ⚠️ Asked only while there is something to show: an idle island asks
     * Rust nothing (and voice.spec.ts holds that a turn with spoken replies
     * off never asks `voice_quiet`). */
    if (this.queue.size && now - this.quietAt > QUIET_MS) {
      this.quietAt = now;
      void call<string | null>("voice_quiet").then(why => { this.quietWhy = why ?? null; this.quietAnswered = Date.now(); })
        .catch(() => { this.quietWhy = null; this.quietAnswered = Date.now(); });
    }
    this.sync();
  }

  private agents(now: number) {
    const news = this.watch.update(this.agentsSeen(), now);
    for (const id of news.settled) this.queue.drop(`ask:${id}`);
    for (const s of news.finished) {
      this.queue.drop(`ask:${s.id}`);
      /* Sticky (his call, 30 Oct: it went too fast, and he is often away when
       * one finishes): it waits until opened or dismissed. A second finishing
       * meanwhile joins this one in the queue (`joinFinished`). */
      this.push(finishedMoment(
        [{ id: s.id, project: s.project, line: firstLine(s.say), agent: s.provider ?? "" }],
        `done:${s.id}:${now}`, now, agentIcon(s.provider),
      ));
    }
    for (const s of news.asked) {
      this.push({
        key: `ask:${s.id}`, kind: "question", icon: agentIcon(s.provider), agent: s.provider ?? "",
        kicker: "Asks", title: s.project, line: firstLine(s.say) || `${this.deps.agentName(s.provider)} is waiting for you`,
        sticky: true, at: now,
        buttons: [{ id: "jump", label: "Answer", icon: "open", primary: true }],
      });
    }
  }

  /** The limit windows already announced, kept across launches: once per window means once. */
  private usageSaid = new Set<string>(load<string[]>("moment-usage-said", []));

  private usage(now: number) {
    for (const low of lowWindows(this.readings, now)) {
      if (this.said.has(low.key) || this.usageSaid.has(low.key)) continue;
      this.usageSaid.add(low.key);
      if (!preview) save("moment-usage-said", [...this.usageSaid].slice(-20));
      const left = Math.max(0, Math.round((1 - low.window.used_fraction) * 100));
      this.push({
        key: low.key, kind: "usage", icon: agentIcon(low.provider), agent: low.provider,
        kicker: `${left}% left`, title: `${low.reading.displayName} · ${low.week ? "this week" : "5-hour limit"}`,
        line: `Resets ${resetsIn(low.window.resets_at, now)}`, sticky: false, at: now,
        until: Date.parse(low.window.resets_at), buttons: [],
      });
    }
  }

  private blocks(now: number) {
    for (const block of this.deps.helm.blocks()) {
      if (block.status !== "planned") continue;
      const start = plannedStart(block.plannedAt, now);
      if (start === null || start - now > BLOCK_LEAD_MS || start <= now) continue;
      const key = `block:${block.id}:${block.plannedAt}`;
      if (this.said.has(key)) continue;
      this.push({
        key, kind: "block", icon: "target", kicker: inMinutes(start, now), title: block.title,
        line: block.project ?? "", sticky: true, at: now, until: start + BLOCK_LEAD_MS,
        buttons: [
          { id: "later", label: "Później", icon: "later" },
          { id: `start:${block.id}`, label: "Start", icon: "play", primary: true },
        ],
      });
    }
    // A block that started (here or in Helm) has nothing left to announce.
    const planned = new Set(this.deps.helm.blocks().filter(b => b.status === "planned").map(b => `block:${b.id}:${b.plannedAt}`));
    this.queue.dropWhere(m => m.kind === "block" && !planned.has(m.key));
  }

  private meetings(now: number) {
    for (const event of this.deps.events()) {
      if (event.allDay) continue;
      const start = Date.parse(event.start);
      if (!Number.isFinite(start) || start <= now || start - now > MEETING_LEAD_MS) continue;
      const key = `meeting:${event.id}:${event.start}`;
      if (this.said.has(key) || this.deps.eventQuiet(event.id)) continue;
      // Helm's prep says this meeting already, with more in it (batch 12).
      if (this.deps.helm.moments().some(n => prepCovers(n, event))) continue;
      const at = new Date(start);
      const time = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
      this.push({
        key, kind: "meeting", icon: "calendar", kicker: inMinutes(start, now), title: event.title,
        line: [time, event.location || event.calendar].filter(Boolean).join(" · "),
        sticky: false, at: now, until: start, accent: event.color || undefined,
        buttons: event.meetingUrl ? [{ id: "join", label: "Dołącz", icon: "join", primary: true }] : [],
      });
    }
  }

  /** A local meeting moment already queued before Helm's prep for it arrived goes (batch 12). */
  private coveredMeetings() {
    const preps = this.deps.helm.moments().filter(n => n.kind === "prep");
    if (!preps.length) return;
    const events = this.deps.events();
    this.queue.dropWhere(m => m.kind === "meeting" && events.some(e => m.key.startsWith(`meeting:${e.id}:`) && preps.some(p => prepCovers(p, e))));
  }

  /* ── The Guardian's own moments (batch 12) ─────────────────────────────── */

  /** Ids shown or dismissed, kept across launches (`remember`). */
  private helmSeen = load<string[]>("moment-helm-seen", []);

  private seeHelm(id: string) {
    this.helmSeen = remember(this.helmSeen, id);
    if (!preview) save("moment-helm-seen", this.helmSeen);
  }

  private forgetHelm(id: string) {
    this.helmSeen = this.helmSeen.filter(one => one !== id);
    this.said.delete(helmKey(id));
    if (!preview) save("moment-helm-seen", this.helmSeen);
  }

  /** Helm's moments into the queue; one Helm no longer sends goes (it stopped
   *  being true, or was handled there). One already up is redrawn in place,
   *  "Za 10 min" to "Za 9 min", keeping its place and its timer. */
  private helmMoments(now: number) {
    this.coveredMeetings();
    const list = this.deps.helm.moments();
    const live = new Set(list.map(n => helmKey(n.id)));
    this.queue.dropWhere(m => m.kind === "helm" && !live.has(m.key));
    for (const n of list) {
      const key = helmKey(n.id);
      if (this.helmSeen.includes(n.id)) continue;
      const there = this.queue.current?.key === key ? this.queue.current : this.queue.queued().find(m => m.key === key);
      if (there) {
        if (JSON.stringify(there.helm) !== JSON.stringify(n)) this.queue.push(helmMoment(n, there.at));
        continue;
      }
      this.push(helmMoment(n, now));
    }
  }

  /** A button on a Helm moment: what Helm said it does. The moment goes on
   *  the press; a call that fails brings it back, with why (AGENTS 882). */
  private helmAct(moment: Moment, index: number) {
    const n = moment.helm!;
    const action = n.actions[index];
    if (!action) return this.done(moment);
    const settle = () => { this.seeHelm(n.id); this.done(moment); };
    const undo = (error: unknown) => {
      this.forgetHelm(n.id);
      this.deps.say("Helm", String(error).replace(/^(invoke error|error): /i, "").slice(0, 120));
      this.push({ ...moment, at: Date.now() });
    };
    switch (action.do) {
      case "open_url":
        void call("open_external", { url: action.url }).catch(e => this.deps.say("Helm", String(e)));
        return settle();
      case "queue":
        settle();
        void this.deps.helm.queue(action.act).catch(undo);
        return;
      case "chat":
        if (!this.deps.helm.chat(action.text, action.command)) return this.deps.say("Guardian", "Still answering the last message");
        return settle();
      case "talk":
        if (!this.deps.helm.talk(action.meeting)) return;
        return settle();
      case "post":
        settle();
        void this.deps.helm.post(action.path, action.body)
          .then(answer => { if (answer && answer.ok === false) throw new Error(answer.error || "Helm said no."); })
          .catch(undo);
        return;
      case "close":
        this.done(moment);
        this.deps.helm.close();
        return;
    }
  }

  /** × on a Helm moment: gone here, and told to Helm so it stays gone there. */
  private dismissHelm(moment: Moment) {
    const id = moment.helm!.id;
    this.seeHelm(id);
    this.done(moment);
    void this.deps.helm.post("/api/notch/moments", { id, action: "dismiss" }).catch(() => { /* remembered here all the same */ });
  }

  /** The day was closed: its moment goes, here and for good. */
  closed() {
    for (const n of this.deps.helm.moments()) if (n.kind === "close") this.seeHelm(n.id);
    this.queue.dropWhere(m => m.helm?.kind === "close");
    this.sync();
  }

  /** A nudge answered elsewhere (the Guardian, Helm) takes its moment with it. */
  private answered() {
    const unread = new Set(this.deps.helm.nudges().map(n => `nudge:${n.id}`));
    this.queue.dropWhere(m => m.kind === "nudge" && !unread.has(m.key));
  }

  /* ── Showing ─────────────────────────────────────────────────────────── */

  private blocked(): boolean {
    const s = this.deps.surface;
    const stale = Date.now() - this.quietAnswered > 2 * QUIET_MS;
    return s.open || s.voiceUp || s.away || this.deps.busy() || stale
      || this.quietWhy === "presenting" || this.quietWhy === "call" || this.quietWhy === "meeting";
  }

  private sync() {
    // The panel opened over a moment only up to be read: it has been seen.
    const up = this.queue.current;
    if (up && !up.sticky && this.deps.surface.open) this.queue.drop(up.key);
    const next = this.queue.step(Date.now(), { blocked: this.blocked(), hovering: this.hovering });
    if (next) this.glance.paint(next);
    // A Helm moment that only informs has been said once it is up.
    if (next && next !== this.up && next.helm && !next.sticky) this.seeHelm(next.helm.id);
    if (next !== this.up) {
      this.up = next;
      this.deps.surface.setMoment(!!next);
      if (!next) this.hovering = false;
    }
  }

  /* ── Acting ──────────────────────────────────────────────────────────── */

  private done(moment: Moment) {
    this.queue.drop(moment.key);
    this.sync();
  }

  private dismiss(moment: Moment) {
    if (moment.helm) return this.dismissHelm(moment);
    this.done(moment);
  }

  /** Open on a finished moment: the first agent's window; the rest stay up. */
  private openFinished(moment: Moment) {
    const first = moment.done?.[0];
    const rest = restAfterOpen(moment);
    this.queue.drop(moment.key);
    if (rest) this.queue.push(rest);
    this.sync();
    void this.jumpTo(first?.id ?? moment.key.split(":")[1]);
  }

  private open(moment: Moment) {
    if (moment.kind === "finished") return this.openFinished(moment);
    if (moment.helm?.kind === "close") { this.done(moment); this.deps.helm.close(); return; }
    this.done(moment);
    if (moment.helm) return this.deps.openScreen(moment.helm.kind === "prep" ? "calendar" : "helm");
    if (moment.kind === "question") return void this.jump(moment);
    this.deps.openScreen(moment.kind === "meeting" ? "calendar" : moment.kind === "usage" ? "agents" : "guardian");
  }

  private act(moment: Moment, button: MomentButton) {
    const id = button.id;
    if (moment.helm && id.startsWith("h:")) return this.helmAct(moment, Number(id.slice(2)));
    if (id === "jump" && moment.kind === "finished") return this.openFinished(moment);
    if (id === "jump") return void (this.done(moment), this.jump(moment));
    if (id === "later") return this.done(moment);
    if (id.startsWith("start:")) {
      this.deps.helm.start(Number(id.slice(6)));
      return this.done(moment);
    }
    if (id === "join") {
      const event = this.deps.events().find(e => moment.key.startsWith(`meeting:${e.id}:`));
      if (event?.meetingUrl) void call("open_external", { url: event.meetingUrl }).catch(e => this.deps.say("Join failed", String(e)));
      return this.done(moment);
    }
    if (moment.kind === "nudge") {
      const nudgeId = Number(moment.key.slice(6));
      const nudge = this.deps.helm.nudges().find(n => n.id === nudgeId);
      if (id === "open") { this.done(moment); this.deps.openScreen("guardian"); return; }
      if (id.startsWith("reply:")) {
        const reply = this.deps.helm.replies()[Number(id.slice(6))];
        if (reply) this.deps.helm.reply(reply);
        return this.done(moment);
      }
      if (id === "go" && nudge) {
        const action = this.deps.helm.action(nudge);
        if ("start" in action) this.deps.helm.start(action.start);
        else if ("entry" in action) this.deps.helm.startEntry(action.entry);
        else this.deps.helm.open(action.open);
        this.deps.helm.read([nudge.id]);
      }
      return this.done(moment);
    }
    this.done(moment);
  }

  /** The agent's own window: its terminal or VS Code (`focus_session`). */
  private jump(moment: Moment) { return this.jumpTo(moment.key.split(":")[1]); }

  private async jumpTo(sessionId: string) {
    const session = this.byId.get(sessionId);
    if (!session) { this.deps.openScreen("agents"); return; }
    try {
      const raised = await call<boolean>("focus_session", { pid: session.pid, hint: session.project });
      if (!raised) this.deps.openScreen("agents");
    } catch {
      this.deps.openScreen("agents");
    }
  }

  /* ── The preview's staged moments (`&moment=finished,question,…`) ─────── */

  private stage() {
    const kinds = (new URLSearchParams(location.search).get("moment") ?? "").split(",").filter(Boolean);
    if (!kinds.length) return;
    const now = Date.now();
    const fake = (id: string, state: AgentSeen["state"], forSecs: number, say: string, project: string, provider = "claude"): SessionView =>
      ({ id, provider, project, branch: "main", pid: 4242, state, forSecs, input: 0, output: 0, lastRunSecs: 0, say } as SessionView);
    const before: SessionView[] = [], after: SessionView[] = [];
    if (kinds.includes("finished")) {
      before.push(fake("s-done", "working", 240, "", "codenotch"));
      after.push(fake("s-done", "idle", 0, "Moments are in: the island now says when an agent finishes, asks, or runs low.", "codenotch"));
    }
    // `finished2`: a second agent finishing in the same reading — they fold into one.
    if (kinds.includes("finished2")) {
      before.push(fake("s-done2", "working", 300, "", "akcesfonia"));
      after.push(fake("s-done2", "idle", 0, "The kit page now loads its photos lazily.", "akcesfonia"));
    }
    if (kinds.includes("question")) {
      before.push(fake("s-ask", "working", 90, "", "helm"));
      after.push(fake("s-ask", "waiting", 0, "Should the weekly review include agent minutes, or only your own?", "helm"));
    }
    if (before.length) {
      // The real path: two readings of the sessions, the watch sees the change.
      const live = this.deps.sessions;
      let staged = before;
      this.deps.sessions = () => [...live(), ...staged];
      this.watch = new AgentWatch();
      this.watch.update(this.agentsSeen(), now);
      staged = after;
    }
    if (kinds.includes("usage")) {
      this.readings = [...this.readings, {
        id: "claude", displayName: "Claude", windows: [
          { id: "session", label: "Current session", used_fraction: 0.93, resets_at: new Date(now + 78 * 60_000).toISOString() },
        ],
      }];
    }
    if (kinds.includes("block")) {
      const at = new Date(now + 2 * 60_000 - 5000);
      const hhmm = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
      const blocks = this.deps.helm.blocks;
      const staged: HelmBlock = { id: 77, title: "Repricer — testy koszyka", status: "planned", plannedAt: hhmm, minutes: 50, runStartedAt: null, elapsedSeconds: 0, project: "Esono Rozwój" };
      this.deps.helm.blocks = () => [...blocks(), ...(this.stagedBlockStarted ? [] : [staged])];
      const start = this.deps.helm.start;
      this.deps.helm.start = id => { if (id === 77) this.stagedBlockStarted = true; start(id); };
    }
    if (kinds.includes("meeting")) {
      const events = this.deps.events;
      const staged: CalEvent = {
        id: "staged-meeting", title: "Esono — przegląd sprintu", start: new Date(now + 5 * 60_000 - 5000).toISOString(),
        end: new Date(now + 35 * 60_000).toISOString(), allDay: false, location: "", meetingUrl: "https://meet.google.com/demo",
        calendar: "Work", calendarId: "work", color: "#5ac8fa", writable: true, response: "accepted",
      };
      this.deps.events = () => [...events(), staged];
    }
    if (kinds.includes("nudge")) window.setTimeout(() => this.nudge(this.deps.helm.nudges().at(-1)?.id ?? -1), 50);
  }
  private stagedBlockStarted = false;
}
