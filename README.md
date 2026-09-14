# Codenotch for Windows

A Windows port of [Codenotch](../codenotch) — the notch that shows how much of
each coding assistant's usage limit you have burned.

**This is a rewrite, not a port.** The macOS app is SwiftUI + AppKit; none of
that exists here. What carries across is the *specification*: the design-frame
measurements, the endpoint contracts, and the accumulated knowledge of each
vendor's quirks. The Swift is the reference implementation — read it, don't
translate it line by line.

Stack: Tauri 2 (Rust) + vanilla TypeScript. Rust owns the window, the Win32
calls and the providers; the notch itself is HTML and CSS.

## The island

A second surface starts at the **top** edge as a small pill. Hover to grow it
into a panel; move away and it folds back with the same spring as the usage
notch. Pin keeps it open, the close button collapses it, and reduced-motion
preferences are respected. It is one shape throughout — the panel *is* the pill,
grown — and it sizes itself to whatever screen is showing.

It is a **wide, shallow bar** — about 970 x 160 — and it flares back out into
the bezel at each end the way the usage notch does, so it reads as part of the
screen edge rather than a panel parked against it. The tabs sit at the top-left
and the window controls at the top-right, on one strip.

Four screens, switched from the rail along the bottom — or by **scrolling
anywhere in the panel** that is not a scrollable list:

| screen | what it holds |
|---|---|
| **Home** | the default: now playing, the week ahead and the next couple of tasks, on one row |
| **Today** | the Day Card — tasks, the composer, the focus timer |
| **Media** | whatever is playing, with artwork, position and transport controls |
| **Calendar** | Google Calendar as an **agenda** or a **seven-day grid** |
| **System** | volume, screen brightness, audio output, and what is connected over Bluetooth |

On Home every column is a live, stripped view of the screen it names: the
transport controls work, tasks can be ticked off, and each column heading opens
the full screen behind it.

**Collapsed, the island shows one thing: whatever is most live.** A meeting
about to start beats a running focus timer, which beats something playing, which
beats the day's tally. The screen that has something live raises a dot on its
tab.

### Search and commands

**`Ctrl+Alt+K`**, or the magnifier in the header. Type, arrow, Enter — or
`Alt`+the number beside a row to run it outright. `Escape` or a click anywhere
else closes it, and the island narrows while it is up: a list of one-line
results in a 910px panel reads as a window someone left open.

One surface over the whole island: every screen, every command, every shelf
item, every live agent session, today's tasks — and anything you type that
matches nothing is offered as a new task. Matching is by subsequence, so `agt`
finds Agents and `sif` finds Show in folder; three letters get you there.

⚠️ **It is not trying to replace Flow Launcher or Raycast.** Those are general
launchers and are better at that job. What this can do that they cannot is
search the island's *own* world and act on it in place — copy a shelved file,
raise the terminal of the session that is waiting for you, tick a task. It is
meant to sit beside a launcher, not instead of one.

**`Tab` goes a level deeper.** Every row that has more than one obvious verb
carries the rest behind it: a shelf item offers copy, open, show in folder and
take off the shelf; a session offers raise, copy the name and quiet for an hour;
a found file offers open, reveal, shelve and copy the path. Enter still does the
obvious thing, so nothing got slower. `Escape` backs out one level before it
closes the palette.

**It puts what you actually use first.** With nothing typed the order is by
recency, halving every three days — not by how often, which never forgets and
slowly turns the list into a record of what you used to do. Typing still wins:
the lift is smaller than a word-boundary match, so it breaks ties rather than
overruling them.

**Arithmetic.** A line with a digit and an operator is answered rather than
searched — `1900 * 56/117`, `90 + 15%`, `20% of 90` — and Enter copies the
result. It is a parser, never `eval`, and it refuses anything that is not a sum
so the row can never appear over what you were looking for.

**Applications.** Type `bra`, get Brave. The index is the **Start Menu** —
Windows has no API that says "the installed applications", but it has two
folders of shortcuts that every installer writes to, which is what the Start
Menu itself lists. Each row carries the app's own icon, pulled off the shortcut
by the shell. Built once in the background at start (152 apps and 287 KB of
icons on this machine, about 1.7s) and cached, because apps do not appear while
you are typing. ⚠️ "Uninstall X", "X Website" and "X Help" are filtered
out — without that, `bra` offers to uninstall Brave as readily as to open it.

**Files, through Everything.** If [Everything](https://voidtools.com) is running
its index is searched too, past three characters, and `Enter` opens the hit —
shelving and revealing are a `Tab` away. Each row carries an icon for what the
file actually is, because a page of hits is otherwise a column of identical
rows. Nothing is installed for it: Everything answers over `WM_COPYDATA`, so
there is no `es.exe`, no HTTP server to enable and no SDK dll to ship. With
Everything closed the palette simply has no file results and says nothing about
it.

**Ranking prefers the thing you named.** Match *quality* — an exact title, a
prefix, the initials of a multi-word name, the query appearing whole — counts
for more than which band a row is in, and bands (an answer, then apps, then the
island's own world, then files) are a preference that decides between things
matching about as well. ⚠️ They were a hard sort order once, and it was
visibly wrong: typing `hero` put *"Hide the chrome"* above a folder actually
called `hero`, and nothing about the match could get past the band.

**A typed prefix narrows to one band** when you do want a strict filter:
`>` for the island's own world, `a ` for apps, `f ` for files. The prefix leaves
the field and becomes a chip; `Backspace` on an empty field sheds it.

**`Tab` → Star this.** A star lifts something near the top and puts it in the
**empty** palette, so the blank field is a short list of what you keep. Anything
with a stable id can be starred, **including a file or a folder** — star
`codenotch-win` once and it is two keystrokes away for ever, with no round trip
to Everything and no need for it to be running. ⚠️ Stars live in
`stars.json` beside the config, not in the WebView's storage: recency is a guess
the palette makes and can afford to lose, a star is something you said.

**Failures are said out loud.** Every palette action used to end in
`.catch(() => {})` — a file that had moved, an app whose shortcut was stale, a
session that had exited all did nothing and reported nothing. The palette closes
before an action runs, so there is nowhere left to put an error; it goes to the
pill's own notice instead.

### Six global shortcuts

`Ctrl+Alt+Space` opens and closes the island. `Ctrl+Alt+K` opens the palette.
`Ctrl+Alt+T` opens the island with the caret already in the composer, so a
thought reaches TickTick from anywhere. `Ctrl+Alt+H` takes it and the usage
notch off screen — the island sits where an editor keeps its tab strip, so
getting it out of the way had to be one key. `Ctrl+Alt+M` sends the island to
the next display, and `Ctrl+Alt+V` parks the clipboard on the shelf. All of them
are rebindable in the task editor, and the choice to hide survives a restart.

⚠️ **Nine letters are unavailable, and the reason is not obvious.**
`Ctrl+Alt` *is* `AltGr` on Windows, so a `Ctrl+Alt+N` hotkey and an `AltGr+N`
keystroke are the same event — and registering the hotkey takes the letter away
everywhere on the machine. Capture was `Ctrl+Alt+N` and the shelf was
`Ctrl+Alt+S`; between them they ate `ń` and `ś`, which presents as a keyboard
that has quietly stopped typing two characters. The Polish (programmers) layout
maps AltGr to **A C E L N O S X Z**, and the editor now refuses all nine rather
than letting you pick one back.

⚠️ Deliberately not `Alt+Space` for the palette: Flow Launcher, PowerToys Run
and half the launchers on Windows already claim it, and a global shortcut that
silently fails to register is worse than an unfamiliar one.

Hiding and showing **slide** out through the bezel rather than blinking, and the
island **hides itself** whenever something is genuinely fullscreen — a game, a
presentation, a shared screen. That uses the same signal Windows uses to decide
whether a notification may appear, so a merely maximised editor does not count.

However it got hidden, **hovering the screen edge brings it back** for as long
as the pointer stays there, the way an auto-hiding taskbar does. It leaves a few
pixels of hot strip behind for exactly that.

### Agents

Every live Claude Code session, ordered by who wants you: **waiting** in amber
first, then working, then idle. Each row carries the project, the branch, the
tokens seen and how long the last run took.

**Clicking a row raises that session's terminal.** This is the point of the
screen — finding which of three terminals has stopped otherwise means
alt-tabbing through all of them.

⚠️ Two Win32 problems sit between a pid and a raised window, and both fail
quietly. Claude Code is a console program, so **the pid owns no window** — the
window belongs to its terminal, an ancestor, and the process tree has to be
walked upward to find it. And **`SetForegroundWindow` refuses silently** for a
process that does not already own the foreground, which this one never does.
It raises the window, not the tab: one terminal window hosts many sessions and
there is no supported way to pick one from outside.

A waiting session also claims the collapsed pill, and the usage notch's dot
turns amber. Only *waiting* claims it — something working needs nothing from
you and will carry on by itself.

Token totals are **since Codenotch started watching**, not for the session's
life, and the screen says so.

### Shelf

A place to put a thing down. Drop a file on the island, or press **`Ctrl+Alt+V`**
and whatever is on the clipboard parks there — a file, a link, a pasted note.
Later you take it out again wherever you were going with it.

⚠️ **Files are referenced, never copied.** A shelf that copied would duplicate
a 2 GB video to park it for ten minutes. The price is that a file can move
behind the shelf's back, so a broken reference is **shown** rather than hidden
— a row that silently vanished would look like the shelf losing things.

⚠️ **Taking a file out is a clipboard copy, not a drag.** Dragging a real file
*out* of a WebView is not something HTML can do; doing it properly means a
hand-written OLE drag source and a modal `DoDragDrop` inside a click-through,
non-activating window. `SetClipboardData(CF_HDROP)` is one documented call, and
Ctrl+V then pastes the real file into Explorer, Slack or an upload field.

The shortcut deliberately does **not** open the island — the point is to park
something without leaving what you are in. The pill says what landed.

**Drag a file over the pill** and the island opens into a drop zone — a dashed
frame across the whole panel saying *Drop to shelve*. Let go anywhere on it.

⚠️ **The pill is the doorway, and it has to be.** The island is click-through
everywhere else, so a drag cannot be *seen* until it crosses painted chrome.
Once it does, WebView2 tells the page it is carrying files, and only then can
the whole window open up as somewhere to aim. (An earlier version used Shift as
the trigger; a modifier can make the window interactive but cannot tell a file
from a stray click.)

**Drag a row back out** to drop the file somewhere else — a real OLE drag
carrying a real `CF_HDROP`, so Explorer, Slack and upload fields all take it.
**Copy** puts the same thing on the clipboard, which is easier to aim at a chat
box than a drag from a strip on the bezel.

⚠️ That drag runs on the **main thread**, and it has to. `DoDragDrop` drives a
modal loop out of the calling thread's message queue; on a worker thread it
receives no mouse input, never learns the button came up, and never returns —
holding the mouse capture, which stops dragging working *everywhere* until the
app is killed. There is also a watchdog: a drag still running after twelve
seconds gets a synthetic Escape, so the worst case is a few seconds rather than
a dead cursor. `node tools/drag-out-check.mjs` proves the loop terminates
without having to find out by hand.

If a drop seems to do nothing, tray → **Open log**: `dom dragenter` means the
page saw it and the fault is downstream; nothing means the drag never reached
the window, so aim closer to the painted strip.

### Review

Where the day went. App time, tasks finished, agent runs and meetings attended
— four things that were all already being kept, in four places, with nothing
joining them. "I was here nine hours" and "two tasks got finished" are each a
fact; together they are the question you actually had.

App time lives here now rather than on System, where it never belonged: System
is the machine's controls, and how long you spent in an editor is not a control.

### Not now

Anything that asks for attention can be told to wait an hour — a waiting agent
from its row, a pill module from its id. It is the gesture the app was missing:
`decay` already handles a condition that is *chronically* true, like a disk at
96%, but a waiting session has no severity that fades and no value that creeps,
so nothing but an explicit "not now" could quiet it.

⚠️ **Nothing is silenced for ever.** Every snooze ends, the island's settings
say how many things are quiet, and one press brings them all back. The failure
mode of a mute button is forgetting you pressed it.

### When a run finishes

The usage notch is a separate window from the island on purpose: it is
click-through chrome reporting on something running elsewhere, while the island
is a surface you type into.

Collapsed it is an 83 × 10px pill with room for exactly one fact, and it
carries the one worth having. A **breathing white dot** means an agent is
working. A **green dot** means a run has just finished — and it stays there
until you open the notch, because the whole point is the run nobody was
watching. Windows also raises a toast naming the project and how long it took
(`akcesfonia finished · Claude Code ran for 4m 12s.`).

A finish is a session that stopped writing its transcript while its process is
still alive. Closing a terminal mid-run raises nothing.

### Displays

On more than one monitor, the island and the usage notch each remember which
screen they are welded to — by the panel's own hardware id, not by
`\\.\DISPLAY1`, which is an adapter slot that renumbers when you unplug
something. Displays are named from their EDID, so the picker in Settings says
**DELL U2724D** and **MSI G24C4** rather than "Generic PnP Monitor" twice.

`Ctrl+Alt+M` moves the island across; the tray moves either window; Settings has
a picker for each. A screen that is asleep or on another input is *absent*, not
gone: placement falls back to where the window already is and keeps the setting,
so it comes home when the display does. Plugging a monitor in or waking from
sleep re-places both windows within three seconds.

### System

A bento of tiles: volume and screen brightness on Control-Centre-style capsules
you can grab anywhere rather than aiming at a thumb, the audio output and the
Bluetooth devices, **CPU, memory, disk, network and uptime**, and the day's app
time. There is a lock button. When something connects over Bluetooth, the island
says so for a few seconds.

Device lists show **what is in use** and put the rest behind one press, so the
screen is the same size with three outputs or thirty — opening a list grows the
island rather than being clipped by it. The meters turn amber past 80% and red
past 92%.

Two honest limits. Brightness goes over **DDC/CI** to the monitor, which plenty
of desktop panels simply refuse — you get a plain sentence instead of a dead
slider. And Windows has never published an API for changing the default audio
output, so that half goes through the same undocumented interface every other
switcher uses; failures are reported rather than swallowed. The Bluetooth list
is a **readout**: there is no supported way to connect or disconnect a device
from another process.

### Where the day went

The System screen shows a breakdown of the applications you have actually been
in today — a stacked bar with the top few named. It is **local only**, records
nothing but the process name (never window titles), and **stops counting when
you stop typing**, so a machine left on overnight does not claim fourteen hours
of work.

### At rest, it is a clock

Collapsed, the island shows whatever is most live — a track, a running timer, a
meeting within half an hour. When nothing is, it settles into a clock, and a
player left **paused for 30 seconds** hands the pill back to it.

At rest it is three slots:

```
[ 14 ]      14:53      [ ☁ 17° ]
[ SEP ]
```

The date is the numeral over the month — the number is what you are looking for,
and stacked it costs a third of the width "Mon, Sep 14" did. The time is
**24-hour by default**, switchable to 12 in the island's own settings (the gear,
then **Clock**), and the choice is saved.

⚠️ The clock sits **dead centre whatever the sides weigh**. A clock that slides
as the third slot changes is one the eye has to find before it can read.

### The third slot

One module at a time, chosen by what is true right now. Each answers a single
question and says nothing the rest of the time, so the slot is empty on a quiet
afternoon and busy when something is happening.

A glyph and one number — never a sentence. After a week you are reading the
icon and the colour; the sentence is on the module's own screen, one hover away.

| Module | Says | When |
|---|---|---|
| Disk | `97%` in red | past 92% |
| CPU / Memory | `94%` in amber | past 90% |
| Agents | `2` | Claude Code is writing |
| Next event | `1h` | 30 minutes to 3 hours out |
| Tasks | `4` | there is a day to report |
| Weather | `17°` | a place is configured |

**News holds the slot; everything else rotates**, six seconds each. But
severity only decides whether something *can* hold the strip — **time decides
how long**. A reading owns it for two minutes, then drops into the rotation,
where it still leads the cycle.

That second half matters more than it sounds. A disk sitting at 96% until you
buy a new one is a fact about the machine, not an alert; without the decay the
strip carries a permanent red warning and nothing else is ever seen, which is
the definition of a warning you stop reading. It re-arms if the figure gets
materially worse — five points, not one, because one point is the disk
creeping.

Two thresholds are deliberately higher than the System screen's own meters: CPU
and memory speak at **90%**, not the 80% that turns a meter amber. A developer's
machine sits at 80% with an editor and a browser open and is perfectly well; a
pill that says so all day is one that is ignored on the day it matters.

Weather is **off until you type a place** (task editor → Weather). Nothing is
requested while the field is empty. It uses Open-Meteo, which needs no key and no
account, and the place is geocoded once into coordinates that are then cached —
so the ordinary case is one request every half hour. Resolving the location from
your IP instead would mean telling a third party where this machine is on every
launch, to save one text field.

When a digit changes it rises into place through a soft blur — only the digits
that actually moved, so 14:32 to 14:33 animates one character rather than
re-popping the whole clock once a minute.

### Media

Read from Windows' own transport controls, the same ones the media keys drive,
so **Spotify, a YouTube tab, VLC and anything else** appear without an account,
an API key or a premium tier. Artwork on the left, everything else beside it.
Play/pause answers immediately, and the progress bar is drawn as a **waveform**
you can click to seek — where the player allows it.

That waveform is **synthetic**: Windows hands over metadata, never audio, so
there is nothing to analyse. It is generated from the track's own title and
artist, so the shape is stable and different tracks look different rather than
being noise redrawn every second. It only appears at all when the player
actually reports a timeline.

### Calendar

Read-only Google Calendar. Setting it up is a one-time job in the task editor:

1. In Google Cloud Console, enable the **Google Calendar API** and create an
   OAuth client of type **Desktop app**.
2. Paste its client ID and secret into **tray → Tasks & TickTick… → Google
   Calendar** and press Connect. Your normal browser opens to sign in; Codenotch
   asks only for read access and never sees your password.
3. Credentials go into Windows Credential Manager beside the TickTick token.

Events refresh every five minutes across every calendar you have selected, up to
eight. A meeting with a Meet, Zoom or Teams link gets a Join button.

Short lists use a shorter island instead of an empty full-height panel.

The panel shows **one day as one list** — today's work and anything overdue,
which carries a small amber age badge in place rather than sitting behind a
filter. There are no per-list headings; a task's list is the colour of its ring.
Finished work collapses out of the day into a single **"N done today"** line,
and clearing the last of it shows a **Day clear** mark.

Completion is immediate: the tick, the strike-through and the progress rail all
answer the click, and TickTick reconciles afterwards. A failed write puts the row
back and says why. Nothing else on the list is disabled while a write is in
flight.

**Adding is a field, not a button.** A composer sits permanently above the sync
line — click it and type; Enter files the task and leaves the caret ready for the
next one. The chevron reveals the list and day, which otherwise default to your
last list and today. Escape releases the field without discarding the draft, and
a draft survives the panel folding. **Renaming happens in place**: click a task's
title, type, press Enter. While any field is live the task notch briefly accepts
keyboard focus; releasing it, saving, collapsing or an outside click restores its
normal non-activating behavior. Account setup still has a separate window.

Use the panel's **gear > Screen edge** controls for left, right, top or bottom.
The content stays upright and the choice persists. Drag the ring along its edge.
The usage notch retains its own edge and position.

Open **tray → Tasks & TickTick…** (also available from Settings) to connect:

1. In the TickTick web app, open **Settings → Account → API Token** and create
   a personal token.
2. Paste it into the task editor's connection form. The app checks access before
   saving it in **Windows Credential Manager**, under `codenotch-win/ticktick`.
3. Add tasks from the panel itself, from a TickTick list, or schedule a day. The same account provides phone sync; the existing Google
   Calendar/Samsung Calendar connection continues independently.

The panel adds, completes and renames; the separate editor also lists everything
by project. Sub-tasks are shown under their parent by default — a parent cannot
be completed directly, so collapsed it would be an inert row — while a
checklist stays behind its own "N of M done" line. Full-task reopening,
indent/outdent, reminders and recurrence editing remain in TickTick. Parent
tasks with children summarize progress; complete their children individually.

**Progress:** actionable leaves count once, with checklist items counting as
their task's work units. Today includes tasks scheduled across today and tasks
completed today. Overdue work has its own view. Hiding completed rows does not
change the denominator. The UI withholds the daily count if completion history
hits the API's 200-result cap or belongs to a previous day.

**Sync:** the app reads the task lists returned by TickTick's project endpoint
every 60 seconds and after writes. Inbox coverage depends on whether that
endpoint exposes it; use a regular TickTick list if Inbox is absent. Completion
history uses the same list scope. Cached tasks remain visible after a transient
failure during the current run; this first version fetches again after restart
and does not provide an offline write queue. Failed writes are shown and are
never automatically retried. No extra sync service or subscription is required
by this implementation.

Use the editor's position controls to show/hide the task notch, select any
screen edge, or reset its position. Disconnect removes the saved token and clears the
in-memory task snapshot; it does not delete anything in TickTick.

### Task development and checks

Requires Node 22.18+ (the model tests use Node's TypeScript stripping).

```sh
pnpm test                 # nested progress and local-day rules
pnpm test:ui              # production frontend in headless Chrome
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

The browser preview at `/tasks.html` and `/task-editor.html` uses sample data;
`/tasks.html?empty` shows setup; `?single` shows a compact one-task fixture. Sample interactions are local to that page and
do not persist. `CODENOTCH_DEMO=1` also supplies sample tasks in the native app,
where they are read-only and credential changes are blocked.

Build the standalone exe with `pnpm tauri build --no-bundle`, or run
`pnpm build` followed by `cargo build --manifest-path src-tauri/Cargo.toml --release --offline --features tauri/custom-protocol`.
A plain Cargo release build still loads the development URL.
After building the release exe, `node tools/smoke-release.mjs` launches a
temporary demo instance and tests both WebViews over a local debugging port.
It checks independent cursor masks, native extended styles, task IPC, editor
opening, text input and closing, and saves screenshots/check results under
ignored `test-results/`. Native foreground focus is recorded separately: Windows
may deny activation to the automated launch, so check keyboard focus manually.
Quit any running Codenotch instance first. The script exits its own process;
normal launches do not enable the debugging port. Physical dragging and live
TickTick round trips should also be checked before distributing a release.

## Running it

**Day to day — build once, then just run the exe:**

```sh
pnpm install
pnpm tauri build
```

That produces two things under `src-tauri/target/release/`:

| | |
|---|---|
| `codenotch.exe` | the app itself. Double-click it; that is the whole install. |
| `bundle/nsis/Codenotch_0.1.0_x64-setup.exe` | an installer, if you would rather have Start-menu and uninstall entries. |

⚠️ **`cargo build --release` is not a shortcut for that**, however much it
looks like one. There is no `custom-protocol` feature in `Cargo.toml`, which is
what the Tauri CLI passes to switch a build from the dev server to the embedded
frontend — so building with cargo alone produces an exe that still points at
`http://localhost:1420`. With no vite server running, both windows land on
`chrome-error://chromewebdata/` and the app is two blank rectangles. Nothing
reports an error; it just looks like the frontend broke.

Then turn on **Settings → Start with Windows** and you never launch it by hand
again. It writes one `Run` key under `HKCU`, pointing at wherever the exe
actually is — so if you move the exe, toggle it off and on.

**While changing it:**

```sh
pnpm tauri dev          # live reload; needs the vite server on :1420
CODENOTCH_DEMO=1 pnpm tauri dev   # the design frame's fixtures instead of live data
```

**One instance only.** A second launch hands off to the first and exits. Two
copies put two always-on-top islands at the same coordinates with two separate
in-memory shelves, which does not look like two apps — it looks like one app
whose features have stopped working.

**Something went wrong?** Tray → **Open log**. It is a capped rolling file
beside the config. (`println!` goes nowhere in a release build: no console.)

Every panic is written there with its location, and the long-lived background
loops — the hover poll, the session watcher, media, Bluetooth, app time, the
display watch — say which of them died and try again three times before giving
up. Before that, a panic in one of those ended the feature for the rest of the
session with nothing to say so.

⚠️ **Quit the notch from its tray icon before building.** A running instance
holds its own exe open, and cargo reports that as
`failed to remove file … Access is denied (os error 5)` — which reads like a
permissions problem rather than "the app is open".

⚠️ `pnpm tauri dev` restarts the app on every Rust edit, and each start polls
Claude immediately. Enough restarts in a row will earn a 429. The back-off is
persisted for exactly that reason, but it is worth knowing why the ring goes
dim during a heavy editing session.

**Controls:** hover the notch to unfold it, hover a ring for its card, drag it
along its edge to move it, and click the orb at the end for settings. The tray
icon has Refresh now, Settings, Reset position and Quit — and the tray is the
only way out, because the window is click-through, topmost and out of Alt-Tab.

## Status

| | |
|---|---|
| Window behaviour | ✅ transparent, click-through, non-activating, work-area pinned |
| Notch shape | ✅ `SideNotchShape` ported, flares and all, all four edges |
| Rings, glyphs, percent labels | ✅ all nine marks traced from `GlyphOutline.swift` |
| Tooltip card + tail | ✅ aimed at the hovered cell |
| Settings orb | ✅ resting arc morphing to a gear, opening the panel |
| Drag to reposition | ✅ along its edge, clamped, persisted; tray → Reset position |
| Claude | ✅ live, default profile, back-off persisted across launches |
| Codex | ✅ live (`wham/usage`); the rollout-log fallback is not built |
| Cursor, Antigravity, GLM, Grok, OpenCode | ⬜ |
| Session activity (the spinning inner arc) | ✅ **working** only — see below |
| Settings panel | ✅ edge, reset position, provider status, quit |
| Auto-update | ⬜ Sparkle has no counterpart; Tauri's updater plugin is the route |

### ⚠️ Click-through must be owned by the poll loop, not by startup

`hover.rs` tracks the previous state as `Option<bool>`, starting at `None`, so
its first tick always applies the click-through state. Starting at `false`
matches the initial not-hovering state, the first tick sees no change, and
`set_ignore_cursor_events` is then never called — leaving the window as whatever
`setup()` managed to make it.

In a debug build setup's call sticks and everything looks right. **In a release
build it does not**, and the app ships as a 410×373 invisible rectangle at the
edge of the screen that swallows every click. Measured on the first release
build: exstyle `0x8040198` — no `WS_EX_TRANSPARENT`, no `WS_EX_LAYERED`, where
the dev build had both. Nothing in any log, and nothing visibly wrong.

### Two scales, not one

`Design.scale` says the frame fixes ratios and one anchor picks the size. That
holds until you try it: at the anchor that makes the card's body text readable
on Windows (a 56pt ring) the notch comes out 89px deep and reads as a slab; at
the anchor that makes the notch right, body text lands at 9.5px. The notch is
glanceable chrome you never focus on and the card is something you stop and
read, so they get separate anchors — `px()` and `cpx()` in `src/layout.ts` —
and each stays internally in the frame's proportions. Nothing mixes them except
the window measurement, which sums two already-converted lengths.

### ⚠️ The activity arc cannot see "waiting"

`ClaudeSessionMonitor` reads a `status`/`tempo` pair from
`~/.claude/sessions/<pid>.json`. **Claude Code on Windows writes that file with
a different shape and no status field at all** — `pid`, `sessionId`, `cwd`,
`startedAt`, `procStart`, `entrypoint`, `messagingSocketPath`. Read the macOS
way it yields `idle` for ever, silently.

So the state comes from the transcript: Claude Code appends to
`~/.claude/projects/<project>/<sessionId>.jsonl` as it streams, and a write in
the last 8 seconds means it is working. Nothing of yours has to be configured.
**It can tell waiting from finished**, which this file used to say needed
Claude Code's hooks. It does not — the modification time cannot separate them,
but the file can. The last conversational record says which:

| last record | the session is |
|---|---|
| `assistant` with a `tool_use` | working — a tool call is pending |
| `assistant` with only prose | **waiting for you** |
| `user` (a prompt or a tool result) | working — the model is thinking |

⚠️ "The last record" is not the last line. A transcript carries fifteen record
types and barely half are conversational; bookkeeping lands at the tail
constantly. And they reach **49 MB**, so nothing loads one — a new session is
classified from a 512 KB tail and then only the bytes appended since the last
look are read. All 18 transcripts on this machine classify in 0.76 seconds.

One good thing the Windows file does carry: `procStart`, the process's own
creation FILETIME. That makes the pid-reuse check exact against
`GetProcessTimes`, rather than the five-minute tolerance `ProcessLiveness` needs.

### ⚠️ It shares a machine with the other Windows port

[Im-Midi/codenotch-windows](https://github.com/Im-Midi/codenotch-windows) is a
separate, more complete implementation of the same app, and it owns
`%APPDATA%\codenotch\`. Its config carries `port`, `lang`, `bar_*` and
`notch_y`; this one deserializes into `{edge, along}`, which `serde(default)`
accepts from *any* JSON object without complaining — so sharing the directory
would have meant reading their file, dropping every field, and writing it back
on the first drag. This app uses **`%APPDATA%\codenotch-win\`** for that reason.
Keep them apart.

### Checking it against the frame

```sh
CODENOTCH_DEMO=1 pnpm tauri dev
```

Shows the three providers from `docs/design/frame-124-hover-tooltip.png` at the
levels it draws them — Claude 73%, OpenAI 21%, Perplexity 52% — so the render can
be compared against the frame rather than against whatever this machine's own
usage happens to be today. Ported from `Sources/Model/Fixtures.swift`.

### Fidelity

`src/layout.ts` is a port of `NotchLayout.swift` and `SideNotchShape.swift`, and
keeps every measurement **in design-frame pixels** rather than converting them,
so it can be diffed against the Swift line for line and checked against the
frame directly. The frame was verified to be 1:1 with those numbers: its notch
bar measures 187px against the declared 186.

The fold is a numerically integrated spring matching
`NotchMotion.unfold` — `spring(response: 0.42, dampingFraction: 0.78)` — rather
than a CSS bezier, because the shape has to be re-generated per frame anyway and
a cubic cannot be made to settle the way the rest of the surface does.

**The one thing that is not 1:1 is the typeface.** The frame is set in SF Pro;
this renders in Segoe UI Variable, which is wider. Every size is correct — the
title's cap height is 26 frame pixels either way — but the letterforms are not.
Closing that means bundling a face (Inter is the usual metric-compatible
substitute); shipping SF Pro itself is not licensed for Windows.

## Three things that cost time here

**Tauri's `set_ignore_cursor_events` silently drops extended window styles.**
It rewrites the whole ex-style word from a value captured earlier, so
`WS_EX_NOACTIVATE` and `WS_EX_TOOLWINDOW` vanish on every toggle — measured, the
window read back `0xC0138` instead of `0x80C01B8`. The notch then steals focus
on click and returns to Alt-Tab, with nothing in any log to say why.
`win::harden` must be re-applied after *every* call. See `src-tauri/src/win.rs`.

**The CSS mirror of `Design.px()` needs a unit on the frame number.**
`calc(210 * 0.3760684)` is a *number*, not a length, so `width` was invalid,
the declaration was dropped, and the notch silently fell back to content-sized —
93×47 instead of 79×10, with no error anywhere. It has to be
`calc(210px * var(--dpx))`. Every token in `src/style.css` is quoted in
design-frame pixels so it can be checked against
`docs/design/frame-124-hover-tooltip.png` in the macOS repo directly.

**The interactive mask is measured a frame after the state flips**, while the
fold is still animating — so a tight mask is briefly smaller than the chrome it
covers, the pointer falls outside its own target mid-expand, and the notch folds
back under it. Fixed twice over: the hot-zone pad applies in both states, and
`transitionend` re-reports the settled box.

## What Windows makes easier

Claude Code stores its OAuth token as **plain JSON** at
`%USERPROFILE%\.claude\.credentials.json`, not in a keychain. That deletes the
single most intricate subsystem in the macOS app — the ACL, the "Always Allow"
grant, the five-case `OSStatus` taxonomy, and the requirement to sign every
build with a stable Developer ID so the grant survives a rebuild.
`ClaudeCredentials.swift` + `ClaudeKeychain` (≈180 lines of hard-won comments)
become a file read.

Antigravity is the exception: it stores through Go's `keyring`, which on Windows
is Credential Manager, so that one still needs a `CredReadW`.

## Path map

| Provider | Windows | verified |
|---|---|---|
| Claude | `%USERPROFILE%\.claude\.credentials.json` | ✅ |
| Claude sessions | `%USERPROFILE%\.claude\sessions\<pid>.json` | ✅ `cwd` names the project on a finish |
| Codex | `%USERPROFILE%\.codex\auth.json` | ✅ |
| Antigravity | `%APPDATA%\Antigravity\User\globalStorage\state.vscdb` | ✅ |
| Cursor | `%APPDATA%\Cursor\User\globalStorage\state.vscdb` | inferred from VS Code |
| Grok | `%USERPROFILE%\.grok\auth.json` | unverified |
| OpenCode | `~/.local/share/opencode/auth.json` or `%APPDATA%\opencode` | unverified |

### Focus timer
Hover a task row and choose **Focus**. One task stays in view; other tasks are tucked away. Pause/resume, Done and End live in its small focus card. The collapsed notch grows to show elapsed time and a slim 25-minute progress rail. At 25 minutes it turns amber as a quiet break cue; it keeps counting until paused or ended. This is elapsed wall-clock time, including sleep/closed-app time while running, not activity tracking. The session persists on this PC; TickTick tasks retain their existing sync. No additional service is used.

Focus controls now use [Hugeicons](https://hugeicons.com/docs) SVGs with tooltips and accessible labels. The collapsed indicator is a taller, text-free fill bar; open the panel for exact elapsed time.
