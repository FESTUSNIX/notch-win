/* The island.
 *
 * One shape welded to a screen edge: a pill showing whatever is most live right
 * now, which grows into a panel of screens. The shell owns the shape, the
 * header, the tabs and which screen is showing; each screen owns its own body.
 */
import { IslandSurface } from "./island-surface";
import { type Edge } from "./layout";
import { paintIcon, type TaskIcon } from "./task-icons";
import { listen } from "@tauri-apps/api/event";
import { call, native, watchTasks } from "./task-client";
import { type TaskView } from "./task-model";
import { pick, renderActivity, renderResting, type Activity, type ScreenName } from "./island-activity";
import { choose, decay, readings, type HoldState, type ModuleContext, type ModuleReading } from "./pill-modules";
import { clockText } from "./tween";
import { nextEvent, startOf } from "./screen-calendar";
import { TodayScreen } from "./screen-today";
import { HomeScreen } from "./screen-home";
import { MediaScreen } from "./screen-media";
import { CalendarScreen } from "./screen-calendar";
import { SystemScreen } from "./screen-system";
import { AgentsScreen } from "./screen-agents";
import * as snooze from "./snooze";
import { Palette, type Action } from "./palette";
import { ShelfScreen } from "./screen-shelf";
import { ReviewScreen } from "./screen-review";
import "./tasks.css";

/* Grouped, not alphabetical, and the order is the argument: what you are
 * doing, what is around you, then the machine and the day behind you. */
const TABS: { name: ScreenName; icon: TaskIcon; label: string }[] = [
  { name: "home", icon: "home", label: "Home" },
  { name: "today", icon: "today", label: "Today" },
  { name: "agents", icon: "agent", label: "Agents" },
  { name: "shelf", icon: "shelf", label: "Shelf" },
  { name: "media", icon: "media", label: "Media" },
  { name: "calendar", icon: "calendar", label: "Calendar" },
  { name: "system", icon: "system", label: "System" },
  { name: "review", icon: "review", label: "Review" },
];

const app = document.getElementById("task-app")!;
app.innerHTML = `<div id="notch-shell">
  <svg id="island-defs" aria-hidden="true" width="0" height="0"><defs><clipPath id="island-clip" clipPathUnits="userSpaceOnUse"><path id="island-clip-path"/></clipPath></defs></svg>
  <div id="island" role="group" aria-label="Codenotch" aria-expanded="false">
    <div id="island-collapsed"></div>
    <div id="drop-veil" aria-hidden="true"><div class="drop-frame"><span class="drop-mark"></span><span class="drop-say">Drop to shelve</span></div></div>
    <div id="island-expanded" inert>
      <header class="island-head">
        <nav class="island-tabs" role="tablist" aria-label="Island screens"></nav>
        <div class="panel-actions"><button id="open-palette" class="small-icon" aria-label="Search and commands" title="Search"></button><button id="pin" class="small-icon" aria-label="Pin the island open" aria-pressed="false" title="Keep open"></button><button id="surface-settings" class="small-icon" aria-label="Island settings" aria-expanded="false" title="Settings"></button><button id="collapse-panel" class="small-icon" aria-label="Collapse the island" title="Collapse"></button></div>
      </header>
      <div id="surface-options" hidden><span>Screen edge</span><div class="edge-choices" role="group" aria-label="Screen edge"><button type="button" data-task-edge="top" aria-pressed="false">Top</button><button type="button" data-task-edge="bottom" aria-pressed="false">Bottom</button><button type="button" data-task-edge="left" aria-pressed="false">Left</button><button type="button" data-task-edge="right" aria-pressed="false">Right</button></div><span>Clock</span><div class="edge-choices" role="group" aria-label="Clock format"><button type="button" data-clock="24" aria-pressed="true">24 h</button><button type="button" data-clock="12" aria-pressed="false">12 h</button></div><span>Tasks showing</span><div class="edge-choices" role="group" aria-label="Task view"><button type="button" data-view="day" aria-pressed="true">Today</button><button type="button" data-view="all" aria-pressed="false">All lists</button></div><p id="snoozed-line" class="options-hint" hidden></p><p id="shortcut-hint" class="options-hint"></p><button id="account-settings">Accounts &amp; connections &#8599;</button></div>
      <div class="screens">
        <section class="screen active" data-screen="home" role="tabpanel" aria-label="Home"><div class="screen-body home-grid spans" id="home-body"></div></section>
        <section class="screen" data-screen="today" role="tabpanel" aria-label="Today" hidden></section>
        <section class="screen" data-screen="media" role="tabpanel" aria-label="Media" hidden><div class="screen-body scrolls" id="media-body"></div></section>
        <section class="screen" data-screen="calendar" role="tabpanel" aria-label="Calendar" hidden><div class="screen-body scrolls" id="calendar-body"></div></section>
        <section class="screen" data-screen="agents" role="tabpanel" aria-label="Agents" hidden><div class="screen-body scrolls" id="agents-body"></div></section>
        <section class="screen" data-screen="shelf" role="tabpanel" aria-label="Shelf" hidden><div class="screen-body scrolls" id="shelf-body"></div></section>
        <section class="screen" data-screen="review" role="tabpanel" aria-label="Review" hidden><div class="screen-body review-grid spans" id="review-body"></div></section>
        <section class="screen" data-screen="system" role="tabpanel" aria-label="System" hidden><div class="screen-body sys-grid spans" id="system-body"></div></section>
      </div>
    </div>
  </div>
</div>`;

const get = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const collapsedLayer = get("island-collapsed");
let screen: ScreenName = "home";
/* Read back from the config at boot rather than defaulted here, so the pill
 * cannot paint once in the wrong format before the answer arrives. */
let clock24 = true;

function paintClockChoice() {
  for (const button of document.querySelectorAll<HTMLElement>("[data-clock]")) {
    button.setAttribute("aria-pressed", String((button.dataset.clock === "24") === clock24));
  }
}

const surface = new IslandSurface(open => { if (open) render(); });
paintIcon(get("open-palette"), "search");
paintIcon(get("pin"), "pin");
paintIcon(get("surface-settings"), "settings");
paintIcon(get("collapse-panel"), "close");

const today = new TodayScreen(document.querySelector<HTMLElement>('[data-screen="today"]')!, surface, () => render());
const media = new MediaScreen(get("media-body"), () => render());
const calendar = new CalendarScreen(get("calendar-body"), () => render());
const system = new SystemScreen(get("system-body"), () => render());
const agentsScreen = new AgentsScreen(get("agents-body"), () => render());
const shelf = new ShelfScreen(get("shelf-body"), () => render());
/* One surface over everything. See palette.ts on why it is not trying to be
 * Flow Launcher: this searches the island's OWN world — the shelf, the live
 * sessions, today's tasks — which a general launcher cannot see. */
const palette = new Palette(surface, () => render());
const review = new ReviewScreen(get("review-body"), { today, calendar });
const home = new HomeScreen(get("home-body"), { today, media, calendar, open: name => show(name) });

/* ── Tabs ─────────────────────────────────────────────────────────────────
 * A rail at the bottom rather than a strip under the header: the header
 * already carries the title and three controls, and putting the switch at the
 * far edge keeps the top of the panel for what the screen is actually saying. */
const tabRail = document.querySelector<HTMLElement>(".island-tabs")!;
for (const tab of TABS) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "island-tab";
  button.dataset.tab = tab.name;
  button.setAttribute("role", "tab");
  button.setAttribute("aria-label", tab.label);
  button.title = tab.label;
  paintIcon(button, tab.icon);
  const label = document.createElement("span");
  label.textContent = tab.label;
  button.append(label);
  button.onclick = () => show(tab.name);
  tabRail.append(button);
}

function show(name: ScreenName) {
  screen = name;
  // Volume, brightness and the device lists are read when the screen is
  // opened — see screen-system.ts on why none of it is polled.
  if (name === "system") void system.load();
  if (name === "review") void review.load().then(() => render());
  for (const section of document.querySelectorAll<HTMLElement>(".screen")) {
    const active = section.dataset.screen === name;
    section.classList.toggle("active", active);
    section.hidden = !active;
  }
  for (const button of document.querySelectorAll<HTMLElement>(".island-tab")) {
    button.setAttribute("aria-selected", String(button.dataset.tab === name));
  }
  render();
}

/* ── The resting pill ─────────────────────────────────────────────────────
 *
 * The date, the time, and one module. Built by the shell rather than by a
 * screen: nothing "owns" the time, and letting Today claim the pill whenever it
 * had nothing better to say made the default state of the whole app a fraction,
 * which is not what you want from a strip you glance at fifty times a day.
 *
 * ⚠️ No ring and no permanent tally. At rest the strip is on screen all day and
 * every mark on it is one you look past to read the time; the ring drew a
 * progress meter for a number that is 0/0 on any day nothing is due. The tally
 * is back as a *module*, which means it appears when there is a day to report
 * and yields the space when there is not.
 */

/** What the machine last said. Polled here rather than by the System screen,
 *  which reads it only when opened — a threshold module cannot wait for that.
 *  ⚠️ It also fixes a first-read quirk: `cpu_percent` needs a previous sample
 *  and returns -1 without one, so the figure was always -1 the first time the
 *  screen was opened and correct every time after. */
let machine: ModuleContext["machine"] = null;
let weather: ModuleContext["weather"] = null;
/** When the current rotation started. Reset when the set of things worth
 *  saying changes, so a new arrival is seen rather than waited for. */
let rotationFrom = Date.now();
let rotationKey = "";
/** When each holding reading last became news. See `decay`: severity decides
 *  whether something *can* own the strip, time decides how long it does. */
let held: HoldState = {};

function moduleContext(): ModuleContext {
  const now = new Date();
  const feed = calendar.feed;
  const next = feed.connected ? nextEvent(feed.events, now) : null;
  return {
    now,
    machine,
    weather,
    // Read off the screen that owns the sessions rather than kept a second
    // time here; one fact, one home.
    agents: agentsScreen.sessions.filter(s => s.state === "working").length,
    quiet: ["disk", "cpu", "memory", "agents", "event", "tasks", "weather"]
      .filter(id => snooze.isQuiet(`module:${id}`)),
    nextEvent: next
      ? { minutes: (startOf(next).getTime() - now.getTime()) / 60000, title: next.title }
      : null,
    tasks: { ...today.tally(), view: today.shownView },
  };
}

function restingModule(): ModuleReading | null {
  const now = Date.now();
  const decayed = decay(readings(moduleContext()), held, now);
  held = decayed.held;
  const all = decayed.readings;
  // The key is what is *available*, not what is showing. A module arriving or
  // falling silent restarts the rotation so the new thing is seen now; the
  // same set carrying on keeps its place in the cycle.
  const key = all.map(r => r.id).join(",");
  if (key !== rotationKey) {
    rotationKey = key;
    rotationFrom = now;
  }
  return choose(all, now - rotationFrom);
}

function restingClaim(): Activity {
  return {
    priority: 0,
    screen: "today",
    kind: "clock",
    label: clockText(new Date(), clock24),
    value: "",
  };
}

/* A one-off line the pill carries for a few seconds.
 *
 * For anything that changes the island out from under you. Moving it to
 * another display is the only such thing today, and it needs saying: the
 * island is click-through chrome welded to a bezel, so sent to a screen you
 * were not looking at it reads as having vanished rather than moved.
 *
 * Priority 90, above every screen: it is the direct consequence of a key that
 * was just pressed, and it stops mattering on its own. */
let notice: { label: string; value: string; until: number } | null = null;
const NOTICE_MS = 4000;

function say(label: string, value: string) {
  notice = { label, value, until: Date.now() + NOTICE_MS };
  render();
  window.setTimeout(() => {
    // Checked rather than assumed: a second notice inside the window replaces
    // the first, and this timer must not clear the newer one.
    if (notice && Date.now() >= notice.until) {
      notice = null;
      render();
    }
  }, NOTICE_MS + 100);
}

function noticeClaim(): Activity | null {
  if (!notice) return null;
  if (Date.now() >= notice.until) {
    notice = null;
    return null;
  }
  return {
    priority: 90,
    screen: "system",
    kind: "day",
    icon: "system",
    label: notice.label,
    value: notice.value,
  };
}

function claims(): (Activity | null)[] {
  return [
    noticeClaim(),
    agentsScreen.activity(),
    system.activity(),
    today.activity(),
    media.activity(),
    calendar.activity(),
    restingClaim(),
  ];
}

/** Draw the collapsed pill: the live claim if there is one, the resting three
 *  slots otherwise. Split because at rest the pill is not one claim with its
 *  parts blank — it is three independent things sharing a strip. */
function paintPill(live = claims()) {
  const best = pick(live);
  if (best && best.priority > 0) {
    renderActivity(collapsedLayer, best);
    return;
  }
  const now = new Date();
  renderResting(collapsedLayer, {
    day: String(now.getDate()),
    month: now.toLocaleDateString(undefined, { month: "short" }).toUpperCase(),
    time: clockText(now, clock24),
    module: restingModule(),
  });
}

/** ⚠️ Said out loud, with a way back. The failure mode of a mute button is
 *  forgetting you pressed it and then wondering for a week why the app stopped
 *  telling you things. */
function paintSnoozed() {
  const line = document.getElementById("snoozed-line");
  if (!line) return;
  const quiet = snooze.count();
  line.hidden = quiet === 0;
  if (!quiet) return;
  line.replaceChildren();
  line.append(`${quiet} thing${quiet === 1 ? "" : "s"} snoozed \u00b7 `);
  const back = document.createElement("button");
  back.type = "button";
  back.className = "snooze-clear";
  back.textContent = "bring back";
  back.onclick = () => { void snooze.wake(); };
  line.append(back);
}

function render() {
  // Every screen renders, not just the visible one: the collapsed pill draws on
  // all three, and a screen that only updated while it was on top would show
  // stale numbers the moment you switched to it.
  today.render();
  media.render();
  calendar.render();
  system.render();
  agentsScreen.render();
  shelf.render();
  review.render();
  home.render();

  const live = claims();
  paintPill(live);
  /* A dot on the tab whose screen has something live. The pill can only say one
   * thing at a time; this is how the other two say "there is something here"
   * without competing for those 200 pixels. Resting claims (the day's own
   * tally) do not count — every tab would wear a dot forever. */
  const lit = new Set(live.filter(c => c && c.priority > 5).map(c => c!.screen));
  for (const button of document.querySelectorAll<HTMLElement>(".island-tab")) {
    button.classList.toggle("live", lit.has(button.dataset.tab as ScreenName));
  }
  surface.measure();
}

get("island-expanded").prepend(palette.element());
/* Reachable without knowing the shortcut. ⚠️ It does NOT pin — see
 * Palette.show: the pin is a user-facing latch, and three callers toggling it
 * around one open left the island stuck open. Holding the panel is `editing`'s
 * job. */
get("open-palette").onclick = () => { void palette.show(); };

/* ── What the palette can do ──────────────────────────────────────────────
 * Each provider answers with actions; the palette ranks across all of them.
 * A new screen adds its commands by exporting a list, not by editing the
 * palette. */

palette.add(() => TABS.map(tab => ({
  id: `go:${tab.name}`,
  title: tab.label,
  keywords: "go screen open",
  hint: "Go",
  icon: tab.icon,
  run: () => { show(tab.name); surface.pinFor(6000); },
})));

palette.add(() => {
  const acts: Action[] = [
    { id: "cmd:capture", title: "Add a task", keywords: "new todo create capture",
      icon: "plus", hint: "Do", run: () => { show("today"); surface.pinFor(6000); void today.capture(); } },
    { id: "cmd:editor", title: "Accounts & connections", keywords: "settings ticktick google weather",
      icon: "settings", hint: "Do", run: () => { void today.action("open_task_editor"); } },
    { id: "cmd:log", title: "Open log", keywords: "debug diagnose trouble",
      icon: "note", hint: "Do", run: () => { void call("open_log").catch(() => {}); } },
    { id: "cmd:display", title: "Move to next display", keywords: "monitor screen",
      icon: "system", hint: "Do", run: () => { void call("next_display", { label: "tasks" }).catch(() => {}); } },
    { id: "cmd:hide", title: "Hide the chrome", keywords: "dismiss away present",
      icon: "close", hint: "Do", run: () => { void call("toggle_chrome").catch(() => {}); } },
    { id: "cmd:clock", title: clock24 ? "Use a 12-hour clock" : "Use a 24-hour clock",
      keywords: "time format", icon: "clock", hint: "Do",
      run: () => {
        clock24 = !clock24;
        paintClockChoice();
        paintPill();
        void call("set_clock_format", { clock24 }).catch(() => {});
      } },
  ];
  if (snooze.count()) {
    acts.push({ id: "cmd:unsnooze", title: "Bring back what is snoozed",
      note: `${snooze.count()} quiet`, keywords: "unmute wake",
      icon: "snooze", hint: "Do", run: () => { void snooze.wake(); } });
  }
  return acts;
});

/* The island's own world, which is the part a general launcher cannot see. */
palette.add(() => shelf.items.flatMap(item => {
  const rows: Action[] = [{
    id: `shelf:copy:${item.id}`,
    title: item.name,
    note: item.missing ? "moved or deleted" : "copy to the clipboard",
    keywords: "shelf file paste",
    icon: item.kind === "link" ? "link" : item.kind === "text" ? "note" : "file",
    hint: "Shelf",
    run: () => { void call(item.missing ? "shelf_remove" : "shelf_copy", { id: item.id }).catch(() => {}); },
  }];
  if (!item.missing) {
    rows.push({
      id: `shelf:open:${item.id}`, title: `Open ${item.name}`,
      keywords: "shelf launch", icon: "open", hint: "Shelf",
      run: () => { void call("shelf_open", { id: item.id }).catch(() => {}); },
    });
  }
  return rows;
}));

palette.add(() => agentsScreen.sessions.map(session => ({
  id: `agent:${session.id}`,
  title: session.project,
  note: session.state === "waiting" ? "waiting for you" : session.state,
  keywords: `agent claude session ${session.branch ?? ""}`,
  icon: "agent",
  hint: "Agents",
  run: () => { void call("focus_session", { pid: session.pid }).catch(() => {}); },
})));

palette.add(() => today.upNext(20).map(task => ({
  id: `task:${task.projectId}:${task.id}`,
  title: task.title || "Untitled task",
  note: "complete",
  keywords: "task todo done tick",
  icon: "check",
  hint: "Today",
  run: () => { today.finish(task); },
})));

/* ⚠️ Last, and only when nothing else matched well: the palette is a way to
 * reach things, and a "create" row that shows up for every stray keystroke
 * turns every mistyped search into an accidental task. */
palette.add(query => {
  if (query.length < 3) return [];
  return [{
    id: "make:task",
    title: `Add task "${query}"`,
    keywords: "new create todo",
    icon: "plus",
    hint: "New",
    run: () => {
      show("today");
      surface.pinFor(8000);
      void today.capture(query);
    },
  }];
});

/* ── Controls ─────────────────────────────────────────────────────────── */
get("pin").onclick = () => surface.pin();
get("collapse-panel").onclick = () => { void surface.collapse(); };
get("account-settings").onclick = () => today.action("open_task_editor");
get("surface-settings").onclick = () => {
  const options = get("surface-options");
  options.hidden = !options.hidden;
  get("surface-settings").setAttribute("aria-expanded", String(!options.hidden));
  surface.measure();
};
/* Clicking the pill opens the island and nothing else.
 *
 * It deliberately does NOT jump to the screen the pill is describing. Hover
 * opens the island before any click can land, so that navigation would fire on
 * a pointer merely crossing the pill; and with music playing for an afternoon
 * the pill's claim is Media all afternoon, which would mean the task list — the
 * reason this thing exists — was never what opening it showed. The tab dot
 * points at the live screen instead, and the tabs do the moving. */
collapsedLayer.addEventListener("click", () => { if (!surface.open) surface.toggle(); });
document.querySelectorAll<HTMLButtonElement>("[data-task-edge]").forEach(button => button.onclick = async () => {
  const edge = button.dataset.taskEdge as Edge;
  if (await today.action("set_task_placement", { edge, visible: true, reset: false })) await surface.place(edge);
});
document.querySelectorAll<HTMLButtonElement>("[data-clock]").forEach(button => button.onclick = () => {
  clock24 = button.dataset.clock === "24";
  paintClockChoice();
  // Painted before the round-trip, not after: the change is a button the user
  // just pressed, and waiting on a disk write to show it reads as a dropped
  // click. The config is the record, not the source the pill reads from.
  paintPill();
  void call("set_clock_format", { clock24 }).catch(() => {});
});
document.querySelectorAll<HTMLButtonElement>("[data-view]").forEach(button => button.onclick = () => {
  document.querySelectorAll("[data-view]").forEach(b => b.setAttribute("aria-pressed", String(b === button)));
  today.setView(button.dataset.view as TaskView);
});

/* ── Changing screens with a wheel ────────────────────────────────────────
 * A wheel anywhere in the panel changes screen, UNLESS the pointer is over
 * something that can actually scroll — then the scroll belongs to that list.
 *
 * ⚠️ Not "the tab rail only", which was the first version: the island is a
 * different height on each screen, so switching moves the rail out from under
 * the pointer and the next flick lands on whatever slid into its place and
 * does nothing. Measured — the rail dropped 71px going from Home to Today.
 * "Can this thing under me scroll?" needs no aiming at all. */
let lastSwitch = 0;
function cycle(direction: number) {
  const now = Date.now();
  // One flick must not run through every tab.
  if (!direction || now - lastSwitch < 260) return;
  lastSwitch = now;
  const index = TABS.findIndex(t => t.name === screen);
  show(TABS[(index + direction + TABS.length) % TABS.length].name);
}

function scrollableUnder(target: EventTarget | null, within: HTMLElement): boolean {
  let node = target instanceof HTMLElement ? target : null;
  while (node && node !== within.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if ((overflow === "auto" || overflow === "scroll") && node.scrollHeight > node.clientHeight + 1) {
      return true;
    }
    node = node.parentElement;
  }
  return false;
}

get("island-expanded").addEventListener("wheel", event => {
  const horizontal = Math.abs(event.deltaX) > Math.abs(event.deltaY);
  if (!horizontal && scrollableUnder(event.target, get("island-expanded"))) return;
  event.preventDefault();
  cycle(Math.sign(horizontal ? event.deltaX : event.deltaY));
}, { passive: false });

window.addEventListener("blur", () => { void surface.input(false).catch(() => {}); });
document.addEventListener("keydown", event => {
  // The palette owns its own keys while it is up and stops them there, so
  // reaching here at all means it is closed.
  if (palette.open) return;
  if (event.key === "Escape") {
    event.preventDefault();
    if (today.escape()) return;
    void surface.collapse();
    return;
  }
  // Tab through screens without the mouse while the island has focus.
  if ((event.ctrlKey || event.metaKey) && event.key === "Tab") {
    event.preventDefault();
    const index = TABS.findIndex(t => t.name === screen);
    show(TABS[(index + (event.shiftKey ? TABS.length - 1 : 1)) % TABS.length].name);
  }
});

/* ── Dragging ──────────────────────────────────────────────────────────────
 * Only from the pill and the header. The rest of the expanded island is
 * content, and a drag that starts on a task row would fight every click. */
let dragStart: { x: number; y: number } | null = null;
let dragged = false;
for (const handle of [collapsedLayer, document.querySelector<HTMLElement>(".island-head")!]) {
  handle.addEventListener("pointerdown", event => {
    if (event.button === 0) { dragStart = { x: event.screenX, y: event.screenY }; dragged = false; }
  });
  handle.addEventListener("pointermove", event => {
    if (dragStart && Math.hypot(event.screenX - dragStart.x, event.screenY - dragStart.y) > 5) {
      dragStart = null; dragged = true; call("drag_begin").catch(() => {});
    }
  });
  handle.addEventListener("click", event => {
    if (dragged) { event.preventDefault(); event.stopImmediatePropagation(); dragged = false; }
  }, true);
}
window.addEventListener("pointerup", () => { dragStart = null; });

async function boot() {
  await surface.boot();
  if (native) {
    // Which display it landed on, said by the pill itself.
    await listen<string>("island:moved", event => say("Moved to", event.payload));

    /* The shelf shortcut deliberately does not open the island: the point is
     * to park something without leaving what you are in. The pill is the
     * whole acknowledgement. */
    await listen<string>("island:shelved", event => say("Shelved", event.payload));
    await listen<string>("island:shelved-failed", event => say("Nothing to shelf", event.payload));

    await listen("island:capture", () => {
      show("today");
      surface.pinFor(4000);
      void today.capture();
    });

    /* One surface over everything. ⚠️ No pin here either — this listener
     * was the first of the three that latched it. */
    await listen("island:palette", () => { void palette.show(); });

    // Kept in step if the format is changed from another window.
    // ⚠️ Inside the `native` guard with every other listener here. Outside it,
    // `listen` rejects in the browser preview and takes the rest of boot()
    // with it — no screens render at all, and the only symptom is an empty
    // island with nothing in the console.
    await listen<{ clock24: boolean }>("tasks:placement", event => {
      clock24 = event.payload.clock24;
      paintClockChoice();
      paintPill();
    });
  }
  try {
    const placement = await call<{ clock24: boolean }>("get_task_placement");
    if (typeof placement.clock24 === "boolean") clock24 = placement.clock24;
  } catch { /* the default stands */ }
  paintClockChoice();

  /* ── Feeding the pill's modules ─────────────────────────────────────────
   * Three sources on three rhythms, none of them a screen: a module has to be
   * able to speak while its screen has never been opened.
   *
   * ⚠️ The machine is polled here rather than by the System screen, which
   * reads it only when opened. A threshold module cannot wait for that, and
   * `cpu_percent` needs a previous sample to answer at all — so this also
   * fixes the -1 the System screen used to show the first time it was opened. */
  const readMachine = async () => {
    try {
      machine = await call<{ cpu: number; memory: number; diskUsed: number; diskFree: number }>("get_machine");
    } catch { /* keep the last good reading rather than blanking a warning */ }
  };
  void readMachine();
  window.setInterval(() => { void readMachine(); }, 15000);

  try {
    weather = await call<typeof weather>("get_weather");
  } catch { /* no place configured, or the first poll has not landed */ }
  if (native) {
    await listen<typeof weather>("notch:weather", event => {
      weather = event.payload;
      paintPill();
    });
    await listen("notch:sessions", () => paintPill());
  }

  show("home");
  await media.boot();
  await calendar.boot();
  await system.boot();
  await agentsScreen.boot();
  await snooze.boot(() => { paintSnoozed(); render(); });
  paintSnoozed();

  /* ── Dropping a file on the island ──────────────────────────────────────
   *
   * ⚠️ Three mechanisms were tried before this one, and the symptom that
   * settled it was the **no-drop cursor**: a file held over the island showed
   * the circle-slash, which means the window *was* being targeted and
   * something was refusing. Not the shell walking past it.
   *
   *   1. Tauri's `tauri://drag-*` events: never fired once, for any real drag.
   *   2. `DragAcceptFiles` + `WM_DROPFILES` on the window (`dropfiles.rs`):
   *      provable by posting the message by hand, and never reached by a real
   *      drag either — an OLE drop target on WebView2's own child window is
   *      found first and the parent's shell registration is never consulted.
   *   3. So: let WebView2 have it (`dragDropEnabled: false`) and handle the
   *      drop in the page, which is the one layer that is definitely the
   *      target.
   *
   * The refusal in (2) is also the explanation for the cursor: WebView2 was
   * the target all along and the page was not accepting. */
  /** What a drag is carrying, for the log. The shape of `dataTransfer` under
   *  WebView2 was the open question, so it is written down rather than
   *  assumed. */
  const describe = (transfer: DataTransfer | null) => {
    if (!transfer) return "no dataTransfer";
    const types = [...transfer.types];
    const files = [...transfer.files].map(f => `${f.name}:${f.size}`);
    const uri = types.includes("text/uri-list") ? transfer.getData("text/uri-list") : "";
    return `types=[${types.join(",")}] files=[${files.join(",")}] uri=${JSON.stringify(uri)}`;
  };
  const log = (note: string) => { void call("debug_note", { note }).catch(() => {}); };

  /** Is this drag carrying files, as opposed to selected text or a link?
   *
   * ⚠️ `dataTransfer.files` is EMPTY during dragenter/dragover — the browser
   * withholds the contents until the drop actually happens. `types` is the
   * only thing that can be read early, which is why the decision is made on
   * that rather than on what looks more obvious. */
  const carryingFiles = (transfer: DataTransfer | null) =>
    !!transfer && [...transfer.types].includes("Files");

  /* ── Standing the island open for a drag ────────────────────────────────
   *
   * The pill is the doorway. The island is click-through everywhere else, so
   * a drag cannot be seen until it crosses painted chrome; once it does,
   * WebView2 raises dragenter here, and THEN the whole window can be opened up
   * as a target. That is the difference between this and the Shift gesture it
   * replaced: this knows it is a file.
   *
   * ⚠️ Closed on a timer refreshed by `dragover`, never on `dragleave`. That
   * event fires every time the pointer crosses between child elements — a
   * dozen times on the way across a panel of task rows — so closing on it
   * makes the overlay strobe and the window stop being a target mid-drag. */
  let dragTimer: number | undefined;
  let dragOpen = false;

  function openForDrag() {
    window.clearTimeout(dragTimer);
    dragTimer = window.setTimeout(closeForDrag, 220);
    if (dragOpen) return;
    dragOpen = true;
    document.documentElement.classList.add("dragging-files");
    void call("set_drop_zone", { active: true }).catch(() => {});
    if (!surface.open) { show("shelf"); surface.pinFor(12_000); }
  }

  function closeForDrag() {
    window.clearTimeout(dragTimer);
    if (!dragOpen) return;
    dragOpen = false;
    document.documentElement.classList.remove("dragging-files");
    void call("set_drop_zone", { active: false }).catch(() => {});
  }

  for (const name of ["dragenter", "dragover"] as const) {
    window.addEventListener(name, event => {
      if (!carryingFiles(event.dataTransfer)) return;
      // ⚠️ preventDefault on BOTH, or the drop never fires and the cursor stays
      // on the circle-slash. That was the whole original fault.
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      if (name === "dragenter" && !dragOpen) log(`dom dragenter: ${describe(event.dataTransfer)}`);
      openForDrag();
    });
  }

  window.addEventListener("drop", event => {
    event.preventDefault();
    closeForDrag();
    log(`dom drop: ${describe(event.dataTransfer)}`);
    void takeDrop(event.dataTransfer);
  });
  // A drag abandoned outside the window never sends anything more; the timer
  // is what notices.
  window.addEventListener("dragend", closeForDrag);

  /** Get real paths out of a drop, whatever WebView2 is willing to give.
   *
   * ⚠️ A browser `File` has no path, by design. Three routes, cheapest first:
   * a path the host put on the transfer, a `file://` uri-list, and — only if
   * neither — the bytes, written into the app's own folder. The last one
   * **copies**, which the shelf otherwise never does. */
  async function takeDrop(transfer: DataTransfer | null) {
    if (!transfer) return;
    const paths: string[] = [];

    for (const file of [...transfer.files]) {
      const hosted = (file as File & { path?: string }).path;
      if (hosted) paths.push(hosted);
    }
    if (!paths.length && [...transfer.types].includes("text/uri-list")) {
      for (const line of transfer.getData("text/uri-list").split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        if (trimmed.startsWith("file:///")) {
          paths.push(decodeURIComponent(trimmed.slice("file:///".length)));
        }
      }
    }
    if (paths.length) {
      await shelf.dropped(paths);
    } else if (transfer.files.length) {
      for (const file of [...transfer.files]) {
        const bytes = [...new Uint8Array(await file.arrayBuffer())];
        await call("shelf_add_bytes", { name: file.name, bytes }).catch((error: unknown) => {
          shelf.error = String(error);
        });
      }
    } else {
      const text = transfer.getData("text/plain");
      if (!text.trim()) return;
      await call("shelf_add_text", { text }).catch(() => {});
    }
    show("shelf");
    surface.pinFor(4000);
  }

  await shelf.boot();

  await watchTasks(value => { today.reconcile(value); today.snapshot = value; render(); });
  try {
    const keys = await call<{ toggle: string; hide: string; capture: string; palette: string }>("get_shortcuts");
    get("shortcut-hint").textContent =
      `${keys.palette} searches everything · ${keys.toggle} opens · ${keys.capture} adds a task · ${keys.hide} hides`;
  } catch { /* the plugin failed to start; the island still works */ }
  render();
  // One second, because the media position and the focus timer both move on
  // that scale. The day's own minute work happens inside the Today screen.
  /* In place, never a redraw: see MediaScreen.tick and renderActivity. The pill
   * is repainted every second because it carries the clock and any running
   * timer; renderActivity reuses its nodes, so this is a few text writes. */
  window.setInterval(() => {
    today.paintTimer();
    agentsScreen.tick();
    paintPill();
    if (screen === "media") media.tick();
  }, 1000);
  window.setInterval(() => { today.tick(); render(); }, 60000);
}
boot().catch(error => {
  const status = document.getElementById("task-status");
  if (status) status.textContent = String(error);
  surface.show(true);
});
