/* When he is done talking (2 Nov, his words: "sometimes I just say 'ok that's
 * it' or 'thanks' and it still keeps going"): what he said, read for a
 * sign-off at its END, in English or Polish.
 *
 * - `only`: nothing but a sign-off ("thanks", "ok, that's it", "dzięki, to
 *   wszystko"): nothing goes to the Guardian, the notch folds.
 * - `last`: a request that ends in one ("add milk, thanks"): it is sent and
 *   answered as ever, and no follow-up listens after the answer.
 * - null: anything else, the conversation goes on.
 *
 * ⚠️ An answer is not a goodbye: after a reply that ASKED ("Shall I log it?"),
 * "ok" or "dobra" is a yes — sent, then closed (`last`), never dropped. A bare
 * "ok" after a reply that only told him something is the end of it.
 * ⚠️ "stop", "cancel", "nieważne" end a FOLLOW-UP only: said fresh to the wake
 * word they may be meant for a timer or the music, so they go to the Guardian.
 * Pure, tested in tests/voice-close.test.mjs.
 *
 * ⚠️ No runtime imports: `node --test` loads this file (AGENTS 437).
 */

export type Close = "only" | "last" | null;

export interface CloseContext {
  /** Said in the follow-up after a reply. */
  follow: boolean;
  /** That reply ended with a question. */
  asked: boolean;
}

/** Goodbyes, wherever they are said. Without diacritics: see `wordsOf`. */
const SIGN_OFFS = [
  "thanks", "thank you", "thanks a lot", "thank you very much", "thanks so much", "thx", "cheers", "ta",
  "thats it", "thats all", "that is all", "that is it", "thatll be all", "that will be all", "thats everything",
  "thats all for now", "thats it for now", "all good", "im good", "im done", "were done", "done for now",
  "nothing else", "nothing more", "no thanks", "no thank you", "bye", "goodbye", "bye bye", "see you", "see ya",
  "see you later", "catch you later", "good night", "talk later",
  "dzieki", "dziekuje", "dziekuje bardzo", "dzieki wielkie", "wielkie dzieki", "dziekowa", "dzienks", "dzieks",
  "to wszystko", "to tyle", "to na tyle", "to by bylo na tyle", "na tyle", "na razie", "nara", "pa", "papa",
  "dobranoc", "nic wiecej", "nie dzieki", "nie trzeba", "juz nic", "koniec", "to koniec", "na dzis tyle",
];
/** Dismissals: a goodbye in a follow-up, maybe a command when fresh. */
const DISMISSALS = [
  "stop", "cancel", "never mind", "nevermind", "forget it", "enough", "leave it", "skip it",
  "anuluj", "niewazne", "zapomnij", "zostaw", "wystarczy", "starczy", "daj spokoj", "przestan",
];
/** A yes to a question. */
const YESES = ["ok", "okay", "okej", "oki", "okey", "yes", "yeah", "yep", "sure", "go ahead", "do it", "please",
  "tak", "dobra", "dobrze", "jasne", "pewnie", "prosze", "zrob to", "dawaj", "jasne ze tak"];
/** Words that only fill: they add nothing to a sign-off. */
const FILLERS = [...YESES, "jarvis", "great", "perfect", "cool", "nice", "fine", "alright", "all right", "awesome",
  "got it", "good", "very good", "excellent", "brilliant", "lovely", "right", "and", "so", "well", "oh", "ah", "hmm",
  "super", "swietnie", "idealnie", "ekstra", "git", "fajnie", "spoko", "rozumiem", "no", "a", "i", "to", "juz", "w porzadku"];

const phrases = (list: string[]) => list.map(one => one.split(" ")).sort((a, b) => b.length - a.length);
const SIGN_OFF = phrases(SIGN_OFFS);
const DISMISS = phrases(DISMISSALS);
const FILL = phrases(FILLERS);
const YES = new Set(YESES);

/** Lowercase words, no punctuation or diacritics ("Dzięki!" → ["dzieki"], "That's" → "thats"). */
export function wordsOf(text: string): string[] {
  return text.toLowerCase()
    .replace(/ł/g, "l")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/['’`]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** The longest phrase of `list` the words end with, as its length (0: none). */
function endsWith(words: string[], list: string[][]): number {
  for (const phrase of list) {
    if (phrase.length > words.length) continue;
    if (phrase.every((word, i) => words[words.length - phrase.length + i] === word)) return phrase.length;
  }
  return 0;
}

export function closing(text: string, context: CloseContext): Close {
  const words = wordsOf(text);
  if (!words.length) return null;
  const goodbyes = context.follow ? [...SIGN_OFF, ...DISMISS].sort((a, b) => b.length - a.length) : SIGN_OFF;
  // From the end back: goodbyes and fillers peeled off, until a word that is neither.
  let rest = words;
  let signed = false;
  let yes = false;
  for (;;) {
    const off = endsWith(rest, goodbyes);
    if (off) { signed = true; rest = rest.slice(0, rest.length - off); continue; }
    const fill = endsWith(rest, FILL);
    if (fill) {
      if (YES.has(rest.slice(rest.length - fill).join(" "))) yes = true;
      rest = rest.slice(0, rest.length - fill);
      continue;
    }
    break;
  }
  if (rest.length) return signed ? "last" : null;
  // Nothing but sign-offs and fillers.
  if (context.asked) return signed && !yes ? "only" : "last";
  return "only";
}
