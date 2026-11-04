/* The Gabi screen's pure half: what `/api/notch/gabi/thread` says, and how the
 * conversation reads. The wiring is screen-gabi.ts. No runtime imports, so
 * `node --test` can load it directly.
 */

export type GabiFun = "hearts" | "confetti" | "hug" | "stars" | "coffee";

/** Helm's own reading of a note of hers (`notchNote`): what kind of thing it is. */
export interface DeskRead {
  style: "reaction" | "event" | "note" | "photo";
  title: string;
  line: string;
  icon: "heart" | "money" | "lock";
  tone: "gabi" | "hot" | "warn" | "good";
}

export interface DeskNote {
  id: number;
  direction: "to_him" | "to_her";
  text: string | null;
  fun: GabiFun | null;
  replyTo: number | null;
  photoId: number | null;
  at: string;
  seen: boolean;
  read: DeskRead | null;
}

export interface DeskPhoto {
  id: number;
  caption: string | null;
  at: string;
  expiresAt: string;
  seen: boolean;
}

export interface GabiDeskData {
  name: string;
  notes: DeskNote[];
  photos: DeskPhoto[];
  fund: number;
  lock: { endsAt: string } | null;
}

/** The surprises he can send back, as Helm's `FUN_META`. */
export const SURPRISES: { fun: GabiFun; emoji: string; label: string }[] = [
  { fun: "hearts", emoji: "❤️", label: "Serduszka" },
  { fun: "confetti", emoji: "🎉", label: "Konfetti" },
  { fun: "hug", emoji: "🤗", label: "Przytulas" },
  { fun: "stars", emoji: "✨", label: "Gwiazdki" },
  { fun: "coffee", emoji: "☕", label: "Kawa" },
];

const emojiOf = (fun: GabiFun | null) => SURPRISES.find(one => one.fun === fun)?.emoji ?? "";

/** `/api/notch/gabi/thread`, checked. Null when she isn't set up yet. */
export function readDesk(raw: unknown): GabiDeskData | null {
  const o = raw as Partial<GabiDeskData> | null;
  if (!o || typeof o.name !== "string" || !Array.isArray(o.notes)) return null;
  return {
    name: o.name,
    notes: o.notes,
    photos: Array.isArray(o.photos) ? o.photos : [],
    fund: typeof o.fund === "number" ? o.fund : 0,
    lock: o.lock ?? null,
  };
}

const localDayOf = (when: Date) =>
  `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, "0")}-${String(when.getDate()).padStart(2, "0")}`;

/** `Dziś`, `Wczoraj`, or the date. */
export function dayTitle(at: string, now: Date): string {
  const when = new Date(at);
  const key = localDayOf(when);
  if (key === localDayOf(now)) return "Dziś";
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (key === localDayOf(yesterday)) return "Wczoraj";
  return when.toLocaleDateString("pl-PL", { weekday: "long", day: "numeric", month: "long" });
}

export type ThreadRow =
  | { kind: "day"; title: string }
  | { kind: "note"; note: DeskNote; style: "text" | "reaction" | "photo"; mine: boolean; text: string; clock: string; firstOfRun: boolean }
  | { kind: "event"; note: DeskNote; title: string; line: string; icon: "money" | "lock" | "heart"; tone: DeskRead["tone"]; clock: string };

/** The conversation as lines: a heading per day, and a note under a note from the
 *  same person within ten minutes doesn't repeat itself. */
export function threadRows(notes: DeskNote[], now: Date): ThreadRow[] {
  const rows: ThreadRow[] = [];
  let day = "";
  let last: DeskNote | null = null;
  for (const note of notes) {
    const when = new Date(note.at);
    const key = localDayOf(when);
    if (key !== day) {
      day = key;
      rows.push({ kind: "day", title: dayTitle(note.at, now) });
      last = null;
    }
    const clock = when.toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit" });
    const read = note.read;
    if (read?.style === "event") {
      rows.push({ kind: "event", note, title: read.title, line: read.line, icon: read.icon, tone: read.tone, clock });
      last = null;
      continue;
    }
    const mine = note.direction === "to_her";
    const firstOfRun = !last || last.direction !== note.direction
      || when.getTime() - new Date(last.at).getTime() > 10 * 60_000;
    const words = read ? read.line : note.text ?? "";
    const reaction = !note.photoId && !note.text?.trim() && !!note.fun;
    rows.push({
      kind: "note",
      note,
      mine,
      firstOfRun,
      clock,
      style: note.photoId ? "photo" : reaction ? "reaction" : "text",
      text: reaction ? emojiOf(note.fun) : words || (note.text ?? ""),
    });
    last = note;
  }
  return rows;
}

/** The note a quick answer would answer: the last one, if it's hers and says something. */
export function waitingOn(notes: DeskNote[]): DeskNote | null {
  const last = notes[notes.length - 1];
  if (!last || last.direction !== "to_him" || last.read?.style === "event") return null;
  return last;
}

/** What opening the screen has now shown him and Helm should hear about. */
export function unseenIds(notes: DeskNote[]): number[] {
  return notes.filter(note => note.direction === "to_him" && !note.seen).map(note => note.id);
}

/** `5 h`, `40 min`: how long a photo has left. */
export function photoLeft(expiresAt: string, now: number): string {
  const minutes = Math.max(0, Math.round((new Date(expiresAt).getTime() - now) / 60_000));
  if (minutes >= 60) return `${Math.round(minutes / 60)} h`;
  return `${minutes} min`;
}

/** `19:00` on a lock's end, or its date if it isn't today. */
export function lockUntil(endsAt: string, now: Date): string {
  const when = new Date(endsAt);
  const clock = when.toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit" });
  if (localDayOf(when) === localDayOf(now)) return clock;
  return `${when.toLocaleDateString("pl-PL", { weekday: "short" })} ${clock}`;
}
