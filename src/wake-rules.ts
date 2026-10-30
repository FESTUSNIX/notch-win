/* The wake word's rules on the island's side (30 Oct). The detector itself is
 * native (`wake.rs`) and is already paused for a call, presenting, a turn and
 * the Guardian speaking; this is the page checking again when `wake:heard`
 * lands, because the page is the one that knows a turn is live this instant
 * (Rust hears it a call later). Pure, so `tests/wake.test.mjs` runs it. */

export interface WakeGate {
  /** Settings → Voice → Wake word. */
  enabled: boolean;
  /** Helm signed in: there is no Guardian to talk to otherwise. */
  signedIn: boolean;
  /** A voice turn is already under way (listening, thinking, speaking). */
  live: boolean;
  /** In a call (`callSource`): the microphone is the call's. */
  call: boolean;
  /** The Guardian is talking: it must never wake itself. */
  speaking: boolean;
  /** Silenced for an hour ("Wycisz słowo"), ms since the epoch; 0 none. */
  snoozedUntil: number;
  now: number;
}

/** Why a heard word starts nothing, in order of what wins; null starts a turn. */
export function wakeRefused(gate: WakeGate): string | null {
  if (!gate.enabled) return "off";
  if (gate.snoozedUntil > gate.now) return "snoozed";
  if (gate.call) return "call";
  if (gate.live) return "turn";
  if (gate.speaking) return "speaking";
  if (!gate.signedIn) return "signed-out";
  return null;
}

/** What the settings mark says while it is not listening — a tooltip, never a line on the page. */
export const WAKE_PAUSED: Record<string, string> = {
  off: "Off",
  key: "Needs your AccessKey",
  mic: "Pick a microphone",
  unplugged: "That microphone isn't plugged in",
  snoozed: "Silenced for an hour",
  presenting: "Paused while you present",
  call: "Paused during a call",
  turn: "Paused while you talk to the Guardian",
  speaking: "Paused while the Guardian speaks",
  engine: "The engine didn't start",
};

/** The mark's tooltip: listening, or why not (with the engine's own words when it failed). */
export function wakeTip(status: { listening: boolean; reason: string | null; problem?: string | null }): string {
  if (status.listening) return "Listening for “Jarvis”";
  const why = WAKE_PAUSED[status.reason ?? "off"] ?? "Paused";
  return status.reason === "engine" && status.problem ? `${why}: ${status.problem}` : why;
}
