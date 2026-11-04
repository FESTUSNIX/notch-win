/* Gabi's screen: the conversation, and what else is theirs today.
 *
 * The notch already shows what she sends as it arrives (gabi-feed.ts). This is where
 * he goes to answer properly, read back, and see the day's photos, without Helm in a
 * browser. Opening it reads what's there, which tells her it was seen.
 *
 * ⚠️ A photo lives in this page's memory only, as in gabi-feed.ts: it's never written
 * down, and goes when Helm's reading says it has gone (24 hours).
 *
 * ⚠️ The skeleton is built once and only the thread is redrawn, when it changed: the
 * shell redraws on any tick, and a redraw must not take the caret or the scroll.
 */
import { element } from "./dom";
import { paintIcon } from "./task-icons";
import { call } from "./task-client";
import { zloty } from "./helm-link";
import { Composer } from "./kit/composer";
import { GABI_REPLIES } from "./gabi-logic";
import {
  SURPRISES, lockUntil, photoLeft, readDesk, threadRows, unseenIds, waitingOn,
  type DeskNote, type DeskPhoto, type GabiDeskData, type GabiFun,
} from "./gabi-desk";

export interface GabiScreenDeps {
  lift: (on: boolean) => Promise<void>;
  editing: () => boolean;
  measure: () => void;
  say: (what: string, why: string) => void;
  /** Whether he's looking at this screen right now. */
  showing: () => boolean;
  changed: () => void;
}

/** How often the thread is read while it's on screen. The feed's own beat wakes it
 *  sooner for anything of hers. */
const READ_EVERY_MS = 15_000;

export class GabiScreen {
  private desk: GabiDeskData | null = null;
  /** Sent, not yet in a reading. */
  private sending: DeskNote[] = [];
  private sendingKey = -1;
  private pictures = new Map<number, string | null>();
  private asking = new Set<number>();
  private viewing: DeskPhoto | null = null;
  private drawnThread = "";
  private drawnSide = "";
  private toldSeen = new Set<number>();

  private built = false;
  private thread = element("div", "gabi-thread scrolls");
  private quick = element("div", "gabi-quick");
  private side = element("aside", "gabi-side");
  private viewer = element("div", "gabi-viewer");
  private composer: Composer;

  constructor(private host: HTMLElement, private deps: GabiScreenDeps) {
    this.composer = new Composer({
      id: "gabi",
      label: "Wiadomość do Gabi",
      placeholder: "Napisz do Gabi…",
      lines: 4,
      maxLength: 1000,
      lift: deps.lift,
      editing: deps.editing,
      send: sent => { this.send({ text: sent.text }); return true; },
      resized: deps.measure,
      closed: () => { this.composer.field.blur(); void deps.lift(false).catch(() => {}); },
      say: deps.say,
      className: "gabi-composer",
    });
  }

  /** Whether she exists to talk to: the rail only offers the screen once she does. */
  get available(): boolean {
    return !!this.desk;
  }

  async boot() {
    await this.read();
    window.setInterval(() => {
      if (this.deps.showing()) void this.read();
    }, READ_EVERY_MS);
  }

  /** Something of hers arrived. */
  poke() {
    void this.read();
  }

  /** On coming to the screen: fresh, at the bottom, and seen. */
  cameBack() {
    this.drawnThread = "";
    void this.read();
  }

  /** Escape: the picture first, then the island as usual. */
  escape(): boolean {
    if (!this.viewing) return false;
    this.viewing = null;
    this.paintViewer();
    return true;
  }

  private async read() {
    let raw: unknown;
    try {
      raw = await call<unknown>("gabi_thread");
    } catch {
      return; // Unreachable for now: the last reading stands.
    }
    const before = !!this.desk;
    this.desk = readDesk(raw);
    if (this.desk) {
      const alive = new Set(this.desk.notes.flatMap(note => note.photoId ? [note.photoId] : []));
      for (const photo of this.desk.photos) alive.add(photo.id);
      for (const id of this.pictures.keys()) if (!alive.has(id)) this.pictures.delete(id);
      this.sending = this.sending.filter(one => !this.desk!.notes.some(note => note.direction === "to_her" && note.text === one.text && note.fun === one.fun));
    }
    this.tellSeen();
    if (before !== !!this.desk) this.deps.changed();
    this.render();
  }

  /** What's on screen has been seen, and she can know. */
  private tellSeen() {
    if (!this.desk || !this.deps.showing()) return;
    const ids = unseenIds(this.desk.notes).filter(id => !this.toldSeen.has(id));
    if (!ids.length) return;
    for (const id of ids) this.toldSeen.add(id);
    const photos = this.desk.notes.filter(note => ids.includes(note.id) && note.photoId).map(note => note.photoId!);
    void call("gabi_send", { body: { seen: ids, photos } }).catch(() => {
      for (const id of ids) this.toldSeen.delete(id);
    });
  }

  private send(what: { text?: string; fun?: GabiFun; replyTo?: number }) {
    const text = what.text?.trim() || null;
    const fun = what.fun ?? null;
    if (!text && !fun) return;
    const replyTo = what.replyTo ?? (this.desk ? waitingOn(this.desk.notes)?.id : undefined) ?? null;
    const pending: DeskNote = {
      id: this.sendingKey--, direction: "to_her", text, fun, replyTo, photoId: null,
      at: new Date().toISOString(), seen: false, read: null,
    };
    this.sending.push(pending);
    this.render();
    void call("gabi_send", { body: { text, fun, replyTo } }).then(() => this.read()).catch(() => {
      this.sending = this.sending.filter(one => one !== pending);
      this.render();
      if (text) {
        this.composer.field.value = text;
        this.composer.field.dispatchEvent(new Event("input"));
      }
      this.deps.say("Gabi", "Nie doszło, spróbuj jeszcze raz");
    });
  }

  private build() {
    this.built = true;
    this.host.classList.add("gabi-body");
    const main = element("div", "gabi-main");
    main.append(this.thread, this.quick, this.composer.el);
    this.viewer.hidden = true;
    this.host.append(main, this.side, this.viewer);
  }

  render() {
    if (!this.built) this.build();
    if (!this.desk) return;
    this.paintThread();
    this.paintSide();
  }

  private paintThread() {
    const notes = [...this.desk!.notes, ...this.sending];
    // The clock in it, so "Dziś" turns over at midnight.
    const key = JSON.stringify([notes.map(one => [one.id, one.text, one.seen]), new Date().getDate()]);
    if (key === this.drawnThread) return;
    const first = !this.drawnThread;
    const atEnd = this.thread.scrollHeight - this.thread.scrollTop - this.thread.clientHeight < 40;
    this.drawnThread = key;
    this.thread.replaceChildren();
    if (!notes.length) {
      this.thread.append(element("p", "gabi-none", "Jeszcze nic. Napisz pierwszy."));
    }
    for (const row of threadRows(notes, new Date())) {
      if (row.kind === "day") {
        this.thread.append(element("h4", "gabi-day", row.title));
      } else if (row.kind === "event") {
        const line = element("div", `gabi-event is-${row.tone}`);
        const mark = element("span", "gabi-event-mark");
        paintIcon(mark, row.icon === "lock" ? "pin" : row.icon === "money" ? "target" : "heart");
        line.append(mark, element("b", "", row.title));
        if (row.line) line.append(element("span", "", row.line));
        line.append(element("time", "", row.clock));
        this.thread.append(line);
      } else {
        const bubble = element("div", `gabi-note ${row.mine ? "is-mine" : "is-hers"} is-${row.style}`
          + (row.firstOfRun ? " is-first" : "") + (row.note.id < 0 ? " is-sending" : ""));
        if (row.style === "photo" && row.note.photoId) bubble.append(this.notePhoto(row.note.photoId, row.note));
        if (row.text) bubble.append(element("p", "gabi-note-text", row.text));
        bubble.append(element("time", "gabi-note-time", row.clock));
        this.thread.append(bubble);
      }
    }
    if (first || atEnd) this.thread.scrollTop = this.thread.scrollHeight;

    this.quick.replaceChildren();
    const waiting = waitingOn(this.desk!.notes);
    this.quick.hidden = !waiting || this.sending.length > 0;
    if (waiting) {
      for (const reply of GABI_REPLIES) {
        const chip = element("button", "gabi-reply", reply) as HTMLButtonElement;
        chip.type = "button";
        chip.onclick = () => this.send({ text: reply, replyTo: waiting.id });
        this.quick.append(chip);
      }
    }
    this.deps.measure();
  }

  /** One picture, fetched when it's first drawn. */
  private picture(id: number, into: HTMLImageElement) {
    const have = this.pictures.get(id);
    if (have) { into.src = have; return; }
    if (this.asking.has(id) || have === null) return;
    this.asking.add(id);
    void call<string | null>("gabi_photo", { id }).catch(() => null).then(art => {
      this.asking.delete(id);
      this.pictures.set(id, art ?? null);
      this.host.querySelectorAll<HTMLImageElement>(`img[data-photo="${id}"]`).forEach(one => { if (art) one.src = art; });
    });
  }

  private notePhoto(id: number, note: DeskNote): HTMLElement {
    const open = element("button", "gabi-note-photo") as HTMLButtonElement;
    open.type = "button";
    open.setAttribute("aria-label", "Pokaż zdjęcie");
    const img = element("img") as HTMLImageElement;
    img.alt = "";
    img.dataset.photo = String(id);
    this.picture(id, img);
    open.append(img);
    open.onclick = () => {
      const photo = this.desk?.photos.find(one => one.id === id)
        ?? { id, caption: note.read?.line ?? null, at: note.at, expiresAt: note.at, seen: true };
      this.viewing = photo;
      this.paintViewer();
    };
    return open;
  }

  private paintSide() {
    const desk = this.desk!;
    const key = JSON.stringify([desk.photos.map(one => [one.id, photoLeft(one.expiresAt, Date.now())]), desk.fund, desk.lock, desk.name]);
    if (key === this.drawnSide) return;
    this.drawnSide = key;
    this.side.replaceChildren();

    const fund = element("div", "gabi-fact");
    fund.append(element("span", "gabi-fact-label", "Fundusz"), element("b", "gabi-fund", zloty(desk.fund)));
    this.side.append(fund);

    if (desk.lock) {
      const lock = element("div", "gabi-fact is-lock");
      lock.append(element("span", "gabi-fact-label", `Blokada od ${desk.name}`), element("b", "", `do ${lockUntil(desk.lock.endsAt, new Date())}`));
      this.side.append(lock);
    }

    if (desk.photos.length) {
      const photos = element("div", "gabi-photos");
      for (const photo of [...desk.photos].reverse()) {
        const tile = element("button", `gabi-photo${photo.seen ? "" : " is-new"}`) as HTMLButtonElement;
        tile.type = "button";
        tile.setAttribute("aria-label", photo.caption || "Zdjęcie");
        const img = element("img") as HTMLImageElement;
        img.alt = "";
        img.dataset.photo = String(photo.id);
        this.picture(photo.id, img);
        tile.append(img, element("span", "gabi-photo-left", photoLeft(photo.expiresAt, Date.now())));
        tile.onclick = () => {
          this.viewing = photo;
          this.paintViewer();
          if (!photo.seen) void call("gabi_send", { body: { seen: [], photos: [photo.id] } }).catch(() => {});
        };
        photos.append(tile);
      }
      this.side.append(photos);
    }

    const send = element("div", "gabi-surprises");
    for (const one of SURPRISES) {
      const button = element("button", "gabi-surprise", one.emoji) as HTMLButtonElement;
      button.type = "button";
      button.setAttribute("aria-label", one.label);
      button.dataset.tip = one.label;
      button.onclick = () => this.send({ fun: one.fun });
      send.append(button);
    }
    this.side.append(send);
  }

  private paintViewer() {
    const photo = this.viewing;
    this.viewer.hidden = !photo;
    this.viewer.replaceChildren();
    if (!photo) return;
    const img = element("img") as HTMLImageElement;
    img.alt = "";
    img.dataset.photo = String(photo.id);
    this.picture(photo.id, img);
    const close = element("button", "gabi-viewer-close small-icon") as HTMLButtonElement;
    close.type = "button";
    close.setAttribute("aria-label", "Zamknij zdjęcie");
    paintIcon(close, "close");
    close.onclick = () => this.escape();
    this.viewer.onclick = click => { if (click.target === this.viewer) this.escape(); };
    this.viewer.append(img, close);
    if (photo.caption) this.viewer.append(element("p", "gabi-viewer-caption", photo.caption));
  }
}
