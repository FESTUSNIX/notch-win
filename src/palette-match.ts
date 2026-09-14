/* Matching what you typed against what there is.
 *
 * Pure, and kept in its own file for one reason: it is the only part of the
 * palette that can be wrong in a way you would not notice. A ranking that is
 * merely *mediocre* still returns results, so it never looks broken — it just
 * quietly puts the thing you wanted third every time, and the palette stops
 * being faster than clicking. So it is testable without a DOM.
 */

/** A subsequence match, with the score carrying why it was a good one. */
export interface Match {
  score: number;
  /** Indices in the haystack that were matched, for highlighting. */
  hits: number[];
}

/* Scoring is deliberately blunt: a few large bonuses rather than many small
 * ones, so the order is explicable. "Why is that first?" should have a one
 * sentence answer. */
const START = 120;   // the match begins at the very start
const WORD = 45;     // a character right after a space, dash, dot or slash
const RUN = 22;      // immediately after the previous match
const CASE = 6;      // the typed case matched exactly

/* ── How WELL it matched, as opposed to where ─────────────────────────────
 *
 * The four above describe the shape of a subsequence match and are diluted by
 * length; these four describe the KIND of match and are not. They are big
 * enough to cross a band (see TIER in palette.ts), and that is deliberate.
 *
 * ⚠️ This is what the bands got wrong on their own. Typing `hero` put
 * "Hide the chrome" — a perfectly real subsequence match, in the island band —
 * above a folder actually called `hero`, because the band was a sort key and
 * nothing could outrank it. A band should be a preference between things that
 * match about as well, never a reason to bury the thing you named. */
const EXACT = 400;     // the title IS what you typed
const PREFIX = 150;    // `bra` -> Brave
const INITIALS = 110;  // `vsc` -> Visual Studio Code
const RUNON = 80;      // the query appears whole, somewhere inside

function boundary(before: string): boolean {
  return before === " " || before === "-" || before === "_" || before === "." ||
    before === "/" || before === "\\" || before === ":";
}

/** The first letter of each word: "Visual Studio Code" -> "vsc".
 *
 * ⚠️ How people actually type an application's name, and a plain
 * subsequence match scores it terribly — the letters are scattered across the
 * whole string, so length normalisation buries it under anything shorter. */
function initials(text: string): string {
  let out = "";
  let fresh = true;
  for (const char of text) {
    if (boundary(char)) { fresh = true; continue; }
    if (fresh) { out += char.toLowerCase(); fresh = false; }
  }
  return out;
}

/**
 * Score `query` against `text`, or `null` if the characters are not all there
 * in order.
 *
 * ⚠️ Subsequence, not substring. "ctk" has to find "Create task" or the
 * palette is a filter rather than a launcher — and the whole reason to type
 * instead of clicking is that three letters get you there.
 *
 * ⚠️ Greedy, left to right, and that is a deliberate limit rather than an
 * oversight. The optimal alignment needs backtracking; for strings this short
 * the difference is invisible and the cost is a function nobody can follow.
 */
export function score(text: string, query: string): Match | null {
  if (!query) return { score: 0, hits: [] };
  const lower = text.toLowerCase();
  const wanted = query.toLowerCase();

  let at = 0;
  let total = 0;
  let previous = -2;
  const hits: number[] = [];

  for (let i = 0; i < wanted.length; i++) {
    const found = lower.indexOf(wanted[i], at);
    if (found === -1) return null;
    hits.push(found);

    if (found === 0) total += START;
    else if (boundary(text[found - 1])) total += WORD;
    if (found === previous + 1) total += RUN;
    if (text[found] === query[i]) total += CASE;

    previous = found;
    at = found + 1;
  }

  /* Shorter is better when the score ties: "Media" should beat "Immediately"
   * for "med". Divided rather than subtracted so a long title with a genuinely
   * strong match still wins over a short weak one. */
  let out = total / (1 + text.length / 64);

  /* ⚠️ Added AFTER the normalisation, on purpose. These say what kind of
   * match this is, and that does not become less true because the title is
   * long: `Visual Studio Code` is still exactly what was typed. Diluting them
   * by length is what let a short accidental match outrank a deliberate one. */
  if (lower === wanted) out += EXACT;
  else if (lower.startsWith(wanted)) out += PREFIX;
  if (wanted.length > 1 && initials(text).startsWith(wanted)) out += INITIALS;
  if (lower.includes(wanted)) out += RUNON;

  return { score: out, hits };
}

export interface Rankable {
  title: string;
  /** Searched as well as the title, but worth less — a group name or a note
   *  matching is a weaker reason than the name matching. */
  keywords?: string;
}

/** Best of the title and the keywords, keeping whichever won. */
export function rank<T extends Rankable>(item: T, query: string): { item: T; match: Match } | null {
  const title = score(item.title, query);
  if (title) return { item, match: title };
  if (!item.keywords) return null;
  const alias = score(item.keywords, query);
  // ⚠️ Halved, and the hits are dropped: they index the keywords, not the
  // title, and highlighting the title with them lights up the wrong letters.
  return alias ? { item, match: { score: alias.score / 2, hits: [] } } : null;
}

/**
 * Everything that matches, best first. Stable within a score so a list does not
 * reshuffle as you type a character that changes nothing.
 *
 * `boost` adds to each item's score — recency, in practice. It applies to the
 * EMPTY query too, and that is the case it was added for: with nothing typed
 * every score is zero, so the order was provider declaration order, which is
 * the state the palette is in every time it opens and the one nobody designed.
 */
export function search<T extends Rankable>(
  items: T[],
  query: string,
  limit = 12,
  boost: (item: T) => number = () => 0,
): { item: T; match: Match }[] {
  if (!query.trim()) {
    return items
      .map(item => ({ item, match: { score: boost(item), hits: [] as number[] } }))
      .sort((a, b) => b.match.score - a.match.score)
      .slice(0, limit);
  }
  return items
    .map(item => rank(item, query))
    .filter((hit): hit is { item: T; match: Match } => hit !== null)
    .map(hit => ({ item: hit.item, match: { ...hit.match, score: hit.match.score + boost(hit.item) } }))
    .sort((a, b) => b.match.score - a.match.score)
    .slice(0, limit);
}
