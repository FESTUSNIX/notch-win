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
  /* ⚠️ The player's stop exists only while something is playing. */
  { name: "media", icon: "media", label: "Playing" },
  { name: "agents", icon: "agent", label: "Agents" },
  { name: "shelf", icon: "shelf", label: "Shelf" },
  { name: "notes", icon: "note", label: "Notes" },
  { name: "calendar", icon: "calendar", label: "Calendar" },
  { name: "system", icon: "system", label: "System" },
  { name: "review", icon: "review", label: "Review" },
];
