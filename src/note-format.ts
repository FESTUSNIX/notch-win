/* Just enough formatting for a note.
 *
 * ⚠️ **The note is stored as the text you typed**, never as HTML and never as
 * a document model. Markers in the body are the whole format: it stays
 * greppable, it survives being pasted somewhere else, and a bug in here can
 * only ever make a note *look* wrong — never lose a word of it. Anything that
 * parses on the way IN owns your writing; this parses on the way out.
 *
 * ⚠️ And the output is a STRUCTURE, not a string of HTML. A note is arbitrary
 * text pasted from somewhere, and the one thing you must not do with that is
 * hand it to a parser that builds elements. The screen walks this and creates
 * text nodes.
 *
 * The subset is deliberately small — the useful half of Markdown and nothing
 * that needs a second pass: `**bold**`, `*italic*`, `` `code` ``, `~~strike~~`,
 * `- ` and `1. ` lists, `> ` quotes and `# ` headings.
 */

export interface Span {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  strike?: boolean;
}

export type BlockKind = "para" | "head" | "bullet" | "number" | "quote" | "code";

export interface Block {
  kind: BlockKind;
  spans: Span[];
  /** The number a `1.` line asked for, so a list starting at 3 starts at 3. */
  index?: number;
}

/** Every marker, in one pass, longest first.
 *
 * ⚠️ `**` before `*`, or `**bold**` matches as two empty italics. Order in an
 * alternation is order of preference, and this is the whole reason it is one
 * regex rather than four passes.
 *
 * ⚠️ The content may not begin or end with a space. Without that, `5 * 3 * 2`
 * is an italic run and a sum becomes a sentence in italics — which is exactly
 * the sort of note this is for.
 */
const INLINE = /(\*\*|~~|[*_`])(?!\s)((?:(?!\1).)+?)(?<!\s)\1/;

const MARKS: Record<string, keyof Span> = {
  "**": "bold",
  "*": "italic",
  _: "italic",
  "`": "code",
  "~~": "strike",
};

/** One line of text, split into runs.
 *
 * ⚠️ Recursive on the tail only, never on the content. Nesting `**a *b* c**`
 * is more than this needs and every attempt at it grows a state machine; a
 * single depth covers what anybody types in a note, and the markers that are
 * left over are shown as the characters they are rather than eaten.
 */
export function spans(line: string): Span[] {
  const out: Span[] = [];
  let rest = line;
  for (;;) {
    const hit = INLINE.exec(rest);
    if (!hit || hit.index === undefined) break;
    const [whole, marker, inner] = hit;
    if (hit.index > 0) out.push({ text: rest.slice(0, hit.index) });
    /* ⚠️ Code is literal all the way down. `` `**not bold**` `` is a person
     * showing you the characters, and formatting them there is the one failure
     * that makes the feature useless for the thing it is most used for. */
    out.push({ text: inner, [MARKS[marker]]: true });
    rest = rest.slice(hit.index + whole.length);
  }
  if (rest) out.push({ text: rest });
  return out.length ? out : [{ text: "" }];
}

/** A note, as blocks.
 *
 * ⚠️ Blank lines separate blocks and are not blocks themselves. A note is
 * written with gaps in it, and a paragraph of nothing drawn for each one is
 * how a five-line note becomes a screen tall.
 */
export function blocks(body: string): Block[] {
  const out: Block[] = [];
  let fenced = false;
  for (const raw of body.split("\n")) {
    const line = raw.trimEnd();

    /* ⚠️ A fence toggles, and everything inside is taken literally — including
     * the markers. Somebody pasting a shell command wants to see it. */
    if (line.trimStart().startsWith("```")) {
      fenced = !fenced;
      continue;
    }
    if (fenced) {
      out.push({ kind: "code", spans: [{ text: raw }] });
      continue;
    }
    if (!line.trim()) continue;

    const head = /^(#{1,3})\s+(.*)$/.exec(line);
    if (head) { out.push({ kind: "head", spans: spans(head[2]) }); continue; }

    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    if (bullet) { out.push({ kind: "bullet", spans: spans(bullet[1]) }); continue; }

    const numbered = /^\s*(\d{1,3})[.)]\s+(.*)$/.exec(line);
    if (numbered) {
      out.push({ kind: "number", spans: spans(numbered[2]), index: Number(numbered[1]) });
      continue;
    }

    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) { out.push({ kind: "quote", spans: spans(quote[1]) }); continue; }

    out.push({ kind: "para", spans: spans(line) });
  }
  return out;
}

/** The note with every marker taken off, for searching and for the row title.
 *
 * ⚠️ Search runs on THIS, not on the raw body. Otherwise `**every**` is found
 * by typing `**every**` and not by typing `every`, which is the one query
 * anybody would use.
 */
export function plain(body: string): string {
  return blocks(body)
    .map(block => block.spans.map(span => span.text).join(""))
    .join("\n");
}

/** Wrap the selection in a marker, or unwrap it if it is already wrapped.
 *
 * Returns the new text and where the selection should end up, so the caller
 * can put the caret back — a formatting button that leaves the caret at the
 * end of the note is a button you use once.
 */
export function toggleMark(
  body: string,
  from: number,
  to: number,
  marker: string,
): { body: string; from: number; to: number } {
  const chosen = body.slice(from, to);
  const before = body.slice(0, from);
  const after = body.slice(to);

  // Already wrapped, just outside the selection: take it off.
  if (before.endsWith(marker) && after.startsWith(marker)) {
    return {
      body: before.slice(0, -marker.length) + chosen + after.slice(marker.length),
      from: from - marker.length,
      to: to - marker.length,
    };
  }
  // Already wrapped, inside the selection: take it off.
  if (chosen.length > marker.length * 2
    && chosen.startsWith(marker) && chosen.endsWith(marker)) {
    const inner = chosen.slice(marker.length, -marker.length);
    return { body: before + inner + after, from, to: from + inner.length };
  }
  /* ⚠️ An empty selection puts the caret BETWEEN the markers, not after them.
   * Pressing bold and then typing is what everybody does, and markers with the
   * caret behind them produce `**` followed by unbolded words. */
  return {
    body: `${before}${marker}${chosen}${marker}${after}`,
    from: from + marker.length,
    to: to + marker.length,
  };
}

/** Put `- ` on each selected line, or take it off if every line has it. */
export function toggleList(
  body: string,
  from: number,
  to: number,
): { body: string; from: number; to: number } {
  const start = body.lastIndexOf("\n", from - 1) + 1;
  const endBreak = body.indexOf("\n", to);
  const end = endBreak === -1 ? body.length : endBreak;
  const lines = body.slice(start, end).split("\n");
  const marked = lines.every(line => /^\s*[-*•]\s+/.test(line) || !line.trim());
  const next = lines
    .map(line => {
      if (!line.trim()) return line;
      return marked ? line.replace(/^(\s*)[-*•]\s+/, "$1") : `- ${line}`;
    })
    .join("\n");
  const body2 = body.slice(0, start) + next + body.slice(end);
  const shift = next.length - (end - start);
  return { body: body2, from: start, to: Math.max(start, to + shift) };
}
