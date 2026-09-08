import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { emptySnapshot, localDay, type TaskSnapshot } from "./task-model";
import fixture from "./task-demo.json";

export const native = isTauri();
export const preview = !native;
const sample = (): TaskSnapshot => JSON.parse(JSON.stringify(fixture).replaceAll("$today", localDay()).replaceAll("$now", new Date().toISOString()));
let demo = new URLSearchParams(location.search).has("empty") ? emptySnapshot() : sample();
if(new URLSearchParams(location.search).has("single")) demo.tasks=demo.tasks.filter(t=>t.title==="Get outside for a walk");
const listeners = new Set<(value: TaskSnapshot) => void>();
const emit = () => listeners.forEach(fn => fn(structuredClone(demo)));

export async function call<T = void>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  if (native) return invoke<T>(command, args);
  if (command === "get_tasks") return structuredClone(demo) as T;
  if (command === "get_task_placement") return {edge:"right",visible:true} as T;
  if (command === "open_task_editor") { window.open("/task-editor.html", "task-editor"); return undefined as T; }
  if (command === "connect_ticktick") throw new Error("Connect TickTick in the desktop app. This is sample data.");
  if (command === "disconnect_ticktick") { demo = emptySnapshot(); emit(); return undefined as T; }
  const task = demo.tasks.find(t => t.id === args.taskId && t.projectId === args.projectId);
  if (command === "complete_task" && task) { task.status = 2; task.completedTime = new Date().toISOString(); }
  if (command === "set_checklist_item" && task) {
    const item = task.items?.find(i => i.id === args.itemId);
    if (item) item.status = args.done ? 1 : 0;
  }
  if (command === "rename_task" && task) task.title = String(args.name);
  if (command === "create_task") demo.tasks.push({id:crypto.randomUUID(),projectId:String(args.projectId),title:String(args.name),status:0,startDate:args.date as string|undefined});
  if (["complete_task","set_checklist_item","rename_task","create_task","refresh_tasks"].includes(command)) emit();
  return undefined as T;
}

export async function watchTasks(fn: (value: TaskSnapshot) => void): Promise<() => void> {
  // Listen first, then get: both sides of the boot race are covered.
  let receivedEvent = false;
  const receive = (value: TaskSnapshot) => { receivedEvent = true; fn(value); };
  const off = native ? await listen<TaskSnapshot>("tasks:changed", event => receive(event.payload)) : (() => { listeners.add(receive); return () => { listeners.delete(receive); }; })();
  const initial = await call<TaskSnapshot>("get_tasks");
  if (!receivedEvent) fn(initial);
  return off;
}
