/* The kit's small parts: collapsible blocks, side panels, a segmented
 * control, a toggle button and a project's chip. Helm's own (collapse.tsx,
 * side-panel.tsx, fields.tsx `Segmented`, chip.tsx) in this app's dark
 * language — one builder each, used everywhere, so the parts look the same on
 * every screen (AGENTS on a second copy of a drawing).
 */
import { element } from "../dom";
import { paintIcon, type TaskIcon } from "../task-icons";
import { logoTile, type Face } from "../helm-parts";
import { load, save } from "./store";

/* ── A block that folds ─────────────────────────────────────────────────
 *
 * A header — chevron, title, count, and whatever the block puts at its end —
 * over a body. The fold is remembered per block.
 *
 * ⚠️ The body SNAPS open and shut; the island's own spring is the motion.
 * The island measures a screen once per render, so a body easing its own
 * height is measured at the start of the ease and the panel is left at the
 * wrong size (AGENTS 511, 752) — and a `0fr → 1fr` row inside a grid item lies
 * about its height on top of that (219). The content fades in instead, which
 * costs no height.
 */
export class Block {
  readonly el: HTMLElement;
  readonly head: HTMLButtonElement;
  readonly body: HTMLElement;
  readonly end: HTMLElement;
  private countEl: HTMLElement;
  private summaryEl: HTMLElement;
  private id: string;
  private toggled: () => void;
  open: boolean;

  constructor(options: { id: string; title: string; icon?: TaskIcon; open?: boolean; className?: string; toggled: () => void }) {
    this.id = options.id;
    this.toggled = options.toggled;
    this.open = load(`fold:${options.id}`, options.open ?? true);
    this.el = element("section", `k-block ${options.className ?? ""}`.trim());
    this.el.dataset.block = options.id;
    const bar = element("div", "k-block-bar");
    this.head = element("button", "k-block-head") as HTMLButtonElement;
    this.head.type = "button";
    const chevron = element("span", "k-chevron");
    paintIcon(chevron, "down");
    this.head.append(chevron);
    if (options.icon) {
      const mark = element("span", "k-block-mark");
      paintIcon(mark, options.icon);
      this.head.append(mark);
    }
    this.head.append(element("span", "k-block-title", options.title));
    this.countEl = element("span", "k-count");
    this.countEl.hidden = true;
    this.summaryEl = element("span", "k-block-summary");
    this.head.append(this.countEl, this.summaryEl);
    this.head.onclick = () => this.toggle();
    this.end = element("div", "k-block-end");
    bar.append(this.head, this.end);
    this.body = element("div", "k-block-body");
    this.el.append(bar, this.body);
    this.paint();
  }

  toggle(open = !this.open) {
    this.open = open;
    save(`fold:${this.id}`, open);
    this.paint();
    if (open) {
      this.body.classList.remove("is-in");
      void this.body.offsetWidth;
      this.body.classList.add("is-in");
    }
    this.toggled();
  }

  /** The count beside the title; 0 or null hides it. */
  count(n: number | null) {
    this.countEl.hidden = !n;
    this.countEl.textContent = n ? String(n) : "";
  }

  /** A line said in the header while the block is folded — Now's title. */
  summary(text: string) {
    this.summaryEl.textContent = text;
  }

  private paint() {
    this.el.classList.toggle("is-open", this.open);
    this.head.setAttribute("aria-expanded", String(this.open));
    this.body.hidden = !this.open;
  }
}

/* ── A side panel ───────────────────────────────────────────────────────
 *
 * A column beside a screen's content that opens and closes: the Guardian's
 * history and project, the project of an agent's session.
 *
 * ⚠️ AGENTS 752–760, all of it, and it is why this is a class: the panel is
 * ALWAYS in the DOM, `width: 0` shut and its width open with NO transition —
 * the island's own width spring is the reveal, and `overflow: hidden` lets the
 * content arrive as the room does; an inner box holds the full width so its
 * text never re-wraps on the way; and it is `inert` shut, so Tab and a screen
 * reader do not find a panel that is not on screen. The screen that owns one
 * must re-apply its width cap when it toggles (759).
 */
export class SidePanel {
  readonly el: HTMLElement;
  readonly inner: HTMLElement;
  private id: string;
  open: boolean;

  constructor(options: { id: string; side: "left" | "right"; label: string; className?: string; open?: boolean }) {
    this.id = options.id;
    this.open = load(`side:${options.id}`, options.open ?? false);
    this.el = element("aside", `k-side is-${options.side} ${options.className ?? ""}`.trim());
    this.el.setAttribute("aria-label", options.label);
    this.inner = element("div", "k-side-in");
    this.el.append(this.inner);
    this.paint();
  }

  toggle(open = !this.open) {
    if (open === this.open) return;
    this.open = open;
    save(`side:${this.id}`, open);
    this.paint();
  }

  private paint() {
    this.el.classList.toggle("is-open", this.open);
    this.el.inert = !this.open;
    this.el.setAttribute("aria-hidden", String(!this.open));
  }
}

/* ── Buttons ──────────────────────────────────────────────────────────── */

/** A round icon button with its name in the tooltip. */
export function iconButton(icon: TaskIcon, label: string, className: string, run: () => void): HTMLButtonElement {
  const button = element("button", `k-icon ${className}`.trim()) as HTMLButtonElement;
  button.type = "button";
  paintIcon(button, icon);
  button.setAttribute("aria-label", label);
  button.dataset.tip = label;
  button.onclick = event => { event.stopPropagation(); run(); };
  return button;
}

/** A button that stays down while its thing is on: a panel's toggle.
 *
 * ⚠️ `data-on`, not `aria-pressed` alone for the look: the global
 * `button[aria-pressed=true]` paints the accent into the glyph (0,1,1), and a
 * panel toggle lit green reads as a warning rather than as "open". */
export function toggleButton(icon: TaskIcon, label: string, className: string, run: () => void): HTMLButtonElement {
  const button = iconButton(icon, label, `k-toggle ${className}`, run);
  return button;
}

export function setToggle(button: HTMLButtonElement, on: boolean) {
  button.dataset.on = String(on);
  button.setAttribute("aria-pressed", String(on));
}

/** Helm's segmented control: a recessed track, the current segment raised. */
export function segmented<T extends string>(options: { label: string; value: T; choices: { value: T; label: string; icon?: TaskIcon }[]; change: (value: T) => void; disabled?: boolean; className?: string }): HTMLElement {
  const track = element("div", `k-seg ${options.className ?? ""}`.trim());
  track.setAttribute("role", "radiogroup");
  track.setAttribute("aria-label", options.label);
  for (const choice of options.choices) {
    const on = choice.value === options.value;
    const segment = element("button", `k-seg-item${on ? " is-on" : ""}`) as HTMLButtonElement;
    segment.type = "button";
    segment.setAttribute("role", "radio");
    segment.setAttribute("aria-checked", String(on));
    segment.disabled = !!options.disabled;
    if (choice.icon) {
      const mark = element("span", "k-seg-mark");
      paintIcon(mark, choice.icon);
      segment.append(mark);
    }
    segment.append(element("span", "", choice.label));
    segment.onclick = event => { event.stopPropagation(); if (!on) options.change(choice.value); };
    track.append(segment);
  }
  return track;
}

/** A project's chip: its face, its name, and × to let it go. */
export function projectChip(face: Face | null, name: string, clear: (() => void) | null, open?: () => void): HTMLElement {
  const chip = element("span", "k-pchip");
  const main = element("button", "k-pchip-main") as HTMLButtonElement;
  main.type = "button";
  main.append(logoTile(face, "sm"), element("span", "k-pchip-name", name));
  if (open) {
    main.onclick = event => { event.stopPropagation(); open(); };
    main.dataset.tip = name;
  } else main.tabIndex = -1;
  chip.append(main);
  if (clear) {
    const x = element("button", "k-pchip-x") as HTMLButtonElement;
    x.type = "button";
    paintIcon(x, "close");
    x.setAttribute("aria-label", `Stop focusing on ${name}`);
    x.dataset.tip = "Stop focusing";
    x.onclick = event => { event.stopPropagation(); clear(); };
    chip.append(x);
  }
  return chip;
}

/** A neutral chip with a glyph and a word or a number. */
export function kchip(label: string, icon?: TaskIcon, tone = ""): HTMLElement {
  const chip = element("span", `k-chip${tone ? ` is-${tone}` : ""}`);
  if (icon) {
    const mark = element("span", "k-chip-mark");
    paintIcon(mark, icon);
    chip.append(mark);
  }
  chip.append(element("span", "", label));
  return chip;
}
