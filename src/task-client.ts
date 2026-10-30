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
/* `sky=night` / `sky=day` make Daylight draw the moon or the sun — see the
   weather reading below for why they move the sun TIMES instead of the clock.
   ⚠️ BOTH, not just night. With only the night flag the day case was whatever
   the real clock said, so the test for it passed all afternoon and failed every
   evening — and "it passes when run alone" was true right up until sunset. */
const sky = new URLSearchParams(location.search).get("sky");
const night = sky === "night";
const daytime = sky === "day";
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
  timerSound: "Notification.Reminder",
  /* ⚠️ Staged from the query string, like `?click` and `?edge=`. It decides
     what the collapsed strip DOES with a running pomodoro — a quiet line or
     the countdown itself — and there is no other way to reach the other one
     from a test: it is a segmented control in a window this page cannot open. */
  pomodoroPill: new URLSearchParams(location.search).has("pomtime") ? "time" : "bar",
  ringStops: [], ringGlass: true, ringHoldMs: 250, ringTap: "@search",
  homeCurrency: "PLN",
  followLive: !new URLSearchParams(location.search).has("nofollow"),
  indexApps: true, notifyRuns: true, mutedModules: [], thresholds: {}, taskView: "day",
  /* `?spoken=off` is Settings → Spoken replies switched off. */
  spokenReplies: new URLSearchParams(location.search).get("spoken") !== "off",
  /* `&wake` is Settings → Voice → Wake word switched on (and fires the word, below). */
  wakeWord: new URLSearchParams(location.search).has("wake"),
  wakeMic: "", wakeMicName: "", wakeSensitivity: "normal",
};
const demoSpaces: Record<string, Record<string, unknown>> = {};

/* ── Helm, staged ───────────────────────────────────────────────────────
   `?helm` connects it (the queue, a thread; `&running` or `&paused` adds a
   session on its first item); `?nudge` adds an unread nudge. A preview has no Tauri events, so what Rust
   would emit (`helm:chat`, `helm:nudge`) goes out on `previewBus` instead. */
const params = new URLSearchParams(location.search);
export const previewBus = new EventTarget();
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const atToday = (hhmm: string) => { const [h, m] = hhmm.split(":").map(Number); const d = new Date(); d.setHours(h, m, 0, 0); return d.toISOString(); };
const dayFrom = (days: number) => { const d = new Date(); d.setDate(d.getDate() + days); return localDay(d); };
function demoHelmQueue() {
  const item = (key: string, title: string, context: string | null, minutes: number, more: Record<string, unknown> = {}) => ({
    key, kind: key.split(":")[0], title, context, projectId: 3, workItemId: null, taskId: null, dealId: null, blockId: null,
    dueOn: null, minutes, done: { kind: "own" }, doneLabel: null, href: "/", ...more,
  });
  type Item = ReturnType<typeof item>;
  const entry = (key: string, type: string, title: string, items: Item[], more: Record<string, unknown> = {}) => ({
    key, type, title, context: type === "small" ? null : items[0].context, projectId: items[0].projectId,
    dueOn: items.map(i => i.dueOn).filter(Boolean).sort()[0] ?? null, minutes: items.reduce((t, i) => t + i.minutes, 0),
    why: null, items, by: null, carried: false, ...more,
  });
  const rynek = item("request:1", "Rynek Czeski — poprawki w koszyku", "Esono Rozwój", 120, { workItemId: 1, dueOn: dayFrom(2) });
  const small = [
    item("attention:payment-9", "Ubrania is 3 days late", "1 200 zł, due 24 Oct", 15, { kind: "money", done: { kind: "mark-paid" }, doneLabel: "Mark as paid" }),
    item("log:3@x", "Log 2 h 15 min on Esono Rozwój", "about 2 h 20 min coded", 5, { kind: "log", done: { kind: "log", minutes: 135 }, doneLabel: "Log 2 h 15 min" }),
    item("followup:4@x", "Follow up on the offer", "Południowa Służba Ratownicza", 30, { dueOn: dayFrom(0), done: { kind: "mark" } }),
  ];
  const blog = item("todo:1", "Napisać post na blog HADA", null, 45, { kind: "todo", projectId: null });
  const logo = item("request:5", "Zmiana logo na nowe", "sonocars", 60, { workItemId: 5, projectId: 5, dueOn: dayFrom(-2) });
  const tasks = [item("task:7", "Home page design ready", "Online store", 60, { kind: "task", taskId: 7, projectId: 9, hue: "magenta", dueOn: dayFrom(4) }), item("task:8", "Cart and checkout design ready", "Online store", 60, { kind: "task", taskId: 8, projectId: 9, hue: "magenta", dueOn: dayFrom(4) })];
  const galeria = item("request:2", "Galeria: nowe zdjęcia aut", "sonocars", 60, { workItemId: 2, projectId: 5 });
  return {
    items: [rynek, ...small, blog, logo, ...tasks, galeria],
    today: [
      entry("request:1", "item", rynek.title, [rynek], { by: "guardian", why: "Termin w czwartek, zostały około 2 godziny." }),
      entry("small", "small", "3 small things", small, { by: "guardian" }),
      entry("todo:1", "item", blog.title, [blog], { by: "me" }),
      entry("request:5", "item", logo.title, [logo], { carried: true }),
    ],
    suggested: [
      entry("group:9:task@x", "group", "Online store: 2 tasks", tasks),
      entry("request:2", "item", galeria.title, [galeria], { why: "sonocars dostał w tym tygodniu najmniej czasu." }),
    ],
    /* ⚠️ On the online store's project, so its group in the suggestions wears
       the "Waiting" chip — a fixture where no row is waiting tests none of it. */
    waiting: [item("attention:waiting-12", "Waiting on the client", "Online store", 15, { projectId: 9 })],
    /* `&free=n` sets the free time left (`&free=off`: a Helm that can't say).
       ⚠️ `&small` runs a session on the small things under an OLDER title
       ("2 small things") with no `sessions` key — what Helm sends once an item
       was added after the start — so Now must still find its entry. */
    snoozed: 2, doneToday: 3, workedMinutes: 190,
    freeMinutes: params.get("free") === "off" ? null : Number(params.get("free") ?? 300),
    sessions: params.has("running") || params.has("paused") ? { "2": "request:1" } : {},
  };
}
function demoHelm() {
  if (!params.has("helm")) return { connected: false, signedIn: false, today: null, error: null, queue: null, queueError: null, notch: null, skewMs: 0 };
  const live = params.has("running") || params.has("paused");
  return {
    connected: true, signedIn: true, error: null, queueError: null, skewMs: 0,
    queue: demoHelmQueue(),
    notch: demoNotch(),
    today: {
      now: new Date().toISOString(), today: localDay(),
      day: { firstStep: "Rynek Czeski — poprawki w koszyku (Esono Rozwój)", closedAt: null, off: false },
      rhythm: { on: true, wake: 465, start: 540, close: 1065 },
      blocks: [
        { id: 1, title: "Zestawienie prac NXM Artech", status: "done", plannedAt: null, minutes: 15, runStartedAt: null, elapsedSeconds: 900, project: "NXM" },
        ...(live ? [{ id: 2, title: "Rynek Czeski — poprawki w koszyku", status: params.has("paused") ? "paused" : "running", plannedAt: null, minutes: params.has("over") ? 20 : 120, runStartedAt: params.has("paused") ? null : minutesAgo(29), elapsedSeconds: params.has("paused") ? 1740 : 0, project: "Esono Rozwój" }] : []),
        ...(params.has("small") ? [{ id: 3, title: "2 small things", status: "running", plannedAt: null, minutes: 30, runStartedAt: minutesAgo(12), elapsedSeconds: 0, project: null }] : []),
      ],
      nudges: params.has("nudge") ? [{ id: 91, kind: "idle", title: "Przerwa trwa 40 minut", body: "Następne w kolejce: Rynek Czeski — poprawki w koszyku (Esono Rozwój). Wracamy?", url: "/", at: minutesAgo(2) }] : [],
      replies: ["Zaczynam", "Za duże, daj 10 minut", "Dziś wolne"],
    },
  };
}
/* ── Peeks, staged (batch 13, builder P) ───────────────────────────────
   `?peek=` takes a comma list; each crosses into its window a few seconds
   after load, so it arrives through the real readers (peek-feed.ts), never
   at launch (a first reading is not news):
   - `music`: the track changes at `peekat` ms (default 2500); `play`: it pauses.
   - `block5` / `over`: with `?helm&running`, the block is 5 min + 4 s from
     its end / 4 s from it; `done`: it is marked done at `peekat`.
   - `meeting`: one 10 min + 4 s out with a Meet link (Join); `leave`: one
     20 min + 4 s out at a street address; `&rain` makes the next hours wet.
   Stage a block owner with music second with `?helm&running` alone. */
const peekFlags = new Set((params.get("peek") ?? "").split(",").filter(Boolean));
const peekAt = Number(params.get("peekat")) || 2500;
let peekDone = false;
function peekStageHelm<T>(helm: T): T {
  const blocks = (helm as { today?: { blocks?: Record<string, unknown>[] } | null }).today?.blocks;
  const live = blocks?.find(b => b.id === 2);
  if (!live) return helm;
  const endIn = peekFlags.has("block5") ? 304 : peekFlags.has("over") ? 4 : null;
  if (endIn !== null) Object.assign(live, { minutes: 30, runStartedAt: new Date(Date.now() - (1800 - endIn) * 1000).toISOString() });
  if (peekDone) Object.assign(live, { status: "done", runStartedAt: null, elapsedSeconds: 1740 });
  return helm;
}
if (peekFlags.has("meeting")) demoCalendar.events.push({ id: "pm", title: "Standup NXM", start: hoursFromNow((600 + 4) / 3600),
  end: hoursFromNow(1), allDay: false, location: "", meetingUrl: "https://meet.google.com/peek", calendar: "Work", color: "#5ac8fa", response: "accepted" });
if (peekFlags.has("leave")) demoCalendar.events.push({ id: "pl", title: "Dentysta", start: hoursFromNow((1200 + 4) / 3600),
  end: hoursFromNow(1.5), allDay: false, location: "ul. Długa 12, Kraków", meetingUrl: "", calendar: "Personal", color: "#ff9f0a", response: "accepted" });
if (preview && peekFlags.size) window.setTimeout(() => {
  if (peekFlags.has("music")) {
    demoMedia = { ...demoMedia, title: "Midnight City", artist: "M83", position: 0, duration: 244 };
    previewBus.dispatchEvent(new CustomEvent("media:changed", { detail: structuredClone(demoMedia) }));
  }
  if (peekFlags.has("play")) {
    demoMedia = { ...demoMedia, playing: false };
    previewBus.dispatchEvent(new CustomEvent("media:changed", { detail: structuredClone(demoMedia) }));
  }
  if (peekFlags.has("done")) {
    peekDone = true;
    previewBus.dispatchEvent(new CustomEvent("helm:changed", { detail: structuredClone(peekStageHelm(demoHelm())) }));
  }
}, peekAt);
/* ── end of the peeks block ── */
function demoThread() {
  const day = localDay();
  const msg = (id: number, role: string, kind: string, title: string | null, body: string, time: string, extra: Record<string, unknown> = {}) =>
    ({ id, day, kind, role, title, body, url: null, createdAt: atToday(time), read: true, receipts: [], cards: [], images: [], ...extra });
  return {
    strictness: "normal", usual: "normal",
    messages: [
      msg(1, "guardian", "start", "9:42 i jeszcze nic nie ruszyło", "Na teraz: Repricer: reguły cen (Esono Repricer). Zacznij od 10 minut, reszta pójdzie łatwiej.", "09:42", { url: "/" }),
      msg(2, "me", "chat", null, "Za duże, daj 10 minut", "09:44"),
      /* ⚠️ THREE changes, so the reply's receipts fold ("3 zmiany"): a
         fixture with one change never shows the fold at all. */
      msg(3, "guardian", "chat", null, "Jasne. Zacznij od jednej reguły: progu dla kategorii **Opony**. Dodałem blok na 10 minut na teraz.", "09:44", {
        receipts: [
          { label: "Start: Repricer: reguły cen (10 min)", icon: "start", undo: { op: "delete", table: "focus_blocks", id: 9 } },
          { label: "Plan: Repricer po 10 min, potem Rynek Czeski", icon: "plan", undo: { op: "update", table: "days", id: 2, values: {} } },
          { label: "Notatka: próg dla Opon", icon: "note", undo: null },
        ],
      }),
      msg(4, "me", "chat", null, "Co mam dziś?", "13:40"),
      msg(5, "guardian", "chat", null, "Najpierw Rynek Czeski: termin w czwartek. Po callu z Piotrem follow-up.", "13:40", {
        cards: [{ type: "day", day, mustWin: null, queue: [
          { title: "Rynek Czeski — poprawki w koszyku", context: "Esono Rozwój", due: null, minutes: 120 },
          { title: "Follow up on the offer", context: "Południowa Służba Ratownicza", due: null, minutes: 30 },
          { title: "Galeria: nowe zdjęcia aut", context: "sonocars", due: null, minutes: 60 },
        ], blocks: [
          { id: 1, title: "Zestawienie prac NXM Artech", time: "08:50", minutes: 15, status: "done" },
        ], meetings: [{ title: "Call z Piotrem", from: "15:00", to: "15:30" }] }],
      }),
      msg(6, "me", "chat", null, "Co jest otwarte w Esono?", "13:52"),
      msg(8, "guardian", "chat", null, "Trzy otwarte zgłoszenia, jedno już w toku u Claude'a.", "13:52", {
        cards: [{ type: "requests", project: "Esono Rozwój", projectId: 3, items: [
          { id: 1, title: "Rynek Czeski — poprawki w koszyku", status: "doing", priority: "urgent", estimate: 120, logged: 95, due: dayFrom(2), waiting: null },
          { id: 11, title: "Filtry kategorii w sklepie", status: "todo", priority: "high", estimate: 90, logged: 0, due: null, waiting: null },
          { id: 12, title: "Mapa strony dla Google", status: "todo", priority: "normal", estimate: 30, logged: 0, due: null, waiting: "klienta" },
        ] }],
      }),
      msg(9, "me", "chat", null, "Skończyłem Rynek Czeski", "14:10"),
      msg(7, "guardian", "chat", null, "Świetnie. Zaloguję czas na Rynek Czeski? Do tego dwie sprawy z pieniędzmi na ten tydzień.", "14:10", {
        cards: [
          { type: "time", requestId: 1, title: "Rynek Czeski — poprawki w koszyku", project: "Esono Rozwój", projectId: 3, minutes: 90, you: 20, agent: 70, estimate: 120, capped: true },
          { type: "reminder", paymentId: 9, title: "Faktura dla Ubrania", client: "Ubrania", amount: 1200, daysLate: 2, level: "friendly" },
          { type: "renewal", id: 3, period: "co rok", title: "Domena sonocars.pl", client: "sonocars", amount: 120, on: dayFrom(3), paidBy: "client" },
        ],
      }),
      ...(params.has("nudge") ? [msg(91, "guardian", "idle", "Przerwa trwa 40 minut", "Następne w kolejce: Rynek Czeski — poprawki w koszyku (Esono Rozwój). Wracamy?", "16:42", { url: "/", read: false })] : []),
      /* What was said in the preview itself, kept as Helm keeps it: a reply
         that vanished on the reload after `done` would be a thread that
         forgets what it just answered. */
      ...structuredClone(sentHere),
    ],
  };
}
const sentHere: Record<string, unknown>[] = [];
/* Earlier days, for the history panel: `/api/guardian/thread?day=` answers
   these as a bare array (the contract's `ThreadMessage[]`). */
function demoDay(day: string) {
  const at = (time: string) => { const [h, m] = time.split(":").map(Number); const d = new Date(`${day}T00:00:00`); d.setHours(h, m, 0, 0); return d.toISOString(); };
  const msg = (id: number, role: string, kind: string, title: string | null, body: string, time: string, extra: Record<string, unknown> = {}) =>
    ({ id, day, kind, role, title, body, url: null, createdAt: at(time), read: true, receipts: [], cards: [], images: [], ...extra });
  if (day === dayFrom(-1)) return [
    msg(201, "guardian", "start", "Dzień dobry", "Na dziś: faktura dla Ubrania i Galeria dla sonocars.", "09:05", { url: "/" }),
    msg(202, "me", "chat", null, "Co z fakturą dla Ubrania?", "11:20"),
    msg(203, "guardian", "chat", null, "Faktura dla Ubrania czeka od 2 dni. Wysłałem uprzejme przypomnienie.", "11:20", {
      receipts: [{ label: "Przypomnienie: Ubrania, 1 200 zł", icon: "reminder", undo: null }],
    }),
  ];
  if (day === dayFrom(-3)) return [
    msg(301, "me", "chat", null, "Zaplanuj mój czwartek", "08:40"),
    msg(302, "guardian", "chat", null, "Plan na czwartek: Repricer, potem Rynek Czeski, a po 15:00 call z Piotrem.", "08:41"),
  ];
  return [];
}
function demoHistory() {
  return { days: [
    { day: localDay(), count: 10, preview: "Świetnie. Zaloguję czas na Rynek Czeski?" },
    { day: dayFrom(-1), count: 3, preview: "Faktura dla Ubrania czeka od 2 dni." },
    { day: dayFrom(-3), count: 2, preview: "Plan na czwartek: Repricer, potem Rynek Czeski" },
  ] };
}
/* ⚠️ Accents folded both ways, as Helm's search does: "faktura" finds
   "fakturą". Written with the combining range spelled out, no escapes —
   a patch tool eats backslashes (AGENTS 60). */
const COMBINING = new RegExp("[" + String.fromCharCode(0x300) + "-" + String.fromCharCode(0x36f) + "]", "g");
function demoSearch(q: string) {
  const fold = (t: string) => t.normalize("NFD").replace(COMBINING, "").replace(/ł/g, "l").toLowerCase();
  const wanted = fold(q.trim());
  const all = [...demoThread().messages, ...demoDay(dayFrom(-1)), ...demoDay(dayFrom(-3))] as { id: number; day: string; role: string; body: string; createdAt: string }[];
  return { results: all.filter(m => wanted && fold(m.body).includes(wanted)).map(m => ({ id: m.id, day: m.day, role: m.role, snippet: m.body, createdAt: m.createdAt })) };
}
/* `/api/notch/projects`, staged: every project, the live ones marked. */
function demoProjects() {
  if (params.get("projects") === "off") return null;
  return { projects: [
    { id: 3, name: "Esono Rozwój", client: "Esono", logoVersion: "v1", hue: "orange", personal: false, live: true },
    { id: 4, name: "Esono Repricer", client: "Esono", logoVersion: "v2", hue: "blue", personal: false, live: false },
    { id: 5, name: "sonocars", client: "sonocars", logoVersion: null, hue: "red", personal: false, live: false },
    { id: 8, name: "Akcesfonia", client: "Akcesfonia", logoVersion: null, hue: "violet", personal: false, live: true },
    { id: 9, name: "Online store", client: "Ubrania", logoVersion: null, hue: "magenta", personal: false, live: false },
    { id: 30, name: "Codenotch", client: null, logoVersion: null, hue: "aqua", personal: true, live: true },
  ] };
}
/* The Guardian's chips, staged: `/api/guardian/suggestions` as Helm picks them
   for a moment of the day. `&suggest=morning` / `evening` are other moments,
   `&suggest=off` the 404 of a Helm without the endpoint (helm.rs: null — no
   row at all). ⚠️ The hints are READ like Helm reads them: a finished run's
   request leads with "Zrobione: …", the project in focus gets its chip — so a
   test can see this machine's facts reach Helm, not just a fixed list. */
function demoSuggestions(args: Record<string, unknown>) {
  const flag = params.get("suggest");
  if (flag === "off") return null;
  const chip = (id: string, label: string, prompt: string, icon: string, kind: string) => ({ id, label, prompt, icon, kind });
  if (flag === "morning") return { suggestions: [
    chip("today", "Co mam dziś?", "Co mam dziś? Pokaż kolejkę i spotkania.", "today", "day"),
    chip("pick-three", "Wybierz trzy na dziś", "Wybierz mi trzy rzeczy na dziś i wstaw je do Dziś.", "plan", "day"),
    chip("week", "Co w tym tygodniu?", "Co mam w tym tygodniu? Terminy, spotkania i co jest zagrożone.", "week", "day"),
  ] };
  if (flag === "evening") return { suggestions: [
    chip("log-code", "Zaloguj 2 h 15 na Esono", "Zaloguj dzisiejszy kod: 2 h 15 min na Esono Rozwój.", "time", "time"),
    chip("wrap", "Podsumuj dzień", "Podsumuj mój dzień: co zrobione, ile czasu i co przechodzi na jutro.", "close", "wrap"),
    chip("tomorrow", "Plan na jutro", "Co jutro na start? Wybierz pierwszą rzecz na rano.", "tomorrow", "day"),
    chip("week", "Co w tym tygodniu?", "Co mam w tym tygodniu? Terminy, spotkania i co jest zagrożone.", "week", "day"),
  ] };
  const finished = Array.isArray(args.finished) ? args.finished.map(Number) : [];
  const done = finished.map(id => demoNotch()?.folders.flatMap(f => f.requests.map(r => ({ r, project: f.project.name }))).find(one => one.r.id === id)).find(Boolean);
  const focus = demoProjects()?.projects.find(p => p.id === args.project);
  return { suggestions: [
    ...(done ? [chip(`agent-done:${done.r.id}`, `Zrobione: ${done.r.title}`, `Agent skończył „${done.r.title}” (${done.project}). Oznacz to zgłoszenie jako zrobione.`, "done", "agents")] : []),
    chip("prep:900", "Przygotuj: Call z Piotrem", "Przygotuj mnie na „Call z Piotrem” o 15:00: z kim, o czym i co jest otwarte.", "call", "meeting"),
    chip("log:1", "Zaloguj 1 h 30", "Zaloguj 1 h 30 min na zgłoszenie „Rynek Czeski — poprawki w koszyku” (Esono Rozwój), tyle pokazuje praca.", "time", "time"),
    ...(focus ? [chip(`project:${focus.id}`, `${focus.name}: co dalej?`, `Co jest otwarte w projekcie „${focus.name}” i od czego zacząć?`, "here", "here")] : []),
    chip("what-now", "Co teraz?", "Co teraz? Daj mi jedną rzecz do zrobienia od razu.", "next", "now"),
    chip("remind", "Przypomnij: Ubrania", "Ubrania: 1 200 zł, 4 dni po terminie. Pokaż przypomnienie do wysłania.", "money", "money"),
  ].slice(0, 4) };
}
/* The cockpit, staged: `/api/notch` as Helm will send it — his clock and the
   agents', what needs him, and the projects with folders on this PC.
   ⚠️ `&notch=off` is the OTHER state, and the one the deployed Helm is in
   until it ships the endpoint: a 404, which helm.rs turns into `null`. Every
   part built on it has to vanish then rather than break — that flag is how
   the preview (and helm.spec) proves it does. */
const hoursFromNowIso = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();
function demoNotch() {
  if (params.get("notch") === "off") return null;
  const project = (id: number, name: string, hue: string, logoVersion: string | null, personal = false) =>
    ({ id, name, logoVersion, hue, client: null, personal });
  const request = (id: number, title: string, status: "todo" | "doing", estimate: number | null, started: number | null = null) =>
    ({ id, title, status, estimate, startedAt: started === null ? null : minutesAgo(started) });
  return {
    day: localDay(),
    clock: { you: 190, agents: 85 },
    moments: demoMoments(),
    needs: params.has("noneeds") ? [] : [
      { key: "meeting:1", kind: "meeting", title: "Call z Piotrem", context: "Południowa Służba Ratownicza", amount: null,
        at: hoursFromNowIso(0.7), href: "/calendar", join: "https://meet.google.com/demo" },
      { key: "reminder:7", kind: "reminder", title: "Faktura dla Ubrania", context: "Ubrania", amount: 1200,
        at: dayFrom(-2), href: "/money", join: null },
      { key: "renewal:3", kind: "renewal", title: "Domena sonocars.pl", context: "sonocars", amount: 120,
        at: dayFrom(3), href: "/money", join: null },
      { key: "request:9", kind: "request", title: "Nowe zgłoszenie od Ubrania", context: "Ubrania", amount: null,
        at: null, href: "/projects/12", join: null },
    ],
    folders: [
      { folder: "esono", path: "C:/Users/matko/CODE/esono", project: project(3, "Esono Rozwój", "orange", "v1"), requests: [
        request(1, "Rynek Czeski — poprawki w koszyku", "doing", 120, 95),
        request(11, "Filtry kategorii w sklepie", "todo", 90),
        request(12, "Mapa strony dla Google", "todo", 30),
      ] },
      /* ⚠️ No path: Helm knows the project but not where it lives on this PC,
         so Start with Claude has to say so rather than open a terminal in the
         wrong place. */
      { folder: "akcesfonia", path: null, project: project(8, "Akcesfonia", "violet", null), requests: [
        request(21, "Nowy koszyk B2B", "doing", null, 200),
        request(22, "Eksport faktur do CSV", "todo", 60),
      ] },
      { folder: "codenotch-win", path: "C:/Users/matko/CODE/_personal/codenotch-win", project: project(30, "Codenotch", "aqua", null, true), requests: [
        request(31, "Helm w notchu", "doing", 240, 120),
        request(32, "Tryb ambient: nowe sceny", "todo", 120),
      ] },
      { folder: "esono-price-watch", path: "C:/Users/matko/CODE/_tests/esono-price-watch", project: project(4, "Esono Repricer", "blue", "v2"), requests: [
        request(41, "Reguły cen dla opon", "todo", 60),
      ] },
      { folder: "sonocars", path: "C:/Users/matko/CODE/sonocars", project: project(5, "sonocars", "red", null), requests: [
        request(5, "Zmiana logo na nowe", "todo", 60),
        request(2, "Galeria: nowe zdjęcia aut", "todo", 60),
      ] },
    ],
  };
}
/* Batch 12: the Guardian's own moments, staged with `&hmoment=prep,wrap,drift,
   idle,remind,request,close` (comma-separated, best first as Helm sends them).
   ⚠️ `prep` is about the staged meeting `&moment=meeting` adds (its id ends in
   that event's), so the two together stage the dedupe: Helm's prep wins. */
function demoMoments() {
  const kinds = (params.get("hmoment") ?? "").split(",").filter(Boolean);
  const all: Record<string, unknown> = {
    prep: { id: "prep:work:staged-meeting", kind: "prep", tone: "guardian", sticky: false, priority: 88,
      title: "Za 5 min: Esono", body: "Sprint zamknięty w 80%, koszyk czeski czeka na akcept.",
      detail: [{ label: "Status", text: "Repricer gotowy, koszyk CZ w testach" }, { label: "Zapytaj", text: "Czy wycena filtrów idzie w tym miesiącu?" }, { label: "Uważaj", text: "Faktura z września 2 dni po terminie" }],
      actions: [{ label: "Dołącz", do: "open_url", url: "https://meet.google.com/demo" }, { label: "Otwórz w Helm", do: "open_url", url: "https://crm.hadastudios.com/clients/3" }] },
    wrap: { id: "wrap:work:kowalski-1", kind: "wrap", tone: "guardian", sticky: true, priority: 72,
      title: "Jak poszło z Kowalski Studio?", body: "Powiedz w dwóch zdaniach, zapiszę resztę.",
      actions: [{ label: "Opowiedz", do: "talk", command: "wrap", meeting: "work:kowalski-1" }, { label: "Tylko czas", do: "post", path: "/api/notch/meetings/work%3Akowalski-1/log" }] },
    drift: { id: "drift:2:over", kind: "drift", tone: "warn", sticky: true, priority: 78,
      title: "Rynek Czeski: +14 min ponad plan", body: "Plan był na 50 min.",
      actions: [{ label: "+15 min", do: "queue", act: { act: "extend", block: 2, minutes: 15 } }, { label: "Zrobione", do: "queue", act: { act: "done", key: "block:2" } }, { label: "Nie dziś", do: "queue", act: { act: "snooze", key: "request:1" } }] },
    idle: { id: "drift:2:idle", kind: "drift", tone: "warn", sticky: true, priority: 78,
      title: "Utknąłeś przy Rynek Czeski?", body: "Od 20 minut cisza. Pierwszy krok na 10 minut?",
      actions: [{ label: "10 minut", do: "chat", text: "Rozbij to na pierwszy krok na 10 minut" }, { label: "Pauza", do: "queue", act: { act: "pause", block: 2 } }, { label: "Nie dziś", do: "queue", act: { act: "snooze", key: "request:1" } }] },
    remind: { id: "remind:7", kind: "remind", tone: "warn", sticky: true, priority: 60,
      title: "Ubrania: 1 200 zł, 2 dni po terminie", body: "Przypominam o fakturze FV/09/2026 z terminem 28 października.",
      actions: [{ label: "Wyślij", do: "post", path: "/api/notch/reminders/7" }, { label: "Otwórz", do: "open_url", url: "https://crm.hadastudios.com/money?remind=7" }] },
    request: { id: "request:9", kind: "request", tone: "guardian", sticky: true, priority: 62,
      title: "Ubrania: Nowy filtr rozmiarów", body: "~2 h, 600 zł\nWycena obejmuje: filtr rozmiarów w kategorii",
      actions: [{ label: "Wyślij", do: "post", path: "/api/notch/requests/9/reply" }, { label: "Otwórz", do: "open_url", url: "https://crm.hadastudios.com/projects/12?request=9" }] },
    close: { id: `close:${localDay()}`, kind: "close", tone: "good", sticky: true, priority: 75,
      title: "Zamykamy dzień?", body: "5 h 10 pracy, 6 zrobione, 3 zostało.",
      actions: [{ label: "Zamknij dzień", do: "close" }] },
  };
  return kinds.map(k => all[k]).filter(Boolean);
}
/* `GET /api/notch/close`, staged. `&close=off` is a Helm without it (null),
   `&close=done` the review already done today, `&queue=fail` a Helm refusing
   the row actions (they must turn back). */
let demoClosed = false;
function demoCloseDay() {
  if (params.get("close") === "off") return null;
  return {
    day: localDay(), worked: { you: 310, agents: 85 },
    done: { count: 6, titles: ["Repricer — reguły cen", "Faktura dla Ubrania", "Mapa strony dla Google"] },
    logs: [
      { key: "log:3:" + localDay(), projectId: 3, project: "Esono Rozwój", minutes: 95 },
      { key: "log:30:" + localDay(), projectId: 30, project: "Codenotch", minutes: 40 },
    ],
    left: [
      { key: "request:1", type: "item", title: "Rynek Czeski — poprawki w koszyku", context: "Esono Rozwój", minutes: 120, itemKeys: ["request:1"] },
      { key: "small", type: "small", title: "3 małe rzeczy", context: null, minutes: 30, itemKeys: ["todo:4", "todo:5", "todo:6"] },
      { key: "request:22", type: "item", title: "Eksport faktur do CSV", context: "Akcesfonia", minutes: 60, itemKeys: ["request:22"] },
    ],
    firsts: [
      { key: "request:1", title: "Rynek Czeski — poprawki w koszyku", context: "Esono Rozwój" },
      { key: "request:11", title: "Filtry kategorii w sklepie", context: "Esono Rozwój" },
      { key: "request:32", title: "Tryb ambient: nowe sceny", context: "Codenotch" },
    ],
    summary: "Repricer domknięty i faktura wysłana, dobry dzień.\nKoszyk czeski znów przesunięty: jutro jako pierwszy.",
    closed: params.get("close") === "done" || demoClosed,
  };
}
/** Two staged logos, as Helm serves them: an image, by project and version. */
const demoLogos: Record<string, string> = {
  "3:v1": `data:image/svg+xml;utf8,${encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><defs><linearGradient id='g' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='#ff8a4c'/><stop offset='1' stop-color='#e8562a'/></linearGradient></defs><rect width='64' height='64' rx='15' fill='url(#g)'/><path d='M21 22h22M21 32h17M21 42h22' stroke='#fff' stroke-width='6' stroke-linecap='round'/></svg>")}`,
  "4:v2": `data:image/svg+xml;utf8,${encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><rect width='64' height='64' rx='15' fill='#1d6fd8'/><path d='M18 42l10-12 8 7 10-15' fill='none' stroke='#fff' stroke-width='5.5' stroke-linecap='round' stroke-linejoin='round'/></svg>")}`,
};
/** What the preview's terminal would have been asked to do. */
const demoFolderOf = (id: number) => demoNotch()?.folders.find(f => f.requests.some(r => r.id === id)) ?? null;
/** `?finished` stages a run that has just ended on a request — what
   `notch:finished` carries natively — on the waiting session under `?agents`
   and on the working one otherwise. */
export function previewFinished(): { session: string; project: string; folder: string | null } | null {
  if (!params.has("finished") || native) return null;
  /* ⚠️ Under `?agents` only: a finished run is a session that has STOPPED,
     and the default fixture's one session is working. */
  return agentsFixture ? { session: "s1", project: "akcesfonia", folder: null } : null;
}
/* Hold to talk's voice, staged. ⚠️ Rust plays it natively, so the preview only
   keeps time: a sentence "plays" for 45 ms a letter, its level goes out on
   `previewBus` as `voice:out`, and a hush cuts every one short. `?call` and
   `?event=now` are what voice.rs answers as a call and a meeting (text only). */
let demoHushes = 0;
const voicePace = Math.max(1, Number(new URLSearchParams(location.search).get("pace")) || 1);
function demoQuiet(): string | null {
  if (demoPrefs.spokenReplies === false) return "off";
  if (callAsked) return "call";
  if (eventFlag === "now") return "meeting";
  return null;
}
async function demoSay(text: string): Promise<{ played?: boolean; hushed?: boolean; muted?: string }> {
  const why = demoQuiet();
  if (why) return { muted: why };
  const hushes = demoHushes;
  const out = (level: number) => previewBus.dispatchEvent(new CustomEvent("voice:out", { detail: level }));
  for (let at = 0; at < Math.min(text.length * 45, 6000); at += 50) {
    if (demoHushes !== hushes) { out(0); return { hushed: true }; }
    out(0.35 + 0.45 * Math.abs(Math.sin(at / 90)));
    await new Promise(done => setTimeout(done, 50));
  }
  out(0);
  return { played: true };
}

async function scriptReply(text: string, capture = false, voice = false) {
  const now = new Date().toISOString();
  const keep = (id: number, role: string, body: string, receipts: unknown[] = []) =>
    sentHere.push({ id, day: localDay(), kind: "chat", role, title: null, body, url: null, createdAt: now, read: true, receipts, cards: [], images: [] });
  const send = (detail: unknown) => previewBus.dispatchEvent(new CustomEvent("helm:chat", { detail }));
  const wait = (ms: number) => new Promise(done => setTimeout(done, ms));
  send({ t: "start", id: 100 });
  await wait(300);
  /* Quick capture's answer: one line and what it filed. */
  if (capture) {
    send({ t: "status", text: "Zapisuję" });
    await wait(500);
    send({ t: "text", d: "Zapisane, przypomnę jutro o 9:00." });
    send({ t: "receipt", index: 0, receipt: { label: `Przypomnienie: ${text.slice(0, 60)}`, icon: "note", undo: { op: "delete", table: "reminders", id: 4 } } });
    await wait(150);
    send({ t: "done", id: 102, changed: true });
    return;
  }
  /* A spoken turn's answer: two sentences, the first whole well before the
     second, so a test sees it said while the rest is still being written. The
     receipt comes first, as Helm's do (the tool runs, then it says so).
     `&pace=n` slows the whole turn n times, for a picture of each moment;
     `&voicecard` adds a card, which the voice glance cannot hold. */
  if (voice) {
    const slow = (ms: number) => wait(ms * voicePace);
    send({ t: "status", text: "Sprawdzam kalendarz" });
    await slow(400);
    const receipt = { label: "Repricer: reguły cen, 17:00", icon: "block", undo: { op: "update", table: "focus_blocks", id: 3, values: {} } };
    send({ t: "receipt", index: 0, receipt });
    if (params.has("voicecard")) send({ t: "card", card: { type: "requests", project: "Esono", projectId: 3, items: [] } });
    for (const part of ["Dobrze, ", "przesunąłem Repricer na siedemnastą. ", "Zostały ci ", "dziś ", "dwie rzeczy."]) {
      send({ t: "text", d: part });
      await slow(part.startsWith("Zostały") ? 900 : 200);
    }
    const id = 1000 + sentHere.length;
    keep(id, "me", text);
    keep(id + 1, "guardian", "Dobrze, przesunąłem Repricer na siedemnastą. Zostały ci dziś dwie rzeczy.", [receipt]);
    send({ t: "done", id: id + 1, changed: true });
    return;
  }
  send({ t: "status", text: "Sprawdzam kalendarz" });
  await wait(600);
  for (const part of ["Dobrze. ", "Przesunąłem Repricer ", "na 17:00, ", `bo pytasz o: „${text.slice(0, 40)}”.`]) {
    send({ t: "text", d: part });
    await wait(220);
  }
  const receipts = [
    { label: "Plan: Repricer po południu", icon: "plan", undo: null },
    { label: "Repricer: reguły cen, 17:00", icon: "block", undo: { op: "update", table: "focus_blocks", id: 3, values: {} } },
  ];
  receipts.forEach((receipt, index) => send({ t: "receipt", index, receipt }));
  await wait(200);
  const id = 1000 + sentHere.length;
  keep(id, "me", text);
  keep(id + 1, "guardian", `Dobrze. Przesunąłem Repricer na 17:00, bo pytasz o: „${text.slice(0, 40)}”.`, receipts);
  send({ t: "done", id: id + 1, changed: true });
}

/* What the preview was asked to do to Helm, for the browser tests to read back
   (`window.__helmCalls`). ⚠️ Helm's writes have nothing to show in a preview —
   a logged hour or a started terminal changes nothing on this page — so the
   only way a test can know Log sent 265 minutes to request 21 is to ask. */
const helmCalls: { command: string; args: Record<string, unknown> }[] = [];
if (preview) (window as unknown as { __helmCalls: typeof helmCalls }).__helmCalls = helmCalls;

/* ── Batch 13 peek SOURCES, staged (builder S) ──────────────────────────
   `&src=volume,buds,mic,power,download,screenshot,paid,logged,focus` fires each
   source's event once, in that order, ~1.2 s apart from 1.5 s after load, on
   `previewBus` under the names Rust emits (`peek:buds`, `peek:mic`, …;
   paid/logged as `peek:helm`, the shape of `/api/notch` `peeks`). `focus`
   counts only during a running block, so stage it with `&helm&running`.
   ⚠️ Separate from P's peek flags on purpose: these stage the SOURCES, P's
   the engine. Settings → Peeks in the preview keeps `peeks`/`peekQuiet` in
   sessionStorage so a reload shows what was switched (tests/browser/peeks.spec). */
const PREVIEW_SHOT = "data:image/svg+xml;utf8," + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="100"><rect width="160" height="100" fill="#20242c"/><rect x="10" y="10" width="90" height="12" rx="3" fill="#5ac8fa"/><rect x="10" y="30" width="140" height="60" rx="4" fill="#2f3542"/></svg>`);
const previewSources: Record<string, [string, unknown]> = {
  buds: ["peek:buds", { name: "Mateusz's Buds3 Pro", connected: true, battery: 80 }],
  mic: ["peek:mic", true],
  volume: ["peek:volume", { level: 64, muted: false }],
  power: ["peek:power", { what: "low", percent: 12, urgent: false }],
  download: ["peek:file", { token: "d1", kind: "download", name: "faktura_wrzesien_2026.pdf", thumb: null }],
  screenshot: ["peek:file", { token: "s1", kind: "screenshot", name: "Zrzut ekranu 2026-10-30 151204.png", thumb: PREVIEW_SHOT }],
  paid: ["peek:helm", [{ id: "paid:41", kind: "paid", title: "+4 795 zł · NXM", at: new Date().toISOString() }]],
  logged: ["peek:helm", [{ id: "logged:907", kind: "logged", title: "1 h 20 min na Atelier, zalogowane", at: new Date().toISOString() }]],
  focus: ["peek:focus", "youtube.com"],
};
if (preview) {
  (params.get("src") ?? "").split(",").filter(k => k in previewSources).forEach((kind, i) => {
    const [name, detail] = previewSources[kind];
    setTimeout(() => previewBus.dispatchEvent(new CustomEvent(name, { detail: structuredClone(detail) })), 1500 + i * 1200);
  });
  try {
    const kept = JSON.parse(sessionStorage.getItem("preview-peek-prefs") ?? "null") as { peeks?: unknown; peekQuiet?: unknown } | null;
    if (kept) Object.assign(demoPrefs, kept);
  } catch { /* none kept */ }
}
const keepPeekPrefs = (prefs: Record<string, unknown>) => {
  try { sessionStorage.setItem("preview-peek-prefs", JSON.stringify({ peeks: prefs.peeks ?? {}, peekQuiet: prefs.peekQuiet ?? null })); } catch { /* forgotten */ }
};
/* ── end of batch 13 sources ── */

/* ── The wake word, staged (30 Oct) ─────────────────────────────────────
   `&wake` switches it on and "hears" the word once, `&wake=<ms>` after load
   (default 1500), as `wake:heard` on `previewBus` — what wake.rs emits. In any
   preview `window.__wake()` hears it again. The microphones are his (the
   earbuds' hands-free one among them); Settings → Voice keeps its four prefs
   and whether a key was saved in sessionStorage, so a reload shows them. */
const demoMics = [
  { id: "{0.0.1.00000000}.{usb}", name: "Microphone (USB Audio Device)", isDefault: false, handsFree: false },
  { id: "{0.0.1.00000000}.{buds}", name: "Headset (Mateusz's Buds3 Pro Hands-Free)", isDefault: true, handsFree: true },
  { id: "{0.0.1.00000000}.{droid}", name: "Microphone (DroidCam Audio)", isDefault: false, handsFree: false },
  { id: "{0.0.1.00000000}.{steam}", name: "Microphone (Steam Streaming Microphone)", isDefault: false, handsFree: false },
];
let demoWakeKey = false;
let demoHeardAt = 0;
function demoWakeStatus() {
  const p = demoPrefs as { wakeWord?: boolean; wakeMic?: string };
  const reason = !p.wakeWord ? "off" : !demoWakeKey ? "key" : !p.wakeMic ? "mic" : null;
  return { listening: !reason, reason, heardAt: demoHeardAt, problem: null, hasKey: demoWakeKey, snoozedUntil: 0 };
}
function demoHear() {
  demoHeardAt = Date.now();
  previewBus.dispatchEvent(new CustomEvent("wake:heard", { detail: demoHeardAt }));
  previewBus.dispatchEvent(new CustomEvent("wake:state", { detail: demoWakeStatus() }));
}
const WAKE_KEPT = ["wakeWord", "wakeMic", "wakeMicName", "wakeSensitivity"];
if (preview) {
  (window as unknown as { __wake: () => void }).__wake = demoHear;
  try {
    const kept = JSON.parse(sessionStorage.getItem("preview-wake-prefs") ?? "null") as Record<string, unknown> | null;
    if (kept) { demoWakeKey = !!kept.hasKey; for (const k of WAKE_KEPT) if (k in kept) demoPrefs[k] = kept[k]; }
  } catch { /* none kept */ }
  if (params.has("wake")) setTimeout(demoHear, Number(params.get("wake")) || 1500);
}
const keepWakePrefs = () => {
  const kept: Record<string, unknown> = { hasKey: demoWakeKey };
  for (const k of WAKE_KEPT) kept[k] = demoPrefs[k];
  try { sessionStorage.setItem("preview-wake-prefs", JSON.stringify(kept)); } catch { /* forgotten */ }
};
/* ── end of the wake word ── */

export async function call<T = void>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  if (native) return invoke<T>(command, args);
  if (command.startsWith("helm_") || command.startsWith("voice_") || command.startsWith("wake_")) helmCalls.push({ command, args: structuredClone(args) });
  if (command === "wake_mics") return structuredClone(demoMics) as T;
  if (command === "wake_status") return demoWakeStatus() as T;
  if (command === "wake_key") {
    demoWakeKey = !!String(args.key ?? "").trim();
    keepWakePrefs();
    previewBus.dispatchEvent(new CustomEvent("wake:state", { detail: demoWakeStatus() }));
    return demoWakeKey as T;
  }
  if (command === "wake_turn") return undefined as T;
  if (command === "wake_snooze") return 0 as T;
  /* ── Moments (30 Oct) ── the jumps and links a moment's buttons make, read back by moments.spec.ts. */
  if (command === "focus_session" || command === "open_external") helmCalls.push({ command, args: structuredClone(args) });
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
    keepPeekPrefs(demoPrefs);
    keepWakePrefs();
    previewBus.dispatchEvent(new CustomEvent("wake:state", { detail: demoWakeStatus() }));
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
  if (command === "get_shortcuts") return {hide:"Ctrl+Alt+H", ring:"Alt+W", capture:"Ctrl+Alt+J", talk:"Alt+Q"} as T;
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
  /* ⚠️ The sun times are REAL fields, not decoration for one widget. The
     reading arrives from `weather.rs` with them and the fixture had only the
     four the pill uses — so Daylight drew its fallback even day here and
     nothing could tell that apart from the widget working. */
  if (command === "get_weather") return {place:"Krakow, Poland", celsius:17,
    summary:"Partly cloudy", icon:"wxPartly", readAtMs: Date.now(),
    /* ⚠️ `?sky=night` moves SUNSET rather than the clock. Daylight decides
       which body to draw from where "now" falls between the two times, so
       pushing both into the last half hour of the day makes every hour a test
       can run at count as night — and the widget takes the same path it would
       at three in the morning. Faking the clock instead would have every other
       fixture on the page living in the future. */
    isDay: !night, high: 21, low: 11,
    /* ⚠️ Day is 00:01 to 23:59 and night is the last twenty minutes of it, so
       whichever flag is set holds at every hour a test might run at. Unflagged
       is the honest default — the real times for the fixture's own city. */
    sunrise: night ? "23:30" : daytime ? "00:01" : "06:12",
    sunset: night ? "23:50" : daytime ? "23:59" : "19:34",
    /* ⚠️ The HOURS and DAYS too. `weather.rs` has sent both for a while and the
       fixture carried neither — so every widget variant that draws a forecast
       silently fell back to its no-data path, and a chart that never appeared
       looked exactly like a chart that was not built. A day that climbs and
       then falls, because a flat series tests none of the scaling. */
    hours: Array.from({ length: 12 }, (_, at) => ({
      at: `${String((new Date().getHours() + at) % 24).padStart(2, "0")}:00`,
      celsius: Math.round(12 + Math.sin(at / 2.4) * 7),
      // `&rain` (peeks block): the next hours wet, for "weź parasol".
      icon: params.has("rain") ? "wxRain" : at % 4 === 0 ? "wxClear" : at % 3 === 0 ? "wxRain" : "wxPartly",
    })),
    days: Array.from({ length: 6 }, (_, at) => ({
      date: new Date(Date.now() + at * 86400000).toISOString().slice(0, 10),
      icon: at % 3 === 0 ? "wxClear" : at % 2 === 0 ? "wxRain" : "wxPartly",
      high: 19 - at, low: 9 + (at % 3),
    }))} as T;
  if (command === "set_weather_place") return null as T;
  /* One coin, so the block can be seen without a symbol configured and a
     network round trip. ⚠️ A RISING day by default and `?coin=down` for the
     other one: the block's whole colour scheme hangs off the sign, and a
     fixture that only ever goes up tests half of it. */
  if (command === "get_crypto") {
    const down = new URLSearchParams(location.search).get("coin") === "down";
    const spark = Array.from({ length: 30 }, (_, at) =>
      61200 + Math.sin(at / 3.1) * 1400 + (down ? -at * 95 : at * 120));
    return { symbol: "BTCUSDT", name: "BTC", quote: "USDT",
      price: spark[spark.length - 1], changePct: down ? -2.4 : 1.9,
      high: Math.max(...spark), low: Math.min(...spark),
      spark, readAtMs: Date.now() } as T;
  }
  if (command === "set_crypto_symbol") return null as T;
  /* A wallet, so the block can be seen without connecting a real account.
     ⚠️ `?wallet=off` is the OTHER state, and it is the one most people are in:
     a block whose only fixture is the happy path is a block whose empty state
     nobody ever looks at. */
  if (command === "get_wallet") {
    if (new URLSearchParams(location.search).get("wallet") === "off") return null as T;
    const holdings = [
      { asset: "BTC", amount: 0.0412, value: 2671.4 },
      { asset: "ETH", amount: 1.18, value: 3240.9 },
      { asset: "SOL", amount: 14.2, value: 1985.3 },
      { asset: "USDT", amount: 612.4, value: 612.4 },
      { asset: "ADA", amount: 840, value: 302.1 },
    ];
    const total = holdings.reduce((sum, one) => sum + one.value, 0);
    /* ⚠️ A HISTORY as well. The line is recorded by the app rather than
       fetched, so a fixture without one only ever shows the "watching" state —
       which is real, and is not the state anybody is trying to look at. A
       fortnight of quarter-hours, wandering. */
    const history = Array.from({ length: 60 }, (_, at) => ({
      at: Date.now() - (59 - at) * 15 * 60 * 1000,
      value: total * (0.88 + Math.sin(at / 7) * 0.06 + at * 0.0022),
    }));
    const first = history[0].value;
    return { connected: true, quote: "USDT", holdings, readAtMs: Date.now(), total,
      history, changePct: ((total - first) / first) * 100,
      spanMs: history[history.length - 1].at - history[0].at } as T;
  }
  if (command === "connect_binance" || command === "disconnect_binance") return null as T;
  if (command === "binance_connected") return false as T;
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
    || command === "size_pin" || command === "note_drag_end") return undefined as T;
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
  /* Helm, staged. ⚠️ Disconnected unless `?helm`: a connected Helm adds a
     running block to the pill and, with `?nudge`, a nudge at priority 80 —
     which would take the strip from every other test. */
  if (command === "get_helm") return structuredClone(peekStageHelm(demoHelm())) as T;
  if (command === "helm_thread") {
    if (!params.has("helm")) throw new Error("Sign in to Helm in Settings to talk to the Guardian.");
    if (typeof args.day === "string" && args.day) return structuredClone(demoDay(args.day)) as T;
    return structuredClone(demoThread()) as T;
  }
  /* Round 2's endpoints, staged. ⚠️ `&history=off`, `&speech=off` and
     `&projects=off` are each the 404 a Helm without the endpoint answers —
     helm.rs turns those into null, and the island has to take it quietly. */
  if (command === "helm_history") {
    if (params.get("history") === "off") return null as T;
    return structuredClone(typeof args.q === "string" && args.q ? demoSearch(args.q) : demoHistory()) as T;
  }
  if (command === "helm_projects") return structuredClone(demoProjects()) as T;
  if (command === "helm_suggestions") return (params.has("helm") ? structuredClone(demoSuggestions(args)) : null) as T;
  if (command === "helm_transcribe_ready") return (params.get("speech") !== "off") as T;
  if (command === "helm_transcribe") {
    if (params.get("speech") === "off") return { unavailable: true } as T;
    await new Promise(done => setTimeout(done, 450 * voicePace));
    return { text: "Przesuń Repricer na jutro rano" } as T;
  }
  /* `&remind=sent` is Helm's 409: that level went out before. */
  if (command === "helm_remind") return (params.get("remind") === "sent"
    ? { ok: false, status: 409, error: "Uprzejme przypomnienie poszło już 26 paź" }
    : { ok: true, sentTo: "ksiegowosc@ubrania.pl" }) as T;
  if (command === "helm_renewal") return { ok: true } as T;
  if (command === "helm_send") { void scriptReply(String(args.text ?? ""), !!args.capture, !!args.voice); return undefined as T; }
  if (command === "voice_say") return (await demoSay(String(args.text ?? ""))) as T;
  if (command === "voice_hush") { demoHushes++; return undefined as T; }
  if (command === "voice_quiet") return demoQuiet() as T;
  if (command === "voice_keys") return undefined as T;
  /* Cofnij: the change is marked taken back in the thread, as Helm does. */
  if (command === "helm_undo") {
    const message = sentHere.find(m => m.id === args.messageId) as { receipts?: { undoneAt?: string }[] } | undefined;
    const receipt = message?.receipts?.[Number(args.index)];
    if (receipt) receipt.undoneAt = new Date().toISOString();
    return undefined as T;
  }
  /* The cockpit's commands. ⚠️ Under `notch=off` they answer as the deployed
     Helm would without the endpoint — but nothing should be calling them then,
     because nothing that calls them is drawn. */
  if (command === "helm_request") {
    if (params.get("notch") === "off") throw new Error("This Helm can't do that yet.");
    if (args.status !== "done") return { ok: true, suggestion: null } as T;
    /* The akcesfonia request has no estimate, so Helm can't cap it: his time
       plus the agents' at the client's share, UNCAPPED — the amber case, which
       needs staging as much as the ordinary one. (With an estimate Helm always
       caps, so "uncapped" never sits next to one.) */
    return { ok: true, suggestion: args.id === 21
      ? { minutes: 250, you: 20, agent: 230, estimate: null, capped: false }
      : { minutes: 90, you: 20, agent: 70, estimate: 120, capped: true } } as T;
  }
  if (command === "helm_log") return undefined as T;
  if (command === "helm_start_claude") {
    const folder = demoFolderOf(Number(args.id));
    if (!folder?.path) throw new Error("Helm doesn't know this project's folder yet.");
    return `${folder.path.split("/").pop()} · Windows Terminal` as T;
  }
  if (command === "helm_logo") return (demoLogos[`${args.id}:${args.version}`] ?? null) as T;
  /* Batch 12. `&hpost=fail` is Helm refusing a moment's post (it must come back). */
  if (command === "helm_close_day") { await new Promise(done => setTimeout(done, 120)); return structuredClone(demoCloseDay()) as T; }
  if (command === "helm_notch_post") {
    const path = String(args.path ?? "");
    if (!path.startsWith("/api/notch/")) throw new Error("That isn't a Helm path the notch may post to.");
    if (path === "/api/notch/close") { demoClosed = true; return { ok: true } as T; }
    if (params.get("hpost") === "fail" && path !== "/api/notch/moments") return { ok: false, status: 409, error: "Odpowiedź nie jest jeszcze gotowa" } as T;
    return { ok: true } as T;
  }
  if (command === "helm_queue" && params.get("queue") === "fail") {
    await new Promise(done => setTimeout(done, 150));
    throw new Error("Helm said no.");
  }
  if (["helm_act", "helm_queue", "helm_read", "helm_undo", "helm_open", "helm_send_code", "disconnect_helm"].includes(command)) return undefined as T;
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
