/* A spoken turn with the Guardian, the pure half (`voice-talk.ts` runs it).
 *
 * Hold the talk key anywhere: the microphone opens on the press, the glance
 * comes up once it has been held half a second, letting go sends the words to
 * Helm, and the Guardian's reply is said sentence by sentence as it streams —
 * the first one while the rest is still being written. Holding the key while
 * it speaks stops it and listens (barge-in); Escape stops everything.
 *
 * Hands-free (29 Oct, round 2, his call: "holding the combo gets tiring if I
 * speak a lot"): a TAP of the key when nothing is being said keeps listening
 * — the microphone that opened on the press stays open — until Enter or
 * another tap sends it, or Escape drops it. Hold-and-release is untouched,
 * for any length. A tap while it speaks still only stops the speech.
 *
 * `step` is the whole state machine: an event in, the next state and what to
 * DO out (effects), so the order of things is under test (tests/voice.test.mjs)
 * and the shell only carries effects out. `takeSentences` and `speakable` are
 * what turns a streaming reply into things a voice can say; `wordsOf` and
 * `revealMs` are how the glance writes it in (`voice-glance.ts`).
 *
 * ⚠️ No runtime imports: `node --test` loads this file, and Node's resolver
 * adds no extensions (AGENTS 437).
 */

/** A press shorter than this is a tap: hands-free when idle, a stop while it speaks. */
export const HOLD_MS = 500;

export type Phase =
  /** Nothing happening. */
  | "idle"
  /** The key is down, under half a second: recording, nothing shown yet. */
  | "pressed"
  /** Held, or tapped into hands-free (`free`): the glance is up and listening. */
  | "listening"
  /** Let go: Helm is writing the words down. */
  | "transcribing"
  /** Sent: the Guardian is acting and writing, nothing to say yet. */
  | "thinking"
  /** Its sentences are being said. */
  | "speaking";

export interface TurnState {
  phase: Phase;
  /** Which spoken turn this is; a sentence's `said` names its own. */
  turn: number;
  /** The next sentence's place in the turn. */
  seq: number;
  /** Sentences handed to the voice and not yet heard. */
  out: number;
  /** The reply has finished streaming. */
  done: boolean;
  /** Reply text not yet a whole sentence. */
  buffer: string;
  /** Why this turn is text only (`off`, `call`, `meeting`, `presenting`, `unavailable`), or null. */
  muted: string | null;
  /** Listening hands-free: no key is held, Enter or another tap sends. */
  free: boolean;
  /** This press interrupted a reply: a tap is then a stop, never hands-free. */
  barge: boolean;
}

export type TurnEvent =
  | { t: "down" }
  /** Still down after `HOLD_MS`. */
  | { t: "held" }
  | { t: "up"; ms: number }
  /** Enter, which sends a hands-free turn. */
  | { t: "enter" }
  /** The recording ended by itself — five minutes, or the microphone went away: what came is sent. */
  | { t: "stop" }
  /** What Helm heard (empty: nothing). */
  | { t: "heard"; text: string }
  /** A delta of the Guardian's reply. */
  | { t: "text"; d: string }
  /** The reply finished (or failed: what came is all there is). */
  | { t: "done" }
  /** A sentence of `turn` was heard, hushed or refused. */
  | { t: "said"; turn: number }
  | { t: "muted"; why: string }
  | { t: "escape" }
  /** The recording or the send failed: the turn is over. */
  | { t: "failed" };

export type Effect =
  | { do: "record" }
  | { do: "cancel" }
  | { do: "finish" }
  | { do: "hush" }
  | { do: "open" }
  /** The keys taken from every app: Escape while the turn is live, Enter while hands-free listens. */
  | { do: "keys"; escape: boolean; enter: boolean }
  | { do: "send"; text: string }
  | { do: "say"; text: string; turn: number; seq: number }
  /** Back to idle: the glance stays up a moment for reading. */
  | { do: "end" };

export const idle = (turn = 0): TurnState => ({ phase: "idle", turn, seq: 0, out: 0, done: false, buffer: "", muted: null, free: false, barge: false });

/** The phases a reply is coming in. */
const replying = (phase: Phase) => phase === "thinking" || phase === "speaking";

const keys = (escape: boolean, enter = false): Effect => ({ do: "keys", escape, enter });

/** Back to idle, giving the keys back. */
const over = (state: TurnState, effects: Effect[] = []): [TurnState, Effect[]] =>
  [idle(state.turn), [...effects, keys(false), { do: "end" }]];

/** Let go, Enter, another tap, five minutes: the words go to Helm. */
const send = (state: TurnState, effects: Effect[] = []): [TurnState, Effect[]] =>
  [{ ...state, phase: "transcribing", free: false }, [...effects, keys(true), { do: "finish" }]];

/** The next state, and what to do about it. */
export function step(state: TurnState, event: TurnEvent): [TurnState, Effect[]] {
  switch (event.t) {
    case "down": {
      if (state.phase === "idle") return [{ ...state, phase: "pressed", barge: false }, [{ do: "record" }]];
      /* Barge-in: the voice stops at once, a tap included, and what is left of
       * the reply arrives as text only (no phase here listens for it). */
      if (replying(state.phase)) return [{ ...state, phase: "pressed", barge: true, buffer: "", out: 0 }, [{ do: "hush" }, { do: "record" }]];
      // Hands-free: the next press sends what was said, on the press.
      if (state.phase === "listening" && state.free) return send(state);
      // The key repeating while held, or a press while the words are on their way.
      return [state, []];
    }
    case "held":
      if (state.phase !== "pressed") return [state, []];
      return [{ ...state, phase: "listening" }, [{ do: "open" }, keys(true)]];
    case "up": {
      if (state.phase === "pressed" && event.ms < HOLD_MS) {
        // A tap while it spoke: the speech stays stopped, the reply goes on as text.
        if (state.barge) return over(state, [{ do: "cancel" }]);
        /* A tap otherwise: hands-free. ⚠️ The microphone that opened on the
         * press is KEPT, so what he says straight after the tap is in it. */
        return [{ ...state, phase: "listening", free: true }, [{ do: "open" }, keys(true, true)]];
      }
      if (state.phase === "pressed") {
        // Held long enough even if the timer lost the race with the key.
        return send(state, [{ do: "open" }]);
      }
      if (state.phase === "listening" && !state.free) return send(state);
      return [state, []];
    }
    case "enter":
      if (state.phase !== "listening" || !state.free) return [state, []];
      return send(state);
    case "stop":
      if (state.phase !== "listening" && state.phase !== "pressed") return [state, []];
      return send(state, state.phase === "pressed" ? [{ do: "open" }] : []);
    case "heard": {
      if (state.phase !== "transcribing") return [state, []];
      const text = event.text.trim();
      if (!text) return over(state);
      return [{ ...idle(state.turn + 1), phase: "thinking" }, [keys(true), { do: "send", text }]];
    }
    case "text": {
      if (!replying(state.phase)) return [state, []];
      return speak({ ...state, buffer: state.buffer + event.d }, false);
    }
    case "done": {
      if (!replying(state.phase)) return [state, []];
      const [next, effects] = speak({ ...state, done: true }, true);
      return next.out ? [next, effects] : over(next, effects);
    }
    case "said": {
      if (event.turn !== state.turn || !replying(state.phase)) return [state, []];
      const next = { ...state, out: Math.max(0, state.out - 1) };
      return next.done && !next.out ? over(next) : [next, []];
    }
    case "muted":
      return [{ ...state, muted: event.why }, []];
    case "escape":
      if (state.phase === "idle") return [state, []];
      return over(state, [{ do: "cancel" }, { do: "hush" }]);
    case "failed":
      if (state.phase === "idle") return [state, []];
      return over(state, [{ do: "cancel" }]);
  }
}

/** Whole sentences out of the buffer, said in order — unless this turn is text only. */
function speak(state: TurnState, final: boolean): [TurnState, Effect[]] {
  const { ready, rest } = takeSentences(state.buffer, final);
  const effects: Effect[] = [];
  let { seq, out, phase } = state;
  for (const sentence of ready) {
    const text = speakable(sentence);
    if (!text || state.muted) continue;
    effects.push({ do: "say", text, turn: state.turn, seq });
    seq++;
    out++;
    phase = "speaking";
  }
  return [{ ...state, buffer: rest, seq, out, phase }, effects];
}

/* ── Sentences ──────────────────────────────────────────────────────────── */

/** Words a full stop does not end, in the Guardian's Polish ("np.", "godz.", "ok."). */
const ABBREVIATIONS = new Set(["np", "itp", "itd", "tj", "tzn", "tzw", "godz", "ok", "min", "nr", "dr", "ul", "wg", "zob", "ds", "pn", "wt", "śr", "czw", "pt", "sob", "ndz", "tys", "mln", "gr", "ew", "jw", "m.in", "pon"]);
/** What may close a sentence after its mark: „tak.” and (dziś.) end there. */
const CLOSERS = "”\"'’)]»";

/**
 * The whole sentences at the front of a reply still streaming, and what is
 * left. A sentence ends at `.`, `!`, `?` or `…` (closing quotes and brackets
 * with it) followed by a space, or at a line break — never at a mark with
 * nothing after it yet, which may be "14." of "14.30", nor after an
 * abbreviation. `final` flushes the rest as the last sentence.
 */
export function takeSentences(buffer: string, final: boolean): { ready: string[]; rest: string } {
  const ready: string[] = [];
  let start = 0;
  for (let i = 0; i < buffer.length; i++) {
    const c = buffer[i];
    let end = -1;
    if (c === "\n") end = i + 1;
    else if (c === "." || c === "!" || c === "?" || c === "…") {
      let j = i + 1;
      while (j < buffer.length && CLOSERS.includes(buffer[j])) j++;
      if (j < buffer.length && /\s/.test(buffer[j])) {
        end = j;
        // "(krótko!) dziś": the mark closes an aside inside the sentence, not the sentence.
        const head = buffer.slice(start, i).trimStart();
        if (head.lastIndexOf("(") > 0 && head.lastIndexOf("(") > head.lastIndexOf(")") && buffer.slice(i + 1, j).includes(")")) end = -1;
        if (end > 0 && c === ".") {
          const word = /([\p{L}.]+)\.$/u.exec(buffer.slice(start, i + 1))?.[1]?.toLowerCase() ?? "";
          if (ABBREVIATIONS.has(word)) end = -1;
        }
      }
      if (end > 0) i = end - 1;
    }
    if (end < 0) continue;
    const sentence = buffer.slice(start, end).trim();
    if (sentence) ready.push(sentence);
    start = end;
  }
  let rest = buffer.slice(start);
  if (final) {
    if (rest.trim()) ready.push(rest.trim());
    rest = "";
  }
  return { ready, rest };
}

/* ── Words, for the glance ───────────────────────────────────────────── */

/**
 * The reply as the glance writes it: plain words, each with the space after
 * it, and whether the last one is whole yet. ⚠️ Markers are dropped one by
 * one, never as pairs, so what is already on screen does not change shape
 * when the closing `**` arrives two tokens later; a link keeps its words.
 * Line breaks are spaces: the glance is a few lines, not a document.
 */
export function wordsOf(text: string, done: boolean): { words: string[]; whole: number } {
  const plain = text
    .replace(/\[([^\]]*)\]\([^)]*\)?/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}|[-*•]|\d+[.)])\s+/gm, "")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trimStart();
  const words = plain.match(/\S+\s*/g) ?? [];
  // The last word is whole once a space follows it, or once nothing more is coming.
  const whole = done || /\s$/.test(plain) ? words.length : Math.max(0, words.length - 1);
  return { words, whole };
}

/**
 * How long a word is given before the next one appears. Read out loud, the
 * words go in at about the voice's own pace (OpenAI's Polish voice says
 * ~15 characters a second), so the text keeps roughly in step with what is
 * heard; text only, they flow in quickly. ⚠️ A backlog is drained faster
 * rather than let fall a sentence behind.
 */
export function revealMs(word: string, speaking: boolean, behind: number): number {
  if (!speaking) return behind > 12 ? 16 : 34;
  const pace = Math.max(110, word.trim().length * 62);
  return behind > 24 ? Math.round(pace / 3) : behind > 12 ? Math.round(pace / 1.6) : pace;
}

/**
 * What a voice should read of a sentence: the words without markdown, links,
 * list marks or emoji. The Guardian is asked for none of these on a spoken
 * turn (Helm's `GUARDIAN_VOICE`); this is for when it slips.
 */
export function speakable(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/^\s{0,3}(?:#{1,6}|[-*•]|\d+[.)])\s+/gm, "")
    .replace(/\*\*|__|[*~]/g, "")
    .replace(/\p{Extended_Pictographic}️?/gu, "")
    .replace(/\s*[→←↔⇒]\s*/g, ", ")
    .replace(/\s+/g, " ")
    .trim();
}
