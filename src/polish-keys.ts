/* Right Alt and a letter types the Polish letter in the app's own fields, whatever
 * keyboard layout Windows has given the webview.
 *
 * Windows keeps a layout per thread. The island's text goes through the webview's
 * own process, which isn't what Windows switches when he changes language in the app
 * in front, so its layout can sit on US while everything else is on Polish (seen on
 * his machine, 4 Nov) and Right Alt + A then types nothing. Handling the key here
 * makes it independent of that, and of which way round the two are.
 *
 * Right Alt only. Left Alt stays what the shortcuts use (Alt+W, Alt+Q).
 */

const LETTERS: Record<string, string> = {
  KeyA: "ą", KeyC: "ć", KeyE: "ę", KeyL: "ł", KeyN: "ń", KeyO: "ó", KeyS: "ś", KeyX: "ź", KeyZ: "ż",
};

/** The letter for a key pressed with Right Alt, or null. */
export function polishLetter(code: string, upper: boolean): string | null {
  const letter = LETTERS[code];
  if (!letter) return null;
  return upper ? letter.toUpperCase() : letter;
}

const TEXT_TYPES = new Set(["text", "search", "email", "url", "tel", "password", ""]);

function takesText(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement) return !target.readOnly && !target.disabled;
  return target instanceof HTMLInputElement && TEXT_TYPES.has(target.type) && !target.readOnly && !target.disabled;
}

/** Put it at the caret as if typed, so undo and every field's `input` listener hold. */
function insert(target: HTMLElement, text: string) {
  if (document.execCommand("insertText", false, text)) return;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    const from = target.selectionStart ?? target.value.length;
    target.setRangeText(text, from, target.selectionEnd ?? from, "end");
    target.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
  }
}

/** Once per page, before anything else hears the keys. */
export function installPolishKeys() {
  let rightAlt = false;
  window.addEventListener("keydown", event => {
    if (event.code === "AltRight") { rightAlt = true; return; }
    if (!rightAlt || event.isComposing || !takesText(event.target)) return;
    const upper = event.shiftKey !== event.getModifierState("CapsLock");
    const letter = polishLetter(event.code, upper);
    if (!letter) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    insert(event.target as HTMLElement, letter);
  }, true);
  window.addEventListener("keyup", event => {
    if (event.code === "AltRight") rightAlt = false;
  }, true);
  // Let go somewhere else: the page never hears the key come up.
  window.addEventListener("blur", () => { rightAlt = false; });
}
