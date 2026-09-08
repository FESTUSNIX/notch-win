export interface ChecklistItem { id: string; title: string; status: number; sortOrder?: number }
export interface Task {
  id: string; projectId: string; title: string; status: number; parentId?: string;
  startDate?: string; dueDate?: string; completedTime?: string; timeZone?: string;
  isAllDay?: boolean; content?: string; desc?: string; items?: ChecklistItem[];
  sortOrder?: number; priority?: number; repeatFlag?: string;
}
export interface Project { id: string; name: string; closed?: boolean; kind?: string }
export interface TaskSnapshot {
  demo?: boolean;
  connected: boolean; tasks: Task[]; projects: Project[]; updatedAt: string | null;
  day: string; error: string | null; historyComplete: boolean;
}
export type TaskView = "today" | "overdue" | "all";
export interface TaskNode { key: string; task: Task; children: TaskNode[]; selected: boolean }
export const emptySnapshot = (): TaskSnapshot => ({ connected: false, tasks: [], projects: [], updatedAt: null, day: "", error: null, historyComplete: false });

export function localDay(date = new Date(), timeZone?: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", ...(timeZone ? { timeZone } : {}) }).formatToParts(date);
  return ["year", "month", "day"].map(k => parts.find(p => p.type === k)!.value).join("-");
}

export function dateDay(value?: string, timeZone?: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  try { return localDay(date, timeZone); } catch { return localDay(date); }
}

export function taskKey(task: Task): string {
  return `${task.projectId}:${task.id}:${task.status === 2 ? task.completedTime || "done" : "open"}`;
}

export function taskForest(tasks: Task[], view: TaskView, today = localDay()): TaskNode[] {
  const unique = new Map<string, Task>();
  for (const task of tasks) {
    if (task.id && task.projectId && task.status !== -1) unique.set(taskKey(task), task);
  }
  const nodes: TaskNode[] = [...unique.values()].map(task => ({ task, key: taskKey(task), children: [], selected: false }));
  const parents = new Map<TaskNode, TaskNode>();
  for (const node of nodes) {
    if (!node.task.parentId) continue;
    const matches = nodes.filter(n => n.task.id === node.task.parentId && n.task.projectId === node.task.projectId);
    const parent = matches.find(n => (n.task.status === 2) === (node.task.status === 2)) ||
      matches.find(n => n.task.status !== 2 && !n.task.repeatFlag);
    if (!parent || parent === node) continue;
    // Malformed external relationships must not recurse forever or hide tasks.
    let cursor: TaskNode | undefined = parent;
    const seen = new Set([node]);
    while (cursor && !seen.has(cursor)) { seen.add(cursor); cursor = parents.get(cursor); }
    if (cursor) continue;
    parents.set(node, parent);
    parent.children.push(node);
  }
  function schedule(node: TaskNode): { start: string | null; end: string | null } {
    const zone = node.task.isAllDay ? node.task.timeZone : undefined;
    const start = dateDay(node.task.startDate, zone);
    const end = dateDay(node.task.dueDate, zone);
    return start || end ? { start: start || end, end: end || start } :
      parents.has(node) ? schedule(parents.get(node)!) : { start: null, end: null };
  }
  for (const node of nodes) {
    const done = node.task.status === 2;
    const { start, end } = schedule(node);
    const doneToday = done && dateDay(node.task.completedTime) === today;
    node.selected = view === "all" ? !done || doneToday : view === "overdue" ?
      !done && !!end && end < today : doneToday || (!done && !!start && !!end && start <= today && end >= today);
  }
  function retain(node: TaskNode): boolean { return node.selected || node.children.some(retain); }
  function sort(list: TaskNode[]) {
    list.sort((a, b) => (a.task.sortOrder || 0) - (b.task.sortOrder || 0) || a.task.title.localeCompare(b.task.title));
    for (const node of list) sort(node.children);
  }
  const roots = nodes.filter(n => !parents.has(n) && retain(n));
  sort(roots);
  return roots;
}

export function progress(nodes: TaskNode[]): { done: number; total: number } {
  let done = 0, total = 0;
  function visit(node: TaskNode) {
    if (node.children.length) { node.children.forEach(visit); return; }
    if (!node.selected) return;
    const items = node.task.items || [];
    if (items.length) {
      total += items.length;
      done += node.task.status === 2 ? items.length : items.filter(i => i.status === 1).length;
    } else { total++; if (node.task.status === 2) done++; }
  }
  nodes.forEach(visit);
  return { done, total };
}

export function visibleNode(node: TaskNode, hideDone: boolean): boolean {
  return (node.selected && (!hideDone || node.task.status !== 2)) || node.children.some(n => visibleNode(n, hideDone));
}
