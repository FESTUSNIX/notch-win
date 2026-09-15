/* What the open screen can do, in the header rather than in a row of its own.
 *
 * Every screen had grown a footer: a sync line, a sentence about how dragging
 * works, a "Clear all". Each was a whole row of 10px grey text at the foot of
 * the panel — the place nothing is read — and each one broke the bottom padding
 * it sat inside, so no two screens ended the same way.
 *
 * ⚠️ They are TOOLS, not content. An instruction is a thing you want once and
 * then never again, and an action is a button; neither is worth a row of the
 * screen it describes. Both live in the header now, beside the tabs, in the one
 * place that is the same on every screen.
 */
import { element } from "./task-list";
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
  /** The sentence that used to be a footer. Shown from a `?`, on hover. */
  help?: string;
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
  if (spec.help) {
    /* ⚠️ A `?` rather than the sentence. The words are the same words; what
     * changes is that they cost nothing until wanted. A title attribute is
     * enough here — this is a hint about a gesture, not a document. */
    const ask = element("button", "screen-tool screen-help small-icon", "?");
    (ask as HTMLButtonElement).type = "button";
    ask.setAttribute("aria-label", spec.help);
    ask.title = spec.help;
    host.append(ask);
  }
}
