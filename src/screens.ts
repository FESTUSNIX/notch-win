/* The screens, in their built-in order. One list, three readers.
 *
 * ⚠️ This used to be TWO constants — `TABS` in `tasks.ts` and `SCREENS` in
 * `task-editor.ts` — with a comment on each saying they had to agree because
 * the two windows share no module. The windows do not share a module at
 * RUNTIME; they share every module at build time, which is a different thing,
 * and keeping two lists in step by hand was a screen that could be reordered
 * into a place it could not be shown. The ring is the third reader and the one
 * that made a third copy obviously wrong.
 *
 * Grouped, not alphabetical, and the order is the argument: what you are doing,
 * what is around you, then the machine and the day behind you.
 */
/* ⚠️ The EXTENSION is deliberate, and it is the only import in this file that
 * has one. `node --test` strips types and then resolves what is left, and
 * Node's resolver does not add extensions the way Vite does — so a bare
 * `./boards` here breaks every test that touches this module, including the
 * ring's, which has nothing to do with boards. The type import below needs no
 * extension because it is erased before Node ever sees it. */
import { screenOf } from "./boards.ts";
import type { Board } from "./boards";
import type { ScreenName } from "./island-activity";
import type { TaskIcon } from "./task-icons";

export interface ScreenDef {
  name: ScreenName;
  icon: TaskIcon;
  label: string;
  /** Reached by being SENT there rather than by walking the rail.
   *
   * ⚠️ One flag, two readers, and they have to be the same flag: `stops()`
   * keeps these off the rail, and the header shows a way back on exactly the
   * screens that have no stop of their own. Written twice, the back arrow
   * appears on a screen you can already leave, or — which is what happened —
   * on none at all. */
  offRail?: true;
}

export const SCREENS: ScreenDef[] = [
  { name: "home", icon: "home", label: "Home" },
  /* ⚠️ On the rail only while there IS one — see `stops()`. A call is the most
   * "what you are doing right now" thing this app knows about, and it is over
   * in forty minutes. */
  { name: "call", icon: "mic", label: "Call" },
  /* ⚠️ And this one is off the rail unless you put it there: the bell in the
   * header is how you reach it. The rail is for places you go on purpose; a
   * notification is something that happened to you. */
  { name: "notices", icon: "bell", label: "Notices", offRail: true },
  /* ⚠️ Off the rail unless you put it there, like the notices — the chip in
   * the header is how you reach it, and it is always there. */
  { name: "timer", icon: "timer", label: "Timer", offRail: true },
  { name: "today", icon: "today", label: "Today" },
  /* ⚠️ On the rail only while Helm is connected — see `stops()`. Beside Today
   * because it is the same question, asked of Helm: what is this day for. */
  { name: "helm", icon: "guardian", label: "Helm" },
  /* ⚠️ The player's stop exists only while something is playing. */
  { name: "media", icon: "media", label: "Playing" },
  { name: "agents", icon: "agent", label: "Agents" },
  { name: "shelf", icon: "shelf", label: "Shelf" },
  { name: "notes", icon: "note", label: "Notes" },
  { name: "calendar", icon: "calendar", label: "Calendar" },
  /* ⚠️ Off the rail unless you put it there, like the notices and the
   * timer. It is a place you visit when you want something from the machine
   * — the volume of one app, a device, a reading — and the rail is for the
   * screens you would sit on for thirty seconds. The chip in the header is
   * how you reach it, and it is always there. */
  { name: "system", icon: "system", label: "System", offRail: true },
  { name: "review", icon: "review", label: "Review" },
];

/** The screens, with this machine's boards among them.
 *
 * ⚠️ ONE splice, and a fourth reader is what made it a function. The island
 * needs it for the rail, the settings window for the list you reorder, and the
 * ring for what a wedge may point at — three copies of "boards go after Home"
 * is three chances for the rail to disagree with the list that reorders it.
 *
 * ⚠️ Right after Home, not at the end. A board is the same class of thing as
 * Home — it IS one — so it belongs beside it rather than behind Review at the
 * bottom of the rail. `railOrder` still overrides the lot.
 */
export function withBoards(boards: readonly Board[]): ScreenDef[] {
  const extra: ScreenDef[] = boards
    .filter(one => one.id !== "home")
    .map(one => ({ name: screenOf(one), icon: one.icon, label: one.name }));
  if (!extra.length) return SCREENS;
  const at = SCREENS.findIndex(one => one.name === "home");
  return [...SCREENS.slice(0, at + 1), ...extra, ...SCREENS.slice(at + 1)];
}
