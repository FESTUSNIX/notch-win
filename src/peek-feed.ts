/* The peeks this side of the island raises (batch 13, builder P): music, the
 * Helm block and the calendar. Each reader is a pure diff of "what it was" and
 * "what it is", so tests/peeks.test.mjs drives them without a DOM; the shell
 * calls `PeekFeed.tick` from its paint and hands each result to `peek()`.
 *
 * ⚠️ The FIRST reading of anything is never news: every reader primes on its
 * first call and speaks from the second. Music also needs a track BEFORE (the
 * first real reading arrives after an empty one); the block and calendar
 * readers fire on a window, so one already inside it when the data first
 * arrives still peeks — a meeting 8 min out at launch is worth saying.
 *
 * Fixed defaults, noted in AGENTS: a meeting peeks 10 min before (until 5 min,
 * where the meeting claim takes the strip); "Czas wyjść" is start − 20 min for
 * an event with a physical place and no call link; "weź parasol" when any of
 * the next 3 forecast hours is rain, drizzle or a storm.
 */
import type { Peek } from "./peeks";

/* ── Music ─────────────────────────────────────────────────────────────── */
export interface MediaLike {
  active: boolean; playing: boolean; title: string; artist: string; artwork: string; source?: string;
}

export class MusicPeeks {
  private was: { key: string; playing: boolean } | null = null;

  /** `owner`: whether music is what the pill is already showing — then a
   *  change is drawn by the claim itself and a peek would say it twice. */
  read(media: MediaLike, owner: boolean): Peek | null {
    const key = media.active ? `${media.title}\u0000${media.artist}` : "";
    const was = this.was;
    this.was = { key, playing: media.playing };
    /* ⚠️ From one track to ANOTHER: music starting after silence (and the
     * first reading at launch, which arrives after an empty one) is not a
     * change worth borrowing the strip for. */
    if (!was || !was.key || !media.active || !media.title || owner) return null;
    if (key !== was.key) {
      return {
        id: `music:${key}`, kind: "music", icon: "media", art: media.artwork || undefined,
        title: media.title, line: media.artist || undefined,
      };
    }
    if (media.playing !== was.playing) {
      return {
        id: `music:${media.playing ? "play" : "pause"}:${key}`, kind: "music",
        icon: media.playing ? "play" : "pause", art: media.artwork || undefined,
        title: media.title, line: media.artist || undefined, ttl: 2500,
      };
    }
    return null;
  }
}

/* ── The Helm block ────────────────────────────────────────────────────── */
export interface BlockLike { id: number; title: string; status: string; minutes: number; project: string | null }

const spokenMinutes = (seconds: number) => {
  const m = Math.max(1, Math.round(seconds / 60));
  return m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}` : `${m} min`;
};

export class BlockPeeks {
  private primed = false;
  private said = new Set<string>();
  /** The live block last time, and how far in it was. */
  private live: { id: number; title: string; seconds: number } | null = null;

  /** `blocks`: Helm's blocks today; `seconds(b)`: how long b has run. */
  read(blocks: BlockLike[], seconds: (b: BlockLike) => number): Peek[] {
    const out: Peek[] = [];
    const live = blocks.find(b => b.status === "running") ?? blocks.find(b => b.status === "paused") ?? null;
    const first = !this.primed;
    this.primed = true;
    if (live) {
      const ran = seconds(live);
      const left = live.minutes * 60 - ran;
      const once = (key: string, peek: Peek) => {
        if (this.said.has(key)) return;
        this.said.add(key);
        if (!first) out.push(peek);
      };
      if (live.status === "running" && left > 60 && left <= 300) {
        once(`5:${live.id}`, {
          id: `block:5:${live.id}`, kind: "block", icon: "target", tone: "accent",
          title: `Zostało ${spokenMinutes(left)}`, line: live.title,
        });
      }
      if (left <= 0) {
        once(`over:${live.id}`, {
          id: `block:over:${live.id}`, kind: "block", icon: "target", tone: "warn", pulse: true,
          title: "Czas minął", line: live.title,
        });
      }
      this.live = { id: live.id, title: live.title, seconds: ran };
      return out;
    }
    /* The live one went: done is news, skipped or removed is not. */
    const gone = this.live;
    this.live = null;
    if (gone && !first) {
      const now = blocks.find(b => b.id === gone.id);
      if (now?.status === "done" && !this.said.has(`done:${gone.id}`)) {
        this.said.add(`done:${gone.id}`);
        out.push({
          id: `block:done:${gone.id}`, kind: "block", icon: "check", tone: "good",
          title: `Zrobione · ${spokenMinutes(Math.max(seconds(now), gone.seconds))}`, line: gone.title,
        });
      }
    }
    return out;
  }
}

/* ── The calendar ──────────────────────────────────────────────────────── */
export interface EventLike {
  id: string; title: string; start: string; allDay: boolean; location: string; meetingUrl: string;
}
export interface HourLike { icon: string }

export const MEETING_PEEK_MIN = 10;
export const LEAVE_MIN = 20;

const WET = /rain|drizzle|storm/i;
/** A physical place: something written, and not a call link. */
const physical = (e: EventLike) => !!e.location.trim() && !e.meetingUrl && !/^\s*https?:|zoom\.us|meet\.google|teams\.microsoft/i.test(e.location);

export class CalendarPeeks {
  private primed = false;
  private said = new Set<string>();

  read(events: EventLike[], now: number, hours: HourLike[] | null, join: (url: string) => void): Peek[] {
    const out: Peek[] = [];
    const first = !this.primed;
    this.primed = true;
    for (const e of events) {
      if (e.allDay) continue;
      const minutes = (Date.parse(e.start) - now) / 60_000;
      if (!(minutes > 0)) continue;
      const time = new Date(Date.parse(e.start)).toTimeString().slice(0, 5);
      if (minutes > 5 && minutes <= MEETING_PEEK_MIN && !this.said.has(`m:${e.id}`)) {
        this.said.add(`m:${e.id}`);
        if (!first) out.push({
          id: `meeting:${e.id}`, kind: "meeting", icon: "calendar", tone: "accent",
          title: e.title, line: `za ${Math.ceil(minutes)} min · ${time}`, ttl: 6000,
          action: e.meetingUrl ? { label: "Join", run: () => join(e.meetingUrl) } : undefined,
        });
      }
      if (physical(e) && minutes > 5 && minutes <= LEAVE_MIN && !this.said.has(`l:${e.id}`)) {
        this.said.add(`l:${e.id}`);
        const wet = !!hours?.slice(0, 3).some(h => WET.test(h.icon));
        if (!first) out.push({
          id: `leave:${e.id}`, kind: "leave", icon: wet ? "wxRain" : "open", tone: "accent", ttl: 6000,
          title: wet ? "Czas wyjść · weź parasol" : "Czas wyjść", line: `${e.title} · ${time}`,
        });
      }
    }
    return out;
  }
}
