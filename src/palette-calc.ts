/* The arithmetic line.
 *
 * The one thing a launcher gets used for that has nothing to do with launching:
 * you want `1900 * 56/117` and you do not want to leave what you are in to get
 * it. Half this codebase is frame-pixel arithmetic, so it earns its place here
 * more than most.
 *
 * ⚠️ A parser, not `eval`. Not because the string is hostile — you typed it —
 * but because `eval` answers questions nobody asked: `alert` is a valid
 * expression, so is a property access on `window`, and an accident becomes a
 * side effect rather than a red result. A grammar this small is twenty lines
 * and cannot do anything but arithmetic.
 *
 * ⚠️ And it is deliberately picky about what it will even try. Anything that
 * parses gets a result row at the top of the palette, so a grammar that says
 * yes to `2` or to a bare word would put a useless row above the thing you were
 * actually searching for. It wants a digit and an operator.
 */

type Token =
  | { kind: "number"; value: number }
  | { kind: "percent"; value: number }
  | { kind: "op"; value: string };

const OPS = "+-*/^()";

/** `1_000`, `3.5`, `20%`. Commas are NOT a thousands separator here — on a
 *  Polish keyboard a comma is the decimal point, and guessing wrong turns
 *  `1,5` into fifteen. */
function tokenise(text: string): Token[] | null {
  const out: Token[] = [];
  let at = 0;
  while (at < text.length) {
    const char = text[at];
    if (char === " ") { at++; continue; }
    if (OPS.includes(char)) { out.push({ kind: "op", value: char }); at++; continue; }
    if (text.startsWith("of", at) && !/[a-z0-9]/i.test(text[at + 2] ?? "")) {
      out.push({ kind: "op", value: "*" });
      at += 2;
      continue;
    }
    if (/[0-9.]/.test(char)) {
      let run = "";
      while (at < text.length && /[0-9._]/.test(text[at])) { run += text[at]; at++; }
      const value = Number(run.replace(/_/g, ""));
      if (!Number.isFinite(value)) return null;
      if (text[at] === "%") { at++; out.push({ kind: "percent", value }); }
      else out.push({ kind: "number", value });
      continue;
    }
    return null;
  }
  return out;
}

/* ⚠️ No constructor parameter properties in this file or in
 * palette-recent.ts. The node tests import the `.ts` directly and Node strips
 * types rather than compiling them, so `constructor(private tokens: Token[])`
 * is a hard `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` at import — the whole test file
 * fails to load, and the error names the syntax rather than the reason. Files
 * only the bundler sees may use them; the ones with node tests may not. */
class Reader {
  at = 0;
  private tokens: Token[];
  constructor(tokens: Token[]) { this.tokens = tokens; }
  peek(): Token | undefined { return this.tokens[this.at]; }
  eat(value: string): boolean {
    const token = this.peek();
    if (token?.kind === "op" && token.value === value) { this.at++; return true; }
    return false;
  }
  done(): boolean { return this.at >= this.tokens.length; }
}

/** A value, and whether it was written as a bare percentage — which is what
 *  makes `90 + 15%` mean 103.5 rather than 90.15. */
interface Value { n: number; pct: boolean }

function atom(r: Reader): Value | null {
  if (r.eat("(")) {
    const inner = expr(r);
    if (!inner || !r.eat(")")) return null;
    return { n: inner.n, pct: false };
  }
  if (r.eat("-")) {
    const inner = atom(r);
    return inner ? { n: -inner.n, pct: inner.pct } : null;
  }
  const token = r.peek();
  if (token?.kind === "number") { r.at++; return { n: token.value, pct: false }; }
  if (token?.kind === "percent") { r.at++; return { n: token.value / 100, pct: true }; }
  return null;
}

/** Right-associative, the way every calculator and every language that has it
 *  does: `2^3^2` is 512, not 64. */
function power(r: Reader): Value | null {
  const base = atom(r);
  if (!base) return null;
  if (!r.eat("^")) return base;
  const exponent = power(r);
  return exponent ? { n: base.n ** exponent.n, pct: false } : null;
}

function term(r: Reader): Value | null {
  let left = power(r);
  if (!left) return null;
  for (;;) {
    if (r.eat("*")) {
      const right = power(r);
      if (!right) return null;
      left = { n: left.n * right.n, pct: false };
    } else if (r.eat("/")) {
      const right = power(r);
      if (!right) return null;
      left = { n: left.n / right.n, pct: false };
    } else return left;
  }
}

function expr(r: Reader): Value | null {
  let left: Value | null = term(r);
  if (!left) return null;
  for (;;) {
    const plus = r.eat("+");
    const minus = !plus && r.eat("-");
    if (!plus && !minus) return left;
    const right = term(r);
    if (!right) return null;
    /* ⚠️ `90 + 15%` is 103.5, not 90.15. A percentage added to something means
     * a percentage OF that something — which is the only reading anyone means
     * when they type it, and getting it wrong is worse than not offering it. */
    const amount: number = right.pct ? left.n * right.n : right.n;
    left = { n: plus ? left.n + amount : left.n - amount, pct: false };
  }
}

/** Grouped for reading. The raw value is what gets copied — `1,234` pasted
 *  into anything that wanted a number is a small betrayal. */
export function format(value: number): string {
  const rounded = Number(value.toPrecision(12));
  if (!Number.isFinite(rounded)) return "";
  return rounded.toLocaleString("en-US", { maximumFractionDigits: 10 });
}

export interface Sum {
  /** Grouped, for the row. */
  text: string;
  /** Plain, for the clipboard. */
  value: string;
}

/**
 * The answer, or `null` when the line is not arithmetic.
 *
 * ⚠️ An operator is required. Without that, every bare number typed on the way
 * to something else — a port, a year, a task called "2026" — grows a result row
 * above the thing being searched for.
 */
export function calc(text: string): Sum | null {
  const line = text.trim().toLowerCase();
  if (!line || !/[0-9]/.test(line)) return null;
  if (!/[+\-*/^%]|\bof\b/.test(line)) return null;
  const tokens = tokenise(line);
  if (!tokens) return null;
  const reader = new Reader(tokens);
  const value = expr(reader);
  if (!value || !reader.done() || !Number.isFinite(value.n)) return null;
  const rounded = Number(value.n.toPrecision(12));
  return { text: format(value.n), value: String(rounded) };
}
