/* The countdown: a timer you wind, or a pomodoro you work through.
 *
 * ⚠️ **One screen, two faces, and they are genuinely different things.** A
 * timer is a number you choose; a pomodoro is a shape you move along. Giving
 * them one face meant the pomodoro had a duration control it should not have
 * and the timer had a session track that meant nothing. Two screens would have
 * been two near-identical faces competing for one stop on the rail.
 *
 * ⚠️ **The dial belongs to the timer alone.** A pomodoro's lengths are a
 * setting you choose once and then stop thinking about; putting them under a
 * drag would invite fiddling with the one number the method exists to hold
 * still.
 */
import { element } from "./dom";
import { paintIcon } from "./task-icons";
import { timerText } from "./focus-timer";
import { away, clamp, offsetFor, ticks, wound } from "./dial";
import { ROUNDS, cycle, phaseName, type Lengths, type Timer } from "./timer";

/** How far either side of the marker the ruler stays sharp, in px. */
const REACH = 190;

export interface TimerDeps {
  lengths: () => Lengths;
  /** Which face is showing, and a way to remember it. */
  mode: () => "timer" | "pomodoro";
  setMode: (mode: "timer" | "pomodoro") => void;
  setLengths: (lengths: Lengths) => void;
  /** Hold the panel open while the name is being typed. */
  focus: (active: boolean) => void;
  /** Redraw. ⚠️ Needed because some of this screen's state is its OWN — the
   * open drawer, the dial's setting — rather than the timer's, so nothing else
   * would know to repaint. Without it the lengths drawer opened on the next
   * whole minute, which reads as a button that does not work. */
  changed: () => void;
}

export class TimerScreen {
  private host: HTMLElement;
  private timer: Timer;
  private deps: TimerDeps;

  /** What the dial is wound to while nothing is running. */
  private set = 15;
  /** Whether the lengths drawer is open. */
  private tuning = false;

  constructor(host: HTMLElement, timer: Timer, deps: TimerDeps) {
    this.host = host;
    this.timer = timer;
    this.deps = deps;
  }

  private drawn = "";

  /** Is the thing that is running this face's own?
   *
   * ⚠️ A plain timer and a pomodoro are ONE engine, so both faces can see
   * whatever is counting — and each has to refuse the other's. Without this
   * the Timer face showed a running pomodoro's countdown above a dial set to
   * something else entirely, which is two different times on one screen. */
  private ours(state: Timer["state"], mode: "timer" | "pomodoro"): Timer["state"] {
    if (!state) return null;
    const plain = state.phase === "plain";
    return (mode === "timer") === plain ? state : null;
  }

  render() {
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

    this.host.append(this.modes(mode));
    if (mode === "timer") this.timerFace(state);
    else this.pomodoroFace(state, lengths);
  }

  /* ── The switch ──────────────────────────────────────────────────────── */

  private modes(mode: "timer" | "pomodoro"): HTMLElement {
    const row = element("div", "tm-modes");
    for (const one of ["timer", "pomodoro"] as const) {
      const button = element("button", `tm-mode${one === mode ? " is-on" : ""}`,
        one === "timer" ? "Timer" : "Pomodoro");
      (button as HTMLButtonElement).type = "button";
      button.setAttribute("aria-pressed", String(one === mode));
      button.onclick = () => { this.deps.setMode(one); };
      row.append(button);
    }
    return row;
  }

  /* ── A timer you wind ────────────────────────────────────────────────── */

  private timerFace(state: Timer["state"]) {
    const running = !!state;
    /* While it runs the dial reads what is LEFT, on the same scale it was set
     * with — so setting it and watching it are one picture rather than two. */
    const minutes = running ? Math.max(0, this.timer.seconds() / 60) : this.set;

    const face = element("div", "tm-face");
    const clock = element("div", "tm-clock",
      running ? timerText(this.timer.seconds()) : `${this.set}:00`);
    face.append(clock);
    this.host.append(face);
    this.host.append(this.dial(minutes, !running));

    const acts = element("div", "tm-acts");
    if (!running) {
      acts.append(this.key("play", "Start", () => this.timer.start(this.set), "lead"));
    } else {
      acts.append(this.key(
        state!.endsAt === null ? "play" : "pause",
        state!.endsAt === null ? "Resume" : "Pause",
        () => this.timer.toggle(), "lead",
      ));
      acts.append(this.key("close", "Stop", () => this.timer.stop()));
    }
    this.host.append(acts);
  }

  /** The ruler. ⚠️ Every tick is built once for the whole range, not windowed
   *  to what is visible: 121 elements is nothing, and a windowed ruler has to
   *  be rebuilt on every frame of a drag, which is the one moment it must
   *  not be. */
  private dial(minutes: number, live: boolean): HTMLElement {
    const host = element("div", `tm-dial${live ? "" : " is-locked"}`);
    const strip = element("div", "tm-strip");
    for (const tick of ticks()) {
      const mark = element("i", tick.major ? "is-major" : "");
      mark.style.left = `${tick.at}px`;
      strip.append(mark);
      if (tick.major) {
        const label = element("span", "tm-tick-say", String(tick.minute));
        label.style.left = `${tick.at}px`;
        strip.append(label);
      }
    }
    host.append(strip, element("span", "tm-marker"));
    this.place(strip, minutes);
    if (live) this.windable(host, strip);
    return host;
  }

  /** Put the strip where `minutes` sits under the marker, and fade its ends. */
  private place(strip: HTMLElement, minutes: number) {
    strip.style.translate = `${offsetFor(minutes)}px`;
    for (const mark of strip.children) {
      const at = parseFloat((mark as HTMLElement).style.left || "0");
      const far = away({ minute: 0, at, major: false }, minutes, REACH);
      /* The depth of field that says "a strip passing under a mark" rather
       * than "a row of lines". ⚠️ Clamped by `away`, or the opacity goes
       * negative and the ruler simply is not there. */
      (mark as HTMLElement).style.opacity = String(Math.max(0.06, 1 - far * 1.15));
      (mark as HTMLElement).style.filter = far > 0.55 ? `blur(${(far - 0.55) * 5}px)` : "";
    }
  }

  private windable(host: HTMLElement, strip: HTMLElement) {
    let from: number | null = null;
    let started = this.set;

    host.addEventListener("pointerdown", event => {
      if (event.button !== 0) return;
      from = event.clientX;
      started = this.set;
      host.setPointerCapture(event.pointerId);
      host.classList.add("is-winding");
    });
    host.addEventListener("pointermove", event => {
      if (from === null) return;
      const next = wound(started, event.clientX - from);
      if (next === this.set) return;
      this.set = next;
      /* ⚠️ Written straight into the DOM rather than through `render()`: this
       * runs on every frame of a drag, and a rebuild there would throw the
       * strip away under the finger holding it. */
      this.place(strip, this.set);
      const clock = this.host.querySelector<HTMLElement>(".tm-clock");
      if (clock) clock.textContent = `${this.set}:00`;
    });
    const release = (event: PointerEvent) => {
      if (from === null) return;
      from = null;
      host.classList.remove("is-winding");
      if (host.hasPointerCapture(event.pointerId)) host.releasePointerCapture(event.pointerId);
      // The key is stale now; let the next render agree with the DOM.
      this.drawn = "";
    };
    host.addEventListener("pointerup", release);
    host.addEventListener("pointercancel", release);

    /* A wheel winds it too. ⚠️ `passive: false`, or the panel's own
     * wheel-to-change-screen takes the gesture and you leave the timer. */
    host.addEventListener("wheel", event => {
      event.preventDefault();
      event.stopPropagation();
      this.set = clamp(this.set + (event.deltaY > 0 ? -1 : 1));
      this.place(strip, this.set);
      const clock = this.host.querySelector<HTMLElement>(".tm-clock");
      if (clock) clock.textContent = `${this.set}:00`;
      this.drawn = "";
    }, { passive: false });
  }

  /* ── A pomodoro you work through ─────────────────────────────────────── */

  private pomodoroFace(state: Timer["state"], lengths: Lengths) {
    /* ⚠️ A field with no box around it. It is optional and usually empty, and
     * an empty bordered input is a hole in the middle of the screen; as a big
     * quiet line of text it reads as a heading you are invited to write. */
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
    /* ⚠️ Kept out of the render key while it is being typed in, or every
     * keystroke rebuilds the field and the caret goes back to the start. */
    name.oninput = () => { if (state) this.timer.state!.name = name.value.trim() || undefined; };
    this.host.append(name);

    const face = element("div", "tm-face");
    face.append(element("div", "tm-clock",
      state ? timerText(this.timer.seconds()) : `${lengths.work}:00`));
    const said = element("div", "tm-say");
    if (state) {
      const round = Math.min(ROUNDS, (state.round % ROUNDS) + (state.phase === "work" ? 1 : 0));
      said.textContent = state.endsAt === null
        ? `${phaseName(state)} · paused`
        : state.phase === "work" ? `${phaseName(state)} · ${round} of ${ROUNDS}`
        : phaseName(state);
    } else {
      said.textContent = `${lengths.work} minutes, then a ${lengths.rest}-minute break`;
    }
    face.append(said);
    this.host.append(face);

    this.host.append(this.track(state, lengths));

    const acts = element("div", "tm-acts");
    if (!state) {
      acts.append(this.key("play", "Start", () => this.timer.start(undefined, name.value), "lead"));
    } else {
      acts.append(this.key(
        state.endsAt === null ? "play" : "pause",
        state.endsAt === null ? "Resume" : "Pause",
        () => this.timer.toggle(), "lead",
      ));
      acts.append(this.key("next", "Skip", () => this.timer.skip()));
      acts.append(this.key("close", "Stop", () => this.timer.stop()));
    }
    const tune = this.key("settings", "Lengths", () => {
      this.tuning = !this.tuning;
      this.drawn = "";
      this.deps.changed();
    });
    tune.classList.toggle("is-on", this.tuning);
    acts.append(tune);
    this.host.append(acts);

    if (this.tuning) this.host.append(this.drawer(lengths));
  }

  /** The whole cycle, laid out, so where you are is a place rather than a
   *  number you have to remember. */
  private track(state: Timer["state"], lengths: Lengths): HTMLElement {
    const row = element("div", "tm-track");
    for (const session of cycle(lengths, state)) {
      const seg = element("div", `tm-seg is-${session.phase} is-${session.state}`);
      /* ⚠️ Sized by its own MINUTES, so a five-minute break is visibly a fifth
       * of a twenty-five-minute focus. Equal segments would say the cycle is
       * eight equal things, which is the one thing it is not. */
      seg.style.flexGrow = String(session.minutes);
      seg.setAttribute("data-tip",
        `${session.phase === "work" ? "Focus" : session.phase === "long" ? "Long break" : "Break"}`
        + ` — ${session.minutes} minutes`);
      if (session.state === "now") {
        const fill = element("i");
        fill.style.width = `${Math.round(this.timer.through() * 100)}%`;
        seg.append(fill);
      }
      row.append(seg);
    }
    return row;
  }

  /** The three lengths, behind a button.
   *
   * ⚠️ These write the SAME preferences the settings window does. One stored
   * value, two controls — which is a different thing from two places that each
   * remember their own answer, and it is the only version of this that does
   * not break the one-settings-window rule the whole app is built on.
   */
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
        this.deps.setLengths({ ...lengths, [key]: next });
        this.drawn = "";
      };
      const down = this.small("−", `Shorter ${label.toLowerCase()}`, () => step(-1));
      const value = element("b", "tm-tune-value", `${lengths[key]}m`);
      const up = this.small("+", `Longer ${label.toLowerCase()}`, () => step(1));
      row.append(down, value, up);
      box.append(row);
    }
    box.append(element("p", "tm-note", "Also in Settings — this is the same number."));
    return box;
  }

  /* ── Bits ────────────────────────────────────────────────────────────── */

  private key(icon: "play" | "pause" | "close" | "next" | "settings", label: string,
    run: () => void, tone = "") {
    const button = element("button", `tm-key${tone ? ` is-${tone}` : ""}`);
    (button as HTMLButtonElement).type = "button";
    button.setAttribute("aria-label", label);
    paintIcon(button, icon);
    button.append(element("span", "tm-key-say", label));
    button.onclick = run;
    return button;
  }

  private small(glyph: string, label: string, run: () => void) {
    const button = element("button", "tm-step", glyph);
    (button as HTMLButtonElement).type = "button";
    button.setAttribute("aria-label", label);
    button.onclick = run;
    return button;
  }

  /** The seconds and the running segment, in place — the screen is keyed. */
  tick() {
    const state = this.ours(this.timer.state, this.deps.mode());
    // The other face's countdown is not this one's to draw. See `ours`.
    if (!state) return;
    const clock = this.host.querySelector<HTMLElement>(".tm-clock");
    if (clock) clock.textContent = timerText(this.timer.seconds());
    const fill = this.host.querySelector<HTMLElement>(".tm-seg.is-now i");
    if (fill) fill.style.width = `${Math.round(this.timer.through() * 100)}%`;
    // A running timer's dial reads what is left, so it glides as it goes.
    const strip = this.host.querySelector<HTMLElement>(".tm-dial.is-locked .tm-strip");
    if (strip) this.place(strip, this.timer.seconds() / 60);
  }
}
