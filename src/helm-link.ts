/* The cockpit's pure half: what `/api/notch` says, and the joins made on it.
 *
 * codenotch is where Mateusz RUNS the work and Helm's web is where he manages
 * it. `/api/notch` is the bridge (helm.rs reads it once a minute, as him): his
 * own time today and the agents', what needs him, and every project that has a
 * folder on this PC, with the requests open on it. Everything here joins that
 * reading to what the island already knows — a Claude Code session to the
 * project and request it is on, a queue entry to its project's logo.
 *
 * ⚠️ No runtime imports, on purpose. `node --test` loads this file directly
 * (tests/helm-link.test.mjs), and Node's resolver does not add the extensions
 * Vite does — one `import { x } from "./dom"` and the whole test file fails to
 * load, naming this file rather than the reason. Types are erased and safe.
 *
 * ⚠️ A Helm without `/api/notch` (404) is a normal state, not an error: the
 * reading is `null` and every function here answers "nothing" for it, so the
 * clock, the needs, the agent links and Start with Claude simply are not drawn.
 */

export interface NotchProject {
  id: number;
  name: string;
  /** Changes when the logo does; null when the project has none. */
  logoVersion: string | number | null;
  /** Helm's identity hue name: blue, orange, aqua… */
  hue: string | null;
  client: string | null;
  personal: boolean;
}

export interface NotchRequest {
  id: number;
  title: string;
  status: "todo" | "doing";
  /** Minutes. */
  estimate: number | null;
  startedAt: string | null;
}

export interface NotchFolder {
  /** The repo's folder name — what the Agents screen calls the session's project. */
  folder: string;
  /** Its full path on this PC, when Helm knows it. */
  path: string | null;
  project: NotchProject;
  requests: NotchRequest[];
}

export type NeedKind = "reminder" | "renewal" | "request" | "meeting";

export interface NotchNeed {
  key: string;
  kind: NeedKind;
  title: string;
  context: string | null;
  amount: number | null;
  at: string | null;
  /** A Helm path to open in the browser. */
  href: string | null;
  /** A meeting's link. */
  join: string | null;
}

export interface Notch {
  day: string;
  /** Today's minutes: his own, and the agents'. */
  clock: { you: number; agents: number };
  /** Most urgent first, at most eight. */
  needs: NotchNeed[];
  folders: NotchFolder[];
}

/** What Done on a request answers: the time Helm suggests logging. */
export interface Suggestion {
  minutes: number;
  you: number;
  agent: number;
  estimate: number | null;
  /** False when the agents' time ran past what the work was estimated at. */
  capped: boolean;
}

/** The reading, or null when it is absent or not the shape this build reads.
 *
 * ⚠️ Checked rather than trusted: the deployed Helm and this build move
 * separately, and a field renamed on the other side must hide the cockpit,
 * not throw inside a render that also draws the rest of Today. */
export function readNotch(raw: unknown): Notch | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Partial<Notch>;
  if (!value.clock || !Array.isArray(value.folders)) return null;
  return {
    day: String(value.day ?? ""),
    clock: { you: Number(value.clock.you) || 0, agents: Number(value.clock.agents) || 0 },
    needs: Array.isArray(value.needs) ? value.needs.slice(0, 8) : [],
    folders: value.folders.filter(f => f && typeof f.folder === "string" && f.project),
  };
}

/** A path as a comparison key: one separator, no trailing one, one case. */
export function pathKey(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** The Helm folder a Claude Code session is working in.
 *
 * ⚠️ The full PATH first, then the name. Two checkouts of one repo have the
 * same folder name and are not the same workspace (AGENTS on workspaces), so a
 * path Helm knows wins over a name that merely matches; the name is the
 * fallback the contract promises (`folders[].folder`, lower-cased, against the
 * session's project as the Agents screen knows it). */
export function folderFor(session: { project: string; folder?: string | null }, notch: Notch | null): NotchFolder | null {
  if (!notch) return null;
  if (session.folder) {
    const mine = pathKey(session.folder);
    const exact = notch.folders.find(f => f.path && pathKey(f.path) === mine);
    if (exact) return exact;
  }
  const name = session.project.trim().toLowerCase();
  return notch.folders.find(f => f.folder.trim().toLowerCase() === name) ?? null;
}

/** The request a folder is on: the one marked doing, the most recently started
 *  if several; none when nothing is doing. */
export function doingRequest(folder: NotchFolder | null): NotchRequest | null {
  const doing = (folder?.requests ?? []).filter(r => r.status === "doing");
  if (!doing.length) return null;
  const at = (r: NotchRequest) => (r.startedAt ? Date.parse(r.startedAt) || 0 : 0);
  return doing.reduce((best, one) => (at(one) > at(best) ? one : best));
}

/** A project by its Helm id. */
export function projectById(id: number | null | undefined, notch: Notch | null): NotchProject | null {
  if (id == null || !notch) return null;
  return notch.folders.find(f => f.project.id === id)?.project ?? null;
}

/** The folder holding a request, by the request's id. */
export function folderOfRequest(id: number, notch: Notch | null): NotchFolder | null {
  return notch?.folders.find(f => f.requests.some(r => r.id === id)) ?? null;
}

/** A length of time the way Helm writes it: "45 min", "2 h", "1 h 30". */
export function spoken(minutes: number): string {
  const whole = Math.max(0, Math.round(minutes));
  const h = Math.floor(whole / 60);
  const m = whole % 60;
  if (!h) return `${m} min`;
  return m ? `${h} h ${String(m).padStart(2, "0")}` : `${h} h`;
}

/** Two letters for a project with no logo. */
export function monogram(name: string): string {
  const words = name.replace(/[^\p{L}\p{N} ]/gu, " ").split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

/** Helm's identity hues, lifted for a dark ground.
 *
 * ⚠️ Not Helm's own values: those are tuned for a white page, and the blue and
 * violet go muddy on black. The same hues, lighter — a project keeps its colour
 * across the two apps without being unreadable in one of them. */
const HUES: Record<string, string> = {
  iris: "#8a84ff", blue: "#5a9ff0", orange: "#f2875a", aqua: "#3cc99a", yellow: "#f2b632",
  magenta: "#ee93b6", green: "#4cb84c", violet: "#9a8cf0", red: "#f06a69", ink: "#9aa0ab",
};

/** A hue for a project: its own, else one picked from its name so it is stable. */
export function hueOf(hue: string | null | undefined, name = ""): string {
  if (hue && HUES[hue]) return HUES[hue];
  const names = Object.keys(HUES).filter(h => h !== "ink");
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  return HUES[names[hash % names.length]];
}

/** The request id behind a queue item, when it is a request. */
export function requestIdOf(item: { key: string; kind: string; workItemId: number | null }): number | null {
  if (item.kind !== "request") return null;
  if (item.workItemId) return item.workItemId;
  const id = Number(item.key.split(":")[1]);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export type ChipTone = "late" | "today" | "move" | "wait";

/** The one chip a row may carry, and only when it says something.
 *
 * ⚠️ ONE, in this order. Helm's own rule — at most one chip per row, and only
 * when it carries status — because two chips side by side read as a tag cloud,
 * and the row's job is its title. Late beats due-today beats whose move it is. */
export function chipFor(entry: { dueOn: string | null; kinds: string[]; projectId: number | null }, today: string, waiting: Set<number>): { tone: ChipTone; label: string } | null {
  if (entry.dueOn && entry.dueOn < today) {
    const days = Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${entry.dueOn}T12:00:00Z`)) / 86_400_000);
    return { tone: "late", label: days === 1 ? "1 day late" : `${days} days late` };
  }
  if (entry.dueOn === today) return { tone: "today", label: "Today" };
  if (entry.kinds.some(kind => kind === "attention" || kind === "followup")) return { tone: "move", label: "Your move" };
  if (entry.projectId != null && waiting.has(entry.projectId)) return { tone: "wait", label: "Waiting" };
  return null;
}

/** "15:00" for a meeting, in the 24-hour clock Helm itself uses. */
export function hhmm(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? "" : `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}

/** Złoty the way Helm writes them: "1 200 zł". */
export function zloty(amount: number): string {
  return `${Math.round(amount).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ")} zł`;
}

/** What a need says beside its title: a meeting's start, an amount, how late. */
export function needSide(need: NotchNeed, today: string): { text: string; late: boolean } | null {
  if (need.kind === "meeting" && need.at) return { text: hhmm(need.at), late: false };
  if (need.amount != null && need.amount > 0) return { text: zloty(need.amount), late: !!need.at && need.at.slice(0, 10) < today };
  if (need.at) {
    const day = need.at.slice(0, 10);
    if (day < today) return { text: "late", late: true };
    if (day === today) return { text: "today", late: false };
  }
  return null;
}

/* ── The Guardian's chips (/api/guardian/suggestions, 28 Oct) ──────────────
 *
 * Helm picks three or four things worth saying to the Guardian NOW — the
 * morning before work, a session running, an agent's run finished, time to
 * log, a call coming up, the end of the day — by rules, not by Claude. Each is
 * a short label and the full sentence its tap sends; `icon` and `kind` are
 * Helm's names for its glyph and what it is about (the island maps both). */

export interface GuardianSuggestion {
  id: string;
  /** Two to four Polish words, for the chip. */
  label: string;
  /** The sentence the tap sends. */
  prompt: string;
  /** Helm's glyph name: today, plan, next, split, play, agents, done, time… */
  icon: string;
  /** What it is about: now, day, agents, time, money, client, meeting, wrap, reply, here. */
  kind: string;
}

/** The most chips the row draws, whatever Helm sends. */
export const MAX_CHIPS = 4;

/** Helm's answer, checked: only whole chips, at most four. Null for no answer
 *  at all (a Helm without the endpoint) — then the row is EMPTY, never the old
 *  three fixed ones. */
export function readSuggestions(raw: unknown): GuardianSuggestion[] | null {
  if (!raw || typeof raw !== "object") return null;
  const list = (raw as { suggestions?: unknown }).suggestions;
  if (!Array.isArray(list)) return null;
  const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const out: GuardianSuggestion[] = [];
  for (const one of list) {
    if (!one || typeof one !== "object") continue;
    const s = one as Record<string, unknown>;
    const chip = { id: text(s.id), label: text(s.label), prompt: text(s.prompt), icon: text(s.icon), kind: text(s.kind) };
    if (!chip.label || !chip.prompt || out.some(o => o.label === chip.label)) continue;
    out.push({ ...chip, id: chip.id || chip.label });
    if (out.length === MAX_CHIPS) break;
  }
  return out;
}
