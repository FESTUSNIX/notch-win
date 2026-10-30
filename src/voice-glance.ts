/* The voice glance (29 Oct, round 2): a spoken turn shown in the island's
 * glance — between the pill and the panel, his "50/50 state" — and never on
 * the Guardian's screen. His words: "I wouldn't display the whole guardian
 * chat page just for speech … the speech answers could also be displayed
 * this way with the text smoothly streaming in."
 *
 * One surface, five moments, each said by a picture before any word:
 * - LISTENING: his voice as live bars, the recording red, the time. Hands-free
 *   adds a lock on the mic and Enter and Esc drawn as keycaps.
 * - TRANSCRIBING: the bars settle into a soft shimmer.
 * - THINKING: his words as one line, the Guardian's shield pulsing beside
 *   whatever it is doing (Helm's own status line).
 * - ANSWER: the reply written in word by word, roughly as the voice says it
 *   (`revealMs`); receipts as compact chips with Cofnij; cards do not fit, so
 *   an open key grows the island into the Guardian with the thread.
 * - MUTED: the same, text only, and a mark that says why.
 *
 * ⚠️ Built ONCE and written in place, like the music glance and the pill. The
 * bars move twenty times a second and the words arrive one by one; a rebuild
 * would restart every word's fade and drop a press on Cofnij halfway through.
 *
 * ⚠️ A word fades and un-blurs; it does not slide. The words are INLINE, so
 * the reply wraps like prose — and `transform` does nothing to an inline box,
 * while opacity and filter do.
 */
import { element } from "./dom";
import { paintIcon, type TaskIcon } from "./task-icons";
import { clockOf } from "./kit/words";
import { MAX_SECONDS } from "./kit/voice";
import { revealMs, wordsOf, type Phase } from "./voice-turn";
import type { Receipt } from "./screen-guardian";

/** What the turn is doing, as the glance draws it. `done`: over, still up to read. */
export interface GlanceTurn {
  phase: Phase | "done";
  free: boolean;
  /** The press interrupted a reply: until it is known to be a hold, the answer stays. */
  barge: boolean;
  muted: string | null;
}

/** The reply on the glance: his words, then the Guardian's. */
export interface GlanceReply {
  heard: string;
  text: string;
  status: string | null;
  receipts: Receipt[];
  cards: number;
  /** The reply's message id, once Helm has saved it: what Cofnij needs. */
  id: number | null;
  done: boolean;
  error: string | null;
}

export const emptyReply = (heard = ""): GlanceReply =>
  ({ heard, text: "", status: null, receipts: [], cards: 0, id: null, done: false, error: null });

/** Why a reply is text only, as a glyph and its tooltip. */
const QUIET: Record<string, { icon: TaskIcon; tip: string }> = {
  off: { icon: "volumeOff", tip: "Text only: spoken replies are off" },
  call: { icon: "join", tip: "Text only: you're in a call" },
  meeting: { icon: "calendar", tip: "Text only: a meeting is on" },
  presenting: { icon: "share", tip: "Text only: you're presenting" },
  unavailable: { icon: "volumeOff", tip: "Text only: Helm can't speak yet (OPENAI_API_KEY)" },
};
const RECEIPT_ICON: Record<string, TaskIcon> = {
  block: "target", start: "play", plan: "today", mode: "settings", request: "request", time: "clock",
  deal: "star", event: "calendar", note: "note", memory: "agent",
  done: "check", later: "later", pin: "pin", reminder: "bell",
};
/** Enough to fill the row at its widest; the oldest are clipped off the left when keys take room. */
const BARS = 66;
/** Chips shown before the rest fold into "+n" (which opens the thread). */
const CHIPS = 2;
/** The last half-minute of a hands-free recording is counted down in warm. */
const LATE_SECONDS = MAX_SECONDS - 30;

export interface GlanceHooks {
  /** Grow the island into the Guardian, with the thread. */
  open: () => void;
  /** Take a receipt back; true once Helm has. */
  undo: (id: number, index: number) => Promise<boolean>;
  /** The content's natural depth changed, in CSS px. */
  measured: (depth: number) => void;
}

export class VoiceGlance {
  private inner = element("div", "v-inner");
  private head = element("div", "v-head");
  private disc = element("span", "v-disc");
  private lock = element("span", "v-lock");
  private wave = element("span", "v-wave");
  private bars: HTMLElement[] = [];
  private time = element("span", "v-time");
  private keys = element("span", "v-keys");
  private said = element("div", "v-said");
  private saidText = element("span", "v-said-text");
  private quiet = element("span", "v-quiet");
  private openKey = element("button", "v-open") as HTMLButtonElement;
  private openCount = element("span", "v-open-count");
  private replyRow = element("div", "v-reply");
  private shield = element("span", "v-shield");
  private status = element("p", "v-status");
  private answer = element("p", "v-answer");
  private error = element("p", "v-error");
  private chips = element("div", "v-chips");
  /** The words on screen, one span each. */
  private shown: HTMLElement[] = [];
  private source = "";
  private sourceDone = false;
  private revealTimer = 0;
  /** The reply is being said out loud: the words go in at the voice's pace. */
  speaking = false;
  /** Receipts taken back here, by index, until the thread says so too. */
  private undone = new Set<number>();
  private drawnChips = "";
  /** What the open key is for: the reply's cards, and receipts past the chips. */
  private cards = 0;
  private folded = 0;
  private measureFrame = 0;
  private lastDepth = 0;

  constructor(private host: HTMLElement, private hooks: GlanceHooks) {
    host.setAttribute("role", "status");
    host.setAttribute("aria-live", "polite");
    paintIcon(this.disc, "mic");
    paintIcon(this.lock, "lock");
    this.disc.append(this.lock);
    for (let i = 0; i < BARS; i++) {
      const bar = element("i");
      bar.style.setProperty("--i", String(i));
      this.wave.append(bar);
      this.bars.push(bar);
    }
    // ⚠️ Keycaps, drawn as keys: the two this mode listens for, Enter first because it is the one that sends.
    this.keys.append(element("kbd", "v-key is-send", "Enter"), element("kbd", "v-key", "Esc"));
    this.head.append(this.disc, this.wave, this.time, this.keys);

    const mark = element("span", "v-said-mark");
    paintIcon(mark, "mic");
    this.openKey.type = "button";
    paintIcon(this.openKey, "open");
    this.openKey.append(this.openCount);
    this.openKey.setAttribute("aria-label", "Open in the Guardian");
    this.openKey.dataset.tip = "Open in the Guardian";
    this.openKey.addEventListener("click", event => { event.stopPropagation(); this.hooks.open(); });
    this.said.append(mark, this.saidText, this.quiet, this.openKey);

    paintIcon(this.shield, "guardian");
    const body = element("div", "v-body");
    body.append(this.status, this.answer, this.error);
    this.replyRow.append(this.shield, body);

    this.inner.append(this.head, this.said, this.replyRow, this.chips);
    host.append(this.inner);
    /* A press on the glance is a press on the conversation: the Guardian, with
     * the thread. Its own buttons stop their presses reaching here. */
    host.addEventListener("click", () => this.hooks.open());
    this.reset();
  }

  /** A new turn: nothing of the last one left on it. */
  reset() {
    window.clearTimeout(this.revealTimer);
    this.revealTimer = 0;
    this.shown = [];
    this.source = "";
    this.sourceDone = false;
    this.answer.replaceChildren();
    this.undone.clear();
    this.drawnChips = "";
    this.cards = 0;
    this.folded = 0;
    this.chips.replaceChildren();
    this.saidText.textContent = "";
    this.status.textContent = "";
    this.error.textContent = "";
    for (const bar of this.bars) bar.style.removeProperty("--h");
    this.time.textContent = "0:00";
    this.host.style.setProperty("--lvl", "0");
  }

  /** What the turn is doing: which rows show, and in which colour. */
  turn(turn: GlanceTurn, reply: GlanceReply | null) {
    const { phase, free, barge, muted } = turn;
    // Pressed from a reply is maybe only a tap to stop it: the answer stays until it is a hold.
    const talking = phase === "listening" || phase === "transcribing" || (phase === "pressed" && !barge);
    this.host.dataset.phase = phase;
    this.host.dataset.free = String(free && phase === "listening");
    this.head.hidden = !talking;
    this.said.hidden = talking || !reply?.heard;
    this.replyRow.hidden = talking || !reply?.heard;
    this.time.hidden = phase !== "listening" && phase !== "pressed";
    this.keys.hidden = !(free && phase === "listening");
    this.lock.hidden = !(free && phase === "listening");
    const why = muted ? QUIET[muted] : null;
    this.quiet.hidden = !why || talking;
    if (why) {
      paintIcon(this.quiet, why.icon);
      this.quiet.dataset.tip = why.tip;
      this.quiet.setAttribute("aria-label", why.tip);
    }
    this.host.dataset.muted = String(!!why);
    this.paintReply(reply);
    // ⚠️ Here too, not only with a reply: back to one listening row after a tall answer, the glance has to shrink.
    this.remeasure();
  }

  /** The reply as it arrives. Cheap to call on every token: only what changed is touched. */
  paintReply(reply: GlanceReply | null) {
    if (!reply) return;
    if (this.saidText.textContent !== reply.heard) this.saidText.textContent = reply.heard;
    this.saidText.dataset.tip = reply.heard;
    const waiting = !reply.text && !reply.error;
    this.status.hidden = !waiting;
    this.status.textContent = reply.status ?? "";
    this.status.classList.toggle("is-blank", !reply.status);
    this.error.hidden = !reply.error;
    this.error.textContent = reply.error ?? "";
    if (reply.text !== this.source || reply.done !== this.sourceDone) {
      this.source = reply.text;
      this.sourceDone = reply.done;
      this.pump();
    }
    this.paintChips(reply);
    this.cards = reply.cards;
    this.folded = Math.max(0, reply.receipts.length - CHIPS);
    this.paintOpen();
    this.remeasure();
  }

  /** The open key: for cards, for receipts folded into +n, for an answer longer than the glance. */
  private paintOpen() {
    this.openKey.hidden = !this.cards && !this.folded && !this.overflowing();
    this.openCount.hidden = !this.cards;
    this.openCount.textContent = this.cards ? String(this.cards) : "";
  }

  /** Twenty times a second while it is up: the bars, the time, the voice's level. */
  tick(level: number, seconds: number, speaking: number) {
    const bars = this.bars;
    for (let i = 0; i < bars.length - 1; i++) bars[i].style.setProperty("--h", bars[i + 1].style.getPropertyValue("--h") || "0.06");
    bars[bars.length - 1].style.setProperty("--h", String(Math.max(0.06, Math.min(1, level))));
    const clock = clockOf(seconds);
    if (this.time.textContent !== clock) this.time.textContent = clock;
    this.time.classList.toggle("is-late", seconds >= LATE_SECONDS);
    this.host.style.setProperty("--lvl", speaking.toFixed(2));
  }

  /* ── The words ───────────────────────────────────────────────────────── */

  /** The next word in, at the pace `revealMs` gives it. */
  private pump() {
    if (this.revealTimer) return;
    const { words, whole } = wordsOf(this.source, this.sourceDone);
    // Words already shown keep their span; a marker resolving later only changes the letters.
    for (let i = 0; i < this.shown.length && i < words.length; i++) {
      if (this.shown[i].textContent !== words[i]) this.shown[i].textContent = words[i];
    }
    if (this.shown.length >= whole) return;
    const word = words[this.shown.length];
    const span = element("span", "v-w", word);
    this.answer.append(span);
    this.shown.push(span);
    this.follow();
    this.remeasure();
    this.revealTimer = window.setTimeout(() => {
      this.revealTimer = 0;
      this.pump();
    }, revealMs(word, this.speaking, whole - this.shown.length));
  }

  /** Everything still queued, at once — the glance is being folded or opened. */
  flush() {
    window.clearTimeout(this.revealTimer);
    this.revealTimer = 0;
    const { words } = wordsOf(this.source, true);
    for (let i = this.shown.length; i < words.length; i++) {
      const span = element("span", "v-w is-now", words[i]);
      this.answer.append(span);
      this.shown.push(span);
    }
    this.follow();
  }

  /** The newest line in view; the older ones fade off the top once it scrolls. */
  private follow() {
    this.answer.scrollTop = this.answer.scrollHeight;
    this.answer.classList.toggle("is-scrolled", this.answer.scrollTop > 0);
    this.paintOpen();
  }

  private overflowing(): boolean {
    return this.answer.scrollHeight > this.answer.clientHeight + 2;
  }

  /* ── Receipts ────────────────────────────────────────────────────────── */

  private paintChips(reply: GlanceReply) {
    const key = JSON.stringify([reply.id, reply.receipts.map(r => [r.label, !!r.undoneAt, !!r.undo]), [...this.undone]]);
    if (key === this.drawnChips) return;
    this.drawnChips = key;
    this.chips.hidden = !reply.receipts.length;
    this.chips.replaceChildren(...reply.receipts.slice(0, CHIPS).map((receipt, index) => this.chip(reply, receipt, index)));
    const more = reply.receipts.length - CHIPS;
    if (more > 0) {
      const rest = element("button", "v-rc is-more", `+${more}`) as HTMLButtonElement;
      rest.type = "button";
      rest.dataset.tip = "Open in the Guardian";
      rest.addEventListener("click", event => { event.stopPropagation(); this.hooks.open(); });
      this.chips.append(rest);
    }
  }

  private chip(reply: GlanceReply, receipt: Receipt, index: number): HTMLElement {
    const undone = !!receipt.undoneAt || this.undone.has(index);
    const chip = element("span", `v-rc${undone ? " is-undone" : ""}`);
    const mark = element("span", "v-rc-mark");
    paintIcon(mark, undone ? "undo" : RECEIPT_ICON[receipt.icon] ?? "check");
    const label = element("span", "v-rc-label", receipt.label);
    label.dataset.tip = receipt.label;
    chip.append(mark, label);
    // ⚠️ Cofnij needs the reply's id, which Helm sends with `done`: until then the chip only says what happened.
    const id = reply.id;
    if (!undone && receipt.undo && id !== null) {
      const undo = element("button", "v-rc-undo", "Cofnij") as HTMLButtonElement;
      undo.type = "button";
      undo.addEventListener("click", event => {
        event.stopPropagation();
        undo.disabled = true;
        void this.hooks.undo(id, index).then(ok => {
          if (ok) this.undone.add(index);
          undo.disabled = false;
          this.paintChips(reply);
        });
      });
      chip.append(undo);
    }
    return chip;
  }

  /* ── Size ────────────────────────────────────────────────────────────── */

  /** Ask for the depth the content needs, once per frame at most. */
  remeasure() {
    if (this.measureFrame) return;
    this.measureFrame = requestAnimationFrame(() => {
      this.measureFrame = 0;
      const pad = parseFloat(getComputedStyle(this.host).paddingTop) || 0;
      const depth = this.inner.offsetHeight + 2 * pad;
      if (Math.abs(depth - this.lastDepth) < 0.5) return;
      this.lastDepth = depth;
      this.hooks.measured(depth);
    });
  }
}
