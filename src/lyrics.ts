/* Live lyrics: an LRC file, and which line of it is now.
 *
 * ⚠️ **Pure, and in its own file, so `node --test` can load it.** Which line
 * is current at 2:13.4 is exactly the kind of off-by-one that is invisible on
 * screen — a line one early looks like a player whose clock is slightly
 * wrong — and obvious in a table. Same reason `dial.ts` sits beside
 * `screen-timer.ts`.
 *
 * ⚠️ **The format is not one format.** LRCLIB returns what its contributors
 * uploaded, which means `[mm:ss.xx]`, `[mm:ss.xxx]`, `[mm:ss]`, several stamps
 * on one line for a repeated chorus, `[ar:]`/`[ti:]`/`[offset:]` metadata
 * headers, and blank lines that are real (an instrumental gap) mixed with
 * blank lines that are padding. Anything unparseable is dropped rather than
 * guessed at: a lyric line at the wrong second is worse than one line missing.
 */

export interface Line {
  /** Seconds from the start of the track. */
  at: number;
  /** The words, or "" for a gap the file marks explicitly. */
  text: string;
}

/** `[mm:ss.cc]`, `[mm:ss.mmm]` or `[mm:ss]`, and the minutes may run past 60. */
const STAMP = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;

/** A metadata header — `[ar:Artist]`, `[offset:+250]`. ⚠️ Told apart from a
 *  timestamp by the KEY being letters: `[id:1]` is a header and `[01:23]` is
 *  not, and the only difference is what is left of the colon. */
const HEADER = /^\[([a-z]+):(.*)\]$/i;

/** Parse an LRC file into lines, in time order.
 *
 * `offset` in the file's own header is applied (it is milliseconds, and
 * POSITIVE means the words come earlier — the tag says "shift the lyrics",
 * not "shift the clock", which is the opposite of what the sign suggests).
 */
export function parseLrc(text: string): Line[] {
  if (!text) return [];
  let shift = 0;
  const out: Line[] = [];

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;

    const header = HEADER.exec(line);
    if (header && !/^\d+$/.test(header[1])) {
      if (header[1].toLowerCase() === "offset") {
        const ms = Number(header[2].trim());
        if (Number.isFinite(ms)) shift = -ms / 1000;
      }
      continue;
    }

    STAMP.lastIndex = 0;
    const stamps: number[] = [];
    let found: RegExpExecArray | null;
    let ends = 0;
    while ((found = STAMP.exec(line))) {
      /* ⚠️ Only the stamps at the FRONT. A bracketed aside inside the words —
       * `[02:00]` quoted in a lyric, or a `[Chorus]` marker — is not a second
       * time for the same line, and treating it as one prints the rest of the
       * song against the wrong minute. */
      if (found.index !== ends) break;
      ends = found.index + found[0].length;
      const fraction = found[3] ? Number(`0.${found[3]}`) : 0;
      stamps.push(Number(found[1]) * 60 + Number(found[2]) + fraction);
    }
    if (!stamps.length) continue;

    const words = line.slice(ends).trim();
    for (const at of stamps) out.push({ at: Math.max(0, at + shift), text: words });
  }

  /* ⚠️ Sorted, because several stamps on one line put a chorus's repeats out
   * of order — and `lineAt` is a search that assumes order. A stable sort, so
   * two lines sharing a second keep the order they were written in. */
  return out.sort((a, b) => a.at - b.at);
}

/** Which line is current at `seconds`, or -1 before the first one.
 *
 * ⚠️ The line that has STARTED, not the nearest. A binary search for the last
 * stamp at or before the position: at 2:13 with lines at 2:10 and 2:16, the
 * answer is 2:10 however much closer 2:16 is.
 */
export function lineAt(lines: Line[], seconds: number): number {
  let low = 0;
  let high = lines.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (lines[mid].at <= seconds) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}

/** Is this file worth showing at all?
 *
 * ⚠️ LRCLIB answers for instrumentals too, and it answers with near-empty
 * files where somebody uploaded a stub. Two lines of words is the floor: one
 * stamp holding the track's title is a metadata record, not a lyric. */
export function worth(lines: Line[]): boolean {
  return lines.filter(one => one.text.length > 0).length >= 2;
}
