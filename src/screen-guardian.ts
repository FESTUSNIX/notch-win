/* The Guardian, on the island: its nudges and the chat as one thread, the
 * same thread as Helm's Ctrl+J panel.
 *
 * The chat runs as Mateusz: `helm.rs` keeps his own Helm session (the
 * Guardian's tools act through Helm's row-level security, which a device key
 * can't), sends what he writes, and streams the reply back as `helm:chat`
 * events — `start`, `status`, `text`, `receipt`, `card`, `done`, `error`.
 *
 * ── Round 2 (28 Oct) ──────────────────────────────────────────────────────
 * - The composer is the kit's (src/kit/composer.ts): it grows, it has a mic
 *   (hold to talk → Helm's /api/transcribe → the words in the box, never sent
 *   by themselves), `@` for a project and `/` for what the line is.
 * - A PROJECT FOCUS: a chip on the bar, set from the project panel, the `@`
 *   picker or a card, and sent as `focus` with every message. The panel on the
 *   right shows that project's open requests and its time today.
 * - HISTORY: the panel on the left lists the days, with a search across every
 *   message; opening a day loads it (`/api/guardian/thread?day=`).
 * - The cards ACT: requests start with Claude or are done, a time suggestion
 *   is logged, a reminder is sent at a chosen level, a renewal is billed or
 *   reminded, the day's first thing is started — and each then says what
 *   happened, in place.
 * - A reply's changes are FOLDED ("4 zmiany ▾"), each with Cofnij inside.
 * - On hover a message offers copy, retry and "make it a request".
 * - The CHIPS over the composer are Helm's (`/api/guardian/suggestions`):
 *   three or four that fit now — a session running, an agent's run done, time
 *   to log, a call coming up, the end of the day — each a tinted glyph and a
 *   few words (kit `actionChip`). Asked for on open, after each reply and when
 *   the focus changes, with what only this machine knows: the agents' sessions
 *   and the project in focus. A Helm without the endpoint: no row at all.
 *
 * ⚠️ New paths may 404 or 503 until Helm ships them, and that is a STATE:
 * history hides its toggle, the mic hides, the `@` picker falls back to the
 * cockpit's folders. Nothing says so on the pill (AGENTS 777).
 *
 * ⚠️ Only the reply being written is touched while it streams. The thread is
 * keyed and rebuilt on a new message; the live reply's text is written in
 * place per event, so a long reply doesn't rebuild forty messages a second.
 */
import { element } from "./dom";
import { paintIcon, taskIcon, type TaskIcon } from "./task-icons";
import { call, native, previewBus } from "./task-client";
import { listen } from "@tauri-apps/api/event";
import { render as renderNote } from "./note-live";
import { nudgeAction, type HelmSource } from "./screen-helm";
import { logControl, logoTile } from "./helm-parts";
import { doingRequest, readSuggestions, spoken, zloty, type GuardianSuggestion } from "./helm-link";
import { Composer, type Sent } from "./kit/composer";
import { SidePanel, actionChip, iconButton, kchip, projectChip, segmented, setToggle, toggleButton } from "./kit/parts";
import { dayName, isDay, marks, plural, type Command, type MentionProject } from "./kit/words";
import { isVertical } from "./layout";
import type { IslandSurface } from "./island-surface";

type Undo = unknown;
interface Receipt { label: string; icon: string; undo: Undo | null; undoneAt?: string | null }

/* ── The cards, as Helm's contract has them (28 Oct) ─────────────────── */
interface DayCard {
  type: "day"; day: string;
  /** Old cards only: days had a must-win before the queue. */
  mustWin?: string | null;
  /** The top of the queue, first being Now. */
  queue?: { title: string; context: string | null; due: string | null; minutes: number | null }[];
  blocks: { id: number; title: string; time: string | null; minutes: number; status: string }[];
  /** "09:30" as Helm sends it. */
  meetings: { title: string; from: string; to: string }[];
}
interface Owed { label: string; client: string | null; amount: number; due: string | null }
interface MoneyCard { type: "money"; month: { earned: number; stillDue: number }; late: Owed[]; awaited: Owed[]; unbilled: { project: string; amount: number }[] }
interface RequestItem { id: number; title: string; status: string; priority: string; estimate: number | null; logged: number; due: string | null; waiting: string | null }
interface RequestsCard { type: "requests"; project: string; projectId: number; items: RequestItem[] }
interface DraftCard { type: "draft"; kind: string; to: string | null; subject: string | null; text: string; email: string | null; phone: string | null }
/** What to log on a request. ⚠️ The shape follows Done's own answer, so the
 *  same control logs it here as on an Agents card. */
interface TimeCard {
  type: "time"; requestId: number; title: string; project: string | null; projectId: number | null; minutes: number; you: number; agent: number; estimate: number | null; capped: boolean;
  /** Set by Helm once the time is in (read defensively: either spelling). */
  logged?: boolean; loggedAt?: string | null;
}
type Level = "friendly" | "firm" | "final";
interface ReminderCard { type: "reminder"; paymentId: number | string; title: string; client: string | null; amount: number; daysLate: number; level: Level }
interface RenewalCard { type: "renewal"; id: number | string; period: string | null; title: string; client: string | null; amount: number; on: string; paidBy: "me" | "client" }
type Card = DayCard | MoneyCard | RequestsCard | DraftCard | TimeCard | ReminderCard | RenewalCard;

interface Message {
  id: number;
  day: string;
  kind: string;
  role: "guardian" | "me";
  title: string | null;
  body: string;
  url: string | null;
  createdAt: string;
  read: boolean;
  receipts: Receipt[];
  cards: Card[];
  images: string[];
}
interface Thread { messages: Message[]; strictness: string; usual: string }

type ChatEvent =
  | { t: "start"; id: number }
  | { t: "status"; text: string }
  | { t: "text"; d: string }
  | { t: "receipt"; receipt: Receipt; index: number }
  | { t: "card"; card: Card }
  | { t: "done"; id: number | null; changed: boolean }
  | { t: "error"; message: string };

interface Live { text: string; status: string | null; receipts: Receipt[]; cards: Card[]; error: string | null; done?: boolean; id?: number | null }
export type { ChatEvent, Live, Receipt };
export type { Picture } from "./kit/composer";

/** What a message carries besides its words (Helm's chat contract, 28 Oct). */
export interface Extra {
  focus?: number | null;
  command?: Command | null;
  mentions?: { projectId: number }[];
  /** He said it (hold to talk, voice-talk.ts): Helm answers short and speakable. */
  voice?: boolean;
}

export interface HistoryDay { day: string; count: number; preview: string }
export interface Found { id: number; day: string; role: "guardian" | "me"; snippet: string; createdAt: string }

/** What this machine tells Helm for the chips: the project in focus, the
 *  agents working or waiting, and the requests a run just finished on. */
export interface SuggestHints { focus: number | null; agents: number; finished: number[] }

const RECEIPT_ICON: Record<string, TaskIcon> = {
  block: "target", start: "play", plan: "today", mode: "settings", request: "request", time: "clock",
  deal: "star", event: "calendar", note: "note", memory: "agent",
  done: "check", later: "later", pin: "pin", reminder: "bell",
};
const zl = new Intl.NumberFormat("pl-PL", { maximumFractionDigits: 0 });
const hhmm = new Intl.DateTimeFormat("pl-PL", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const localDay = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
};
const PL_LOG = { log: "Zaloguj", skip: "Pomiń", uncapped: "ponad estymację", uncappedTip: "Agenci pracowali dłużej niż estymacja; Helm nie przyciął czasu" };
const LEVELS: { value: Level; label: string }[] = [
  { value: "friendly", label: "Uprzejmie" },
  { value: "firm", label: "Stanowczo" },
  { value: "final", label: "Ostatecznie" },
];
const clean = (error: unknown) => String((error as Error)?.message ?? error).replace(/^(invoke error|error): /i, "").slice(0, 140);

/** The panels' widths, in CSS px. ⚠️ The island's width table adds them to
 *  the Guardian's own (tasks.ts `widthOf`), so these are the one copy. */
export const HISTORY_W = 232;
export const PROJECT_W = 252;

/** The thread and the turn in flight. */
export class GuardianChat {
  thread: Thread | null = null;
  error = "";
  pending = false;
  sent: { text: string; images: string[] } | null = null;
  live: Live | null = null;
  /** The live reply's text changed: written in place rather than redrawn. */
  onText: (() => void) | null = null;
  /** Every event of a chat turn as it arrives, for the spoken turn, which says
   *  the reply sentence by sentence while it streams (voice-talk.ts). */
  watch: ((event: ChatEvent) => void) | null = null;
  /** Quick capture's turn, kept apart from the chat's. */
  captured: Live | null = null;
  onCapture: (() => void) | null = null;
  /** An older day being read, or null for today (the live thread). */
  viewing: { day: string; messages: Message[] } | null = null;
  /** The days, for the history panel. null: not read, or a Helm without it. */
  days: HistoryDay[] | null = null;
  /** Whether this Helm keeps a history at all (404/503 hides the panel). */
  hasHistory = true;
  found: Found[] | null = null;
  private searchGen = 0;
  /** The chips over the composer, picked by Helm for NOW. null: not read, or
   *  a Helm without `/api/guardian/suggestions` — then there is no row at all
   *  (never the old three fixed ones, which only fitted the morning). */
  suggestions: GuardianSuggestion[] | null = null;
  /** What this machine adds to them; set by the shell. */
  hints: (() => SuggestHints) | null = null;
  private suggestGen = 0;
  /** Whose turn the events streaming in belong to.
   *
   * ⚠️ One stream, two readers. `helm:chat` carries no turn id, so a capture
   * and a chat message in flight at once would interleave into each other's
   * reply — which is why `pending` refuses the second, and this says which of
   * the two owns what arrives. */
  private turn: "chat" | "capture" | null = null;

  private changed: () => void;
  private say: (what: string, why: string) => void;

  constructor(changed: () => void, say: (what: string, why: string) => void) {
    this.changed = changed;
    this.say = say;
  }

  async boot() {
    const handle = (event: ChatEvent) => this.event(event);
    if (native) await listen<ChatEvent>("helm:chat", event => handle(event.payload));
    else previewBus.addEventListener("helm:chat", event => handle((event as CustomEvent<ChatEvent>).detail));
  }

  /** The thread again, and everything the Guardian said is read (he's looking at it).
   *  The chips are asked for again with it: opening the screen and every
   *  finished reply both come through here. */
  async load() {
    void this.loadSuggestions();
    try {
      this.thread = await call<Thread>("helm_thread");
      this.error = "";
      if (this.thread?.messages.some(m => m.role === "guardian" && !m.read)) void call("helm_read").catch(() => {});
    } catch (error) {
      this.error = clean(error);
    }
    this.changed();
  }

  /** Another day's messages. ⚠️ Read defensively: the contract says a bare
   *  array, the thread itself is an object with `messages` — both are taken. */
  async loadDay(day: string) {
    if (!isDay(day)) return;
    if (day === localDay()) { this.viewing = null; this.changed(); return; }
    try {
      const answer = await call<Message[] | Thread | null>("helm_thread", { day });
      const messages = Array.isArray(answer) ? answer : answer?.messages ?? [];
      this.viewing = { day, messages: messages.map(m => ({ ...m, day: m.day || day, receipts: m.receipts ?? [], cards: m.cards ?? [], images: m.images ?? [] })) };
    } catch (error) {
      this.say("Guardian", clean(error));
    }
    this.changed();
  }

  today() { if (this.viewing) { this.viewing = null; this.changed(); } }

  /** What's worth saying now, from Helm. ⚠️ A generation counter, like the
   *  search: the answer to an older ask (before the focus changed) must not
   *  land on top of the newer one. A failure keeps the last chips. */
  async loadSuggestions() {
    const gen = ++this.suggestGen;
    const hints = this.hints?.() ?? { focus: null, agents: 0, finished: [] };
    try {
      const answer = await call<unknown>("helm_suggestions", { project: hints.focus, agents: hints.agents, finished: hints.finished });
      if (gen !== this.suggestGen) return;
      this.suggestions = readSuggestions(answer);
    } catch {
      return;
    }
    this.changed();
  }

  /** The days with a count and a preview. A Helm without the endpoint answers
   *  null, and the panel's toggle goes away. */
  async loadHistory() {
    try {
      const answer = await call<{ days?: HistoryDay[] } | null>("helm_history", {});
      this.hasHistory = !!answer;
      this.days = Array.isArray(answer?.days) ? answer!.days : answer ? [] : null;
    } catch {
      /* the last list stays */
    }
    this.changed();
  }

  /** Search across every message. ⚠️ A generation counter: a slow answer for
   *  "fa" must not land on top of the one for "faktura" (AGENTS 172). */
  async search(query: string) {
    const gen = ++this.searchGen;
    const q = query.trim();
    if (!q) { this.found = null; this.changed(); return; }
    try {
      const answer = await call<{ results?: Found[] } | null>("helm_history", { q });
      if (gen !== this.searchGen) return;
      this.found = Array.isArray(answer?.results) ? answer!.results : [];
    } catch {
      if (gen !== this.searchGen) return;
      this.found = [];
    }
    this.changed();
  }

  async send(text: string, images: { mediaType: string; data: string; url: string }[] = [], extra: Extra = {}) {
    if (this.pending || (!text.trim() && !images.length)) return false;
    this.pending = true;
    this.turn = "chat";
    this.viewing = null;
    this.sent = { text: text.trim(), images: images.map(i => i.url) };
    this.live = { text: "", status: null, receipts: [], cards: [], error: null };
    this.changed();
    try {
      await call("helm_send", {
        text: text.trim(), images: images.map(({ mediaType, data }) => ({ mediaType, data })),
        focus: extra.focus ?? null, command: extra.command ?? null, mentions: extra.mentions?.length ? extra.mentions.map(m => m.projectId) : null,
        // Only on a spoken turn: every other message goes exactly as before.
        ...(extra.voice ? { voice: true } : {}),
      });
    } catch (error) {
      this.event({ t: "error", message: clean(error) });
      this.event({ t: "done", id: null, changed: false });
    }
    return true;
  }

  /** Quick capture: one line for the Guardian to file (`capture: true`).
   *  Returns false when a turn is already in flight. */
  async capture(text: string, extra: Extra = {}): Promise<boolean> {
    if (this.pending || !text.trim()) return false;
    this.pending = true;
    this.turn = "capture";
    this.captured = { text: "", status: null, receipts: [], cards: [], error: null, done: false, id: null };
    this.onCapture?.();
    try {
      await call("helm_send", {
        text: text.trim(), images: [], capture: true,
        command: extra.command ?? null, mentions: extra.mentions?.length ? extra.mentions.map(m => m.projectId) : null,
      });
    } catch (error) {
      this.event({ t: "error", message: clean(error) });
      this.event({ t: "done", id: null, changed: false });
    }
    return true;
  }

  private event(event: ChatEvent) {
    if (this.turn === "capture") return this.captureEvent(event);
    this.watch?.(event);
    const live = this.live;
    if (!live) return;
    switch (event.t) {
      case "status": live.status = event.text; this.onText?.(); return;
      case "text": live.status = null; live.text += event.d; this.onText?.(); return;
      case "receipt": live.receipts.push(event.receipt); this.changed(); return;
      case "card": live.cards.push(event.card); this.changed(); return;
      case "error": live.status = null; live.error = event.message; this.changed(); return;
      case "done":
        void this.load().then(() => {
          this.sent = null;
          // An error stays on screen; a finished reply is now in the thread.
          this.live = live.error ? { ...live, text: "", receipts: [], cards: [] } : null;
          this.pending = false;
          this.turn = null;
          this.changed();
        });
        return;
    }
  }

  /** The capture's reply, in its own live record. ⚠️ `done` frees the turn at
   *  once rather than after the thread reloads: the bar is waiting on it. */
  private captureEvent(event: ChatEvent) {
    const live = this.captured;
    if (!live) return;
    switch (event.t) {
      case "start": break;
      case "status": live.status = event.text; break;
      case "text": live.status = null; live.text += event.d; break;
      case "receipt": live.receipts.push(event.receipt); break;
      case "card": live.cards.push(event.card); break;
      case "error": live.status = null; live.error = event.message; break;
      case "done":
        live.status = null;
        live.done = true;
        live.id = event.id;
        this.pending = false;
        this.turn = null;
        void this.load();
        break;
    }
    this.onCapture?.();
  }

  async undo(messageId: number, index: number) {
    try {
      await call("helm_undo", { messageId, index });
      await this.load();
      if (this.viewing) await this.loadDay(this.viewing.day);
    } catch (error) {
      this.say("Guardian", clean(error));
    }
  }
}

type RenewalStage = "idle" | "bill" | "remind" | "billed" | "reminded" | "failed";
type TimeStage = "idle" | "logging" | "logged" | "stale";
/** What happened to a card here, by `message:index`. */
type CardState =
  | { kind: "time"; minutes: number; stage: TimeStage }
  | { kind: "reminder"; level: Level; stage: "idle" | "sending" | "sent" | "failed"; said: string }
  | { kind: "renewal"; stage: RenewalStage; said: string }
  | { kind: "requests"; done: Set<number>; started: Set<number>; busy: number | null }
  | { kind: "day"; started: boolean };

/** Helm's names for a chip's glyph, in this app's icon set (the same
 *  Hugeicons Helm's panel draws). Anything new on Helm's side gets the shield. */
const CHIP_ICON: Record<string, TaskIcon> = {
  today: "day", plan: "plan", next: "aim", split: "stopwatch", play: "play", agents: "robot", done: "check",
  time: "clock", money: "coins", renewal: "repeat", request: "request", call: "join", note: "note", close: "moon",
  tomorrow: "sunrise", week: "review", yes: "thumbsUp", no: "close", shorter: "scissor", here: "briefcase",
};
/** What a chip is about picks its disc's colour (kit.css `.k-act.is-*`); an unknown kind stays neutral. */
const CHIP_KINDS = new Set(["now", "day", "agents", "time", "money", "client", "meeting", "wrap", "reply", "here"]);

export class GuardianScreen {
  private host: HTMLElement;
  private chat: GuardianChat;
  private helm: HelmSource;
  private surface: IslandSurface;
  readonly composer: Composer;
  readonly history: SidePanel;
  readonly project: SidePanel;
  private drawn = "";
  private drawnHistory = "";
  private drawnProject = "";
  private liveText: HTMLElement | null = null;
  private liveStatus: HTMLElement | null = null;
  private cards = new Map<string, CardState>();
  /** Folded receipts opened, by message id (or "live"). */
  private unfolded = new Set<string>();
  /** Set for ONE render by a press inside the thread: keep it where it is.
   *  ⚠️ Every other render scrolls to the end (a new message is the news); a
   *  card's own stepper doing that would yank it out from under the pointer. */
  private keep = false;
  /** A message to bring into view once its day is drawn (a search hit). */
  private flash: number | null = null;
  private query = "";
  private searchTimer = 0;
  private widthChanged: () => void;
  /** The screen's own width in CSS px, without its panels — set by the shell. */
  mainCss = 680;

  constructor(host: HTMLElement, chat: GuardianChat, helm: HelmSource, surface: IslandSurface, hooks: { width: () => void }) {
    this.host = host;
    this.chat = chat;
    this.helm = helm;
    this.surface = surface;
    this.widthChanged = hooks.width;
    host.classList.add("g-screen");
    this.history = new SidePanel({ id: "guardian-history", side: "left", label: "History", className: "g-history" });
    this.project = new SidePanel({ id: "guardian-project", side: "right", label: "Project", className: "g-project" });
    this.history.el.style.setProperty("--side-w", `${HISTORY_W}px`);
    this.project.el.style.setProperty("--side-w", `${PROJECT_W}px`);
    this.composer = new Composer({
      id: "guardian",
      label: "Message to the Guardian",
      placeholder: "Napisz do Guardiana…",
      lines: 6,
      lift: on => surface.input(on),
      editing: () => surface.editing,
      ready: () => !chat.pending,
      send: sent => this.submit(sent),
      pictures: true,
      voice: helm.voice,
      projects: () => helm.projects,
      face: project => helm.faceOfProject(project),
      picked: project => { if (helm.focus === null) this.setFocus(project.id); },
      commands: true,
      resized: () => surface.measure(),
      closed: () => { this.composer.field.blur(); void surface.input(false).catch(() => {}); },
      say: (what, why) => helm.tell(what, why),
      className: "g-composer",
    });
    host.innerHTML = `
      <div class="g-shell leads">
        <div class="g-main lead">
          <div class="g-bar"></div>
          <div class="task-list scrolls g-thread"><div class="g-items"></div></div>
          <div class="g-foot"><div class="g-chips"></div></div>
        </div>
      </div>`;
    const shell = this.get(".g-shell");
    shell.prepend(this.history.el);
    shell.append(this.project.el);
    this.get(".g-foot").append(this.composer.el);
    chat.onText = () => this.paintLive();
    this.get(".g-thread").addEventListener("scroll", () => this.edges(), { passive: true });
    this.buildBar();
    this.buildHistory();
  }

  private get<T extends HTMLElement = HTMLElement>(selector: string): T {
    return this.host.querySelector<T>(selector)!;
  }

  /** Whether each panel adds its width, for the island's width table. */
  get extraWidth(): number {
    return (this.history.open && this.chat.hasHistory ? HISTORY_W : 0) + (this.project.open ? PROJECT_W : 0);
  }

  /* ── Sending ─────────────────────────────────────────────────────────── */

  private submit(sent: Sent): boolean {
    if (this.chat.pending) return false;
    void this.chat.send(sent.text, sent.pictures, { focus: this.helm.focus, command: sent.command, mentions: sent.mentions });
    return true;
  }

  /** A message sent from the thread itself: a chip, a retry, a quick reply. */
  private say(text: string, command: Command | null = null) {
    if (this.chat.pending || !text.trim()) return;
    void this.chat.send(text, [], { focus: this.helm.focus, command });
  }

  /** Escape while the box holds the caret releases it and keeps the draft. */
  escape(): boolean {
    if (document.activeElement !== this.composer.field) return false;
    if (this.composer.escape()) return true;
    this.composer.field.blur();
    void this.surface.input(false).catch(() => {});
    return true;
  }

  /* ── The bar: history, the focus, the day being read, the project ───── */

  private buildBar() {
    const bar = this.get(".g-bar");
    const hist = toggleButton("history", "History", "g-hist-toggle", () => {
      this.history.toggle();
      if (this.history.open && !this.chat.days) void this.chat.loadHistory();
      this.surface.deliberately();
      this.widthChanged();
      this.render();
    });
    const focus = element("div", "g-focus");
    const viewing = element("div", "g-viewing");
    const spacer = element("span", "g-spacer");
    const proj = toggleButton("sideRight", "Project", "g-proj-toggle", () => {
      this.project.toggle();
      this.surface.deliberately();
      this.widthChanged();
      this.render();
    });
    bar.append(hist, focus, viewing, spacer, proj);
  }

  private paintBar() {
    const hist = this.get<HTMLButtonElement>(".g-hist-toggle");
    hist.hidden = !this.chat.hasHistory;
    setToggle(hist, this.history.open && this.chat.hasHistory);
    setToggle(this.get<HTMLButtonElement>(".g-proj-toggle"), this.project.open);
    const focus = this.get(".g-focus");
    const project = this.helm.focusProject;
    focus.replaceChildren(project
      ? projectChip(this.helm.faceOfProject(project), project.name, () => this.setFocus(null), () => { if (!this.project.open) this.get<HTMLButtonElement>(".g-proj-toggle").click(); })
      : this.focusPrompt());
    const viewing = this.get(".g-viewing");
    viewing.replaceChildren();
    const day = this.chat.viewing?.day;
    if (day) {
      const chip = kchip(dayName(day, localDay()), "history");
      chip.classList.add("g-day-chip");
      const back = element("button", "g-today") as HTMLButtonElement;
      back.type = "button";
      back.textContent = "Dziś";
      back.dataset.tip = "Back to today";
      back.onclick = () => this.chat.today();
      viewing.append(chip, back);
    }
  }

  /** No focus: a ghost that opens the project panel to choose one. */
  private focusPrompt(): HTMLElement {
    const button = element("button", "g-focus-pick") as HTMLButtonElement;
    button.type = "button";
    const mark = element("span", "g-focus-mark");
    paintIcon(mark, "at");
    button.append(mark, element("span", "", "Projekt"));
    button.dataset.tip = "Focus on a project";
    button.setAttribute("aria-label", "Focus on a project");
    button.onclick = () => { if (!this.project.open) this.get<HTMLButtonElement>(".g-proj-toggle").click(); };
    return button;
  }

  /** ⚠️ Setting the focus never opens the panel by itself: picked from `@`
   *  mid-sentence, the island growing wide under the words being typed is the
   *  last thing wanted. The chip opens it. */
  private setFocus(id: number | null) {
    this.helm.setFocus(id);
    this.render();
    // One chip is about the project in focus.
    void this.chat.loadSuggestions();
  }

  /* ── History ─────────────────────────────────────────────────────────── */

  private buildHistory() {
    const inner = this.history.inner;
    const search = element("label", "g-search");
    const mark = element("span", "g-search-mark");
    paintIcon(mark, "search");
    const field = element("input", "k-field g-search-field") as HTMLInputElement;
    field.type = "search";
    field.placeholder = "Szukaj w rozmowach";
    field.setAttribute("aria-label", "Search the Guardian's messages");
    field.autocomplete = "off";
    field.spellcheck = false;
    field.oninput = () => {
      this.query = field.value;
      window.clearTimeout(this.searchTimer);
      this.searchTimer = window.setTimeout(() => { void this.chat.search(this.query); }, 220);
    };
    field.onkeydown = event => {
      if (event.key === "Escape" && field.value) {
        event.preventDefault();
        event.stopPropagation();
        field.value = "";
        this.query = "";
        void this.chat.search("");
      }
    };
    field.addEventListener("pointerdown", () => { if (!this.surface.editing) void this.surface.input(true).then(() => field.focus()).catch(() => {}); });
    search.append(mark, field);
    const list = element("div", "g-hist-list");
    inner.append(search, list);
  }

  private paintHistory() {
    const today = localDay();
    const key = JSON.stringify([this.chat.days, this.chat.found, this.query, this.chat.viewing?.day ?? today, this.history.open]);
    if (key === this.drawnHistory) return;
    this.drawnHistory = key;
    const list = this.history.inner.querySelector<HTMLElement>(".g-hist-list")!;
    list.replaceChildren();
    if (!this.history.open) return;
    const found = this.chat.found;
    if (found && this.query.trim()) {
      if (!found.length) list.append(element("p", "g-hist-empty", "Nic nie znaleziono"));
      for (const hit of found.slice(0, 40)) list.append(this.foundRow(hit, today));
      return;
    }
    const days = this.chat.days;
    if (!days) {
      for (let i = 0; i < 4; i++) list.append(element("div", "g-hist-ghost"));
      return;
    }
    const shown = this.chat.viewing?.day ?? today;
    const all = days.some(d => d.day === today) ? days : [{ day: today, count: this.chat.thread?.messages.filter(m => m.day === today).length ?? 0, preview: "" }, ...days];
    for (const one of all) {
      const row = element("button", `g-hist-day${one.day === shown ? " is-on" : ""}`) as HTMLButtonElement;
      row.type = "button";
      const head = element("span", "g-hist-head");
      head.append(element("span", "g-hist-name", dayName(one.day, today)));
      if (one.count) head.append(element("span", "k-count", String(one.count)));
      row.append(head);
      if (one.preview) row.append(element("span", "g-hist-preview", one.preview));
      row.setAttribute("aria-current", String(one.day === shown));
      row.onclick = () => { void this.chat.loadDay(one.day); };
      list.append(row);
    }
  }

  private foundRow(hit: Found, today: string): HTMLElement {
    const row = element("button", "g-hist-hit") as HTMLButtonElement;
    row.type = "button";
    const head = element("span", "g-hist-head");
    const who = element("span", `g-hist-who is-${hit.role}`);
    paintIcon(who, hit.role === "me" ? "you" : "guardian");
    head.append(who, element("span", "g-hist-name", dayName(hit.day, today)));
    const at = hit.createdAt ? hhmm.format(new Date(hit.createdAt)) : "";
    if (at) head.append(element("span", "g-hist-time", at));
    const snippet = element("span", "g-hist-snippet");
    let from = 0;
    for (const [start, end] of marks(hit.snippet, this.query)) {
      snippet.append(document.createTextNode(hit.snippet.slice(from, start)), element("mark", "", hit.snippet.slice(start, end)));
      from = end;
    }
    snippet.append(document.createTextNode(hit.snippet.slice(from)));
    row.append(head, snippet);
    row.onclick = () => {
      this.flash = hit.id;
      if (hit.day === today) { this.chat.today(); this.render(); }
      else void this.chat.loadDay(hit.day);
    };
    return row;
  }

  /* ── The project panel ───────────────────────────────────────────────── */

  private paintProject() {
    const project = this.helm.focusProject;
    const notch = this.helm.notch;
    const folder = project ? notch?.folders.find(f => f.project.id === project.id) ?? null : null;
    const time = project ? this.helm.timeToday(project) : null;
    const key = JSON.stringify([this.project.open, project?.id, folder, time, this.helm.projects.map(p => p.id), this.helm.logoTick, [...this.helm.starting], [...this.helm.doneHere]]);
    if (key === this.drawnProject) return;
    this.drawnProject = key;
    const inner = this.project.inner;
    inner.replaceChildren();
    if (!this.project.open) return;
    if (!project) {
      inner.append(element("h3", "g-pp-title", "Projekty"));
      const list = element("div", "g-pp-list");
      const projects = [...this.helm.projects].sort((a, b) => Number(!!b.live) - Number(!!a.live) || a.name.localeCompare(b.name, "pl"));
      for (const one of projects.slice(0, 30)) {
        const row = element("button", "g-pp-pick") as HTMLButtonElement;
        row.type = "button";
        row.append(logoTile(this.helm.faceOfProject(one), "sm"), element("span", "g-pp-name", one.name));
        if (one.live) {
          const live = element("span", "g-pp-live");
          live.dataset.tip = "Work going on";
          row.append(live);
        }
        row.onclick = () => this.setFocus(one.id);
        list.append(row);
      }
      if (!projects.length) list.append(element("p", "g-hist-empty", "Helm nie podał projektów"));
      inner.append(list);
      return;
    }
    const head = element("div", "g-pp-head");
    head.append(logoTile(this.helm.faceOfProject(project), "md"));
    const who = element("div", "g-pp-who");
    who.append(element("span", "g-pp-big", project.name));
    if (project.client && project.client !== project.name) who.append(element("span", "g-pp-client", project.client));
    head.append(who);
    inner.append(head);
    if (time && (time.you || time.agents)) {
      const figures = element("div", "g-pp-figures");
      const fig = (cls: string, icon: TaskIcon, minutes: number, tip: string) => {
        const f = element("span", `g-pp-fig ${cls}`);
        const mark = element("span", "g-pp-fig-mark");
        paintIcon(mark, icon);
        f.append(mark, element("b", "", spoken(minutes)));
        f.dataset.tip = tip;
        return f;
      };
      if (time.you) figures.append(fig("is-you", "you", time.you, `Twój czas dziś: ${spoken(time.you)}`));
      if (time.agents) figures.append(fig("is-agents", "claude", time.agents, `Agenci dziś: ${spoken(time.agents)}`));
      inner.append(figures);
    }
    const open = (folder?.requests ?? []).filter(r => !this.helm.doneHere.has(r.id));
    const list = element("div", "g-pp-list");
    if (open.length) {
      const title = element("h3", "g-pp-title");
      title.append(element("span", "", "Otwarte"), element("span", "k-count", String(open.length)));
      inner.append(title);
    }
    const doing = doingRequest(folder);
    for (const request of open) {
      const row = element("div", `g-pp-req${request.status === "doing" ? " is-doing" : ""}`);
      const text = element("div", "g-pp-req-text");
      text.append(element("span", "g-pp-req-title", request.title));
      row.append(text);
      const end = element("div", "g-pp-req-end");
      if (request.estimate) end.append(element("span", "g-pp-est", spoken(request.estimate)));
      if (request.status === "doing" && doing?.id === request.id) {
        const mark = element("span", "hp-agent");
        paintIcon(mark, "claude");
        mark.dataset.tip = "Claude is on it";
        end.append(mark);
      }
      const acts = element("div", "g-pp-acts");
      if (request.status !== "doing" && folder?.path) {
        const start = iconButton("claude", "Start with Claude", "g-pp-claude", () => this.helm.startWithClaude(request.id, request.title));
        start.disabled = this.helm.starting.has(request.id);
        acts.append(start);
      }
      acts.append(iconButton("check", "Done", "g-pp-done", () => { void this.helm.requestDone(request.id); }));
      row.append(end, acts);
      list.append(row);
    }
    if (!open.length) list.append(element("p", "g-hist-empty", folder ? "Nic otwartego" : "Ten projekt nie ma folderu na tym PC"));
    inner.append(list);
  }

  /* ── The thread ──────────────────────────────────────────────────────── */

  render() {
    const { thread, live, sent, pending, error, viewing } = this.chat;
    this.composer.refresh();
    this.paintBar();
    this.paintHistory();
    this.paintProject();
    const shell = this.get(".g-shell");
    const side = (this.history.open && this.chat.hasHistory) || this.project.open;
    shell.dataset.floor = side ? "360" : "";
    /* ⚠️ Horizontal edges only: on a left or right edge the island is the
     * shell's width and the panels squeeze in beside a main column that then
     * has to give way, rather than hold a width the island does not have. */
    shell.classList.toggle("has-side", side && !isVertical(this.surface.edge));
    shell.style.setProperty("--g-main-w", `${Math.round(this.mainCss)}px`);
    const messages = viewing ? viewing.messages : thread?.messages ?? [];
    const key = JSON.stringify([this.helm.signedIn, error, pending, !!sent, live?.receipts.length, live?.cards.length, live?.error, viewing?.day,
      messages.map(m => [m.id, m.receipts.map(r => !!r.undoneAt)]), this.helm.nudges.map(n => n.id),
      [...this.cards].map(([k, v]) => [k, JSON.stringify(v, (_, x) => x instanceof Set ? [...x] : x)]), [...this.unfolded], this.helm.starting.size,
      this.chat.suggestions?.map(s => s.id + s.label)]);
    if (key === this.drawn) return;
    this.drawn = key;
    const scrolled = this.get(".g-thread").scrollTop;

    this.composer.el.hidden = !this.helm.signedIn;
    const chips = this.get(".g-chips");
    chips.replaceChildren();
    const items = this.get(".g-items");
    items.replaceChildren();
    this.liveText = null;
    this.liveStatus = null;

    if (!this.helm.signedIn) {
      const box = element("div", "day-empty");
      box.append(element("h3", "", "Sign in to talk to the Guardian"), element("p", "", "Helm sends you a code by email; type it in Settings → Connections → Helm."));
      const button = element("button", "day-connect", "Open Settings");
      button.type = "button";
      button.onclick = () => { void call("open_task_editor").catch(() => {}); };
      box.append(button);
      items.append(box);
      return;
    }
    if (!thread && !viewing) {
      items.append(element("p", "g-quiet", error || "Wczytuję rozmowę…"));
      return;
    }

    // The newest nudge keeps its action and quick replies until he answers it.
    const all = thread?.messages ?? [];
    const lastNudge = [...all].reverse().find(m => m.role === "guardian" && m.kind !== "chat");
    const answered = !!lastNudge && all.some(m => m.role === "me" && m.createdAt > lastNudge.createdAt);
    const actionable = !viewing && !!lastNudge && lastNudge.day === localDay() && !answered && !pending;

    let day = "";
    messages.forEach((m, index) => {
      if (m.day !== day) {
        day = m.day;
        items.append(element("h3", "g-day", dayName(m.day, localDay())));
      }
      items.append(this.message(m, actionable && m.id === lastNudge?.id, messages, index));
    });
    if (!messages.length && !sent) {
      const quiet = element("div", "g-hello");
      const tile = element("span", "g-hello-tile");
      paintIcon(tile, "guardian");
      quiet.append(tile, element("p", "", viewing ? "Tego dnia nic nie było." : "Napisz, co trzeba zrobić. Układam kolejkę, przesuwam rzeczy w kalendarzu, dodaję zgłoszenia i piszę szkice."));
      items.append(quiet);
    }
    if (!viewing && sent) items.append(this.mine(sent.text, sent.images, null));
    if (!viewing && live) items.append(this.reply(live.text, live.receipts, live.cards, null, true, live.error));
    if (error && thread) items.append(element("p", "helm-error", error));

    // A nudge waiting for an answer carries its own replies; the chips would repeat them.
    if (!viewing && !pending && !actionable && this.composer.empty) {
      for (const one of this.chat.suggestions ?? []) {
        const chip = actionChip(one.label, CHIP_ICON[one.icon] ?? "guardian", CHIP_KINDS.has(one.kind) ? one.kind : "", () => this.say(one.prompt), one.prompt);
        chip.classList.add("g-suggest");
        chip.dataset.kind = one.kind;
        chips.append(chip);
      }
    }
    this.paintLive();
    if (this.flash !== null) {
      const id = this.flash;
      this.flash = null;
      requestAnimationFrame(() => {
        const target = items.querySelector<HTMLElement>(`[data-message="${id}"]`);
        if (!target) return;
        const box = this.get(".g-thread");
        box.scrollTop = Math.max(0, target.offsetTop - 24);
        target.classList.remove("is-flash");
        void target.offsetWidth;
        target.classList.add("is-flash");
        this.edges();
      });
    } else if (this.keep) {
      this.keep = false;
      this.get(".g-thread").scrollTop = scrolled;
    } else this.toEnd();
    requestAnimationFrame(() => this.edges());
  }

  /** A fade where there is more to scroll to, and only there (AGENTS 790). */
  private edges() {
    const box = this.get(".g-thread");
    const more = box.scrollHeight - box.clientHeight;
    box.classList.toggle("is-above", more > 1 && box.scrollTop > 1);
    box.classList.toggle("is-below", more > 1 && box.scrollTop < more - 1);
  }

  /** The reply as it streams: its text and what it's doing, in place. */
  private paintLive() {
    const live = this.chat.live;
    if (!live || this.chat.viewing) return;
    if (this.liveText) renderNote(this.liveText, live.text);
    if (this.liveStatus) {
      const status = this.chat.pending && !live.text && !live.status ? "Myślę" : live.status;
      this.liveStatus.querySelector(".g-status-text")!.textContent = status ? `${status}…` : "";
      this.liveStatus.hidden = !status;
    }
    this.toEnd();
  }

  private toEnd() {
    const box = this.get(".g-thread");
    requestAnimationFrame(() => { box.scrollTop = box.scrollHeight; this.edges(); });
  }

  private message(m: Message, actionable: boolean, list: Message[], index: number): HTMLElement {
    if (m.role === "me") return this.mine(m.body, m.images, m);
    if (m.kind !== "chat") return this.nudge(m, actionable);
    const row = this.reply(m.body, m.receipts, m.cards, m.id, false, null);
    row.dataset.message = String(m.id);
    // Retry asks again what was asked last before this reply.
    const asked = [...list.slice(0, index)].reverse().find(one => one.role === "me");
    row.append(this.hoverActs(m.body, asked?.body ?? null, false));
    return row;
  }

  /** On hover: copy, retry, make it a request. */
  private hoverActs(text: string, retry: string | null, mine: boolean): HTMLElement {
    const acts = element("div", `g-hover${mine ? " is-mine" : ""}`);
    acts.append(iconButton("copy", "Copy", "g-hover-copy", () => {
      void call("copy_text", { text }).then(() => this.helm.tell("Copied", text.slice(0, 48))).catch(() => {});
    }));
    if (retry) acts.append(iconButton("retry", "Ask again", "g-hover-retry", () => this.say(retry)));
    if (text.trim()) acts.append(iconButton("request", "Make it a request", "g-hover-request", () => this.say(text.slice(0, 1500), "request")));
    return acts;
  }

  private mine(text: string, images: string[], m: Message | null): HTMLElement {
    const row = element("div", "g-msg is-me");
    if (m) row.dataset.message = String(m.id);
    // His own message: the actions sit in the empty room to its left.
    if (m) row.append(this.hoverActs(text, text, true));
    const bubble = element("div", "g-mine");
    if (images.length) {
      const shots = element("div", "g-mine-shots");
      for (const url of images) {
        const img = element("img");
        img.src = url;
        img.alt = "";
        shots.append(img);
      }
      bubble.append(shots);
    }
    if (text) bubble.append(element("p", "g-text", text));
    row.append(bubble);
    return row;
  }

  private nudge(m: Message, actionable: boolean): HTMLElement {
    const row = element("div", "g-msg is-nudge");
    row.dataset.message = String(m.id);
    const tile = element("span", "g-nudge-tile");
    paintIcon(tile, "guardian");
    const body = element("div", "g-nudge");
    const head = element("div", "g-nudge-head");
    head.append(element("b", "g-title", m.title || "Guardian"));
    if (m.createdAt) head.append(element("span", "g-time", hhmm.format(new Date(m.createdAt))));
    body.append(head);
    if (m.body) body.append(element("p", "g-text", m.body));
    if (actionable) {
      const acts = element("div", "g-acts");
      const action = nudgeAction({ id: m.id, kind: m.kind, title: m.title, body: m.body, url: m.url, at: m.createdAt }, this.helm.blocks, [...this.helm.today, ...this.helm.suggested]);
      const go = element("button", "g-go");
      go.type = "button";
      go.append(taskIcon(action.icon), document.createTextNode(action.label));
      go.onclick = () => {
        if ("start" in action) this.helm.start(action.start);
        else if ("entry" in action) this.helm.startEntry(action.entry);
        else this.helm.open(action.open);
        this.helm.read([m.id]);
      };
      acts.append(go);
      for (const reply of this.helm.replies) {
        const chip = element("button", "g-chip", reply);
        chip.type = "button";
        chip.onclick = () => this.say(reply);
        acts.append(chip);
      }
      body.append(acts);
    }
    row.append(tile, body);
    return row;
  }

  private reply(text: string, receipts: Receipt[], cards: Card[], id: number | null, live: boolean, error: string | null): HTMLElement {
    const row = element("div", "g-msg is-reply");
    const box = element("div", "g-reply");
    const body = element("div", "g-text g-md");
    renderNote(body, text);
    box.append(body);
    if (live) {
      this.liveText = body;
      this.liveStatus = element("p", "g-status");
      this.liveStatus.append(element("span", "g-status-dot"), element("span", "g-status-text"));
      box.append(this.liveStatus);
    }
    if (receipts.length) box.append(this.receipts(receipts, id));
    cards.forEach((card, index) => {
      const built = this.card(card, `${id ?? "live"}:${index}`);
      if (built) box.append(built);
    });
    if (error) box.append(element("p", "helm-error", error));
    row.append(box);
    return row;
  }

  /** What a reply changed. ⚠️ Folded when there is more than one: four lines
   *  of "Start: …", "Plan: …" between a sentence and its cards push the cards
   *  off the panel, and the count says the same thing in one line. */
  private receipts(receipts: Receipt[], id: number | null): HTMLElement {
    const key = String(id ?? "live");
    const folded = receipts.length > 1 && !this.unfolded.has(key);
    const wrap = element("div", `g-changes${folded ? "" : " is-open"}`);
    if (receipts.length > 1) {
      const head = element("button", "g-changes-head") as HTMLButtonElement;
      head.type = "button";
      head.setAttribute("aria-expanded", String(!folded));
      const tick = element("span", "g-changes-tick");
      paintIcon(tick, "check");
      const undone = receipts.filter(r => r.undoneAt).length;
      const label = `${receipts.length} ${plural(receipts.length, "zmiana", "zmiany", "zmian")}`;
      const chevron = element("span", "k-chevron");
      paintIcon(chevron, "down");
      head.append(tick, element("span", "g-changes-label", label));
      if (undone) head.append(element("span", "g-changes-undone", `${undone} cofnięte`));
      head.append(chevron);
      head.onclick = () => {
        if (this.unfolded.has(key)) this.unfolded.delete(key);
        else this.unfolded.add(key);
        this.keep = true;
        this.surface.deliberately();
        this.render();
        this.surface.measure();
      };
      wrap.append(head);
    }
    if (!folded) {
      const list = element("ul", "g-receipts");
      receipts.forEach((receipt, index) => {
        const line = element("li", `g-receipt${receipt.undoneAt ? " is-undone" : ""}`);
        const icon = element("span", "g-receipt-icon");
        paintIcon(icon, receipt.undoneAt ? "undo" : RECEIPT_ICON[receipt.icon] ?? "check");
        line.append(icon, element("span", "g-receipt-label", receipt.label));
        if (receipt.undoneAt) line.append(element("span", "g-receipt-state", "Cofnięte"));
        else if (receipt.undo && id !== null) {
          const undo = element("button", "g-undo", "Cofnij");
          undo.type = "button";
          undo.onclick = () => { undo.disabled = true; this.keep = true; void this.chat.undo(id, index); };
          line.append(undo);
        }
        list.append(line);
      });
      wrap.append(list);
    }
    return wrap;
  }

  /* ── Cards ───────────────────────────────────────────────────────────── */

  private head(icon: TaskIcon, title: string, tone: string, side?: HTMLElement | null): HTMLElement {
    const head = element("div", "g-card-head");
    const mark = element("span", `g-card-tile is-${tone}`);
    paintIcon(mark, icon);
    head.append(mark, element("span", "g-card-title", title));
    if (side) head.append(side);
    return head;
  }

  private card(card: Card, at: string): HTMLElement | null {
    const box = element("div", `g-card is-${card.type}`);
    switch (card.type) {
      case "time": return this.timeCard(card, at, box);
      case "reminder": return this.reminderCard(card, at, box);
      case "renewal": return this.renewalCard(card, at, box);
      case "requests": return this.requestsCard(card, at, box);
      case "day": return this.dayCard(card, at, box);
      case "money": return this.moneyCard(card, box);
      case "draft": return this.draftCard(card, box);
      default: return null;
    }
  }

  private state<T extends CardState>(at: string, make: () => T): T {
    const held = this.cards.get(at) as T | undefined;
    if (held) return held;
    const fresh = make();
    this.cards.set(at, fresh);
    return fresh;
  }

  private redraw() { this.keep = true; this.drawn = ""; this.render(); this.surface.measure(); }

  /** A time suggestion: the minutes to log on a request, changeable, and Log. */
  private timeCard(card: TimeCard, at: string, box: HTMLElement): HTMLElement {
    const project = card.project ? element("span", "g-card-side", card.project) : null;
    box.append(this.head("clock", card.title, "iris", project));
    const state = this.state(at, () => ({ kind: "time" as const, minutes: Math.max(5, Math.round(card.minutes || 0)), stage: (card.logged ? "stale" : "idle") as TimeStage }));
    if (state.stage === "logged") {
      box.append(this.said("check", `Zalogowane: ${spoken(state.minutes)}`, "good"));
      return box;
    }
    if (state.stage === "stale") {
      box.append(this.said("clock", "Już nieaktualne: czas jest zalogowany", "quiet"));
      return box;
    }
    box.append(logControl({
      minutes: card.minutes, you: card.you ?? 0, agent: card.agent ?? 0,
      estimate: card.estimate ?? null, capped: card.capped !== false,
    }, {
      minutes: state.minutes,
      busy: state.stage === "logging",
      words: PL_LOG,
      setMinutes: minutes => { state.minutes = minutes; this.redraw(); },
      log: () => {
        state.stage = "logging";
        this.redraw();
        void this.stillOffered(card, at).then(still => {
          if (!still) { state.stage = "stale"; this.redraw(); return; }
          return this.helm.logTime(card.requestId, state.minutes)
            .then(() => { state.stage = "logged"; })
            .catch(() => { state.stage = "idle"; })
            .finally(() => this.redraw());
        });
      },
    }));
    return box;
  }

  /** A reminder: how late, how much, the level, and Send. */
  private reminderCard(card: ReminderCard, at: string, box: HTMLElement): HTMLElement {
    const side = element("div", "g-card-figs");
    side.append(element("b", "g-amount", zloty(card.amount)));
    if (card.daysLate > 0) side.append(element("span", "g-late", `${card.daysLate} ${plural(card.daysLate, "dzień", "dni", "dni")} po terminie`));
    box.append(this.head("bell", card.title, card.daysLate > 0 ? "hot" : "warn", side));
    if (card.client) box.append(element("p", "g-card-sub", card.client));
    const level = (["friendly", "firm", "final"] as Level[]).includes(card.level) ? card.level : "friendly";
    const state = this.state(at, () => ({ kind: "reminder" as const, level, stage: "idle" as "idle" | "sending" | "sent" | "failed", said: "" }));
    if (state.stage === "sent") {
      box.append(this.said("mail", state.said || "Wysłane", "good"));
      return box;
    }
    const acts = element("div", "g-card-acts");
    acts.append(segmented({
      label: "How firm", value: state.level, choices: LEVELS, disabled: state.stage === "sending",
      change: value => { state.level = value; this.redraw(); },
    }));
    const send = element("button", "hp-btn is-tinted g-card-go") as HTMLButtonElement;
    send.type = "button";
    const mark = element("span", "hp-btn-mark");
    paintIcon(mark, "mail");
    send.append(mark, element("span", "hp-btn-word", state.stage === "sending" ? "Wysyłam…" : "Wyślij"));
    send.disabled = state.stage === "sending";
    send.onclick = () => {
      state.stage = "sending";
      this.redraw();
      void this.helm.remind(card.paymentId, state.level).then(answer => {
        if (answer.ok) { state.stage = "sent"; state.said = answer.sentTo ? `Wysłane do ${answer.sentTo}` : "Wysłane"; }
        /* ⚠️ A level already sent is Helm's 409: the reminder HAS gone, so the
         * card is in its sent state, with Helm's own sentence on it. */
        else if (answer.already) { state.stage = "sent"; state.said = answer.error ?? "Już wysłane"; }
        else { state.stage = "failed"; state.said = answer.error ?? "Nie wysłano"; }
        this.redraw();
      });
    };
    acts.append(send);
    box.append(acts);
    if (state.stage === "failed") box.append(element("p", "g-card-error", state.said));
    return box;
  }

  /** A renewal: what, when, how much — billed to the client, or a reminder. */
  private renewalCard(card: RenewalCard, at: string, box: HTMLElement): HTMLElement {
    const side = element("div", "g-card-figs");
    side.append(element("b", "g-amount", zloty(card.amount)));
    if (card.on) side.append(element("span", "g-when", dayName(card.on.slice(0, 10), localDay())));
    box.append(this.head("repeat", card.title, "good", side));
    if (card.client || card.period) {
      const sub = element("div", "g-card-sub g-card-subline");
      if (card.client) sub.append(element("span", "", card.client));
      if (card.period) sub.append(kchip(card.period, "repeat"));
      box.append(sub);
    }
    const state = this.state(at, () => ({ kind: "renewal" as const, stage: "idle" as RenewalStage, said: "" }));
    if (state.stage === "billed" || state.stage === "reminded") {
      box.append(this.said(state.stage === "billed" ? "money" : "bell", state.said, "good"));
      return box;
    }
    const acts = element("div", "g-card-acts");
    const busy = state.stage === "bill" || state.stage === "remind";
    const act = (action: "bill" | "remind", icon: TaskIcon, label: string, primary: boolean) => {
      const button = element("button", `hp-btn ${primary ? "is-tinted" : "is-ghost"} g-card-${action}`) as HTMLButtonElement;
      button.type = "button";
      const mark = element("span", "hp-btn-mark");
      paintIcon(mark, icon);
      button.append(mark, element("span", "hp-btn-word", state.stage === action ? "…" : label));
      button.disabled = busy;
      button.onclick = () => {
        state.stage = action;
        this.redraw();
        void this.helm.renewal(card.id, action, card.period).then(answer => {
          if (answer.ok) { state.stage = action === "bill" ? "billed" : "reminded"; state.said = action === "bill" ? "Faktura wystawiona" : "Przypomnienie wysłane"; }
          else { state.stage = "failed"; state.said = answer.error ?? "Nie wyszło"; }
          this.redraw();
        });
      };
      return button;
    };
    if (card.paidBy === "client") acts.append(act("bill", "money", "Wystaw", true));
    acts.append(act("remind", "bell", "Przypomnij", card.paidBy !== "client"));
    box.append(acts);
    if (state.stage === "failed") box.append(element("p", "g-card-error", state.said));
    return box;
  }

  /** A project's requests: each can be started with Claude or done, here. */
  private requestsCard(card: RequestsCard, at: string, box: HTMLElement): HTMLElement {
    const focus = element("button", "g-card-focus") as HTMLButtonElement;
    focus.type = "button";
    const project = this.helm.projects.find(p => p.id === card.projectId) ?? { id: card.projectId, name: card.project } as MentionProject;
    focus.append(logoTile(this.helm.faceOfProject(project), "sm"));
    focus.dataset.tip = this.helm.focus === card.projectId ? "Focused" : `Focus on ${card.project}`;
    focus.onclick = () => this.setFocus(card.projectId);
    const head = this.head("request", card.project, "iris", focus);
    box.append(head);
    const state = this.state(at, () => ({ kind: "requests" as const, done: new Set<number>(), started: new Set<number>(), busy: null as number | null }));
    const list = element("div", "g-card-rows");
    for (const item of card.items) {
      const done = state.done.has(item.id) || item.status === "done";
      const started = state.started.has(item.id) || item.status === "doing";
      const row = element("div", `g-req${done ? " is-done" : ""}${started && !done ? " is-doing" : ""}`);
      const dot = element("span", `g-prio is-${item.priority}`);
      dot.dataset.tip = item.priority;
      const text = element("div", "g-req-text");
      text.append(element("span", "g-req-title", item.title));
      if (item.waiting) text.append(element("span", "g-req-wait", `Czeka na: ${item.waiting}`));
      row.append(dot, text);
      const end = element("div", "g-req-end");
      const figure = item.estimate ? `${spoken(item.logged)} / ${spoken(item.estimate)}` : item.logged ? spoken(item.logged) : "";
      if (done) end.append(kchip("Gotowe", "check", "good"));
      else if (started) {
        const mark = element("span", "hp-agent");
        paintIcon(mark, "claude");
        mark.dataset.tip = "Claude is on it";
        end.append(mark);
        if (figure) end.append(element("span", "g-req-fig", figure));
      } else if (figure) end.append(element("span", "g-req-fig", figure));
      row.append(end);
      if (!done) {
        const acts = element("div", "g-req-acts");
        if (!started) {
          const claude = iconButton("claude", "Start with Claude", "g-req-claude", () => {
            state.started.add(item.id);
            this.helm.startWithClaude(item.id, item.title);
            this.redraw();
          });
          claude.disabled = this.helm.starting.has(item.id);
          acts.append(claude);
        }
        const finish = iconButton("check", "Done", "g-req-done", () => {
          state.busy = item.id;
          this.redraw();
          void this.helm.requestDone(item.id).then(ok => {
            state.busy = null;
            if (ok) state.done.add(item.id);
            this.redraw();
          });
        });
        finish.disabled = state.busy === item.id;
        acts.append(finish);
        row.append(acts);
      }
      list.append(row);
    }
    if (!card.items.length) list.append(element("p", "g-card-sub", "Nic otwartego."));
    box.append(list);
    return box;
  }

  /** The day: the queue (Now first, with Start), the blocks, the meetings. */
  private dayCard(card: DayCard, at: string, box: HTMLElement): HTMLElement {
    box.append(this.head("today", dayName(card.day, localDay()), "accent", null));
    if (card.mustWin) box.append(element("p", "g-card-sub", card.mustWin));
    const state = this.state(at, () => ({ kind: "day" as const, started: false as boolean }));
    const rows = element("div", "g-card-rows");
    (card.queue ?? []).forEach((q, i) => {
      const line = element("div", `g-qrow${i === 0 ? " is-now" : ""}`);
      line.append(element("span", "g-qnum", String(i + 1)));
      const text = element("div", "g-qtext");
      text.append(element("span", "g-qtitle", q.title));
      if (i === 0 && q.context) text.append(element("span", "g-qcontext", q.context));
      line.append(text);
      if (q.minutes) line.append(element("span", "g-qmin", spoken(q.minutes)));
      if (i === 0 && !this.chat.viewing) {
        const entry = [...this.helm.today, ...this.helm.suggested].find(e => e.title === q.title);
        const live = this.helm.blocks.some(b => b.status === "running" && b.title === q.title);
        if (entry && !live && !state.started) {
          const go = element("button", "hp-btn is-tinted g-qgo") as HTMLButtonElement;
          go.type = "button";
          const mark = element("span", "hp-btn-mark");
          paintIcon(mark, "play");
          go.append(mark, element("span", "hp-btn-word", "Zacznij"));
          go.onclick = () => { state.started = true; this.helm.startEntry(entry); this.redraw(); };
          line.append(go);
        } else if (live || state.started) line.append(kchip("W toku", "play", "good"));
      }
      rows.append(line);
    });
    const timed = [
      ...card.meetings.map(meeting => ({ at: meeting.from, node: this.timedRow(meeting.from, meeting.title, `do ${meeting.to}`, "is-meeting") })),
      ...card.blocks.map(block => ({ at: block.time ?? "99:99", node: this.timedRow(block.time ?? "—", block.title, spoken(block.minutes), block.status === "done" ? "is-done" : "") })),
    ].sort((a, b) => a.at.localeCompare(b.at));
    if (timed.length) {
      const list = element("div", "g-card-timed");
      for (const one of timed) list.append(one.node);
      rows.append(list);
    }
    box.append(rows);
    return box;
  }

  private timedRow(time: string, title: string, side: string, cls: string): HTMLElement {
    const line = element("div", `g-trow ${cls}`.trim());
    line.append(element("span", "g-ttime", time), element("span", "g-tmark"), element("span", "g-ttitle", title), element("span", "g-tside", side));
    return line;
  }

  private moneyCard(card: MoneyCard, box: HTMLElement): HTMLElement {
    box.append(this.head("coins", "Pieniądze", "good", null));
    const figures = element("div", "g-figures");
    const figure = (value: number, label: string) => {
      const f = element("div", "g-figure");
      f.append(element("b", "", `${zl.format(value)} zł`), element("span", "", label));
      return f;
    };
    figures.append(figure(card.month.earned, "w tym miesiącu"), figure(card.month.stillDue, "do zapłaty"), figure(card.unbilled.reduce((t, u) => t + u.amount, 0), "do rozliczenia"));
    box.append(figures);
    for (const owed of card.late) {
      const line = element("div", "g-trow is-late");
      line.append(element("span", "g-ttitle", owed.client ? `${owed.client}: ${owed.label}` : owed.label), element("span", "g-tside", `${zl.format(owed.amount)} zł`));
      box.append(line);
    }
    return box;
  }

  private draftCard(card: DraftCard, box: HTMLElement): HTMLElement {
    box.append(this.head("mail", `Szkic${card.to ? ` · ${card.to}` : ""}`, "iris", null));
    if (card.subject) box.append(element("p", "g-card-subject", card.subject));
    box.append(element("p", "g-draft", card.text));
    const acts = element("div", "g-card-acts");
    const copy = element("button", "hp-btn is-ghost") as HTMLButtonElement;
    copy.type = "button";
    const mark = element("span", "hp-btn-mark");
    paintIcon(mark, "copy");
    copy.append(mark, element("span", "hp-btn-word", "Kopiuj"));
    copy.onclick = () => { void call("copy_text", { text: card.subject ? `${card.subject}\n\n${card.text}` : card.text }).then(() => this.helm.tell("Copied", card.subject ?? "Szkic")).catch(() => {}); };
    acts.append(copy);
    box.append(acts);
    return box;
  }

  /** Whether a time card is still on offer before its Log is acted on.
   *
   * ⚠️ A time card can be OLD now: one made from Claude Code is saved in the
   * thread, so Log can sit on a message from hours ago whose time has since
   * been logged elsewhere. Helm's own panel re-reads the thread first; so does
   * this. A card from the reply still streaming is new by definition. */
  private async stillOffered(card: TimeCard, at: string): Promise<boolean> {
    const [message, index] = at.split(":");
    if (message === "live") return true;
    const viewing = this.chat.viewing?.day;
    await (viewing ? this.chat.loadDay(viewing) : this.chat.load());
    const list = this.chat.viewing?.messages ?? this.chat.thread?.messages ?? [];
    const fresh = list.find(m => String(m.id) === message)?.cards[Number(index)] as TimeCard | undefined;
    return !!fresh && fresh.type === "time" && fresh.requestId === card.requestId && !fresh.logged && !fresh.loggedAt;
  }

  private said(icon: TaskIcon, text: string, tone: string): HTMLElement {
    const line = element("p", `g-card-said is-${tone}`);
    const mark = element("span", "g-card-said-mark");
    paintIcon(mark, icon);
    line.append(mark, element("span", "", text));
    return line;
  }
}
