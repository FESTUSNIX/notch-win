/* What a pile of notes looks like once there are more than ten of them.
 *
 * Writing one is a field and a key. Everything here is about the other half —
 * finding the one you wrote a fortnight ago from three words you half remember.
 *
 * ⚠️ No DOM, no Tauri, no clock of its own. Every rule below is decided on
 * strings and a number, which is what makes them testable without a browser.
 */

export interface Note {
  id: string;
  body: string;
  written: number;
  edited: number;
  /** Whether it has a window of its own on the desktop. ⚠️ Window state, kept
   *  on the note because the two are one to one — see notes.rs. */
  pinned?: boolean;
  /** Which side of the screen the docked drawer sits on. */
  edge?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  /** A key of `TINTS`, or empty for plain paper. */
  tint?: string;
}

/* ── Colour ───────────────────────────────────────────────────
 * ⚠️ A KEY, never a colour. What is stored on a note is `amber`, and the
 * stylesheet decides what amber is — so a note can never carry a string that
 * ends up inside a CSS declaration, and the palette can be retuned in one place
 * without rewriting every note that used it.
 *
 * ⚠️ Six, and the first is "none". A colour picker on a note is for telling
 * four notes apart at a glance, which is a job six swatches do and thirty do
 * not — past about eight nobody remembers which colour meant what, and the
 * control stops being a glance and becomes a decision. */
export const TINTS: { key: string; label: string }[] = [
  { key: "", label: "Plain" },
  { key: "amber", label: "Amber" },
  { key: "rose", label: "Rose" },
  { key: "violet", label: "Violet" },
  { key: "sky", label: "Sky" },
  { key: "lime", label: "Lime" },
];

/** The note's colour key, folded to one the stylesheet knows. */
export function tintOf(note: { tint?: string } | null | undefined): string {
  const said = note?.tint ?? "";
  return TINTS.some(one => one.key === said && one.key) ? said : "";
}

/** The first line, which is the closest thing a note has to a title.
 *
 * ⚠️ Trimmed and capped, because it is drawn in one row. A note that opens with
 * a pasted URL two hundred characters long would otherwise push the date off
 * the end of the row and take the rest of the list's alignment with it.
 */
export function noteTitle(body: string, cap = 80): string {
  const first = body.split("\n").map(line => line.trim()).find(Boolean) ?? "";
  return first.length > cap ? `${first.slice(0, cap - 1)}…` : first;
}

/** What is left after the title, as one line, for the row's second line.
 *
 * ⚠️ Newlines collapsed to spaces rather than kept. The row is one line tall;
 * a preview containing `\n` renders as the first word and a lot of nothing.
 */
export function notePreview(body: string, cap = 120): string {
  const lines = body.split("\n").map(line => line.trim()).filter(Boolean);
  const rest = lines.slice(1).join(" ");
  return rest.length > cap ? `${rest.slice(0, cap - 1)}…` : rest;
}

/** Fold the accents off, so `Krakow` finds `Kraków`.
 *
 * ⚠️ This is the whole reason search here is not `body.includes(query)`. Half
 * of what gets written down on this machine is Polish, and a search that only
 * matches if you reproduce the diacritics is a search you have to already know
 * the answer to use. `NFD` splits a letter from its mark and the range strips
 * the marks; anything without one is untouched.
 */
export function fold(value: string): string {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** The notes matching a query, newest first.
 *
 * ⚠️ Every word, anywhere, in any order — not the phrase. You remember a note
 * as "that ssh thing for the pi", and requiring those five characters in that
 * order finds nothing. Each word must appear somewhere; where is not the
 * question being asked.
 *
 * ⚠️ NOT the palette's subsequence matcher. That one is built to turn three
 * letters into a command, so it matches `agt` against `Agents` — against a page
 * of prose it matches almost everything, and a search that returns the whole
 * list has not answered anything.
 */
export function searchNotes(notes: Note[], query: string): Note[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return notes;
  return notes.filter(note => {
    const body = fold(note.body);
    return words.every(word => body.includes(word));
  });
}

/** Where the query matched, so the row can light it up.
 *
 * Returns the body split into alternating plain and matched runs, starting
 * plain — so a caller draws `parts[0]` as text, `parts[1]` as a mark, and so
 * on, with no second pass over the string.
 *
 * ⚠️ Matched on the FOLDED text and sliced from the original. The two are the
 * same length because `NFD` + strip only ever removes combining marks that were
 * not there in the composed form to begin with — which is true for the Latin
 * scripts this has to handle and is asserted in the tests, because the day it
 * stops being true the highlight lands on the wrong characters rather than
 * failing.
 */
export function highlight(body: string, query: string): string[] {
  const words = [...new Set(fold(query).split(/\s+/).filter(Boolean))];
  if (!words.length) return [body];
  const folded = fold(body);
  if (folded.length !== body.length) return [body];

  const hits: [number, number][] = [];
  for (const word of words) {
    let at = folded.indexOf(word);
    while (at !== -1) {
      hits.push([at, at + word.length]);
      at = folded.indexOf(word, at + word.length);
    }
  }
  if (!hits.length) return [body];
  hits.sort((a, b) => a[0] - b[0]);

  /* Overlapping hits merged, or two words that share letters produce runs that
   * slice each other in half and the output stops being the original text. */
  const runs: [number, number][] = [];
  for (const [from, to] of hits) {
    const last = runs[runs.length - 1];
    if (last && from <= last[1]) last[1] = Math.max(last[1], to);
    else runs.push([from, to]);
  }

  const parts: string[] = [];
  let cursor = 0;
  for (const [from, to] of runs) {
    parts.push(body.slice(cursor, from), body.slice(from, to));
    cursor = to;
  }
  parts.push(body.slice(cursor));
  return parts;
}

/** `just now`, `14 min`, `3 h`, `Tue`, `4 Mar`.
 *
 * ⚠️ A shape, not a timestamp. The list is read top to bottom and the question
 * is always "how long ago", never "at what time" — and a column of
 * `2026-09-15 16:04` is the same width for every row, so nothing in it draws
 * the eye to the one written this morning.
 */
export function noteWhen(written: number, now: number): string {
  const mins = Math.floor((now - written) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} h`;
  const date = new Date(written);
  const days = Math.floor(hours / 24);
  if (days < 7) return date.toLocaleDateString(undefined, { weekday: "short" });
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}
