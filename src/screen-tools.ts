/* What the open screen can do, in a tab hanging off the island's bottom edge.
 *
 * Every screen had grown a footer: a sync line, a sentence about how dragging
 * works, a "Clear all". Each was a whole row of 10px grey text at the foot of
 * the panel — the place nothing is read — and each one broke the bottom padding
 * it sat inside, so no two screens ended the same way.
 *
 * ⚠️ They are NOT in the header. That was the first home for them, beside the
 * pin, the settings and the close, and it is the wrong one: those four are the
 * same on every screen, and a control that changes with the screen mixed in
 * among four that never do reads as an orphan wherever you put it. The tab is
 * a place of its own, whose contents are allowed to change — and it is only
 * drawn when there is something in it, so a screen with no tools costs no
 * chrome at all.
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

    /* ⚠️ Laid on the ARC, not in a row. The tab is a curve, and a straight
     * line of buttons inside a curved shape reads as a row that happens to have
     * a curved background — which is the thing this replaced. Each one sits a
     * little deeper the nearer it is to the middle of the span, which is where
     * the shape has the most room: a circle's sagitta, in miniature.
     *
     * ⚠️ A distance, not a direction. Which way is "deeper" depends on which
     * edge the island is on, and only the stylesheet knows that — so this hands
     * over a length and `#island-tools[data-edge]` picks the axis and the sign.
     * Written as a custom property rather than as `translate` for that reason. */
    const middle = (tools.length - 1) / 2;
    const away = tools.length > 1 ? (index - middle) / (middle || 1) : 0;
    button.style.setProperty("--tool-dip", `${Math.round((1 - away * away) * 5)}px`);
    host.append(button);
  }
  /* The count, so the shell can size the tab — or not draw it at all. A tab
   * with nothing in it is a shape hanging off the island for no reason. */
  return tools.length;
}
