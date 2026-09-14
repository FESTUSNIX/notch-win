/* The pure half of the media screen: names, clocks, waveforms.
 *
 * Split out so it can be tested under `node --test` — screen-media.ts reaches
 * for the DOM and for Tauri's event bridge on import, and neither exists there.
 */

/** `Spotify.exe`, `308046B0AF4A39CB` (Firefox), `Brave` … into something a
 *  person recognises. Unknown ids keep their own name rather than a lie. */
const SOURCES: Record<string, string> = {
  "spotify.exe": "Spotify",
  brave: "Brave",
  "msedge.exe": "Edge",
  "chrome.exe": "Chrome",
  "firefox.exe": "Firefox",
  "308046b0af4a39cb": "Firefox",
  "vlc.exe": "VLC",
  "microsoft.zunemusic_8wekyb3d8bbwe!microsoft.zunemusic": "Media Player",
};

export function sourceName(id: string): string {
  if (!id) return "";
  const known = SOURCES[id.toLowerCase()];
  if (known) return known;
  const tail = id.split("!").pop() || id;
  return tail.replace(/\.exe$/i, "");
}

export function clock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const whole = Math.floor(seconds);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

/** Endpoint names whose interesting half is in the brackets. */
const GENERIC = /^(headphones?|speakers?|headset|earphones?|line out)$/i;

/** Windows names an endpoint "<form factor> (<adapter>)", and which half is
 *  worth showing depends on which one is generic.
 *
 *  ⚠️ Both directions are real, which is why this is not a one-line strip:
 *  "Headphones (6- Mateusz's Buds3 Pro)" hides the device in the brackets,
 *  while "DELL U2724D (NVIDIA High Definition Audio)" hides the *driver* there
 *  and the monitor is the part outside. Taking the brackets every time renames
 *  every monitor to its graphics card. */
export function deviceName(raw: string): string {
  const match = raw.match(/^(.*?)\s*\((.*)\)\s*$/);
  if (!match) return raw.trim();
  const head = match[1].trim();
  // "6- Mateusz's Buds3 Pro" — the index is Windows' own, and means nothing.
  const inner = match[2].replace(/^\d+-\s*/, "").trim();
  if (!head) return inner || raw.trim();
  return GENERIC.test(head) ? inner || head : head;
}

/** A waveform for a track, without any audio.
 *
 * ⚠️ Synthetic, and the code should say so plainly: Windows' transport controls
 * hand over metadata, never samples, and nothing here captures the loopback
 * stream. What makes it honest rather than decorative is that it is
 * *deterministic* — seeded from the title and artist, so one track always draws
 * the same shape and a different track visibly draws a different one. Random
 * bars redrawn each render would be a lie that also flickers.
 *
 * The envelope keeps it looking like audio instead of noise: quieter at the
 * head and tail, louder through the middle. */
export function waveform(seed: string, bars: number): number[] {
  // FNV-1a, then xorshift32 — small, dependency-free, and stable across runs.
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  let x = hash || 1;
  const out: number[] = [];
  for (let i = 0; i < bars; i++) {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5; x |= 0;
    const noise = ((x >>> 0) % 1000) / 1000;
    const envelope = 0.5 + 0.5 * Math.sin((i / Math.max(1, bars - 1)) * Math.PI);
    out.push(Math.max(0.14, Math.min(1, (0.32 + 0.68 * noise) * envelope)));
  }
  return out;
}

/** How long a run took, the way a person would say it.
 *
 * ⚠️ **Must stay identical to `sessions::spoken` in Rust.** The same duration
 * is written twice on the same event — once into the Windows toast, once into
 * the notch's own tooltip — and two spellings of "4m 12s" side by side read as
 * two different numbers. The Rust test carries the same table as this one's.
 */
export function spoken(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/* ── Agent sessions ───────────────────────────────────────────────────────
 * Here rather than in `screen-agents.ts` for one blunt reason: node's
 * type-stripping refuses a `constructor(private host: HTMLElement)` parameter
 * property, so nothing in a screen class's file can be imported by a node
 * test. This file is where the strip's pure formatting lives for exactly that
 * reason, whatever its name suggests. */

/** `1.3M`, `48k`, `900`. Tokens are read at a glance or not at all, and past
 *  ten million the decimal is noise rather than precision. */
export function tokens(count: number): string {
  if (count >= 1e6) return `${(count / 1e6).toFixed(count < 1e7 ? 1 : 0)}M`;
  if (count >= 1000) return `${Math.round(count / 1000)}k`;
  return String(count);
}

/** How long a session has been in its current state. One unit, never two: a
 *  session left open since yesterday is "2d", not "31h 12m". */
export function held(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  const hours = Math.floor(seconds / 3600);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}
