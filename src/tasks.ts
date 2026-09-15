/* The island.
 *
 * One shape welded to a screen edge: a pill showing whatever is most live right
 * now, which grows into a panel of screens. The shell owns the shape, the
 * header, the tabs and which screen is showing; each screen owns its own body.
 */
import { IslandSurface } from "./island-surface";
import { cpx } from "./layout";
import { paintIcon, type TaskIcon } from "./task-icons";
import { listen } from "@tauri-apps/api/event";
import { call, native, preview, watchTasks } from "./task-client";
import { pick, renderActivity, renderResting, type Activity, type ScreenName } from "./island-activity";
import { choose, decay, readings, type HoldState, type ModuleContext, type ModuleReading } from "./pill-modules";
import { clockText } from "./tween";
import { setMotion } from "./motion-pref";
import { nextEvent, startOf } from "./screen-calendar";
import { TodayScreen } from "./screen-today";
import { HomeScreen } from "./screen-home";
/* ⚠️ Still here, without a screen of its own. The player was in THREE
 * places — the collapsed pill, the Home column, and a whole tab — and the tab
 * was the only one of the three that duplicated what Spotify, a browser and
 * the media keys already do better on a bigger surface. What it keeps is the
 * part nothing else had: the pill saying what is playing at a glance. */
import { MediaScreen, MediaSource } from "./screen-media";
import { CalendarScreen } from "./screen-calendar";
import { SystemScreen } from "./screen-system";
import { AgentsScreen } from "./screen-agents";
import * as snooze from "./snooze";
import * as stars from "./palette-stars";
import * as workspaces from "./workspaces";
import { Palette, TIER, type Action } from "./palette";
import { paintTools, type ScreenTools } from "./screen-tools";
import { iconFor } from "./file-kind";
import { calc } from "./palette-calc";
import { ShelfScreen } from "./screen-shelf";
import { ReviewScreen } from "./screen-review";
import "./tasks.css";

/* Grouped, not alphabetical, and the order is the argument: what you are
 * doing, what is around you, then the machine and the day behind you. */
const TABS: { name: ScreenName; icon: TaskIcon; label: string }[] = [
  { name: "home", icon: "home", label: "Home" },
  { name: "today", icon: "today", label: "Today" },
  /* ⚠️ The player's tab exists only while something is playing — see
   * `paintMediaTab`. It was removed for being a permanent tab holding a title
   * and three buttons; it earns one again now that it carries the playhead and
   * the queue, but only while there is something to carry. */
  { name: "media", icon: "media", label: "Playing" },
  { name: "agents", icon: "agent", label: "Agents" },
  { name: "shelf", icon: "shelf", label: "Shelf" },
  { name: "calendar", icon: "calendar", label: "Calendar" },
  { name: "system", icon: "system", label: "System" },
  { name: "review", icon: "review", label: "Review" },
];

/* ── The player's two widths ────────────────────────────────────────
 * ⚠️ Derived from the grid in tasks.css, never chosen. `.media-body` is a
 * 500px player track beside a 260px queue track with a 14px gap, inside
 * `--screen-pad` of 15 a side — and the island's body has to come to exactly
 * that. A design pixel is 56/117 of a CSS one (`cpx`), so this is the inverse.
 *
 * Get them out of step and one of two things happens, both of which look like
 * an animation bug rather than a number: the player stops being centred in the
 * shape, or the queue is clipped by the bezel on the way in. */
const dpx = (css: number) => Math.round(css * 117 / 56);
const PLAYER_ONLY = dpx(500 + 2 * 15);
const PLAYER_AND_QUEUE = dpx(500 + 2 * 15 + 14 + 260);

/** How wide each screen wants to be, in DESIGN pixels — `cpx()` converts.
 *
 * ⚠️ A panel is only as wide as what is in it. One width for everything meant
 * a column of one-line tasks laid out across 909 CSS px with two thirds of the
 * row empty, which reads as a window somebody left open rather than as a notch.
 * The machinery already existed: `capBody` is what narrows the panel for the
 * palette.
 *
 * ⚠️ Horizontal edges only, and `capBody` enforces that. On a left or right
 * edge the "body" is the panel's HEIGHT, and capping that cuts the list short
 * instead of making it narrower.
 *
 * 1900 design px is the full body (~909 CSS px); anything smaller is a choice
 * about content, not about the shape. */
const WIDTH: Record<ScreenName, number> = {
  home: 1900,      // three cards side by side
  today: 1420,     // one column of rows, and the composer under it
  /* ⚠️ The player has TWO widths — see `widthOf` — and both are DERIVED from
   * the grid in tasks.css rather than picked. `.media-body` is a 500px player
   * track and a 260px queue track with a 14px gap, inside `--screen-pad` of
   * 15 a side; the island's body has to be exactly that, or the player is no
   * longer centred and the queue is clipped by the bezel. */
  media: PLAYER_ONLY,
  agents: 1620,    // rows carrying project, branch, tokens and a verb
  shelf: 1480,     // rows with a thumbnail and a path
  calendar: 1900,  // the week grid needs seven columns
  system: 1900,    // a bento
  review: 1480,    // a few stacked cards
};

/** What the panel should be, allowing for a screen that changes its own mind.
 *
 * ⚠️ The open queue asks for the FULL body, not more. `measure()` clamps the
 * cap to `islandBodyLong`, so a number above it is silently the same as the
 * number at it — which looks, from a test, exactly like the width not changing
 * at all. */
function widthOf(name: ScreenName): number {
  if (name === "media" && player.open) return PLAYER_AND_QUEUE;
  return WIDTH[name];
}

const app = document.getElementById("task-app")!;
app.innerHTML = `<div id="notch-shell">
  <svg id="island-defs" aria-hidden="true" width="0" height="0"><defs><clipPath id="island-clip" clipPathUnits="userSpaceOnUse"><path id="island-clip-path"/></clipPath></defs></svg>
  <div id="island" role="group" aria-label="Codenotch" aria-expanded="false">
    <div id="island-collapsed"></div>
    <div id="drop-veil" aria-hidden="true"><div class="drop-frame"><span class="drop-mark"></span><span class="drop-say">Drop to shelve</span></div></div>
    <div id="island-expanded" inert>
      <header class="island-head">
        <nav class="island-tabs" role="tablist" aria-label="Island screens"></nav>
        <div class="screen-tools" id="screen-tools"></div>
        <div class="panel-actions"><button id="open-palette" class="small-icon" aria-label="Search and commands" title="Search"></button><button id="pin" class="small-icon" aria-label="Pin the island open" aria-pressed="false" title="Keep open"></button><button id="surface-settings" class="small-icon" aria-label="Settings" title="Settings"></button><button id="collapse-panel" class="small-icon" aria-label="Collapse the island" title="Collapse"></button></div>
      </header>
      <div class="screens">
        <section class="screen active" data-screen="home" role="tabpanel" aria-label="Home"><div class="screen-body home-grid spans" id="home-body"></div></section>
        <section class="screen" data-screen="today" role="tabpanel" aria-label="Today" hidden></section>
        <section class="screen" data-screen="media" role="tabpanel" aria-label="Playing" hidden><div class="screen-body media-body spans" id="media-body"></div></section>
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

/* ── Preferences ────────────────────────────────────────────
 * Everything the settings window can change, read once at boot and again every
 * time that window writes.
 *
 * ⚠️ Applied LIVE. The settings window is a different window, so a preference
 * the island only picked up on its next restart would be a settings screen that
 * looks broken — you change the accent, nothing happens, you change it back.
 */
interface Prefs {
  accent: string;
  weekStartsMonday: boolean;
  fahrenheit: boolean;
  openOnHover: boolean;
  foldDelayMs: number;
  motion: string;
  panelWidth: number;
  useEverything: boolean;
  indexApps: boolean;
  mutedModules: string[];
  thresholds: Record<string, number>;
  taskView: string;
}

let prefs: Prefs = {
  accent: "#00ff88", weekStartsMonday: true, fahrenheit: false, openOnHover: true, foldDelayMs: 450,
  motion: "system", panelWidth: 0, useEverything: true, indexApps: true,
  mutedModules: [], thresholds: {}, taskView: "day",
};

/* ⚠️ A FOLD CLOSES THE PALETTE, and it has to.
 *
 * The palette held the panel open through `editing`, which `input(true)` sets —
 * but `input` can fail (Windows refuses the foreground), and `pinFor`'s timer
 * expires either way. So the island could fold with the palette still `open`:
 * the host was never hidden, the shortcut hit `show()`'s "already open" branch
 * and did nothing, and hovering the island brought back a palette that had
 * never been given the caret — visible, and impossible to type in or click.
 * Folding is the one signal that covers every route into that state. */
const surface = new IslandSurface(open => {
  if (open) render();
  else if (palette.open) void palette.hide();
});
paintIcon(get("open-palette"), "search");
paintIcon(get("pin"), "pin");
paintIcon(get("surface-settings"), "settings");
paintIcon(get("collapse-panel"), "close");

const today = new TodayScreen(document.querySelector<HTMLElement>('[data-screen="today"]')!, surface, () => render());
const media = new MediaSource(() => render());
const calendar = new CalendarScreen(get("calendar-body"), () => render(), {
  create: (title, day, list) => {
    void today.createOn(title, day, list).then(why => { if (why) say("Could not add", why); });
  },
  lists: () => today.lists(),
  focus: active => surface.input(active),
});
const system = new SystemScreen(get("system-body"), () => render());
const agentsScreen = new AgentsScreen(get("agents-body"), () => render());
const shelf = new ShelfScreen(get("shelf-body"), () => render());
/* One surface over everything. See palette.ts on why it is not trying to be
 * Flow Launcher: this searches the island's OWN world — the shelf, the live
 * sessions, today's tasks — which a general launcher cannot see. */
/* ⚠️ The third argument is new and it matters: the palette closes BEFORE an
 * action runs, so a failure has nowhere to show itself. Every action used to
 * end in `.catch(() => {})` — a file that had moved, an app whose shortcut was
 * stale, a session that had exited all did nothing and said nothing. They throw
 * now, and this turns the throw into the pill's own notice. */
const palette = new Palette(surface, () => {
    /* ⚠️ The screen's own width, given back. The palette narrows the panel
     * while it is up; what it hands back has to be what the screen underneath
     * asked for, or every search leaves the island stuck at its full width. */
    surface.capBody(cpx(widthOf(screen)));
    render();
  },
  (what, why) => say(`${what} failed`, why.replace(/^invoke error: /i, "").slice(0, 120)));
const player = new MediaScreen(get("media-body"), {
  source: media,
  /* ⚠️ Asked for, so it springs. The queue opening is the clearest case there
   * is of a size change you pressed a button for. */
  width: () => { surface.capBody(cpx(widthOf("media"))); surface.deliberately(); },
}, () => render());
const review = new ReviewScreen(get("review-body"), { today, calendar });
const home = new HomeScreen(get("home-body"), { today, media, calendar, open: name => show(name) });

/* ── Tabs ─────────────────────────────────────────────────────────────────
 * A rail at the bottom rather than a strip under the header: the header
 * already carries the title and three controls, and putting the switch at the
 * far edge keeps the top of the panel for what the screen is actually saying. */
const tabRail = document.querySelector<HTMLElement>(".island-tabs")!;
const screens = document.querySelector<HTMLElement>(".screens")!;
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

/* The pill the selection rides on. A sibling of the tabs, not a child of one. */
const tabGlide = document.createElement("span");
tabGlide.className = "tab-glide";
tabGlide.setAttribute("aria-hidden", "true");
tabRail.append(tabGlide);

/** The gap between a tab's icon and its caption, and between tabs. Both are in
 *  the stylesheet; they are here because the geometry below is arithmetic. */
const LABEL_GAP = 7;
const TAB_GAP = 2;

/** How wide a tab will be once it is captioned, or once it is not.
 *
 * ⚠️ Computed, never measured. At the moment of a click the labels are mid
 * transition, so every width on screen is a width that is on its way somewhere
 * — measuring one gives the pill a target that was true a frame ago. The
 * label's `scrollWidth` reports its full text width whatever its animated
 * `max-width` happens to be, which is what makes this knowable up front. */
function tabWidth(tab: HTMLElement, captioned: boolean): number {
  const label = tab.querySelector<HTMLElement>("span");
  if (!label) return tab.offsetWidth;
  const showing = label.offsetWidth + parseFloat(getComputedStyle(label).marginLeft || "0");
  const wanted = captioned ? label.scrollWidth + LABEL_GAP : 0;
  return tab.offsetWidth - showing + wanted;
}

/**
 * Put the pill under the selected tab, and set each label to its own width.
 *
 * ⚠️ The position is summed from the left rather than read off the tab. A tab
 * BEFORE the selected one is shrinking as this runs — that is the tab being
 * left — so `offsetLeft` is measured against a strip that is still moving.
 */
function placeGlide(animate: boolean) {
  const tabs = [...tabRail.querySelectorAll<HTMLElement>(".island-tab")];
  const at = tabs.find(tab => tab.getAttribute("aria-selected") === "true");
  if (!at) { tabGlide.classList.remove("is-placed"); return; }

  for (const tab of tabs) {
    const label = tab.querySelector<HTMLElement>("span");
    if (label) label.style.maxWidth = tab === at ? `${label.scrollWidth}px` : "0px";
  }

  let x = tabs[0]?.offsetLeft ?? 0;
  for (const tab of tabs) {
    if (tab === at) break;
    x += tabWidth(tab, false) + TAB_GAP;
  }
  if (!animate) tabGlide.style.transition = "none";
  tabGlide.style.width = `${tabWidth(at, true)}px`;
  tabGlide.style.transform = `translateX(${x - (tabs[0]?.offsetLeft ?? 0)}px)`;
  tabGlide.style.left = `${tabs[0]?.offsetLeft ?? 0}px`;
  tabGlide.classList.add("is-placed");
  if (!animate) requestAnimationFrame(() => { tabGlide.style.transition = ""; });
}

/* ⚠️ Observed, not placed once. The strip's widths move for reasons this file
 * cannot see — the font finishing loading, the island changing edge, the panel
 * narrowing for the palette — and a pill left at a stale width after any of
 * them is visibly wrong until the next click. */
if (typeof ResizeObserver !== "undefined") {
  new ResizeObserver(() => placeGlide(false)).observe(tabRail);
}

/** How long a leaving screen is kept on screen. Must match `screen-out`. */
const SCREEN_EXIT_MS = 150;

function show(name: ScreenName) {
  const from = screen;
  screen = name;
  // Volume, brightness and the device lists are read when the screen is
  // opened — see screen-system.ts on why none of it is polled.
  if (name === "system") void system.load();
  if (name === "review") void review.load().then(() => render());
  /* The direction the selection travelled, so the new screen arrives from the
   * side it sits on. ⚠️ Taken from the TAB ORDER, not from the order screens
   * were opened in — the strip is what you are looking at while this happens. */
  const was = TABS.findIndex(tab => tab.name === from);
  const now = TABS.findIndex(tab => tab.name === name);
  const moving = from !== name && was >= 0 && now >= 0;
  screens.style.setProperty("--dir", String(moving && now < was ? -1 : 1));

  for (const section of document.querySelectorAll<HTMLElement>(".screen")) {
    const active = section.dataset.screen === name;
    /* ⚠️ The screen being left is kept, out of flow, for the length of its
     * exit. Hidden outright it would vanish mid-gesture; left in flow it would
     * hold the panel at the taller of the two heights and then drop. */
    if (!active && moving && section.dataset.screen === from) {
      section.classList.remove("active");
      section.classList.add("is-leaving");
      section.hidden = false;
      const leaving = section;
      window.setTimeout(() => {
        // Checked, not assumed: a fast switch back makes this screen active
        // again before the timer fires, and hiding it then would blank it.
        if (!leaving.classList.contains("active")) {
          leaving.classList.remove("is-leaving");
          leaving.hidden = true;
        }
      }, SCREEN_EXIT_MS);
      continue;
    }
    section.classList.toggle("active", active);
    section.classList.remove("is-leaving");
    section.hidden = !active;
    // The first paint is not an arrival: nothing was left to come from.
    if (active) section.classList.toggle("is-first", !moving);
  }
  for (const button of document.querySelectorAll<HTMLElement>(".island-tab")) {
    button.setAttribute("aria-selected", String(button.dataset.tab === name));
  }
  /* ⚠️ The width lands BEFORE the render. The panel measures its content at
   * the end of `render()`, and measuring a screen at the previous screen's
   * width gets the wrapping — and therefore the height — right for a layout
   * that is about to change. */
  surface.capBody(cpx(widthOf(name)));
  placeGlide(true);
  // You pressed a tab: this one is allowed to bounce. See `sizing()`.
  surface.deliberately();
  render();
}

/** The player's tab, which is there only while there is a player.
 *
 * ⚠️ A tab that is always present and usually empty is what got the last
 * one removed. This one appears with the first track and goes with the last,
 * and ⚠️ if it goes while you are LOOKING at it the shell moves you home —
 * otherwise the island sits on a hidden tab showing an empty screen with no
 * way to tell what happened. */
function paintMediaTab() {
  const tab = document.querySelector<HTMLElement>('[data-tab="media"]');
  if (!tab) return;
  const playing = media.media.active;
  tab.hidden = !playing;
  if (!playing && screen === "media") show("home");
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
    /* ⚠️ Two different reasons to be silent, folded into one list here
     * because the module layer should only know "quiet", not why: snoozed is
     * "not now", muted is "not ever". */
    quiet: ["disk", "cpu", "memory", "agents", "event", "tasks", "weather"]
      .filter(id => snooze.isQuiet(`module:${id}`) || prefs.mutedModules.includes(id)),
    thresholds: prefs.thresholds,
    fahrenheit: prefs.fahrenheit,
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

function render() {
  // Every screen renders, not just the visible one: the collapsed pill draws on
  // all three, and a screen that only updated while it was on top would show
  // stale numbers the moment you switched to it.
  today.render();
  calendar.render();
  system.render();
  agentsScreen.render();
  shelf.render();
  review.render();
  home.render();
  player.render();
  paintMediaTab();

  /* What the OPEN screen can do, in the header. ⚠️ Only the open one: these
   * are the tools for what you are looking at, and a header carrying every
   * screen's would be four buttons that mostly do nothing here. */
  const tools: Partial<Record<ScreenName, () => ScreenTools>> = {
    today: () => today.tools(),
    shelf: () => shelf.tools(),
    media: () => player.tools(),
  };
  paintTools(get("screen-tools"), tools[screen]?.() ?? {});

  const live = claims();
  paintPill(live);
  /* A dot on the tab whose screen has something live. The pill can only say one
   * thing at a time; this is how the other two say "there is something here"
   * without competing for those 200 pixels. Resting claims (the day's own
   * tally) do not count — every tab would wear a dot forever. */
/* ⚠️ Media raises no dot, and not merely because it lost its tab. A dot means
 * "this screen has something you have not seen"; the player is already NAMED on
 * the pill, with its own equaliser running, so a dot would be the same claim
 * made twice — and it would land on Home, which is the default screen and
 * therefore the one place a dot says least. */
  const lit = new Set(live
    .filter(c => c && c.priority > 5 && c.kind !== "media")
    .map(c => c!.screen));
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
/* The one way in, from the shortcut and from the header button alike.
 *
 * ⚠️ The key that opens it closes it. It used to re-select the field instead,
 * on the argument that a second press means "I meant something else" — which
 * is true while you are looking at it and wrong every other time: the palette
 * is opened from inside another application, and the only way to dismiss it
 * without running something was Escape, aimed at a window that may never have
 * taken focus.
 *
 * ⚠️ And "hide everything" wins the argument it is in. Opening the palette
 * behind a hidden island is a shortcut that does nothing whatsoever — the
 * palette is there, on a surface slid off the screen — so asking for it is
 * taken as asking for the app back. `show_chrome`, never `toggle_chrome`:
 * toggling from a caller that has only its own idea of the state is how a
 * shortcut ends up hiding the island half the time. */
async function summon() {
  if (!palette.showing && surface.isHidden) await call("show_chrome").catch(() => {});
  await palette.toggle();
}
get("open-palette").onclick = () => { void summon(); };

/* The global shortcut, for the browser preview.
 *
 * ⚠️ Preview only, and it has to exist. `island:palette` is a native event, so
 * with no Tauri there is NO way to press the key that opens the palette — and
 * the header button cannot stand in for it, because opening the palette takes
 * the header out of sight, which is exactly the behaviour that makes the
 * shortcut the only way to close it again. Without this the toggle is
 * untestable outside a release build. */
if (preview) {
  document.addEventListener("keydown", event => {
    if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "k") return;
    event.preventDefault();
    void summon();
  }, true);
}

/* ── What the palette can do ──────────────────────────────────────────────
 * Each provider answers with actions; the palette ranks across all of them.
 * A new screen adds its commands by exporting a list, not by editing the
 * palette. */

/* ⚠️ `keep` is what makes a row starrable, and it carries enough to REBUILD
 * the row from the stars file alone. A screen needs no rebuilding — this
 * provider offers it on every query including the empty one — so its `kind` is
 * blank and the stored copy is deduped away in favour of this live one. */
palette.add(() => TABS.map(tab => ({
  id: `go:${tab.name}`,
  title: tab.label,
  keywords: "go screen open",
  hint: "Go",
  icon: tab.icon,
  keep: { title: tab.label, note: "screen", icon: tab.icon, kind: "", path: "" },
  run: () => { show(tab.name); surface.pinFor(6000); },
})));

palette.add(() => {
  const acts: Action[] = [
    { id: "cmd:capture", title: "Add a task", keywords: "new todo create capture",
      icon: "plus", hint: "Do", keep: { title: "Add a task", note: "command", icon: "plus", kind: "", path: "" },
      run: () => { show("today"); surface.pinFor(6000); void today.capture(); } },
    { id: "cmd:editor", title: "Accounts & connections", keywords: "settings ticktick google weather",
      icon: "settings", hint: "Do", keep: { title: "Accounts & connections", note: "command", icon: "settings", kind: "", path: "" },
      run: () => { void today.action("open_task_editor"); } },
    { id: "cmd:log", title: "Open log", keywords: "debug diagnose trouble",
      icon: "note", hint: "Do", keep: { title: "Open log", note: "command", icon: "note", kind: "", path: "" },
      run: () => call("open_log") },
    { id: "cmd:display", title: "Move to next display", keywords: "monitor screen",
      icon: "system", hint: "Do", keep: { title: "Move to next display", note: "command", icon: "system", kind: "", path: "" },
      run: () => call("next_display", { label: "tasks" }) },
    { id: "cmd:hide", title: "Hide the chrome", keywords: "dismiss away present",
      icon: "close", hint: "Do", keep: { title: "Hide the chrome", note: "command", icon: "close", kind: "", path: "" },
      run: () => call("toggle_chrome") },
    { id: "cmd:clock", title: clock24 ? "Use a 12-hour clock" : "Use a 24-hour clock",
      keywords: "time format", icon: "clock", hint: "Do",
      keep: { title: clock24 ? "Use a 12-hour clock" : "Use a 24-hour clock", note: "command", icon: "clock", kind: "", path: "" },
      run: () => {
        clock24 = !clock24;
        paintPill();
        call("set_clock_format", { clock24 });
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
/* ⚠️ ONE row per shelf item, with the rest of the verbs behind `Tab`.
 * It used to emit two — copy and open — and with eight things on the shelf
 * that is sixteen rows competing with every screen, every command and every
 * task for eight visible slots. A second row per item is how a palette stops
 * being faster than the screen it replaced. */
palette.add(() => shelf.items.map(item => ({
  id: `shelf:${item.id}`,
  title: item.name,
  note: item.missing ? "moved or deleted" : "copy to the clipboard",
  keywords: "shelf file paste",
  icon: item.kind === "link" ? "link" : item.kind === "text" ? "note" : "file",
  hint: "Shelf",
  keep: { title: item.name, note: "on the shelf",
    icon: item.kind === "link" ? "link" : item.kind === "text" ? "note" : "file",
    kind: "", path: "" },
  run: () => call(item.missing ? "shelf_remove" : "shelf_copy", { id: item.id }),
  more: () => {
    const rows: Action[] = [];
    if (!item.missing) {
      rows.push(
        { id: `shelf:copy:${item.id}`, title: "Copy", keywords: "clipboard paste",
          icon: "copy", run: () => call("shelf_copy", { id: item.id }) },
        { id: `shelf:open:${item.id}`, title: "Open", keywords: "launch run",
          icon: "open", run: () => call("shelf_open", { id: item.id }) },
      );
      if (item.kind === "file") {
        rows.push({ id: `shelf:reveal:${item.id}`, title: "Show in folder",
          keywords: "explorer reveal locate", icon: "folder",
          run: () => call("shelf_reveal", { id: item.id }) });
      }
    }
    rows.push({ id: `shelf:remove:${item.id}`, title: "Take off the shelf",
      keywords: "delete remove clear", icon: "close",
      run: () => call("shelf_remove", { id: item.id }) });
    return rows;
  },
})));

palette.add(() => agentsScreen.sessions.map(session => ({
  id: `agent:${session.id}`,
  title: session.project,
  note: session.state === "waiting" ? "waiting for you" : session.state,
  keywords: `agent claude session ${session.branch ?? ""}`,
  icon: "agent",
  hint: "Agents",
  run: () => call("focus_session", { pid: session.pid }),
  more: () => [
    { id: `agent:raise:${session.id}`, title: "Raise the terminal",
      keywords: "focus window show", icon: "open",
      run: () => call("focus_session", { pid: session.pid }) },
    { id: `agent:path:${session.id}`, title: "Copy the project name",
      keywords: "clipboard folder cd", icon: "copy",
      run: () => call("copy_text", { text: session.project }) },
    /* ⚠️ Where a workspace comes from. The session already carries its own
     * `cwd`, so there is nothing to type and nothing to pick — which is the
     * whole reason there is no workspace editor. */
    ...(session.folder && !workspaces.has(session.folder)
      ? [{ id: `ws:save:${session.folder}`, title: "Save as a workspace",
           note: workspaces.leaf(session.folder),
           keywords: "workspace project keep start", icon: "folder" as TaskIcon,
           run: async () => {
             await workspaces.save(session.folder!);
             say("Workspace", workspaces.leaf(session.folder!));
           } }]
      : []),
    /* The snooze the Agents screen already has, reachable without going there
     * — which is the whole argument for the palette. */
    snooze.isQuiet(`agent:${session.id}`)
      ? { id: `agent:wake:${session.id}`, title: "Let it ask again",
          keywords: "unmute wake", icon: "snooze",
          run: () => { void snooze.wake(`agent:${session.id}`); } }
      : { id: `agent:hush:${session.id}`, title: "Quiet for an hour",
          keywords: "snooze mute later", icon: "snooze",
          run: () => { void snooze.hush(`agent:${session.id}`); } },
  ],
})));

palette.add(() => today.upNext(20).map(task => ({
  id: `task:${task.projectId}:${task.id}`,
  title: task.title || "Untitled task",
  note: "complete",
  keywords: "task todo done tick",
  icon: "check",
  hint: "Today",
  run: () => { today.finish(task); },
  more: () => [
    { id: `task:done:${task.id}`, title: "Complete", keywords: "finish tick done",
      icon: "check", run: () => { today.finish(task); } },
    { id: `task:copy:${task.id}`, title: "Copy the title", keywords: "clipboard text",
      icon: "copy", run: () => call("copy_text", { text: task.title }) },
    { id: `task:shelve:${task.id}`, title: "Park it on the shelf",
      keywords: "shelf note later", icon: "shelf",
      run: () => call("shelf_add_text", { text: task.title }) },
  ],
})));

/* The arithmetic line. ⚠️ FIRST, because when a line is a sum it is never
 * also a search — `calc` refuses anything without both a digit and an operator
 * precisely so that this row cannot appear over something you were looking
 * for. `volatile`, because the id carries the expression: learning from it
 * would evict forty real entries in an afternoon. */
palette.add(query => {
  const sum = calc(query);
  if (!sum) return [];
  return [{
    id: `calc:${sum.value}`,
    title: `= ${sum.text}`,
    note: "copy the result",
    keywords: "calculator maths sum",
    icon: "copy",
    hint: "Sum",
    tier: TIER.answer,
    pinned: true,
    volatile: true,
    /* ⚠️ Copied through Rust, not `navigator.clipboard`. The palette hands
     * the caret back before an action runs, and the web clipboard API rejects
     * on an unfocused document — silently, in a promise nobody awaits. */
    run: () => call("copy_text", { text: sum.value }),
  }];
});

/* The applications. ⚠️ Fetched ONCE and searched in here, not asked per
 * keystroke: the list is a shell call per shortcut to build and it does not
 * change while you are typing. The array starts empty, so the provider simply
 * answers nothing until the first fetch lands.
 *
 * ⚠️ Nothing on an empty query. Apps outrank everything except an answer
 * (see TIER), so offering them with the field blank would bury the screens and
 * the day under a hundred and fifty applications you did not ask for — and the
 * blank field is where recency does its work. */
let installed: { name: string; path: string; icon: string | null }[] = [];
palette.add(query => {
  if (!query) return [];
  return installed.map(app => ({
    id: `app:${app.path}`,
    title: app.name,
    note: "application",
    keywords: "app open launch program",
    icon: "app" as const,
    art: app.icon ?? undefined,
    hint: "App",
    tier: TIER.app,
    /* ⚠️ `kind: "app"` is what lets a starred application appear in the
     * EMPTY palette. This provider answers nothing without a query, so without
     * the record a starred app would sit in the file and show up nowhere. */
    keep: { title: app.name, note: "application", icon: "app", kind: "app", path: app.path },
    run: () => call("launch_app", { path: app.path }),
    more: () => [
      { id: `app:open:${app.path}`, title: "Open", keywords: "launch run start",
        icon: "open" as const, art: app.icon ?? undefined,
        run: () => call("launch_app", { path: app.path }) },
      { id: `app:reveal:${app.path}`, title: "Show the shortcut",
        keywords: "explorer folder locate", icon: "folder" as const,
        run: () => call("found_reveal", { path: app.path }) },
      /* ⚠️ One row per workspace rather than a picker. The Tab menu is
       * already a list; a dialog to choose from a list inside a list is the
       * form this feature exists to avoid. */
      ...workspaces.all().map(([folder, workspace]) => ({
        id: `app:ws:${app.path}:${folder}`,
        title: `Add to ${workspace.name}`,
        keywords: "workspace project file",
        icon: "plus" as const,
        run: async () => { say("Added to", await workspaces.addApp(folder, app.path)); },
      })),
    ],
  }));
});

/* Everything, if it is running. ⚠️ A LATE provider: the answer is a round
 * trip to another process, so it arrives after the list is already up rather
 * than holding every keystroke for it.
 *
 * ⚠️ Debounced HERE rather than in the palette. The palette drops a stale
 * answer, which keeps the list correct, but it would still have paid for one
 * IPC round trip per keystroke — and "codenotch" is nine of them. */
let asked = 0;
palette.addLive(query => new Promise<Action[]>(resolve => {
  /* Three characters, same threshold as the create-a-task row. Everything
   * answers "e" with half the disk, and a palette that fills with system DLLs
   * on the way to typing "editor" is worse than no file search. */
  if (!prefs.useEverything || query.length < 3 || calc(query)) { resolve([]); return; }
  const mine = ++asked;
  window.setTimeout(() => {
    if (mine !== asked) { resolve([]); return; }
    call<{ name: string; path: string; full: string; folder: boolean }[]>(
      "everything_search", { query, limit: 10 })
      .then(hits => resolve(hits.map(hit => ({
        id: `found:${hit.full}`,
        title: hit.name,
        note: hit.path,
        /* The path is searched as well, at half weight, so `src pal` finds
         * what `pal` alone would bury. */
        keywords: `${hit.full} file find everything`,
        /* ⚠️ What it IS, not just that it is a file. A page of hits is a
         * column of identical rows, and the icon is the only part of one you
         * read without reading it. See file-kind.ts. */
        icon: iconFor(hit.name, hit.folder),
        hint: "Found",
        tier: TIER.file,
        /* Starring a path is the point of all this: once starred, a folder is
         * two keystrokes away for ever, with no round trip to Everything and
         * no need for it to be running. */
        keep: { title: hit.name, note: hit.path, icon: iconFor(hit.name, hit.folder),
          kind: "file", path: hit.full },
        /* ⚠️ OPEN. It shelved at first, on the argument that parking a
         * thing is what the island has and a launcher does not — which is true
         * about the island and wrong about the keystroke. Enter on a file means
         * open it; everything else is a Tab away. */
        run: () => call("found_open", { path: hit.full }),
        more: () => [
          { id: `found:reveal:${hit.full}`, title: "Show in folder",
            keywords: "explorer reveal locate", icon: "folder",
            run: () => call("found_reveal", { path: hit.full }) },
          { id: `found:shelve:${hit.full}`, title: "Put it on the shelf",
            keywords: "park keep", icon: "shelf",
            run: () => call("shelf_add_paths", { paths: [hit.full] }) },
          { id: `found:copy:${hit.full}`, title: "Copy the path",
            keywords: "clipboard", icon: "copy",
            run: () => call("copy_text", { text: hit.full }) },
        ],
      }))))
      .catch(() => resolve([]));
  }, 140);
}));

/* A project, and everything you open to work on it.
 *
 * ⚠️ No editor, no settings page. A workspace screen with a folder picker and
 * an app list is a form to fill in before the feature does anything, which is
 * how a feature like this gets used once. These are made from rows that are
 * already on screen — see the session and application providers above. */
palette.add(() => workspaces.all().map(([folder, workspace]) => ({
  id: `ws:${folder}`,
  title: workspace.name,
  note: workspace.apps.length
    ? `workspace \u00b7 ${workspace.apps.length} app${workspace.apps.length === 1 ? "" : "s"}`
    : "workspace",
  keywords: `${folder} workspace project open start`,
  icon: "folder" as TaskIcon,
  hint: "Workspace",
  keep: { title: workspace.name, note: "workspace", icon: "folder", kind: "", path: folder },
  run: async () => { say("Opening", await workspaces.open(folder)); },
  more: () => [
    { id: `ws:open:${folder}`, title: "Open everything", keywords: "start launch all",
      icon: "open" as TaskIcon,
      run: async () => { say("Opening", await workspaces.open(folder)); } },
    { id: `ws:folder:${folder}`, title: "Just the folder", keywords: "explorer show",
      icon: "folder" as TaskIcon, run: () => call("found_open", { path: folder }) },
    /* The session for this folder, if one is running. ⚠️ Matched on the
     * folder rather than the project name: two checkouts of the same repo have
     * the same name and are not the same workspace. */
    ...agentsScreen.sessions
      .filter(session => session.folder === folder)
      .map(session => ({
        id: `ws:raise:${folder}`, title: "Raise its terminal",
        keywords: "session claude agent focus", icon: "agent" as TaskIcon,
        run: () => call("focus_session", { pid: session.pid }),
      })),
    { id: `ws:copy:${folder}`, title: "Copy the folder path", keywords: "clipboard",
      icon: "copy" as TaskIcon, run: () => call("copy_text", { text: folder }) },
    { id: `ws:forget:${folder}`, title: "Forget this workspace",
      keywords: "remove delete", icon: "close" as TaskIcon,
      run: () => workspaces.remove(folder) },
  ],
})));

/* What you kept.
 *
 * ⚠️ Registered LAST, because the dedupe in `query()` keeps the FIRST row
 * for an id — so a live provider that can still offer the real thing wins, and
 * this only speaks for what nothing else can produce. That is the whole reason
 * a star carries a snapshot: on an empty query nothing asks Everything and
 * nothing enumerates the applications, so a starred folder or app would exist
 * in the file and appear nowhere.
 *
 * ⚠️ A starred thing that has since gone throws rather than doing nothing.
 * A star is deliberate, so its quiet disappearance is worth a sentence. */
palette.add(() => stars.all().map(([id, star]) => ({
  id,
  title: star.title || id,
  note: star.note,
  keywords: `${star.path} starred favourite kept`,
  icon: (star.icon || "star") as TaskIcon,
  hint: "Starred",
  tier: star.kind === "app" ? TIER.app : star.kind === "file" ? TIER.file : TIER.island,
  keep: star,
  run: () => {
    if (star.kind === "app") return call("launch_app", { path: star.path });
    if (star.kind === "file") return call("found_open", { path: star.path });
    throw new Error("whatever this was is no longer here");
  },
  more: star.kind === "file" ? () => [
    { id: `starred:reveal:${id}`, title: "Show in folder",
      keywords: "explorer reveal locate", icon: "folder" as TaskIcon,
      run: () => call("found_reveal", { path: star.path }) },
    { id: `starred:shelve:${id}`, title: "Put it on the shelf",
      keywords: "park keep", icon: "shelf" as TaskIcon,
      run: () => call("shelf_add_paths", { paths: [star.path] }) },
    { id: `starred:copy:${id}`, title: "Copy the path", keywords: "clipboard",
      icon: "copy" as TaskIcon, run: () => call("copy_text", { text: star.path }) },
  ] : undefined,
})));

/* ⚠️ Last, and only when nothing else matched well: the palette is a way to
 * reach things, and a "create" row that shows up for every stray keystroke
 * turns every mistyped search into an accidental task. */
palette.add(query => {
  if (query.length < 3 || calc(query)) return [];
  return [{
    id: "make:task",
    title: `Add task "${query}"`,
    keywords: "new create todo",
    icon: "plus",
    tier: TIER.offer,
    hint: "New",
    run: () => {
      show("today");
      surface.pinFor(8000);
      void today.capture(query);
    },
  }];
});

/** Everything a preference actually changes, in one place.
 *
 * ⚠️ Idempotent and safe to call at any time: it runs at boot, on every
 * write from the settings window, and nothing here assumes it is the first. */
function applyPrefs(next: Prefs) {
  prefs = next;
  document.documentElement.style.setProperty("--accent", next.accent);
  setMotion(next.motion);
  surface.setOpenOnHover(next.openOnHover);
  /* ⚠️ On <html>, where the stylesheet can read it. Click mode is not only a
   * behaviour — it is what makes the pill able to hold controls at all, because
   * the pointer resting on it no longer means "open". */
  document.documentElement.dataset.open = next.openOnHover ? "hover" : "click";
  surface.setFoldDelay(next.foldDelayMs);
  surface.setBodyLong(next.panelWidth);
  today.setView(next.taskView === "all" ? "all" : "day");
  home.setWeekStart(next.weekStartsMonday);
  calendar.setWeekStart(next.weekStartsMonday);
  /* ⚠️ Both. The pill reads `prefs` through `moduleContext()`, so a muted
   * module or a moved threshold needs `paintPill`; the week strip and the
   * calendar grid are drawn by their screens, so they need a render. A
   * preference that only takes effect on the next unrelated redraw is a
   * settings window that looks broken. */
  paintPill();
  render();
}

/* ── Controls ─────────────────────────────────────────────────────────── */
get("pin").onclick = () => surface.pin();
get("collapse-panel").onclick = () => { void surface.collapse(); };
/* ⚠️ Opens the settings WINDOW. It used to open a popover inside the panel
 * holding the edge, the clock and the task view — which meant those three
 * settings lived somewhere the other twenty did not, and the popover pushed the
 * island taller every time it was opened. One gear, one place. */
get("surface-settings").onclick = () => { void today.action("open_task_editor"); };
/* Clicking the pill opens the island and nothing else.
 *
 * It deliberately does NOT jump to the screen the pill is describing. Hover
 * opens the island before any click can land, so that navigation would fire on
 * a pointer merely crossing the pill; and with music playing for an afternoon
 * the pill's claim is Media all afternoon, which would mean the task list — the
 * reason this thing exists — was never what opening it showed. The tab dot
 * points at the live screen instead, and the tabs do the moving. */
/* ── Pressing the pill ─────────────────────────────────────────
 * ⚠️ `pointerdown`/`pointerup`, not `:active`. A CSS `:active` on the island
 * would also fire for a press on anything inside the expanded panel — every
 * task row, every tab — and the whole shape would flinch each time. */
const island = get("island");
const press = (down: boolean) => island.classList.toggle("is-pressed", down);
collapsedLayer.addEventListener("pointerdown", () => press(true));
for (const event of ["pointerup", "pointercancel", "pointerleave"] as const) {
  collapsedLayer.addEventListener(event, () => press(false));
}

collapsedLayer.addEventListener("click", () => {
  /* ⚠️ A second press closes it ONLY in click mode. With hover opening, the
   * pointer has already opened the panel before a click can possibly land, so
   * a plain toggle here means "point at it, it opens, press it, it shuts" —
   * which is what the original `if (!open)` guard was there to stop. */
  if (!surface.open || !surface.opensOnHover) surface.toggle();
});

/* The equaliser is the player's play/pause in click mode. ⚠️ The press must
 * not reach the pill underneath, or toggling the track would open the island
 * every time. */
collapsedLayer.addEventListener("click", event => {
  const eq = (event.target as HTMLElement).closest(".pill-eq");
  if (!eq) return;
  event.stopPropagation();
  media.control("playpause");
}, true);

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
/* How much wheel has to go one way before the screen changes, and how long the
 * gesture is allowed to gather.
 *
 * ⚠️ A trackpad sends a stream of 2-4px deltas, so acting on the first one
 * made a screen change out of a thumb resting on the pad — you would look up to
 * find yourself somewhere else. A mouse notch is ~100px, so one notch still
 * counts and two fingers drifting do not. */
/* ⚠️ 240, up from 90. A trackpad sends a stream of 2–4px deltas and a mouse
 * notch is ~100px, so 90 was "one notch, or a thumb resting on the pad for a
 * third of a second" — which in use meant looking up to find yourself two
 * screens away. Two notches, or a deliberate swipe, and nothing less. */
const WHEEL_TO_SWITCH = 240;
const WHEEL_WINDOW = 400;
let wheeled = 0;
let wheeledAt = 0;

function cycle(direction: number) {
  const now = Date.now();
  // One flick must not run through every tab.
  // ⚠️ And a longer tail on the switch itself: one gesture must not run
  // through three screens because it had momentum left.
  if (!direction || now - lastSwitch < 450) return;
  lastSwitch = now;
  wheeled = 0;
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
  const delta = horizontal ? event.deltaX : event.deltaY;
  const now = Date.now();
  /* ⚠️ Gathered, not acted on. A run that stalls or reverses starts over, so
   * a wheel nudged both ways never lands on a switch — only a deliberate push
   * one way does. */
  if (now - wheeledAt > WHEEL_WINDOW || Math.sign(delta) !== Math.sign(wheeled)) wheeled = 0;
  wheeled += delta;
  wheeledAt = now;
  if (Math.abs(wheeled) < WHEEL_TO_SWITCH) return;
  cycle(Math.sign(wheeled));
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
  /* ⚠️ FIRST, and awaited. Two things below read a preference as they run
   * rather than after: the Start Menu walk checks `indexApps`, and the accent
   * has to be on the element before the first paint or the island opens green
   * and turns purple a frame later. */
  try { applyPrefs(await call<Prefs>("get_prefs")); }
  catch { applyPrefs(prefs); }
  /* ⚠️ Not awaited. The list takes a second or so to build on the Rust side
   * and nothing on screen depends on it — the palette simply has no
   * applications until it lands, which is the correct behaviour for the first
   * second of a run anyway. Awaiting it here would hold the island's first
   * paint behind a Start Menu walk. */
  await stars.boot(() => render());
  await workspaces.boot(() => render());
  /* ⚠️ Skipped entirely when the preference is off, rather than filtered
   * later. Walking the Start Menu is a shell call per shortcut — about 1.7s on
   * a real machine — and the whole point of switching it off is not paying it. */
  void (prefs.indexApps
    ? call<typeof installed>("list_apps")
    : Promise.resolve([] as typeof installed))
    .then(list => { installed = list; })
    .catch(() => { /* no applications is a palette without apps, not an error */ });
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
    await listen("island:palette", () => { void summon(); });

    // Kept in step if the format is changed from another window.
    // ⚠️ Inside the `native` guard with every other listener here. Outside it,
    // `listen` rejects in the browser preview and takes the rest of boot()
    // with it — no screens render at all, and the only symptom is an empty
    // island with nothing in the console.
    await listen<{ clock24: boolean }>("tasks:placement", event => {
      clock24 = event.payload.clock24;
      paintPill();
    });
    /* ⚠️ Emitted to every window by `set_prefs`, so this is the island being
     * told rather than the island polling. */
    await listen<Prefs>("notch:prefs", event => applyPrefs(event.payload));

    /* A click anywhere else. ⚠️ The palette first: it is the surface ON the
     * island, and its own outside-click handler is a document `pointerdown`
     * that can only ever see clicks that landed on the island. */
    await listen("island:dismiss", () => {
      if (palette.open) { void palette.hide(); return; }
      void surface.dismiss();
    });
  }
  try {
    const placement = await call<{ clock24: boolean }>("get_task_placement");
    if (typeof placement.clock24 === "boolean") clock24 = placement.clock24;
  } catch { /* the default stands */ }

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
  /* ⚠️ What is quiet is said out loud in two places that survive the popover
   * going: the palette's "Bring back what is snoozed", which carries the
   * count, and the Pill pane of the settings window. The failure mode of a
   * mute button is forgetting you pressed it. */
  await snooze.boot(() => render());

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
  render();
  // One second, because the pill's media position and the focus timer both move on
  // that scale. The day's own minute work happens inside the Today screen.
  /* In place, never a redraw: see MediaScreen.tick and renderActivity. The pill
   * is repainted every second because it carries the clock and any running
   * timer; renderActivity reuses its nodes, so this is a few text writes. */
  window.setInterval(() => {
    today.paintTimer();
    agentsScreen.tick();
    paintPill();
  }, 1000);
  window.setInterval(() => { today.tick(); render(); }, 60000);
}
boot().catch(error => {
  const status = document.getElementById("task-status");
  if (status) status.textContent = String(error);
  surface.show(true);
});
