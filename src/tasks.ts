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
import "./tasks.css";

const TABS: { name: ScreenName; icon: TaskIcon; label: string }[] = [
  { name: "home", icon: "home", label: "Home" },
  { name: "today", icon: "today", label: "Today" },
  { name: "media", icon: "media", label: "Media" },
  { name: "calendar", icon: "calendar", label: "Calendar" },
  { name: "system", icon: "system", label: "System" },
];

const app = document.getElementById("task-app")!;
app.innerHTML = `<div id="notch-shell">
  <svg id="island-defs" aria-hidden="true" width="0" height="0"><defs><clipPath id="island-clip" clipPathUnits="userSpaceOnUse"><path id="island-clip-path"/></clipPath></defs></svg>
  <div id="island" role="group" aria-label="Codenotch" aria-expanded="false">
    <div id="island-collapsed"></div>
    <div id="island-expanded" inert>
      <header class="island-head">
        <nav class="island-tabs" role="tablist" aria-label="Island screens"></nav>
        <div class="panel-actions"><button id="pin" class="small-icon" aria-label="Pin the island open" aria-pressed="false" title="Keep open"></button><button id="surface-settings" class="small-icon" aria-label="Island settings" aria-expanded="false" title="Settings"></button><button id="collapse-panel" class="small-icon" aria-label="Collapse the island" title="Collapse"></button></div>
      </header>
      <div id="surface-options" hidden><span>Screen edge</span><div class="edge-choices" role="group" aria-label="Screen edge"><button type="button" data-task-edge="top" aria-pressed="false">Top</button><button type="button" data-task-edge="bottom" aria-pressed="false">Bottom</button><button type="button" data-task-edge="left" aria-pressed="false">Left</button><button type="button" data-task-edge="right" aria-pressed="false">Right</button></div><span>Clock</span><div class="edge-choices" role="group" aria-label="Clock format"><button type="button" data-clock="24" aria-pressed="true">24 h</button><button type="button" data-clock="12" aria-pressed="false">12 h</button></div><span>Tasks showing</span><div class="edge-choices" role="group" aria-label="Task view"><button type="button" data-view="day" aria-pressed="true">Today</button><button type="button" data-view="all" aria-pressed="false">All lists</button></div><p id="shortcut-hint" class="options-hint"></p><button id="account-settings">Accounts &amp; connections &#8599;</button></div>
      <div class="screens">
        <section class="screen active" data-screen="home" role="tabpanel" aria-label="Home"><div class="screen-body home-grid spans" id="home-body"></div></section>
        <section class="screen" data-screen="today" role="tabpanel" aria-label="Today" hidden></section>
        <section class="screen" data-screen="media" role="tabpanel" aria-label="Media" hidden><div class="screen-body scrolls" id="media-body"></div></section>
        <section class="screen" data-screen="calendar" role="tabpanel" aria-label="Calendar" hidden><div class="screen-body scrolls" id="calendar-body"></div></section>
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
paintIcon(get("pin"), "pin");
paintIcon(get("surface-settings"), "settings");
paintIcon(get("collapse-panel"), "close");

const today = new TodayScreen(document.querySelector<HTMLElement>('[data-screen="today"]')!, surface, () => render());
const media = new MediaScreen(get("media-body"), () => render());
const calendar = new CalendarScreen(get("calendar-body"), () => render());
const system = new SystemScreen(get("system-body"), () => render());
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
let agents = 0;
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
    agents,
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

function render() {
  // Every screen renders, not just the visible one: the collapsed pill draws on
  // all three, and a screen that only updated while it was on top would show
  // stale numbers the moment you switched to it.
  today.render();
  media.render();
  calendar.render();
  system.render();
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

    await listen("island:capture", () => {
      show("today");
      surface.pinFor(4000);
      void today.capture();
    });

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
    await listen<{ provider: string; state: string; running: number }[]>("notch:activity", event => {
      agents = event.payload.reduce((n, a) => n + (a.running ?? 0), 0);
      paintPill();
    });
    try {
      const running = await call<{ running: number }[]>("get_activity");
      agents = running.reduce((n, a) => n + (a.running ?? 0), 0);
    } catch { /* the watcher has not reported yet */ }
  }

  show("home");
  await media.boot();
  await calendar.boot();
  await system.boot();

  await watchTasks(value => { today.reconcile(value); today.snapshot = value; render(); });
  try {
    const keys = await call<{ toggle: string; hide: string; capture: string }>("get_shortcuts");
    get("shortcut-hint").textContent =
      `${keys.toggle} opens · ${keys.capture} captures a task · ${keys.hide} hides`;
  } catch { /* the plugin failed to start; the island still works */ }
  render();
  // One second, because the media position and the focus timer both move on
  // that scale. The day's own minute work happens inside the Today screen.
  /* In place, never a redraw: see MediaScreen.tick and renderActivity. The pill
   * is repainted every second because it carries the clock and any running
   * timer; renderActivity reuses its nodes, so this is a few text writes. */
  window.setInterval(() => {
    today.paintTimer();
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
