/* Helm, on the island: today's must-win and focus blocks, the Guardian's
 * nudges, and the way into its chat.
 *
 * Helm is Mateusz's work OS; `helm.rs` reads it every 20 s and sends what it
 * read as `helm:changed`. Starting, pausing and finishing a block go back
 * through `helm_act`, and Helm applies its own rules (one block runs at a
 * time; a finished one pays the reward and logs the time).
 *
 * ⚠️ **A nudge stays until it is answered.** It claims the pill at 80 — over
 * everything but a toast that just went past — with no timeout, and leaves
 * only when it is read: here (its button, a reply, ×) or in Helm. Mateusz's
 * call: these are the ones that must not be missed.
 *
 * ⚠️ **While the screen is shared, the pill keeps a nudge's words to itself.**
 * It says "Guardian" and nothing else until the island is opened — the same
 * argument that keeps notification content off the header.
 */
import { element } from "./dom";
import { paintIcon, type TaskIcon } from "./task-icons";
import { call, native } from "./task-client";
import { listen } from "@tauri-apps/api/event";
import { timerText } from "./focus-timer";
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
  /** Where its action goes in Helm: `/start`, `/morning`, `/end`… */
  url: string | null;
  at: string;
}

export interface HelmToday {
  now: string;
  day: { mustWin: string | null; firstStep: string | null; closedAt: string | null; off: boolean } | null;
  blocks: HelmBlock[];
  nudges: HelmNudge[];
  replies: string[];
}

export interface Helm {
  connected: boolean;
  today: HelmToday | null;
  error: string | null;
  /** This clock minus Helm's at the reading. */
  skewMs: number;
  presenting: boolean;
}

export const emptyHelm = (): Helm => ({ connected: false, today: null, error: null, skewMs: 0, presenting: false });

/** Seconds a block has run, counted from when HELM says it started. */
export function blockSeconds(block: HelmBlock, skewMs: number, now = Date.now()): number {
  const running = block.status === "running" && block.runStartedAt
    ? Math.max(0, (now - skewMs - Date.parse(block.runStartedAt)) / 1000)
    : 0;
  return Math.floor(block.elapsedSeconds + running);
}

/** The block the strip speaks for: the running one, else one left paused. */
export function liveBlock(blocks: HelmBlock[]): HelmBlock | null {
  return blocks.find(b => b.status === "running") ?? blocks.find(b => b.status === "paused") ?? null;
}

/** The block a "Start" means: one left paused first, then the next planned. */
export function nextBlock(blocks: HelmBlock[]): HelmBlock | null {
  return blocks.find(b => b.status === "paused") ?? blocks.find(b => b.status === "planned") ?? null;
}

export type NudgeAction =
  | { label: string; icon: TaskIcon; start: number }
  | { label: string; icon: TaskIcon; open: string };

/** What a nudge's own button does, from where Helm points it.
 *
 * ⚠️ "Start" STARTS the block, here, rather than opening Helm's start screen:
 * the nudge exists to get the first block going, and a button that opens a
 * page about starting is one more step between him and it. With nothing
 * planned it opens that page, where a block can be planned. */
export function nudgeAction(nudge: HelmNudge, blocks: HelmBlock[]): NudgeAction {
  const path = nudge.url ?? "/guardian";
  if (path.startsWith("/start")) {
    const next = nextBlock(blocks);
    return next ? { label: "Start", icon: "play", start: next.id } : { label: "Plan the day", icon: "open", open: "/start" };
  }
  if (path.startsWith("/morning")) return { label: "Check in", icon: "sun", open: "/morning" };
  if (path.startsWith("/end")) return { label: "Close the day", icon: "check", open: "/end" };
  return { label: "Open", icon: "open", open: path };
}

export class HelmSource {
  helm: Helm = emptyHelm();
  /** Nudges answered here, hidden until the next reading agrees. */
  private answered = new Set<number>();
  /** A block action on its way, so its buttons do not take a second press. */
  pending: number | null = null;

  private changed: () => void;
  private say: (what: string, why: string) => void;

  constructor(changed: () => void, say: (what: string, why: string) => void) {
    this.changed = changed;
    this.say = say;
  }

  async boot() {
    if (native) {
      await listen<Helm>("helm:changed", event => {
        this.helm = event.payload;
        // A reading that no longer has them confirms them; keep only the rest.
        const unread = new Set(this.helm.today?.nudges.map(n => n.id) ?? []);
        for (const id of this.answered) if (!unread.has(id)) this.answered.delete(id);
        this.pending = null;
        this.changed();
      });
    }
    /* ⚠️ Asked for once at boot: the first reading may have been emitted
     * before this page was listening. See AGENTS on events. */
    try { this.helm = await call<Helm>("get_helm"); } catch { /* not yet */ }
    this.changed();
  }

  get connected(): boolean {
    return this.helm.connected;
  }

  get blocks(): HelmBlock[] {
    return this.helm.today?.blocks ?? [];
  }

  /** Unread, oldest first. */
  get nudges(): HelmNudge[] {
    return (this.helm.today?.nudges ?? []).filter(n => !this.answered.has(n.id));
  }

  private fail(error: unknown) {
    this.pending = null;
    this.say("Helm", String(error).replace(/^invoke error: /i, "").slice(0, 120));
    this.changed();
  }

  private act(action: Record<string, unknown>, block: number | null = null) {
    this.pending = block;
    this.changed();
    void call("helm_act", { action }).catch(error => this.fail(error));
  }

  start(block: number) { this.act({ do: "start", block }, block); }
  pause(block: number) { this.act({ do: "pause", block }, block); }
  done(block: number) { this.act({ do: "done", block }, block); }
  /** Focus on a task from Today: a Helm block of its own, started at once. */
  startNew(title: string) { this.act({ do: "new", title: title.slice(0, 120), minutes: 50 }); }

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

  /** The Guardian's chat window, with a line to send if one was typed. */
  chat(ask?: string) {
    void call("open_helm_chat", { ask: ask?.trim() || null }).catch(error => this.fail(error));
  }

  /** The newest unread nudge, on the strip. */
  nudgeClaim(): Activity | null {
    const waiting = this.nudges;
    const newest = waiting.at(-1);
    if (!newest) return null;
    const quiet = this.helm.presenting;
    return {
      priority: 80,
      screen: "helm",
      kind: "day",
      icon: "guardian",
      label: quiet ? "Guardian" : newest.title || "Guardian",
      value: quiet ? (waiting.length > 1 ? `${waiting.length} waiting` : "") : newest.body,
    };
  }

  /** The running (or paused) Helm block, on the strip where codenotch's own
   *  focus session used to be: 45, over music, under a meeting about to start. */
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
      value: held ? "paused" : block.project ?? "",
      time: timerText(seconds),
      held,
      progress: Math.min(1, seconds / Math.max(60, block.minutes * 60)),
    };
  }
}

const STATUS_ICON: Record<string, TaskIcon> = { running: "target", paused: "pause", done: "check", skipped: "close", planned: "clock" };

export class HelmScreen {
  private host: HTMLElement;
  private source: HelmSource;
  private surface: IslandSurface;
  private content: HTMLElement;
  private form: HTMLFormElement;
  private field: HTMLInputElement;
  private drawn = "";

  constructor(host: HTMLElement, source: HelmSource, surface: IslandSurface) {
    this.host = host;
    this.source = source;
    this.surface = surface;
    /* ⚠️ The Ask line lives OUTSIDE the redrawn part, like Today's composer:
     * the screen redraws on every reading, and a redraw must not take away
     * what is half-typed. */
    this.content = element("div", "helm-content");
    this.form = element("form", "helm-ask");
    this.field = element("input", "helm-ask-field");
    this.field.placeholder = "Ask the Guardian…";
    this.field.setAttribute("aria-label", "Ask the Guardian");
    this.field.autocomplete = "off";
    const send = element("button", "helm-ask-send");
    send.type = "submit";
    send.setAttribute("aria-label", "Open the chat");
    send.dataset.tip = "Open the chat";
    paintIcon(send, "open");
    this.form.append(this.field, send);
    this.host.append(this.content, this.form);
    this.wire();
  }

  private wire() {
    this.form.onsubmit = event => {
      event.preventDefault();
      const text = this.field.value.trim();
      this.source.chat(text);
      this.field.value = "";
      this.field.blur();
      void this.surface.input(false).catch(() => {});
    };
    // Focusing a field in a NOACTIVATE window needs the exception lifted first.
    this.form.addEventListener("pointerdown", event => {
      if (this.surface.editing || !(event.target instanceof HTMLElement) || event.target.closest(".helm-ask-send")) return;
      event.preventDefault();
      void this.surface.input(true).then(() => this.field.focus()).catch(() => {});
    });
  }

  /** Escape while the Ask line holds the caret releases it and keeps the draft. */
  escape(): boolean {
    if (document.activeElement !== this.field) return false;
    this.field.blur();
    void this.surface.input(false).catch(() => {});
    return true;
  }

  render() {
    const { helm, pending } = this.source;
    const today = helm.today;
    /* ⚠️ Keyed: `render()` runs every second with the shell, and rebuilding
     * the rows each time throws away the hover. The timers move in `tick`. */
    const key = JSON.stringify([helm.connected, helm.error, pending, today?.day?.mustWin,
      this.source.nudges.map(n => n.id),
      this.source.blocks.map(b => [b.id, b.status, b.title, b.minutes, b.plannedAt, b.project])]);
    if (key === this.drawn) return;
    this.drawn = key;
    this.form.hidden = !helm.connected;
    this.content.replaceChildren();

    if (!helm.connected) {
      const empty = element("div", "helm-empty");
      empty.append(element("p", "home-empty", "Helm isn't connected."));
      const connect = element("button", "helm-button", "Connect in Settings");
      connect.type = "button";
      connect.onclick = () => { void call("open_task_editor").catch(() => {}); };
      empty.append(connect);
      this.content.append(empty);
      return;
    }

    for (const nudge of [...this.source.nudges].reverse()) this.content.append(this.nudgeCard(nudge));

    const must = element("div", "helm-must");
    const mark = element("span", "helm-must-mark");
    paintIcon(mark, "target");
    must.append(mark, element("span", "helm-must-text", today?.day?.mustWin || "No must-win set yet"));
    must.classList.toggle("is-empty", !today?.day?.mustWin);
    this.content.append(must);

    const list = element("ul", "helm-blocks");
    for (const block of this.source.blocks) list.append(this.blockRow(block));
    if (!this.source.blocks.length) list.append(element("li", "helm-none", "No blocks planned today."));
    this.content.append(list);

    // The last reading stays on screen; what went wrong is said under it.
    if (helm.error) this.content.append(element("p", "helm-error", helm.error));
  }

  private nudgeCard(nudge: HelmNudge): HTMLElement {
    const card = element("div", "helm-nudge");
    const head = element("div", "helm-nudge-head");
    const mark = element("span", "helm-nudge-mark");
    paintIcon(mark, "guardian");
    head.append(mark, element("b", "helm-nudge-title", nudge.title || "Guardian"));
    const shut = element("button", "helm-nudge-shut");
    shut.type = "button";
    shut.setAttribute("aria-label", "Dismiss");
    shut.dataset.tip = "Dismiss (it's marked read in Helm)";
    paintIcon(shut, "close");
    shut.onclick = () => this.source.read([nudge.id]);
    head.append(shut);
    card.append(head, element("p", "helm-nudge-body", nudge.body));

    const acts = element("div", "helm-nudge-acts");
    const action = nudgeAction(nudge, this.source.blocks);
    const go = element("button", "helm-button is-primary");
    go.type = "button";
    const icon = element("span", "helm-button-icon");
    paintIcon(icon, action.icon);
    go.append(icon, document.createTextNode(action.label));
    go.onclick = () => {
      if ("start" in action) this.source.start(action.start);
      else this.source.open(action.open);
      this.source.read([nudge.id]);
    };
    acts.append(go);
    /* The quick replies Helm's own panel offers. ⚠️ They go to the CHAT, not
     * to a canned action here: "Za duże, daj 10 minut" is a request for the
     * Guardian to cut the block down, which is its judgement, not this app's. */
    for (const reply of this.source.helm.today?.replies ?? []) {
      const chip = element("button", "helm-chip", reply);
      chip.type = "button";
      chip.onclick = () => {
        this.source.chat(reply);
        this.source.read([nudge.id]);
      };
      acts.append(chip);
    }
    card.append(acts);
    return card;
  }

  private blockRow(block: HelmBlock): HTMLElement {
    const row = element("li", `helm-block is-${block.status}`);
    row.dataset.block = String(block.id);
    const mark = element("span", "helm-block-mark");
    paintIcon(mark, STATUS_ICON[block.status] ?? "clock");
    const text = element("span", "helm-block-text");
    text.append(element("span", "helm-block-title", block.title));
    const sub = [block.plannedAt, block.project, `${block.minutes} min`].filter(Boolean).join(" · ");
    text.append(element("span", "helm-block-sub", sub));
    row.append(mark, text);

    if (block.status === "running" || block.status === "paused") {
      row.append(element("time", "helm-time", timerText(blockSeconds(block, this.source.helm.skewMs))));
    }
    const busy = this.source.pending === block.id;
    const button = (icon: TaskIcon, label: string, run: () => void) => {
      const b = element("button", "helm-icon-button");
      b.type = "button";
      b.disabled = busy;
      b.setAttribute("aria-label", `${label}: ${block.title}`);
      b.dataset.tip = label;
      paintIcon(b, icon);
      b.onclick = run;
      return b;
    };
    if (block.status === "running") row.append(button("pause", "Pause", () => this.source.pause(block.id)));
    if (block.status === "paused" || block.status === "planned") row.append(button("play", block.status === "paused" ? "Resume" : "Start", () => this.source.start(block.id)));
    if (block.status === "running" || block.status === "paused") row.append(button("check", "Done", () => this.source.done(block.id)));
    return row;
  }

  /** The running block's clock, in place — the rows themselves are keyed. */
  tick() {
    for (const time of this.content.querySelectorAll<HTMLElement>(".helm-time")) {
      const id = Number(time.closest<HTMLElement>(".helm-block")?.dataset.block);
      const block = this.source.blocks.find(b => b.id === id);
      if (block) time.textContent = timerText(blockSeconds(block, this.source.helm.skewMs));
    }
  }
}
