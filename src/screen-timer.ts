/* The countdown: a timer you wind, or a pomodoro you work through.
 *
 * ⚠️ **One screen, two faces, and they are genuinely different things.** A
 * timer is a number you choose; a pomodoro is a shape you move along. One face
 * meant the pomodoro had a duration control it should not have and the timer
 * had a session track that meant nothing.
 *
 * ⚠️ **Nothing here is centred.** The first version stacked everything down
 * the middle of a 700px panel, which left two wide margins of nothing and made
 * every element look small. The controls sit on one side and the number on the
 * other — the number is the biggest thing on the screen and it gets a side of
 * its own.
 *
 * ⚠️ **Icons, not labels, and not all one size.** Pause is the button you
 * press twenty times and it is 54px of accent; skip and stop are 40px of grey
 * beside it; the lengths are a 32px ghost in the corner. A row of four
 * identical labelled buttons says all four matter equally, which is never true.
 */
import { element } from "./dom";
import { paintIcon } from "./task-icons";
import { timerText } from "./focus-timer";
import { setDigits, setText } from "./tween";
import { tick as click } from "./click";
import { MOST, clamp, free, offsetFor, ticks } from "./dial";
import { ROUNDS, cycle, phaseName, type Lengths, type Timer } from "./timer";

/** How long the ruler takes to ease onto a mark once the hand lets go.
 *  Must match `.tm-strip.is-settling` in the stylesheet. */
const SETTLE = 260;

export interface TimerDeps {
  lengths: () => Lengths;
  mode: () => "timer" | "pomodoro";
  setMode: (mode: "timer" | "pomodoro") => void;
  setLengths: (lengths: Lengths) => void;
  /** Hold the panel open while the name is being typed. */
  focus: (active: boolean) => void;
  /** Redraw — this screen owns state the timer does not. */
  changed: () => void;
}

export class TimerScreen {
  private host: HTMLElement;
  private timer: Timer;
  private deps: TimerDeps;

  /** What the dial is wound to while nothing is running. */
  private set = 15;
  private tuning = false;

  /** Every tick on the ruler, by its minute, and which one is lit. */
  private marks: HTMLElement[] = [];
  private lit = -1;

  /** A hand is on the dial, or the ruler is still easing onto a mark.
   *
   * ⚠️ Nothing may REBUILD this screen while either is true. The rebuild
   * replaces the element the pointer is captured on, which drops the drag
   * halfway through with the button still down; mid-settle it is only the
   * animation that is eaten, which is quieter and just as wrong.
   */
  private holding = false;
  private easing = 0;

  /** The mode the pill was last drawn under, so it has somewhere to come
   *  FROM — changing mode rebuilds this screen, pill and all. */
  private was: "timer" | "pomodoro" | null = null;
  private pill: { pill: HTMLElement; tabs: HTMLElement[] } | null = null;
  private watch?: ResizeObserver;

  constructor(host: HTMLElement, timer: Timer, deps: TimerDeps) {
    this.host = host;
    this.timer = timer;
    this.deps = deps;
  }

  private drawn = "";

  /** Is the thing that is running this face's own?
   *
   * ⚠️ A plain timer and a pomodoro are ONE engine, so both faces can see
   * whatever is counting — and each has to refuse the other's, or the timer
   * face draws a running pomodoro's clock above a dial set to something else.
   */
  private ours(state: Timer["state"], mode: "timer" | "pomodoro"): Timer["state"] {
    if (!state) return null;
    return (mode === "timer") === (state.phase === "plain") ? state : null;
  }

  render() {
    // See `holding`: a rebuild mid-gesture drops the drag it is rebuilding for.
    if (this.holding) return;
    const mode = this.deps.mode();
    const state = this.ours(this.timer.state, mode);
    const lengths = this.deps.lengths();
    const key = [
      mode, state?.phase ?? "", state?.endsAt === null, state?.round ?? 0,
      state?.name ?? "", this.tuning, this.set,
      lengths.work, lengths.rest, lengths.long,
    ].join("|");
    if (key === this.drawn) return;
    this.drawn = key;
    this.host.replaceChildren();

    const top = element("div", "tm-top");
    top.append(this.modes(mode));
    if (mode === "pomodoro") {
      const tune = this.button("settings", "Focus and break lengths", () => {
        this.tuning = !this.tuning;
        this.drawn = "";
        this.deps.changed();
      }, "ghost");
      tune.classList.toggle("is-on", this.tuning);
      top.append(tune);
    }
    this.host.append(top);
    // Measured, so it has to happen after the row is in the document.
    this.slide(mode);

    if (mode === "timer") this.timerFace(state);
    else this.pomodoroFace(state, lengths);
  }

  private modes(mode: "timer" | "pomodoro"): HTMLElement {
    const row = element("div", "tm-modes");
    row.dataset.at = mode === "timer" ? "0" : "1";
    const pill = element("i", "tm-modes-pill");
    row.append(pill);
    const tabs: HTMLElement[] = [];
    for (const one of ["timer", "pomodoro"] as const) {
      const button = element("button", `tm-mode${one === mode ? " is-on" : ""}`,
        one === "timer" ? "Timer" : "Pomodoro");
      (button as HTMLButtonElement).type = "button";
      button.setAttribute("aria-pressed", String(one === mode));
      button.onclick = () => this.deps.setMode(one);
      row.append(button);
      tabs.push(button);
    }
    this.pill = { pill, tabs };
    return row;
  }

  /** transitions.dev's sliding tabs: the pill TRAVELS between the two rather
   *  than one lighting up as the other goes out.
   *
   * ⚠️ MEASURED off the tabs, never `calc(50%)`. "Timer" and "Pomodoro" are
   * not the same length, so half the control was a pill that overhung one
   * word and left the other sticking out from under it — which is exactly
   * what it looked like.
   *
   * ⚠️ And put at the PREVIOUS tab first, with the transition off, then
   * moved on the next frame. Changing mode rebuilds this whole screen, so the
   * pill is a new element with nothing to animate from: without this it
   * simply appears under the other word. The forced reflow between the two
   * writes is what makes the second one a transition rather than a no-op.
   */
  private slide(mode: "timer" | "pomodoro") {
    const kit = this.pill;
    const was = this.was;
    this.was = mode;
    if (!kit) return;
    const put = (tab: HTMLElement) => {
      // Not laid out — a hidden screen, or a test that never showed it. The
      // stylesheet's own fallback stands rather than a pill of zero width.
      if (!tab.offsetWidth) return;
      kit.pill.style.width = `${tab.offsetWidth}px`;
      kit.pill.style.left = "0px";
      kit.pill.style.translate = `${tab.offsetLeft}px 0`;
    };
    const travels = was !== null && was !== mode;
    const to = kit.tabs[mode === "timer" ? 0 : 1];
    kit.pill.style.transition = "none";
    put(travels ? kit.tabs[was === "timer" ? 0 : 1] : to);
    void kit.pill.offsetWidth;
    kit.pill.style.transition = "";
    if (travels) put(to);

    /* ⚠️ And AGAIN whenever the tabs gain a size. This screen is rendered
     * while it is still hidden — `offsetWidth` is 0 there, so nothing above
     * measured anything, and the pill kept the stylesheet's half-width
     * fallback for as long as the panel stayed open. An observer rather than
     * a retry loop: a screen you never open never gets a size, and a rAF that
     * waits for one would run for the life of the window. */
    this.watch?.disconnect();
    this.watch = new ResizeObserver(() => {
      if (!kit.pill.isConnected) { this.watch?.disconnect(); return; }
      kit.pill.style.transition = "none";
      put(kit.tabs[this.was === "timer" ? 0 : 1]);
      void kit.pill.offsetWidth;
      kit.pill.style.transition = "";
    });
    for (const tab of kit.tabs) this.watch.observe(tab);
  }

  /* ── A timer you wind ────────────────────────────────────────────────── */

  private timerFace(state: Timer["state"]) {
    const running = !!state;
    const minutes = running ? Math.max(0, this.timer.seconds() / 60) : this.set;
    this.host.append(this.dial(minutes, !running));

    /* The row the whole face is built around: what to press on the left, what
     * it says on the right. */
    const row = element("div", "tm-row");
    const acts = element("div", "tm-acts");
    if (!running) {
      acts.append(this.button("play", "Start", () => this.timer.start(this.set), "lead"));
    } else {
      acts.append(this.button(
        state!.endsAt === null ? "play" : "pause",
        state!.endsAt === null ? "Resume" : "Pause",
        () => this.timer.toggle(), "lead",
      ));
      acts.append(this.button("close", "Stop", () => this.timer.stop()));
    }
    row.append(acts, this.clock(running ? timerText(this.timer.seconds()) : `${this.set}:00`));
    this.host.append(row);
  }

  /** The big number. ⚠️ A `t-digit-group`, so `setDigits` re-enters only the
   *  digits that CHANGED with a blurred rise — swapping the whole number makes
   *  the minutes flinch once a second for no reason. */
  private clock(text: string): HTMLElement {
    const clock = element("div", "tm-clock t-digit-group");
    setDigits(clock, text);
    return clock;
  }

  private dial(minutes: number, live: boolean): HTMLElement {
    const host = element("div", `tm-dial${live ? "" : " is-locked"}`);
    const strip = element("div", "tm-strip");
    this.marks = [];
    this.lit = -1;
    for (const mark of ticks()) {
      const line = element("i", mark.major ? "is-major" : "");
      line.style.left = `${mark.at}px`;
      strip.append(line);
      // By minute, so lighting the one under the mark is a lookup, not a scan.
      this.marks[mark.minute] = line;
      if (mark.major) {
        const label = element("span", "tm-tick-say", String(mark.minute));
        label.style.left = `${mark.at}px`;
        strip.append(label);
      }
    }
    /* ⚠️ The arrow sits BELOW the ruler, pointing up at the tick it names.
     * Drawn THROUGH the ticks it was one more tall line among a hundred tall
     * lines, and the eye had to work out which of them it was on; from
     * underneath there is nothing for it to be confused with. */
    host.append(strip, element("span", "tm-marker"));
    this.place(strip, minutes);
    if (live) this.windable(host, strip);
    return host;
  }

  /** Put the strip where `minutes` sits under the marker, and light the tick
   *  that is under it.
   *
   * ⚠️ ONE property on ONE element, plus a class on one more. This used to
   * write an opacity and a blur onto all 242 children on every frame of a
   * drag — which is what the drag felt like — and because the fade was
   * measured in pixels from the marker it kept the whole ruler inside a 210px
   * window in the middle of a 700px panel. The fade is a `mask-image` on the
   * dial now: the same picture, no work per frame, and full width.
   */
  private place(strip: HTMLElement, minutes: number) {
    strip.style.translate = `${offsetFor(minutes)}px`;
    /* ⚠️ Rounded here, NOT `clamp`: a running timer passes through zero, and
     * clamp's floor is one minute — so at the moment the ruler reads 0 the
     * lit tick would be the 1 beside it, an arrow pointing at the wrong mark
     * for the one second anybody is watching. */
    const at = Math.max(0, Math.min(MOST, Math.round(minutes))) || 0;
    if (at === this.lit) return;
    this.marks[this.lit]?.classList.remove("is-at");
    this.marks[at]?.classList.add("is-at");
    this.lit = at;
  }

  private windable(host: HTMLElement, strip: HTMLElement) {
    let from: number | null = null;
    let started = this.set;
    /** The exact minute under the mark, fractional — because a hand is. */
    let at = this.set;

    const showing = (minutes: number) => {
      const clock = this.host.querySelector<HTMLElement>(".tm-clock");
      /* ⚠️ Plain text while a finger is on it, never `setDigits`: the pop-in
       * is for a number that changes once a second, and replaying it on every
       * frame of a drag is a column of digits fighting the hand moving them. */
      if (clock) clock.textContent = `${minutes}:00`;
    };

    /** Ease the strip onto its mark, and hold off the redraw until it lands.
     *  See `holding` — a rebuild here eats the one animation that makes the
     *  release feel like the dial caught rather than like it twitched. */
    const settle = () => {
      this.holding = true;
      strip.classList.add("is-settling");
      window.clearTimeout(this.easing);
      this.easing = window.setTimeout(() => {
        strip.classList.remove("is-settling");
        this.holding = false;
      }, SETTLE);
    };

    host.addEventListener("pointerdown", event => {
      if (event.button !== 0) return;
      from = event.clientX;
      started = this.set;
      at = this.set;
      this.holding = true;
      window.clearTimeout(this.easing);
      // Under the hand it must be exactly under the hand, never easing toward it.
      strip.classList.remove("is-settling");
      host.setPointerCapture(event.pointerId);
      host.classList.add("is-winding");
    });
    host.addEventListener("pointermove", event => {
      if (from === null) return;
      /* ⚠️ The strip follows the hand CONTINUOUSLY and rounds only for the
       * number it reads out. Stepping a whole minute at a time meant the ruler
       * stood still for seven pixels of hand and then jumped fifteen, which is
       * a ratchet rather than a dial — and the ends stopped dead, which reads
       * as the control having broken. `free` gives at both. */
      at = free(started, event.clientX - from);
      const next = clamp(at);
      if (next !== this.set) {
        /* A tick as each mark passes, brighter on the fives. ⚠️ The sound IS
         * the detent — there is no haptic engine on a PC to borrow one from —
         * but `click` keeps a floor between two of them, because a quick drag
         * crosses a mark every three milliseconds and that is a buzz. */
        click(next % 5 === 0 ? 1.34 : 1);
        this.set = next;
        showing(next);
      }
      this.place(strip, at);
    });
    const release = (event: PointerEvent) => {
      if (from === null) return;
      from = null;
      host.classList.remove("is-winding");
      if (host.hasPointerCapture(event.pointerId)) host.releasePointerCapture(event.pointerId);
      // Wherever the hand left it, up to half a minute off a mark. Ease it home.
      this.set = clamp(at);
      at = this.set;
      settle();
      this.place(strip, this.set);
      showing(this.set);
    };
    host.addEventListener("pointerup", release);
    host.addEventListener("pointercancel", release);

    /* A wheel winds it too. ⚠️ `passive: false` and stopped, or the panel's
     * own wheel-to-change-screen takes the gesture and you leave the timer. */
    host.addEventListener("wheel", event => {
      event.preventDefault();
      event.stopPropagation();
      const next = clamp(this.set + (event.deltaY > 0 ? -1 : 1));
      if (next === this.set) return;
      click(next % 5 === 0 ? 1.34 : 1);
      this.set = next;
      at = next;
      // A wheel arrives in steps, so every step is a small settle of its own.
      settle();
      this.place(strip, this.set);
      showing(this.set);
    }, { passive: false });
  }

  /* ── A pomodoro you work through ─────────────────────────────────────── */

  private pomodoroFace(state: Timer["state"], lengths: Lengths) {
    /* ⚠️ A field with no box around it. It is optional and usually empty, and
     * an empty bordered input is a hole in the middle of the screen; as a big
     * quiet line it reads as a heading you are invited to write. */
    const name = element("input", "tm-name") as HTMLInputElement;
    name.type = "text";
    name.placeholder = "What are you working on?";
    name.value = state?.name ?? "";
    name.maxLength = 60;
    name.onfocus = () => this.deps.focus(true);
    name.onblur = () => {
      this.deps.focus(false);
      if (state) this.timer.rename(name.value);
    };
    name.onkeydown = event => {
      if (event.key === "Enter") name.blur();
      if (event.key === "Escape") { name.value = state?.name ?? ""; name.blur(); }
      event.stopPropagation();
    };
    name.oninput = () => {
      if (this.timer.state) this.timer.state.name = name.value.trim() || undefined;
    };
    this.host.append(name);
    this.host.append(this.track(state, lengths));

    const row = element("div", "tm-row");
    const acts = element("div", "tm-acts");
    if (!state) {
      acts.append(this.button("play", "Start", () => this.timer.start(undefined, name.value), "lead"));
    } else {
      acts.append(this.button(
        state.endsAt === null ? "play" : "pause",
        state.endsAt === null ? "Resume" : "Pause",
        () => this.timer.toggle(), "lead",
      ));
      acts.append(this.button("next", "Skip to the next session", () => this.timer.skip()));
      acts.append(this.button("close", "Stop", () => this.timer.stop()));
    }

    const right = element("div", "tm-right");
    right.append(this.clock(state ? timerText(this.timer.seconds()) : `${lengths.work}:00`));
    const said = element("div", "tm-say t-text-swap");
    setText(said, this.phaseLine(state, lengths));
    right.append(said);
    row.append(acts, right);
    this.host.append(row);

    if (this.tuning) this.host.append(this.drawer(lengths));
  }

  private phaseLine(state: Timer["state"], lengths: Lengths): string {
    if (!state) return `${lengths.work} min focus · ${lengths.rest} min break`;
    if (state.endsAt === null) return `${phaseName(state)} · paused`;
    if (state.phase !== "work") return phaseName(state);
    return `${phaseName(state)} · ${(state.round % ROUNDS) + 1} of ${ROUNDS}`;
  }

  /** The cycle, as dots that elongate.
   *
   * ⚠️ This was a row of bars and it looked like a download. Dots are the
   * idiom for "which of a short sequence am I on", and the one you are on
   * EARNS its width — it stretches into a capsule and fills, so the thing
   * happening is the thing that is biggest. A focus round is a bigger dot than
   * its break, which puts the shape of the method into one glance.
   */
  private track(state: Timer["state"], lengths: Lengths): HTMLElement {
    const row = element("div", "tm-track");
    for (const session of cycle(lengths, state)) {
      const dot = element("div", `tm-dot is-${session.phase} is-${session.state}`);
      dot.setAttribute("data-tip",
        `${session.phase === "work" ? "Focus" : session.phase === "long" ? "Long break" : "Break"}`
        + ` — ${session.minutes} minutes`);
      if (session.state === "now") {
        const fill = element("i");
        fill.style.width = `${Math.round(this.timer.through() * 100)}%`;
        dot.append(fill);
      }
      row.append(dot);
    }
    return row;
  }

  private drawer(lengths: Lengths): HTMLElement {
    const box = element("div", "tm-drawer");
    const rows: [string, keyof Lengths, number, number][] = [
      ["Focus", "work", 5, 90],
      ["Break", "rest", 1, 30],
      ["Long break", "long", 5, 60],
    ];
    for (const [label, key, least, most] of rows) {
      const row = element("div", "tm-tune");
      row.append(element("span", "tm-tune-say", label));
      const step = (by: number) => {
        const next = Math.min(most, Math.max(least, lengths[key] + by));
        if (next === lengths[key]) return;
        click(1, 0);
        this.deps.setLengths({ ...lengths, [key]: next });
        this.drawn = "";
      };
      /* ⚠️ The two steppers and the number are ONE group. Laid out as three
       * loose children of a column, the plus of one length sat next to the
       * minus of the next and neither read as belonging to anything. */
      const pair = element("div", "tm-tune-row");
      pair.append(
        this.small("−", `Shorter ${label.toLowerCase()}`, () => step(-1)),
        element("b", "tm-tune-value", `${lengths[key]}m`),
        this.small("+", `Longer ${label.toLowerCase()}`, () => step(1)),
      );
      row.append(pair);
      box.append(row);
    }
    box.append(element("p", "tm-note", "The same numbers as Settings."));
    return box;
  }

  /* ── Bits ────────────────────────────────────────────────────────────── */

  /** ⚠️ Icon only, and the label is the TOOLTIP. Four labelled buttons in a
   *  row say all four matter equally; a big accent circle beside two grey ones
   *  says which one you meant. */
  private button(icon: "play" | "pause" | "close" | "next" | "settings",
    label: string, run: () => void, tone = "") {
    const button = element("button", `tm-btn${tone ? ` is-${tone}` : ""}`);
    (button as HTMLButtonElement).type = "button";
    button.setAttribute("aria-label", label);
    button.setAttribute("data-tip", label);
    paintIcon(button, icon);
    // 0: a press is deliberate and must never be swallowed by the dial's floor.
    button.onclick = () => { click(0.8, 0); run(); };
    return button;
  }

  private small(glyph: string, label: string, run: () => void) {
    const button = element("button", "tm-step", glyph);
    (button as HTMLButtonElement).type = "button";
    button.setAttribute("aria-label", label);
    button.onclick = run;
    return button;
  }

  /** The seconds, the running dot and the phase line, in place — the screen
   *  itself is keyed and must not be rebuilt once a second. */
  tick() {
    const state = this.ours(this.timer.state, this.deps.mode());
    if (!state) return;
    const clock = this.host.querySelector<HTMLElement>(".tm-clock");
    // Per digit, so only the numbers that changed move. See `clock`.
    if (clock) setDigits(clock, timerText(this.timer.seconds()));
    const fill = this.host.querySelector<HTMLElement>(".tm-dot.is-now i");
    if (fill) fill.style.width = `${Math.round(this.timer.through() * 100)}%`;
    const said = this.host.querySelector<HTMLElement>(".tm-say");
    if (said) setText(said, this.phaseLine(state, this.deps.lengths()));
    // A running timer's dial reads what is left, so it glides as it goes.
    const strip = this.host.querySelector<HTMLElement>(".tm-dial.is-locked .tm-strip");
    if (strip) this.place(strip, this.timer.seconds() / 60);
  }
}
