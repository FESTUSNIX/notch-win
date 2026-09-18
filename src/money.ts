/* `120 usd to pln`, in the palette.
 *
 * The second thing a launcher gets used for that has nothing to do with
 * launching — the first being arithmetic, which is already here. Every
 * invoice, every price on an American website and every "is that cheap?"
 * about a train ticket is this question, and the alternative is a browser tab
 * that wants cookie consent first.
 *
 * ⚠️ Parsed, not guessed. Anything that parses puts a row at the TOP of the
 * palette, so a grammar that says yes to a bare number or to the word "in"
 * would bury whatever was actually being searched for. It wants an amount, a
 * currency it knows, and a second currency it knows.
 *
 * ⚠️ The rates are one table against the euro — see `money.rs` — so every pair
 * is two divisions done here. Asking a service per pair would be a request per
 * keystroke for arithmetic that is a multiplication.
 */

/** What the table from `money.rs` looks like once it is in the page. */
export interface Rates {
  /** The day the table is FOR, `2026-09-17`. Not the day it was fetched. */
  date: string;
  /** What the rates are quoted against — `EUR`. */
  base: string;
  rates: Record<string, number>;
}

export interface Money {
  amount: number;
  from: string;
  to: string;
}

/** Symbols worth knowing, and the ones deliberately left out.
 *
 * ⚠️ `kr` is NOT here. It is the krona, the krone and the króna — Sweden,
 * Norway, Denmark and Iceland — and a converter that silently picks one of
 * four is worse than one that says it does not know the word. Same for `$`
 * alone being every dollar there is: it is taken as the American one because
 * that is what a price on a website means nine times in ten, and the code is
 * always there for the tenth.
 */
const SYMBOLS: Record<string, string> = {
  "$": "USD", "usd": "USD", "dollar": "USD", "dollars": "USD",
  "€": "EUR", "eur": "EUR", "euro": "EUR", "euros": "EUR",
  "£": "GBP", "gbp": "GBP", "pound": "GBP", "pounds": "GBP", "quid": "GBP",
  "zł": "PLN", "zl": "PLN", "pln": "PLN", "złoty": "PLN", "zloty": "PLN",
  "¥": "JPY", "jpy": "JPY", "yen": "JPY",
  "₹": "INR", "inr": "INR", "rupee": "INR", "rupees": "INR",
  "chf": "CHF", "franc": "CHF", "francs": "CHF",
  "czk": "CZK", "koruna": "CZK",
  "sek": "SEK", "nok": "NOK", "dkk": "DKK", "isk": "ISK",
  "cad": "CAD", "aud": "AUD", "nzd": "NZD", "sgd": "SGD", "hkd": "HKD",
  "cny": "CNY", "yuan": "CNY", "rmb": "CNY",
  "krw": "KRW", "won": "KRW",
  "brl": "BRL", "real": "BRL", "mxn": "MXN", "zar": "ZAR", "try": "TRY",
  "huf": "HUF", "ron": "RON", "bgn": "BGN", "ils": "ILS", "php": "PHP",
  "thb": "THB", "myr": "MYR", "idr": "IDR", "inrs": "INR",
};

/** The words that mean "into". `>` and `-` are here because a hand in a hurry
 *  types one of them and the sentence still means the same thing. */
const INTO = new Set(["to", "in", "into", "as", ">", "->", "=", "-"]);

/** `1 234,56` and `1,234.56` both mean the same number — and on a Polish
 *  keyboard the comma IS the decimal point.
 *
 * ⚠️ A comma is only a thousands separator when it is followed by exactly
 * three digits AND there is another separator doing the decimal job. Guessing
 * the other way turns `1,5` into fifteen, which is the bug that made
 * `palette-calc` refuse commas outright. */
function amountOf(text: string): number | null {
  const cleaned = text.replace(/\s|_/g, "");
  if (!/^[\d.,]+$/.test(cleaned) || !/\d/.test(cleaned)) return null;
  const dots = (cleaned.match(/\./g) ?? []).length;
  const commas = (cleaned.match(/,/g) ?? []).length;
  let plain = cleaned;
  if (dots && commas) {
    // Whichever comes last is the decimal point; the other groups thousands.
    const decimal = cleaned.lastIndexOf(".") > cleaned.lastIndexOf(",") ? "." : ",";
    const group = decimal === "." ? "," : ".";
    plain = cleaned.split(group).join("").replace(decimal, ".");
  } else if (commas === 1 && /,\d{3}$/.test(cleaned) && cleaned.length > 4) {
    plain = cleaned.replace(",", "");
  } else if (commas) {
    plain = cleaned.split(",").join(".");
    if ((plain.match(/\./g) ?? []).length > 1) return null;
  }
  const value = Number(plain);
  return Number.isFinite(value) ? value : null;
}

/** A currency, from a code, a name or a symbol. */
function codeOf(word: string): string | null {
  const key = word.toLowerCase().replace(/[.,]$/, "");
  return SYMBOLS[key] ?? (/^[a-z]{3}$/.test(key) ? key.toUpperCase() : null);
}

/**
 * `100 usd to pln`, `$100 pln`, `eur to gbp`.
 *
 * @returns `null` for anything that is not plainly a conversion — which is
 * most of what gets typed into a palette.
 */
export function parseMoney(text: string): Money | null {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 48) return null;
  /* Symbols are split off the number: `$100` and `100zł` are both one token
   * to a space-splitter and neither is a word this grammar knows. */
  const spaced = trimmed
    .replace(/([$€£¥₹])/g, " $1 ")
    /* ⚠️ A LOOKAHEAD, not `\b`, after `zł`. A word boundary is defined against
     * ASCII word characters and `ł` is not one — so the boundary lands where a
     * reader does not expect it and `100zł to eur` silently stopped being a
     * conversion at all. */
    .replace(/(\d)\s*(zł|zl)(?![a-ząćęłńóśżź])/gi, "$1 $2 ")
    .replace(/(\d)([a-z]{3})\b/gi, "$1 $2 ")
    /* A space is a thousands separator here — `1 500` — and two numbers in a
     * row are otherwise two amounts, which this grammar refuses outright.
     * Exactly three digits, so `100 200 usd eur` is still the typo it looks
     * like. */
    .replace(/(\d)\s+(?=\d{3}(?!\d))/g, "$1");
  const words = spaced.split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 5) return null;

  let amount: number | null = null;
  const seen: string[] = [];
  for (const word of words) {
    if (INTO.has(word.toLowerCase())) continue;
    const number = amountOf(word);
    if (number !== null) {
      // ⚠️ One amount. "100 200 usd eur" is a typo, not a conversion.
      if (amount !== null) return null;
      amount = number;
      continue;
    }
    const code = codeOf(word);
    if (!code) return null;
    seen.push(code);
  }
  if (seen.length !== 2) return null;
  const [from, to] = seen;
  if (from === to) return null;
  return { amount: amount ?? 1, from, to };
}

/**
 * The conversion, through the table's own base.
 *
 * @returns `null` when either currency is not in the table — which is the
 * honest answer for a code the source does not publish, and a great deal
 * better than a number computed from a missing rate. ⚠️ `undefined * 4` is
 * `NaN`, and `NaN` renders perfectly happily.
 */
export function convert(money: Money, table: Rates): number | null {
  const rate = (code: string) =>
    code === table.base ? 1 : table.rates[code];
  const from = rate(money.from);
  const to = rate(money.to);
  if (!from || !to || !Number.isFinite(from) || !Number.isFinite(to)) return null;
  return (money.amount / from) * to;
}

/** Currencies nobody writes decimals for. */
const WHOLE = new Set(["JPY", "KRW", "HUF", "IDR", "ISK", "CLP", "VND"]);

/**
 * `1,234.56`, `¥130`, `0.000812`.
 *
 * ⚠️ A fixed locale, not the machine's. Every other number in this app is
 * grouped the same way, and a converter that writes `1 234,56` on one screen
 * beside `1,234.56` on another is two apps.
 */
export function sayMoney(value: number, code: string): string {
  const digits = WHOLE.has(code) ? 0
    /* ⚠️ Small numbers keep their significant figures. Two decimals on a
     * satoshi-sized answer is `0.00`, which is not a rounding — it is the
     * converter saying the answer is nothing. */
    : Math.abs(value) > 0 && Math.abs(value) < 0.01 ? 6
    : 2;
  return value.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/** The amount as it was TYPED, near enough.
 *
 * ⚠️ Not `sayMoney`. The answer is money and wants its two decimals; the
 * question is a number somebody typed, and echoing "120" back as "120.00" is
 * the row correcting them about something they got right. */
export function sayAmount(value: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: 4 });
}

/** `2026-09-17` -> `17 Sep`.
 *
 * ⚠️ Said, not printed. The date is on the row because these are DAILY
 * rates and an answer on Sunday is Friday's number — which is a fact somebody
 * reads, and nobody reads a hyphenated ISO date. */
export function sayDay(date: string): string {
  const [, month, day] = date.split("-").map(Number);
  if (!month || !day || month > 12) return date;
  /* ⚠️ A table, not `toLocaleDateString`. Its "short" month is four letters
   * in some locales and three in others — `en-GB` says "Sept" — so the row
   * would be a character wider on one machine than another for no reason
   * anybody could see. */
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${day} ${months[month - 1]}`;
}

/** `4.3580`, for the line that says how the answer was arrived at. */
export function sayRate(money: Money, table: Rates): string {
  const one = convert({ ...money, amount: 1 }, table);
  if (one === null) return "";
  return one.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: one < 1 ? 4 : 3,
  });
}
