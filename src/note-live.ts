/* The note as it will look, while you are writing it.
 *
 * ⚠️ **One renderer, three surfaces.** The wall, the sheet and the docked
 * drawer all draw a note, and before this each had its own copy of the walk —
 * so a note could legitimately look like three different notes. `render` is
 * that walk; `markersOf` is the way back.
 *
 * ⚠️ **The note is still stored as the text you typed.** This is a view of the
 * markers, not a replacement for them: `render` turns `**bold**` into a
 * `<strong>`, `markersOf` turns the `<strong>` back into `**bold**`, and what
 * lands in `notes.json` is characters. A file you can grep, paste anywhere and
 * read in Notepad is worth more than a document model, and a bug in here can
 * only make a note LOOK wrong.
 *
 * ⚠️ Which means the round trip NORMALISES, and that is the honest cost of
 * showing people their own writing instead of its source. `_italic_` comes
 * back as `*italic*`, a run of blank lines becomes one, a fence loses its
 * language, and a mark inside a mark loses the inner one — the parser cannot
 * express any of those, so a view built from it cannot either. It only ever
 * happens to a note somebody actually EDITED: opening one and leaving writes
 * nothing, because nothing calls this.
 */
import { blocks, type Block } from "./note-format";
import { element } from "./dom";

/* ── Text → elements ─────────────────────────────────────────────────── */

/** Draw a note into `host`, optionally lighting up a search term.
 *
 * ⚠️ Text nodes, never `innerHTML`. A note is arbitrary text pasted from
 * somewhere, and the one thing you must not do with that is hand it to
 * something that builds elements. */
export function render(host: HTMLElement, body: string, lit?: (text: string) => Node[]) {
  host.replaceChildren();
  const parsed = blocks(body);
  let list: HTMLElement | null = null;
  let fence: HTMLElement | null = null;

  for (const block of parsed) {
    if (block.kind === "bullet" || block.kind === "number") {
      fence = null;
      /* Consecutive bullets share one list, so the marker column lines up and
       * a gap between two of them is a gap rather than two lists. */
      const wanted = block.kind === "bullet" ? "ul" : "ol";
      if (!list || list.tagName.toLowerCase() !== wanted) {
        list = element(wanted as "ul", "note-list-block");
        if (block.kind === "number" && block.index && block.index !== 1) {
          (list as HTMLOListElement).start = block.index;
        }
        host.append(list);
      }
      const item = element("li", "");
      runs(item, block, lit);
      padEmpty(item);
      list.append(item);
      continue;
    }
    list = null;

    /* ⚠️ One `<pre>` for a run of fenced lines, not one per line. Each is its
     * own block out of the parser, and drawing them separately puts a margin
     * through the middle of a pasted command. */
    if (block.kind === "code") {
      if (!fence) {
        fence = element("pre", "note-code");
        host.append(fence);
      } else {
        fence.append(document.createTextNode("\n"));
      }
      runs(fence, block, lit);
      continue;
    }
    fence = null;

    const tag = block.kind === "head" ? "h4" : "p";
    const line = element(tag as "p", `note-${block.kind}`);
    if (block.kind === "head" && block.level && block.level !== 1) {
      line.dataset.level = String(block.level);
    }
    runs(line, block, lit);
    padEmpty(line);
    host.append(line);
  }
  if (!parsed.length) {
    const line = element("p", "note-para");
    padEmpty(line);
    host.append(line);
  }
}

/** A block with nothing in it needs somewhere for the caret to be.
 *
 * ⚠️ This is the single most load-bearing line in the editor. An empty
 * `<p></p>` has no line box, so a caret placed in one is not really anywhere:
 * Chromium answers the first keystroke by building a NEW paragraph beside it
 * and leaving the caret before both — which reads as every first letter of a
 * note jumping to the end of it, and as nothing you type afterwards obeying
 * the rules, because the caret is in no block at all. A `<br>` gives the line
 * somewhere to be. `inline` skips it again on the way out. */
function padEmpty(block: HTMLElement) {
  if ((block.textContent ?? "") === "") block.append(document.createElement("br"));
}

/** One block's runs. */
function runs(host: HTMLElement, block: Block, lit?: (text: string) => Node[]) {
  for (const span of block.spans) {
    const tag = span.code ? "code" : span.bold ? "strong"
      : span.italic ? "em" : span.strike ? "s" : "span";
    const run = element(tag as "span", "");
    /* ⚠️ The highlight is applied INSIDE a run, not over the line. Applied
     * over the line it would have to slice through the formatting and every
     * mark would have to be re-opened on the other side of a hit. */
    if (lit) run.append(...lit(span.text));
    else run.append(document.createTextNode(span.text));
    host.append(run);
  }
}

/* ── Elements → text ─────────────────────────────────────────────────── */

const MARK: Record<string, string> = {
  STRONG: "**", B: "**", EM: "*", I: "*", CODE: "`", S: "~~", STRIKE: "~~", DEL: "~~",
};

/** One element's contents, as markers.
 *
 * ⚠️ The OUTERMOST mark only. `**a *b* c**` is more than the parser can read
 * back, so a mark inside a mark keeps the one a reader would notice and drops
 * the other — rather than writing something that comes back as literal
 * asterisks in the middle of a bold run. */
function inline(node: Node, inside = false): string {
  let out = "";
  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      out += (child.nodeValue ?? "").replace(/\u200b/g, "");
      continue;
    }
    if (!(child instanceof HTMLElement)) continue;
    /* ⚠️ A `<br>` at the END of a block is the placeholder above, not a line
     * break somebody asked for. Counted as one, every empty line in a note
     * would grow another every time it was opened. */
    if (child.tagName === "BR") {
      if (child.nextSibling) out += "\n";
      continue;
    }
    const marker = MARK[child.tagName];
    if (marker && !inside) {
      const text = inline(child, true);
      /* ⚠️ A marker may not touch a space on the inside, or the parser reads
       * it as literal punctuation and the run comes back showing asterisks.
       * The spaces go OUTSIDE the markers, where they read the same. */
      const bare = text.trim();
      if (!bare) { out += text; continue; }
      const before = text.slice(0, text.length - text.trimStart().length);
      const after = text.slice(text.trimEnd().length);
      out += `${before}${marker}${bare}${marker}${after}`;
      continue;
    }
    out += inline(child, inside);
  }
  return out;
}

/** What is on screen, as the text that would produce it.
 *
 * ⚠️ Walks the TOP level only for block structure, and recurses for runs. A
 * `contenteditable` will happily nest a list inside a list item if somebody
 * presses Tab; the parser has no nesting, so a nested list is flattened rather
 * than written as something that cannot be read back. */
export function markersOf(host: HTMLElement): string {
  const lines: string[] = [];
  let last = "";

  const push = (line: string, kind: string) => {
    /* A blank line between two paragraphs, because that is how prose is
     * written and a note pasted in with gaps should keep them. Everything else
     * — list items, quoted lines, headings — runs on. */
    if (kind === "para" && last === "para") lines.push("");
    lines.push(line);
    last = kind;
  };

  const block = (node: HTMLElement) => {
    const tag = node.tagName;
    if (tag === "UL" || tag === "OL") {
      const start = tag === "OL" ? Number((node as HTMLOListElement).start) || 1 : 0;
      let at = 0;
      for (const item of node.children) {
        if (!(item instanceof HTMLElement) || item.tagName !== "LI") continue;
        /* A list nested inside an item is drawn out as its own items. */
        const nested = [...item.children].filter(one =>
          one instanceof HTMLElement && (one.tagName === "UL" || one.tagName === "OL"));
        const text = inline(item).trim();
        if (text) push(start ? `${start + at}. ${text}` : `- ${text}`, "list");
        at += text ? 1 : 0;
        for (const one of nested) block(one as HTMLElement);
      }
      return;
    }
    if (tag === "PRE") {
      lines.push("```");
      for (const line of (node.textContent ?? "").split("\n")) lines.push(line);
      lines.push("```");
      last = "code";
      return;
    }
    if (node.classList.contains("note-quote")) {
      const text = inline(node).trim();
      push(text ? `> ${text}` : ">", "quote");
      return;
    }
    if (/^H[1-6]$/.test(tag) || node.classList.contains("note-head")) {
      const level = Number(node.dataset.level) || (/^H([1-6])$/.exec(tag)?.[1]
        ? Math.min(3, Number(/^H([1-6])$/.exec(tag)![1])) : 1);
      const text = inline(node).trim();
      if (text) push(`${"#".repeat(Math.min(3, Math.max(1, level)))} ${text}`, "head");
      return;
    }
    /* Anything else is a paragraph — including the bare `<div>` a browser
     * makes when Enter is pressed, which is why this is the fallback rather
     * than a test for `<p>`. */
    for (const part of inline(node).split("\n")) push(part, "para");
  };

  for (const child of host.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      const text = (child.nodeValue ?? "").trim();
      if (text) push(text, "para");
      continue;
    }
    if (child instanceof HTMLElement) block(child);
  }
  /* ⚠️ Trailing blanks trimmed, leading ones kept off. An empty editor is an
   * empty note, and an empty note deletes itself — so this must come out as
   * exactly "" rather than as a newline. */
  return lines.join("\n")
    .replace(/[\u200b\ufeff]/g, "")
    .replace(/\u00a0/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}


/* ── Typing markers turns them into what they mean ───────────────────────
 *
 * ⚠️ Without this the editor is only styled for notes it did not write. You
 * type `- milk` and get the characters `- milk`; it becomes a bullet the next
 * time the note is opened, which is worse than never — text that rearranges
 * itself while you are not looking is text you stop trusting.
 *
 * ⚠️ It fires only at the END of a block, and that is a deliberate limit
 * rather than a shortcut. Re-parsing a block rebuilds its elements, so the
 * caret has to be put back afterwards — and "at the end of what I just typed"
 * is the one position that survives any rebuild. Typing a marker into the
 * middle of an existing line leaves it as characters until the note is next
 * opened, which is the same as every editor of this shape.
 */

/** The block the caret is in: an item, or a direct child of the editor.
 *
 * ⚠️ Text typed straight into the editor is WRAPPED rather than ignored. A
 * `contenteditable` will happily hold a bare text node at its top level — that
 * is what you get if the caret is put at the end of the editor rather than
 * inside its last paragraph — and a caret sitting in one has no block, so
 * every rule silently stopped firing. The wrap is also what keeps `markersOf`
 * and the renderer looking at the same shape. */
function blockOf(host: HTMLElement, node: Node | null, offset = 0): HTMLElement | null {
  let at: Node | null = node;
  if (at === host) at = host.childNodes[Math.max(0, offset - 1)] ?? host.lastChild;
  while (at && at !== host) {
    if (at instanceof HTMLElement && (at.tagName === "LI" || at.parentElement === host)) {
      return at;
    }
    if (at.nodeType === Node.TEXT_NODE && at.parentNode === host) {
      const line = element("p", "note-para");
      host.replaceChild(line, at);
      line.append(at);
      return line;
    }
    at = at.parentNode;
  }
  return null;
}

/** Whether the caret sits after the last character of `block`. */
function atEnd(block: HTMLElement, node: Node, offset: number): boolean {
  const range = document.createRange();
  range.selectNodeContents(block);
  range.setStart(node, offset);
  return range.toString().length === 0;
}

/** An element's markup with the trailing whitespace taken off the end of its
 *  last piece of text.
 *
 * ⚠️ This is what makes typing a space safe. The parser trims the end of every
 * line — it has to, or a stray space changes what a line means — so the moment
 * somebody types one, what the text PARSES to no longer matches what is on
 * screen, and the block gets redrawn without the space they just typed. Every
 * word would lose the space after it. Comparing both sides with the tail taken
 * off asks the only question that matters: has the MARKUP changed. */
function bareHtml(el: Element): string {
  const copy = el.cloneNode(true) as Element;
  const walk = document.createTreeWalker(copy, NodeFilter.SHOW_TEXT);
  let last: Text | null = null;
  while (walk.nextNode()) last = walk.currentNode as Text;
  /* ⚠️ The zero-width space goes with the whitespace. It is the caret's
   * foothold outside a mark (see `caretToTail`) — on the screen but not in
   * the note. Counted as content, the block would read as changed the moment
   * one appeared, and the space typed after `**bold**` would be redrawn
   * away. */
  if (last) last.nodeValue = (last.nodeValue ?? "").replace(/[\s\u00a0\u200b]+$/, "");
  return copy.innerHTML;
}

/** Put the caret at the end of the note.
 *
 * ⚠️ Inside the last BLOCK, not at the end of the editor. At the editor's own
 * level the caret belongs to no block, so the first thing typed lands in a
 * bare text node — and every rule that reads "the block the caret is in" has
 * nothing to read. */
export function caretToEnd(host: HTMLElement) {
  caretTo(host.lastElementChild ?? host);
}

/** Put the caret after the runs in `block`, outside any mark.
 *
 * ⚠️ A caret parked at the end of a `<strong>` inherits its style, so the next
 * word typed after `**milk**` came out bold too — the rule fired, the markers
 * vanished, and everything after them joined the run they were supposed to
 * close. The zero-width space is a foothold OUTSIDE the mark for the caret to
 * stand in; one keystroke later the block is redrawn and it is gone. Nothing
 * that reads a note ever sees it. */
function caretToTail(block: HTMLElement) {
  const last = block.lastChild;
  if (!(last instanceof HTMLElement) || !MARK[last.tagName]) { caretTo(block); return; }
  const tail = document.createTextNode("\u200b");
  block.append(tail);
  const range = document.createRange();
  range.setStart(tail, 1);
  range.collapse(true);
  const chosen = window.getSelection();
  chosen?.removeAllRanges();
  chosen?.addRange(range);
}

/** Put the caret at the end of `node`. */
function caretTo(node: Node) {
  const range = document.createRange();
  range.selectNodeContents(node);
  range.collapse(false);
  const chosen = window.getSelection();
  chosen?.removeAllRanges();
  chosen?.addRange(range);
}

/** Re-read the block the caret is in, and redraw it if it now means something
 *  else. Returns whether anything changed. */
function digest(host: HTMLElement): boolean {
  const chosen = window.getSelection();
  if (!chosen?.rangeCount) return false;
  const range = chosen.getRangeAt(0);
  if (!range.collapsed) return false;
  const block = blockOf(host, range.startContainer, range.startOffset);
  if (!block || !atEnd(block, range.startContainer, range.startOffset)) return false;

  /* ⚠️ The placeholder goes the moment the block has words. Left in, it stops
   * being trailing — so `inline` reads it as a line break, and a heading with
   * one letter typed into it parses as a newline followed by a paragraph. */
  if ((block.textContent ?? "") !== "") {
    for (const stray of [...block.querySelectorAll("br")]) stray.remove();
  }
  const text = inline(block);
  if (!text.trim()) return false;

  /* ⚠️ A line that is JUST a marker and the space after it needs a letter
   * lending to it. The parser trims every line before reading it — it has to,
   * or a stray space at the end changes what a line means — so `# ` parses as
   * the character `#` and `- ` as the character `-`, and the one moment a
   * marker is supposed to take effect is the moment nothing follows it yet.
   * The letter is taken back off below. */
  const opening = /^\s*(#{1,3}|[-*•]|\d{1,3}[.)]|>)[ \u00a0]$/.test(text);
  const temp = document.createElement("div");
  render(temp, opening ? `${text}x` : text);
  const made = temp.firstElementChild;
  if (!made || temp.children.length !== 1) return false;
  if (opening) {
    const walk = document.createTreeWalker(made, NodeFilter.SHOW_TEXT);
    let last: Text | null = null;
    while (walk.nextNode()) last = walk.currentNode as Text;
    if (!last) return false;
    last.nodeValue = (last.nodeValue ?? "").slice(0, -1);
  }

  const list = made.tagName === "UL" || made.tagName === "OL";
  /* The element whose children are the runs — the item inside a list, or the
   * block itself. */
  const inner = list ? made.firstElementChild : made;
  if (!inner) return false;

  /* ⚠️ A block whose marker has already been EATEN keeps its shape. An item,
   * a heading and a quoted line all carry their marker in the element rather
   * than in the text — `<li>milk</li>` holds no dash — so re-reading the text
   * says "paragraph" every time, and taking that literally turned a heading
   * back into a paragraph on the first letter typed into it. The parse may add
   * structure here; it may never take it away. */
  const marked = block.tagName === "LI"
    || block.classList.contains("note-head")
    || block.classList.contains("note-quote");

  if (marked && !list) {
    if (bareHtml(block) === bareHtml(made)) return false;
    block.replaceChildren(...made.childNodes);
    padEmpty(block);
    caretToTail(block);
    return true;
  }
  /* An item that has grown a second marker: `- ` typed inside a bullet. What
   * the parse gives back is the item's RUNS, never its shape. */
  if (block.tagName === "LI") {
    if (bareHtml(block) === bareHtml(inner)) return false;
    block.replaceChildren(...inner.childNodes);
    padEmpty(block);
    caretToTail(block);
    return true;
  }

  /* A paragraph that has become a list item joins the list above it rather
   * than starting a second one — or every bullet is its own list and a
   * numbered one restarts at each line. */
  if (list) {
    const before = block.previousElementSibling;
    const item = made.firstElementChild;
    if (!item) return false;
    if (before && before.tagName === made.tagName) {
      before.append(item);
      block.remove();
    } else {
      block.replaceWith(made);
    }
    padEmpty(item as HTMLElement);
    caretTo(item);
    return true;
  }

  /* ⚠️ `DIV` counts as a paragraph. A browser makes one of those when Enter
   * is pressed, and treating it as a different shape from `<p>` would rebuild
   * the block on every keystroke for no visible change. */
  const same = (tag: string) => (tag === "DIV" ? "P" : tag);
  if (same(block.tagName) === same(made.tagName)
    && (block.dataset.level ?? "") === ((made as HTMLElement).dataset.level ?? "")) {
    if (bareHtml(block) === bareHtml(made)) return false;
    block.replaceChildren(...made.childNodes);
    padEmpty(block);
    caretToTail(block);
    return true;
  }
  block.replaceWith(made);
  padEmpty(made as HTMLElement);
  caretTo(made);
  return true;
}

/* ── The editable surface ────────────────────────────────────────────── */

/** Turn a host into the note, editable in place.
 *
 * ⚠️ There is no "edit mode". The thing on screen IS the note and IS the
 * field: you put the caret in a word and type. A view you have to press to
 * turn into an editor is one press between a thought and writing it down,
 * every time, and it is the reason the last version of this screen was a
 * preview with a box underneath. */
export function editable(host: HTMLElement, body: string, changed: () => void) {
  host.contentEditable = "true";
  host.spellcheck = false;
  host.setAttribute("role", "textbox");
  host.setAttribute("aria-multiline", "true");
  render(host, body);

  /* ⚠️ `styleWithCSS` OFF. With it on, Chromium writes bold as
   * `<span style="font-weight:700">` — which `markersOf` does not know, so the
   * word would look bold until it was saved and then quietly come back plain.
   * Off, it writes `<b>`, which is a tag with a meaning. */
  try {
    document.execCommand("styleWithCSS", false, "false");
    document.execCommand("defaultParagraphSeparator", false, "p");
  } catch { /* an older engine; the serialiser copes with div either way */ }

  /* ⚠️ Paste is PLAIN TEXT, always. What gets pasted into a note is a web
   * page as often as it is a sentence, and a contenteditable takes the lot —
   * tables, images, fonts, scripts. The markers are the only formatting this
   * understands, so the only safe paste is the text. */
  host.addEventListener("paste", event => {
    event.preventDefault();
    const text = event.clipboardData?.getData("text/plain") ?? "";
    if (text) document.execCommand("insertText", false, text);
  });
  host.addEventListener("drop", event => event.preventDefault());
  host.addEventListener("input", () => {
    /* ⚠️ Before the caller is told. `digest` can rebuild the block the caret
     * is in, and the caller's first move is to read the markers back out of
     * it — reading before the rewrite would store the version with the
     * markers still in it, and the next redraw would parse them twice. */
    tidy(host);
    digest(host);
    changed();
  });
}

/** Lift a list back out of whatever the browser buried it in.
 *
 * ⚠️ `insertUnorderedList` on a paragraph that holds a run leaves
 * `<p><ul><li>…</li></ul></p>` — a list inside a paragraph, which is not legal
 * HTML and, worse, is not a list as far as `markersOf` is concerned: the walk
 * sees a paragraph at the top level and reads straight through it, so pressing
 * the list button stored an ordinary line. The list has to be a child of the
 * editor before anything reads it back. */
function tidy(host: HTMLElement) {
  for (const list of [...host.querySelectorAll("ul, ol")]) {
    let parent = list.parentElement;
    while (parent && parent !== host && parent.tagName !== "LI") {
      parent.after(list);
      if (!(parent.textContent ?? "").trim()) parent.remove();
      parent = list.parentElement;
    }
  }
}

/** Bold, italic, code or a list, on the selection. */
export function mark(host: HTMLElement, what: "bold" | "italic" | "list" | "code") {
  host.focus();
  if (what === "list") {
    document.execCommand("insertUnorderedList");
    tidy(host);
    return;
  }
  if (what !== "code") { document.execCommand(what); return; }

  /* No browser command makes a `<code>`, so this is done by hand. ⚠️ Through
   * the range rather than `insertHTML`, so what ends up inside is whatever was
   * selected — text nodes and all — and never a string somebody's note was
   * turned into. */
  const chosen = window.getSelection();
  const range = chosen?.rangeCount ? chosen.getRangeAt(0) : null;
  if (!range) return;
  const box = document.createElement("code");
  try {
    if (range.collapsed) {
      box.append(document.createTextNode("​"));
      range.insertNode(box);
    } else {
      box.append(range.extractContents());
      range.insertNode(box);
    }
  } catch { return; }
  const after = document.createRange();
  after.selectNodeContents(box);
  chosen?.removeAllRanges();
  chosen?.addRange(after);
}
