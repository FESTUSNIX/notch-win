/* Which mark a coin gets, and what to call it.
 *
 * `coin-marks.ts` says which symbols have a file; this says how to get from
 * what Binance calls a thing to what the icon set calls it. The two are not
 * quite the same list and never will be — an exchange renames a ticker the
 * week a project rebrands, and an icon set follows whenever it follows.
 *
 * ⚠️ PURE, and no DOM in it. The board draws the mark; this only decides which
 * one, which is the part with rules worth testing — see `tests/coin-icon`.
 *
 * ⚠️ There is always an answer: `null` here means "no mark", and every caller
 * falls back to the three-letter monogram that was the only thing here before.
 * A token this set has never heard of has to look deliberate rather than
 * broken, because there will always be one.
 */
import { COIN_MARKS } from "./coin-marks.ts";

/** Binance's name for a thing against the icon set's name for it.
 *
 * ⚠️ SHORT on purpose, and every line is a fact somebody can check rather than
 * a guess at what a ticker might mean. A wrong mark is worse than none: a
 * monogram reads as "no logo for this", a confident logo for the wrong coin
 * reads as your money being somewhere it is not.
 *
 * The wrapped and staked forms take the UNDERLYING's mark, which is what every
 * wallet does — `BETH` is ether, and a shopper looking for their ether should
 * find it rather than a blank disc. */
const ALIAS: Record<string, string> = {
  // Binance renamed the ticker in 2024; the set still files it under the old one.
  RENDER: "RNDR",
  // IOTA was MIOTA everywhere for years and some balances still say so.
  MIOTA: "IOTA",
  // Ether, wrapped or staked.
  BETH: "ETH",
  WETH: "ETH",
  // Bitcoin on BNB Chain.
  BTCB: "BTC",
};

/** The file's base name for an asset, or null if there is no mark for it. */
export function coinMarkName(asset: string): string | null {
  /* ⚠️ Letters and digits only, and uppercased. The symbol becomes a FILENAME
   * and then a URL, so anything that would need escaping is dropped rather
   * than encoded — a balance line reading `BTC.b` must not be able to ask for
   * a path with a dot segment in it. */
  const clean = (asset ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!clean) return null;

  const named = ALIAS[clean];
  if (named) return COIN_MARKS.has(named) ? named : null;
  if (COIN_MARKS.has(clean)) return clean;

  /* ⚠️ `LD` is Binance's own prefix for a coin sitting in Lending — `LDBTC` is
   * bitcoin, not a token called LDBTC. Tried LAST so a real ticker starting
   * with those two letters (`LDO`, Lido) is matched as itself first. */
  if (clean.length > 3 && clean.startsWith("LD")) {
    const under = clean.slice(2);
    if (COIN_MARKS.has(under)) return under;
  }
  return null;
}

/** Where the mark lives, or null.
 *
 * ⚠️ RELATIVE, with no leading slash. Every page of this app sits at the root
 * of whatever is serving it — Vite on :1420 in development, the bundle's own
 * protocol in a release — and a relative path is the one spelling that is
 * right under both. */
export function coinMarkUrl(asset: string): string | null {
  const name = coinMarkName(asset);
  return name ? `coin/${name}.svg` : null;
}
