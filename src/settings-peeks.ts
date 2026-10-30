/* Settings → Peeks (batch 13, builder S): which news may borrow the pill,
 * grouped by what it is about, and quiet hours.
 *
 * Stored as the contract says: `peeks` holds the kinds switched OFF as
 * `false` (missing = on), `peekQuiet` is `{ from, to }` or null. `peek()` in
 * peeks.ts reads them; this file only writes.
 *
 * ⚠️ Kept out of task-editor.ts, which only hands it the prefs and the save:
 * the pane is one list, and the editor is long enough. */
import type { PeekKind } from "./peeks";
import { taskIcon, type TaskIcon } from "./task-icons";
import { withKind } from "./peek-logic";

export interface PeekQuiet { from: string; to: string }
export interface PeekPrefs { peeks?: Partial<Record<string, boolean>>; peekQuiet?: PeekQuiet | null }

/** Every kind, in its group. ⚠️ Ids are the contract's PeekKind: a typo here
 *  is a switch that controls nothing, which is why the type checks them. */
export const PEEK_GROUPS: { title: string; hue: string; kinds: { kind: PeekKind; icon: TaskIcon; title: string }[] }[] = [
  { title: "Music", hue: "#ff6b9a", kinds: [
    { kind: "music", icon: "media", title: "Song changes" },
    { kind: "volume", icon: "volume", title: "Volume" },
  ] },
  { title: "Your block", hue: "#a78bfa", kinds: [
    { kind: "block", icon: "timer", title: "Block starts and ends" },
  ] },
  { title: "Calendar", hue: "#5ac8fa", kinds: [
    { kind: "meeting", icon: "calendar", title: "Meeting soon" },
    { kind: "leave", icon: "later", title: "Time to leave" },
  ] },
  { title: "Devices", hue: "#64d2ff", kinds: [
    { kind: "buds", icon: "buds", title: "Earbuds" },
    { kind: "mic", icon: "micOff", title: "Microphone muted" },
    { kind: "power", icon: "battery", title: "Battery and charger" },
  ] },
  { title: "Files", hue: "#ffd60a", kinds: [
    { kind: "download", icon: "download", title: "Downloads" },
    { kind: "screenshot", icon: "image", title: "Screenshots" },
  ] },
  { title: "Money and work", hue: "#30d158", kinds: [
    { kind: "paid", icon: "money", title: "Paid" },
    { kind: "logged", icon: "stopwatch", title: "Time Helm logged" },
  ] },
  { title: "Focus", hue: "#ff9f0a", kinds: [
    { kind: "focus", icon: "focus", title: "Before the curtain" },
  ] },
];

const DEFAULT_QUIET: PeekQuiet = { from: "22:00", to: "07:00" };

/** The pane's markup: one host the rows are built into. */
export const PEEKS_PANE_HTML = `<div id="peek-groups"></div>
  <div><p class="set-label">Quiet hours</p><div class="set-group">
    <div class="set-row"><div class="set-text mod-row peek-row" style="--peek-hue:#8e8eff" id="peek-quiet-label"><b>Hours</b></div>
      <div class="set-ctl"><input type="time" id="peek-quiet-from" aria-label="From"><span class="peek-dash">–</span><input type="time" id="peek-quiet-to" aria-label="To"><input type="checkbox" class="switch" id="peek-quiet"></div></div>
  </div><p class="set-note">A battery at 5% still shows.</p></div>`;

export function mountPeeks(prefs: () => PeekPrefs, change: (patch: PeekPrefs) => void): () => void {
  const groups = document.getElementById("peek-groups")!;
  const boxes: { kind: PeekKind; box: HTMLInputElement; row: HTMLElement }[] = [];
  for (const group of PEEK_GROUPS) {
    const wrap = document.createElement("div");
    const label = document.createElement("p");
    label.className = "set-label";
    label.textContent = group.title;
    const list = document.createElement("div");
    list.className = "set-group";
    for (const spec of group.kinds) {
      const row = document.createElement("div");
      row.className = "set-row";
      const left = document.createElement("div");
      left.className = "set-text mod-row peek-row";
      left.style.setProperty("--peek-hue", group.hue);
      const title = document.createElement("b");
      title.textContent = spec.title;
      left.append(taskIcon(spec.icon), title);
      const box = document.createElement("input");
      box.type = "checkbox"; box.className = "switch"; box.dataset.peek = spec.kind;
      box.setAttribute("aria-label", spec.title);
      box.onchange = () => {
        change({ peeks: withKind(prefs().peeks, spec.kind, box.checked) });
        left.classList.toggle("is-off", !box.checked);
      };
      const ctl = document.createElement("div");
      ctl.className = "set-ctl";
      ctl.append(box);
      row.append(left, ctl);
      list.append(row);
      boxes.push({ kind: spec.kind, box, row: left });
    }
    wrap.append(label, list);
    groups.append(wrap);
  }

  const quietLabel = document.getElementById("peek-quiet-label")!;
  quietLabel.prepend(taskIcon("moon"));
  const quiet = document.getElementById("peek-quiet") as HTMLInputElement;
  const from = document.getElementById("peek-quiet-from") as HTMLInputElement;
  const to = document.getElementById("peek-quiet-to") as HTMLInputElement;
  const sendQuiet = () => {
    const next = quiet.checked && from.value && to.value && from.value !== to.value ? { from: from.value, to: to.value } : null;
    change({ peekQuiet: next });
    paintQuiet(next);
  };
  const paintQuiet = (q: PeekQuiet | null) => {
    from.disabled = to.disabled = !q;
    quietLabel.classList.toggle("is-off", !q);
  };
  quiet.onchange = () => {
    if (quiet.checked && (!from.value || !to.value)) { from.value = DEFAULT_QUIET.from; to.value = DEFAULT_QUIET.to; }
    sendQuiet();
  };
  from.onchange = to.onchange = () => { if (quiet.checked) sendQuiet(); };

  return function paint() {
    const now = prefs();
    for (const { kind, box, row } of boxes) {
      box.checked = now.peeks?.[kind] !== false;
      row.classList.toggle("is-off", !box.checked);
    }
    const q = now.peekQuiet ?? null;
    quiet.checked = !!q;
    from.value = q?.from ?? DEFAULT_QUIET.from;
    to.value = q?.to ?? DEFAULT_QUIET.to;
    paintQuiet(q);
  };
}
