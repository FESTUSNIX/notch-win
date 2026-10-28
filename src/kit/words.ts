/* The composer's pure half: what an `@` or a `/` is in the middle of, which
 * projects match what was typed after it, and what a draft becomes when it
 * is sent (`text`, `mentions`, `command`).
 *
 * ⚠️ No runtime imports but the one with an extension. `node --test` loads
 * this file (tests/kit.test.mjs), and Node's resolver does not add the
 * extensions Vite does — a bare `./x` here fails the whole test file with a
 * message naming this one (AGENTS 437, 645).
 */
import { search } from "../palette-match.ts";

/** The four things a line can be filed as, sent as `command` (Helm's contract). */
export type Command = "request" | "note" | "log" | "todo";

export interface CommandDef {
  command: Command;
  /** What the menu calls it, in the thread's own Polish. */
  label: string;
  /** The glyph, by its name in task-icons. */
  icon: "request" | "note" | "clock" | "today";
}

/* ⚠️ In this order, which is the order of how often each is wanted: a new
 * request for a client is the commonest thing filed from a notch, a to-do the
 * rarest (Today's own composer already adds those). */
export const COMMANDS: CommandDef[] = [
  { command: "request", label: "Zgłoszenie", icon: "request" },
  { command: "note", label: "Notatka", icon: "note" },
  { command: "log", label: "Zaloguj czas", icon: "clock" },
  { command: "todo", label: "Do zrobienia", icon: "today" },
];

/** A project the `@` picker offers: `/api/notch/projects`, or the cockpit's folders. */
export interface MentionProject {
  id: number;
  name: string;
  client?: string | null;
  hue?: string | null;
  logoVersion?: string | number | null;
  personal?: boolean;
  /** Has work going on (Helm's `live`): such projects come first on an empty query. */
  live?: boolean;
}

export interface Mention {
  projectId: number;
  name: string;
}

/** Accents off, case down. ⚠️ Both sides: "rozwoj" has to find "Rozwój" and
 *  the reverse, or the picker only works for whoever types the accents. */
export function fold(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ł/g, "l").replace(/Ł/g, "L").toLowerCase();
}

/** What the caret is in the middle of: an `@project` being typed, a `/command`
 *  at the start, or nothing.
 *
 * ⚠️ An `@` only at the start of a word — an e-mail address is not a mention.
 * The query may hold spaces (project names do: "Esono Rozwój"), but not a line
 * break, and not more than three words: past that it is a sentence that
 * happened to start with an `@`, and a picker hanging on it is in the way. */
export function trigger(text: string, caret: number): { kind: "@" | "/"; start: number; query: string } | null {
  const before = text.slice(0, caret);
  const slash = /^\s*\/([\p{L}]*)$/u.exec(before);
  if (slash) return { kind: "/", start: before.indexOf("/"), query: slash[1] };
  const at = before.lastIndexOf("@");
  if (at < 0) return null;
  if (at > 0 && !/[\s(\[{"'„]/.test(before[at - 1])) return null;
  const query = before.slice(at + 1);
  if (query.length > 32 || /[\n@]/.test(query) || /^\s/.test(query)) return null;
  if (query.split(/\s+/).length > 3) return null;
  return { kind: "@", start: at, query };
}

/** The projects for an `@` query, best first; on an empty query the live ones
 *  lead, then the rest by name. */
export function matchProjects<T extends MentionProject>(projects: T[], query: string, limit = 6): { project: T; hits: number[] }[] {
  const items = projects.map(project => ({ project, title: fold(project.name), keywords: project.client ? fold(project.client) : undefined }));
  if (!query.trim()) {
    return [...items]
      .sort((a, b) => Number(!!b.project.live) - Number(!!a.project.live) || a.project.name.localeCompare(b.project.name, "pl"))
      .slice(0, limit)
      .map(one => ({ project: one.project, hits: [] }));
  }
  /* ⚠️ Words before letters. The palette's subsequence matching is right for
   * commands ("agt" → Agents) and wrong for names: "eso" lit up Akcesfonia
   * (a-k-c-E-S-f-O) and ranked it with Esono. A name that CONTAINS what was
   * typed, or starts a word with it, is what was meant; the loose match is
   * only the fallback when nothing does. */
  const q = fold(query.trim());
  const hits = search(items, q, 40);
  const strong = hits.filter(hit => hit.item.title.includes(q) || (hit.item.keywords ?? "").includes(q)
    || hit.item.title.split(/\s+/).map(word => word[0] ?? "").join("").startsWith(q));
  return (strong.length ? strong : hits).slice(0, limit).map(hit => ({ project: hit.item.project, hits: hit.match.hits }));
}

/** The commands for a `/` query. */
export function matchCommands(query: string): CommandDef[] {
  const q = fold(query);
  return COMMANDS.filter(one => !q || one.command.startsWith(q) || fold(one.label).startsWith(q));
}

/** A command the text starts with: `/request …`. */
export function leadingCommand(text: string): { command: Command; end: number } | null {
  const found = /^\s*\/(request|note|log|todo)(?=\s|$)/.exec(text);
  return found ? { command: found[1] as Command, end: found[0].length } : null;
}

/** The mentions whose `@Name` is still in the text. ⚠️ A mention is the text,
 *  not a record kept beside it: delete the words and the mention goes too. */
export function liveMentions(text: string, mentions: Mention[]): Mention[] {
  const seen = new Set<number>();
  return mentions.filter(one => {
    if (seen.has(one.projectId) || !text.includes(`@${one.name}`)) return false;
    seen.add(one.projectId);
    return true;
  });
}

/** What the mirror behind the field paints: the text in runs, the mentions and
 *  the command as their own runs so they can wear a pill. */
export type Run = { text: string; kind: "plain" } | { text: string; kind: "mention"; projectId: number } | { text: string; kind: "command" };

export function runs(text: string, mentions: Mention[]): Run[] {
  const out: Run[] = [];
  let rest = text;
  const command = leadingCommand(text);
  if (command) {
    const lead = text.slice(0, command.end);
    const space = lead.length - lead.trimStart().length;
    if (space) out.push({ text: lead.slice(0, space), kind: "plain" });
    out.push({ text: lead.slice(space), kind: "command" });
    rest = text.slice(command.end);
  }
  const live = liveMentions(text, mentions);
  while (rest) {
    let best: { at: number; mention: Mention } | null = null;
    for (const mention of live) {
      const at = rest.indexOf(`@${mention.name}`);
      if (at >= 0 && (!best || at < best.at || (at === best.at && mention.name.length > best.mention.name.length))) best = { at, mention };
    }
    if (!best) {
      out.push({ text: rest, kind: "plain" });
      break;
    }
    if (best.at) out.push({ text: rest.slice(0, best.at), kind: "plain" });
    const token = `@${best.mention.name}`;
    out.push({ text: token, kind: "mention", projectId: best.mention.projectId });
    rest = rest.slice(best.at + token.length);
  }
  return out;
}

/** A draft as it is sent: the words (the command taken off the front), the
 *  command, and the projects mentioned. */
export function outgoing(text: string, mentions: Mention[]): { text: string; command: Command | null; mentions: { projectId: number }[] } {
  const command = leadingCommand(text);
  const body = (command ? text.slice(command.end) : text).trim();
  return {
    text: body,
    command: command?.command ?? null,
    mentions: liveMentions(text, mentions).map(one => ({ projectId: one.projectId })),
  };
}

/** Polish plural: 1 zmiana, 2–4 zmiany, 5 zmian, 22 zmiany, 25 zmian. */
export function plural(n: number, one: string, few: string, many: string): string {
  if (n === 1) return one;
  const tens = n % 100;
  const units = n % 10;
  if (units >= 2 && units <= 4 && !(tens >= 12 && tens <= 14)) return few;
  return many;
}

/** "0:07", "1:42" — a recording's length. */
export function clockOf(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/** Where the words found by a search are in a snippet, for highlighting:
 *  `[start, end)` pairs, folded so "krakow" lights "Kraków". ⚠️ The offsets
 *  are trusted only when folding kept the length (AGENTS 311). */
export function marks(snippet: string, query: string): [number, number][] {
  const q = fold(query.trim());
  if (!q) return [];
  const folded = fold(snippet);
  if (folded.length !== snippet.length) return [];
  const out: [number, number][] = [];
  let at = folded.indexOf(q);
  while (at >= 0 && out.length < 8) {
    out.push([at, at + q.length]);
    at = folded.indexOf(q, at + q.length);
  }
  return out;
}

/** A Helm day as the thread names it: "Dziś", "Wczoraj", "wt., 27 paź". */
export function dayName(day: string, today: string): string {
  if (day === today) return "Dziś";
  const yesterday = new Date(`${today}T12:00:00Z`);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  if (day === yesterday.toISOString().slice(0, 10)) return "Wczoraj";
  const date = new Date(`${day}T12:00:00Z`);
  const weekday = new Intl.DateTimeFormat("pl-PL", { weekday: "short", timeZone: "UTC" }).format(date);
  const dm = new Intl.DateTimeFormat("pl-PL", { day: "numeric", month: "short", timeZone: "UTC" }).format(date);
  return `${weekday} ${dm}`;
}

/** A day Helm will take: `YYYY-MM-DD` and a real date. */
export function isDay(day: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(day) && !Number.isNaN(Date.parse(`${day}T12:00:00Z`));
}
