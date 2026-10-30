/* The moment glance (30 Oct): one moment (moments.ts) drawn in the island's
 * glance — between the pill and the panel, like the voice glance, and sized
 * the same way (its depth from what is in here, `measured`).
 *
 * A picture before a word: the TILE says whose it is (the agent's own mark,
 * the Guardian's shield, the calendar), its tint and the small badge on it
 * say what happened — the agent's own colour for finished, warn for a question or a limit, the
 * accent for the Guardian, the calendar's own colour for a meeting. Then the
 * kicker and the title on one line, the line under them, and the buttons:
 * quick replies as quiet chips on the left, the actions on the right with at
 * most ONE filled (AGENTS 815).
 *
 * ⚠️ Built once and written in place per moment, like the voice glance: the
 * island fades it on its own spring, and rebuilding the host would drop a
 * press halfway through.
 */
import { element } from "./dom";
import { paintIcon, type TaskIcon } from "./task-icons";
import { helmBadge, type Moment, type MomentButton } from "./moments";

export interface MomentHooks {
  /** A button was pressed. */
  act: (moment: Moment, button: MomentButton) => void;
  /** The moment itself was pressed: open what it is about. */
  open: (moment: Moment) => void;
  /** Its close key: away, without acting. */
  dismiss: (moment: Moment) => void;
  /** The content's natural depth changed, in CSS px. */
  measured: (depth: number) => void;
}

/** The badge on the tile: what happened, by kind. */
const BADGE: Record<Moment["kind"], TaskIcon | null> = {
  finished: "check",
  question: "request",
  usage: "timer",
  nudge: null,
  block: null,
  meeting: null,
  helm: null,
};

export class MomentGlance {
  private inner = element("div", "m-inner");
  private tile = element("span", "m-tile");
  private badge = element("span", "m-badge");
  private kicker = element("span", "m-kicker");
  private title = element("b", "m-title");
  private line = element("p", "m-line");
  /** The Guardian's labelled lines (batch 12): "Zapytaj …", "Uważaj …". */
  private detail = element("dl", "m-detail");
  private close = element("button", "m-close") as HTMLButtonElement;
  private top = element("div", "m-top");
  private acts = element("div", "m-acts");
  private chips = element("div", "m-chips");
  private buttons = element("div", "m-buttons");
  private shown: Moment | null = null;
  private measureFrame = 0;
  private lastDepth = 0;

  constructor(private host: HTMLElement, private hooks: MomentHooks) {
    host.setAttribute("role", "status");
    host.setAttribute("aria-live", "polite");
    const text = element("div", "m-text");
    const head = element("div", "m-head");
    head.append(this.kicker, this.title);
    text.append(head, this.line, this.detail);
    this.close.type = "button";
    paintIcon(this.close, "close");
    this.close.setAttribute("aria-label", "Dismiss");
    this.close.dataset.tip = "Dismiss";
    this.close.addEventListener("click", event => {
      event.stopPropagation();
      if (this.shown) this.hooks.dismiss(this.shown);
    });
    this.top.append(this.tile, text, this.close);
    this.acts.append(this.chips, this.buttons);
    this.inner.append(this.top, this.acts);
    host.append(this.inner);
    host.addEventListener("click", () => { if (this.shown) this.hooks.open(this.shown); });
  }

  get moment(): Moment | null { return this.shown; }

  /** Draw one moment (or keep the last one while the island folds it away). */
  paint(moment: Moment | null) {
    if (!moment) return;
    const same = this.shown?.key === moment.key && this.shown.line === moment.line && this.shown.title === moment.title
      && this.shown.kicker === moment.kicker && JSON.stringify(this.shown.detail) === JSON.stringify(moment.detail)
      && JSON.stringify(this.shown.buttons) === JSON.stringify(moment.buttons);
    this.shown = moment;
    if (same) return;
    const host = this.host;
    host.dataset.kind = moment.kind;
    host.dataset.sticky = String(moment.sticky);
    host.dataset.key = moment.key;
    host.dataset.agent = moment.agent ?? "";
    host.dataset.tone = moment.tone ?? "";
    if (moment.accent) host.style.setProperty("--m", moment.accent);
    else host.style.removeProperty("--m");

    // ⚠️ `paintIcon` skips a name it already drew; the badge is cleared with it, so both are drawn afresh.
    delete this.tile.dataset.icon;
    this.tile.replaceChildren();
    this.tile.dataset.agent = moment.agent ?? "";
    paintIcon(this.tile, moment.icon);
    const badge = moment.helm ? helmBadge(moment.helm.kind) : BADGE[moment.kind];
    if (badge) {
      paintIcon(this.badge, badge);
      this.tile.append(this.badge);
    }
    this.kicker.textContent = moment.kicker ?? "";
    this.kicker.hidden = !moment.kicker;
    this.title.textContent = moment.title;
    this.title.dataset.tip = moment.title;
    this.line.textContent = moment.line;
    this.line.hidden = !moment.line;
    const detail = moment.detail ?? [];
    this.detail.replaceChildren(...detail.map(d => {
      const row = element("div", "m-detail-row");
      row.append(element("dt", "", d.label), element("dd", "", d.text));
      return row;
    }));
    this.detail.hidden = !detail.length;
    this.close.hidden = !moment.sticky;

    const chips = moment.buttons.filter(b => b.chip);
    const buttons = moment.buttons.filter(b => !b.chip);
    this.chips.replaceChildren(...chips.map(b => this.button(moment, b)));
    this.buttons.replaceChildren(...buttons.map(b => this.button(moment, b)));
    this.acts.hidden = !moment.buttons.length;
    /* With no quick replies the buttons sit at the end of the top row: one
     * row of island, not a second row holding a lone button. */
    const inline = !chips.length && !detail.length && (moment.kind !== "helm" || buttons.length <= 1);
    host.dataset.inline = String(inline);
    if (inline) this.top.insertBefore(this.acts, this.close);
    else this.inner.append(this.acts);
    // A row arriving eases in, like the voice glance's rows.
    this.inner.classList.remove("is-new");
    void this.inner.offsetWidth;
    this.inner.classList.add("is-new");
    this.remeasure();
  }

  private button(moment: Moment, b: MomentButton): HTMLElement {
    const button = element("button", b.chip ? "m-chip" : `m-btn${b.primary ? " is-primary" : ""}`) as HTMLButtonElement;
    button.type = "button";
    button.dataset.act = b.id;
    if (b.icon && !b.chip) {
      const icon = element("span", "m-btn-icon");
      paintIcon(icon, b.icon);
      button.append(icon);
    }
    button.append(element("span", "m-btn-label", b.label));
    button.addEventListener("click", event => {
      event.stopPropagation();
      this.hooks.act(moment, b);
    });
    return button;
  }

  /** Ask for the depth the content needs, once per frame at most. */
  remeasure() {
    if (this.measureFrame) return;
    this.measureFrame = requestAnimationFrame(() => {
      this.measureFrame = 0;
      const pad = parseFloat(getComputedStyle(this.host).paddingTop) || 0;
      const depth = this.inner.offsetHeight + 2 * pad;
      if (Math.abs(depth - this.lastDepth) < 0.5) return;
      this.lastDepth = depth;
      this.hooks.measured(depth);
    });
  }
}
