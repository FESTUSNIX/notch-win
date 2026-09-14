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

export async function call<T = void>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  if (native) return invoke<T>(command, args);
  if (command === "get_tasks") return structuredClone(demo) as T;
  if (command === "get_task_placement") return {edge:"top",visible:true} as T;
  if (command === "get_media") return structuredClone(demoMedia) as T;
  if (command === "get_calendar") return structuredClone(demoCalendar) as T;
  if (command === "get_shortcuts") return {toggle:"Ctrl+Alt+Space",hide:"Ctrl+Alt+H",capture:"Ctrl+Alt+N"} as T;
  if (command === "get_chrome_hidden") return false as T;
  if (command === "open_external") return undefined as T;
  if (command === "google_status") return true as T;
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
  if (command === "get_activity") return [{provider:"claude", state:"working", running:2}] as T;
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
