import { getCurrentWindow } from "@tauri-apps/api/window";
import { call, native, preview, watchTasks } from "./task-client";
import { emptySnapshot, localDay, type Task, type TaskView } from "./task-model";
import { renderTaskList, element } from "./task-list";
import "./tasks.css";

document.body.className = "editor-page";
document.getElementById("task-editor")!.innerHTML = `<main class="editor-wrap">
  <header><div><div class="eyebrow">CODENOTCH</div><h1>Your tasks</h1></div><button id="close-editor" aria-label="Close task editor">×</button></header>
  <div id="editor-status" role="status"></div>
  <section class="settings-section"><h2>TickTick connection</h2><p class="hint" id="connection-state">Connect your existing account. Your tasks stay in TickTick.</p>
    <details id="connection-details"><summary>Connect or replace token</summary><form id="connect-form">
      <p class="hint">In TickTick on the web, open Settings → Account → API Token. Create a token and paste it here.</p>
      <label class="field">API token<input id="token" type="password" autocomplete="off" spellcheck="false" maxlength="2500" required placeholder="Paste your TickTick token"></label>
      <div class="button-row"><button class="primary" type="submit">Connect TickTick</button><button class="secondary" id="disconnect" type="button">Disconnect</button></div>
      <p class="hint" style="margin-top:10px">Saved in Windows Credential Manager on this PC.</p>
    </form></details>
  </section>
  <section class="settings-section" id="capture"><h2 id="capture-heading">Quick add</h2><form id="task-form">
    <label class="field">Task<input id="task-title" maxlength="1000" required placeholder="What would you like to get done?" autocomplete="off"></label>
    <div class="form-row" id="schedule-fields"><label class="field">List<select id="project" required></select></label><label class="field">Scheduled day<input id="task-date" type="date"></label></div>
    <div class="button-row"><button class="primary" type="submit" id="save-task">Add task</button><button id="cancel-edit" class="secondary" type="button" hidden>Cancel rename</button></div>
    <p class="hint" id="list-scope" style="margin-top:10px">Lists exposed by TickTick’s API. Leave the date empty for an unscheduled task.</p>
  </form></section>
  <details class="settings-section"><summary>Notch position &amp; visibility</summary>
    <label class="toggle-label"><input type="checkbox" id="notch-visible" checked>Show task notch</label>
    <label class="field">Screen edge<select id="task-edge"><option value="left">Left</option><option value="right">Right</option><option value="top">Top</option><option value="bottom">Bottom</option></select></label>
    <button type="button" id="reset-task-position" class="secondary">Reset task position</button>
    <p class="hint" style="margin-top:10px">Drag the task ring along its edge.</p>
  </details>
  <section><div class="button-row"><h2 style="margin:0;flex:1">Your lists</h2><button id="refresh-editor">↻ Refresh</button></div>
    <nav class="task-tabs" aria-label="Task view"><button data-view="today" aria-pressed="true">Today</button><button data-view="overdue" aria-pressed="false">Overdue</button><button data-view="all" aria-pressed="false">All lists</button></nav>
    <div id="editor-list" class="task-list"></div>
  </section>
</main>`;
const get = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = get("editor-status");
const token = get<HTMLInputElement>("token");
const name = get<HTMLInputElement>("task-title");
const date = get<HTMLInputElement>("task-date");
const project = get<HTMLSelectElement>("project");
const visible = get<HTMLInputElement>("notch-visible");
const edge = get<HTMLSelectElement>("task-edge");
let snapshot = emptySnapshot(), busy = false, message = "", view: TaskView = "today";
let editing: Task | null = null;
const collapsed = new Set<string>();
date.value = localDay();

function render() {
  status.textContent = message || snapshot.error || (busy ? "Syncing with TickTick…" : preview ? "Interactive preview · sample tasks. Connect in the desktop app." : "");
  status.classList.toggle("error-message", !!(message || snapshot.error));
  get("connection-state").textContent = snapshot.demo ? "Sample tasks · no TickTick account connected" : snapshot.connected ? `Connected to TickTick${snapshot.updatedAt ? ` · synced ${new Date(snapshot.updatedAt).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"})}` : " · loading…"}` : "Connect your existing account. Your tasks stay in TickTick.";
  const selected = project.value;
  project.replaceChildren();
  for (const p of snapshot.projects.filter(p => !p.closed && p.kind !== "NOTE")) {
    const option = element("option", "", p.name); option.value = p.id; project.append(option);
  }
  if ([...project.options].some(p => p.value === selected)) project.value = selected;
  get("capture").hidden = !snapshot.connected;
  get<HTMLButtonElement>("disconnect").disabled = busy || !snapshot.connected;
  document.querySelectorAll<HTMLButtonElement>("form button, #refresh-editor").forEach(b => b.disabled = busy);
  document.querySelectorAll<HTMLInputElement>("form input").forEach(input => input.disabled = busy);
  project.disabled = busy || !!editing;
  date.disabled = busy || !!editing;
  get<HTMLButtonElement>("save-task").disabled = busy || (!editing && !project.value) || !!snapshot.error;
  get("list-scope").textContent = project.options.length ? "Lists exposed by TickTick’s API. Leave the date empty for an unscheduled task." : "No task lists returned by TickTick. Create a regular task list in TickTick, then refresh.";
  renderTaskList(get("editor-list"), snapshot, {view,hideDone:false,collapsed,disabled:busy || !!snapshot.error,redraw:render,
    complete:t => action("complete_task",{projectId:t.projectId,taskId:t.id,expectedStart:t.startDate ?? null}),
    check:(t,itemId,done) => action("set_checklist_item",{projectId:t.projectId,taskId:t.id,itemId,done}),
    edit:t => { editing = t; name.value = t.title; get("capture-heading").textContent = "Rename task"; get("save-task").textContent = "Save name"; get("cancel-edit").hidden = false; get("schedule-fields").hidden = true; name.focus(); name.scrollIntoView({block:"center"}); render(); }
  });
}
async function action(command: string, args: Record<string, unknown> = {}): Promise<boolean> {
  if (busy) return false;
  busy = true; message = ""; render();
  try { await call(command, args); return true; } catch(error) { message = String(error); return false; }
  finally { busy = false; render(); }
}
function cancelEdit() {
  editing = null; name.value = ""; get("capture-heading").textContent = "Quick add"; get("save-task").textContent = "Add task";
  get("cancel-edit").hidden = true; get("schedule-fields").hidden = false; render();
}
get("cancel-edit").onclick = cancelEdit;
get("connect-form").onsubmit = async e => {
  e.preventDefault();
  const value = token.value; token.value = "";
  if (await action("connect_ticktick",{token:value})) { cancelEdit(); get<HTMLDetailsElement>("connection-details").open = false; }
};
get("disconnect").onclick = async () => {
  if (await action("disconnect_ticktick")) { cancelEdit(); get<HTMLDetailsElement>("connection-details").open = true; }
};
get("task-form").onsubmit = async e => {
  e.preventDefault();
  if (!name.value.trim()) return;
  if (editing) {
    if (await action("rename_task",{projectId:editing.projectId,taskId:editing.id,name:name.value})) cancelEdit();
  } else {
    let scheduled: string | null = null;
    if (date.value) {
      const [y,m,d] = date.value.split("-").map(Number);
      scheduled = new Date(y,m-1,d).toISOString();
    }
    if (await action("create_task",{projectId:project.value,name:name.value,date:scheduled,timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone})) name.value = "";
  }
};
async function setPlacement(reset = false) {
  if (!await action("set_task_placement",{edge:edge.value,visible:visible.checked,reset})) {
    const current = await call<{edge:string;visible:boolean}>("get_task_placement"); edge.value = current.edge; visible.checked = current.visible;
  }
}
visible.onchange = () => setPlacement(); edge.onchange = () => setPlacement();
get("reset-task-position").onclick = () => setPlacement(true);
get("refresh-editor").onclick = () => action("refresh_tasks");
get("close-editor").onclick = () => { if (native) getCurrentWindow().close(); else window.close(); };
document.addEventListener("keydown", e => { if (e.key === "Escape") { if (editing) cancelEdit(); else if (native) getCurrentWindow().close(); } });
document.querySelectorAll<HTMLButtonElement>("[data-view]").forEach(button => button.onclick = () => {
  view = button.dataset.view as TaskView; document.querySelectorAll("[data-view]").forEach(b => b.setAttribute("aria-pressed", String(b === button))); render();
});
async function boot() {
  await watchTasks(value => { snapshot = value; render(); });
  get<HTMLDetailsElement>("connection-details").open = !snapshot.connected;
  const placement = await call<{edge:string;visible:boolean}>("get_task_placement");
  edge.value = placement.edge; visible.checked = placement.visible;
}
boot().catch(e => { message = String(e); render(); });
