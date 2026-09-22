# TODO

Checklist only. The _why_ behind anything here is in `AGENTS.md` (numbered log of
silent failures) or in the comment above the code.

## Rules — don't quietly undo

- Bezel shape: welded to a screen edge, keeps the fillet.
- One settings window. A preference goes in `prefs.rs` and gets a control there.
- One accent variable. No new hardcoded colour — derive with `color-mix`.
- Tokens never reach a WebView, a log, or an error message.
- Every trap found gets a numbered `AGENTS.md` entry.

## Next

- [ ] **Widgets / boards** — customization overhaul
  - [x] Functionality → widget: add, remove, reorder (5 widgets: Now playing,
        Calendar, Today, Clock, Countdown)
  - [x] Home is board #1 — same model, keeps the screen name `home`
  - [x] Custom boards; drag a card between and within boards
  - [x] Boards sit alongside screens in rail / ring / palette / settings
  - [x] Board cap as a field in `prefs.rs`, set to `4`
  - [x] No per-widget settings in v1
  - [x] Arrange ON the board, not in settings — the grid on the island's arc
        opens a tray of widget tiles; drag to add, reorder or take off, × / ✓
  - [x] Widgets are real controls, shrunk: media scrubber, countdown transport
  - [x] 10 widgets: media, calendar, today, clock, countdown, weather, agents,
        notes, shelf, machine
  - [x] Blocks, not cards — space and an aligned label separate them; only the
        weather draws a surface. Each speaks in one of the app's six tones
  - [x] The board scrolls, and the tray is a COLUMN beside it — the panel
        grows sideways to hold it, so nothing on the board is ever covered
  - [x] No uppercase eyebrow labels; glass surfaces on the blocks and the tray
  - [x] Resizable blocks — a 6-column grid, a list of allowed sizes per widget,
        a corner to pull. Stored as cells, so a board lays out the same on any
        monitor; old files (a list of bare names) still read
  - [x] Weather data extended: hourly, 6-day, H/L, sunrise/sunset, is_day —
        one Open-Meteo call, verified live
  - [x] Widget VARIANTS — stored per placement, picked from pills in arrange
        mode. Calendar: week / month / agenda. Weather: now / forecast / both.
        Countdown: ring / numbers. The dial went back to the screen — a block
        that could set a timer but not show the list it joined was a second,
        worse copy of the same control
  - [x] Size-aware layouts — where a variant and a size disagree, the size wins
  - [x] Now playing: Row / Column / Cover. The column's art takes the slack so
        a taller block is a bigger cover, not a hole; the cover is the artwork
        with the words over it and the transport on hover (good at 1×1)
  - [x] Weather: Now / Hourly / Daily / Everything — "forecast" was two
        answers wearing one name. Day rows carry a high/low range bar scaled
        across the whole week
  - [x] The tray widens the ISLAND rather than taking the room out of the
        board — a cap may exceed the default full body now, up to
        `islandBodyMax`. Same rule the timer's list follows, and it is drawn
        the same way: a hairline separator, not a card
  - [x] The countdown widget was clamped to 40px by a name it shared with
        Today's tally ring; it is `w-ring` now, sized off the block's cells,
        and its transport drops to one key at a single cell
  - [x] Daylight widget: the sun on the arc it is actually crossing, the moon
        with its phase after dark, a wash that changes through the day. Two
        arcs, not one — daylight and darkness are different lengths. No API:
        the sun times are in the weather reading and the phase is arithmetic
  - [x] Three run widgets — pomodoro, timer, stopwatch — each about its own
        kind, each able to start one. The ring is `run-ring.ts`, the same
        builder the screen draws from, so a pomodoro is eight segments on a
        board exactly as it is on the screen
  - [x] A board block ticks in place every second. The shell's full render runs
        on the minute, so a countdown on a board held one number for up to
        sixty seconds
  - [ ] Weather has no per-condition artwork yet — the block is tinted by sky
        and time of day, but the glyphs are the pill's line icons
  - [x] Crypto — a coin's price, 24h change and a 30-day line from Binance's
        PUBLIC endpoints (no key). Three views; `bold` is the chart full-bleed
        with a scrub that moves the price, the percentage and the date
  - [x] Wallet — the connected Binance account's balance as a proportion bar.
        Read-only keys, stored in Credential Manager, never returned to a
        WebView. The only private endpoint the app knows is `GET /account`
  - [x] Widget settings live in the tray, opened from a gear on each block —
        view, and the ground it is drawn on. The pills inside blocks are gone
  - [x] The wallet reads spot, Funding and Simple Earn, prices through four
        routes, and is shown in a currency you pick
  - [x] The balance is a LINE the app records itself — Binance has no history —
        with a scrub, the holdings as a proportion bar and list underneath
  - [ ] The history starts the day the app does, so the span reads "14h" until
        it has been running a while. Nothing seeds it
  - [ ] Margin and Futures balances are still not counted — different
        endpoints again, and a key that can see them can usually trade them
  - [ ] No timeframe switcher on the coin — `crypto.rs` fetches one interval,
        thirty daily closes
  - [ ] The board can outgrow the island's depth cap and scroll, so the last
        row is cut. Nothing tells you it is scrollable
  - [ ] Today says "0 to do" over three rows of overdue tasks — the count and
        the list are answering different questions
  - [x] Per-board icons — a shortlist of sixteen in the settings window, and a
        new board takes the first glyph nobody is using rather than `home`
  - [ ] No board in the palette's "new" verbs — you make one in Settings
  - [ ] Weather has no hourly row and no H/L — `weather.rs` reports one
        observation, and inventing the rest would be a forecast we don't have
  - [ ] Agents shows what Codex reports it is doing; Claude's is inferred, so
        that line falls back to a session count
- [x] **Timer** — three kinds, many of each
  - [x] Stopwatch as a third kind, counting up. Pomodoro / Timer / Stopwatch
        are one face with one ring, not three layouts behind a mode switch
  - [x] The ring says which kind it is: segmented for a pomodoro (one arc per
        leg of the cycle), one unbroken circle for the other two
  - [x] Several of each. `Runs` is the collection; the old two single-engine
        keys migrate in, read once and left where they are
  - [x] The list extends from the side, the way `.media-lyrics` does — pick a
        run, start or pause it in place, remove it, clear the lot. The one on
        screen is lit; every row ticks
  - [x] `+` top right makes another of whatever kind is on screen
  - [x] One button for start / pause / resume; the dial and the name field
        live here, since setting a timer needs a ruler and somewhere to say
        what it is for
  - [x] Laid out on the Figma frame (Akcesfonia, node 79:6): a 392px face
        column and a 255px list column, 647 with both — the frame's proportions
        with more room round the 200px circle and a wider list than the frame's 175. Every length in the `tm-` block is off that frame; `TIMER_FACE` /
        `TIMER_LIST` in tasks.ts are the same two numbers
  - [x] List rows off the frame: a tinted disc with a bright glyph, not a
        saturated fill with dark ink on it
  - [x] The list widens the ISLAND rather than taking the room out of the face
        — a second cap in `widthOf`, the way the player's queue has one
  - [ ] No SKIP on the screen. The design frame gives the foot three controls
        and cutting a break short is only reachable from the countdown widget's
        transport. If it comes back it goes beside the gear, and only while a
        pomodoro is counting
  - [ ] The ruler is 314px, so about ten minutes either side of the marker.
        Fine for a kitchen timer, a long drag for anything over an hour
  - [ ] Switching to a timer grows the panel by the ruler's 48px. Reserving the
        row on every kind would cost a stopwatch 48px of nothing, so it jumps
  - [ ] No sound per run — the finish chime is one setting for all of them
  - [ ] A finished run is cleared rather than kept, so there is no history of
        what was worked on. Today would own that if it arrives
- [ ] **Money** — budgeting, expenses, subscriptions, insights. Shape TBD.
- [x] **Ambient mode** — the player full screen, grown out of the island
  - [x] Generated rooms (City window, Cabin) that follow the real sun, moon and
        weather, with Time / Weather overrides; the cover colour wash
  - [x] Your own folder of videos and stills (settings, or the scene menu)
  - [x] Centre and side layouts; controls step back after three seconds
  - [x] The glance — a size up from the pill on hover, in click mode
  - [x] On the island's design system: `tokens.css`, the player's own keys
  - [x] Lyrics never re-wrap when a line becomes current (AGENTS 772)
  - [ ] Unsynced lyrics still fall back to the title
  - [ ] No lyric timing nudge; LRCLIB is often a second out
  - [ ] Opens on the island's monitor only
- [ ] **Screenshots** — stacks, editing, sharing.
- [ ] **Palette extensions**, in order of worth:
  - [x] Units — `70 kg to lb`, `1.5 GB in MiB`; both byte families
  - [ ] Dates/times — `in 3 weeks`, `days until 24 dec`, epoch, `16:00 CET in warsaw`
  - [ ] Sound output — `→ headphones`; `system.rs` already lists and sets
  - [ ] Notes from the palette (`searchNotes` exists; wrapper only)
  - [ ] QR of a link — needs a drawing library, hence last

- [x] **Calendar work mode**: add events on click, drag, move them around. Add a separate UI (button toggle) which expands the calendar weekly view and allows CRUD. In this mode we also should show list of tasks (from the Today screen) which would be visible in an expanded panel on the right (expands the island like lyrics or widget list blocks). The tasks could be draggable from the list onto the calendar itself and they would have an additional checkbox on the event to mark them as done. All of this is already in TickTick - check if we can use that functionality or we must extend our own
- [ ] **Tabbed notes**: allow stacking different notes in one embed (notch), add tabs on top of the note which allow us switching between them.

- [ ] **Connect tasks with calendar/events and pomodoro/timer**: right now we have multiple separate functionalities which are pretty similar or complement each other. eg. events could be tasks (for example we set a task which is "wash car" and we also could have it as an event in the calendar). The calendar makes it easier to view and plan everything in time. Then on tasks we have a "focus" mode which turns on timer and focus on the task - it could be integrated with pomodoro/stopwatch/timer. We need to connect all of these functionalities so that we don't get 10 different solutions for one problem

## Open

**Agents**

- [ ] Permission prompts aren't a state — indistinguishable from a slow tool call
- [ ] Nothing kept when a session ends (no "18 min, 40 calls"). Same history Today wants
- [ ] Codex windows found by title — wrong one if two editors share a folder
- [ ] Claude's plan limit blank (endpoint needs the token → must be read in Rust)
- [ ] Cost in money not computed — price table goes stale silently
- [ ] Overview not orderable/filterable
- [ ] Usage panel is at the island height budget on a 760px screen

**Notes**

- [ ] A marker typed mid-line stays literal until reopen (rules fire at block end)
- [ ] Round trip normalises: `_i_`→`*i*`, fences lose their language, nested marks
- [ ] No nesting: `**a *b* c**` renders the outer marker only
- [ ] One 100ms thread per docked note — fine for a handful, not for twenty
- [ ] Docks to the current (primary) monitor; can't drag to another
- [ ] Not searchable from the palette
- [ ] No global shortcut of its own

**Notifications**

- [ ] Reply/snooze impossible — `UserNotification` can't be activated from outside
- [ ] 1.5s poll; instant needs a background-task registration a desktop app can't make
- [ ] ~1 app in 50 has no logo anywhere → letter tile

**Media**

- [ ] Unsynced lyrics ignored — a static block would be honest, not drawn
- [ ] Nothing on the collapsed strip, on purpose (same rule as notification text)
- [ ] Mixer skips pid 0 (Windows system sounds) — no process, no icon

**Ring**

- [ ] Wedge order comes from the settings list, not a drag
- [ ] Ticks can stay silent until the first mouse pick of the session (AGENTS 574)

**Elsewhere**

- [ ] Island context-awareness follows on _every_ open; escape would be a grace period
- [ ] Settings' screens list is still 12 rows (drag-to-reorder needs the shape)
- [ ] No Today streak — needs history the app doesn't keep. Review screen would own it

## Done

- [x] Notes v1 — wall + sheet, live WYSIWYG editor (stores markers), colour per note,
      arm-then-confirm delete, dock to edge (island shape + spring), drag-out with a
      ghost and lit zones, pull an edge or corner to resize (size stored on the note)
- [x] Agents — per-agent mark and colour, tool checklist, cost bar, Codex reader,
      `usage.json` (4 months, 3 cuts + week chart), session vs overview layouts
- [x] Agent states were inverted: prose-end = idle, `AskUserQuestion` = waiting
- [x] Ring — `Alt+W` tap = palette, hold = ring; verbs as well as screens; hold-and-release
      via `GetAsyncKeyState`; overshoot forgiven; one label under the ring
- [x] Notifications shelf — mirror of Windows' centre, dismiss/clear/open
- [x] Live lyrics via LRCLIB — own panel, window travels over the whole file
- [x] Volume mixer per app, with shell icons
- [x] Call mode — mic as the signal; mute + hang up collapsed, full call expanded
- [x] Pomodoro + timer as two engines behind two faces — replaced by `Runs`
- [x] Currency converter (+ optional home currency), units converter
- [x] Island context awareness on open (above 40 only, never a toast)
- [x] Today overhaul — one thing next, finished count, rail sweep on empty
- [x] Screens: reorder, hide, a colour each. System off the rail (header chip)
- [x] Settings decluttered — descriptions out, sentence case, ring as chips
- [x] Shelf cards carry the file's real shell thumbnail
- [x] Fixes: arcs/rail hidden behind the palette, island fold on palette close,
      device/bluetooth card padding, event stuck on the island
