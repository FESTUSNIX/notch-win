/* A project, and everything you open to work on it.
 *
 * ⚠️ There is no editor for these, and that is the design. A workspace screen
 * with a folder picker and an app list is a form to fill in before the feature
 * does anything, which is how a feature like this gets used once. They are made
 * out of rows that are already on screen instead:
 *
 *   a live session   → "Save as a workspace"   (its folder is already known)
 *   an application   → "Add to a workspace"    (a sub-menu of the ones you have)
 *   a workspace      → Enter opens everything; Tab offers the parts
 *
 * The folder is the id, so saving the same session twice is the same workspace
 * rather than a second one with the same name.
 */
import { listen } from "@tauri-apps/api/event";
import { call, native } from "./task-client";

export interface Workspace {
  name: string;
  folder: string;
  apps: string[];
}

let kept = new Map<string, Workspace>();
let onChange: (() => void) | null = null;

export async function boot(changed: () => void) {
  onChange = changed;
  try {
    kept = new Map(Object.entries(await call<Record<string, Workspace>>("get_workspaces")));
  } catch { /* none yet */ }
  if (native) {
    await listen<Record<string, Workspace>>("notch:workspaces", event => {
      kept = new Map(Object.entries(event.payload));
      onChange?.();
    });
  }
}

export function all(): [string, Workspace][] { return [...kept.entries()]; }

export function count(): number { return kept.size; }

export function has(folder: string): boolean { return kept.has(folder); }

/** The last segment of a path — `akcesfonia`, not 60 characters of drive. */
export function leaf(folder: string): string {
  const parts = folder.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? folder;
}

/** ⚠️ Applied locally before the round trip, so the palette redraws on the
 *  keystroke rather than on the reply — same contract as the stars. */
export async function save(folder: string, name?: string) {
  const workspace: Workspace = kept.get(folder)
    ?? { name: name || leaf(folder), folder, apps: [] };
  kept.set(folder, workspace);
  onChange?.();
  await call("save_workspace", { id: folder, workspace });
}

export async function remove(folder: string) {
  kept.delete(folder);
  onChange?.();
  await call("remove_workspace", { id: folder });
}

export async function addApp(folder: string, path: string): Promise<string> {
  const workspace = kept.get(folder);
  if (workspace && !workspace.apps.includes(path)) workspace.apps.push(path);
  onChange?.();
  return await call<string>("add_to_workspace", { id: folder, path });
}

/** Everything it holds. Returns what actually opened, so the pill can say. */
export async function open(folder: string): Promise<string> {
  return await call<string>("open_workspace", { id: folder });
}
