/* Where the day went.
 *
 * The first screen in this app that looks backwards, and it invents nothing:
 * app time, finished tasks, agent runs and the calendar were all already being
 * kept, in four places, with nothing joining them. "I was at this machine for
 * nine hours" and "two tasks got finished" are each a fact; together they are
 * the question you actually had.
 *
 * ⚠️ App time lives here now, not on System. It was moved to System when Today
 * got too busy, and it never belonged there — System is the machine's controls,
 * and how long you spent in an editor is not a control.
 */
import { element } from "./dom";
import { paintIcon } from "./task-icons";
import { call } from "./task-client";
import { spoken } from "./media-format";
import { localDay } from "./task-model";
import { endOf, startOf, type CalendarScreen } from "./screen-calendar";
import type { TodayScreen } from "./screen-today";
import type { Activity } from "./island-activity";

export interface AppTime {
  day: string;
  total: number;
  apps: { name: string; seconds: number }[];
}

export interface Run {
  day: string;
  project: string;
  seconds: number;
  endedMs: number;
  waiting: boolean;
  /** What the run cost. ⚠️ Optional: runs recorded before tokens were counted
   *  have neither field, and `serde(default)` writes them as absent. */
  input?: number;
  output?: number;
}

/** `3h 12m`, `48m`, `— `. One or two units, never three. */
export function hours(seconds: number): string {
  if (seconds < 60) return "—";
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  if (!h) return `${m}m`;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/** Group runs by project, longest total first. */
export function byProject(runs: Run[]): { project: string; runs: number; seconds: number }[] {
  const totals = new Map<string, { project: string; runs: number; seconds: number }>();
  for (const run of runs) {
    const row = totals.get(run.project) ?? { project: run.project, runs: 0, seconds: 0 };
    row.runs += 1;
    row.seconds += run.seconds;
    totals.set(run.project, row);
  }
  return [...totals.values()].sort((a, b) => b.seconds - a.seconds);
}

export interface ReviewDeps {
  today: TodayScreen;
  calendar: CalendarScreen;
}

export class ReviewScreen {
  readonly name = "review" as const;
  appTime: AppTime = { day: "", total: 0, apps: [] };
  runs: Run[] = [];

  constructor(private host: HTMLElement, private deps: ReviewDeps) {}

  /** ⚠️ Never claims the pill. A review is something you go and read; a strip
   *  that announced "you have been here nine hours" unprompted would be a
   *  different and much worse product. */
  activity(): Activity | null { return null; }

  /** Read when the screen is opened, not on a timer — nothing here changes
   *  fast enough to be worth a poll, and both calls touch disk. */
  async load() {
    try {
      [this.appTime, this.runs] = await Promise.all([
        call<AppTime>("get_app_time"),
        call<Run[]>("get_runs", { day: "" }),
      ]);
    } catch { /* the screen shows what it has */ }
  }

  private tile(cls: string, heading: string): HTMLElement {
    const tile = element("section", `review-tile ${cls}`);
    tile.append(element("h3", "review-head", heading));
    return tile;
  }

  /** One big number and a line under it. */
  private figure(value: string, note: string): HTMLElement {
    const wrap = element("div", "review-figure");
    wrap.append(element("span", "review-value", value), element("span", "review-note", note));
    return wrap;
  }

  private render_time(): HTMLElement {
    const tile = this.tile("review-time", "At this machine");
    const apps = this.appTime.apps.slice(0, 5);
    tile.append(this.figure(hours(this.appTime.total), apps.length ? `${apps.length} apps` : "nothing tracked yet"));
    const list = element("div", "review-bars");
    const top = apps[0]?.seconds || 1;
    for (const app of apps) {
      const row = element("div", "review-bar");
      row.append(element("span", "review-bar-name", app.name));
      const rail = element("div", "review-rail");
      const fill = element("i");
      fill.style.width = `${Math.max(4, (app.seconds / top) * 100)}%`;
      rail.append(fill);
      row.append(rail, element("span", "review-bar-time", hours(app.seconds)));
      list.append(row);
    }
    tile.append(list);
    return tile;
  }

  private render_tasks(): HTMLElement {
    const tile = this.tile("review-tasks", "Finished");
    const { done, total, reliable } = this.deps.today.tally();
    tile.append(this.figure(
      reliable ? String(done) : "—",
      reliable ? (total ? `of ${total} today` : "nothing was scheduled") : "TickTick not connected",
    ));
    const finished = this.deps.today.finishedToday();
    const list = element("div", "review-list");
    for (const title of finished.slice(0, 6)) {
      const row = element("div", "review-item");
      const mark = element("span", "review-tick");
      paintIcon(mark, "check");
      row.append(mark, element("span", "review-item-name", title));
      list.append(row);
    }
    if (finished.length > 6) {
      list.append(element("p", "review-more", `and ${finished.length - 6} more`));
    }
    tile.append(list);
    return tile;
  }

  private render_agents(): HTMLElement {
    const tile = this.tile("review-agents", "Agents");
    const seconds = this.runs.reduce((n, run) => n + run.seconds, 0);
    tile.append(this.figure(
      String(this.runs.length),
      this.runs.length ? `runs · ${hours(seconds) === "—" ? spoken(seconds) : hours(seconds)}` : "no runs today",
    ));
    const list = element("div", "review-list");
    for (const row of byProject(this.runs).slice(0, 5)) {
      const line = element("div", "review-item");
      line.append(
        element("span", "review-item-name", row.project),
        element("span", "review-item-meta", `${row.runs} · ${hours(row.seconds) === "—" ? spoken(row.seconds) : hours(row.seconds)}`),
      );
      list.append(line);
    }
    tile.append(list);
    return tile;
  }

  private render_meetings(): HTMLElement {
    const tile = this.tile("review-meetings", "Calendar");
    const now = new Date();
    const today = localDay();
    const past = this.deps.calendar.feed.events.filter(event => {
      const day = event.allDay ? event.start.slice(0, 10) : localDay(startOf(event));
      return day === today && !event.allDay && endOf(event) <= now;
    });
    const minutes = past.reduce(
      (n, event) => n + (endOf(event).getTime() - startOf(event).getTime()) / 60000, 0);
    tile.append(this.figure(
      this.deps.calendar.feed.connected ? String(past.length) : "—",
      this.deps.calendar.feed.connected
        ? (past.length ? `meetings · ${hours(minutes * 60)}` : "clear so far")
        : "not connected",
    ));
    const list = element("div", "review-list");
    for (const event of past.slice(0, 5)) {
      const line = element("div", "review-item");
      line.append(
        element("span", "review-item-name", event.title),
        element("span", "review-item-meta",
          startOf(event).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })),
      );
      list.append(line);
    }
    tile.append(list);
    return tile;
  }

  render() {
    this.host.replaceChildren();
    this.host.append(
      this.render_time(),
      this.render_tasks(),
      this.render_agents(),
      this.render_meetings(),
    );
  }
}
