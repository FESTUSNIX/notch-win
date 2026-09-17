/* Windows' notification centre, on the island.
 *
 * ⚠️ **A mirror, not an archive.** Nothing here keeps a copy. Dismissing a row
 * removes the notification from Windows; clearing empties the centre; and when
 * the centre is empty so is this screen. Keeping our own copy so things "stay
 * in the shelf" would be a private, durable log of someone's messages, which is
 * a much larger promise than showing them what is already on their own screen.
 *
 * ⚠️ **The header shows a COUNT, never a word of content.** The island is on
 * screen all day, including while its owner is sharing it — the same argument
 * that keeps an email address out of a call's title. Content is on this screen,
 * which you have to open.
 */
import { element } from "./dom";
import { paintIcon } from "./task-icons";
import { call, native } from "./task-client";
import { listen } from "@tauri-apps/api/event";
import type { ScreenTools } from "./screen-tools";

export interface Notice {
  id: number;
  app: string;
  title: string;
  body: string;
  /** Unix ms. */
  at: number;
  /** The app's own logo as a data URI, or empty. */
  icon: string;
  /** The app's model id, which is what can open it again. */
  aumid: string;
}

export interface Notices {
  /** `allowed`, `denied`, `unavailable`, or `off`. */
  access: string;
  items: Notice[];
}

export const emptyNotices = (): Notices => ({ access: "allowed", items: [] });

/** How long ago, in one unit. Same rule as the agents strip: a notice from
 *  yesterday is "1d", never "27h 12m". */
export function ago(ms: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - ms) / 1000));
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  const hours = Math.floor(seconds / 3600);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

/** Why the screen is empty, when it is empty for a reason. */
export function whyEmpty(access: string): string {
  switch (access) {
    case "off": return "Notifications are switched off in Settings.";
    case "denied": return "Windows will not let Codenotch read notifications.";
    case "unavailable": return "This build of Windows offers no notification centre.";
    default: return "Nothing in the notification centre.";
  }
}

export class NoticeSource {
  notices: Notices = emptyNotices();
  error = "";

  private changed: () => void;
  private say: (what: string, why: string) => void;

  constructor(changed: () => void, say: (what: string, why: string) => void) {
    this.changed = changed;
    this.say = say;
  }

  async boot() {
    if (native) {
      await listen<Notices>("notices:changed", event => {
        this.notices = event.payload;
        this.changed();
      });
    }
    try { this.notices = await call<Notices>("get_notices"); } catch { /* not yet */ }
    this.changed();
  }

  get count(): number {
    return this.notices.items.length;
  }

  /** Bring the app that raised one to the front.
   *
   * ⚠️ The APP, not the conversation. A notification carries no way to
   * activate itself from outside — `UserNotification` has no such method — so
   * this opens Slack, never the thread. The button is named for what it does.
   */
  open(id: number) {
    this.error = "";
    void call("notice_open", { id }).catch(error => {
      const why = String(error).replace(/^invoke error: /i, "");
      this.say("Notifications", why.slice(0, 120));
    });
  }

  /** Dismiss one, or every one of them. */
  clear(id?: number) {
    this.error = "";
    /* Optimistic, because the round trip is a COM call and a row that sits
     * there for a moment after you pressed × reads as a button that missed. */
    this.notices = {
      ...this.notices,
      items: id === undefined ? [] : this.notices.items.filter(one => one.id !== id),
    };
    this.changed();
    void call<Notices>("notice_dismiss", { id })
      .then(fresh => { this.notices = fresh; this.changed(); })
      .catch(error => {
        const why = String(error).replace(/^invoke error: /i, "");
        this.error = why;
        this.say("Notifications", why.slice(0, 120));
        this.changed();
      });
  }
}

export class NoticesScreen {
  private host: HTMLElement;
  private source: NoticeSource;

  constructor(host: HTMLElement, source: NoticeSource) {
    this.host = host;
    this.source = source;
  }

  tools(): ScreenTools {
    return {
      tools: [{
        icon: "close",
        label: "Clear them all",
        disabled: this.source.count === 0,
        run: () => this.source.clear(),
      }],
    };
  }

  private drawn = "";

  render() {
    const { notices } = this.source;
    /* ⚠️ Keyed, like the call screen: `render()` runs on every tick and on
     * every frame of a rail drag, and rebuilding forty rows each time throws
     * away the hover and costs the whole panel during a gesture. */
    const key = [notices.access, this.source.error,
      notices.items.map(one => one.id).join(",")].join("|");
    if (key === this.drawn) return;
    this.drawn = key;

    this.host.replaceChildren();
    if (!notices.items.length) {
      this.host.append(element("p", "home-empty", whyEmpty(notices.access)));
      return;
    }

    /* ⚠️ ONE clear-all, on the arc. There was a second one on a bar above the
     * list for a while; two controls for one verb is two places to look for
     * it, and the bar was a row of chrome over a list whose whole job is to be
     * skimmed. The arc is where a screen's tools live. */
    for (const notice of notices.items) {
      const row = this.row(notice);
      // Anything that was not on the screen last time arrives rather than
      // appearing. See `.is-new`.
      if (!this.seen.has(notice.id)) row.classList.add("is-new");
      this.host.append(row);
    }
    this.seen = new Set(notices.items.map(one => one.id));
  }

  /** Which ids were on screen last time, so only the new ones animate in. */
  private seen = new Set<number>();

  /** Take a card off the screen, then off the machine.
   *
   * ⚠️ The animation runs BEFORE the removal, and it has to: the list is
   * keyed on its ids, so the moment the source drops one the row is gone from
   * the next render and there is nothing left to animate. */
  private dismiss(row: HTMLElement, id: number, toward: number) {
    if (row.classList.contains("is-going")) return;
    /* ⚠️ The card's OWN height, measured before it goes. The collapse below
     * it has to be exactly what is being removed, and a card is two lines tall
     * or three depending on what the app said. */
    row.style.setProperty("--gone-height", `${row.getBoundingClientRect().height + 8}px`);
    row.style.setProperty("--slide", `${toward > 0 ? 120 : -120}%`);
    row.classList.add("is-going");
    window.setTimeout(() => this.source.clear(id), 200);
  }

  private row(notice: Notice): HTMLElement {
    const row = element("div", "notice-row");
    row.dataset.notice = String(notice.id);

    /* The app's own logo, and a letter when Windows has none. ⚠️ A LETTER,
     * not a generic bell: the mark is how a list of forty is skimmed, and
     * forty identical bells is a list with no marks at all. Measured on a real
     * centre, 47 of 48 do have a logo — see `notices.rs` for the three places
     * it is looked for. */
    const plinth = element("div", "notice-mark");
    if (notice.icon) {
      const art = element("img", "notice-logo") as HTMLImageElement;
      art.src = notice.icon;
      art.alt = "";
      plinth.append(art);
    } else {
      plinth.classList.add("is-letter");
      plinth.textContent = (notice.app || notice.title || "?").trim().charAt(0).toUpperCase();
    }

    /* The whole card opens the app; the × dismisses it. ⚠️ Two SIBLING
     * buttons, never one inside the other — a nested button is invalid and
     * the inner one stops being reachable by keyboard. */
    const open = element("button", "notice-open");
    (open as HTMLButtonElement).type = "button";
    open.setAttribute("data-tip", notice.app ? `Open ${notice.app}` : "Open the app");
    open.onclick = () => this.source.open(notice.id);

    const head = element("div", "notice-head");
    head.append(
      element("b", "notice-title", notice.title || notice.app || "Notification"),
      element("span", "notice-when", ago(notice.at)),
    );
    open.append(head);
    // The app, then what it said — the order the notification itself uses.
    if (notice.app) open.append(element("span", "notice-app", notice.app));
    if (notice.body) open.append(element("p", "notice-body", notice.body));

    const shut = element("button", "notice-shut");
    (shut as HTMLButtonElement).type = "button";
    shut.setAttribute("aria-label", `Dismiss ${notice.title || notice.app}`);
    shut.setAttribute("data-tip", "Dismiss \u2014 this removes it from Windows too");
    paintIcon(shut, "close");
    shut.onclick = () => this.dismiss(row, notice.id, 1);

    row.append(plinth, open, shut);
    this.draggable(row, notice.id);
    return row;
  }

  /** Throw a card sideways to be rid of it.
   *
   * ⚠️ Horizontal intent has to be PROVED before the card takes the
   * gesture, or the list cannot be scrolled: a finger moving down the column
   * is a scroll, and one that has travelled further across than down is a
   * dismissal. Six pixels is enough to tell them apart and few enough not to
   * be felt.
   *
   * ⚠️ And a drag must not also open the app. The card is a button; without
   * the guard below, every throw ends in Slack.
   */
  private draggable(row: HTMLElement, id: number) {
    let from: { x: number; y: number } | null = null;
    let carrying = false;

    row.addEventListener("pointerdown", event => {
      if (event.button !== 0) return;
      from = { x: event.clientX, y: event.clientY };
      carrying = false;
    });

    row.addEventListener("pointermove", event => {
      if (!from) return;
      const dx = event.clientX - from.x;
      const dy = event.clientY - from.y;
      if (!carrying) {
        if (Math.abs(dx) < 6 || Math.abs(dx) <= Math.abs(dy)) return;
        carrying = true;
        row.classList.add("is-carried");
        row.setPointerCapture(event.pointerId);
      }
      row.style.setProperty("--slide", `${dx}px`);
      // Fading as it goes is what says the throw is doing something.
      row.style.setProperty("--fade", String(Math.max(0, 1 - Math.abs(dx) / 220)));
    });

    const release = (event: PointerEvent) => {
      if (!from) return;
      const dx = event.clientX - from.x;
      from = null;
      if (!carrying) return;
      carrying = false;
      row.classList.remove("is-carried");
      if (row.hasPointerCapture(event.pointerId)) row.releasePointerCapture(event.pointerId);
      /* A third of the card's width, or a flick. ⚠️ Measured against the
       * ROW rather than a fixed number of pixels: the panel is a different
       * width on a different screen, and a threshold in pixels is a different
       * gesture on each of them. */
      if (Math.abs(dx) > row.getBoundingClientRect().width * 0.33) {
        this.dismiss(row, id, dx);
        return;
      }
      // Not far enough: back where it was.
      row.style.removeProperty("--slide");
      row.style.removeProperty("--fade");
    };
    row.addEventListener("pointerup", release);
    row.addEventListener("pointercancel", release);

    /* ⚠️ Capturing, and on the ROW: the press that ends a throw would
     * otherwise reach the card's own button and open the app. */
    row.addEventListener("click", event => {
      if (!row.classList.contains("is-going") && !row.style.getPropertyValue("--slide")) return;
      event.stopPropagation();
      event.preventDefault();
    }, true);
  }

  /** The relative times, in place — the rows themselves are keyed. */
  tick() {
    for (const row of this.host.querySelectorAll<HTMLElement>(".notice-row")) {
      const id = Number(row.dataset.notice);
      const notice = this.source.notices.items.find(one => one.id === id);
      const when = row.querySelector<HTMLElement>(".notice-when");
      if (notice && when) when.textContent = ago(notice.at);
    }
  }
}
