/* Quick capture: one line to the Guardian, from wherever he is.
 *
 * `Ctrl+Alt+J` (shortcuts.rs) — or the palette's "Tell the Guardian" — opens
 * the island on a single field. Enter sends the line to the Guardian's chat
 * with `capture: true`, so Helm files it (a reminder, a to-do, a note on a
 * project) rather than chatting about it; the answer comes back as one line
 * with what it changed and Cofnij beside each, and the island folds itself
 * away a few seconds later. The thought is out of his head and he never left
 * what he was doing.
 *
 * ⚠️ A Helm older than the flag ignores it and answers as it would any chat
 * message. That is still a filed thought and a reply — just a longer one, which
 * the bar clamps to two lines — so nothing here waits on Helm understanding it.
 *
 * ⚠️ Built on the PALETTE's discipline, not its code: one open/close chain
 * (AGENTS 260 — two round trips to Rust racing each other leave the island
 * stuck in editing mode), the mask applied before anything opens the island
 * (397), the caret asked for until it arrives (`grab`), and the fold decided
 * before the size is handed back (399). The difference is the size: the
 * palette lies over the screen at its height, the capture bar IS the panel —
 * `setSolo` sizes the island to it, because a one-line field at the top of a
 * full-height black panel reads as a window that failed to load.
 */
import { element } from "./dom";
import { paintIcon, type TaskIcon } from "./task-icons";
import { FRAME, cpx } from "./layout";
import { Composer, type Sent, type Voice } from "./kit/composer";
import type { Face } from "./helm-parts";
import type { MentionProject } from "./kit/words";
import type { IslandSurface } from "./island-surface";
import type { GuardianChat } from "./screen-guardian";

/** How long the answer stays before the island folds itself away, once the
 *  reply is in. Long enough to read one line and reach Cofnij. */
const LINGER_MS = 6000;

const RECEIPT_ICON: Record<string, TaskIcon> = {
  block: "target", start: "play", plan: "today", request: "request", time: "clock",
  deal: "star", event: "calendar", note: "note", memory: "agent", reminder: "bell",
  done: "check", later: "later", pin: "pin",
};

export class Capture {
  private host: HTMLElement;
  /** The kit's composer: it grows to four lines, takes `@` and `/`, and has
   *  the mic — the same field as the Guardian's, one line tall at rest. */
  readonly composer: Composer;
  private answer: HTMLElement;
  private surface: IslandSurface;
  private chat: GuardianChat;
  private onClose: () => void;
  private signedIn: () => boolean;
  private say: (what: string, why: string) => void;
  private linger: number | undefined;
  private undone = new Set<number>();
  private keys = (event: KeyboardEvent) => this.key(event);
  private away = (event: PointerEvent) => this.outside(event);
  private queue: Promise<unknown> = Promise.resolve();
  open = false;

  constructor(surface: IslandSurface, chat: GuardianChat, hooks: {
    signedIn: () => boolean;
    say: (what: string, why: string) => void;
    /** Give the screen underneath its width back. */
    closed: () => void;
    voice: Voice;
    projects: () => MentionProject[];
    face: (project: MentionProject) => Face | null;
  }) {
    this.surface = surface;
    this.chat = chat;
    this.signedIn = hooks.signedIn;
    this.say = hooks.say;
    this.onClose = hooks.closed;
    this.host = element("div", "capture");
    this.host.hidden = true;
    this.composer = new Composer({
      id: "capture",
      label: "One line for the Guardian",
      placeholder: "Jedna linijka dla Guardiana…",
      maxLength: 500,
      lines: 4,
      lift: on => surface.input(on),
      editing: () => surface.editing,
      ready: () => !chat.pending,
      send: sent => this.submit(sent),
      voice: hooks.voice,
      projects: hooks.projects,
      face: hooks.face,
      commands: true,
      // ⚠️ Under the field, in flow: the bar IS the panel and has no room above it.
      below: true,
      lead: "guardian",
      resized: () => surface.measure(),
      say: hooks.say,
      className: "capture-bar",
    });
    this.composer.field.classList.add("capture-field");
    const bar = this.composer.el;
    this.answer = element("div", "capture-answer");
    this.answer.hidden = true;
    this.answer.setAttribute("aria-live", "polite");
    this.host.append(bar, this.answer);
    chat.onCapture = () => this.paint();
  }

  element(): HTMLElement { return this.host; }

  private chain<T>(job: () => Promise<T>): Promise<T> {
    const next = this.queue.then(job, job);
    // ⚠️ The chain must not stay rejected, or every later press is dropped.
    this.queue = next.catch(() => {});
    return next;
  }

  /** Open on the field — with words already in it, and sent, when the palette
   *  handed some over. */
  show(text = "", send = false) { return this.chain(() => this.opening(text, send)); }
  hide() { return this.chain(() => this.closing()); }
  /** The shortcut: the key that opens it closes it. */
  toggle() { return this.chain(() => (this.open ? this.closing() : this.opening("", false))); }

  private async opening(text: string, send: boolean) {
    if (!this.signedIn()) {
      this.say("Guardian", "Sign in to Helm in Settings first");
      return;
    }
    if (this.open) {
      await this.grab();
      return;
    }
    // ⚠️ `open` and the mask FIRST, before `pinFor` opens the island (AGENTS 397).
    this.open = true;
    this.mask(true);
    this.surface.pinFor(8000);
    this.host.hidden = false;
    this.composer.setDisabled(false);
    if (text) this.composer.set(text);
    this.answer.hidden = true;
    this.answer.replaceChildren();
    this.undone.clear();
    window.clearTimeout(this.linger);
    this.surface.capBody(cpx(FRAME.islandPaletteLong));
    document.addEventListener("keydown", this.keys, true);
    document.addEventListener("pointerdown", this.away, true);
    await this.surface.input(true).catch(() => {});
    await this.grab();
    this.surface.deliberately();
    this.surface.measure();
    if (send && text.trim()) this.composer.submit();
  }

  /** ⚠️ Asked for until it arrives: one `focus()` can land before the native
   *  side has lifted NOACTIVATE, and then the keys go to the app behind. */
  private async grab() {
    const field = this.composer.field;
    for (let tries = 0; tries < 15; tries++) {
      field.focus({ preventScroll: true });
      if (document.activeElement === field && document.hasFocus()) break;
      await new Promise(frame => requestAnimationFrame(frame));
    }
    field.setSelectionRange(field.value.length, field.value.length);
  }

  private async closing() {
    if (!this.open) return;
    this.open = false;
    window.clearTimeout(this.linger);
    this.host.hidden = true;
    document.removeEventListener("keydown", this.keys, true);
    document.removeEventListener("pointerdown", this.away, true);
    await this.surface.input(false).catch(() => {});
    // ⚠️ Folding: the screen's size is left for the next opening (AGENTS 399).
    if (this.surface.foldIfDone()) return;
    this.mask(false);
    this.surface.deliberately();
    this.onClose();
    this.surface.measure();
  }

  /** The panel's screen, header and furniture stand down while this is up. */
  private mask(on: boolean) {
    document.getElementById("island-expanded")?.classList.toggle("is-capturing", on);
    this.surface.setSearching(on);
    this.surface.setSolo(on);
  }

  /** The island opened again after a fold that happened while this was up. */
  unmask() { if (!this.open) this.mask(false); }

  private outside(event: PointerEvent) {
    if (!this.open) return;
    if (event.target instanceof Node && this.host.contains(event.target)) return;
    void this.hide();
  }

  private key(event: KeyboardEvent) {
    if (!this.open) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      // The composer's own Escape first: a picker, a recording, the words.
      if (this.composer.escape()) return;
      void this.hide();
      return;
    }
    // Enter on an empty line is "never mind", the way Escape is.
    if (event.key === "Enter" && !event.shiftKey && this.composer.empty && !this.composer.recording && !this.chat.captured?.done) {
      event.preventDefault();
      event.stopPropagation();
      void this.hide();
    }
  }

  private submit(sent: Sent): boolean {
    if (!sent.text) return false;
    if (this.chat.pending) {
      this.say("Guardian", "Still answering the last one");
      return false;
    }
    void this.chat.capture(sent.text, { command: sent.command, mentions: sent.mentions });
    this.composer.setDisabled(true);
    this.paint();
    return true;
  }

  /** The reply as it streams: what it is doing, then one line and its receipts.
   *  Folds itself away a moment after the reply is in. */
  private paint() {
    const live = this.chat.captured;
    if (!this.open || !live) return;
    this.answer.hidden = false;
    this.answer.replaceChildren();
    const line = element("div", `capture-line${live.error ? " is-error" : ""}`);
    const mark = element("span", "capture-line-mark");
    if (live.error) paintIcon(mark, "close");
    else if (live.done) paintIcon(mark, "check");
    else mark.classList.add("is-thinking");
    const said = live.error ?? (live.text.trim() || (live.status ? `${live.status}…` : "Myślę…"));
    line.append(mark, element("p", `capture-text${!live.text.trim() && !live.error ? " is-status" : ""}`, said));
    this.answer.append(line);
    if (live.receipts.length) {
      const list = element("ul", "capture-receipts");
      live.receipts.forEach((receipt, index) => {
        const undone = this.undone.has(index) || !!receipt.undoneAt;
        const row = element("li", `capture-receipt${undone ? " is-undone" : ""}`);
        const icon = element("span", "capture-receipt-mark");
        paintIcon(icon, RECEIPT_ICON[receipt.icon] ?? "check");
        row.append(icon, element("span", "capture-receipt-label", receipt.label));
        if (undone) row.append(element("span", "capture-receipt-state", "Cofnięte"));
        else if (receipt.undo && live.done && live.id != null) {
          const id = live.id;
          const undo = element("button", "capture-undo", "Cofnij") as HTMLButtonElement;
          undo.type = "button";
          undo.onclick = () => {
            undo.disabled = true;
            void this.chat.undo(id, index).then(() => {
              this.undone.add(index);
              this.paint();
            });
          };
          row.append(undo);
        }
        list.append(row);
      });
      this.answer.append(list);
    }
    this.surface.measure();
    if (live.done) {
      /* ⚠️ The caret is handed back the moment the reply is in — he typed one
       * line and went back to what he was doing — and the fold waits. A
       * pointer on the bar holds it open (the island's own hover), and Cofnij
       * starts the wait again rather than folding under the press. */
      /* ⚠️ `pinFor` AFTER the caret is released, never before: releasing it
       * arms the island's ordinary fold timer (450 ms), which would take the
       * answer away long before anybody could read it. `pinFor` replaces that
       * timer with its own. */
      void this.surface.input(false).catch(() => {}).then(() => {
        if (this.open) this.surface.pinFor(LINGER_MS + 1000);
      });
      window.clearTimeout(this.linger);
      this.linger = window.setTimeout(() => { void this.hide(); }, LINGER_MS);
    }
  }
}
