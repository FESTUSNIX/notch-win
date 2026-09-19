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
import { svgEl } from "./svg";
import { paintIcon, type TaskIcon } from "./task-icons";
import { call, native } from "./task-client";
import { short } from "./spend";
import {
  all, byAgent, byDay, byProject, spent, type Bucket, type Slice,
} from "./usage";
import { held, spoken, tokens } from "./media-format";
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

/** An agent's mark, in a plinth, tagged with whose it is.
 *
 * ⚠️ The data attribute is what lets the stylesheet paint it in the
 * agent's OWN colour — Anthropic's terracotta, OpenAI's white — while the
 * state keeps the pip, the word and the card's wash. Two facts, two channels:
 * whose agent this is never changes, and what it is doing changes every few
 * seconds, so putting both in the same colour loses whichever moved last. */
function mark(where: string, session: { provider?: string }): HTMLElement {
  const box = element("span", where);
  box.dataset.agent = session.provider ?? "";
  paintIcon(box, markFor(session.provider));
  return box;
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

/** How many days the panel reads. A week: long enough to see a rhythm, short
 *  enough that every column is wide enough to aim at. */
const WINDOW = 7;

/** Today, as `usage.rs` files it — the LOCAL day, never UTC.
 *
 * ⚠️ `toISOString().slice(0, 10)` is the obvious one line and it is wrong
 * every evening: at 01:00 in Warsaw it says yesterday, so the chart's last
 * column stops being today for the busiest hours of the night. */
function today(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${String(now.getDate()).padStart(2, "0")}`;
}

/** `Wed`, for a column's tip. */
function weekday(day: string): string {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(year, month - 1, date).toLocaleDateString(undefined, { weekday: "short" });
}

export class AgentsScreen {
  readonly name = "agents" as const;
  sessions: SessionView[] = [];
  /** Ticks with the shell so "waiting 40s" climbs without a re-render. */
  private clocks = new Map<string, HTMLElement>();
  /** A fortnight of what the agents have cost, one bucket per day per model
   *  per project. See `usage.rs` — the runs themselves are kept separately
   *  and for a shorter time, because they answer a different question. */
  private usage: Bucket[] = [];
  /** Which live session the stage is showing.
   *
   * ⚠️ The session's ID, not its index. The list is re-sorted by state on
   * every tick — whoever wants you goes first — so an index points at a
   * different session the moment one of them finishes, and the page you were
   * reading would change under you with nothing having been clicked.
   */
  private staged = "";
  /** Whether the screen is showing one session rather than the overview.
   *
   * ⚠️ Not "is there a live session" — it is a place you navigated to, and it
   * has to survive a tick that changes what is live. The overview is what the
   * rail opens; the detail is what the strip opens. */
  private detailed = false;
  error = "";

  constructor(private host: HTMLElement, private changed: () => void) {}

  async boot() {
    try {
      this.sessions = await call<SessionView[]>("get_sessions");
      /* ⚠️ Read here rather than polled. A bucket only changes when a run
       * ends, and the watcher already pushes an event then — so a timer would
       * be re-reading a file to find it unchanged. */
      this.usage = await call<Bucket[]>("get_usage", { days: WINDOW });
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
  private spent(session: SessionView, figures = true): HTMLElement {
    const whole = session.input + session.output;
    const wrap = element("div", "agent-spend");
    /* ⚠️ Without the figures where they are already printed above. On the
     * detail the same two numbers sit in the facts row with their units under
     * them; repeating them four pixels below, abbreviated and unlabelled, is
     * the same fact twice in two formats — which reads as two facts. */
    if (figures) wrap.append(
      element("span", "agent-spend-in", short(session.input)),
      element("span", "agent-spend-out", `+${short(session.output)}`),
    );
    const rail = element("div", "agent-spend-rail");
    const fill = element("i");
    fill.style.width = whole ? `${(session.output / whole) * 100}%` : "0%";
    rail.append(fill);
    wrap.append(rail);
    /* ⚠️ `data-tip`, never `title`. A leftover `title` is not a harmless
     * duplicate: Windows draws its own tooltip a second later, in its own
     * colours, over this app's — so the control ends up with two labels that
     * disagree about when to appear. There is a test for it. */
    wrap.dataset.tip = `${tokens(session.input)} read, ${tokens(session.output)} written`;
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
    let index = 0;
    for (const step of steps) {
      const line = element("div", `agent-step${step.done ? " is-done" : " is-now"}`);
      // The stagger reads its own position. See `.agent-step` in tasks.css.
      line.style.setProperty("--i", String(index++));
      const tick = element("span", "agent-tick");
      paintIcon(tick, step.done ? "check" : "play");
      line.append(tick, element("span", "agent-step-say", step.say));
      list.append(line);
    }
    return list;
  }

  /* ── The detail ──────────────────────────────────────
   *
   * One session, at the size the news deserves — and NOT on the overview.
   * This is what the collapsed strip expands into: you looked down, saw that
   * something was running, and opened it to see what. Everything else the
   * screen knows is one tap away behind the arrow.
   *
   * ⚠️ Room, deliberately. Every reading here is one somebody is leaning in
   * to read — a checklist, a sentence, a pair of figures — and the version of
   * this that was tucked into the overview had them at 10 and 11 pixels with
   * four-pixel gaps, which is a density that suits a list of things you are
   * scanning past, not the one thing you stopped on.
   */
  private detail(session: SessionView): HTMLElement {
    const quiet = isQuiet(`agent:${session.id}`);
    const card = element("div", `agent-detail is-${session.state}${quiet ? " is-quiet" : ""}`);

    /* ⚠️ The way back is the ISLAND'S arrow, beside the screen's name — see
     * `paintBack`. A second arrow inside the panel is a second answer to the
     * same question, four millimetres from the first, and the one in the
     * header is where every other screen has already taught you to look. */
    const bell = this.bell(session, quiet);
    if (bell) card.append(bell);

    const head = element("button", "agent-detail-head");
    (head as HTMLButtonElement).type = "button";
    head.setAttribute("aria-label", `Go to ${session.project}, ${WORDS[session.state]}`);
    head.onclick = () => { void this.focus(session); };

    head.append(mark("agent-detail-mark", session));

    const who = element("div", "agent-detail-who");
    const line = element("div", "agent-detail-line");
    line.append(element("span", "agent-detail-name", session.project));
    const state = element("span", "agent-live-state");
    state.append(element("i", "agent-pip"), element("span", "", liveWord(session)));
    line.append(state);
    who.append(line);

    /* Whose agent, and which model. ⚠️ The separators are pseudo-elements
     * — a middot in the markup belongs to the model's own text, where a test,
     * a screen reader and a copy all find it. */
    const meta = element("div", "agent-detail-meta");
    meta.append(element("span", "agent-agent", agentName(session.provider)));
    if (session.model) meta.append(element("span", "agent-model", modelName(session.model)));
    if (session.branch) meta.append(element("span", "agent-branch", session.branch));
    who.append(meta);
    head.append(who);

    /* ── What it has spent, on the title's own line ──────────────────────
     * ⚠️ Up here rather than under the panels. At the bottom it was the last
     * thing on a screen that is otherwise about what the agent is DOING — and
     * it is the one part of this screen that is true whether or not anything
     * is happening, which is exactly what a header carries. The title has an
     * empty right-hand end; this is what it is for. */
    const facts = element("div", "agent-facts");
    const fact = (what: string, value: string) => {
      const box = element("div", "agent-fact");
      box.append(element("span", "agent-fact-value", value),
        element("span", "agent-fact-what", what));
      return box;
    };
    facts.append(fact("read", short(session.input)), fact("written", short(session.output)));
    const clock = element("span", "agent-fact-value", held(session.forSecs));
    this.clocks.set(session.id, clock);
    const since = element("div", "agent-fact");
    since.append(clock, element("span", "agent-fact-what",
      session.state === "waiting" ? "waiting" : session.state === "working" ? "running" : "quiet"));
    facts.append(since);
    if (session.lastRunSecs) facts.append(fact("last run", spoken(session.lastRunSecs)));
    head.append(facts);
    card.append(head);

    /* ── What it did, and what it said about it ──────────────────
     * Two columns, because they are two different kinds of thing: a list of
     * actions, and one sentence of prose. Stacked, the sentence reads as one
     * more step. */
    const body = element("div", "agent-detail-body");
    /* ⚠️ Six here against four on a card. A run makes hundreds of calls and
     * the question is "is it moving", which four lines answer — but this is
     * the screen somebody opened ON PURPOSE, and the next question after "is
     * it moving" is "what has it been doing", which needs a few more. */
    /* ⚠️ FOUR, not six. The question a checklist answers is "is it moving",
     * and four lines answer it as well as forty — six turned the panel into a
     * transcript, which is the thing you open the terminal for. */
    const steps = this.steps(session, 4);
    if (steps) {
      const panel = element("div", "agent-panel");
      panel.append(element("h4", "agent-panel-title", "Doing"), steps);
      body.append(panel);
    }
    /* ⚠️ The sentence is kept when the turn ends, unlike the checklist. A
     * status that has stopped being true is a lie; the last thing an agent
     * said is still the last thing it said — and on a waiting session it is
     * the whole reason you are looking at it. */
    const said = session.thinking || session.say;
    if (said) {
      const panel = element("div", "agent-panel");
      panel.append(element("h4", "agent-panel-title",
        session.thinking ? "Thinking about" : "Last said"));
      const bubble = element("div", `agent-bubble${session.thinking ? " is-thought" : ""}`);
      bubble.append(element("p", "agent-bubble-say", said));
      panel.append(bubble);
      body.append(panel);
    }
    if (body.childElementCount) card.append(body);

    /* ⚠️ No bar down here. The output share is worth a shape on a CARD,
     * where the figures are abbreviated to four characters and unlabelled —
     * but the facts in the header already say "512k read, 9k written" in
     * words, and a lone green sliver under them is a control nobody can name. */
    return card;
  }

  /** The dots under the detail, one per live session.
   *
   * ⚠️ Real buttons, not decoration. They are the only way to reach the
   * session the detail is not showing, and a row of divs would be invisible to
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

  /* ── The overview ────────────────────────────────────
   *
   * A card per session, in a grid. ⚠️ A COLUMN inside each card and a row of
   * cards across: a session's facts are short — a name, a model, a figure —
   * and laid out as a row each they left two thirds of the width empty while
   * making the screen one line taller per session. Five sessions was a screen
   * you had to scroll to see the usage under.
   */
  private card(session: SessionView): HTMLElement {
    const quiet = isQuiet(`agent:${session.id}`);
    const card = element("button", `agent-card is-${session.state}${quiet ? " is-quiet" : ""}`);
    (card as HTMLButtonElement).type = "button";
    card.setAttribute("aria-label", `${session.project}, ${WORDS[session.state]}`);
    /* ⚠️ Opens the DETAIL, it does not raise the window. On a card this
     * small the click target is the whole tile, and a tile that throws you into
     * another application is one you learn not to touch. Going there is a
     * deliberate second step, on the detail, where it is labelled. */
    card.onclick = () => {
      this.staged = session.id;
      this.detailed = true;
      this.changed();
    };

    const top = element("div", "agent-card-top");
    const state = element("span", "agent-card-state");
    state.append(element("i", "agent-pip"), element("span", "", liveWord(session)));
    top.append(mark("agent-card-mark", session), state);
    card.append(top);

    card.append(element("div", "agent-card-name", session.project));
    const meta = element("div", "agent-card-meta");
    meta.append(element("span", "agent-model", modelName(session.model) || agentName(session.provider)));
    if (session.branch) meta.append(element("span", "agent-branch", session.branch));
    card.append(meta);

    /* The one live fact a card has room for: what it is doing, or how long it
     * has been quiet. ⚠️ One line, clipped — the phrase is the tail of a
     * shell command often enough that wrapping it would make every card the
     * height of the longest command anybody has run today. */
    const line = element("div", "agent-card-doing");
    if (session.doing) line.textContent = session.doing;
    else if (session.thinking) line.textContent = session.thinking;
    else {
      line.classList.add("is-quiet");
      const clock = element("span", "agent-for", held(session.forSecs));
      this.clocks.set(session.id, clock);
      line.append(element("span", "agent-since",
        session.state === "waiting" ? "waiting" : "quiet"), clock);
    }
    card.append(line);
    /* ⚠️ Only where something HAS been spent. A session this app picked up
     * a minute ago reads "0 +0" against an empty rail, which is three pieces
     * of furniture saying nothing — on the card whose whole job is the few
     * things that are worth saying. */
    if (session.input || session.output) card.append(this.spent(session));
    return card;
  }

  /* ── What it all cost ─────────────────────────────────
   *
   * The usage notch says the window is going; nothing on the machine said what
   * ate it. That is the question you actually have when you look at that ring,
   * and this app is the only thing already counting tokens per run.
   *
   * ⚠️ Three cuts of one number, in TWO COLUMNS. Stacked, the same four
   * blocks ran the panel off the bottom of the island and every heading had to
   * be found by scrolling past the one above it; side by side, the shape of
   * the week and the list of who spent it are one glance.
   */

  /** One breakdown: a name, a bar, a figure. */
  private bars(rows: Slice[], whole: Slice, name: (row: Slice) => HTMLElement): HTMLElement {
    const list = element("div", "use-list");
    for (const row of rows.slice(0, 4)) {
      const line = element("div", "use-row");
      line.append(name(row));
      const rail = element("div", "use-rail");
      const fill = element("i");
      /* ⚠️ A floor, not the raw share. A row at 2% draws a bar you cannot
       * see, which reads as "nothing" rather than as "a little" — and the
       * number beside it then looks like it belongs to the row above. */
      const part = spent(whole) ? spent(row) / spent(whole) : 0;
      fill.style.width = `${Math.max(4, part * 100)}%`;
      rail.append(fill);
      line.append(rail, element("span", "use-tokens", short(spent(row))));
      line.dataset.tip = `${short(row.input)} in, ${short(row.output)} out, `
        + `${row.runs} run${row.runs === 1 ? "" : "s"}`;
      list.append(line);
    }
    return list;
  }

  /** The week, as a chart.
   *
   * ⚠️ A LINE over an area, not seven bars in boxes. Bars answer "how big
   * was Tuesday" one column at a time; the question this is here for is
   * whether today is normal, which is a shape — and at seven columns of
   * forty pixels the bars spent most of their room drawing their own empty
   * tracks.
   *
   * ⚠️ Every day, including the ones nothing ran on. A chart built from the
   * days that HAVE data draws three days off as three days of work in a row,
   * which is the opposite of what it is claiming.
   */
  private week(days: Slice[]): HTMLElement {
    const most = Math.max(...days.map(spent), 1);
    const wrap = element("div", "use-chart");

    /* The drawing space. ⚠️ `preserveAspectRatio="none"` stretches the
     * geometry to whatever width the panel is, which would stretch the stroke
     * with it — `vector-effect` on the paths is what keeps the line an even
     * 1.5px at any width, and without it the line is visibly thinner along
     * its flat stretches. */
    const view = svgEl("svg", { viewBox: "0 0 100 40", preserveAspectRatio: "none",
      class: "use-chart-svg", "aria-hidden": "true", focusable: "false" });
    const defs = svgEl("defs", {});
    const grad = svgEl("linearGradient", { id: "use-chart-fill", x1: "0", y1: "0", x2: "0", y2: "1" });
    grad.append(
      svgEl("stop", { offset: "0", "stop-color": "var(--accent)", "stop-opacity": ".34" }),
      svgEl("stop", { offset: "1", "stop-color": "var(--accent)", "stop-opacity": "0" }),
    );
    defs.append(grad);
    view.append(defs);

    /* Points over the MIDDLE of each day's own column, with a little headroom
     * at the top so the busiest day is not welded to the edge of its frame.
     *
     * ⚠️ The middle, not the edges. Spread from 0 to 100 the curve is a
     * seventh of a week out of step with the labels underneath it — Monday's
     * trough sits over Tuesday — and nothing about the picture looks wrong,
     * which is the whole problem. The line runs flat out to each edge so the
     * chart still fills its box. */
    const step = 100 / days.length;
    const at = (index: number) => (index + 0.5) * step;
    const high = (day: Slice) => 38 - (spent(day) / most) * 33;
    const points = days.map((day, index) => [at(index), high(day)] as const);

    const line = points.map(([x, y], index) => {
      if (!index) return `M0 ${y.toFixed(2)} L${x.toFixed(2)} ${y.toFixed(2)}`;
      const [px, py] = points[index - 1];
      /* A gentle curve rather than a kink at every point — and the control
       * points sit on the HORIZONTAL midpoint, which is what stops a zero day
       * between two busy ones from swinging the curve below the floor. */
      const mid = (px + x) / 2;
      return `C${mid.toFixed(2)} ${py.toFixed(2)} ${mid.toFixed(2)} ${y.toFixed(2)} `
        + `${x.toFixed(2)} ${y.toFixed(2)}`;
    }).join(" ");

    /* Out to the right edge as well, so the fill has no notch in its corners. */
    const full = `${line} L100 ${(points.at(-1)?.[1] ?? 38).toFixed(2)}`;
    view.append(svgEl("path", { d: `${full} L100 40 L0 40 Z`, fill: "url(#use-chart-fill)" }));
    view.append(svgEl("path", { d: full, class: "use-chart-line", fill: "none" }));
    wrap.append(view);

    /* Today, as a dot on the line. ⚠️ An HTML element placed over the chart
     * rather than a circle inside it: the drawing space is stretched, and a
     * circle in it comes out an ellipse as wide as the panel. */
    const last = points.at(-1);
    if (last) {
      const dot = element("i", "use-chart-dot");
      dot.style.left = `${last[0]}%`;
      dot.style.top = `${(last[1] / 40) * 100}%`;
      wrap.append(dot);
    }

    /* One hover target per day, and the day's own initial under it. */
    const labels = element("div", "use-days");
    for (const day of days) {
      const slot = element("div", "use-day");
      if (day.key === today()) slot.classList.add("is-today");
      slot.append(element("span", "use-day-name", weekday(day.key)));
      slot.dataset.tip = `${weekday(day.key)} \u00b7 ${short(spent(day))}`
        + (day.runs ? ` \u00b7 ${day.runs} run${day.runs === 1 ? "" : "s"}` : "");
      labels.append(slot);
    }
    const chart = element("div", "use-week");
    chart.append(wrap, labels);
    return chart;
  }

  /** What is left of the plan, where an agent says.
   *
   * ⚠️ Only Codex reports this, and only while a session is live — it
   * arrives on the transcript, not from an API. Absent is the normal case and
   * draws nothing rather than a row of dashes. */
  private plan(): HTMLElement | null {
    const live = this.sessions.find(one => one.limits?.week != null || one.limits?.window != null);
    if (!live?.limits) return null;
    const { window: short5, week, plan } = live.limits;
    const row = element("div", "use-plan");
    const name = element("span", "use-plan-name");
    name.append(mark("use-plan-mark", live), element("span", "", plan
      ? `${agentName(live.provider)} ${plan}` : agentName(live.provider)));
    row.append(name);
    for (const [label, used] of [["5h", short5], ["week", week]] as const) {
      if (used == null) continue;
      const meter = element("div", "use-meter");
      const fill = element("i");
      fill.style.width = `${Math.max(2, Math.min(100, used))}%`;
      if (used >= 80) meter.classList.add("is-high");
      meter.append(fill);
      const slot = element("div", "use-plan-slot");
      slot.append(element("span", "use-plan-label", label), meter,
        element("span", "use-plan-used", `${Math.round(used)}%`));
      slot.dataset.tip = `${Math.round(used)}% of the ${label === "5h" ? "five-hour" : "weekly"} limit`;
      row.append(slot);
    }
    return row;
  }

  private usageBlock(): HTMLElement | null {
    if (!this.usage.length) return null;
    const days = byDay(this.usage, today(), WINDOW);
    const mine = this.usage.filter(bucket => bucket.day === today());
    const agents = byAgent(mine);
    const projects = byProject(mine);
    const whole = all(agents);

    const block = element("section", "spend");
    const head = element("div", "spend-head");
    head.append(
      element("h3", "spend-title", "Usage"),
      /* ⚠️ The heading counts TODAY and the chart counts the week. A panel
       * where the big number and the chart mean different spans is one nobody
       * reads the same way twice, so the heading says which it is. */
      element("span", "spend-total", whole.runs
        ? `${short(spent(whole))} today · ${whole.runs} run${whole.runs === 1 ? "" : "s"}`
        : "nothing today"),
    );
    block.append(head);

    const grid = element("div", "use-grid");
    const left = element("div", "use-col");
    left.append(element("h4", "use-cut", "This week"), this.week(days));
    const plan = this.plan();
    if (plan) left.append(plan);
    grid.append(left);

    const right = element("div", "use-col");
    if (agents.length) {
      right.append(element("h4", "use-cut", "By agent"));
      right.append(this.bars(agents, whole, row => {
        /* The agent's own mark and the model it spent most on — the two facts
         * this panel never carried, on a screen whose whole subject is which
         * agent is doing what. */
        const name = element("span", "use-name");
        name.append(mark("use-mark", { provider: row.key }),
          element("span", "use-who", agentName(row.key)));
        if (row.top) name.append(element("span", "use-model", modelName(row.top)));
        return name;
      }));
    }
    if (projects.length > 1) {
      right.append(element("h4", "use-cut", "By project"));
      right.append(this.bars(projects, whole,
        row => element("span", "use-name", row.key)));
    }
    if (right.childElementCount) grid.append(right);
    block.append(grid);
    return block;
  }

  /** Open the session the strip is showing.
   *
   * ⚠️ Called when the island opens ON its own — see `landOn`. You looked
   * down, saw that something was running and opened it: the thing you came for
   * is that session, not a list with it somewhere in it. Walking to the screen
   * from the rail is the other intent entirely, and clears this. */
  openFromPill() {
    const first = this.sessions.filter(one => !isQuiet(`agent:${one.id}`))
      .find(one => one.state === "waiting")
      ?? this.sessions.filter(one => !isQuiet(`agent:${one.id}`))
        .find(one => one.state === "working");
    if (!first) return;
    this.staged = first.id;
    this.detailed = true;
    this.changed();
  }

  /** Whether the screen is showing one session rather than the overview.
   *  The island's header reads this to decide what its arrow means. */
  isDetailed(): boolean {
    return this.detailed && this.sessions.some(one => one.id === this.staged);
  }

  /** Back to the overview. */
  showList() {
    if (!this.detailed) return;
    this.detailed = false;
    this.changed();
  }

  render() {
    this.host.replaceChildren();
    this.clocks.clear();
    if (!this.sessions.length) {
      this.host.append(element("p", "home-empty", "No agent sessions open."));
      return;
    }

    /* ── One session, in detail ────────────────────────────
     * ⚠️ Falls back to the overview rather than holding an id that is gone.
     * The session being read can finish and be dropped while it is on screen,
     * and a detail view of nothing is a screen that has gone blank on the
     * exact tick something happened. */
    const shown = this.detailed
      ? this.sessions.find(one => one.id === this.staged)
      : undefined;
    if (shown) {
      this.host.append(this.detail(shown));
      /* The pager covers the LIVE ones. A dormant session is reachable from
       * the overview and nobody pages through six of them. */
      const live = this.live();
      if (live.length > 1 && live.some(one => one.id === shown.id)) {
        this.host.append(this.dots(live, shown));
      }
      if (this.error) this.host.append(element("p", "screen-error", this.error));
      return;
    }
    this.detailed = false;

    const grid = element("div", "agent-grid");
    for (const session of this.sessions) grid.append(this.card(session));
    this.host.append(grid);

    const usage = this.usageBlock();
    if (usage) this.host.append(usage);
    if (this.error) this.host.append(element("p", "screen-error", this.error));
  }
}
