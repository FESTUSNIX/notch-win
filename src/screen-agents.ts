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
 */
import { listen } from "@tauri-apps/api/event";
import { element } from "./dom";
import { paintIcon } from "./task-icons";
import { call, native } from "./task-client";
import { byProject, share, short, sum, total } from "./spend";
import type { Run } from "./screen-review";
import { held, spoken, tokens } from "./media-format";
import { hush, isQuiet, wake } from "./snooze";
import type { Activity } from "./island-activity";

export type AgentState = "working" | "waiting" | "idle";

export interface SessionView {
  id: string;
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
}

const WORDS: Record<AgentState, string> = {
  waiting: "waiting for you",
  working: "working",
  idle: "idle",
};

export class AgentsScreen {
  readonly name = "agents" as const;
  sessions: SessionView[] = [];
  /** Ticks with the shell so "waiting 40s" climbs without a re-render. */
  private clocks = new Map<string, HTMLElement>();
  /** Today's finished runs, for the spend block. */
  private runs: Run[] = [];
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

  /** The pill claim.
   *
   * ⚠️ Only *waiting* claims it, never *working*. Something working needs
   * nothing from you and will carry on by itself; the pill is for things that
   * want you. Priority 55 puts it under a meeting about to start and over a
   * focus timer — a blocked agent is the most interruptible thing on this list
   * and the cheapest to deal with. */
  activity(): Activity | null {
    const waiting = this.sessions.filter(s => s.state === "waiting" && !isQuiet(`agent:${s.id}`));
    if (!waiting.length) return null;
    const first = waiting[0];
    return {
      priority: 55,
      screen: "agents",
      kind: "event",
      icon: "agent",
      label: waiting.length === 1 ? first.project : `${waiting.length} agents waiting`,
      value: waiting.length === 1 ? `waiting ${held(first.forSecs)}` : first.project,
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
      const raised = await call<boolean>("focus_session", { pid: session.pid });
      // A session started from a detached process owns no window. Saying so is
      // better than a button that silently does nothing.
      this.error = raised ? "" : `${session.project} has no window to raise.`;
    } catch (error) {
      this.error = String(error);
    }
    this.changed();
  }

  private row(session: SessionView): HTMLElement {
    const quiet = isQuiet(`agent:${session.id}`);
    const row = element("div", `agent-row is-${session.state}${quiet ? " is-quiet" : ""}`);
    const go = element("button", "agent-go");
    (go as HTMLButtonElement).type = "button";
    go.setAttribute("aria-label", `Go to ${session.project}, ${WORDS[session.state]}`);
    go.onclick = () => { void this.focus(session); };

    const mark = element("span", "agent-mark");
    paintIcon(mark, session.state === "waiting" ? "agent" : session.state === "working" ? "focus" : "clock");
    const copy = element("div", "agent-copy");
    const head = element("div", "agent-head");
    head.append(element("span", "agent-project", session.project));
    if (session.branch) head.append(element("span", "agent-branch", session.branch));
    const state = element("div", "agent-state");
    /* ⚠️ The WORK, where there is any, rather than the state. "working" is
     * three bits of information about something you are watching closely;
     * "editing palette.ts" is the thing you actually wanted to know, and the
     * transcript has been carrying it all along. The state word stays where
     * there is no phrase — waiting and idle have nothing to describe. */
    state.append(element("span", "agent-word", session.doing || WORDS[session.state]));
    const clock = element("span", "agent-for", held(session.forSecs));
    this.clocks.set(session.id, clock);
    state.append(clock);
    copy.append(head, state);

    const meta = element("div", "agent-meta");
    if (session.input || session.output) {
      meta.append(element("span", "agent-tokens",
        `${tokens(session.input)} / ${tokens(session.output)}`));
    }
    if (session.lastRunSecs) {
      meta.append(element("span", "agent-run", `last ${spoken(session.lastRunSecs)}`));
    }
    go.append(mark, copy, meta);

    /* Snoozing is only offered where it means something. An idle session is
     * already saying nothing, and muting silence is a control that does
     * nothing but make you wonder later what you switched off. */
    row.append(go);
    if (session.state === "waiting" || quiet) {
      const bell = element("button", `agent-snooze${quiet ? " is-on" : ""}`);
      (bell as HTMLButtonElement).type = "button";
      const label = quiet ? `Stop snoozing ${session.project}` : `Snooze ${session.project} for an hour`;
      bell.setAttribute("aria-label", label);
      bell.dataset.tip = label;
      paintIcon(bell, "snooze");
      bell.onclick = () => {
        void (quiet ? wake(`agent:${session.id}`) : hush(`agent:${session.id}`));
      };
      row.append(bell);
    }
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
      element("span", "spend-total", `${short(total(whole))} tokens \u00b7 ${whole.runs} runs`),
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
      this.host.append(element("p", "home-empty", "No Claude Code sessions open."));
      return;
    }
    for (const session of this.sessions) this.host.append(this.row(session));
    const spend = this.spendBlock();
    if (spend) this.host.append(spend);
    if (this.error) this.host.append(element("p", "screen-error", this.error));
  }
}
