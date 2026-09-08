import { TaskSurface } from "./task-surface";
import { type Edge } from "./layout";
import { call, native, preview, watchTasks } from "./task-client";
import { emptySnapshot, localDay, progress, taskForest, type TaskSnapshot, type TaskView } from "./task-model";
import { renderTaskList } from "./task-list";
import "./tasks.css";

const app = document.getElementById("task-app")!;
app.innerHTML = `<div id="notch-shell">
  <aside id="task-panel" aria-label="Task list" inert>
    <header class="panel-heading"><div><div class="eyebrow" id="date-label"></div><h1>Today’s focus <span id="daily-count"></span></h1></div><div class="panel-actions"><button id="pin" class="small-icon" aria-label="Pin task panel" aria-pressed="false" title="Keep open">&#8982;</button><button id="surface-settings" class="small-icon" aria-label="Notch settings" aria-expanded="false" title="Notch settings">&#9881;</button><button id="collapse-panel" class="small-icon" aria-label="Collapse task panel" title="Collapse">&#215;</button></div></header>
    <div id="surface-options" hidden><span>Screen edge</span><div class="edge-choices" role="group" aria-label="Screen edge"><button type="button" data-task-edge="left" aria-pressed="false">Left</button><button type="button" data-task-edge="top" aria-pressed="false">Top</button><button type="button" data-task-edge="bottom" aria-pressed="false">Bottom</button><button type="button" data-task-edge="right" aria-pressed="false">Right</button></div><button id="account-settings">TickTick connection &#8599;</button></div><nav class="task-tabs" aria-label="Task view"><button data-view="today" aria-pressed="true">Today</button><button data-view="overdue" aria-pressed="false">Overdue <span id="overdue-count"></span></button><button data-view="all" aria-pressed="false">All lists</button></nav>
    <div id="task-status" role="status"></div><div id="task-list" class="task-list"><div id="task-list-content"></div></div>
    <form id="inline-composer" hidden><input id="inline-title" aria-label="Task name" maxlength="1000" required autocomplete="off" placeholder="What needs doing?"><div class="composer-options"><select id="inline-project" aria-label="Task list" required></select><input id="inline-date" aria-label="Scheduled day" type="date"><button type="button" id="cancel-inline" aria-label="Cancel task entry">&#215;</button><button id="submit-inline" type="submit" aria-label="Save task">&#8593;</button></div></form>
    <footer class="task-footer"><button id="hide-done" aria-pressed="false">Hide completed</button><button id="refresh" aria-label="Refresh tasks">↻</button><button id="add-task" class="accent-button">＋ Add task</button></footer>
    <div class="sync-line" id="sync-line"></div>
  </aside>
  <div id="task-rail"><svg id="rail-shape" aria-hidden="true"><path/></svg><button id="focus-ring" aria-label="Open today's tasks" aria-expanded="false"><svg viewBox="0 0 64 64" aria-hidden="true"><circle class="ring-track" cx="32" cy="32" r="27"/><circle id="ring-progress" cx="32" cy="32" r="27" pathLength="100"/><circle class="target" cx="32" cy="32" r="10"/><circle class="target" cx="32" cy="32" r="5"/><circle class="target-dot" cx="32" cy="32" r="1.5"/></svg><span id="rail-count">—</span><span class="rail-caption">Today</span></button></div>
</div>`;
const get = <T extends HTMLElement>(id:string) => document.getElementById(id) as T;
const rail = get("task-rail"), list = get("task-list-content"), status = get("task-status");
const surface = new TaskSurface();
const composer = get<HTMLFormElement>("inline-composer");
const title = get<HTMLInputElement>("inline-title"), project = get<HTMLSelectElement>("inline-project"), date = get<HTMLInputElement>("inline-date");
let snapshot: TaskSnapshot = emptySnapshot();
let view: TaskView = "today", busy = false, hideDone = false, composing = false;
let actionError = "", day = localDay();
const collapsed = new Set<string>();
date.value = localDay();
async function action(command:string,args:Record<string,unknown>={}):Promise<boolean> {
  if(busy) return false;
  busy=true; actionError=""; render();
  try { await call(command,args); return true; }
  catch(error) { actionError=String(error); return false; }
  finally {busy=false;render();}
}
async function startCompose() {
  if(!snapshot.connected) { await action("open_task_editor"); return; }
  get("surface-options").hidden=true;
  get("surface-settings").setAttribute("aria-expanded","false");
  composing=true; composer.hidden=false; render();
  try {await surface.input(true);title.focus();}
  catch(error) {actionError=String(error);render();}
}
async function endCompose() {
  composing=false; composer.hidden=true;
  await surface.input(false); render();
}
function render() {
  const today = progress(taskForest(snapshot.tasks, "today"));
  const overdue = progress(taskForest(snapshot.tasks, "overdue"));
  const reliable = !!snapshot.updatedAt && snapshot.historyComplete && snapshot.day === localDay();
  const count = reliable ? `${today.done}/${today.total}` : "—";
  document.getElementById("rail-count")!.textContent = count;
  document.getElementById("daily-count")!.textContent = reliable ? count : "";
  document.getElementById("overdue-count")!.textContent = overdue.total ? String(overdue.total) : "";
  document.getElementById("ring-progress")!.style.strokeDasharray = `${reliable && today.total ? today.done / today.total * 100 : 0} 100`;
  rail.classList.toggle("stale", !!snapshot.error);
  document.getElementById("date-label")!.textContent = new Date().toLocaleDateString(undefined, {weekday:"long",month:"short",day:"numeric"});
  status.textContent = actionError || snapshot.error || (busy ? "Syncing with TickTick…" : snapshot.connected && !snapshot.updatedAt ? "Loading TickTick…" :
    snapshot.updatedAt && !snapshot.historyComplete ? "Completion history is partial. Daily progress is unavailable." : "");
  status.classList.toggle("error", !!(actionError || snapshot.error));
  const ago = snapshot.updatedAt ? Math.max(0, Math.floor((Date.now() - new Date(snapshot.updatedAt).getTime()) / 60000)) : null;
  document.getElementById("sync-line")!.textContent = preview ? "Interactive preview · sample tasks" : snapshot.demo ? "Demo · sample tasks · read only" : snapshot.updatedAt ? `TickTick · ${ago ? `${ago} min ago` : "just synced"}` : "TickTick · connect in Tasks settings";
  document.getElementById("add-task")!.textContent = snapshot.connected ? "＋ Add task" : "Connect TickTick";
  document.getElementById("add-task")!.setAttribute("aria-label", snapshot.connected ? "Add task" : "Connect TickTick");
  (document.getElementById("refresh") as HTMLButtonElement).disabled = busy;
  const selected=project.value;
  const projects=snapshot.projects.filter(p=>!p.closed && p.kind!=="NOTE");
  if(project.options.length!==projects.length || projects.some((p,i)=>project.options[i]?.value!==p.id || project.options[i]?.text!==p.name)) {
    project.replaceChildren(...projects.map(p=>new Option(p.name,p.id)));
    if(projects.some(p=>p.id===selected)) project.value=selected;
  }
  composer.querySelectorAll<HTMLInputElement|HTMLButtonElement|HTMLSelectElement>("input,button,select").forEach(el=>el.disabled=busy);
  get<HTMLButtonElement>("submit-inline").disabled=busy || !project.value || !!snapshot.error || (native && !!snapshot.demo);
  get("add-task").hidden=composing;
  renderTaskList(list, snapshot, {view, hideDone, collapsed, disabled:busy || !snapshot.connected || !!snapshot.error || (native && !!snapshot.demo), redraw:render,
    complete: task => action("complete_task", {projectId:task.projectId,taskId:task.id,expectedStart:task.startDate ?? null}),
    check: (task,itemId,done) => action("set_checklist_item", {projectId:task.projectId,taskId:task.id,itemId,done})});
  surface.measure();
}
get("pin").onclick=()=>surface.pin();
get("collapse-panel").onclick=()=>{void surface.collapse();};
get("focus-ring").onclick=()=>{if(surface.open) void surface.collapse(); else surface.show(true);};
get("hide-done").onclick=event=>{hideDone=!hideDone;(event.currentTarget as HTMLElement).setAttribute("aria-pressed",String(hideDone));render();};
get("refresh").onclick=()=>action("refresh_tasks");
get("add-task").onclick=()=>{void startCompose();};
get("cancel-inline").onclick=()=>{void endCompose();};
get("account-settings").onclick=()=>action("open_task_editor");
get("surface-settings").onclick=()=>{const options=get("surface-options");options.hidden=!options.hidden;get("surface-settings").setAttribute("aria-expanded",String(!options.hidden));surface.measure();};
document.querySelectorAll<HTMLButtonElement>("[data-task-edge]").forEach(button=>button.onclick=async()=>{
  const edge=button.dataset.taskEdge as Edge;
  if(await action("set_task_placement",{edge,visible:true,reset:false})) await surface.place(edge);
});
composer.onsubmit=async event=>{
  event.preventDefault(); if(!title.value.trim() || busy) return;
  let scheduled:string|null=null;
  if(date.value) {const [y,m,d]=date.value.split("-").map(Number);scheduled=new Date(y,m-1,d).toISOString();}
  if(await action("create_task",{projectId:project.value,name:title.value,date:scheduled,timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone})) {
    title.value=""; await endCompose();
  } else {title.focus();}
};
composer.addEventListener("pointerdown",event=>{
  if(surface.editing || !(event.target instanceof HTMLElement) || !event.target.matches("input,select")) return;
  const field=event.target; event.preventDefault();
  void surface.input(true).then(()=>field.focus()).catch(error=>{actionError=String(error);render();});
});
window.addEventListener("blur",()=>{void surface.input(false).catch(()=>{});});
document.addEventListener("keydown",event=>{if(event.key==="Escape" && !busy) {event.preventDefault();if(composing) void endCompose();else void surface.collapse();}});
document.querySelectorAll<HTMLButtonElement>("[data-view]").forEach(button => button.onclick = () => {
  view = button.dataset.view as TaskView;
  document.querySelectorAll("[data-view]").forEach(b => b.setAttribute("aria-pressed",String(b === button))); render();
});
let dragStart: {x:number;y:number} | null = null;
let dragged = false;
rail.addEventListener("pointerdown", event => { if (event.button === 0) { dragStart = {x:event.screenX,y:event.screenY}; dragged = false; } });
rail.addEventListener("pointermove", event => {
  if (dragStart && Math.hypot(event.screenX-dragStart.x,event.screenY-dragStart.y)>5) {
    dragStart = null; dragged = true; call("drag_begin").catch(() => {});
  }
});
window.addEventListener("pointerup", () => { dragStart = null; });
rail.addEventListener("click", event => { if (dragged) { event.preventDefault(); event.stopImmediatePropagation(); dragged = false; } }, true);
async function boot() {
  await surface.boot();
  await watchTasks(value=>{snapshot=value;render();});
  render();
  window.setInterval(()=>{if(day!==localDay()){day=localDay();void call("refresh_tasks").catch(()=>{});}render();},60000);
}
boot().catch(error=>{status.textContent=String(error);surface.show(true);});
