/* Turn @web3icons into the coin marks this app serves.
 *
 * ⚠️ A GENERATOR, not a vendored copy made by hand. The set moves — tokens get
 * added, a logo gets redrawn, a coin climbs into the top 250 — and the answer
 * to that is `pnpm coin-marks` against a newer version, never a folder
 * somebody edited. Same bargain as `generate-glyphs.py`: the OUTPUT is
 * committed so a checkout builds without the dependency, and this script is
 * how it got there.
 *
 * Writes two things:
 *   public/coin/<SYMBOL>.svg   one file each, served lazily by <img>
 *   src/coin-marks.ts          the list of symbols that HAVE a file
 *
 * ⚠️ CURATED, not the whole set. @web3icons carries about 1800 tokens and
 * shipping all of them was 4.7 MB across 1788 files in a repo that tracks
 * under 200 — for a wallet that shows five rows. What it is worth having is
 * the coins somebody might actually hold, which is what `RANK` picks out.
 *
 * ⚠️ The `background` variant, which is a square plate in the token's colour
 * with the mark knocked out of it — a coin disc once CSS rounds it. `branded`
 * and `mono` are glyphs on nothing and would leave the app inventing a plate
 * colour for every token, which is work this set has already done.
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tokens } from "@web3icons/common";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const svgs = join(root, "node_modules/@web3icons/core/dist/svgs");
const into = join(root, "public/coin");

/** How far down the market a mark is worth shipping.
 *
 * ⚠️ A RANK, not a count, so the list is a statement about what matters rather
 * than about how big the folder may be. 250 is roughly where a coin stops
 * being one somebody holds and starts being one somebody has heard of. */
const RANK = 250;

/** Marks that ship whatever the rank says, and the reason there is a list at
 * all: `marketCapRank` has holes.
 *
 * ⚠️ **Bitcoin's rank is `null`.** A cutoff on its own silently drops the one
 * coin nobody would forgive — which is the whole argument for a floor rather
 * than a tidier one-line filter. `POL`, `IMX`, `JUP` and `WBETH` sit outside
 * 250 for their own reasons and belong here too.
 *
 * ⚠️ Everything Binance PRICES in is here whether or not it currently ranks.
 * A quote currency shows up in the wallet of anybody who has ever sold
 * something, so it is not optional the way a position is.
 *
 * ⚠️ A name here with no art is a hard FAILURE, not a warning. The list only
 * means anything if being on it guarantees the file — a floor that quietly
 * gives way is worse than no floor. */
const CORE = [
  // What Binance quotes in.
  "USDT", "USDC", "FDUSD", "TUSD", "DAI", "PAXG",
  // The majors.
  "BTC", "ETH", "BNB", "SOL", "XRP", "ADA", "DOGE", "TRX", "DOT",
  "LTC", "BCH", "LINK", "AVAX", "MATIC", "POL", "SHIB", "TON", "XLM", "ATOM",
  // Wrapped and staked forms people hold without meaning to. ⚠️ `WBETH` is
  // what Binance hands you for staking ether, so it turns up unannounced.
  "WBTC", "WBETH",
  // Outside the cutoff, and held anyway.
  "IMX", "JUP",
];

/** What a backslash escape in a JS string literal stands for. */
const ESCAPES = { n: "\n", r: "\r", t: "\t", "'": "'", '"': '"', "\\": "\\" };

/** Where a row's artwork lives, or null.
 *
 * ⚠️ `filePath` is the ONLY way to find it, and it is not always a token.
 * Toncoin is `network:ton` and Injective is `network:injective` — both are
 * chains with a coin, and their marks sit under `networks/`. Reading the
 * token directory alone is why the first pass of this had no mark for either,
 * and neither is obscure. */
function artOf(row) {
  const [kind, file] = String(row.filePath ?? "").split(":");
  const dir = kind === "token" ? "tokens" : kind === "network" ? "networks" : null;
  if (!dir || !file) return null;
  const path = join(svgs, dir, "background", `${file}.svg.js`);
  return existsSync(path) ? path : null;
}

/** The SVG out of one of the package's tiny ES modules.
 *
 * ⚠️ Read as TEXT and cut with a regex rather than imported. These are ESM
 * files holding a single-quoted string literal, and importing them to read a
 * string each is module resolution doing what two lines of parsing does.
 *
 * ⚠️ The escapes are undone in ONE pass. Chaining a replace per escape reads
 * the same and is not: undoing the doubled backslash last turns a literal
 * backslash-then-n into a newline, and doing it first turns every newline back
 * into two characters. One pass with a lookup cannot get that wrong — the
 * version that got it wrong wrote the escape into all 1788 files, and every
 * mark rendered as a disc of stray text. */
function svgOf(source) {
  const body = source.match(/=\s*'([\s\S]*?)'\s*\n\s*export/);
  if (!body) return null;
  return body[1].replace(/\\(.)/g, (whole, one) => ESCAPES[one] ?? whole).trim();
}

/** ⚠️ `width`/`height` are DROPPED and the viewBox kept. With them the mark is
 *  24px wherever it lands and the CSS box around it is a suggestion; without
 *  them it fills whatever it is given, which is 26px in a coin head and 17 in
 *  a wallet row. `class="web3icons"` goes too — it is the package's hook for
 *  its own React components and this app has no rule for it. */
function tidy(svg) {
  return svg
    .replace(/\s+width="\d+"/, "")
    .replace(/\s+height="\d+"/, "")
    .replace(/\s+class="web3icons"/, "")
    .replace(/>\s+</g, "><")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/* ⚠️ Keyed on the UPPERCASED symbol, which is how Binance says it and how
 * `coin-icon.ts` asks for it. The set spells them both ways — `btc` and `TON`
 * are both in there — and the metadata has no two rows sharing one, so the
 * fold is safe. */
const rows = new Map();
for (const row of tokens) {
  const symbol = String(row.symbol ?? "").toUpperCase();
  /* ⚠️ Only what a filename can carry unambiguously. The symbol becomes a
   * path and then a URL, so anything needing escaping is dropped rather than
   * encoded. */
  if (!/^[A-Z0-9]+$/.test(symbol)) continue;
  if (!rows.has(symbol)) rows.set(symbol, row);
}

const core = new Set(CORE);
const wanted = [...rows].filter(([symbol, row]) =>
  core.has(symbol) || (row.marketCapRank > 0 && row.marketCapRank <= RANK));

rmSync(into, { recursive: true, force: true });
mkdirSync(into, { recursive: true });

const symbols = [];
const failed = [];
let bytes = 0;
for (const [symbol, row] of wanted) {
  const path = artOf(row);
  const svg = path && svgOf(readFileSync(path, "utf8"));
  if (!svg || !svg.startsWith("<svg") || !svg.endsWith("</svg>")) { failed.push(symbol); continue; }
  const out = tidy(svg);
  /* ⚠️ A mark still holding an escape is one this script has misread, and it
   * would reach somebody's board as a disc of stray text. */
  if (out.includes("\\n") || out.includes("\\'")) { failed.push(symbol); continue; }
  writeFileSync(join(into, `${symbol}.svg`), out);
  symbols.push(symbol);
  bytes += out.length;
}
symbols.sort();

/* ⚠️ A missing CORE mark stops the build. Everything else is a rank away from
 * being in the list anyway, so losing one is a shrug; losing one of these is
 * the wallet drawing "BTC" in letters. */
const short = CORE.filter(one => !symbols.includes(one));
if (short.length) {
  console.error(`No mark for ${short.join(", ")} — either the set dropped it or CORE names it wrong.`);
  process.exit(1);
}

writeFileSync(join(root, "src/coin-marks.ts"), `/* GENERATED by tools/generate-coin-marks.mjs — do not edit.
 *
 * Which tokens have a mark in \`public/coin\`, and nothing else: the marks
 * themselves are files, fetched only when one is painted. ⚠️ A SET rather
 * than a probe, because the alternative is an <img> that 404s in front of the
 * user before the fallback can run — see \`coin-icon.ts\`.
 *
 * ⚠️ CURATED — the top ${RANK} by market cap plus a floor of majors and quote
 * currencies. A coin outside it gets the monogram, which is a real answer and
 * not a failure. Widen it by raising \`RANK\` in the generator, never by
 * dropping a file in beside these.
 *
 * Source: @web3icons (MIT), the \`background\` variant.
 */
export const COIN_MARKS: ReadonlySet<string> = new Set(${JSON.stringify(symbols)});
`);

console.log(`${symbols.length} marks, ${(bytes / 1024).toFixed(0)} KB`
  + (failed.length ? `  (${failed.length} ranked tokens have no art: ${failed.slice(0, 8).join(", ")}…)` : ""));
