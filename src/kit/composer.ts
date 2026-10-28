/* The composer: one field for every place on the island that takes words for
 * Helm — the Guardian, Add to today, quick capture.
 *
 * What it is, from Helm's own (chat-panel.tsx), in this app's dark language:
 * - a textarea that GROWS, one line to about six, then scrolls — a long line
 *   wraps instead of running off the end of a one-line input;
 * - a recessed well whose focus is a soft glow, never a bare outline;
 * - pasted (or picked) pictures as small thumbnails inside the well;
 * - hold to talk, a round Send that is lit only when there is something to
 *   send; Enter sends, Shift+Enter breaks the line, Escape clears, then closes;
 * - `@` for a project (a chip in the text, sent as `mentions`) and `/` for
 *   what the line is (request · note · log · todo, sent as `command`);
 * - the draft kept per composer, across closing the island and a reload.
 *
 * ⚠️ The chips "in the text" are painted BEHIND it. A mention is the words
 * `@Esono Rozwój` in an ordinary textarea, and a mirror under the field draws
 * the pill exactly where those words are laid out — so the caret, selection,
 * undo, IME and paste are all the browser's own. A contenteditable with real
 * chip elements in it would have to reimplement every one of those, and the
 * notes screen already shows how many traps that is (AGENTS 609–613).
 *
 * ⚠️ The mirror must lay text out EXACTLY as the field does: same font, size,
 * line-height, padding, width, wrapping. Change one in the stylesheet and
 * change it on `.k-mirror` too, or the pills drift off their words.
 */
import { element } from "../dom";
import { paintIcon, type TaskIcon } from "../task-icons";
import type { Face } from "../helm-parts";
import { hueOf } from "../helm-link";
import { Menu, type MenuItem } from "./menu";
import { Recorder, base64Of, voiceProblem } from "./voice";
import { load, save } from "./store";
import { dropTip } from "../tips";
import {
  clockOf, liveMentions, matchCommands, matchProjects, outgoing, runs, trigger,
  type Command, type Mention, type MentionProject,
} from "./words";

export interface Picture { mediaType: "image/jpeg"; data: string; url: string }

/** What Send hands over. */
export interface Sent {
  text: string;
  command: Command | null;
  mentions: { projectId: number }[];
  pictures: Picture[];
  /** The words as typed, command and all, for a retry or a draft. */
  raw: string;
}

/** Helm's speech, as the host provides it. */
export interface Voice {
  /** Hold to talk is offered at all: Helm has `/api/transcribe`. */
  available(): boolean;
  /** The words in a recording. Throws with a sentence when Helm could not. */
  transcribe(audio: string, mime: string): Promise<string>;
}

export interface ComposerOptions {
  /** The draft's key: one draft per composer. */
  id: string;
  label: string;
  placeholder: string;
  maxLength?: number;
  /** Lines it grows to before it scrolls. */
  lines?: number;
  /** Lift the island's NOACTIVATE for typing (`surface.input`). */
  lift: (on: boolean) => Promise<void>;
  editing: () => boolean;
  /** Returns false to refuse (a reply still streaming) — the words stay. */
  send: (sent: Sent) => boolean;
  /** Whether Send may light up at all right now. */
  ready?: () => boolean;
  pictures?: boolean;
  voice?: Voice | null;
  /** The `@` picker's projects; absent, `@` is just a character. */
  projects?: (() => MentionProject[]) | null;
  /** A project's face, with its logo once fetched. */
  face?: (project: MentionProject) => Face | null;
  /** A project was picked from `@` (the Guardian takes it as the focus). */
  picked?: (project: MentionProject) => void;
  commands?: boolean;
  /** Open the pickers under the field, in flow — the capture bar, which IS the
   *  panel and has no room above it. */
  below?: boolean;
  /** The well changed height: the island has to measure again. */
  resized?: () => void;
  /** Escape on an empty composer. */
  closed?: () => void;
  say?: (what: string, why: string) => void;
  /** A mark at the left end, inside the well (quick capture's shield). */
  lead?: TaskIcon;
  className?: string;
}

const LINE = 20;
const PAD = 8;
/** How far a held pointer may wander off the mic before it counts as sliding off. */
const SLOP = 24;

/** A pasted picture, shrunk to at most 1280 px and sent as JPEG — as Helm's panel does. */
async function shrink(file: File): Promise<Picture> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1280 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const url = canvas.toDataURL("image/jpeg", 0.82);
  return { mediaType: "image/jpeg", data: url.slice(url.indexOf(",") + 1), url };
}

function iconButton(icon: TaskIcon, label: string, className: string): HTMLButtonElement {
  const button = element("button", className) as HTMLButtonElement;
  button.type = "button";
  paintIcon(button, icon);
  button.setAttribute("aria-label", label);
  button.dataset.tip = label;
  return button;
}

export class Composer {
  readonly el: HTMLFormElement;
  readonly field: HTMLTextAreaElement;
  private o: ComposerOptions;
  private well: HTMLElement;
  private mirror: HTMLElement;
  private shots: HTMLElement;
  private sendButton: HTMLButtonElement;
  private mic: HTMLButtonElement | null = null;
  private attach: HTMLButtonElement | null = null;
  private rec: HTMLElement;
  private recTime: HTMLElement;
  private bars: HTMLElement[] = [];
  private menu: Menu;
  private mentions: Mention[] = [];
  private pictures: Picture[] = [];
  private recorder = new Recorder();
  /** How the hold began: the pointer on the mic, or Ctrl+Space in the field. */
  private held: { by: "pointer"; box: DOMRect } | { by: "key" } | null = null;
  private transcribing = false;
  /** Bumped by a cancel, so words arriving for a cancelled hold are dropped. */
  private holdGen = 0;
  private tick = 0;
  private height = 0;
  private draftTimer = 0;
  private disabled = false;
  /** Escape while a hold is on, wherever the caret is — the mic takes no
   *  focus, so the field's own keydown may never see it. */
  private escKey = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    this.cancelHold();
  };
  /** The key held to talk, let go wherever the caret went meanwhile; and the
   *  window losing focus mid-hold, which no key-up will ever follow. */
  private upKey = (event: KeyboardEvent) => {
    if (this.held?.by === "key" && (event.code === "Space" || event.key === "Control" || event.key === " " || event.key === "Enter")) void this.finishHold();
  };
  private lostFocus = () => { if (this.held) void this.finishHold(); };

  constructor(options: ComposerOptions) {
    this.o = options;
    this.el = element("form", `k-composer ${options.className ?? ""}`.trim()) as HTMLFormElement;
    this.el.noValidate = true;
    this.well = element("div", "k-well");
    this.shots = element("div", "k-shots");
    this.shots.hidden = true;
    const line = element("div", "k-line");
    if (options.lead) {
      const lead = element("span", "k-lead");
      paintIcon(lead, options.lead);
      line.append(lead);
    }
    if (options.pictures) {
      this.attach = iconButton("attach", "Add a picture", "k-icon k-attach");
      const picker = element("input") as HTMLInputElement;
      picker.type = "file";
      picker.accept = "image/*";
      picker.multiple = true;
      picker.hidden = true;
      this.attach.onclick = () => picker.click();
      picker.onchange = () => { void this.add([...(picker.files ?? [])]).then(() => { picker.value = ""; }); };
      line.append(this.attach, picker);
    }
    const text = element("div", "k-text");
    this.mirror = element("div", "k-mirror");
    this.mirror.setAttribute("aria-hidden", "true");
    this.field = element("textarea", "k-input") as HTMLTextAreaElement;
    this.field.rows = 1;
    this.field.placeholder = options.placeholder;
    this.field.setAttribute("aria-label", options.label);
    this.field.maxLength = options.maxLength ?? 4000;
    this.field.spellcheck = false;
    this.field.autocomplete = "off";
    this.rec = element("div", "k-rec");
    this.rec.hidden = true;
    this.rec.setAttribute("aria-live", "polite");
    const dot = element("span", "k-rec-dot");
    this.recTime = element("span", "k-rec-time", "0:00");
    const wave = element("span", "k-rec-wave");
    for (let i = 0; i < 64; i++) {
      const bar = element("i");
      wave.append(bar);
      this.bars.push(bar);
    }
    const stop = iconButton("close", "Cancel · Esc", "k-icon k-rec-cancel");
    stop.onclick = () => this.cancelHold();
    this.rec.append(dot, this.recTime, wave, stop);
    text.append(this.mirror, this.field, this.rec);
    line.append(text);
    if (options.voice) {
      this.mic = iconButton("mic", "Hold to talk · Ctrl Space", "k-icon k-mic");
      this.wireMic(this.mic);
      line.append(this.mic);
    }
    this.sendButton = iconButton("send", "Send · Enter", "k-send");
    this.sendButton.onclick = () => this.submit();
    line.append(this.sendButton);
    this.well.append(this.shots, line);
    this.menu = new Menu({ label: "Suggestions", className: "k-pop", pick: item => this.pickFromMenu(item) });
    if (options.below) this.el.append(this.well, this.menu.el);
    else this.el.append(this.menu.el, this.well);
    this.el.classList.toggle("is-below", !!options.below);
    this.wire();
    this.restore();
    this.paint();
    /* ⚠️ The height is only right at the width it was measured at. A composer
     * drawn while its screen was hidden, or before the island had its width,
     * measured the words wrapping in a sliver and kept a three-line field for
     * one line of text. Re-measured whenever the field's width changes. */
    let width = 0;
    new ResizeObserver(entries => {
      const now = Math.round(entries[0]?.contentRect.width ?? 0);
      if (now && now !== width) { width = now; this.autosize(); }
    }).observe(this.field);
  }

  /* ── State ───────────────────────────────────────────────────────────── */

  get value(): string { return this.field.value; }

  /** Put words in (a palette line, a retry). Replaces the draft. */
  set(text: string, mentions: Mention[] = []) {
    this.field.value = text;
    this.mentions = mentions;
    this.paint();
    this.keepDraft();
  }

  get empty(): boolean { return !this.field.value.trim() && !this.pictures.length; }

  get recording(): boolean { return this.recorder.state !== "idle" || this.transcribing; }

  setDisabled(on: boolean) {
    this.disabled = on;
    this.field.disabled = on;
    this.el.classList.toggle("is-disabled", on);
    this.paint();
  }

  /** Repaint what depends on the host: Send's readiness, whether there is a mic. */
  refresh() { this.paint(); }

  /** The caret into the field, lifting NOACTIVATE first (AGENTS 302). */
  async focus() {
    if (!this.o.editing()) await this.o.lift(true).catch(() => {});
    for (let tries = 0; tries < 15; tries++) {
      this.field.focus({ preventScroll: true });
      if (document.activeElement === this.field) break;
      await new Promise(frame => requestAnimationFrame(frame));
    }
    const end = this.field.value.length;
    this.field.setSelectionRange(end, end);
  }

  /** Escape, in order: the open picker, a recording, the words, then nothing
   *  (and the host closes or lets the caret go). Returns whether it was used. */
  escape(): boolean {
    if (this.menu.open) { this.closeMenu(); return true; }
    if (this.recording) { this.cancelHold(); return true; }
    if (this.field.value || this.pictures.length) {
      /* ⚠️ Through the editing commands, so Ctrl+Z brings it back. Escape
       * pressed by reflex must not cost a paragraph. */
      this.field.focus({ preventScroll: true });
      this.field.select();
      if (!document.execCommand("delete")) this.field.value = "";
      this.pictures = [];
      this.paintShots();
      this.paint();
      this.keepDraft();
      return true;
    }
    return false;
  }

  /* ── Wiring ──────────────────────────────────────────────────────────── */

  private wire() {
    this.el.onsubmit = event => { event.preventDefault(); this.submit(); };
    /* A press anywhere on the well puts the caret in — lifting NOACTIVATE
     * first, or the keys go to the window behind (AGENTS 302). Buttons keep
     * their own press and never take the caret out of the field. */
    this.well.addEventListener("pointerdown", event => {
      const target = event.target as HTMLElement;
      if (target.closest("button")) { event.preventDefault(); return; }
      if (this.o.editing() || this.disabled) return;
      event.preventDefault();
      void this.focus();
    });
    this.field.addEventListener("input", () => {
      this.mentions = liveMentions(this.field.value, this.mentions);
      this.paint();
      this.suggest();
      this.keepDraft();
    });
    this.field.addEventListener("keydown", event => this.key(event));
    this.field.addEventListener("click", () => this.suggest());
    this.field.addEventListener("scroll", () => { this.mirror.scrollTop = this.field.scrollTop; });
    this.field.addEventListener("blur", () => {
      // A picker outliving the caret is a picker nobody can drive.
      window.setTimeout(() => { if (document.activeElement !== this.field) this.closeMenu(); }, 120);
    });
    this.field.addEventListener("paste", event => {
      if (!this.o.pictures) return;
      const files = [...(event.clipboardData?.files ?? [])].filter(f => f.type.startsWith("image/"));
      if (!files.length) return;
      event.preventDefault();
      void this.add(files);
    });
  }

  private key(event: KeyboardEvent) {
    if (this.menu.open && this.menu.key(event)) {
      event.stopPropagation();
      return;
    }
    if (event.key === "Escape") {
      if (this.escape()) { event.preventDefault(); event.stopPropagation(); }
      return;
    }
    // Ctrl+Space held talks, as on Helm's own composer.
    if (event.code === "Space" && event.ctrlKey && !event.altKey && !event.metaKey && this.voiceOn()) {
      event.preventDefault();
      if (!event.repeat && !this.held) { this.held = { by: "key" }; void this.startHold(); }
      return;
    }
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      if (!this.recording) this.submit();
      return;
    }
    /* ⚠️ A mention goes as one: Backspace at its end takes the whole
     * `@Name`, not its last letter — half a project name is not a mention of
     * anything, and it would sit in the text looking like one. */
    if (event.key === "Backspace" && this.field.selectionStart === this.field.selectionEnd) {
      const caret = this.field.selectionStart;
      const before = this.field.value.slice(0, caret);
      const mention = this.mentions.find(one => before.endsWith(`@${one.name}`));
      if (mention) {
        event.preventDefault();
        const from = caret - mention.name.length - 1;
        this.field.setSelectionRange(from, caret);
        if (!document.execCommand("delete")) this.field.setRangeText("", from, caret, "end");
        this.mentions = liveMentions(this.field.value, this.mentions);
        this.paint();
        this.keepDraft();
      }
    }
  }

  /* ── The pickers ─────────────────────────────────────────────────────── */

  private suggest() {
    const caret = this.field.selectionStart;
    const found = this.field.selectionStart === this.field.selectionEnd ? trigger(this.field.value, caret) : null;
    /* ⚠️ A mention just completed is not a query: `@Esono Rozwój ` would
     * otherwise reopen the picker on its own name, and the Enter meant to
     * send would pick it a second time. */
    if (found?.kind === "@" && this.mentions.some(one => found.query.trimEnd() === one.name)) return this.closeMenu();
    if (found?.kind === "@" && this.o.projects) {
      const hits = matchProjects(this.o.projects(), found.query, 6);
      if (!hits.length) return this.closeMenu();
      this.openMenu(hits.map(({ project, hits: lit }) => ({
        id: `p:${project.id}`,
        label: project.name,
        detail: project.client && project.client !== project.name ? project.client : undefined,
        face: this.o.face?.(project) ?? { name: project.name, hue: project.hue },
        hits: lit,
      })));
      return;
    }
    if (found?.kind === "/" && this.o.commands) {
      const hits = matchCommands(found.query);
      if (!hits.length) return this.closeMenu();
      this.openMenu(hits.map(one => ({ id: `c:${one.command}`, label: one.label, detail: `/${one.command}`, icon: one.icon })));
      return;
    }
    this.closeMenu();
  }

  private closeMenu() {
    if (!this.menu.open) return;
    this.menu.hide();
    // ⚠️ Under the field it is in flow, so the island has to measure again.
    if (this.o.below) this.o.resized?.();
  }

  private openMenu(items: MenuItem[]) {
    const was = this.menu.open;
    this.menu.show(items, true);
    if (this.o.below && !was) this.o.resized?.();
  }


  private pickFromMenu(item: MenuItem) {
    const caret = this.field.selectionStart;
    const found = trigger(this.field.value, caret);
    if (!found) return;
    if (item.id.startsWith("p:")) {
      const project = this.o.projects?.().find(one => `p:${one.id}` === item.id);
      if (!project) return;
      /* ⚠️ Recorded BEFORE the words go in: inserting them fires `input`
       * synchronously, and an input that does not know the mention yet takes
       * `@Esono Rozwój ` for a query and opens the picker on its own name. */
      this.mentions = [...this.mentions.filter(one => one.projectId !== project.id), { projectId: project.id, name: project.name }];
      this.replace(found.start, caret, `@${project.name} `);
      this.o.picked?.(project);
    } else {
      this.replace(found.start, caret, `/${item.id.slice(2)} `);
    }
    this.paint();
    this.keepDraft();
    // The picker under the capture bar has gone: the island measures again.
    if (this.o.below) this.o.resized?.();
  }

  /** Replace a span of the field, through the editing commands so undo works. */
  private replace(from: number, to: number, text: string) {
    this.field.focus({ preventScroll: true });
    this.field.setSelectionRange(from, to);
    if (!document.execCommand("insertText", false, text)) this.field.setRangeText(text, from, to, "end");
  }

  /* ── Pictures ────────────────────────────────────────────────────────── */

  private async add(files: File[]) {
    const images = files.filter(f => f.type.startsWith("image/")).slice(0, 3 - this.pictures.length);
    if (!images.length) return;
    try {
      const shrunk = await Promise.all(images.map(shrink));
      this.pictures = [...this.pictures, ...shrunk].slice(0, 3);
      this.paintShots();
      this.paint();
    } catch {
      this.o.say?.("Picture", "Couldn't read that picture");
    }
  }

  private paintShots() {
    this.shots.hidden = !this.pictures.length;
    this.shots.replaceChildren(...this.pictures.map((picture, index) => {
      const shot = element("span", "k-shot");
      const img = element("img") as HTMLImageElement;
      img.src = picture.url;
      img.alt = "";
      const drop = iconButton("close", "Remove the picture", "k-shot-x");
      drop.onclick = () => { this.pictures = this.pictures.filter((_, j) => j !== index); this.paintShots(); this.paint(); };
      shot.append(img, drop);
      return shot;
    }));
  }

  /* ── Sending ─────────────────────────────────────────────────────────── */

  submit() {
    if (this.disabled || this.recording || !this.canSend()) return;
    const raw = this.field.value;
    const out = outgoing(raw, this.mentions);
    if (!out.text && !this.pictures.length) return;
    const ok = this.o.send({ ...out, pictures: this.pictures, raw });
    if (ok === false) return;
    this.field.value = "";
    this.mentions = [];
    this.pictures = [];
    this.paintShots();
    this.closeMenu();
    this.paint();
    save(`draft:${this.o.id}`, null);
  }

  private canSend(): boolean {
    if (this.o.ready && !this.o.ready()) return false;
    return !!outgoing(this.field.value, this.mentions).text || this.pictures.length > 0;
  }

  /* ── Hold to talk ────────────────────────────────────────────────────── */

  private voiceOn(): boolean { return !!this.o.voice && this.o.voice.available() && !this.disabled; }

  private wireMic(mic: HTMLButtonElement) {
    mic.addEventListener("pointerdown", event => {
      if (event.button !== 0 || !this.voiceOn()) return;
      event.preventDefault();
      /* ⚠️ Captured on the press, which is safe here and nowhere near the
       * rail's trap (AGENTS 356): the mic has no click to swallow — the hold
       * IS the gesture, and letting go anywhere has to be heard. */
      mic.setPointerCapture(event.pointerId);
      // The label goes before the hold starts: it would sit on the recording.
      mic.dataset.tip = "";
      dropTip();
      this.held = { by: "pointer", box: mic.getBoundingClientRect() };
      void this.startHold();
    });
    mic.addEventListener("pointermove", event => {
      const held = this.held;
      if (held?.by !== "pointer") return;
      const b = held.box;
      if (event.clientX < b.left - SLOP || event.clientX > b.right + SLOP || event.clientY < b.top - SLOP || event.clientY > b.bottom + SLOP) this.cancelHold();
    });
    mic.addEventListener("pointerup", () => { if (this.held?.by === "pointer") void this.finishHold(); });
    mic.addEventListener("pointercancel", () => { if (this.held?.by === "pointer") this.cancelHold(); });
    mic.addEventListener("contextmenu", event => event.preventDefault());
    // Space or Enter held on the focused button, for the keyboard.
    mic.addEventListener("keydown", event => {
      if (event.key !== " " && event.key !== "Enter") return;
      event.preventDefault();
      if (!event.repeat && !this.held) { this.held = { by: "key" }; void this.startHold(); }
    });
    mic.addEventListener("keyup", event => { if ((event.key === " " || event.key === "Enter") && this.held) void this.finishHold(); });
  }

  private async startHold() {
    this.recorder.onLevel = level => this.paintLevel(level);
    this.recorder.onLimit = () => { void this.finishHold(); };
    this.el.classList.add("is-recording");
    this.rec.hidden = false;
    document.addEventListener("keydown", this.escKey, true);
    document.addEventListener("keyup", this.upKey, true);
    window.addEventListener("blur", this.lostFocus);
    this.paint();
    try {
      await this.recorder.start();
    } catch (error) {
      this.held = null;
      this.el.classList.remove("is-recording");
      this.rec.hidden = true;
      this.paint();
      this.unlisten();
      this.o.say?.("Microphone", voiceProblem(error));
      return;
    }
    // Let go (or cancelled) while the microphone was still opening: a tap.
    if (this.recorder.state !== "recording") return;
    window.clearInterval(this.tick);
    this.tick = window.setInterval(() => { this.recTime.textContent = clockOf(this.recorder.seconds); }, 250);
    this.recTime.textContent = "0:00";
    this.paint();
  }

  private async finishHold() {
    if (!this.held) return;
    this.held = null;
    window.clearInterval(this.tick);
    const recording = await this.recorder.finish();
    if (!recording) {
      this.stopRecUi();
      return;
    }
    this.transcribing = true;
    const gen = this.holdGen;
    this.el.classList.remove("is-recording");
    this.el.classList.add("is-transcribing");
    this.paint();
    try {
      const words = (await this.o.voice!.transcribe(await base64Of(recording.blob), recording.mime)).trim();
      if (words && gen === this.holdGen) this.insert(words);
    } catch (error) {
      this.o.say?.("Speech", String((error as Error)?.message ?? error).replace(/^(invoke error|error): /i, "").slice(0, 120));
    } finally {
      this.transcribing = false;
      this.stopRecUi();
    }
  }

  private cancelHold() {
    this.holdGen++;
    this.transcribing = false;
    this.held = null;
    window.clearInterval(this.tick);
    this.recorder.cancel();
    this.stopRecUi();
  }

  private unlisten() {
    document.removeEventListener("keydown", this.escKey, true);
    document.removeEventListener("keyup", this.upKey, true);
    window.removeEventListener("blur", this.lostFocus);
  }

  private stopRecUi() {
    this.unlisten();
    this.el.classList.remove("is-recording", "is-transcribing");
    this.rec.hidden = true;
    for (const bar of this.bars) bar.style.removeProperty("--h");
    this.paint();
  }

  /** The level as a moving wave: the newest on the right. */
  private paintLevel(level: number) {
    const bars = this.bars;
    for (let i = 0; i < bars.length - 1; i++) bars[i].style.setProperty("--h", bars[i + 1].style.getPropertyValue("--h") || "0.08");
    bars[bars.length - 1].style.setProperty("--h", String(Math.max(0.08, Math.min(1, level))));
  }

  /** What was heard, at the caret — for reading before sending. Never sent. */
  private insert(words: string) {
    const value = this.field.value;
    const at = document.activeElement === this.field ? this.field.selectionStart : value.length;
    const before = value.slice(0, at);
    const glue = before && !/\s$/.test(before) ? " " : "";
    void this.focus().then(() => {
      this.field.setSelectionRange(at, at);
      const text = glue + words;
      if (!document.execCommand("insertText", false, text)) this.field.setRangeText(text, at, at, "end");
      this.paint();
      this.keepDraft();
    });
  }

  /* ── Painting ────────────────────────────────────────────────────────── */

  private paint() {
    const text = this.field.value;
    // The mirror: the same words, with the pills under the mentions and the command.
    const parts = runs(text, this.mentions);
    this.mirror.replaceChildren(...parts.map(run => {
      if (run.kind === "plain") return document.createTextNode(run.text);
      const pill = element("span", run.kind === "mention" ? "k-mention" : "k-command", run.text);
      if (run.kind === "mention") {
        const project = this.o.projects?.().find(one => one.id === run.projectId);
        pill.style.setProperty("--hue", hueOf(project?.hue ?? null, project?.name ?? run.text));
      }
      return pill;
    }), document.createTextNode("​"));
    this.autosize();
    const ready = this.canSend() && !this.recording && !this.disabled;
    this.sendButton.disabled = !ready;
    this.sendButton.classList.toggle("is-ready", ready);
    if (this.mic) {
      const on = this.voiceOn();
      this.mic.hidden = !on && !this.recording;
      this.mic.classList.toggle("is-live", this.recorder.state !== "idle");
      this.mic.setAttribute("aria-pressed", String(this.recorder.state !== "idle"));
      // No tooltip over a held button: it would sit on the recording.
      this.mic.dataset.tip = this.recording ? "" : "Hold to talk · Ctrl Space";
    }
    if (this.attach) this.attach.hidden = this.recording;
    this.el.classList.toggle("has-text", !!text);
  }

  /** One line to `lines`, then it scrolls. */
  private autosize() {
    // The field's own metrics: the capture bar sets a bigger line than the rest.
    const style = getComputedStyle(this.field);
    const line = parseFloat(style.lineHeight) || LINE;
    const pad = (parseFloat(style.paddingTop) || PAD) + (parseFloat(style.paddingBottom) || PAD);
    const max = (this.o.lines ?? 6) * line + pad;
    this.field.style.height = "auto";
    const want = Math.max(line + pad, Math.min(this.field.scrollHeight, max));
    this.field.style.height = `${want}px`;
    this.field.style.overflowY = this.field.scrollHeight > max + 1 ? "auto" : "hidden";
    this.mirror.style.height = `${want}px`;
    this.mirror.scrollTop = this.field.scrollTop;
    const total = this.well.offsetHeight;
    if (total !== this.height) {
      this.height = total;
      this.o.resized?.();
    }
  }

  /* ── The draft ───────────────────────────────────────────────────────── */

  private keepDraft() {
    window.clearTimeout(this.draftTimer);
    this.draftTimer = window.setTimeout(() => {
      const text = this.field.value;
      save(`draft:${this.o.id}`, text ? { text, mentions: liveMentions(text, this.mentions) } : null);
    }, 200);
  }

  private restore() {
    const draft = load<{ text: string; mentions: Mention[] } | null>(`draft:${this.o.id}`, null);
    if (!draft?.text) return;
    this.field.value = draft.text.slice(0, this.field.maxLength);
    this.mentions = liveMentions(this.field.value, Array.isArray(draft.mentions) ? draft.mentions : []);
  }
}
