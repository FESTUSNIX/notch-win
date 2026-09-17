# Codenotch for Windows — working notes

A Windows rewrite of [Codenotch](../codenotch), the usage notch that sits on a
screen edge and answers two questions at a glance: **how much of my AI allowance
is left**, and **is Claude still working**.

Read this before changing anything. Most of it is things that cost a debugging
session to find and that produce **no error when you get them wrong** — a silent
zero, a dash where a number should be, an invisible rectangle eating clicks.

---

## 1. What this is, and what it is not

**It is a rewrite, not a port.** The macOS app is SwiftUI + AppKit; none of that
exists here. What carries across is the *specification* — the design-frame
measurements, the endpoint contracts, the accumulated knowledge of each vendor's
quirks. The Swift is the reference implementation: read it, do not translate it
line by line.

Three repositories are involved. Keep them straight:

| | |
|---|---|
| `../codenotch` | the macOS original, in Swift. The **source of truth for design and provider semantics**. Its `docs/design/frame-124-hover-tooltip.png` is the design frame every measurement here derives from. |
| `../notchwin/codenotch-windows` | a **different, more complete** Windows port (Im-Midi). Pure Rust + Tauri, single-file UI. Worth reading; several ideas here are taken from it and credited in comments. |
| this repo | ours. Tauri 2 + Rust + vanilla TypeScript, two pages. |

⚠️ **The other port is installed on this machine and owns `%APPDATA%\codenotch\`.**
This app uses **`%APPDATA%\codenotch-win\`**. See §5.5 — sharing it destroys
their config.

---

## 2. Stack and layout

Tauri 2 (Rust) + vanilla TypeScript + Vite. No framework: the UI is one notch
and one small settings panel, and a framework would be more machinery than
either needs.

```
index.html            the notch page
settings.html         the settings panel (a second Tauri window)
src/
  layout.ts           ⭐ every measurement, in design-frame pixels. Port of
                        NotchLayout.swift + SideNotchShape.swift.
  main.ts             the notch: rendering, springs, hover, drag gestures
  glyphs.ts           GENERATED from the macOS app's GlyphOutline.swift (§4.3)
  style.css           the notch's appearance
  settings.ts/.css    the panel
src-tauri/src/
  lib.rs              app setup, tray, commands, the poll loop
  win.rs              ⭐ Win32: extended styles, work area, placement
  hover.rs            ⭐ cursor polling, click-through, hover events
  drag.rs             dragging along the edge
  sessions.rs         ⭐ "is Claude working" — see §5.9
  config.rs           persisted settings + remembered readings
  model.rs            the reading model (Snapshot / LimitWindow / Status)
  providers/
    claude.rs         api.anthropic.com/api/oauth/usage
    codex.rs          chatgpt.com/backend-api/wham/usage
  fixtures.rs         the design frame's three providers, for CODENOTCH_DEMO=1
```

Starred files are where the non-obvious knowledge lives.

---

## 3. Building and running

```sh
pnpm install
pnpm tauri build            # → src-tauri/target/release/codenotch.exe (+ NSIS installer)
pnpm tauri dev              # live reload; needs the vite server on :1420
CODENOTCH_DEMO=1 pnpm tauri dev   # the design frame's fixtures instead of live data
```

⚠️ **Quit the notch from its tray icon before building.** A running instance
holds its own exe open and cargo reports it as
`failed to remove file … Access is denied (os error 5)`, which reads like a
permissions problem rather than "the app is open". This will catch you.

⚠️ **`pnpm tauri dev` restarts the app on every Rust edit, and every start polls
Claude immediately.** A dozen edits in a row will earn a 429 with
`Retry-After: 0`. The back-off is persisted (§5.6) so it does not compound, but
the ring will read stale for a while and it is your own doing.

⚠️ **Verify in a release build before believing anything about window
behaviour.** §5.2 is a bug that existed *only* in release, after hours of
debug-build verification.

Diagnostics: debug builds keep a console and print `[notch] …` lines — provider
readings, activity state, back-off countdown. Release builds have no console by
design (§5.4), so that is the only log.

---

## 4. Design fidelity

### 4.1 Everything is quoted in design-frame pixels

`docs/design/frame-124-hover-tooltip.png` in the macOS repo is 2000×2000 and is
**1:1 with the numbers in `layout.ts`** — verified by measuring it: the notch bar
is 187px wide against the 186 declared. So a measurement can be checked against
the image directly, and `layout.ts` diffs against `NotchLayout.swift` line for
line. Keep it that way: convert at the point of use, never in the constant.

### 4.2 Two scales, not one

`Design.scale` says the frame fixes ratios and one anchor picks the size. That
holds until you try it here:

- at the anchor that makes the card's body text readable on Windows (a 56pt
  ring) the notch comes out **89px deep** and reads as a slab bolted to the bezel
- at the anchor that makes the notch right, body text lands at **9.5px**

The notch is glanceable chrome you never focus on; the card is something you
stop and read. They get separate anchors — `NOTCH_RING = 46`, `CARD_RING = 56` —
and each stays internally in the frame's proportions. `px()` is the notch's
scale, `cpx()` the card's. **Nothing mixes them** except `windowFrame()`, which
sums two already-converted lengths.

### 4.3 Glyphs are generated, not drawn

`src/glyphs.ts` is produced from the macOS app's `GlyphOutline.swift` by
`tools/generate-glyphs.py` — traced point arrays → one SVG path each, normalised
to a 0..100 viewBox, filled even-odd so the counters inside the OpenAI knot stay
open. `opticalScale` is applied: boxes of equal size are not marks of equal
size, and the eye reads the mark.

```sh
python tools/generate-glyphs.py            # expects ../codenotch beside this repo
python tools/generate-glyphs.py <path>     # or point it at GlyphOutline.swift
```

The output is **committed**, so a checkout builds without the Swift repo
present. Regenerate rather than hand-edit — the file is 16 KB of coordinates and
carries a "do not hand-edit" header for that reason.

### 4.4 Motion is integrated, not eased

The fold is a numerically integrated spring matching
`spring(response: 0.42, dampingFraction: 0.78)`; the orb's is `0.36 / 0.7`. Not
CSS beziers — the shape is regenerated per frame anyway, and a cubic cannot be
made to settle the way the rest of the surface does.

⚠️ **Ring/activity animations use `steps()`, not smooth interpolation.** A 60fps
SVG transform in a transparent always-on-top window keeps the desktop compositor
recompositing the whole stack beneath it and *other applications visibly
stutter*. `steps(12)` drops repaints to ~10fps and still reads as turning.
(Found by the other port.)

---

## 5. The traps

Every one of these is silent.

### 5.1 `set_ignore_cursor_events` clobbers extended window styles

tao implements click-through by rewriting the **whole** ex-style word from a
value it captured earlier, so any bit set behind its back is dropped. Measured:
after one toggle the window read `0xC0138` — topmost and layered survived
(tao sets those itself), `WS_EX_NOACTIVATE` and `WS_EX_TOOLWINDOW` were gone.
The notch then steals focus on click and returns to Alt-Tab.

**`win::harden()` must be re-applied after every single call.** See `hover.rs`.

### 5.2 Click-through must be owned by the poll loop, not by startup

`hover.rs` tracks the previous state as **`Option<bool>` starting at `None`**, so
its first tick always applies. Starting at `false` matches the initial
not-hovering state, the first tick sees no change, and
`set_ignore_cursor_events` is never called — leaving whatever `setup()` managed.

In a **debug** build setup's call sticks and all is well. In a **release** build
it does not, and the app ships as a 410×373 invisible rectangle at the screen
edge that swallows every click. Measured: `0x8040198`, no `WS_EX_TRANSPARENT`,
no `WS_EX_LAYERED`, where the dev build had both.

Healthy value to check against: **`0x80C01B8`** — TRANSPARENT, LAYERED,
NOACTIVATE, TOOLWINDOW, TOPMOST.

### 5.3 CSS `calc()` needs a unit on the frame number

`Design.px()` returns points in Swift. Its CSS mirror must be
`calc(210px * var(--dpx))`. Written `calc(210 * var(--dpx))` both operands are
unitless, the result is a **number not a length**, the `width` declaration is
invalid and dropped, and the element silently falls back to content-sized —
93×47 instead of 79×10, with nothing in the console.

### 5.4 `main.rs` needs the subsystem attribute

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
```

Without it the binary links against the **console** subsystem and every launch
opens a CMD window behind the app. Conditional on purpose: debug builds keep
their console, which is the only log this app has while being worked on. Verify
with the PE header — subsystem `2` is GUI, `3` is console.

### 5.5 ⚠️ Do not use `%APPDATA%\codenotch\`

That belongs to the other Windows port, whose config carries `port`, `lang`,
`bar_*`, `notch_y`. This app deserializes into `{edge, along, …}`, and
`#[serde(default)]` accepts *any* JSON object without complaint — so sharing the
directory means reading their file, dropping every field it does not know, and
writing it back. Their install breaks on your first drag. **This app uses
`codenotch-win`.** Both can be installed at once.

### 5.6 The rate-limit deadline must be persisted

Claude's endpoint answers 429 with `Retry-After: 0`, so the wait is the client's
to invent. A wait that lives only in memory is spent the moment the app
restarts — and relaunching during a penalty costs another attempt and *deepens*
it. `config.claude_backoff_until_ms` is `UsageArchive.saveBackoffUntil`.

⚠️ **Backing off must still emit the cell.** Skipping the provider entirely makes
its ring vanish and reappear every couple of minutes, which reads as the app
being broken rather than the endpoint being unavailable. See
`providers::claude::pending()`.

### 5.7 A failed fetch must never blank a reading

A transient 429 or dropped connection is not new information about your usage.
The last figure is still the best answer anyone has, and replacing it with a dash
throws away a true reading to report a network event.

`Snapshot::or_stale` carries the previous windows forward with `stale: true`,
keeping **this** round's status so the card can say why. The ring dims to 45%,
the card says `Rate limited · read 4 min ago`.

⚠️ And it must be **persisted**, not just held in memory — otherwise a launch
whose first fetch fails has nothing to carry and shows a dash, which is exactly
what a rate-limited restart looks like. `%APPDATA%\codenotch-win\readings.json`.

### 5.8 Emitting is not enough — the page must be able to ask

The web layer registers its listeners during boot, which lands *after* the first
poll answers. A single `emit` is missed and the notch sits on its placeholder
until the next tick a minute later. Every stream of state therefore has both an
event **and** a getter: `get_readings`, `get_activity`.

### 5.9 ⚠️ Claude Code's session files are different on Windows

`ClaudeSessionMonitor` reads a `status` / `tempo` pair from
`~/.claude/sessions/<pid>.json`. **On Windows that file has no status field at
all.** Its shape is:

```
pid, sessionId, cwd, startedAt, procStart, version, peerProtocol, peerFeatures,
kind, entrypoint, pidDomain, name, nameSource, nameSince,
messagingSocketPath, updatedAt, bridgeSessionId
```

It registers that a session *exists*, not what it is doing. Read the macOS way
it yields `idle` for ever, silently.

So activity comes from the **transcript**: Claude Code appends to
`~/.claude/projects/<project>/<sessionId>.jsonl` as it streams, and a write in
the last 8 seconds means it is working. Nothing of the user's has to be
configured.

**What that cannot see is `waiting`.** A session blocked on a prompt stops
writing exactly as a finished one does. Telling them apart needs Claude Code's
hooks — which is why the other port ships a separate hook executable — and it is
not built here.

One gift: `procStart` is the process's own creation FILETIME, so the pid-reuse
check is **exact** against `GetProcessTimes`, rather than the five-minute
tolerance `ProcessLiveness.swift` needs.

### 5.10 Hit tests and the tooltip aim are in *shape* coordinates

The window carries orb overhang at both ends, so the shape does not start where
the window does. Both `cellAt()` and the tooltip's `--aim` must be measured from
`shapeSVG.getBoundingClientRect()`.

Getting this wrong biases every ring's hit zone by one overhang (~31px). It
still resolves the right ring, because the zone is ±117 design px wide — so it
presents as "the hitbox is too high up", not as a hitbox that misses.

### 5.11 The window is always its expanded size

Folding is drawn *inside* it, so the OS window never resizes mid-animation —
the same bargain the AppKit panel makes. What changes the window is the number of
providers and the room the card needs; the web layer knows both, so it calls
`set_notch_size`. Mouse events are masked per-rect instead
(`set_interactive_rects`).

### 5.12 `clampCorners` order matters

Claim the corner first out of half the depth, then let the flare take what is
left. Clamping the corner by `depth - curl` — the obvious reading — collapses it
to zero as soon as the flare is as wide as the body, which is exactly what
happens when the notch folds to its pill: a 10pt-wide shape with square corners.

### 5.13 reqwest's TLS feature names

`rustls-tls` does not exist in reqwest 0.13 — it is `rustls`, and the default
features pull `aws-lc-sys`, which needs NASM and CMake on Windows. This uses
`default-features = false` + `native-tls`, which is schannel: already present,
nothing to install.

---

## 6. Provider contracts

### Claude

```
GET https://api.anthropic.com/api/oauth/usage
Authorization: Bearer <token>
anthropic-beta: oauth-2025-04-20
```

Token from `%USERPROFILE%\.claude\.credentials.json` → `claudeAiOauth.accessToken`
(`expiresAt` is unix **ms**). **Plain JSON, no keychain** — this is the subsystem
Windows makes *simpler*: the whole of `ClaudeCredentials.swift` + `ClaudeKeychain`
(ACL, "Always Allow", the OSStatus taxonomy, the Developer-ID requirement)
collapses into a file read.

Response: `limits[]` of `{kind, percent, resets_at}`, plus `five_hour` and
`seven_day` of `{utilization, resets_at}`. ⚠️ **Merge the named windows in, do not
use them only as a fallback** — an entry is present in `limits` only while its
reset has not passed, so a window that just rolled over drops out of the array
while `five_hour` still carries it. Relying on the array alone loses the session
exactly when it resets.

### Codex

```
GET https://chatgpt.com/backend-api/wham/usage
Authorization: Bearer <access_token>
ChatGPT-Account-Id: <account_id>
```

Both from `~/.codex/auth.json` → `tokens.*`. Read only, never refreshed.
Response: `rate_limit.{primary_window,secondary_window}` of
`{used_percent, limit_window_seconds, reset_at | reset_after_seconds}`.

⚠️ Labels are derived from window **length**, not from the field name — the
primary window is not always five hours (a free plan has shown thirty days).

Not built: the fallback to the `rate_limits` snapshot in the newest rollout log,
which is what the other port shows when Codex is signed out.

### Paths

| Provider | Windows | verified |
|---|---|---|
| Claude | `%USERPROFILE%\.claude\.credentials.json` | ✅ |
| Claude sessions | `%USERPROFILE%\.claude\sessions\<pid>.json` | ✅ shape differs from macOS, §5.9 |
| Claude transcripts | `%USERPROFILE%\.claude\projects\<project>\<sessionId>.jsonl` | ✅ |
| Codex | `%USERPROFILE%\.codex\auth.json` | ✅ same as macOS |
| Antigravity | `%APPDATA%\Antigravity\User\globalStorage\state.vscdb` | ✅ present |
| Cursor | `%APPDATA%\Cursor\User\globalStorage\state.vscdb` | inferred from VS Code's layout |
| Grok | `%USERPROFILE%\.grok\auth.json` | unverified |
| OpenCode | `~/.local/share/opencode/auth.json` or `%APPDATA%\opencode` | unverified |

⚠️ Cursor's store must be opened read-only but **not** `immutable` — Cursor runs
it in WAL mode, and `immutable=1` ignores the write-ahead log and serves a token
the editor has already rotated. (From the macOS app; not yet implemented here.)

**A provider that is not installed gets no cell at all** — not a cell reading
"not signed in". The notch is glanceable and a row of empty rings for tools this
machine never had is noise in the one place with no room for any.

---

## 7. Where it stands

Working: Claude and Codex live and auto-detected · the notch shape with its
flares on all four edges · rings, traced glyphs, percent labels · hover card with
tail aimed at the hovered cell · settings orb morphing to a gear · drag to
reposition, persisted · settings panel (edge, position, autostart, provider
status, quit) · tray (refresh, settings, reset, quit) · spinning activity arc ·
stale readings kept, dimmed and explained · persisted back-off · autostart.

Not built, roughly in the order worth doing:

1. **Multi-monitor.** The notch is locked to whichever monitor it starts on;
   the drag clamps to one work area and cannot cross. Needs monitor identity
   stored alongside the ratio.
2. **Click a ring** to open that provider's dashboard.
3. **The `waiting` state** (amber pulse) — needs Claude Code hooks, §5.9.
4. **Codex's rollout-log fallback** for when it is signed out.
5. **Cursor and Antigravity** providers.
6. **Code signing.** The exe is unsigned; SmartScreen warns on first run.
7. **Auto-update.** No Sparkle counterpart; Tauri's updater plugin is the route,
   and it needs its own signing key (⚠️ never commit the private one).
8. **Claude profile support** — `~/.claude-<slug>` directories, each its own ring.

---

## 8. Conventions

- **Colours come from the frame**, via the tokens at the top of `style.css`
  (`#000` notch, `#303030` ring track, `#2D2D2D` bar track, `#00FF88` /
  `#F2FF00` / `#FF3F00` bands). Sampled from the image, not invented.
- **Never invent a measurement.** Add it to `FRAME` in `layout.ts` in
  design-frame pixels with a note on where it came from.
- **A failure is a visible status, never a made-up number.** No zeros standing
  in for "unknown"; a dash and a reason, or a dimmed stale figure.
- Comments explain *why*, especially where the reason is a trap above. The code
  says what it does; the comment says what it will cost you to change it.

## 9. TickTick task sibling (2026-09-08)

The `tasks` window is a separate four-edge notch; `task-editor` is its focusable
editor. Both share the app/tray with `notch` and `settings`. Vite now builds four
pages. Hover rectangles are keyed by window label, and dragging/sizing derive
their target from Tauri's injected calling window. Never put those back into a
single shared rectangle vector or address `notch` from task commands.

- `tasks.ts`, `tasks.css`: the task notch, its optimistic state, pinning and
  mask reporting.
- `task-editor.ts`: token setup, quick add, rename and task placement.
- `task-day.ts`: the **Day Card** — the panel's list. Separate from
  `task-list.ts` on purpose: that one draws the editor window, which is a
  settings page (grouped by project, dense, rename pencil). Two surfaces, two
  densities; do not merge them back into one renderer with a mode flag.
- `task-model.ts`, `task-list.ts`: nested display and leaf-based progress.
- `task-client.ts`, `task-demo.json`: native IPC plus explicit browser fixtures.
- `src-tauri/src/tasks.rs`: official TickTick Open API, serialized polling and
  mutations, current-run snapshot and error state.
- `credentials.rs`: Windows Credential Manager; never return the token to a
  WebView or include it in error messages/logs. Demo mode cannot alter it.
- `task_window.rs`: editor creation, task placement and demo-only diagnostics.

WebView2 creation must run in an async command. Tray handlers spawn it onto
Tauri's async runtime; building a WebView directly in a synchronous command or
event handler deadlocks on Windows (verified by the native release test).

TickTick full-task completion status is **2**; checklist completion is **1**.
Fetch fresh checklist data before changing one item. A successful write followed
by a failed refresh must be reported as **saved, refresh failed**, not as a failed
create which the user might retry. Do not automatically retry writes. Guard
recurring completion against a changed occurrence. Completion queries cap at
200; do not display that partial history as an exact daily count.

Tokens are in `codenotch-win/ticktick`; position/visibility use `task_edge`,
`task_along`, `task_visible` in this app's existing config. Task content currently
stays in memory and refetches after restart. Live sync requires a user-supplied
token entered in the native editor. Do not ask for it in chat.

`pnpm test`, `pnpm test:ui`, and `cargo test --lib` cover task behavior.
`node tools/smoke-release.mjs` checks the **release** WebView2 windows using
sample data and a temporary localhost debug endpoint. It does not exercise live
TickTick writes or physical pointer dragging. See README for setup and limits.
Use `pnpm tauri build` for production, or enable `--features tauri/custom-protocol`
when building directly with Cargo. A plain `cargo build --release` still targets
the development server and produces blank/error WebViews when it is absent.

### Task interactions (follow-up)

- The task rail now folds to the original pill and reveals on hover. Both notches
  import the same integrated Spring from src/motion.ts (0.42 / 0.78).
- task-surface.ts owns animated geometry, per-frame masks, four-edge orientation,
  content-based panel height, pinning and the inline-entry focus lifecycle.
- Only account setup and optional task management use task-editor. create_task
  accepts either task window; token commands remain editor-only.
- NOACTIVATE is the default, with an explicit exception while inline entry is
  active. task_window::set_task_input owns that temporary state; win::harden
  must preserve it on every hover toggle. Release/save/collapse/blur restore the
  default. Restore the former foreground window only if the task notch still
  owns focus; never override an outside click.
- Browser tests cover fold/reopen, retained drafts, live-field capture, rename in
  place, all four edges, compact lists, day-clear and reduced motion. Native
  smoke checks the temporary style change and restoration without writing to
  TickTick.

### The Day Card (2026-09-08)

One day as one list: no project headings, overdue badged in place instead of
behind a tab, finished work sunk into one line, 52px rows, and a composer that is
always a field. Nine chrome zones became three. Every item below is a trap that
produces **no error**.

1. **Progress is scored on `today`, never on `day`.** The `day` view exists so
   the list can carry overdue work; the ring and the rail deliberately do not
   count it. Score `day` and a backlog of twelve late tasks parks the ring at
   2/15 for a week, so finishing something reads as no progress — which is the
   opposite of what the whole surface is for.
2. **Optimistic state is keyed on `taskId`, not `taskKey`.** `taskKey` folds
   status in, so it changes at the exact moment the optimistic entry has to
   survive. `taskId` is `projectId:id` and is stable across completion.
3. **Optimistic entries are cleared by the arriving snapshot agreeing, never by
   the mutation resolving.** `complete_task` refreshes and publishes *before* it
   returns, so clearing on resolve blinks the row back to its old state in the
   window between the two.
4. **Completion must not set `busy`.** `busy` disables the list, and the reward
   sequence runs for ~860 ms after the click. `mutate()` exists for writes that
   show their result immediately; `action()` is only for commands with nothing to
   show until they return (refresh, placement, opening the editor).
5. **`pathLength` does not normalise the dash on nodes built with
   `createElementNS`.** It works on `#ring-progress`, which is parsed from markup.
   On the day-clear ring it did not: `stroke-dasharray: 1` resolved to one
   *pixel* and the ring drew as a dotted line that reads as a dim grey circle,
   with no error and correct-looking computed styles. The dash lengths in
   `tasks.css` are the geometry's own — 2πr = 207.3 for the arc, 38.6 for the
   mark, 17.1 for the check tick. Change a shape and change them with it; the
   browser test polls `strokeDashoffset` to `0px` to catch the drift.
6. **A `.slot` wraps exactly one `.slot-inner`.** `grid-template-rows: 1fr → 0fr`
   collapses one track; a row and its children as two children of the slot leaves
   the second track open and only half the row collapses.
7. **`.gone` must be added a frame after the row exists**, or the transition has
   nothing to travel from and the row vanishes instantly. `renderDay` does that
   with `requestAnimationFrame`, so it works whether the node is fresh or not.
8. **The composer lives outside `#task-list`, pinned above the footer.** Inside
   the scroller it scrolled out of reach on a busy day, and inside
   `#task-list-content` a redraw destroyed what was half-typed.
9. **The rename field commits on blur only when it is still connected.** Any
   redraw detaches it, which also fires `blur` — committing there files a
   half-typed rename because a snapshot happened to land while someone was
   typing. `editCaret` carries the caret across those redraws.
10. **Sub-tasks open by default; a checklist does not.** A parent with children
    cannot be completed here, so collapsed it is an inert row with a disabled
    circle. A task with a checklist is completable on its own, so its steps are
    detail. Two sets — `expanded` for rows that default closed, `collapsed` for
    rows that default open.
11. **One click is the floor for the composer**, and that is `WS_EX_NOACTIVATE`,
    not a design choice: a keystroke cannot reach a window that is not focused.
    What the live field buys is that the click lands *in* the field rather than
    on a button that then produces one, and that Enter keeps the caret so the
    second, third and fourth task cost nothing.
12. **List colour falls back to a hash of the project id.** TickTick gives most
    lists a colour and some none, and an index-based fallback re-colours every
    list the day one is added.
13. The overdue chip caps at `99+d`. It sits beside the title on a 373px panel,
    and a task forgotten for two years must not be the widest thing in the row.

### Focus timer
`focus-timer.ts` persists a local timestamp-based session, updated only on start/pause/resume/end. `tasks.ts` paints the two clock labels once per second without redrawing task inputs. `task-surface.ts` uses FRAME.focusPillDepth/Length for the collapsed timer on all four edges. Focus is local and never writes task data by itself; Done uses the existing completion command. Keep the timer visible when the panel folds. The 25-minute mark is a visual cue, not an automatic completion or reset.

Focus visual refinement: task-icons.ts renders the free Hugeicons package as local SVG; controls retain aria-label/title when text is removed. The focused task sits directly in the panel, with no nested card. The collapsed focus pill contains only a ~7 x 96 px fill bar; exact elapsed time is shown in the open panel and its accessible label. Bar orientation follows the screen edge. Paused fill dims; the 25-minute cue remains amber.

## 10. The island (2026-09-08)

The task notch became a **Dynamic-Island-style surface**: one rounded rectangle
welded to a screen edge that shows the most live thing going on and grows into a
panel of screens — **Today · Media · Calendar**. The pill-plus-detached-card
design is gone, and so is `task-surface.ts`.

- `island-surface.ts`: the shape. One spring drives width, height and corner
  radius; the two content layers cross-fade inside `overflow: hidden`.
- `island-activity.ts`: what the collapsed pill says, and the claim contest.
- `tasks.ts`: the shell — header, tab rail, which screen is showing.
- `screen-today.ts` / `screen-media.ts` / `screen-calendar.ts`: the screens.
  Each owns its body, supplies a subtitle, and returns an `Activity` claim.
- `src-tauri/src/media.rs`: Windows' GlobalSystemMediaTransportControls.
- `src-tauri/src/calendar.rs`: Google Calendar, read-only, OAuth PKCE loopback.
- `src-tauri/src/shortcuts.rs`: the two global keys.

The window keeps the label **`tasks`** and the config keys keep their
`task_*` names. Renaming them is pure churn with a config migration attached and
no user-visible benefit; the code calls the thing an island regardless.

### The collapsed pill is a contest, not three slots

It is ~200 x 35px: one glyph and one line. Every screen returns a claim or null
and the highest wins, so the pill can never show a placeholder while something
real is happening one screen over. The order, and the reasons:

| claim | priority | why there |
|---|---|---|
| meeting in ≤ 5 min | 50 | the only claim with a deadline attached |
| focus session running | 45 | you started it deliberately; music is ambient |
| something playing | 40 | it changes under you |
| meeting in ≤ 30 min | 25 | information, not an event |
| player paused | 15 | keeps the controls reachable, claims almost nothing |
| the day's tally | 5 | the resting state |

⚠️ **A meeting only claims the pill inside 30 minutes.** A four o'clock meeting
is not news at nine, and without the cutoff it would sit on the day's progress
all day.

⚠️ **Opening the island does NOT jump to the claim's screen.** Hover opens it
before any click can land, so that navigation would fire on a pointer merely
crossing the pill — and with music playing all afternoon the claim is Media all
afternoon, so the task list would never be what opening it showed. The live
screen raises a **dot on its tab** instead; the tabs do the moving.

### Traps, all of which produce no error

1. **`windows` 0.62 dropped `IAsyncOperation::get()`.** The crate offers only
   `IntoFuture` now. `media.rs` spins on `Status()` / `GetResults()` with a
   two-second deadline rather than standing a Tokio runtime up inside a COM
   apartment for a sub-millisecond local call.
2. **`windows-future` must track the version `windows` itself depends on**
   (0.62.2 → 0.3.2). `windows` re-exports `windows_core` as `windows::core` but
   *not* this crate, so it is a direct dependency here; a different minor version
   makes `IAsyncOperation` a different type from the one the APIs return.
3. **Every WinRT thread needs `CoInitializeEx` first.** Without it the first
   activation fails with `CO_E_NOTINITIALIZED` and every reading is empty.
4. **SMTC is polled, not subscribed.** Handlers have to be attached per session
   and torn down when the current session changes, and the position still has to
   be sampled. One second of polling is two local COM calls.
5. **Album art is only re-read when the track changes.** It is a few hundred KB
   over IPC; polling it would decode a JPEG a second.
6. **Google requires `client_secret` even for a Desktop client with PKCE**, and
   returns a **refresh token only with `access_type=offline` + `prompt=consent`**.
   Without both, the connection silently lasts one hour.
7. **`open_external` is scheme-checked.** The URL comes from an event body that
   anyone who can put a meeting in your calendar can write, and `cmd /c start`
   would take `file:` or a UNC path.
8. **Neither island layer is anchored with a percentage.** Two separate bugs
   came from that: `paint()` writing `transform: translateY(...)` replaced the
   CSS centring transform and the panel landed half its own width off to the
   side; and a layer laid out at `left: 50%` counts as layout overflow of the
   island whatever the transform does, so `scrollWidth` reported an overflow
   with nothing visibly out of place. Both layers are placed in pixels every
   frame.
9. **`measure()` must not use `scrollHeight` on the scroller.** A `flex: 1`
   scroller whose content is shorter than its box reports the box, so the
   measurement feeds the panel's height back into itself and a one-task day
   stays as tall as a full one. Sum the scroller's children instead.
10. **The island's hairline is an inset box-shadow, not a border.** A border sits
    outside the content box, so a layer sized to the island's width is two pixels
    wider than the box can hold and the island reports itself as overflowing
    while looking perfectly fine.
11. **A vertical island's pill hides its text.** It is ~35px across, and
    `align-items: center` in a column lets the copy size to its own max-content
    and hang out of the shape. The glyph carries the activity there.
12. **The shortcut handler must check `ShortcutState::Pressed`.** Otherwise press
    and release both run the action and every toggle is a no-op.
13. **`show()` drops the hardened ex-styles**, the same tao trap `win::harden`
    exists for. The hide shortcut re-hardens on the way back.
14. **Browser tests must poll anything measured mid-morph.** `expect()` on an
    `evaluate` result does not retry, and three tests failed purely on the spring
    not having settled.

### Preview and tests

`?quiet` puts the browser preview in its **resting** state — nothing playing and
nothing imminent in the calendar. Both outrank the day on the pill, so any test
that wants to read the day's own tally needs it. `?single`, `?empty` unchanged.
`pnpm test`, `pnpm test:ui` and `cargo test --lib` all pass; the live SMTC probe
is `cargo test --lib media -- --ignored --nocapture`, which prints whatever is
playing on this machine.

### Shape and screens (2026-09-09)

The island is **wider than it is tall** (699 x up to 388 CSS px) and its default
screen is **Home**: three columns, one per other screen. Tabs are Home · Today ·
Media · Calendar.

1. **The shape is `notchPath`, applied as an SVG `clipPath`.** The island flares
   back *out* to the bezel at each end exactly as the usage notch does, which no
   `border-radius` can describe. Reusing the existing generator rather than
   re-deriving it: the arc sweep flags and the corner/flare clamping are the
   parts that are easy to get subtly wrong, and they are already right there.
   ⚠️ It is generated in CSS pixels, so `cornerRadius` has to be passed in —
   `FRAME.cornerRadius` is a frame measurement and means nothing in that space.
2. **Lengths in FRAME are the BODY, not the element.** The flare is added on
   top, so the island always measures `body + 2 * curl` along its edge, and the
   content layers are sized to the body. Laying content into the flare puts it
   under the curve.
3. **No drop shadow.** A CSS filter is applied *before* clipping, so it would be
   drawn around the rectangle and then cut away by the clip. The sibling notch
   has none either; the shape carries the separation.
4. **`measure()` has three modes, and a grid needs its own.** `spans` takes the
   tallest child plus padding — a grid's natural height is its tallest column,
   and summing its children asks for three stacked columns' worth of panel and
   clips the real one. `scrolls` sums children (never `scrollHeight`, see §10).
   Everything else is `offsetHeight`.
5. **Home owns no data.** Every column reads another screen's state and calls
   its methods, so there is one optimistic task layer, one media session and one
   agenda. Its column headings are the way into the full screens.
6. **`upNext` keeps a `settling` task.** It has already been marked done by the
   optimistic layer, so dropping it would make the row vanish from Home the
   instant it was ticked — no tick drawn, nothing to say the click landed. The
   day screen holds finished rows for the same 520 ms for the same reason.
7. **The per-second tick updates in place; it never re-renders.** Rebuilding a
   screen every second replaces every node under the pointer: hover states
   reset, a click can land on an element already thrown away, and Playwright
   never finds the page stable enough to act on.
8. **A wheel changes screen unless the thing under the pointer can scroll.**
   Not "over the tab rail only", which was the first version: the island is a
   different height on each screen, so switching moves the rail out from under
   the pointer — measured at 71px between Home and Today — and the next flick
   lands on whatever slid into its place. There is a 260 ms cooldown so one
   flick cannot run through every tab; a test that wheels twice must wait it out.
9. **`cmd /C start` must never be used to open a URL.** `cmd` treats `&` as a
   command separator and an OAuth URL is nothing but `&`-separated parameters —
   the browser got everything up to the first one and Google answered
   "Required parameter is missing: response_type". `ShellExecuteW` hands the
   string to the shell API with no command line to re-parse, and its return
   value is checked: at or below 32 is an error, and a browser that never opened
   otherwise looks exactly like waiting three minutes for a redirect.
10. **Demo mode blocks the write, not the field.** Focusing the composer is what
    lifts `WS_EX_NOACTIVATE`, so disabling it under fixtures left the native
    smoke test with no way to exercise the one behaviour it exists to check.
11. **Home renders the same task titles as the day screen**, so browser tests
    must scope day assertions to `[data-screen="today"]` or Playwright refuses
    in strict mode.

### The bar (2026-09-09)

Home was three vertical columns in a 758 x 388 panel and read as clutter. It is
now **one row** in a 969 x ~158 bar: art beside the words beside the transport,
a month and a date strip, a ring and two tasks — three sections separated by
hairlines, no section headings, no cards around events.

12. **Chrome is one strip, not two.** The tabs moved from a rail at the bottom
    into the top-left of the header, with the window controls at the top-right.
    That is ~50px of height back and puts where-you-are and where-you-can-go on
    the same line. The shell no longer has a title or subtitle at all — each
    screen says what it needs (Today prints its own date and count).
13. **`overdueDays` returns 0 for a completed task**, so a task that was three
    months late drops to unranked the instant it is ticked and falls straight
    out of a top-N list. On Home that looked exactly like the settle window not
    working, and no filter can fix it — `upNext` ranks a settling task as if it
    were still open so it holds its place until the timer moves it.
14. **Finishing overdue work DOES move the day's tally** (2/6 -> 3/7), and that
    is not a contradiction of §"the pill" above. Pending overdue work stays out
    of the denominator so a backlog cannot hold the day at 2/15 all week; work
    completed today is work done today and joins as done. The ratio can only
    improve by clearing a backlog, never worsen.
15. **The island is ~970px wide.** A browser test that sets a narrow viewport
    for the editor page must reset it before loading the island, or the tabs are
    off screen and every click times out.
16. **`.check()` is the wrong Playwright verb for a row that completes.** It
    waits for a checkbox it can still toggle, and a completed row is disabled;
    `.click()` is what the interaction actually is.

17. **The media waveform is synthetic, and the code says so.** Windows' transport
    controls hand over metadata, never samples, and nothing here captures the
    loopback stream — so there is no audio to analyse. What makes it honest
    rather than decorative is that `waveform()` is *deterministic*: seeded from
    title and artist, so one track always draws the same shape and a different
    track visibly draws a different one. Random bars redrawn each render would
    be a lie that also flickers, and a browser test asserts the shape is stable
    across a screen change.
18. **Only the four bars at the playhead animate.** Putting the whole played
    region in motion says "this audio is playing again", which is not what it
    means.
19. **The waveform seeks**, via `TryChangePlaybackPositionAsync`, and is only
    offered when the session reports `IsPlaybackPositionEnabled` — several
    players accept the call and silently do nothing. A scrubber that cannot
    scrub is a worse affordance than a plain bar.

### Clock, hiding, capture and audio (2026-09-09)

20. **The resting pill is a clock**, built by the shell rather than by a screen.
    Nothing owns the time, and the alternative — Today claiming the pill whenever
    it had nothing better to say — made the default state of the whole app a
    fraction. A paused player hands the pill back after **30 seconds**: paused is
    still a claim at first so the controls stay one glance away, but not for the
    rest of the afternoon.
21. **`renderActivity` reuses its nodes.** The pill repaints every second, and
    `replaceChildren` each time means the text can never animate (there is no old
    node to animate away from) and any hover inside it is thrown away on every
    tick. It rebuilds only when the *kind* of claim changes.
22. **Restarting a CSS animation needs a forced reflow.** Removing and re-adding
    a class in the same task does nothing — the browser never computes the
    intermediate style. `tween.ts` reads `offsetWidth` in between.
23. **Hiding is animated by the webview; Rust waits it out.** The class drives a
    transform, and `apply_visibility` only really calls `hide()` after 340 ms —
    and **re-reads the state first**, because it can flip back mid-animation and
    hiding then leaves a window that is invisible but believes it is shown.
    ⚠️ Neither `#island` nor `#stage` is ever given a transform by its paint
    loop; anything that starts writing one must move the transition to a wrapper.
24. **Auto-hide uses `SHQueryUserNotificationState`**, the API Windows itself
    uses to decide whether a toast may appear, so it already knows about
    exclusive-fullscreen games and presentation mode. Comparing the foreground
    window's rect to the monitor — the obvious approach — calls a maximised
    editor fullscreen and hides the island all day. It is kept in a separate
    atomic from `config.chrome_hidden`: one is a preference that survives a
    restart, the other a condition that clears itself.
25. **Switching the audio output goes through `IPolicyConfig`**, which is
    undocumented — there has never been a public API. The vtable in audio.rs is
    declared by hand and **the ten reserved slots are load-bearing**: they exist
    only to put `SetDefaultEndpoint` at the right offset, and removing one makes
    this call `SetPropertyValue` with a device id, which is not a crash, just
    wrong. Both `eConsole` and `eMultimedia` are set, or communication apps stay
    on the old device and it looks like the switch failed.
26. **Bluetooth is read from `PKEY_Device_EnumeratorName` (`BTH…`)**, not the
    form factor — a Bluetooth headset reports "Headset" exactly like a USB one.
27. **An endpoint name has two shapes and both are real.** "Headphones (6- Buds3
    Pro)" hides the device in the brackets; "DELL U2724D (NVIDIA High Definition
    Audio)" hides the *driver* there. Taking the brackets every time renames
    every monitor to its graphics card, so `deviceName` keeps whichever half is
    not a generic form factor. Covered in `tests/media-format.test.mjs`, which is
    why the pure helpers live in `media-format.ts` — screen-media.ts touches the
    DOM on import and cannot be loaded under `node --test`.

### Reveal, System, app time (2026-09-09)

`system.rs` (volume, brightness, Bluetooth), `apptime.rs` (foreground tracking),
`screen-system.ts`. Tabs are Home · Today · Media · Calendar · System.

28. **Hidden no longer means `hide()`.** A hidden window has no edge to hover,
    so there was no way back except the shortcut — and the island is hideable
    precisely because it sits where a hand already is. Hidden now means the shape
    has slid out through its bezel, leaving a **3px hot strip** the width of the
    pill that reveals it on hover and slides it away again on leave. ⚠️ The strip
    makes the window non-click-through where it sits, so anything larger quietly
    swallows clicks at the top of the screen for a surface that is not visible.
29. **The System screen is read on open, never polled.** Brightness is a DDC/CI
    round trip down the display cable and can hang for a second on a panel that
    half-implements the protocol; Bluetooth enumeration walks the radio's device
    list. `system.rs` polls only the connected list, on a 4-second beat, and only
    to raise a notice — and it seeds from the first read so devices already
    connected at launch are not announced as if they had just arrived.
30. **`GetMonitorBrightness` and `SetMonitorBrightness` return a raw `BOOL`**,
    not the `Result` most of the `windows` crate hands back. A monitor that
    refuses DDC/CI is reported in words rather than shown as a dead slider.
31. **Bluetooth rows are a readout, and look like one.** Windows exposes no
    supported way to connect or disconnect a device from another process, so
    those rows must never look clickable.
32. **App time never counts idle.** Without `GetLastInputInfo`, a machine left on
    overnight reports fourteen hours in whatever was in front and the number
    stops meaning anything. Only the process name is recorded — never window
    titles, which are where the private part of "what were you doing" lives.
    `PROCESS_QUERY_LIMITED_INFORMATION` so it works unelevated against
    higher-integrity processes.
33. **The app-time strip shares the focus session's slot.** One or the other,
    never both, so the day's breakdown costs no row. It is rebuilt only when its
    signature changes — it redraws on the same pass as the task list, which runs
    on every optimistic tick.
34. **Home lost its progress ring.** It cost a third of the section to say
    "1/1", which the resting pill already says and the Today screen says
    properly. The tasks took the room: three of them, with list colour and how
    late they are.
35. ⚠️ **Do not write CSS escapes through a patch script.** `content:" b7"`
    survived one round of scripting as a doubled backslash and rendered as the
    literal text `b7` next to the date. The middle dot is a literal character in
    the stylesheet now, and a browser test asserts the date line never contains
    `00b7`.

### The iOS pass (2026-09-09)

Content lives in translucent rounded **tiles** on the dark ground, separated by
gaps rather than hairlines — Control Centre's grammar. App time moved off Today
onto System, where it sits as a full-width tile under the three columns.

36. **"Frosted" is painted, not blurred.** `backdrop-filter` on a child of
    `#island` samples the island's own opaque black, not the desktop behind the
    window — the island is where the transparency stops. Translucent white over
    black is what iOS-on-dark actually looks like anyway. Every surface reads
    from `--tile` / `--tile-hi` / `--tile-on`.
37. **The volume and brightness controls are capsules, not `<input type=range>`.**
    A range gives a 4px rail whose thumb is the only hit area, and restyling it
    into this shape means fighting three vendor pseudo-elements. The capsule
    keeps `role="slider"`, `aria-valuenow` and the arrow keys, so nothing is
    lost by leaving the native control behind — the browser tests drive it by
    keyboard.
38. **The capsule glyph uses `mix-blend-mode: difference`.** It sits at the
    bottom where the fill usually is, but at a low value the fill is beneath it.
    Blending inverts it against whatever it is over, with no second state to
    keep in step.
39. ⚠️ **`measure()`'s grid rule counts ROWS.** Taking the tallest child was
    right only while a grid had a single row, and silently clipped the second
    the day System grew a full-width tile underneath. It now groups children by
    `offsetTop`, takes the tallest in each row and adds the gaps back — which is
    also correct for the single-row case, so there is one rule, not two.

### The bento, and lists that do not grow (2026-09-09)

System is a fixed-shape bento — capsules, Output, Bluetooth, This PC, and the
day's app time — rather than three columns that grow with their contents.

40. ⚠️ **A list must not drive the panel height.** Seven audio endpoints (a
    developer's machine has Steam's two virtual ones, every monitor and the real
    speakers) made a column taller than the island can be, so the tile
    underneath was cut off with **nothing to scroll**. A tile now shows what is
    *in use* and puts the rest behind one press, which costs the same two rows
    with three devices or thirty.
41. **`measure()`'s grid rule is the union of the boxes, in viewport space.**
    Three earlier versions were each wrong: summing the children asks for three
    stacked columns' worth of panel, taking the tallest clips a second row, and
    grouping by `offsetTop` over-counts the moment a tile spans two rows — which
    is what a bento is made of. Measuring in viewport space also lets an
    absolutely positioned `.sheet` count, so opening a device list **grows** the
    island instead of being clipped by it.
42. **The day tile runs under the three narrow tiles, not beside the capsules.**
    Spanning the capsules down a second short row left a tile two thirds empty —
    exactly the dead space the redesign was about.
43. **Home's tiles stretch.** Three tiles of different natural heights left
    ragged gaps under the short ones, which was most of what read as emptiness.
44. **The machine tile reads CPU, memory, disk, network and uptime.** ⚠️
    `GetSystemTimes` returns cumulative totals — reading it once and dividing
    gives the machine's lifetime average, which barely moves and looks broken;
    a previous sample is kept so the figure is a delta. `GetAdaptersAddresses`
    is called twice on purpose, once for the size: guessing a buffer is how it
    silently truncates on a machine with Hyper-V, WSL and a VPN on it. Meters go
    amber past 80% and red past 92%, because a disk at 97% is the one fact on
    that screen that is actually urgent.
45. **Uptime switches to days past 48 hours.** "up 112h 00m" is arithmetic; "up
    4d 16h" is the thing you wanted to know.

### Agent runs and multiple monitors (2026-09-09)

**The agent activity notch stays its own window.** It is `index.html` / the
`notch` label, welded to the right edge; the island is `tasks.html`. They were
never merged and should not be — the usage notch is click-through chrome that
reports on something running elsewhere, while the island is a surface you type
into. Folding one into the other would mean either giving up the island's
`WS_EX_NOACTIVATE` or making usage unreadable while a composer has focus.

46. **A finished run is a `Working` — `Idle` transition on a session that is
    still alive.** The distinction is load-bearing: a session whose process is
    gone drops out of `live_sessions()` before the comparison happens, so
    closing a terminal mid-run raises nothing. Shutting a window is not an
    achievement to be congratulated for, and a toast for it would fire every
    time one was closed.
47. **The run duration subtracts `WORKING_WINDOW`.** The transcript counts as
    live for 8s after its last write, so a run that has "just ended" ended
    eight seconds ago. Without the subtraction every run is reported 8s longer
    than it was, and a short one at roughly double.
48. **`Finished` is an event, never a field on `ProviderActivity`.** That struct
    is cached in `Latest` and handed to anyone who calls `get_activity`, so a
    one-shot fact living on it would be replayed as news on every WebView
    reload.
49. **The collapsed pill is the indicator; the toast is the courtesy.** Cells
    are `opacity: 0` when collapsed, so until now the notch reported a run only
    to someone already hovering it — the opposite of the case it exists for.
    `#pip` is 5px, shares the shape's own box, and has three states: breathing
    white while working, green on a finish, nothing otherwise. `done` outranks
    `working` on purpose — a second session starting does not un-finish the
    first, and the finish is the news. **Opening the notch is the
    acknowledgement**: there is no dismiss control on a 10px pill, and adding
    one would mean a second gesture to clear something already read.
50. ⚠️ **An unpackaged exe cannot simply raise a toast.**
    `CreateToastNotifier` resolves the AppUserModelID against the shell, and an
    id it has never heard of fails with `ELEMENT_NOT_FOUND` — an `Err` nobody
    is looking at, so the notification is silently never shown.
    `notify::register()` writes
    `HKCU\Software\Classes\AppUserModelId\<identifier>` on every launch, which is
    the lighter of the two documented registrations (the other puts a shortcut
    in a Start Menu nobody asked for). Written against the `windows` crate
    already in the tree rather than through `tauri-plugin-notification`, which
    would pull a second major version of `windows` in behind it for four lines
    of XML. Toast XML is parsed, so a project name containing `&` is escaped or
    the whole toast fails to load — again with nothing shown and no error.
51. **`spoken()` exists twice, in Rust and in TypeScript, and both are tested
    against the same table.** The same duration is written into the toast and
    into the notch's tooltip; two spellings of "4m 12s" side by side read as
    two different numbers.
52. **`MonitorFromWindow` answers the wrong question for a notch.** It reports
    where the window *is*, and a window that is only ever where it was last put
    answers "wherever Windows dropped me at launch". Placement now takes a
    display id from the config; `win::place_on` is the only entry point and
    `win::place` is gone, so no caller can pin a window to the right edge of the
    wrong screen.
53. **The display id is the device interface path, not `\\.\DISPLAY1`.** The
    adapter slot is a position, not a panel: unplugging one monitor renumbers
    the rest, and a saved position would silently reappear on the wrong screen.
54. ⚠️ **Windows will not tell you a monitor's model.**
    `EnumDisplayDevicesW` reports the *driver's* description, which on ordinary
    panels is the string "Generic PnP Monitor" — three displays all called the
    same thing, which is useless in a menu whose whole job is telling them
    apart. The name on the box is only in the EDID the driver cached under
    `...\Enum\<enumerator>\<hardware id>\<instance>\Device Parameters`,
    in the 18-byte descriptor tagged `0xFC`. It is not always the first
    descriptor — the MSI here has it in the fourth — so all four are walked,
    and a short or absent blob must return `None` rather than panic in a
    background thread.
55. **`MONITORINFOF_PRIMARY` and `EDD_GET_DEVICE_INTERFACE_NAME` live in
    `UI::WindowsAndMessaging`**, not in `Graphics::Gdi` beside the functions
    that take them. And **`BOOL` is `windows::core::BOOL` in 0.62**, while
    `TRUE` is still in `Win32::Foundation`.
56. **A missing display falls back and never clears the setting.** A monitor
    that is asleep, on another input, or behind a KVM is absent, not gone —
    clearing would move the notch home for good the first time the screen
    blanked, with nothing to say why.
57. **Nothing here can hear `WM_DISPLAYCHANGE`.** tao owns the window procedure
    and Tauri surfaces no equivalent, so plugging a monitor in or waking from
    sleep can strand both windows on a bezel that has moved.
    `drag::watch_displays` polls the monitor list every 3s instead —
    enumerating monitors costs microseconds — and skips a re-place while a
    drag is in flight, or it would fight the pointer for the window.
58. **Moving the island announces where it went.** It is click-through chrome
    on a bezel; sent to a screen you were not looking at it reads as having
    vanished. `island:moved` raises a transient pill claim at priority 90,
    which is also the first brick of the claims-queue idea in the roadmap.
59. **The display picker hides itself on one monitor**, and the two tray items
    are disabled there. A control whose only entries are "Automatic" and the
    single screen you have cannot do anything, and offering it only invites the
    question of what it would mean.
60. ⚠️ **A patch tool that rewrites files eats backslashes, and this
    codebase is full of them.** The literal `r"\\?\"` reached win.rs as
    `r"\?\"`, so the prefix was never trimmed, the registry key came out
    with the prefix embedded in its middle, `RegOpenKeyEx` said "file not
    found", and `.ok()?` swallowed it — **every** monitor fell through to its
    driver description, and it looked correct on the one display whose driver
    publishes a real name. The same collapse hit `sessions::project_of`, where
    the compiler caught it instead. Two defences now: `win::SEP` is a named
    constant so the file carries no bare escape, and `registry_key()` is a pure
    function tested against a real device path off this machine.

### The resting clock, the motion scale, and Home (2026-09-14)

61. **The resting pill is the time and nothing else.** It was a ring, the
    time, and `Mon, Sep 14 · 0/0` under it. At rest — which is most of the
    day — that made the strip a progress meter for a number that is 0/0 on
    any day nothing is due, beside a date the taskbar carries two inches
    away. The clock gets its own build path in `island-activity.ts` rather
    than a claim with its parts left blank, because a `kind: "clock"` with
    no `progress` falls through `build()` to `paintIcon(lead, "media")` and
    the pill grows a music note.
62. ⚠️ **`hourCycle: "h23"`, not `hour12: false`.** They are not the same
    switch: `hour12: false` selects the **h24** cycle in several locales,
    which prints midnight as `24:00` and one minute past as `24:01` before
    rolling over to `00:02`. Nobody sees this until midnight, on a machine
    that is not the developer's.
63. **`hour: "2-digit"` is advisory in the 12-hour cycle.** Every engine
    prints `2:32 PM`, never `02:32 PM`, so the two formats have different
    character counts and nothing may be sized on one of them.
64. **The clock re-animates only the characters that changed.**
    transitions.dev's number pop-in replays every digit on every update,
    which is right for a balance you tap to refresh and wrong for a clock:
    `14:32` to `14:33` moves one character, and popping all five once a
    minute is the same thing-twitching-in-the-corner-of-your-eye problem the
    "no seconds" rule already solved once. `setDigits` matches
    right-to-left so `9:59` to `10:00` still only re-animates what moved,
    and the colon never carries the attribute at all — a separator
    wobbling between two still numbers reads as a fault.
65. ⚠️ **`align-items: stretch` on a `.screen-body` grid is a feedback
    loop.** `.home-grid` is a `screen-body`, so flex hands it the panel's
    whole height; a row left to fill that height stretches the tiles,
    `measure()` reads the taller tiles, the panel grows to hold them, and
    round again. Measured: the island reached 357px and ran off the side of
    its own window. `align-content: start` is what makes stretch safe —
    the row is then sized by its tiles and stretch only equalises them
    against each other. `.sys-grid` already did this; `.home-grid` now does.
66. **Home is styled in exactly one place.** It had grown three passes — an
    original hairline-column pass, a tile pass, and a "stretch, not centre"
    pass — and because later rules simply win, the tile padding from the
    second was overwritten by `padding: 0 18px` from the first and the
    `align-items: stretch` from the third by `align-items: center`. On
    screen that was ragged tiles with their content pressed against the top
    and bottom edges: exactly what the two later passes had been written to
    prevent. No rule was wrong; there were just three of them.
67. **Motion is on one token scale** (`--duration-*`, `--ease-*`), in both
    `tasks.css` and `style.css`, chosen by **what the motion does** rather
    than by what number looked right in isolation. Two things are
    deliberately NOT on it: the infinite loops (`eq`, `wave-head`, the
    activity spinner) have no matching token usage, and the notch's shape,
    fold and orb are integrated springs written frame by frame by `main.ts`
    — nothing on that path reads a CSS duration.
68. ⚠️ **`cargo build --release` does NOT produce a release binary here.**
    It produces one that still points at `http://localhost:1420`, so both
    WebViews land on `chrome-error://chromewebdata/` and the app is two
    blank rectangles. There is no `[features] custom-protocol` in
    `Cargo.toml`, which is what the Tauri CLI passes to switch a build from
    the dev server to the embedded assets. **`npm run tauri build` is the
    command** (`beforeBuildCommand` is `pnpm build`, and pnpm is installed).
    Touching `build.rs` does not fix it and neither does rebuilding; the
    only symptom is the smoke test reporting two error pages, which reads
    like a frontend fault rather than a build one.
69. **The two smoke tests poll for the click-through flip rather than
    sleeping on it.** `WS_EX_TRANSPARENT` is cleared by `hover.rs`'s own
    100ms poll, from a mask the page pushes on a 20ms interval, so the lag
    is however long those two take to line up. A fixed `pause(1000)` passed
    on an idle machine and failed right after another smoke run had torn a
    WebView2 down — which is exactly when it runs. It flaked twice before
    it was fixed rather than re-run.

### The resting pill's three slots (2026-09-14)

`[ 14 / SEP ]   14:53   [ module ]`. The date came back stacked, and the
third slot carries whatever `pill-modules.ts` decides is worth the space.

70. ⚠️ **`1fr auto 1fr`, never `auto auto auto`.** The two sides may be
    different widths; the **middle may not move**. With auto columns the
    clock slides left and right as the module changes from "22°" to "3 tasks
    left", and a clock that is not always in the same place is one the eye
    has to find before it can read — which is the whole job it has. The
    browser test measures the clock's centre against the pill's for exactly
    this.
71. ⚠️ **Severity decides whether a reading CAN hold the slot; time
    decides how long it does.** The first version had only the first half, and
    it produced exactly the thing it was written to prevent: this machine's
    disk sits at 95-97% and will until someone buys a new one, so the strip
    carried a permanent red warning and nothing else could ever be seen — a
    permanent alert being the definition of an alert you stop reading. `decay`
    is the fix: news owns the slot for `HOLD_MS` (2 minutes), then drops to
    just under `HOLD` and takes its turn. It still sorts above every ambient
    module, so a standing condition leads the cycle and is seen every time
    round rather than every time you look.
    It **re-arms** when the figure gets materially worse (5 points, not 1 —
    one point is the disk creeping), measured from a high-water mark so a
    reading that dips and climbs back does not re-alert on ground it has
    already covered. A module falling silent drops its arming entirely, so
    coming back is news again.
    `decay` returns the next state rather than writing to the one it was given,
    which is what lets the whole rule be tested a tick at a time with no clock
    and no DOM.
72. **`choose()` is pure, and that is deliberate.** Given the same readings
    and the same elapsed milliseconds it always answers the same thing, so
    the rotation rule is tested with no clock, no DOM and no fixture.
73. **The rotation restarts when the SET changes, not when the text does.**
    The key is which modules have something to say. A module arriving or
    falling silent shows the new thing now; the same set carrying on keeps
    its place in the cycle instead of jumping back to the start every time
    a countdown ticks.
74. ⚠️ **The module slot animates on a change of SUBJECT, not of
    wording.** A countdown going from "in 2h 10m" to "in 2h 09m" is the same
    module being more precise; running the text swap on that is a slot that
    never holds still. `data-module` is what tells the two apart, and the
    same-subject path updates in place through `setText`.
75. **CPU speaks at 90, where the System meters speak at 80.** A developer's
    machine sits at 80% with an editor and a browser open and is perfectly
    well. A meter you went to look at can afford to be informative; a pill
    that warns all day is one that is ignored on the day it matters.
76. **The event module starts at 30 minutes, where the calendar screen stops
    claiming the pill.** Inside that window the screen takes the *whole*
    pill at priority 25/50, so a module covering the same range would never
    be seen — and on the frame it was, the pill would say the same thing
    twice. It is a hand-off, not a duplicate.
77. **-1 is "not read yet", not a low reading.** Every machine module tests
    for it, or a fresh launch reports `Disk -1%` as a quiet fact.
78. **The machine is polled by the shell, not by the System screen.** That
    screen reads it only when opened, and a threshold module cannot wait for
    that. It also fixes a quirk nobody had chased: `cpu_percent` needs a
    previous sample and returns -1 without one, so the CPU figure was always
    wrong the *first* time the System screen was opened and right every time
    after.
79. ⚠️ **Weather is opt-in by a typed place, and that is a decision, not
    an omission.** Resolving the location from the IP address would mean
    every launch tells a third party where this machine is, to save one text
    field. Open-Meteo needs no key and no account, the place is geocoded
    **once** into cached coordinates, and nothing is requested at all while
    the field is empty. Clearing it drops the coordinates too — leaving
    them would make a later re-enable silently report the old city.
80. **The weather icon names cross the IPC boundary as strings** (`wxRain`,
    `wxStorm`, …). Renaming one in `task-icons.ts` without renaming it in
    `describe()` leaves the pill with no icon and no error.
81. **`sessions::ProviderActivity` carries a `running` count as well as a
    state**, and the count is part of the change comparison. Two sessions
    starting and one stopping leaves `state` at `Working`, so without it the
    pill would keep saying "2 agents" indefinitely.
82. **`islandPillLong` is 640, up from 430.** `cpx()` is 56/117, so that is
    306 CSS px of body plus two curls — about 342 in all. Past roughly 700
    the strip stops reading as a notch welded to the bezel and starts
    reading as a toolbar someone left open. The release smoke test's "thin
    pill" ceiling moved from 260 to 400 with it.
83. ⚠️ **On a vertical edge the sides are hidden, not shrunk.** The shape
    is 35px wide there and has room for one thing. A date stacked into 35px
    is unreadable and a module clipped to its glyph is a mystery rather than
    a summary, so only the time survives.

### Minimal is a glyph and a token (2026-09-14)

84. ⚠️ **A module says an icon and one token, never a sentence.** `97%`
    beside a disk glyph, not `Disk 97% · 14 GB free` on two lines. The
    strip is on screen all day: after a week you are reading the glyph and
    the colour, and the words are only costing width. Everything a module
    summarises is on its own screen, one hover away, which is where the
    sentence belongs. The node test asserts `text.length <= 4` and that no
    module carries a second line, because this is the kind of rule that
    erodes one helpful clarification at a time.
85. **`islandPillLong` went 430 -> 640 -> 470.** Widened when the resting
    pill became three slots, then brought most of the way back when the
    module slot lost its sentence: 470 design px is 225 CSS px of body, about
    260 with both curls. The release smoke test's "thin pill" ceiling is 400,
    which still catches the panel at ~970 without pinning the pill's own
    width to a number that changes with its contents.
86. **The resting pill's padding is 20px, not 4.** With the slots hard
    against the curls the strip read as something clipped rather than
    something laid out, and the curl is a curve — the content has to clear
    where it starts bending, not where it ends.

### Agent supervision (2026-09-14)

**The thing this file used to say was impossible.** Every earlier version of
`sessions.rs` and the README said telling *waiting* from *finished* needed
Claude Code's hooks, because both stop writing and a modification time cannot
separate them. That was true of the modification time and false of the file.

87. **The last conversational record is the whole signal.** `assistant` with a
    `tool_use` means working; `assistant` with only prose means the turn
    ended and it is **waiting for you**; a `user` record means the model is
    thinking. No hook, no config, nothing of the user's to modify.
88. ⚠️ **"The last record" is not the last line.** A transcript carries
    fifteen record types and barely half are conversational —
    `bridge-session`, `atis-latch`, `attachment`, `last-prompt`, `ai-title`,
    `queue-operation` and friends land at the tail constantly. Reading the
    final line and looking for a role finds nothing, silently and for ever.
    `transcript::classify` returns `None` for them and a test feeds it every
    one.
89. ⚠️ **`isSidechain` records are a subagent's conversation.** A subagent
    ending its turn with prose is not the session waiting for you — the
    parent picks the result up and carries on — and counting it would make
    every Task call look like a prompt. Its tokens are skipped for the same
    reason.
90. ⚠️ **Transcripts reach 49 MB on this machine.** Nothing may load one.
    A newly noticed session is classified from a 512 KB tail; after that only
    the bytes appended since the last look are read, capped at 4 MB a tick.
    Measured: all 18 transcripts on this machine, the 49 MB one included,
    classify in **0.76 s** total.
91. ⚠️ **A read can land mid-append and take half a line.** The offset is
    rewound to the last newline so the fragment is read again — whole —
    next time, rather than parsed as truncated JSON. A file *shorter* than
    the offset was replaced, not rewound, and the offset jumps to the new end
    rather than re-reading 49 MB.
92. **Token totals are "since Codenotch started watching", and the UI says
    so.** A historical scan of every open transcript at launch would read
    hundreds of megabytes to learn what the last few kilobytes already say.
93. ⚠️ **Cache reads are counted.** They are most of what a long session
    spends and what the limit is measured against; a figure that left them
    out would report an afternoon as a few thousand tokens.
94. ⚠️ **The pid owns no window.** Claude Code is a console program: its
    node process draws nothing and the window belongs to its *terminal*,
    which is an ancestor. `GetWindowThreadProcessId` on that window answers
    with the terminal's pid, so matching the session's own pid against window
    owners finds nothing at all. `win::raise_process` walks the process tree
    upward (capped at 8, because a recycled pid can make the parent map
    cyclic) until it finds an ancestor that owns a visible, titled window.
95. ⚠️ **`SetForegroundWindow` refuses silently.** It returns FALSE, with
    no error, for a process that does not already own the foreground — and
    this one never does: the notch is `WS_EX_NOACTIVATE` precisely so it
    cannot. `AttachThreadInput` to the current foreground thread for the
    duration of the call is the way around it. Verified against a real
    session's pid: `raised: true`.
    Honest limitation: it raises the **window, not the tab**. One Windows
    Terminal window hosts many sessions and there is no supported way to
    select one of its tabs from outside.
96. **`AttachThreadInput` is in `System::Threading`**, not beside the other
    input functions in `UI::Input::KeyboardAndMouse`.
97. **Only *waiting* claims the pill, never *working*.** Something working
    needs nothing from you and will carry on by itself. Priority 55 puts it
    under a meeting about to start and **over media** — which is correct,
    and which quietly broke two media tests when the demo fixture was first
    given a waiting session. `?agents` is the flag now; `?quiet` has none at
    all, because that fixture means the pill is at rest.
98. ⚠️ **The sessions event is compared on what is DRAWN.** `forSecs`
    climbs every tick, so comparing the views wholesale emits an event 65
    times a minute for ever and wakes both WebViews for nothing. The elapsed
    figures are recomputed in the web layer from the state it already has.
99. ⚠️ **Node's type-stripping refuses `constructor(private host: ...)`.**
    Nothing in a screen class's file can be imported by a node test, which is
    why `media-format.ts` holds the strip's pure formatting whatever its name
    suggests. `tokens()` and `held()` live there for that reason alone.
100. **The usage notch is not replaced by the Agents screen and must not be.**
     It is click-through chrome reporting on something running elsewhere; the
     screen is a panel you click into. Its pip gained `waiting` (amber,
     breathing slowly) — a style that had been sitting in `style.css` since
     the first version, waiting for the day the state could be produced.

### The shelf, the review and snoozing (2026-09-14)

101. ⚠️ **Shelved files are REFERENCED, never copied.** A shelf that
     copied would duplicate a 2 GB video to park it for ten minutes and
     then hold a stale copy of something you kept editing. The price is
     that a file can move or be deleted behind the shelf's back, so every
     item is re-checked on read and **shown as missing rather than hidden**
     — a row that silently vanished would look like the shelf losing
     things. A missing row offers removal and nothing else: a button that
     cannot work is worse than no button.
102. ⚠️ **Taking a file OUT is a clipboard copy, not a drag, and that is
     a decision.** Dragging a real file out of a WebView is not something
     HTML can do — the browser can offer text or a URL, and Explorer wants
     a `CF_HDROP`. Doing it properly means becoming an OLE drag source: a
     hand-written `IDataObject` and `IDropSource` and a modal `DoDragDrop`
     running its own message loop inside a window that is click-through and
     non-activating. That is the same class of hand-rolled COM as
     `IPolicyConfig`, the most dangerous code in this tree, for a gesture
     that is awkward from a 35px strip anyway. `SetClipboardData(CF_HDROP)`
     is one documented call and pastes into Explorer, Slack, a browser
     upload and everything else.
103. ⚠️ **Every path out of the clipboard code closes the clipboard.**
     Leaving it open locks it for the whole desktop — nothing on the
     machine can copy or paste until this process exits, and there is no
     error anywhere to say why. Hence the `Clipboard` guard with a `Drop`
     impl rather than a matched pair of calls.
104. ⚠️ **The `HGLOBAL` is given away, not lent.** Once
     `SetClipboardData` succeeds the clipboard owns that block and freeing
     it is a double free; if it *fails*, nobody owns it and not freeing it
     leaks. Both branches are written out.
105. **A `CF_HDROP` payload needs a second NUL.** The path list is
     double-terminated; without it the receiver reads past the buffer
     looking for the next path. `GlobalFree` is in `Foundation`, not beside
     `GlobalAlloc`/`Lock`/`Unlock` in `System::Memory`.
106. ⚠️ **A file dropped on the island only lands while the island is
     interactive.** Both windows are `WS_EX_TRANSPARENT` except over the
     rects the web layer reports, and the drag loop finds its target with
     `WindowFromPoint`, which skips a transparent window entirely — so a
     file held over a collapsed, untouched island drops onto whatever is
     behind it. Hovering with a file held does open the island (the hover
     poll reads the cursor, which keeps moving during a drag). **The
     `Ctrl+Alt+S` clipboard path is the one that always works**, which is
     why it exists and why it is the one under test.
107. **The shelf shortcut does not open the island.** The point is to park
     something without leaving what you are in; showing a panel would be
     the interruption the shelf exists to avoid. The pill's transient
     notice is the whole acknowledgement.
108. **`explorer.exe /select,<path>` is ONE argument, comma and all.** No
     space after the comma, and the path is not a separate parameter.
     Written any other way Explorer silently opens Documents instead.
109. **App time moved off System and onto Review.** It went to System when
     Today got too busy and it never belonged there — System is the
     machine's controls, and how long you spent in an editor is not a
     control. Review is the screen that looks backwards, and it is the
     first thing in this app that does.
110. **Review invents nothing.** App time, finished tasks, agent runs and
     the calendar were all already being kept, in four places, with nothing
     joining them. Only the run log was new, and only because the watcher
     was throwing each finished run away after raising its toast.
111. ⚠️ **Snooze is the missing gesture, and `decay` is not a
     substitute for it.** `decay` handles a condition that is chronically
     true; snooze handles one you are choosing to ignore for an hour. A
     waiting agent has neither a severity that fades nor a value that
     creeps, so nothing but an explicit "not now" could ever quiet it.
112. ⚠️ **Nothing is silenced for ever, and the app says what is quiet.**
     Every snooze has an end, the island's settings line says how many
     things are snoozed, and one press brings them all back. The failure
     mode of a mute button is forgetting you pressed it and then wondering
     for a week why the app stopped telling you things.
113. **Snoozing is only offered where something is asking.** An idle agent
     row has no bell: muting silence is a control that does nothing but
     make you wonder later what you switched off.
114. ⚠️ **The quiet set is PASSED INTO `pill-modules`, not imported.**
     Importing `./snooze` pulls `task-client` and the Tauri event API in
     behind it, and `readings()` stops being something node can import —
     which costs the file its entire test suite. One field on
     `ModuleContext` buys that back.
115. **State that is neither a setting nor a cache gets its own file.**
     `shelf.json`, `runs.json` and `snooze.json` sit beside `config.json`
     rather than inside it: each is written on its own schedule by its own
     thread, and folding them in would mean a run ending rewrites the
     user's edge, position and shortcuts — with a torn write costing all
     of it at once.
116. **Eight tabs now, grouped rather than alphabetical**: what you are
     doing (Home, Today, Agents, Shelf), what is around you (Media,
     Calendar), then the machine and the day behind you (System, Review).

### Why dropping a file did not work (2026-09-14)

Reported as "I can't drag the file onto the shelf". Three separate causes,
none of them the handler, and the first one had been there since the app was
written.

117. ⚠️ **There was no single-instance guard, and two copies look exactly
     like a broken feature.** Two always-on-top islands sit at the same
     coordinates, each with its own hover poll rewriting its own window's
     extended styles and its own in-memory shelf. A drop lands on whichever
     window is on top and *is* written to `shelf.json` — while the island
     you are looking at belongs to the other process and never hears about
     it. Everything works and nothing appears to. Found by a probe that
     enumerated windows whose title starts with "Codenotch" and got four.
118. ⚠️ **A collapsed island is not a drop target, and its mask is too
     small to become one.** `WS_EX_TRANSPARENT` is skipped by
     `WindowFromPoint`, which is what the OLE drag loop uses; the mask that
     clears the flag is the collapsed pill, about 260 × 35, and a pointer
     dragging a file has to cross it and *stop* there for a 100ms poll
     before anything opens. Nobody hits that. `hover.rs` now takes the whole
     window rect while the left button is down, which makes the target the
     size of the panel. It cannot steal anything: a drag in progress already
     owns the mouse, and the flag decides where the *next* hit test lands.
119. **The third was self-inflicted: `cargo build --release` again** (see
     #68). The binary under test was pointing at the dev server, so both
     WebViews were error pages and no handler existed to receive anything.
     The lesson holds: **`npm run tauri build`, always.**
120. ⚠️ **`println!` goes nowhere in this app, and never did.** The
     release build is `windows_subsystem = "windows"` with no console, so
     every `println!` in the tree — nineteen background threads' worth —
     is dead in exactly the build anyone runs when something is wrong.
     `log.rs` is a capped rolling file beside the config, `debug_note` now
     routes into it instead of being dev-only, and the tray has **Open
     log**. This is the first half of the logging gap the 1.0 discussion
     listed as a blocker.
121. **The drop path is under test without a human.** A real OS drag needs a
     hand holding a file, but everything from Tauri's event to the file
     being on the shelf is exercised in the release smoke test by emitting
     the `tauri://drag-drop` the drag would have produced. When dropping
     "does not work" again, that is what says whether the fault is in the
     window — hit-testing, transparency, a second instance — or in the
     handler.
122. **`dropprobe.rs` is the tool that answered this.** Test-only and
     ignored: it enumerates Codenotch windows, prints their rects and
     extended styles, and asks `WindowFromPoint` what is hit-testable with
     the mouse button up and held down. Run it with the app running:
     `cargo test --lib dropprobe -- --ignored --nocapture`.
123. ⚠️ **Use forward slashes in any Windows path a patch tool touches.**
     The smoke test's `C:\Windows\...\hosts` lost every backslash on the way
     into the file and JS then read what was left as escape sequences, so
     the shelf filed an item called `WindowsSystem32driversetchosts`.
     Windows takes forward slashes everywhere that matters here, and no
     shell, patch script or JS parser can eat them. Same root cause as #60.

### The drop, properly (2026-09-14)

124. ⚠️ **"The whole window counts while the button is down" is not an
     acceptable way to widen a drop target.** It was tried and it is
     unusable: this window is always the EXPANDED size and almost entirely
     invisible, so clicking anywhere in a 969×388 patch of apparently empty
     desktop made the island interactive and opened it. Reverted the same
     day it was added. The mask is the painted chrome and nothing else.
125. ⚠️ **Tauri's drag-and-drop never fires for this window.** Measured,
     not assumed. The web layer logs *every* `tauri://drag-*` event it
     receives; a synthetic `drag-drop` emitted at the same webview arrives
     and shelves the file; a real file dragged out of Explorer produces
     **nothing at all** — no drop, no enter, no over. Whatever wry
     registers as an OLE drop target is not found for a window that is
     layered, click-through, non-activating and undecorated.
126. **So the window asks the shell directly.** `dropfiles.rs`:
     `DragAcceptFiles` plus a `SetWindowSubclass` that catches
     `WM_DROPFILES`. No `IDataObject`, no `IDropSource`, no modal
     `DoDragDrop` — the older and much simpler contract, and it covers
     exactly the case that matters, a file dragged out of Explorer.
127. **`DragAcceptFiles` is a shell registration, not a style bit**, so it
     survives `set_ignore_cursor_events` rewriting the whole extended-style
     word — the trap `win::harden` exists for. The subclass survives it
     too. Worth knowing before someone adds a third re-apply call.
128. **`DragFinish` runs even on an empty path list.** It frees the block
     the shell allocated for the drop; skipping it leaks into the shell's
     heap for the life of the process.
129. **The handler path is provable without a human.** Unlike an OLE drag,
     `WM_DROPFILES` is just a window message carrying an `HDROP` — and an
     `HDROP` is the same `DROPFILES` block the clipboard code already
     builds. `dropprobe::posts_a_real_drop_message` allocates one, posts it
     at the island from another process, and the log shows
     `WM_DROPFILES: 1 path(s)` followed by `shelf: 1 item(s)`. If dropping
     ever stops working again, that test says whether the fault is the
     handler or the hit test.
130. ⚠️ **The posted block needs `GMEM_SHARE` (0x2000), which the
     `windows` crate does not name.** Another process has to be able to
     follow the pointer; without it the receiver gets one it cannot read
     and the drop silently does nothing.
131. **A drop still has to land on PAINTED chrome.** The window is a hole
     almost everywhere, and per-pixel alpha is what the shell hit-tests
     against, so the pill or the open panel are the target — everywhere
     else the island genuinely is not there. That is correct behaviour and
     not something to widen; see #124 for what widening costs.

### Dropping in, and dragging out (2026-09-14)

132. ⚠️ **The no-drop cursor was the clue, and it meant the opposite of
     what was assumed.** A circle-slash means the window *is* being
     targeted and something is refusing — not that the shell walked past
     it. WebView2 registers an OLE drop target on its own **child** window,
     the drag loop finds that first, and the parent's `DragAcceptFiles`
     registration is never consulted. The page was the target all along and
     was not accepting.
133. **`dragDropEnabled: false` on the tasks window, and the page handles
     it.** `preventDefault()` on **both** `dragenter` and `dragover` is
     what turns the circle-slash into a copy cursor and lets `drop` fire.
     Missing either one gives exactly the reported symptom.
134. ⚠️ **`dataTransfer.files` is EMPTY during dragenter/dragover.** The
     browser withholds the contents until the drop actually happens, so
     `types` — which contains `"Files"` — is the only thing that can be read
     early. Deciding "is this a file drag" on `files.length` looks obvious
     and never fires.
135. **The pill is the doorway, and that is the whole detection story.** The
     island is click-through everywhere else, so a drag cannot be seen at
     all until it crosses painted chrome. Once WebView2 raises `dragenter`,
     the page knows it is a file and asks Rust to open the *whole* window as
     a target. This replaced a Shift+click gesture: a modifier can make the
     window interactive but cannot tell a file from a stray click.
136. ⚠️ **The drop zone closes on a TIMER refreshed by `dragover`, never
     on `dragleave`.** That event fires every time the pointer crosses
     between child elements — a dozen times on the way across a panel of
     task rows — so closing on it makes the overlay strobe and the window
     stop being a target mid-drag.
137. **Dragging back OUT is a real OLE drag, and it is not as bad as
     `shelf.rs` feared.** The judgement there — that a hand-maintained COM
     vtable is not worth it — still stands; what changed is that almost
     none of it has to be written. The `IDataObject` comes from the shell
     (`SHCreateItemFromParsingName` + `BindToHandler(BHID_DataObject)`),
     carrying a proper `CF_HDROP`; only `IDropSource` is implemented, it is
     two methods, and `#[implement]` writes the vtable. The dangerous part
     — the part that makes `IPolicyConfig` the scariest code in this tree
     — does not exist here.
138. ⚠️ **`DoDragDrop` runs a modal message loop, so it gets its own
     thread.** On the UI thread it would freeze the island for the length of
     the drag; on Tauri's async pool it would hold a worker. The thread is
     also where `OleInitialize` goes — **not `CoInitializeEx`**: OLE drag
     and drop needs the full OLE apartment and fails with
     `CO_E_NOTINITIALIZED` without it.
139. ⚠️ **The shell's parser refuses forward slashes.**
     `SHCreateItemFromParsingName` answers `E_INVALIDARG` for
     `C:/Windows/.../hosts`, so a file that arrived as a `file:///C:/...`
     uri-list could be opened and copied but **never dragged back out**.
     `shelf::windows_path` normalises on the way in and `dragout` again on
     the way out. Measured, and now a test: `std::fs` and `ShellExecuteW`
     both accept either spelling, which is what hides this.
140. **A drag out starts on pointer MOVEMENT, not on pointerdown.**
     `DoDragDrop` takes the mouse the instant it is called, so starting it
     on the press would turn every click on a shelf row — including ones
     aimed at the buttons beside it — into a drag nobody asked for. Six
     pixels separates the two gestures.
141. **The drop path is under test without a human.** The release smoke test
     dispatches a real `DragEvent` carrying a `File`, which exercises
     detection, the overlay, the bytes fallback and the shelf write; and it
     starts a real drag out to prove the path resolves and the shell
     accepts it. What it cannot check is the modal loop, which needs a
     mouse.
142. **The bytes fallback never overwrites.** A browser `File` has no path
     by design, so a drop through the page has only the contents; they go
     in the app's own folder, and a second file of the same name lands
     beside the first rather than on top of it.

### The drag that would not end (2026-09-14)

Reported as "dragging out doesn't work and it also broke my normal drag".
The two halves were the same fault.

143. ⚠️ **`DoDragDrop` must run on a thread that receives mouse
     messages, which in practice means the main thread.** It drives its own
     modal loop out of the *calling thread's* message queue and calls
     `QueryContinueDrag` for each mouse message it sees. A plain worker
     thread has no message queue and gets no mouse input, so the loop never
     learns the button came up and **never returns**.
144. ⚠️ **And a stuck drag loop does not break the app — it breaks the
     desktop.** It holds the mouse capture, so dragging stops working
     everywhere until the process is killed. That is the whole reason this
     is not something to try by hand: the failure mode costs the user their
     mouse, not a feature.
145. **Blocking the main thread for the length of a drag is correct, not a
     compromise.** It is what every Windows app does. `run_on_main_thread`
     is how the work gets there; the hover poll checks `dragout::DRAGGING`
     and stands back, because `set_ignore_cursor_events` goes through the
     main thread too and would queue behind the modal loop at best.
146. **`continue_drag` is a free function so it can be tested.** It is the
     rule that decides whether the loop ever ends — `MK_LBUTTON` clear
     means drop, Escape means cancel — and testing the wrong bit gives a
     drag that follows the cursor for ever. Five assertions, no COM.
147. **There is a watchdog, and it exists because of #144.** If a drag is
     still running after twelve seconds a synthetic Escape is sent:
     `continue_drag` always answers `DRAGDROP_S_CANCEL` for it, so the loop
     ends and the capture comes back. It converts "kill the app" into
     "wait a few seconds". Sent only while `DRAGGING` is still true, so a
     drag that finished never sees a stray keystroke.
148. **`tools/drag-out-check.mjs` proves termination without risking it.**
     It launches the app, shelves a real file, presses the button, starts
     the drag through the real command, wiggles, releases, and reads the
     log. `returned HRESULT(0x00040100)` is `DRAGDROP_S_DROP`: the loop
     ended and gave the capture back. Verified on this machine, with
     `effect 1` — the drop was accepted, not just abandoned.

### Surviving a panic (2026-09-14)

149. ⚠️ **A panic in a background thread here was silent and
     permanent.** Nineteen of them run forever and each one *is* a feature.
     When one unwound, Rust printed to a stderr a windowed release build
     does not have, the thread ended, and that feature stopped for the rest
     of the session with nothing anywhere to say so. The app looked fine:
     music stopped updating, or the notch stopped noticing hover, and the
     only symptom was "it went weird".
150. **Two halves, because they answer different questions.** A panic hook
     writes every panic down with its location, wherever it happens —
     including the main thread. `guard::spawn` catches the unwind, names
     the feature, and restarts the loop.
151. ⚠️ **Restarting is capped at three attempts with a widening gap.**
     A panic that recurs immediately — a bad assumption about a data
     shape, not a transient Win32 failure — would otherwise spin the CPU
     retrying forever. Three tries turns a hiccup into a hiccup and leaves
     a permanent fault permanent, but **logged**.
152. **The hook is chained, not replaced**, so `cargo run` still prints the
     usual message and backtrace.
153. **Scope is deliberate and written down.** `guard::spawn` covers OS
     threads. `tasks`, `calendar` and `weather` are tokio tasks, whose
     panics go into a `JoinHandle` nobody awaits — just as silent, and now
     covered by the hook but not restarted. The one-shot COM workers in
     `audio`, `media` and `system` are left alone on purpose: they send a
     result down a oneshot channel, and the receiving side already turns a
     dropped sender into "the audio thread stopped".
154. **`dropfiles.rs` is deleted.** `DragAcceptFiles` + `WM_DROPFILES` was
     provable by posting the message by hand and fired **zero** times for a
     real drag — WebView2's OLE target on its child window is found first
     and the parent's shell registration is never consulted. The code is
     gone; the reasoning moved to the top of `shelf.rs`, where the working
     path lives. Three abandoned mechanisms are worth one paragraph and no
     lines of code.

### The palette (2026-09-14)

155. ⚠️ **It is not trying to be Flow Launcher, and should not.** Flow is
     a general launcher and is better at that job; duplicating it badly
     would be worse than having both. What this can do that Flow cannot is
     search the island's **own** world — the shelf, the live agent
     sessions, today's tasks, what is snoozed — and act on it in place.
     Complementary, not competing.
156. **Subsequence matching, not substring.** "agt" has to find "Agents" or
     the palette is a filter rather than a launcher, and the whole reason
     to type instead of clicking is that three letters get you there.
     `palette-match.ts` is pure and separate because a *mediocre* ranking
     still returns results — it never looks broken, it just quietly puts
     the thing you wanted third every time.
157. ⚠️ **The count of `<b>` elements is not the count of matched
     characters.** Consecutive hits are grouped into one run, so "agt"
     against "Agents" lights `Ag` and `t`: two elements, three letters. A
     test asserting the count fails for a highlighter that is working.
158. **The palette closes BEFORE the action runs.** Half of them open a
     screen, move a window or raise a terminal, and a palette still sitting
     over the result is something you have to dismiss to see what you asked
     for.
159. **The "add task" row needs three characters.** A create row on every
     stray keystroke turns a mistyped search into an accidental task. And
     it opens the composer with the words in rather than submitting: the
     composer is where a task gets its list and its day.
160. ⚠️ **The focus ring is suppressed on `.palette-field` and nowhere
     else.** The global rule draws an accent outline on any focused input,
     which is right for a form and wrong for a field that *is* the bar —
     it boxes the whole palette in green.
161. **Typing needs `surface.input(true)`, the same lift the composer uses.**
     The island is `WS_EX_NOACTIVATE` so that glancing at it never steals
     focus; a field takes that off for exactly as long as it holds the
     caret. The palette also pins first, because a panel that folds when
     the pointer wanders would take the caret with it.
162. ⚠️ **Not `Alt+Space`.** Flow Launcher, PowerToys Run and half the
     launchers on Windows claim it, and a global shortcut that silently
     fails to register is worse than an unfamiliar one. `Ctrl+Alt+K`.
163. ⚠️ **`set_shortcuts` takes the WHOLE set and registers all or
     none.** The editor's form sent two of six for several commits, which
     does not save part of it — the invoke fails outright on a missing
     argument, so saving a shortcut silently did nothing at all. The `KEYS`
     list in `task-editor.ts` is the one place that has to match the Rust
     struct.
164. ⚠️ **A slice-based deletion cut four listeners, not one.** Removing
     the dead `island:dropped` block by slicing to the next `  }` swallowed
     `island:shelved-failed`, `island:capture` and `tasks:placement` with
     it, and it was committed — quick capture stopped working and nothing
     failed. This is the same trap already recorded for `screen-media.ts`.
     **Delete by matching the whole block, never by slicing to the next
     closing brace.**
165. ⚠️ **`Ctrl+Alt` IS `AltGr`, and on a Polish layout that types
     letters.** Windows implements AltGr as left-Ctrl plus right-Alt, so an
     `AltGr+N` keystroke and a `Ctrl+Alt+N` hotkey are the same event — and
     registering the hotkey **takes the letter away everywhere on the
     machine**. `Ctrl+Alt+N` ate `ń` and `Ctrl+Alt+S` ate `ś`, with nothing
     connecting the two: what you experience is a keyboard that has stopped
     typing two characters. The Polish (programmers) layout maps AltGr to
     **A C E L N O S X Z**; `shortcuts::eats_a_letter` refuses all nine, a
     migration rewrites saved bindings off them, and the palette's row
     shortcuts are plain `Alt`+digit for the same reason.
166. ⚠️ **`overflow: hidden` on the island made it a SCROLL
     CONTAINER.** Its content is permanently wider than its box — the
     expanded panel is laid out at full size behind the collapsed pill — so
     anything that scrolls a descendant into view (a `focus()`, a
     `scrollIntoView`, Chromium's own scroll anchoring after a resize, or
     Playwright's click) moved the pill sideways. **The DOM denies it**:
     `left` still computes to `0px`, `offsetLeft` is still `0`, there is no
     transform, and only `getBoundingClientRect` disagrees — which is what
     made it take a day to find. `overflow: clip` clips identically without
     the scroll box.
167. ⚠️ **The island header does not fit on the left and right
     edges, and the overflow is INVISIBLE.** There the panel is capped by
     the shell's width (~388px, `islandBodyDepth`) while eight icon tabs
     plus four action buttons want ~460. A `.island-tabs` that refused to
     shrink pushed `.panel-actions` outside the island, where the clip
     erased it: pin, settings and collapse were simply absent on a
     vertically docked island. It arrived one tab and one button at a time,
     so no single change was big enough to notice. The strip now carries
     `flex: 1 1 auto; min-width: 0` and scrolls instead of pushing.
168. ⚠️ **A row that IS the answer must not be RANKED.** The arithmetic
     line was filtered out of its own query: `1900 * 56/117` has to
     subsequence-match `= 909.401709402`, which it does not, so the sum
     vanished and "Add task" took the top row. `Action.pinned` skips matching
     and sits first.
169. ⚠️ **Node strips TypeScript, it does not compile it.** A constructor
     parameter property (`constructor(private store: Store)`) is a hard
     `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` at import, and the whole test file
     fails to load with an error naming the syntax rather than the reason.
     `palette-calc.ts` and `palette-recent.ts` therefore write their fields
     out; files only the bundler sees may keep using them.
170. ⚠️ **`Path::join` on a bare drive is DRIVE-RELATIVE.** `Path::new("C:")
     .join("x")` is `C:x` — "x in whatever the current directory on C: is" —
     not `C:\x`. Everything reports the parent of a root-level item as exactly
     `C:`, so this is not a corner case but every hit at the top of a drive,
     and the two strings read identically. `everything::joined` puts the
     separator back. The live `#[ignore]`d test is what caught it; the unit
     tests could not have.
171. ⚠️ **Everything not running is not an error.** `FindWindowW` returns
     null and the search returns an empty list, because a row saying so in a
     palette that is mostly about the island's own world is noise ninety-nine
     times in a hundred.
172. ⚠️ **A late provider needs a generation counter.** Everything answers
     over IPC, so a reply for `no` can land after `notes` has been typed. The
     palette bumps `gen` on every keystroke and drops any answer carrying an
     old one — and holds the highlight by id across the late repaint, because
     rows appearing under the cursor is how a palette runs the wrong thing.
173. ⚠️ **`navigator.clipboard.writeText` does not work from the palette.**
     The caret is handed back before an action runs, and the web clipboard API
     rejects on an unfocused document — silently, in a promise nobody awaits.
     `shelf::copy_text` goes through Win32, which does not care who has focus.
174. ⚠️ **A fold has to close the palette.** The palette held the panel
     open through `editing`, which `input(true)` sets — but `input` can fail
     (Windows refuses the foreground) and `pinFor`'s timer expires either way.
     So the island could fold with the palette still `open`: the host was never
     hidden, the shortcut hit `show()`'s "already open" branch and did nothing,
     and hovering the island brought back a palette that had never been given
     the caret — visible, and impossible to type in or click. The fold callback
     is the one signal that covers every route into that state.
175. ⚠️ **The Start Menu IS the list of applications.** Windows has no API
     for it. Registry uninstall keys are a different set (they include things
     with no UI) and Store apps live somewhere else again; two `read_dir` walks
     of the Start Menu give the list a person would recognise. ⚠️ Filter the
     noise: every vendor ships "Uninstall X", "X Website" and "X Help" beside
     the thing you wanted.
176. ⚠️ **`biHeight` must be NEGATIVE when reading an icon's pixels.** A DIB
     is bottom-up by default, so a positive height hands back an upside-down
     icon — and it reads as a rendering bug three files away from the cause.
177. ⚠️ **An old icon's 32-bit DIB carries no alpha at all.** Every pixel
     comes back fully transparent and the row draws blank. The AND mask is what
     says which pixels are there (1 means transparent); `apps::art::alpha_from`
     rebuilds the channel from it.
178. ⚠️ **Both Start Menus carry the same shortcut** for anything installed
     for all users, so without a dedupe every such app is offered twice and the
     two rows are indistinguishable.
179. ⚠️ **Rank wide, band, then cut.** Cutting to the visible rows before
     the band sort lets a page of file hits push every app off the end — and
     the band is then sorting a list the files have already won.
180. ⚠️ **A band must not be a sort key.** As a hard order it put "Hide
     the chrome" above a folder actually called `hero`, because the island band
     outranked the file band and nothing about match quality could get past it.
     Bands add points now; the quality signals in `palette-match` (EXACT 400,
     PREFIX 150, INITIALS 110, RUNON 80) are deliberately large enough to cross
     one.
181. ⚠️ **A row built out of the query cannot be RANKED against the
     query.** `Add task "agt"` contains `agt` verbatim, so it collected the
     substring bonus on every query it ever appeared for and outranked Agents
     for its own initials. `TIER.offer` sinks it; the arithmetic line sidesteps
     the same trap by being `pinned`.
182. ⚠️ **Quality bonuses go on AFTER the length normalisation.** They say
     what kind of match this is, and that does not become less true because the
     title is long — diluting them is what let a short accidental match outrank
     a deliberate one.
183. ⚠️ **Hold the highlight only when it was moved on purpose.** Held
     unconditionally across a late re-rank, a file hit that ranks first leaves
     the selection on whatever the synchronous pass put at the top — so `hero`
     is drawn first and Enter runs "Hide the chrome". Same wrongness as the
     bands, by a different route.
184. ⚠️ **A star stores a SNAPSHOT, not an id.** It has to appear in the
     empty palette, and nothing enumerates the disk or the applications on an
     empty query — with only an id there would be nothing to draw, and a
     starred folder would sit in the file and show up nowhere. The snapshot is
     also what makes a starred file survive Everything being closed. Dedupe by
     id in `query()` keeps the live row when there is one; the starred provider
     is registered LAST for exactly that.
185. ⚠️ **A scope prefix must LEAVE the field.** Left in the text, the
     matcher would have to know to skip it, every provider would see it, and
     backspacing over it would silently change what the results mean with
     nothing on screen having moved.
186. ⚠️ **`.catch(() => {})` on a palette action swallows the only report
     there is.** The palette closes before the action runs, so a failure has
     nowhere to show itself — a moved file, a stale shortcut and an exited
     session all did nothing and said nothing. Actions return their promise now
     and `Palette.pick` routes the throw to the pill.
187. ⚠️ **The elevation recipe is FOUR parts and all four carry weight.**
     `--hairline` (an inset ring, so the edge exists without a border eating a
     pixel), `--gloss` (one lit top line, which is the whole of what gives the
     light a direction), `--sheen` (a fall-off, always a background-*image* so
     it layers over a colour instead of replacing it), and `--lift-*` — **two**
     shadows: a tight contact one that reads as thickness and a wide soft one
     that reads as distance. Drop either shadow and it flattens.
188. ⚠️ **Anything that RECEIVES input is sunk; anything that IS an object
     is raised.** One rule, and it is what keeps the surface legible once
     everything has depth — the tab rail, the palette bar and every field go
     below the panel; tiles, chips and the selected row go above it.
189. ⚠️ **Elevation is spent, not sprinkled.** Only the selected palette row
     is an object. Lifting all eight would flatten the hierarchy the lift exists
     to create, which is the same mistake as giving every `button` a face — most
     buttons in this app are text, not objects, which is why `.raised` is opt-in
     rather than the base.
190. ⚠️ **A coloured glow stops reading as light and starts reading as a
     halo.** The accent button shipped at `0 8px 20px -8px rgba(0,255,136,.55)`
     in the first pass and wore a green corona a third of its own width.
     `--glow-accent` is a third of that. It says "this one is live"; it is not
     meant to be seen on its own.
191. ⚠️ **One press value across the surface.** It was `.92` on icon
     buttons, `.92` on the transport, `.97` on a capsule and `.96` on the rest —
     four different presses on one screen, which reads as "off" without being
     nameable. `scale(.96)`, retimed to **90ms**: inheriting the 150ms hover
     duration means the press lands after the finger has left.
192. ⚠️ **`max-width: fit-content` alongside `flex: 1 1 auto` on the tab
     rail.** The header is the flex line, so a sunk rail without the cap
     stretches its trough across every empty pixel and reads as a wide grey bar
     with the tabs at one end — while dropping the flex takes back the shrinking
     that keeps `.panel-actions` inside the island on a vertical edge (trap 167).
193. ⚠️ **`paintIcon` animates a REPLACEMENT, never a first paint.**
     Animating the first one turns every screen switch into thirty icons popping
     in at once. It is an enter (scale .25→1, opacity 0→1, blur 4px→0) rather
     than a cross-fade on purpose: a true cross-fade needs both icons absolutely
     positioned over each other, and every icon host in this app sizes itself
     off its SVG.
194. ⚠️ **The island's SHAPE is not part of any of this.** `notchPath()`
     writes an SVG path every frame from one spring, and `#island` can carry no
     drop shadow at all — a filter is applied before clipping, so it would be
     drawn round the rectangle and then cut away. Elevation on this surface is
     something the contents have, never the shape.
195. ⚠️ **A second block that re-states selectors an earlier block owns is a
     cascade collision waiting to happen.** The iOS pass kept its own
     `.island-tab[aria-selected=true] { background: var(--tile-on) }` several
     hundred lines below the tab rules — equal specificity, later in the file,
     so it won on order alone and the strip kept its flat look while everything
     round it changed. Nothing errored; the tabs just quietly stayed behind.
     **Style each thing once, where it is defined.**
196. ⚠️ **The tab pill TRAVELS, and its geometry is computed rather than
     measured.** At the moment of a click every width on the strip is
     mid-transition, so reading one gives a target that was true a frame ago —
     the pill would still glide, just never quite onto anything. `tabWidth()`
     derives it from the label's `scrollWidth`, which reports full text width
     whatever the animated `max-width` is, and the position is summed from the
     left because the tab being LEFT is shrinking as the placement runs.
197. ⚠️ **Only the pill is painted, never the selected tab as well.**
     Painting both lights the new tab instantly while the pill is still
     travelling, so there are two selections on screen for a quarter of a
     second on every switch.
198. ⚠️ **The caption's `max-width` is set per label, in JS.** One shared
     value big enough for the longest caption means every shorter one reaches
     full size early and stops — the easing is truncated and the label lands
     before the pill does. And the icon-to-caption gap is a `margin`, not flex
     `gap`: gap applies to a zero-width item just the same, so every icon-only
     tab would carry 7px it shows nothing in.
199. ⚠️ **`backdrop-filter` on a child of `#island` blurs the ISLAND, not the
     desktop.** The island is solid black and is what the transparency stops
     at, so the palette's blur was sampling the tab strip and the open screen
     and smearing them through its own surface — two stacked surfaces where
     there should be one. Same trap the iOS-pass note already warned about, made
     again. The palette is opaque now, and the layers behind it are hidden.
200. ⚠️ **Hide them with `visibility`, never `display`.** The tab strip has
     to keep its layout while out of sight: the travelling pill is placed from
     the tabs' measured widths (trap 196), and a strip at `display:none`
     measures zero — the pill would be rebuilt at width 0 the moment the palette
     opened and stay there until the next click. The island's own height is
     measured from the active screen for the same reason.
201. ⚠️ **The player raises no tab dot.** A dot means "this screen has
     something you have not seen", and the track is already named on the pill
     with its equaliser running — the same claim twice. It would also land on
     Home, the default screen, which is the one place a dot says least.
202. ⚠️ **A "what it is doing" phrase must be CLEARED when the turn ends.**
     The transcript goes quiet the moment a tool call is answered, so the last
     one seen outlives the run that made it — a row still reading "editing
     palette.ts" is a status that WAS true, which is worse than no status. It is
     cleared by a turn-ending record in `scan`, and gated on `Working` again in
     the view.
203. ⚠️ **The LAST `tool_use` in an assistant block, not the first.** One
     turn can carry several calls, and the last written is the one in flight.
204. ⚠️ **An unknown tool still says something.** The set grows — an MCP
     server adds its own — and a session that went blank because `phrase()` had
     no branch for `mcp__figma__get_design_context` would look exactly like one
     that had stopped. Unknown names fall back to the tool's own name.
205. ⚠️ **Working with no phrase is CORRECT, not a bug.** After a prompt goes
     in and before the first tool call the model is thinking and there is
     nothing to name — which is why the row falls back to the state word rather
     than showing an empty line. Confirmed against the real transcripts.
206. ⚠️ **A run's cost is a DELTA, never the session's total.**
     `Tracked.usage` climbs for the life of the session, so filing that against
     one run counts every earlier run again — the day's total would grow
     quadratically while looking entirely plausible. `usage_at_start` is taken
     when the run begins rather than by subtracting the previous run
     afterwards, because a session can be dropped and re-tracked between runs,
     which resets the counter.
207. ⚠️ **A project that spent nothing is DROPPED, not shown as zero.** Runs
     recorded before tokens were counted carry neither field, and a fortnight of
     those — named, ordered, every one reading `0` — looks like the feature is
     broken rather than like the history predates it.
208. ⚠️ **A bar whose width is `NaN%` renders at FULL width.** Dividing by a
     zero total makes the emptiest possible day look like the busiest, in
     silence. `spend.share()` returns 0 for an empty whole, and the bars have a
     4% floor so a small share reads as "a little" rather than "nothing".
209. ⚠️ **New fields on `runlog::Run` need `serde(default)`.** The file holds
     two weeks of history and a parse error throws all of it away to add one
     column.
210. ⚠️ **A query scope must not reach into a sub-menu.** The scope narrows
     the top-level search; the verbs inside a Tab menu carry no band of their
     own, so they all default to `island` — and an `a ` scope filtered out every
     row of the menu it had just opened. Caught by the workspace test, not by
     review.
211. ⚠️ **A workspace has no editor, on purpose.** A screen with a folder
     picker and an app list is a form to fill in before the feature does
     anything, which is how a feature like this gets used once. They are built
     from rows that are already on screen — a live session already carries its
     own `cwd`, and an application is filed into one from the row that launches
     it.
212. ⚠️ **The FOLDER is the workspace's id, never the project name.** Two
     checkouts of the same repo have the same name and are not the same
     workspace — and keying on the folder is also what makes "save this session
     as a workspace" idempotent however many times it is pressed.
213. ⚠️ **`open_workspace` collects every failure rather than returning the
     first.** A workspace is several things; an editor that would not start is
     no reason to leave the browser and the folder unopened, and "3 opened, 1
     would not" is a more useful answer than one error message.
214. ⚠️ **The panel's SIZE is sprung, not set.** `depth` and `body` are
     recomputed on every screen change, and writing them into the geometry made
     the island snap to the new screen's height while its contents were still
     fading in — the one motion on the surface with no easing at all. Damped
     harder than the fold (0.9 vs 0.78): the fold is a panel arriving and can
     afford overshoot, this is a panel already on screen changing size under the
     cursor, where overshoot reads as a wobble.
215. ⚠️ **Snap the size while the island is CLOSED.** A size change nobody
     is looking at must not animate — the spring would spend its travel behind a
     collapsed pill and the panel would then open at whatever size it had
     reached, a different wrong size every time.
216. ⚠️ **`tick()` must watch all three springs.** A size change can outlast
     the opening; stopping on the fold alone leaves the panel frozen mid-resize.
217. ⚠️ **The leaving screen goes ABSOLUTE for its exit.** Left in flow it
     still claims height, so the panel holds the taller of the two screens until
     the exit finishes and then drops — a lurch at the end of every switch. Out
     of flow, the arriving screen alone sets the height.
218. ⚠️ **A sprung height means tests must POLL geometry.** At the moment a
     height first exceeds its old value the island is still travelling, so
     anything measured once is measured mid-flight. Two existing tests asserted
     on the first frame and only one of them failed — the other was passing by
     luck.
219. ⚠️ **`grid-template-rows: 0fr -> 1fr` nested inside a grid ITEM lies
     about its intrinsic height.** The outer row came out 50px shorter than the
     open pill and the list drew straight over the pill below it. That trick is
     right when the content height is unknown and the parent is not a grid; here
     a `max-height` is honest, because the list has a deliberate cap.
220. ⚠️ **Set an expanded list's height AT RENDER TIME, not in a
     `requestAnimationFrame`.** The island measures the screen's content the
     moment `render()` returns — a height applied a frame later is a height the
     panel never saw, so the list opened correctly and the panel stayed short
     around it, clipping a third of it.
221. ⚠️ **In a flex COLUMN, `align-self` is the horizontal axis.** Carried
     over from when the pills were grid items, `align-self: start` shrank every
     pill to the width of its own text and left the column half empty.
222. ⚠️ **A pill's mark says what the PILL is, never what the device is.**
     With the tile headings gone it is the only thing telling Output from
     Bluetooth, and a pair of bluetooth buds made both pills show the same
     glyph — two rows that read as the same control twice.
223. ⚠️ **A menu must not hang off the control that opens it when both are
     `<button>`s.** `.chip-menu` was appended to the chip, so every option was a
     button inside a button — invalid HTML, and the live consequence was that a
     press on an option bubbled to the chip and re-opened the menu it had just
     chosen from. It hangs off the chips container now.
224. ⚠️ **A dismiss-on-press handler has to TEST the press.** Registered as
     a blanket `once` listener it tore the option down before that option's own
     click could land, and the click then fell through to whatever was
     underneath. Same shape as the palette's `outside`.
225. ⚠️ **The Open/Done count comes from the draw, not from a second
     filter.** A switch counted separately from the list it switches disagrees
     with it the moment either rule changes — a task held back for its
     completion animation is finished by one count and not the other, which is a
     "Done 1" tab leading to an empty list. `renderDay` returns its own split.
226. ⚠️ **The two halves are exclusive.** Drawing the open list underneath
     the finished one makes "Done" an addition to the day rather than a view of
     it — which is the drawer this replaced, wearing a tab.
227. ⚠️ **A footer is where a thing goes to not be read.** Every screen had
     grown one — a sync line, a sentence about dragging, a "Clear all" — each a
     row of 10px grey text at the foot of the panel, and each breaking the
     bottom padding it sat inside so no two screens ended the same way. They are
     tools in the header now: an instruction behind a `?`, an action as a
     button. `screen-tools.ts` is the one place that draws them.
228. ⚠️ **One padding value for the sides and the bottom of every screen.**
     It was 14/12 on `.screen-body` and 16/14 on the bento, with a footer row
     inside making the gap under the last thing different again per screen.
     `--screen-pad`.
229. ⚠️ **A second `box-shadow` on the same rule silently replaces the
     first.** `.cal-next` carried its coloured strip that way and threw the
     whole elevation recipe away with it — the rule above it looked correct and
     did nothing.
230. ⚠️ **Tint the card, never stripe it.** A 3px coloured rail down a dark
     card is the shape every generated calendar has, and it says nothing the
     card's own colour cannot. `color-mix` against the tile rather than a flat
     alpha, so a pale calendar and a dark one land at the same weight.
231. ⚠️ **An event opens into a PANEL, not a row that grows.** The detail is
     five lines; growing a row by that much pushes every event under it down the
     screen, so the thing being read moves while it is read. Anchored to the
     screen rather than the row, or an event near the bottom opens a panel half
     off the island.
232. ⚠️ **`measure()` must count MARGINS, not just `offsetHeight`.** The
     agents, shelf and calendar lists all space themselves with
     `.row + .row { margin-top }`, so a five-row list was measured about thirty
     pixels short and the screen opened already scrolled — which reads as cut
     off rather than as long. Its own padding counts too.
233. ⚠️ **A wheel has to be GATHERED before it switches screens.** A trackpad
     sends a stream of 2-4px deltas, so acting on the first one made a screen
     change out of a thumb resting on the pad. 90px one way inside 400ms; a run
     that stalls or reverses starts over.
234. ⚠️ **Screen tools go at the RIGHT-hand end of the header.** Left where
     they fell after the tab strip they read as orphans — two glyphs adrift in
     the middle with space on both sides and nothing saying what they belonged
     to. `margin-left: auto` puts them with the pin, the settings and the close.
235. ⚠️ **`.home-sec` is a flex ROW.** Appending a second child to a Home
     column makes it a second column: the add row took its half and squeezed
     every task title to zero width while leaving the checkboxes and the chip
     exactly where they were, which looks like missing text rather than a
     layout fault.
236. ⚠️ **A taller panel invalidates every fixed "move away" point in the
     tests.** A full day is 436px now, so `mouse.move(0, 400)` — written when
     the panel capped at ~330 — lands INSIDE the island and the pointer never
     leaves. Measure the box.
237. ⚠️ **Nothing scrolls at rest any more,** so a test about wheeling over a
     scroller has to make one. A wheel over a list with nothing to scroll
     correctly falls through to changing screens.
238. ⚠️ **The bottom gap was the padding, twice.** `natural()` counts the
     scroller's own padding now, so the `cardPadding` the depth formula added on
     top of it spent that gap a second time — about 30px under the last row of
     every screen, which is exactly why the bottom looked nothing like the
     sides. The formula adds nothing now.
239. ⚠️ **A child that CLIPS its own content contributes the content, not the
     box.** Home's three cards are stretched to each other's height by the grid,
     so the tallest one's list can overflow it by a row — and a union of the
     boxes then measures the panel short and clips the last row.
240. ⚠️ **A hover has to lead somewhere.** Every Home card lit up under the
     pointer while only a 15px arrow in its corner did anything, and the player
     — which has no screen behind it at all — was making the same promise. The
     whole card opens its screen now, `can-open` gates the hover, and anything
     that is itself a control keeps its own press.
241. ⚠️ **A row and the row that adds one are the same shape.** Home's add row
     was a button with its own padding under task rows carrying NEGATIVE
     margins: three checkboxes at one inset, a plus at another, three different
     row heights. One padding, one radius, one circle size.
242. ⚠️ **A dangling selector list joins itself to the next rule.** A regex
     that deleted `#sync-line[^
]*` took the `{ background:transparent; }` off
     `.day-row .task-title:active,.day-sub:active,` and left the trailing
     comma, which silently welded it to the `.eyebrow` rule hundreds of lines
     of comment later — so pressing a day row made it grey and 11px. Valid CSS,
     no warning anywhere.
243. ⚠️ **`.switch` (0,1,0) loses to `input[type=checkbox]` (0,1,1).** The
     island already sizes every checkbox to 14px, so a restyled toggle came out
     as a 14px square with a 16px thumb hanging off it. Where two rules must
     both exist, the later one has to be able to WIN — qualify it.
244. ⚠️ **`.set-row.stack input:not([type=checkbox])` is (0,3,1)** and beat
     the colour well's own `input[type=color]` rule, stretching a 24px swatch
     into a 185px lozenge. A `:not()` carries the specificity of what is inside
     it.
245. ⚠️ **A pane that arrives on an animation screenshots as an empty
     pane.** Playwright does not wait for CSS animations, so a shot taken on the
     click catches opacity 0 and looks exactly like a page that rendered
     nothing. Poll the opacity first.
246. ⚠️ **An "enabled" list cannot say "none".** Empty has to mean "all" for
     an older file to behave, so switching the last module off switched them all
     back on. Store what is MUTED.
247. ⚠️ **A setting with nothing on the other end of it is worse than no
     setting.** `week_starts_monday` was written, validated, persisted and
     rendered — and neither week on the island is week-aligned, so it could
     never have changed a pixel. It is gone; the doc comment says why, so it is
     not added back.
248. ⚠️ **A preview stub is code that can rot.** `get_shortcuts` answered
     with three of six keys and a stale `Ctrl+Alt+N` for capture — the exact
     AltGr combination the defaults moved away from months ago. The settings
     window's AltGr guard is what found it, by warning about a shortcut no build
     has shipped.
249. ⚠️ **Two settings windows is how a setting ends up in neither.** It
     went wherever the person adding it happened to have open. One window, one
     tray item, one gear — and `open_settings` is now a second door to the same
     window rather than a second window.
250. ⚠️ **A preference read after the thing that uses it is a preference
     that does nothing on the first run.** `indexApps` is checked while the
     Start Menu index is BUILT, so reading prefs later in `boot()` walked the
     Start Menu on every launch whatever it said. The accent is the same shape
     of bug one frame wide: read first, apply, then paint.
251. ⚠️ **`matchMedia(...).matches` cached in a field is a preference that
     needs a restart.** Both the island and Today held one, so "never animate"
     would have taken effect next launch. `motion-pref.ts` answers live, and the
     stylesheet reads the same three states off `<html>` — including the case
     the media query cannot express, which is overriding it the OTHER way.
252. ⚠️ **Removing a control removes its test's only route.** Three island
     tests drove the edge, the clock and un-snoozing through the gear popover.
     The clock and the snooze have palette commands that still exist; the edge
     has nothing on the island at all any more, so the preview stages it from
     the query string — which also covers BOOTING on each edge rather than only
     arriving there.
253. ⚠️ **A scroller's children legitimately report rects outside their
     box.** The "header controls stay inside the island" check asserted over
     every descendant of `.island-head`; on a vertical edge the 7-tab strip is a
     112px horizontal scroller, so a scrolled-out tab fails a test that was
     written about `.panel-actions`.
254. ⚠️ **A chip's count has to be rows, not tasks.** The day folds subtasks
     into their parent, so counting tasks puts `7` on a chip that opens three
     rows — and the count is the half of a filter you believe. `listTally`
     counts roots, and the browser test compares against
     `#task-list-content > .slot`, never `.day-row`, which matches nested rows
     too.
255. ⚠️ **The chosen chip has to survive its own filter emptying the day.**
     Drawing the rail from "lists that have rows" makes the active chip vanish
     the moment you finish the last task in it — leaving an empty day, no
     explanation, and no way back but guessing. It is pushed back in, and the
     rail stays up whenever a filter is set even below two lists.
256. ⚠️ **Scope has to follow whether the control can name itself.** The
     Today header sits directly above the rows it counts, so it follows the
     list filter and prints the list's name beside the number; the resting pill
     has no room to say "of Work", so it keeps counting the whole day. Home
     follows the filter because its card is a door into the filtered screen.
     Three different answers, one rule.
257. ⚠️ **One variable has to BE one variable.** The accent became settable
     while thirty-two declarations still said `#00ff88`, `#22ff9a` or
     `rgba(0,255,136,…)`, so a purple accent bought a purple tab strip and left
     green hovers, a green today-cell on Home and a green focus ring — which
     reads as a half-finished theme rather than as a setting that did not take.
     Every one is `color-mix(in srgb, var(--accent) N%, …)` now, and the hover
     and the ink are DERIVED (`--accent-hi`, `--on-accent`) rather than stored:
     a hover colour the user also has to pick is two settings for one decision,
     and the pair can be set to disagree.
258. ⚠️ **Auditing a theme by eye is what misses it.** The test sets a
     different accent and then walks every element's computed
     background/color/border/shadow for the default green, rather than checking
     a list of the places that happened to be wrong. ⚠️ It has to set a
     non-default accent first, or the default IS that green and the check
     passes on a sheet with none of the work done.
259. ⚠️ **Not every green is the accent.** `--good` (a "connected" dot) and the
     usage notch's `--ample` are traffic lights; a traffic light that turns
     purple because somebody liked purple has stopped being one. They are
     deliberately left alone — `--good` is now a token so the next person can
     see the decision rather than re-derive it.
260. ⚠️ **Open and close both await Rust, so they can run over each other.**
     `set_task_input` lifts and restores `WS_EX_NOACTIVATE` and `grab()` spends
     up to fifteen frames asking for the caret — a quarter of a second in which
     a second press, a click outside or a fold can arrive. Whichever FINISHED
     last decided what the native side believed: an `input(true)` landing after
     an `input(false)` leaves the island in editing mode with no palette on
     screen, and `editing` blocks folding, so the panel is stuck open with no
     visible reason. Every entry point queues on one chain now. ⚠️ The chain
     must not stay rejected, or every later press is dropped.
261. ⚠️ **The preview cannot reproduce that race,** and the test says so. Its
     `set_task_input` returns immediately and `grab()` wins on the first frame,
     so removing the queue leaves the test green — checked, and written down in
     the test rather than left to look like coverage.
262. ⚠️ **The header button cannot stand in for the global shortcut.** Opening
     the palette takes the panel behind it out of sight, header included —
     which is precisely why the shortcut has to close it — so the browser test
     needs a key. `island:palette` is a native event, so the island answers
     Ctrl+K itself under `preview`.
263. ⚠️ **`show_chrome`, never `toggle_chrome`.** Something that needs the
     island on screen has to be able to say so; a caller toggling from its own
     idea of the state hides the island half the time. Asking for the palette
     while everything is hidden is asking for the app back — opening it behind
     a hidden island is a shortcut that does nothing whatsoever.
264. ⚠️ **`openOnHover` only ever stopped the OPENING.** The fold timer was
     armed on every `hover(false)` whatever the preference said, so click mode
     still shut the panel the moment the pointer wandered off — which is the one
     thing somebody turning hover off is trying to stop. Half a mode reads as a
     broken setting, not as a missing feature.
265. ⚠️ **A click outside the island cannot be seen by the island.** It is
     `WS_EX_TRANSPARENT` everywhere it is not painted, so the click goes to
     whatever is behind and the page's own `pointerdown` never fires. It is
     watched from `hover.rs`'s existing poll with `GetAsyncKeyState`, on the
     button-down TRANSITION — held down, the state would fire ten times a second
     and the second one would land on an island that had already closed. Not a
     `WH_MOUSE_LL` hook: that runs on every mouse message on the machine.
266. ⚠️ **A plain toggle on the pill is wrong in hover mode.** The pointer has
     already opened the panel before a click can land, so "press the pill to
     close" becomes "point at it, it opens, press it, it shuts". The toggle is
     gated on click mode; the original `if (!open)` guard existed for this.
267. ⚠️ **Press-scale goes on `scale`, never `transform`.** `#island`'s
     transform is spent on the hide/reveal slide and would have to restate the
     translate for all four edges; `.island-tab`'s is rewritten every frame by
     `placeGlide`. The independent `scale` property composes with both.
     ⚠️ And its origin is the EDGE: scaling a shape welded to the top of the
     screen about its middle lifts it off the bezel.
268. ⚠️ **A second `transition` rule for the same element silently drops the
     properties the other one listed.** The press-scale was declared beside the
     press, 600 lines before the hide/reveal block that already owned
     `#island`'s transition — so the later rule won and `scale` animated not at
     all. Style each thing once, where it is defined. (`.day-row:hover` was
     written out twice as well; the copy is gone.)
269. ⚠️ **The bounce belongs to the INTENT, not to the call site.** A size
     change you asked for (a tab press) can overshoot; one under a still
     pointer (a list gained a row) must not, or the row you were about to press
     moves out from under you. `deliberately()` arms the next measure and
     `measure()` consumes it — a flag rather than a parameter, because the
     measure that matters is the one at the END of the render, not the one the
     caller makes.
270. ⚠️ **`Spring.retune()` keeps the velocity.** It is called mid-flight;
     zeroing there stops the panel dead and starts again, which is the one
     thing a spring exists to make impossible.
271. ⚠️ **Per-screen widths make "about 910px" false everywhere.** A test
     asserting the palette is `full - 100` narrower broke the moment a screen
     was narrower than that; it derives the expected width from `FRAME` now.
     ⚠️ And `capBody(0)` means "the full body", so the palette handing back a
     zero left the island stuck at its widest over a narrow screen.
272. ⚠️ **`getDay()` is 0 for SUNDAY**, so Monday-first is `(day + 6) % 7` days
     back, never `day - 1` — which is `-1` on a Sunday and walks the week
     FORWARD into one that has not happened. Both week views are aligned now,
     which is also why `week_starts_monday` came back: it finally has something
     on the other end of it.
273. ⚠️ **A preference has to repaint the screens, not only the pill.**
     `applyPrefs` called `paintPill()` alone, so the week strip and the calendar
     grid kept the old first day until something unrelated redrew them.
274. ⚠️ **Spotify matches the redirect URI character for character, port
     included.** Google accepts any loopback port and `calendar.rs` binds
     `127.0.0.1:0`; copying that pattern gets `INVALID_CLIENT: Invalid redirect
     URI`, which reads like a bad client id and sends you looking in the wrong
     place. The port is fixed (5733), it is one constant shared by the auth URL
     and the string the settings window tells you to register, and a test
     asserts they are the same one. `127.0.0.1`, never `localhost`.
275. ⚠️ **PKCE, so there is no client secret to keep.** A desktop app cannot
     hold one, and it halves what the user has to paste.
276. ⚠️ **`/me/player/queue` answers 204 with NO BODY** when nothing is
     playing. Parsing that as JSON turned an ordinary paused Spotify into a red
     error across the screen. 403 (the account will not share it) and every
     other status are answers too — the command returns a `note`, never an
     `Err`, because a rejected promise in the island is a banner and "Spotify is
     not playing on any device" is not an error.
277. ⚠️ **Spotify rotates the refresh token on some responses and omits it on
     others.** Keeping the old one when a new one arrives is how a connection
     works for weeks and then stops for no visible reason.
278. ⚠️ **Album art comes largest-first, so the thumbnail is the LAST entry.**
     A queue of twenty 640px covers is megabytes fetched to draw them at 34px.
279. ⚠️ **Do not invent the badges.** The reference shows "E" and "L"
     (explicit, lyrics); Windows' transport session carries neither flag and
     Spotify is not the source for the player. The slot holds the SOURCE
     instead, which is a real fact. A badge that is always on is decoration
     claiming to be data.
280. ⚠️ **A screen body needs `scrolls` or `spans`, or the panel measures the
     wrong height.** `natural()` falls back to `offsetHeight` for anything else,
     and a `flex:1` body reports whatever the flex gave it — which is the
     PREVIOUS screen's height. The player came out flush against the header
     with its queue heading clipped off the top, which looks like a padding bug
     and is a measurement one.
281. ⚠️ **`measure()` clamps the cap to `islandBodyLong`,** so asking for a
     width above it is silently the same as asking for the width at it — which
     from a test looks exactly like the width not changing at all. The open
     queue asks for `FRAME.islandBodyLong`, not a bigger number.
282. ⚠️ **A sprung width cannot be sampled on the frame it was asked for.**
     The test polls until the width stops moving before comparing; a
     measurement taken on the click is some arbitrary point on the way there,
     and every comparison against it is then meaningless.
283. ⚠️ **Spotify cannot reorder its own queue, and neither can we.** The Web
     API has no endpoint for moving, removing or inserting a queued item;
     `POST /me/player/queue` appends and that is the whole surface. Playlists
     can be reordered, the queue cannot. Do not build the drag handle.
284. ⚠️ **Adding a scope invalidates the grant already stored.** The old token
     keeps working for reads and answers 403 for the write, which reads as a
     Premium problem rather than a stale consent. The error says so by name.
     ⚠️ And the scope list is SPACE-separated; a comma silently grants nothing.
285. ⚠️ **Cap the list, not the panel.** A Spotify queue is routinely twenty
     rows and the island would grow to the height of a window. The `max-height`
     has to sit on the scroller itself: `natural()` adds a clipping child's
     hidden content back into the measurement and walks the grid's DIRECT
     children, so an overflow one level up measures the full list again.
     ⚠️ A fixture of exactly three tracks proves nothing about a cap of three.
286. ⚠️ **A spring settles within 0.01 of its target, which rounds either
     way.** A test asserting a width comes back exactly equal after a round
     trip fails by one pixel, at random. Compare with a tolerance.
287. ⚠️ **A bezier is not a spring.** Droppy's timings (560ms
     `cubic-bezier(0.32,1.22,0.36,1)` for size, 460ms
     `cubic-bezier(0.3,1.6,0.4,1)` for the fold) transfer as a SHAPE, not as
     numbers: `response` is the period, so the duration carries over, and a
     control point above 1 means damping below ~0.7. Copying the numbers into
     a spring means nothing.
288. ⚠️ **A transition needs both states to be the same SHAPE.** The queue
     column went `minmax(0,1fr) 0fr` → `minmax(0,1.35fr) minmax(0,1fr)`: two
     different value types on both tracks, which cannot be interpolated, so it
     jumped. Both sides are `minmax()` then a length now.
289. ⚠️ **And the element has to exist on both sides of it.** The panel was
     appended only while open, so on the way in it arrived at full size in the
     same frame the column was told to grow, and on the way out it was gone
     before the column could shrink. It is always in the DOM; the column opens
     and closes, the panel is clipped by it, and `inert` + `aria-hidden` keep a
     closed panel out of Tab order.
290. ⚠️ **A fraction chases a moving target.** `0fr → 1fr` interpolates, but
     what a fraction RESOLVES to depends on the island's own width — which is
     springing at the same time — so the column arrives at a different speed
     from the shape carrying it. A fixed length, and an island that grows by
     exactly that length plus the gap, leaves the other column standing still.
291. ⚠️ **Content in an animating track must be a fixed width.** Left to fill
     the column, three track titles re-wrap through eight line-breaks each on
     the way in and out, which reads as a glitch rather than as a panel
     arriving. Fixed width inside an `overflow:hidden` track, so it slides.
292. ⚠️ **The panel's contents were at their FINAL size and offset on frame
     one.** `measure()` sizes `#island-expanded` to the target body — correctly,
     because that is the width the content has to be measured at — and nothing
     ever resized it again, so only the black shape animated and everything
     inside it snapped. That is what "the animation is glitchy" was: not the
     queue, the whole panel. `paint()` now sizes the layer from the sprung
     value every frame; `measure()` still sets the target, and the two are not
     in conflict — one is the question, the other is the answer arriving.
293. ⚠️ **A `1fr` track re-lays out its contents on every frame of a spring.**
     The player was sized by whatever the queue left over, and its transport row
     is `space-between` — so the buttons crawled apart and back together for the
     whole 560ms. Both tracks are fixed lengths now: the player cannot change
     size, so nothing inside it can move relative to anything else inside it.
294. ⚠️ **The island is CENTRED on its edge** (`(shell - width) / 2`), so a
     fixed-width column pinned to its left edge slides outward as the island
     grows — which is the whole effect, and it is free. Nothing animates the
     player's position; it rides the shape.
295. ⚠️ **Endpoints agree even when the middle is wrong.** Every version of
     this passed a test that checked the closed state and the open state. The
     test samples the frames in between now and asserts two things about them:
     the player's width never changes, and its left edge does.
296. ⚠️ **ISO week 1 is the week containing the first THURSDAY**, not the week
     containing 1 January. `(dayOfYear / 7) + 1` gets 2027-01-01 wrong by 53
     weeks, and nobody notices until January. `isoWeek` moves to the week's
     Thursday and counts from the 4th of that Thursday's year. ⚠️ And the count
     is ROUNDED, not floored: both ends are local midnight, so a DST change
     between them leaves the difference an hour short of whole days.
297. ⚠️ **ISO weeks always start on Monday, whatever the week-start
     preference says.** The preference decides which column a day is drawn in;
     the NUMBER is a fixed international definition, and a "wk. 28" that moved
     when somebody changed a setting is a different thing wearing the label.
298. ⚠️ **Six rows in the month grid, always.** "As many as this month needs"
     is five in November and six in December, so the panel's height changes
     every time you page and the agenda beside it jumps with it.
299. ⚠️ **A block's second line is gated on PIXELS, not on hours.** An hour is
     22px in the week grid and two lines of type need ~34, so "an hour is long
     enough for a time" put a second line into a block that could not hold the
     first — and the title was clipped away, leaving a meeting labelled only
     with its start time.
300. ⚠️ **Two fields cannot answer to one label.** The calendar's New Task
     field was `aria-label="Task name"`, which Today's composer already carries,
     and both are in the DOM at once — ambiguous for a screen reader and for
     anything driving the page.
301. ⚠️ **`scrollIntoView` on a node that is not in the document yet does
     nothing, silently.** Choosing a day scrolls the agenda to it, and the
     heading only exists once the render has appended it — so the scroll is
     queued for the frame after.
302. ⚠️ **A field on the island cannot be typed into until NOACTIVATE is
     lifted.** The calendar's New Task popover called `focus()` and nothing
     else, so the caret was in the island and every keystroke went to the
     window behind it — a field you can see, click, and not type in. The lift is
     a round trip (`set_task_input`) and has to be AWAITED before the focus.
     Today's composer has done this for ages; anything new that takes text has
     to do it too, and hand the keyboard back on close or the island cannot
     fold.
303. ⚠️ **Scroll to the nearest heading AT OR AFTER the day, not the day's
     own.** Most days have nothing on them, so most clicks have no heading — and
     looking one up by date did nothing at all on those days, which is
     indistinguishable from the click not registering. ⚠️ And scroll by
     arithmetic: the headings are sticky, so `scrollIntoView` considers one
     already in view when it is stuck to the top over a different day, and does
     not move.
304. ⚠️ **Scrolling on a flag set for ONE render, never on the state itself.**
     Keyed on `chosenDay`, every unrelated redraw — a minute ticking over, a
     task completing — dragged the agenda back to it while you were reading
     something else.
305. ⚠️ **Mixing a tint into `--tile` washes the hue out.** `--tile` is white
     at 5.5%, so a purple event and a green one came out the same grey-with-a-
     hint at a glance — which is the one thing the colour is there to stop.
     Mixed into near-black the hue survives at a lower percentage and the card
     still reads as a dark surface. And no `--sheen` over a tint.
306. ⚠️ **Presence and a computed style have to be read in ONE round trip.**
     `await expect(locator).toHaveCount(1)` followed by `locator.evaluate(...)`
     is two, and a 150ms exit animation can finish in between — so the style
     comes back for an element that is no longer in the state being asserted.
     It failed only after the calendar grew a 42-cell grid, i.e. for a reason
     with nothing to do with what broke.
307. ⚠️ **Never mutate a string inside a loop over its own match offsets.** A
     sweep that deleted dead CSS rules did `for m in finditer(s)` and sliced `s`
     on each iteration — every match after the first used an offset into a
     string that no longer existed, so the second cut lands wherever that
     happens to be now. Re-scan after each edit, or collect the spans and apply
     them back to front.
308. ⚠️ **Truncate a user's text on a CHARACTER boundary.** `&body[..MAX]`
     panics the moment a note contains anything outside ASCII, which on a
     Polish machine is most of them — and the panic takes the note with it.
     `.chars().take(n)`.
309. ⚠️ **A textarea must not be re-rendered on its own keystrokes.** A
     redraw replaces the element and takes the caret, the selection and the
     undo stack with it. The draft lives in the field and is read on save; only
     the list redraws.
310. ⚠️ **Search folds the accents off both ways.** `Krakow` has to find
     `Kraków` and the reverse, or the search is one you have to already know the
     answer to use. `NFD` then strip `̀-ͯ`.
     ⚠️ And it is NOT the palette's subsequence matcher: that one turns three
     letters into a command (`agt` → `Agents`), and against prose it matches
     almost everything — a search that returns the whole list has answered
     nothing.
311. ⚠️ **A highlight built from the folded string is sliced at offsets that
     may not line up.** Composed `ó` folds to one character and the offsets
     survive; text that arrives already DECOMPOSED folds shorter than it is, and
     the mark then lands on the wrong characters. The length is compared and
     the body handed back whole when they differ — a missing highlight is a
     nicety lost, a wrong one is a lie.
312. ⚠️ **Never `innerHTML` for a note.** It is arbitrary text the user pasted
     from somewhere; the one thing you must not do with that is hand it to a
     parser. Text nodes, and a test that pastes an `<img onerror>`.
313. ⚠️ **`weekday: "short"` is not two to four characters.** It is `niedz.`
     in Polish. A test asserting a length passed in English and nowhere else;
     assert on "has no digits" instead.
314. ⚠️ **Read the length before taking the mutable borrow.** `held.len()`
     inside an arm of `match held.iter_mut()` is an immutable borrow while a
     mutable one is live, and the compiler is right to refuse.
315. ⚠️ **Parse on the way OUT, never on the way in.** The note is stored as
     the characters typed, so it stays greppable, survives being pasted
     elsewhere, and the worst a parser bug can do is make a note LOOK wrong
     rather than lose a word of it. Anything that parses on the way in owns the
     user's writing.
316. ⚠️ **`**` has to be tried before `*`** or `**bold**` matches as two empty
     italic runs. Order in an alternation is order of preference — which is the
     whole reason it is one regex rather than four passes.
317. ⚠️ **An inline run may not begin or end with a space**, or `5 * 3 * 2` is
     an italic run and a sum becomes a sentence in italics. Exactly the sort of
     thing a quick note holds.
318. ⚠️ **A code run is literal all the way down.** Somebody writing
     `` `**not bold**` `` is showing you the characters; formatting inside there
     is the one failure that makes the feature useless for its commonest use.
319. ⚠️ **A formatting button must use `pointerdown` + `preventDefault`,
     not `click`.** A click takes focus off the textarea first, so the selection
     is gone by the time the handler runs and bold wraps nothing — every time.
320. ⚠️ **And it writes the field directly, not through a re-render.** A
     redraw replaces the textarea and takes the selection with it, which is the
     one thing a formatting button cannot do.
321. ⚠️ **Search runs on the PLAIN text.** On the raw body, `**every**` is
     found by typing `**every**` and not by typing `every` — the one query
     anybody would use.
322. ⚠️ **The highlight is applied INSIDE a formatted run, not over the
     line.** Over the line it has to slice through the formatting, and every
     mark has to be re-opened on the other side of a hit.
323. ⚠️ **One scroller per screen.** `.screen-body` already scrolls; a second
     one inside it meant the panel measured the full content height, capped
     itself at the island's maximum and then clipped the bottom row — which
     reads as a broken layout rather than as a list that scrolls.
324. ⚠️ **`auto-fill`, not `auto-fit`, for a wall of cards.** With `auto-fit`
     a single note stretches to the full width of the island and stops being a
     square; `auto-fill` keeps the empty tracks.
325. ⚠️ **A count a test perturbs itself is the wrong assertion.** The notes
     test adds notes and then asserted how many matched `pi` — a number that
     changes every time an earlier step in the same test adds one, and that
     `Shopping` happens to contain.
326. ⚠️ **The sticky note is the one window here that MUST take focus.** The
     island is `WS_EX_NOACTIVATE` so a glance never steals the caret, and every
     field on it pays for that in plumbing — copying that pattern to a note you
     click into and type in would make it unwritable. Ordinary focusable
     window; undecorated, always-on-top and off the taskbar is the whole of it.
327. ⚠️ **`data-tauri-drag-region` on the body makes every press a drag.** The
     body is what you click to edit, so the note becomes unwritable and it
     presents as the click doing nothing. A strip at the top, and only that.
328. ⚠️ **A drag started on a drag region is handled by the OS from mouse-down
     onwards** — the WebView never sees the move or the release. So a
     `pointerup` listener fires for clicks and never for drags, which is
     exactly backwards; the window's own `onMoved` is the only signal.
     ⚠️ And it fires per PIXEL, so it has to be debounced or one drag is four
     hundred writes to disk.
329. ⚠️ **Escape must remove the blur handler before it re-renders.** The
     re-render removes the textarea, removing it fires `blur`, and `blur` saves
     — so "discard" saved the very words it was discarding. Caught by a test
     that typed something and pressed Escape.
330. ⚠️ **`position(0, 0)` is a real position**, and it is the top-left corner
     of the primary monitor — under the island, where Windows already puts
     everything else. A never-placed window must take the default instead, so
     0/0 has to mean "unplaced" and be checked for.
331. ⚠️ **A position is saved but NOT emitted.** `notch:notes` redraws every
     note in every window; emitting on a drag would repaint the island's whole
     wall for a window moving on another monitor.
332. ⚠️ **Closing the window is part of deleting the note.** A sticky note
     whose note has been deleted is a square of text on the desktop that
     nothing can reach — and the same is true of a note emptied to nothing,
     which goes through `save_note` rather than `remove_note`.
333. ⚠️ **A shape hanging off the island must be a SIBLING of it.**
     `#island` is `overflow: clip` and carries a clip path, so a child that
     reaches past the shape is erased with no warning — and the window itself
     is sized to the island exactly, so the strip the shape hangs into has to
     be added to `windowSize()` or the shape is cut off at the window's edge.
     Both failures look like a rendering fault rather than a missing element.
334. ⚠️ **Anything drawn outside a reported mask is visible but dead.** The
     notch window is click-through everywhere outside `report()`'s rects, so a
     new surface that does not push one of its own is drawn, cannot be hovered
     or clicked, and — worse — the island folds the instant the pointer leaves
     the mask to reach for it.
335. ⚠️ **`notchTransform` picks which END the flares are on, not which way
     the shape points.** A tab moulded into the island's edge takes the
     island's OWN edge, not the opposite one: both hang off something above
     them. Reversed, the fillets land at the free end and a shelf reads as a
     bell dangling on a stalk. Nothing errors; it just looks wrong.
336. ⚠️ **A fillet radius near the depth never straightens out.** At 46 of
     75 the tab had no flat sides left and read as a mound; at 30 of 75 the
     curve is the top third and the rest is a straight drop. The shape is
     valid at every value, so only looking at it catches this.
337. ⚠️ **Chrome that exists on one edge and not on others is a silent
     feature hole.** The tool tab was horizontal-edges-only at first, which
     meant the screens' actions had no home at all on a left or right edge —
     no error, no fallback, just controls that cease to exist when the island
     is moved.
338. ⚠️ **`clampCorners` silently grants a shorter sweep than you asked
     for.** The flare is capped at `depth - cornerRadius`, so with the island's
     own 78.8 corner radius a 75-deep tab could never sweep further than ~37
     whatever number was written — three attempts at tuning it changed
     nothing, and the path stayed valid the whole time. A long sweep needs a
     small free-end radius AND a depth to draw it in.
339. ⚠️ **Two inverse flares that meet leave a spike, not a joint.** The
     island's end sweeps up and out; the tab's sweeps up and in. Set the tab's
     inset below the island's own `islandCurl` and they cross, leaving a wedge
     of black pointing down into the gap between them. Valid geometry, no
     warning, looks like a rendering fault.
340. ⚠️ **Chrome revealed on hover must report its GROWN mask before it
     grows.** The notch window is click-through outside the reported rects, so
     a shape that springs open under the pointer is briefly larger than the
     mask — and the pointer, now over a click-through region, fires
     `pointerleave`, which closes it, which is a loop. Report the target size
     on the way in and the settled size on the way out, so the mask is always
     a superset of what is painted.
341. ⚠️ **`mouseover`/`mouseout` on a container with buttons in it fire on
     every child.** Crossing from one tool to the next raises `mouseout` on the
     container, so a hover-revealed row closes while the pointer is still
     inside it. `pointerenter`/`pointerleave` do not bubble and are the pair
     that means what this needs.
342. ⚠️ **Anything struck concentric with a notch's corner must ask what the
     corner BECAME.** `clampCorners` shrinks `cornerRadius` to fit the depth
     and the flares, so an arc drawn at the nominal 78.8 sits visibly inside a
     shallow island's edge — which reads as a mistake, not as a smaller gap.
     `notchCorner()` returns the clamped value.
343. ⚠️ **A hit band that follows a moving shape oscillates under a still
     pointer.** The pointer enters the band, the shape swings outward, the band
     goes with it, the pointer is left over nothing, `pointerleave` fires, it
     shuts — and the pointer has not moved, so it opens again. Strike the band
     across every position the shape can reach and it cannot happen.
344. ⚠️ **A masked region the page treats as `pointer-events: none` is a
     DEAD region, not a transparent one.** The Win32 mask decides which pixels
     the window receives at all; CSS then decides what happens. A mask larger
     than the live area swallows clicks meant for the desktop behind it. Mask
     the quadrant the arc occupies, not a box centred on its circle — that is
     four times the area for the same curve.
345. ⚠️ **The island is WIDER than the preview viewport at the suite's
     default 900px.** Its body is a fixed design width, about 935 CSS px, so
     anything anchored to its far corner is off-screen there and a hover test
     fails with no error — `elementFromPoint` simply returns null. Real windows
     are sized to the island, so this is a preview artefact; a spec that
     touches the far corner needs `test.use({viewport})`.
346. ⚠️ **A clearance measured to a stroke's CENTRELINE is not the clearance
     you see.** Half of an eight-pixel line lives in the gap, so a radius set
     to `corner + gap` draws a gap of `gap - 4`. Measure to the stroke's inner
     edge, and the number in `layout.ts` means what it says.
347. ⚠️ **Two sibling shapes need the SAME clearance, not a similar one.**
     The tool arc and the agents notch's settings orb sit against different
     curves, so nothing forces them to agree — and at 34 against the orb's 18
     the arc read as a separate decision rather than the same one. When a
     measurement exists elsewhere in the app for the same visual job, take the
     number, do not pick a new one.
348. ⚠️ **`page.clock` or the test fails at a time of day.** The calendar's
     week-grid spec asserted the now line, which is drawn only while the hour
     is inside the grid's axis — so it passed all afternoon and failed every
     evening, on a change that had nothing to do with the calendar. Anything
     asserting a clock-derived element pins the clock.
349. ⚠️ **A notch's rounded corners are a FLARE in from each end, not at the
     box's corners.** `notchPath` turns back out to the bezel at both ends, so
     the corner centre is at `length - curl - corner` along the edge and only
     `depth - corner` across it. Take the box's corner instead and anything
     concentric with it is a flare's width — about 30px — out of place, which
     reads as being both too far out and crooked while every radius involved
     is still correct.
350. ⚠️ **Clearance is measured to whatever is ON the circle, not to the
     circle.** A line and a 28px disc on the same radius do not have the same
     gap: half the stroke is 4px and half the disc is 14. Put them on different
     radii that share one clearance — kept on the line's own circle, the discs'
     inner edges land inside the island's corner and the row looks welded on.
351. ⚠️ **Every measurement taken from a shape's own centre is blind to that
     centre being wrong.** Radius, clearance and stroke all checked out while
     the arc was struck about the wrong point, because they were all measured
     from it. What catches it is walking inward at several angles and finding
     where the other shape actually begins: concentric, that distance is the
     same every time. (Hide the invisible hit band first, or
     `elementFromPoint` answers in the island's place.)
352. ⚠️ **Reaching for a sibling of the island reads as LEAVING the island.**
     The arcs are siblings — `#island` is `overflow: clip` — so pointing at one
     folds the panel while you are on your way to its own close button. The
     masks do cover them, but they are recomputed on a settle and the pointer
     can arrive first; the arc says so directly instead, and only ever opens
     with it, because letting go of an arc must not fold anything.
353. ⚠️ **Chrome placed from a moving shape must not close on
     `pointerleave`.** The arcs are positioned from the island's measured size
     every frame, so a panel springing to a new height drags the whole quadrant
     out from under a pointer that has not moved — leave fires, the arc shuts,
     and nothing was touched. Hold it open while the island's own springs are
     unsettled, then ask `:hover` again.
354. ⚠️ **A control that moved behind a hover needs a second way in.** Pin
     went from a permanent header button to a disc on a bare arc, and "keep
     this open" is wanted exactly when you are about to do something fiddly —
     the worst moment to hunt for a hidden control. It is a palette command
     now, which is also the only stable way a test can reach it.
355. ⚠️ **`page.clock.install` freezes `requestAnimationFrame`.** Time does
     not advance on its own, so spring-driven layout stops mid-flight while the
     DOM looks settled. Anything positioned by the paint loop is at a
     provisional place in a clocked test; flow-laid-out chrome was not, which
     is why this only surfaced when the controls moved onto an arc.
356. ⚠️ **`setPointerCapture` on `pointerdown` swallows the `click`.**
     Capture retargets everything that follows to the capturing element, the
     click included — so on a draggable rail every press of a stop was
     delivered to the rail instead of the button, and pressing a screen did
     nothing at all. Nothing errors, and the drag works perfectly. Capture when
     the drag actually starts, not when the pointer goes down.
357. ⚠️ **A draggable control needs a slop threshold or it has no clicks.**
     Every press moves a pixel or two, so without one the snap fights the click
     and the screen you pressed is never the one you get.
358. ⚠️ **Chrome that is only on some edges is a silent feature hole, again.**
     The rail ran across the island's end at first, which left a left- or
     right-edge island with NO screen switcher — the header strip had already
     gone. Same shape as 337; it will keep happening as long as things move out
     of the header, so the rule is: before deleting the last copy of a control,
     check all four edges.
359. ⚠️ **A preference that gates a `!important` rule must exist in the
     PREVIEW fixture too.** `railAlways` hides every stop when false, and the
     browser fixture did not carry it — so the rail came up as a bare black pill
     that filled on hover, which is a real setting and therefore looked
     deliberate rather than missing.
360. ⚠️ **A test helper that waits for a settle cannot test travel.** Routing
     the screen switch through the palette made `goTo` wait for the island to
     stop, and two tests measuring a height mid-flight then measured the
     destination twice — one of them comparing it against itself and passing for
     the wrong reason. Both take an explicit opt-out now.
361. ⚠️ **A clamped radius silently breaks a spacing guarantee.** The arc
     divided a FIXED angular spread by the number of actions and then clamped
     the radius to keep the shape inside its window — so once the clamp bit, the
     chord between two neighbours fell below the spacing that had been
     calculated for it and the discs overlapped into one lozenge with notches
     in it. Every number involved was still correct. Derive the ANGLE from the
     radius you ended up with, not the radius from the angle you wanted.
362. ⚠️ **Arriving at a hover-revealed control changes it, so measure after
     arriving.** A test that works out where to press, then moves the pointer
     there, has measured the closed shape and pressed the open one.
363. ⚠️ **A drag delivered in one burst always releases as a flick.** The
     release speed is read off the last two moves, and Playwright's `steps`
     dispatches them microseconds apart — so a test dragging exactly one stop
     lands one further, intermittently, depending on machine speed. End the
     gesture with a slow one-pixel move.
364. ⚠️ **`show(name)` replays a screen's entrance when handed the screen it
     is already on.** It is harmless from a click and ruinous from a drag,
     which passes stops continuously — a gesture wobbling over one stop flashes
     the panel on every crossing. The rail remembers what it last announced and
     says nothing twice.
365. ⚠️ **Two motions on the same pixels read as neither.** The rail
     translates and blurs the whole panel through a drag; a screen playing its
     own entrance on top of that reads as the content stuttering. A live change
     swaps the screen with the entrance suppressed and lets the gesture carry
     the motion.
366. ⚠️ **A `MutationObserver` on `class` counts the wrong thing by
     default.** `target.classList.contains(x)` in the callback is true for every
     later mutation on an element that still has `x` — so a test counting
     entrances counted a screen merely being hidden. Keep the previous value and
     count the 0→1 transition.
367. ⚠️ **A caption in a carousel sets the pitch for every slot.** One word
     on the centred stop made all nine slots a word wide, which put a rail of
     five at over two hundred pixels with the screens marooned at its ends. The
     name belongs where it does not have to fit between two neighbours.
368. ⚠️ **`Math.sign` of a float that should be zero is 1.** The rail pushed
     its neighbours aside with `Math.sign(away) * push`, and the CENTRED stop's
     `away` is zero give or take rounding — so it shoved itself a full step and
     sat off centre by half a caption, while every radius and width involved
     still measured correct. Ramp through zero instead of stepping across it.
369. ⚠️ **A hidden element measures zero, and so does a clamped one.** The
     rail is `hidden` until its first paint and its captions are held at
     `max-width: 0`; `scrollWidth` AND `offsetWidth` both report 0 in either
     case, so three separate attempts to measure a caption all returned nothing
     and the pill grew to exactly its own padding. A fixed slot with an
     ellipsis has none of those failure modes.
370. ⚠️ **`min-width: auto` on a flex item beats `max-width: 0`.** A flex
     item will not shrink below its content by default, so a caption held at
     zero rendered at full width and every stop on the rail became a word-wide
     pill sitting on its neighbours.
371. ⚠️ **`box-sizing: border-box` makes padding the FLOOR of a width.**
     `max-width: 0` cannot squeeze padding out, so a caption clamped to nothing
     still occupied its own padding on every stop. Grow the padding with the
     width, from the same number.
372. ⚠️ **A debounce re-armed from the frame loop never fires.** The loop is
     woken by things with nothing to do with the thing being debounced — the
     clock ticking the pill over, a session changing, the panel measuring
     itself — and each of those reset the timer. Start the count; never restart
     one already running.
373. ⚠️ **A spring asymptotes, so `value === 0` is never true again.** The
     name went away once and never came back, because the re-arm was guarded on
     an exact zero the spring arrives near but not at. Ask `settled`.
374. ⚠️ **Rubber-banding past the end unselects everything.** Which stop you
     are ON has to be read from the CLAMPED position while where each one sits
     is read from the real one — judged on the rubber-banded position, the
     nearest stop is over half a slot away and the rail reads as having lost
     its place because you leaned on the end of it.
375. ⚠️ **`event.timeStamp` does not advance for synthesised pointer events.**
     Anything driven by automation — and some remote-desktop stacks — delivers
     a constant timestamp, so a velocity computed from it divides by the
     millisecond floor and every gesture reads as thousands of pixels a second.
     Every speed gate then latches on the first move and the feature is simply
     never on. Use `performance.now()`.
376. ⚠️ **The first move after `pointerdown` has no time behind it.** The gap
     between the press and the first move is nearly zero, so the first speed
     sample is garbage however it is measured. Skip it, and floor the interval
     at a frame — two moves coalesced into one tick are not evidence of speed.
377. ⚠️ **A live preview must be gated on the gesture, not on a timer.** Rate-
     limiting screen changes to one every 150ms still rendered four of them in
     a fast sweep, and every screen has its own width and height — so that is
     four resizes of the island in half a second, each correct alone and
     unreadable in a row. Gate on distance travelled and speed, and LATCH it:
     slowing down in the middle of a long sweep must not start animating again
     halfway through.
378. ⚠️ **`cpx()` imported into Node answers differently than in the page.**
     It converts design pixels by a scale the browser works out from the
     screen, so a distance computed in a test is not the distance on screen.
     Measure from the page and scale by a ratio of two constants, which is the
     same everywhere.
379. ⚠️ **An offset measured to the NEAREST slot flips sign at every slot it
     passes.** The panel is carried by the rail, and that carry was
     `position - round(position)` — which is correct only while the screen
     changes on the same crossing, because the new one arrives on exactly that
     flip. The moment the screens stop following along, nothing changes at the
     crossing and the flip is all there is: the panel slid one way, snapped
     back, and did it again for every screen gone past. Measure to the thing
     being SHOWN, not to the nearest one, and cap it.
380. ⚠️ **One sample must not latch a gesture gate.** A pointer stream
     stutters — a frame drops, two moves coalesce, the machine is busy — and a
     single pair delivered eight milliseconds apart reads as hundreds of pixels
     a second whatever the hand was doing. Taken raw, that switched the rail's
     live preview off for the rest of a perfectly deliberate drag, at random,
     on a busy machine. Smooth the speed before anything reads it.
381. ⚠️ **A hard limit reads as a jam.** Stopping the panel dead at one
     screen's worth was the honest thing to say — it is not following you any
     further — but a gesture pushing against something frozen feels like a
     fault. A log curve past the knee keeps it moving and makes every further
     screen of travel move it less: a bow being drawn, not a drawer hitting its
     stop.
382. ⚠️ **A zero-height child still takes its gap.** `.tile` sets a 7px gap
     and a system pill holds two children — the head, and a list clamped to
     `max-height: 0`. Every closed pill therefore carried seven pixels of
     nothing along its bottom edge, which reads as a taste decision rather than
     a bug and survived a long time because of it.
383. ⚠️ **A class on the panel cannot hide the furniture outside it.** The
     arcs and the rail are SIBLINGS of `#island` — they have to be, it is
     `overflow: clip` — so `.is-searching`, which takes the panel out of sight
     behind the palette, left them hanging off a shape that is now a search
     bar, offering the actions and the screens of whatever was underneath.
     Anything new outside the island needs telling directly.
384. ⚠️ **A question from an agent is a TOOL CALL, not prose.**
     `AskUserQuestion` arrives as a `tool_use` block exactly like `Bash` or
     `Read`, so a classifier that reads "any non-text block means mid-flight"
     counts the one moment a session genuinely wants you as *working* — no
     pulse, no notification. Verified against a real transcript on this
     machine: the record is an assistant message whose only block is that call,
     and nothing follows until the answer arrives as a `tool_result`.
385. ⚠️ **"The file will not grow again" is not the same as "you are
     needed".** A turn ending in prose was reported as *waiting*, which is true
     of the transcript and false of the reader: the work came back, there was
     no question, and there was nothing to answer — yet it pulsed amber and
     held the pill until the terminal was closed. Together with 384 the two
     states were exactly inverted, and each looked plausible on its own.
386. ⚠️ **A small mark centred in a large host is not where you put it.** The
     rail's hint is five pixels tall and its host is as deep as a stop — it has
     to be, the stops live in it — so centring sat the line twenty pixels off
     the island's edge and the whole rail read as adrift. Align the mark to the
     edge it belongs to; centre only what the depth exists for.
387. ⚠️ **Releasing the caret arms the fold timer, so the panel is SHOWN for
     its duration.** Closing the palette with the pointer away handed the panel
     back, then waited most of half a second before folding — which reads as
     the island opening by mistake. Fold at once when nothing is holding it
     open, having checked: the palette is opened from a control on the island,
     so the pointer is often still there.
388. ⚠️ **Cards dropped into a screen body come out as rows.** Every screen's
     body is a flex column, so a card laid straight into it is one per line at
     full width — which is the list it replaced, with bigger pictures. A grid
     of its own, and `auto-fill` rather than `auto-fit`: with `auto-fit` a
     shelf holding two items stretches them across the whole panel and they
     stop being cards.
389. ⚠️ **`auto-fill` asks the element how wide it is, and during a screen
     change the answer is the PREVIOUS screen's.** The panel's width is sprung,
     so a grid laid out at that moment wraps to two rows, the island measures
     itself against that, opens at twice the height it needs and settles a
     moment later. Compute the column count from the width the panel is
     travelling to.
390. ⚠️ **A tooltip must not fall back to "the nearest thing with a label".**
     `#island` carries an `aria-label`, as do the panel, the screens and half
     the regions inside them — so `closest("[aria-label]")` matches everywhere
     on the surface and the whole island grows one tooltip saying its own name.
     Match controls, then read the label off what you matched.
391. ⚠️ **A regex sweep over `.title =` catches `.title===`.** Converting the
     native tooltips to `data-tip` rewrote two comparisons into syntax errors,
     and a looser pattern written to catch `x.title=y` is exactly what does it.
     It also hits data models: a `Task` has a title and it is not a tooltip.
392. ⚠️ **Half the native tooltips are in markup strings, not assignments.**
     Sweeping `.title =` left seven `title="…"` attributes in template
     literals, and the OS draws its own tooltip a second later over ours — so
     those controls ended up with two labels disagreeing about when to appear.
393. ⚠️ **A saved order must be a SORT KEY, not the list itself.** Rebuilding
     the rail from `railOrder` drops every screen the preferences have never
     heard of — so a file written before a screen existed hides it, silently and
     for good. Rank by the saved position, fall back to the built-in one, and a
     partial list is simply a partial list.
394. ⚠️ **The screen the island lands on cannot be hideable.** Home is where
     it opens and where a screen that disappears sends you; hidden, neither has
     anywhere to go. Refused in the island as well as disabled in the settings
     window — preferences are a file anybody can edit.
395. ⚠️ **`dragover` must call `preventDefault` or every drop is refused.**
     Without it an HTML5 reorder looks exactly like a list that cannot be
     reordered: the row lifts, follows the pointer, and springs back.
396. ⚠️ **Every control in a non-active settings pane is present and
     `hidden`.** The window is a sidebar over a stack of panes, so a test that
     addresses a control without opening its pane times out against a perfectly
     correct page — and so does a styled checkbox, whose input is painted over
     by its own pseudo-element and never hittable.
397. ⚠️ **Setting a flag AFTER the call that fires the callback guarded on it
     is a mask that removes itself.** The palette applied its mask, then called
     `pinFor` — which opens the island synchronously, which fires the shell's
     open callback, which calls `unmask`, which is guarded on `palette.open`
     — and `open` was set on the next line. The mask went on and came off in
     the same tick, so the screen behind the palette was visible the whole time
     it was up, and had been all along.
398. ⚠️ **"Not open" is not "staying open".** Escape reaches the island's own
     handler as well as the palette's, so by the time the palette asked whether
     to fold, the island was often already on its way down — and reading that
     as "nothing to fold, the panel is staying" put the screen back on screen
     for the length of the fold. The question is "will it end up collapsed".
399. ⚠️ **Giving a size back before a fold retargets the fold.** `onClose`
     restores the screen's width and height, and the springs then travel
     towards a full expanded panel on their way down to the pill — so the
     island visibly GREW while closing. Masking the contents hid what was in
     it and left the shape doing exactly that. Fold first; restore behind the
     collapsed pill, where it snaps.
400. ⚠️ **Tauri intercepts drag events at the window, so HTML5 drag and drop
     does not reach the page.** The settings window's reorder worked perfectly
     in a browser and not at all in the app — which is exactly what makes the
     platform's own drag the wrong choice here, because the bug only exists
     where it cannot be seen. Pointer events work in both, and are testable.
401. ⚠️ **A tooltip that falls back to `aria-label` is a tooltip on
     everything.** Everything pressable is labelled, for reasons that have
     nothing to do with wanting a tooltip — so the fallback put one on every
     control on the surface, and a tooltip on everything is a tooltip nobody
     reads. Require `data-tip`, and say it twice where it helps.
402. ⚠️ **`innerText` counts text clipped to zero width.** The rail hides every
     caption but the middle one with `max-width: 0; overflow: hidden`, and
     `innerText` reports all nine — so "does this control already show its own
     name" answered yes for all of them. A `Range` over the text is no better:
     it measures the text's own layout and ignores the ancestor clipping it.
     The text node's PARENT box is what is on screen.
403. ⚠️ **A selected item has to differ in KIND, not in degree.** The rail's
     current stop was a slightly lighter grey disc among grey discs, which on a
     row of nine takes a second look to find. Colour is what makes it findable
     without reading.

404. ⚠️ **A preview is not a reason to hand the page a filesystem.** The
     obvious way to show a shelved file is Tauri's asset protocol, and it
     grants "read any file matching this glob" — the shelf holds whatever was
     dropped on it, so the glob would have to be the disk. The command takes a
     shelf ID and returns a PNG instead: no path crosses the bridge, and a
     page that renders a lot of text it did not write gains nothing it can be
     talked into reading.
405. ⚠️ **It is the SHELL's thumbnail, not one decoded here.** Windows already
     holds a cached, oriented, scaled preview for images, PDFs, video and
     Office documents, and it is the picture Explorer shows — which is the one
     the eye is expecting. Decoding a 40 MP JPEG to draw it at 120px is
     slower, larger, and wrong more often.
406. ⚠️ **`IShellItemImageFactory` hands back an opaque thumbnail with every
     alpha byte at ZERO.** Written straight out that is a correctly sized,
     correctly coloured, completely invisible PNG — and nothing errors. Force
     alpha to 255 when the whole channel is zero, and only then: an icon with
     a genuine cut-out has a mixed channel and must keep it.
407. ⚠️ **Loud is not the same as findable.** The first fix for 403 added a
     bloom around the active stop, and the rail then had one thing on it —
     every glance landed on the selection whether or not you were looking for
     it. A quiet wash at half the strength, in a colour nothing else on the
     rail wears, is found just as fast and costs no attention when you are not
     looking.
408. ⚠️ **A Playwright failure that will not reproduce is probably my own
     orphaned processes.** One test failed a full-suite run and then passed
     three times in isolation; the cause was leftover vite/chrome workers from
     an earlier interrupted run holding the port. Check `netstat` for the dev
     port before believing a lone failure.
409. ⚠️ **The microphone says you are in a call; a window title only guesses.**
     Teams is titled "Microsoft Teams" whether or not anybody is talking, and a
     browser on a Meet lobby page is titled exactly like a browser in a Meet
     call. An ACTIVE Core Audio capture session is the same fact Windows draws
     its own microphone glyph for, and it is the only one that is not a guess.
410. ⚠️ **A capture session OUTLIVES the recording that made it.** Teams opens
     one when it starts and keeps it all day, so "this app has a capture
     session" is true from breakfast and means nothing. `AudioSessionState`
     being Active is the test; without it every launch is a call.
411. ⚠️ **The process holding the microphone is not the app you would name.**
     New Teams runs its call inside `msedgewebview2.exe` and a Meet tab
     captures through Chrome's audio service — both children. Matching the
     capturing pid against a list of executables finds neither, and finds
     nothing to report rather than erroring. Walk UP the process tree, the way
     `win::raise_process` walks up to find a window.
412. ⚠️ **Zero capture SESSIONS is an ordinary machine; zero capture ENDPOINTS
     is a broken enumeration.** They look identical from outside — both report
     "no call" — and the second is discovered during a meeting. The probe
     asserts on endpoints, and opens a capture stream of its own to prove an
     active session is really seen.
413. ⚠️ **`PostMessage` of a key does not reach a Chromium or WebView2 window.**
     That is Teams, Meet and WhatsApp, i.e. most of them. `SendInput` is the
     only thing that works and it goes to the FOREGROUND — so the call window
     has to be raised, sent the key, and the previous window put back. The
     flicker is the cost of the only mechanism there is.
414. ⚠️ **Release modifiers in REVERSE order.** Sent up in the same order they
     went down, the modifier lifts before the letter and the app sees a bare
     `m` — which in Teams is not mute, it is a letter typed into the meeting
     chat.
415. ⚠️ **A browser window's title is its ACTIVE TAB's title**, so a Meet call
     drops its own evidence the moment you look at another tab. The microphone
     is what says the call is still up; the name it had is carried forward.
     Without that, every Meet call ends on screen the first time you check your
     email.
416. ⚠️ **And the same fact makes `Ctrl+D` dangerous.** Meet's mute is an
     ordinary browser shortcut and means mute only while the Meet tab is in
     front; sent at a window that has moved on it is "add bookmark". The window
     is asked again what it is after being raised, and refused if it has moved.
417. ⚠️ **Mute the endpoint AND send the app's shortcut.** The app's mute is
     what the meeting can SEE; the endpoint's is the one that can be read back
     and the one that holds when a keystroke does not land. Sending only the
     shortcut means a failure you can neither see nor hear — you believe you
     are muted and you carry on talking. Doing both makes every failure silent
     in the safe direction.
418. ⚠️ **Mute the endpoint the call is RECORDING FROM, not the default one.**
     An app records from whichever microphone it was told to, and a headset
     that is not the system default is the normal case for somebody in a call.
     Muting the default then silences nothing, and looks exactly like it
     worked.
419. ⚠️ **`paintIcon` REPLACES its target's children.** An `<img>` sitting in
     the same box as a fallback glyph is deleted the first time the glyph is
     painted — and nothing throws on that frame. The next tick finds
     `dataset.kind` unchanged, skips the builder, and dies on a node that was
     there a second ago. Give the picture and the glyph an element each and
     toggle `hidden`.
420. ⚠️ **A wheel that steps through `TABS` can land on a stop that is not on
     the rail.** Two screens come and go and several can be switched off, and
     `render` sends you straight back — so the notch reads as DEAD rather than
     as having done something. It was latent while the player sat third; a call
     sitting second made the very first notch do nothing. Step through the
     stops that exist, not through the list of all of them.
421. ⚠️ **The process holding the microphone has the SAME NAME as the app and
     owns no window.** `brave.exe --type=utility` is Chrome's audio service and
     is itself `brave.exe`; Teams and Discord capture in children of their own
     name too. So walking up the process tree finds the app on the FIRST step —
     the child — and asking that pid for its windows finds none. The symptom
     was not an error: Teams and Discord offered a lone Mute (every other
     control needs a window to send a keystroke to) and Google Meet was never
     detected at all (its gate needs a window title to read). Match windows
     across every process running the same EXECUTABLE, never by pid. AGENTS 411
     is the same trap one level up and does not cover this: the walk found the
     right app and still the wrong process.
422. ⚠️ **New Teams puts the signed-in ACCOUNT in its window title.** The real
     string is `Meeting compact view | Meeting with <name> | Personal |
     <address> | Microsoft Teams` — five fields — so stripping the app's name
     off the end, which is all every other app needs, put an email address on a
     strip that is on screen all day, including while its owner is sharing it.
     Anything holding an `@` is dropped from a title now, in every app.
423. ⚠️ **A marker that matches everything is not a marker.** `| microsoft
     teams` ends every window Teams has, so as the test for "this is the call
     window" it matched the inbox as readily as the meeting — and the
     tie-breaker below it never ran.
424. ⚠️ **The rail's timing tests fail under PARALLEL load, and it looks
     exactly like a regression.** A dozen specs here measure motion — a drag
     frame by frame, a spring that has to have settled — and on three parallel
     Chrome instances they miss frames. Two or three fail, never the same two,
     always passing alone. ⚠️ **This entry first said the cause was work I had
     added per frame, and that was wrong**: the same failures came back after
     that work was keyed away. `--workers=1` fixed most of it — 78/78 on a
     quiet machine — and not all: the next two runs each failed one test, a
     different one, while the machine was busy with a video call. The config
     pins one worker now, and the rule is that **a failure here is only real if
     it survives being run alone**. The per-frame lesson below still stands on
     its own merits; it just was not this.
425. ⚠️ **A screen that rebuilds itself on every `render()` is paid for by the
     whole panel.** `render()` runs on every frame of a rail drag, so a screen
     that replaces its own children each time does that work per frame to
     change nothing — and throws away the hover and focus on whatever the
     pointer is over. Redraw on a key; let the per-second tick write text only.
426. ⚠️ **`UserNotificationListener` works for an UNPACKAGED app.** It is
     documented as needing the `userNotificationListener` capability, which
     only a packaged app can declare, so the reasonable expectation is a flat
     refusal — and the reasonable design is a notifications screen that can
     only hold this app's own notices. Asked on a real machine it answers
     `Allowed` and hands back the whole centre. The probe in `notify.rs` is
     kept so the day that stops being true is a test failure rather than an
     empty screen.
427. ⚠️ **A notification's text is a LIST, not a title and a body.** The
     template decides how many elements there are and apps use one, two or
     three, so element 0 is the title and the rest join. An empty list is a
     real notification (an image-only toast) and is kept, named after its app.
428. ⚠️ **WinRT `DateTime` is 100ns ticks since 1601, not since 1970.** The
     difference is 11644473600 seconds. Skip it and every notification is
     dated to the seventeenth century — which still SORTS correctly, so the
     list looks right and every timestamp on it is wrong.
429. ⚠️ **Mirror the notification centre; never archive it.** Keeping our own
     copy so things "stay in the shelf" would build a private, durable log of
     someone's messages, which is a much larger promise than showing them what
     is already on their own screen. Dismissing a row removes it from Windows,
     and when the centre is empty so is the screen.
430. ⚠️ **The header may count them; it must never quote them.** The island is
     on screen all day, including while its owner is sharing it — the same
     argument that keeps an address out of a call's title. Content lives on a
     screen you have to open.
431. ⚠️ **A countdown is an END TIME, never a remaining number.** A number
     ticked down drifts against the clock, stops while the machine sleeps and
     cannot survive a reload. And a stored countdown that ran out while the app
     was closed must be DROPPED rather than fired: otherwise every launch after
     lunch announces a pomodoro that ended an hour ago, and the one thing a
     timer must never do is go off at the wrong time.
432. ⚠️ **Node's type stripping refuses a parameter property**, so
     `constructor(private changed: () => void)` makes a file unimportable by
     `node --test` — which is the whole reason an engine lives in a file of its
     own. Declare the fields and assign them. Same trap `media-format.ts`
     exists to route around, met from the other side.
433. ⚠️ **A radial menu's hit test is an ANGLE, not the element under the
     pointer.** Each wedge's glyph and label are drawn on top of it, so
     `elementFromPoint` reports the text for a third of the ring and the menu
     goes dead exactly where its own labels are.
434. ⚠️ **Sampling a segment's CENTRE cannot catch a segment rotated half a
     segment.** The ring's aim regions were briefly offset from its drawn
     wedges — the right-hand half of every wedge selected its neighbour — and
     every test passed, because a centre maps to the same index under both
     conventions. Found by reverting the fix and watching the suite stay green.
     Sample just inside each wedge's own two EDGES, which is the only place the
     two conventions disagree, and tie the sample to the drawing function.
435. ⚠️ **A window that takes no focus has no Escape and no blur.** The ring is
     `WS_EX_NOACTIVATE` like the rest of the chrome, so there is no key to
     dismiss it with and no event when attention moves elsewhere: the way out
     has to be moving the pointer away, and only a poll of `GetCursorPos` can
     see that. The webview learns nothing about a pointer that is not over it.
436. ⚠️ **An SVG sibling does not inherit a custom property from the shape it is
     drawn on top of.** The ring's glyph sits over its wedge, not inside it, so
     `--stop` has to be set on both — one of them silently keeps the default.
437. ⚠️ **Node's resolver does not do extensionless imports the way vite does.**
     A file that `node --test` must load may import types freely (they are
     erased) but not values from `"./screens"`. Either spell the `.ts` or,
     better, pass the data in — a geometry handed its own list is easier to
     test besides.
438. ⚠️ **Eight is the ceiling for a ring.** Past that a segment is thinner than
     the hand is accurate and the advantage of a radial menu — aim rather than
     read — is gone. What does not fit belongs in the palette, which is what
     the middle of the ring opens.
439. ⚠️ **`AppDisplayInfo::GetLogo` only answers for a PACKAGED app.** Measured
     on a real notification centre: 7 of 48 notifications carried a logo and
     the other 41 — every desktop app on the machine — came back empty. A list
     where six rows in seven have no mark is a list you cannot skim, which is
     most of what the icon is for. Three places to look, in order: the WinRT
     logo, then `IconUri` under `HKCU\Software\Classes\AppUserModelId\<id>`
     (what an app writes when it registers its own toasts), then the Start Menu
     entry with the same display name. That took it to 47 of 48.
440. ⚠️ **A notification cannot be activated from outside.** `UserNotification`
     has no method for it, so the only quick action available is the app's
     AUMID through `shell:AppsFolder\<id>` — which opens Slack, never the
     thread. Reply and snooze belong to the notification's own actions and are
     not exposed at all. Name the button for what it does.
441. ⚠️ **A control that is hidden when idle is a control with no way in.** The
     timer chip appeared only while something was counting, so the only way to
     start a pomodoro was to already know the palette command. Something that
     can only be reached by knowing about it is a feature nobody uses. Idle it
     is a bare glyph and a door; running it is the readout.
442. ⚠️ **One press, one meaning.** The chip briefly paused a running countdown
     and did nothing otherwise — two controls wearing one hat, where which one
     you get depends on a state you may not have looked at. It opens the screen
     either way now, and the screen carries pause, stop and the presets with
     room to label them.
443. ⚠️ **A patch script that inserts after an anchor is not idempotent**, and
     a failed run half-way down means the next run re-applies everything above
     the failure. Two runs put `| "timer"` in the union twice and the screen in
     the list twice — which compiles, and quietly gives the rail a duplicate
     stop. Check the count after any re-run of a partially applied script.
444. ⚠️ **Never compare a CLOCK's text across two page loads.** A test captured
     the resting pill's time, reloaded with a call staged, and asserted the two
     strings matched. They do match — except when the minute rolls between the
     loads, which in a five-minute suite happens about once an hour and reads
     exactly like an intermittent bug in the pill. Assert the shape, and assert
     it against the page's own `new Date()` if you want to know it is the wall
     clock.
445. ⚠️ **A box measured while the panel is still resizing is the width of the
     screen you just left.** Every screen animates the island to its own width,
     so `boundingBox()` taken the instant a screen changes is wrong for about
     400ms. A notification card reported 789px wide and was 511 by the time the
     press landed — so the press went to whatever had taken that pixel and the
     drag did nothing, which looks exactly like a drag handler that does not
     work. Poll for two identical readings before measuring, the way
     `reachIsland` does for the arc.
446. ⚠️ **Prove horizontal intent before a card takes a drag**, or the list
     cannot be scrolled: a finger moving down a column is a scroll and one that
     has travelled further across than down is a dismissal. And guard the
     click — the card is a button, so without it every throw ends in the app
     the card came from.
447. ⚠️ **A dismissal has to animate BEFORE the row leaves the model.** The
     list is keyed on its ids, so the moment the source drops one there is
     nothing left to animate; and the gap it leaves has to collapse by the
     card's own measured height, or every card below it jumps up.
448. ⚠️ **A back arrow belongs only on screens you were SENT to.** Everything
     on the rail already has a way back — the rail — so an arrow on all twelve
     is a control that does nothing new, on every screen, for ever. The flag
     lives on the screen definition and is read by both the rail and the
     header: written twice, the arrow appeared on screens that could already be
     left and on none of the two that could not.
449. ⚠️ **A python patch script that inserts after an anchor is not
     idempotent**, and writing `⚠` inside an escaped python string puts the
     literal characters `⚠` into the file. In a TypeScript string literal
     that still renders correctly, which is why it survived review; in a
     COMMENT it is just wrong. Grep for a literal backslash-u after any bulk
     patch.
450. ⚠️ **Windows owns every sound a timer needs, so ship none.**
     `C:\Windows\media` holds the notification and alarm sounds the machine
     already uses, registered under `AppEvents` as aliases. No asset, no
     licence question, and a noise the person already recognises as "the
     computer wants me".
451. ⚠️ **These registry values are `REG_EXPAND_SZ` and come back RAW.** The
     alarm sounds resolve to `%SystemRoot%\media\Alarm01.wav`, which
     `PlaySound` cannot open — and with `SND_NODEFAULT` that is silence and no
     error, a setting that offers a sound and does nothing. Two of the four
     offered happened to be stored expanded, which is why it half worked. The
     `#[ignore]`d test that resolves every offered alias is what caught it.
452. ⚠️ **And `SND_NODEFAULT` is not optional.** Without it a path that cannot
     be opened plays the system default ding: a wrong noise instead of a silent
     failure, which is much harder to notice and impossible to debug from the
     sound alone. Same reason the alias is resolved here rather than passed to
     `SND_ALIAS`, which falls back the same way.
453. ⚠️ **Play the sound DIRECTLY, not through the toast.** A toast carries one
     and it would have been less code — but a toast is suppressed by Focus
     Assist, and Focus Assist is exactly what somebody running a pomodoro has
     switched on.
454. ⚠️ **A round counter is not a position.** `round` counts FINISHED work
     rounds, and the session track reads it as an index — the break after round
     one is the FIRST break, not the second. Conflating them put three segments
     behind you the moment the first round was skipped. And the long break is
     the one case where `round % 4 === 0` means the END of a cycle rather than
     the start of the next, or the whole track empties while it runs.
455. ⚠️ **Two faces sharing one engine must each refuse the other's state.** A
     plain timer and a pomodoro are the same countdown underneath, so the timer
     face happily drew a running pomodoro's clock above a dial set to something
     else — two different times on one screen, both correct, neither useful.
456. ⚠️ **A screen with state of its OWN needs a way to ask for a redraw.**
     The lengths drawer set a flag and cleared its render key, and nothing
     repainted until the next whole minute: a button that works and appears to
     do nothing. Every other screen's state changes come through a source that
     already calls back.
457. ⚠️ **Replacing a span between two anchors deletes whatever a later patch
     put between them.** Rewriting `cycle` by cutting from its own name to the
     next top-level `const` took six exported functions with it, because an
     earlier patch in the same session had inserted `cycle` above them rather
     than below. `tsc` caught it instantly — but only because they were
     exported and used; a private helper would have gone silently.
458. ⚠️ **`nextEvent` keeps an event until it ENDS, which is right for the
     screen and wrong for the strip.** The pill's claim only checked "more than
     thirty minutes away?", so once the meeting began the countdown went
     NEGATIVE and the claim held for its whole duration. A reminder for
     something that started twenty minutes ago is not a reminder.
459. ⚠️ **Everything that asks for attention needs a way to say "not now" —
     including the one with a deadline.** A module can be muted and an agent
     snoozed; the meeting could not be answered at all, because the strip is
     not clickable while hovering it opens the panel. The palette is the way
     in: a command that exists only while that event is claiming.
460. ⚠️ **A claim holds the whole strip; a module takes its turn.** Thirty
     minutes of "Design review in 24m" is half an hour of a notch that can say
     nothing else. The claim's window and the module's hand-off are the same
     number in two files and have to move together.
461. ⚠️ **Centred is the lazy layout and it looks it.** Everything stacked down
     the middle of a 700px panel leaves two wide margins of nothing and makes
     every element look small. Controls on one side, the number on the other,
     and the number gets to be sixty pixels.
462. ⚠️ **A row of identical labelled buttons says all of them matter
     equally**, which is never true. Pause is pressed twenty times a session,
     stop once, the lengths on a Tuesday — 54px accent, 40px grey, 32px ghost,
     icons only, labels in the tooltip.
463. ⚠️ **A progress BAR reads as a download.** The pomodoro cycle as eight
     bars looked like something installing; as dots where the running one
     stretches into a filling capsule it reads as a place in a sequence, which
     is what it is. And the running dot needs a ring of its own colour as well
     as the fill: a minute into twenty-five the fill is 4% of 56px, so on the
     fill alone the thing HAPPENING looked exactly like the things that had not
     started.
464. ⚠️ **A dial needs a detent, and a PC has no haptics to borrow.** The sound
     is the feedback: eighteen milliseconds of square wave at 3% gain per mark,
     brighter on the fives. Synthesised rather than a file — a WAV would be a
     bigger asset than the code, and a file has to be decoded before the first
     one plays, which is the moment it must not be late.
465. ⚠️ **An `AudioContext` built at import is born suspended and stays
     silent.** It needs a gesture, so create it on the first tick — a drag IS
     the gesture, so by then the browser is willing.
466. ⚠️ **Number pop-in is for a number that changes once a second**, not for
     one under a finger. Replaying the per-digit animation on every frame of a
     drag is a column of digits fighting the hand moving them: plain text while
     dragging, `setDigits` while running.
467. ⚠️ **A drag that ROUNDS is a ratchet, not a dial.** The ruler moved only
     when the whole minute under the mark changed, so it stood still for seven
     pixels of hand and then jumped fifteen. The strip follows the pointer
     continuously and only the NUMBER rounds; the release eases it onto the
     mark over 260ms, which is the part that says the dial caught rather than
     twitched.
468. ⚠️ **Ends that stop dead read as the control breaking under the hand.**
     They give instead, asymptotically — six minutes of travel however hard you
     pull — so the gesture can never leave the ruler somewhere it has to be
     dragged back from. `free()` in dial.ts, with the same NaN guard `clamp`
     has, because a NaN offset paints nothing and reports nothing.
469. ⚠️ **A per-element fade is a per-frame cost AND a shorter ruler.** The
     dial wrote an opacity and a blur onto all 242 of its children on every
     frame of the drag, which is what the drag felt like; and because the fade
     was measured in pixels from the MARKER rather than from the edges, it kept
     the ruler inside a 210px window in the middle of a 700px panel. A
     `mask-image` on the dial is free and reaches both edges.
470. ⚠️ **One click per mark is a buzz, not a detent.** A quick drag crosses
     a mark every two or three milliseconds. `click.ts` keeps a 45ms floor and
     simply drops the ticks in between — catching up afterwards would be a
     burst of clicks arriving after the hand has stopped. A BUTTON passes 0:
     a press is deliberate and must not be swallowed because a drag ended
     forty milliseconds ago.
471. ⚠️ **A sliding tab pill cannot be `calc(50%)` unless the labels are the
     same length.** "Timer" and "Pomodoro" are not, so the pill overhung one
     word and left the other sticking out from under it. Measured off the tab
     — and placed at the PREVIOUS tab first with the transition off, because
     changing mode rebuilds the screen and the pill is a new element with
     nothing to animate from.
472. ⚠️ **`offsetWidth` is 0 on a screen that has not been shown**, so a
     measured control keeps its stylesheet fallback for as long as the panel
     stays open. A `ResizeObserver` on the tabs, not a rAF retry: a screen you
     never open never gets a size, and the retry would run for the life of the
     window.
473. ⚠️ **Two `boundingBox()` calls are two different moments.** The panel
     grows from its centre for a few frames after it opens, so a pill measured
     in one round trip and its tab in the next read as seven pixels adrift — a
     misalignment that was entirely the measurement. Both rects in one
     `evaluate`. Same family as the 789-vs-511 card in 4xx.
474. ⚠️ **A plain timer does not deserve the whole strip.** Twenty minutes of
     "Timer · 12:04" costs the date, the clock and the module slot, to say a
     number you asked for yourself and can see the end of. It is a circle
     parked beside the notch now; a POMODORO still claims the strip, because
     it has a name and a phase, which are what you look down to be reminded of.
475. ⚠️ **The countdown was the smallest thing on the strip.** It was the
     tail of the grey 10.5px second line, behind the phase and a middle dot —
     so the one number anybody looks down for read as metadata about the title
     above it. Its own slot, 21px, tabular; the name and the phase qualify IT.
476. ⚠️ **Every reported rect is BOTH "the window is clickable here" and
     "the pointer is on the notch".** Reporting the countdown bubble as one
     mask therefore opened the island the moment you reached for it — the
     exact trap the pill's own buttons are stuck in, arriving on a control
     built to escape it. Two lists: `masks` open the island, `passive` only
     make the window clickable. The `tasks:hover` payload has carried the
     pointer's x/y all along, which is what makes the two answerable apart.
477. ⚠️ **The notch's BOX is a whole flare longer than its shape.** It curls
     back out to the bezel at each end, so anything spaced off `x + width`
     is spaced off an empty corner: the countdown parked a gap plus a flare
     away and read as a bubble that happened to be near the notch rather than
     one torn off its side. Measure from `width - curl`, and level the circle
     with the island's FREE edge — the one away from the bezel.
478. ⚠️ **A passive rect that overlaps a mask has to WIN the overlap.** Tucked
     into the flare's corner the countdown sits inside the island's hover box
     while sitting well outside the island's shape, so "on a mask and not on a
     passive rect" opened the panel the moment you reached for the circle —
     the same failure the passive list was added to prevent, one geometry
     change later. And the rule has to be written in BOTH hover paths: the
     preview's `pointermove` is where every hover test runs, so a rule living
     only in the `native` branch is a rule nothing checks.
479. ⚠️ **One number that only changes once a minute looks stopped.** The
     circle showed whole minutes, which on a resting notch is the only moving
     thing on screen sitting still for sixty seconds at a time — and "45" in
     the last minute read as forty-five of them. Two rows, minutes over
     seconds, the seconds smaller and quieter: what you read, and what says it
     is running.
480. ⚠️ **One engine for two features is one feature that eats the other.**
     A pomodoro and a plain timer shared a single state, so pressing Start on
     the timer face silently threw away a run that was four rounds in — no
     warning, nothing to undo, and the only symptom was a track that had gone
     back to empty. Two instances of the same class with their own storage
     keys, each dropping the other's shape on load. They run side by side, and
     the collapsed island had room for both all along.
481. ⚠️ **"Make it a decision" is not "throw the run away".** A finished
     break returned nothing, so the state went null, the rounds already done
     were forgotten and the track emptied: a pomodoro left alone through its
     own break looked exactly like one that had reset itself. It hands back
     the next round READY — `endsAt: null` with the whole span left — which is
     the same shape as paused and has to say a different word on the same
     button, so the state carries `ready` to tell them apart.
482. ⚠️ **`a || b` never ticks b.** Both countdowns have to be ticked before
     either answer is read, or a pomodoro ending in the same second as a timer
     leaves the timer unfinished: no sound, no toast, and 00:00 on screen
     until the next second.
483. ⚠️ **A claim carrying `progress` draws a RING, so nothing repaints its
     icon.** The strip kept the focus glyph all through the break, because the
     "repaint the icon every frame" line skips any claim with a progress
     fraction — which is right when the slot holds a ring and wrong the moment
     the progress moved to a bar along the bottom.
484. ⚠️ **"Show it on hover" is unobservable with hover opening.** A pointer
     arriving at the collapsed strip has already replaced it with the panel,
     so the reveal can only be watched in click mode. The behaviour degrades
     correctly — there you get the panel's own 60px clock — but a test for it
     has to reload into `?click`, and the countdown surviving that trip is the
     end-time-on-disk rule paying for itself.
485. ⚠️ **A 60px number in a 60px line box carries fifteen pixels of nothing
     under it.** The panel is sized to its content, so that slack is black at
     the bottom of the island — on the one screen with the least on it. Tabular
     digits have no descenders, so the line box can be cut to the ink.
486. ⚠️ **A second hue for "break" would be a second colour to keep in step.**
     The accent is one variable and the user picks it; a fixed blue clashes
     with half the choices. A pale tint of the accent says rest against work
     and cannot drift — with an ICON beside it, because a colour on its own is
     not a difference to everybody who uses this.
487. ⚠️ **A stray `</div>` does not stay inside the element it was written
     in.** One extra closer in a settings pane's template closed
     `.settings-scroll` itself: an end tag with no matching open is applied to
     the nearest open div IN SCOPE, and `<section>` is not on the list of
     elements that block that search. Every pane after the broken one was
     parsed as a SIBLING of the scroller — no scrolling, and none of the side
     padding, which lives on it. Nothing errored and the panes before it were
     perfect. The guard is one line: every pane's parent must be the scroller.
488. ⚠️ **A lean means the opposite thing the moment the content behind it
     changes.** Dragging the rail leans the panel the way the hand went, which
     is right for the screen going OUT — and on the frame the new screen
     arrives, that same lean puts the new content on the side you dragged away
     from, so it walks in backwards against its own entrance animation. It is
     mirrored once at the swap, and the paint loop is told to keep its hands
     off for the length of the return: the real offset is zero by then, so one
     more frame of it would snap the panel home.
489. ⚠️ **Being the most live claim is not the same as being somewhere to
     be sent.** A toast outranks everything on the strip by design; landing on
     the System screen because one went past is a navigation nobody asked for.
     `steers: false` says "draw me, do not go there", and the bar for the rest
     is 40 — the line between "this is happening to you" and "this is a fact
     about your day". A player that steals the panel because music is on is
     the behaviour that makes people switch the feature off.
490. ⚠️ **Two measurements racing through one fold.** Landing on a live screen
     was called from inside the panel's own open work, and `show` caps the
     body, renders and measures — so two screens were measured through one
     opening. It landed as a screen visited LATER sitting ten pixels short at
     the bottom, on a full test run and nowhere else. A frame later it is an
     ordinary screen change.
491. ⚠️ **A glyph at the head of the strip costs the name its place.** The
     phase sat between the edge and the session name with a gap either side —
     three things in a row with room for two — and pushed the one word you
     actually read a third of the way in. It moved to the far end and shares
     ONE fixed-width grid cell with the countdown: they trade places under the
     pointer, and a swap that re-lays the strip out moves the name out from
     under the eye that came to read it.
492. ⚠️ **A bar that fills at a third of a pixel a second has stopped, as far
     as anyone can tell.** Twenty-five minutes of progress is invisible as
     motion. A sheen travelling along the fill is what says RUNNING; the width
     says how far. And the fill needs a floor, or the first minute is a line
     that never started — the same trade the pomodoro's dots already make.
493. ⚠️ **Full screen slides the island off the edge, and anything drawn
     against its box goes with it.** The line a running pomodoro leaves on the
     bezel is a SIBLING, placed on the reveal strip — the rectangle that was
     already interactive — so the thing you can see and the thing you can
     point at are one rectangle by construction rather than by agreement.  **Superseded by 494.**
494. ⚠️ **Two lines for one fact, for the length of an animation.** That
     separate strip meant the bezel's line AND the strip's own were both on
     screen for the moment the island slid back — briefly duplicated, then one
     vanished. The island is PARKED short of gone instead: the words ride up
     out of sight and the same element stays on the edge, so there is nothing
     to keep in step. ⚠️ The parked rules have identical specificity to the
     hidden ones, so they must come after them in the sheet.
495. ⚠️ **A glyph centred in its own slot floats.** The phase sat twenty-five
     pixels in from the strip's edge with nothing to its right, which reads as
     something that has come loose rather than as the end of a row. Aligned to
     the end of the slot it shares with the countdown, and lifted off the
     progress line — a glyph resting on a bar reads as part of it.
496. ⚠️ **LRCLIB's `/api/get` is a fingerprint, not a search.** Artist, track,
     album AND duration, or it answers 404 — which is the behaviour to want: a
     near miss returns nothing rather than another recording's words scrolling
     against this one's clock. `/api/search` exists and is not used.
497. ⚠️ **An LRC file is not one format.** `[mm:ss.xx]`, `[mm:ss.mmm]`,
     `[mm:ss]`, several stamps on one line for a repeated chorus, metadata
     headers that look exactly like stamps apart from what is left of the
     colon, and a `[offset:]` whose POSITIVE value means the words come
     EARLIER. Only the stamps at the FRONT of a line count, or a bracketed
     aside inside the words prints the rest of the song against the wrong
     minute.
498. ⚠️ **A `MutexGuard` held across an `await` makes the future non-Send**,
     which Tauri's command machinery refuses — and the state handle has to go
     out of scope before the guard does, or the borrow outlives what it
     borrows. Both in one small block before the request.
499. ⚠️ **The player had a clock that nothing moved.** The media screen redrew
     on events and once a minute, so the scrub bar sat wherever the last event
     left it; the lyrics are what made it visible. A `tick` that writes in
     place, because that screen holds a scrollable queue, an open device menu
     and a search field with a caret in it.
500. ⚠️ **A fixture whose playhead runs in real time is a test that depends
     on how fast the machine is.** By the time a test walks to the player the
     demo track is several seconds further on than the fixture says. Seek to a
     known second first, and aim at the MIDDLE of a line's span rather than
     just past its stamp.
