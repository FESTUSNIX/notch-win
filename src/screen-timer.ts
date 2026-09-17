/* The countdown, with room for its controls.
 *
 * ⚠️ The header's chip is a READOUT and a door, not the whole feature. It shows
 * what is left and opens this; everything that is a decision — start, stop,
 * how long — is here, where there is room to label it. A header with six
 * controls crammed into 22 pixels is the strip this app replaced.
 *
 * ⚠️ This is NOT the focus timer on Today. That one is a stopwatch attached to
 * a task, counting up with no end; this counts down to one. See `timer.ts`.
 */
import { element } from "./dom";
import { paintIcon } from "./task-icons";
import { timerText } from "./focus-timer";
import { ROUNDS, phaseName, type Lengths, type Timer } from "./timer";

/** What a press of one of the preset buttons is worth, in minutes.
 *
 * ⚠️ Five of them, and none longer than 45. A preset is for the countdown you
 * want without thinking; anything else is `timer 90` in the palette, which is
 * faster than a row of twelve buttons you have to read. */
const PRESETS = [5, 10, 15, 25, 45];

export class TimerScreen {
  private host: HTMLElement;
  private timer: Timer;
  private lengths: () => Lengths;

  constructor(host: HTMLElement, timer: Timer, lengths: () => Lengths) {
    this.host = host;
    this.timer = timer;
    this.lengths = lengths;
  }

  private drawn = "";

  render() {
    const state = this.timer.state;
    /* Keyed like the other screens: `render()` runs on every frame of a rail
     * drag, and the seconds are written by `tick` rather than redrawn. */
    const key = [state?.phase ?? "", state?.endsAt === null, state?.round ?? 0].join("|");
    if (key === this.drawn) return;
    this.drawn = key;
    this.host.replaceChildren();

    const face = element("div", "timer-face");
    const clock = element("div", "timer-clock", state ? timerText(this.timer.seconds()) : "—");
    const said = element("div", "timer-say");
    if (state) {
      said.textContent = state.endsAt === null
        ? `${phaseName(state)} · paused`
        : phaseName(state);
    } else {
      said.textContent = "Nothing running";
    }
    face.append(clock, said);

    /* How many pomodoros are behind you in this run. ⚠️ Only while a run is
     * going: a permanent "0 of 4" is a scoreboard for a game nobody started. */
    if (state && state.round > 0) {
      const dots = element("div", "timer-rounds");
      for (let index = 0; index < ROUNDS; index++) {
        const dot = element("i");
        if (index < state.round % ROUNDS || (state.round > 0 && state.round % ROUNDS === 0)) {
          dot.className = "is-done";
        }
        dots.append(dot);
      }
      face.append(dots);
    }
    this.host.append(face);

    const row = element("div", "timer-acts");
    if (!state) {
      row.append(this.key("play", `Start a ${this.lengths().work}-minute pomodoro`,
        () => this.timer.start(), true));
    } else {
      row.append(this.key(
        state.endsAt === null ? "play" : "pause",
        state.endsAt === null ? "Carry on" : "Pause",
        () => this.timer.toggle(), true,
      ));
      row.append(this.key("close", "Stop", () => this.timer.stop()));
    }
    this.host.append(row);

    const presets = element("div", "timer-presets");
    presets.append(element("span", "timer-presets-say", "Just a timer"));
    for (const minutes of PRESETS) {
      const one = element("button", "timer-preset", `${minutes}m`);
      (one as HTMLButtonElement).type = "button";
      one.setAttribute("data-tip", `Count down ${minutes} minutes`);
      one.onclick = () => this.timer.start(minutes);
      presets.append(one);
    }
    this.host.append(presets);

    /* ⚠️ One settings window, so the lengths are not repeated here — a second
     * place to change the same number is the trap this app is built around.
     * What is here is where they live. */
    this.host.append(element("p", "timer-note",
      `Pomodoro ${this.lengths().work}m, break ${this.lengths().rest}m, `
      + `long break ${this.lengths().long}m after ${ROUNDS} — change them in Settings.`));
  }

  private key(icon: "play" | "pause" | "close", label: string, run: () => void, lead = false) {
    const button = element("button", `timer-key${lead ? " is-lead" : ""}`);
    (button as HTMLButtonElement).type = "button";
    button.setAttribute("aria-label", label);
    button.setAttribute("data-tip", label);
    paintIcon(button, icon);
    button.append(element("span", "timer-key-say", label));
    button.onclick = run;
    return button;
  }

  /** The seconds, in place — the screen itself is keyed. */
  tick() {
    const clock = this.host.querySelector<HTMLElement>(".timer-clock");
    if (clock && this.timer.state) clock.textContent = timerText(this.timer.seconds());
  }
}
