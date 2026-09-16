import {
  PauseIcon, PlayIcon, StopIcon, Tick02Icon, ListViewIcon, PinIcon, Settings01Icon,
  Cancel01Icon, ArrowDown01Icon, PlusSignIcon, FocusIcon,
  PreviousIcon, NextIcon, MusicNote01Icon, Calendar01Icon, CheckListIcon, Video01Icon,
  Home01Icon, ListViewIcon as AgendaIcon, GridIcon, BluetoothIcon, SpeakerIcon,
  ComputerIcon, Sun03Icon, VolumeHighIcon, VolumeOffIcon, Clock01Icon, SquareLock02Icon,
  ChipIcon, RamMemoryIcon, HardDriveIcon, AiBrain01Icon,
  CloudIcon, CloudSunRainIcon, CloudFogIcon, CloudDrizzleIcon, CloudMidRainIcon,
  CloudBigRainIcon, CloudSnowIcon, CloudLightningIcon,
  File01Icon, Note01Icon, Link01Icon, Copy01Icon, Folder01Icon,
  ArrowUpRight01Icon, InboxIcon, Analytics01Icon, AlarmClockIcon, Search01Icon,
  SourceCodeIcon, Image01Icon, Pdf01Icon, Zip01Icon, Txt01Icon, Doc01Icon,
  Xls01Icon, Ppt01Icon, Mp301Icon, ComputerTerminal01Icon, Rocket01Icon, StarIcon,
  KeyboardIcon,
  Mic01Icon, MicOff01Icon, ScreenShareIcon, HandIcon, CallEnd01Icon,
} from "@hugeicons/core-free-icons";

const icons = {
  pause: PauseIcon, play: PlayIcon, stop: StopIcon, check: Tick02Icon, list: ListViewIcon,
  pin: PinIcon, settings: Settings01Icon, close: Cancel01Icon, down: ArrowDown01Icon,
  plus: PlusSignIcon, focus: FocusIcon,
  previous: PreviousIcon, next: NextIcon, media: MusicNote01Icon,
  calendar: Calendar01Icon, today: CheckListIcon, join: Video01Icon,
  home: Home01Icon, agenda: AgendaIcon, grid: GridIcon,
  bluetooth: BluetoothIcon, speaker: SpeakerIcon,
  system: ComputerIcon, sun: Sun03Icon, volume: VolumeHighIcon, volumeOff: VolumeOffIcon,
  clock: Clock01Icon, lock: SquareLock02Icon,
  // The resting pill's modules.
  chip: ChipIcon, memory: RamMemoryIcon, disk: HardDriveIcon, agent: AiBrain01Icon,
  /* Weather, keyed by the names weather.rs emits. ⚠️ These strings cross the
     IPC boundary as data, so renaming one here without renaming it in
     `describe()` leaves the pill with no icon and no error. */
  wxClear: Sun03Icon, wxPartly: CloudSunRainIcon, wxCloud: CloudIcon, wxFog: CloudFogIcon,
  wxDrizzle: CloudDrizzleIcon, wxRain: CloudMidRainIcon, wxHeavyRain: CloudBigRainIcon,
  wxSnow: CloudSnowIcon, wxStorm: CloudLightningIcon,
  // The shelf, the review and snoozing.
  file: File01Icon, note: Note01Icon, link: Link01Icon, copy: Copy01Icon,
  folder: Folder01Icon, open: ArrowUpRight01Icon, shelf: InboxIcon,
  review: Analytics01Icon, snooze: AlarmClockIcon, search: Search01Icon,
  /* What a file IS, at a glance. ⚠️ The point is not decoration: a list of
     Everything hits is a column of identical rows, and the icon is the only
     part of a row you read without reading it. See file-kind.ts for the map. */
  code: SourceCodeIcon, image: Image01Icon, pdf: Pdf01Icon, zip: Zip01Icon,
  text: Txt01Icon, doc: Doc01Icon, sheet: Xls01Icon, slides: Ppt01Icon,
  audio: Mp301Icon, video: Video01Icon, exe: ComputerTerminal01Icon,
  app: Rocket01Icon, star: StarIcon,
  // The settings window's page strip.
  keyboard: KeyboardIcon,
  /* In a call. ⚠️ There is no camera-off glyph and there should not be: the
     app never says whether your camera is on, so an icon that claimed to know
     would be decoration that lies. The mute has two because the microphone
     endpoint's state IS readable — see call.rs. */
  mic: Mic01Icon, micOff: MicOff01Icon, share: ScreenShareIcon,
  hand: HandIcon, hangup: CallEnd01Icon,
};
export type TaskIcon = keyof typeof icons;

/** Render Hugeicons' static SVG data without introducing a UI framework. */
export function taskIcon(name: TaskIcon) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [key, value] of Object.entries({ viewBox: "0 0 24 24", fill: "none", width: "20", height: "20", "aria-hidden": "true", focusable: "false", "stroke-linecap": "round", "stroke-linejoin": "round" })) svg.setAttribute(key, value);
  for (const [tag, attributes] of icons[name]) {
    const child = document.createElementNS(svg.namespaceURI, tag);
    for (const [key, value] of Object.entries(attributes)) if (key !== "key") child.setAttribute(key.replace(/[A-Z]/g, c => "-" + c.toLowerCase()), String(value));
    svg.append(child);
  }
  return svg;
}

/** Draw an icon into a host, and animate it in when it REPLACES another.
 *
 * ⚠️ Only on a change, never on the first paint. Animating the first one turns
 * every screen switch into a field of thirty icons popping in at once, which is
 * the entrance nobody asked for — the same reason `AnimatePresence` ships with
 * `initial={false}`.
 *
 * The class is removed on the way out so the animation can run again; without
 * that, an icon that swaps twice only ever animates once. */
export function paintIcon(target: HTMLElement, name: TaskIcon) {
  if (target.dataset.icon === name) return;
  const replacing = !!target.dataset.icon;
  target.classList.remove("icon-swapped");
  target.replaceChildren(taskIcon(name));
  target.dataset.icon = name;
  if (replacing) {
    // Read back, so the class lands on a fresh element rather than being
    // added and removed inside one frame.
    void target.offsetWidth;
    target.classList.add("icon-swapped");
  }
}
