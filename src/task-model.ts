export interface ChecklistItem { id: string; title: string; status: number; sortOrder?: number }
export interface Task {
  id: string; projectId: string; title: string; status: number; parentId?: string;
  startDate?: string; dueDate?: string; completedTime?: string; timeZone?: string;
  isAllDay?: boolean; content?: string; desc?: string; items?: ChecklistItem[];
  sortOrder?: number; priority?: number; repeatFlag?: string;
}
/** `color` is TickTick's own list colour, passed straight through by collect().
 *  Absent on plenty of lists, so every consumer needs a fallback. */
export interface Project { id: string; name: string; closed?: boolean; kind?: string; color?: string }
export interface TaskSnapshot {
  demo?: boolean;
  connected: boolean; tasks: Task[]; projects: Project[]; updatedAt: string | null;
  day: string; error: string | null; historyComplete: boolean;
}
/** `day` is what the notch panel shows: today's work *and* whatever is late.
 *
 * ⚠️ It is deliberately not what the ring counts. Progress stays on `today`,
 * so a backlog of twelve overdue tasks cannot park the day at 2/15 and make
 * finishing something feel like no progress at all. Late work is listed and
 * badged; it is not scored. */
export type TaskView = "today" | "overdue" | "all" | "day";
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
    const scheduledToday = !done && !!start && !!end && start <= today && end >= today;
    const late = !done && !!end && end < today;
    node.selected = view === "all" ? !done || doneToday : view === "overdue" ? late :
      view === "day" ? doneToday || scheduledToday || late :
      doneToday || scheduledToday;
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

/** The first day of the week `date` falls in.
 *
 * ⚠️ `getDay()` is 0 for SUNDAY. Monday-first is therefore `(day + 6) % 7`
 * days back, never `day - 1` — which is `-1` on a Sunday and walks the week
 * FORWARD into the one that has not happened yet. The Sunday case is the whole
 * reason this is a function with a test rather than a line in two screens.
 *
 * Returned at local midnight, so the caller can add days without a DST hour
 * creeping in.
 */
export function weekStart(date: Date, mondayFirst: boolean): Date {
  const back = mondayFirst ? (date.getDay() + 6) % 7 : date.getDay();
  const first = new Date(date);
  first.setDate(date.getDate() - back);
  first.setHours(0, 0, 0, 0);
  return first;
}

/** How many rows each list holds, keyed on project id.
 *
 * ⚠️ ROOTS, not tasks. The day draws one row per root and folds its subtasks
 * inside it, so counting tasks would put "7" on a chip that reveals three
 * rows — and a count that disagrees with the list it labels is worse than no
 * count, because it is the half of the control you believe.
 *
 * Insertion-ordered, so a caller walking it gets the lists in the order the
 * rows came in rather than by id.
 */
export function listTally(nodes: TaskNode[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const node of nodes) {
    counts.set(node.task.projectId, (counts.get(node.task.projectId) ?? 0) + 1);
  }
  return counts;
}

/** One list's rows, or all of them when `projectId` is empty.
 *
 * ⚠️ Matched on the ROOT only. A subtask lives in its parent's list in every
 * case TickTick allows, and testing each child as well would drop a row whose
 * parent is the thing being looked for.
 */
export function inList(nodes: TaskNode[], projectId: string): TaskNode[] {
  return projectId ? nodes.filter(node => node.task.projectId === projectId) : nodes;
}

export function visibleNode(node: TaskNode, hideDone: boolean): boolean {
  return (node.selected && (!hideDone || node.task.status !== 2)) || node.children.some(n => visibleNode(n, hideDone));
}

/** Identity that survives completion.
 *
 * ⚠️ Not `taskKey`, which folds status in so a reopened task redraws as a new
 * row. Optimistic state has to outlive exactly that transition — it is keyed on
 * the task itself, and only the arriving snapshot clears it. */
export function taskId(task: Pick<Task, "projectId" | "id">): string {
  return `${task.projectId}:${task.id}`;
}

/** How many whole days past its due day a task is, or 0 if it is not late.
 *
 * Days, not hours: the panel says "3d", and a task due last night at 23:00 is
 * one day late all through today rather than flipping to two overnight. */
export function overdueDays(task: Task, today = localDay()): number {
  if (task.status === 2) return 0;
  const zone = task.isAllDay ? task.timeZone : undefined;
  const end = dateDay(task.dueDate, zone) || dateDay(task.startDate, zone);
  if (!end || end >= today) return 0;
  const ms = Date.parse(`${today}T00:00:00Z`) - Date.parse(`${end}T00:00:00Z`);
  return Math.max(1, Math.round(ms / 86400000));
}

/** Every leaf under this node is finished — so the row can leave the day. */
export function nodeDone(node: TaskNode): boolean {
  const { done, total } = progress([node]);
  return total > 0 && done === total;
}
