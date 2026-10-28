/* What the kit remembers between openings: drafts, which blocks are folded,
 * which panels are open.
 *
 * ⚠️ Every read and write is guarded. Storage can throw (a WebView profile
 * that is full or locked, a preview with storage blocked), and a fold that
 * failed to remember itself must not take the screen with it — it simply
 * forgets, the way it would on a fresh install.
 */
const PREFIX = "kit:";

export function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function save(key: string, value: unknown) {
  try {
    if (value === null || value === undefined) localStorage.removeItem(PREFIX + key);
    else localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    /* forgotten, not broken */
  }
}
