/* Gabi in the notch (4 Nov), wired: her notes off Rust's ten-second read
 * (`gabi:notes`, gabi.rs) turned into the things gabi-logic.ts says they are.
 *
 * ⚠️ HELD, NOT LOST. Nothing of hers shows while a client could see it: a call,
 * a shared screen, a meeting, full screen, ambient. Nor while nobody's at the PC,
 * or a reaction would play to an empty room and tell her he saw it. `gabi_hold`
 * answers from Rust; everything waits in `GabiDesk` and plays once that clears.
 *
 * ⚠️ NOT a peek's own queue. A peek that waited 90 seconds is old news and is
 * dropped (peeks.ts), which is right for a song and wrong for her. So a fund note
 * isn't handed to the peek queue until the pill is actually free.
 */
import { listen } from "@tauri-apps/api/event";
import { call, native, preview, previewBus } from "./task-client";
import { peek, peekOn } from "./peeks";
import { still } from "./motion-pref";
import {
  GabiDesk, eventPeek, gabiIdOf, gabiKey, noteMoment, photoPeek, reactionPeek, readGabi, replyOf, sentPeek,
  type GabiFun, type GabiNote,
} from "./gabi-logic";
import type { Moment, MomentButton } from "./moments";
import type { MomentFeed } from "./moment-feed";
import type { IslandSurface } from "./island-surface";

export interface GabiDeps {
  surface: IslandSurface;
  moments: MomentFeed;
  /** The pill is taken or out of sight (peeks.ts's hold-backs). */
  peekHeld: () => boolean;
  say: (what: string, why: string) => void;
}

const TICK_MS = 500;
const HOLD_EVERY_MS = 3000;
/** A second hearts this soon after the first is one bigger rain, not two. */
const RUN_MS = 6000;
/** A photo's thumbnail in the pill, then the island opens. */
const THUMB_MS = 1500;

export class GabiFeed {
  private desk = new GabiDesk();
  private hold: string | null = null;
  private holdAt = 0;
  /** When `gabi_hold` last answered: nothing plays on an answer gone stale. */
  private holdAnswered = -Infinity;
  /** Pictures in memory only, by note. ⚠️ Never saved: see gabi.rs. */
  private photos = new Map<number, string>();
  private run: { fun: GabiFun; count: number; at: number } | null = null;
  /** The photo between its thumbnail and the island opening: not waiting, so no heart for it. */
  private opening: number | null = null;

  constructor(private deps: GabiDeps) {
    deps.moments.gabiHooks = {
      act: (moment, button) => this.act(moment, button),
      dismiss: moment => this.answer(moment, null),
    };
    deps.surface.onHeart(() => this.reopen());
  }

  async boot() {
    const read = (raw: unknown) => this.read(raw);
    if (native) await listen<unknown>("gabi:notes", event => read(event.payload));
    else previewBus.addEventListener("gabi:notes", event => read((event as CustomEvent<unknown>).detail));
    window.setInterval(() => this.tick(), TICK_MS);
    if (preview) this.stage();
  }

  /** The preview's staged notes (`&gabi=reaction,note,photo,penalty,bonus,lock`). */
  private stage() {
    const kinds = (new URLSearchParams(location.search).get("gabi") ?? "").split(",").filter(Boolean);
    if (!kinds.length) return;
    const note = (id: number, style: string, title: string, line: string, extra = {}) =>
      ({ id, style, title, line, fun: null, photoId: null, icon: "heart", tone: "gabi", at: "", ...extra });
    const staged = {
      reaction: [note(1, "reaction", "Gabi", "❤️ Serduszka", { fun: "hearts" }), note(2, "reaction", "Gabi", "❤️ Serduszka", { fun: "hearts" })],
      note: [note(11, "note", "Gabi", "Jestem z Ciebie dumna 💛")],
      photo: [note(12, "photo", "Gabi", "Obiad czeka 🍝", { photoId: 77 })],
      penalty: [note(13, "event", "−50 zł · Gabi", "74 minuty YouTube", { icon: "money", tone: "hot" })],
      bonus: [note(14, "event", "+100 zł · Gabi", "Atelier oddane", { icon: "money", tone: "gabi", fun: "confetti" })],
      lock: [note(15, "event", "Bez stron do 19:00", "Gabi", { icon: "lock", tone: "warn" })],
    } as Record<string, unknown[]>;
    this.read({ notes: kinds.flatMap(kind => staged[kind] ?? []) });
  }

  private read(raw: unknown) {
    this.desk.read(readGabi(raw));
    // Answered somewhere else (Helm, the phone): away from here too.
    this.deps.moments.dropGabiWhere(id => !this.desk.has(id));
    for (const id of this.photos.keys()) if (!this.desk.has(id)) this.photos.delete(id);
    this.paintHeart();
  }

  /* ── Every half second ───────────────────────────────────────────────── */

  private tick() {
    const now = Date.now();
    if (this.desk.hasWork() && now - this.holdAt > HOLD_EVERY_MS) {
      this.holdAt = now;
      void call<string | null>("gabi_hold")
        .then(why => { this.hold = why ?? null; this.holdAnswered = Date.now(); })
        .catch(() => { this.hold = null; this.holdAnswered = Date.now(); });
    }
    this.paintHeart();
    const s = this.deps.surface;
    if (this.hold || now - this.holdAnswered > 2 * HOLD_EVERY_MS || s.away || s.inAmbient) return;
    this.reactions(now);
    this.events();
    void this.notes();
  }

  private reactions(now: number) {
    if (!peekOn("gabi")) return;
    const due = this.desk.dueReactions();
    if (!due.length) return;
    const fun = due[0].fun!;
    const going = this.run && this.run.fun === fun && now - this.run.at < RUN_MS ? this.run.count : 0;
    const count = going + due.length;
    this.run = { fun, count, at: now };
    this.burst(fun, count);
    const last = due[due.length - 1];
    peek({ ...reactionPeek(last, count), action: { label: "Serce", icon: "heart", run: () => this.heartBack(last) } });
    for (const n of due) this.seen(n);
  }

  private events() {
    if (!peekOn("gabi") || this.deps.peekHeld()) return;
    const note = this.desk.dueEvent();
    if (!note) return;
    if (note.fun) this.burst(note.fun, 1);
    peek(eventPeek(note));
    this.seen(note);
  }

  /** The next note or photo, when nothing else of hers is opening. */
  private async notes() {
    if (this.opening !== null) return;
    const note = this.desk.dueNote();
    if (!note) return;
    this.desk.markShown(note.id);
    if (note.fun) this.burst(note.fun, 1);
    if (note.style !== "photo" || !note.photoId) return this.deps.moments.gabi(noteMoment(note, Date.now()));
    this.opening = note.id;
    try {
      const art = await this.picture(note);
      if (art && !this.deps.peekHeld()) {
        peek(photoPeek(note, art));
        await new Promise(done => window.setTimeout(done, THUMB_MS));
      }
      // Answered from the phone in that second and a half: nothing to open.
      if (this.desk.has(note.id)) this.deps.moments.gabi(noteMoment(note, Date.now(), art ?? undefined));
    } finally {
      this.opening = null;
    }
  }

  private async picture(note: GabiNote): Promise<string | null> {
    if (!note.photoId) return null;
    const have = this.photos.get(note.id);
    if (have) return have;
    const art = await call<string | null>("gabi_photo", { id: note.photoId }).catch(() => null);
    if (art) this.photos.set(note.id, art);
    return art;
  }

  /* ── The layer over the screen ───────────────────────────────────────── */

  private burst(fun: GabiFun, count: number) {
    if (still()) return;
    const box = document.getElementById("island")?.getBoundingClientRect();
    if (!box) return;
    const edge = this.deps.surface.edge;
    const x = edge === "left" ? box.right : edge === "right" ? box.left : box.left + box.width / 2;
    const y = edge === "top" ? box.bottom : edge === "bottom" ? box.top : box.top + box.height / 2;
    void call("gabi_fun", { fun, count, x, y, edge }).catch(() => { /* the pill still said it */ });
  }

  /* ── The heart beside the notch ──────────────────────────────────────── */

  /** What's open or queued right now, so it isn't counted as waiting. */
  private upNow(): Set<number> {
    const up = new Set(this.deps.moments.gabiKeys().map(gabiIdOf).filter((id): id is number => id !== null));
    if (this.opening !== null) up.add(this.opening);
    return up;
  }

  private paintHeart() {
    // ⚠️ Not during a call or a share: it's small, and still hers.
    const quiet = !!this.hold && this.hold !== "idle";
    this.deps.surface.setHeart(quiet ? 0 : this.desk.unanswered(this.upNow()).length);
  }

  private reopen() {
    const waiting = this.desk.unanswered(this.upNow());
    const note = waiting[waiting.length - 1];
    if (!note) return;
    void this.picture(note).then(art => {
      if (this.desk.has(note.id)) this.deps.moments.gabi(noteMoment(note, Date.now(), art ?? undefined));
    });
  }

  /* ── Answering ───────────────────────────────────────────────────────── */

  private seen(note: GabiNote) {
    this.desk.markPlayed(note.id);
    void call("gabi_answer", { id: note.id, reply: null, photo: null }).catch(() => { /* still unseen in Helm; she just won't see it read yet */ });
  }

  private heartBack(note: GabiNote) {
    void call("gabi_answer", { id: note.id, reply: "❤️", photo: null })
      .then(() => { peek(sentPeek("❤️")); })
      .catch(() => this.deps.say("Gabi", "Nie doszło"));
  }

  private act(moment: Moment, button: MomentButton) {
    if (button.id === "gabi:write") {
      this.deps.moments.writeGabi(moment, text => this.answer(moment, text));
      return;
    }
    const reply = replyOf(button.id);
    if (reply) this.answer(moment, reply);
  }

  /** An answer, or `null` for ×: seen either way. It goes at once; a call that fails brings it back. */
  private answer(moment: Moment, reply: string | null) {
    const id = gabiIdOf(moment.key);
    const note = id === null ? null : this.desk.find(id);
    this.deps.moments.dropGabi(gabiKey(id ?? -1));
    if (!note) return;
    this.desk.answer(note.id);
    this.photos.delete(note.id);
    this.paintHeart();
    if (reply) peek(sentPeek(reply));
    void call("gabi_answer", { id: note.id, reply, photo: note.photoId }).catch(() => {
      this.desk.restore(note);
      this.deps.say("Gabi", "Nie doszło, spróbuj jeszcze raz");
    });
  }
}
