# TODO

## Decisions this must not quietly undo

- The bezel shape. Everything is welded to a screen edge and keeps the fillet.
- One settings window. Anything new that is a preference goes in `prefs.rs` and
  gets a control there — not a popover somewhere else.
- The accent is one variable. No new hardcoded colour; derive with `color-mix`.
- Tokens never reach a WebView, a log, or an error message.
- `AGENTS.md` is the log of things that failed silently. Every trap this pass
  turns up gets a numbered entry.

## My ideas for the next features

- ~~Currency converter extension for the command palette~~ — **done**.
  `120 usd to pln`, `$120 zl`, `eur to gbp`. ECB daily rates through
  Frankfurter with exchangerate-api behind it, one table against the euro
  cached on disk for six hours, and the crossing done in the page. The row
  says what it worked from and WHICH DAY, because a daily rate on a Sunday is
  Friday's number.
  - [x] **A home currency**, in `Settings → Search → Money`, so `120 usd` and
        `$120` have an answer on their own. Off by default — a converter that
        guesses which country you are in is wrong the moment you travel.

- **Five more for the palette**, in the order they would earn their place:
  1. ~~**Units**~~ — **done**. `70 kg to lb`, `12ft in m`, `220°F to C`,
     `1.5 GB in MiB`: length, mass, temperature, data, time, volume, area and
     speed, no network, and both byte families because a drive and an
     operating system mean different things by "GB". Temperature carries an
     offset — scaled as a ratio, 20°C comes out as 36°F.
  2. **Dates and times** — `in 3 weeks`, `days until 24 dec`,
     `1789714959` (an epoch, as a date), `16:00 CET in warsaw`. Every one of
     those is a browser tab today, and the island already owns a calendar, a
     clock and the week's shape.
  3. **Jump to a window** — type a title, get that window. `win.rs` already
     enumerates every visible window with its title and pid, and
     `focus_session` already raises one: this is a provider over machinery
     that exists, and it is the thing alt-tab is worst at with twenty windows.
  4. **What you copied** — the shelf already keeps it. Searching it from the
     palette turns a screen you have to open into a line you can type, which
     is the difference between a feature and a habit.
  5. **Encode, hash, generate** — `b64 hello`, `url <text>`, `md5 <text>`,
     `uuid`, `pw 20`. Pure, offline, and the exact set of things a developer
     currently pastes into somebody else's website — which for a password or
     a token is the part that should stop.
  - Also considered and not chosen yet: a colour tool (`#0f61ff` → rgb/hsl,
    and set the accent), and translation (needs a key, and the good ones are
    not free).

- **And eight more, ranked by what they would actually save.** The test each
  one has to pass is the same: it is something done on this machine several
  times a week, and the palette is a shorter road to it than what is used now.
  A palette that answers everything is a palette nobody can predict, so an
  idea that is merely clever is listed and not built.

  1. **Start a timer by saying how long.** `20 min`, `1h30`, `7:30 alarm`.
     The timer, its pill and its screen all exist; this is a parser and one
     call. ⚠️ The grammar has to stay narrow — a bare number must not start
     anything, because a bare number is also an amount, a year and a port.
  2. **Switch the sound output.** `system.rs` already lists the devices and
     can set one; `→ headphones` in the palette is a daily gesture that is
     currently three clicks into a Windows flyout that moves between builds.
     Wi-Fi is the same shape if the enumeration lands.
  3. **Move the focused window.** `left half`, `right half`, `centre`,
     `other screen`. `win.rs` already enumerates windows and the island
     already moves itself between displays. Windows' own Snap needs the mouse
     or a chord you have to remember; this is a word.
  4. **The notes, from the palette.** Already promised further down this file
     under Notes — `searchNotes` folds accents and matches every word, so the
     provider is a wrapper. It belongs in this list too, because "the pile is
     findable without opening the screen" is what makes the pile worth having.
  5. **Snippets, out of the notes that already exist.** A note whose first
     line is `;;addr` becomes `addr` in the palette, and picking it copies the
     rest. No new storage, no new editor, no sync — the feature is a naming
     convention over a thing that is already written down and already backed
     up with everything else.
  6. **Numbers in other bases.** `0xff to dec`, `255 in binary`, `1010b hex`.
     The same family as the unit converter and the same file could hold it:
     pure, offline, and instant.
  7. **Characters that are not on a Polish keyboard.** `arrow`, `dash`,
     `shrug`, `degree` → copies `→`, `—`, `¯\_(ツ)_/¯`, `°`. A small table, and
     the alternative is a website or a Windows dialog nobody can find twice.
  8. **A QR of a link.** The one honest way to get a URL from this machine
     onto a phone. Offline, but it needs a drawing library — which is why it
     is last rather than second.

  Rejected on purpose, so they are not proposed again: running shell commands
  from the palette (a palette is a place you type half-finished words into,
  and half a command is a real command), killing processes by name (same
  reason, with a worse failure), and anything that reads a credential back out
  of Credential Manager — tokens never come back to a WebView.

- ~~A shortcut that opens a ring around the mouse~~ — **done**, `Ctrl+Alt+R`.
  Every screen at a direction, the palette in the middle, picking one opens the
  island on it. ⚠️ Eight at most: past that, aiming stops being faster than
  reading.
  - [x] **Hold and let go to pick.** Press, flick the wrist, let go — one
        gesture, no click. A tap still opens it and leaves it up, which is what
        somebody reading the labels is doing. 200ms is the line.
  - [x] **Verbs as well as screens**, and they are what stops it being a
        navigation menu: add a task, write a note (both with the caret where it
        belongs), shelve the clipboard, start a pomodoro. Chosen in
        `Settings → Island → The ring`, eight at most.
  - [ ] The chosen list is ordered by the settings list rather than dragged. A
        ring whose wedges move about is one where aiming stops working, so the
        order has to come from somewhere fixed — but "somewhere fixed" is
        currently "the order this list happens to be written in".
  - [x] **Hold and let go actually works.** Windows repeats a held key and
        every repeat was another press, so holding it toggled the ring shut.
  - [x] **One label, under the ring**, instead of eight around it — long
        names ran over their own wedges. Frosted by default, with a solid
        style for a busy background, a tick per wedge crossed and a lower one
        on the pick.
  - [ ] The ticks come from the ring's own page, which a global shortcut does
        not activate — they may stay silent until the first mouse pick of
        the session. See AGENTS 574.
  - [x] **The release is watched here now**, with `GetAsyncKeyState`: the
        plugin's own `Released` never arrives on this machine, which is why
        the gesture had never worked — and why the auto-repeat guard locked
        the ring out of opening at all. See AGENTS 581.
  - [x] **Tap for one thing, hold for the ring.** A tap opens the command
        palette (or whatever is set in Settings → Island) and never draws the
        menu; the ring is what holding past 0.25s gets you. Both the delay and
        what a tap does are preferences.
  - [x] **The pick carries the pointer** rather than trusting the page to have
        seen it move — see AGENTS 590.
  - [ ] The whole gesture is now logged. If it misbehaves again, the log says
        which step: `Settings → General → Open log`.
  - [x] **Two global shortcuts, not seven.** `Alt+W` tapped is the palette and
        held is the ring; `Ctrl+Alt+H` still hides everything. The five that
        went — open the island, add a task, shelve the clipboard, next display
        and the palette's own key — are all a wedge or a palette row away.
  - [x] **Overshooting is forgiven.** Past the ring's edge the angle alone
        decides, out to 250px, and a wedge holds until the pointer is a fifth
        of a wedge into the next one.
  - [x] **A tap acts at once.** It was waiting for an event loop that a
        press-and-release does not wake, so the palette opened on the next
        keystroke instead.
  - [x] **What the ring picks is what opens.** Opening the island lands on
        the liveliest claim a frame later, which used to take the screen back
        — an agent working outranked the wedge somebody had just chosen.

- ~~Settings: too many words, too many switches in one pane~~ — **done**. The
  descriptions under every row are gone except where the consequence is
  invisible; the section headings are sentence case rather than tracked
  uppercase; the pomodoro has a pane of its own and the call and the
  notifications moved to The pill; the ring's sixteen rows are four lines of
  chips.
  - [ ] The screens list is still twelve rows, because it is a drag-to-reorder
        list and that is the shape that makes order obvious. It is the longest
        thing left in the pane.
- [x] **The rail budget**: a screen earns a rail stop only if you would sit on
      it for thirty seconds. **System is off it now**, with a chip in the
      header beside the timer and the bell — it is a place you visit for one
      thing and leave. Review is still there and is the remaining candidate.

- ~~Quick note widget with history of all notes, search~~ — **done**. Two
  screens: the WALL is the index — colour, first words, when — and pressing one
  opens THE NOTE, a full sheet that is both how you read it and how you write
  it. Search folds accents and matches every word anywhere. Palette: "Write a
  note".
  - [x] **The editor is the screen.** What was here before was a two-row
        composer above the wall, so the one surface you could type into was the
        smallest thing on it and opening a note meant watching its words jump
        out of the card into a box somewhere else. There is no save button: the
        sheet writes itself down when you stop typing, and leaving the screen
        writes it too.
  - [x] **And it shows the note, not its source.** Bold is bold while you type
        it and a list has bullets; typing `- ` or `**` turns into what it means
        as you type it, and what gets STORED is still the markers — greppable,
        pasteable, readable in Notepad. The docked drawer is the same editor:
        the caret goes straight into the words, with no mode to enter first.
  - [ ] A marker typed into the MIDDLE of an existing line stays as characters
        until the note is next opened. The rules fire at the end of a block,
        because that is the one caret position that survives the block being
        redrawn.
  - [ ] The round trip normalises: `_italic_` comes back as `*italic*`, a fence
        loses its language and a mark inside a mark loses the inner one. The
        parser cannot express any of those, so a view built from it cannot
        either — and it only ever happens to a note somebody actually edited.
  - [x] **Delete asks twice.** A note is the only thing this app stores that is
        not a cache of something else, and the button that throws one away sits
        30px from the one that copies it. The first press arms it; it disarms
        itself after four seconds.
  - [ ] No global shortcut of its own — the palette command is the fast path.
        One would mean a seventh key and a seventh row in Settings.
  - [x] **Dock a note to the edge of the screen**, by pressing the pin or by
        dragging the card out of the island. It is a sliver at the side with
        the note's first words turned on their side, and the whole note when
        the pointer arrives — press the sliver to keep it open, drag it to
        slide it along the edge or across to the other one. Which edge and how
        far down are remembered; docked notes come back when the app restarts.
  - [x] **The island's shape and the island's spring**, literally: the drawer
        is cut by `notchPath` — the same path the island cuts itself out of the
        bezel with — and driven by `Spring` at the island's own numbers. So it
        flares back OUT to the screen edge at each end instead of sitting
        against it as a rounded box, and it arrives with the same overshoot
        everything else in the app does.
  - [x] **The window never resizes.** It is bigger than the open drawer at all
        times, transparent, and click-through everywhere it is not painted —
        `watch_pin` in notes.rs is a short copy of `hover.rs` for that. A
        window that grows on hover can only jump; there is no resizing one at
        sixty frames a second across a process boundary.
  - [ ] One 100ms polling thread per docked note, which is the price of the
        arrangement above. Fine for the handful anybody docks; if it ever
        becomes twenty, they want one loop over a list rather than twenty
        loops.
  - [x] **The drag docks as it goes.** A drag with no preview is a drag of
        nothing: the card cannot leave the island's window. The real drawer is
        the preview — it slides out of the edge you are heading for and follows
        the pointer until you let go. Dropping it back on the island puts it
        away again.
  - [ ] The drawer docks to the CURRENT monitor, which in practice is the
        primary one — the window is built before it has been placed, so there
        is nothing to ask which screen it is on. Dragging it to another
        monitor is the missing half.
  - [ ] Notes are not searchable _from the palette_ yet, only from the screen.
  - [x] **A colour per note** — six, chosen on the sheet, shown as a band down
        the card's leading edge and as the sliver's own colour. Stored as a
        KEY, never a colour, so nothing a note carries can reach a stylesheet.
  - [x] Simple formatting — `**bold**`, `*italic*`, `` `code` ``, `~~strike~~`,
        `-` and `1.` lists, `>` quotes, `#` headings, ``` fences. Stored as the
        text you typed; parsed on the way out.
  - [ ] No nesting: `**a *b* c**` renders the outer marker only. Every attempt
        at one grows a state machine, and a note is not a document.

- ~~Improve (today): overhaul the Today screen~~ — **done**. The chips are
  raised rather than washed in their list's colour (the dot carries it); the
  heading no longer names the list the rail below is already wearing lit; the
  overdue chip is text and a hairline rather than a filled amber pill.
  - **One thing to do next**: the first row that can actually be ticked wears
    an accent edge. A list is a set of things you could do; a queue is one
    thing you are about to do.
  - **What you have finished**, beside what is left. A day that only counts
    down can only get worse.
  - **The day emptying** sweeps the rail once — the reward for finishing is
    that the list is empty, which is a quiet thing.
  - [ ] No streak, and it is the obvious next one: "three days clear" is the
        strongest thing this screen could say and it needs history the app
        does not keep yet. The Review screen is where that would come from.

---

---

## 7. Agent states were inverted — DONE

⚠️ **The two states a session can be in were exactly the wrong way round**,
and each looked plausible on its own.

- A turn ending in prose — the work came back, no question — was reported as
  _waiting_. True of the file, false of you: it pulsed amber and held the pill
  until the terminal was closed. It is **done** now, which is idle.
- A QUESTION was reported as _working_. `AskUserQuestion` arrives as a
  `tool_use` block exactly like `Bash`, so the mid-flight check swallowed the
  one moment that genuinely wanted you — no pulse, no notification. It is
  **waiting** now.

Verified against a real transcript rather than argued: the question is an
assistant record whose only block is that tool call, and nothing follows it
until the answer arrives as a `tool_result`.

- [ ] Permission prompts are still not detected. Blocking on "allow this
      command?" looks like a tool call with a result that has not arrived —
      indistinguishable, from the transcript alone, from a `cargo build` that
      is still running. It needs a time threshold or a hook.

---

## Done

- Fix: Arcs and screen rail/switcher are visible when the command palette is open. The command palette should be a separate layer that doesn't show the global island UI
- Fix (system): Unnecessary padding bottom on device and bluetooth cards.
- Fix (command palette): When closing the command palette, expanded island shows up before folding. Fix that.
- Feature: reordering screens/tabs, hiding them, and a colour each — eight
  preset tones plus a custom picker, right-click to clear back to the accent.

- ~~Style (shelf): cards with a plinth, title, format and size~~ — done, and the
  plinth now carries the file's **real** preview. ⚠️ The shell's thumbnail, by
  shelf ID — not Tauri's asset protocol, which would have handed the WebView
  the disk. Asked once per file per modification time, and a file the shell
  has nothing for keeps its glyph.
- ~~Feature: In call mode with controls~~ — **done**. The microphone is the
  signal: an app with an active capture session is in a call, which is the same
  fact Windows draws its own microphone glyph for. Collapsed, the strip keeps
  the clock and gains mute + hang up; expanded, it is the call with its own
  screen. Zoom, Teams, Meet, WhatsApp — and Discord and Slack, which the table
  gave away for free.
- ~~Notifications shelf~~ — **done, basic**. Windows' own centre, mirrored on a
  Notices screen with a bell in the header. ⚠️ A MIRROR: dismissing one here
  dismisses it there, and nothing is kept on disk. The header shows a count and
  never a word of content.
  Cards with the app's own logo, the title, the app and two lines of body — the
  shape the notification had when it flew past. Dismiss, clear all, and pressing
  a card opens the app it came from.
  - [ ] ⚠️ **Reply and snooze are not possible.** A notification cannot be
        activated from outside — `UserNotification` has no method for it — so
        the only handle is the app's AUMID, which opens Slack and never the
        thread. Those actions live in the notification's own buttons, which
        Windows does not expose.
  - [ ] The poll is 1.5s now, not 4. Instant would need `NotificationChanged`,
        which is documented as needing a background-task registration a desktop
        app cannot make.
  - [ ] One app in fifty still has no logo anywhere (WinRT, the AUMID registry
        key, the Start Menu) and falls back to a letter tile.
- ~~Fix: Upcoming event stuck on the island~~ — **done**

- ~~Pomodoro widget~~ — **done**, and then rebuilt as two faces on one screen,
  and then as two ENGINES behind them: a pomodoro and a timer run side by
  side. One state meant starting a timer silently threw away a run four rounds
  in. The tab you are not on wears a dot when its countdown is live.

- ~~Improve: context awareness for the notch~~ — **done**. Opening it lands on
  whatever is happening rather than wherever you last were: the pill has
  already picked the most live claim, and the island follows it. ⚠️ Above 40
  only — a call, an agent waiting, a meeting about to start, a countdown — and
  never for a toast, which outranks everything and is a message rather than a
  place. `Settings → Island → Opening` switches it off.
  - [ ] It follows on EVERY open, so walking to Notes and reopening goes back
        to the call. That is the feature; if it grates, the escape is a grace
        period after a deliberate screen change rather than a new setting.

- ~~Feature (media): live lyrics sync using LRCLIB~~ — **done**. Its own panel
  under the player and the queue, opened from the button beside the output
  picker and closed by default; the island grows for it. The whole file is in
  the DOM and the window travels over it, fading and blurring out from the
  line being sung — so it can be scrolled to read ahead, and a line change
  reads as movement rather than as a caption being replaced. The change itself
  is a timer aimed at the next line's own second, not a poll. ⚠️ LRCLIB's
  `/api/get` is a fingerprint (artist + track + album + duration) and answers
  404 on a near miss, which is the behaviour to want — nothing beats another
  recording's words against this one's clock. No key, no account, cached by
  the same fingerprint on both sides.
  - [ ] Unsynced files are ignored. LRCLIB serves plain words too, and pacing
        them by dividing the track's length by the line count is an invention
        that is wrong from the second line on. A block of static text would be
        honest and is not drawn yet.
  - [ ] Nothing on the collapsed strip. A line of lyric is the most tempting
        thing to put there and the one most likely to be read over somebody's
        shoulder — the same argument that keeps a notification's words off it.

- ~~Improve (agents): more statistics, and states worth looking at~~ — **done**.
  A card was a glyph for its state, a name and two grey numbers, repeated three
  times down the screen.
  - **Whose agent it is**, as the mark: Claude's burst rather than a fourth
    drawing of the state. The state moved to a badge beside the name.
  - **What it has been doing**, as a checklist — the last four tool calls,
    ticked as their results come back, the one in flight lit. What an agent is
    doing is a list, not a sentence.
  - **What it cost**, as a shape: a bar of the output share beside the figures.
  - [ ] Nothing is kept once a session ends, so there is no "this run took
        18 minutes and 40 calls" — the transcript has it and the app reads
        only the tail. That is the same history the Today streak wants.
  - [x] **Codex is read too**, out of `~/.codex/sessions` — a second reader,
        because the two formats share nothing. Codex states what Claude's has
        to infer: when a turn starts and ends, which model answered, the
        session's running total, and what is left of the plan.
  - [x] **Whose agent, and which model**, on the card and on the strip.
  - [x] **A stage for the live ones**, paged with dots, and one quiet line
        each for the dormant. Four identical cards was the complaint.
  - [ ] Codex sessions cannot be reached by pid — they have none — so the
        window is found by its title. It picks the wrong window if two
        editors have the same folder open.
  - [ ] A permission prompt is still not a state. Codex has
        `tools.request_permissions` in an exec call, which is close, but an
        exec that is merely slow looks identical from outside.
  - [x] **The usage is kept.** `usage.json` — one bucket per day per agent
        per model per project, four months of them, seeded once from the runs
        so the chart is not empty for a fortnight. The panel cuts today three
        ways (agent, model, project), draws the week behind it, and shows
        what is left of the plan where the agent reports it.
  - [ ] Only Codex reports a plan limit, so Claude's half of that row is
        blank. Anthropic's own usage endpoint is behind the token this app
        deliberately never hands to a WebView, so it would have to be read
        in Rust and reported like everything else here.
  - [ ] Cost in money is not computed. It needs a price per model per
        provider, which is a table that goes stale silently — the worst kind
        of number to put on a screen that is otherwise all measurements.
  - [x] **The real marks**, from each vendor's own VS Code extension rather
        than drawn by hand. The first Claude one was a compass rose.
  - [x] **Two layouts, two intents.** The strip expands into the SESSION —
        one at reading size, with room — and the rail opens the OVERVIEW: a
        card per session in a grid, so five sessions is four across rather
        than five rows deep.
  - [ ] The overview is not orderable or filterable. With a dozen sessions
        the grid is the right shape but "only the ones that want me" would
        be better than reading twelve cards.
  - [x] **Each agent in its own colour**, on the mark only — the state keeps
        the pip, the word and the wash.
  - [x] **The week is a chart**, a line over an area, with the points over
        their own days.
  - [x] **Bigger type, no eyebrows.** Uppercase at .08em tracking was doing
        the work of six different headings.
  - [ ] The usage panel is within a few pixels of the island's height budget
        on a 760px screen. Anything added to it has to come out of something
        else until the island can scroll a screen without it reading as cut
        off.

- ~~Feature (media): volume mixer, per app~~ — **done**, on the System screen:
  a row per app with a rail and a mute, sorted by what is making a sound now.
  ⚠️ `eRender` sessions, read on OPEN and never polled — it is a COM walk of
  every session on the machine. A write goes to every session of that process,
  because a browser opens one per renderer.
  - [x] The app's own icon on each row, from the shell — the same extractor
        the palette and the call strip use, so there is one leaky-handle path
        rather than three.
  - [ ] Pid 0 — Windows' own system sounds — is left out: it has no process to
        name and no icon, and a row that cannot say what it is is a slider
        nobody dares move.

---
