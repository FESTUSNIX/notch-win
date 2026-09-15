/* One helper, used by every screen.
 *
 * ⚠️ This was `task-list.ts`, which also held `renderTaskList` — the grouped,
 * collapsible, checklist-aware renderer the settings window used to draw its
 * task browser with. That browser is gone (the tasks live on the island, which
 * is where you already are when you want them), and what was left was one
 * three-line function in a file named after a list it no longer drew.
 */
export function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); node.className = className; node.textContent = text; return node;
}
