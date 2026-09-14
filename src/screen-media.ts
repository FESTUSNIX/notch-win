/* Now playing — whatever owns the system transport controls.
 *
 * Nothing here knows about Spotify. `media.rs` reads Windows' own
 * GlobalSystemMediaTransportControls, which is what the media keys drive, so a
 * YouTube tab and a desktop player look identical from up here.
 */
import { element } from "./task-list";
import { paintIcon } from "./task-icons";
import { call, native } from "./task-client";
import { setText } from "./tween";
import { clock, sourceName, waveform } from "./media-format";

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

/** Bars across the scrubber. Enough to read as a waveform, few enough that
 *  each one is still a couple of pixels wide in a ~600px track. */
const BARS = 72;
/** Bars at the playhead that animate while playing. Only these: a whole played
 *  region in motion would say "this audio is playing again", which it is not. */
const HEAD = 4;

export interface AudioDevice {
  id: string;
  name: string;
  isDefault: boolean;
  isBluetooth: boolean;
}

export class MediaScreen {
  media: Media = emptyMedia();
  error = "";
  /** When `media.position` was sampled, so playback can be run forward between
   *  polls instead of ticking once a second in visible one-second jumps. */
  private sampledAt = Date.now();
  /** When playback stopped, or null while it is running. */
  private pausedAt: number | null = null;

  constructor(private host: HTMLElement, private changed: () => void) {}

  async boot() {
    if (native) await listen<Media>("media:changed", e => this.receive(e.payload));
    try { this.receive(await call<Media>("get_media")); } catch { /* no session yet */ }
  }

  private receive(next: Media) {
    // Track when it stopped, not merely that it did: a player paused a minute
    // ago is not news, and it should hand the pill back to the clock.
    if (next.playing) this.pausedAt = null;
    else if (this.pausedAt === null || !this.media.active) this.pausedAt = Date.now();
    this.media = next;
    this.sampledAt = Date.now();
    this.changed();
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
      && Date.now() - this.pausedAt > MediaScreen.PAUSED_GRACE) {
      return null;
    }
    return {
      /* Playing beats the day's resting tally and a paused player; it loses to
       * a focus session and to an imminent meeting. Paused stays on the list so
       * the pill can still offer the controls, but it claims almost nothing. */
      priority: this.media.playing ? 40 : 15,
      screen: "media",
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
  tick() {
    if (!this.media.active || this.media.duration <= 0) return;
    const position = this.position();
    const played = Math.round((position / this.media.duration) * BARS);
    const bars = this.host.querySelectorAll<HTMLElement>(".wave i");
    bars.forEach((bar, i) => {
      bar.classList.toggle("on", i < played);
      bar.classList.toggle("head", i < played && i >= played - HEAD);
    });
    const elapsed = this.host.querySelector<HTMLElement>(".media-time");
    if (elapsed) setText(elapsed, clock(position));
  }

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

  render() {
    this.host.replaceChildren();
    if (!this.media.active) {
      const empty = element("div", "day-empty");
      empty.append(
        element("h3", "", "Nothing playing"),
        element("p", "", "Start something in Spotify, a browser tab or any player and it appears here."),
      );
      this.host.append(empty);
      return;
    }

    /* Art left, everything else right. A centred column put the artwork in the
     * middle of a bar three times as wide as it is tall and pushed the
     * transport off the bottom edge. */
    const row = element("div", "media-row");

    const art = element("div", "media-art");
    if (this.media.artwork) {
      const image = element("img") as HTMLImageElement;
      image.src = this.media.artwork;
      image.alt = "";
      image.width = 150;
      image.height = 150;
      art.append(image);
    } else {
      art.classList.add("blank");
      paintIcon(art, "media");
    }

    const side = element("div", "media-side");
    /* Two lines, not three. Artist and app were separate rows and the screen
     * came out five deep in a bar that is only ever a few rows tall. */
    const copy = element("div", "media-copy");
    copy.append(element("h3", "media-title", this.media.title || "Unknown track"));
    const by = [this.media.artist, sourceName(this.media.source)].filter(Boolean).join("  ·  ");
    if (by) copy.append(element("p", "media-artist", by));
    side.append(copy);

    const position = this.position();
    // ⚠️ Only drawn when the player reports a timeline. Some do not, and a bar
    // that never moves reads as a stall rather than as missing information.
    if (this.media.duration > 0) {
      const scrub = element("div", `media-scrub${this.media.canSeek ? " seekable" : ""}`);
      const wave = element("div", `wave${this.media.playing ? " playing" : ""}`);
      const heights = waveform(`${this.media.title}|${this.media.artist}`, BARS);
      const played = Math.round((position / this.media.duration) * BARS);
      heights.forEach((height, i) => {
        const bar = element("i",
          i < played ? (i >= played - HEAD ? "on head" : "on") : "");
        bar.style.height = `${Math.round(height * 100)}%`;
        // Staggered, so the played bars ripple rather than pulse as one block.
        bar.style.animationDelay = `${(i % 12) * 70}ms`;
        wave.append(bar);
      });
      if (this.media.canSeek) {
        wave.setAttribute("role", "slider");
        wave.setAttribute("aria-label", "Seek");
        wave.setAttribute("aria-valuemin", "0");
        wave.setAttribute("aria-valuemax", String(Math.round(this.media.duration)));
        wave.setAttribute("aria-valuenow", String(Math.round(position)));
        wave.setAttribute("tabindex", "0");
        wave.onclick = event => {
          const box = wave.getBoundingClientRect();
          this.seek((event.clientX - box.left) / box.width);
        };
        wave.onkeydown = event => {
          const step = event.key === "ArrowLeft" ? -5 : event.key === "ArrowRight" ? 5 : 0;
          if (!step) return;
          event.preventDefault();
          this.seek((this.position() + step) / this.media.duration);
        };
      }
      scrub.append(wave);
      side.append(scrub);
    }

    /* The transport shares a row with the two timestamps rather than taking one
     * of its own: elapsed, controls, remaining, on the line under the wave. */
    const foot = element("div", "media-foot");
    const elapsed = element("span", "media-time", clock(position));
    const total = element("span", "media-time", this.media.duration > 0 ? clock(this.media.duration) : "");
    const controls = element("div", "media-controls");
    const button = (icon: Parameters<typeof paintIcon>[1], label: string, enabled: boolean, action: string, big = false) => {
      const b = element("button", big ? "media-button primary" : "media-button");
      (b as HTMLButtonElement).type = "button";
      b.setAttribute("aria-label", label);
      b.title = label;
      (b as HTMLButtonElement).disabled = !enabled;
      paintIcon(b, icon);
      b.onclick = () => this.control(action);
      return b;
    };
    controls.append(
      button("previous", "Previous track", this.media.canPrevious, "previous"),
      button(this.media.playing ? "pause" : "play", this.media.playing ? "Pause" : "Play", this.media.canPlayPause, "playpause", true),
      button("next", "Next track", this.media.canNext, "next"),
    );
    foot.append(elapsed, controls, total);
    side.append(foot);

    row.append(art, side);
    this.host.append(row);
    if (this.error) this.host.append(element("p", "screen-error", this.error));
  }
}
