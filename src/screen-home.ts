/* Home: the whole island on one line.
 *
 * The default screen, and the reason the island is a wide bar rather than a
 * panel. Three sections separated by hairlines, each a stripped view of another
 * screen — it owns no data, so there is exactly one optimistic task layer, one
 * media session and one agenda in the app.
 *
 * Everything here is one row deep. A column that stacks art over text over
 * controls is a panel; the same content laid across reads at a glance, which is
 * the only thing a strip welded to a screen edge can usefully be.
 */
import { element } from "./task-list";
import { paintIcon } from "./task-icons";
import { localDay, overdueDays } from "./task-model";
import { sourceName, type MediaSource } from "./screen-media";
import { countdown, dayHeading, endOf, nextEvent, startOf, type CalendarScreen } from "./screen-calendar";
import type { TodayScreen } from "./screen-today";
import type { Activity, ScreenName } from "./island-activity";

/** Days either side of today in the date strip. */
const STRIP_BACK = 2;
const STRIP_FORWARD = 4;

export interface HomeDeps {
  today: TodayScreen;
  media: MediaSource;
  calendar: CalendarScreen;
  open: (screen: ScreenName) => void;
}

export class HomeScreen {
  readonly name = "home" as const;

  // No `changed` callback: Home owns no state. Every control it draws calls
  // the screen that owns the thing, and that screen redraws the shell.
  constructor(private host: HTMLElement, private deps: HomeDeps) {}

  /** Home never claims the pill. It is a view of the other three, and a claim
   *  from here would compete with the screen that actually owns the thing. */
  activity(): Activity | null { return null; }

  /** A section of the bar, with a quiet chevron into the full screen. No
   *  heading: the content says what it is, and three uppercase labels across a
   *  strip this size is most of what made the first version read as clutter. */
  /** ⚠️ `screen` is nullable, and Now playing is the one that passes null.
   *  Every other column is a summary with a fuller screen behind it; the player
   *  has no screen behind it any more, so a chevron promising one would be a
   *  control that goes nowhere. */
  private section(cls: string, title: string, screen: ScreenName | null): HTMLElement {
    const wrap = element("section", `home-sec ${cls}${screen ? " can-open" : ""}`);
    if (!screen) return wrap;
    /* ⚠️ The WHOLE card opens the screen, not just the chevron. A card that lit
     * up under the pointer and then did nothing when pressed is a promise the
     * screen does not keep — and it was making that promise on every pixel
     * except one 15px arrow in the corner.
     *
     * ⚠️ Anything that is itself a control keeps its own press. The transport,
     * the checkboxes and the add row all live inside these cards, and a card
     * that swallowed their clicks would be worse than one that did nothing. */
    wrap.onclick = event => {
      if (event.target instanceof HTMLElement
        && event.target.closest("button, input, label, a")) return;
      this.deps.open(screen);
    };
    const go = element("button", "home-go", "›");
    (go as HTMLButtonElement).type = "button";
    go.setAttribute("aria-label", `Open ${title}`);
    go.title = title;
    go.onclick = () => this.deps.open(screen);
    wrap.append(go);
    return wrap;
  }

  /* ── Media ───────────────────────────────────────────────────────────────
   * Art on the left, the words beside it, the transport under the words. */
  private mediaSection(): HTMLElement {
    const wrap = this.section("home-media", "Now playing", null);
    const media = this.deps.media.media;
    if (!media.active) {
      wrap.append(element("p", "home-empty", "Nothing playing"));
      return wrap;
    }
    const art = element("div", "home-art");
    if (media.artwork) {
      const image = element("img") as HTMLImageElement;
      image.src = media.artwork;
      image.alt = "";
      image.width = 68;
      image.height = 68;
      art.append(image);
    } else {
      art.classList.add("blank");
      paintIcon(art, "media");
    }

    const copy = element("div", "home-media-copy");
    copy.append(element("span", "home-track-title", media.title || "Unknown track"));
    copy.append(element("span", "home-track-artist",
      [media.artist, sourceName(media.source)].filter(Boolean).join(" · ")));

    const controls = element("div", "home-controls");
    for (const [icon, label, action, enabled] of [
      ["previous", "Previous track", "previous", media.canPrevious],
      [media.playing ? "pause" : "play", media.playing ? "Pause" : "Play", "playpause", media.canPlayPause],
      ["next", "Next track", "next", media.canNext],
    ] as const) {
      const button = element("button", "home-button");
      (button as HTMLButtonElement).type = "button";
      (button as HTMLButtonElement).disabled = !enabled;
      button.setAttribute("aria-label", label);
      button.title = label;
      paintIcon(button, icon);
      button.onclick = () => this.deps.media.control(action);
      controls.append(button);
    }
    copy.append(controls);
    wrap.append(art, copy);
    return wrap;
  }

  /* ── Calendar ─────────────────────────────────────────────────────────── */
  private calendarSection(): HTMLElement {
    const wrap = this.section("home-cal", "Calendar", "calendar");
    const feed = this.deps.calendar.feed;
    const today = localDay();
    const busy = new Set(feed.events.map(e => (e.allDay ? e.start.slice(0, 10) : localDay(startOf(e)))));

    /* ⚠️ The month is a CAPTION over the strip, not a word beside it. Set as
     * a display-size "Sep" in its own column it took four tenths of the width
     * of the section and left the seven days it was labelling squeezed into
     * what was left — and the month is the one thing on a week strip you
     * already know. */
    const strip = element("div", "home-strip");
    strip.append(element("span", "home-month",
      new Date().toLocaleDateString(undefined, { month: "long" })));
    const days = element("div", "home-days");
    for (let offset = -STRIP_BACK; offset <= STRIP_FORWARD; offset++) {
      const date = new Date();
      date.setDate(date.getDate() + offset);
      const key = localDay(date);
      const weekend = date.getDay() === 0 || date.getDay() === 6;
      const cell = element("div",
        `home-day${key === today ? " is-today" : ""}${busy.has(key) ? " busy" : ""}${weekend ? " weekend" : ""}`);
      cell.append(
        element("span", "home-day-name", date.toLocaleDateString(undefined, { weekday: "narrow" })),
        element("span", "home-day-num", String(date.getDate())),
        element("span", "home-day-dot"),
      );
      days.append(cell);
    }
    strip.append(days);
    wrap.append(strip);

    /* One line under the strip, not a stack of cards. The strip's dots already
     * say which days are busy; this says what the very next thing is. */
    const line = element("div", "home-next");
    if (!feed.connected) {
      line.append(element("span", "home-empty", "Calendar not connected"));
      wrap.append(line);
      return wrap;
    }
    const now = new Date();
    const next = nextEvent(feed.events, now) || feed.events.filter(e => endOf(e) > now)[0];
    if (!next) {
      const mark = element("span", "home-next-mark");
      paintIcon(mark, "calendar");
      line.append(mark, element("span", "home-empty", "Nothing for today"));
    } else {
      const day = next.allDay ? next.start.slice(0, 10) : localDay(startOf(next));
      const chip = element("span", "home-next-when",
        next.allDay ? "All day" : countdown(now, startOf(next)));
      chip.style.setProperty("--cal", next.color || "#5ac8fa");
      line.append(chip, element("span", "home-next-title", next.title));
      if (day !== today) line.append(element("span", "home-next-day", dayHeading(day)));
    }
    wrap.append(line);
    return wrap;
  }

  /* ── Today ────────────────────────────────────────────────────────────── */
  private todaySection(): HTMLElement {
    const wrap = this.section("home-today", "Today", "today");
    // ⚠️ No progress ring here. It cost a third of the section's width to say
    // "1/1", which the pill already says at rest and the Today screen says
    // properly. The tasks themselves are what the space is for.
    const { total, reliable } = this.deps.today.tally();
    const ns = "http://www.w3.org/2000/svg";

    const list = element("div", "home-tasks");
    const next = this.deps.today.upNext(4);
    if (!next.length) {
      list.append(element("span", "home-empty", reliable && total ? "All done" : "Nothing scheduled"));
    }
    for (const task of next) {
      // A finished task lingers for the settle window, so the tick and the
      // strike are seen before the row leaves. Same beat as the day screen.
      const finished = task.status === 2;
      const row = element("div", `home-task${finished ? " is-done" : ""}`);
      const check = element("label", "check");
      // Same list colour as the day screen: the ring is how a task says which
      // list it is on, here as much as there.
      check.style.setProperty("--list", this.deps.today.colorOf(task));
      const input = element("input") as HTMLInputElement;
      input.type = "checkbox";
      input.checked = finished;
      input.disabled = !this.deps.today.writeable || finished;
      input.setAttribute("aria-label", `Complete ${task.title}`);
      input.onchange = () => { input.checked = finished; this.deps.today.finish(task); };
      const mark = document.createElementNS(ns, "svg");
      mark.setAttribute("viewBox", "0 0 24 24");
      mark.setAttribute("aria-hidden", "true");
      const path = document.createElementNS(ns, "path");
      path.setAttribute("d", "M6.2 12.6 L10 16.4 L17.8 7.6");
      mark.append(path);
      check.append(input, element("span", "disc"), element("span", "fill"), mark, element("span", "pulse"));
      row.append(check, element("span", "home-task-title strike", task.title));
      // The one piece of context worth the width: how late it already is.
      const late = overdueDays(task);
      if (late && !finished) {
        row.append(element("span", "home-late", late > 99 ? "99+d" : `${late}d`));
      }
      list.append(row);
    }
    /* ⚠️ One line, at the foot of the column, and it opens the DAY rather than
     * composing here. A second composer on Home would be a second place a task
     * can be half-typed and a second set of rules for where it lands — and the
     * screen it opens has the field already focused, so the cost is the same
     * keystroke either way. */
    const add = element("button", "home-add");
    (add as HTMLButtonElement).type = "button";
    add.disabled = !this.deps.today.writeable;
    const plus = element("span", "home-add-mark");
    paintIcon(plus, "plus");
    add.append(plus, element("span", "", "Add a task"));
    add.onclick = () => this.deps.open("today");
    /* ⚠️ Inside the LIST, not beside it. `.home-sec` is a flex row — the three
     * Home columns are its children — so a second child here is a second
     * column, and it squeezed every task title to zero width while leaving the
     * checkboxes and the chip exactly where they were. */
    list.append(add);
    wrap.append(list);
    return wrap;
  }

  render() {
    this.host.replaceChildren();
    this.host.append(this.mediaSection(), this.calendarSection(), this.todaySection());
  }

}
