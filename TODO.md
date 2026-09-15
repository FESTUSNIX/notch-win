# TODO

## My ideas for the next features

- Currency converter extension for the command palette
- Notifications shelf/screen which keeps recent notifications and allows for quick actions
- Pomodoro widget
- Quick note widget with history of all notes, search

A big overhaul of how the island _feels_, in four parts. Reference is **Droppy**
(macOS): a notch that is snappy, springy, only as wide as its content, and whose
controls appear under the pointer rather than sitting there all day.

Items **1** and **2** are the current work. Items **3** and **4** are written
down so the shape is agreed, and are **not started** — they wait for the word.

---

## 1. Click mode should mean click

Right now `openOnHover: false` only stops the island _opening_ on hover. Leaving
still folds it, so in click mode the panel closes the moment the pointer wanders
off — which is the one thing click mode exists to prevent.

- [x] **Leaving must not fold in click mode.**
      `IslandSurface.hover()` (`src/island-surface.ts`) schedules
      `show(false)` on every `hover(false)`, whatever `openOnHover` says.
      In click mode the fold timer should not be armed at all.
- [x] **A click outside closes it.** Nothing does this today, and it is the
      half of the bargain that makes the above safe.
      ⚠️ The island is `WS_EX_TRANSPARENT` outside its own painted shape, so a
      click outside never reaches WebView2 — this has to be seen natively.
      **Use the poll that already exists**: `hover.rs` ticks on a timer and
      `drag.rs` already reads `GetAsyncKeyState(VK_LBUTTON)`. Watch for a
      button-down _transition_ while the cursor is outside the island's
      reported rect and emit `island:dismiss`. No low-level hook — a
      `WH_MOUSE_LL` hook runs on every mouse message machine-wide and is a
      liability for a personal tool.
- [x] **A second click on the pill closes it.** `collapsedLayer`'s click
      handler currently opens only (`if (!surface.open) surface.toggle()`).
      In click mode it should toggle.
- [x] **Escape closes it** when the island has focus. Already true while the
      palette is up; make it true for the panel.

### Controls that appear under the pointer

Click mode gives us a resting state nothing is fighting for, so the panel can
show less and reveal more.

- [x] **The media waveform becomes play/pause on hover.** The bars beside the
      track title are decoration; under the pointer they should cross-fade into
      the transport control. Per `better-ui`: icon swap at scale `0.25 → 1`,
      opacity `0 → 1`, blur `4px → 0`, both icons kept in the DOM, one
      absolutely positioned, `cubic-bezier(0.2, 0, 0, 1)`.
- [ ] Audit every screen for the same move (the pill's equaliser is done): what is ambient at rest and
      actionable under the pointer. Candidates — the day's progress rail
      (→ open Today), the Home cards' arrows, the System meters.
- [x] ⚠️ **Motion is never the only feedback channel.** Every hover-revealed
      control needs a static cue too (a cursor change, a colour, a label), or
      it is invisible to anyone who does not move a mouse over it first.

### Press

- [x] **Press down = `scale(0.96)`, 90ms.** Release bounces back with
      `--ease-bounce` (`cubic-bezier(0.34, 1.36, 0.64, 1)`). Already true for
      some buttons; make it the rule, including on the collapsed pill.
- [x] ⚠️ **The pill cannot simply take a CSS transform.** `#island` and
      `#stage` are positioned with `left`/`top` by the paint loop, and their
      `transform` is already spent on the hide/reveal slide
      (`tasks.css`, "Leaving and arriving"). A press-scale needs a **wrapper
      element** inside the island, or it will fight the chrome-hidden
      transition and the fold.

**How we would know:** a browser test in click mode that opens the island,
moves the pointer right off it, and asserts the panel is still open — then
fires the dismiss and asserts it closed. Plus the existing fold tests must
still pass in hover mode.

---

## 2. Snappier, bouncier, and only as wide as it needs to be

### Per-screen width

The panel is 909 CSS px on every screen. A list of tasks does not need that;
Home's three-card bento does.

- [x] **Each screen declares a preferred width**, and `show(name)` applies it.
      The machinery exists: `surface.capBody(px)` already narrows the panel for
      the palette (to ~620px). Give every screen a number instead of one.
- [x] Starting guesses, to be tuned against the real thing:

      | Screen   | Why                              | Design px | CSS px |
      | -------- | -------------------------------- | --------- | ------ |
      | Home     | three cards side by side         | 1900      | ~969   |
      | Today    | one column of rows               | 1420      | ~739   |
      | Agents   | project, branch, tokens, a verb  | 1620      | ~835   |
      | Shelf    | rows with a thumbnail and a path | 1480      | ~768   |
      | Calendar | seven columns                    | 1900      | ~969   |
      | System   | a bento                          | 1900      | ~969   |
      | Review   | a few stacked cards              | 1480      | ~768   |

- [x] ⚠️ **Horizontal edges only.** On a left/right edge the "body" is the
      panel's _height_, and capping that cuts the list short instead of making
      it narrower — `capBody` already guards this; keep the guard.
- [x] ⚠️ The palette narrows the panel too. Screen width and palette width must
      not fight: the palette's cap should win while it is up and hand the
      screen's own width back on close.

### The springs

`src/motion.ts` is a real spring (`response`, `damping`). Current values:

| Spring         | Response | Damping  | What it moves                       |
| -------------- | -------- | -------- | ----------------------------------- |
| `fold`         | **0.34** | **0.72** | opening and closing                 |
| `grow`/`widen` | **0.30** | **0.74** | a size change you asked for         |
| `grow`/`widen` | 0.34     | **0.92** | a size change under a still pointer |

Shipped values. `sizing()` in `island-surface.ts` picks between the two, and
`Spring.retune()` swaps them mid-flight without zeroing the velocity.

- [x] **Shorter response, less damping** on `fold` — this is the gesture the
      whole app is judged by.
- [x] ⚠️ **`grow`/`widen` are damped at 0.90 on purpose** and the reason is
      written down: a panel already on screen changing size _under your cursor_
      reads as a wobble when it overshoots. Do not simply lower it. The honest
      split is **a size change that accompanies a screen change can bounce**
      (the content changed, you expect movement) **and a size change under a
      still pointer cannot** (a list grew a row; nothing should wobble).
      That means `grow`/`widen` need two sets of parameters, chosen by _why_
      they were retargeted.
- [ ] Review it at 10% speed in the browser's Animations panel, not at full
      speed. What feels off slowed down is what feels subtly wrong live.
      (Values are in and tested; the eyeball pass at 10% is still owed.)
- [x] ⚠️ Everything here must keep answering `motion-pref.ts` — `never` means
      snap, `always` means ignore the Windows setting.

### Interactions everywhere

- [x] Sweep every interactive element for the full set: rest, hover, press,
      focus-visible, disabled. Done: the tab strip, day rows, agent rows, the
      pill itself, the pill's equaliser. ⚠️ `scale`, not `transform`, on
      anything the paint loop or the tab glide already transforms.
- [ ] Still thin: System's device rows and the shelf's row actions.
- [x] `transition-property` named explicitly, never `transition: all`.
- [x] ⚠️ **Style each thing once, where it is defined.** This has bitten here
      before — a tab rule hundreds of lines later silently overrode the whole
      elevation pass.

**How we would know:** a test that walks each screen and asserts the panel's
width actually changed, plus the existing height-travel test extended to width.

---

## 3. The music widget — DONE

Shipped as a screen of its own, with its tab on the strip only while
something is playing. What landed:

- Large artwork, title with badges (explicit / lyrics), artist underneath.
- A scrubber with elapsed on the left and **remaining** (`-2:22`) on the right.
- Transport: previous / play-pause / next, plus an output-device button.
- A waveform that is decoration at rest and the play/pause control on hover
  (see item 1).
- **"Playing Next"** — a queue panel to the _right_ of the player, **closed by
  default**, opened by the list button at bottom-left. Opening it widens the
  panel; that is exactly what item 2's per-screen width has to support.
- **Spotify**, for the queue and nothing else. PKCE, so there is no client
  secret to keep; the token is in Windows Credential Manager beside TickTick's
  and Google's and is never read back into a WebView.
  ⚠️ **The redirect URI is fixed at `http://127.0.0.1:5733/callback`** and has
  to be registered in the Spotify dashboard character for character. Google
  accepts any loopback port; Spotify does not, and gets you
  `INVALID_CLIENT: Invalid redirect URI` — which reads like a bad client id.
  Settings → Connections prints the string with a Copy button.
  ⚠️ With Spotify disconnected the panel loses its right-hand column and
  nothing else: every other control comes from Windows' own transport session.

### Still open on the player

- [x] Add to the queue — a search in the panel, appending to the end.
- [ ] **Reordering the queue is not possible, and not for want of trying.**
      Spotify's Web API has **no** endpoint for moving a queued item, removing
      one, or inserting at a position: `POST /me/player/queue` appends and that
      is the entire surface. (Playlist items can be reordered —
      `PUT /v1/playlists/{id}/tracks` — but the queue is not a playlist.) A
      drag handle here would be a control that cannot be implemented, so there
      is none. If Spotify ever ships it, this is the one thing to add.
- [ ] The queue is fetched when the panel opens and after an add, never
      refreshed while it sits open. A track change leaves a stale list.
- [ ] Nothing in the queue is clickable — skipping _to_ a queued track has no
      endpoint either.
- [ ] ⚠️ **The scope changed** (`user-modify-playback-state` was added for the
      add). A connection made before this has to be reconnected in Settings, or
      adding answers 403 — which reads like a Premium problem.

## 4. The calendar — DONE

Month grid and agenda in one view, plus a week that is a time grid:

- **Month grid on the left**, agenda **scrolling on the right**, in one row.
- Month name in the accent, `‹ ›` to page months, today ringed, the selected
  day filled.
- The agenda is continuous and grouped by day with a sticky-ish heading
  (`SATURDAY, 11 JUL (WK. 28)`), each event a tinted card — we already tint by
  calendar colour, so this is mostly layout.
- **A `+` button** next to the month that opens a **New Task popover**: title
  field, a day/time control, an `Add` button.
  ⚠️ It writes to TickTick, so it is the composer's logic, not a second
  creation path — reuse `screen-today`'s optimistic layer rather than growing
  another one.
- ⚠️ The week grid **is** week-aligned now, which is why `week_starts_monday`
  came back with it (defaulting to Monday). ISO week numbers are printed
  beside each agenda heading and always start on Monday whatever that setting
  says — the setting decides which column a day is drawn in; the week *number*
  is a fixed international definition.

### Still open on the calendar

- [ ] Paging past the fetched window (45 days) draws a correct grid with no
      busy dots, because there are no events for it. Either fetch per month or
      say so in the grid.
- [ ] The New Task popover files into whatever list Today's composer is on.
      There is no list picker in the popover.
- [ ] Nothing can be created *in the calendar* — it makes TickTick tasks, not
      Google events. Writing events needs a second Google scope.

---

## Decisions this must not quietly undo

- The bezel shape. Everything is welded to a screen edge and keeps the fillet.
- One settings window. Anything new that is a preference goes in `prefs.rs` and
  gets a control there — not a popover somewhere else.
- The accent is one variable. No new hardcoded colour; derive with `color-mix`.
- Tokens never reach a WebView, a log, or an error message.
- `AGENTS.md` is the log of things that failed silently. Every trap this pass
  turns up gets a numbered entry.
