/* Text that changes without snapping.
 *
 * Numbers on this surface change while you are looking at them — a tally after
 * a tick, a clock at the minute, a countdown to a meeting. Writing
 * `textContent` swaps them between two frames, which reads as a glitch rather
 * than as something updating.
 *
 * ⚠️ The animation is restarted by hand. Removing and re-adding a class in the
 * same task does nothing: the browser never computes the intermediate style, so
 * the keyframes do not replay. Reading `offsetWidth` in between forces the
 * reflow that makes the removal real.
 */
export function setText(el: HTMLElement, text: string) {
  if (el.textContent === text) return;
  const first = el.textContent === "" || el.textContent === null;
  el.textContent = text;
  if (first) return;          // arriving is not a change
  el.classList.remove("bumped");
  void el.offsetWidth;
  el.classList.add("bumped");
}

/** Same, for an attribute that drives a transition (a dash offset, a width). */
export function setStyle(el: HTMLElement, property: string, value: string) {
  if (el.style.getPropertyValue(property) === value) return;
  el.style.setProperty(property, value);
}

/** `14:32`, or `2:32 PM`. Deliberately not seconds: a pill that ticks every
 *  second is a thing that moves in the corner of your eye all day.
 *
 *  ⚠️ **`hourCycle`, not `hour12: false`.** They are not the same switch:
 *  `hour12: false` selects the `h24` cycle in several locales, which prints
 *  midnight as **24:00** and one minute past as 24:01 before rolling to 00:02.
 *  `h23` is the one that means what people mean by "24-hour clock".
 *
 *  ⚠️ And `hour: "2-digit"` is advisory in the 12-hour cycle — every engine
 *  prints `2:32 PM`, never `02:32 PM` — so the two formats have different
 *  character counts and the pill must not be sized on one of them.
 */
export function clockText(now = new Date(), use24 = true): string {
  return now.toLocaleTimeString([], {
    hour: use24 ? "2-digit" : "numeric",
    minute: "2-digit",
    hourCycle: use24 ? "h23" : "h12",
  });
}

/* ── Digits that change, rather than digits that are replaced ──────────────
 *
 * transitions.dev's number pop-in, with one deliberate departure: **only the
 * characters that actually changed are re-animated.**
 *
 * The stock snippet replays every digit on every update, which is right for a
 * balance you tap to refresh and wrong for a clock. `14:32` to `14:33` moves
 * one character; popping all five once a minute is a thing twitching in the
 * corner of your eye all day, which is the exact problem the "no seconds"
 * decision above already solved once.
 *
 * Characters are matched right-to-left, so `9:59` to `10:00` — where the string
 * grows — still re-animates the minutes rather than shifting every column by
 * one and calling all of it new.
 */
export function setDigits(group: HTMLElement, text: string) {
  const chars = [...text];
  const existing = [...group.children] as HTMLElement[];
  const first = existing.length === 0;

  // Right-to-left: the units column is the one that always moves, so aligning
  // from that end is what keeps a width change from reading as a full reset.
  const changed = new Set<number>();
  for (let i = 0; i < chars.length; i++) {
    const mirror = existing[existing.length - chars.length + i];
    if (!mirror || mirror.textContent !== chars[i]) changed.add(i);
  }
  if (!first && changed.size === 0) return;

  group.replaceChildren();
  chars.forEach((char, index) => {
    const span = document.createElement("span");
    span.className = "t-digit";
    span.textContent = char;
    // A colon is punctuation, not a digit: it never changes and animating it
    // makes the separator wobble between two numbers that are holding still.
    if (!first && changed.has(index) && /\d/.test(char)) {
      span.dataset.pop = "";
      // Later columns ride in behind earlier ones, so a rollover reads as a
      // sweep rather than as everything landing on the same frame.
      const rank = [...changed].filter(i => i < index && /\d/.test(chars[i])).length;
      if (rank) span.style.setProperty("--digit-delay", `calc(var(--duration-stagger) * ${rank})`);
    }
    group.append(span);
  });

  if (first) return;
  // See the note at the top: without the reflow the class removal is never
  // computed and the keyframes do not replay.
  group.classList.remove("is-animating");
  void group.offsetHeight;
  group.classList.add("is-animating");
}
