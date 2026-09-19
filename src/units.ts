/* `70 kg to lb`, in the palette.
 *
 * The converter's sibling, and the one that needs no network at all: a table of
 * factors and the same grammar. Every recipe in cups, every American spec sheet
 * in inches and every drive that says GB when it means GiB is this question.
 *
 * ⚠️ Anything that parses puts a row at the TOP of the palette, so the grammar
 * says no to almost everything: an amount, a unit it knows, and a second unit
 * of the SAME kind. "5 kg to miles" has no answer and gets no row, rather than
 * a number nobody can use.
 *
 * ⚠️ Every factor is against one base per kind, so a conversion is one
 * multiplication and one division. Temperature is the exception and is the
 * reason `offset` exists: 0°C is not 0°F, and a table of pure ratios turns
 * "20°C in F" into 36.
 */

interface Unit {
  /** What it measures. Two units only convert within one of these. */
  kind: string;
  /** How many of the kind's base unit one of these is. */
  per: number;
  /** Added AFTER scaling, for the scales that do not start at zero. */
  offset?: number;
  /** What to print. ⚠️ Not the word that was typed: `5 lbs` and `5 lb` are the
   *  same answer and should say the same thing. */
  say: string;
}

/* The bases: metre, gram, second, byte, litre, square metre, kelvin, m/s. */
const UNITS: Record<string, Unit> = {
  // ── Length ────────────────────────────────────────────────────────────
  mm: { kind: "length", per: 0.001, say: "mm" },
  cm: { kind: "length", per: 0.01, say: "cm" },
  m: { kind: "length", per: 1, say: "m" },
  km: { kind: "length", per: 1000, say: "km" },
  in: { kind: "length", per: 0.0254, say: "in" },
  inch: { kind: "length", per: 0.0254, say: "in" },
  inches: { kind: "length", per: 0.0254, say: "in" },
  ft: { kind: "length", per: 0.3048, say: "ft" },
  foot: { kind: "length", per: 0.3048, say: "ft" },
  feet: { kind: "length", per: 0.3048, say: "ft" },
  yd: { kind: "length", per: 0.9144, say: "yd" },
  yard: { kind: "length", per: 0.9144, say: "yd" },
  yards: { kind: "length", per: 0.9144, say: "yd" },
  mi: { kind: "length", per: 1609.344, say: "mi" },
  mile: { kind: "length", per: 1609.344, say: "mi" },
  miles: { kind: "length", per: 1609.344, say: "mi" },
  nmi: { kind: "length", per: 1852, say: "nmi" },

  // ── Mass ──────────────────────────────────────────────────────────────
  mg: { kind: "mass", per: 0.001, say: "mg" },
  g: { kind: "mass", per: 1, say: "g" },
  kg: { kind: "mass", per: 1000, say: "kg" },
  t: { kind: "mass", per: 1_000_000, say: "t" },
  tonne: { kind: "mass", per: 1_000_000, say: "t" },
  oz: { kind: "mass", per: 28.349523125, say: "oz" },
  lb: { kind: "mass", per: 453.59237, say: "lb" },
  lbs: { kind: "mass", per: 453.59237, say: "lb" },
  pound: { kind: "mass", per: 453.59237, say: "lb" },
  st: { kind: "mass", per: 6350.29318, say: "st" },
  stone: { kind: "mass", per: 6350.29318, say: "st" },

  // ── Temperature ───────────────────────────────────────────────────────
  /* ⚠️ Kelvin is the base, so Celsius carries an offset and Fahrenheit carries
   * both. A table of ratios alone reads 20°C as 36°F. */
  k: { kind: "heat", per: 1, say: "K" },
  c: { kind: "heat", per: 1, offset: 273.15, say: "°C" },
  celsius: { kind: "heat", per: 1, offset: 273.15, say: "°C" },
  f: { kind: "heat", per: 5 / 9, offset: 255.372222222, say: "°F" },
  fahrenheit: { kind: "heat", per: 5 / 9, offset: 255.372222222, say: "°F" },

  // ── Data ──────────────────────────────────────────────────────────────
  /* ⚠️ Both families, because both are real and they differ by 7% at GB: a
   * drive says GB and means 10^9, an operating system says GB and means 2^30,
   * and refusing to have one of them is how a converter gets the wrong one. */
  b: { kind: "data", per: 1, say: "B" },
  kb: { kind: "data", per: 1e3, say: "kB" },
  mb: { kind: "data", per: 1e6, say: "MB" },
  gb: { kind: "data", per: 1e9, say: "GB" },
  tb: { kind: "data", per: 1e12, say: "TB" },
  kib: { kind: "data", per: 1024, say: "KiB" },
  mib: { kind: "data", per: 1024 ** 2, say: "MiB" },
  gib: { kind: "data", per: 1024 ** 3, say: "GiB" },
  tib: { kind: "data", per: 1024 ** 4, say: "TiB" },

  // ── Time ──────────────────────────────────────────────────────────────
  ms: { kind: "time", per: 0.001, say: "ms" },
  s: { kind: "time", per: 1, say: "s" },
  sec: { kind: "time", per: 1, say: "s" },
  min: { kind: "time", per: 60, say: "min" },
  h: { kind: "time", per: 3600, say: "h" },
  hr: { kind: "time", per: 3600, say: "h" },
  hour: { kind: "time", per: 3600, say: "h" },
  hours: { kind: "time", per: 3600, say: "h" },
  d: { kind: "time", per: 86400, say: "d" },
  day: { kind: "time", per: 86400, say: "d" },
  days: { kind: "time", per: 86400, say: "d" },
  wk: { kind: "time", per: 604800, say: "wk" },
  week: { kind: "time", per: 604800, say: "wk" },
  weeks: { kind: "time", per: 604800, say: "wk" },

  // ── Volume ────────────────────────────────────────────────────────────
  ml: { kind: "volume", per: 0.001, say: "ml" },
  l: { kind: "volume", per: 1, say: "l" },
  litre: { kind: "volume", per: 1, say: "l" },
  liter: { kind: "volume", per: 1, say: "l" },
  cup: { kind: "volume", per: 0.2365882365, say: "cup" },
  cups: { kind: "volume", per: 0.2365882365, say: "cup" },
  pt: { kind: "volume", per: 0.473176473, say: "pt" },
  qt: { kind: "volume", per: 0.946352946, say: "qt" },
  gal: { kind: "volume", per: 3.785411784, say: "gal" },
  floz: { kind: "volume", per: 0.0295735295625, say: "fl oz" },

  // ── Area ──────────────────────────────────────────────────────────────
  m2: { kind: "area", per: 1, say: "m²" },
  km2: { kind: "area", per: 1e6, say: "km²" },
  ha: { kind: "area", per: 10_000, say: "ha" },
  ac: { kind: "area", per: 4046.8564224, say: "ac" },
  acre: { kind: "area", per: 4046.8564224, say: "ac" },
  acres: { kind: "area", per: 4046.8564224, say: "ac" },
  ft2: { kind: "area", per: 0.09290304, say: "ft²" },

  // ── Speed ─────────────────────────────────────────────────────────────
  kmh: { kind: "speed", per: 1 / 3.6, say: "km/h" },
  mph: { kind: "speed", per: 0.44704, say: "mph" },
  kn: { kind: "speed", per: 0.514444444, say: "kn" },
  knot: { kind: "speed", per: 0.514444444, say: "kn" },
  knots: { kind: "speed", per: 0.514444444, say: "kn" },
};

/** What somebody typed, tidied into a key of the table above. */
function unitOf(word: string): string | null {
  const key = word
    .toLowerCase()
    .replace(/[.,]$/, "")
    .replace(/°/g, "")
    .replace(/\//g, "")
    .replace(/²/g, "2")
    .replace(/\s/g, "");
  return key in UNITS ? key : null;
}

export interface Measure {
  amount: number;
  from: string;
  to: string;
}

/** The words that mean "into", shared with the money parser's grammar. */
const INTO = new Set(["to", "in", "into", "as", ">", "->", "=", "-"]);

/** `1 234,56` and `1,234.56`, and a comma that is a decimal point. */
function amountOf(text: string): number | null {
  const cleaned = text.replace(/\s|_/g, "");
  if (!/^-?[\d.,]+$/.test(cleaned) || !/\d/.test(cleaned)) return null;
  const dots = (cleaned.match(/\./g) ?? []).length;
  const commas = (cleaned.match(/,/g) ?? []).length;
  let plain = cleaned;
  if (dots && commas) {
    const decimal = cleaned.lastIndexOf(".") > cleaned.lastIndexOf(",") ? "." : ",";
    plain = cleaned.split(decimal === "." ? "," : ".").join("").replace(decimal, ".");
  } else if (commas === 1 && /,\d{3}$/.test(cleaned) && cleaned.length > 4) {
    plain = cleaned.replace(",", "");
  } else if (commas) {
    plain = cleaned.split(",").join(".");
    if ((plain.match(/\./g) ?? []).length > 1) return null;
  }
  const value = Number(plain);
  return Number.isFinite(value) ? value : null;
}

/**
 * `70 kg to lb`, `12ft in m`, `220f c`, `1.5gb mb`.
 *
 * ⚠️ `null` unless both units are known AND measure the same thing. "5 kg to
 * miles" has no answer, and a row that appeared for it would be a row that
 * appears for almost anything.
 */
export function parseUnits(text: string): Measure | null {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 48) return null;
  /* A number welded to its unit is one token to a space-splitter — `70kg`,
   * `12ft`, `220°f` — and neither half is a word this grammar knows. */
  const spaced = trimmed
    .replace(/(\d)\s*°?\s*([a-z²/]+)/gi, "$1 $2 ")
    .replace(/(\d)\s+(?=\d{3}(?!\d))/g, "$1");
  const words = spaced.split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 5) return null;

  let amount: number | null = null;
  const seen: string[] = [];
  for (const word of words) {
    if (INTO.has(word.toLowerCase())) continue;
    const number = amountOf(word);
    if (number !== null) {
      if (amount !== null) return null;
      amount = number;
      continue;
    }
    const unit = unitOf(word);
    if (!unit) return null;
    seen.push(unit);
  }
  if (seen.length !== 2 || amount === null) return null;
  const [from, to] = seen;
  /* ⚠️ Same kind, and not the same unit. Different kinds have no answer;
   * the same unit twice is a question nobody asks. */
  if (from === to || UNITS[from].kind !== UNITS[to].kind) return null;
  return { amount, from, to };
}

/** The conversion, through the kind's own base. */
export function convertUnits(measure: Measure): number | null {
  const from = UNITS[measure.from];
  const to = UNITS[measure.to];
  if (!from || !to || from.kind !== to.kind) return null;
  /* ⚠️ The offset is applied on the way IN and taken off on the way out, in
   * that order. Scaling an offset scale as if it were a ratio is how "20°C in
   * F" becomes 36 — a number that looks like a temperature and is not one. */
  const base = measure.amount * from.per + (from.offset ?? 0);
  return (base - (to.offset ?? 0)) / to.per;
}

/** What to call the unit on the answer. */
export function sayUnit(key: string): string {
  return UNITS[key]?.say ?? key;
}

/**
 * The answer, at a length somebody can read.
 *
 * ⚠️ Significant figures, not fixed decimals. `2 mm to in` is 0.0787 and
 * `70 kg to lb` is 154.32: two decimals would print the first as `0.08`, which
 * is a converter saying "about nothing", and six would print the second with
 * four digits of noise the input never had.
 */
export function sayMeasure(value: number): string {
  const size = Math.abs(value);
  /* Five figures, wherever the point happens to be — so the answer carries
   * about as much precision as the question did, whatever its size. */
  const digits = size === 0 ? 0
    : size < 0.001 ? 6
    : size < 1 ? 4
    : Math.max(0, 4 - Math.floor(Math.log10(size)));
  const fixed = value.toFixed(digits);
  // No trailing zeroes: `154.30` is a precision the input did not have.
  const tidy = digits ? fixed.replace(/\.?0+$/, "") : fixed;
  return Number(tidy).toLocaleString("en-US", { maximumFractionDigits: digits });
}
