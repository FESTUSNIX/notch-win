/* Today's foot, read as one line: what to add, or time to log.
 *
 * "Poprawki w stopce @Esono 45m jutro" is an `add` with a project, a length
 * and a day; "log 1,5h @Esono poprawki" (or "zaloguj …") is time on a project,
 * `log_time`. Whatever is not a token is the title (or the log's note). The
 * pure half, node-tested in `tests/helm-quick.test.mjs`; the screen sends what
 * it answers through `/api/queue`.
 *
 * ⚠️ Positions are kept 1:1 while matching: `foldChar` folds ONE character to
 * one character (accents off, ł → l, case down), so a match found in the
 * folded line is cut out of the line as typed, accents and all.
 */

export interface QuickProject {
  id: number;
  name: string;
}

export type Quick =
  | { act: "add"; title: string; projectId?: number; minutes?: number; dueOn?: string }
  | { act: "log_time"; projectId: number; minutes: number; note?: string; day?: string }
  | { error: string };

const foldChar = (c: string) => {
  const parts = c.normalize("NFD");
  const base = parts.length > c.length ? parts[0] : c;
  const low = base === "ł" || base === "Ł" ? "l" : base.toLowerCase();
  return low.length === c.length ? low : c;
};
const fold = (text: string) => [...text].map(foldChar).join("");

/** A token's end: the line's end, a space or punctuation — never a letter (`\b` is ASCII-only). */
const END = String.raw`(?=$|[\s,.;:!?)])`;
const START = String.raw`(?:^|(?<=[\s(]))`;

const WEEKDAYS: Record<string, number> = {
  niedziela: 0, niedziele: 0, poniedzialek: 1, wtorek: 2, sroda: 3, srode: 3, czwartek: 4, piatek: 5, sobota: 6, sobote: 6,
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
};
const RELATIVE: Record<string, number> = { dzis: 0, dzisiaj: 0, today: 0, jutro: 1, tomorrow: 1, pojutrze: 2, wczoraj: -1, yesterday: -1 };

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Cut `[from, to)` out of the line, leaving one space. */
const cut = (text: string, from: number, to: number) => `${text.slice(0, from)} ${text.slice(to)}`;

/** The first length in the line: 30m, 45 min, 1h, 1,5h, 1.5 h, 90min, 1h30, 2 godz. */
export function takeMinutes(text: string): { minutes: number; rest: string } | null {
  const f = fold(text);
  const both = new RegExp(`${START}(\\d{1,2})\\s*h\\s*(\\d{1,2})\\s*(?:m|min)?${END}`).exec(f);
  if (both) return { minutes: Number(both[1]) * 60 + Number(both[2]), rest: cut(text, both.index, both.index + both[0].length) };
  const one = new RegExp(`${START}(\\d{1,3}(?:[.,]\\d{1,2})?)\\s*(h|hr|hrs|godz|godziny|godzin|godzina|m|min|mins|minut|minuty)${END}`).exec(f);
  if (!one) return null;
  const value = Number(one[1].replace(",", "."));
  const minutes = Math.round(/^(h|hr|hrs|godz)/.test(one[2]) ? value * 60 : value);
  return minutes > 0 ? { minutes, rest: cut(text, one.index, one.index + one[0].length) } : null;
}

/** The first day in the line, as YYYY-MM-DD: dziś/jutro/pojutrze, a weekday (the NEXT one —
 *  "piątek" said on a Friday is a week out), or 5.11 / 05.11 (this year, else next). */
export function takeDay(text: string, today: string): { day: string; rest: string } | null {
  const f = fold(text);
  const lead = String.raw`(?:(?:w|we|na|do|on|by)\s+)?`;
  const word = new RegExp(`${START}${lead}(${[...Object.keys(RELATIVE), ...Object.keys(WEEKDAYS)].join("|")})${END}`).exec(f);
  if (word) {
    const name = word[1];
    let day: string;
    if (name in RELATIVE) day = addDays(today, RELATIVE[name]);
    else {
      const now = new Date(`${today}T12:00:00Z`).getUTCDay();
      day = addDays(today, ((WEEKDAYS[name] - now + 7) % 7) || 7);
    }
    return { day, rest: cut(text, word.index, word.index + word[0].length) };
  }
  const date = new RegExp(`${START}${lead}(\\d{1,2})\\.(\\d{1,2})\\.?${END}`).exec(f);
  if (date) {
    const d = Number(date[1]);
    const m = Number(date[2]);
    let year = Number(today.slice(0, 4));
    const iso = (y: number) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const real = (y: number) => { const at = new Date(`${iso(y)}T12:00:00Z`); return at.getUTCMonth() + 1 === m && at.getUTCDate() === d; };
    if (m < 1 || m > 12 || !real(year) && !real(year + 1)) return null;
    if (iso(year) < today || !real(year)) year += 1;
    return { day: iso(year), rest: cut(text, date.index, date.index + date[0].length) };
  }
  return null;
}

/** The project: a mention the composer made (`mentioned`, its words in the line), else
 *  `@word` matched by name — whole name, then a name starting with it, then a word of it. */
export function takeProject(text: string, projects: QuickProject[], mentioned: number[] = []): { id: number; rest: string } | null {
  const f = fold(text);
  const named = [...projects].sort((a, b) => b.name.length - a.name.length);
  // The composer's mention first: its `@Name` is in the line as typed.
  for (const id of mentioned) {
    const project = projects.find(p => p.id === id);
    const at = project ? f.indexOf(`@${fold(project.name)}`) : -1;
    if (project && at >= 0) return { id, rest: cut(text, at, at + project.name.length + 1) };
  }
  if (mentioned.length) return { id: mentioned[0], rest: text };
  // A full name typed after `@`, the longest first ("Esono Rozwój" before "Esono").
  for (const project of named) {
    const at = new RegExp(`@${fold(project.name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}${END}`).exec(f);
    if (at) return { id: project.id, rest: cut(text, at.index, at.index + at[0].length) };
  }
  const token = /(?:^|\s)@([^\s@]+)/.exec(f);
  if (!token) return null;
  const word = token[1];
  const pick = projects.find(p => fold(p.name) === word)
    ?? projects.find(p => fold(p.name).startsWith(word))
    ?? projects.find(p => fold(p.name).split(/[\s\-–—_/]+/).some(part => part.startsWith(word)));
  if (!pick) return null;
  const from = token.index + token[0].indexOf("@");
  return { id: pick.id, rest: cut(text, from, from + word.length + 1) };
}

const tidy = (text: string) => text.replace(/\s+/g, " ").replace(/^[\s,;:–—-]+|[\s,;:–—-]+$/g, "").trim();

/** One line from the foot, as what to send. */
export function parseQuick(line: string, options: { projects: QuickProject[]; mentioned?: number[]; today: string }): Quick {
  let text = line.trim();
  const log = /^(log|zaloguj)\s+/i.exec(text);
  if (log) text = text.slice(log[0].length);
  const project = takeProject(text, options.projects, options.mentioned);
  if (project) text = project.rest;
  const length = takeMinutes(text);
  if (length) text = length.rest;
  const day = takeDay(text, options.today);
  if (day) text = day.rest;
  const rest = tidy(text);
  const minutes = length ? Math.min(16 * 60, Math.max(5, length.minutes)) : undefined;

  if (log) {
    if (!project) return { error: "Log needs an @project" };
    if (!minutes) return { error: "Log needs a time, like 1h" };
    const out: Quick = { act: "log_time", projectId: project.id, minutes };
    if (rest) out.note = rest.slice(0, 280);
    if (day && day.day <= options.today) out.day = day.day;
    return out;
  }
  if (!rest) return { error: "Add needs a title" };
  const out: Quick = { act: "add", title: rest.slice(0, 280) };
  if (project) out.projectId = project.id;
  if (minutes) out.minutes = minutes;
  if (day) out.dueOn = day.day;
  return out;
}
