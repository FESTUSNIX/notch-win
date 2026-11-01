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

/** The two detectors (wake.rs `Detector`): sherpa-onnx is offline with no
 * account and the default; Picovoice needs his AccessKey and only knows "Jarvis". */
export const WAKE_ENGINES: [string, string][] = [["sherpa", "sherpa-onnx (offline)"], ["porcupine", "Picovoice"]];
export const DEFAULT_PHRASE = "Jarvis";

export function wakeEngine(pref: string | undefined): "sherpa" | "porcupine" {
  return pref === "porcupine" ? "porcupine" : "sherpa";
}

/** The phrase as sherpa will listen for it, or null — ASCII letters and single
 * spaces, one to three words, 40 characters at most. Mirrors `wake::phrase_ok`. */
export function wakePhrase(text: string): string | null {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 3 || !words.every(w => /^[A-Za-z]+$/.test(w))) return null;
  const joined = words.join(" ");
  return joined.length <= 40 ? joined : null;
}

/** Why a typed phrase is refused, for the field's tooltip; null when it is fine. */
export function wakePhraseProblem(text: string): string | null {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "Say something to listen for";
  if (words.length > 3) return "Three words at most";
  if (!words.every(w => /^[A-Za-z]+$/.test(w))) return "Letters only, A to Z";
  return wakePhrase(text) ? null : "Too long";
}

/** What it listens for: sherpa's phrase, or Porcupine's built-in "Jarvis". */
export function wakeWords(prefs: { wakeEngine?: string; wakePhrase?: string }): string {
  return wakeEngine(prefs.wakeEngine) === "sherpa" ? wakePhrase(prefs.wakePhrase ?? "") ?? DEFAULT_PHRASE : DEFAULT_PHRASE;
}

/** The mark's tooltip: listening, or why not (with the engine's own words when it failed). */
export function wakeTip(status: { listening: boolean; reason: string | null; problem?: string | null }, phrase = DEFAULT_PHRASE): string {
  if (status.listening) return `Listening for “${phrase}”`;
  const why = WAKE_PAUSED[status.reason ?? "off"] ?? "Paused";
  return status.reason === "engine" && status.problem ? `${why}: ${status.problem}` : why;
}
