/* Whether this frame should move.
 *
 * Windows has one answer — the system's reduced-motion setting — and it is the
 * right default. It is not the only one worth having: a machine that turns
 * motion off globally for accessibility reasons still leaves the springs here
 * dead in a way nobody asked for, and a machine that leaves it on still has
 * people who would rather this particular panel just appeared.
 *
 * ⚠️ **One reader, consulted live.** The alternative — every spring caching
 * `matchMedia(...).matches` in a field at construction — is what the island and
 * Today both did, and it means a preference changed in the settings window
 * takes effect on the next restart. The attribute is on `<html>`, so the
 * stylesheet can answer the same question with the same three states.
 */
const reduced = matchMedia("(prefers-reduced-motion: reduce)");

export type MotionPref = "system" | "always" | "never";

/** ⚠️ Called per use, never stored. See above. */
export function still(): boolean {
  const mode = document.documentElement.dataset.motion;
  if (mode === "never") return true;
  if (mode === "always") return false;
  return reduced.matches;
}

/** Write the preference where both JS and CSS can read it. */
export function setMotion(mode: string) {
  const value: MotionPref = mode === "always" || mode === "never" ? mode : "system";
  document.documentElement.dataset.motion = value;
}

/** Fires when Windows changes its mind. ⚠️ Still worth listening to under
 *  `always`/`never`: the preference can go back to `system` without a reload. */
export function onSystemMotionChange(fn: () => void) {
  reduced.addEventListener("change", fn);
}
