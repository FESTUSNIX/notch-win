/* Settings → Character (2 Nov): who the Guardian is in the notch — the Eyes,
 * Hoot or Sir, each shown alive, or off (the date comes back) — and how
 * lively he is, with his cameos and his reactions to the PC switchable.
 *
 * Stored as four prefs (prefs.rs): `faceCharacter` (eyes, hoot, sir, off),
 * `faceCalm`, `faceCameos`, `faceReactions`. face.ts reads them in the notch;
 * this file only writes. The cards draw with the notch's own painters, so
 * what he picks here is exactly what he gets there.
 */
import { Eyes, type Habits } from "./face-eyes";
import { Sprite } from "./face-friends";
import type { Mood } from "./face-mood";
import { taskIcon } from "./task-icons";

export interface CharacterPrefs { faceCharacter?: string; faceCalm?: boolean; faceCameos?: boolean; faceReactions?: boolean }

const CHARACTERS = [
  { id: "eyes", name: "Eyes" },
  { id: "hoot", name: "Hoot" },
  { id: "sir", name: "Sir" },
  { id: "off", name: "Off" },
] as const;

/** The moods the cards play through, a couple of seconds each. */
const REEL: Mood[] = ["idle", "happy", "listen", "love", "think", "alert", "speak", "sleep"];
const REEL_S = 1.8;

/** The pane's markup: the cards, then how he behaves. */
export const CHARACTER_PANE_HTML = `<div><p class="set-label">Who</p><div class="char-cards" id="char-cards" role="radiogroup" aria-label="Character"></div></div>
  <div><p class="set-label">How</p><div class="set-group">
    <div class="set-row"><div class="set-text"><b>Habits</b></div><div class="set-ctl"><div class="seg" role="group" aria-label="Habits" id="char-calm"><button type="button" data-calm="no" aria-pressed="false">Lively</button><button type="button" data-calm="yes" aria-pressed="false">Calm</button></div></div></div>
    <div class="set-row"><div class="set-text"><b>Cameos</b></div><div class="set-ctl"><input type="checkbox" class="switch" id="char-cameos" aria-label="Cameos"></div></div>
    <div class="set-row"><div class="set-text"><b>Reacts to your PC</b></div><div class="set-ctl"><input type="checkbox" class="switch" id="char-reactions" aria-label="Reacts to your PC"></div></div>
  </div></div>`;

export function mountCharacter(prefs: () => CharacterPrefs, change: (patch: CharacterPrefs) => void): () => void {
  const host = document.getElementById("char-cards")!;
  const live: { ctx: CanvasRenderingContext2D; draw: Eyes | Sprite; canvas: HTMLCanvasElement }[] = [];
  const cards: HTMLButtonElement[] = [];
  for (const spec of CHARACTERS) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "char-card";
    card.dataset.character = spec.id;
    card.setAttribute("role", "radio");
    const stage = document.createElement("span");
    stage.className = "char-stage";
    if (spec.id === "off") {
      // Off: the date is back in the pill, so the card shows the date.
      const date = document.createElement("span");
      date.className = "char-date";
      const now = new Date();
      date.append(Object.assign(document.createElement("b"), { textContent: String(now.getDate()) }),
        Object.assign(document.createElement("small"), { textContent: now.toLocaleDateString(undefined, { month: "short" }).toUpperCase() }));
      stage.append(date);
    } else {
      const canvas = document.createElement("canvas");
      canvas.setAttribute("aria-hidden", "true");
      stage.append(canvas);
      live.push({ canvas, ctx: canvas.getContext("2d")!, draw: spec.id === "eyes" ? new Eyes() : new Sprite(spec.id) });
    }
    card.append(stage, Object.assign(document.createElement("span"), { className: "char-name", textContent: spec.name }));
    card.onclick = () => { change({ faceCharacter: spec.id }); paint(); };
    host.append(card);
    cards.push(card);
  }

  const calm = document.getElementById("char-calm")!;
  for (const b of calm.querySelectorAll<HTMLButtonElement>("button")) b.onclick = () => { change({ faceCalm: b.dataset.calm === "yes" }); paint(); };
  const cameos = document.getElementById("char-cameos") as HTMLInputElement;
  const reactions = document.getElementById("char-reactions") as HTMLInputElement;
  cameos.onchange = () => change({ faceCameos: cameos.checked });
  reactions.onchange = () => change({ faceReactions: reactions.checked });
  for (const [id, icon] of [["char-cameos", "guardian"], ["char-reactions", "buds"]] as const) {
    const text = document.getElementById(id)!.closest(".set-row")!.querySelector(".set-text")!;
    text.classList.add("mod-row");
    text.prepend(taskIcon(icon));
  }

  /* The cards play their reel only while the pane is on screen. */
  const habits: Habits = { glance: 0, wink: 0, tilt: 0, level: null, look: null, react: null };
  let last = 0;
  const frame = (now: number) => {
    requestAnimationFrame(frame);
    if (!host.offsetParent) return;
    const t = now / 1000;
    const dt = Math.min(0.05, last ? t - last : 0.016);
    last = t;
    const mood = REEL[Math.floor(t / REEL_S) % REEL.length];
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    for (const one of live) {
      const size = Math.round(one.canvas.clientWidth * (window.devicePixelRatio || 1));
      if (!size) continue;
      if (one.canvas.width !== size) { one.canvas.width = size; one.canvas.height = size; }
      one.draw.draw(one.ctx, size, t, mood, dt, habits, reduced, 1.25);
    }
  };
  requestAnimationFrame(frame);

  function paint() {
    const now = prefs();
    const who = now.faceCharacter ?? "eyes";
    for (const card of cards) {
      const on = card.dataset.character === who;
      card.setAttribute("aria-checked", String(on));
      card.classList.toggle("is-chosen", on);
    }
    const isCalm = !!now.faceCalm;
    for (const b of calm.querySelectorAll<HTMLButtonElement>("button")) b.setAttribute("aria-pressed", String((b.dataset.calm === "yes") === isCalm));
    cameos.checked = now.faceCameos !== false;
    reactions.checked = now.faceReactions !== false;
    // Off, or calm: the switches have nothing to say.
    const off = who === "off";
    cameos.disabled = off || isCalm;
    reactions.disabled = off;
    calm.classList.toggle("is-off", off);
  }
  return paint;
}
