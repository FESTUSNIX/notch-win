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
/* `?noagents` empties the session list and nothing else.
 *
 * ⚠️ `?quiet` would do it too, and would also stop the music and clear the
 * calendar — which is exactly wrong for the tests that need this, because
 * they are about what the PLAYER does with the strip. A session that is
 * working claims the pill at 46, over media at 40, so the default fixture's
 * one working session was quietly outranking the thing under test. */
const noAgents = new URLSearchParams(location.search).has("noagents");
/* `nocal` pushes the demo agenda out of claiming range but leaves the player
 * alone — the two flags silence different competitors for the pill. */
const nocal = quiet || new URLSearchParams(location.search).has("nocal");
const demoMixer = [
  { pid: 4396, name: "Brave", path: "C:/brave.exe", icon: "", volume: 0.65, muted: false, active: true },
  { pid: 15816, name: "Spotify", path: "C:/spotify.exe", icon: "", volume: 1, muted: false, active: false },
];
const demoQueue = [
    {id:"q1", title:"Heroine (Cryogenic's Second Wind)", artist:"CRYOGENIC", artwork:""},
    {id:"q2", title:"Roulette", artist:"Bilal Wahib, Boef", artwork:""},
    {id:"q3", title:"Habiba", artist:"Boef", artwork:""},
    {id:"q4", title:"Murder To Excellence", artist:"JAY-Z, Kanye West", artwork:""},
    {id:"q5", title:"No, No, No", artist:"Eve, Stephen Marley", artwork:""},
    {id:"q6", title:"Winnetka Exit", artist:"Styles Of Beyond", artwork:""},
  ];
let demoMedia = {
  active: !quiet, playing: !quiet,
  title: "I turned my potion shop into a chaotic factory!",
  artist: "Real Civil Engineer", album: "", source: "Brave",
  position: 263, duration: 1878, artwork: "",
  canNext: false, canPrevious: false, canPlayPause: true, canSeek: true,
  shuffle: false, canShuffle: true,
};
/* `?call` puts the preview IN a call, and `?call=meet` in one whose app
   offers fewer controls — Meet has no way to hang up or share from the
   keyboard, so the row is genuinely shorter and that is worth being able to
   look at. ⚠️ The control list is the thing being staged, not the app name:
   it is what `call.rs` derives from its shortcut table, and the front end is
   only allowed to lay out what it was handed. */
const callFlag = new URLSearchParams(location.search).get("call");
const callAsked = new URLSearchParams(location.search).has("call");
let demoCall = callFlag === "meet"
  ? {active:true, app:"meet", appName:"Google Meet", title:"abc-defg-hij",
     icon:"", since:Date.now() - 128_000, muted:false,
     can:["mute", "video", "hand", "open"], pid:8123}
  : {active:callAsked, app:"zoom", appName:"Zoom", title:"Design Sync",
     icon:"", since:Date.now() - 743_000, muted:false,
     can:["mute", "video", "share", "hand", "leave", "open"], pid:4242};
/* `?notices` fills the centre, `?notices=denied` refuses it. ⚠️ Both are
   worth staging: "nothing has happened" and "Windows will not let this app
   look" draw the same empty screen and want different words, and only one of
   them is a bug. */
const noticeFlag = new URLSearchParams(location.search).get("notices");
let demoNotices = {
  access: noticeFlag === "denied" ? "denied" : "allowed",
  // Present and not a refusal. (`?notices` alone parses as an empty string.)
  items: noticeFlag !== null && noticeFlag !== "denied" ? [
    {id:1, app:"Slack", title:"Marek Nowak", body:"Can you look at the PR before standup?",
     at:Date.now() - 90_000, icon:"", aumid:"com.slack"},
    {id:2, app:"Outlook", title:"Design Sync in 15 minutes", body:"Teams meeting", at:Date.now() - 12 * 60_000, icon:"", aumid:"com.outlook"},
    {id:3, app:"Codenotch", title:"akcesfonia stopped", body:"Claude Code ran for 21m 10s.",
     at:Date.now() - 55 * 60_000, icon:"", aumid:"com.vinz.codenotch"},
    {id:4, app:"Brave", title:"Norton Password Manager", body:"Vault is synced and ready!",
     at:Date.now() - 5 * 3_600_000, icon:"", aumid:"Brave"},
  ] : [],
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
/* `?event=soon` puts one eight minutes out, `?event=now` one that started ten
   minutes ago. ⚠️ Both are worth staging: the claim is supposed to hold the
   strip for the first and to have LET GO of the second, and for a while it did
   neither — it counted down past zero and sat there through the meeting. */
const eventFlag = new URLSearchParams(location.search).get("event");
const eventStart = eventFlag === "soon" ? 8 / 60 : eventFlag === "now" ? -10 / 60 : (nocal ? 3 : 0.3);
/* ⚠️ The unflagged case keeps the ORIGINAL end, not `start + 1`. Making it
   exactly an hour long turned the panel's duration from "42min" into "1h",
   which is a fixture change dressed up as a rendering bug three files away. */
const eventEnd = eventFlag === "now" ? 20 / 60
  : eventFlag === "soon" ? eventStart + 0.7
  : (nocal ? 4 : 1);

const demoCalendar = {
  connected: true,
  updatedAt: new Date().toISOString(),
  error: null,
  events: [
    { id: "a", title: "Design review", start: hoursFromNow(eventStart), end: hoursFromNow(eventEnd),
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
const hoursAgo = (h: number) => Date.now() - h * 3_600_000;
let demoNotes: {id: string; body: string; written: number; edited: number;
  pinned?: boolean; edge?: string; y?: number; tint?: string}[] = [
  {id:"n1", body:"ssh key for the pi\nroot@10.0.0.4, port 2222", written:hoursAgo(1), edited:hoursAgo(1)},
  {id:"n2", body:"Spotkanie w Krakowie — wtorek 14:00", written:hoursAgo(5), edited:hoursAgo(5),
   tint:"violet"},
  {id:"n3", body:"Book: The Design of Everyday Things", written:hoursAgo(30), edited:hoursAgo(30)},
  {id:"n4", body:"Bin day is Thursday", written:hoursAgo(50), edited:hoursAgo(50)},
  {id:"n5", body:"Raspberry pi power supply is 5V 3A", written:hoursAgo(200), edited:hoursAgo(200)},
];
let demoPrefs: Record<string, unknown> = {
  accent: "#00ff88", weekStartsMonday: true, fahrenheit: false,
  /* ⚠️ Staged from the query string, like `?edge=`. Click mode changes what
     the pill IS — a surface that can hold controls, because the pointer resting
     on it no longer means "open" — and there is no other way to reach it in a
     preview: `notch:prefs` is a native event and the settings window is a
     different page. */
  openOnHover: !new URLSearchParams(location.search).has("click"),
  foldDelayMs: 450, motion: "system", panelWidth: 0,
  /* ⚠️ Both, and the rail is unusable without them. `railAlways` gates a
     `!important` rule that hides every stop, so a fixture missing it shows a
     bare black pill that only fills when hovered — which is a valid setting
     and therefore looks deliberate rather than absent. */
  railVisible: 5, railAlways: true, railGrip: 100, railSharp: 0,
  /* `?flat` lays every screen out at once instead of centring one — the
     setting is a checkbox in the real window and a flag here, because it
     changes the rail's whole layout and looking at it is the only way to
     judge it. */
  railFlat: new URLSearchParams(location.search).has("flat"),
  /* `?order=` and `?hide=` drive the rail's own list from the URL, the way the
     settings window drives it from a file. ⚠️ Comma-separated screen NAMES,
     not labels — the rail matches on `data-tab`. */
  railOrder: (new URLSearchParams(location.search).get("order") ?? "").split(",").filter(Boolean),
  railHidden: (new URLSearchParams(location.search).get("hide") ?? "").split(",").filter(Boolean),
  /* `?tint=name:#hex,name:#hex` — the same map the settings window writes. */
  railColours: Object.fromEntries((new URLSearchParams(location.search).get("tint") ?? "")
    .split(",").filter(Boolean).map(one => one.split(":")) as [string, string][]), useEverything: true,
  callMode: true, callMuteMic: true, callOpen: true,
  noticeMode: true, pomodoroWork: 25, pomodoroBreak: 5, pomodoroLong: 15,
  timerSound: "Notification.Reminder", timerMode: "pomodoro",
  /* ⚠️ Staged from the query string, like `?click` and `?edge=`. It decides
     what the collapsed strip DOES with a running pomodoro — a quiet line or
     the countdown itself — and there is no other way to reach the other one
     from a test: it is a segmented control in a window this page cannot open. */
  pomodoroPill: new URLSearchParams(location.search).has("pomtime") ? "time" : "bar",
  ringStops: [], ringGlass: true, ringHoldMs: 250, ringTap: "@search",
  homeCurrency: "PLN",
  followLive: !new URLSearchParams(location.search).has("nofollow"),
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
  /* The mixer, staged. ⚠️ Two apps where one is making a sound and one is
     merely holding a session, because telling those apart is the whole reason
     the list has a dot. */
  if (command === "get_mixer") return structuredClone(demoMixer) as T;
  if (command === "set_app_volume") {
    const row = demoMixer.find(one => one.pid === args.pid);
    if (row) row.volume = Number(args.volume) || 0;
    return undefined as T;
  }
  if (command === "set_app_mute") {
    const row = demoMixer.find(one => one.pid === args.pid);
    if (row) row.muted = !!args.muted;
    return undefined as T;
  }
  /* ⚠️ Staged, not fetched. The preview has no network and LRCLIB should not
     be asked what a fixture is listening to — and "what does a lyric look like
     against a wide, short panel" is the question the preview exists for. The
     stamps are around the demo track's own position, 263 seconds. */
  if (command === "get_lyrics") {
    return { known: true, plain: "", synced: [
      "[ti:A demo]", "[offset:0]",
      "[04:14.00]and the lights came up over the water",
      "[04:20.00]nobody said a word",
      "[04:25.50]we just stood there",
      "[04:31.00]the way you do when it is over",
      "[04:38.00]",
      "[04:44.00]and the lights came up over the water",
    ].join(String.fromCharCode(10)) } as T;
  }
  if (command === "get_call") return structuredClone(demoCall) as T;
  if (command === "get_notices") return structuredClone(demoNotices) as T;
  if (command === "notice_dismiss") {
    const id = args.id as number | undefined;
    demoNotices = {...demoNotices,
      items: id === undefined ? [] : demoNotices.items.filter(one => one.id !== id)};
    return structuredClone(demoNotices) as T;
  }
  if (command === "notify_now" || command === "notice_open") return true as T;
  if (command === "play_sound") return undefined as T;
  if (command === "call_action") {
    const action = String(args.action ?? "");
    /* Only the mute changes anything the preview can show, which is the honest
       stub: every other control happens inside another application, and this
       one has none. */
    if (action === "mute" || action === "unmute") demoCall.muted = action === "mute";
    if (action === "leave") demoCall = {...demoCall, active:false};
    return structuredClone(demoCall) as T;
  }
  if (command === "get_calendar") return structuredClone(demoCalendar) as T;
  /* ⚠️ Both of them, and the ones Rust actually defaults to. This stub was
     three keys and a stale `Ctrl+Alt+N` — which is `AltGr+N`, the combination
     that ate `ń` and is the reason the defaults moved. The settings window's
     AltGr guard is what found it: it warned about a shortcut no build had
     shipped for months. */
  if (command === "get_shortcuts") return {hide:"Ctrl+Alt+H", ring:"Alt+W"} as T;
  if (command === "ring_pick" || command === "ring_close") return undefined as T;
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
  /* ⚠️ A REAL table, trimmed — what the service answered on 17 Sep 2026.
     Made-up rates would make the converter's row look right while proving
     nothing about the crossing, which is the only arithmetic in it. */
  if (command === "get_rates") return {
    date: "2026-09-17", base: "EUR", fetchedMs: Date.now(),
    rates: {AUD: 1.6139, BRL: 5.8905, CAD: 1.6068, CHF: 0.9466, CNY: 7.7009,
      CZK: 24.308, DKK: 7.4753, GBP: 0.8583, HKD: 9.0071, HUF: 362.98,
      JPY: 178.75, KRW: 1587.31, MXN: 19.7337, NOK: 11.6, NZD: 1.79,
      PLN: 4.358, SEK: 11.02, SGD: 1.47, TRY: 47.9, USD: 1.1481, ZAR: 19.8},
  } as T;
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
  /* ⚠️ The order depends on the SHUFFLE, which is the whole point of the
     fixture: shuffling is the one thing that changes what comes next without
     changing what is playing, and a queue that answers the same list either
     way cannot tell a refetch from a stale panel. */
  if (command === "spotify_queue") return {connected:true, note:"", tracks:(demoMedia.shuffle
    ? [...demoQueue].reverse() : demoQueue)} as T;

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
    state: quiet || noAgents ? "idle" : agentsFixture ? "waiting" : "working",
    running: quiet || noAgents ? 0 : 1}] as T;
  /* Three sessions in the three states, so the preview shows the ordering:
     whoever wants you first.
     ⚠️ None of them under `?quiet`. A waiting session CLAIMS the pill at
     priority 55, and `quiet` means the preview is in its resting state — with
     sessions here every test that checks the clock would instead find an
     agent, which is exactly what happened when this stub was first written. */
  if (command === "get_sessions") return (quiet || noAgents ? [] : !agentsFixture ? [
    {id:"s2", project:"codenotch-win", branch:"master", pid:4243, state:"working",
     forSecs:31, input:512_000, output:9_100, lastRunSecs:96, doing:"running cargo test --lib",
     provider:"claude", model:"claude-opus-5", steps:[{id:"a",say:"reading nz_2.png",done:true},{id:"b",say:"reading nz_3.png",done:true},{id:"c",say:"running vid",done:true},{id:"d",say:"running grep -n",done:false}],
     thinking:"Fire ignites at frame ~112", say:"Processing both sequences and fixing the glows to blue.",
     folder:"C:/Users/matko/CODE/_personal/codenotch-win"},
  ] : [
    {id:"s1", project:"akcesfonia", branch:"master", pid:4242, state:"waiting",
     provider:"claude", model:"claude-opus-5", forSecs:214, input:1_284_000, output:38_200,
     lastRunSecs:252, say:"Which of the two folders should it write into?"},
    {id:"s2", project:"codenotch-win", branch:"master", pid:4243, state:"working",
     forSecs:31, input:512_000, output:9_100, lastRunSecs:96, doing:"running cargo test --lib",
     provider:"claude", model:"claude-opus-5", steps:[{id:"a",say:"reading nz_2.png",done:true},{id:"b",say:"reading nz_3.png",done:true},{id:"c",say:"running vid",done:true},{id:"d",say:"running grep -n",done:false}],
     thinking:"Fire ignites at frame ~112", say:"Processing both sequences and fixing the glows to blue.",
     folder:"C:/Users/matko/CODE/_personal/codenotch-win"},
    /* ⚠️ A CODEX row, and not as a fourth copy of the same shape. The two
       agents report different things — Codex knows what is left of the plan
       and Claude does not — so a fixture of three Claude sessions would have
       proved nothing about the half of the screen that only ever has one of
       them. This one is working, so both live states are on screen at once. */
    {id:"s4", project:"esono-price-watch", branch:"main", pid:0, state:"working",
     provider:"codex", model:"gpt-6-astra", forSecs:74, input:214_000, output:6_400,
     lastRunSecs:181, doing:"running npm run build",
     steps:[{id:"e",say:"reading feed.ts",done:true},{id:"f",say:"editing parse.ts",done:true},
            {id:"g",say:"running npm run build",done:false}],
     say:"The feed parser was dropping every entry without a guid.",
     limits:{window:12, week:41, plan:"plus"},
     folder:"C:/Users/matko/CODE/_tests/esono-price-watch"},
    /* ⚠️ A session with NO model, on purpose: one picked up mid-run never
       saw a record that named one, and the card has to say something sensible
       rather than an empty gap where every other card has a word. */
    {id:"s3", project:"esono", branch:"feat/pdp", pid:4244, state:"idle",
     provider:"claude", forSecs:9_400, input:22_000, output:800, lastRunSecs:0},
  ]) as T;
  if (command === "focus_session") return true as T;
  /* ⚠️ Held for the page's lifetime, like the stars. Enough of them to put
     the search above its own threshold, because a fixture of three notes
     proves nothing about a control that appears at five. */
  if (command === "get_notes") return structuredClone(demoNotes) as T;
  if (command === "save_note") {
    const body = String(args.body ?? "").trim();
    const id = String(args.id ?? "");
    const at = Date.now();
    if (id) {
      if (!body) demoNotes = demoNotes.filter(n => n.id !== id);
      else demoNotes = demoNotes.map(n => n.id === id ? {...n, body, edited: at} : n);
    } else if (body) {
      demoNotes = [{id: `n${at}`, body, written: at, edited: at}, ...demoNotes];
    }
    return structuredClone(demoNotes) as T;
  }
  if (command === "pin_note") {
    demoNotes = demoNotes.map(n => n.id === String(args.id)
      ? {...n, pinned: !!args.pinned,
         ...(args.edge ? {edge: String(args.edge)} : {}),
         ...(args.y === undefined ? {} : {y: Number(args.y)})}
      : n);
    return structuredClone(demoNotes) as T;
  }
  if (command === "tint_note") {
    demoNotes = demoNotes.map(n => n.id === String(args.id)
      ? {...n, tint: String(args.tint ?? "")} : n);
    return structuredClone(demoNotes) as T;
  }
  /* The drawer's own window calls; there is no window in a preview, so the
     page lays itself out at whatever size the browser gave it. */
  if (command === "dock_note" || command === "move_pin"
    || command === "drag_pin" || command === "note_drag_end") return undefined as T;
  /* The preview has no second window to drag into, so the gesture is staged:
     the note pins itself the way a real drop at the right-hand edge would. */
  if (command === "note_drag_start") {
    demoNotes = demoNotes.map(n => n.id === String(args.id)
      ? {...n, pinned: true, edge: "right"} : n);
    return undefined as T;
  }
  if (command === "remove_note") {
    demoNotes = demoNotes.filter(n => n.id !== String(args.id));
    return structuredClone(demoNotes) as T;
  }
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
  /* ⚠️ One file has a preview and the rest do not, which is the real
     shape of a shelf — a `.zip` is a glyph however long you wait. */
  if (command === "shelf_thumb") {
    return (args.id === "f1" ? "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAGCAIAAABxZ0isAAAAEUlEQVR4nGMIa1qBFTEMpAQACnFIAfXVen4AAAAASUVORK5CYII=" : null) as T;
  }
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
  /* A week of buckets, the shape `usage.rs` keeps them in: one per day per
     model per project. ⚠️ Written against a moving `today` rather than fixed
     dates — a fixture with September in it draws a chart of seven empty
     columns the moment the month turns, and the panel then looks broken
     rather than unfed. */
  if (command === "get_usage") return (quiet ? [] : (() => {
    const day = (back: number) => {
      const at = new Date();
      at.setDate(at.getDate() - back);
      const month = String(at.getMonth() + 1).padStart(2, "0");
      return `${at.getFullYear()}-${month}-${String(at.getDate()).padStart(2, "0")}`;
    };
    return [
      {day: day(6), provider: "claude", model: "claude-opus-5", project: "akcesfonia",
       input: 1_900_000, output: 44_000, runs: 9, seconds: 2_400},
      {day: day(5), provider: "claude", model: "claude-opus-5", project: "esono",
       input: 640_000, output: 12_000, runs: 4, seconds: 900},
      {day: day(3), provider: "codex", model: "gpt-6-astra", project: "esono-price-watch",
       input: 2_100_000, output: 51_000, runs: 7, seconds: 3_100},
      {day: day(2), provider: "claude", model: "claude-opus-5", project: "codenotch-win",
       input: 3_400_000, output: 88_000, runs: 14, seconds: 6_200},
      {day: day(0), provider: "claude", model: "claude-opus-5", project: "codenotch-win",
       input: 2_960_000, output: 74_500, runs: 11, seconds: 4_800},
      {day: day(0), provider: "claude", model: "claude-haiku-4-5", project: "codenotch-win",
       input: 180_000, output: 3_200, runs: 3, seconds: 240},
      {day: day(0), provider: "claude", model: "claude-opus-5", project: "akcesfonia",
       input: 1_284_000, output: 38_200, runs: 6, seconds: 1_900},
      {day: day(0), provider: "codex", model: "gpt-6-astra", project: "esono-price-watch",
       input: 820_000, output: 19_400, runs: 4, seconds: 1_100},
    ];
  })()) as T;
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
    if (args.action === "shuffle") demoMedia = {...demoMedia, shuffle: !demoMedia.shuffle};
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
