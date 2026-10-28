/* A Claude Code session's Helm project, as a side panel: its face, the
 * session it came from, its time today, and its open requests — the one on
 * it as a chip, the rest each a press away from a terminal running Claude.
 *
 * ⚠️ One builder for both places it opens (Today's Agents block and the
 * Agents screen), so a project looks the same in each — a second copy of a
 * drawing drifts the moment it exists (AGENTS on the run ring).
 */
import { element } from "./dom";
import { paintIcon, type TaskIcon } from "./task-icons";
import { faceOf, logoTile, wordButton } from "./helm-parts";
import { doingRequest, spoken, type NotchFolder } from "./helm-link";
import { iconButton, kchip } from "./kit/parts";
import type { HelmSource } from "./screen-helm";

export interface PanelSession {
  id: string;
  project: string;
  provider?: string;
  state: string;
  doing?: string | null;
}

export function projectPanel(inner: HTMLElement, o: {
  helm: HelmSource;
  session: PanelSession;
  folder: NotchFolder;
  close: () => void;
  /** Put after the head: the "done?" a finished run asks, on the Agents screen. */
  extra?: HTMLElement | null;
  /** A way to the session itself, where the panel is not already beside it. */
  open?: (() => void) | null;
}) {
  const { helm, session, folder } = o;
  const project = folder.project;
  inner.replaceChildren();
  const head = element("div", "agent-side-head");
  head.append(logoTile(faceOf(project, helm.logo(project), null), "md"));
  const who = element("div", "agent-side-who");
  who.append(element("span", "agent-side-name", project.name));
  const via = element("span", "agent-side-via");
  const mark = element("span", "agent-side-mark");
  mark.dataset.agent = session.provider ?? "";
  paintIcon(mark, session.provider === "codex" ? "codex" : session.provider === "claude" ? "claude" : "agent");
  via.append(mark, element("span", "", session.project));
  who.append(via);
  head.append(who, iconButton("close", "Hide the project", "agent-side-close", o.close));
  inner.append(head);

  const time = helm.timeToday({ id: project.id, name: project.name });
  const figures = element("div", "agent-side-figs");
  const fig = (cls: string, icon: TaskIcon, minutes: number, tip: string) => {
    const f = element("span", `agent-side-fig ${cls}`);
    const m = element("span", "agent-side-fig-mark");
    paintIcon(m, icon);
    f.append(m, element("b", "", spoken(minutes)));
    f.dataset.tip = tip;
    return f;
  };
  if (time.you) figures.append(fig("is-you", "you", time.you, "Your time on it today"));
  if (time.agents) figures.append(fig("is-agents", "claude", time.agents, "The agents' time on it today"));
  if (o.open) {
    const go = wordButton("open", "Session", "hp-btn is-ghost agent-side-open", o.open);
    go.setAttribute("aria-label", `Open ${session.project} on the Agents screen`);
    go.dataset.tip = "The session, on the Agents screen";
    figures.append(go);
  }
  if (figures.childElementCount) inner.append(figures);
  if (o.extra) inner.append(o.extra);

  const doing = doingRequest(folder);
  const open = folder.requests.filter(r => !helm.doneHere.has(r.id));
  const title = element("h4", "agent-panel-title agent-side-title");
  title.append(element("span", "", "Open"), element("span", "k-count", String(open.length)));
  inner.append(title);
  const list = element("div", "agent-side-list");
  for (const request of open) {
    const on = request.status === "doing" && doing?.id === request.id;
    const row = element("div", `agent-side-row${on ? " is-on" : ""}`);
    row.append(element("span", "agent-side-row-title", request.title));
    const end = element("div", "agent-side-row-end");
    if (request.estimate) end.append(element("span", "agent-side-est", spoken(request.estimate)));
    /* ⚠️ Doing is a CHIP and Start is a BUTTON: two Claude marks side by
     * side, one a fact and one a press, read as the same thing twice. */
    if (on) {
      const chip = kchip("On it", "claude", "claude");
      chip.dataset.tip = "Claude is on it";
      end.append(chip);
    } else if (request.status === "todo") {
      const start = wordButton("claude", "Start", "hp-btn is-claude agent-side-start", () => helm.startWithClaude(request.id, request.title));
      start.setAttribute("aria-label", `Start ${request.title} with Claude`);
      start.dataset.tip = "Start with Claude";
      start.disabled = helm.starting.has(request.id);
      end.append(start);
    }
    row.append(end);
    list.append(row);
  }
  if (!open.length) list.append(element("p", "agent-side-empty", "Nothing open"));
  inner.append(list);
}
