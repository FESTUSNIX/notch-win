/* The tick a dial makes as it passes a mark.
 *
 * ⚠️ **Synthesised, not a file.** It is eighteen milliseconds of a sine wave
 * with an envelope on it — a WAV would be a bigger asset than the code, and a
 * file has to be decoded before the first one can play, which is exactly the
 * moment it must not be late. Nothing is shipped and nothing is loaded.
 *
 * ⚠️ **An `AudioContext` cannot start without a gesture**, which is why this
 * is created on the first tick rather than at import: a drag IS the gesture,
 * so by the time anything here is called the browser is willing. Built at
 * import it would be born `suspended` and stay silent for ever.
 */

let box: AudioContext | null = null;

/** Off entirely — the same preference that silences a finished countdown. */
let allowed = true;

/** The shortest gap between two ticks, in ms.
 *
 * ⚠️ A quick drag crosses a mark every two or three milliseconds, and a
 * hundred clicks a second is not a ratchet — it is a buzz, and it is the one
 * sound in the app that made somebody reach for the mute. Thinning them out
 * is what turns the same gesture back into detents you can count. The tick
 * that is dropped is simply not played: catching up afterwards would be a
 * burst of clicks arriving after the hand has stopped.
 */
const GAP = 45;
let last = -Infinity;

export function setClicks(on: boolean) {
  allowed = on;
}

/**
 * One tick.
 *
 * @param pitch 1 is an ordinary mark; a taller mark can ask for more.
 * @param gap   The floor to obey. ⚠️ A BUTTON passes 0: a press is a thing
 *              you did once and deliberately, and swallowing it because a
 *              drag ended forty milliseconds ago is the control going quiet
 *              at the one moment it was answering you.
 *
 * ⚠️ Very quiet, and very short. A dial that clicks at notification volume is
 * a dial nobody drags twice — the sound is there to be felt rather than heard,
 * which means about 3% gain and under twenty milliseconds.
 */
export function tick(pitch = 1, gap = GAP) {
  if (!allowed) return;
  const now = performance.now();
  if (now - last < gap) return;
  last = now;
  try {
    box ??= new AudioContext();
    if (box.state === "suspended") void box.resume();
    const now = box.currentTime;
    const tone = box.createOscillator();
    const level = box.createGain();
    tone.type = "square";
    tone.frequency.value = 1500 * pitch;
    /* An exponential fall, not a linear one: a linear tail on something this
     * short reads as a soft thud, and the ear wants a click. ⚠️ It cannot
     * reach zero — `exponentialRampToValueAtTime` throws on it — so the ramp
     * ends just above and the node stops. */
    level.gain.setValueAtTime(0.035, now);
    level.gain.exponentialRampToValueAtTime(0.0001, now + 0.018);
    tone.connect(level).connect(box.destination);
    tone.start(now);
    tone.stop(now + 0.02);
  } catch {
    /* No audio device, a policy that refuses, a browser without the API: a
     * dial that makes no noise is a dial, and this must never be the reason a
     * drag stops working. */
  }
}
