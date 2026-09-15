/* What the open screen can do, on an arc struck off the island's far corner.
 *
 * Every screen had grown a footer: a sync line, a sentence about how dragging
 * works, a "Clear all". Each was a whole row of 10px grey text at the foot of
 * the panel — the place nothing is read — and each one broke the bottom padding
 * it sat inside, so no two screens ended the same way.
 *
 * ⚠️ They are NOT in the header. That was the first home for them, beside the
 * pin, the settings and the close, and it is the wrong one: those four are the
 * same on every screen, and a control that changes with the screen mixed in
 * among four that never do reads as an orphan wherever you put it.
 *
 * ⚠️ And they are not welded to the island either. The second home was a
 * shape moulded into its underside, and a lump on a corner cannot be made to
 * look deliberate however it is filleted. A line a gap out from the corner,
 * following its contour, reads as its own object — the same idea as the
 * settings orb on the agents notch.
 *
 * ⚠️ And there is no `?`. A sentence explaining a gesture is worth saying
 * once, in the docs — a permanent button whose only job is to re-explain
 * dragging is a footer that learned to hide.
 */
import { element } from "./dom";
import { paintIcon, type TaskIcon } from "./task-icons";

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
export function paintTools(host: HTMLElement, spec: ScreenTools): number {
  host.replaceChildren();
  const tools = spec.tools ?? [];
  for (const [index, tool] of tools.entries()) {
    const button = element("button", `screen-tool${tool.tone ? ` is-${tool.tone}` : ""}`);
    (button as HTMLButtonElement).type = "button";
    (button as HTMLButtonElement).disabled = !!tool.disabled || !tool.run;
    button.setAttribute("aria-label", tool.label);
    button.title = tool.label;
    paintIcon(button, tool.icon);
    if (tool.run) button.onclick = tool.run;

    /* The order they arrive in when the arc opens. ⚠️ From the island
     * OUTWARD: the line swings away from the corner, so the action nearest the
     * corner is the one it reaches first. Counting the other way makes the far
     * ones appear over a line that has not got to them yet.
     *
     * ⚠️ Where each one SITS is not decided here. The angle depends on the
     * arc's radius, which is sprung, so it is written by the paint loop in
     * `island-surface.ts` every frame — this only builds the buttons. */
    button.style.setProperty("--tool-i", String(index));
    host.append(button);
  }
  /* The count, so the shell can size the tab — or not draw it at all. A tab
   * with nothing in it is a shape hanging off the island for no reason. */
  return tools.length;
}
