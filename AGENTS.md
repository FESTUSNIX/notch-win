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
