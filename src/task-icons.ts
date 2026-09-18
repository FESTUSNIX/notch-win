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
  Notification01Icon, Timer01Icon, ArrowLeft01Icon, Coffee02Icon, Target01Icon, SubtitleIcon, ShuffleIcon,
} from "@hugeicons/core-free-icons";

/* ── The agents' own marks ──────────────────────────────────
   The REAL ones, taken from each vendor's own VS Code extension on this
   machine — `anthropic.claude-code/resources/claude-logo.svg` and
   `openai.chatgpt/resources/blossom-black.svg`.

   ⚠️ A logo drawn from memory is wrong, and it is wrong in the one place
   where being approximately right is worth nothing: a mark is recognised
   before it is read, so a burst with the wrong number of rays reads as "some
   app" rather than as Claude. The first version here was eight even spokes,
   which is a compass rose.

   ⚠️ FILLED paths in `currentColor`, not the brand colours. Every glyph in
   this app takes the colour of whatever it sits in — a state tint, a hover, a
   phase — and two hardcoded brand oranges would be the only two icons that
   ignored all of it. The SHAPE is the mark; the colour is this app's. */
const CLAUDE_MARK: [string, Record<string, string>][] = [
  ["path", {
    d: "M4.709 "
      + "15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 "
      + "11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 "
      + "2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 "
      + "1.908 1.476 2.491 "
      + "1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 "
      + "2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 "
      + "1.555 "
      + "3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 "
      + "1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 "
      + "1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 "
      + "1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 "
      + "1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 "
      + "1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 "
      + "1.068 2.006 1.81 2.509 "
      + "2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 "
      + "2.345 3.521.122 "
      + "1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 "
      + "7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 "
      + "1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 "
      + "2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 "
      + "18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z",
    fill: "currentColor",
  }],
];

const CODEX_MARK: [string, Record<string, string>][] = [
  ["path", {
    d: "M13.795 23.856q-1.188 0-2.256-.448a6.1 6.1 0 0 1-1.9-1.247 5.8 5.8 0 0 "
      + "1-1.875.306 5.8 5.8 0 0 1-2.944-.777 6.1 6.1 0 0 "
      + "1-2.184-2.12q-.807-1.34-.808-2.99 0-.682.19-1.482a6.3 6.3 0 0 "
      + "1-1.472-2.002 5.76 5.76 0 0 1 .024-4.85q.546-1.177 1.52-2.024a5.5 5.5 0 0 "
      + "1 2.303-1.2A5.55 5.55 0 0 1 5.485 2.62 6.06 6.06 0 0 1 7.575.925 5.85 5.85 "
      + "0 0 1 10.21.313q1.187 0 2.255.447a6.1 6.1 0 0 1 1.9 1.248 5.8 5.8 0 0 1 "
      + "1.875-.306q1.59 0 2.944.776a5.9 5.9 0 0 1 2.16 2.12q.832 1.34.832 2.99 0 "
      + ".682-.19 1.483a6.2 6.2 0 0 1 1.472 2.024q.522 1.13.522 2.378 0 1.272-.546 "
      + "2.449a6.1 6.1 0 0 1-1.543 2.048 5.45 5.45 0 0 1-2.28 1.177 5.4 5.4 0 0 "
      + "1-1.115 2.402 5.8 5.8 0 0 1-2.066 1.695 5.85 5.85 0 0 1-2.635.612M7.93 "
      + "20.913q1.188 0 2.066-.495l4.463-2.542a.52.52 0 0 0 .238-.448v-2.024L8.95 "
      + "18.676a.97.97 0 0 1-1.044 0L3.419 16.11a.7.7 0 0 1-.024.165v.282q0 "
      + "1.201.57 2.213.594.99 1.639 1.554 1.044.59 "
      + "2.326.589m.238-3.838q.143.07.26.07a.46.46 0 0 0 "
      + ".238-.07l1.781-1.012-5.722-3.296q-.522-.306-.522-.918v-5.11a4.27 4.27 0 0 "
      + "0-1.9 1.602 4.13 4.13 0 0 0-.712 2.354q0 1.155.594 2.213.593 1.06 1.543 "
      + "1.601zm5.627 5.227q1.258 0 2.279-.565a4.25 4.25 0 0 0 "
      + "1.614-1.554q.594-.99.594-2.213v-5.085q0-.283-.237-.424l-1.805-1.036v6.568q0 "
      + ".613-.522.919l-4.487 2.566q1.163.825 "
      + "2.564.824m.902-8.617v-3.202l-2.683-1.507-2.707 1.507v3.202l2.707 "
      + "1.507zm-6.933-7.51q0-.612.522-.918l4.488-2.567a4.34 4.34 0 0 "
      + "0-2.564-.824q-1.26 0-2.28.565a4.25 4.25 0 0 0-1.614 1.554q-.57.99-.57 "
      + "2.213v5.062q0 .283.237.447l1.781 1.036zm12.061 11.253a4.13 4.13 0 0 0 "
      + "1.876-1.6 4.2 4.2 0 0 0 "
      + ".712-2.355q0-1.154-.593-2.213-.594-1.06-1.544-1.6l-4.44-2.543q-.142-.095-.26-.071a.46.46 "
      + "0 0 0-.238.07l-1.78.99 5.745 3.319q.26.141.38.377a.9.9 0 0 1 "
      + ".142.518zm-4.772-11.96q.522-.33 1.045 0l4.51 "
      + "2.614v-.424q0-1.13-.57-2.142a4.1 4.1 0 0 "
      + "0-1.59-1.648q-1.02-.613-2.374-.613-1.187 0-2.066.495L9.545 6.292a.52.52 0 "
      + "0 0-.238.448v2.025z",
    fill: "currentColor",
  }],
];

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
  // The header's two chips.
  bell: Notification01Icon, timer: Timer01Icon, back: ArrowLeft01Icon,
  /* A pomodoro's two halves. ⚠️ An icon as well as a colour: the words
     "Focus" and "Break" are the same length and much the same shape at 10px,
     which is the size the collapsed strip prints them at. */
  coffee: Coffee02Icon,
  /* A pomodoro's two halves. ⚠️ `focus` is a CROSSHAIR — four corner ticks
     and a dot — which at sixteen pixels on a black strip is a smudge rather
     than a symbol. Concentric rings read as one thing at that size. */
  target: Target01Icon,
  /* The lyrics panel. ⚠️ Not `text`, which is a FILE glyph with the letters
     TXT printed inside it — at sixteen pixels beside a speaker that reads as
     a document, not as words being sung. */
  words: SubtitleIcon, shuffle: ShuffleIcon,
  // Whose agent it is. See the marks above.
  claude: CLAUDE_MARK,
  codex: CODEX_MARK,
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
