/* The Today screen: the Day Card, now one screen of the island.
 *
 * Everything that used to be the whole task panel lives here — the optimistic
 * completion layer, the permanent composer, rename-in-place and the focus
 * session. The shell owns the shape, the header and the tabs; this owns the day.
 */
import { FocusTimer, timerText } from "./focus-timer";
import { paintIcon } from "./task-icons";
import { element } from "./task-list";
import { call, native, preview } from "./task-client";
import {
  emptySnapshot, localDay, nodeDone, overdueDays, progress, taskForest, taskId,
  type Task, type TaskNode, type TaskSnapshot, type TaskView,
} from "./task-model";
import { listColor, renderDay } from "./task-day";
import type { Activity } from "./island-activity";
import type { IslandSurface } from "./island-surface";

const HTML = `
  <div class="day-head">
    <div class="day-meta"><span id="day-date"></span><span id="day-left"></span></div>
    <div class="day-switch" id="day-switch" role="tablist" aria-label="Which tasks" hidden><button type="button" id="day-open" role="tab" aria-selected="true">Open</button><button type="button" id="day-done-tab" role="tab" aria-selected="false"></button></div>
  </div>
  <div class="day-rail"><i id="day-rail-fill"></i></div>
  <section id="focus-session" hidden><div id="focus-task-title"></div><div class="focus-controls"><time id="focus-elapsed" title="Elapsed focus time">00:00</time><button id="focus-others" aria-label="Show other tasks" title="Show other tasks" aria-expanded="false"></button><button id="focus-pause" aria-label="Pause focus timer" title="Pause"></button><button id="focus-end" aria-label="End focus session" title="End session"></button><button id="focus-finish" aria-label="Complete focused task" title="Complete task"></button></div><span id="focus-state" class="sr-only"></span></section>
  <div id="task-status" role="status"></div>
  <div id="task-list" class="task-list scrolls"><div id="task-list-content"></div><div id="task-done"></div></div>
  <form id="inline-composer"><span class="plus" aria-hidden="true">+</span><input id="inline-title" aria-label="Task name" maxlength="1000" required autocomplete="off" placeholder="Add a task"><div class="composer-chips" id="composer-chips"><button type="button" class="chip" id="chip-list" aria-haspopup="listbox" aria-expanded="false"></button><button type="button" class="chip" id="chip-day" aria-haspopup="listbox" aria-expanded="false"></button></div><span class="enter-hint" aria-hidden="true">&#8629;</span></form>
`;

export class TodayScreen {
  readonly name = "today" as const;
  snapshot: TaskSnapshot = emptySnapshot();
  private view: TaskView = "day";
  private busy = false;
  private actionError = "";
  private day = localDay();

  /* ── Optimistic state ───────────────────────────────────────────────────
   * TickTick stays authoritative; it is just no longer in the loop between a
   * click and what the click looks like. ⚠️ Each map is cleared by the arriving
   * snapshot agreeing, never by the call returning — the write's own refresh
   * can land first, and clearing on resolve blinks the row back in between. */
  private pendingStatus = new Map<string, number>();
  private pendingItems = new Map<string, Map<string, number>>();
  private pendingNames = new Map<string, string>();
  private settling = new Set<string>();
  private leaving = new Set<string>();
  private expanded = new Set<string>();
  private collapsed = new Set<string>();
  private outbox: { id: string; title: string }[] = [];
  private editing: string | null = null;
  private editCaret: number | null = null;
  /** Which half of the day is on screen. ⚠️ A switch, not a drawer: an
   *  inline "3 done today" row was invisible where it sat — under everything
   *  else — and opening it made a long list longer, which is the opposite of
   *  what looking at finished work is for. */
  private showing: "open" | "done" = "open";
  /** The list and day the composer will file into. Held here rather than read
   *  off a `<select>`, because there is no longer one. */
  private toList = "";
  private toDay = localDay();
  /** Which composer chip has its menu open. */
  private picking: "list" | "day" | null = null;
  /** What the sync tool says when pointed at. */
  private syncWord = "";
  private othersOpen = false;
  /** False when the day is read-only: no account, an error, or fixtures mode. */
  private writable = false;

  readonly focusTimer: FocusTimer;
  private reduced = matchMedia("(prefers-reduced-motion: reduce)");
  private composer!: HTMLFormElement;
  private title!: HTMLInputElement;

  private list!: HTMLElement;
  private doneTarget!: HTMLElement;
  private status!: HTMLElement;

  constructor(private host: HTMLElement, private surface: IslandSurface, private changed: () => void) {
    this.host.innerHTML = HTML;
    const get = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
    this.composer = get<HTMLFormElement>("inline-composer");
    this.title = get<HTMLInputElement>("inline-title");

    this.list = get("task-list-content");
    this.doneTarget = get("task-done");
    this.status = get("task-status");
    this.focusTimer = new FocusTimer(() => { this.othersOpen = false; this.changed(); });

    paintIcon(this.host.querySelector("#inline-composer .plus") as HTMLElement, "plus");
    paintIcon(get("focus-others"), "list");
    paintIcon(get("focus-end"), "stop");
    paintIcon(get("focus-finish"), "check");

    this.wire();
  }

  private get(id: string) { return document.getElementById(id) as HTMLElement; }

  /** How long a finished row is held before it leaves, and how long it takes. */
  private HOLD() { return this.reduced.matches ? 0 : 520; }
  private COLLAPSE() { return this.reduced.matches ? 0 : 340; }

  title$(): string { return this.view === "all" ? "All lists" : "Today"; }
  /** Which list the day is showing, for the resting pill's tasks module. */
  get shownView(): TaskView { return this.view; }

  /** The snapshot as the person in front of it believes it to be. */
  private local(source: TaskSnapshot = this.snapshot): TaskSnapshot {
    if (!this.pendingStatus.size && !this.pendingItems.size && !this.pendingNames.size) return source;
    const now = new Date().toISOString();
    return { ...source, tasks: source.tasks.map(task => {
      const key = taskId(task);
      const status = this.pendingStatus.get(key);
      const items = this.pendingItems.get(key);
      const name = this.pendingNames.get(key);
      if (status === undefined && !items && name === undefined) return task;
      return {
        ...task,
        ...(name !== undefined ? { title: name } : {}),
        ...(status !== undefined ? { status, completedTime: status === 2 ? task.completedTime || now : undefined } : {}),
        ...(items && task.items ? { items: task.items.map(i => (items.has(i.id) ? { ...i, status: items.get(i.id)! } : i)) } : {}),
      };
    }) };
  }

  /** Drop every optimistic entry the server has now confirmed. */
  reconcile(next: TaskSnapshot) {
    for (const [key, status] of [...this.pendingStatus]) {
      if (next.tasks.some(t => taskId(t) === key && t.status === status)) this.pendingStatus.delete(key);
    }
    for (const [key, name] of [...this.pendingNames]) {
      if (next.tasks.some(t => taskId(t) === key && t.title === name)) this.pendingNames.delete(key);
    }
    for (const [key, wanted] of [...this.pendingItems]) {
      const task = next.tasks.find(t => taskId(t) === key);
      if (!task?.items) continue;
      for (const [id, status] of [...wanted]) {
        if (task.items.some(i => i.id === id && i.status === status)) wanted.delete(id);
      }
      if (!wanted.size) this.pendingItems.delete(key);
    }
    // A focus session on a task that is finished, or gone, has nothing to time.
    const f = this.focusTimer.session;
    if (f && (!next.connected || (next.updatedAt && !next.error
      && next.tasks.some(t => t.id === f.id && t.projectId === f.projectId && t.status === 2)
      && !next.tasks.some(t => t.id === f.id && t.projectId === f.projectId && t.status !== 2)))) {
      this.focusTimer.stop();
    }
  }

  /** A write that never blocks the list. Failure puts the row back and says why. */
  private async mutate(command: string, args: Record<string, unknown>, revert: () => void) {
    this.actionError = "";
    this.changed();
    try { await call(command, args); }
    catch (error) { revert(); this.actionError = String(error); }
    finally { this.changed(); }
  }

  /** Commands that genuinely have nothing to show until they return. */
  async action(command: string, args: Record<string, unknown> = {}): Promise<boolean> {
    if (this.busy) return false;
    this.busy = true; this.actionError = ""; this.changed();
    try { await call(command, args); return true; }
    catch (error) { this.actionError = String(error); return false; }
    finally { this.busy = false; this.changed(); }
  }

  private complete(task: Task) {
    const key = taskId(task);
    if (this.pendingStatus.get(key) === 2) return;
    const clear = () => { this.pendingStatus.delete(key); this.settling.delete(key); this.leaving.delete(key); };
    this.pendingStatus.set(key, 2);
    this.settling.add(key);
    this.changed();
    window.setTimeout(() => {
      if (!this.settling.delete(key)) return;     // already reverted by a failed write
      this.leaving.add(key);
      this.changed();
      window.setTimeout(() => { this.leaving.delete(key); this.changed(); }, this.COLLAPSE());
    }, this.HOLD());
    void this.mutate("complete_task", { projectId: task.projectId, taskId: task.id, expectedStart: task.startDate ?? null }, clear);
  }

  private checkItem(task: Task, itemId: string, done: boolean) {
    const key = taskId(task);
    const wanted = this.pendingItems.get(key) || new Map<string, number>();
    wanted.set(itemId, done ? 1 : 0);
    this.pendingItems.set(key, wanted);
    void this.mutate("set_checklist_item", { projectId: task.projectId, taskId: task.id, itemId, done }, () => {
      wanted.delete(itemId);
      if (!wanted.size) this.pendingItems.delete(key);
    });
  }

  private rename(task: Task, name: string) {
    const key = taskId(task);
    this.pendingNames.set(key, name);
    void this.mutate("rename_task", { projectId: task.projectId, taskId: task.id, name }, () => this.pendingNames.delete(key));
  }

  /** Today claims the pill only while a session is running.
   *
   * The resting state belongs to the shell's clock, which carries this screen's
   * tally anyway — two claims for the same day would just mean the higher one
   * always wins and the other is dead code. */
  activity(): Activity | null {
    const session = this.focusTimer.session;
    if (!session) return null;
    const seconds = this.focusTimer.seconds();
    return {
      /* Above music. A timer is something you deliberately started and are
       * inside; whatever is playing is ambient by definition. Only a meeting
       * about to start outranks it. */
      priority: 45,
      screen: "today",
      kind: "focus",
      icon: "focus",
      label: session.title,
      value: timerText(seconds) + (session.startedAt === null ? " paused" : ""),
      progress: Math.min(1, seconds / 1500),
    };
  }

  /** Put the caret in the composer from anywhere — the capture shortcut. */
  /** Put the caret in the composer from anywhere.
   *
   *  `seed` pre-fills it — the palette's "Add task …" row hands over what was
   *  already typed rather than making you type it twice. ⚠️ It does not
   *  SUBMIT: the composer is where a task gets its list and its day, and a
   *  palette that created tasks behind your back would be a different and
   *  worse thing than one that takes you to the composer with the words in. */
  async capture(seed = "") {
    try {
      if (seed) this.title.value = seed;
      await this.surface.input(true);
      this.title.focus();
      if (seed) this.title.setSelectionRange(seed.length, seed.length);
      else this.title.select();
    } catch (error) {
      this.actionError = String(error);
      this.changed();
    }
  }

  paintTimer() {
    const s = this.focusTimer.session;
    const seconds = this.focusTimer.seconds();
    const text = timerText(seconds);
    const paused = s?.startedAt === null;
    this.get("focus-elapsed").textContent = text;
    const shell = document.getElementById("notch-shell")!;
    shell.style.setProperty("--focus-progress", String(Math.min(1, seconds / 1500)));
    shell.classList.toggle("focus-paused", !!s && paused);
    shell.classList.toggle("focus-break", !!s && seconds >= 1500);
    this.get("focus-state").textContent = paused ? "Paused" : seconds >= 1500 ? "25 minutes reached - take a breath" : "Focusing";
    paintIcon(this.get("focus-pause"), paused ? "play" : "pause");
    this.get("focus-pause").title = paused ? "Resume" : "Pause";
    this.get("focus-pause").setAttribute("aria-label", paused ? "Resume focus timer" : "Pause focus timer");
    this.get("focus-elapsed").title = seconds >= 1500 ? "25 minutes reached - take a break when ready" : "Elapsed focus time";
  }

  render() {
    const shown = this.local();
    const session = this.focusTimer.session;
    this.get("focus-session").hidden = !session;
    this.get("focus-others").hidden = !session;
    this.get("task-list").hidden = !!session && !this.othersOpen;
    for (const attr of ["aria-label", "title"] as const) {
      this.get("focus-others").setAttribute(attr === "title" ? "title" : attr, this.othersOpen ? "Hide other tasks" : "Show other tasks");
    }
    this.get("focus-others").setAttribute("aria-expanded", String(this.othersOpen));
    if (session) {
      const task = shown.tasks.find(t => t.id === session.id && t.projectId === session.projectId);
      this.get("focus-task-title").textContent = task?.title || session.title;
      (this.get("focus-finish") as HTMLButtonElement).disabled = !task || task.status === 2 || !shown.connected
        || !!shown.error || (native && !!shown.demo)
        || shown.tasks.some(t => t.parentId === task.id && t.projectId === task.projectId);
    }
    this.paintTimer();

    // ⚠️ Progress is `today`, never `day`. Overdue work is listed and badged
    // but not scored — a backlog must not hold the ring at 2/15 all week.
    const today = progress(taskForest(shown.tasks, "today"));
    const reliable = !!shown.updatedAt && shown.historyComplete && shown.day === localDay();
    const percent = reliable && today.total ? (today.done / today.total) * 100 : 0;
    this.get("day-rail-fill").style.width = `${percent}%`;
    // The shell has no title bar any more, so the day says the date itself.
    this.get("day-date").textContent = new Date().toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
    this.get("day-left").textContent = !reliable ? ""
      : today.total === 0 ? "nothing scheduled"
      : today.done === today.total ? "all done"
      : `${today.total - today.done} left`;

    this.status.textContent = this.actionError || shown.error || (shown.connected && !shown.updatedAt ? "Loading TickTick…" :
      shown.updatedAt && !shown.historyComplete ? "Completion history is partial. Daily progress is unavailable." : "");
    this.status.classList.toggle("error", !!(this.actionError || shown.error));

    const ago = shown.updatedAt ? Math.max(0, Math.floor((Date.now() - new Date(shown.updatedAt).getTime()) / 60000)) : null;
    /* ⚠️ Kept as a STRING, drawn in the header. It was a row of 10px grey text
     * at the foot of the panel — the place nothing is read — and it broke the
     * bottom padding it sat inside. The words still exist; they are a tooltip
     * on the button that does the thing they describe. */
    this.syncWord = preview ? "Interactive preview · sample tasks" : shown.demo ? "Demo · sample tasks · read only" :
      this.busy ? "Syncing with TickTick…" : shown.updatedAt ? `TickTick · ${ago ? `${ago} min ago` : "just synced"}` : "TickTick · connect in settings";

    /* The list the composer files into. ⚠️ Held as an id and checked against
     * what still exists — a list closed in TickTick would otherwise leave the
     * chip naming something the next create would be rejected for. */
    const projects = shown.projects.filter(p => !p.closed && p.kind !== "NOTE");
    if (!projects.some(p => p.id === this.toList)) this.toList = projects[0]?.id ?? "";
    this.paintChips(projects);

    const frozen = this.busy || !shown.connected || !!shown.error || (native && !!shown.demo);
    /* ⚠️ The composer field is NOT disabled by demo mode, only by a missing
     * account or a real error. Demo blocks the write, not the caret: focusing
     * this field is what lifts WS_EX_NOACTIVATE, so disabling it under fixtures
     * left the native smoke test with no way to exercise the one behaviour it
     * exists to check. The submit handler carries the demo guard instead. */
    this.title.disabled = this.busy || !shown.connected || !!shown.error;
    this.title.placeholder = shown.connected ? "Add a task" : "Connect TickTick in settings";
    this.writable = !frozen;

    const drawn = renderDay(this.list, this.doneTarget, shown, {
      focus: task => this.focusTimer.start(task),
      focused: session ? `${session.projectId}:${session.id}` : undefined,
      view: this.view, disabled: frozen,
      settling: this.settling, leaving: this.leaving, expanded: this.expanded, collapsed: this.collapsed,
      editing: this.editing, editCaret: this.editCaret, showing: this.showing, outbox: this.outbox,
      redraw: this.changed, complete: t => this.complete(t), check: (t, i, d) => this.checkItem(t, i, d),
      rename: (t, n) => this.rename(t, n),
      connect: () => { void this.action("open_task_editor"); },
      setEditing: key => { this.editing = key; this.editCaret = null; this.changed(); },
      setShowing: which => { this.showing = which; this.changed(); },
    });

    /* ⚠️ The switch appears only once something is finished, and its count
     * comes from the draw that just happened. A "Done 0" tab is a control that
     * does nothing sitting where the day's summary goes — which on a fresh
     * morning is every morning — and a count taken separately from the list it
     * switches disagrees with it the moment either rule changes. */
    const sw = this.get("day-switch");
    sw.hidden = drawn.finished === 0;
    if (drawn.finished) {
      this.get("day-done-tab").textContent = `Done ${drawn.finished}`;
      this.get("day-open").setAttribute("aria-selected", String(this.showing === "open"));
      this.get("day-done-tab").setAttribute("aria-selected", String(this.showing === "done"));
    } else if (this.showing === "done") {
      // The last finished task was un-ticked while its own half was on screen.
      this.showing = "open";
    }
  }

  setView(view: TaskView) { this.view = view; this.changed(); }

  /* ── What the Home screen borrows ──────────────────────────────────────
   * Home shows a stripped version of this screen rather than keeping its own
   * copy of the day: one optimistic layer, one definition of "open", one
   * completion path. */

  /** The header's tools for this screen. */
  tools(): { help?: string; tools: { icon: "clock"; label: string; run?: () => void; disabled?: boolean }[] } {
    /* ⚠️ One tool, not two. A "Connect TickTick" button here would be the
     * SECOND one on screen — the empty state already offers it, in the middle
     * of the panel where somebody with no tasks is actually looking. */
    return {
      tools: [{
        icon: "clock",
        label: this.syncWord || "Refresh tasks",
        disabled: this.busy,
        run: () => { void this.action("refresh_tasks"); },
      }],
    };
  }

  /** Today's tally, exactly as the ring and the pill read it. */
  tally(): { done: number; total: number; reliable: boolean } {
    const shown = this.local();
    const { done, total } = progress(taskForest(shown.tasks, "today"));
    return { done, total, reliable: !!shown.updatedAt && shown.historyComplete && shown.day === localDay() };
  }

  /** What actually got finished today, for the Review screen.
   *
   * ⚠️ Read from the same forest the tally counts, so the number and the list
   * can never disagree. Titles rather than tasks: nothing downstream needs to
   * act on them, and handing out live tasks invites a second completion path. */
  finishedToday(): string[] {
    const shown = this.local();
    const out: string[] = [];
    const walk = (nodes: TaskNode[]) => {
      for (const node of nodes) {
        if (node.task.status === 2) out.push(node.task.title || "Untitled task");
        if (node.children.length) walk(node.children);
      }
    };
    walk(taskForest(shown.tasks, "today"));
    return out;
  }

  /** The next few things to do, overdue first — the same order the day lists.
   *
   * ⚠️ A task still `settling` is kept. It has already been marked done by the
   * optimistic layer, so dropping it here would make it vanish from Home the
   * instant it was ticked — no tick drawn, no strike, nothing to say the click
   * landed. The day screen holds finished rows for the same 520ms and for the
   * same reason. */
  upNext(limit: number): Task[] {
    const shown = this.local();
    const alive = (task: Task) => task.status !== 2 || this.settling.has(taskId(task));
    /* ⚠️ Rank a settling task as if it were still open. `overdueDays` returns 0
     * for anything completed, so a task that was three months late drops to
     * unranked the instant it is ticked and falls straight out of the top few —
     * which looked exactly like the settle window not working, and is not
     * something the filter above can save. It has to hold its place until the
     * timer moves it. */
    const ranked = (task: Task) => (this.settling.has(taskId(task)) ? { ...task, status: 0 } : task);
    return taskForest(shown.tasks, "day")
      .filter(node => !nodeDone(node) || this.settling.has(taskId(node.task)))
      .flatMap(node => (node.children.length ? node.children.filter(c => c.selected && alive(c.task)) : [node]))
      .filter(node => alive(node.task))
      .sort((a, b) => overdueDays(ranked(b.task)) - overdueDays(ranked(a.task))
        || (a.task.sortOrder || 0) - (b.task.sortOrder || 0))
      .slice(0, limit)
      .map(node => node.task);
  }

  /** Completing from Home runs the same optimistic path as completing here. */
  finish(task: Task) { this.complete(task); }

  get writeable() { return this.writable; }

  /** The list colour for a task, so Home's checks match the day's. */
  colorOf(task: Task): string {
    return listColor(this.local().projects.find(p => p.id === task.projectId));
  }

  /** `Today`, `Tomorrow`, or the weekday — never `2026-09-18`.
   *
   * ⚠️ A chip is read at a glance or it is not read. An ISO date in a 60px pill
   * is four numbers to parse before you know whether it is soon. */
  private dayName(iso: string): string {
    const today = localDay();
    if (iso === today) return "Today";
    const [y, m, d] = iso.split("-").map(Number);
    const when = new Date(y, m - 1, d);
    const days = Math.round((when.getTime() - new Date(`${today}T00:00:00`).getTime()) / 86_400_000);
    if (days === 1) return "Tomorrow";
    if (days > 1 && days < 7) return when.toLocaleDateString(undefined, { weekday: "long" });
    return when.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  }

  /** The chips that say where a new task will go. */
  private paintChips(projects: TaskSnapshot["projects"]) {
    const list = this.get("chip-list");
    const named = projects.find(p => p.id === this.toList);
    list.replaceChildren();
    const dot = element("span", "chip-dot");
    dot.style.background = listColor(named) || "var(--dim)";
    list.append(dot, element("span", "", named?.name ?? "No list"));
    list.setAttribute("aria-label", `List: ${named?.name ?? "none"}`);

    const day = this.get("chip-day");
    day.replaceChildren(element("span", "", this.dayName(this.toDay)));
    day.setAttribute("aria-label", `Day: ${this.dayName(this.toDay)}`);

    /* ⚠️ The menu is rebuilt on every paint rather than kept and toggled. The
     * screen redraws on every keystroke into the composer, so a kept menu is a
     * node with a stale list of projects in it. */
    this.host.querySelectorAll(".chip-menu").forEach(menu => menu.remove());
    list.setAttribute("aria-expanded", String(this.picking === "list"));
    day.setAttribute("aria-expanded", String(this.picking === "day"));
    if (!this.picking) return;
    /* ⚠️ The menu hangs off the chips CONTAINER, never off the chip. A chip is
     * a <button> and so is every option in the menu — nesting them is invalid
     * HTML, and the live consequence was that a press on an option bubbled to
     * the chip and re-opened the menu it had just chosen from. */
    const anchor = this.get("composer-chips");
    const menu = element("div", "chip-menu");
    const rows = this.picking === "list"
      ? projects.map(project => ({
          label: project.name, colour: listColor(project), on: project.id === this.toList,
          take: () => { this.toList = project.id; },
        }))
      : this.week().map(iso => ({
          label: this.dayName(iso), colour: "", on: iso === this.toDay,
          take: () => { this.toDay = iso; },
        }));
    for (const row of rows) {
      const item = element("button", `chip-option${row.on ? " is-on" : ""}`);
      (item as HTMLButtonElement).type = "button";
      if (row.colour) {
        const mark = element("span", "chip-dot");
        mark.style.background = row.colour;
        item.append(mark);
      }
      item.append(element("span", "", row.label));
      item.onclick = (event: MouseEvent) => {
        event.stopPropagation();
        row.take();
        this.picking = null;
        this.changed();
        this.title.focus();
      };
      menu.append(item);
    }
    anchor.append(menu);
  }

  /** Today and the six days after it. Past a week, the task editor. */
  private week(): string[] {
    const out: string[] = [];
    const base = new Date(`${localDay()}T00:00:00`);
    for (let i = 0; i < 7; i++) {
      const when = new Date(base);
      when.setDate(base.getDate() + i);
      out.push(localDay(when));
    }
    return out;
  }

  /** Open a chip's menu, closing the other. */
  private pick(which: "list" | "day") {
    this.picking = this.picking === which ? null : which;
    this.changed();
    if (this.picking) {
      /* Anything outside closes it. ⚠️ The press has to be tested rather than
       * assumed: a press INSIDE the menu would otherwise tear the option down
       * before its own click could land on it, and the click would then fall
       * through to whatever was underneath. */
      const away = (event: PointerEvent) => {
        if (event.target instanceof Node
          && (event.target as HTMLElement).closest?.(".chip-menu, .chip")) return;
        document.removeEventListener("pointerdown", away, true);
        if (!this.picking) return;
        this.picking = null;
        this.changed();
      };
      window.setTimeout(() => document.addEventListener("pointerdown", away, true), 0);
    }
  }

  /** The minute hand: refresh across midnight and re-age the sync line. */
  tick() {
    if (this.day !== localDay()) {
      this.day = localDay();
      this.toDay = this.day;
      void call("refresh_tasks").catch(() => {});
    }
  }

  private wire() {
    const get = (id: string) => this.get(id);
    get("focus-pause").onclick = () => this.focusTimer.toggle();
    get("focus-end").onclick = () => this.focusTimer.stop();
    get("focus-others").onclick = () => { this.othersOpen = !this.othersOpen; this.changed(); };
    get("focus-finish").onclick = () => {
      const s = this.focusTimer.session;
      const task = this.snapshot.tasks.find(t => t.id === s?.id && t.projectId === s?.projectId);
      if (task) this.complete(task);
    };
    get("day-open").onclick = () => { this.showing = "open"; this.changed(); };
    get("day-done-tab").onclick = () => { this.showing = "done"; this.changed(); };
    get("chip-list").onclick = event => { event.stopPropagation(); this.pick("list"); };
    get("chip-day").onclick = event => { event.stopPropagation(); this.pick("day"); };

    /* ── The composer ──────────────────────────────────────────────────────
     * A live field at all times, never a button that becomes one, and it lives
     * outside #task-list-content so a redraw cannot destroy what is half-typed.
     *
     * ⚠️ It still costs one click. The island runs WS_EX_NOACTIVATE so it never
     * steals focus from the window being worked in; set_task_input lifts that
     * only while a field is live. A keystroke cannot reach a window that is not
     * focused, so one click is the floor — what changed is that the click lands
     * in the field rather than on a button that then produces one. */
    this.composer.onsubmit = async event => {
      event.preventDefault();
      const value = this.title.value.trim();
      if (!value || this.busy || this.title.disabled) return;
      if (!this.writable) {
        this.actionError = "Sample data is read only.";
        this.changed();
        return;
      }
      if (!this.toList) {
        this.actionError = "Choose a list first.";
        this.pick("list");
        return;
      }
      let scheduled: string | null = null;
      if (this.toDay) {
        const [y, m, d] = this.toDay.split("-").map(Number);
        scheduled = new Date(y, m - 1, d).toISOString();
      }
      const ticket = { id: `${Date.now()}`, title: value };
      this.outbox.push(ticket);
      this.title.value = "";
      this.actionError = "";
      this.changed();
      this.title.focus();   // stays open: the next task is typed, not clicked into
      try {
        await call("create_task", { projectId: this.toList, name: value, date: scheduled, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
      } catch (error) {
        this.actionError = String(error);
        // Hand the words back rather than losing them to a failed write.
        if (!this.title.value) this.title.value = value;
      } finally {
        this.outbox.splice(this.outbox.indexOf(ticket), 1);
        this.changed();
      }
    };

    // Focusing a field in a NOACTIVATE window needs the exception lifted first.
    const lift = (field: HTMLElement) => {
      void this.surface.input(true).then(() => field.focus())
        .catch(error => { this.actionError = String(error); this.changed(); });
    };
    this.composer.addEventListener("pointerdown", event => {
      if (this.surface.editing || !(event.target instanceof HTMLElement)) return;
      /* ⚠️ A chip is not a field. Lifting the caret for it would take focus
       * off the half-typed title, and the chips only exist while that title has
       * focus — so the lift would close the very thing being pressed. */
      if (event.target.closest(".chip, .chip-menu")) return;
      event.preventDefault();
      lift(this.title);
    });
    // Renaming in place needs the same exception; it starts from a title click.
    this.list.addEventListener("pointerdown", event => {
      if (this.surface.editing || !(event.target instanceof HTMLElement) || !event.target.closest(".task-title")) return;
      void this.surface.input(true).catch(() => {});
    });
  }

  /** Escape while the composer holds the caret releases the field and keeps the
   *  draft; the shell handles Escape everywhere else. Returns true if handled. */
  escape(): boolean {
    if (document.activeElement !== this.title) return false;
    this.title.blur();
    void this.surface.input(false).catch(() => {});
    return true;
  }
}
