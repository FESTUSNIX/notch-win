import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { emptySnapshot, localDay, type TaskSnapshot } from "./task-model";
import fixture from "./task-demo.json";

/* Browser-preview stand-ins for the native surfaces. Kept here beside the task
 * fixture rather than in each screen, so `preview` has one home and a screen
 * never has to know whether it is running under Tauri. */
const hoursFromNow = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();
/* `?quiet` puts the preview in its RESTING state: nothing playing and nothing
 * imminent in the calendar. Both of those outrank the day on the collapsed
 * pill, so a test that wants to read the day's own tally has to silence them. */
const quiet = new URLSearchParams(location.search).has("quiet");
/* `?agents` puts a session in the WAITING state.
 * ⚠️ Not the default, and not under `?quiet`. A waiting session claims the
 * pill at priority 55, which outranks media — correctly, because music is
 * ambient and a blocked agent is a request — so having one in the default
 * fixture quietly took the pill away from every media test. */
const agentsFixture = new URLSearchParams(location.search).has("agents");
/* `nocal` pushes the demo agenda out of claiming range but leaves the player
 * alone — the two flags silence different competitors for the pill. */
const nocal = quiet || new URLSearchParams(location.search).has("nocal");
let demoMedia = {
  active: !quiet, playing: !quiet,
  title: "I turned my potion shop into a chaotic factory!",
  artist: "Real Civil Engineer", album: "", source: "Brave",
  position: 263, duration: 1878, artwork: "",
  canNext: false, canPrevious: false, canPlayPause: true, canSeek: true,
};
let demoDevices = [
  {id:"bt", name:"Headphones (6- Mateusz's Buds3 Pro)", isDefault:true, isBluetooth:true},
  {id:"mon", name:"DELL U2724D (NVIDIA High Definition Audio)", isDefault:false, isBluetooth:false},
  {id:"spk", name:"Speakers (Realtek(R) Audio)", isDefault:false, isBluetooth:false},
  {id:"msi", name:"MSI G24C4 (NVIDIA High Definition Audio)", isDefault:false, isBluetooth:false},
  {id:"logi", name:"Speakers (6- Logi Z207)", isDefault:false, isBluetooth:true},
  {id:"steam1", name:"Speakers (Steam Streaming Speakers)", isDefault:false, isBluetooth:false},
  {id:"steam2", name:"Speakers (Steam Streaming Microphone)", isDefault:false, isBluetooth:false},
];
const demoCalendar = {
  connected: true,
  updatedAt: new Date().toISOString(),
  error: null,
  events: [
    { id: "a", title: "Design review", start: hoursFromNow(nocal ? 3 : 0.3), end: hoursFromNow(nocal ? 4 : 1),
      allDay: false, location: "", meetingUrl: "https://meet.google.com/demo",
      calendar: "Work", color: "#5ac8fa", response: "accepted" },
    { id: "b", title: "Lunch with Ada", start: hoursFromNow(4), end: hoursFromNow(5),
      allDay: false, location: "Cafe Mistral", meetingUrl: "",
      calendar: "Personal", color: "#ff9f0a", response: "accepted" },
    { id: "c", title: "Sprint planning", start: hoursFromNow(26), end: hoursFromNow(27.5),
      allDay: false, location: "", meetingUrl: "https://zoom.us/j/demo",
      calendar: "Work", color: "#5ac8fa", response: "needsAction" },
  ],
};

export const native = isTauri();
export const preview = !native;
const sample = (): TaskSnapshot => JSON.parse(JSON.stringify(fixture).replaceAll("$today", localDay()).replaceAll("$now", new Date().toISOString()));
let demo = new URLSearchParams(location.search).has("empty") ? emptySnapshot() : sample();
if(new URLSearchParams(location.search).has("single")) demo.tasks=demo.tasks.filter(t=>t.title==="Get outside for a walk");
const listeners = new Set<(value: TaskSnapshot) => void>();
const emit = () => listeners.forEach(fn => fn(structuredClone(demo)));
const demoStars: Record<string, Record<string, string>> = {};
let demoPrefs: Record<string, unknown> = {
  accent: "#00ff88", weekStartsMonday: true, fahrenheit: false,
  /* ⚠️ Staged from the query string, like `?edge=`. Click mode changes what
     the pill IS — a surface that can hold controls, because the pointer resting
     on it no longer means "open" — and there is no other way to reach it in a
     preview: `notch:prefs` is a native event and the settings window is a
     different page. */
  openOnHover: !new URLSearchParams(location.search).has("click"),
  foldDelayMs: 450, motion: "system", panelWidth: 0, useEverything: true,
  indexApps: true, notifyRuns: true, mutedModules: [], thresholds: {}, taskView: "day",
};
const demoSpaces: Record<string, Record<string, unknown>> = {};

export async function call<T = void>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  if (native) return invoke<T>(command, args);
  if (command === "get_tasks") return structuredClone(demo) as T;
  if (command === "get_task_placement") return {
    /* ⚠️ Staged from the query string. The island lost its own edge and clock
       controls when the settings window took them — and the settings window is
       a different PAGE, so in the preview nothing can reach this one. Without
       this the preview could only ever be looked at welded to the top. */
    edge: new URLSearchParams(location.search).get("edge") ?? "top",
    visible: true,
    clock24: !new URLSearchParams(location.search).has("clock12"),
  } as T;
  /* ⚠️ Held for the page's lifetime, not written anywhere. The point is to
     exercise the round trip — including the validation, which lives in Rust
     and is therefore the one thing this stub cannot reproduce. */
  if (command === "get_prefs") return structuredClone(demoPrefs) as T;
  if (command === "set_prefs") {
    demoPrefs = args.prefs as Record<string, unknown>;
    return structuredClone(demoPrefs) as T;
  }
  if (command === "get_displays") return {screens:[
    {id:"\\.\DISPLAY1", name:"DELL U2720Q", x:0, y:0, width:3840, height:2160, primary:true},
    {id:"\\.\DISPLAY2", name:"LG 24MK430", x:3840, y:0, width:1920, height:1080, primary:false},
  ], notch:null, tasks:null} as T;
  if (command === "set_display" || command === "set_edge") return undefined as T;
  if (command === "get_edge") return "top" as T;
  if (command === "get_autostart") return false as T;
  if (command === "set_autostart") return undefined as T;
  if (command === "get_readings") return [
    {id:"claude", displayName:"Claude", status:{state:"ok"}, windows:[]},
  ] as T;
  if (command === "everything_running") return true as T;
  if (command === "reset_position" || command === "open_log" || command === "quit_app") return undefined as T;
  if (command === "get_media") return structuredClone(demoMedia) as T;
  if (command === "get_calendar") return structuredClone(demoCalendar) as T;
  /* ⚠️ All six, and the ones Rust actually defaults to. This stub was three
     keys and a stale `Ctrl+Alt+N` for `capture` — which is `AltGr+N`, the
     combination that ate `ń` and is the reason the defaults moved. The
     settings window's AltGr guard is what found it: it warned about a shortcut
     no build has shipped for months. */
  if (command === "get_shortcuts") return {palette:"Ctrl+Alt+K",toggle:"Ctrl+Alt+Space",
    capture:"Ctrl+Alt+T",shelf:"Ctrl+Alt+V",display:"Ctrl+Alt+M",hide:"Ctrl+Alt+H"} as T;
  if (command === "get_chrome_hidden") return false as T;
  if (command === "show_chrome" || command === "toggle_chrome") return undefined as T;
  /* ⚠️ Apps and file hits are stubbed here so the BANDING is exercised by
     the real code path rather than argued about. The names share a stem on
     purpose: `code` matches an application, a shelf item and a path, which is
     the only way to see that the three land in that order. */
  if (command === "list_apps") return [
    {name:"Brave", path:"C:/Start/Brave.lnk", icon:null},
    {name:"Visual Studio Code", path:"C:/Start/Code.lnk", icon:null},
    {name:"Notion", path:"C:/Start/Notion.lnk", icon:null},
  ] as T;
  if (command === "everything_search") {
    const wanted = String(args.query ?? "").toLowerCase();
    return [
      {name:"hero.png", path:"C:/CODE/site/public", full:"C:/CODE/site/public/hero.png", folder:false},
      {name:"hero", path:"C:/CODE/site/src/components", full:"C:/CODE/site/src/components/hero", folder:true},
    ].filter(hit => hit.full.toLowerCase().includes(wanted)) as T;
  }
  if (command === "launch_app" || command === "found_open" || command === "found_reveal") return undefined as T;
  /* Stars in the preview live for the page's lifetime only — long enough to
     exercise the round trip, short enough that one test cannot colour another. */
  if (command === "get_stars") return structuredClone(demoStars) as T;
  /* Workspaces in the preview live for the page's lifetime, like the stars:
     long enough to exercise the round trip, short enough that one test cannot
     colour another. */
  if (command === "get_workspaces") return structuredClone(demoSpaces) as T;
  if (command === "save_workspace") {
    demoSpaces[String(args.id)] = args.workspace as Record<string, unknown>;
    return undefined as T;
  }
  if (command === "remove_workspace") { delete demoSpaces[String(args.id)]; return undefined as T; }
  if (command === "add_to_workspace") {
    const space = demoSpaces[String(args.id)] as {name: string; apps: string[]} | undefined;
    if (space && !space.apps.includes(String(args.path))) space.apps.push(String(args.path));
    return (space?.name ?? "") as T;
  }
  if (command === "open_workspace") {
    const space = demoSpaces[String(args.id)] as {apps: string[]} | undefined;
    return `${1 + (space?.apps.length ?? 0)} opened` as T;
  }
  if (command === "set_star") {
    const id = String(args.id ?? "");
    if (args.star) demoStars[id] = args.star as Record<string, string>;
    else delete demoStars[id];
    return true as T;
  }
  if (command === "copy_text") return undefined as T;
  if (command === "open_external") return undefined as T;
  if (command === "google_status") return true as T;
  // ⚠️ Empty, and that is the honest stub: the preview has no account, and a
  // month nobody can ask about draws exactly like a month with nothing in it.
  if (command === "calendar_days") return {} as T;
  if (command === "spotify_status") return true as T;
  if (command === "spotify_redirect") return "http://127.0.0.1:5733/callback" as T;
  if (command === "connect_spotify" || command === "disconnect_spotify") {
    throw new Error("Connect Spotify in the desktop app. This is sample data.");
  }
  /* ⚠️ A queue with a track that has no artwork in it, on purpose: a cover is
     the one field Spotify legitimately omits, and the row still has to be a
     row. Same reason the shelf fixture carries a missing file. */
  /* ⚠️ SIX, not three. Three is exactly the number the list is capped at, so
     a fixture of three proves nothing about the cap — and the cap is the whole
     reason the panel does not grow to the height of a Spotify queue. */
  if (command === "spotify_queue") return {connected:true, note:"", tracks:[
    {id:"q1", title:"Heroine (Cryogenic's Second Wind)", artist:"CRYOGENIC", artwork:""},
    {id:"q2", title:"Roulette", artist:"Bilal Wahib, Boef", artwork:""},
    {id:"q3", title:"Habiba", artist:"Boef", artwork:""},
    {id:"q4", title:"Murder To Excellence", artist:"JAY-Z, Kanye West", artwork:""},
    {id:"q5", title:"No, No, No", artist:"Eve, Stephen Marley", artwork:""},
    {id:"q6", title:"Winnetka Exit", artist:"Styles Of Beyond", artwork:""},
  ]} as T;
  if (command === "spotify_search") {
    const wanted = String(args.query ?? "").toLowerCase();
    return [
      {uri:"spotify:track:1", title:"Mr. Carter", artist:"Lil Wayne, JAY-Z", artwork:""},
      {uri:"spotify:track:2", title:"Ready or Not", artist:"Fugees", artwork:""},
    ].filter(t => t.title.toLowerCase().includes(wanted)) as T;
  }
  if (command === "spotify_enqueue") return undefined as T;
  if (command === "get_app_time") return {day:localDay(), total:16_800, apps:[
    {name:"VS Code", seconds:9000}, {name:"Chrome", seconds:4200},
    {name:"Terminal", seconds:1800}, {name:"Spotify", seconds:900},
  ]} as T;
  if (command === "get_system") return {volume:51, muted:false, brightness:14, bluetooth:[
    {name:"Logi Z207", connected:true, paired:true},
    {name:"Mateusz's Buds3 Pro", connected:true, paired:true},
    {name:"JBL C115TWS", connected:false, paired:true},
    {name:"FestusPhone25", connected:false, paired:true},
  ]} as T;
  if (command === "set_volume" || command === "set_brightness") return undefined as T;
  if (command === "lock_workstation") return undefined as T;
  if (command === "get_machine") return {cpu:34, memory:76, diskUsed:97, diskFree:7_600_000_000,
    network:"Ethernet", uptime:403_200} as T;
  /* The resting pill's modules. ⚠️ `diskUsed: 97` above is this machine's real
     figure and is left alone on purpose — it means the preview shows the disk
     module HOLDING the slot, which is the behaviour worth seeing. The rotation
     among the ambient ones is covered by choose()'s own tests, which need no
     DOM and no fixture. */
  if (command === "get_weather") return {place:"Krakow, Poland", celsius:17,
    summary:"Partly cloudy", icon:"wxPartly", readAtMs: Date.now()} as T;
  if (command === "set_weather_place") return null as T;
  if (command === "get_activity") return [{provider:"claude",
    state: quiet ? "idle" : agentsFixture ? "waiting" : "working",
    running: quiet ? 0 : 1}] as T;
  /* Three sessions in the three states, so the preview shows the ordering:
     whoever wants you first.
     ⚠️ None of them under `?quiet`. A waiting session CLAIMS the pill at
     priority 55, and `quiet` means the preview is in its resting state — with
     sessions here every test that checks the clock would instead find an
     agent, which is exactly what happened when this stub was first written. */
  if (command === "get_sessions") return (quiet ? [] : !agentsFixture ? [
    {id:"s2", project:"codenotch-win", branch:"master", pid:4243, state:"working",
     forSecs:31, input:512_000, output:9_100, lastRunSecs:96, doing:"running cargo test --lib",
     folder:"C:/Users/matko/CODE/_personal/codenotch-win"},
  ] : [
    {id:"s1", project:"akcesfonia", branch:"master", pid:4242, state:"waiting",
     forSecs:214, input:1_284_000, output:38_200, lastRunSecs:252},
    {id:"s2", project:"codenotch-win", branch:"master", pid:4243, state:"working",
     forSecs:31, input:512_000, output:9_100, lastRunSecs:96, doing:"running cargo test --lib",
     folder:"C:/Users/matko/CODE/_personal/codenotch-win"},
    {id:"s3", project:"esono", branch:"feat/pdp", pid:4244, state:"idle",
     forSecs:9_400, input:22_000, output:800, lastRunSecs:0},
  ]) as T;
  if (command === "focus_session") return true as T;
  if (command === "get_snoozed") return {} as T;
  if (command === "snooze" || command === "unsnooze") return undefined as T;
  if (command === "get_shelf") return (quiet ? [] : [
    {id:"f1", kind:"file", name:"Codenotch_0.1.0_x64-setup.exe", path:"C:\\build\\setup.exe",
     text:null, addedMs:Date.now()-60_000, missing:false, size:4_820_000},
    {id:"f2", kind:"link", name:"https://open-meteo.com/en/docs", path:null,
     text:"https://open-meteo.com/en/docs", addedMs:Date.now()-600_000, missing:false, size:0},
    {id:"f3", kind:"text", name:"Traceback (most recent call last):", path:null,
     text:"Traceback (most recent call last):\n  boom", addedMs:Date.now()-900_000, missing:false, size:0},
    // The case that only exists because files are referenced, not copied.
    {id:"f4", kind:"file", name:"moved.psd", path:"C:\\gone\\moved.psd", text:null,
     addedMs:Date.now()-9_000_000, missing:true, size:0},
  ]) as T;
  if (command.startsWith("shelf_")) return undefined as T;
  if (command === "get_runs") return (quiet ? [] : [
    {day:"", project:"akcesfonia", seconds:252, endedMs:Date.now()-3_600_000, waiting:true,
     input:1_284_000, output:38_200},
    {day:"", project:"akcesfonia", seconds:96, endedMs:Date.now()-7_200_000, waiting:true,
     input:412_000, output:9_100},
    {day:"", project:"codenotch-win", seconds:1_840, endedMs:Date.now()-1_800_000, waiting:true,
     input:2_960_000, output:74_500},
    /* ⚠️ One run with no tokens at all, on purpose: runs recorded before the
       count existed carry neither field, and the list must not grow a row named
       after a project that reads `0`. */
    {day:"", project:"esono", seconds:40, endedMs:Date.now()-9_000_000, waiting:false},
  ]) as T;
  if (command === "get_audio_devices") return structuredClone(demoDevices) as T;
  if (command === "set_audio_device") {
    demoDevices = demoDevices.map(d => ({...d, isDefault: d.id === args.id}));
    return undefined as T;
  }
  if (command === "set_shortcuts") return undefined as T;
  if (command === "connect_google" || command === "disconnect_google") {
    throw new Error("Connect Google Calendar in the desktop app. This is sample data.");
  }
  if (command === "media_seek") {
    demoMedia = {...demoMedia, position: Number(args.seconds) || 0};
    return undefined as T;
  }
  if (command === "media_command") {
    if (args.action === "playpause") demoMedia = {...demoMedia, playing: !demoMedia.playing};
    return undefined as T;
  }
  if (command === "open_task_editor") { window.open("/task-editor.html", "task-editor"); return undefined as T; }
  if (command === "connect_ticktick") throw new Error("Connect TickTick in the desktop app. This is sample data.");
  if (command === "disconnect_ticktick") { demo = emptySnapshot(); emit(); return undefined as T; }
  const task = demo.tasks.find(t => t.id === args.taskId && t.projectId === args.projectId);
  if (command === "complete_task" && task) { task.status = 2; task.completedTime = new Date().toISOString(); }
  if (command === "set_checklist_item" && task) {
    const item = task.items?.find(i => i.id === args.itemId);
    if (item) item.status = args.done ? 1 : 0;
  }
  if (command === "rename_task" && task) task.title = String(args.name);
  if (command === "create_task") demo.tasks.push({id:crypto.randomUUID(),projectId:String(args.projectId),title:String(args.name),status:0,startDate:args.date as string|undefined});
  if (["complete_task","set_checklist_item","rename_task","create_task","refresh_tasks"].includes(command)) emit();
  return undefined as T;
}

export async function watchTasks(fn: (value: TaskSnapshot) => void): Promise<() => void> {
  // Listen first, then get: both sides of the boot race are covered.
  let receivedEvent = false;
  const receive = (value: TaskSnapshot) => { receivedEvent = true; fn(value); };
  const off = native ? await listen<TaskSnapshot>("tasks:changed", event => receive(event.payload)) : (() => { listeners.add(receive); return () => { listeners.delete(receive); }; })();
  const initial = await call<TaskSnapshot>("get_tasks");
  if (!receivedEvent) fn(initial);
  return off;
}
