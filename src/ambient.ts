/* Ambient mode: the player, full screen.
 *
 * Its own window (`ambient.rs`), opened from the island. The page grows the
 * player out of the island's rectangle, plays the room behind it — a generated
 * scene that follows the real sky, or a video or still from your own folder —
 * and steps every control back three seconds after the pointer stops.
 *
 * ⚠️ `invoke` directly rather than `task-client`'s `call`. That module carries
 * the task demo fixture and a preview mode for the island; this window never
 * shows a task and has no preview, and pulling both into its bundle would be
 * weight for nothing.
 */
import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { clock } from "./media-format";
import { lineAt, parseLrc, worth, type Line } from "./lyrics";
import { skyAt, type Sky, type SkyChoice, type WeatherChoice } from "./ambient-sky.ts";
import { paletteOf, SCENE_ORDER, SCENES, type Canvases } from "./ambient-scenes.ts";
import { paintIcon, type TaskIcon } from "./task-icons";
import { Lens } from "./ambient-lens.ts";
import { onSystemMotionChange, setMotion, still } from "./motion-pref";
import "./ambient.css";

const native = isTauri();
const call = <T = void>(command: string, args: Record<string, unknown> = {}) =>
  native ? invoke<T>(command, args) : Promise.reject(new Error("not native"));

interface Media {
  active: boolean; playing: boolean; title: string; artist: string; album: string; source: string;
  position: number; duration: number; artwork: string;
  canNext: boolean; canPrevious: boolean; canPlayPause: boolean; canSeek: boolean;
  shuffle: boolean | null; canShuffle: boolean; repeat: string | null; canRepeat: boolean;
}
interface Rect { x: number; y: number; width: number; height: number }
interface Opening { from: Rect; to: Rect; serial: number }
interface Weather { icon: string; sunrise: string; sunset: string }
interface SceneFile { path: string; name: string; kind: "video" | "image" }
interface Scenes { folder: string; files: SceneFile[] }
interface AppVolume { pid: number; name: string; path: string; volume: number; muted: boolean }

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const $$ = <T extends HTMLElement = HTMLElement>(sel: string) => [...document.querySelectorAll<T>(sel)];
const stage = $("stage"), scene = $("scene");

/* ── What is remembered between opens ──────────────────────────────────
 * ⚠️ localStorage, per machine, and deliberately not a synced setting: which
 * room somebody likes to sit in is a mood, not configuration. Wrapped, because
 * a webview with storage blocked must still open. */
interface Choices { layout: "centre" | "side"; scene: string; size: number; sky: SkyChoice; weather: WeatherChoice }
const DEFAULTS: Choices = { layout: "centre", scene: "city", size: 1, sky: "live", weather: "live" };
let choices: Choices = { ...DEFAULTS };
try { choices = { ...DEFAULTS, ...JSON.parse(localStorage.getItem("ambient") || "{}") }; } catch { /* keep defaults */ }
const remember = () => { try { localStorage.setItem("ambient", JSON.stringify(choices)); } catch { /* fine */ } };

/* ── The playing track ─────────────────────────────────────────────────── */
let media: Media | null = null;
let sampledAt = performance.now();
let trackKey = "";
let lines: Line[] = [];
let shownLine = -2;
let palette: number[][] = [];

/** Where the playhead is now. ⚠️ Run forward from the last reading, which
 *  arrives once a second — lyrics stepped on that tick land up to a second
 *  late, which is exactly the lag that makes words feel unsynced. */
function position(): number {
  if (!media) return 0;
  if (!media.playing || media.duration <= 0) return media.position;
  return Math.min(media.duration, media.position + (performance.now() - sampledAt) / 1000);
}

function bind(name: string, value: string) {
  for (const el of $$(`[data-bind="${name}"]`)) {
    if (el instanceof HTMLImageElement) { if (el.src !== value) el.src = value; }
    else if (el.textContent !== value) el.textContent = value;
  }
}

function receive(next: Media) {
  media = next;
  sampledAt = performance.now();
  stage.classList.toggle("is-empty", !next.active);
  const key = `${next.title}\u0000${next.artist}\u0000${next.album}`;
  if (key !== trackKey) {
    trackKey = key;
    bind("title", next.active ? next.title : "Nothing playing");
    bind("artist", next.artist);
    bind("album", next.album);
    bind("cover", next.artwork || BLANK);
    $("quiet").textContent = next.active ? next.title : "Nothing playing";
    loadLyrics(next);
    loadPalette(next.artwork);
    void findVolume();
  }
  for (const b of $$<HTMLButtonElement>('[data-act="playpause"]')) {
    b.setAttribute("aria-label", next.playing ? "Pause" : "Play");
    paintIcon(b, next.playing ? "pause" : "play");
    b.disabled = !next.canPlayPause;
  }
  for (const b of $$<HTMLButtonElement>('[data-act="next"]')) b.disabled = !next.canNext;
  for (const b of $$<HTMLButtonElement>('[data-act="previous"]')) b.disabled = !next.canPrevious;
  /* ⚠️ Shuffle and repeat are HIDDEN, not disabled, when the player does not
   * report them. A browser tab says nothing about either, and a control drawn
   * from a missing answer is one that lies about what it would do. */
  for (const b of $$<HTMLButtonElement>('[data-act="shuffle"]')) {
    b.hidden = next.shuffle === null;
    b.setAttribute("aria-pressed", String(!!next.shuffle));
    b.disabled = !next.canShuffle;
  }
  for (const b of $$<HTMLButtonElement>('[data-act="repeat"]')) {
    b.hidden = next.repeat === null;
    const mode = next.repeat ?? "none";
    b.dataset.mode = mode;
    paintIcon(b, mode === "track" ? "repeatOne" : "repeat");
    b.setAttribute("aria-pressed", String(mode !== "none"));
    b.setAttribute("aria-label", `Repeat: ${mode === "none" ? "off" : mode === "list" ? "all" : "this track"}`);
    b.disabled = !next.canRepeat;
  }
  for (const p of $$<HTMLInputElement>(".pos:not(#vol)")) {
    p.max = String(Math.max(1, next.duration));
    p.disabled = !next.canSeek || next.duration <= 0;
  }
}
const BLANK = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";

async function loadLyrics(m: Media) {
  lines = [];
  shownLine = -2;
  $("lines").replaceChildren();
  stage.classList.add("no-lyrics");
  if (!m.active || !m.title) return;
  const mine = trackKey;
  try {
    const got = await call<{ synced: string; plain: string }>("get_lyrics", {
      artist: m.artist, track: m.title, album: m.album, seconds: Math.round(m.duration),
    });
    if (mine !== trackKey) return;
    const parsed = parseLrc(got.synced || "");
    /* ⚠️ SYNCED words only. Plain lyrics are a wall of text that does not
     * move, and a wall of text is the opposite of what this screen is for —
     * the title sits quietly where the words would have been instead. */
    if (!worth(parsed)) return;
    showLines(parsed);
  } catch { /* no words: the title stays */ }
}

function showLines(parsed: Line[]) {
  lines = parsed;
  shownLine = -2;
  const host = $("lines");
  host.replaceChildren();
  for (const one of parsed) {
    const p = document.createElement("p");
    p.className = "line" + (one.text ? "" : " gap");
    p.textContent = one.text || "· · ·";
    host.append(p);
  }
  stage.classList.remove("no-lyrics");
}

function placeLyrics(force = false) {
  if (!lines.length) return;
  const n = Math.max(0, lineAt(lines, position()));
  if (n === shownLine && !force) return;
  shownLine = n;
  const host = $("lines"), box = $("lyr"), kids = [...host.children] as HTMLElement[];
  kids.forEach((el, j) => {
    el.classList.toggle("is-now", j === n);
    el.classList.toggle("is-next", j === n + 1);
    el.classList.toggle("is-past", j < n);
    el.classList.toggle("is-near", Math.abs(j - n) === 1);
    /* How far from the voice, for the fade and the blur. ⚠️ Capped, so a
     * line forty rows away is not asked for a 28px blur nobody can see. */
    el.style.setProperty("--far", String(Math.min(4, Math.abs(j - n))));
  });
  const line = kids[n];
  if (!line) return;
  /* ⚠️ No line changes size when it becomes current (see `.line` in the
   * stylesheet), so the offsets read here are the offsets it will have — the
   * centring cannot be measured against a height that is about to change. */
  requestAnimationFrame(() => {
    host.style.transform = `translateY(${box.clientHeight / 2 - line.offsetTop - line.offsetHeight / 2}px)`;
  });
}

function loadPalette(src: string) {
  if (!src) { palette = []; return; }
  const img = new Image();
  img.onload = () => { palette = paletteOf(img); };
  img.src = src;
}

/* ── Volume of the playing app ─────────────────────────────────────────
 * ⚠️ The APP's volume, not the system's, through the same audio sessions the
 * mixer screen drives — turning the music down here must not also mute a
 * call. Matched to the media session by executable, which is what Windows
 * gives the session as its source (`Spotify.exe`). A source with no audio
 * session of its own — a browser tab, often — simply gets no slider. */
let volumePid = 0;
async function findVolume() {
  const wrap = $("volWrap");
  if (!media?.source) { wrap.hidden = true; return; }
  try {
    const apps = await call<AppVolume[]>("get_mixer");
    const want = media.source.toLowerCase().replace(/\.exe$/, "");
    const found = apps.find(a => {
      const exe = (a.path.split(/[\\/]/).pop() || "").toLowerCase().replace(/\.exe$/, "");
      return exe === want || a.name.toLowerCase() === want;
    });
    wrap.hidden = !found;
    if (found) {
      volumePid = found.pid;
      const v = $<HTMLInputElement>("vol");
      v.value = String(Math.round(found.volume * 100));
      v.style.setProperty("--p", `${v.value}%`);
    }
  } catch { wrap.hidden = true; }
}

/* ── The weather outside, and your own folder ──────────────────────────── */
let weather: Weather | null = null;
let own: Scenes = { folder: "", files: [] };
let sky: Sky = skyAt({ now: new Date() });
function refreshSky() {
  sky = skyAt({
    now: new Date(), sunrise: weather?.sunrise, sunset: weather?.sunset, icon: weather?.icon,
    sky: choices.sky, weather: choices.weather,
  });
}

/* ── The scene ─────────────────────────────────────────────────────────── */
const far = $<HTMLCanvasElement>("far"), near = $<HTMLCanvasElement>("near");
const canvases: Canvases = { far: far.getContext("2d")!, near: near.getContext("2d")!, W: 0, H: 0, FW: 0, FH: 0, S: 1 };
const built = new Set<string>();
const lens = new Lens($<HTMLCanvasElement>("bloom"), $("grain"), stage);

function size() {
  /* ⚠️ Capped. A 4K monitor at 200% would otherwise be a 7680-pixel canvas
   * repainted sixty times a second for a room that is mostly blur. */
  const dpr = Math.min(1.5, window.devicePixelRatio || 1);
  const W = Math.max(640, Math.round(Math.min(1920, window.innerWidth * dpr)));
  const H = Math.round(W * window.innerHeight / Math.max(1, window.innerWidth));
  Object.assign(canvases, { W, H, S: W / 1000, FW: Math.round(W / 3), FH: Math.round(H / 3) });
  near.width = W; near.height = H;
  far.width = canvases.FW; far.height = canvases.FH;
  lens.size(W, H);
  built.clear();
}

const vA = $<HTMLVideoElement>("vA"), vB = $<HTMLVideoElement>("vB"), stillImg = $<HTMLImageElement>("still");
let activeVideo: HTMLVideoElement | null = null;
let swapping = false;

function isOwn(id: string) { return id.startsWith("own:"); }
function ownFile(id: string) { return own.files.find(f => `own:${f.path}` === id); }

function applyScene() {
  let id = choices.scene;
  // A file that has gone from the folder falls back rather than showing black.
  if (isOwn(id) && !ownFile(id)) id = "city";
  if (!isOwn(id) && !SCENES[id]) id = "city";
  stage.dataset.scene = isOwn(id) ? "own" : id;
  stage.classList.toggle("is-own", isOwn(id));
  for (const v of [vA, vB]) { v.pause(); v.classList.remove("on"); }
  stillImg.classList.remove("on");
  activeVideo = null;
  if (!isOwn(id)) return;
  const file = ownFile(id)!;
  const src = convertFileSrc(file.path);
  if (file.kind === "image") {
    stillImg.src = src;
    stillImg.classList.add("on");
  } else {
    vA.src = src; vB.src = src;
    vA.currentTime = 0;
    void vA.play().catch(() => {});
    vA.classList.add("on");
    activeVideo = vA;
  }
}

/* ⚠️ A seamless loop is two videos, not `loop`. The attribute hitches at the
 * seam on several codecs — a visible stall once a minute in a room that is
 * supposed to be still. The other copy starts a second early and crossfades. */
function loopVideo() {
  const a = activeVideo;
  if (!a || swapping || !a.duration || a.currentTime < a.duration - 1.2) return;
  swapping = true;
  const b = a === vA ? vB : vA;
  b.currentTime = 0;
  void b.play().catch(() => {});
  b.classList.add("on");
  a.classList.remove("on");
  setTimeout(() => { a.pause(); activeVideo = b; swapping = false; }, 1200);
}

/* ── The loop ──────────────────────────────────────────────────────────── */
let frame = 0, last = 0, clockT = 0, skyAtT = 0;
function tick(now: number) {
  const dt = last ? Math.min(0.1, (now - last) / 1000) : 0.016;
  last = now;
  clockT += dt;
  if (now - skyAtT > 1000) { skyAtT = now; refreshSky(); updateTimes(); lens.mood(sky, isOwn(choices.scene)); }
  placeLyrics();
  loopVideo();
  const calm = still();
  if (!isOwn(choices.scene) && (!calm || !built.has("drawn"))) {
    const s = SCENES[stage.dataset.scene || "city"] ?? SCENES.city;
    if (!built.has(s.id)) { s.build(canvases); built.add(s.id); }
    s.draw(canvases, sky, clockT, calm ? 0 : dt, { palette });
    if (calm) built.add("drawn");
  }
  /* The lens over whatever is up. Your own scene blooms from its own frame;
   * the colour wash does not bloom at all — it is already nothing but glow. */
  const own = isOwn(choices.scene);
  if (!calm || !built.has("lensed")) {
    const src: CanvasImageSource[] = own
      ? [activeVideo ?? stillImg]
      : [far, near];
    if (stage.dataset.scene !== "artwork") lens.frame(src, now, !calm);
    if (calm) built.add("lensed");
  }
  frame = requestAnimationFrame(tick);
}
function run(on: boolean) {
  if (on && !frame) { last = 0; frame = requestAnimationFrame(tick); }
  if (!on && frame) { cancelAnimationFrame(frame); frame = 0; }
}

function updateTimes() {
  if (!media) return;
  const at = position(), dur = media.duration;
  bind("now", clock(at));
  bind("left", dur > 0 ? `-${clock(dur - at)}` : "");
  for (const p of $$<HTMLInputElement>(".pos:not(#vol)")) {
    if (document.activeElement !== p) p.value = String(at);
    p.style.setProperty("--p", `${dur > 0 ? (at / dur) * 100 : 0}%`);
  }
}

/* ── Opening and closing ───────────────────────────────────────────────
 * ⚠️ The scene is CLIPPED to the island's rectangle and the clip springs to
 * the window — the island does not fade into a separate full-screen view. It
 * is one shape growing, which is the whole of what makes this read as the
 * player opening rather than as another app launching.
 */
let lastSerial = 0;
let closingTo: Rect | null = null;
const clipOf = (r: Rect) => {
  const w = window.innerWidth, h = window.innerHeight;
  return `inset(${r.y}px ${w - r.x - r.width}px ${h - r.y - r.height}px ${r.x}px round ${Math.min(r.width, r.height) / 2}px)`;
};

function open(o: Opening) {
  if (o.serial === lastSerial) return;
  lastSerial = o.serial;
  closingTo = o.to;
  stage.classList.remove("is-open", "is-closing", "is-idle");
  scene.style.transition = "none";
  scene.style.clipPath = clipOf(o.from);
  stage.hidden = false;
  void scene.offsetWidth;
  scene.style.transition = "";
  refreshSky();
  size();
  applyScene();
  run(true);
  requestAnimationFrame(() => {
    stage.classList.add("is-open");
    scene.style.clipPath = "inset(0px 0px 0px 0px round 0px)";
    setTimeout(() => placeLyrics(true), 820);
  });
  armIdle();
}

let closing = false;
function close() {
  if (closing || stage.hidden) return;
  closing = true;
  menu(false);
  stage.classList.remove("is-open", "is-idle");
  stage.classList.add("is-closing");
  if (closingTo) scene.style.clipPath = clipOf(closingTo);
  const done = () => {
    closing = false;
    run(false);
    for (const v of [vA, vB]) v.pause();
    /* ⚠️ HIDDEN before the window is. A transparent window that is shown
     * again keeps its last frame until the page repaints, and that frame
     * would be the full-screen room flashing up before the next opening
     * clips it back down. */
    stage.hidden = true;
    void call("ambient_close").catch(() => {});
  };
  setTimeout(done, still() ? 0 : 760);
}

/* ── Controls ──────────────────────────────────────────────────────────── */
const sizes = [1, 1.2, 0.85];
function applyChoices() {
  stage.dataset.layout = choices.layout;
  stage.style.setProperty("--lyr", String(choices.size));
  remember();
  setTimeout(() => placeLyrics(true), 60);
}

function media_(action: string) {
  // Played optimistically, so the button answers now rather than at the next
  // one-second poll; the poll then corrects it if the player said no.
  if (action === "playpause" && media) receive({ ...media, playing: !media.playing, position: position() });
  void call("media_command", { action }).catch(() => {});
}

const acts: Record<string, () => void> = {
  playpause: () => media_("playpause"),
  next: () => media_("next"),
  previous: () => media_("previous"),
  shuffle: () => media_("shuffle"),
  repeat: () => media_("repeat"),
  close: () => close(),
  layout: () => { choices.layout = choices.layout === "centre" ? "side" : "centre"; applyChoices(); },
  size: () => { choices.size = sizes[(sizes.indexOf(choices.size) + 1) % sizes.length] ?? 1; applyChoices(); setTimeout(() => placeLyrics(true), 650); },
  menu: () => menu($("menu").hidden),
  folder: () => { void call<Scenes | null>("ambient_pick_folder").then(s => { if (s) setOwn(s); }).catch(() => {}); },
};
document.addEventListener("click", e => {
  const b = (e.target as HTMLElement).closest<HTMLElement>("[data-act]");
  if (b && !(b as HTMLButtonElement).disabled) { e.stopPropagation(); acts[b.dataset.act!]?.(); return; }
  // A click anywhere outside the menu puts it away.
  if (!$("menu").hidden && !(e.target as HTMLElement).closest("#menu")) menu(false);
});
for (const p of $$<HTMLInputElement>(".pos:not(#vol)")) {
  p.addEventListener("change", () => {
    const at = Number(p.value);
    if (media) receive({ ...media, position: at });
    void call("media_seek", { seconds: at }).catch(() => {});
  });
}
$<HTMLInputElement>("vol").addEventListener("input", e => {
  const v = e.target as HTMLInputElement;
  v.style.setProperty("--p", `${v.value}%`);
  if (volumePid) void call("set_app_volume", { pid: volumePid, volume: Number(v.value) / 100 }).catch(() => {});
});
scene.addEventListener("dblclick", e => {
  if (!(e.target as HTMLElement).closest("button, input, #menu")) close();
});
document.addEventListener("keydown", e => {
  if (e.key === "Escape") { e.preventDefault(); if (!$("menu").hidden) menu(false); else close(); }
  if (e.key === " " && !(e.target as HTMLElement).closest("button, input")) { e.preventDefault(); media_("playpause"); }
});

/* Idle: every control steps back three seconds after the pointer stops. */
let idleTimer = 0;
function armIdle() {
  stage.classList.remove("is-idle");
  clearTimeout(idleTimer);
  idleTimer = window.setTimeout(() => {
    // Not while the menu is open — it would vanish under the pointer.
    if ($("menu").hidden) stage.classList.add("is-idle");
  }, 3000);
}
document.addEventListener("pointermove", armIdle);

/* ── The scene menu ────────────────────────────────────────────────────── */
const SKY_CHOICES: [SkyChoice, string][] = [["live", "Now"], ["dawn", "Dawn"], ["day", "Day"], ["dusk", "Dusk"], ["night", "Night"]];
const WEATHER_CHOICES: [WeatherChoice, string][] = [["live", "Outside"], ["clear", "Clear"], ["clouds", "Clouds"], ["rain", "Rain"], ["snow", "Snow"], ["fog", "Fog"], ["storm", "Storm"]];

function menu(on: boolean) {
  $("menu").hidden = !on;
  for (const b of $$('[data-act="menu"]')) b.setAttribute("aria-expanded", String(on));
  if (on) { drawMenu(); clearTimeout(idleTimer); } else armIdle();
}

function drawMenu() {
  const list = $("menuScenes");
  list.replaceChildren();
  const option = (id: string, name: string, note = "") => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "scene-opt";
    if (isOwn(id)) b.dataset.own = ""; else b.dataset.scene = id;
    b.setAttribute("aria-pressed", String(choices.scene === id));
    const swatch = document.createElement("i");
    // Your own files are not a room we can paint a swatch of: their kind instead.
    if (isOwn(id)) paintIcon(swatch, ownFile(id)?.kind === "video" ? "video" : "image");
    b.append(swatch, Object.assign(document.createElement("span"), { textContent: name }));
    if (note) b.append(Object.assign(document.createElement("small"), { textContent: note }));
    b.onclick = () => { choices.scene = id; remember(); applyScene(); drawMenu(); };
    list.append(b);
  };
  for (const id of SCENE_ORDER) option(id, SCENES[id].name);
  for (const f of own.files) option(`own:${f.path}`, f.name, f.kind === "video" ? "video" : "still");

  /* ⚠️ Time and weather only for the generated rooms. Your own video has its
   * own weather in it, and a control that changed nothing would be a lie. */
  $("menuSky").hidden = isOwn(choices.scene);
  const chips = (host: HTMLElement, items: [string, string][], key: "sky" | "weather") => {
    host.replaceChildren();
    for (const [value, label] of items) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chip";
      b.textContent = label;
      b.setAttribute("aria-pressed", String(choices[key] === value));
      b.onclick = () => { (choices as unknown as Record<string, string>)[key] = value; remember(); refreshSky(); drawMenu(); };
      host.append(b);
    }
  };
  chips($("chipsSky"), SKY_CHOICES, "sky");
  chips($("chipsWeather"), WEATHER_CHOICES, "weather");
  $("folderLabel").textContent = own.folder ? "Change your folder…" : "Add your own folder…";
}

function setOwn(s: Scenes) {
  own = s;
  if (!$("menu").hidden) drawMenu();
  if (isOwn(choices.scene) && !ownFile(choices.scene)) applyScene();
}

/* ── Boot ──────────────────────────────────────────────────────────────── */
/* ── The app's own preferences ──────────────────────────────────────────
 * The accent and the motion switch, from the same prefs every other window
 * reads. ⚠️ Without this the page is in the stylesheet's stock green whatever
 * the user picked, and it moves whatever they said about motion. */
interface Prefs { accent: string; motion: string }
function applyPrefs(p: Prefs) {
  if (p.accent) document.documentElement.style.setProperty("--accent", p.accent);
  setMotion(p.motion);
  // A room drawn once for "still" must be drawn again if motion comes back.
  built.delete("drawn");
}

async function boot() {
  for (const el of $$("[data-glyph]")) paintIcon(el, el.dataset.glyph as TaskIcon);
  onSystemMotionChange(() => built.delete("drawn"));
  applyChoices();
  window.addEventListener("resize", () => { size(); placeLyrics(true); });
  if (!native) { preview(); return; }
  try { applyPrefs(await call<Prefs>("get_prefs")); } catch { /* the stock accent stands */ }
  await listen<Prefs>("notch:prefs", e => applyPrefs(e.payload));
  await listen<Media>("media:changed", e => receive(e.payload));
  await listen<Weather | null>("notch:weather", e => { weather = e.payload; refreshSky(); });
  await listen<Scenes>("ambient:scenes", e => setOwn(e.payload));
  await listen<Opening>("ambient:open", e => open(e.payload));
  try { receive(await call<Media>("get_media")); } catch { /* nothing playing */ }
  try { weather = await call<Weather | null>("get_weather"); } catch { /* no module */ }
  try { setOwn(await call<Scenes>("ambient_scenes")); } catch { /* no folder */ }
  /* ⚠️ Asked for, as well as listened for. The first open BUILDS this
   * window, and the event announcing it is sent before the page has loaded
   * to hear it — every first open would otherwise be a window that appears
   * and shows nothing. `serial` stops the second path replaying the first. */
  const pending = await call<Opening | null>("ambient_pending").catch(() => null);
  if (pending) open(pending);
  // Focus follows the window being shown, so Escape reaches this page.
  void getCurrentWindow().setFocus().catch(() => {});
}
/** A plain browser: a sample track and words, so the layout can be looked at
 *  without the app. ⚠️ Never reached in the app — `native` is true there. */
function preview() {
  // `?scene=cabin&sky=day&weather=snow&layout=side` — for looking at a room without waiting for it.
  const q = new URLSearchParams(location.search);
  const pick = <K extends keyof Choices>(k: K) => { const v = q.get(k); if (v) (choices as unknown as Record<string, string>)[k] = v; };
  (["scene", "sky", "weather", "layout"] as (keyof Choices)[]).forEach(pick);
  applyChoices();
  receive({
    active: true, playing: true, title: "Midnight Window", artist: "Hollow Fields", album: "A Quieter Place",
    source: "", position: 20, duration: 280, artwork: "", canNext: true, canPrevious: true, canPlayPause: true,
    canSeek: true, shuffle: false, canShuffle: true, repeat: "none", canRepeat: true,
  });
  showLines(parseLrc([
    "[00:00.00]", "[00:09.00]The rain makes a softer kind of sound", "[00:17.00]And for a moment, time slows down",
    "[00:25.00]We're just here, and that's enough", "[00:33.00]Nothing left to hurry up", "[00:42.00]",
    "[00:49.00]Lamps come on along the river", "[00:56.00]Someone's kettle, someone's song",
  ].join("\n")));
  const w = window.innerWidth;
  open({ from: { x: w / 2 - 150, y: 8, width: 300, height: 44 }, to: { x: w / 2 - 150, y: 8, width: 300, height: 44 }, serial: 1 });
}

void boot();
