/* Peeks (batch 13): news that borrows the collapsed PILL for a few seconds
 * and hands it back. See contract-b13 and AGENTS (the notes on owner, peek,
 * moment and glance).
 *
 * ⚠️ No DOM and no Tauri here — the queue, the hold-backs, the replay and the
 * wheel's cycle are plain logic so tests/peeks.test.mjs can run them under
 * node. The shell (tasks.ts) asks `peeks.step()` once a paint and draws what
 * it answers with `renderPeek` (island-activity.ts).
 *
 * The rules:
 * - one at a time; the newest of a kind REPLACES an older one of the same kind
 *   (three song changes → the last), whether it is waiting or already up;
 * - held back (waiting, not lost) while the shell says so: a moment or the
 *   voice glance up, the panel open, fullscreen/away, presenting, a call;
 * - a peek that waited past `STALE_MS` is dropped — a song change from two
 *   minutes ago is not news;
 * - quiet hours (Settings → Peeks) drop non-urgent peeks at the door;
 * - the last few shown are kept for the wheel's replay, newest first.
 */
import type { TaskIcon } from "./task-icons";

export type PeekKind =
  | "music" | "volume" | "block" | "meeting" | "leave"          // P's
  | "buds" | "mic" | "power" | "download" | "screenshot"        // S's (devices, files)
  | "paid" | "logged" | "focus";                                // S's (Helm, focus)

export interface Peek {
  /** Stable per event: "music:<track id>", "download:<path>", "paid:<payment id>". */
  id: string;
  kind: PeekKind;
  /** A TaskIcon name codenotch already has, or an image URL/data URL for `art`. */
  icon: TaskIcon | string;
  /** Album cover / screenshot thumbnail (small). */
  art?: string;
  /** One short line. */
  title: string;
  /** Second, quieter line. */
  line?: string;
  /** 0–1 for a level/progress peek (volume, battery). */
  level?: number;
  tone?: "neutral" | "good" | "warn" | "accent";
  /** What a click on the peek does. */
  action?: { label: string; run: () => void };
  /** The one small icon beside the click: Pokaż w folderze on a download, Otwórz on a
   *  screenshot (builder S). Pressing it runs this instead of the click's action. */
  secondary?: { label: string; icon: string; run: () => void };
  /** Default 4000 ms. */
  ttl?: number;
  /** Shown even in quiet hours (e.g. battery 5%). */
  urgent?: boolean;
  /** One amber pulse when it comes up (a block running over). P's addition. */
  pulse?: boolean;
}

export const PEEK_TTL = 4000;
/** A peek that has waited this long behind a hold-back is no longer news. */
export const STALE_MS = 90_000;
/** How many shown peeks the wheel can replay. */
export const REPLAY = 3;
/** The wheel's cycle falls back to the owner after this long untouched. */
export const IDLE_MS = 5000;

interface Waiting { peek: Peek; at: number }

export class PeekQueue {
  private waiting: Waiting[] = [];
  private up: { peek: Peek; until: number } | null = null;
  /** Shown, newest first, for the wheel's replay. */
  recent: Peek[] = [];

  get size(): number { return this.waiting.length + (this.up ? 1 : 0); }
  /** What is up right now, without stepping. */
  get showing(): Peek | null { return this.up?.peek ?? null; }

  push(peek: Peek, now: number) {
    /* The same kind already UP: swap its content in place and give it its time
     * again — a fourth track change while the third is showing shows the
     * fourth, not the third and then the fourth. */
    if (this.up && this.up.peek.kind === peek.kind) {
      this.up = { peek, until: now + (peek.ttl ?? PEEK_TTL) };
      this.remember(peek);
      return;
    }
    this.waiting = this.waiting.filter(one => one.peek.kind !== peek.kind);
    this.waiting.push({ peek, at: now });
  }

  /** Drop everything of a kind (a source that knows its news is void). */
  drop(kind: PeekKind) {
    this.waiting = this.waiting.filter(one => one.peek.kind !== kind);
    if (this.up?.peek.kind === kind) this.up = null;
  }

  /** What the pill should show this instant, or null for the owner.
   *
   * ⚠️ A hold that arrives while a peek is up ENDS it (it was seen, it is in
   * the replay) rather than pausing it: the panel opening or a call starting
   * is the user's attention going elsewhere, and a peek resuming afterwards
   * would be news repeated. */
  /** `pointer`: the pointer is on the pill — the peek up stays (its time stops,
   *  so it can be clicked) and no new one starts under the pointer. */
  step(now: number, held: boolean, pointer = false): Peek | null {
    this.waiting = this.waiting.filter(one => now - one.at < STALE_MS);
    if (pointer && !held) {
      if (this.up) this.up.until = Math.max(this.up.until, now + 1500);
      return this.up?.peek ?? null;
    }
    if (this.up && (held || now >= this.up.until)) this.up = null;
    if (held) return null;
    if (!this.up) {
      const next = this.waiting.shift();
      if (next) {
        this.up = { peek: next.peek, until: now + (next.peek.ttl ?? PEEK_TTL) };
        this.remember(next.peek);
      }
    }
    return this.up?.peek ?? null;
  }

  private remember(peek: Peek) {
    this.recent = [peek, ...this.recent.filter(one => one.id !== peek.id && one.kind !== peek.kind)].slice(0, REPLAY);
  }
}

/* ── The wheel's cycle ────────────────────────────────────────────────────
 * Owner (0) → second place (1) → the replay, newest first → back to 0. Idle
 * `IDLE_MS` returns to the owner. `count` is how many stops there are now
 * (1 + second? + replay), so a stop that vanished is skipped, not shown blank. */
export class PillCycle {
  private at = 0;
  private touched = -Infinity;

  wheel(dir: number, count: number, now: number): number {
    if (count <= 1) { this.at = 0; return 0; }
    const from = this.index(count, now);
    this.at = ((from + Math.sign(dir || 1)) % count + count) % count;
    this.touched = now;
    return this.at;
  }

  index(count: number, now: number): number {
    if (now - this.touched > IDLE_MS || this.at >= count) this.at = 0;
    return this.at;
  }

  reset() { this.at = 0; this.touched = -Infinity; }
}

/* ── Settings → Peeks (S writes the UI; read here) ───────────────────────── */
export interface PeekPrefs {
  peeks?: Partial<Record<PeekKind, boolean>>;
  peekQuiet?: { from: string; to: string } | null;
}

let prefs: PeekPrefs = {};

/** The shell hands the prefs over on boot and on every `notch:prefs`. */
export function setPeekPrefs(next: PeekPrefs | null | undefined) {
  prefs = { peeks: next?.peeks ?? {}, peekQuiet: next?.peekQuiet ?? null };
}

/** Whether a kind is on (Settings → Peeks). Missing = on. */
export function peekOn(kind: PeekKind): boolean {
  return prefs.peeks?.[kind] !== false;
}

const minutesOf = (hhmm: string): number | null => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/** Whether `date` falls in the quiet hours; a window may wrap midnight (22:00–07:00). */
export function inQuiet(quiet: PeekPrefs["peekQuiet"], date: Date): boolean {
  if (!quiet) return false;
  const from = minutesOf(quiet.from), to = minutesOf(quiet.to);
  if (from === null || to === null || from === to) return false;
  const now = date.getHours() * 60 + date.getMinutes();
  return from < to ? now >= from && now < to : now >= from || now < to;
}

/** The one queue the pill reads. */
export const peeks = new PeekQueue();
const listeners = new Set<() => void>();

/** The shell repaints the pill when a peek arrives rather than waiting for the tick. */
export function onPeek(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Queue a peek; returns false when its kind is switched off or it was dropped. */
export function peek(p: Peek): boolean {
  if (!peekOn(p.kind)) return false;
  if (!p.urgent && inQuiet(prefs.peekQuiet, new Date())) return false;
  peeks.push(p, Date.now());
  for (const fn of listeners) fn();
  return true;
}
