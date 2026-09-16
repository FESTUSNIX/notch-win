# TODO

## My ideas for the next features

- Currency converter extension for the command palette
- Notifications shelf/screen which keeps recent notifications and allows for quick actions
- Pomodoro widget
- ~~Quick note widget with history of all notes, search~~ — **done**. A Notes
  screen: a field that saves on Enter, the pile newest-first, and a search that
  folds accents and matches every word anywhere. Palette: "Write a note".
  - [ ] No global shortcut of its own — the palette command is the fast path.
        One would mean a seventh key and a seventh row in Settings.
  - [x] Pin a note to the desktop — its own always-on-top, undecorated,
        draggable window. Position and size are remembered; pinned notes come
        back when the app restarts.
  - [ ] Notes are not searchable _from the palette_ yet, only from the screen.
  - [ ] A pinned note has no colour of its own — they are all the same paper.
        A colour per note is the obvious next thing if the desktop gets busy.
  - [x] Simple formatting — `**bold**`, `*italic*`, `` `code` ``, `~~strike~~`,
        `-` and `1.` lists, `>` quotes, `#` headings, ``` fences. Stored as the
        text you typed; parsed on the way out.
  - [ ] No nesting: `**a *b* c**` renders the outer marker only. Every attempt
        at one grows a state machine, and a note is not a document.

- Fix: Agent status gets stuck at "waiting" when the agent has actually finished
- Style (shelf): instead of rows make the items cards (square-ish) with a thumbnail, title, format and size.
- Feature (media): live lyrics sync using LRCLIB
- Feature: In call mode with controls (mute, hand up, camera, etc.), integrate Teams, Zoom, Google Meet and WhatsApp if possible.
- Feature (media): Add volume mixer. Control volume per app
- Fix: Arcs and screen rail/switcher are visible when the command palette is open. The command palette should be a separate layer that doesn't show the global island UI
- Fix (system): Unnecessary padding bottom on device and bluetooth cards.
- Fix (command palette): When closing the command palette, expanded island shows up before folding. Fix that. When opening or closing the command the island should not be taken into account.

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
- [x] Audited. The pill's equaliser is the only place it earned its keep:
      the pill is the one surface with no room for a control at rest. The
      candidates were all rejected on the same ground — ⚠️ a hover-revealed
      control is only right where there is nowhere to put a permanent one.
      The day rail sits above a screen you can already press a tab to reach;
      the Home cards' arrows are already visible and the whole card is
      clickable; the System meters have their own device rows underneath.
      Hiding those behind a hover would be hiding a control that had a home.
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
- [x] Still thin: System's device rows and the shelf's row actions.
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
- [x] The queue is fetched when the panel opens and after an add, never
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
  says — the setting decides which column a day is drawn in; the week _number_
  is a fixed international definition.

### Still open on the calendar

- [x] Paging past the fetched window (45 days) draws a correct grid with no
      busy dots, because there are no events for it. Either fetch per month or
      say so in the grid.
- [x] The New Task popover files into whatever list Today's composer is on.
      There is no list picker in the popover.
- [ ] Nothing can be created _in the calendar_ — it makes TickTick tasks, not
      Google events. Writing events needs a second Google scope.

---

## 5. The tool arc — DONE

Context-based controls — clear the shelf, show the queue, refresh — on a line
struck concentric with the island's far corner, a gap out from it. Reached for,
the line swings out and the actions land on it, each at its own angle.

⚠️ **It took three shapes to get here, and the first two are worth knowing
about.** In the header beside the pin and the settings gear, they read as
orphans — the header is the same on every screen and these are the one thing on
it that is not. Moulded into the island's underside as a reversed notch, they
read as a lump on a corner, and no amount of filleting makes a lump look
deliberate. What works is a separate object following the contour at a
distance: the same idea as the settings orb on the agents notch.

- [x] **A sibling of `#island`, never a child.** `#island` is `overflow: clip`
      with a clip path on it, so anything inside it that reaches past the shape
      is simply erased.
- [x] ⚠️ **The window had to grow.** `windowSize()` was exactly the island's
      own size, so a shape hanging off the bottom had nowhere to hang. The
      strip below costs nothing — the window is click-through everywhere
      outside the reported masks.
- [x] ⚠️ **And the tab reports a mask of its own**, or it is drawn, unhoverable
      and unclickable, and the island folds the moment the pointer reaches for
      it.
- [x] ⚠️ **The fillets go at the JOINT, not the free end.** Same `notchPath`,
      same `notchTransform`, same edge as the island — both shapes hang off
      something above them. Reversed, it reads as a bell on a stalk.
- [x] **All four edges.** The horizontal-only version was silent: on a left or
      right edge the tools were simply not on the screen. `screen-tools.ts`
      writes the arc offset as a length and `#island-tools[data-edge]` picks
      the axis and the sign.
- [x] **The header row is gone**, not duplicated. Two homes for one control is
      how one of them goes stale.
- [x] Every screen that had tools kept them; Calendar gained a refresh and a
      link out, which were previously reachable only by knowing they existed.
- [x] **Bare at rest, filled on hover.** A row of icons parked under the island
      permanently is a toolbar, and a toolbar is what the header row already
      was. Closed, the tab is a seam that says only that there is something
      here; the shape springs open and the tools arrive with the pointer.
- [x] ⚠️ **Struck concentric with the corner the island ACTUALLY got.**
      `clampCorners` shrinks `cornerRadius` to fit; at the nominal value the
      line sits inside the island's own edge.
- [x] ⚠️ **The hit band does not follow the line.** It spans every radius the
      line can swing through — otherwise the pointer opens it, the line moves
      out from under the pointer, `pointerleave` fires, and it shuts and
      reopens forever without the pointer moving.
- [x] ⚠️ **The mask is the quadrant, not a box on the circle.** A masked
      region the page treats as `pointer-events: none` swallows clicks meant
      for the desktop; a centred box is four times the area for the same curve.
- [x] ⚠️ **Sized and placed off the agents orb's own numbers**, not new ones.
      18 of clearance and an 18 stroke, the same as the orb; the line is
      trimmed shorter than the span the actions use, so it reads as a hint
      rather than as a continuation of the island's straight edges.
- [x] ⚠️ **Concentric with the corner's real centre**, which is a flare in
      from the island's end — not the box's corner. Off by that, it reads as
      both too far out and crooked, and every radius is still correct.
- [x] ⚠️ **The line and the actions share a CLEARANCE, not a radius.** A disc
      is three times the line's thickness; on the line's own circle its inner
      edge lands inside the island's corner.
- [x] ⚠️ **Two actions fit at the RESTING radius** — the line swinging out to
      make room is a fine motion for four and an absurd one for two, and two
      is what every screen here actually has.
- [ ] No screen has more than two actions yet, so the line never has to swing
      far. The radius maths for three and four is written but unexercised.

---

## 6. The furniture moves out of the header — DONE

Three controls hung off the island's free edge instead of crowding one bar:
the screen's own actions on the far corner, the island's four on the near one,
and the screens themselves on a rail under the middle.

⚠️ **The header could not hold the screens, and that is measurable.** On the
narrowest screen — the player at 531px — the header has about 60px spare, and
nine captions need six hundred. That is why only the selected tab was ever
captioned, which told you where you were and nothing about where you could go.

- [x] **The rail centres where you are**, captions it, and fades and blurs its
      neighbours away either side. One number — which stop is under the middle
      — and every position is derived from it.
- [x] **Drag it, flick it, wheel it, or press a stop.** The panel rides along
      and blurs while the drag is live, so the two read as one movement.
- [x] ⚠️ **Capture the pointer when the DRAG starts, not on the press** — see
      AGENTS 356. Capturing early swallows every click.
- [x] **All four edges**: across the island's end, or down its side.
- [x] Settings: how many stops show (3–7), and whether they show unasked.
- [x] **The arcs are a hint, not chrome.** The resting line is thinner (11
      design, ~5px) and short — it points at the hover area rather than tracing
      it — and the actions are smaller, spaced, and closer to the island.
- [x] ⚠️ **The spread follows the actions, not the other way round.** A fixed
      spread divided by the count overlapped the discs the moment the radius
      was clamped for room; the spacing is what is guaranteed now and the span
      is whatever that comes to. AGENTS 361.
- [x] **Either the line or the screens, never both.** The rail was a black
      pill with the stops inside it — a heavy piece of furniture directly under
      a panel that is already a large black shape. It is the arcs' own mark
      now, straight: a hint that there is a hover area, which goes as the
      screens arrive. In the always-on mode there is no line at all.
- [x] **Compact stops, each on its own ground**, so they sit close together and
      still read against whatever is behind the island.
- [x] **The screen changes DURING the drag**, not on release — walking three
      screens was three separate drags, and the panel spent each gesture
      showing something the rail had already left.
- [x] ⚠️ **With its entrance suppressed while the drag is live.** Two motions
      on the same pixels read as neither. AGENTS 364-365.
- [x] **The name is back on the stop, debounced.** It opens into a fixed slot
      once the rail has been still for a beat, and goes the instant it moves —
      so a drag never pays for the layout change. AGENTS 368-373.
- [x] **The ends do not carry the panel.** The rail still rubber-bands past the
      first and last stop, but there is no screen out there to be carried
      towards, so the content stays put instead of sliding off and snapping
      back. The end stop stays marked while you lean on it. AGENTS 374.
- [x] **More room in the gesture.** The finger travels 150 design px per stop
      rather than the 90 the stops are drawn at, so the rail moves slower than
      the hand and there is room to stop on the one you wanted.
- [x] **Past the limit it RESISTS rather than freezing** — a log curve, so the
      whole nine-screen list comes to about two screens of lean and every
      further screen of rail moves it less than the one before. AGENTS 381.
- [x] ⚠️ **And the panel stops rocking once they stop following.** The carry
      is measured to the screen being SHOWN rather than to the nearest stop,
      and capped at one screen's worth — the rail can travel the whole list
      from there; the panel is not going with it. AGENTS 379.
- [x] **Slow and short walks the screens; long or fast saves them for the
      release.** Two stops is a correction and the panel follows it through;
      six is travelling, and travelling wants one arrival. Latched for the rest
      of the gesture, so slowing down halfway does not start it up again.
- [x] ~~A fast drag does not render every screen it passes~~ — live changes are
      rate-limited to one every 150ms, and the release is never limited, so
      whatever it lands on is always what ends up on screen.
- [x] The header names the screen — and now it is the only place that does,
      which is what let the rail's slots shrink from a word wide to an icon. It is there
      because the header is the window's DRAG REGION and something has to be in
      it — but if the rail is always on, the name is said twice.

---

## Decisions this must not quietly undo

- The bezel shape. Everything is welded to a screen edge and keeps the fillet.
- One settings window. Anything new that is a preference goes in `prefs.rs` and
  gets a control there — not a popover somewhere else.
- The accent is one variable. No new hardcoded colour; derive with `color-mix`.
- Tokens never reach a WebView, a log, or an error message.
- `AGENTS.md` is the log of things that failed silently. Every trap this pass
  turns up gets a numbered entry.
