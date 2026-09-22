/* Countdowns and stopwatches: one face, a list of runs beside it.
 *
 * ⚠️ **One face for three kinds, not three faces.** A pomodoro, a timer and a
 * stopwatch are the same object — a circle, a figure, a start button — and the
 * differences between them are what the circle is made of and what sits under
 * it. The screen used to be two layouts switched by a mode, which meant every
 * change had to be made twice and the two drifted.
 *
 * ⚠️ **The ring says which kind it is.** A pomodoro is SEGMENTED, one arc per
 * leg of the cycle, because the thing you want to know is where you are in a
 * shape; a timer and a stopwatch are one unbroken circle, because they have no
 * shape to be part-way through. That is the whole visual difference and it is
 * doing real work.
 *
 * ⚠️ **The list EXTENDS, it does not overlay.** Same bargain `.media-lyrics`
 * makes: no transition on its width, because the island is sized from its
 * content and measures once per render — a panel easing itself open is
 * measured at the start of the ease and the island settles at the wrong size.
 * The panel snaps and the island's own spring is the animation.
 */
import { element } from "./dom";
import { paintIcon, taskIcon } from "./task-icons";
import { timerText } from "./focus-timer";
import { setDigits } from "./tween";
import { tick as click } from "./click";
import { clamp, free, offsetFor, ticks, wound } from "./dial";
import { ROUNDS, phaseName, type Lengths } from "./timer";
import { buildRing, paintRing } from "./run-ring";
import {
  counted, figureMs, running, runName,
  type Run, type RunKind, type Runs,
} from "./runs";

export interface TimerDeps {
  lengths: () => Lengths;
  setLengths: (lengths: Lengths) => void;
  /** Hold the panel open while a name is being typed. */
  focus: (active: boolean) => void;
  /** Redraw — this screen owns state the runs do not. */
  changed: () => void;
  /** Open the settings window, where the pomodoro's lengths live. */
  settings: () => void;
  /** The list has opened or shut and the panel has to be re-capped. ⚠️ The
   *  screen cannot do this itself: how wide a screen wants to be is a fact
   *  `tasks.ts` owns, in one table, for all of them. */
  width: () => void;
}

/** The three kinds, in the order the switcher offers them. ⚠️ ONE list: the
 *  switcher, the add menu and the list panel all read it, and three copies of
 *  "what a kind is called" is three places to rename it in. */
const KINDS: { id: RunKind; label: string; icon: "clock" | "timer" | "target" }[] = [
  { id: "stopwatch", label: "Stopwatch", icon: "clock" },
  { id: "timer", label: "Timer", icon: "timer" },
  { id: "pomodoro", label: "Pomodoro", icon: "target" },
];

export class TimerScreen {
  readonly name = "timer" as const;

  /** Whether the list panel is out. ⚠️ Held here, not in the runs: it is a
   *  fact about this screen rather than about the runs, and the widgets that
   *  read the same list have no panel to open.
   *
   * ⚠️ READ FROM OUTSIDE, by `widthOf` in tasks.ts, which is what makes the
   * list extend the island rather than be folded into it. Same arrangement as
   * the player's `open`. */
  private open = false;
  get listOpen(): boolean { return this.open; }

  /** A hand is on the dial, or the ruler is still easing onto a mark.
   *
   * ⚠️ Nothing may REBUILD this screen while either is true. The rebuild
   * replaces the element the pointer is captured on, which drops the drag
   * halfway through with the button still down. */
  private holding = false;
  private easing = 0;

  /** What the screen last drew, so a tick can update the figure in place
   *  rather than rebuilding a screen somebody may be dragging on. */
  private drawn = "";
  /** Which kind was on screen last, so switching to another can be ANIMATED
   *  and everything else cannot.
   *
   * ⚠️ Not simply "did we rebuild": the screen rebuilds when the list opens,
   * when a phase turns over and when a run is renamed, and a face that flew in
   * on every one of those would be a screen that twitches while you use it. */
  private shown = "";
  private face: { figure: HTMLElement; arc: SVGCircleElement | null; segs: SVGCircleElement[] } | null = null;
  /** The time cell of each row in the list, by run id, so a tick can write to
   *  them without rebuilding a panel somebody may be pressing. */
  private rows = new Map<string, HTMLElement>();

  constructor(
    private host: HTMLElement,
    private runs: Runs,
    private deps: TimerDeps,
  ) {}

  /** The run on screen. */
  private get run(): Run | null { return this.runs.current; }

  /** Called every second by the shell. */
  tick() {
    const run = this.run;
    if (!run || !this.face) return;
    // ⚠️ In PLACE. A rebuild every second would drop a drag and restart the
    // ring's own transition, which is what makes it sweep rather than jump.
    setDigits(this.face.figure, faceText(run, this.deps.lengths()));
    this.paintRing(run);
    /* ⚠️ The LIST ticks too. It is built once when the panel opens, so without
     * this every row but the one on the face froze at the moment it was drawn
     * — a stopwatch you had just started sat at 00:00 while the big figure
     * counted, which reads as a list of dead entries rather than of running
     * ones. Written in place for the same reason the figure is. */
    for (const [id, cell] of this.rows) {
      const one = this.runs.list.find(held => held.id === id);
      if (one) cell.textContent = faceText(one, this.deps.lengths());
    }
  }

  render() {
    // See `holding`: a rebuild mid-gesture drops the drag it is rebuilding for.
    if (this.holding || this.easing) return;
    const run = this.run;
    /* What the SHAPE of the screen depends on. ⚠️ Not the figure: that changes
     * every second and rebuilding for it would restart every animation on the
     * screen once a second. */
    const shape = [
      run?.id ?? "", run?.kind ?? "", running(run ?? ({} as Run)) ? "go" : "stop",
      run?.count ? run.count.phase : "-", String(run?.minutes ?? 0),
      this.open ? "list" : "",
      /* ⚠️ EVERY run, not a count and not just the one on the face. The list
       * is part of this screen, and pressing Start on a row that is not the
       * current one changes nothing else here — so keyed on the current run
       * alone, `render` took the tick path and the row kept its play icon for
       * ever. The time ticked, which was the only cue the press had landed.
       *
       * ⚠️ The id, so a removal and an addition are not the same length; the
       * title, so a rename repaints the row (written on blur, never per
       * keystroke, so the field cannot lose its caret to this). */
      this.runs.list.map(one =>
        `${one.id}${running(one) ? "!" : ""}:${one.title}`).join(","),
    ].join("|");
    if (shape === this.drawn && this.face) { this.tick(); return; }
    this.drawn = shape;

    this.host.replaceChildren();
    const board = element("div", "tm-board");
    /* ⚠️ Only when the KIND changed. `data-enter` is what the keyframe hangs
     * off, and it is set before the children exist so the animation starts on
     * the frame the face first paints rather than one after it. */
    const kind = run?.kind ?? "";
    if (kind && kind !== this.shown) board.dataset.enter = "";
    this.shown = kind;

    if (!run) {
      board.append(this.emptyFace());
    } else {
      board.append(this.head(run), this.body(run), this.foot(run));
    }
    this.host.append(board);
    if (this.open) this.host.append(this.panel());
  }

  /* ── The top row: which kind, and one more ─────────────────────────── */

  private head(run: Run): HTMLElement {
    const row = element("div", "tm-head");

    /* ⚠️ The active kind EXPANDS to carry its name and the other two stay
     * glyphs. Three labelled tabs is a row of words where two of them are
     * about things you are not looking at; three bare glyphs is a control you
     * have to learn. One of each is the segmented control every phone has. */
    const kinds = element("div", "tm-kinds");
    kinds.setAttribute("role", "tablist");
    for (const kind of KINDS) {
      const on = run.kind === kind.id;
      const tab = element("button", `tm-kind${on ? " is-on" : ""}`);
      (tab as HTMLButtonElement).type = "button";
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", String(on));
      tab.setAttribute("aria-label", kind.label);
      tab.dataset.tip = kind.label;
      const mark = element("span", "tm-kind-mark");
      mark.append(taskIcon(kind.icon));
      tab.append(mark);
      if (on) tab.append(element("span", "tm-kind-name", kind.label));
      /* ⚠️ Switching kind moves to an EXISTING run of that kind where there is
       * one, and makes a new one where there is not. Pressing "Timer" and
       * being given a fresh one every time is how a list of five timers you
       * never asked for happens. */
      tab.onclick = () => {
        const held = this.runs.of(kind.id)[0];
        if (held) this.runs.pick(held.id);
        else this.runs.add(kind.id);
        this.deps.changed();
      };
      kinds.append(tab);
    }

    const add = element("button", "tm-add");
    (add as HTMLButtonElement).type = "button";
    add.setAttribute("aria-label", `Add another ${run.kind}`);
    add.dataset.tip = "Add another";
    paintIcon(add, "plus");
    add.onclick = () => { this.runs.add(run.kind); this.deps.changed(); };

    row.append(kinds, add);
    return row;
  }

  /* ── The middle: the ring, and what belongs under it ───────────────── */

  private body(run: Run): HTMLElement {
    const body = element("div", "tm-body");
    body.append(this.ring(run));

    /* The name. ⚠️ A field rather than a label, on every kind: "what are you
     * working on" is the question a pomodoro asks, and a timer wants to say
     * "oven" for exactly the same reason — you will have three of them. */
    const name = document.createElement("input");
    name.type = "text";
    name.className = "tm-name";
    /* ⚠️ An input carries an INTRINSIC width from its `size` attribute — 20
     * characters by default — and that width wins over `align-self: stretch`:
     * the field came out 216px inside a 314px column. The wrapper below is what
     * actually sizes it; this stops the intrinsic width setting a floor under
     * the column when the name is long. */
    name.size = 1;
    name.value = run.title;
    name.placeholder = run.kind === "pomodoro"
      ? "What are you working on?" : "What is this for?";
    name.setAttribute("aria-label", "Name this run");
    name.onfocus = () => { void this.deps.focus(true); };
    name.onblur = () => {
      void this.deps.focus(false);
      this.runs.rename(run.id, name.value);
    };
    name.onkeydown = event => {
      if (event.key === "Enter") name.blur();
      if (event.key === "Escape") { name.value = run.title; name.blur(); }
    };
    /* ⚠️ WRAPPED, because a form control is not stretched by its flex parent.
     * Chrome sizes an input from its own intrinsic width whatever the column
     * asks — `align-self: stretch` is ignored and a percentage falls back to
     * that same intrinsic width, so the field was 216px in a 314px column and
     * then 64px once the intrinsic width was taken away. A plain div DOES
     * stretch, and a percentage against its definite width resolves. */
    const box = element("div", "tm-name-box");
    box.append(name);
    body.append(box);

    /* The ruler, on a timer that has not been started. ⚠️ Only then: setting a
     * length and changing one mid-count are different things, and there is no
     * control for the second because nobody means it. */
    if (run.kind === "timer" && !run.count) body.append(this.dial(run));
    return body;
  }

  /** The circle. ⚠️ Built by `run-ring.ts`, which the board's three run
   *  widgets draw from too — the ring is the one thing that says which kind you
   *  are looking at, and a second copy of it drifted the moment it existed. */
  private ring(run: Run): HTMLElement {
    const wrap = element("div", `tm-ring is-${run.kind}`);
    const built = buildRing(run, this.deps.lengths());

    const face = element("div", "tm-face");
    if (run.kind === "pomodoro") {
      const mark = element("span", "tm-face-mark");
      mark.append(taskIcon(run.count?.phase === "work" || !run.count ? "target" : "coffee"));
      face.append(mark);
    }
    const figure = element("div", "tm-figure");
    setDigits(figure, faceText(run, this.deps.lengths()));
    face.append(figure);
    if (run.kind === "pomodoro") {
      face.append(element("span", "tm-phase",
        run.count ? `${phaseName(run.count)} · ${(run.count.round % ROUNDS) + 1} of ${ROUNDS}` : "Ready"));
    }

    wrap.append(built.el, face);
    this.face = { figure, arc: built.arc, segs: built.segs };
    this.paintRing(run);
    return wrap;
  }

  /** Move the ring to where the run actually is. Called every tick. */
  private paintRing(run: Run) {
    const held = this.face;
    if (!held) return;
    paintRing(held, run, this.deps.lengths(), running(run));
  }

  /** The ruler you wind a timer with. */
  private dial(run: Run): HTMLElement {
    const wrap = element("div", "tm-dial");
    const strip = element("div", "tm-strip");
    const rule = element("div", "tm-rule");
    for (const mark of ticks()) {
      const one = element("i", mark.major ? "is-major" : "");
      one.style.left = `${mark.at}px`;
      if (mark.major) {
        const say = element("b");
        say.textContent = String(mark.minute);
        one.append(say);
      }
      rule.append(one);
    }
    strip.append(rule);

    let minutes = run.minutes;
    /* ⚠️ `offsetFor` is ALREADY the shift — it returns `-minutes * PER`,
     * because winding the ruler up slides it left. Negating it here was
     * negating it twice, so the ruler sat as far to the RIGHT of the marker as
     * it should have sat to the left (a timer set to 8 put zero 120px past the
     * mark, with the rest of the ruler off the fade) and every drag moved it
     * away from the hand. The sign belongs in one place and `dial.ts` is it. */
    const show = () => { rule.style.translate = `${offsetFor(minutes)}px`; };

    let from: { x: number; at: number } | null = null;
    strip.addEventListener("pointerdown", event => {
      event.stopPropagation();
      from = { x: event.clientX, at: minutes };
      strip.setPointerCapture(event.pointerId);
      strip.classList.add("is-dragging");
      this.holding = true;
    });
    strip.addEventListener("pointermove", event => {
      if (!from) return;
      minutes = free(from.at, event.clientX - from.x);
      show();
      /* ⚠️ The FIGURE follows the ruler, live. A dial that moves a ruler and
       * leaves the number to catch up on release is a control you have to let
       * go of to read. */
      const whole = clamp(minutes);
      if (this.face) setDigits(this.face.figure, timerText(whole * 60));
      if (whole !== this.lastClick) { click(whole % 5 === 0 ? 1.34 : 1); this.lastClick = whole; }
    });
    for (const done of ["pointerup", "pointercancel"] as const) {
      strip.addEventListener(done, event => {
        if (!from) return;
        minutes = clamp(wound(from.at, event.clientX - from.x));
        from = null;
        strip.classList.remove("is-dragging");
        strip.classList.add("is-settling");
        show();
        this.holding = false;
        /* ⚠️ The screen stays frozen through the SETTLE as well. Mid-ease a
         * rebuild eats only the animation, which is quieter than dropping a
         * drag and just as wrong. */
        this.easing = window.setTimeout(() => {
          this.easing = 0;
          strip.classList.remove("is-settling");
          this.deps.changed();
        }, SETTLE);
        /* ⚠️ The value is committed NOW, not when the ease finishes. The ease
         * is 260ms of cosmetics; letting it own the write meant the number on
         * screen was not yet the number a press of Start would use, so winding
         * to 35 and starting straight away started 25. The render it would
         * trigger is held off by `easing`, which is already set above — so the
         * ruler still glides onto its mark. */
        this.runs.setMinutes(run.id, minutes);
      });
    }
    show();
    wrap.append(strip);
    return wrap;
  }

  private lastClick = -1;

  /* ── The bottom row ────────────────────────────────────────────────── */

  private foot(run: Run): HTMLElement {
    const row = element("div", "tm-foot");

    const gear = element("button", "tm-round");
    (gear as HTMLButtonElement).type = "button";
    gear.setAttribute("aria-label", "Timer settings");
    gear.dataset.tip = "Settings";
    paintIcon(gear, "settings");
    gear.onclick = () => this.deps.settings();

    /* ⚠️ ONE button, and its word changes. Start, pause and resume are the
     * same press at three moments — three buttons would mean two of them are
     * always wrong. */
    const go = element("button", "tm-go");
    (go as HTMLButtonElement).type = "button";
    const live = running(run);
    go.textContent = live ? "Pause" : run.count || counted(run) > 0 ? "Resume" : "Start";
    go.setAttribute("aria-label", go.textContent);
    go.onclick = () => { this.runs.toggle(run.id); click(1); this.deps.changed(); };

    const list = element("button", `tm-round${this.open ? " is-on" : ""}`);
    (list as HTMLButtonElement).type = "button";
    list.setAttribute("aria-label", this.open ? "Hide the list" : "Show the list");
    list.setAttribute("aria-expanded", String(this.open));
    list.dataset.tip = "All runs";
    paintIcon(list, "list");
    /* ⚠️ The WIDTH first, then the render. The panel measures its content at
     * the end of the render, so a render at the old cap measures the two
     * columns squeezed into one column's room — and `width()` also asks the
     * island to spring rather than snap, which this is: you pressed a button
     * for it. */
    list.onclick = () => {
      this.open = !this.open;
      this.deps.width();
      this.deps.changed();
    };

    row.append(gear, go, list);
    return row;
  }

  /* ── The list, out at the side ─────────────────────────────────────── */

  private panel(): HTMLElement {
    // ⚠️ Cleared on every rebuild: a row that has gone would otherwise be
    // written to for ever, holding a reference to an element nothing shows.
    this.rows.clear();
    const panel = element("div", "tm-list");
    const rows = element("div", "tm-rows");
    for (const run of this.runs.list) {
      const on = run.id === this.runs.active;
      const row = element("div", `tm-row${on ? " is-on" : ""}`);
      row.dataset.run = run.id;

      /* ⚠️ The whole row PICKS, and only the button controls. A row that both
       * selects and toggles depending on where you press is a row you have to
       * aim at. */
      const pick = element("button", "tm-pick");
      (pick as HTMLButtonElement).type = "button";
      pick.setAttribute("aria-label", `Show ${runName(run)}`);
      pick.setAttribute("aria-current", String(on));
      const when = element("span", "tm-row-time", faceText(run, this.deps.lengths()));
      this.rows.set(run.id, when);
      pick.append(when);
      pick.append(element("span", "tm-row-name", runName(run)));
      pick.onclick = () => { this.runs.pick(run.id); this.deps.changed(); };

      const live = running(run);
      const go = element("button", `tm-row-go${live ? " is-live" : ""}`);
      (go as HTMLButtonElement).type = "button";
      go.setAttribute("aria-label", `${live ? "Pause" : "Start"} ${runName(run)}`);
      paintIcon(go, live ? "pause" : "play");
      go.onclick = event => {
        event.stopPropagation();
        this.runs.toggle(run.id);
        this.deps.changed();
      };

      const off = element("button", "tm-row-off");
      (off as HTMLButtonElement).type = "button";
      off.setAttribute("aria-label", `Remove ${runName(run)}`);
      off.dataset.tip = "Remove";
      paintIcon(off, "close");
      off.onclick = event => {
        event.stopPropagation();
        this.runs.remove(run.id);
        this.deps.changed();
      };

      /* ⚠️ The GO button last, so it is pinned to the right edge of every row
       * whether or not the remove is showing. With the remove between them the
       * row has one fixed target and one that fades in beside it; with it
       * after, the target every row shares moves 26px the moment you point at
       * one of them. */
      row.append(pick, off, go);
      rows.append(row);
    }
    if (!this.runs.list.length) {
      rows.append(element("p", "tm-none", "Nothing here yet."));
    }

    const clear = element("button", "tm-clear");
    (clear as HTMLButtonElement).type = "button";
    clear.textContent = "Clear all";
    clear.onclick = () => { this.runs.clear(); this.deps.changed(); };

    panel.append(rows, clear);
    return panel;
  }

  /** Nothing at all: the list has been cleared. */
  private emptyFace(): HTMLElement {
    const wrap = element("div", "tm-empty");
    wrap.append(element("p", "tm-empty-say", "Nothing counting."));
    const row = element("div", "tm-empty-row");
    for (const kind of KINDS) {
      const add = element("button", "tm-empty-add");
      (add as HTMLButtonElement).type = "button";
      const mark = element("span", "tm-kind-mark");
      mark.append(taskIcon(kind.icon));
      add.append(mark, element("span", "", kind.label));
      add.onclick = () => { this.runs.add(kind.id); this.deps.changed(); };
      row.append(add);
    }
    wrap.append(row);
    return wrap;
  }
}

/** How long the ruler takes to ease onto a mark once the hand lets go.
 *  Must match `.tm-strip.is-settling` in the stylesheet. */
const SETTLE = 260;

/** The figure on a run's face.
 *
 * ⚠️ A stopwatch counts in HOURS once it passes one, and a countdown never
 * does — `timerText` rolls over to `1h 05` past a hundred minutes, which is
 * right for a countdown you set and wrong for a stopwatch you left running. */
function faceText(run: Run, lengths: Lengths): string {
  const ms = figureMs(run, lengths);
  if (run.kind !== "stopwatch") return timerText(Math.round(ms / 1000));
  const whole = Math.floor(ms / 1000);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}
