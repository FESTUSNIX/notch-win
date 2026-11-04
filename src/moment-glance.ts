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
import { face } from "./face";

export interface MomentHooks {
  /** A button was pressed. */
  act: (moment: Moment, button: MomentButton) => void;
  /** The moment itself was pressed: open what it is about. */
  open: (moment: Moment) => void;
  /** Its close key: away, without acting. */
  dismiss: (moment: Moment) => void;
  /** The content's natural depth changed, in CSS px. */
  measured: (depth: number) => void;
  /** A photo may take more depth than a note (not on a side edge, whose glance is a fixed depth). */
  mayGrow: (on: boolean) => boolean;
  /** Whether pressing its body goes anywhere (the cursor says so). */
  opens: (moment: Moment) => boolean;
  /** Typing an answer: the island takes the keyboard, or gives it back. */
  input: (active: boolean) => Promise<unknown>;
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
  gabi: null,
};

export class MomentGlance {
  private inner = element("div", "m-inner");
  private text = element("div", "m-text");
  /** Typing an answer right now: the moment holds, and a repaint leaves the field alone. */
  private writing = false;
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
    const head = element("div", "m-head");
    head.append(this.kicker, this.title);
    this.text.append(head, this.line, this.detail);
    this.close.type = "button";
    paintIcon(this.close, "close");
    this.close.setAttribute("aria-label", "Dismiss");
    this.close.dataset.tip = "Dismiss";
    this.close.addEventListener("click", event => {
      event.stopPropagation();
      if (this.shown) this.hooks.dismiss(this.shown);
    });
    this.top.append(this.tile, this.text, this.close);
    this.acts.append(this.chips, this.buttons);
    this.inner.append(this.top, this.acts);
    host.append(this.inner);
    host.addEventListener("click", () => { if (this.shown) this.hooks.open(this.shown); });
  }

  get moment(): Moment | null { return this.shown; }
  get typing(): boolean { return this.writing; }

  /** Typing an answer in place (hers): the buttons make way for a field. Enter
   *  sends, Escape puts the buttons back. ⚠️ The island refuses the keyboard by
   *  default, so it has to ask for it, and always give it back. */
  write(moment: Moment, send: (text: string) => void) {
    if (this.writing || this.shown?.key !== moment.key) return;
    this.writing = true;
    const field = element("input", "m-reply") as HTMLInputElement;
    field.type = "text";
    field.maxLength = 200;
    field.placeholder = "Odpisz…";
    field.setAttribute("aria-label", "Odpowiedź");
    const go = element("button", "m-btn is-primary") as HTMLButtonElement;
    go.type = "button";
    go.append(element("span", "m-btn-label", "Wyślij"));
    const before = [...this.acts.childNodes];
    const stop = () => {
      if (!this.writing) return;
      this.writing = false;
      void this.hooks.input(false).catch(() => {});
      if (this.shown?.key === moment.key) this.acts.replaceChildren(...before);
      this.remeasure();
    };
    const submit = () => {
      const value = field.value.trim();
      if (!value) return;
      stop();
      send(value);
    };
    field.addEventListener("click", event => event.stopPropagation());
    field.addEventListener("keydown", event => {
      event.stopPropagation();
      if (event.key === "Enter") submit();
      else if (event.key === "Escape") stop();
    });
    field.addEventListener("blur", () => { window.setTimeout(() => { if (document.activeElement !== go) stop(); }, 120); });
    go.addEventListener("click", event => { event.stopPropagation(); submit(); });
    this.acts.replaceChildren(field, go);
    this.remeasure();
    void this.hooks.input(true).then(() => field.focus()).catch(() => stop());
  }

  /** The picture, a size up or back (hers). */
  private enlarge() {
    const big = this.host.dataset.big !== "true";
    if (!this.hooks.mayGrow(big)) return;
    this.host.dataset.big = String(big);
    this.remeasure();
  }

  /** Draw one moment (or keep the last one while the island folds it away). */
  paint(moment: Moment | null) {
    if (!moment) return;
    const same = this.shown?.key === moment.key && this.shown.line === moment.line && this.shown.title === moment.title
      && this.shown.photo === moment.photo
      && this.shown.kicker === moment.kicker && JSON.stringify(this.shown.detail) === JSON.stringify(moment.detail)
      && JSON.stringify(this.shown.buttons) === JSON.stringify(moment.buttons);
    this.shown = moment;
    if (same) return;
    const host = this.host;
    host.dataset.kind = moment.kind;
    host.toggleAttribute("data-inert", !this.hooks.opens(moment));
    host.dataset.sticky = String(moment.sticky);
    host.dataset.key = moment.key;
    host.dataset.agent = moment.agent ?? "";
    host.dataset.tone = moment.tone ?? "";
    host.dataset.photo = String(!!moment.photo);
    delete host.dataset.big;
    this.hooks.mayGrow(false);
    if (moment.accent) host.style.setProperty("--m", moment.accent);
    else host.style.removeProperty("--m");

    // ⚠️ `paintIcon` skips a name it already drew; the badge is cleared with it, so both are drawn afresh.
    delete this.tile.dataset.icon;
    this.tile.replaceChildren();
    this.tile.dataset.agent = moment.agent ?? "";
    /* The Guardian's own moment (2 Nov): his face on its tile, in the shield's
     * place — worried over a warning, glad over good news. */
    const his = face.enabled && moment.icon === "guardian";
    this.tile.classList.toggle("has-face", his);
    if (his) face.mount(this.tile, "moment", { px: 40, zoom: 1.35, mood: () => moment.tone === "warn" ? "alert" : moment.tone === "good" ? "happy" : null });
    else {
      face.unmount("moment");
      if (moment.photo) {
        const image = element("img", "m-photo") as HTMLImageElement;
        image.alt = "";
        image.src = moment.photo;
        image.addEventListener("click", event => { event.stopPropagation(); this.enlarge(); });
        this.tile.append(image);
      } else paintIcon(this.tile, moment.icon);
    }
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
    this.close.hidden = !moment.sticky && moment.kind !== "gabi";

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
    // A picture takes the height: its answers go beside it, under the words.
    else if (moment.photo) this.text.append(this.acts);
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
