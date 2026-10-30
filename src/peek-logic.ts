/* Batch 13 (builder S): what the new sources' events SAY, as peeks. Pure —
 * no Tauri, no DOM — so tests/peek-sources.test.mjs can run it under node.
 * The wiring (listening, running actions) is peek-sources.ts.
 *
 * Copy is the island's Polish, short: the title says it, `line` only when a
 * second fact is worth a glance. */
import type { Peek, PeekKind } from "./peeks";

/* ── What Rust sends (devices.rs, arrivals.rs, curtain.rs) ──────────────── */

export interface BudsEvent { name: string; connected: boolean; battery: number | null }
export type PowerEvent =
  | { what: "charger"; plugged: boolean; percent: number }
  | { what: "low"; percent: number; urgent: boolean };
export interface Arrival { token: string; kind: "download" | "screenshot"; name: string; thumb: string | null }
/** `/api/notch` `peeks` (Helm's feed). */
export interface HelmPeek { id: string; kind: "paid" | "logged"; title: string; line?: string; at: string }

/** A peek without its click: the wiring adds what a click does. */
export type PeekShape = Omit<Peek, "action">;

/** "Mateusz's Buds3 Pro" → "Buds"; anything else keeps its name, owner dropped. */
export function shortDevice(name: string): string {
  const bare = name.replace(/\(.*?\)/g, "").replace(/^[^'’]*['’]s\s+/, "").trim();
  if (/buds/i.test(bare)) return "Buds";
  return bare.length > 22 ? `${bare.slice(0, 21)}…` : bare || name.trim();
}

export function budsPeek(e: BudsEvent): PeekShape {
  const who = shortDevice(e.name);
  const level = e.battery != null && e.battery >= 0 && e.battery <= 100 ? e.battery : null;
  if (!e.connected) return { id: `buds:${e.name}`, kind: "buds", icon: "buds", title: `${who} rozłączone`, tone: "neutral" };
  return {
    id: `buds:${e.name}`, kind: "buds", icon: "buds",
    title: level == null ? `${who} podłączone` : `${who} podłączone · ${level}%`,
    ...(level == null ? {} : { level: level / 100 }),
    tone: level != null && level <= 20 ? "warn" : "good",
  };
}

export function micPeek(muted: boolean): PeekShape {
  return muted
    ? { id: "mic", kind: "mic", icon: "micOff", title: "Mikrofon wyciszony", tone: "warn" }
    : { id: "mic", kind: "mic", icon: "mic", title: "Mikrofon włączony", tone: "good" };
}

/** System volume (batch 13: left to S). One id, so a held key replaces itself. */
export function volumePeek(e: { level: number; muted: boolean }): PeekShape {
  const level = Math.max(0, Math.min(100, Math.round(e.level)));
  return e.muted || level === 0
    ? { id: "volume", kind: "volume", icon: "volumeOff", title: "Wyciszono", level: 0, tone: "neutral", ttl: 1800 }
    : { id: "volume", kind: "volume", icon: "volume", title: `Głośność ${level}%`, level: level / 100, tone: "neutral", ttl: 1800 };
}

export function powerPeek(e: PowerEvent): PeekShape {
  if (e.what === "low") {
    return { id: "power:low", kind: "power", icon: "batteryLow", title: `Bateria ${e.percent}%`,
      level: e.percent / 100, tone: "warn", urgent: e.urgent, ...(e.urgent ? { ttl: 8000 } : {}) };
  }
  return e.plugged
    ? { id: "power:charger", kind: "power", icon: "charging", title: `Ładowanie · ${e.percent}%`, level: e.percent / 100, tone: "good" }
    : { id: "power:charger", kind: "power", icon: "battery", title: `Na baterii · ${e.percent}%`, level: e.percent / 100, tone: "neutral" };
}

/** A long name keeps its start and its extension: "faktura_wrzesie…_2026.pdf". */
export function fitName(name: string, max = 28): string {
  if (name.length <= max) return name;
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 && name.length - dot <= 6 ? name.slice(dot) : "";
  return `${name.slice(0, max - ext.length - 1)}…${ext}`;
}

export function filePeek(a: Arrival): PeekShape {
  if (a.kind === "screenshot") {
    return { id: `screenshot:${a.token}`, kind: "screenshot", icon: "image", title: "Zrzut ekranu",
      ...(a.thumb ? { art: a.thumb } : {}), tone: "neutral" };
  }
  return { id: `download:${a.token}`, kind: "download", icon: "download", title: `Pobrano: ${fitName(a.name)}`, tone: "neutral" };
}

export function focusPeek(site: string): PeekShape {
  return { id: `focus:${site}`, kind: "focus", icon: "focus", title: "Wracamy?", line: site, tone: "accent" };
}

/* ── Helm's feed: each id once, across launches ─────────────────────────── */

/** Remembered ids, newest last, capped (as moments.ts `remember`). */
export function remember(seen: string[], id: string, keep = 80): string[] {
  return [...seen.filter(one => one !== id), id].slice(-keep);
}

/** The feed's entries not shown yet, oldest first, from a raw `/api/notch`
 *  reading (`peeks` may be missing, or junk from an older Helm). */
export function freshHelmPeeks(raw: unknown, seen: readonly string[]): HelmPeek[] {
  const list = (raw as { peeks?: unknown } | null)?.peeks;
  if (!Array.isArray(list)) return [];
  return list
    .filter((p): p is HelmPeek => !!p && typeof p.id === "string" && (p.kind === "paid" || p.kind === "logged") && typeof p.title === "string" && p.title.trim() !== "")
    .filter(p => !seen.includes(p.id))
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

export function helmPeek(p: HelmPeek): PeekShape {
  const kind: PeekKind = p.kind;
  return {
    id: p.id.startsWith(`${kind}:`) ? p.id : `${kind}:${p.id}`, kind,
    icon: kind === "paid" ? "money" : "stopwatch",
    title: p.title.trim().slice(0, 60),
    ...(p.line?.trim() ? { line: p.line.trim().slice(0, 60) } : {}),
    tone: kind === "paid" ? "good" : "accent",
  };
}

/** Once per site per block: the key to remember. No running block, no peek. */
export function focusKey(block: number | null, site: string): string | null {
  return block == null || !site.trim() ? null : `${block}:${site.trim().toLowerCase()}`;
}

/* ── Settings → Peeks ───────────────────────────────────────────────────── */

/** Switch a kind: off is stored as `false`, on is the absence (contract). */
export function withKind(peeks: Partial<Record<string, boolean>> | undefined, kind: string, on: boolean): Record<string, boolean> {
  const next: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(peeks ?? {})) if (v === false && k !== kind) next[k] = false;
  if (!on) next[kind] = false;
  return next;
}
