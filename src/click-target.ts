/* Where a click on the pill's news or on a moment lands (4 Nov). His words: "when
 * we click on any peek we just open the previous screen", and "I open either on
 * guardian or today screen which provides no context for this action".
 *
 * Pure, so tests/click-target.test.mjs can run it under node; `goTo` in tasks.ts
 * carries it out. Two answers are allowed: the screen this thing belongs to, or
 * null, which means nothing here is about it yet. ⚠️ Null is not "open the panel
 * anyway": a screen with no connection to what he pressed is the bug, and a moment
 * already shows more about itself than Today does.
 */
import type { Peek } from "./peeks";
import type { Moment } from "./moments";
import type { ScreenName } from "./island-activity";

export interface Target {
  screen: ScreenName;
  /** On the calendar: this event's panel, open. */
  event?: string;
}

/** What follows the kind in an id: `meeting:<event id>` gives the event id. */
const afterKind = (id: string) => id.slice(id.indexOf(":") + 1);

/** A peek pressed. Mail, her notes, a download and a screenshot have no screen:
 *  those carry their own `action`, or stay put. */
export function peekTarget(peek: Pick<Peek, "kind" | "id">): Target | null {
  switch (peek.kind) {
    case "music": return { screen: "media" };
    case "volume": case "buds": case "mic": case "power": return { screen: "system" };
    case "block": case "focus": case "paid": case "logged": return { screen: "helm" };
    case "meeting": case "leave": return { screen: "calendar", event: afterKind(peek.id) };
    case "timer": return { screen: "timer" };
    case "pc": return { screen: "guardian" };
    default: return null;
  }
}

/** A moment's body pressed. ⚠️ A payment, a client's request, mail, the car and a
 *  reminder are null for now: leaving would take away the very buttons that act on
 *  them, and Today says nothing more. The context view replaces this. */
export function momentTarget(moment: Pick<Moment, "kind" | "key" | "helm">): Target | null {
  const helm = moment.helm;
  if (helm) {
    if (helm.kind === "prep" || helm.kind === "wrap") return { screen: "calendar", event: afterKind(helm.id) };
    return helm.kind === "drift" ? { screen: "helm" } : null;
  }
  switch (moment.kind) {
    // `meeting:<event id>:<its start>`
    case "meeting": return { screen: "calendar", event: moment.key.split(":")[1] };
    case "usage": return { screen: "agents" };
    case "nudge": return { screen: "guardian" };
    case "block": return { screen: "helm" };
    default: return null;
  }
}

/** Whether pressing the moment's body does anything: an agent's own window, closing
 *  the day, or a screen. The cursor says so. */
export const momentOpens = (moment: Pick<Moment, "kind" | "key" | "helm">): boolean =>
  moment.kind === "finished" || moment.kind === "question" || moment.helm?.kind === "close" || !!momentTarget(moment);
