/* In a call: who with, for how long, and the controls worth reaching.
 *
 * ⚠️ Nothing here knows what Zoom is. `call.rs` watches the microphone, names
 * the app and says which controls that app really answers to; this draws what
 * arrived. The one rule the front end owns is the one the back end cannot see —
 * that a control nobody offered is not drawn greyed out, it is not drawn.
 *
 * ⚠️ **The pill's controls are only reachable in click mode**, and that is not
 * an oversight — it is the same bargain the player's equaliser makes. With
 * hover opening, a pointer arriving at the pill has already turned it into a
 * panel, so there is nothing left to press; the full row of controls on the
 * expanded island is what you actually use, and it is one pointer-move away.
 * Building two different pills for the two modes would mean the strip's markup
 * changed when a preference did.
 */
import { element } from "./dom";
import { paintIcon } from "./task-icons";
import { call, native } from "./task-client";
import { clock } from "./media-format";
import { callControls, pillControls, type CallControl } from "./call-format";
import { listen } from "@tauri-apps/api/event";
import type { Activity } from "./island-activity";

export interface Call {
  active: boolean;
  app: string;
  appName: string;
  title: string;
  icon: string;
  /** Unix ms when the call was first seen. */
  since: number;
  /** The microphone ENDPOINT's mute — the only one that can be read back. */
  muted: boolean;
  can: string[];
  pid: number;
}

export const emptyCall = (): Call => ({
  active: false, app: "", appName: "", title: "", icon: "", since: 0,
  muted: false, can: [], pid: 0,
});

/** What is happening on the microphone, and the controls for it. */
export class CallSource {
  call: Call = emptyCall();
  error = "";

  constructor(
    private changed: () => void,
    private say: (what: string, why: string) => void,
  ) {}

  async boot() {
    if (native) await listen<Call>("call:changed", event => this.receive(event.payload));
    try { this.receive(await call<Call>("get_call")); } catch { /* nothing yet */ }
  }

  /** Whether a call has just begun, so the shell can put the island on it. */
  private wasActive = false;

  private receive(next: Call) {
    const began = next.active && !this.wasActive;
    this.wasActive = next.active;
    this.call = next;
    if (began) this.started?.();
    this.changed();
  }

  /** Called once each time a call begins. Set by the shell. */
  started: (() => void) | null = null;

  /** Seconds since the call was first seen. ⚠️ Derived from `since` rather
   *  than counted here: the poll is 1.5s and a counter of our own would drift
   *  from it, and would restart whenever this window reloaded mid-call. */
  elapsed(): number {
    if (!this.call.active || !this.call.since) return 0;
    return Math.max(0, (Date.now() - this.call.since) / 1000);
  }

  activity(): Activity | null {
    if (!this.call.active) return null;
    return {
      /* ⚠️ 70: above everything that stands, including the Bluetooth notice at
       * 60 and a waiting agent at 55. While you are in a call the pill IS the
       * mute button, and taking it away for four seconds to say a headset
       * connected is exactly the wrong trade. Only the island's own notice
       * (90) outranks it, because that is the direct answer to a key you just
       * pressed and it expires by itself. */
      priority: 70,
      screen: "call",
      kind: "call",
      label: this.call.title,
      value: `${this.call.appName} · ${clock(this.elapsed())}`,
      artwork: this.call.icon,
      icon: "mic",
      muted: this.call.muted,
      controls: pillControls(this.call.can, this.call.muted),
    };
  }

  /** Press one. ⚠️ Optimistic for the mute alone: it is the only one whose
   *  result this app can read back, so it is the only one that can be put
   *  right when the answer disagrees. Everything else happens inside another
   *  application, where "did it work" is not a question that can be asked. */
  act(action: string) {
    this.error = "";
    if (action === "mute" || action === "unmute") {
      this.call = { ...this.call, muted: action === "mute" };
      this.changed();
    }
    void call<Call>("call_action", { action })
      .then(fresh => { this.call = fresh; this.changed(); })
      .catch(error => {
        const why = String(error).replace(/^invoke error: /i, "");
        this.error = why;
        this.say("Call", why.slice(0, 120));
        this.changed();
      });
  }
}

/** The expanded island's call screen. */
export class CallScreen {
  /** @param clock the wall clock, formatted — the shell's, never ours. See
   *  `Activity.clock`: one clock, one preference, one tick. */
  constructor(
    private host: HTMLElement,
    private source: CallSource,
    private clock: () => string,
  ) {}

  /** What this screen was last drawn from. */
  private drawn = "";

  render() {
    const { call: live } = this.source;
    /* ⚠️ Only when something CHANGED. `render()` runs on every tick and on
     * every frame of a rail drag, and rebuilding six buttons each time throws
     * away the hover and the focus on whichever one the pointer is over — and
     * it is work the whole panel pays for during a gesture that is measured in
     * frames. The clocks move in `tick`, which writes text and nothing else. */
    const key = [live.active, live.app, live.title, live.muted, live.can.join(),
      live.icon.length, this.source.error].join("|");
    if (key === this.drawn) return;
    this.drawn = key;
    this.host.replaceChildren();
    if (!live.active) {
      const empty = element("p", "home-empty", "No call is running.");
      this.host.append(empty);
      return;
    }

    const head = element("div", "call-head");
    const plinth = element("div", "call-plinth");
    if (live.icon) {
      const art = element("img", "call-art") as HTMLImageElement;
      art.src = live.icon;
      art.alt = "";
      plinth.append(art);
    } else {
      paintIcon(plinth, "mic");
    }
    const copy = element("div", "call-copy");
    /* ⚠️ The app, then how long you have been in this — NOT how many people
     * are in the room. Nothing on Windows will say that: there is no API for
     * it and the window title does not carry it, and a number nobody can check
     * is worse than a number nobody has. The elapsed time is both knowable and
     * the thing you actually glance down for. */
    copy.append(
      element("b", "call-title", live.title),
      element("span", "call-where", `${live.appName} · ${clock(this.source.elapsed())}`),
    );
    head.append(plinth, copy, element("span", "call-held", this.clock()));

    const row = element("div", "call-acts");
    for (const one of callControls(live.can, live.muted)) {
      row.append(this.button(one));
    }
    this.host.append(head, row);

    if (this.source.error) {
      this.host.append(element("p", "call-why", this.source.error));
    }
  }

  private button(control: CallControl): HTMLElement {
    const wrap = element("div", "call-act");
    const key = element("button", `call-key${control.tone ? ` is-${control.tone}` : ""}`);
    (key as HTMLButtonElement).type = "button";
    if (control.on) key.classList.add("is-on");
    key.dataset.act = control.action;
    key.setAttribute("aria-label", control.label);
    key.setAttribute("data-tip", this.tip(control));
    paintIcon(key, control.icon);
    key.onclick = () => this.source.act(control.action);
    wrap.append(key, element("span", "call-act-say", control.label));
    return wrap;
  }

  /** ⚠️ The mute's tooltip says which mute it is. The microphone endpoint and
   *  the app's own button are two different switches, and this presses both —
   *  so when one of them fails you are still silent, and the sentence here is
   *  the only place that says so before it matters. */
  private tip(control: CallControl): string {
    if (control.action === "mute") return "Mute — the microphone and the app's own button";
    if (control.action === "unmute") return "Unmute — the microphone and the app's own button";
    if (control.action === "leave") return "Leave the call";
    if (control.action === "open") return "Bring the call window forward";
    if (control.action === "share") return "Share your screen";
    if (control.action === "hand") return "Raise your hand";
    return "Turn the camera on or off";
  }

  /** Move both clocks without redrawing the screen. Same contract as
   *  `TodayScreen.paintTimer`: a screen rebuilt every second would throw away
   *  the focus and the hover on every button on it. */
  tick() {
    const held = this.host.querySelector<HTMLElement>(".call-held");
    if (held) held.textContent = this.clock();
    const where = this.host.querySelector<HTMLElement>(".call-where");
    if (where && this.source.call.active) {
      where.textContent = `${this.source.call.appName} · ${clock(this.source.elapsed())}`;
    }
  }
}
