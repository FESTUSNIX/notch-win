/* Now playing — whatever owns the system transport controls.
 *
 * Nothing here knows about Spotify. `media.rs` reads Windows' own
 * GlobalSystemMediaTransportControls, which is what the media keys drive, so a
 * YouTube tab and a desktop player look identical from up here.
 */
import { call, native } from "./task-client";
import { sourceName } from "./media-format";

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
