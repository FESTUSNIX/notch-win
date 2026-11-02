/* When he has finished speaking, for a hands-free turn (2 Nov): the
 * microphone's level twenty times a second in, `silence` once he has spoken
 * and then been quiet long enough, `nothing` when he never started.
 *
 * ⚠️ Relative to the room, not a fixed number: the room is the QUIETEST level
 * of the last few seconds (a rolling minimum, the microphone's first moments
 * left out while its level climbs from zero). A fan, the speakers' hiss or any
 * steady tone sits at that minimum and never counts as speech; real speech
 * dips between words, so the minimum stays under it and the words stand out.
 * Speech is also above an absolute minimum, so a silent room's tiny floor
 * doesn't make a breath a sentence.
 *
 * ⚠️ The end is measured against the room as it was when he STARTED: words
 * fall back to that quiet, a sound that switched on (music, a fan, a microphone
 * whose audio starts late) stays above it. Such a sound — loud, flat, never
 * back to the quiet — ends the window as `nothing` after `FLAT_MS`, rather
 * than being sent as if it were words. Pure, tested in tests/voice-endpoint.test.mjs.
 *
 * ⚠️ No runtime imports: `node --test` loads this file (AGENTS 437).
 */

/** Quiet this long after speaking sends the turn. */
export const SILENCE_MS = 1300;
/** Speech must add up to this much before a pause can end the turn (a cough isn't a sentence). */
export const SPEECH_MS = 300;
/** Nothing said for this long ends a turn he started… */
export const NOTHING_MS = 9000;
/** …and, shorter, the follow-up after a reply. */
export const FOLLOW_MS = 7000;

/** How far back the room's quiet is looked for. */
const ROOM_MS = 3000;
/** The microphone's level climbs from zero when it opens: not the room. */
const WARMUP_MS = 300;
/** Speech is at least this loud (the recorder's 0..1)… */
const SPEECH_MIN = 0.12;
/** …and this many times the room. */
const SPEECH_OVER_ROOM = 2.5;
/** Loud and flat (no dip back to the quiet) this long after "speech": a sound, not words. */
export const FLAT_MS = 4000;
/** A level within this of the last second's range is flat. */
const FLAT_RANGE = 0.06;
/** Quiet is under this, at the least… */
const QUIET_MIN = 0.05;
/** …or under this many times the room. */
const QUIET_OVER_ROOM = 1.6;

export type Endpoint = "silence" | "nothing" | null;

export class EndOfSpeech {
  private start = -1;
  private last = -1;
  private room: { t: number; level: number }[] = [];
  private spoken = 0;
  private loudAt = -1;
  /** The room when he started speaking: the quiet his words come back to. */
  private before = -1;
  /** Since when the level has been flat and above that quiet. */
  private flatSince = -1;
  private follow: boolean;

  constructor(follow = false) {
    this.follow = follow;
  }

  /** Starting over for a new listening window. */
  reset(follow = false) {
    this.follow = follow;
    this.start = -1;
    this.last = -1;
    this.room = [];
    this.spoken = 0;
    this.loudAt = -1;
    this.before = -1;
    this.flatSince = -1;
  }

  /** Whether he has said anything yet in this window. */
  get started(): boolean { return this.spoken >= SPEECH_MS; }

  push(level: number, now: number): Endpoint {
    if (this.start < 0) { this.start = now; this.last = now; }
    const dt = Math.max(0, Math.min(250, now - this.last));
    this.last = now;
    if (now - this.start >= WARMUP_MS) this.room.push({ t: now, level });
    while (this.room.length && now - this.room[0].t > ROOM_MS) this.room.shift();
    // No room measured yet (the first moments): nothing counts either way.
    if (this.room.length) {
      let floor = Infinity;
      for (const one of this.room) floor = Math.min(floor, one.level);
      if (level >= Math.max(SPEECH_MIN, floor * SPEECH_OVER_ROOM)) {
        if (this.before < 0) this.before = floor;
        this.spoken += dt;
        this.loudAt = now;
      }
      if (this.started) {
        const quiet = level < Math.max(QUIET_MIN, this.before * QUIET_OVER_ROOM);
        if (quiet) {
          this.flatSince = -1;
          return now - this.loudAt >= SILENCE_MS ? "silence" : null;
        }
        // Loud and flat over the last second, never back to the quiet: a sound that switched on.
        let lo = Infinity, hi = -Infinity;
        for (const one of this.room) if (now - one.t <= 1000) { lo = Math.min(lo, one.level); hi = Math.max(hi, one.level); }
        if (hi - lo < FLAT_RANGE) {
          if (this.flatSince < 0) this.flatSince = now;
          if (now - this.flatSince >= FLAT_MS) return "nothing";
        } else this.flatSince = -1;
        return null;
      }
    }
    return now - this.start >= (this.follow ? FOLLOW_MS : NOTHING_MS) ? "nothing" : null;
  }
}
