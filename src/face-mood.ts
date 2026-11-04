/* The Guardian's face (2 Nov, his words: "I'd love some sort of visual
 * character … something playful"; he picked plain Eyes, with Hoot and Sir to
 * switch to): what mood it's in, decided from what codenotch already knows.
 *
 * Ten moods. Some last while their reason does (a voice turn, a warning up, a
 * session running, the night); some are a FLASH — paid, done, oops — that
 * plays for `FLASH_MS` and hands back to whatever is underneath. When several
 * apply the highest in `RANK` wins: talking to him beats everything, a failure
 * beats good news, good news beats a worry, a worry beats a session, a
 * session beats the night.
 *
 * Pure, tested in tests/face-mood.test.mjs. ⚠️ No runtime imports: `node
 * --test` loads this file (AGENTS 437).
 */

export type Mood = "idle" | "listen" | "think" | "speak" | "happy" | "love" | "focus" | "alert" | "oops" | "sleep"
  /** Only where a view asks for it: music playing beside him (the pill's edge). */
  | "vibe";
export const MOODS: Mood[] = ["idle", "listen", "think", "speak", "happy", "love", "focus", "alert", "oops", "sleep"];

/** A flash of good or bad news, this long. */
export const FLASH_MS = 4000;

/** Highest first. */
const RANK: Mood[] = ["listen", "speak", "think", "oops", "love", "happy", "alert", "focus", "sleep", "idle"];

/** The voice turn's phases, as voice-turn.ts names them. */
export type VoicePhase = "idle" | "pressed" | "listening" | "transcribing" | "thinking" | "speaking";

export interface MoodInputs {
  /** The voice turn, when one is live. */
  voice: VoicePhase | null;
  /** Flashes not yet over: what and until when (ms). */
  flashes: { mood: "happy" | "love" | "oops"; until: number }[];
  /** A warning is up: late money, a mail waiting, a session running over. */
  worried: boolean;
  /** A session or a pomodoro is running. */
  focused: boolean;
  /** Past his close time, or 23:00 to 06:00. */
  night: boolean;
  now: number;
}

/** A voice turn's phase as a mood: listening while he speaks, thinking while it's written down and answered, talking while it's said. */
export function voiceMood(phase: VoicePhase | null): Mood | null {
  if (!phase || phase === "idle") return null;
  if (phase === "pressed" || phase === "listening") return "listen";
  if (phase === "speaking") return "speak";
  return "think";
}

export function moodOf(s: MoodInputs): Mood {
  const on = new Set<Mood>();
  const v = voiceMood(s.voice);
  if (v) on.add(v);
  for (const f of s.flashes) if (f.until > s.now) on.add(f.mood);
  if (s.worried) on.add("alert");
  if (s.focused) on.add("focus");
  if (s.night) on.add("sleep");
  return RANK.find(m => on.has(m)) ?? "idle";
}

/** Whether it's night for the face: from his close time (minutes, when known), else 23:00, until 06:00. */
export function isNight(minutes: number, close: number | null): boolean {
  const from = close != null && close >= 18 * 60 ? close : 23 * 60;
  return minutes >= from || minutes < 6 * 60;
}

/** Flashes still running, the new one added (a repeat of the same mood just lasts longer). */
export function withFlash(flashes: MoodInputs["flashes"], mood: MoodInputs["flashes"][number]["mood"], now: number): MoodInputs["flashes"] {
  return [...flashes.filter(f => f.until > now && f.mood !== mood), { mood, until: now + FLASH_MS }];
}

/** The moods that move all the time (a beating heart, a nodding z, a voice): drawn every frame while they're on. */
export const LIVELY: ReadonlySet<Mood> = new Set<Mood>(["listen", "think", "speak", "happy", "love", "alert", "oops", "vibe"]);
/** The ones that last for hours (a session, the night): drawn at a few frames a second, enough for their slow motion. */
export const STEADY: ReadonlySet<Mood> = new Set<Mood>(["focus", "sleep"]);

/** Pokes in a row (within `POKE_WINDOW_MS` of each other) and what they get: a start, a giggle, then grumpy. */
export const POKE_WINDOW_MS = 4000;
export function pokeReaction(inARow: number): "startle" | "giggle" | "grumpy" {
  return inARow >= 5 ? "grumpy" : inARow >= 3 ? "giggle" : "startle";
}

/**
 * When the next habit falls (ms from now), "lively" only: a glance comes with
 * new text, these are the rare ones — a wink or a curious tilt a few times an
 * hour. `rand` is 0..1, passed in so the tests can fix it.
 */
export function nextHabit(rand: number): { kind: "wink" | "tilt"; inMs: number } {
  return { kind: rand < 0.5 ? "wink" : "tilt", inMs: Math.round(8 * 60_000 + rand * 14 * 60_000) };
}

/**
 * What a peek does to his face, if anything (2 Nov). His own news — paid,
 * logged, a thing he couldn't do, a mail that matters, a timer up — he tells
 * with his face in the peek's lead and a flash of mood; the PC's — the earbuds
 * going on, the volume maxed, the battery low — he reacts to, the same way.
 * Everything else keeps its glyph: a face where it says nothing is clutter
 * (his rule). Null: not his.
 */
export interface PeekFace { flash?: "happy" | "love" | "oops"; react?: "phones" | "wide" | "tired"; glance?: boolean }
export function peekFace(p: { kind: string; id: string; level?: number; tone?: string }): PeekFace | null {
  switch (p.kind) {
    case "paid": return { flash: "love" };
    // Hers: his eyes go soft for a reaction or a bonus; a penalty or a lock keeps its glyph.
    case "gabi": return p.tone === "gabi" ? { flash: "love" } : null;
    case "logged": return { flash: "happy" };
    case "pc": return { flash: "oops" };
    case "mail": case "timer": return { glance: true };
    case "buds": return p.tone === "neutral" ? null : { react: "phones" };
    case "volume": return (p.level ?? 0) >= 1 ? { react: "wide" } : null;
    case "power": return p.id === "power:low" ? { react: "tired" } : null;
    default: return null;
  }
}
