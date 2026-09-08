import { paintIcon } from "./task-icons";
import { FocusTimer, timerText } from "./focus-timer";
import { TaskSurface } from "./task-surface";
import { type Edge } from "./layout";
import { call, native, preview, watchTasks } from "./task-client";
import {
  emptySnapshot, localDay, progress, taskForest, taskId,
  type Task, type TaskSnapshot, type TaskView,
} from "./task-model";
import { renderDay } from "./task-day";
import "./tasks.css";

const app = document.getElementById("task-app")!;
app.innerHTML = `<div id="notch-shell">
  <aside id="task-panel" aria-label="Task list" inert>
    <header class="day-head">
      <div class="day-top"><h1 id="day-title">Today</h1><div class="panel-actions"><button id="pin" class="small-icon" aria-label="Pin task panel" aria-pressed="false" title="Keep open">&#8982;</button><button id="surface-settings" class="small-icon" aria-label="Notch settings" aria-expanded="false" title="Notch settings">&#9881;</button><button id="collapse-panel" class="small-icon" aria-label="Collapse task panel" title="Collapse">&#215;</button></div></div>
      <div class="day-meta"><span id="day-date"></span><span id="day-left"></span></div>
      <div class="day-rail"><i id="day-rail-fill"></i></div>
    </header>
    <div id="surface-options" hidden><span>Screen edge</span><div class="edge-choices" role="group" aria-label="Screen edge"><button type="button" data-task-edge="left" aria-pressed="false">Left</button><button type="button" data-task-edge="top" aria-pressed="false">Top</button><button type="button" data-task-edge="bottom" aria-pressed="false">Bottom</button><button type="button" data-task-edge="right" aria-pressed="false">Right</button></div><span>Showing</span><div class="edge-choices" role="group" aria-label="Task view"><button type="button" data-view="day" aria-pressed="true">Today</button><button type="button" data-view="all" aria-pressed="false">All lists</button></div><button id="account-settings">TickTick connection &#8599;</button></div>
    <section id="focus-session" hidden><div id="focus-task-title"></div><div class="focus-controls"><time id="focus-elapsed" title="Elapsed focus time">00:00</time><button id="focus-others" aria-label="Show other tasks" title="Show other tasks" aria-expanded="false"></button><button id="focus-pause" aria-label="Pause focus timer" title="Pause"></button><button id="focus-end" aria-label="End focus session" title="End session"></button><button id="focus-finish" aria-label="Complete focused task" title="Complete task"></button></div><span id="focus-state" class="sr-only"></span></section>
    <div id="task-status" role="status"></div>
    <div id="task-list" class="task-list"><div id="task-list-content"></div><div id="task-done"></div></div>
    <form id="inline-composer"><span class="plus" aria-hidden="true">&#43;</span><input id="inline-title" aria-label="Task name" maxlength="1000" required autocomplete="off" placeholder="Add a task"><span class="enter-hint" aria-hidden="true">&#8629;</span><button type="button" id="composer-options" class="small-icon" aria-label="Task list and day" aria-expanded="false" title="List and day">&#8964;</button></form>
    <div id="composer-fields" hidden><select id="inline-project" aria-label="Task list" required></select><input id="inline-date" aria-label="Scheduled day" type="date"></div>
    <footer class="task-footer"><button id="sync-line" aria-label="Refresh tasks"></button></footer>
  </aside>
  <div id="task-rail"><button id="focus-pill" aria-label="Open focus timer"><span class="pill-track" aria-hidden="true"><i id="pill-fill"></i></span></button><svg id="rail-shape" aria-hidden="true"><path/></svg><button id="focus-ring" aria-label="Open today's tasks" aria-expanded="false"><svg viewBox="0 0 64 64" aria-hidden="true"><circle class="ring-track" cx="32" cy="32" r="27"/><circle id="ring-progress" cx="32" cy="32" r="27" pathLength="100"/><circle class="target" cx="32" cy="32" r="10"/><circle class="target" cx="32" cy="32" r="5"/><circle class="target-dot" cx="32" cy="32" r="1.5"/></svg><span id="rail-count">—</span><span class="rail-caption">Today</span></button></div>
</div>`;

const get = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const rail = get("task-rail"), list = get("task-list-content"), doneTarget = get("task-done"), status = get("task-status");
const surface = new TaskSurface();
paintIcon(get("pin"),"pin");paintIcon(get("surface-settings"),"settings");paintIcon(get("collapse-panel"),"close");
paintIcon(get("composer-options"),"down");paintIcon(document.querySelector("#inline-composer .plus") as HTMLElement,"plus");
paintIcon(get("focus-others"),"list");paintIcon(get("focus-end"),"stop");paintIcon(get("focus-finish"),"check");
const composer = get<HTMLFormElement>("inline-composer");
const title = get<HTMLInputElement>("inline-title"), project = get<HTMLSelectElement>("inline-project"), date = get<HTMLInputElement>("inline-date");

let snapshot: TaskSnapshot = emptySnapshot();
let view: TaskView = "day", busy = false;
let actionError = "", day = localDay();

/* ── Optimistic state ─────────────────────────────────────────────────────
 * TickTick is still authoritative; it is just no longer in the loop between a
 * click and what the click looks like. complete_task holds a server-side gate
 * for a write *and* a full re-poll of every list, so waiting for it meant the
 * app's primary action took hundreds of milliseconds to show anything.
 *
 * ⚠️ Each map is cleared by the arriving snapshot agreeing, never by the call
 * returning. The write's own refresh can land before the mutation resolves, and
 * clearing on resolve would blink the row back to its old state in between. */
const pendingStatus = new Map<string, number>();
const pendingItems = new Map<string, Map<string, number>>();
const pendingNames = new Map<string, string>();
/** Finished and still on screen, so the tick has somewhere to be seen. */
const settling = new Set<string>();
/** One render further on: rendered open, then collapsed on the next frame. */
const leaving = new Set<string>();
const expanded = new Set<string>();
const collapsed = new Set<string>();
const outbox: { id: string; title: string }[] = [];
let editing: string | null = null;
let editCaret: number | null = null;
let doneOpen = false;
let othersOpen=false;
const focusTimer=new FocusTimer(()=>{othersOpen=false;render();});
get("focus-pill").onclick=()=>surface.show(true);
get("focus-pause").onclick=()=>focusTimer.toggle();
get("focus-end").onclick=()=>focusTimer.stop();
get("focus-others").onclick=()=>{othersOpen=!othersOpen;render();};
get("focus-finish").onclick=()=>{const s=focusTimer.session;const task=snapshot.tasks.find(t=>t.id===s?.id && t.projectId===s.projectId);if(task)complete(task);};

const reduced = matchMedia("(prefers-reduced-motion: reduce)");
/** How long a finished row is held before it leaves, and how long it takes. */
const HOLD = () => (reduced.matches ? 0 : 520);
const COLLAPSE = () => (reduced.matches ? 0 : 340);

/** The snapshot as the person in front of it believes it to be. */
function local(source: TaskSnapshot): TaskSnapshot {
  if (!pendingStatus.size && !pendingItems.size && !pendingNames.size) return source;
  const now = new Date().toISOString();
  return { ...source, tasks: source.tasks.map(task => {
    const key = taskId(task);
    const status = pendingStatus.get(key);
    const items = pendingItems.get(key);
    const name = pendingNames.get(key);
    if (status === undefined && !items && name === undefined) return task;
    return {
      ...task,
      ...(name !== undefined ? { title: name } : {}),
      ...(status !== undefined
        ? { status, completedTime: status === 2 ? task.completedTime || now : undefined }
        : {}),
      ...(items && task.items
        ? { items: task.items.map(i => (items.has(i.id) ? { ...i, status: items.get(i.id)! } : i)) }
        : {}),
    };
  }) };
}

/** Drop every optimistic entry the server has now confirmed. */
function reconcile(next: TaskSnapshot) {
  for (const [key, status] of [...pendingStatus]) {
    if (next.tasks.some(t => taskId(t) === key && t.status === status)) pendingStatus.delete(key);
  }
  for (const [key, name] of [...pendingNames]) {
    if (next.tasks.some(t => taskId(t) === key && t.title === name)) pendingNames.delete(key);
  }
  for (const [key, wanted] of [...pendingItems]) {
    const task = next.tasks.find(t => taskId(t) === key);
    if (!task?.items) continue;
    for (const [id, status] of [...wanted]) {
      if (task.items.some(i => i.id === id && i.status === status)) wanted.delete(id);
    }
    if (!wanted.size) pendingItems.delete(key);
  }
}

/** A write that never blocks the list. Failure puts the row back and says why. */
async function mutate(command: string, args: Record<string, unknown>, revert: () => void) {
  actionError = "";
  render();
  try { await call(command, args); }
  catch (error) { revert(); actionError = String(error); }
  finally { render(); }
}

/** Commands that genuinely have nothing to show until they return. */
async function action(command: string, args: Record<string, unknown> = {}): Promise<boolean> {
  if (busy) return false;
  busy = true; actionError = ""; render();
  try { await call(command, args); return true; }
  catch (error) { actionError = String(error); return false; }
  finally { busy = false; render(); }
}

function complete(task: Task) {
  const key = taskId(task);
  if (pendingStatus.get(key) === 2) return;
  const clear = () => { pendingStatus.delete(key); settling.delete(key); leaving.delete(key); };
  pendingStatus.set(key, 2);
  settling.add(key);
  render();
  window.setTimeout(() => {
    if (!settling.delete(key)) return;      // already reverted by a failed write
    leaving.add(key);
    render();
    window.setTimeout(() => { leaving.delete(key); render(); }, COLLAPSE());
  }, HOLD());
  void mutate("complete_task", { projectId: task.projectId, taskId: task.id, expectedStart: task.startDate ?? null }, clear);
}

function checkItem(task: Task, itemId: string, done: boolean) {
  const key = taskId(task);
  const wanted = pendingItems.get(key) || new Map<string, number>();
  wanted.set(itemId, done ? 1 : 0);
  pendingItems.set(key, wanted);
  void mutate("set_checklist_item", { projectId: task.projectId, taskId: task.id, itemId, done }, () => {
    wanted.delete(itemId);
    if (!wanted.size) pendingItems.delete(key);
  });
}

function rename(task: Task, name: string) {
  const key = taskId(task);
  pendingNames.set(key, name);
  void mutate("rename_task", { projectId: task.projectId, taskId: task.id, name }, () => pendingNames.delete(key));
}

function render() {
  const shown = local(snapshot);
  const session=focusTimer.session;
  get("focus-session").hidden=!session;
  get("focus-others").hidden=!session;
  get("task-list").hidden=!!session&&!othersOpen;
  get("focus-others").setAttribute("aria-label",othersOpen?"Hide other tasks":"Show other tasks");
  get("focus-others").title=othersOpen?"Hide other tasks":"Show other tasks";
  get("focus-others").setAttribute("aria-expanded",String(othersOpen));
  surface.setTiming(!!session);
  if(session) {
    const task=shown.tasks.find(t=>t.id===session.id && t.projectId===session.projectId);
    get("focus-task-title").textContent=task?.title||session.title;
    get<HTMLButtonElement>("focus-finish").disabled=!task || task.status===2 || !shown.connected || !!shown.error || (native&&!!shown.demo) || shown.tasks.some(t=>t.parentId===task.id && t.projectId===task.projectId);
  }
  paintTimer();
  // ⚠️ Progress is `today`, never `day`. Overdue work is listed and badged but
  // not scored — a backlog must not hold the ring at 2/15 all week.
  const today = progress(taskForest(shown.tasks, "today"));
  const reliable = !!shown.updatedAt && shown.historyComplete && shown.day === localDay();
  const count = reliable ? `${today.done}/${today.total}` : "—";
  const percent = reliable && today.total ? (today.done / today.total) * 100 : 0;

  get("rail-count").textContent = count;
  get("ring-progress").style.strokeDasharray = `${percent} 100`;
  get("day-rail-fill").style.width = `${percent}%`;
  get("day-title").textContent = view === "all" ? "All lists" : "Today";
  get("day-date").textContent = new Date().toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
  get("day-left").textContent = !reliable ? ""
    : today.total === 0 ? "nothing scheduled"
    : today.done === today.total ? "all done"
    : `${today.total - today.done} left`;
  rail.classList.toggle("stale", !!shown.error);

  status.textContent = actionError || shown.error || (shown.connected && !shown.updatedAt ? "Loading TickTick…" :
    shown.updatedAt && !shown.historyComplete ? "Completion history is partial. Daily progress is unavailable." : "");
  status.classList.toggle("error", !!(actionError || shown.error));

  const ago = shown.updatedAt ? Math.max(0, Math.floor((Date.now() - new Date(shown.updatedAt).getTime()) / 60000)) : null;
  get("sync-line").textContent = preview ? "Interactive preview · sample tasks" : shown.demo ? "Demo · sample tasks · read only" :
    busy ? "Syncing with TickTick…" : shown.updatedAt ? `TickTick · ${ago ? `${ago} min ago` : "just synced"}` : "TickTick · connect in settings";
  get<HTMLButtonElement>("sync-line").disabled = busy;

  const selected = project.value;
  const projects = shown.projects.filter(p => !p.closed && p.kind !== "NOTE");
  if (project.options.length !== projects.length || projects.some((p, i) => project.options[i]?.value !== p.id || project.options[i]?.text !== p.name)) {
    project.replaceChildren(...projects.map(p => new Option(p.name, p.id)));
    if (projects.some(p => p.id === selected)) project.value = selected;
  }

  const frozen = busy || !shown.connected || !!shown.error || (native && !!shown.demo);
  title.disabled = frozen;
  title.placeholder = shown.connected ? "Add a task" : "Connect TickTick in settings";

  renderDay(list, doneTarget, shown, {
    focus:task=>focusTimer.start(task), focused:session?session.projectId+":"+session.id:undefined,
    view, disabled: frozen, settling, leaving, expanded, collapsed, editing, editCaret, doneOpen, outbox,
    redraw: render, complete, check: checkItem, rename,
    connect: () => { void action("open_task_editor"); },
    setEditing: key => { editing = key; editCaret = null; render(); },
    setDoneOpen: open => { doneOpen = open; render(); },
  });
  surface.measure();
}

/* ── Controls ──────────────────────────────────────────────────────────── */
get("pin").onclick = () => surface.pin();
get("collapse-panel").onclick = () => { void surface.collapse(); };
get("focus-ring").onclick = () => { if (surface.open) void surface.collapse(); else surface.show(true); };
get("sync-line").onclick = () => action("refresh_tasks");
get("account-settings").onclick = () => action("open_task_editor");
get("surface-settings").onclick = () => {
  const options = get("surface-options");
  options.hidden = !options.hidden;
  get("surface-settings").setAttribute("aria-expanded", String(!options.hidden));
  surface.measure();
};
get("composer-options").onclick = () => {
  const fields = get("composer-fields");
  fields.hidden = !fields.hidden;
  get("composer-options").setAttribute("aria-expanded", String(!fields.hidden));
  surface.measure();
};
document.querySelectorAll<HTMLButtonElement>("[data-task-edge]").forEach(button => button.onclick = async () => {
  const edge = button.dataset.taskEdge as Edge;
  if (await action("set_task_placement", { edge, visible: true, reset: false })) await surface.place(edge);
});
document.querySelectorAll<HTMLButtonElement>("[data-view]").forEach(button => button.onclick = () => {
  view = button.dataset.view as TaskView;
  document.querySelectorAll("[data-view]").forEach(b => b.setAttribute("aria-pressed", String(b === button)));
  render();
});

/* ── The composer ──────────────────────────────────────────────────────────
 * A live field at all times, never a button that becomes one, and it lives
 * outside #task-list-content so a redraw cannot destroy what is half-typed.
 *
 * ⚠️ It still costs one click. The notch runs WS_EX_NOACTIVATE so it never
 * steals focus from the window being worked in; set_task_input lifts that only
 * while a field is live. A keystroke cannot reach a window that is not focused,
 * so one click is the floor — what changed is that the click lands in the
 * field rather than on a button that then produces one. */
composer.onsubmit = async event => {
  event.preventDefault();
  const value = title.value.trim();
  if (!value || busy || title.disabled) return;
  if (!project.value) { actionError = "Choose a list first."; get("composer-fields").hidden = false; render(); return; }
  let scheduled: string | null = null;
  if (date.value) { const [y, m, d] = date.value.split("-").map(Number); scheduled = new Date(y, m - 1, d).toISOString(); }

  const ticket = { id: `${Date.now()}`, title: value };
  outbox.push(ticket);
  title.value = "";
  actionError = "";
  render();
  title.focus();   // stays open: the next task is typed, not clicked into

  try {
    await call("create_task", { projectId: project.value, name: value, date: scheduled, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
  } catch (error) {
    actionError = String(error);
    // Hand the words back rather than losing them to a failed write.
    if (!title.value) title.value = value;
  } finally {
    outbox.splice(outbox.indexOf(ticket), 1);
    render();
  }
};
// Focusing a field in a NOACTIVATE window needs the exception lifted first.
composer.addEventListener("pointerdown", event => {
  if (surface.editing || !(event.target instanceof HTMLElement)) return;
  const field = event.target.closest("input,select") as HTMLElement | null ?? title;
  if (field === get("composer-options")) return;
  event.preventDefault();
  void surface.input(true).then(() => field.focus()).catch(error => { actionError = String(error); render(); });
});
get("composer-fields").addEventListener("pointerdown", event => {
  if (surface.editing || !(event.target instanceof HTMLElement) || !event.target.matches("input,select")) return;
  const field = event.target;
  event.preventDefault();
  void surface.input(true).then(() => field.focus()).catch(error => { actionError = String(error); render(); });
});
// Renaming in place needs the same exception, and it starts from a click on the title.
list.addEventListener("pointerdown", event => {
  if (surface.editing || !(event.target instanceof HTMLElement) || !event.target.closest(".task-title")) return;
  void surface.input(true).catch(() => {});
});

window.addEventListener("blur", () => { void surface.input(false).catch(() => {}); });
document.addEventListener("keydown", event => {
  if (event.key !== "Escape" || busy) return;
  event.preventDefault();
  // ⚠️ Escape releases the field before it collapses anything, and never clears
  // it. The composer is permanent, so what is typed into it is a draft — the
  // panel folding is not a reason to throw it away, and pressing Escape again
  // is a cheap way to say you meant the panel.
  if (document.activeElement === title) { title.blur(); void surface.input(false).catch(() => {}); return; }
  void surface.collapse();
});

/* ── Dragging the rail ─────────────────────────────────────────────────── */
let dragStart: { x: number; y: number } | null = null;
let dragged = false;
rail.addEventListener("pointerdown", event => { if (event.button === 0) { dragStart = { x: event.screenX, y: event.screenY }; dragged = false; } });
rail.addEventListener("pointermove", event => {
  if (dragStart && Math.hypot(event.screenX - dragStart.x, event.screenY - dragStart.y) > 5) {
    dragStart = null; dragged = true; call("drag_begin").catch(() => {});
  }
});
window.addEventListener("pointerup", () => { dragStart = null; });
rail.addEventListener("click", event => { if (dragged) { event.preventDefault(); event.stopImmediatePropagation(); dragged = false; } }, true);

function paintTimer() {
  const s=focusTimer.session,seconds=focusTimer.seconds(),text=timerText(seconds),paused=s?.startedAt===null;
  get("focus-elapsed").textContent=text;
  get("notch-shell").style.setProperty("--focus-progress",String(Math.min(1,seconds/1500)));
  get("notch-shell").classList.toggle("focus-paused",!!s&&paused);
  get("notch-shell").classList.toggle("focus-break",!!s&&seconds>=1500);

  get("focus-state").textContent=paused?"Paused":seconds>=1500?"25 minutes reached - take a breath":"Focusing";
  paintIcon(get("focus-pause"),paused?"play":"pause");
  get("focus-pause").title=paused?"Resume":"Pause";
  get("focus-pause").setAttribute("aria-label",paused?"Resume focus timer":"Pause focus timer");
  get("focus-pill").setAttribute("aria-label","Open focus timer, "+text+" elapsed"+(paused?", paused":""));
  get("focus-elapsed").title=seconds>=1500?"25 minutes reached - take a break when ready":"Elapsed focus time";
}
window.setInterval(paintTimer,1000);
async function boot() {
  date.value = localDay();
  await surface.boot();
  await watchTasks(value => { reconcile(value); snapshot = value; const f=focusTimer.session; if(f && (!value.connected || (value.updatedAt && !value.error && value.tasks.some(t=>t.id===f.id && t.projectId===f.projectId && t.status===2) && !value.tasks.some(t=>t.id===f.id && t.projectId===f.projectId && t.status!==2)))) focusTimer.stop(); render(); });
  render();
  window.setInterval(() => {
    if (day !== localDay()) { day = localDay(); date.value = day; void call("refresh_tasks").catch(() => {}); }
    render();
  }, 60000);
}
boot().catch(error => { status.textContent = String(error); surface.show(true); });
