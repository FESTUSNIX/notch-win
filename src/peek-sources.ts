/* Batch 13 (builder S): the island's new peek sources, wired.
 *
 * - VOLUME (devices.rs, left to S by P): the output's level or mute moved
 *   (`peek:volume`) — volume keys, the tray, the island's own slider.
 * - DEVICES (devices.rs): earbuds connected / disconnected with their battery
 *   (`peek:buds`), the default microphone muted / unmuted (`peek:mic`), the
 *   laptop battery low and the charger in or out (`peek:power`).
 * - FILES (arrivals.rs): a finished download, a saved screenshot
 *   (`peek:file`). Click opens the download / copies the screenshot; the small
 *   action shows the download in its folder / opens the screenshot. Rust holds
 *   the paths; this page only has tokens.
 * - HELM: `/api/notch` `peeks` — payments marked paid, time Helm logged by
 *   itself. Each id once, remembered across launches (`kit:peek-helm-seen`).
 * - FOCUS (curtain.rs): a locked site came to the front during a running
 *   block — the curtain is three seconds away. "Wracamy?" once per site per
 *   block; click opens Helm.
 *
 * What the copy says is peek-logic.ts; whether a kind shows at all is
 * Settings → Peeks, read by `peek()` itself.
 */
import { listen } from "@tauri-apps/api/event";
import { call, native, preview, previewBus } from "./task-client";
import { load, save } from "./kit/store";
import { peek, type Peek } from "./peeks";
import {
  budsPeek, filePeek, volumePeek, focusKey, focusPeek, freshHelmPeeks, helmPeek, micPeek, powerPeek, remember,
  type Arrival, type BudsEvent, type PeekShape, type PowerEvent,
} from "./peek-logic";

export interface PeekSourceDeps {
  /** The running Helm block's id, or null. */
  runningBlock: () => number | null;
  /** Open the island on a screen. */
  open: (screen: "helm") => void;
}

/** The small action beside a peek's click (contract Changes, builder S). */
interface Secondary { label: string; icon: string; run: () => void }
const withSecondary = (p: Peek, s: Secondary): Peek => ({ ...p, secondary: s });

const quietly = (command: string, args: Record<string, unknown>) => () => { void call(command, args).catch(() => {}); };

/** One source's event, natively from Rust and in a preview off `previewBus`. */
async function on<T>(name: string, fn: (payload: T) => void) {
  if (native) await listen<T>(name, event => fn(event.payload));
  else previewBus.addEventListener(name, event => fn((event as CustomEvent<T>).detail));
}

const plain = (shape: PeekShape): Peek => ({ ...shape });

function fileAction(a: Arrival): Peek {
  const p = plain(filePeek(a));
  if (a.kind === "screenshot") {
    p.action = { label: "Kopiuj", run: quietly("arrival_copy", { token: a.token }) };
    return withSecondary(p, { label: "Otwórz", icon: "open", run: quietly("arrival_open", { token: a.token }) });
  }
  p.action = { label: "Otwórz", run: quietly("arrival_open", { token: a.token }) };
  return withSecondary(p, { label: "Pokaż w folderze", icon: "folder", run: quietly("arrival_reveal", { token: a.token }) });
}

export async function bootPeekSources(deps: PeekSourceDeps) {
  await on<BudsEvent>("peek:buds", e => { peek(plain(budsPeek(e))); });
  await on<{ level: number; muted: boolean }>("peek:volume", e => { peek(plain(volumePeek(e))); });
  await on<boolean>("peek:mic", muted => { peek(plain(micPeek(muted))); });
  await on<PowerEvent>("peek:power", e => { peek(plain(powerPeek(e))); });
  await on<Arrival>("peek:file", a => { peek(fileAction(a)); });

  /* Focus: once per site per block. Session memory is enough — a block is
   * minutes long and a restart mid-block saying it once more is harmless. */
  const warned = new Set<string>();
  await on<string>("peek:focus", site => {
    const key = focusKey(deps.runningBlock(), site);
    if (!key || warned.has(key)) return;
    warned.add(key);
    peek({ ...focusPeek(site), action: { label: "Helm", run: () => deps.open("helm") } });
  });

  /* Helm's feed. ⚠️ Read from the RAW reading: `readNotch` (helm-link.ts)
   * keeps only the fields it knows, so `peeks` is gone by the time HelmSource
   * has parsed it. */
  let seen = load<string[]>("peek-helm-seen", []);
  const fromHelm = (raw: unknown) => {
    for (const p of freshHelmPeeks(raw, seen)) {
      seen = remember(seen, p.id);
      peek(plain(helmPeek(p)));
    }
    if (!preview) save("peek-helm-seen", seen);
  };
  const notchOf = (helm: unknown) => (helm as { signedIn?: boolean; notch?: unknown } | null)?.notch ?? null;
  if (native) await listen<unknown>("helm:changed", event => fromHelm(notchOf(event.payload)));
  else previewBus.addEventListener("peek:helm", event => fromHelm({ peeks: (event as CustomEvent<unknown>).detail }));
  try { fromHelm(notchOf(await call<unknown>("get_helm"))); } catch { /* not yet */ }
}
