import { progress, taskForest, visibleNode, type Task, type TaskNode, type TaskSnapshot, type TaskView } from "./task-model";

export interface ListOptions {
  view: TaskView; hideDone: boolean; collapsed: Set<string>; disabled: boolean;
  redraw: () => void; complete: (task: Task) => void;
  check: (task: Task, itemId: string, done: boolean) => void;
  edit?: (task: Task) => void;
}

export function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); node.className = className; node.textContent = text; return node;
}

export function renderTaskList(target: HTMLElement, snapshot: TaskSnapshot, options: ListOptions) {
  target.replaceChildren();
  const forest = taskForest(snapshot.tasks, options.view);
  const groups = new Map<string, TaskNode[]>();
  for (const node of forest) {
    if (!visibleNode(node, options.hideDone)) continue;
    const group = groups.get(node.task.projectId) || [];
    group.push(node); groups.set(node.task.projectId, group);
  }
  if (!groups.size) {
    const empty = element("div", "empty-state");
    empty.append(element("div", "empty-mark", "◎"), element("h3", "", !snapshot.connected ? "Your tasks, within reach" :
      options.view === "overdue" ? "Nothing overdue" : options.hideDone && progress(forest).done ? "All clear" : "Make room for what matters"));
    empty.append(element("p", "", !snapshot.connected ? "Connect TickTick to bring your lists and daily plan here." :
      options.view === "overdue" ? "You're caught up on scheduled tasks." : "Add a task or schedule one in TickTick for today."));
    target.append(empty); return;
  }
  function draw(node: TaskNode, depth: number): HTMLElement {
    const task = node.task;
    const block = element("div", "task-block");
    const row = element("div", `task-row${task.status === 2 ? " done" : ""}${!node.selected ? " context" : ""}`);
    const children = node.children.filter(n => visibleNode(n, options.hideDone));
    const items = task.items || [];
    const expandable = children.length > 0 || items.length > 0;
    const folded = options.collapsed.has(node.key);
    const toggle = element("button", "disclosure", expandable ? folded ? "›" : "⌄" : "");
    toggle.type = "button"; toggle.disabled = !expandable;
    toggle.setAttribute("aria-label", `${folded ? "Expand" : "Collapse"} ${task.title}`);
    if (expandable) toggle.setAttribute("aria-expanded", String(!folded));
    toggle.onclick = () => {
      folded ? options.collapsed.delete(node.key) : options.collapsed.add(node.key);
      if(folded) target.classList.add("revealing");
      options.redraw();
      window.setTimeout(()=>target.classList.remove("revealing"),180);
    };
    const checkbox = element("input"); checkbox.type = "checkbox";
    checkbox.checked = task.status === 2;
    const summary = progress([node]);
    checkbox.indeterminate = expandable && summary.done > 0 && summary.done < summary.total;
    // Bulk completion and recurring undo need verified provider semantics.
    checkbox.disabled = options.disabled || task.status === 2 || node.children.length > 0 || !node.selected;
    checkbox.setAttribute("aria-label", `Complete ${task.title}`);
    checkbox.title = node.children.length ? "Complete individual subtasks below" : task.status === 2 ? "Completed · reopen in TickTick" : "Complete task";
    checkbox.onchange = () => { checkbox.checked = task.status === 2; options.complete(task); };
    const body = element("div", "task-copy");
    const label = element("span", "task-title", task.title || "Untitled task");
    body.append(label);
    const note = task.content || task.desc;
    if (note) body.append(element("p", "task-note", note));
    if (task.repeatFlag) body.append(element("span", "task-meta", "↻ Repeats"));
    row.append(toggle, checkbox, body);
    if (expandable) row.append(element("span", "task-count", `${summary.done}/${summary.total}`));
    if (options.edit && task.status !== 2) {
      const edit = element("button", "edit-task", "✎"); edit.setAttribute("aria-label", `Rename ${task.title}`);
      edit.disabled = options.disabled; edit.onclick = () => options.edit!(task); row.append(edit);
    }
    block.append(row);
    if (!folded) {
      const nested = element("div", depth < 6 ? "task-children" : "task-children flat");
      for (const child of children) nested.append(draw(child, depth + 1));
      if (node.selected) for (const item of items) {
        if (options.hideDone && (item.status === 1 || task.status === 2)) continue;
        const line = element("label", `checklist-row${item.status === 1 || task.status === 2 ? " done" : ""}`);
        const check = element("input"); check.type = "checkbox";
        check.checked = item.status === 1 || task.status === 2;
        check.disabled = options.disabled || task.status === 2;
        check.onchange = () => { const next = check.checked; check.checked = !next; options.check(task, item.id, next); };
        line.append(check, element("span", "task-title", item.title)); nested.append(line);
      }
      if (nested.childElementCount) block.append(nested);
    }
    return block;
  }
  for (const [projectId, nodes] of groups) {
    const section = element("section", "task-group");
    const heading = element("div", "group-heading");
    const summary = progress(forest.filter(n => n.task.projectId === projectId));
    heading.append(element("h3", "", snapshot.projects.find(p => p.id === projectId)?.name || "TickTick"), element("span", "", `${summary.done}/${summary.total}`));
    section.append(heading);
    for (const node of nodes) section.append(draw(node, 0));
    target.append(section);
  }
}
