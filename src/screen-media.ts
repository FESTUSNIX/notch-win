/* Now playing — whatever owns the system transport controls.
 *
 * Nothing here knows about Spotify. `media.rs` reads Windows' own
 * GlobalSystemMediaTransportControls, which is what the media keys drive, so a
 * YouTube tab and a desktop player look identical from up here.
 */
import { call, native } from "./task-client";
import { clock, sourceName } from "./media-format";
import { element } from "./dom";
import { paintIcon } from "./task-icons";
import { lineAt, parseLrc, worth, type Line } from "./lyrics";

// Re-exported so the screens that already import them from here keep working.
export { clock, sourceName } from "./media-format";
import { listen } from "@tauri-apps/api/event";
import type { Activity } from "./island-activity";

export interface Media {
  active: boolean;
  playing: boolean;
  title: string;
  artist: string;
  album: string;
  source: string;
  position: number;
  duration: number;
  artwork: string;
  canNext: boolean;
  canPrevious: boolean;
  canPlayPause: boolean;
  canSeek: boolean;
}

export const emptyMedia = (): Media => ({
  active: false, playing: false, title: "", artist: "", album: "", source: "",
  position: 0, duration: 0, artwork: "", canNext: false, canPrevious: false, canPlayPause: false,
  canSeek: false,
});

export interface AudioDevice {
  id: string;
  name: string;
  isDefault: boolean;
  isBluetooth: boolean;
}

/** What is playing, and the two controls worth having away from the player.
 *
 * ⚠️ NOT a screen any more, and the rename is the point. It had one for a
 * while, and the player was then in three places at once — the collapsed pill,
 * the Home row, and a tab of its own — where the tab was the only one competing
 * with Spotify, a browser and the media keys on a far bigger surface. What is
 * left is the part nothing else on the machine does: saying what is playing
 * without you going to look. */
export class MediaSource {
  media: Media = emptyMedia();
  error = "";
  /** When `media.position` was sampled, so playback can be run forward between
   *  polls instead of ticking once a second in visible one-second jumps. */
  private sampledAt = Date.now();
  /** When playback stopped, or null while it is running. */
  private pausedAt: number | null = null;

  constructor(private changed: () => void) {}

  async boot() {
    if (native) await listen<Media>("media:changed", e => this.receive(e.payload));
    try { this.receive(await call<Media>("get_media")); } catch { /* no session yet */ }
  }

  /** Everything about a track that changes what is DRAWN.
   *
   * ⚠️ The position is deliberately not in it: that is the playhead, and it
   * moves several times a second. See `receive`. */
  private static shape(media: Media): string {
    return [media.active, media.playing, media.title, media.artist, media.album,
      media.source, Math.round(media.duration), media.artwork,
      media.canSeek, media.canNext, media.canPrevious, media.canPlayPause].join("");
  }

  private receive(next: Media) {
    // Track when it stopped, not merely that it did: a player paused a minute
    // ago is not news, and it should hand the pill back to the clock.
    if (next.playing) this.pausedAt = null;
    else if (this.pausedAt === null || !this.media.active) this.pausedAt = Date.now();
    const was = this.media;
    this.media = next;
    this.sampledAt = Date.now();
    /* ⚠️ Only when the SHAPE changed. `media:changed` fires as the playhead
     * moves — several times a second — and redrawing on it rebuilt the whole
     * screen that often: the hover went, the caret in the search field went,
     * and the lyrics' own scroll position was reset mid-animation, which is
     * what made the words appear and then vanish. The playhead is written in
     * place by `MediaScreen.tick`, once a second, which is what it is for. */
    if (MediaSource.shape(was) !== MediaSource.shape(next)) this.changed();
  }

  /** How long the pill keeps a paused track before the clock takes over. */
  private static readonly PAUSED_GRACE = 30_000;

  /** Where the track is *now*, not where it was when Windows last told us. */
  position(): number {
    const { position, duration, playing } = this.media;
    if (!playing || duration <= 0) return position;
    return Math.min(duration, position + (Date.now() - this.sampledAt) / 1000);
  }

  activity(): Activity | null {
    if (!this.media.active) return null;
    // Paused and left alone: give the pill back rather than sitting on it with
    // a track nobody is listening to.
    if (!this.media.playing && this.pausedAt !== null
      && Date.now() - this.pausedAt > MediaSource.PAUSED_GRACE) {
      return null;
    }
    return {
      /* Playing beats the day's resting tally and a paused player; it loses to
       * a focus session and to an imminent meeting. Paused stays on the list so
       * the pill can still offer the controls, but it claims almost nothing. */
      priority: this.media.playing ? 40 : 15,
      /* ⚠️ Home, not a Media screen — there is no longer one. The player
         lives on the Home row, which is where the pill opens into. */
      screen: "home",
      kind: "media",
      label: this.media.title,
      value: this.media.artist || sourceName(this.media.source),
      artwork: this.media.artwork,
      playing: this.media.playing,
    };
  }

  /** Public so Home's compact controls run the same optimistic path. */
  control(action: string) {
    this.error = "";
    void call("media_command", { action }).catch(e => { this.error = String(e); this.changed(); });
    // Optimistic, and only for the one thing whose result is instantaneous.
    if (action === "playpause" && this.media.canPlayPause) {
      const playing = !this.media.playing;
      this.pausedAt = playing ? null : Date.now();
      this.media = { ...this.media, position: this.position(), playing };
      this.sampledAt = Date.now();
      this.changed();
    }
  }

  /** Same contract as HomeScreen.tick: move the playhead, never rebuild. */
  seek(fraction: number) {
    const { duration, canSeek } = this.media;
    if (!canSeek || duration <= 0) return;
    const target = Math.max(0, Math.min(duration, fraction * duration));
    // Optimistic, like play/pause: the playhead moves under the finger and
    // Windows catches up on the next poll.
    this.media = { ...this.media, position: target };
    this.sampledAt = Date.now();
    this.changed();
    void call("media_seek", { seconds: target }).catch(e => { this.error = String(e); this.changed(); });
  }

}

/* ── The player ───────────────────────────────────────────────────────────
 *
 * ⚠️ A screen again, and the tab exists only while something is playing.
 *
 * It had one, it was removed, and the removal was right: the tab held a title,
 * an artist and three buttons, permanently, competing with Spotify and the
 * media keys on a far bigger surface. What makes it worth a screen now is the
 * one thing nothing else on the machine offers in a glance — where you are in
 * the track, and what is coming after it.
 *
 * ⚠️ It still does not own the playback. `media.rs` reads Windows' own
 * transport session, so this draws whatever answers the media keys. Spotify is
 * consulted for the queue and for nothing else; with it disconnected the panel
 * loses its right-hand column and every other control still works.
 */

export interface QueueTrack { id: string; title: string; artist: string; artwork: string }
export interface Queue { connected: boolean; tracks: QueueTrack[]; note: string }
export interface Found { uri: string; title: string; artist: string; artwork: string }

export interface MediaDeps {
  source: MediaSource;
  /** Ask the shell for a wider or narrower panel. The queue needs the room. */
  width: (queueOpen: boolean) => void;
}

export class MediaScreen {
  readonly name = "media" as const;
  /** ⚠️ Closed by default. The queue answers a question you have occasionally;
   *  the track you are listening to is the one you have now. */
  private queueOpen = false;
  private queue: Queue = { connected: false, tracks: [], note: "" };
  private asked = 0;
  /** The track the open queue was fetched against.
   *
   * ⚠️ Title and artist, not the position. `media:changed` fires constantly —
   * the playhead moves — and refetching on every one of those is a request to
   * Spotify several times a second for a list that changes once a song. */
  private fetchedFor = "";
  private devicesOpen = false;
  private devices: AudioDevice[] = [];
  /** The add-to-queue search: open, what was typed, and what came back. */
  private adding = false;
  private term = "";
  private found: Found[] = [];
  private searched = 0;
  private said = "";

  /* ── The words ──────────────────────────────────────
   * ⚠️ Keyed on the TRACK, like the queue and for the same reason:
   * `media:changed` fires as the playhead moves, and asking LRCLIB about the
   * same song several times a second is not a thing to do to somebody's free
   * service. The Rust side caches it again by the same fingerprint. */
  private wordsFor = "";
  private lines: Line[] = [];
  /** Which line is lit, so a repaint that changes nothing animates nothing. */
  private lit = -2;
  /** ⚠️ Closed by default, like the queue. Lyrics are the thing you want
   *  sometimes and the thing that doubles the height of the panel always. */
  private lyricsOpen = false;
  /** The timer aimed at the NEXT line's own second. See `beat`. */
  private beating = 0;
  /** When the reader last scrolled by hand, so the follow stands down. */
  private scrolled = 0;

  constructor(private host: HTMLElement, private deps: MediaDeps, private changed: () => void) {}

  get open(): boolean { return this.queueOpen; }

  /** ⚠️ Fetched on OPEN rather than polled: it is a network round trip to
   *  another service, and a panel nobody has asked for should cost nothing. */
  async load() {
    if (!this.queueOpen) return;
    const mine = ++this.asked;
    try {
      const queue = await call<Queue>("spotify_queue");
      if (mine === this.asked) { this.queue = queue; this.changed(); }
    } catch { /* the note covers the ordinary failures */ }
  }

  /** ⚠️ Debounced, and the stale answer is dropped rather than drawn. Every
   *  few keystrokes is a round trip to Spotify, and they do not come back in
   *  the order they were asked. */
  private search(term: string) {
    this.term = term;
    const mine = ++this.searched;
    window.setTimeout(async () => {
      if (mine !== this.searched) return;
      try {
        const found = await call<Found[]>("spotify_search", { query: term });
        if (mine === this.searched) { this.found = found; this.changed(); }
      } catch { /* an empty list is the honest answer to a failed search */ }
    }, 220);
  }

  private async enqueue(track: Found) {
    this.said = `Queued ${track.title}`;
    this.changed();
    try {
      await call("spotify_enqueue", { uri: track.uri });
      // The queue is a round trip behind the write; ask again rather than
      // guessing where Spotify put it.
      await this.load();
    } catch (error) {
      this.said = String(error).replace(/^invoke error: /i, "");
      this.changed();
    }
  }

  private toggleQueue() {
    this.queueOpen = !this.queueOpen;
    this.deps.width(this.queueOpen);
    // Opening asks again whatever was fetched last time: the panel may have
    // been shut for an hour.
    this.fetchedFor = "";
    this.changed();
  }

  title$() { return "Playing"; }
  activity(): Activity | null { return null; }

  tools() {
    return {
      tools: [{
        icon: "list" as const,
        label: this.queueOpen ? "Hide what is next" : "Show what is next",
        run: () => this.toggleQueue(),
      }],
    };
  }

  render() {
    const media = this.deps.source.media;
    /* ⚠️ The queue goes stale the moment the track changes, and it used to sit
     * there stale until the panel was closed and reopened — showing the song
     * that just finished at the top of "Playing Next". Refetched on the change
     * itself rather than polled: the queue changes once a song, and a timer
     * fast enough to feel right would be a request every few seconds for a
     * list that almost never moves. */
    const playing = `${media.title} ${media.artist}`;
    if (this.queueOpen && media.active && playing !== this.fetchedFor) {
      this.fetchedFor = playing;
      void this.load();
    }
    /* The words, on the same key and for the same reason. ⚠️ `media:changed`
     * fires as the playhead moves, so asking LRCLIB about the same song
     * several times a second is not a thing to do to somebody's free service.
     * The Rust side caches it again by the same fingerprint. */
    if (media.active && playing !== this.wordsFor) {
      this.wordsFor = playing;
      this.lines = [];
      this.lit = -2;
      void this.words(media);
    }
    this.host.replaceChildren();
    this.host.classList.toggle("has-queue", this.queueOpen);

    if (!media.active) {
      const empty = element("div", "day-empty");
      empty.append(element("h3", "", "Nothing playing"),
        element("p", "", "Start something and the controls appear here."));
      this.host.append(empty);
      return;
    }

    /* ── What is playing ──────────────────────────────────────────────── */
    const now = element("div", "media-now");

    const head = element("div", "media-head");
    const art = element("div", "media-art");
    if (media.artwork) {
      const image = element("img") as HTMLImageElement;
      image.src = media.artwork; image.alt = ""; image.width = 84; image.height = 84;
      art.append(image);
    } else {
      art.classList.add("blank");
      paintIcon(art, "media");
    }

    const copy = element("div", "media-copy");
    const line = element("div", "media-title-line");
    line.append(element("h2", "media-title", media.title || "Unknown track"));
    /* ⚠️ The SOURCE, not an "explicit" badge. Windows' transport session
     * carries no explicit flag and no lyrics flag, and a badge that is always
     * on is worse than no badge — it would be decoration claiming to be data.
     * Which app is playing is a real fact, in the same slot. */
    const source = sourceName(media.source);
    if (source) line.append(element("span", "media-badge", source));
    copy.append(line, element("p", "media-artist", media.artist || "Unknown artist"));

    const bars = element("div", `media-eq${media.playing ? " on" : ""}`);
    for (let i = 0; i < 4; i++) bars.append(element("i"));
    head.append(art, copy, bars);

    /* ── Where you are in it ──────────────────────────────────────────── */
    const at = this.deps.source.position();
    const scrub = element("div", "media-scrub");
    scrub.append(element("span", "media-time", clock(at)));
    const rail = element("div", "media-rail");
    const fill = element("i");
    fill.style.width = media.duration > 0
      ? `${Math.max(0, Math.min(100, (at / media.duration) * 100))}%` : "0%";
    rail.append(fill);
    if (media.canSeek && media.duration > 0) {
      rail.classList.add("can-seek");
      rail.onclick = event => {
        const box = rail.getBoundingClientRect();
        this.deps.source.seek((event.clientX - box.left) / box.width);
      };
    }
    /* ⚠️ Remaining, written as a negative — not the total. The total is the
     * same number every time you look at it; how much is left is the one you
     * were actually asking for. */
    const left = media.duration > 0 ? Math.max(0, media.duration - at) : 0;
    scrub.append(rail, element("span", "media-time media-left",
      media.duration > 0 ? `-${clock(left)}` : ""));

    /* ── The controls ─────────────────────────────────────────────────── */
    const transport = element("div", "media-transport");

    const queueButton = element("button", `media-side${this.queueOpen ? " is-on" : ""}`);
    (queueButton as HTMLButtonElement).type = "button";
    queueButton.setAttribute("aria-label", "Playing next");
    queueButton.setAttribute("aria-expanded", String(this.queueOpen));
    queueButton.dataset.tip = "Playing next";
    paintIcon(queueButton, "list");
    queueButton.onclick = () => this.toggleQueue();

    const keys = element("div", "media-keys");
    for (const [icon, label, action, enabled] of [
      ["previous", "Previous track", "previous", media.canPrevious],
      [media.playing ? "pause" : "play", media.playing ? "Pause" : "Play", "playpause", media.canPlayPause],
      ["next", "Next track", "next", media.canNext],
    ] as const) {
      const button = element("button", `media-key${action === "playpause" ? " is-main" : ""}`);
      (button as HTMLButtonElement).type = "button";
      (button as HTMLButtonElement).disabled = !enabled;
      button.setAttribute("aria-label", label);
      button.dataset.tip = label;
      paintIcon(button, icon);
      button.onclick = () => this.deps.source.control(action);
      keys.append(button);
    }

    const output = element("button", `media-side${this.devicesOpen ? " is-on" : ""}`);
    (output as HTMLButtonElement).type = "button";
    output.setAttribute("aria-label", "Output device");
    output.setAttribute("aria-expanded", String(this.devicesOpen));
    output.dataset.tip = this.devices.find(d => d.isDefault)?.name || "Output device";
    paintIcon(output, "speaker");
    output.onclick = event => { event.stopPropagation(); void this.pickDevice(); };

    /* ⚠️ Beside the output picker, not among the transport keys: it opens a
     * panel, which is what the queue button beside it does, and the three in
     * the middle are the ones that touch what is playing. */
    const words = element("button", `media-side${this.lyricsOpen ? " is-on" : ""}`);
    (words as HTMLButtonElement).type = "button";
    (words as HTMLButtonElement).disabled = !this.lines.length;
    words.setAttribute("aria-label", "Lyrics");
    words.setAttribute("aria-expanded", String(this.lyricsOpen));
    words.dataset.tip = this.lines.length ? "Lyrics" : "No lyrics for this one";
    paintIcon(words, "mic");
    words.onclick = () => {
      this.lyricsOpen = !this.lyricsOpen;
      this.lit = -2;
      this.changed();
    };

    transport.append(queueButton, keys, element("div", "media-side-pair"));
    (transport.lastElementChild as HTMLElement).append(words, output);
    now.append(head, scrub, transport);
    if (this.devicesOpen) now.append(this.deviceMenu());
    this.host.append(now);

    /* ⚠️ ALWAYS appended, even closed. It used to be added and removed with
     * the toggle, which is why nothing could animate: on the way in the panel
     * appeared at full size in the same frame the column was told to grow, and
     * on the way out it was gone before the column could shrink. The column is
     * what opens and closes; the panel just sits in it and is clipped. */
    this.host.append(this.renderQueue());
    /* ⚠️ ALWAYS appended, like the queue, and for the same reason: the
     * height is what opens and closes, and an element added on the toggle
     * arrives at full size in the frame it is told to grow from nothing. */
    this.host.append(this.saying(this.deps.source.position()));
    // In the document now, so it can be measured. See `saying`.
    const scroll = this.host.querySelector<HTMLElement>(".media-words");
    if (scroll && this.lyricsOpen) this.paintWords(scroll, this.deps.source.position());
    this.beat();
  }

  /** Three lines: what was said, what is being said, and what is next.
   *
   * ⚠️ Three rather than a scroller. The panel is a wide, short box and a
   * column of forty lines in it is a wall you have to find your place in —
   * which is the one job this has. The line you are on is the bright one and
   * its neighbours are context, which is the shape every player that does this
   * well has settled on.
   *
   * ⚠️ Nothing at all when the file is unsynced. LRCLIB serves plain words
   * too, and pacing them by dividing the track's length by the line count is
   * an invention that is wrong from the second line on. */
  private saying(at: number): HTMLElement {
    const open = this.lyricsOpen && this.lines.length > 0;
    const box = element("div", `media-lyrics${open ? " is-open" : ""}`);
    const scroll = element("div", "media-words");
    for (const line of this.lines) scroll.append(element("p", "media-word", line.text));
    /* ⚠️ The whole file is in the DOM and the window moves over it, rather
     * than three slots being rewritten. Rewritten, every line arrives from
     * nowhere and the words never appear to MOVE — which is the one thing
     * that makes a lyric feel synced rather than merely correct. It is also
     * what makes it scrollable: reading ahead is a wheel, not a feature. */
    scroll.addEventListener("wheel", () => { this.scrolled = Date.now(); }, { passive: true });
    scroll.addEventListener("pointerdown", () => { this.scrolled = Date.now(); });
    box.append(scroll);
    /* ⚠️ NOT painted here. The window is centred on the current line by
     * measuring it, and an element that is not in the document yet has a
     * client height of nothing and every row at offset zero — so the scroll
     * went to the top and `lit` recorded the line as already drawn, which is
     * why the words sat at the beginning of the song and would not move. See
     * the paint at the end of `render`. */
    this.lit = -2;
    return box;
  }

  /** Written in PLACE — never rebuilt. See `beat` and `tick`. */
  private paintWords(scroll: HTMLElement, at: number) {
    const index = lineAt(this.lines, at);
    if (index === this.lit) return;
    this.lit = index;
    const rows = [...scroll.children] as HTMLElement[];
    rows.forEach((row, slot) => {
      /* ⚠️ Distance, not a binary state. One class on the current line and
       * nothing on the rest gives a wall of identical grey with one bright
       * line in it; fading and blurring OUT from the middle is what makes the
       * eye land where the voice is without being told to. */
      const far = Math.min(4, Math.abs(slot - index));
      row.style.setProperty("--far", String(far));
      row.classList.toggle("is-now", slot === index);
    });
    /* ⚠️ Before the first line there is NO current line — not line zero. An
     * intro of eight seconds would otherwise hold the first words up as if
     * they were being sung over it. */
    scroll.classList.toggle("is-waiting", index < 0);
    const target = rows[Math.max(0, index)];
    // Hands off for a moment after somebody scrolls it themselves.
    if (!target || Date.now() - this.scrolled < 6000) return;
    scroll.scrollTo({
      top: target.offsetTop - (scroll.clientHeight - target.offsetHeight) / 2,
      behavior: "smooth",
    });
  }

  /** Wake exactly when the next line starts.
   *
   * ⚠️ A timer aimed at the line's own second, not a poll. The screen's
   * tick is once a second, so a line landed up to a second late — which on a
   * lyric is the difference between following the song and trailing it. The
   * tick stays as the floor: a timer that fires late under load is caught by
   * it within the second, and re-armed from the real position rather than
   * from where the last one thought it was. */
  private beat() {
    window.clearTimeout(this.beating);
    this.beating = 0;
    if (!this.lyricsOpen || !this.lines.length) return;
    const media = this.deps.source.media;
    if (!media.active || !media.playing) return;
    const at = this.deps.source.position();
    const next = this.lines[lineAt(this.lines, at) + 1];
    if (!next) return;
    this.beating = window.setTimeout(() => {
      const scroll = this.host.querySelector<HTMLElement>(".media-words");
      if (scroll) this.paintWords(scroll, this.deps.source.position());
      this.beat();
    }, Math.max(30, (next.at - at) * 1000));
  }

  /** Ask for this track's lyrics. ⚠️ Never an error anybody sees: a song
   *  nobody has transcribed, a network that is down and a service having a bad
   *  day are the same thing here — nothing to show. */
  private async words(media: Media) {
    const mine = this.wordsFor;
    try {
      const got = await call<{ synced: string; plain: string }>("get_lyrics", {
        artist: media.artist,
        track: media.title,
        album: media.album,
        seconds: Math.round(media.duration),
      });
      // The track may have changed while the request was out.
      if (mine !== this.wordsFor) return;
      const lines = parseLrc(got.synced || "");
      if (!worth(lines)) return;
      this.lines = lines;
      this.changed();
      this.beat();
    } catch { /* nothing to show, which is the ordinary case */ }
  }

  /** The playhead and the words, once a second, in place.
   *
   * ⚠️ In place and not a redraw: this screen holds a queue that can be
   * scrolled, an open device menu and a search field with a caret in it, and
   * rebuilding it once a second would throw all three away. Same contract as
   * `TodayScreen.paintTimer`. */
  tick() {
    const media = this.deps.source.media;
    if (!media.active) return;
    const at = this.deps.source.position();
    const elapsed = this.host.querySelector<HTMLElement>(".media-time:not(.media-left)");
    if (elapsed) elapsed.textContent = clock(at);
    const left = this.host.querySelector<HTMLElement>(".media-left");
    if (left && media.duration > 0) left.textContent = `-${clock(Math.max(0, media.duration - at))}`;
    const fill = this.host.querySelector<HTMLElement>(".media-rail i");
    if (fill && media.duration > 0) {
      fill.style.width = `${Math.max(0, Math.min(100, (at / media.duration) * 100))}%`;
    }
    const box = this.host.querySelector<HTMLElement>(".media-words");
    if (box && this.lyricsOpen) this.paintWords(box, at);
  }

  /** The output picker, on the same grammar as the composer's chips. */
  private async pickDevice() {
    this.devicesOpen = !this.devicesOpen;
    this.changed();
    if (!this.devicesOpen) return;
    try {
      this.devices = await call<AudioDevice[]>("get_audio_devices");
      this.changed();
    } catch { /* the menu says so below */ }
    /* ⚠️ Anything outside closes it, and the press has to be TESTED rather
     * than assumed: a press inside would otherwise tear the row down before
     * its own click could land on it. */
    const away = (event: PointerEvent) => {
      if (event.target instanceof Node
        && (event.target as HTMLElement).closest?.(".media-devices, .media-side")) return;
      document.removeEventListener("pointerdown", away, true);
      if (!this.devicesOpen) return;
      this.devicesOpen = false;
      this.changed();
    };
    window.setTimeout(() => document.addEventListener("pointerdown", away, true), 0);
  }

  private deviceMenu(): HTMLElement {
    const menu = element("div", "media-devices");
    if (!this.devices.length) {
      menu.append(element("p", "media-none", "No output devices."));
      return menu;
    }
    for (const device of this.devices) {
      const row = element("button", `media-device${device.isDefault ? " is-on" : ""}`);
      (row as HTMLButtonElement).type = "button";
      const mark = element("span", "media-device-mark");
      paintIcon(mark, device.isBluetooth ? "bluetooth" : "speaker");
      row.append(mark, element("span", "", device.name));
      row.onclick = () => {
        this.devicesOpen = false;
        void call("set_audio_device", { id: device.id }).catch(() => {});
        this.devices = this.devices.map(d => ({ ...d, isDefault: d.id === device.id }));
        this.changed();
      };
      menu.append(row);
    }
    return menu;
  }

  /** Type a track, press the plus, it goes on the END of the queue.
   *
   * ⚠️ The end, and only the end. Spotify's Web API has no endpoint for
   * reordering a queued item, removing one, or inserting at a position —
   * `POST /me/player/queue` appends and that is all of it. A "move up" handle
   * here would be a control that cannot be implemented, so there is not one.
   */
  private searchBox(): HTMLElement {
    const box = element("div", "media-search");
    const field = document.createElement("input");
    field.type = "search";
    field.placeholder = "Add a track…";
    field.value = this.term;
    field.setAttribute("aria-label", "Search Spotify");
    field.oninput = () => this.search(field.value);
    box.append(field);

    if (this.found.length) {
      const results = element("div", "media-results");
      for (const track of this.found) {
        const row = element("button", "media-result");
        (row as HTMLButtonElement).type = "button";
        const cover = element("span", "media-track-art");
        if (track.artwork) {
          const image = element("img") as HTMLImageElement;
          image.src = track.artwork; image.alt = ""; image.width = 28; image.height = 28;
          cover.append(image);
        } else {
          cover.classList.add("blank");
          paintIcon(cover, "media");
        }
        const copy = element("div", "media-track-copy");
        copy.append(element("span", "media-track-title", track.title),
          element("span", "media-track-artist", track.artist));
        const mark = element("span", "media-result-add");
        paintIcon(mark, "plus");
        row.append(cover, copy, mark);
        row.onclick = () => { void this.enqueue(track); };
        results.append(row);
      }
      box.append(results);
    } else if (this.term.trim().length >= 2) {
      box.append(element("p", "media-none", "Nothing found."));
    }
    return box;
  }

  private renderQueue(): HTMLElement {
    const panel = element("aside", "media-queue");
    /* ⚠️ The contents are a FIXED width inside a track that animates. Left to
     * fill the column they would re-wrap every frame on the way in and out —
     * three titles reflowing through eight line-breaks each, which reads as a
     * glitch rather than as a panel arriving. Clipped, it slides. */
    const inner = element("div", "media-queue-in");
    panel.append(inner);
    panel.setAttribute("aria-hidden", String(!this.queueOpen));
    // Nothing inside a closed panel is reachable by Tab either.
    (panel as HTMLElement).inert = !this.queueOpen;

    const head = element("div", "media-queue-top");
    head.append(element("h3", "media-queue-head", "Playing Next"));
    if (this.queue.connected) {
      const add = element("button", `media-add${this.adding ? " is-on" : ""}`);
      (add as HTMLButtonElement).type = "button";
      add.setAttribute("aria-label", "Add to the queue");
      add.setAttribute("aria-expanded", String(this.adding));
      add.dataset.tip = "Add to the queue";
      paintIcon(add, "plus");
      add.onclick = () => {
        this.adding = !this.adding;
        this.said = "";
        if (!this.adding) { this.term = ""; this.found = []; }
        this.changed();
        if (this.adding) {
          requestAnimationFrame(() =>
            this.host.querySelector<HTMLInputElement>(".media-search input")?.focus());
        }
      };
      head.append(add);
    }
    inner.append(head);

    if (this.adding) inner.append(this.searchBox());
    if (this.said) inner.append(element("p", "media-said", this.said));

    if (!this.queue.connected) {
      /* ⚠️ Offered, not explained away. Windows' transport session has no
       * concept of a queue, so this is the one part of the player that needs
       * an account — and the way to give it one is two clicks from here. */
      const ask = element("div", "media-ask");
      ask.append(element("p", "", "Connect Spotify to see what is coming next."));
      const connect = element("button", "media-connect", "Open settings");
      (connect as HTMLButtonElement).type = "button";
      connect.onclick = () => { void call("open_task_editor").catch(() => {}); };
      ask.append(connect);
      inner.append(ask);
      return panel;
    }

    if (!this.queue.tracks.length) {
      inner.append(element("p", "media-none", this.queue.note || "Nothing queued."));
      return panel;
    }

    const list = element("div", "media-queue-list scrolls");
    for (const track of this.queue.tracks) {
      const row = element("div", "media-track");
      const cover = element("span", "media-track-art");
      if (track.artwork) {
        const image = element("img") as HTMLImageElement;
        image.src = track.artwork; image.alt = ""; image.width = 34; image.height = 34;
        cover.append(image);
      } else {
        cover.classList.add("blank");
        paintIcon(cover, "media");
      }
      const copy = element("div", "media-track-copy");
      copy.append(element("span", "media-track-title", track.title),
        element("span", "media-track-artist", track.artist));
      row.append(cover, copy);
      list.append(row);
    }
    inner.append(list);
    return panel;
  }
}
