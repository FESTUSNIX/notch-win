/* Gabi in the notch (4 Nov), the rules: what she sent, and how much of the
 * island each thing takes. Pure, so tests/gabi.test.mjs can run it under node;
 * the wiring is gabi-feed.ts. His words: "the nudges, text and even the surprise
 * emojis/reactions make sense if I see them quick."
 *
 * - A REACTION plays over the screen and is gone. It's seen once it played.
 * - The FUND or her LOCK borrows the pill. Seen once it showed. He can't undo
 *   hers, so there's nothing to press.
 * - A NOTE or a PHOTO opens the island for NOTE_FOLD_MS, then folds to the heart
 *   beside the notch, which stays until he answers. Only an answer or × tells
 *   her it was seen: a note he never looked at must not read as seen.
 *
 * Helm decides what each note IS (`notchNote`); nothing here reads her text.
 */
import type { Peek } from "./peeks";
import type { Moment } from "./moments";

export type GabiStyle = "reaction" | "event" | "note" | "photo";
export type GabiFun = "hearts" | "confetti" | "hug" | "stars" | "coffee";

export interface GabiNote {
  id: number;
  style: GabiStyle;
  title: string;
  line: string;
  fun: GabiFun | null;
  photoId: number | null;
  icon: "heart" | "money" | "lock";
  tone: "gabi" | "hot" | "warn" | "good";
  at: string;
}

/** How long a note stays open by itself (his call: then it folds to the heart). */
export const NOTE_FOLD_MS = 12_000;
/** Above everything else that speaks up: she may interrupt (his call, 3 Nov). */
export const GABI_PRIORITY = 95;
/** The one-tap answers, as Helm's `QUICK_REPLIES`. */
export const GABI_REPLIES = ["❤️", "👍", "Dzięki! 😘"];
const STYLES: GabiStyle[] = ["reaction", "event", "note", "photo"];
const FUNS: GabiFun[] = ["hearts", "confetti", "hug", "stars", "coffee"];
const ICONS: GabiNote["icon"][] = ["heart", "money", "lock"];
const TONES: GabiNote["tone"][] = ["gabi", "hot", "warn", "good"];

/** `/api/notch/gabi`, checked: what isn't one of hers is dropped, not drawn. */
export function readGabi(raw: unknown): GabiNote[] {
  const list = (raw as { notes?: unknown } | null)?.notes;
  if (!Array.isArray(list)) return [];
  return list.flatMap((n): GabiNote[] => {
    if (!n || typeof n !== "object") return [];
    const o = n as Record<string, unknown>;
    if (typeof o.id !== "number" || !STYLES.includes(o.style as GabiStyle) || typeof o.title !== "string") return [];
    return [{
      id: o.id, style: o.style as GabiStyle, title: o.title, line: typeof o.line === "string" ? o.line : "",
      fun: FUNS.includes(o.fun as GabiFun) ? o.fun as GabiFun : null,
      photoId: typeof o.photoId === "number" ? o.photoId : null,
      icon: ICONS.includes(o.icon as GabiNote["icon"]) ? o.icon as GabiNote["icon"] : "heart",
      tone: TONES.includes(o.tone as GabiNote["tone"]) ? o.tone as GabiNote["tone"] : "gabi",
      at: typeof o.at === "string" ? o.at : "",
    }];
  });
}

/* ── What's owed to him ───────────────────────────────────────────────────── */

/** Her notes as last read, and how far each has got here. Survives nothing: a
 *  restart shows what's still unseen again, which is right. */
export class GabiDesk {
  private notes: GabiNote[] = [];
  private played = new Set<number>();
  private shown = new Set<number>();
  /** Answered here, so a reading from before the answer can't bring it back. */
  private answered = new Set<number>();

  read(list: GabiNote[]) {
    const there = new Set(list.map(n => n.id));
    // Answered reached Helm (it's gone from the list), so it needn't be remembered.
    for (const id of this.answered) if (!there.has(id)) this.answered.delete(id);
    this.notes = list.filter(n => !this.answered.has(n.id));
  }

  /** Reactions not played yet: the oldest, with every one of the same fun after it in a row. */
  dueReactions(): GabiNote[] {
    const due = this.notes.filter(n => n.style === "reaction" && !this.played.has(n.id));
    if (!due.length) return [];
    const first = due[0].fun;
    const run: GabiNote[] = [];
    for (const n of due) {
      if (n.fun !== first) break;
      run.push(n);
    }
    return run;
  }

  /** The oldest fund or lock note not shown yet. */
  dueEvent(): GabiNote | null {
    return this.notes.find(n => n.style === "event" && !this.played.has(n.id)) ?? null;
  }

  /** The next note or photo to open with: words first, a picture last. */
  dueNote(): GabiNote | null {
    const waiting = this.notes.filter(n => (n.style === "note" || n.style === "photo") && !this.shown.has(n.id));
    return waiting.find(n => n.style === "note") ?? waiting[0] ?? null;
  }

  hasWork(): boolean {
    return !!(this.dueReactions().length || this.dueEvent() || this.dueNote());
  }

  markPlayed(id: number) { this.played.add(id); }
  markShown(id: number) { this.shown.add(id); }

  /** Answered or closed: gone from here at once, whatever the next reading says. */
  answer(id: number) {
    this.answered.add(id);
    this.played.delete(id);
    this.shown.delete(id);
    this.notes = this.notes.filter(n => n.id !== id);
  }

  /** The answer didn't reach Helm: it's owed again. */
  restore(note: GabiNote) {
    this.answered.delete(note.id);
    this.shown.add(note.id);
    if (!this.notes.some(n => n.id === note.id)) this.notes = [...this.notes, note];
  }

  /** What the heart stands for: notes that opened, folded, and still wait for an answer. Oldest first. */
  unanswered(up: ReadonlySet<number>): GabiNote[] {
    return this.notes.filter(n => (n.style === "note" || n.style === "photo") && this.shown.has(n.id) && !up.has(n.id));
  }

  find(id: number): GabiNote | null { return this.notes.find(n => n.id === id) ?? null; }
  /** Still one of hers Helm lists. */
  has(id: number): boolean { return this.notes.some(n => n.id === id); }
}

/* ── How each looks ───────────────────────────────────────────────────────── */

export const gabiKey = (id: number) => `gabi:${id}`;
export const gabiIdOf = (key: string): number | null => {
  const m = /^gabi:(\d+)$/.exec(key);
  return m ? Number(m[1]) : null;
};

/** A reaction in the pill. `count`: how many in a row, "×3". */
export function reactionPeek(note: GabiNote, count: number): Peek {
  return {
    id: `gabi:fun:${note.id}`, kind: "gabi", icon: "heart", title: note.title,
    line: count > 1 ? `${note.line} ×${count}` : note.line, tone: "gabi", urgent: true, ttl: 3800,
  };
}

/** The fund or her lock in the pill, with one pulse. */
export function eventPeek(note: GabiNote): Peek {
  return {
    id: `gabi:event:${note.id}`, kind: "gabi", icon: note.icon, title: note.title, ...(note.line ? { line: note.line } : {}),
    tone: note.tone, urgent: true, ttl: 5200, pulse: true,
  };
}

/** A photo's first second and a half: the thumbnail in the pill. ⚠️ `once`: the
 *  wheel's replay must not keep a picture that expires. */
export function photoPeek(note: GabiNote, art: string): Peek {
  return { id: `gabi:photo:${note.id}`, kind: "gabi", icon: "image", art, title: note.title, line: note.line || "Nowe zdjęcie", tone: "gabi", urgent: true, ttl: 1500, once: true };
}

/** What he sent, said back in the pill for a moment. */
export function sentPeek(text: string): Peek {
  return { id: `gabi:sent:${text}`, kind: "gabi", icon: "heart", title: "Wysłane", line: text, tone: "gabi", urgent: true, ttl: 1500, once: true };
}

/** A note or a photo opening the island. */
export function noteMoment(note: GabiNote, at: number, photo?: string): Moment {
  return {
    key: gabiKey(note.id), kind: "gabi", icon: "heart", title: note.title, line: note.line, sticky: false, at,
    foldMs: NOTE_FOLD_MS, priority: GABI_PRIORITY, ...(photo ? { photo } : {}),
    buttons: [
      ...GABI_REPLIES.map((label, i) => ({ id: `gabi:reply:${i}`, label, chip: true })),
      { id: "gabi:write", label: "Odpisz" },
    ],
  };
}

/** What a button on her moment sends: the quick answer it stands for. */
export const replyOf = (buttonId: string): string | null => {
  const m = /^gabi:reply:(\d+)$/.exec(buttonId);
  return m ? GABI_REPLIES[Number(m[1])] ?? null : null;
};
