/* What the open screen can do, at the right-hand end of the header.
 *
 * Every screen had grown a footer: a sync line, a sentence about how dragging
 * works, a "Clear all". Each was a whole row of 10px grey text at the foot of
 * the panel — the place nothing is read — and each one broke the bottom padding
 * it sat inside, so no two screens ended the same way.
 *
 * ⚠️ They belong with the OTHER buttons, not floating after the tabs. Sat
 * next to the tab strip they read as orphans: a couple of glyphs adrift in the
 * middle of a header with empty space on both sides and nothing to say what
 * they were attached to. Pushed to the right they join the pin, the settings
 * and the close — one cluster of controls, divided from the panel's own by a
 * hairline because these change with the screen and those never do.
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
export function paintTools(host: HTMLElement, spec: ScreenTools) {
  host.replaceChildren();
  for (const tool of spec.tools ?? []) {
    const button = element("button", `screen-tool small-icon${tool.tone ? ` is-${tool.tone}` : ""}`);
    (button as HTMLButtonElement).type = "button";
    (button as HTMLButtonElement).disabled = !!tool.disabled || !tool.run;
    button.setAttribute("aria-label", tool.label);
    button.title = tool.label;
    paintIcon(button, tool.icon);
    if (tool.run) button.onclick = tool.run;
    host.append(button);
  }
}
