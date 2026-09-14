import {
  PauseIcon, PlayIcon, StopIcon, Tick02Icon, ListViewIcon, PinIcon, Settings01Icon,
  Cancel01Icon, ArrowDown01Icon, PlusSignIcon, FocusIcon,
  PreviousIcon, NextIcon, MusicNote01Icon, Calendar01Icon, CheckListIcon, Video01Icon,
  Home01Icon, ListViewIcon as AgendaIcon, GridIcon, BluetoothIcon, SpeakerIcon,
  ComputerIcon, Sun03Icon, VolumeHighIcon, VolumeOffIcon, Clock01Icon, SquareLock02Icon,
  ChipIcon, RamMemoryIcon, HardDriveIcon, AiBrain01Icon,
  CloudIcon, CloudSunRainIcon, CloudFogIcon, CloudDrizzleIcon, CloudMidRainIcon,
  CloudBigRainIcon, CloudSnowIcon, CloudLightningIcon,
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

export function paintIcon(target: HTMLElement, name: TaskIcon) {
  if (target.dataset.icon === name) return;
  target.replaceChildren(taskIcon(name));
  target.dataset.icon = name;
}
