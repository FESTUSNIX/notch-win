/* The things you keep.
 *
 * ⚠️ Stored natively, not in `localStorage` beside the recency. That is not an
 * inconsistency: recency is a guess the palette makes about you and can afford
 * to be wrong about, and a star is something you said. A cleared WebView
 * profile is an ordinary event — losing a guess to one is a shrug, losing a
 * list you curated is a bug. See stars.rs.
 *
 * ⚠️ Held in memory and answered synchronously. The providers and the ranking
 * ask on every keystroke, and neither can await.
 */
import { listen } from "@tauri-apps/api/event";
import { call, native } from "./task-client";

/** ⚠️ Big enough to lift something out of its band, because that is the whole
 *  point of having starred it — but under PREFIX (150), so a star never buries
 *  the thing you have just named outright. */
export const STAR = 90;

/** Enough to rebuild the row without whatever produced it.
 *
 * ⚠️ An id alone would not have been enough. A star has to appear in the
 * EMPTY palette, and Everything is not asked on an empty query — so a starred
 * folder would exist in the file and show up nowhere. It is also what makes a
 * starred file survive Everything being closed. */
export interface Star {
  title: string;
  note: string;
  icon: string;
  /** `app` launches `path`, `file` opens it. Anything else is left to the
   *  provider that owns the id — screens, commands and the shelf enumerate
   *  themselves already, so they need no rebuilding. */
  kind: string;
  path: string;
}

let kept = new Map<string, Star>();
let onChange: (() => void) | null = null;

export async function boot(changed: () => void) {
  onChange = changed;
  try {
    kept = new Map(Object.entries(await call<Record<string, Star>>("get_stars")));
  } catch { /* nothing starred */ }
  if (native) {
    await listen<Record<string, Star>>("notch:stars", event => {
      kept = new Map(Object.entries(event.payload));
      onChange?.();
    });
  }
}

export function has(id: string): boolean { return kept.has(id); }

export function all(): [string, Star][] { return [...kept.entries()]; }

export function count(): number { return kept.size; }

/** ⚠️ Applied here before the round trip, so the row redraws on the
 *  keystroke rather than on the reply. The native side is the record; this is
 *  the echo. */
export async function toggle(id: string, record: Star): Promise<boolean> {
  const on = !kept.has(id);
  if (on) kept.set(id, record); else kept.delete(id);
  onChange?.();
  await call("set_star", { id, star: on ? record : null });
  return on;
}
