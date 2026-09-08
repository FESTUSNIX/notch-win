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

- `tasks.ts`, `tasks.css`: the task notch, pinning and mask reporting.
- `task-editor.ts`: token setup, quick add, rename and task placement.
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
- Quick add lives inside tasks.ts. Only account setup and optional task management
  use task-editor. create_task accepts either task window; token commands remain
  editor-only.
- NOACTIVATE is the default, with an explicit exception while inline entry is
  active. task_window::set_task_input owns that temporary state; win::harden
  must preserve it on every hover toggle. Cancel/save/collapse/blur restore the
  default. Restore the former foreground window only if the task notch still
  owns focus; never override an outside click.
- Browser tests cover fold/reopen, retained drafts, inline create, all four edges,
  compact lists and reduced motion. Native smoke checks the temporary style
  change and restoration without writing to TickTick.
