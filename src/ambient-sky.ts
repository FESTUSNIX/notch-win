/* The sky outside the ambient window: what time of day it looks like, where
 * the sun or the moon is, and what the weather is doing.
 *
 * ⚠️ PURE, and no DOM in it. The scenes draw; this decides what they draw,
 * which is the part with rules worth testing — see `tests/ambient-sky`.
 *
 * ⚠️ Built on `dayArc` and `moonPhase`, the same two the Daylight widget uses,
 * so the ambient sky and the widget on the board can never disagree about
 * whether it is dusk or what the moon is doing.
 */
import { clockMinutes, dayArc, moonPhase, type DayPart } from "./widgets.ts";

/** A time of day somebody can pick instead of the real one. */
export type SkyChoice = "live" | "dawn" | "day" | "dusk" | "night";
/** A weather somebody can pick instead of the real one. */
export type WeatherChoice = "live" | "clear" | "clouds" | "rain" | "snow" | "fog" | "storm";

export interface Sky {
  part: DayPart;
  /** 0 at midnight-dark, 1 at full daylight. Continuous, so the scene never
   *  snaps between palettes. */
  light: number;
  /** 0..1, how much of the horizon glow is the warm one of sunrise and sunset. */
  warmth: number;
  /** How far across its own arc the sun (by day) or the moon (by night) is. */
  share: number;
  /** 0 = new, 0.5 = full. */
  moon: number;
  cloud: number;
  rain: number;
  snow: number;
  fog: number;
  /** Lightning, 0 or 1. */
  storm: number;
}

/** What each of the weather module's icons looks like as a sky.
 *
 * ⚠️ Keyed on the ICON, not on the WMO code: `weather.rs` already folds forty
 * codes into these nine, and folding them a second, different way here would
 * be two opinions about what "drizzle" means. */
const WEATHER: Record<string, Pick<Sky, "cloud" | "rain" | "snow" | "fog" | "storm">> = {
  wxClear: { cloud: 0.05, rain: 0, snow: 0, fog: 0, storm: 0 },
  wxPartly: { cloud: 0.35, rain: 0, snow: 0, fog: 0, storm: 0 },
  wxCloud: { cloud: 0.8, rain: 0, snow: 0, fog: 0.1, storm: 0 },
  wxFog: { cloud: 0.55, rain: 0, snow: 0, fog: 0.85, storm: 0 },
  wxDrizzle: { cloud: 0.7, rain: 0.3, snow: 0, fog: 0.15, storm: 0 },
  wxRain: { cloud: 0.85, rain: 0.65, snow: 0, fog: 0.1, storm: 0 },
  wxHeavyRain: { cloud: 0.95, rain: 1, snow: 0, fog: 0.2, storm: 0 },
  wxSnow: { cloud: 0.8, rain: 0, snow: 0.75, fog: 0.2, storm: 0 },
  wxStorm: { cloud: 0.95, rain: 0.9, snow: 0, fog: 0.1, storm: 1 },
};

/** The pickable weathers, as the icon they stand for. */
const CHOSEN: Record<Exclude<WeatherChoice, "live">, string> = {
  clear: "wxClear", clouds: "wxCloud", rain: "wxRain", snow: "wxSnow", fog: "wxFog", storm: "wxStorm",
};

/** A representative moment for a picked time of day, in minutes. ⚠️ Placed
 *  INSIDE the sunrise/sunset the caller passes, so "dusk" is dusk wherever
 *  and whenever the app is running. */
function pickedMinute(choice: Exclude<SkyChoice, "live">, rise: number, set: number): number {
  switch (choice) {
    case "dawn": return rise + 10;
    case "day": return Math.round(rise + (set - rise) * 0.42);
    case "dusk": return set - 12;
    case "night": return (set + 60 * 3) % (24 * 60);
  }
}

const clamp = (v: number) => Math.max(0, Math.min(1, v));

export interface SkyInput {
  now: Date;
  /** `HH:MM`, from the weather reading, or empty. */
  sunrise?: string;
  sunset?: string;
  /** The weather module's icon, or empty when there is no reading. */
  icon?: string;
  sky?: SkyChoice;
  weather?: WeatherChoice;
}

export function skyAt(input: SkyInput): Sky {
  /* ⚠️ Defaults that are a real day's shape, not zeroes. No weather module is
   * the ordinary case for somebody who never set a place, and a sky computed
   * from a sunrise of 00:00 would be noon at midnight. */
  const riseRaw = clockMinutes(input.sunrise);
  const setRaw = clockMinutes(input.sunset);
  const rise = riseRaw >= 0 ? riseRaw : 6 * 60 + 30;
  const set = setRaw > rise ? setRaw : 19 * 60;
  const choice = input.sky ?? "live";
  const minute = choice === "live"
    ? input.now.getHours() * 60 + input.now.getMinutes()
    : pickedMinute(choice, rise, set);
  const arc = dayArc(minute, rise, set);

  /* Light and warmth as CURVES over the arc, not as four palettes. The sky has
   * to move continuously through dusk — a scene left running across 19:00
   * that jumped from one palette to another would be the one moment it is
   * noticed. */
  let light: number;
  let warmth: number;
  if (arc.part === "night") {
    // A ramp of twilight at each end of the night, then dark.
    const edge = Math.min(arc.share, 1 - arc.share);
    light = 0.3 * clamp(1 - edge / 0.06);
    /* ⚠️ Warmth reaches 1 at the crossing from BOTH sides. It was 0.8 here
     * and 1 on the day side, so the horizon dimmed by a fifth in a single frame
     * at sunset — the one moment somebody is watching it. */
    warmth = clamp(1 - edge / 0.06);
  } else {
    const edge = Math.min(arc.share, 1 - arc.share);
    light = 0.3 + 0.7 * clamp(edge / 0.14);
    warmth = clamp(1 - edge / 0.16);
  }

  const icon = input.weather && input.weather !== "live" ? CHOSEN[input.weather] : input.icon ?? "";
  const weather = WEATHER[icon] ?? WEATHER.wxPartly;
  /* ⚠️ Cloud dims the light it lets through, and it takes the warmth out of a
   * sunset. An overcast dusk that still glowed orange would be the scene
   * contradicting the weather it claims to be showing. */
  light *= 1 - weather.cloud * 0.45;
  warmth *= 1 - weather.cloud * 0.6;

  return {
    part: arc.part,
    light,
    warmth,
    share: arc.share,
    moon: moonPhase(input.now),
    ...weather,
  };
}

/** Mix two `[r, g, b]` colours. */
export function mix(a: number[], b: number[], t: number): number[] {
  return a.map((v, i) => Math.round(v + (b[i] - v) * t));
}

/** The sky's three bands — top, middle, horizon — for a given sky.
 *
 * ⚠️ Night, day and the warm horizon are the only hand-picked colours; every
 * other sky is a mix of them. That is what keeps a storm at dusk, a clear
 * noon and fog at night in one family instead of nine palettes that each
 * have to be tuned against the other eight. */
export function skyColours(sky: Sky): { top: number[]; mid: number[]; horizon: number[] } {
  const night = { top: [9, 13, 27], mid: [20, 25, 46], horizon: [38, 38, 62] };
  const day = { top: [58, 104, 160], mid: [118, 158, 200], horizon: [196, 214, 226] };
  const warm = [214, 128, 88];
  /* ⚠️ Mixed, not chosen. A threshold here flipped an overcast sky from
   * charcoal to pale grey in one frame as the light crossed a half. */
  const grey = mix([34, 38, 52], [120, 128, 140], sky.light);
  const band = (key: "top" | "mid" | "horizon", warmthShare: number) => {
    const base = mix(night[key], day[key], sky.light);
    const warmed = mix(base, warm, sky.warmth * warmthShare);
    return mix(warmed, grey, sky.cloud * 0.65);
  };
  return { top: band("top", 0.08), mid: band("mid", 0.35), horizon: band("horizon", 0.9) };
}
