/* "Not now."
 *
 * Everything in this app that asks for attention had exactly one way to stop
 * asking: stop being true. That is right for a disk at 97% — which decays into
 * the rotation instead — and wrong for a Claude session you are deliberately
 * leaving until after lunch, which claims the pill and turns the notch amber
 * every time you glance at it.
 *
 * ⚠️ **Nothing is silenced for ever.** Every snooze has an end, the island's
 * settings say how many things are quiet, and one press brings them all back —
 * because the failure mode of a mute button is forgetting you pressed it, and
 * then wondering for a week why the app stopped telling you things.
 */
import { listen } from "@tauri-apps/api/event";
import { call, native } from "./task-client";

/** key -> unix ms at which it starts mattering again. */
let quiet: Record<string, number> = {};
let onChange: (() => void) | null = null;

export const MINUTES = 60;

export async function boot(changed: () => void) {
  onChange = changed;
  try {
    quiet = await call<Record<string, number>>("get_snoozed");
  } catch { /* nothing snoozed */ }
  if (native) {
    await listen<Record<string, number>>("notch:snoozed", event => {
      quiet = event.payload;
      onChange?.();
    });
  }
}

/** ⚠️ Checked against the clock here as well as pruned in Rust. The store is
 *  only re-read when it changes, so an entry that expires while nothing else
 *  happens would otherwise stay quiet until the next write. */
export function isQuiet(key: string): boolean {
  const until = quiet[key];
  if (!until) return false;
  if (until <= Date.now()) {
    delete quiet[key];
    return false;
  }
  return true;
}

export function count(): number {
  return Object.keys(quiet).filter(key => isQuiet(key)).length;
}

export async function hush(key: string, minutes = MINUTES) {
  quiet[key] = Date.now() + minutes * 60_000;
  onChange?.();
  await call("snooze", { key, minutes }).catch(() => {});
}

export async function wake(key = "") {
  if (key) delete quiet[key];
  else quiet = {};
  onChange?.();
  await call("unsnooze", { key }).catch(() => {});
}
