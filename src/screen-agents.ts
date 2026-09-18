/* Which agent is working, which one is waiting for you, and how to get to it.
 *
 * The usage notch answers "is something running" with one arc, which is all a
 * 10px pill can draw. With three terminals open the useful fact is *which* of
 * them has stopped and is waiting — and, more than that, being able to get
 * there without alt-tabbing through every window to find out.
 *
 * ⚠️ The usage notch is not replaced by this and must not be. It is
 * click-through chrome that reports on something running elsewhere; this is a
 * panel you click into. They answer the same question at different distances.
 *
 * ── Two halves, because a live session and a dormant one are not the same
 * kind of thing ──────────────────────────────────────────────────────────
 *
 * Every session used to get the same card, so the screen was a stack of
 * near-identical rows, most of them about nothing: a dormant session is a
 * name, a number and no news, and four of those around the one that is
 * actually running is how you lose the one that is actually running.
 *
 * So the live ones get a STAGE — the mark, whose agent and which model, the
 * checklist of what it has been doing, and the sentence it last said — and
 * everything dormant is one quiet line each underneath. With more than one
 * live, the stage is PAGED rather than repeated: two stages side by side is
 * two things shouting, and neither is readable at this width.
 */
import { listen } from "@tauri-apps/api/event";
import { element } from "./dom";
import { paintIcon, type TaskIcon } from "./task-icons";
import { call, native } from "./task-client";
import { byProject, share, short, sum, total } from "./spend";
import type { Run } from "./screen-review";
import { held, tokens } from "./media-format";
import { modelName } from "./model-name";
import { hush, isQuiet, wake } from "./snooze";
import type { Activity } from "./island-activity";

export type AgentState = "working" | "waiting" | "idle";

export interface SessionView {
  id: string;
  /** Which agent it is — `claude` or `codex`. See `markFor`. */
  provider?: string;
  /** The model answering, as the provider names it: `claude-opus-5`. */
  model?: string | null;
  project: string;
  branch: string | null;
  pid: number;
  state: AgentState;
  forSecs: number;
  input: number;
  output: number;
  lastRunSecs: number;
  /** The session's working directory — what a workspace is made of. */
  folder?: string | null;
  /** What it is doing right now — `editing palette.ts`. Absent unless it
   *  is working: a phrase that outlives its run is a status that WAS true. */
  doing?: string | null;
  /** The last few tool calls, oldest first, and whether each came back.
   *
   * ⚠️ What an agent is doing is a LIST, not a sentence. One phrase says
   * "running cargo test" and nothing about the four things before it — which
   * is most of what somebody glancing at this wants, because it is the
   * difference between stuck and working through. */
  steps?: { id: string; say: string; done: boolean }[];
  /** The last thing it said, in prose. Survives the end of a turn. */
  say?: string | null;
  /** What it is reasoning about, where the agent reports that at all. */
  thinking?: string | null;
  /** What is left of the plan, where the agent says. Codex only today. */
  limits?: { window: number | null; week: number | null; plan: string | null } | null;
}

/** The glyph for an agent, by provider.
 *
 * ⚠️ Falls back to the generic one rather than to Claude's. A fallback of
 * "draw the Claude mark" would be right by accident for the agents that are
 * read today and would go on being drawn over whatever is added next.
 */
export function markFor(provider?: string): TaskIcon {
  if (provider === "claude") return "claude";
  if (provider === "codex") return "codex";
  return "agent";
}

/** The agent's name, as a person says it. */
export function agentName(provider?: string): string {
  if (provider === "claude") return "Claude";
  if (provider === "codex") return "Codex";
  return "Agent";
}

const WORDS: Record<AgentState, string> = {
  waiting: "waiting for you",
  working: "working",
  idle: "idle",
};

/** The word for the state, as a badge. ⚠️ Shorter than `WORDS`, which is a
 *  sentence fragment for a screen reader and for the pill; a badge beside a
 *  project name has room for one word and is read as a label rather than as
 *  prose. */
const BADGE: Record<AgentState, string> = {
  waiting: "Waiting",
  working: "Working",
  idle: "Idle",
};

/** The live word for a session, which is not always its state.
 *
 * ⚠️ "Thinking" is not a fourth state — it is `Working` with no tool out, and
 * it is the one thing a long turn can say for itself. A session that reasons
 * for two minutes under a badge reading "Working" looks exactly like one that
 * has hung; the same two minutes under "Thinking" is the model doing its job.
 */
function liveWord(session: SessionView): string {
  if (session.state === "working" && session.thinking) return "Thinking";
  return BADGE[session.state];
}

export class AgentsScreen {
  readonly name = "agents" as const;
  sessions: SessionView[] = [];
  /** Ticks with the shell so "waiting 40s" climbs without a re-render. */
  private clocks = new Map<string, HTMLElement>();
  /** Today's finished runs, for the spend block. */
  private runs: Run[] = [];
  /** Which live session the stage is showing.
   *
   * ⚠️ The session's ID, not its index. The list is re-sorted by state on
   * every tick — whoever wants you goes first — so an index points at a
   * different session the moment one of them finishes, and the page you were
   * reading would change under you with nothing having been clicked.
   */
  private staged = "";
  error = "";

  constructor(private host: HTMLElement, private changed: () => void) {}

  async boot() {
    try {
      this.sessions = await call<SessionView[]>("get_sessions");
      /* ⚠️ Read here rather than polled. Runs only land when one ends, and the
       * watcher already pushes an event then — see `boot` — so a timer would
       * be re-reading a file to find it unchanged. */
      this.runs = await call<Run[]>("get_runs", { day: "" });
    } catch { /* the watcher has not reported yet */ }
    if (native) {
      await listen<SessionView[]>("notch:sessions", event => {
        this.sessions = event.payload;
        this.changed();
      });
    }
  }

  /** The sessions worth a stage: the ones with news.
   *
   * ⚠️ Waiting counts as live. It is not doing anything, but it is the one
   * that wants you — and what it last said is exactly what has to be read to
   * deal with it. */
  private live(): SessionView[] {
    return this.sessions.filter(one => one.state !== "idle");
  }

  /** The pill claim.
   *
   * ⚠️ Waiting outranks working, and both claim it now. Working used to claim
   * nothing at all, on the argument that something working needs nothing from
   * you — which is true, and left the collapsed island silent about the only
   * thing happening on the machine. The strip says which agent, on what, and
   * what it has cost; 46 puts it over a track and a task count, and under a
   * meeting about to start.
   */
  activity(): Activity | null {
    const mine = this.sessions.filter(one => !isQuiet(`agent:${one.id}`));
    const waiting = mine.filter(one => one.state === "waiting");
    const working = mine.filter(one => one.state === "working");
    const first = waiting[0] ?? working[0];
    if (!first) return null;

    /* ⚠️ The AGENT'S OWN mark, not a generic brain. The strip says one thing
     * at a time and this claim outranks almost everything on it, so the glyph
     * is doing the work of a sentence: whose agent, and which one of them. */
    const icon = markFor(first.provider);
    if (waiting.length) {
      const many = waiting.length > 1;
      return {
        priority: 55,
        screen: "agents",
        kind: "event",
        icon,
        label: many ? `${waiting.length} agents waiting` : first.project,
        value: many ? first.project : `waiting ${held(first.forSecs)}`,
        /* The far slot. ⚠️ What a session has SPENT, on both claims rather
         * than only on the working one — it is the number that went on
         * climbing while you were not looking, and the moment you are most
         * likely to care what it reached is the moment it stops. */
        count: short(first.input + first.output),
      };
    }
    const many = working.length > 1;
    return {
      priority: 46,
      screen: "agents",
      kind: "event",
      icon,
      label: many ? `${working.length} agents working` : first.project,
      /* What it is doing, or failing that which model is doing it. ⚠️ Not the
       * word "working": the strip is the most valuable space in the app and
       * "working" is the one thing the mark beside it already says.
       *
       * ⚠️ And with several running, WHICH one — a phrase with no project
       * attached is a fact about a session the strip has not named, which is
       * worse than the plain name of the one it means. */
      value: many
        ? first.project
        : (first.doing || first.thinking || modelName(first.model) || WORDS.working),
      /* The far slot, where a countdown sits on a timer claim. Tokens are the
       * other number that climbs while you are not looking. */
      count: short(first.input + first.output),
    };
  }

  /** The elapsed figures, in place. The list itself is only redrawn when the
   *  set of sessions or their states actually change — see the note in
   *  `sessions.rs` on why the event carries no ticking numbers. */
  tick() {
    for (const session of this.sessions) {
      const clock = this.clocks.get(session.id);
      if (!clock) continue;
      session.forSecs += 1;
      clock.textContent = held(session.forSecs);
    }
  }

  private async focus(session: SessionView) {
    try {
      /* ⚠️ The folder goes with the pid, because for Codex there IS no pid:
       * every thread of it runs inside one process that owns no window. What
       * the row can offer instead is the name of the project, which is what an
       * editor puts in its title bar — see `focus_session`. */
      const raised = await call<boolean>("focus_session",
        { pid: session.pid, hint: session.project });
      // A session started from a detached process owns no window. Saying so is
      // better than a button that silently does nothing.
      this.error = raised ? "" : `${session.project} has no window to raise.`;
    } catch (error) {
      this.error = String(error);
    }
    this.changed();
  }

  /** The snooze bell, where snoozing means anything.
   *
   * ⚠️ Offered only where something is actually asking for attention. A
   * dormant session is already saying nothing, and muting silence is a control
   * that does nothing but make you wonder later what you switched off. */
  private bell(session: SessionView, quiet: boolean): HTMLElement | null {
    if (session.state !== "waiting" && !quiet) return null;
    const bell = element("button", `agent-snooze${quiet ? " is-on" : ""}`);
    (bell as HTMLButtonElement).type = "button";
    const label = quiet
      ? `Stop snoozing ${session.project}`
      : `Snooze ${session.project} for an hour`;
    bell.setAttribute("aria-label", label);
    bell.dataset.tip = label;
    paintIcon(bell, "snooze");
    bell.onclick = event => {
      event.stopPropagation();
      void (quiet ? wake(`agent:${session.id}`) : hush(`agent:${session.id}`));
    };
    return bell;
  }

  /** What a session has spent, as figures and as a shape.
   *
   * ⚠️ The bar is the OUTPUT share, not the total: the total is the figures
   * beside it, and how much of a session was the model talking back is what
   * tells a long read apart from a long write. */
  private spent(session: SessionView): HTMLElement {
    const whole = session.input + session.output;
    const wrap = element("div", "agent-spend");
    wrap.append(
      element("span", "agent-spend-in", short(session.input)),
      element("span", "agent-spend-out", `+${short(session.output)}`),
    );
    const rail = element("div", "agent-spend-rail");
    const fill = element("i");
    fill.style.width = whole ? `${(session.output / whole) * 100}%` : "0%";
    rail.append(fill);
    wrap.append(rail);
    wrap.title = `${tokens(session.input)} read, ${tokens(session.output)} written`;
    return wrap;
  }

  /** What it has been doing, as a checklist.
   *
   * ⚠️ The last few, not all of them. A run makes hundreds of calls and the
   * question this answers is "is it moving", which four lines answer as well
   * as forty and a card can hold. The one in flight is last and wears the mark
   * that says so. */
  private steps(session: SessionView, most: number): HTMLElement | null {
    const steps = (session.steps ?? []).slice(-most);
    if (!steps.length) return null;
    const list = element("div", "agent-steps");
    for (const step of steps) {
      const line = element("div", `agent-step${step.done ? " is-done" : " is-now"}`);
      const tick = element("span", "agent-tick");
      paintIcon(tick, step.done ? "check" : "play");
      line.append(tick, element("span", "agent-step-say", step.say));
      list.append(line);
    }
    return list;
  }

  /* ── The stage ─────────────────────────────────────────────────────────
   *
   * One live session, at the size the news deserves. Everything on it is a
   * fact the watcher read out of a transcript; none of it is a label for a
   * state that something else on the card already says.
   */
  private stage(session: SessionView): HTMLElement {
    const quiet = isQuiet(`agent:${session.id}`);
    const card = element("div", `agent-live is-${session.state}${quiet ? " is-quiet" : ""}`);

    const head = element("button", "agent-live-head");
    (head as HTMLButtonElement).type = "button";
    head.setAttribute("aria-label", `Go to ${session.project}, ${WORDS[session.state]}`);
    head.onclick = () => { void this.focus(session); };

    const mark = element("span", "agent-live-mark");
    paintIcon(mark, markFor(session.provider));
    head.append(mark);

    const who = element("div", "agent-live-who");
    const line = element("div", "agent-live-line");
    line.append(element("span", "agent-live-name", session.project));
    /* The state as its own word in its own colour — the way the picture of a
     * working agent has it, and the reason the name beside it can stay plain
     * white and be the thing that is read first. */
    const state = element("span", "agent-live-state");
    state.append(element("i", "agent-pip"), element("span", "", liveWord(session)));
    line.append(state);
    who.append(line);

    /* ── The second line is the FACTS, and they were the missing half ──
     * Whose agent it is and which model is answering were nowhere on this
     * screen, through a year in which it became normal to have several
     * sessions open on three different models. */
    const meta = element("div", "agent-live-meta");
    meta.append(element("span", "agent-agent", agentName(session.provider)));
    if (session.model) meta.append(element("span", "agent-model", modelName(session.model)));
    if (session.branch) meta.append(element("span", "agent-branch", session.branch));
    const clock = element("span", "agent-for", held(session.forSecs));
    this.clocks.set(session.id, clock);
    meta.append(clock);
    who.append(meta);
    head.append(who);
    card.append(head);

    const bell = this.bell(session, quiet);
    if (bell) card.append(bell);

    /* ── The body: what it did, and what it said about it ──────────────── */
    const body = element("div", "agent-live-body");
    const steps = this.steps(session, 4);
    if (steps) body.append(steps);
    /* ⚠️ The sentence is kept when the turn ends, unlike the checklist. A
     * status that has stopped being true is a lie; the last thing an agent
     * said is still the last thing it said — and on a waiting session it is
     * the whole reason you are looking at it. */
    const said = session.thinking || session.say;
    if (said) {
      const bubble = element("div", `agent-bubble${session.thinking ? " is-thought" : ""}`);
      bubble.append(element("p", "agent-bubble-say", said));
      body.append(bubble);
    }
    if (body.childElementCount) card.append(body);

    card.append(this.spent(session));
    return card;
  }

  /** The dots under the stage, one per live session.
   *
   * ⚠️ Real buttons, not decoration. They are the only way to reach the
   * session the stage is not showing, and a row of divs would be invisible to
   * a keyboard — on a screen whose whole purpose is getting somewhere. */
  private dots(live: SessionView[], shown: SessionView): HTMLElement {
    const rail = element("div", "agent-dots");
    for (const session of live) {
      const dot = element("button", `agent-dot is-${session.state}`);
      (dot as HTMLButtonElement).type = "button";
      dot.setAttribute("aria-label", `Show ${session.project}`);
      if (session.id === shown.id) {
        dot.classList.add("is-on");
        dot.setAttribute("aria-current", "true");
      }
      dot.onclick = () => {
        this.staged = session.id;
        this.changed();
      };
      rail.append(dot);
    }
    return rail;
  }

  /** A dormant session: one line, and nothing it does not have to say. */
  private row(session: SessionView): HTMLElement {
    const quiet = isQuiet(`agent:${session.id}`);
    const row = element("div", `agent-row is-${session.state}${quiet ? " is-quiet" : ""}`);
    const go = element("button", "agent-go");
    (go as HTMLButtonElement).type = "button";
    go.setAttribute("aria-label", `Go to ${session.project}, ${WORDS[session.state]}`);
    go.onclick = () => { void this.focus(session); };

    const mark = element("span", "agent-mark");
    paintIcon(mark, markFor(session.provider));

    const copy = element("div", "agent-copy");
    copy.append(element("span", "agent-project", session.project));
    const meta = element("div", "agent-meta");
    if (session.model) meta.append(element("span", "agent-model", modelName(session.model)));
    const clock = element("span", "agent-for", held(session.forSecs));
    this.clocks.set(session.id, clock);
    meta.append(element("span", "agent-since", "quiet for"), clock);
    copy.append(meta);

    go.append(mark, copy,
      element("span", "agent-quiet-spend", short(session.input + session.output)));
    row.append(go);
    const bell = this.bell(session, quiet);
    if (bell) row.append(bell);
    return row;
  }

  /** What today cost, and which project spent it.
   *
   * ⚠️ The usage notch says the window is going; nothing said what was eating
   * it. That is the question you actually have when you look at the ring, and
   * this app is the only thing on the machine already counting tokens per run
   * per project.
   *
   * ⚠️ Returns null on a day with no spend rather than an empty panel. A
   * heading over nothing is the hole this codebase keeps filling in.
   */
  private spendBlock(): HTMLElement | null {
    const rows = byProject(this.runs);
    if (!rows.length) return null;
    const whole = sum(rows);

    const block = element("section", "spend");
    const head = element("div", "spend-head");
    head.append(
      element("h3", "spend-title", "Spent today"),
      element("span", "spend-total", `${short(total(whole))} tokens · ${whole.runs} runs`),
    );
    block.append(head);

    for (const row of rows.slice(0, 5)) {
      const line = element("div", "spend-row");
      line.append(element("span", "spend-project", row.project));
      const rail = element("div", "spend-rail");
      const fill = element("i");
      /* ⚠️ A floor, not the raw share. A project at 2% draws a bar you cannot
       * see, which reads as "nothing" rather than as "a little" — and the
       * number beside it then looks like it belongs to the row above. */
      fill.style.width = `${Math.max(4, share(row, whole) * 100)}%`;
      rail.append(fill);
      line.append(rail, element("span", "spend-tokens", short(total(row))));
      line.dataset.tip = `${row.project}: ${short(row.input)} in, ${short(row.output)} out, `
        + `${row.runs} run${row.runs === 1 ? "" : "s"}`;
      block.append(line);
    }
    return block;
  }

  render() {
    this.host.replaceChildren();
    this.clocks.clear();
    if (!this.sessions.length) {
      this.host.append(element("p", "home-empty", "No agent sessions open."));
      return;
    }

    const live = this.live();
    if (live.length) {
      /* ⚠️ Falls back to the first rather than holding an id that is no longer
       * live. The staged session can finish while you are reading it, and a
       * stage that then renders nothing is a screen gone blank on the exact
       * tick something happened. */
      const shown = live.find(one => one.id === this.staged) ?? live[0];
      this.staged = shown.id;
      this.host.append(this.stage(shown));
      // One live session needs no pager: a single dot is furniture.
      if (live.length > 1) this.host.append(this.dots(live, shown));
    }

    const rest = this.sessions.filter(one => one.state === "idle");
    if (rest.length) {
      const quiet = element("div", "agent-quiet");
      /* A heading only where there is something above to tell these apart
       * from. On a screen of nothing but dormant sessions, "Quiet" over the
       * only list there is says nothing at all. */
      if (live.length) quiet.append(element("h3", "agent-quiet-title", "Quiet"));
      for (const session of rest) quiet.append(this.row(session));
      this.host.append(quiet);
    }

    const spend = this.spendBlock();
    if (spend) this.host.append(spend);
    if (this.error) this.host.append(element("p", "screen-error", this.error));
  }
}
