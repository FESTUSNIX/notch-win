/* The pure half of in-call mode: which buttons a call gets, and in what order.
 *
 * Split out so it can be tested under `node --test` — `screen-call.ts` reaches
 * for the DOM and for Tauri's event bridge on import, and neither exists there.
 * Same reason `media-format.ts` exists beside `screen-media.ts`.
 *
 * ⚠️ **Nothing here decides what an app CAN do.** That list is `Call.can`, and
 * it is built in Rust from the shortcut table — the one place that knows Google
 * Meet has no way to hang up from the keyboard. This file only lays out what
 * arrived. Deriving the buttons from the app's name here as well would be the
 * same rule in two languages, and the two would drift.
 */
import type { TaskIcon } from "./task-icons";

export interface CallControl {
  /** What `call_action` is asked for. */
  action: string;
  icon: TaskIcon;
  label: string;
  /** Hanging up is the one press here that cannot be taken back. */
  tone?: "danger";
  /** Drawn as held down — the mute, while the microphone is cut. */
  on?: boolean;
}

/** Left to right. ⚠️ Leave is LAST and nothing is ever placed after it: it is
 *  the only irreversible control on the row, and a row whose destructive end
 *  moves depending on which app you are in is a row you cannot press without
 *  looking. */
const ORDER = ["mute", "video", "share", "hand", "open", "leave"];

/** Every control this call offers, in the order they are drawn.
 *
 * ⚠️ `can` is filtered, not trusted as an order: it arrives in the table's
 * order, and an app that gains a shortcut later would otherwise quietly move
 * everything else along the row.
 */
export function callControls(can: string[], muted: boolean): CallControl[] {
  const out: CallControl[] = [];
  for (const action of ORDER) {
    if (!can.includes(action)) continue;
    out.push(control(action, muted));
  }
  return out;
}

function control(action: string, muted: boolean): CallControl {
  switch (action) {
    /* ⚠️ The label says what the press WILL do, not what is true now — the
     * same rule the pill's play/pause glyph follows. The icon says the state:
     * a struck-through microphone beside the word "Unmute" is the one pairing
     * that reads correctly, because you are looking at what you are and
     * pressing for what you want. */
    case "mute":
      return {
        action: muted ? "unmute" : "mute",
        icon: muted ? "micOff" : "mic",
        label: muted ? "Unmute" : "Mute",
        on: muted,
      };
    case "video": return { action, icon: "video", label: "Video" };
    case "share": return { action, icon: "share", label: "Share" };
    case "hand": return { action, icon: "hand", label: "Hand" };
    case "open": return { action, icon: "open", label: "Open" };
    default: return { action: "leave", icon: "hangup", label: "Leave", tone: "danger" };
  }
}

/** The two the collapsed pill carries.
 *
 * ⚠️ Two, because the pill is a strip beside a clock and the third control is
 * what turns it into a toolbar. Mute is one of them always — it is the reason
 * anybody looks at a notch mid-call. The other is the way OUT: hanging up
 * where the app can be told to, and otherwise bringing the call forward, which
 * is the nearest honest thing. An app that offers neither gets one button
 * rather than a dead second one.
 */
export function pillControls(can: string[], muted: boolean): CallControl[] {
  const out = [control("mute", muted)];
  if (can.includes("leave")) out.push(control("leave", muted));
  else if (can.includes("open")) out.push(control("open", muted));
  return out;
}
