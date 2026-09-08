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
