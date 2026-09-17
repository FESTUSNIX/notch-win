/* The Day Card: the notch panel's list.
 *
 * ⚠️ The ONLY task renderer now. There used to be a second, `task-list.ts`,
 * drawing the editor window's browser — grouped by list, dense, with a rename
 * pencil. Two renderers for one kind of data meant every change to how a task
 * reads had to be made twice, and one of them was on a page nobody opened to
 * look at tasks. This draws the product: one day as one list, no project
 * headings, finished work sunk into a single line, and a composer that is
 * always a field.
 *
 * Nothing here awaits the network. Every control reports what it did straight
 * away and the caller reconciles when TickTick answers; see `settling` below.
 */
import { taskIcon } from "./task-icons";
import { element } from "./dom";
import {
  inList, listTally, nodeDone, overdueDays, progress, taskForest, taskId, visibleNode,
  type Project, type Task, type TaskNode, type TaskSnapshot, type TaskView,
} from "./task-model";

const NS = "http://www.w3.org/2000/svg";

export interface DayOptions {
  /** The key of the row to mark as the one to do next. See `nextUp`. */
  next?: string | null;
  view: TaskView;
  focus?: (task:Task)=>void;
  focused?: string;
  disabled: boolean;
  /** Finished, but still held among the live rows so the tick can be seen. */
  settling: Set<string>;
  /** Held one render longer, rendered open and closed on the next frame. */
  leaving: Set<string>;
  /** Explicit opens, for rows that default closed. */
  expanded: Set<string>;
  /** Explicit closes, for rows that default open. */
  collapsed: Set<string>;
  editing: string | null;
  /** Caret inside the rename field, carried across redraws. Null means fresh. */
  editCaret: number | null;
  showing: "open" | "done";
  /** Which TickTick list to show, or "" for all of them. */
  list: string;
  /** Tasks typed into the composer that TickTick has not confirmed yet. */
  outbox: { id: string; title: string }[];
  redraw: () => void;
  connect: () => void;
  complete: (task: Task) => void;
  check: (task: Task, itemId: string, done: boolean) => void;
  rename: (task: Task, name: string) => void;
  setEditing: (key: string | null) => void;
  setShowing: (which: "open" | "done") => void;
}

/* TickTick gives most lists a colour and some none, so there has to be a
 * fallback — and it has to be stable, or a list changes colour between two
 * renders of the same day. Hashed off the id rather than the index, which
 * shifts whenever a list is added. */
const PALETTE = ["#5ac8fa", "#ff9f0a", "#bf5af2", "#ff6482", "#64d2ff", "#30d158", "#ffd60a"];

export function listColor(project?: Project): string {
  const raw = project?.color?.trim();
  if (raw && /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(raw)) return raw;
  // ⚠️ The app's own colour, not a copy of its default. A task with no list
  // is the app speaking for itself, and it should say so in whatever colour
  // the app is currently wearing.
  if (!project) return "var(--accent)";
  let hash = 0;
  for (let i = 0; i < project.id.length; i++) hash = (hash * 31 + project.id.charCodeAt(i)) >>> 0;
  return PALETTE[hash % PALETTE.length];
}

function tick(): SVGSVGElement {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(NS, "path");
  path.setAttribute("d", "M6.2 12.6 L10 16.4 L17.8 7.6");
  svg.append(path);
  return svg;
}

/** The one control the whole app is about.
 *
 * A real checkbox, visually hidden inside the ring: it keeps the label, the
 * keyboard and the accessibility tree that a styled <button> would have to
 * rebuild by hand. The ring, fill, tick and pulse are painted around it. */
function control(color: string, done: boolean, label: string, disabled: boolean, toggle: () => void): HTMLElement {
  const wrap = element("label", "check");
  wrap.style.setProperty("--list", color);
  const input = element("input") as HTMLInputElement;
  input.type = "checkbox";
  input.checked = done;
  input.disabled = disabled;
  input.setAttribute("aria-label", label);
  // Never let the box drive its own state: the row's class does, so a rejected
  // write can put it back without the control having flickered on its own.
  input.onchange = () => { input.checked = done; toggle(); };
  wrap.append(input, element("span", "disc"), element("span", "fill"), tick(), element("span", "pulse"));
  return wrap;
}

function titleField(value: string, o: DayOptions, commit: (name: string) => void): HTMLInputElement {
  const field = element("input") as HTMLInputElement;
  field.className = "day-field";
  field.value = value;
  field.maxLength = 1000;
  field.autocomplete = "off";
  field.setAttribute("aria-label", "Task name");
  const remember = () => { o.editCaret = field.selectionStart; };
  field.onkeyup = remember;
  field.onclick = remember;
  field.onkeydown = event => {
    if (event.key === "Enter") { event.preventDefault(); commit(field.value.trim()); }
    // Stop it here: the panel's own Escape collapses the whole surface.
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); o.setEditing(null); }
  };
  // ⚠️ Only a real blur commits. Any redraw detaches this node, which also
  // fires blur — committing there would file a half-typed rename because a
  // snapshot happened to land while someone was typing.
  field.onblur = () => { if (field.isConnected) commit(field.value.trim()); };
  requestAnimationFrame(() => {
    field.focus();
    // Fresh edit selects the lot so typing replaces it; a redraw mid-rename
    // puts the caret back where the typist left it.
    if (o.editCaret === null) field.select();
    else field.setSelectionRange(o.editCaret, o.editCaret);
  });
  return field;
}

/** The one thing to do next: the first row, in the order they are DRAWN,
 *  that can actually be ticked.
 *
 * ⚠️ In draw order and not by any ranking of its own. A list already sorted
 * by what is most overdue is a queue; marking a different task as "next" than
 * the one at the top would be two opinions on the same screen, and the reader
 * would have to work out which to trust. It is the first tickable line, which
 * is also the one the eye lands on — the marker only says out loud what the
 * order was already saying quietly.
 *
 * ⚠️ A parent with children is skipped. It cannot be completed here (bulk
 * completion needs provider semantics this app has not verified), so pointing
 * at it is pointing at a circle that is disabled.
 */
export function nextUp(nodes: TaskNode[]): string | null {
  for (const node of nodes) {
    const children = node.children.filter(one => visibleNode(one, false));
    if (!nodeDone(node) && !children.length && node.selected) return taskId(node.task);
    const inside = nextUp(children);
    if (inside) return inside;
  }
  return null;
}

function drawRow(node: TaskNode, snapshot: TaskSnapshot, o: DayOptions, depth: number): HTMLElement {
  const task = node.task;
  const key = taskId(task);
  const done = task.status === 2;
  const items = (task.items || []).filter(() => node.selected);
  const children = node.children.filter(n => visibleNode(n, false));
  const expandable = children.length > 0 || items.length > 0;
  /* Sub-tasks open by default, a checklist does not — and the difference is
   * whether the row still means anything closed. A parent with children cannot
   * be completed here (bulk completion needs semantics this app has not
   * verified), so collapsed it is an inert line with a disabled circle. A task
   * with a checklist is completable on its own, so its steps are detail. */
  const opensByDefault = children.length > 0;
  const open = opensByDefault ? !o.collapsed.has(key) : o.expanded.has(key);
  const late = overdueDays(task);
  const color = listColor(snapshot.projects.find(p => p.id === task.projectId));

  const slot = element("div", "slot");
  slot.dataset.slot = key;
  // One child, so `grid-template-rows: 1fr -> 0fr` has a single track to close.
  // A row plus its children as two tracks would only collapse the first.
  const inner = element("div", "slot-inner");
  slot.append(inner);
  /* ⚠️ The NEXT one is marked, not merely first. A list is a set of things
   * you could do; a queue is one thing you are about to do, and the whole
   * difference between the two is a mark on one row. It is the cheapest thing
   * on this screen that makes it answer "what now" instead of "what is
   * outstanding". */
  const next = !done && key === o.next;
  const row = element("div", `day-row${done ? " is-done" : ""}${depth ? " nested" : ""}`
    + (next ? " is-next" : ""));

  // A parent is finished by finishing its children; completing it in bulk needs
  // provider semantics this app has not verified.
  const blocked = o.disabled || done || children.length > 0 || !node.selected;
  row.append(control(color, done, `Complete ${task.title}`, blocked, () => o.complete(task)));

  const body = element("div", "day-body");
  if (o.editing === key) {
    body.append(titleField(task.title, o, name => {
      o.setEditing(null);
      if (name && name !== task.title) o.rename(task, name); else o.redraw();
    }));
  } else {
    const title = element("button", "task-title strike", task.title || "Untitled task");
    (title as HTMLButtonElement).type = "button";
    title.setAttribute("aria-label", `Rename ${task.title}`);
    (title as HTMLButtonElement).disabled = o.disabled || done;
    title.onclick = () => o.setEditing(key);
    body.append(title);

    const meta: HTMLElement[] = [];
    if (expandable) {
      const sum = progress([node]);
      const sub = element("button", "day-sub", `${sum.done} of ${sum.total} done`);
      (sub as HTMLButtonElement).type = "button";
      sub.setAttribute("aria-expanded", String(open));
      sub.setAttribute("aria-label", `${open ? "Collapse" : "Expand"} ${task.title}`);
      sub.onclick = () => {
        const set = opensByDefault ? o.collapsed : o.expanded;
        (open === opensByDefault) ? set.add(key) : set.delete(key);
        o.redraw();
      };
      meta.push(sub);
    }
    if (task.repeatFlag) meta.push(element("span", "day-sub muted", "Repeats"));
    if (meta.length) { const line = element("div", "day-meta-line"); line.append(...meta); body.append(line); }
  }
  row.append(body);
  if(!done && !children.length && o.focus) {
    const focus=element("button","task-focus");focus.append(taskIcon("focus"));focus.dataset.tip = o.focused===key?"Current focus":"Focus on this task";
    focus.type="button";focus.setAttribute("aria-label","Focus "+task.title);
    focus.disabled=o.focused===key;focus.onclick=()=>o.focus!(task);row.append(focus);
  }

  if (late) {
    // Capped: the chip sits beside the title on a 373px panel, and a task
    // forgotten for two years must not be the widest thing in the row.
    const chip = element("span", "day-chip", late > 99 ? "99+d" : `${late}d`);
    chip.dataset.tip = `${late} ${late === 1 ? "day" : "days"} overdue`;
    row.append(chip);
  }
  /* ⚠️ A word, and only on the one row. An icon here would be a fourth
   * glyph in a line that already has a circle, a focus target and sometimes an
   * overdue chip; the word is read once and then never again, because after
   * that the eye knows the mark by its shape. */
  if (next) {
    const flag = element("span", "day-next", "Next");
    flag.dataset.tip = "The first thing you can tick";
    row.append(flag);
  }
  inner.append(row);

  if (open && expandable) {
    const nested = element("div", "day-children");
    for (const child of children) nested.append(drawRow(child, snapshot, o, depth + 1));
    for (const item of items) {
      const finished = item.status === 1 || done;
      const line = element("div", `day-step${finished ? " is-done" : ""}`);
      line.append(control(color, finished, item.title, o.disabled || done, () => o.check(task, item.id, !finished)));
      line.append(element("span", "task-title strike", item.title));
      nested.append(line);
    }
    inner.append(nested);
  }
  return slot;
}

function clearCard(done: number): HTMLElement {
  const card = element("div", "day-clear");
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 80 80");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", "clear-ring");
  // ⚠️ No pathLength here. On nodes built with createElementNS it does not
  // normalise the dash the way it does on the rail ring, which is parsed from
  // markup — `stroke-dasharray: 1` then resolves to one *pixel* and the ring
  // draws as a dotted line that reads as a dim grey circle. The dash lengths in
  // the stylesheet are this geometry's own: 2πr = 207.3 for the arc, 38.6 for
  // the mark. Change either shape and change them with it.
  for (const cls of ["trk", "arc"]) {
    const circle = document.createElementNS(NS, "circle");
    circle.setAttribute("class", cls);
    circle.setAttribute("cx", "40"); circle.setAttribute("cy", "40"); circle.setAttribute("r", "33");
    svg.append(circle);
  }
  const mark = document.createElementNS(NS, "path");
  mark.setAttribute("class", "mark");
  mark.setAttribute("d", "M27 41.5 L36 50 L54 31");
  svg.append(mark);
  card.append(svg, element("h3", "", "Day clear"),
    element("p", "", `${done} done · nothing left`));
  // The animation is keyed on a class added a frame late, so it plays on the
  // render that finished the day and not on every redraw afterwards.
  requestAnimationFrame(() => card.classList.add("played"));
  return card;
}

/** Draws the day, and says how much of it is finished.
 *
 * ⚠️ The counts are RETURNED rather than recomputed by the caller. The header's
 * Open/Done switch and the list rail are both drawn from them, and a control
 * counted separately from the list it switches disagrees with it the moment
 * either rule changes — a task held back for its completion animation is
 * finished by one count and not the other, which is a "Done 1" tab leading to
 * an empty list.
 *
 * `lists` counts the half the switch is on, BEFORE the list filter: it is what
 * each chip would reveal if it were pressed, which is the only number a chip
 * can honestly wear. */
export function renderDay(content: HTMLElement, doneTarget: HTMLElement, snapshot: TaskSnapshot, o: DayOptions): { finished: number; lists: Map<string, number> } {
  content.replaceChildren();
  doneTarget.replaceChildren();

  const forest = taskForest(snapshot.tasks, o.view);
  const shown = forest.filter(n => visibleNode(n, false));
  // A finished root leaves the day, unless it is still being celebrated.
  const held = (n: TaskNode) => o.settling.has(taskId(n.task)) || o.leaving.has(taskId(n.task));
  const live = shown.filter(n => !nodeDone(n) || held(n));
  const everyFinished = shown.filter(n => nodeDone(n) && !held(n));
  /* ⚠️ Counted on the half that is SHOWING. A chip wearing the number of open
   * tasks while the Done half is on screen is a chip that leads somewhere else
   * than it says. */
  const lists = listTally(o.showing === "done" ? everyFinished : live);
  // One thing to do next, in the order the rows are drawn. See `nextUp`.
  o.next = o.showing === "done" ? null : nextUp(inList(live, o.list));
  const finished = inList(everyFinished, o.list);

  /* ⚠️ The two halves are exclusive. The switch says which one you asked
   * for, so drawing the open list underneath the finished one would make
   * "Done" an addition to the day rather than a view of it — which is the
   * drawer this replaced, wearing a tab. */
  if (o.showing === "done") {
    for (const node of finished) doneTarget.append(drawRow(node, snapshot, o, 1));
    if (!finished.length) doneTarget.append(element("p", "day-none", "Nothing finished yet today."));
    return { finished: finished.length, lists };
  }

  const open = inList(live, o.list);
  open.sort((a, b) => overdueDays(b.task) - overdueDays(a.task) ||
    (a.task.sortOrder || 0) - (b.task.sortOrder || 0) || a.task.title.localeCompare(b.task.title));

  if (!open.length && !o.outbox.length) {
    const todayDone = progress(taskForest(snapshot.tasks, "today")).done;
    if (!snapshot.connected) {
      const empty = element("div", "day-empty");
      const connect = element("button", "day-connect", "Connect TickTick");
      (connect as HTMLButtonElement).type = "button";
      connect.onclick = () => o.connect();
      empty.append(element("h3", "", "Your tasks, within reach"),
        element("p", "", "Bring your lists and your day here."), connect);
      content.append(empty);
    } else if (todayDone > 0) {
      content.append(clearCard(todayDone));
    } else {
      /* ⚠️ Names the list when one is chosen. "Nothing scheduled" under a
       * rail with `Work` lit reads as an empty DAY, and the way out — press
       * All — is the one thing the copy does not mention. */
      const named = o.list ? snapshot.projects.find(p => p.id === o.list) : undefined;
      const empty = element("div", "day-empty");
      empty.append(element("h3", "", named ? `Nothing in ${named.name}` : "Nothing scheduled"),
        element("p", "", named
          ? "Press All to see the rest of the day."
          : "Add one below, or plan the day in TickTick."));
      content.append(empty);
    }
  }

  for (const node of open) {
    const slot = drawRow(node, snapshot, o, 0);
    content.append(slot);
    // Collapse on the frame after the row exists at full height — set the class
    // during construction and the transition has nothing to travel from.
    if (o.leaving.has(taskId(node.task))) requestAnimationFrame(() => slot.classList.add("gone"));
  }

  for (const pending of o.outbox) {
    const ghost = element("div", "day-row ghost");
    ghost.append(element("span", "check placeholder"), element("span", "task-title", pending.title));
    ghost.append(element("span", "day-chip quiet", "Saving"));
    content.append(ghost);
  }

  /* ⚠️ Finished work is behind the header's switch, not a drawer down here. A
   * drawer put "3 done today" underneath everything else — the one place you
   * would not look for it — and opening it made a long list longer, which is
   * the opposite of what looking back over the day is for. */
  return { finished: finished.length, lists };
}
