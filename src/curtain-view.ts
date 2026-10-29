/* What the curtain says and offers (curtain.rs, curtain.ts), from Helm's reading
 * (`GET /api/desktop/blocker`) and the site in front. Pure, so node tests it
 * (tests/curtain.test.mjs).
 *
 * ⚠️ In Polish, like the Guardian's nudges: the curtain is the Guardian talking
 * (Helm's own screens stay English). The line itself comes from Helm; this only
 * words the buttons and the times around it.
 */

export interface Earn { perHour: number; worked: number; hours: number; earned: number; spent: number; left: number; nextIn: number }
export interface Site { domain: string; name: string; tokens: string[]; earn: boolean }
export interface Reading {
  now: string;
  /** Helm's `BlockerPlan.why`: earn, first-block, spend, focus, held, locked, limit… */
  why: string;
  sites: Site[];
  title: string;
  body: string;
  earn: Earn;
  spend: number | null;
  buy: { minutes: number; price: number } | null;
  opens: string | null;
  until: string | null;
}
export interface Showing { serial: number; reading: Reading; site: Site; browser: string }

const num = (v: unknown, fallback = 0) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const str = (v: unknown) => (typeof v === "string" ? v : "");
const iso = (v: unknown) => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? v : null);

/** Helm's answer, checked. ⚠️ `null` for anything without the line: a curtain
 *  with no words is a black screen, and the page then closes itself. */
export function readReading(body: unknown): Reading | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (!str(b.title)) return null;
  const e = (b.earn ?? {}) as Record<string, unknown>;
  const buy = b.buy as Record<string, unknown> | null | undefined;
  return {
    now: str(b.now),
    why: str(b.why),
    sites: Array.isArray(b.sites) ? (b.sites as Site[]) : [],
    title: str(b.title),
    body: str(b.body),
    earn: {
      perHour: num(e.perHour, 15), worked: num(e.worked), hours: num(e.hours), earned: num(e.earned),
      spent: num(e.spent), left: num(e.left), nextIn: num(e.nextIn, 60),
    },
    spend: typeof b.spend === "number" && b.spend > 0 ? b.spend : null,
    buy: buy && typeof buy.price === "number" && typeof buy.minutes === "number" ? { minutes: buy.minutes, price: buy.price } : null,
    opens: iso(b.opens),
    until: iso(b.until),
  };
}

/** "20 min", "1 h 20 min", "2 h". */
export function minutes(m: number) {
  const whole = Math.max(0, Math.round(m));
  const h = Math.floor(whole / 60);
  const rest = whole % 60;
  if (!h) return `${rest} min`;
  return rest ? `${h} h ${rest} min` : `${h} h`;
}

const money = new Intl.NumberFormat("pl-PL", { maximumFractionDigits: 2 });
/** "10 zł", "12,50 zł". */
export const zl = (n: number) => `${money.format(n)} zł`;

/* Helm's days are Warsaw's, and so is this machine — but the tests run anywhere. */
const clockFormat = new Intl.DateTimeFormat("pl-PL", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "Europe/Warsaw" });
const dayFormat = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Warsaw" });

/** "Wolne od 18:00", "Wolne od północy", "Wolne jutro". */
export function freeFrom(opens: string | null, now: Date): string | null {
  if (!opens) return null;
  const at = new Date(opens);
  const clock = clockFormat.format(at);
  if (dayFormat.format(at) === dayFormat.format(now)) return `Wolne od ${clock}`;
  return clock === "00:00" ? "Wolne od północy" : "Wolne jutro";
}

/** "za 3 h 50 min", or null once it's past. */
export function countdown(at: string | null, now: Date): string | null {
  if (!at) return null;
  const left = Math.ceil((Date.parse(at) - now.getTime()) / 60_000);
  return left > 0 ? `za ${minutes(left)}` : null;
}

/** What earned time looks like now, for the bar: shares of the whole, and how far into the next hour he is. */
export function barOf(earn: Earn) {
  const spent = Math.min(earn.spent, earn.earned);
  const total = Math.max(1, earn.earned + earn.perHour);
  return { spent: spent / total, left: earn.left / total, next: earn.perHour / total, into: Math.max(0, Math.min(1, (60 - earn.nextIn) / 60)) };
}

const EARNING = new Set(["earn", "first-block", "spend"]);

export interface Offer {
  /** Earned minutes to open now (earned and unspent, on a site earned time opens). */
  spend: { minutes: number; label: string } | null;
  /** Five minutes from the reward fund, when Helm's rules allow it. */
  buy: { label: string; price: number } | null;
  /** Earned time is the story: the bar and the next hour. */
  earning: boolean;
  worked: string;
  next: string | null;
  /** When the sites open by themselves, and how long that is. */
  free: string | null;
  wait: string | null;
  /** The site and the browser it's in: "YouTube w Brave". */
  where: string;
}

/** What the curtain offers for this showing. ⚠️ Spending and buying only on a
 *  site earned time opens: a site a locked rule also holds would stay shut, and
 *  a button that takes money for nothing is the worst one to have. */
export function offerOf(showing: Showing, now: Date): Offer {
  const r = showing.reading;
  const earnable = showing.site.earn;
  const spendable = earnable && r.spend ? Math.min(15, r.spend) : 0;
  const earning = EARNING.has(r.why);
  return {
    spend: spendable ? { minutes: spendable, label: `Otwórz na ${minutes(spendable)}` } : null,
    buy: earnable && r.buy ? { label: `${r.buy.minutes} minut za ${zl(r.buy.price)}`, price: r.buy.price } : null,
    earning,
    worked: `Przepracowane ${minutes(r.earn.worked)}`,
    next: earning ? `${r.why === "first-block" ? "Pierwsze" : "Kolejne"} ${r.earn.perHour} min za ${minutes(r.earn.nextIn)} pracy` : null,
    free: freeFrom(r.opens, now),
    wait: countdown(r.opens, now),
    where: showing.browser ? `${showing.site.name} w ${showing.browser}` : showing.site.name,
  };
}
