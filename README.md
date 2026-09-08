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

## TickTick task notch

A second notch starts on the **left** screen edge as a small resting pill.
Hover to reveal the progress ring and task panel; move away to fold it with the
same spring motion as the usage notch. Pin keeps it open; the close button or
ring collapses it explicitly. Reduced-motion preferences are respected.
Short lists use a shorter panel instead of an empty full-height card.

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

Then turn on **Settings → Start with Windows** and you never launch it by hand
again. It writes one `Run` key under `HKCU`, pointing at wherever the exe
actually is — so if you move the exe, toggle it off and on.

**While changing it:**

```sh
pnpm tauri dev          # live reload; needs the vite server on :1420
CODENOTCH_DEMO=1 pnpm tauri dev   # the design frame's fixtures instead of live data
```

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
What that cannot distinguish is a session **blocked on you** from one that has
simply finished — both stop writing. That needs Claude Code's hooks, which is
why the other port ships a separate hook executable, and it is not built here.

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
| Claude sessions | `%USERPROFILE%\.claude\sessions\<pid>.json` | ✅ same shape as macOS |
| Codex | `%USERPROFILE%\.codex\auth.json` | ✅ |
| Antigravity | `%APPDATA%\Antigravity\User\globalStorage\state.vscdb` | ✅ |
| Cursor | `%APPDATA%\Cursor\User\globalStorage\state.vscdb` | inferred from VS Code |
| Grok | `%USERPROFILE%\.grok\auth.json` | unverified |
| OpenCode | `~/.local/share/opencode/auth.json` or `%APPDATA%\opencode` | unverified |

### Focus timer
Hover a task row and choose **Focus**. One task stays in view; other tasks are tucked away. Pause/resume, Done and End live in its small focus card. The collapsed notch grows to show elapsed time and a slim 25-minute progress rail. At 25 minutes it turns amber as a quiet break cue; it keeps counting until paused or ended. This is elapsed wall-clock time, including sleep/closed-app time while running, not activity tracking. The session persists on this PC; TickTick tasks retain their existing sync. No additional service is used.

Focus controls now use [Hugeicons](https://hugeicons.com/docs) SVGs with tooltips and accessible labels. The collapsed indicator is a taller, text-free fill bar; open the panel for exact elapsed time.
