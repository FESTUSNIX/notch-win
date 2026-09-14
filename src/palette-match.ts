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

function boundary(before: string): boolean {
  return before === " " || before === "-" || before === "_" || before === "." ||
    before === "/" || before === "\\" || before === ":";
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
  return { score: total / (1 + text.length / 64), hits };
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
