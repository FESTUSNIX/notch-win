/* What the open screen can do — the SHAPE of it, not the drawing.
 *
 * `IslandArc` lays these out on a line struck off the island's far corner;
 * this is only the vocabulary every screen's `tools()` is written against.
 *
 * ⚠️ They are NOT in the header. That was the first home for them, beside
 * the pin, the settings and the close, and it is the wrong one: those four are
 * the same on every screen, and a control that changes with the screen mixed
 * in among four that never do reads as an orphan wherever you put it. The two
 * arcs say which is which without a word — the near corner is the island, the
 * far corner is what you are looking at.
 *
 * ⚠️ And there is no `?`. A sentence explaining a gesture is worth saying
 * once, in the docs — a permanent button whose only job is to re-explain
 * dragging is a footer that learned to hide.
 */
import { type TaskIcon } from "./task-icons";

export interface Tool {
  icon: TaskIcon;
  label: string;
  /** Absent for a readout — a tool with nothing to do is still worth a title. */
  run?: () => void;
  disabled?: boolean;
  /** Draws attention: the sync tool while a sync is failing. */
  tone?: "warn";
}

export interface ScreenTools {
  tools?: Tool[];
}

/** ⚠️ Rebuilt, never diffed. The set changes with the screen and with its
 *  state — a shelf with nothing on it has no "clear" — and a stale button that
 *  still works is worse than one that has gone. */
