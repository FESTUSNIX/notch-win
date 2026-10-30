/* Settings → Voice: the wake word (30 Oct, wake.rs) and the microphone every
 * voice turn records from.
 *
 * - The switch, with a lamp beside it that lights when "Jarvis" is heard —
 *   the test — and whose tooltip says whether it is listening or why not.
 * - Sensitivity, three steps.
 * - The microphone: every one plugged in, one row each. ⚠️ A Bluetooth
 *   hands-free one is marked (the warning icon, a tooltip): listening on it
 *   keeps his earbuds in call quality. Nothing is chosen for him.
 * - The Picovoice AccessKey: written to Credential Manager, never read back —
 *   the field only ever shows whether one is saved.
 *
 * Stored in prefs.rs (`wakeWord`, `wakeMic`, `wakeMicName`, `wakeSensitivity`);
 * the key through `wake_key`. task-editor.ts hands it the prefs and the save. */
import { listen } from "@tauri-apps/api/event";
import { call, native, previewBus } from "./task-client";
import { taskIcon } from "./task-icons";
import { tips } from "./tips";
import { wakeTip } from "./wake-rules";

export interface WakePrefs {
  wakeWord?: boolean;
  wakeMic?: string;
  wakeMicName?: string;
  wakeSensitivity?: string;
}
interface Mic { id: string; name: string; isDefault: boolean; handsFree: boolean }
interface Status { listening: boolean; reason: string | null; heardAt: number; problem?: string | null; hasKey?: boolean }

const LEVELS: [string, string][] = [["low", "Low"], ["normal", "Normal"], ["high", "High"]];
/** How long the lamp stays lit after the word. */
const LIT_MS = 2200;

export const WAKE_PANE_HTML = `
  <div><p class="set-label">Wake word</p><div class="set-group">
    <div class="set-row"><div class="set-text mod-row wake-head" id="wake-head"><b>“Jarvis”</b></div>
      <div class="set-ctl"><span class="wake-lamp" id="wake-lamp" data-tip="Off" role="status"></span><input type="checkbox" class="switch" id="wake-on" aria-label="Wake word"></div></div>
    <div class="set-row"><div class="set-text"><b>Sensitivity</b></div>
      <div class="set-ctl"><div class="seg" role="group" aria-label="Sensitivity" id="wake-level">${
        LEVELS.map(([value, text]) => `<button type="button" data-level="${value}" aria-pressed="false">${text}</button>`).join("")
      }</div></div></div>
  </div></div>
  <div><p class="set-label">Microphone</p><div class="set-group" id="wake-mics"></div></div>
  <div><p class="set-label">Picovoice</p><div class="set-group">
    <div class="set-row"><div class="set-text mod-row" id="wake-key-label"><b>AccessKey</b></div>
      <div class="set-ctl"><span class="wake-saved" id="wake-saved" data-tip="Saved in Windows Credential Manager" hidden></span><input id="wake-key" type="password" autocomplete="off" spellcheck="false" maxlength="512" placeholder="console.picovoice.ai"><button type="button" class="set-btn is-accent" id="wake-key-save">Save</button><button type="button" class="set-btn" id="wake-key-remove" hidden>Remove</button></div></div>
  </div></div>`;

export function mountWake(prefs: () => WakePrefs, change: (patch: WakePrefs) => void, say: (text: string, kind?: string) => void): () => void {
  tips();
  const on = document.getElementById("wake-on") as HTMLInputElement;
  const lamp = document.getElementById("wake-lamp")!;
  const head = document.getElementById("wake-head")!;
  const level = document.getElementById("wake-level")!;
  const list = document.getElementById("wake-mics")!;
  const keyInput = document.getElementById("wake-key") as HTMLInputElement;
  const saved = document.getElementById("wake-saved")!;
  const save = document.getElementById("wake-key-save") as HTMLButtonElement;
  const remove = document.getElementById("wake-key-remove") as HTMLButtonElement;
  head.prepend(taskIcon("mic"));
  document.getElementById("wake-key-label")!.prepend(taskIcon("key"));
  saved.append(taskIcon("check"));

  let mics: Mic[] = [];
  let status: Status = { listening: false, reason: "off", heardAt: 0 };
  let litTimer = 0;

  on.onchange = () => { change({ wakeWord: on.checked }); paint(); };
  for (const button of level.querySelectorAll<HTMLButtonElement>("button")) {
    button.onclick = () => { change({ wakeSensitivity: button.dataset.level }); paint(); };
  }

  const paintKey = (has: boolean) => {
    saved.hidden = !has;
    remove.hidden = !has;
    keyInput.placeholder = has ? "••••••••••••" : "console.picovoice.ai";
  };
  save.onclick = async () => {
    const key = keyInput.value.trim();
    if (!key) return;
    try {
      const has = await call<boolean>("wake_key", { key });
      keyInput.value = "";
      paintKey(has);
      say("AccessKey saved");
    } catch (error) { say(String(error), "error"); }
  };
  keyInput.onkeydown = event => { if (event.key === "Enter") save.click(); };
  remove.onclick = async () => {
    try { paintKey(await call<boolean>("wake_key", { key: "" })); } catch (error) { say(String(error), "error"); }
  };

  /* One row per microphone; the chosen one carries the check. ⚠️ A chosen
   * mic that is not plugged in stays on the list, dimmed, so the choice is
   * not silently lost while the USB cable is out. */
  const paintMics = () => {
    const now = prefs();
    const rows: Mic[] = [...mics];
    if (now.wakeMic && !rows.some(m => m.id === now.wakeMic)) {
      rows.push({ id: now.wakeMic, name: now.wakeMicName || "Microphone", isDefault: false, handsFree: false });
    }
    list.replaceChildren(...rows.map(mic => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "set-row wake-mic";
      row.dataset.mic = mic.id;
      const chosen = mic.id === now.wakeMic;
      const away = !mics.some(m => m.id === mic.id);
      row.classList.toggle("is-chosen", chosen);
      row.classList.toggle("is-away", away);
      row.setAttribute("aria-pressed", String(chosen));
      const text = document.createElement("div");
      text.className = "set-text mod-row";
      const name = document.createElement("b");
      name.textContent = mic.name;
      text.append(taskIcon(mic.handsFree ? "buds" : "mic"), name);
      if (mic.handsFree) {
        const warn = document.createElement("span");
        warn.className = "wake-warn";
        warn.dataset.tip = "Keeps your earbuds in call quality";
        warn.append(taskIcon("warn"));
        text.append(warn);
      }
      if (away) text.dataset.tip = "Not plugged in";
      const mark = document.createElement("span");
      mark.className = "wake-pick";
      if (chosen) mark.append(taskIcon("check"));
      row.append(text, mark);
      row.onclick = () => {
        const pick = chosen ? { wakeMic: "", wakeMicName: "" } : { wakeMic: mic.id, wakeMicName: mic.name };
        change(pick);
        paintMics();
      };
      return row;
    }));
    if (!rows.length) {
      const empty = document.createElement("div");
      empty.className = "set-row";
      empty.innerHTML = `<div class="set-text mod-row"><b>No microphone plugged in</b></div>`;
      empty.querySelector(".mod-row")!.prepend(taskIcon("micOff"));
      list.append(empty);
    }
  };

  const paintStatus = () => {
    lamp.dataset.tip = wakeTip(status);
    lamp.classList.toggle("is-listening", status.listening);
  };
  const heard = () => {
    lamp.classList.add("is-heard");
    window.clearTimeout(litTimer);
    litTimer = window.setTimeout(() => lamp.classList.remove("is-heard"), LIT_MS);
  };

  const listenTo = <T>(name: string, run: (payload: T) => void) => native
    ? void listen<T>(name, event => run(event.payload))
    : previewBus.addEventListener(name, event => run((event as CustomEvent<T>).detail));
  listenTo<Status>("wake:state", next => { status = { ...status, ...next }; paintStatus(); });
  listenTo<number>("wake:heard", () => heard());

  void call<Mic[]>("wake_mics").then(list => { mics = list; paintMics(); }).catch(() => paintMics());
  void call<Status>("wake_status").then(next => { status = next; paintKey(!!next.hasKey); paintStatus(); }).catch(() => {});

  function paint() {
    const now = prefs();
    on.checked = now.wakeWord === true;
    head.classList.toggle("is-off", !on.checked);
    const value = now.wakeSensitivity || "normal";
    for (const button of level.querySelectorAll<HTMLButtonElement>("button")) {
      button.setAttribute("aria-pressed", String(button.dataset.level === value));
    }
    paintMics();
    paintStatus();
  }
  return paint;
}
